/**
 * Outbound-command delivery behavior: the stdin payload, the retry budget with
 * its exponential backoff, the timeout that stops only the spawned process
 * group, spawn failures, and commands that exit before reading stdin.
 * @module outbound.spec
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runOutbound } from '../src/outbound.ts'
import type { OutboundPayload } from '../src/types.ts'

const recordStdin = fileURLToPath(new URL('./fixtures/record-stdin.mjs', import.meta.url))
const failFast = fileURLToPath(new URL('./fixtures/fail-fast.mjs', import.meta.url))
const groupSleep = fileURLToPath(new URL('./fixtures/group-sleep.mjs', import.meta.url))
const exitWithoutReading = fileURLToPath(new URL('./fixtures/exit-without-reading.mjs', import.meta.url))

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** One fresh temporary workspace directory. */
async function makeRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'push-registry-outbound-'))
  return root
}

/** One delivery payload for a registered iOS device. */
function payload(title = 'Turn finished'): OutboundPayload {
  return {
    event: { kind: 'turn-finished', sessionId: 'session-1', title, occurredAt: 1 },
    device: { deviceId: 'device-1', platform: 'ios', token: 'token-value' },
  }
}

/** Node binary invocation of one fixture. */
function node(script: string): readonly string[] {
  return [process.execPath, script]
}

describe('runOutbound', () => {
  it('hands the payload JSON to the command on stdin and reports success', async () => {
    const dir = await makeRoot()
    const target = join(dir, 'calls.jsonl')
    const outcome = await runOutbound(payload(), [process.execPath, recordStdin, target], {
      timeoutMs: 5000,
      maxRetries: 0,
    })

    expect(outcome).toMatchObject({ ok: true, attempts: 1 })
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(payload())
    expect(outcome.error).toBeUndefined()
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('retries a non-zero exit with exponential backoff and records the final failure', async () => {
    const dir = await makeRoot()
    const target = join(dir, 'calls.txt')
    const waits: number[] = []
    const outcome = await runOutbound(payload(), [process.execPath, failFast, target], {
      timeoutMs: 5000,
      maxRetries: 2,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })

    expect(outcome).toMatchObject({ ok: false, attempts: 3, error: 'exited with code 1' })
    expect(waits).toEqual([250, 500])
    expect(await readFile(target, 'utf8')).toBe('called\ncalled\ncalled\n')
  })

  it('succeeds on the final retry', async () => {
    const dir = await makeRoot()
    const marker = join(dir, 'first-attempt.marker')
    const succeedOnSecond = [
      process.execPath,
      '-e',
      'const fs = require(\'node:fs\'); fs.existsSync(process.argv[1]) ? process.exit(0) : (fs.writeFileSync(process.argv[1], \'x\'), process.exit(1))',
      marker,
    ]
    const outcome = await runOutbound(payload(), succeedOnSecond, {
      timeoutMs: 5000,
      maxRetries: 1,
      sleep: async () => {},
    })

    expect(outcome).toMatchObject({ ok: true, attempts: 2 })
  })

  it('kills the spawned process group on timeout', async () => {
    if (process.platform === 'win32') return
    const dir = await makeRoot()
    const pidFile = join(dir, 'pids.json')
    const outcome = await runOutbound(payload(), [process.execPath, groupSleep, pidFile], {
      timeoutMs: 400,
      maxRetries: 0,
    })

    expect(outcome).toMatchObject({ ok: false, attempts: 1, error: 'timed out after 400 ms' })
    const { pid, childPid } = JSON.parse(await readFile(pidFile, 'utf8')) as { pid: number; childPid: number }
    await expect(groupIsGone(pid)).resolves.toBe(true)
    await expect(groupIsGone(childPid)).resolves.toBe(true)
  })

  it('fails loudly when the process group cannot be stopped', async () => {
    if (process.platform === 'win32') return
    const dir = await makeRoot()
    const pidFile = join(dir, 'pids.json')
    const outcome = await runOutbound(payload(), [process.execPath, groupSleep, pidFile], {
      timeoutMs: 200,
      maxRetries: 0,
      stopGroup: () => {
        throw new Error('stop refused')
      },
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('failed to stop the outbound process group: Error: stop refused')
    // The fallback stop covers only the direct child; clean up its grandchild.
    const { childPid } = JSON.parse(await readFile(pidFile, 'utf8')) as { childPid: number }
    process.kill(childPid, 'SIGKILL')
    await expect(groupIsGone(childPid)).resolves.toBe(true)
  })

  it('reports spawn failures without retrying into a crash', async () => {
    const outcome = await runOutbound(payload(), ['definitely-missing-push-registry-binary'], {
      timeoutMs: 5000,
      maxRetries: 1,
      sleep: async () => {},
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.attempts).toBe(2)
    expect(outcome.error).toContain('failed to spawn definitely-missing-push-registry-binary')
  })

  it('survives a command that exits before reading stdin', async () => {
    const outcome = await runOutbound(payload('x'.repeat(200_000)), node(exitWithoutReading), {
      timeoutMs: 10_000,
      maxRetries: 0,
    })

    expect(outcome).toMatchObject({ ok: true, attempts: 1 })
  })
})

/** Wait until the process is no longer visible to the OS. */
async function groupIsGone(pid: number): Promise<boolean> {
  for (let waited = 0; waited < 5000; waited += 50) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}
