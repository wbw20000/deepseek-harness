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
  PresenceAcknowledgement,
  PresenceConfirmation,
  SelfDevelopmentRunner,
} from '@deepseek-ai/dsh-workflow-self-development-runner'
// Type-only: pulls the events consumer's Context merge (including the
// campaign-passed/campaign-ended event declarations) so `selfDevelopmentEvents`
// below and this facade's own `ctx.emit` calls are typed.
import type {} from '@deepseek-ai/dsh-workflow-self-development-events'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SelfDevelopmentErrorCode } from '@deepseek-ai/dsh-workflow-self-development'
import type { SelfDevelopmentRunnerErrorCode } from '@deepseek-ai/dsh-workflow-self-development-runner'
import { buildConfirmationCard, taskTitle } from './card.ts'
import {
  countRunningCampaigns,
  readCampaign,
  stopRunningCampaignsAfterRestart,
  writeCampaign,
} from './campaign.ts'
import type { CampaignRecord } from './campaign.ts'
import { readLaunchProfile, resolveLaunchProfile, writeLaunchProfile } from './launch-profile.ts'
import { toCampaignState, toWireEvent, toWireOutcome, toWireProjection } from './wire.ts'
import { SelfDevelopmentRemoteError } from './errors.ts'
import {
  assertHostOnlyFields,
  parseApproveBudgetInput,
  parseAuthorizePlanningInput,
  parseCampaignOptions,
  parseCampaignStopReason,
  parseConfirmPlanInput,
  parseCreateTaskInput,
  parseExpectedRevision,
  parseLaunchProfileInput,
  parseRecordTrialApprovalInput,
  parseRunAttemptRequest,
  parseStopInput,
  parseSubmitPlanDraftInput,
  parseTaskId,
} from './schema.ts'
import type {
  BudgetApprovalInput,
  CampaignOptions,
  CampaignState,
  CampaignStatus,
  ConfirmedPlanInput,
  LaunchProfile,
  LaunchProfileInput,
  LaunchProfileResult,
  PlanDraftInput,
  RecentEvent,
  RemoteConfig,
  RemoteConnectionService,
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
  CampaignOptions,
  CampaignRoundOutcome,
  CampaignState,
  CampaignStatus,
  CardBudget,
  ConfirmedPlanInput,
  ConfirmationCard,
  LaunchProfile,
  LaunchProfileInput,
  LaunchProfileResult,
  PlanDraftInput,
  RecentEvent,
  RemoteConfig,
  RemoteConnectionCaller,
  RemoteConnectionService,
  RemoteOperationResult,
  RemoteRunAttemptOutcome,
  RemoteRunAttemptRequest,
  RemoteTaskProjection,
  TaskDetail,
  TaskSpecInput,
  TaskSummary,
} from './types.ts'
export {
  campaignPath,
  countRunningCampaigns,
  listCampaigns,
  PROCESS_RESTARTED_REASON,
  readCampaign,
  stopRunningCampaignsAfterRestart,
  writeCampaign,
} from './campaign.ts'
export type { CampaignRecord } from './campaign.ts'
export {
  launchProfilePath,
  readLaunchProfile,
  resolveLaunchProfile,
  writeLaunchProfile,
} from './launch-profile.ts'
export { toCampaignState, toWireEvent, toWireOutcome, toWireProjection } from './wire.ts'

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
 * The connection service is optional too and is read with `ctx.get`, per the
 * repository's optional-service rule: a deployment without the phone channel
 * mounts no connection service, and every caller is then the stable host.
 */
export class SelfDevelopmentRemote extends TypertRemoteService {
  static inject = ['selfDevelopmentTasks']

  /** Runtime schema for the service config; every field is deployment-owned. */
  static Config = z.object({
    enabled: z.boolean().default(false),
    allowedActors: z.array(z.string()).default([]),
    controlDirectory: z.string().required(),
    maxConcurrentCampaigns: z.number().step(1).default(2),
    roundDelayMs: z.number().step(1).default(1000),
  }) as unknown as z<RemoteConfig>

  /** Validated deployment configuration. */
  private readonly resolved: RemoteConfig

  /** Facade-owned trusted clock, used only when the runner plugin is absent. */
  private ownClock: HostClock | undefined

  /**
   * Task ids whose campaign loop this process currently owns — added the
   * instant `startCampaign` commits the initial record, removed the instant
   * the loop (or a racing `stopCampaign`) finalizes it. `activeTasks` unions
   * this with the runner's own set, so a task counts as active during the
   * gap between two rounds, when the runner itself has nothing in flight.
   */
  private readonly runningCampaigns = new Set<string>()

  /**
   * The in-flight `finalizeCampaign` promise for a task currently being
   * finalized, published synchronously before any await so a racing loser
   * can always find and await it rather than reading a write still in
   * flight. Cleared once that finalization settles.
   */
  private readonly finalizing = new Map<string, Promise<CampaignRecord>>()

  /**
   * Per-task serialization of campaign record writes. A round's record
   * update and a concurrent `stopCampaign`'s finalization each reach their
   * write only after their own awaits, so without a shared order the round's
   * `running` record could land after the finalized `stopped` one and revert
   * it — a field test left a stopped campaign reading `running` this way.
   * Every record write goes through this chain, and a round update re-checks
   * `runningCampaigns` inside it, so a finalization is always the last word.
   */
  private readonly recordWrites = new Map<string, Promise<unknown>>()

  /**
   * Serializes `startCampaign`'s check-then-write section (already-running
   * check, `maxConcurrentCampaigns` count, and the initial record write),
   * which otherwise spans several `await` points with no mutual exclusion:
   * two concurrent calls could both observe spare capacity and both write,
   * over-running the cap, or both win the same task's "not already running"
   * check and start two loops for it. A promise-chain mutex, not a
   * per-`controlDirectory` one — this process serves exactly one.
   */
  private campaignStartLock: Promise<unknown> = Promise.resolve()

  /**
   * This process's one-time campaign-restart recovery, memoized so every
   * caller of a campaign method awaits the same scan instead of racing it.
   */
  private restartScan: Promise<void> | undefined

  /**
   * @param ctx - owning Cordis context carrying the task-control service.
   * @param config - deployment configuration for the enablement switch, the
   *   actor allowlist, the task-control service's control directory, and the
   *   default concurrent-campaign cap.
   * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when the control
   *   directory is not an absolute path. Misconfiguration fails at load.
   */
  constructor(ctx: Context, config: RemoteConfig) {
    super(ctx, 'selfDevelopmentRemote', { namespace: 'selfDevelopmentRemote' })
    this.resolved = validateConfig(config)
  }

  /**
   * List every task under the control directory with its progress row.
   * @returns one row per task journal directory, sorted by task id.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled` while the facade is disabled.
   * @throws whatever the task-control service or a task journal rejects with, converted at the
   *   facade boundary into `self-development/core` (`details.code` keeps the original code).
   */
  @Remote('listTasks')
  async listTasks(): Promise<readonly TaskSummary[]> {
    return this.forward(async () => {
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
    })
  }

  /**
   * Read one task's full projection and its confirmation-card view. The card
   * carries the task's stored launch profile, when the host has set one; a
   * stored but unreadable profile refuses the read with
   * `self-development/config-invalid` rather than rendering without it.
   * @param taskId - task identity.
   * @returns the projection and the read-only card.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled` while the facade is disabled,
   *   `self-development/config-invalid` when the task id is malformed or the stored launch profile
   *   fails its shape validation, or
   *   `self-development/task-unknown` when the task has no journal yet; the facade never creates a
   *   journal from a read path.
   * @throws whatever the task-control service rejects with, converted at the facade boundary into
   *   `self-development/core` (`details.code` keeps the original code).
   */
  @Remote('getTask')
  async getTask(taskId: string): Promise<TaskDetail> {
    return this.forward(async () => {
      this.assertEnabled()
      const id = parseTaskId(taskId)
      await this.assertTaskExists(id)
      const projection = await this.ctx.selfDevelopmentTasks.state(id, this.clock())
      const launchProfile = await readLaunchProfile(this.resolved.controlDirectory, id)
      return {
        projection: toWireProjection(projection),
        card: buildConfirmationCard(id, projection, launchProfile),
      }
    })
  }

  /**
   * Read the retained recent self-development notification events.
   * @returns the events consumer's title-level buffer, oldest first; `[]` when
   *   the events consumer plugin is not loaded in this context.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled` while the facade is disabled.
   */
  @Remote('recentEvents')
  async recentEvents(): Promise<readonly RecentEvent[]> {
    return this.forward(async () => {
      this.assertEnabled()
      const events = this.ctx.get('selfDevelopmentEvents')
      return await Promise.resolve(events === undefined ? [] : events.recent().map(toWireEvent))
    })
  }

  /**
   * Create one task from a TaskSpec, optionally storing a launch profile in
   * the same call. The actor is the spec's `createdBy` field; it is checked
   * against `allowedActors` when that list is non-empty. The profile's
   * derived `confirmedBy` and the spec's `createdBy` are both actor-checked.
   * The profile is written only after the core commits the creation: a
   * failed create leaves no profile file behind.
   * @param spec - TaskSpec in wire form.
   * @param expectedRevision - revision the caller observed; a new task is at revision 0.
   * @param launchProfile - optional launch profile; host-only, and every field of it derives or
   *   stores an isolation or confirmation setting.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`,
   *   `self-development/actor-forbidden`, or `self-development/host-only-field` from a non-host caller:
   *   the spec fixes `stableBaselineDigest` and `allowedModificationScope`, and a present
   *   `launchProfile` fixes the launch isolation and confirmation settings, which the phone
   *   whitelist may not set.
   * @throws whatever the task-control service rejects with, converted at the facade boundary into
   *   `self-development/core` (`details.code` keeps the original code).
   */
  @Remote('createTask')
  async createTask(
    spec: TaskSpecInput,
    expectedRevision: number,
    launchProfile?: LaunchProfileInput,
  ): Promise<RemoteOperationResult> {
    return this.forward(async () => {
      this.assertEnabled()
      const parsed = parseCreateTaskInput(spec, expectedRevision, launchProfile)
      if (parsed.launchProfile !== undefined) {
        // The whole profile argument is host-only; this check fires before the
        // method-level refusal so a phone caller sees the offending field.
        assertHostOnlyFields('launchProfile', parsed.launchProfile, this.callerIsHost())
      }
      this.assertCallerIsHost('createTask', 'stableBaselineDigest and allowedModificationScope')
      this.assertActorAllowed(parsed.spec.createdBy)
      // The profile resolves against the spec being created, so the derived
      // artifactPaths exist before the task's journal does.
      const resolvedProfile = parsed.launchProfile === undefined
        ? undefined
        : this.resolveCheckedProfile(parsed.launchProfile, parsed.spec)
      const operationId = this.operationId()
      const controller = await this.open(parsed.spec.taskId)
      const result = await controller.createTask({
        taskId: SelfDevTaskId(parsed.spec.taskId),
        expectedRevision: parsed.expectedRevision,
        operationId,
        spec: parsed.spec,
      })
      if (resolvedProfile !== undefined) {
        await writeLaunchProfile(this.resolved.controlDirectory, parsed.spec.taskId, resolvedProfile)
      }
      return { taskId: parsed.spec.taskId, operationId, ...result }
    })
  }

  /**
   * Store one task's launch profile, replacing any previous one. The profile
   * resolves its derived fields against the task's current spec and the
   * facade's `allowedActors` before anything is written.
   * @param taskId - task identity.
   * @param profile - launch profile in wire form; every field is host-only.
   * @returns the task id and the stored profile with every derived field filled.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`
   *   (malformed id, malformed profile, or an underivable `artifactPaths`/`confirmedBy`),
   *   `self-development/actor-forbidden`, `self-development/host-only-field` from a non-host caller,
   *   or `self-development/task-unknown` when the task has no journal yet.
   * @throws whatever the task-control service rejects with, converted at the facade boundary into
   *   `self-development/core` (`details.code` keeps the original code).
   */
  @Remote('setLaunchProfile')
  async setLaunchProfile(taskId: string, profile: LaunchProfileInput): Promise<LaunchProfileResult> {
    return this.forward(async () => {
      this.assertEnabled()
      const id = parseTaskId(taskId)
      const parsed = parseLaunchProfileInput(profile)
      this.assertCallerIsHost('setLaunchProfile', 'worktree, acceptancePath, artifactPaths, dataHome')
      await this.assertTaskExists(id)
      const controller = await this.open(id)
      const resolved = this.resolveCheckedProfile(parsed, controller.projection.spec)
      await writeLaunchProfile(this.resolved.controlDirectory, id, resolved)
      return { taskId: id, launchProfile: resolved }
    })
  }

  /**
   * Resolve one launch profile input against a spec and actor-check the
   * derived confirmer, so every profile the facade stores carries an
   * allowlisted `confirmedBy`.
   * @param input - the host's profile in wire form.
   * @param spec - the spec supplying the `allowedModificationScope` default.
   * @returns the resolved profile ready to store.
   * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when a derived field
   *   has no source, or `self-development/actor-forbidden` when the resolved confirmer is not
   *   in the allowlist.
   */
  private resolveCheckedProfile(
    input: LaunchProfileInput,
    spec: { readonly allowedModificationScope: readonly string[] } | undefined,
  ): LaunchProfile {
    const resolved = resolveLaunchProfile(input, spec, this.resolved.allowedActors, Date.now())
    this.assertActorAllowed(resolved.confirmedBy)
    return resolved
  }

  /**
   * Grant the separate planning authorization. This never approves
   * development and consumes no development round.
   * @param taskId - task identity.
   * @param expectedRevision - revision the caller observed.
   * @param authorizedBy - human actor granting the authorization.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled` or `self-development/config-invalid`.
   * @throws whatever the task-control service rejects with, converted at the facade boundary into
   *   `self-development/core` (`details.code` keeps the original code).
   */
  @Remote('authorizePlanning')
  async authorizePlanning(taskId: string, expectedRevision: number, authorizedBy: string): Promise<RemoteOperationResult> {
    return this.forward(async () => {
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
    })
  }

  /**
   * Submit a drafted plan for human confirmation.
   * @param taskId - task identity.
   * @param expectedRevision - revision the caller observed.
   * @param draft - plan draft in wire form.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled` or `self-development/config-invalid`.
   * @throws whatever the task-control service rejects with, converted at the facade boundary into
   *   `self-development/core` (`details.code` keeps the original code).
   */
  @Remote('submitPlanDraft')
  async submitPlanDraft(
    taskId: string,
    expectedRevision: number,
    draft: PlanDraftInput,
  ): Promise<RemoteOperationResult> {
    return this.forward(async () => {
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
    })
  }

  /**
   * Freeze the human-confirmed plan. The actor is the explicit confirmer.
   * @param taskId - task identity.
   * @param expectedRevision - revision the caller observed.
   * @param plan - confirmed plan in wire form.
   * @param actor - human actor confirming the plan; checked against `allowedActors`.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`,
   *   or `self-development/actor-forbidden`.
   * @throws whatever the task-control service rejects with, converted at the facade boundary into
   *   `self-development/core` (`details.code` keeps the original code).
   */
  @Remote('confirmPlan')
  async confirmPlan(
    taskId: string,
    expectedRevision: number,
    plan: ConfirmedPlanInput,
    actor: string,
  ): Promise<RemoteOperationResult> {
    return this.forward(async () => {
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
    })
  }

  /**
   * Record a human budget approval, or replace the current one. The actor is
   * the approval's `approvedBy` field; consumed rounds and time never reset.
   * @param taskId - task identity.
   * @param expectedRevision - revision the caller observed.
   * @param approval - budget approval in wire form.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`,
   *   or `self-development/actor-forbidden`.
   * @throws whatever the task-control service rejects with, converted at the facade boundary into
   *   `self-development/core` (`details.code` keeps the original code).
   */
  @Remote('approveBudget')
  async approveBudget(
    taskId: string,
    expectedRevision: number,
    approval: BudgetApprovalInput,
  ): Promise<RemoteOperationResult> {
    return this.forward(async () => {
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
    })
  }

  /**
   * Stop a task at human request. When the runner is loaded, the stop goes
   * through it so owned process groups and evidence writes finish before the
   * result returns; otherwise only the core stop runs.
   * @param taskId - task identity.
   * @param expectedRevision - revision the caller observed.
   * @param reason - optional stop reason; only `cancelled` exists today.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled` or `self-development/config-invalid`.
   * @throws whatever the core or the runner rejects with, converted at the facade boundary into
   *   `self-development/core` (`details.code` keeps the original code).
   */
  @Remote('stop')
  async stop(taskId: string, expectedRevision: number, reason?: 'cancelled'): Promise<RemoteOperationResult> {
    return this.forward(async () => {
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
    })
  }

  /**
   * Record a human trial approval bound to the current verified result. The
   * actor is the approver. No upgrade path exists in this facade.
   * @param taskId - task identity.
   * @param expectedRevision - revision the caller observed.
   * @param approvedBy - human actor approving the trial; checked against `allowedActors`.
   * @returns the operation id the facade generated plus the core's result.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`,
   *   or `self-development/actor-forbidden`.
   * @throws whatever the task-control service rejects with, converted at the facade boundary into
   *   `self-development/core` (`details.code` keeps the original code).
   */
  @Remote('recordTrialApproval')
  async recordTrialApproval(
    taskId: string,
    expectedRevision: number,
    approvedBy: string,
  ): Promise<RemoteOperationResult> {
    return this.forward(async () => {
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
    })
  }

  /**
   * Launch one supervised attempt. The facade assembles the
   * `PresenceConfirmation` from the request and the frozen plan, and refuses
   * unless the caller explicitly passed `presenceAcknowledged: true` — a UI
   * must never default that acknowledgement. Requires the runner plugin.
   *
   * The five launch fields (`worktree`, `artifactPaths`, `acceptancePath`,
   * `loopbackAllowlist`, `confirmedBy`) are optional: an absent field is
   * derived from the task's stored launch profile, and an explicit value
   * overrides the profile. A field that is neither explicit nor derivable
   * refuses with `self-development/config-invalid`, naming the field.
   * @param request - the supervised attempt request in wire form.
   * @returns the runner's outcome plus the operation id the facade generated.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`
   *   (a malformed field, an unreadable stored profile, or an underivable launch field),
   *   `self-development/presence-unconfirmed` when
   *   `presenceAcknowledged` is not exactly `true`, `self-development/host-only-field` from a
   *   non-host caller (the launch assigns the worktree, acceptance, and artifact isolation
   *   settings, and a non-host request may not set the host-only `dataHome`), or
   *   `self-development/runner-unavailable` when the runner plugin is not loaded.
   * @throws whatever the core or the runner rejects with, converted at the facade boundary into
   *   `self-development/core` (`details.code` keeps the original code).
   */
  @Remote('runAttempt')
  async runAttempt(request: RemoteRunAttemptRequest): Promise<RemoteRunAttemptOutcome> {
    return this.forward(async () => {
      this.assertEnabled()
      const parsed = parseRunAttemptRequest(request)
      assertHostOnlyFields('runAttempt', parsed, this.callerIsHost())
      this.assertCallerIsHost('runAttempt', 'worktree, acceptancePath, artifactPaths, dataHome')
      if (!parsed.presenceAcknowledged) {
        throw new SelfDevelopmentRemoteError(
          'self-development/presence-unconfirmed',
          'presenceAcknowledged must be explicitly true; a UI must never default or pre-select the human-presence acknowledgement',
        )
      }
      // The task id names a file under launch-profiles/, so it is validated
      // like every other id-addressed read before anything touches the disk.
      const taskId = parseTaskId(parsed.taskId)
      const profile = await readLaunchProfile(this.resolved.controlDirectory, taskId)
      // Explicit values win; an absent value derives from the stored profile.
      const effective: ResolvedRunAttemptRequest = {
        ...parsed,
        worktree: parsed.worktree ?? fromProfile(profile, 'worktree'),
        artifactPaths: sortedUnique(parsed.artifactPaths ?? fromProfile(profile, 'artifactPaths')),
        acceptancePath: parsed.acceptancePath ?? fromProfile(profile, 'acceptancePath'),
        loopbackAllowlist: parsed.loopbackAllowlist ?? fromProfile(profile, 'loopbackAllowlist'),
        confirmedBy: parsed.confirmedBy ?? fromProfile(profile, 'confirmedBy'),
      }
      this.assertActorAllowed(effective.confirmedBy)
      const runner = this.requireRunner()
      const controller = await this.open(taskId)
      const presence = await this.buildPresence(controller.projection, effective, 'supervised-not-unattended')
      const operationId = this.operationId()
      const outcome = await runner.runAttempt({
        taskId,
        expectedRevision: parsed.expectedRevision,
        operationId,
        worktree: effective.worktree,
        artifactPaths: effective.artifactPaths,
        acceptancePath: effective.acceptancePath,
        // Host-only: only the stable host supplies a data directory, forwarded
        // verbatim; a phone channel omits the field and the runner keeps its
        // configured `dshHome`.
        ...(parsed.dataHome === undefined ? {} : { dshHome: parsed.dataHome }),
        presence,
      })
      return toWireOutcome(outcome, operationId, effective.worktree)
    })
  }

  /**
   * The task ids of the attempts the runner currently owns, plus every task
   * with a campaign loop this process currently owns.
   * @returns a read-only snapshot, deduplicated; excludes the runner's own
   *   set only when the runner plugin is absent.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled` while the facade is disabled.
   */
  @Remote('activeTasks')
  async activeTasks(): Promise<readonly string[]> {
    return this.forward(async () => {
      this.assertEnabled()
      const runnerActive = this.runner()?.activeTasks() ?? []
      return await Promise.resolve([...new Set([...runnerActive, ...this.runningCampaigns])])
    })
  }

  /**
   * Start one unattended campaign: create its record and launch the first
   * round immediately, in the background. The returned state is the freshly
   * created record (`status: 'running'`, `rounds: 0`) — it never waits for
   * the first round, which can run for as long as the approved budget
   * allows; poll `campaign(taskId)` for progress.
   *
   * `options.unattended` decides both the acknowledgement every round this
   * campaign derives carries and whether the loop continues past the first
   * round. `true`: every round — including the first — carries
   * `acknowledgement: 'unattended-accepted'`, the recorded fact of this
   * call's one-time acceptance covering the whole budget window, never an
   * isolation guarantee; the loop keeps launching rounds, each with a
   * freshly derived `PresenceConfirmation` and a fresh operation id, until a
   * terminal status. `false`: this call's acceptance covers only the first
   * round, which therefore carries `acknowledgement:
   * 'supervised-not-unattended'` — the same literal a direct `runAttempt`
   * asserts. A pass still reaches `status: 'passed'`, sharing the loop's one
   * success path with an `unattended: true` campaign — passing is already
   * terminal regardless of `unattended`. Only a failure that is not itself
   * campaign-terminal stops the loop early because `unattended` is `false`:
   * `status: 'stopped'`, leaving further rounds to a direct manual
   * `runAttempt`.
   * @param taskId - task identity.
   * @param expectedRevision - revision the caller observed; binds the first round only, later rounds re-read the current revision.
   * @param options - campaign options; host-only in full.
   * @returns the task id and the freshly created campaign state.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`
   *   (malformed fields, a task that already has a running campaign, or a call that would exceed
   *   `maxConcurrentCampaigns`), `self-development/actor-forbidden`, `self-development/host-only-field`
   *   from a non-host caller, or `self-development/runner-unavailable` when the runner plugin is not loaded.
   */
  @Remote('startCampaign')
  async startCampaign(taskId: string, expectedRevision: number, options: CampaignOptions): Promise<{
    readonly taskId: string
    readonly campaign: CampaignState
  }> {
    return this.forward(async () => {
      this.assertEnabled()
      const id = parseTaskId(taskId)
      const revision = parseExpectedRevision(expectedRevision)
      const parsedOptions = parseCampaignOptions(options)
      this.assertCallerIsHost('startCampaign', 'campaign lifecycle and the unattended presence acknowledgement')
      this.assertActorAllowed(parsedOptions.acceptedBy)
      this.requireRunner()
      const record = await this.lockCampaignStart(() => this.claimCampaignSlot(id, parsedOptions))
      // Fire-and-forget: the loop owns its own finalization and never lets an
      // error escape unhandled; a crash it cannot classify still finalizes
      // the record as 'failed' before this catch could ever run.
      this.runCampaignLoop(id, revision).catch((error: unknown) => {
        this.ctx.logger.warn('self-development-remote: campaign loop crashed for task "%s"', id)
        this.ctx.logger.warn(error)
      })
      return { taskId: id, campaign: toCampaignState(record) }
    })
  }

  /**
   * Run one function while holding `campaignStartLock`, queuing behind
   * whatever call already holds it. The lock is released whether `fn`
   * resolves or rejects, so a refused `startCampaign` never blocks the next
   * queued one.
   * @param fn - the critical section to run exclusively.
   * @returns `fn`'s result.
   */
  private async lockCampaignStart<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.campaignStartLock
    // The executor below runs synchronously inside `new Promise`, so
    // `release` always holds the real resolver by the time `finally` reads
    // it; this placeholder only satisfies the type without a non-null
    // assertion, and is itself never called.
    /* v8 ignore next */
    let release: () => void = () => {}
    this.campaignStartLock = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /**
   * `startCampaign`'s check-then-write critical section: the already-running
   * and `maxConcurrentCampaigns` checks, and the initial record write. Must
   * run inside `lockCampaignStart` — read alone, `runningCampaigns.has` and
   * `countRunningCampaigns` are consistent only against writes serialized the
   * same way.
   * @param id - validated task identity.
   * @param parsedOptions - validated campaign options.
   * @returns the freshly written initial record.
   * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when the task already
   *   has a running campaign, or starting this one would exceed `maxConcurrentCampaigns`.
   */
  private async claimCampaignSlot(id: string, parsedOptions: CampaignOptions): Promise<CampaignRecord> {
    await this.ensureRestartScan()
    if (this.runningCampaigns.has(id)) {
      throw new SelfDevelopmentRemoteError('self-development/config-invalid', `task ${JSON.stringify(id)} already has a running campaign`)
    }
    const cap = parsedOptions.maxConcurrentCampaigns ?? this.resolved.maxConcurrentCampaigns
    const running = await countRunningCampaigns(this.resolved.controlDirectory)
    if (running >= cap) {
      throw new SelfDevelopmentRemoteError(
        'self-development/config-invalid',
        `starting this campaign would exceed maxConcurrentCampaigns (${cap})`,
      )
    }
    const startedAt = Date.now()
    const record: CampaignRecord = {
      taskId: id,
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      rounds: 0,
      // 'unattended: false' still auto-launches one round, but that round's
      // confirmation is this call's own single acceptance of that one
      // launch — the same wording a direct runAttempt asserts — never the
      // campaign-wide 'unattended-accepted' acceptance.
      acknowledgement: parsedOptions.unattended ? 'unattended-accepted' : 'supervised-not-unattended',
      unattended: parsedOptions.unattended,
      acceptedBy: parsedOptions.acceptedBy,
    }
    await writeCampaign(this.resolved.controlDirectory, id, record)
    this.runningCampaigns.add(id)
    return record
  }

  /**
   * Read one task's current campaign state.
   * @param taskId - task identity.
   * @returns the stored campaign state, or `undefined` when the task has never had a campaign.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`
   *   (malformed task id, or a corrupt stored record), or `self-development/host-only-field` from a
   *   non-host caller.
   */
  @Remote('campaign')
  async campaign(taskId: string): Promise<CampaignState | undefined> {
    return this.forward(async () => {
      this.assertEnabled()
      const id = parseTaskId(taskId)
      this.assertCallerIsHost('campaign', 'campaign lifecycle')
      await this.ensureRestartScan()
      const record = await readCampaign(this.resolved.controlDirectory, id)
      return record === undefined ? undefined : toCampaignState(record)
    })
  }

  /**
   * Stop one task's campaign: cancel whatever attempt is currently in flight
   * through the runner and end the loop. Already terminal (not `running`) is
   * a no-op that returns the stored state unchanged — nothing is left in
   * flight to cancel. Requires the runner plugin, exactly like
   * `startCampaign`: a campaign cannot exist without one having launched its
   * rounds.
   * @param taskId - task identity.
   * @param reason - human-readable stop reason recorded on the campaign; never entered into an event title verbatim.
   * @returns the finalized (or already-terminal) campaign state.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled`, `self-development/config-invalid`
   *   (malformed fields, or no campaign record exists for this task), `self-development/host-only-field`
   *   from a non-host caller, or `self-development/runner-unavailable` when the runner plugin is not loaded.
   * @throws whatever the core or the runner rejects with, converted at the facade boundary into
   *   `self-development/core` (`details.code` keeps the original code).
   */
  @Remote('stopCampaign')
  async stopCampaign(taskId: string, reason: string): Promise<CampaignState> {
    return this.forward(async () => {
      this.assertEnabled()
      const id = parseTaskId(taskId)
      const parsedReason = parseCampaignStopReason(reason)
      this.assertCallerIsHost('stopCampaign', 'campaign lifecycle')
      const runner = this.requireRunner()
      await this.ensureRestartScan()
      const record = await readCampaign(this.resolved.controlDirectory, id)
      if (record === undefined) {
        throw new SelfDevelopmentRemoteError('self-development/config-invalid', `no campaign record exists for task ${JSON.stringify(id)}`)
      }
      if (record.status !== 'running') return toCampaignState(record)
      const controller = await this.open(id)
      await runner.stop({
        taskId: id,
        expectedRevision: controller.projection.revision,
        operationId: this.operationId(),
      })
      const finalized = await this.finalizeCampaign(id, record, { status: 'stopped', reason: parsedReason })
      return toCampaignState(finalized)
    })
  }

  /**
   * Run one `@Remote` body behind the facade's failure conversion. The
   * Gateway forwards only `RemoteError`s and folds everything else into
   * `gateway/internal`, so a core or runner rejection is converted here into
   * `self-development/core` with the owning package's code in `details.code`,
   * while the facade's own refusals pass through unchanged.
   * @param invoke - the method body to run.
   * @returns the body's result.
   */
  private async forward<T>(invoke: () => Promise<T>): Promise<T> {
    try {
      return await invoke()
    } catch (error) {
      if (error instanceof RemoteError) throw error
      if (error instanceof SelfDevelopmentError || error instanceof SelfDevelopmentRunnerError) {
        // The owning packages narrow `code` through their constructors, below
        // HarnessError's string-typed property.
        throw new RemoteError('self-development/core', error.message, {
          code: error.code as SelfDevelopmentErrorCode | SelfDevelopmentRunnerErrorCode,
        }, { cause: error })
      }
      throw error
    }
  }

  /**
   * Refuse every method while the facade is disabled.
   * @returns nothing when the facade is enabled.
   * @throws SelfDevelopmentRemoteError with `self-development/disabled` while `enabled` is `false`.
   */
  private assertEnabled(): void {
    if (this.resolved.enabled) return
    throw new SelfDevelopmentRemoteError(
      'self-development/disabled',
      'self-development remote is disabled; set enabled: true in the service config to allow UI and phone operations',
    )
  }

  /**
   * Check an operation's actor against the allowlist.
   * @param actor - the operation's actor field.
   * @returns nothing when the actor may act.
   * @throws SelfDevelopmentRemoteError with `self-development/actor-forbidden` when the allowlist is
   *   non-empty and does not contain the actor.
   */
  private assertActorAllowed(actor: string): void {
    if (this.resolved.allowedActors.length === 0) return
    if (this.resolved.allowedActors.includes(actor)) return
    throw new SelfDevelopmentRemoteError(
      'self-development/actor-forbidden',
      `actor ${JSON.stringify(actor)} is not in the configured allowlist`,
    )
  }

  /**
   * Whether the current Remote caller counts as the stable host. The
   * connection layer derives the answer from the request's Host header: a
   * loopback host is this machine. Without the connection service, or outside
   * any `@Remote` request, there is no caller context and the call is treated
   * as the host — the local direct-call and test semantics.
   * @returns whether the caller may set host-only isolation fields.
   */
  private callerIsHost(): boolean {
    const caller = this.connection()?.caller.current()
    if (caller === undefined) return true
    return caller.loopback
  }

  /**
   * Read the optional connection service structurally. The service is read
   * with `ctx.get` instead of a declared injection so deployments without the
   * phone channel load the facade unchanged.
   * @returns the connection service, or `undefined` when it is not mounted.
   */
  private connection(): RemoteConnectionService | undefined {
    const connection: unknown = this.ctx.get('connection')
    return connection as RemoteConnectionService | undefined
  }

  /**
   * Refuse an isolation-setting operation from a non-host caller, before the
   * core or runner is touched.
   * @param operation - facade method the caller invoked.
   * @param settings - the isolation settings the operation assigns.
   * @returns nothing when the caller counts as the stable host.
   * @throws SelfDevelopmentRemoteError with `self-development/host-only-field` from a caller whose
   *   Host header is not loopback; the message states what the phone whitelist
   *   may still do.
   */
  private assertCallerIsHost(operation: string, settings: string): void {
    if (this.callerIsHost()) return
    throw new SelfDevelopmentRemoteError(
      'self-development/host-only-field',
      `${operation} assigns isolation settings (${settings}) and is reserved for the stable host; `
        + 'a phone caller may watch progress, interject, confirm the plan and budget, stop, and approve or reject the trial',
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
   * @throws SelfDevelopmentRemoteError with `self-development/runner-unavailable` when the runner
   *   plugin is not loaded.
   */
  private requireRunner(): SelfDevelopmentRunner {
    const runner = this.runner()
    if (runner !== undefined) return runner
    throw new SelfDevelopmentRemoteError(
      'self-development/runner-unavailable',
      'runAttempt requires the supervised runner plugin; selfDevelopmentRunner is not loaded in this context',
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
   * @throws whatever the task-control service rejects with, converted at the facade boundary into
   *   `self-development/core` (`details.code` keeps the original code).
   */
  private async open(taskId: string): Promise<SelfDevelopmentTaskController> {
    return this.ctx.selfDevelopmentTasks.open(taskId, this.clock())
  }

  /**
   * Check that a task journal exists before a read path opens it, so reading
   * an unknown task never creates its directory.
   * @param taskId - task identity.
   * @returns nothing once the journal directory exists.
   * @throws SelfDevelopmentRemoteError with `self-development/task-unknown` when the task has no
   *   journal directory.
   */
  private async assertTaskExists(taskId: string): Promise<void> {
    const directory = join(this.resolved.controlDirectory, 'tasks', taskId)
    try {
      await stat(directory)
    } catch {
      throw new SelfDevelopmentRemoteError(
        'self-development/task-unknown',
        `task ${JSON.stringify(taskId)} has no journal under the control directory`,
      )
    }
  }

  /**
   * Assemble the human-presence confirmation for one launch. The confirmation
   * time is one trusted-clock observation taken now; the plan digest comes
   * from the projection at the requested revision, and the acceptance digest
   * from the definition's bytes. A direct `runAttempt` always binds
   * `'supervised-not-unattended'`; a campaign round binds whichever literal
   * the caller passes — `'unattended-accepted'` for an `unattended: true`
   * campaign, `'supervised-not-unattended'` for an `unattended: false`
   * campaign's one automatic round — and every call derives a fresh
   * confirmation object, never a cached or reused one.
   * @param projection - the task projection at the requested revision.
   * @param request - the launch facts the confirmation binds.
   * @param acknowledgement - the literal this confirmation carries.
   * @returns the confirmation the runner binds to the real launch facts.
   * @throws the `self-development/core` failure with `details.code` `SELF_DEV_INVALID_STATE` when the
   *   task has no confirmed plan, or `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` when the acceptance
   *   definition cannot be read.
   */
  private async buildPresence(
    projection: TaskProjection,
    request: PresenceLaunchFacts,
    acknowledgement: PresenceAcknowledgement,
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
      acknowledgement,
      taskId: request.taskId,
      testPlanDigest: plan.digest,
      acceptanceDefinitionDigest: await acceptanceDefinitionDigest(request.acceptancePath),
      artifactPaths: sortedUnique(request.artifactPaths),
    }
  }

  /**
   * Run this process's one-time campaign-restart recovery exactly once,
   * memoized so concurrent callers await the same scan.
   * @returns nothing; resolves once every stored `running` campaign this
   *   process did not itself just create has been marked `stopped`.
   */
  private async ensureRestartScan(): Promise<void> {
    this.restartScan ??= stopRunningCampaignsAfterRestart(this.resolved.controlDirectory)
    await this.restartScan
  }

  /**
   * One campaign's full automatic lifecycle, from its first round to a
   * terminal status. Runs detached from the `startCampaign` call that started
   * it; every exit path finalizes the record before returning, so this
   * promise never needs a caller to react to its settlement.
   * @param taskId - task identity.
   * @param firstExpectedRevision - the revision `startCampaign` observed, bound to round one only.
   * @returns nothing; the campaign record is this method's only externally visible result.
   */
  private async runCampaignLoop(taskId: string, firstExpectedRevision: number): Promise<void> {
    let record = await readCampaign(this.resolved.controlDirectory, taskId)
    // startCampaign just wrote this exact record; only an external deletion
    // in that instant could make this undefined, a race this package's own
    // writers never trigger.
    /* v8 ignore next */
    if (record === undefined) return
    let expectedRevision = firstExpectedRevision
    while (this.runningCampaigns.has(taskId)) {
      // The core can reactively stop a task after a round settles — the
      // no-progress limit or the budget floor tripping inside the core's own
      // post-failure bookkeeping — without that round's own rejection ever
      // naming the stop: the round rejects with its ordinary failure code,
      // and only the *next* startAttempt would see the task is no longer
      // ready. Reading the live status here, before every round including
      // the first, is what actually catches that reactive stop instead of
      // retrying blind into it every time.
      const notReady = await this.checkTaskReadyForRound(taskId)
      if (notReady !== undefined) {
        // The `while` condition above already re-checks `runningCampaigns`
        // at the top of every iteration, so a concurrent stopCampaign that
        // finalized before this iteration began is already caught there.
        // This narrower guard defends only the window inside
        // checkTaskReadyForRound's own single await: a stopCampaign call
        // that reads the record, cancels through the runner, and finalizes
        // — several awaits of its own — entirely within that one await is
        // not a window this suite can force open deterministically without
        // mocking internal timing; the concurrent-finalize races this same
        // guard's sibling below (and finalizeCampaign's own) do close are
        // covered directly.
        /* v8 ignore next */
        if (!this.runningCampaigns.has(taskId)) return
        await this.finalizeCampaign(taskId, record, notReady)
        return
      }
      let outcome: RemoteRunAttemptOutcome
      try {
        outcome = await this.launchCampaignRound(taskId, expectedRevision, record)
      } catch (error: unknown) {
        // A concurrent stopCampaign may have already finalized this campaign
        // while the round above was in flight (that is exactly what settles
        // this rejection, on a stop). Once finalized, this loop must touch
        // neither the record nor the events stream again: the stale `record`
        // captured before the stop would otherwise overwrite the caller's
        // stop reason with a fabricated round outcome.
        if (!this.runningCampaigns.has(taskId)) return
        const classification = classifyCampaignFailure(error)
        if (!classification.consumedRound) {
          await this.finalizeCampaign(taskId, record, { status: classification.terminalStatus, reason: classification.reason })
          return
        }
        if (classification.terminalStatus === undefined) {
          // The only classification shape that can still be a round that
          // never reached the core: every terminal shape above already
          // named its own status, and a cancelled round (the other
          // `consumedRound: true` shape) cannot fire before `attempt/started`
          // commits — there is nothing in flight for `stopCampaign` to cancel
          // otherwise. The core's revision is the ground truth a rejection's
          // code cannot always be trusted to report on its own — see
          // `classifyCampaignFailure`'s doc comment for the three runner
          // codes this specifically exists to catch, and it equally catches
          // any rejection this function has never seen before.
          const revisionAfterRound = await this.currentRevision(taskId)
          if (revisionAfterRound === expectedRevision) {
            await this.finalizeCampaign(taskId, record, {
              status: 'failed',
              reason: `round did not reach the core: ${classification.reason}`,
            })
            return
          }
          record = await this.recordCampaignRound(taskId, record, { lastOutcome: classification.outcome })
          if (!record.unattended) {
            await this.finalizeCampaign(taskId, record, {
              status: 'stopped',
              reason: 'unattended is false; the automatic first round finished, further rounds require a manual runAttempt',
            })
            return
          }
          await this.delayBeforeNextRound()
          expectedRevision = revisionAfterRound
          continue
        }
        record = await this.recordCampaignRound(taskId, record, { lastOutcome: classification.outcome })
        await this.finalizeCampaign(taskId, record, { status: classification.terminalStatus, reason: classification.reason })
        return
      }
      if (!this.runningCampaigns.has(taskId)) return
      record = await this.recordCampaignRound(taskId, record, { lastAttemptId: outcome.attemptId, lastOutcome: 'passed' })
      await this.finalizeCampaign(taskId, record, { status: 'passed' })
      return
    }
  }

  /**
   * Launch one campaign round through the same runner path a direct
   * `runAttempt` uses. Every launch field derives from the task's stored
   * launch profile — a campaign takes no per-round field overrides — and the
   * presence confirmation derives from the campaign record with a fresh
   * clock observation and a fresh operation id. The acknowledgement is
   * `record.acknowledgement` verbatim: `'unattended-accepted'` for an
   * `unattended: true` campaign's every round, `'supervised-not-unattended'`
   * for an `unattended: false` campaign's one automatic round.
   * @param taskId - task identity.
   * @param expectedRevision - the revision this round is bound to.
   * @param record - the campaign record this round derives from.
   * @returns the wire-mapped outcome of a passing round.
   * @throws whatever the runner's `runAttempt` rejects with, verbatim —
   *   `classifyCampaignFailure` is the caller's classification of this rejection.
   */
  private async launchCampaignRound(
    taskId: string,
    expectedRevision: number,
    record: CampaignRecord,
  ): Promise<RemoteRunAttemptOutcome> {
    const profile = await readLaunchProfile(this.resolved.controlDirectory, taskId)
    const worktree = fromProfile(profile, 'worktree', 'startCampaign')
    const artifactPaths = sortedUnique(fromProfile(profile, 'artifactPaths', 'startCampaign'))
    const acceptancePath = fromProfile(profile, 'acceptancePath', 'startCampaign')
    const loopbackAllowlist = fromProfile(profile, 'loopbackAllowlist', 'startCampaign')
    const runner = this.requireRunner()
    const controller = await this.open(taskId)
    const presence = await this.buildPresence(
      controller.projection,
      { taskId, confirmedBy: record.acceptedBy, worktree, loopbackAllowlist, artifactPaths, acceptancePath },
      record.acknowledgement,
    )
    const operationId = this.operationId()
    const outcome = await runner.runAttempt({
      taskId,
      expectedRevision,
      operationId,
      worktree,
      artifactPaths,
      acceptancePath,
      presence,
    })
    return toWireOutcome(outcome, operationId, worktree)
  }

  /**
   * Persist one round's outcome onto a campaign record still `running`.
   * @param taskId - task identity.
   * @param record - the record before this round.
   * @param fields - the round's attempt id (when it produced one) and outcome; a round is recorded
   *   only once it is known to have actually started, so the outcome is always present.
   * @returns the updated, persisted record.
   */
  private async recordCampaignRound(
    taskId: string,
    record: CampaignRecord,
    fields: { readonly lastAttemptId?: string | undefined; readonly lastOutcome: Exclude<CampaignRecord['lastOutcome'], undefined> },
  ): Promise<CampaignRecord> {
    const updated: CampaignRecord = {
      ...record,
      rounds: record.rounds + 1,
      updatedAt: Date.now(),
      lastOutcome: fields.lastOutcome,
      ...(fields.lastAttemptId === undefined ? {} : { lastAttemptId: fields.lastAttemptId }),
    }
    return this.writeRecordInOrder(taskId, async () => {
      // A concurrent stopCampaign may have finalized this campaign between
      // the round's settlement and this write; its record is final, and this
      // round update must not revert it to `running`.
      if (!this.runningCampaigns.has(taskId)) return record
      await writeCampaign(this.resolved.controlDirectory, taskId, updated)
      return updated
    })
  }

  /**
   * Run one campaign record write after every earlier write for the same
   * task has settled, whatever their outcomes; see {@link recordWrites}.
   * @param taskId - task identity.
   * @param write - the write to run once its turn comes.
   * @returns the write's own result.
   */
  private writeRecordInOrder<T>(taskId: string, write: () => Promise<T>): Promise<T> {
    const previous = this.recordWrites.get(taskId) ?? Promise.resolve()
    const next = previous.then(write, write)
    this.recordWrites.set(taskId, next.then(() => undefined, () => undefined))
    return next
  }

  /**
   * End one campaign's loop for good: persist the terminal status and reason,
   * and emit the matching `campaign-passed`/`campaign-ended` event. Races
   * itself against a concurrent `stopCampaign`: only the caller that wins
   * `runningCampaigns.delete` writes and emits; every loser — synchronously
   * unable to interleave before the winner has published its in-flight
   * promise, since nothing awaits between the `delete` and that publish —
   * awaits that same promise and returns the winner's actual persisted
   * outcome, never a stale pre-finalization view of its own.
   * @param taskId - task identity.
   * @param record - the record immediately before finalization.
   * @param fields - the terminal status (never `running`) and, for a non-`passed` status, the one-line reason.
   * @returns the finalized record.
   */
  private async finalizeCampaign(
    taskId: string,
    record: CampaignRecord,
    fields: { readonly status: Exclude<CampaignStatus, 'running'>; readonly reason?: string | undefined },
  ): Promise<CampaignRecord> {
    if (!this.runningCampaigns.delete(taskId)) {
      const inFlight = this.finalizing.get(taskId)
      if (inFlight !== undefined) return inFlight
      // No in-flight finalization and this call still lost the delete race:
      // a previous finalization already completed and cleared itself before
      // this call ever reached here. The current persisted record is that
      // finalization's actual outcome.
      const current = await readCampaign(this.resolved.controlDirectory, taskId)
      // A completed finalization always leaves a record behind; only an
      // external deletion could make this undefined.
      /* v8 ignore next */
      return current ?? record
    }
    const finalize = (async (): Promise<CampaignRecord> => {
      const updated: CampaignRecord = {
        ...record,
        status: fields.status,
        updatedAt: Date.now(),
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
      }
      await this.writeRecordInOrder(taskId, () => writeCampaign(this.resolved.controlDirectory, taskId, updated))
      await this.emitCampaignEvent(taskId, fields.status)
      return updated
    })()
    this.finalizing.set(taskId, finalize)
    try {
      return await finalize
    } finally {
      this.finalizing.delete(taskId)
    }
  }

  /**
   * Emit the matching campaign-lifecycle Cordis event for a just-finalized
   * campaign.
   * @param taskId - task identity.
   * @param status - the campaign's terminal status.
   * @returns nothing; the events package folds the emitted event into the
   *   unified notification vocabulary.
   */
  private async emitCampaignEvent(taskId: string, status: Exclude<CampaignStatus, 'running'>): Promise<void> {
    const revision = await this.currentRevision(taskId)
    if (status === 'passed') {
      this.ctx.emit('self-development/campaign-passed', { taskId, revision })
      return
    }
    this.ctx.emit('self-development/campaign-ended', { taskId, status, revision })
  }

  /**
   * Read one task's current projection revision.
   * @param taskId - task identity.
   * @returns the controller's current revision.
   */
  private async currentRevision(taskId: string): Promise<number> {
    const controller = await this.open(taskId)
    return controller.projection.revision
  }

  /**
   * Wait `resolved.roundDelayMs` before the loop's next round. Depth-defense
   * only, after a round the revision check above did not already end the
   * campaign over: it slows a rapid string of genuinely-started-but-failing
   * rounds instead of firing them back to back, and does nothing to bound
   * their count on its own — `roundDelayMs: 0` (every test harness in this
   * package) makes it a no-op wait.
   * @returns nothing; resolves once the configured delay has elapsed.
   */
  private async delayBeforeNextRound(): Promise<void> {
    if (this.resolved.roundDelayMs === 0) return
    await new Promise<void>(resolve => setTimeout(resolve, this.resolved.roundDelayMs))
  }

  /**
   * Check the core's live status before this round launches. `status:
   * 'ready'` is the only status a round may start from; every other status
   * ends the campaign now, mapped from the closed-vocabulary `stopReason`
   * when the core itself stopped the task (`'no-progress'` and
   * `'budget-exhausted'` both mean the campaign is out of runway —
   * `'exhausted'`; `'cancelled'` and every other status — the core is
   * mid-attempt, awaiting trial, pre-ready, or handed off — mean `'stopped'`
   * with a reason naming what was actually observed).
   * @param taskId - task identity.
   * @returns the terminal fields to finalize with, or `undefined` when the
   *   status is `'ready'` and a round may launch.
   */
  private async checkTaskReadyForRound(taskId: string): Promise<{
    readonly status: Exclude<CampaignStatus, 'running' | 'passed'>
    readonly reason: string
  } | undefined> {
    const controller = await this.open(taskId)
    const { status, stopReason } = controller.projection
    if (status === 'ready') return undefined
    if (status === 'stopped') {
      const outOfRunway = stopReason === 'no-progress' || stopReason === 'budget-exhausted'
      return {
        status: outOfRunway ? 'exhausted' : 'stopped',
        reason: `core stopped the task: ${stopReason}`,
      }
    }
    return { status: 'stopped', reason: `task is no longer ready for a round (status: ${status})` }
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
 * A run-attempt request whose five launch fields are all present: the caller
 * supplied them, or the facade derived them from the task's launch profile.
 */
type ResolvedRunAttemptRequest = RemoteRunAttemptRequest & {
  /** Experiment worktree, explicit or derived. */
  readonly worktree: string
  /** Artifact paths the acceptance covers, explicit or derived. */
  readonly artifactPaths: readonly string[]
  /** Acceptance definition path, explicit or derived. */
  readonly acceptancePath: string
  /** Loopback ports the session may bind, explicit or derived. */
  readonly loopbackAllowlist: readonly number[]
  /** Launch confirmer, explicit or derived. */
  readonly confirmedBy: string
}

/**
 * The launch facts `buildPresence` binds into a `PresenceConfirmation`,
 * shared by a direct `runAttempt` (a {@link ResolvedRunAttemptRequest} already
 * carries every one of these fields) and a campaign round (derived fresh from
 * the task's launch profile each round).
 */
interface PresenceLaunchFacts {
  /** Task the confirmation covers. */
  readonly taskId: string
  /** Launch confirmer. */
  readonly confirmedBy: string
  /** Experiment worktree. */
  readonly worktree: string
  /** Loopback ports the session may bind. */
  readonly loopbackAllowlist: readonly number[]
  /** Artifact paths the acceptance covers. */
  readonly artifactPaths: readonly string[]
  /** Acceptance definition path. */
  readonly acceptancePath: string
}

/**
 * How one campaign round's failure resolves the loop, classified from
 * whatever `launchCampaignRound` rejected with. A discriminated union on
 * `consumedRound`: a round that never started carries no outcome to record,
 * and one that did always carries one — never both `undefined` at once, so
 * `recordCampaignRound` never has to tolerate a missing outcome.
 */
type CampaignFailureClassification =
  | {
    /**
     * `false`: the core never committed `attempt/started`, so no budget was
     * consumed — `SELF_DEV_BUDGET_EXHAUSTED`, `SELF_DEV_INVALID_STATE`,
     * `SELF_DEV_RUNNER_ATTEMPT_ACTIVE`, `SELF_DEV_RUNNER_ACCEPTANCE_INVALID`,
     * `SELF_DEV_RUNNER_PRESENCE_MISMATCH`, and `SELF_DEV_RUNNER_LAUNCH_MISMATCH`
     * are the recognized rejections where that happens (all six fire, at
     * every one of their throw sites in the runner package, before the core
     * commits anything — verified by reading every call site, not assumed
     * from the code name; see the deliberate omissions noted on
     * `runCampaignLoop`'s catch block), and an unrecognized exception is
     * treated the same way, conservatively, since this function cannot
     * otherwise tell.
     */
    readonly consumedRound: false
    /**
     * The campaign always ends now: `exhausted` for a refused start over
     * budget, `stopped` for a refused start the core rejected for any other
     * reason (including a status the live-status check ahead of this round
     * should already have caught — this is the fallback if it did not),
     * `failed` for an unrecognized crash.
     */
    readonly terminalStatus: 'exhausted' | 'stopped' | 'failed'
    /** One-line reason recorded on the terminal record. */
    readonly reason: string
  }
  | {
    /** `true`: the round started and so consumed one unit of budget. */
    readonly consumedRound: true
    /** The round outcome to record. */
    readonly outcome: Exclude<CampaignRecord['lastOutcome'], 'passed' | undefined>
    /** `'stopped'` for a cancelled round; `undefined` for every other failure, retried or stopped per `unattended`. */
    readonly terminalStatus: 'stopped' | undefined
    /** One-line reason recorded when this round's failure does end the campaign. */
    readonly reason: string
  }

/**
 * Classify one campaign round's rejection. A recognized core or runner error
 * other than the codes named below is an ordinary round failure the loop
 * retries (when `unattended`) exactly like a human retrying a failed
 * `runAttempt` — `runCampaignLoop`'s own revision comparison, not this
 * function, is what actually catches an ordinary-looking rejection that
 * never reached the core (see its catch block); the core's own
 * `noProgressAttemptLimit` is what eventually turns a persistently broken
 * *started* round into a reactive stop, which the live status check ahead of
 * the next round is what actually catches (see `checkTaskReadyForRound`).
 * `SELF_DEV_INVALID_STATE` and `SELF_DEV_RUNNER_ATTEMPT_ACTIVE` end the
 * campaign here too, as a second, narrower net for the race that check
 * cannot close — status flipping, or another in-flight attempt claiming the
 * runner's own per-task slot, in the gap between that check and this round's
 * own `runAttempt` call. `SELF_DEV_RUNNER_ACCEPTANCE_INVALID`,
 * `SELF_DEV_RUNNER_PRESENCE_MISMATCH`, and `SELF_DEV_RUNNER_LAUNCH_MISMATCH`
 * end it as `failed` — a launch-configuration problem a retry cannot route
 * around, not a task-lifecycle stop. Three sibling runner codes —
 * `SELF_DEV_RUNNER_CONFIG_INVALID`, `SELF_DEV_RUNNER_WORKTREE_INVALID`, and
 * `SELF_DEV_RUNNER_BUDGET_INVALID` — are deliberately *not* classified here
 * even though each also has a pre-`attempt/started` throw site, because each
 * also has at least one throw site reachable only after `attempt/started`
 * commits (worktree/artifact digesting during the executor's own post-run
 * content-stability check, a platform check inside process-group creation,
 * and phase/deadline budget checks during phase execution, respectively) —
 * classifying them here by code alone would misreport a real, budget-consuming
 * attempt that happened to fail with one of these codes as one that never
 * reached the core. `runCampaignLoop`'s revision comparison is what correctly
 * tells the two apart for these three, from the observed fact rather than
 * the code. An exception this function does not recognize at all is treated
 * as a crash: terminal, never retried, and its message is never swallowed.
 * @param error - whatever `launchCampaignRound` rejected with.
 * @returns the classification driving `runCampaignLoop`'s next step.
 */
function classifyCampaignFailure(error: unknown): CampaignFailureClassification {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof SelfDevelopmentError || error instanceof SelfDevelopmentRunnerError) {
    if (error.code === 'SELF_DEV_BUDGET_EXHAUSTED') {
      return { consumedRound: false, terminalStatus: 'exhausted', reason: message }
    }
    if (error.code === 'SELF_DEV_INVALID_STATE' || error.code === 'SELF_DEV_RUNNER_ATTEMPT_ACTIVE') {
      return { consumedRound: false, terminalStatus: 'stopped', reason: message }
    }
    if (
      error.code === 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID'
      || error.code === 'SELF_DEV_RUNNER_PRESENCE_MISMATCH'
      || error.code === 'SELF_DEV_RUNNER_LAUNCH_MISMATCH'
    ) {
      return { consumedRound: false, terminalStatus: 'failed', reason: message }
    }
    if (error.code === 'SELF_DEV_ATTEMPT_CANCELLED') {
      return { consumedRound: true, outcome: 'cancelled', terminalStatus: 'stopped', reason: message }
    }
    const outcome = error.code === 'SELF_DEV_LATE_RESULT' ? 'late' : 'failed'
    return { consumedRound: true, outcome, terminalStatus: undefined, reason: message }
  }
  // Not a recognized core or runner error at all: a crash, not a round
  // outcome. `consumedRound: false` leaves `rounds` and `lastOutcome`
  // untouched — this function cannot tell whether the core ever committed
  // `attempt/started` — and `terminalStatus` ends the loop immediately.
  return { consumedRound: false, terminalStatus: 'failed', reason: message }
}

/**
 * Digest the raw bytes of the acceptance definition for the presence binding.
 * @param path - absolute path of the acceptance definition.
 * @returns the lowercase sha-256 hex digest of the file bytes.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` when the file cannot
 *   be read, matching the code the runner rejects an unusable definition with; the facade boundary
 *   converts it into `self-development/core`.
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
 * Read one launch field of a task's stored profile.
 * @param profile - the stored profile, or `undefined` when the task has none.
 * @param field - the launch field the request omitted.
 * @returns the profile's value for the field.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` naming the field when
 *   no profile exists to derive it from.
 */
function fromProfile<K extends 'worktree' | 'artifactPaths' | 'acceptancePath' | 'loopbackAllowlist' | 'confirmedBy'>(
  profile: LaunchProfile | undefined,
  field: K,
  context: 'runAttempt' | 'startCampaign' = 'runAttempt',
): LaunchProfile[K] {
  const value = profile?.[field]
  if (value === undefined) {
    throw new SelfDevelopmentRemoteError(
      'self-development/config-invalid',
      `${context}.${field} is missing and the task has no launch profile`,
    )
  }
  return value
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
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when the control directory
 *   is not an absolute path, `maxConcurrentCampaigns` is not a positive finite integer, or
 *   `roundDelayMs` is not a non-negative finite integer.
 */
function validateConfig(config: RemoteConfig): RemoteConfig {
  const invalid = (detail: string): SelfDevelopmentRemoteError =>
    new SelfDevelopmentRemoteError('self-development/config-invalid', `self-development remote config is invalid: ${detail}`)
  if (config.controlDirectory.length === 0 || !isAbsolute(config.controlDirectory)) {
    throw invalid(`controlDirectory ${JSON.stringify(config.controlDirectory)} must be an absolute path`)
  }
  if (!Number.isInteger(config.maxConcurrentCampaigns) || config.maxConcurrentCampaigns < 1) {
    throw invalid(`maxConcurrentCampaigns must be a positive finite integer, got ${String(config.maxConcurrentCampaigns)}`)
  }
  if (!Number.isInteger(config.roundDelayMs) || config.roundDelayMs < 0) {
    throw invalid(`roundDelayMs must be a non-negative finite integer, got ${String(config.roundDelayMs)}`)
  }
  return config
}
