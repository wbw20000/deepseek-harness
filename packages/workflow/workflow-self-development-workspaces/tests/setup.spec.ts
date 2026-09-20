/**
 * `runWorkspaceSetup` behavior against the real `setup-case.mjs` fixture: a
 * clean exit resolves with the command's `cwd` set to the worktree; a
 * non-zero exit, a signal-terminated command, an empty argv, and an
 * unspawnable command all reject with `SELF_DEV_WORKSPACE_SETUP_FAILED` and a
 * message carrying the command and the retained output tail; a deadline
 * kills the command's whole process group, not just its direct child; and
 * `assertSetupPlatformSupport` refuses Windows before anything spawns.
 * @module setup.spec
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSetupPlatformSupport, runWorkspaceSetup } from '../src/setup.ts'

/** Absolute path of the fake setup command fixture. */
const fixture = fileURLToPath(new URL('./fixtures/setup-case.mjs', import.meta.url))

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A temporary worktree-like directory the fixture runs against. */
async function makeWorktree(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'self-dev-setup-'))
  return root
}

/** Reject and read the boundary error, or fail the assertion when it resolved. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => { throw new Error('expected runWorkspaceSetup to reject') },
    (error: unknown) => error,
  )
}

describe('runWorkspaceSetup', () => {
  it('runs the command with the worktree as cwd and resolves once it exits cleanly', async () => {
    const worktree = await makeWorktree()
    await expect(runWorkspaceSetup(worktree, {
      command: ['node', fixture, 'write', 'marker.txt', 'setup ran\n'],
      timeoutMs: 5000,
    })).resolves.toBeUndefined()
    await expect(readFile(join(worktree, 'marker.txt'), 'utf8')).resolves.toBe('setup ran\n')
  })

  it('rejects with the command and the retained output when the command exits non-zero', async () => {
    const worktree = await makeWorktree()
    const command = ['node', fixture, 'fail', '3', 'install failed here\n']
    const error = await rejection(runWorkspaceSetup(worktree, { command, timeoutMs: 5000 }))
    expect(error).toMatchObject({ code: 'SELF_DEV_WORKSPACE_SETUP_FAILED' })
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toContain(JSON.stringify(command))
    expect(message).toContain('exited with code 3')
    expect(message).toContain('install failed here')
  })

  it('rejects when the command is killed by a signal', async () => {
    const worktree = await makeWorktree()
    const error = await rejection(runWorkspaceSetup(worktree, { command: ['node', fixture, 'crash'], timeoutMs: 5000 }))
    expect(error).toMatchObject({ code: 'SELF_DEV_WORKSPACE_SETUP_FAILED' })
    expect(error instanceof Error ? error.message : String(error)).toContain('killed by signal SIGTERM')
  })

  it('rejects and kills the command\'s whole process group when the deadline fires', async () => {
    const worktree = await makeWorktree()
    const pidfile = join(worktree, 'grandchild.pid')
    const error = await rejection(runWorkspaceSetup(worktree, {
      command: ['node', fixture, 'spawn-grandchild', pidfile, '60000'],
      timeoutMs: 300,
    }))
    expect(error).toMatchObject({ code: 'SELF_DEV_WORKSPACE_SETUP_FAILED' })
    expect(error instanceof Error ? error.message : String(error)).toContain('did not finish within 300 ms')
    // The grandchild is a sibling in the same process group, not the group
    // leader: it only dies if the timeout kills the whole group, not just the
    // direct child.
    const grandchildPid = Number((await readFile(pidfile, 'utf8')).trim())
    await expect.poll(() => pidAlive(grandchildPid), { timeout: 2000, interval: 20 }).toBe(false)
  })

  it('rejects when the configured argv is empty', async () => {
    const worktree = await makeWorktree()
    const error = await rejection(runWorkspaceSetup(worktree, { command: [], timeoutMs: 5000 }))
    expect(error).toMatchObject({ code: 'SELF_DEV_WORKSPACE_SETUP_FAILED' })
    expect(error instanceof Error ? error.message : String(error)).toContain('non-empty argv')
  })

  it('rejects when the command cannot spawn', async () => {
    const worktree = await makeWorktree()
    const error = await rejection(runWorkspaceSetup(worktree, {
      command: [join(worktree, 'no-such-setup-binary')],
      timeoutMs: 5000,
    }))
    expect(error).toMatchObject({ code: 'SELF_DEV_WORKSPACE_SETUP_FAILED' })
    expect(error instanceof Error ? error.message : String(error)).toContain('could not start')
  })

  it('retains only the last 2 KiB of combined output in the failure message', async () => {
    const worktree = await makeWorktree()
    const long = 'x'.repeat(3000)
    const error = await rejection(runWorkspaceSetup(worktree, { command: ['node', fixture, 'fail', '1', long], timeoutMs: 5000 }))
    const message = error instanceof Error ? error.message : String(error)
    const tailStart = message.indexOf('output tail: ') + 'output tail: '.length
    expect(message.length - tailStart).toBe(2048)
    expect(message.endsWith('x'.repeat(2048))).toBe(true)
  })
})

describe('assertSetupPlatformSupport', () => {
  it('refuses Windows and allows POSIX platforms', () => {
    expect(() => { assertSetupPlatformSupport('win32') }).toThrow('Windows execution is unavailable')
    expect(() => { assertSetupPlatformSupport('darwin') }).not.toThrow()
    expect(() => { assertSetupPlatformSupport('linux') }).not.toThrow()
  })
})

/**
 * Whether a pid still names a live process.
 * @param pid - numeric pid to probe.
 * @returns true when the process is still alive.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
