/**
 * Workspace reclamation: a task worktree stays registered — and keeps
 * holding one of the workspaces service's `maxConcurrentTasks` slots — after
 * its campaign was stopped or its change was merged, because neither the
 * core nor the workspaces service knows when a worktree stopped mattering.
 * This module decides that for the chat tools: `self_development_merge`
 * releases the merged task's worktree right after the fast-forward, and
 * `self_development_propose` reclaims every stopped or already-merged
 * worktree before allocating a new one, so a slot never stays taken by work
 * that is finished. An open trial instance on a worktree is closed first;
 * nothing else is ever released.
 */

import { runGit } from './baseline.ts'
import type { ReleaseOutcome, SelfDevelopmentRemoteFacade, TrialPort, WorkspacesPort } from './types.ts'

/** Git runner shape shared with `baseline.ts`'s `runGit`. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>

/** Ports the reclamation reads and acts through. */
export interface CleanupDeps {
  /** The workspaces service, for `list` and `release`. */
  readonly workspaces: WorkspacesPort
  /** The optional trial service; an open trial on a worktree is closed before that worktree is released. */
  readonly trial: TrialPort | undefined
  /** The stable-side facade, for each task's current status. */
  readonly facade: Pick<SelfDevelopmentRemoteFacade, 'getTask'>
  /** The stable branch a worktree must be fully merged into to count as finished. */
  readonly targetBranch: string
  /** Git runner, replaceable by direct unit tests; defaults to `baseline.ts`'s `runGit`. */
  readonly git?: GitRunner
}

/**
 * Close any open trial on a task's worktree, then release the worktree and
 * its data home through the workspaces service.
 * @param deps - the workspaces and optional trial ports.
 * @param taskId - the task whose workspace is released.
 * @returns whether the workspace was released, with a one-line detail either way.
 */
export async function releaseTaskWorkspace(deps: Pick<CleanupDeps, 'workspaces' | 'trial'>, taskId: string): Promise<ReleaseOutcome> {
  let trialNote = ''
  if (deps.trial !== undefined) {
    try {
      const open = (await deps.trial.trials()).some(instance => instance.taskId === taskId)
      if (open) {
        await deps.trial.closeTrial(taskId)
        trialNote = ' (trial instance closed)'
      }
    } catch (error: unknown) {
      return { released: false, detail: `trial instance for ${taskId} could not be closed: ${(error as Error).message}` }
    }
  }
  try {
    await deps.workspaces.release(taskId)
    return { released: true, detail: `workspace of ${taskId} released${trialNote}` }
  } catch (error: unknown) {
    return { released: false, detail: `workspace of ${taskId} could not be released: ${(error as Error).message}` }
  }
}

/**
 * Whether a worktree is clean and its HEAD is already contained in the
 * target branch — the change is in stable, so nothing in the worktree is
 * unmerged. Any git failure (a vanished worktree, an unknown branch) answers
 * `false`: reclamation only ever acts on what it can prove finished.
 * @param git - git runner.
 * @param worktree - absolute task worktree path.
 * @param targetBranch - the stable branch.
 * @returns `true` only for a clean worktree whose HEAD is an ancestor of (or equal to) the target tip.
 */
export async function isFullyMerged(git: GitRunner, worktree: string, targetBranch: string): Promise<boolean> {
  try {
    if ((await git(['status', '--porcelain'], worktree)) !== '') return false
    // `merge-base --is-ancestor` exits 1 (a rejected git call) when HEAD is
    // not contained in the branch, which the catch below turns into `false`.
    await git(['merge-base', '--is-ancestor', 'HEAD', targetBranch], worktree)
    return true
  } catch {
    return false
  }
}

/**
 * Release every registered workspace whose task is finished: its status is
 * `stopped`, or it is `awaiting-trial` with a worktree already fully merged
 * into the target branch (a merged task keeps that status, since the core
 * has no merged state). A task whose status cannot be read is left alone;
 * so is any task still `attempting`, `ready`, or awaiting approval, however
 * clean its worktree looks — a fresh allocation is clean and at the target
 * tip too.
 * @param deps - the ports and the target branch.
 * @returns the release outcomes of the reclaimed tasks, in registry order; empty when nothing was finished.
 */
export async function reclaimFinishedWorkspaces(deps: CleanupDeps): Promise<readonly ReleaseOutcome[]> {
  const git = deps.git ?? runGit
  let workspaces: readonly { readonly taskId: string; readonly worktree: string }[]
  try {
    workspaces = await deps.workspaces.list()
  } catch (error: unknown) {
    return [{ released: false, detail: `workspaces could not be listed: ${(error as Error).message}` }]
  }
  const outcomes: ReleaseOutcome[] = []
  for (const workspace of workspaces) {
    // Sequential by design: the workspaces service serializes releases
    // anyway, and each status read is one facade call.
    const status = await deps.facade.getTask(workspace.taskId).then(detail => detail.projection.status, () => undefined)
    const finished = status === 'stopped'
      || (status === 'awaiting-trial' && await isFullyMerged(git, workspace.worktree, deps.targetBranch))
    if (finished) outcomes.push(await releaseTaskWorkspace(deps, workspace.taskId))
  }
  return outcomes
}
