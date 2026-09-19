/**
 * Local-notification delivery unit behavior: one spawn per event, the fixed
 * deadline with a process-group kill, and terminal failure reporting.
 * @module notify.spec
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runNotify } from '../src/notify.ts'
import type { SelfDevelopmentEvent } from '../src/types.ts'

/** One representative event; content is irrelevant to delivery. */
const EVENT: SelfDevelopmentEvent = {
  taskId: 'task-1',
  kind: 'failed',
  sessionId: undefined,
  title: 'Round 1 failed: runner exited 1',
  occurredAt: 1_700_000_000_000,
  revision: 7,
}

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Create a disposable directory registered for cleanup. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'self-dev-notify-'))
  root = dir
  return dir
}

/** Absolute path of one fixture command. */
function fixture(name: string): string {
  return new URL(`./fixtures/${name}`, import.meta.url).pathname
}

describe('runNotify', () => {
  it('spawns once and hands the event JSON to stdin', async () => {
    const dir = await scratch()
    const out = join(dir, 'notices.log')
    const failure = await runNotify(EVENT, [process.execPath, fixture('record-stdin.mjs'), out])
    expect(failure).toBeUndefined()
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({ ...EVENT, sessionId: undefined })
    expect(JSON.stringify(JSON.parse(await readFile(out, 'utf8')))).not.toContain('sessionId')
  })

  it('reports a non-zero exit as a terminal failure', async () => {
    const failure = await runNotify(EVENT, [process.execPath, '-e', 'process.exit(3)'])
    expect(failure).toBe('exited with code 3')
  })

  it('reports a spawn failure as a terminal failure', async () => {
    const failure = await runNotify(EVENT, ['/nonexistent-self-dev-notify-binary'])
    expect(failure).toMatch(/^failed to spawn/)
  })

  it('kills its own process group at the deadline and reports the timeout', async () => {
    const failure = await runNotify(EVENT, [process.execPath, fixture('sleeper.mjs')], { timeoutMs: 100 })
    expect(failure).toBe('timed out after 100 ms')
  })

  it('uses the injected group stop at the deadline', async () => {
    // The injected stop must actually stop the child for the delivery to
    // settle: the promise resolves on the child's close event.
    const stopGroup = vi.fn((pid: number) => { process.kill(-pid, 'SIGKILL') })
    const failure = await runNotify(
      EVENT, [process.execPath, fixture('sleeper.mjs')], { timeoutMs: 100, stopGroup },
    )
    expect(stopGroup).toHaveBeenCalledTimes(1)
    expect(stopGroup).toHaveBeenCalledWith(expect.any(Number))
    expect(failure).toBe('timed out after 100 ms')
  })

  it('reports a throwing group stop instead of killing the host group', async () => {
    const failure = await runNotify(
      EVENT, [process.execPath, fixture('sleeper.mjs')],
      { timeoutMs: 100, stopGroup: () => { throw new Error('EPERM') } },
    )
    expect(failure).toContain('failed to stop the notification process group')
  })
})
