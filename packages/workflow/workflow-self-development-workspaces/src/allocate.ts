/**
 * Workspace allocation: one git worktree, one `selfdev/<taskId>` branch, and
 * one copied task data home per task, under the experiments root. Allocation
 * is idempotent per task id, refuses to exceed the configured concurrency
 * limit (queuing is not parallelism, so over-limit allocation is rejected
 * outright instead of waiting), and registers the workspace in the durable
 * registry before returning it. Every target path is proven to resolve inside
 * the experiments root before anything is created, and a failed allocation
 * tears down what it built.
 * @module @deepseek-ai/dsh-workflow-self-development-workspaces/allocate
 */

import { mkdir, realpath, rm, rmdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { revParse, runGit } from './git.ts'
import { SelfDevelopmentWorkspacesError } from './runtime.ts'
import { readRegistry, writeRegistry } from './registry.ts'
import { realpathIfInside, validateTaskId } from './paths.ts'
import { runInSerialChain } from './serial-chain.ts'
import { copyDataHomeTemplate, templateExists } from './template.ts'
import type { TaskWorkspace, WorkspacesConfig } from './types.ts'

/** One workspace allocation request. */
export interface AllocateRequest {
  /** The task the workspace is for; also the branch and directory name. */
  readonly taskId: string
  /** Absolute path of the project repository to branch from. */
  readonly projectRoot: string
  /** Baseline commit; defaults to the project's current `HEAD`. */
  readonly baseCommit?: string
}

/**
 * Allocate the workspace for one task, or return the workspace a previous
 * allocation registered for the same task id. Allocations against one
 * experiments root serialize within this process, so concurrent callers see
 * the limit and the registry exactly one at a time.
 * @param config - the service's deployment configuration.
 * @param req - task id, project root, and optional baseline commit.
 * @returns the task's workspace record; the worktree and data home paths are
 *   realpaths under the experiments root.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_TASK_INVALID` when the
 *   task id cannot name a branch or directory; `SELF_DEV_WORKSPACE_LIMIT` when
 *   the configured maximum is already allocated; `SELF_DEV_WORKSPACE_ALLOC_FAILED`
 *   when the project root, baseline, template, target paths, or git worktree
 *   creation fails.
 */
export async function allocateWorkspace(config: WorkspacesConfig, req: AllocateRequest): Promise<TaskWorkspace> {
  validateTaskId(req.taskId)
  if (!isAbsolute(req.projectRoot)) {
    throw new SelfDevelopmentWorkspacesError(
      `projectRoot ${JSON.stringify(req.projectRoot)} must be an absolute path`,
      'SELF_DEV_WORKSPACE_ALLOC_FAILED',
    )
  }
  return runInSerialChain(config.experimentsRoot, () => allocateSerially(config, req))
}

/**
 * Allocate one workspace while holding the experiments root's serial chain:
 * the limit check, the target-path preflight, the git and copy work, and the
 * registry write all run without another same-process allocation or release
 * interleaving.
 * @param config - the service's deployment configuration.
 * @param req - the validated allocation request.
 * @returns the task's workspace record.
 */
async function allocateSerially(config: WorkspacesConfig, req: AllocateRequest): Promise<TaskWorkspace> {
  const registry = await readRegistry(config.experimentsRoot)
  const existing = registry.workspaces.find(workspace => workspace.taskId === req.taskId)
  if (existing !== undefined) return existing
  if (registry.workspaces.length >= config.maxConcurrentTasks) {
    throw new SelfDevelopmentWorkspacesError(
      `${String(registry.workspaces.length)} workspaces are already allocated; the configured limit is ${String(config.maxConcurrentTasks)}. Queuing a task behind live worktrees would not run it in parallel, so allocation is refused instead.`,
      'SELF_DEV_WORKSPACE_LIMIT',
    )
  }
  const projectRoot = await realpath(req.projectRoot).catch((error: unknown) => {
    throw new SelfDevelopmentWorkspacesError(
      `projectRoot ${req.projectRoot} does not resolve: ${detail(error)}`,
      'SELF_DEV_WORKSPACE_ALLOC_FAILED',
    )
  })
  const baseCommit = req.baseCommit === undefined
    ? await resolveHead(projectRoot)
    : await resolveRevision(projectRoot, req.baseCommit)
  if (!(await templateExists(config.dataHomeTemplate))) {
    throw new SelfDevelopmentWorkspacesError(
      `data home template ${config.dataHomeTemplate} does not exist`,
      'SELF_DEV_WORKSPACE_ALLOC_FAILED',
    )
  }
  const taskRoot = join(config.experimentsRoot, req.taskId)
  const worktreePath = join(taskRoot, 'worktree')
  const dataHomePath = join(taskRoot, 'dsh-home')
  const branch = `selfdev/${req.taskId}`
  await mkdir(config.experimentsRoot, { recursive: true })
  // Before creating anything: a target that is, or sits under, a symlink
  // pointing outside the experiments root is refused here, before `mkdir` or
  // `git worktree add` can follow it and build outside the root.
  for (const [path, label] of [[taskRoot, 'task root'], [worktreePath, 'worktree'], [dataHomePath, 'data home']] as const) {
    if (await realpathIfInside(config.experimentsRoot, path) === undefined) {
      throw new SelfDevelopmentWorkspacesError(
        `allocation target ${label} ${path} does not resolve inside the experiments root ${config.experimentsRoot}`,
        'SELF_DEV_WORKSPACE_ALLOC_FAILED',
      )
    }
  }
  let worktree: string
  let dataHome: string
  try {
    await mkdir(taskRoot, { recursive: true })
    await runGit(projectRoot, ['worktree', 'add', '-b', branch, worktreePath, baseCommit])
    await copyDataHomeTemplate(config.dataHomeTemplate, dataHomePath)
    // Register the realpaths of what now exists: the preflight resolved the
    // not-yet-existing targets through their ancestors, and `release` re-checks
    // every registered path against the experiments root before deleting it.
    worktree = await realpath(worktreePath)
    dataHome = await realpath(dataHomePath)
  } catch (error) {
    // Roll the half-built workspace back: an allocation either registers
    // completely or leaves nothing behind. The rollback is best-effort — the
    // caller must see the allocation failure, not a teardown failure.
    await rollbackAllocation(projectRoot, branch, worktreePath, dataHomePath, taskRoot)
    throw error instanceof SelfDevelopmentWorkspacesError
      ? error
      : new SelfDevelopmentWorkspacesError(
        `could not allocate the workspace for task ${req.taskId} under ${taskRoot}: ${detail(error)}`,
        'SELF_DEV_WORKSPACE_ALLOC_FAILED',
      )
  }
  const workspace: TaskWorkspace = {
    taskId: req.taskId,
    projectRoot,
    baseCommit,
    worktree,
    branch,
    dataHome,
    allocatedAt: Date.now(),
  }
  await writeRegistry(config.experimentsRoot, { version: 1, workspaces: [...registry.workspaces, workspace] })
  return workspace
}

/**
 * Tear down a failed allocation's leftovers: the git worktree and branch, the
 * copied data home, and the worktree directory. The task root is dropped only
 * when it is left empty, so a directory the caller owned before allocating
 * survives.
 * @param projectRoot - absolute project repository the worktree was added to.
 * @param branch - the branch the failed allocation created.
 * @param worktreePath - the worktree path passed to git.
 * @param dataHomePath - the data home the copy may have partially filled.
 * @param taskRoot - the task directory that may hold the leftovers.
 */
async function rollbackAllocation(
  projectRoot: string,
  branch: string,
  worktreePath: string,
  dataHomePath: string,
  taskRoot: string,
): Promise<void> {
  try {
    await runGit(projectRoot, ['worktree', 'remove', '--force', worktreePath])
    await runGit(projectRoot, ['branch', '-D', branch])
  } catch {
    // Git could not tear down its side; the registry was never written, so
    // nothing references the leftover registration.
  }
  try {
    await rm(worktreePath, { recursive: true, force: true })
    await rm(dataHomePath, { recursive: true, force: true })
    await rmdir(taskRoot)
  } catch {
    // Directories that are not empty or not this allocation's are left in
    // place; the registry was never written, so nothing references them.
  }
}

/**
 * Resolve the project's current `HEAD`.
 * @param projectRoot - absolute project repository root.
 * @returns the `HEAD` commit id.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_ALLOC_FAILED` when the
 *   project root is not a usable git repository.
 */
async function resolveHead(projectRoot: string): Promise<string> {
  const head = await revParse(projectRoot, 'HEAD')
  if (head === undefined) {
    throw new SelfDevelopmentWorkspacesError(
      `project root ${projectRoot} has no HEAD commit; allocate against a committed baseline`,
      'SELF_DEV_WORKSPACE_ALLOC_FAILED',
    )
  }
  return head
}

/**
 * Resolve an explicit baseline revision.
 * @param projectRoot - absolute project repository root.
 * @param baseCommit - the requested baseline revision expression.
 * @returns the resolved commit id.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_ALLOC_FAILED` when the
 *   revision does not resolve in the project.
 */
async function resolveRevision(projectRoot: string, baseCommit: string): Promise<string> {
  const resolved = await revParse(projectRoot, baseCommit)
  if (resolved === undefined) {
    throw new SelfDevelopmentWorkspacesError(
      `baseCommit ${baseCommit} does not resolve in ${projectRoot}`,
      'SELF_DEV_WORKSPACE_ALLOC_FAILED',
    )
  }
  return resolved
}

/**
 * Describe one unknown failure for a boundary message.
 * @param error - thrown value of any type.
 * @returns the value's string form, which carries the message for Error values.
 */
function detail(error: unknown): string {
  return String(error)
}
