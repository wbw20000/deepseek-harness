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
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { allocateWorkspace } from '../src/allocate.ts'
import { integrate, rebaseOnto } from '../src/integration.ts'
import { integrationLockPath } from '../src/integration-lock.ts'
import type { IntegrationResult, SnapshotIdentity, VerifyOutcome } from '../src/types.ts'
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
    expect(result).toEqual({ status: 'integrated', commit, baseMoved: false })
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
    // The second call's target tip (now the first call's fast-forwarded main)
    // differs from the allocation's original baseCommit, so this integration
    // detects a moved baseline — and rebases onto it, a no-op since the
    // worktree HEAD already is that tip — even though the fast-forward itself
    // has nothing left to move.
    expect(again).toEqual({ status: 'integrated', commit, baseMoved: true })
  })

  it('fast-forwards an unchecked-out target branch through a compare-and-swap ref update', async () => {
    sandbox = await makeSandbox()
    await git(sandbox.projectRoot, ['branch', 'release'])
    const workspace = await allocate('task-a')
    const commit = await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'release', actor: 'tester' })
    expect(result).toEqual({ status: 'integrated', commit, baseMoved: false })
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
    expect(result).toEqual({ status: 'integrated', commit, baseMoved: false })
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
    expect(result).toEqual({ status: 'integrated', commit, baseMoved: false })
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
    expect(result).toEqual({ status: 'integrated', commit, baseMoved: false })
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

describe('integration verify gate', () => {
  it('calls verify after the rebase and before the fast-forward, handing it the rebased worktree', async () => {
    sandbox = await makeSandbox()
    const base = (await git(sandbox.projectRoot, ['rev-parse', 'HEAD'])).trim()
    const workspace = await allocate('task-a', base)
    const commitA = await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const other = await allocate('task-b', base)
    await writeFile(join(other.worktree, 'other.txt'), 'task-b work\n')
    await commitAll(other.worktree, 'task-b work')
    const movedMain = await integrate(sandbox.config, { taskId: 'task-b', targetBranch: 'main', actor: 'tester' })
    expect(movedMain.status).toBe('integrated')
    const calls: Array<{ worktree: string; head: string; mainTipAtCall: string }> = []
    const verify = async (worktree: string): Promise<VerifyOutcome> => {
      calls.push({
        worktree,
        head: (await git(worktree, ['rev-parse', 'HEAD'])).trim(),
        mainTipAtCall: (await git(sandbox!.projectRoot, ['rev-parse', 'main'])).trim(),
      })
      return { ok: true }
    }
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester', verify })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.worktree).toBe(workspace.worktree)
    // The rebase rewrote task-a's commit onto the moved baseline, so verify
    // observes a HEAD that differs from the pre-rebase commit.
    expect(calls[0]!.head).not.toBe(commitA)
    // main had not yet moved to task-a's content when verify ran: the
    // fast-forward is still ahead of it.
    if (movedMain.status !== 'integrated') throw new Error('unreachable')
    expect(calls[0]!.mainTipAtCall).toBe(movedMain.commit)
    expect(result.status).toBe('integrated')
    if (result.status !== 'integrated') throw new Error('unreachable')
    expect(result.baseMoved).toBe(true)
    await expect(git(sandbox.projectRoot, ['rev-parse', 'main'])).resolves.toContain(result.commit)
  })

  it('calls verify before the fast-forward even when the baseline never moved', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    const commit = await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const calls: string[] = []
    const verify = async (worktree: string): Promise<VerifyOutcome> => {
      calls.push(worktree)
      // main must not have fast-forwarded yet when the gate runs.
      await expect(git(sandbox!.projectRoot, ['rev-parse', 'main'])).resolves.not.toContain(commit)
      return { ok: true }
    }
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester', verify })
    expect(calls).toEqual([workspace.worktree])
    expect(result).toEqual({ status: 'integrated', commit, baseMoved: false })
  })

  it('does not fast-forward, keeps the rebase result in the worktree, and releases the lock when verify fails', async () => {
    sandbox = await makeSandbox()
    const base = (await git(sandbox.projectRoot, ['rev-parse', 'HEAD'])).trim()
    const a = await allocate('task-a', base)
    const commitA = await commitMarker(a.worktree, 'task-a done\n', 'task-a work')
    const other = await allocate('task-b', base)
    await writeFile(join(other.worktree, 'other.txt'), 'task-b work\n')
    await commitAll(other.worktree, 'task-b work')
    await integrate(sandbox.config, { taskId: 'task-b', targetBranch: 'main', actor: 'tester' })
    const mainBefore = (await git(sandbox.projectRoot, ['rev-parse', 'main'])).trim()
    const verify = async (): Promise<VerifyOutcome> => ({ ok: false, reason: 'acceptance gate failed' })
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester', verify })
    expect(result).toEqual({ status: 'verification-failed', reason: 'acceptance gate failed', baseMoved: true })
    // The rebase already ran and is kept: the worktree HEAD moved off the
    // pre-rebase commit and the worktree is clean, not aborted mid-rebase.
    const headAfter = (await git(a.worktree, ['rev-parse', 'HEAD'])).trim()
    expect(headAfter).not.toBe(commitA)
    await expect(git(a.worktree, ['status', '--porcelain'])).resolves.toBe('')
    // main never moved: the fast-forward was skipped.
    await expect(git(sandbox.projectRoot, ['rev-parse', 'main'])).resolves.toBe(`${mainBefore}\n`)
    // The lock released: nothing is left holding it.
    expect(existsSync(integrationLockPath(sandbox.experimentsRoot))).toBe(false)
  })

  it('treats a throwing verify as a failed verification, carrying the error text as the reason', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const verify = async (): Promise<VerifyOutcome> => {
      throw new Error('boom')
    }
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester', verify })
    expect(result.status).toBe('verification-failed')
    if (result.status !== 'verification-failed') throw new Error('unreachable')
    expect(result.reason).toContain('boom')
    expect(result.baseMoved).toBe(false)
    expect(existsSync(integrationLockPath(sandbox.experimentsRoot))).toBe(false)
  })
})

describe('integration snapshot', () => {
  const snapshotIdentity: SnapshotIdentity = {
    message: 'snapshot: experiment agent scratch work',
    author: { name: 'Experiment Agent', email: 'agent@example.invalid' },
  }

  /**
   * Install a `pre-commit` hook that would fail any commit that actually runs
   * it. `--git-path` answers where the shared hooks directory lives, absolute
   * from a linked worktree like the ones under test here.
   */
  async function installBlockingPreCommitHook(worktree: string): Promise<void> {
    const hookDir = resolve(worktree, (await git(worktree, ['rev-parse', '--git-path', 'hooks'])).trim())
    const hookPath = join(hookDir, 'pre-commit')
    await mkdir(hookDir, { recursive: true })
    await writeFile(hookPath, '#!/bin/sh\necho "pre-commit ran" > hook-ran.marker\nexit 1\n', { mode: 0o755 })
  }

  it('snapshots a dirty worktree under the given identity, skips hooks and GPG, and carries the commit into the target branch', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    await installBlockingPreCommitHook(workspace.worktree)
    // An untracked file an experiment agent left behind, exactly the shape
    // that a plain `integrate` would otherwise report as "uncommitted
    // changes" and lose on rebase or fast-forward.
    await writeFile(join(workspace.worktree, 'scratch.mjs'), 'console.log("smoke")\n')
    const result = await integrate(sandbox.config, {
      taskId: 'task-a', targetBranch: 'main', actor: 'tester', snapshot: snapshotIdentity,
    })
    expect(result.status).toBe('integrated')
    if (result.status !== 'integrated') throw new Error('unreachable')
    expect(result.snapshotCommit).toBeDefined()
    const snapshotCommit = result.snapshotCommit!
    // Nothing else moved the worktree onward from the snapshot: the
    // integrated commit is the snapshot commit itself.
    expect(result.commit).toBe(snapshotCommit)
    expect((await git(workspace.worktree, ['log', '-1', '--format=%an <%ae>', snapshotCommit])).trim())
      .toBe('Experiment Agent <agent@example.invalid>')
    expect((await git(workspace.worktree, ['log', '-1', '--format=%s', snapshotCommit])).trim())
      .toBe('snapshot: experiment agent scratch work')
    // The blocking hook never ran: git commit succeeded (unsigned, no
    // verification) despite it, and it never wrote its marker.
    expect(existsSync(join(workspace.worktree, 'hook-ran.marker'))).toBe(false)
    // The target branch now contains the snapshot commit and the file it captured.
    await expect(git(sandbox.projectRoot, ['rev-parse', 'main'])).resolves.toContain(snapshotCommit)
    await expect(readFile(join(sandbox.projectRoot, 'scratch.mjs'), 'utf8')).resolves.toBe('console.log("smoke")\n')
  })

  it('produces no commit and no snapshotCommit for a clean worktree even when a snapshot identity is supplied', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    const commit = await commitMarker(workspace.worktree, 'task-a done\n', 'task-a work')
    const result = await integrate(sandbox.config, {
      taskId: 'task-a', targetBranch: 'main', actor: 'tester', snapshot: snapshotIdentity,
    })
    expect(result).toEqual({ status: 'integrated', commit, baseMoved: false })
    expect(Object.hasOwn(result, 'snapshotCommit')).toBe(false)
  })

  it('fails without touching the worktree when it is dirty and no snapshot identity was supplied', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    await writeFile(join(workspace.worktree, 'scratch.mjs'), 'console.log("smoke")\n')
    const result = await integrate(sandbox.config, { taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expect(result).toEqual({
      status: 'failed',
      reason: 'worktree has uncommitted changes and no snapshot identity was supplied',
    })
    // Nothing moved: the worktree is still dirty with the same untracked
    // file, and main is still at the allocation baseline.
    expect((await git(workspace.worktree, ['status', '--porcelain'])).trim()).toContain('scratch.mjs')
    await expect(readFile(join(workspace.worktree, 'scratch.mjs'), 'utf8')).resolves.toBe('console.log("smoke")\n')
    await expect(git(sandbox.projectRoot, ['rev-parse', 'main'])).resolves.toContain(workspace.baseCommit)
  })

  it('attaches snapshotCommit to a non-integrated result too', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    await writeFile(join(workspace.worktree, 'scratch.mjs'), 'console.log("smoke")\n')
    const verify = async (): Promise<VerifyOutcome> => ({ ok: false, reason: 'gate failed' })
    const result = await integrate(sandbox.config, {
      taskId: 'task-a', targetBranch: 'main', actor: 'tester', snapshot: snapshotIdentity, verify,
    })
    expect(result.status).toBe('verification-failed')
    if (result.status !== 'verification-failed') throw new Error('unreachable')
    expect(result.snapshotCommit).toBeDefined()
    expect(result.reason).toBe('gate failed')
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
