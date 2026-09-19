/**
 * Serialized integration semantics against a real project repository: a
 * finished task fast-forwards the target branch; a task behind a moved
 * baseline rebases and then fast-forwards; a conflicting task reports the
 * conflict and leaves no rebase state behind; concurrent integrations run
 * serially and end consistent with serial execution; a stale lock file is
 * cleaned; and every git failure is reported as a failed result without half
 * state.
 * @module integrate.spec
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { allocateWorkspace } from '../src/allocate.ts'
import { integrate, rebaseOnto } from '../src/integration.ts'
import { integrationLockPath } from '../src/integration-lock.ts'
import type { IntegrationResult } from '../src/types.ts'
import { makeSandbox, removeSandbox, commitAll, git, type Sandbox } from './harness.ts'

const execFileAsync = promisify(execFile)

/**
 * Expect a failed integration whose reason contains the fragment.
 * @param result - the integration outcome.
 * @param fragment - text the failure reason must contain.
 */
function expectFailedWith(result: IntegrationResult, fragment: string): void {
  expect(result.status).toBe('failed')
  if (result.status !== 'failed') throw new Error('unreachable')
  expect(result.reason).toContain(fragment)
}

let sandbox: Sandbox | undefined

afterEach(async () => {
  if (sandbox !== undefined) await removeSandbox(sandbox)
  sandbox = undefined
})

/** Allocate one task in the current sandbox. */
async function allocate(taskId: string, baseCommit?: string) {
  return allocateWorkspace(sandbox!.config, {
    taskId,
    projectRoot: sandbox!.projectRoot,
    ...(baseCommit === undefined ? {} : { baseCommit }),
  })
}

/** Commit a changed marker file in a worktree. */
async function commitMarker(worktree: string, content: string, message: string): Promise<string> {
  await writeFile(join(worktree, 'marker.txt'), content)
  return commitAll(worktree, message)
}

/** Whether the project repository holds no rebase state and a clean status. */
async function projectIsClean(projectRoot: string): Promise<boolean> {
  const status = await git(projectRoot, ['status', '--porcelain'])
  const gitDir = (await execFileAsync('git', ['rev-parse', '--absolute-git-dir'], { cwd: projectRoot })).stdout.trim()
  return status.trim().length === 0 && !existsSync(join(gitDir, 'rebase-merge')) && !existsSync(join(gitDir, 'rebase-apply'))
}

describe('integration', () => {
  it('fast-forwards the target branch to a finished task', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    const commit = await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expect(result).toEqual({ status: 'integrated', commit })
    await expect(git(sandbox.projectRoot, ['rev-parse', 'main'])).resolves.toContain(commit)
    await expect(readFile(join(sandbox.projectRoot, 'marker.txt'), 'utf8')).resolves.toBe('task-a done\n')
  })

  it('rebases a task whose baseline moved and then fast-forwards when there is no conflict', async () => {
    sandbox = await makeSandbox()
    const base = (await git(sandbox.projectRoot, ['rev-parse', 'HEAD'])).trim()
    const workspace = await allocate('task-a', base)
    // Task A edits one file; task B edits another, both against the same base.
    const commitA = await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const other = await allocate('task-b', base)
    await writeFile(join(other.worktree, 'other.txt'), 'task-b work\n')
    await commitAll(other.worktree, 'task-b work')
    await integrate(sandbox.config, { taskId: 'task-b', targetBranch: 'main', actor: 'tester' })
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expect(result.status).toBe('integrated')
    if (result.status !== 'integrated') throw new Error('unreachable')
    // The rebase rewrote the task commit onto the moved baseline, so the
    // integrated commit differs from the pre-rebase commit but carries its
    // change, and main fast-forwarded to it.
    expect(result.commit).not.toBe(commitA)
    await expect(git(sandbox.projectRoot, ['rev-parse', 'main'])).resolves.toContain(result.commit)
    await expect(readFile(join(sandbox.projectRoot, 'marker.txt'), 'utf8')).resolves.toBe('task-a done\n')
  })

  it('reports a conflict with the files and leaves no rebase state behind', async () => {
    sandbox = await makeSandbox()
    const base = (await git(sandbox.projectRoot, ['rev-parse', 'HEAD'])).trim()
    const a = await allocate('task-a', base)
    await commitMarker(a.worktree, 'task-a version\n', 'task-a work')
    await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    const c = await allocate('task-c', base)
    const headBefore = await commitMarker(c.worktree, 'task-c version\n', 'task-c work')
    const result = await integrate(sandbox.config, { taskId: 'task-c', targetBranch: 'main', actor: 'tester' })
    expect(result).toEqual({ status: 'conflict', files: ['marker.txt'], baseMoved: true })
    // The worktree keeps its own commit and a clean status; the project keeps
    // no rebase state.
    await expect(git(c.worktree, ['rev-parse', 'HEAD'])).resolves.toContain(headBefore)
    await expect(git(c.worktree, ['status', '--porcelain'])).resolves.toBe('')
    expect(await projectIsClean(sandbox.projectRoot)).toBe(true)
    await expect(git(sandbox.projectRoot, ['rev-parse', 'main'])).resolves.not.toContain(headBefore)
  })

  it('is serial under concurrent calls and ends consistent with serial execution', async () => {
    sandbox = await makeSandbox()
    const base = (await git(sandbox.projectRoot, ['rev-parse', 'HEAD'])).trim()
    const a = await allocate('task-a', base)
    await commitMarker(a.worktree, 'task-a version\n', 'task-a work')
    const b = await allocate('task-b', base)
    await writeFile(join(b.worktree, 'other.txt'), 'task-b work\n')
    await commitAll(b.worktree, 'task-b work')
    const [first, second] = await Promise.all([
      integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' }),
      integrate(sandbox.config, { taskId: 'task-b', targetBranch: 'main', actor: 'tester' }),
    ])
    expect(first).toMatchObject({ status: 'integrated' })
    expect(second).toMatchObject({ status: 'integrated' })
    // Serially consistent: whichever task integrated last owns the final
    // fast-forwarded main, and both commits are in its history.
    const finalMain = (await git(sandbox.projectRoot, ['rev-parse', 'main'])).trim()
    expect([first, second].some(result => result.status === 'integrated' && result.commit === finalMain)).toBe(true)
    await expect(git(sandbox.projectRoot, ['merge-base', '--is-ancestor', 'selfdev/task-a', finalMain])).resolves.toEqual('')
    await expect(git(sandbox.projectRoot, ['merge-base', '--is-ancestor', 'selfdev/task-b', finalMain])).resolves.toEqual('')
    expect(await projectIsClean(sandbox.projectRoot)).toBe(true)
  })

  it('integrates a task twice into an already-integrated target', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    const commit = await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    const again = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expect(again).toEqual({ status: 'integrated', commit })
  })

  it('fast-forwards an unchecked-out target branch through a compare-and-swap ref update', async () => {
    sandbox = await makeSandbox()
    await git(sandbox.projectRoot, ['branch', 'release'])
    const workspace = await allocate('task-a')
    const commit = await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'release', actor: 'tester' })
    expect(result).toEqual({ status: 'integrated', commit })
    await expect(git(sandbox.projectRoot, ['rev-parse', 'release'])).resolves.toContain(commit)
    await expect(git(sandbox.projectRoot, ['rev-parse', 'main'])).resolves.not.toContain(commit)
  })

  it('fetches a configured upstream and integrates its newer tip', async () => {
    sandbox = await makeSandbox()
    // A bare origin, one clone as the project, one clone as the upstream
    // writer: the project's local main starts behind origin/main.
    const origin = join(sandbox.root, 'origin.git')
    await execFileAsync('git', ['init', '-q', '--bare', origin])
    await execFileAsync('git', ['-C', sandbox.projectRoot, 'push', '--quiet', origin, 'main'])
    const projectRoot = join(sandbox.root, 'clone')
    await execFileAsync('git', ['clone', '--quiet', origin, projectRoot])
    const config = { ...sandbox.config, experimentsRoot: sandbox.experimentsRoot }
    const workspace = await allocateWorkspace(config, { taskId: 'task-a', projectRoot })
    const commit = await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const pusher = join(sandbox.root, 'pusher')
    await execFileAsync('git', ['clone', '--quiet', origin, pusher])
    await writeFile(join(pusher, 'upstream.txt'), 'upstream work\n')
    await commitAll(pusher, 'upstream work')
    await execFileAsync('git', ['-C', pusher, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
    const result = await integrate(config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expect(result.status).toBe('integrated')
    if (result.status !== 'integrated') throw new Error('unreachable')
    // The rebase onto the fetched upstream tip rewrote the task commit.
    expect(result.commit).not.toBe(commit)
    const clonedMain = (await execFileAsync('git', ['-C', projectRoot, 'rev-parse', 'main'], {})).stdout.trim()
    expect(clonedMain).toBe(result.commit)
    await expect(readFile(join(projectRoot, 'marker.txt'), 'utf8')).resolves.toBe('task-a done\n')
    await expect(readFile(join(projectRoot, 'upstream.txt'), 'utf8')).resolves.toBe('upstream work\n')
  })

  it('falls back to the local branch when the upstream config value is empty', async () => {
    sandbox = await makeSandbox()
    await git(sandbox.projectRoot, ['config', 'branch.main.remote', ''])
    const workspace = await allocate('task-a')
    const commit = await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expect(result).toEqual({ status: 'integrated', commit })
  })

  it('creates a local target branch from the fetched upstream tip when none exists', async () => {
    sandbox = await makeSandbox()
    // The project works on branch `dev`; `main` exists only on the bare
    // origin, with branch.main.remote configured so the integration fetches
    // it and fast-forwards the local branch into existence.
    await execFileAsync('git', ['-C', sandbox.projectRoot, 'branch', '-m', 'main', 'dev'])
    const origin = join(sandbox.root, 'origin.git')
    await execFileAsync('git', ['init', '-q', '--bare', origin])
    await execFileAsync('git', ['-C', sandbox.projectRoot, 'push', '--quiet', origin, 'dev:refs/heads/main'])
    await execFileAsync('git', ['-C', sandbox.projectRoot, 'remote', 'add', 'origin', origin])
    await execFileAsync('git', ['-C', sandbox.projectRoot, 'fetch', '--quiet', origin, 'main'])
    await git(sandbox.projectRoot, ['config', 'branch.main.remote', 'origin'])
    const workspace = await allocate('task-a')
    const commit = await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expect(result).toEqual({ status: 'integrated', commit })
    const created = (await execFileAsync('git', ['-C', sandbox.projectRoot, 'rev-parse', 'main'], {})).stdout.trim()
    expect(created).toBe(commit)
    // `main` is not checked out anywhere: the ref moves, the working tree of
    // the checked-out `dev` branch does not.
    await expect(git(sandbox.projectRoot, ['symbolic-ref', '--short', 'HEAD'])).resolves.toBe('dev\n')
  })

  it('reports a failed integration when the target branch does not exist', async () => {
    sandbox = await makeSandbox()
    await allocate('task-a')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'no-such-branch', actor: 'tester' })
    expectFailedWith(result, 'was not found')
  })

  it('reports a failed integration when the worktree has uncommitted changes', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    await writeFile(join(workspace.worktree, 'marker.txt'), 'uncommitted\n')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expectFailedWith(result, 'uncommitted')
  })

  it('reports a failed integration when the worktree index is corrupt', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    // A corrupt index makes the cleanliness check fail inside the locked
    // steps; the boundary reports it as a failed result, not a throw.
    const gitDir = (await execFileAsync('git', ['-C', workspace.worktree, 'rev-parse', '--absolute-git-dir'], {})).stdout.trim()
    await writeFile(join(gitDir, 'index'), 'corrupt\n')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expect(result.status).toBe('failed')
  })

  it('reports a failed integration when the worktree lost its git directory', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    await rm(join(workspace.worktree, '.git'), { force: true })
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expectFailedWith(result, 'HEAD')
  })

  it('reports a failed integration when the worktree HEAD does not contain the target tip', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    // An orphan commit shares no history with the baseline, so the target tip
    // is unchanged and yet not an ancestor of the worktree HEAD.
    await execFileAsync('git', ['checkout', '--orphan', 'detached-line'], { cwd: workspace.worktree })
    const commit = await commitMarker(workspace.worktree, 'orphan\n', 'orphan work')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expectFailedWith(result, 'does not contain target tip')
    void commit
  })

  it('refuses to fast-forward a target branch checked out in another worktree', async () => {
    sandbox = await makeSandbox()
    const otherPath = join(sandbox.root, 'holding-worktree')
    await git(sandbox.projectRoot, ['worktree', 'add', '-b', 'release', otherPath])
    const workspace = await allocate('task-a')
    await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'release', actor: 'tester' })
    expectFailedWith(result, 'checked out')
    await expect(git(sandbox.projectRoot, ['rev-parse', 'release'])).resolves.not.toContain(
      (await git(workspace.worktree, ['rev-parse', 'HEAD'])).trim(),
    )
  })

  it('reports a failed rebase that never entered a rebase state', async () => {
    sandbox = await makeSandbox()
    const base = (await git(sandbox.projectRoot, ['rev-parse', 'HEAD'])).trim()
    const workspace = await allocate('task-a', base)
    await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    // Move the baseline so the integration must rebase, then block the index:
    // git refuses the rebase without entering rebase state.
    const other = await allocate('task-b', base)
    await writeFile(join(other.worktree, 'other.txt'), 'task-b work\n')
    await commitAll(other.worktree, 'task-b work')
    await integrate(sandbox.config, { taskId: 'task-b', targetBranch: 'main', actor: 'tester' })
    const gitDir = (await execFileAsync('git', ['-C', workspace.worktree, 'rev-parse', '--absolute-git-dir'], {})).stdout.trim()
    await writeFile(join(gitDir, 'index.lock'), 'blocked\n')
    try {
      const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
      expect(result.status).toBe('failed')
      expect(await projectIsClean(sandbox.projectRoot)).toBe(true)
    } finally {
      await rm(join(gitDir, 'index.lock'), { force: true })
    }
  })

  it('reports a failed integration when the rebase abort itself fails', async () => {
    sandbox = await makeSandbox()
    const base = (await git(sandbox.projectRoot, ['rev-parse', 'HEAD'])).trim()
    const a = await allocate('task-a', base)
    await commitMarker(a.worktree, 'task-a version\n', 'task-a work')
    await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    const c = await allocate('task-c', base)
    await commitMarker(c.worktree, 'task-c version\n', 'task-c work')
    // Park the worktree in a real conflict state, then block the index so the
    // abort inside the next rebase attempt cannot write.
    const mainTip = (await git(sandbox.projectRoot, ['rev-parse', 'main'])).trim()
    await execFileAsync('git', ['-C', c.worktree, 'rebase', mainTip]).catch(() => undefined)
    const gitDir = (await execFileAsync('git', ['-C', c.worktree, 'rev-parse', '--absolute-git-dir'], {})).stdout.trim()
    await writeFile(join(gitDir, 'index.lock'), 'blocked\n')
    try {
      const outcome = await rebaseOnto(c.worktree, mainTip)
      expect(outcome.status).toBe('failed')
      expect((outcome as { reason: string }).reason).toContain('abort')
    } finally {
      await rm(join(gitDir, 'index.lock'), { force: true })
      await execFileAsync('git', ['-C', c.worktree, 'rebase', '--abort']).catch(() => undefined)
    }
  })

  it('refuses an unknown task', async () => {
    sandbox = await makeSandbox()
    await expect(integrate(sandbox.config, { taskId: 'task-never', targetBranch: 'main', actor: 'tester' }))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_TASK_UNKNOWN' })
  })

  it('refuses an empty target branch name', async () => {
    sandbox = await makeSandbox()
    await allocate('task-a')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: '', actor: 'tester' })
    expectFailedWith(result, 'targetBranch')
  })

  it('cleans a stale integration lock whose recorded pid no longer exists', async () => {
    sandbox = await makeSandbox()
    await mkdir(sandbox.experimentsRoot, { recursive: true })
    // Record a pid that is guaranteed dead: a process we spawned and waited for.
    const { pid } = await spawnAndExitReal()
    await writeFile(integrationLockPath(sandbox.experimentsRoot), `${JSON.stringify({ pid, acquiredAt: 1 })}\n`)
    const workspace = await allocate('task-a')
    const commit = await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expect(result).toEqual({ status: 'integrated', commit })
    expect(existsSync(integrationLockPath(sandbox.experimentsRoot))).toBe(false)
  })

  it('tolerates an unreadable lock file by treating it as stale', async () => {
    sandbox = await makeSandbox()
    await mkdir(sandbox.experimentsRoot, { recursive: true })
    await writeFile(integrationLockPath(sandbox.experimentsRoot), 'not json at all\n')
    const workspace = await allocate('task-a')
    await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expect(result.status).toBe('integrated')
    if (result.status !== 'integrated') throw new Error('unreachable')
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/)
  })
})

/**
 * Spawn a short-lived process and wait for its exit, returning its now-dead pid.
 * @returns the dead pid.
 */
function spawnAndExitReal(): Promise<{ readonly pid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    child.on('exit', () => {
      resolve({ pid: child.pid ?? -1 })
    })
    child.on('error', reject)
  })
}
