/** The proposal orchestration: one approval, then workspace, acceptance, and the eight facade steps. */

import { join } from 'node:path'
import {
  assertPlanCoveredByDefinition,
  acceptancePath,
  directoryExists,
  parseAcceptanceDefinition,
  writeAcceptanceDefinition,
} from './acceptance.ts'
import { approvalReason } from './card.ts'
import { budgetViolation, toBudgetApproval } from './budget.ts'
import { deriveTaskId, readBaselineDigest } from './baseline.ts'
import { errorOf } from './errors.ts'
import type { ResolvedChatConfig } from './config.ts'
import type {
  ApprovalPort,
  CampaignState,
  FacadeOperationResult,
  ProposeError,
  ProposeInput,
  ProposeOutcome,
  ProposeStep,
  ResolvedProposeInput,
  SelfDevelopmentRemoteFacade,
  WorkspacesPort,
} from './types.ts'

/**
 * Apply the deployment defaults to the fields a proposal may omit: the budget
 * and the unattended choice fall back to the deployment config; `parallel`
 * has no per-deployment default and falls back to `true` (parallel campaigns
 * allowed), matching the 2026-09-20 DH wave decision.
 * @param input - the raw tool input.
 * @param config - the resolved deployment configuration.
 * @returns the input with every optional field filled.
 */
export function resolveProposeInput(input: ProposeInput, config: ResolvedChatConfig): ResolvedProposeInput {
  return {
    ...input,
    budget: input.budget ?? config.defaultBudget,
    unattended: input.unattended ?? config.defaultUnattended,
    parallel: input.parallel ?? true,
  }
}

/** Everything one proposal run needs; every port is test-replaceable. */
export interface ProposeDeps {
  /** The stable-side Remote facade (DH-a wire forms). */
  readonly facade: SelfDevelopmentRemoteFacade
  /** The approval service; `undefined` fails the proposal closed before any facade call. */
  readonly approval: ApprovalPort | undefined
  /** The workspaces service; `undefined` falls back to a pre-allocated directory under the experiments root. */
  readonly workspaces: WorkspacesPort | undefined
  /** Resolved deployment configuration. */
  readonly config: ResolvedChatConfig
  /** The agent on whose behalf the approval card is shown; absent outside a live tool execution. */
  readonly agent?: unknown
  /** The tool call the approval card attaches to. */
  readonly callId?: unknown
  /** Cancellation lifetime of the approval card. */
  readonly signal?: AbortSignal
  /** Task ids this service started, checked against running campaigns for `parallel: false`. */
  readonly knownTaskIds: readonly string[]
  /** Task id suffix override for deterministic tests; defaults to random. */
  readonly taskIdSuffix?: string
}

/**
 * Validate the tool input before anything is asked or written. Runs after
 * {@link resolveProposeInput}, so `budget`, `unattended`, and `parallel` are
 * always present.
 * @param input - the tool input with every default applied.
 * @returns the first violated rule as a reason, or `undefined` when the input is valid.
 */
export function proposeInputViolation(input: ResolvedProposeInput): string | undefined {
  if (typeof input.requirement !== 'string' || input.requirement.trim().length === 0) {
    return 'requirement must be a non-empty string'
  }
  if (!Array.isArray(input.allowedModificationScope) || input.allowedModificationScope.length === 0) {
    return 'allowedModificationScope must be a non-empty array of paths'
  }
  if (!Array.isArray(input.plan.requiredCases) || input.plan.requiredCases.length === 0) {
    return 'plan.requiredCases must be a non-empty array'
  }
  const budget = budgetViolation(input.budget)
  if (budget !== undefined) return budget
  try {
    const definition = parseAcceptanceDefinition(input.acceptance)
    assertPlanCoveredByDefinition(definition, input.plan.requiredCases)
  } catch (error: unknown) {
    return (error as Error).message
  }
  return undefined
}

/**
 * Run one proposal: validate, check the parallel choice, ask for the single
 * approval, then allocate the workspace, write the acceptance definition, and
 * drive the facade through createTask, authorizePlanning, submitPlanDraft,
 * confirmPlan, approveBudget, and startCampaign. Every completed step is
 * recorded; a failure stops the sequence and returns the steps done so far
 * plus the failure reason. Nothing is rolled back: written records and the
 * worktree stay for triage.
 * @param deps - the ports and configuration for this run.
 * @param rawInput - the tool input, before the deployment defaults are applied.
 * @returns the proposal outcome.
 */
export async function runPropose(deps: ProposeDeps, rawInput: ProposeInput): Promise<ProposeOutcome> {
  const input = resolveProposeInput(rawInput, deps.config)
  const inputViolation = proposeInputViolation(input)
  if (inputViolation !== undefined) {
    return { ok: false, steps: [], reason: inputViolation }
  }
  const steps: ProposeStep[] = []
  const config = deps.config
  const taskId = deriveTaskId(input.requirement, deps.taskIdSuffix)

  if (!input.parallel) {
    for (const knownTaskId of deps.knownTaskIds) {
      const campaign = await deps.facade.campaign(knownTaskId).catch(() => undefined)
      if (campaign?.status === 'running') {
        return {
          ok: false,
          steps,
          reason: `parallel is false and task ${knownTaskId} has a running campaign; stop it or pass parallel: true`,
        }
      }
    }
  }

  if (deps.approval === undefined) {
    return { ok: false, steps, reason: 'approval service is not mounted; the proposal fails closed' }
  }
  const reason = approvalReason(input, {
    taskId,
    experimentsRoot: config.experimentsRoot,
    acceptancePath: acceptancePath(config.controlDirectory, taskId),
  }, config.cardLocale)
  const outcome = await deps.approval.request({
    agent: deps.agent,
    toolName: 'self_development_propose',
    reason,
    ...(deps.callId === undefined ? {} : { callId: deps.callId }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  })
  if (outcome !== 'allowed-once') {
    return { ok: false, steps, reason: `approval outcome was ${outcome}; nothing was started` }
  }
  steps.push({ step: 'approval', detail: `allowed-once by ${config.actor}` })

  const workspace = await allocateWorkspace(deps, taskId, steps)
  if (!workspace.ok) {
    return {
      ok: false,
      taskId,
      steps,
      reason: 'workspace allocation failed',
      error: workspace.error,
    }
  }

  let baselineDigest: string
  try {
    baselineDigest = await readBaselineDigest(config.stableRepo)
    steps.push({ step: 'baseline', detail: baselineDigest })
  } catch (error: unknown) {
    return fail(steps, taskId, { message: (error as Error).message })
  }

  let acceptance: string
  try {
    acceptance = await writeAcceptanceDefinition(config.controlDirectory, taskId, parseAcceptanceDefinition(input.acceptance))
    steps.push({ step: 'acceptance', detail: acceptance })
  } catch (error: unknown) {
    return fail(steps, taskId, { message: (error as Error).message })
  }

  const facadeSteps = await runFacadeSteps(deps, input, taskId, {
    worktree: workspace.worktree,
    dataHome: workspace.dataHome,
    baselineDigest,
    acceptancePath: acceptance,
  }, steps)
  if (!facadeSteps.ok) {
    return {
      ok: false,
      taskId,
      steps,
      reason: `facade step ${facadeSteps.error.step} failed`,
      error: facadeSteps.error.error,
    }
  }
  return {
    ok: true,
    taskId,
    workspace: workspace.worktree,
    baselineDigest,
    steps,
    campaign: facadeSteps.campaign,
  }
}

/** Build a failure outcome directly. */
function fail(steps: ProposeStep[], taskId: string, error: ProposeError): ProposeOutcome {
  return { ok: false, taskId, steps, reason: error.message, error }
}

/** Result of the facade steps: the failed step, or the started campaign. */
type FacadeStepsOutcome =
  | { readonly ok: false; readonly error: FacadeStepError }
  | { readonly ok: true; readonly campaign: CampaignState }

/** One facade step that failed, with its normalized error. */
interface FacadeStepError {
  readonly step: string
  readonly error: ProposeError
}

/** Workspace resolution outcome: the allocated paths, or the failure that stopped the proposal. */
type WorkspaceOutcome =
  | { readonly ok: true; readonly worktree: string; readonly dataHome?: string | undefined }
  | { readonly ok: false; readonly error: ProposeError }

/**
 * Resolve the workspace for one task, recording the step. With a workspaces
 * service the allocation carries a per-attempt `dataHome`; without one the
 * pre-allocated directory `<experimentsRoot>/<taskId>` is used as-is, and a
 * missing directory fails the proposal.
 */
async function allocateWorkspace(deps: ProposeDeps, taskId: string, steps: ProposeStep[]): Promise<WorkspaceOutcome> {
  if (deps.workspaces !== undefined) {
    try {
      // TaskWorkspaceView.dataHome is a required field: an allocated
      // workspace always has one, unlike the pre-allocated fallback below.
      const workspace = await deps.workspaces.allocate({ taskId, projectRoot: deps.config.stableRepo })
      steps.push({ step: 'workspace', detail: workspace.worktree })
      return { ok: true, worktree: workspace.worktree, dataHome: workspace.dataHome }
    } catch (error: unknown) {
      steps.push({ step: 'workspace', detail: (error as Error).message })
      return { ok: false, error: errorOf(error) }
    }
  }
  const fallback = join(deps.config.experimentsRoot, taskId)
  if (!(await directoryExists(fallback))) {
    steps.push({ step: 'workspace', detail: `${fallback} does not exist` })
    return { ok: false, error: { message: `no workspaces service is mounted and ${fallback} does not exist` } }
  }
  steps.push({ step: 'workspace', detail: fallback })
  return { ok: true, worktree: fallback }
}

/** Drive the six facade steps after the workspace and acceptance are in place. */
async function runFacadeSteps(
  deps: ProposeDeps,
  input: ResolvedProposeInput,
  taskId: string,
  prepared: {
    readonly worktree: string
    readonly dataHome?: string | undefined
    readonly baselineDigest: string
    readonly acceptancePath: string
  },
  steps: ProposeStep[],
): Promise<FacadeStepsOutcome> {
  const config = deps.config
  const launchProfile = {
    worktree: prepared.worktree,
    acceptancePath: prepared.acceptancePath,
    ...(prepared.dataHome === undefined ? {} : { dataHome: prepared.dataHome }),
    confirmedBy: config.actor,
  }
  const spec = {
    taskId,
    version: 1,
    requirement: input.requirement,
    allowedModificationScope: [...input.allowedModificationScope],
    stableBaselineDigest: prepared.baselineDigest,
    createdBy: config.actor,
  }
  const frozenPlan = {
    testPlanId: `plan-${taskId}`,
    version: 1,
    taskSpecVersion: 1,
    requiredCases: [...input.plan.requiredCases],
    manualCases: [...input.plan.manualCases],
  }
  const calls: readonly [string, (revision: number) => Promise<FacadeOperationResult>][] = [
    ['createTask', revision => deps.facade.createTask(spec, revision, launchProfile)],
    ['authorizePlanning', revision => deps.facade.authorizePlanning(taskId, revision, config.actor)],
    ['submitPlanDraft', revision => deps.facade.submitPlanDraft(taskId, revision, {
      requiredCases: frozenPlan.requiredCases,
      manualCases: frozenPlan.manualCases,
    })],
    ['confirmPlan', revision => deps.facade.confirmPlan(taskId, revision, frozenPlan, config.actor)],
    ['approveBudget', revision => deps.facade.approveBudget(taskId, revision,
      toBudgetApproval(input.budget, { testPlanVersion: 1, taskSpecVersion: 1, approvedBy: config.actor }))],
    ['startCampaign', revision => deps.facade.startCampaign(taskId, revision, {
      unattended: input.unattended,
      acceptedBy: config.actor,
    }).then(result => ({
      taskId: result.taskId,
      operationId: 'campaign',
      revision: result.campaign.updatedAt,
      replayed: false,
      campaign: result.campaign,
    }))],
  ]
  let revision = 0
  let campaign: CampaignState | undefined
  for (const [step, call] of calls) {
    try {
      const result = await call(revision)
      revision = result.revision
      campaign = (result as { campaign?: CampaignState }).campaign
      steps.push({ step, detail: step === 'startCampaign' ? 'campaign started' : result.operationId })
    } catch (error: unknown) {
      return { ok: false, error: { step, error: errorOf(error) } }
    }
  }
  return { ok: true, campaign: campaign as CampaignState }
}
