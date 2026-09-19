/**
 * Serialized integration of an allocated task's worktree back into a project
 * branch. Integrations against one experiments root are mutually exclusive;
 * against the acquired lock the service fetches the target branch's latest
 * tip, rebases the task branch when the allocation baseline moved, and — only
 * when the worktree HEAD then contains the target tip — fast-forwards the
 * target branch. No merge commit is ever created and no ref is ever forced:
 * the fast-forward is either a true ancestor move or it fails. Every
 * intermediate git failure aborts cleanly: a started rebase is aborted, and
 * the result is a `failed` record with the git reason.
 * @module @deepseek-ai/dsh-workflow-self-development-workspaces/integration
 */

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isAncestor, revParse, runGit } from './git.ts'
import { withIntegrationLock } from './integration-lock.ts'
import { SelfDevelopmentWorkspacesError } from './runtime.ts'
import { readRegistry } from './registry.ts'
import type { IntegrationRequest, IntegrationResult, TaskWorkspace, WorkspacesConfig } from './types.ts'

/**
 * Integrate one allocated task's worktree into a project branch.
 * @param config - the service's deployment configuration.
 * @param req - task id, target branch, and actor of the integration.
 * @returns the integration outcome; git failures are reported as
 *   `{ status: 'failed', reason }`, never thrown.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_TASK_UNKNOWN` when the
 *   task has no allocated workspace, and with `SELF_DEV_WORKSPACE_INTEGRATION_BUSY`
 *   when a live lock holder does not release in time.
 */
export async function integrate(config: WorkspacesConfig, req: IntegrationRequest): Promise<IntegrationResult> {
  const registry = await readRegistry(config.experimentsRoot)
  const entry = registry.workspaces.find(workspace => workspace.taskId === req.taskId)
  if (entry === undefined) {
    throw new SelfDevelopmentWorkspacesError(
      `task ${req.taskId} has no allocated workspace to integrate`,
      'SELF_DEV_WORKSPACE_TASK_UNKNOWN',
    )
  }
  if (typeof req.targetBranch !== 'string' || req.targetBranch.length === 0) {
    return { status: 'failed', reason: 'targetBranch must be a non-empty branch name' }
  }
  return withIntegrationLock(config.experimentsRoot, async () => {
    try {
      return await integrateLocked(entry, req.targetBranch)
    } catch (error) {
      // Any git failure inside the locked steps is reported as a failed
      // result with its reason; the lock release and the rebase abort inside
      // the steps keep the repositories free of half state.
      return { status: 'failed', reason: detail(error) }
    }
  })
}

/**
 * Run one integration's git steps while holding the integration lock.
 * @param entry - the task's allocated workspace.
 * @param targetBranch - the project branch to fast-forward.
 * @returns the integration outcome.
 */
async function integrateLocked(entry: TaskWorkspace, targetBranch: string): Promise<IntegrationResult> {
  const targetTip = await resolveTargetTip(entry.projectRoot, targetBranch)
  if (targetTip === undefined) {
    return { status: 'failed', reason: `target branch ${targetBranch} was not found in ${entry.projectRoot}` }
  }
  const head = await revParse(entry.worktree, 'HEAD')
  if (head === undefined) {
    return { status: 'failed', reason: `worktree ${entry.worktree} has no HEAD commit` }
  }
  const dirty = await runGit(entry.worktree, ['status', '--porcelain'])
  if (dirty.stdout.trim().length > 0) {
    return { status: 'failed', reason: `worktree ${entry.worktree} has uncommitted changes; commit or clean them first` }
  }
  if (targetTip !== entry.baseCommit) {
    const rebased = await rebaseOnto(entry.worktree, targetTip)
    if (rebased.status === 'conflict') {
      return { status: 'conflict', files: rebased.files, baseMoved: true }
    }
    if (rebased.status === 'failed') return rebased
  }
  // After a successful rebase the worktree has a new HEAD; a lost HEAD is a
  // git failure and reports as failed through the boundary below.
  const integrated = (await runGit(entry.worktree, ['rev-parse', 'HEAD'])).stdout.trim()
  if (!(await isAncestor(entry.projectRoot, targetTip, integrated))) {
    return { status: 'failed', reason: `worktree HEAD ${integrated} does not contain target tip ${targetTip}` }
  }
  if (integrated === targetTip) {
    return { status: 'integrated', commit: integrated }
  }
  return fastForward(entry, targetBranch, integrated)
}

/**
 * Resolve the target branch's current tip: the fetched remote-tracking ref
 * when the branch has a configured upstream, otherwise the local branch.
 * @param projectRoot - absolute project repository root.
 * @param targetBranch - the branch to resolve.
 * @returns the tip commit id, or `undefined` when the branch does not resolve.
 */
async function resolveTargetTip(projectRoot: string, targetBranch: string): Promise<string | undefined> {
  const upstream = await runGit(projectRoot, ['config', '--get', `branch.${targetBranch}.remote`])
    .then(result => result.stdout.trim() || undefined)
    .catch(() => undefined)
  if (upstream === undefined) return revParse(projectRoot, `refs/heads/${targetBranch}`)
  await runGit(projectRoot, ['fetch', '--quiet', upstream, targetBranch])
  return revParse(projectRoot, `refs/remotes/${upstream}/${targetBranch}`)
}

/** One rebase outcome before the fast-forward decision. */
type RebaseOutcome =
  | { status: 'ok' }
  | { status: 'conflict'; files: readonly string[] }
  | { status: 'failed'; reason: string }

/**
 * Rebase the worktree branch onto a target tip. A conflict aborts the rebase
 * and reports the unmerged files; any other rebase failure is aborted and
 * reported as failed. The worktree never keeps rebase state across a return.
 * Exported for direct behavioral tests of the abort-failure path; callers
 * inside the service reach it through {@link integrate}.
 * @param worktree - absolute task worktree path.
 * @param targetTip - commit id to rebase onto.
 * @returns the rebase outcome.
 */
export async function rebaseOnto(worktree: string, targetTip: string): Promise<RebaseOutcome> {
  try {
    await runGit(worktree, ['rebase', targetTip])
    return { status: 'ok' }
  } catch (error) {
    const reason = detail(error)
    if (!(await rebaseInProgress(worktree))) {
      return { status: 'failed', reason: `git rebase onto ${targetTip} failed: ${reason}` }
    }
    const files = await unmergedFiles(worktree)
    const abort = await runGit(worktree, ['rebase', '--abort']).then(
      () => undefined,
      (abortError: unknown) => `git rebase --abort also failed: ${detail(abortError)}`,
    )
    if (abort !== undefined) {
      return { status: 'failed', reason: `git rebase onto ${targetTip} failed: ${reason}; ${abort}` }
    }
    // Git stops a rebase only for conflicts, so the unmerged list is the
    // conflict's file set; return it once the rebase state is fully aborted.
    return { status: 'conflict', files }
  }
}

/**
 * Whether the worktree currently holds an interrupted rebase.
 * @param worktree - absolute task worktree path.
 * @returns true when git still tracks a rebase in progress.
 * @throws whatever git fails with; the caller reports it as a failed result.
 */
async function rebaseInProgress(worktree: string): Promise<boolean> {
  for (const stateDir of ['rebase-merge', 'rebase-apply']) {
    // --git-path answers where the state directory would live, existing or
    // not; from a linked worktree it is absolute, from the main tree relative.
    const relative = (await runGit(worktree, ['rev-parse', '--git-path', stateDir])).stdout.trim()
    const statePath = resolve(worktree, relative)
    if (await stat(statePath).then(() => true, () => false)) return true
  }
  return false
}

/**
 * List the worktree's unmerged files.
 * @param worktree - absolute task worktree path.
 * @returns the unmerged file paths, one per entry.
 */
async function unmergedFiles(worktree: string): Promise<readonly string[]> {
  const result = await runGit(worktree, ['diff', '--name-only', '--diff-filter=U'])
  return result.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

/**
 * Fast-forward the target branch to the worktree HEAD. A target branch that
 * is checked out in the project root fast-forwards through `merge --ff-only`;
 * a target branch checked out in another worktree refuses; an unchecked-out
 * target branch moves through a compare-and-swap `update-ref`, which fails
 * loudly when the local tip moved under the lock. No path here creates a
 * merge commit or forces a non-ancestor move.
 * @param entry - the task's allocated workspace.
 * @param targetBranch - the project branch to fast-forward.
 * @param commit - the worktree HEAD to fast-forward to.
 * @returns the integration outcome.
 */
async function fastForward(
  entry: TaskWorkspace,
  targetBranch: string,
  commit: string,
): Promise<IntegrationResult> {
  const checkedOutAt = await worktreeHoldingBranch(entry.projectRoot, targetBranch)
  const ref = `refs/heads/${targetBranch}`
  if (checkedOutAt === undefined) {
    const localTip = await revParse(entry.projectRoot, ref)
    const args = localTip === undefined
      ? ['update-ref', ref, commit]
      : ['update-ref', ref, commit, localTip]
    await runGit(entry.projectRoot, args)
    return { status: 'integrated', commit }
  }
  if (checkedOutAt !== entry.projectRoot) {
    return {
      status: 'failed',
      reason: `target branch ${targetBranch} is checked out in ${checkedOutAt}; integrate it there`,
    }
  }
  await runGit(entry.projectRoot, ['merge', '--ff-only', commit])
  return { status: 'integrated', commit }
}

/**
 * Find the worktree that currently holds a branch checked out.
 * @param projectRoot - absolute project repository root.
 * @param targetBranch - the branch to look for.
 * @returns the holding worktree's realpath, or `undefined` when no worktree
 *   holds the branch.
 */
async function worktreeHoldingBranch(projectRoot: string, targetBranch: string): Promise<string | undefined> {
  const result = await runGit(projectRoot, ['worktree', 'list', '--porcelain'])
  const wanted = `branch refs/heads/${targetBranch}`
  let currentPath: string | undefined
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim()
    } else if (line === wanted && currentPath !== undefined) {
      return currentPath
    }
  }
  return undefined
}

/**
 * Describe one unknown failure for a boundary message.
 * @param error - thrown value of any type.
 * @returns the value's string form, which carries the message for Error values.
 */
function detail(error: unknown): string {
  return String(error)
}
