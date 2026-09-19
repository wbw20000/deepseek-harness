/**
 * Integration lock behavior: exclusive acquisition with pid records, release
 * on completion and on throw, stale locks removed by pid liveness but only
 * while the file still holds the stale content, unreadable locks treated as
 * stale, and a live holder that outlasts the wait is refused with the busy
 * code.
 * @module integration-lock.spec
 */

import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { integrationLockPath, pidAlive, withIntegrationLock } from '../src/integration-lock.ts'

// Interception hook for the lock-file reads of one test: the hook maps a path
// to replacement content, and `undefined` reads through to the real file. It
// is only set while the race test runs and is cleared in its finally.
const lockReads = vi.hoisted(() => ({
  override: undefined as undefined | ((path: string) => string | undefined),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFile = actual.readFile
  return {
    ...actual,
    readFile: ((path: Parameters<typeof readFile>[0], options?: Parameters<typeof readFile>[1]) => {
      const key = typeof path === 'string' ? path : ''
      const replacement = lockReads.override?.(key)
      if (replacement !== undefined) {
        return Promise.resolve(Buffer.from(replacement, 'utf8')) as ReturnType<typeof readFile>
      }
      return readFile(path, options)
    }) as typeof readFile,
  }
})

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Spawn a short-lived process and resolve with its pid once it is dead.
 * @returns the dead pid.
 */
async function exitThenReturnPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  const pid = child.pid ?? -1
  await new Promise<void>((resolve, reject) => {
    child.on('exit', () => {
      resolve()
    })
    child.on('error', reject)
  })
  return pid
}

describe('integration lock', () => {
  it('acquires, runs, and releases the lock', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-lock-'))
    const ran = await withIntegrationLock(root, async () => 'done')
    expect(ran).toBe('done')
    expect(existsSync(integrationLockPath(root))).toBe(false)
  })

  it('releases the lock when the work throws', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-lock-'))
    await expect(withIntegrationLock(root, async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(existsSync(integrationLockPath(root))).toBe(false)
    // A following acquisition succeeds.
    await expect(withIntegrationLock(root, async () => 'again')).resolves.toBe('again')
  })

  it('removes a stale lock whose pid is dead', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-lock-'))
    const deadPid = await exitThenReturnPid()
    await writeFile(integrationLockPath(root), `${JSON.stringify({ pid: deadPid, acquiredAt: 1 })}\n`)
    await expect(withIntegrationLock(root, async () => 'recovered')).resolves.toBe('recovered')
    expect(existsSync(integrationLockPath(root))).toBe(false)
  })

  it('does not remove a lock that a live holder rewrote between the stale read and the removal', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-lock-'))
    const lockPath = integrationLockPath(root)
    const deadPid = await exitThenReturnPid()
    const stale = `${JSON.stringify({ pid: deadPid, acquiredAt: 1 })}\n`
    const live = `${JSON.stringify({ pid: process.pid, acquiredAt: 2 })}\n`
    // The on-disk record is the live holder's; only the acquirer's first read
    // still sees the stale content, as when a holder rewrote the file between
    // the two reads. The removal must re-check and leave the live record up.
    await writeFile(lockPath, live)
    let reads = 0
    lockReads.override = path => path === lockPath && reads < 1 ? (reads += 1, stale) : undefined
    try {
      await expect(withIntegrationLock(root, async () => 'never', { maxWaitMs: 200 }))
        .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_INTEGRATION_BUSY' })
    } finally {
      lockReads.override = undefined
    }
    expect(await readFile(lockPath, 'utf8')).toBe(live)
  })

  it('treats an unreadable or pid-less lock file as stale', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-lock-'))
    await writeFile(integrationLockPath(root), 'garbage\n')
    await expect(withIntegrationLock(root, async () => 'ok')).resolves.toBe('ok')
  })

  it.each([
    ['a non-object record', '"just a string"\n'],
    ['a record without a numeric pid', '{"pid":"yesterday"}\n'],
  ])('treats %s as stale', async (_name, content) => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-lock-'))
    await writeFile(integrationLockPath(root), content)
    await expect(withIntegrationLock(root, async () => 'ok')).resolves.toBe('ok')
  })

  it('waits for a live holder, then takes over when it exits', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-lock-'))
    // A holder that stays alive briefly: the acquirer polls, sees the stale
    // takeover once the pid is gone, and completes its work.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 250)'])
    const pid = child.pid ?? -1
    await writeFile(integrationLockPath(root), `${JSON.stringify({ pid, acquiredAt: 1 })}\n`)
    await expect(withIntegrationLock(root, async () => 'recovered', { maxWaitMs: 10_000 })).resolves.toBe('recovered')
    expect(existsSync(integrationLockPath(root))).toBe(false)
  })

  it('refuses with the busy code when a live holder outlasts the wait', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-lock-'))
    await writeFile(integrationLockPath(root), `${JSON.stringify({ pid: process.pid, acquiredAt: 1 })}\n`)
    await expect(withIntegrationLock(root, async () => 'never', { maxWaitMs: 200 }))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_INTEGRATION_BUSY' })
    // The refused attempt releases nothing it does not hold.
    expect(await readFile(integrationLockPath(root), 'utf8')).toContain(String(process.pid))
  })

  it('treats a lock file it cannot read as stale', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-lock-'))
    const lockPath = integrationLockPath(root)
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, acquiredAt: 1 })}\n`)
    await chmod(lockPath, 0o000)
    await expect(withIntegrationLock(root, async () => 'recovered')).resolves.toBe('recovered')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('propagates a lock file that cannot be created at all', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-lock-'))
    await chmod(root, 0o555)
    try {
      await expect(withIntegrationLock(root, async () => 'never')).rejects.toMatchObject({
        code: 'EACCES',
      })
    } finally {
      await chmod(root, 0o755)
    }
  })

  it('judges pid liveness', async () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
    expect(pidAlive(Number.NaN)).toBe(false)
    expect(pidAlive(await exitThenReturnPid())).toBe(false)
  })

  it('names the lock file after the experiments root', () => {
    expect(integrationLockPath('/experiments')).toBe(join('/experiments', 'integration.lock'))
  })
})
