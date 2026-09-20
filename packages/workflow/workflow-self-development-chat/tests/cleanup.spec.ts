/**
 * Workspace reclamation: releasing one task's worktree (closing its trial
 * first), the merged-worktree git check, and the pre-allocation sweep over
 * finished tasks — stopped ones and merged `awaiting-trial` ones — that
 * leaves every unfinished or unreadable task alone.
 * @module cleanup.spec
 */

import { describe, expect, it } from 'vitest'
import { isFullyMerged, reclaimFinishedWorkspaces, releaseTaskWorkspace } from '../src/cleanup.ts'
import type { GitRunner } from '../src/cleanup.ts'
import type { TaskDetailView, TaskWorkspaceView, TrialInstance, TrialPort, WorkspacesPort } from '../src/types.ts'

/** A workspaces fake that records releases and can fail them. */
class FakeWorkspaces implements WorkspacesPort {
  registered: TaskWorkspaceView[] = []
  released: string[] = []
  listFailWith: Error | undefined
  releaseFailWith: Error | undefined

  allocate(): Promise<TaskWorkspaceView> {
    throw new Error('allocate is not exercised here')
  }

  integrate(): never {
    throw new Error('integrate is not exercised here')
  }

  async list(): Promise<readonly TaskWorkspaceView[]> {
    if (this.listFailWith !== undefined) throw this.listFailWith
    return this.registered
  }

  async release(taskId: string): Promise<void> {
    if (this.releaseFailWith !== undefined) throw this.releaseFailWith
    this.released.push(taskId)
  }
}

/** A trial fake with a configurable open set. */
class FakeTrial implements TrialPort {
  open: TrialInstance[] = []
  closed: string[] = []
  trialsFailWith: Error | undefined

  async trials(): Promise<readonly TrialInstance[]> {
    if (this.trialsFailWith !== undefined) throw this.trialsFailWith
    return this.open
  }

  async closeTrial(taskId: string): Promise<void> {
    this.closed.push(taskId)
  }
}

/** One registered workspace view for a task id. */
function workspaceOf(taskId: string): TaskWorkspaceView {
  return {
    taskId,
    projectRoot: '/repo',
    baseCommit: 'a'.repeat(40),
    worktree: `/exp/${taskId}`,
    branch: `self-dev/${taskId}`,
    dataHome: `/exp/${taskId}/.data`,
    allocatedAt: 1,
  }
}

/** A facade `getTask` fake answering a fixed status per task; an unknown task rejects. */
function facadeWithStatuses(statuses: Record<string, string>): { getTask(taskId: string): Promise<TaskDetailView> } {
  return {
    async getTask(taskId: string): Promise<TaskDetailView> {
      const status = statuses[taskId]
      if (status === undefined) throw new Error(`unknown task ${taskId}`)
      return { projection: { status, revision: 1 } } as unknown as TaskDetailView
    },
  }
}

/** A git runner answering a clean or dirty worktree and a contained or uncontained HEAD. */
function gitAnswering(options: { dirty?: readonly string[]; unmerged?: readonly string[] }): GitRunner {
  return async (args: readonly string[], cwd: string): Promise<string> => {
    if (args[0] === 'status') return options.dirty?.includes(cwd) === true ? ' M src/a.ts' : ''
    if (args[0] === 'merge-base') {
      if (options.unmerged?.includes(cwd) === true) throw new Error('git merge-base exited 1')
      return ''
    }
    throw new Error(`unexpected git call ${args.join(' ')}`)
  }
}

describe('releaseTaskWorkspace', () => {
  it('releases the workspace and reports it, without a trial service', async () => {
    const workspaces = new FakeWorkspaces()
    const outcome = await releaseTaskWorkspace({ workspaces, trial: undefined }, 'task-1')
    expect(outcome).toEqual({ released: true, detail: 'workspace of task-1 released' })
    expect(workspaces.released).toEqual(['task-1'])
  })

  it('closes an open trial on the worktree first and says so', async () => {
    const workspaces = new FakeWorkspaces()
    const trial = new FakeTrial()
    trial.open = [{ taskId: 'task-1', url: 'http://127.0.0.1:8980/', port: 8980, startedAt: 1 }]
    const outcome = await releaseTaskWorkspace({ workspaces, trial }, 'task-1')
    expect(outcome).toEqual({ released: true, detail: 'workspace of task-1 released (trial instance closed)' })
    expect(trial.closed).toEqual(['task-1'])
    expect(workspaces.released).toEqual(['task-1'])
  })

  it('leaves other tasks’ trials alone', async () => {
    const workspaces = new FakeWorkspaces()
    const trial = new FakeTrial()
    trial.open = [{ taskId: 'task-2', url: 'http://127.0.0.1:8981/', port: 8981, startedAt: 1 }]
    const outcome = await releaseTaskWorkspace({ workspaces, trial }, 'task-1')
    expect(outcome.released).toBe(true)
    expect(trial.closed).toEqual([])
  })

  it('does not release when the trial service fails, and reports why', async () => {
    const workspaces = new FakeWorkspaces()
    const trial = new FakeTrial()
    trial.trialsFailWith = new Error('trial service is down')
    const outcome = await releaseTaskWorkspace({ workspaces, trial }, 'task-1')
    expect(outcome).toEqual({ released: false, detail: 'trial instance for task-1 could not be closed: trial service is down' })
    expect(workspaces.released).toEqual([])
  })

  it('reports a failed release without throwing', async () => {
    const workspaces = new FakeWorkspaces()
    workspaces.releaseFailWith = new Error('task task-1 has no allocated workspace to release')
    const outcome = await releaseTaskWorkspace({ workspaces, trial: undefined }, 'task-1')
    expect(outcome).toEqual({
      released: false,
      detail: 'workspace of task-1 could not be released: task task-1 has no allocated workspace to release',
    })
  })
})

describe('isFullyMerged', () => {
  it('is true for a clean worktree whose HEAD the target branch contains', async () => {
    expect(await isFullyMerged(gitAnswering({}), '/exp/task-1', 'stable')).toBe(true)
  })

  it('is false for a dirty worktree, an uncontained HEAD, or a failing git', async () => {
    expect(await isFullyMerged(gitAnswering({ dirty: ['/exp/task-1'] }), '/exp/task-1', 'stable')).toBe(false)
    expect(await isFullyMerged(gitAnswering({ unmerged: ['/exp/task-1'] }), '/exp/task-1', 'stable')).toBe(false)
    const failing: GitRunner = async () => { throw new Error('not a git repository') }
    expect(await isFullyMerged(failing, '/exp/task-1', 'stable')).toBe(false)
  })
})

describe('reclaimFinishedWorkspaces', () => {
  it('releases stopped tasks and merged awaiting-trial tasks, and nothing else', async () => {
    const workspaces = new FakeWorkspaces()
    workspaces.registered = ['stopped-1', 'merged-1', 'running-1', 'fresh-1', 'unmerged-1', 'unknown-1'].map(workspaceOf)
    const facade = facadeWithStatuses({
      'stopped-1': 'stopped',
      'merged-1': 'awaiting-trial',
      'running-1': 'attempting',
      // A fresh allocation is clean and at the target tip, exactly like a
      // merged worktree: only the status keeps it.
      'fresh-1': 'ready',
      'unmerged-1': 'awaiting-trial',
    })
    const git = gitAnswering({ unmerged: ['/exp/unmerged-1'] })
    const outcomes = await reclaimFinishedWorkspaces({ workspaces, trial: undefined, facade, targetBranch: 'stable', git })
    expect(outcomes).toEqual([
      { released: true, detail: 'workspace of stopped-1 released' },
      { released: true, detail: 'workspace of merged-1 released' },
    ])
    expect(workspaces.released).toEqual(['stopped-1', 'merged-1'])
  })

  it('returns nothing when no workspace is finished, or none is registered', async () => {
    const workspaces = new FakeWorkspaces()
    workspaces.registered = [workspaceOf('running-1')]
    const facade = facadeWithStatuses({ 'running-1': 'attempting' })
    const deps = { workspaces, trial: undefined, facade, targetBranch: 'stable', git: gitAnswering({}) }
    expect(await reclaimFinishedWorkspaces(deps)).toEqual([])
    workspaces.registered = []
    expect(await reclaimFinishedWorkspaces(deps)).toEqual([])
    expect(workspaces.released).toEqual([])
  })

  it('reports an unlistable registry as one failed outcome and releases nothing', async () => {
    const workspaces = new FakeWorkspaces()
    workspaces.listFailWith = new Error('registry unreadable')
    const facade = facadeWithStatuses({})
    const outcomes = await reclaimFinishedWorkspaces({ workspaces, trial: undefined, facade, targetBranch: 'stable', git: gitAnswering({}) })
    expect(outcomes).toEqual([{ released: false, detail: 'workspaces could not be listed: registry unreadable' }])
  })

  it('closes a reclaimed task’s trial through the trial port', async () => {
    const workspaces = new FakeWorkspaces()
    workspaces.registered = [workspaceOf('stopped-1')]
    const trial = new FakeTrial()
    trial.open = [{ taskId: 'stopped-1', url: 'http://127.0.0.1:8980/', port: 8980, startedAt: 1 }]
    const facade = facadeWithStatuses({ 'stopped-1': 'stopped' })
    const outcomes = await reclaimFinishedWorkspaces({ workspaces, trial, facade, targetBranch: 'stable', git: gitAnswering({}) })
    expect(outcomes).toEqual([{ released: true, detail: 'workspace of stopped-1 released (trial instance closed)' }])
    expect(trial.closed).toEqual(['stopped-1'])
  })

  it('uses the real git runner by default, treating a non-repository worktree as unmerged', async () => {
    const workspaces = new FakeWorkspaces()
    workspaces.registered = [{ ...workspaceOf('merged-1'), worktree: '/nonexistent/worktree/for/cleanup-spec' }]
    const facade = facadeWithStatuses({ 'merged-1': 'awaiting-trial' })
    const outcomes = await reclaimFinishedWorkspaces({ workspaces, trial: undefined, facade, targetBranch: 'stable' })
    expect(outcomes).toEqual([])
    expect(workspaces.released).toEqual([])
  })
})
