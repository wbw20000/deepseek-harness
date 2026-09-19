/**
 * Workspace release: remove the task's git worktree and delete its data home,
 * then drop the registry entry. Only paths recorded in the registry are ever
 * touched. Each registered path is re-resolved through `realpath` immediately
 * before removal, and a path that resolves outside the experiments root —
 * for example a registered directory replaced by a symlink — is refused
 * instead of followed and deleted at its target. Releases against one
 * experiments root serialize within this process on the same chain as
 * allocation, so a release cannot interleave with a concurrent allocation's
 * registry read-modify-write.
 * @module @deepseek-ai/dsh-workflow-self-development-workspaces/release
 */

import { rm, stat } from 'node:fs/promises'
import { runGit } from './git.ts'
import { SelfDevelopmentWorkspacesError } from './runtime.ts'
import { readRegistry, writeRegistry } from './registry.ts'
import { realpathIfInside, validateTaskId } from './paths.ts'
import { runInSerialChain } from './serial-chain.ts'
import type { WorkspacesConfig } from './types.ts'

/**
 * Release one task's workspace: `git worktree remove --force`, delete the
 * data home, and remove the registry entry. A worktree directory that already
 * vanished is pruned from git's worktree registration instead; a missing data
 * home is already gone. Paths outside the registry are never touched; a
 * decoy directory beside the registered worktree survives.
 * @param config - the service's deployment configuration.
 * @param taskId - the task whose workspace is released.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_TASK_INVALID` when the
 *   task id is not a plain safe name; `SELF_DEV_WORKSPACE_TASK_UNKNOWN` when no
 *   workspace is registered for the task; `SELF_DEV_WORKSPACE_RELEASE_FAILED`
 *   when a registered path resolves outside the experiments root or git
 *   cannot remove the worktree.
 */
export async function releaseWorkspace(config: WorkspacesConfig, taskId: string): Promise<void> {
  validateTaskId(taskId)
  return runInSerialChain(config.experimentsRoot, () => releaseSerially(config, taskId))
}

/**
 * Release one workspace while holding the experiments root's serial chain.
 * @param config - the service's deployment configuration.
 * @param taskId - the validated task id to release.
 */
async function releaseSerially(config: WorkspacesConfig, taskId: string): Promise<void> {
  const registry = await readRegistry(config.experimentsRoot)
  const entry = registry.workspaces.find(workspace => workspace.taskId === taskId)
  if (entry === undefined) {
    throw new SelfDevelopmentWorkspacesError(
      `task ${taskId} has no allocated workspace to release`,
      'SELF_DEV_WORKSPACE_TASK_UNKNOWN',
    )
  }
  if (await pathExists(entry.worktree)) {
    const worktree = await registeredPathInside(config, entry.worktree, 'worktree')
    await runGit(entry.projectRoot, ['worktree', 'remove', '--force', worktree])
  } else {
    // The worktree directory vanished outside this service (manual cleanup,
    // crash recovery). Git still tracks the worktree registration; prune it.
    await runGit(entry.projectRoot, ['worktree', 'prune'])
  }
  if (await pathExists(entry.dataHome)) {
    const dataHome = await registeredPathInside(config, entry.dataHome, 'data home')
    await rm(dataHome, { recursive: true, force: true })
  }
  await writeRegistry(config.experimentsRoot, {
    version: 1,
    workspaces: registry.workspaces.filter(workspace => workspace.taskId !== taskId),
  })
}

/**
 * Re-resolve a registered path and prove it sits inside the experiments root
 * before the service deletes anything.
 * @param config - the service's deployment configuration.
 * @param path - the registered absolute path, which currently exists.
 * @param label - the path's role, for the error message.
 * @returns the path's current realpath.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_RELEASE_FAILED` when the
 *   path resolves outside the experiments root.
 */
async function registeredPathInside(config: WorkspacesConfig, path: string, label: string): Promise<string> {
  const real = await realpathIfInside(config.experimentsRoot, path)
  if (real === undefined) {
    throw new SelfDevelopmentWorkspacesError(
      `registered ${label} ${path} no longer resolves inside the experiments root ${config.experimentsRoot}; refusing to delete it`,
      'SELF_DEV_WORKSPACE_RELEASE_FAILED',
    )
  }
  return real
}

/**
 * Whether a path currently exists.
 * @param path - absolute path to check.
 * @returns true when the path exists.
 */
async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}
