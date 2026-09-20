/**
 * The merge orchestration: a "nothing to merge" pre-check, one approval,
 * `recordTrialApproval`, then `workspaces.integrate` with a `verify` built
 * from the runner's acceptance check plus the configured integration gates,
 * and a `snapshot` request so a dirty task worktree (an experimental agent's
 * uncommitted work) is committed before rebase instead of discarded.
 * `integrated` triggers the configured upgrade; `conflict`/`verification-failed`
 * auto-starts a repair campaign under the same approval, naming the
 * conflicted files or the verification reason; `failed` only reports.
 */

import { readFile } from 'node:fs/promises'
import { acceptancePath, parseAcceptanceDefinition } from './acceptance.ts'
import { runGit } from './baseline.ts'
import { mergeApprovalReason } from './card.ts'
import type { ResolvedChatConfig } from './config.ts'
import { errorOf } from './errors.ts'
import { buildVerify } from './gates.ts'
import type { GateDeps } from './gates.ts'
import { runPropose } from './propose.ts'
import type { ProposeDeps } from './propose.ts'
import { runUpgrade } from './upgrade.ts'
import type { UpgradeDeps } from './upgrade.ts'
import type {
  AcceptanceDefinition,
  ApprovalPort,
  FacadeOperationResult,
  IntegrationResult,
  MergeBlockedEventPayload,
  MergeInput,
  MergeIntegratedEventPayload,
  MergeOutcome,
  MergeStep,
  ProposeInput,
  ProposeOutcome,
  RunnerVerifyPort,
  SelfDevelopmentRemoteFacade,
  TaskDetailView,
  WorkspacesPort,
} from './types.ts'

/** The facade task status `self_development_merge` requires, absent an explicit `taskId`. */
const AWAITING_TRIAL_STATUS = 'awaiting-trial'

/** Modification scope handed to an auto-started repair campaign: the repair fixes the same change, not a bounded new one. */
const REPAIR_MODIFICATION_SCOPE = ['**']

/** Everything one merge run needs; every port is test-replaceable. */
export interface MergeDeps {
  /** The stable-side Remote facade (DH-a wire forms), also reused for the repair campaign's `propose`. */
  readonly facade: SelfDevelopmentRemoteFacade
  /** The approval service; `undefined` fails the merge closed before any facade call. */
  readonly approval: ApprovalPort | undefined
  /** The workspaces service; `undefined` fails the merge closed — `integrate` has no fallback. */
  readonly workspaces: WorkspacesPort | undefined
  /**
   * The runner verification port; `undefined` fails the merge closed —
   * merging to stable without independent acceptance verification is not offered.
   */
  readonly runner: RunnerVerifyPort | undefined
  /** Resolved deployment configuration. */
  readonly config: ResolvedChatConfig
  /** The agent on whose behalf the approval card is shown; absent outside a live tool execution. */
  readonly agent?: unknown
  /** The tool call the approval card attaches to. */
  readonly callId?: unknown
  /** Cancellation lifetime of the approval card. */
  readonly signal?: AbortSignal
  /** Task ids this service started, most recent last — searched in reverse for the default `awaiting-trial` task. */
  readonly knownTaskIds: readonly string[]
  /** Task id suffix override for a repair campaign's deterministic tests; defaults to random. */
  readonly taskIdSuffix?: string
  /** Emit the `self-development-chat/merge-integrated` Cordis event; `undefined` skips it (the chat result does not depend on it). */
  readonly emitIntegrated?: (payload: MergeIntegratedEventPayload) => void
  /** Emit the `self-development-chat/merge-blocked` Cordis event; `undefined` skips it. */
  readonly emitBlocked?: (payload: MergeBlockedEventPayload) => void
  /** Injectable shell runner for the integration gates, replaceable by direct unit tests. */
  readonly gateDeps?: GateDeps
  /** Injectable upgrade side effects, replaceable by direct unit tests. */
  readonly upgradeDeps?: UpgradeDeps
  /** Git runner used for the "nothing to merge" pre-check; defaults to `baseline.ts`'s `runGit`. */
  readonly git?: (args: readonly string[], cwd: string) => Promise<string>
}

/** `resolveTaskId`'s outcome: the task to merge and its current detail, or why none could be resolved. */
type ResolvedTaskId =
  | { readonly ok: true; readonly taskId: string; readonly detail: TaskDetailView }
  | { readonly ok: false; readonly reason: string }

/**
 * Resolve the task to merge: the given `taskId` (rejected unless it is
 * `awaiting-trial`), or, when omitted, the most recently proposed task from
 * `knownTaskIds` that is `awaiting-trial`.
 */
async function resolveTaskId(deps: MergeDeps, requestedTaskId: string | undefined): Promise<ResolvedTaskId> {
  if (requestedTaskId !== undefined) {
    let detail: TaskDetailView
    try {
      detail = await deps.facade.getTask(requestedTaskId)
    } catch (error: unknown) {
      return { ok: false, reason: `task ${requestedTaskId} lookup failed: ${(error as Error).message}` }
    }
    if (detail.projection.status !== AWAITING_TRIAL_STATUS) {
      return { ok: false, reason: `task ${requestedTaskId} is not awaiting-trial (status: ${detail.projection.status})` }
    }
    return { ok: true, taskId: requestedTaskId, detail }
  }
  for (let index = deps.knownTaskIds.length - 1; index >= 0; index--) {
    const candidateId = deps.knownTaskIds[index]
    if (candidateId === undefined) continue
    // Sequential by design: searching most-recent-first stops at the first match.
    const detail = await deps.facade.getTask(candidateId).catch(() => undefined)
    if (detail?.projection.status === AWAITING_TRIAL_STATUS) {
      return { ok: true, taskId: candidateId, detail }
    }
  }
  return { ok: false, reason: 'no awaiting-trial task found; pass taskId explicitly, or propose and let a campaign pass first' }
}

/**
 * Whether the task's worktree has nothing new to bring to `targetBranch`: no
 * uncommitted changes (so there is nothing a `snapshot` commit would save
 * either) and its branch HEAD already equals `targetBranch`'s own tip. A
 * courtesy pre-check, like `parallel: false`'s own: task worktrees share the
 * stable repository's object store and refs (the same assumption `verify`
 * and the eight-step sequence's baseline digest already rely on), so
 * `targetBranch` resolves from inside the task worktree too. Any failure —
 * no launch profile yet, an unreadable worktree, an unresolvable branch —
 * fails open into the normal merge attempt rather than blocking it.
 * @param git - the injectable git runner.
 * @param worktree - the task's worktree path, when a launch profile set one.
 * @param targetBranch - the configured merge target branch.
 * @returns `true` only when the worktree is clean and already at the target tip.
 */
async function hasNothingToMerge(
  git: (args: readonly string[], cwd: string) => Promise<string>,
  worktree: string | undefined,
  targetBranch: string,
): Promise<boolean> {
  if (worktree === undefined) return false
  try {
    const status = await git(['status', '--porcelain'], worktree)
    if (status !== '') return false
    const [head, targetTip] = await Promise.all([
      git(['rev-parse', 'HEAD'], worktree),
      git(['rev-parse', targetBranch], worktree),
    ])
    return head === targetTip
  } catch {
    return false
  }
}

/** Cap on the requirement-derived portion of {@link snapshotMessage}. */
const SNAPSHOT_MESSAGE_REQUIREMENT_MAX_LENGTH = 72

/**
 * Build the snapshot commit message: `selfdev(<taskId>): <requirement's
 * first line, capped at 72 characters>`, or just `selfdev(<taskId>)` when
 * the task's requirement was not readable from its projection.
 * @param taskId - the task being merged.
 * @param requirement - the task's requirement, when its projection carried a spec.
 * @returns the one-line commit message.
 */
function snapshotMessage(taskId: string, requirement: string | undefined): string {
  if (requirement === undefined) return `selfdev(${taskId})`
  // `String.prototype.split` always returns at least one element, even for
  // '' (['']), so index 0 is never actually undefined here.
  /* v8 ignore next -- see above; noUncheckedIndexedAccess cannot see the length guarantee. */
  const firstLine = requirement.split('\n')[0] ?? ''
  const capped = firstLine.length > SNAPSHOT_MESSAGE_REQUIREMENT_MAX_LENGTH
    ? firstLine.slice(0, SNAPSHOT_MESSAGE_REQUIREMENT_MAX_LENGTH)
    : firstLine
  return `selfdev(${taskId}): ${capped}`
}

/** The two {@link IntegrationResult} statuses that auto-start a repair campaign. */
type RepairableResult = Extract<IntegrationResult, { readonly status: 'conflict' | 'verification-failed' }>

/**
 * Build the requirement text for an auto-started repair campaign, naming
 * what the user needs from the plan's own frozen interface: the target tip
 * and the conflicted files for `conflict`, or the verification reason for
 * `verification-failed`. The parameter type is narrowed to exactly the two
 * repairable statuses (not the full `IntegrationResult`), so a future status
 * this function does not yet handle fails to compile here instead of
 * silently mis-describing itself.
 */
function repairRequirement(config: ResolvedChatConfig, result: RepairableResult): string {
  if (result.status === 'conflict') {
    return `Rebase onto ${config.targetBranch} and resolve the conflicts in ${result.files.join(', ')}, keeping the original acceptance definition passing.`
  }
  return `Fix the acceptance failure on the new baseline: ${result.reason}`
}

/**
 * Start the automatic repair campaign for a blocked merge: the same
 * acceptance definition already written for the blocked task (read back
 * verbatim and forwarded as text — `parseAcceptanceDefinition` accepts a
 * JSON string, see `acceptance.ts`), a plan derived straight from that
 * definition's own cases and assertions (so it trivially satisfies
 * `assertPlanCoveredByDefinition`), unattended, `unlimited` budget, and no
 * second approval — the merge card already named this consequence.
 */
async function startRepairCampaign(deps: MergeDeps, blockedTaskId: string, result: RepairableResult): Promise<ProposeOutcome> {
  const definitionPath = acceptancePath(deps.config.controlDirectory, blockedTaskId)
  let definitionText: string
  try {
    definitionText = await readFile(definitionPath, 'utf8')
  } catch (error: unknown) {
    return { ok: false, steps: [], reason: `could not read the acceptance definition to repair: ${(error as Error).message}` }
  }
  let definition: AcceptanceDefinition
  try {
    definition = parseAcceptanceDefinition(definitionText)
  } catch (error: unknown) {
    return { ok: false, steps: [], reason: `the written acceptance definition is no longer valid: ${(error as Error).message}` }
  }
  const repairInput: ProposeInput = {
    requirement: repairRequirement(deps.config, result),
    allowedModificationScope: REPAIR_MODIFICATION_SCOPE,
    plan: {
      requiredCases: definition.cases.map(acceptanceCase => ({
        caseId: acceptanceCase.caseId,
        requirement: `repair coverage for case ${acceptanceCase.caseId}`,
        assertionIds: acceptanceCase.assertions.map(assertion => assertion.assertionId),
      })),
      manualCases: [],
    },
    acceptance: definitionText,
    budget: { preset: 'unlimited' },
    unattended: true,
    parallel: true,
  }
  const repairDeps: ProposeDeps = {
    facade: deps.facade,
    approval: deps.approval,
    workspaces: deps.workspaces,
    config: deps.config,
    ...(deps.agent === undefined ? {} : { agent: deps.agent }),
    ...(deps.callId === undefined ? {} : { callId: deps.callId }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    knownTaskIds: [...deps.knownTaskIds, blockedTaskId],
    ...(deps.taskIdSuffix === undefined ? {} : { taskIdSuffix: deps.taskIdSuffix }),
    skipApprovalDetail: `covered by the merge approval card for task ${blockedTaskId}`,
  }
  return runPropose(repairDeps, repairInput)
}

/**
 * Emit the merge-result Cordis event, when an emitter is configured. Names
 * `self-development-chat/merge-integrated` and
 * `self-development-chat/merge-blocked`, declared by this package's own
 * `declare module '@deepseek-ai/cordis'` augmentation (`index.ts`) — `index.ts`
 * also fans each payload out to the upstream `self-development/merge-integrated`/
 * `self-development/merge-blocked` events `@deepseek-ai/dsh-workflow-self-development-events`
 * actually subscribes to, which is why `revision` (the task projection
 * revision `recordTrialApproval` observed) rides along on every payload here
 * even though this package's own event names do not otherwise need it.
 * @param deps - the merge run's deps, for the two optional emit hooks.
 * @param taskId - the merged (or blocked) task id.
 * @param result - the settled `workspaces.integrate` outcome.
 * @param revision - the task projection revision `recordTrialApproval` returned.
 */
function emitMergeEvent(deps: MergeDeps, taskId: string, result: IntegrationResult, revision: number): void {
  const occurredAt = Date.now()
  const snapshotCommit = result.snapshotCommit
  if (result.status === 'integrated') {
    deps.emitIntegrated?.({
      taskId,
      commit: result.commit,
      baseMoved: result.baseMoved,
      occurredAt,
      revision,
      ...(snapshotCommit === undefined ? {} : { snapshotCommit }),
    })
    return
  }
  if (result.status === 'conflict') {
    deps.emitBlocked?.({ taskId, status: result.status, files: result.files, occurredAt, revision })
    return
  }
  deps.emitBlocked?.({ taskId, status: result.status, reason: result.reason, occurredAt, revision })
}

/**
 * Run one merge end to end: resolve the task, show the single approval card,
 * record trial approval, integrate with a runner-plus-gates `verify`, then
 * react to the result — upgrade on `integrated`, an unattended repair
 * campaign on `conflict`/`verification-failed`, or just a report on `failed`.
 * Nothing is rolled back on failure: whatever the facade or workspaces
 * service already committed stays for triage, matching `runPropose`.
 * @param deps - the ports and configuration for this run.
 * @param input - the tool input.
 * @returns the merge outcome.
 */
export async function runMerge(deps: MergeDeps, input: MergeInput): Promise<MergeOutcome> {
  const steps: MergeStep[] = []
  const config = deps.config

  const resolved = await resolveTaskId(deps, input.taskId)
  if (!resolved.ok) {
    return { ok: false, steps, reason: resolved.reason }
  }
  const { taskId, detail } = resolved

  const nothingToMerge = await hasNothingToMerge(deps.git ?? runGit, detail.card.launchProfile?.worktree, config.targetBranch)
  if (nothingToMerge) {
    return { ok: false, taskId, steps, reason: 'nothing to merge' }
  }

  if (deps.runner === undefined) {
    return { ok: false, taskId, steps, reason: 'selfDevelopmentRunner is not mounted; acceptance cannot be independently verified before merging to stable' }
  }
  if (deps.workspaces === undefined) {
    return { ok: false, taskId, steps, reason: 'workspaces service is not mounted; self_development_merge needs its integrate() method' }
  }
  if (deps.approval === undefined) {
    return { ok: false, taskId, steps, reason: 'approval service is not mounted; the merge fails closed' }
  }

  const reason = mergeApprovalReason({
    taskId,
    requirement: detail.projection.spec?.requirement,
    targetBranch: config.targetBranch,
  }, config.cardLocale)
  const approvalOutcome = await deps.approval.request({
    agent: deps.agent,
    toolName: 'self_development_merge',
    reason,
    ...(deps.callId === undefined ? {} : { callId: deps.callId }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  })
  if (approvalOutcome !== 'allowed-once') {
    return { ok: false, taskId, steps, reason: `approval outcome was ${approvalOutcome}; nothing was merged` }
  }
  steps.push({ step: 'approval', detail: `allowed-once by ${config.actor}` })

  let recordResult: FacadeOperationResult
  try {
    recordResult = await deps.facade.recordTrialApproval(taskId, detail.projection.revision, config.actor)
    steps.push({ step: 'recordTrialApproval', detail: `approved by ${config.actor}` })
  } catch (error: unknown) {
    return { ok: false, taskId, steps, reason: 'recordTrialApproval failed', error: errorOf(error) }
  }

  const verify = buildVerify(deps.runner, config, taskId, deps.gateDeps)
  const snapshot = {
    message: snapshotMessage(taskId, detail.projection.spec?.requirement),
    author: config.commitIdentity,
  }
  let result: IntegrationResult
  try {
    result = await deps.workspaces.integrate({ taskId, targetBranch: config.targetBranch, actor: config.actor, verify, snapshot })
    steps.push({ step: 'integrate', detail: result.status })
  } catch (error: unknown) {
    return { ok: false, taskId, steps, reason: 'integrate failed', error: errorOf(error) }
  }

  emitMergeEvent(deps, taskId, result, recordResult.revision)

  if (result.status === 'integrated') {
    if (config.upgrade.kind === 'none') {
      return { ok: true, taskId, steps, result }
    }
    const upgrade = await runUpgrade(config.upgrade, config.targetBranch, taskId, deps.upgradeDeps)
    steps.push({ step: 'upgrade', detail: upgrade.detail })
    return { ok: true, taskId, steps, result, upgrade }
  }

  if (result.status === 'conflict' || result.status === 'verification-failed') {
    const repair = await startRepairCampaign(deps, taskId, result)
    steps.push({ step: 'repair', detail: repair.ok ? `started task ${repair.taskId}` : repair.reason })
    return { ok: true, taskId, steps, result, repair }
  }

  return { ok: true, taskId, steps, result }
}
