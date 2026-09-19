/**
 * Opt-in Remote facade over the self-development task-control service and the
 * supervised runner. The facade exists so the M4 UI and the phone whitelist
 * can watch progress, interject, confirm a plan and a budget, stop a task,
 * and approve or reject a trial through one stable typed surface, while
 * ordinary chat messages can never reach these methods: they are called only
 * by an explicit UI or phone client through the Typert gateway. Every method
 * refuses while `enabled` is `false`; the service is mounted only by an
 * explicit profile entry and ships in no default bundle.
 * @module @deepseek-ai/dsh-workflow-self-development-remote
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  SelfDevelopmentError,
  SelfDevOperationId,
  SelfDevTaskId,
} from '@deepseek-ai/dsh-workflow-self-development'
import type {
  SelfDevelopmentTaskController,
  TaskProjection,
  TrustedClock,
} from '@deepseek-ai/dsh-workflow-self-development'
import {
  HostClock,
  SelfDevelopmentRunnerError,
} from '@deepseek-ai/dsh-workflow-self-development-runner'
import type {
  PresenceConfirmation,
  SelfDevelopmentRunner,
} from '@deepseek-ai/dsh-workflow-self-development-runner'
// Type-only: pulls the events consumer's Context merge so the optional
// `selfDevelopmentEvents` read below is typed.
import type {} from '@deepseek-ai/dsh-workflow-self-development-events'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { buildConfirmationCard, taskTitle } from './card.ts'
import { toWireEvent, toWireOutcome, toWireProjection } from './wire.ts'
import { SelfDevelopmentRemoteError } from './errors.ts'
import {
  parseApproveBudgetInput,
  parseAuthorizePlanningInput,
  parseConfirmPlanInput,
  parseCreateTaskInput,
  parseRecordTrialApprovalInput,
  parseRunAttemptRequest,
  parseStopInput,
  parseSubmitPlanDraftInput,
  parseTaskId,
} from './schema.ts'
import type {
  BudgetApprovalInput,
  ConfirmedPlanInput,
  PlanDraftInput,
  RecentEvent,
  RemoteConfig,
  RemoteOperationResult,
  RemoteRunAttemptOutcome,
  RemoteRunAttemptRequest,
  TaskDetail,
  TaskSpecInput,
  TaskSummary,
} from './types.ts'

export { SelfDevelopmentRemoteError } from './errors.ts'
export type { SelfDevelopmentRemoteErrorCode } from './errors.ts'
export type {
  BudgetApprovalInput,
  CardBudget,
  ConfirmedPlanInput,
  ConfirmationCard,
  PlanDraftInput,
  RecentEvent,
  RemoteConfig,
  RemoteOperationResult,
  RemoteRunAttemptOutcome,
  RemoteRunAttemptRequest,
  RemoteTaskProjection,
  TaskDetail,
  TaskSpecInput,
  TaskSummary,
} from './types.ts'
export { toWireEvent, toWireOutcome, toWireProjection } from './wire.ts'

/**
 * The facade's own deployment configuration. `controlDirectory` repeats the
 * task-control service's value because the core service keeps its resolved
 * configuration private and this package may not modify it; the facade reads
 * the same directory only to list task journals.
 */
export type Config = RemoteConfig

/**
 * Stable-side Remote facade. The supervised runner is optional: every method
 * that needs it refuses with a facade code when the runner plugin is not
 * loaded, and the read paths work against the task-control service alone.
 */
export class SelfDevelopmentRemote extends TypertRemoteService {
  static inject = ['selfDevelopmentTasks']

  /** Runtime schema for the service config; every field is deployment-owned. */
  static Config = z.object({
    enabled: z.boolean().default(false),
    allowedActors: z.array(z.string()).default([]),
    controlDirectory: z.string().required(),
  }) as unknown as z<RemoteConfig>

  /** Validated deployment configuration. */
  private readonly resolved: RemoteConfig

  /** Facade-owned trusted clock, used only when the runner plugin is absent. */
  private ownClock: HostClock | undefined

  /**
   * @param ctx - owning Cordis context carrying the task-control service.
   * @param config - deployment configuration for the enablement switch, the
   *   actor allowlist, and the task-control service's control directory.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_CONFIG_INVALID` when the control
   *   directory is not an absolute path. Misconfiguration fails at load.
   */
  constructor(ctx: Context, config: RemoteConfig) {
    super(ctx, 'selfDevelopmentRemote', { namespace: 'selfDevelopmentRemote' })
    this.resolved = validateConfig(config)
  }

  /**
   * List every task under the control directory with its progress row.
   * @returns one row per task journal directory, sorted by task id.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_DISABLED` while the facade is disabled.
   * @throws whatever the task-control service or a task journal rejects with, verbatim.
   */
  @Remote('listTasks')
  async listTasks(): Promise<readonly TaskSummary[]> {
    this.assertEnabled()
    const tasksRoot = join(this.resolved.controlDirectory, 'tasks')
    let entries
    try {
      entries = await readdir(tasksRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const summaries: TaskSummary[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue
      const taskId = parseTaskId(entry.name)
      const projection = await this.ctx.selfDevelopmentTasks.state(taskId, this.clock())
      summaries.push({
        taskId,
        status: projection.status,
        revision: projection.revision,
        title: taskTitle(projection.spec?.requirement ?? ''),
      })
    }
    return summaries
  }

  /**
   * Read one task's full projection and its confirmation-card view.
   * @param taskId - task identity.
   * @returns the projection and the read-only card.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_DISABLED` while the facade is disabled,
   *   `SELF_DEV_REMOTE_CONFIG_INVALID` when the task id is malformed, or
   *   `SELF_DEV_REMOTE_TASK_UNKNOWN` when the task has no journal yet; the facade never creates a
   *   journal from a read path.
   * @throws whatever the task-control service rejects with, verbatim.
   */
  @Remote('getTask')
  async getTask(taskId: string): Promise<TaskDetail> {
    this.assertEnabled()
    const id = parseTaskId(taskId)
    await this.assertTaskExists(id)
    const projection = await this.ctx.selfDevelopmentTasks.state(id, this.clock())
    return { projection: toWireProjection(projection), card: buildConfirmationCard(id, projection) }
  }

  /**
   * Read the retained recent self-development notification events.
   * @returns the events consumer's title-level buffer, oldest first; `[]` when
   *   the events consumer plugin is not loaded in this context.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_DISABLED` while the facade is disabled.
   */
  @Remote('recentEvents')
  async recentEvents(): Promise<readonly RecentEvent[]> {
    this.assertEnabled()
    const events = this.ctx.get('selfDevelopmentEvents')
    return await Promise.resolve(events === undefined ? [] : events.recent().map(toWireEvent))
  }

  /**
   * Create one task from a TaskSpec. The actor is the spec's `createdBy`
   * field; it is checked against `allowedActors` when that list is non-empty.
   * @param spec - TaskSpec in wire form.
   * @param expectedRevision - revision the caller observed; a new task is at revision 0.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_DISABLED`, `SELF_DEV_REMOTE_CONFIG_INVALID`,
   *   or `SELF_DEV_REMOTE_ACTOR_FORBIDDEN`.
   * @throws whatever the task-control service rejects with, verbatim.
   */
  @Remote('createTask')
  async createTask(spec: TaskSpecInput, expectedRevision: number): Promise<RemoteOperationResult> {
    this.assertEnabled()
    const parsed = parseCreateTaskInput(spec, expectedRevision)
    this.assertActorAllowed(parsed.spec.createdBy)
    const operationId = this.operationId()
    const controller = await this.open(parsed.spec.taskId)
    const result = await controller.createTask({
      taskId: SelfDevTaskId(parsed.spec.taskId),
      expectedRevision: parsed.expectedRevision,
      operationId,
      spec: parsed.spec,
    })
    return { taskId: parsed.spec.taskId, operationId, ...result }
  }

  /**
   * Grant the separate planning authorization. This never approves
   * development and consumes no development round.
   * @param taskId - task identity.
   * @param expectedRevision - revision the caller observed.
   * @param authorizedBy - human actor granting the authorization.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_DISABLED` or `SELF_DEV_REMOTE_CONFIG_INVALID`.
   * @throws whatever the task-control service rejects with, verbatim.
   */
  @Remote('authorizePlanning')
  async authorizePlanning(taskId: string, expectedRevision: number, authorizedBy: string): Promise<RemoteOperationResult> {
    this.assertEnabled()
    const parsed = parseAuthorizePlanningInput(taskId, expectedRevision, authorizedBy)
    const operationId = this.operationId()
    const controller = await this.open(parsed.taskId)
    const result = await controller.authorizePlanning({
      taskId: SelfDevTaskId(parsed.taskId),
      expectedRevision: parsed.expectedRevision,
      operationId,
      authorizedBy: parsed.authorizedBy,
    })
    return { taskId: parsed.taskId, operationId, ...result }
  }

  /**
   * Submit a drafted plan for human confirmation.
   * @param taskId - task identity.
   * @param expectedRevision - revision the caller observed.
   * @param draft - plan draft in wire form.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_DISABLED` or `SELF_DEV_REMOTE_CONFIG_INVALID`.
   * @throws whatever the task-control service rejects with, verbatim.
   */
  @Remote('submitPlanDraft')
  async submitPlanDraft(
    taskId: string,
    expectedRevision: number,
    draft: PlanDraftInput,
  ): Promise<RemoteOperationResult> {
    this.assertEnabled()
    const parsed = parseSubmitPlanDraftInput(taskId, expectedRevision, draft)
    const operationId = this.operationId()
    const controller = await this.open(parsed.taskId)
    const result = await controller.submitPlanDraft({
      taskId: SelfDevTaskId(parsed.taskId),
      expectedRevision: parsed.expectedRevision,
      operationId,
      draft: parsed.draft,
    })
    return { taskId: parsed.taskId, operationId, ...result }
  }

  /**
   * Freeze the human-confirmed plan. The actor is the explicit confirmer.
   * @param taskId - task identity.
   * @param expectedRevision - revision the caller observed.
   * @param plan - confirmed plan in wire form.
   * @param actor - human actor confirming the plan; checked against `allowedActors`.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_DISABLED`, `SELF_DEV_REMOTE_CONFIG_INVALID`,
   *   or `SELF_DEV_REMOTE_ACTOR_FORBIDDEN`.
   * @throws whatever the task-control service rejects with, verbatim.
   */
  @Remote('confirmPlan')
  async confirmPlan(
    taskId: string,
    expectedRevision: number,
    plan: ConfirmedPlanInput,
    actor: string,
  ): Promise<RemoteOperationResult> {
    this.assertEnabled()
    const parsed = parseConfirmPlanInput(taskId, expectedRevision, plan, actor)
    this.assertActorAllowed(parsed.actor)
    const operationId = this.operationId()
    const controller = await this.open(parsed.taskId)
    const result = await controller.confirmPlan({
      taskId: SelfDevTaskId(parsed.taskId),
      expectedRevision: parsed.expectedRevision,
      operationId,
      plan: parsed.plan,
    })
    return { taskId: parsed.taskId, operationId, ...result }
  }

  /**
   * Record a human budget approval, or replace the current one. The actor is
   * the approval's `approvedBy` field; consumed rounds and time never reset.
   * @param taskId - task identity.
   * @param expectedRevision - revision the caller observed.
   * @param approval - budget approval in wire form.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_DISABLED`, `SELF_DEV_REMOTE_CONFIG_INVALID`,
   *   or `SELF_DEV_REMOTE_ACTOR_FORBIDDEN`.
   * @throws whatever the task-control service rejects with, verbatim.
   */
  @Remote('approveBudget')
  async approveBudget(
    taskId: string,
    expectedRevision: number,
    approval: BudgetApprovalInput,
  ): Promise<RemoteOperationResult> {
    this.assertEnabled()
    const parsed = parseApproveBudgetInput(taskId, expectedRevision, approval)
    this.assertActorAllowed(readApprovedBy(parsed.approval))
    const operationId = this.operationId()
    const controller = await this.open(parsed.taskId)
    const result = await controller.approveBudget({
      taskId: SelfDevTaskId(parsed.taskId),
      expectedRevision: parsed.expectedRevision,
      operationId,
      approval: parsed.approval,
    })
    return { taskId: parsed.taskId, operationId, ...result }
  }

  /**
   * Stop a task at human request. When the runner is loaded, the stop goes
   * through it so owned process groups and evidence writes finish before the
   * result returns; otherwise only the core stop runs.
   * @param taskId - task identity.
   * @param expectedRevision - revision the caller observed.
   * @param reason - optional stop reason; only `cancelled` exists today.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_DISABLED` or `SELF_DEV_REMOTE_CONFIG_INVALID`.
   * @throws whatever the core or the runner rejects with, verbatim.
   */
  @Remote('stop')
  async stop(taskId: string, expectedRevision: number, reason?: 'cancelled'): Promise<RemoteOperationResult> {
    this.assertEnabled()
    const parsed = parseStopInput(taskId, expectedRevision, reason)
    const operationId = this.operationId()
    const runner = this.runner()
    const result = runner !== undefined
      ? await runner.stop({
        taskId: parsed.taskId,
        expectedRevision: parsed.expectedRevision,
        operationId,
      })
      : await (await this.open(parsed.taskId)).stop({
        taskId: SelfDevTaskId(parsed.taskId),
        expectedRevision: parsed.expectedRevision,
        operationId,
      })
    return { taskId: parsed.taskId, operationId, ...result }
  }

  /**
   * Record a human trial approval bound to the current verified result. The
   * actor is the approver. No upgrade path exists in this facade.
   * @param taskId - task identity.
   * @param expectedRevision - revision the caller observed.
   * @param approvedBy - human actor approving the trial; checked against `allowedActors`.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_DISABLED`, `SELF_DEV_REMOTE_CONFIG_INVALID`,
   *   or `SELF_DEV_REMOTE_ACTOR_FORBIDDEN`.
   * @throws whatever the task-control service rejects with, verbatim.
   */
  @Remote('recordTrialApproval')
  async recordTrialApproval(
    taskId: string,
    expectedRevision: number,
    approvedBy: string,
  ): Promise<RemoteOperationResult> {
    this.assertEnabled()
    const parsed = parseRecordTrialApprovalInput(taskId, expectedRevision, approvedBy)
    this.assertActorAllowed(parsed.approvedBy)
    const operationId = this.operationId()
    const controller = await this.open(parsed.taskId)
    const result = await controller.recordTrialApproval({
      taskId: SelfDevTaskId(parsed.taskId),
      expectedRevision: parsed.expectedRevision,
      operationId,
      approvedBy: parsed.approvedBy,
    })
    return { taskId: parsed.taskId, operationId, ...result }
  }

  /**
   * Launch one supervised attempt. The facade assembles the
   * `PresenceConfirmation` from the request and the frozen plan, and refuses
   * unless the caller explicitly passed `presenceAcknowledged: true` — a UI
   * must never default that acknowledgement. Requires the runner plugin.
   * @param request - the supervised attempt request in wire form.
   * @returns the runner's outcome plus the operation id the facade generated.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_DISABLED`, `SELF_DEV_REMOTE_CONFIG_INVALID`,
   *   `SELF_DEV_REMOTE_ACTOR_FORBIDDEN`, `SELF_DEV_REMOTE_PRESENCE_UNCONFIRMED` when
   *   `presenceAcknowledged` is not exactly `true`, or
   *   `SELF_DEV_REMOTE_RUNNER_UNAVAILABLE` when the runner plugin is not loaded.
   * @throws whatever the core or the runner rejects with, verbatim.
   */
  @Remote('runAttempt')
  async runAttempt(request: RemoteRunAttemptRequest): Promise<RemoteRunAttemptOutcome> {
    this.assertEnabled()
    const parsed = parseRunAttemptRequest(request)
    if (!parsed.presenceAcknowledged) {
      throw new SelfDevelopmentRemoteError(
        'presenceAcknowledged must be explicitly true; a UI must never default or pre-select the human-presence acknowledgement',
        'SELF_DEV_REMOTE_PRESENCE_UNCONFIRMED',
      )
    }
    this.assertActorAllowed(parsed.confirmedBy)
    const runner = this.requireRunner()
    const controller = await this.open(parsed.taskId)
    const presence = await this.buildPresence(controller.projection, parsed)
    const operationId = this.operationId()
    const outcome = await runner.runAttempt({
      taskId: parsed.taskId,
      expectedRevision: parsed.expectedRevision,
      operationId,
      worktree: parsed.worktree,
      artifactPaths: sortedUnique(parsed.artifactPaths),
      acceptancePath: parsed.acceptancePath,
      // Host-only: only the stable host supplies a data directory, forwarded
      // verbatim; a phone channel omits the field and the runner keeps its
      // configured `dshHome`.
      ...(parsed.dataHome === undefined ? {} : { dshHome: parsed.dataHome }),
      presence,
    })
    return toWireOutcome(outcome, operationId, parsed.worktree)
  }

  /**
   * The task ids of the attempts the runner currently owns.
   * @returns a read-only snapshot, empty when the runner plugin is absent.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_DISABLED` while the facade is disabled.
   */
  @Remote('activeTasks')
  async activeTasks(): Promise<readonly string[]> {
    this.assertEnabled()
    return await Promise.resolve(this.runner()?.activeTasks() ?? [])
  }

  /**
   * Refuse every method while the facade is disabled.
   * @returns nothing when the facade is enabled.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_DISABLED` while `enabled` is `false`.
   */
  private assertEnabled(): void {
    if (this.resolved.enabled) return
    throw new SelfDevelopmentRemoteError(
      'self-development remote is disabled; set enabled: true in the service config to allow UI and phone operations',
      'SELF_DEV_REMOTE_DISABLED',
    )
  }

  /**
   * Check an operation's actor against the allowlist.
   * @param actor - the operation's actor field.
   * @returns nothing when the actor may act.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_ACTOR_FORBIDDEN` when the allowlist is
   *   non-empty and does not contain the actor.
   */
  private assertActorAllowed(actor: string): void {
    if (this.resolved.allowedActors.length === 0) return
    if (this.resolved.allowedActors.includes(actor)) return
    throw new SelfDevelopmentRemoteError(
      `actor ${JSON.stringify(actor)} is not in the configured allowlist`,
      'SELF_DEV_REMOTE_ACTOR_FORBIDDEN',
    )
  }

  /**
   * Resolve the supervised runner plugin.
   * @returns the runner service, or `undefined` when the plugin is not loaded.
   */
  private runner(): SelfDevelopmentRunner | undefined {
    return this.ctx.get('selfDevelopmentRunner')
  }

  /**
   * Resolve the supervised runner plugin, refusing explicitly when absent.
   * @returns the runner service.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_RUNNER_UNAVAILABLE` when the runner
   *   plugin is not loaded.
   */
  private requireRunner(): SelfDevelopmentRunner {
    const runner = this.runner()
    if (runner !== undefined) return runner
    throw new SelfDevelopmentRemoteError(
      'runAttempt requires the supervised runner plugin; selfDevelopmentRunner is not loaded in this context',
      'SELF_DEV_REMOTE_RUNNER_UNAVAILABLE',
    )
  }

  /**
   * The trusted clock observations are stamped with: the runner's singleton
   * clock when the runner plugin is loaded, otherwise the facade's own host
   * clock.
   * @returns the trusted clock in use.
   */
  private clock(): TrustedClock {
    const runner = this.runner()
    if (runner !== undefined) return runner.clock()
    const existing = this.ownClock
    if (existing !== undefined) return existing
    const created = new HostClock()
    this.ownClock = created
    return created
  }

  /**
   * Generate one operation id for a forwarded mutating operation.
   * @returns a fresh branded UUID the caller can use to replay the operation exactly.
   */
  private operationId(): ReturnType<typeof SelfDevOperationId> {
    return SelfDevOperationId(randomUUID())
  }

  /**
   * Open (or resume) one task's controller through the task-control service.
   * @param taskId - task identity naming the journal directory.
   * @returns the task controller.
   * @throws whatever the task-control service rejects with, verbatim.
   */
  private async open(taskId: string): Promise<SelfDevelopmentTaskController> {
    return this.ctx.selfDevelopmentTasks.open(taskId, this.clock())
  }

  /**
   * Check that a task journal exists before a read path opens it, so reading
   * an unknown task never creates its directory.
   * @param taskId - task identity.
   * @returns nothing once the journal directory exists.
   * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_TASK_UNKNOWN` when the task has no
   *   journal directory.
   */
  private async assertTaskExists(taskId: string): Promise<void> {
    const directory = join(this.resolved.controlDirectory, 'tasks', taskId)
    try {
      await stat(directory)
    } catch {
      throw new SelfDevelopmentRemoteError(
        `task ${JSON.stringify(taskId)} has no journal under the control directory`,
        'SELF_DEV_REMOTE_TASK_UNKNOWN',
      )
    }
  }

  /**
   * Assemble the human-presence confirmation for one launch. The confirmation
   * time is one trusted-clock observation taken now; the plan digest comes
   * from the projection at the requested revision, and the acceptance digest
   * from the definition's bytes.
   * @param projection - the task projection at the requested revision.
   * @param request - the validated run-attempt request.
   * @returns the confirmation the runner binds to the real launch facts.
   * @throws SelfDevelopmentError with `SELF_DEV_INVALID_STATE` when the task has no confirmed plan.
   * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` when the acceptance
   *   definition cannot be read.
   */
  private async buildPresence(
    projection: TaskProjection,
    request: RemoteRunAttemptRequest,
  ): Promise<PresenceConfirmation> {
    const plan = projection.plan
    if (plan === undefined) {
      throw new SelfDevelopmentError(
        `attempt launch requires a confirmed plan; task ${request.taskId} has none`,
        'SELF_DEV_INVALID_STATE',
      )
    }
    return {
      confirmedBy: request.confirmedBy,
      confirmedAt: this.clock().observe(),
      worktree: request.worktree,
      loopbackAllowlist: [...request.loopbackAllowlist],
      acknowledgement: 'supervised-not-unattended',
      taskId: request.taskId,
      testPlanDigest: plan.digest,
      acceptanceDefinitionDigest: await acceptanceDefinitionDigest(request.acceptancePath),
      artifactPaths: sortedUnique(request.artifactPaths),
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Stable-side Remote facade over the self-development services. */
    selfDevelopmentRemote: SelfDevelopmentRemote
  }
}

export default SelfDevelopmentRemote

/**
 * Digest the raw bytes of the acceptance definition for the presence binding.
 * @param path - absolute path of the acceptance definition.
 * @returns the lowercase sha-256 hex digest of the file bytes.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` when the file cannot
 *   be read, matching the code the runner rejects an unusable definition with.
 */
async function acceptanceDefinitionDigest(path: string): Promise<string> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    /* v8 ignore next 3 -- readFile rejects with an Error, so the non-Error branch is unreachable. */
    throw new SelfDevelopmentRunnerError(
      `acceptance definition ${JSON.stringify(path)} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      'SELF_DEV_RUNNER_ACCEPTANCE_INVALID',
    )
  }
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Deduplicate and sort artifact paths into the canonical recorded order.
 * @param paths - artifact paths as handed in.
 * @returns the unique ascending paths.
 */
function sortedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort()
}

/**
 * Read the `approvedBy` field of a validated budget approval for the actor check.
 * @param approval - the approval as parsed from the wire.
 * @returns the approving actor.
 */
function readApprovedBy(approval: BudgetApprovalInput): string {
  return approval.approvedBy
}

/**
 * Validate the deployment configuration at construction time.
 * @param config - configuration as parsed from cordis.yml.
 * @returns the same configuration once every field is proven usable.
 * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_CONFIG_INVALID` when the control directory
 *   is not an absolute path.
 */
function validateConfig(config: RemoteConfig): RemoteConfig {
  const invalid = (detail: string): SelfDevelopmentRemoteError =>
    new SelfDevelopmentRemoteError(`self-development remote config is invalid: ${detail}`, 'SELF_DEV_REMOTE_CONFIG_INVALID')
  if (config.controlDirectory.length === 0 || !isAbsolute(config.controlDirectory)) {
    throw invalid(`controlDirectory ${JSON.stringify(config.controlDirectory)} must be an absolute path`)
  }
  return config
}
