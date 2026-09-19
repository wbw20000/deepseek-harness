/**
 * Local-notification delivery: spawn the configured command once per event,
 * hand the event JSON over stdin, and enforce a fixed 10-second deadline with
 * a process-group kill. Delivery never retries and never blocks the event
 * stream: the caller owns logging the failure reason.
 */

import { spawn } from 'node:child_process'
import type { SelfDevelopmentEvent } from './types.ts'

/** Fixed deadline for one notification command. */
export const NOTIFY_TIMEOUT_MS = 10_000

/** Delivery options with direct-unit-test replacements. */
export interface NotifyOptions {
  /** Deadline override for direct unit tests; defaults to {@link NOTIFY_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Timeout group stop override for direct unit tests. */
  readonly stopGroup?: (pid: number) => void
}

/**
 * Deliver one event through the notification command. The command runs in its
 * own process group (detached spawn), so the deadline kill reaches descendants
 * without touching the host's group. Spawn errors, non-zero exits, and
 * timeouts are terminal: the function resolves with the failure reason and
 * never retries.
 * @param event - the unified event; its JSON arrives on the command's stdin.
 * @param command - notification command argv; config resolution owns its validation.
 * @param options - deadline and group-stop overrides for direct unit tests.
 * @returns the failure reason, or `undefined` when the command exited 0.
 */
export function runNotify(
  event: SelfDevelopmentEvent,
  command: readonly string[],
  options: NotifyOptions = {},
): Promise<string | undefined> {
  return new Promise((resolve) => {
    // `command` is validated non-empty at config resolution; an empty-argv
    // caller error surfaces through the spawn-failure path below.
    const child = spawn(command[0] as string, command.slice(1), {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    })
    const timeoutMs = options.timeoutMs ?? NOTIFY_TIMEOUT_MS
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      // Kill only the group this spawn created: the detached child is its own
      // process-group leader, so `-pid` never reaches the host's group. The
      // deadline only runs while the child exists, so the pid is a number.
      try {
        (options.stopGroup ?? defaultStopGroup)(child.pid as number)
      } catch (error) {
        resolve(`failed to stop the notification process group: ${String(error)}`)
        child.kill('SIGKILL')
        return
      }
    }, timeoutMs)
    // The command may exit before reading stdin; the exit code carries the
    // failure. Raising this handler needs a write larger than the pipe buffer
    // to a command that exits unread, which no title-level event reaches.
    /* v8 ignore next -- the exit code carries the failure; nothing is logged here. */
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
    child.stdin.end(`${JSON.stringify(event)}\n`)
  })
}

/** Signal the notification child's own process group. */
function defaultStopGroup(pid: number): void {
  process.kill(-pid, 'SIGKILL')
}
