/**
 * Opt-in service for self-development workspace allocation and serialized
 * integration. The service validates its deployment configuration at
 * construction and owns no injected dependency: it allocates one git worktree,
 * `selfdev/<taskId>` branch, and copied data home per task under the
 * experiments root, optionally runs a deployment-configured setup command
 * inside the fresh worktree before registering it, registers every allocation
 * durably, releases only what it registered, and integrates finished task
 * branches back into a project baseline strictly one at a time. It registers
 * no tool, prompt, or event, and it performs no unattended execution.
 * @module @deepseek-ai/dsh-workflow-self-development-workspaces
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { allocateWorkspace } from './allocate.ts'
import type { AllocateRequest } from './allocate.ts'
import { integrate } from './integration.ts'
import { readRegistry } from './registry.ts'
import { releaseWorkspace } from './release.ts'
import { SelfDevelopmentWorkspacesError } from './runtime.ts'
import type { IntegrationRequest, IntegrationResult, TaskWorkspace, WorkspacesConfig } from './types.ts'

export { SelfDevelopmentWorkspacesError, SelfDevelopmentWorkspacesErrorCode } from './runtime.ts'
export { runGit, revParse, isAncestor } from './git.ts'
export type { GitRun } from './git.ts'
export { registryPath, readRegistry, writeRegistry } from './registry.ts'
export type { WorkspaceRegistry } from './registry.ts'
export { integrationLockPath, withIntegrationLock, pidAlive } from './integration-lock.ts'
export type { LockOptions } from './integration-lock.ts'
export { allocateWorkspace } from './allocate.ts'
export type { AllocateRequest } from './allocate.ts'
export { releaseWorkspace } from './release.ts'
export { integrate } from './integration.ts'
export { copyDataHomeTemplate, templateExists } from './template.ts'
export { assertSetupPlatformSupport, runWorkspaceSetup } from './setup.ts'
export { validateTaskId, realpathIfInside } from './paths.ts'
export type { TaskWorkspace, WorkspacesConfig, IntegrationResult, IntegrationRequest, VerifyOutcome, WorkspaceSetupConfig } from './types.ts'

/**
 * Cordis service composing workspace allocation, release, and serialized
 * integration.
 */
export class SelfDevelopmentWorkspaces extends Service {
  static inject = []

  /** Runtime schema for the service config; every field is deployment-owned. */
  static Config = z.object({
    experimentsRoot: z.string().required(),
    dataHomeTemplate: z.string().required(),
    maxConcurrentTasks: z.number().step(1).min(1).default(2),
    // Absent must stay absent: no setup configured is `undefined`, not an
    // empty-argv object with an unset timeout.
    setup: z.object({
      command: z.array(z.string()).required(),
      timeoutMs: z.number().step(1).min(1).required(),
    }).default(undefined as unknown as { command: string[]; timeoutMs: number }),
  }) as unknown as z<WorkspacesConfig>

  // Cordis service shadows read state through a prototype-extended proxy, so
  // this uses TypeScript privacy instead of a #-private field: private-field
  // access fails the brand check on the shadow receiver.

  /** Validated deployment configuration every allocation runs under. */
  private readonly config: WorkspacesConfig

  /**
   * Tail of the in-process integration chain. Integrations from one service
   * instance run one at a time without touching the lock file, so two
   * concurrent calls in one process wait for each other instead of polling
   * against their own pid; the file lock still serializes across processes.
   */
  private integrationTail: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - owning Cordis context.
   * @param config - deployment configuration for the experiments root, the
   *   data-home template, the workspace limit, and the optional setup command.
   * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_CONFIG_INVALID` when a
   *   path field is missing, empty, or not absolute, `maxConcurrentTasks` is
   *   not a positive finite integer, or a configured `setup.command` is empty
   *   or `setup.timeoutMs` is not a positive finite integer. Misconfiguration
   *   fails at load.
   */
  constructor(ctx: Context, config: WorkspacesConfig) {
    super(ctx, 'selfDevelopmentWorkspaces')
    this.config = validateConfig(config)
  }

  /**
   * Allocate the workspace for one task, or return the workspace a previous
   * allocation registered for the same task id. Allocation is refused — not
   * queued — once the configured concurrency limit is reached, because a
   * queued task behind live worktrees would not run in parallel. Allocations
   * and releases against one experiments root serialize in memory, so the
   * limit check and the registry write are exact within this process; across
   * processes the deployment keeps one writer per experiments root.
   * @param req - task id, project root, and optional baseline commit.
   * @returns the task's workspace record.
   * @throws SelfDevelopmentWorkspacesError with the codes documented on
   *   {@link allocateWorkspace}.
   */
  allocate(req: AllocateRequest): Promise<TaskWorkspace> {
    return allocateWorkspace(this.config, req)
  }

  /**
   * Release one task's workspace: remove its worktree, delete its data home,
   * and drop the registry entry. Only registered paths are touched.
   * @param taskId - the task whose workspace is released.
   * @throws SelfDevelopmentWorkspacesError with the codes documented on
   *   {@link releaseWorkspace}.
   */
  release(taskId: string): Promise<void> {
    return releaseWorkspace(this.config, taskId)
  }

  /**
   * List the currently allocated workspaces from the durable registry.
   * @returns the registry's workspace records; later allocation changes are
   *   not reflected in a returned snapshot.
   * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_REGISTRY_INVALID` when
   *   the registry file cannot be read or parsed.
   */
  async list(): Promise<readonly TaskWorkspace[]> {
    return (await readRegistry(this.config.experimentsRoot)).workspaces
  }

  /**
   * Integrate one allocated task's worktree into a project branch. Calls on
   * one service instance serialize in memory; calls across processes
   * serialize on the experiments root's integration lock. Git failures inside
   * the integration are reported as a `failed` result, never thrown. When
   * `req.verify` is supplied, it runs once against the worktree after a
   * rebase (when one was needed) and before the fast-forward, whether or not
   * the baseline had moved; a rejection or a thrown error both report
   * `verification-failed` and leave the target branch untouched.
   * @param req - task id, target branch, actor, and optional verification gate.
   * @returns the integration outcome.
   * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_TASK_UNKNOWN` when the
   *   task has no allocated workspace, and with `SELF_DEV_WORKSPACE_INTEGRATION_BUSY`
   *   when a live cross-process lock holder does not release in time. The
   *   in-memory chain itself has no busy bound: a call waits indefinitely
   *   behind a serialized callback that never settles.
   */
  integrate(req: IntegrationRequest): Promise<IntegrationResult> {
    // The tail always resolves: the settlement below swallows both outcomes.
    const run = this.integrationTail.then(() => integrate(this.config, req))
    this.integrationTail = run.then(() => undefined, () => undefined)
    return run
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    selfDevelopmentWorkspaces: SelfDevelopmentWorkspaces
  }
}

export default SelfDevelopmentWorkspaces

/**
 * Validate the deployment configuration at construction time.
 * @param config - configuration as parsed from cordis.yml.
 * @returns the same configuration once every field is proven usable.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_CONFIG_INVALID` when a
 *   path field is missing, empty, or not absolute, `maxConcurrentTasks` is
 *   not a positive finite integer, or a configured `setup.command` is empty
 *   or `setup.timeoutMs` is not a positive finite integer.
 */
function validateConfig(config: WorkspacesConfig): WorkspacesConfig {
  const invalid = (detail: string): SelfDevelopmentWorkspacesError =>
    new SelfDevelopmentWorkspacesError(`self-development workspaces config is invalid: ${detail}`, 'SELF_DEV_WORKSPACE_CONFIG_INVALID')
  for (const field of ['experimentsRoot', 'dataHomeTemplate'] as const) {
    const value = config[field]
    if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
      throw invalid(`${field} ${JSON.stringify(value)} must be an absolute path`)
    }
  }
  if (!Number.isInteger(config.maxConcurrentTasks) || config.maxConcurrentTasks < 1) {
    throw invalid(`maxConcurrentTasks must be a positive finite integer, got ${String(config.maxConcurrentTasks)}`)
  }
  if (config.setup !== undefined) {
    if (config.setup.command.length === 0) {
      throw invalid('setup.command must be a non-empty argv')
    }
    if (!Number.isInteger(config.setup.timeoutMs) || config.setup.timeoutMs < 1) {
      throw invalid(`setup.timeoutMs must be a positive finite integer, got ${String(config.setup.timeoutMs)}`)
    }
  }
  return config
}
