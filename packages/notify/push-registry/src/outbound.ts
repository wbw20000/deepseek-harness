/** Outbound-command delivery: spawn, bounded timeout, group kill, retries. */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import type { OutboundPayload } from './types.ts'

/** Fixed retry cadence: 250 ms after the first failure, doubling per attempt. */
export const OUTBOUND_RETRY_BACKOFF_BASE_MS = 250

/** One completed outbound delivery. */
export interface OutboundOutcome {
  /** Whether the final attempt exited 0. */
  readonly ok: boolean
  /** Total attempts spent, including the first. */
  readonly attempts: number
  /** Wall time of all attempts in milliseconds. */
  readonly durationMs: number
  /** Failure reason of the final attempt; absent when delivered. */
  readonly error?: string
}

/** Delivery options the service derives from its resolved config. */
export interface OutboundOptions {
  /** Per-attempt deadline in milliseconds. */
  readonly timeoutMs: number
  /** Retry attempts after the first failure. */
  readonly maxRetries: number
  /** Inter-attempt wait; defaults to the fixed exponential backoff. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Timeout group stop; defaults to signaling the spawned process group. */
  readonly stopGroup?: (pid: number) => void
}

/**
 * Deliver one payload through the outbound command, retrying only failures.
 * Each attempt spawns the command, writes the payload JSON on stdin, and
 * expects exit 0 within the deadline. The command runs in its own process
 * group (detached spawn), so the timeout kill reaches descendants without
 * touching the host's group; an unkillable group fails the attempt loudly.
 * Non-zero exits, spawn errors, and timeouts are the retryable failures.
 * @param payload - event and device, including the token.
 * @param command - outbound command argv.
 * @param options - deadline, retry count, and optional wait injection.
 * @returns the aggregated delivery outcome.
 */
export async function runOutbound(
  payload: OutboundPayload,
  command: readonly string[],
  options: OutboundOptions,
): Promise<OutboundOutcome> {
  const wait = options.sleep ?? sleep
  const startedAt = performance.now()
  const attempts = 1 + options.maxRetries
  for (let attempt = 1;; attempt += 1) {
    const failure = await runAttempt(payload, command, options.timeoutMs, options.stopGroup)
    if (failure === undefined) {
      return { ok: true, attempts: attempt, durationMs: performance.now() - startedAt }
    }
    if (attempt >= attempts) {
      return { ok: false, attempts: attempt, durationMs: performance.now() - startedAt, error: failure }
    }
    await wait(OUTBOUND_RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1))
  }
}

/**
 * Run one attempt and return its failure reason, or undefined on success.
 * @param payload - event and device, including the token.
 * @param command - outbound command argv; config resolution owns its validation.
 * @param timeoutMs - per-attempt deadline in milliseconds.
 * @param stopGroup - timeout group stop override for direct unit tests.
 * @returns the failure reason, or undefined when the command exited 0.
 */
async function runAttempt(
  payload: OutboundPayload,
  command: readonly string[],
  timeoutMs: number,
  stopGroup?: (pid: number) => void,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    // `command` is validated non-empty at config resolution; the empty-argv
    // caller error surfaces through the spawn-failure path below.
    const child = spawn(command[0] as string, command.slice(1), {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    })
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      // Kill only the group this spawn created: the detached child is its own
      // process-group leader, so `-pid` never reaches the host's group. The
      // deadline only runs while the child exists, so the pid is a number.
      try {
        (stopGroup ?? defaultStopGroup)(child.pid as number)
      } catch (error) {
        resolve(`failed to stop the outbound process group: ${String(error)}`)
        child.kill('SIGKILL')
        return
      }
    }, timeoutMs)
    // The command may exit before reading stdin; the exit code carries the failure.
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      clearTimeout(deadline)
      resolve(`failed to spawn ${String(command[0])}: ${String(error)}`)
    })
    child.on('close', (code) => {
      clearTimeout(deadline)
      if (timedOut) {
        resolve(`timed out after ${String(timeoutMs)} ms`)
        return
      }
      resolve(code === 0 ? undefined : `exited with code ${String(code)}`)
    })
    child.stdin.end(`${JSON.stringify(payload)}\n`)
  })
}

/** Signal the outbound child's own process group. */
function defaultStopGroup(pid: number): void {
  process.kill(-pid, 'SIGKILL')
}
