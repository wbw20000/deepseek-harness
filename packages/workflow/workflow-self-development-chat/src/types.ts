/** Domain and structural-boundary types of the chat-side self-development launcher. Types only. */

// The real approval service is a genuine, always-available dependency (unlike
// the DH-a facade), so its outcome vocabulary is imported rather than mirrored
// — a same-named local mirror would collide with this type in generated,
// cross-package tooling (the Cordis API catalog) that indexes types by name.
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

export type { ApprovalOutcome }

/** One acceptance assertion, mirroring the runner's acceptance definition vocabulary. */
export type AcceptanceAssertion =
  | { readonly assertionId: string; readonly kind: 'exit-code'; readonly expected: number }
  | { readonly assertionId: string; readonly kind: 'stdout-includes'; readonly text: string }
  | { readonly assertionId: string; readonly kind: 'file-exists'; readonly path: string }
  | { readonly assertionId: string; readonly kind: 'file-includes'; readonly path: string; readonly text: string }

/** One acceptance case, mirroring the runner's acceptance definition schema. */
export interface AcceptanceCase {
  readonly caseId: string
  readonly command: readonly string[]
  readonly cwd?: string | undefined
  readonly timeoutMs: number
  readonly assertions: readonly AcceptanceAssertion[]
}

/** The stable-side acceptance definition the proposing agent drafts; `{ "cases": [...] }`. */
export interface AcceptanceDefinition {
  readonly cases: readonly AcceptanceCase[]
}

/** One required acceptance case the frozen plan must cover. */
export interface RequiredCaseInput {
  readonly caseId: string
  readonly requirement: string
  readonly assertionIds: readonly string[]
}

/** Budget terms the proposing agent selects; "unlimited" is the 24-hour time preset. */
export type ProposeBudget =
  | {
    /** No round limit; the campaign runs until the frozen 24-hour time cap (`MAX_BUDGET_HOURS`). */
    readonly preset: 'unlimited'
  }
  | {
    /** Selects the rounds-only budget form. */
    readonly mode: 'rounds'
    /** Maximum campaign rounds; must be a positive integer. */
    readonly maxRounds: number
  }
  | {
    /** Selects the time-only budget form. */
    readonly mode: 'time'
    /** Time budget in hours; must be positive and at most `MAX_BUDGET_HOURS` (24). */
    readonly hours: number
  }

/** Tool input of `self_development_propose`, drafted by the agent from the user's request. */
export interface ProposeInput {
  /** The requirement, as consolidated from the user's words. */
  readonly requirement: string
  /** Glob-allowed repository paths the development worker may modify. */
  readonly allowedModificationScope: readonly string[]
  /** Drafted plan: required acceptance cases plus items reserved for human verification. */
  readonly plan: { readonly requiredCases: readonly RequiredCaseInput[]; readonly manualCases: readonly string[] }
  /** Drafted acceptance definition as the model sent it; validated by `parseAcceptanceDefinition` before anything is written. */
  readonly acceptance: unknown
  /** Selected budget terms; omitted uses the deployment's configured default. */
  readonly budget?: ProposeBudget | undefined
  /** Whether one approval covers every round of the campaign; omitted uses the deployment default. */
  readonly unattended?: boolean | undefined
  /** When `false`, the proposal is refused while another campaign is running; omitted defaults to `true`. */
  readonly parallel?: boolean | undefined
}

/** {@link ProposeInput} after the deployment defaults are applied to the fields a caller may omit. */
export interface ResolvedProposeInput extends Omit<ProposeInput, 'budget' | 'unattended' | 'parallel'> {
  readonly budget: ProposeBudget
  readonly unattended: boolean
  readonly parallel: boolean
}

/** One completed step of a proposal, recorded for the tool result. */
export interface ProposeStep {
  /** Step name in execution order (`approval`, `workspace`, `baseline`, `acceptance`, then the facade calls). */
  readonly step: string
  /** One-line detail: the produced path, operation id, or failure message. */
  readonly detail: string
}

/** Machine-routed failure reason carried to the tool result. */
export interface ProposeError {
  /** Facade, workspace, or local error code; absent when the failure has none. */
  readonly code?: string
  /** Error message text. */
  readonly message: string
}

/** Campaign start options handed to the facade's `startCampaign` (DH-a wire form). */
export interface CampaignOptions {
  /** One approval covers every round of the campaign instead of per-round confirmation. */
  readonly unattended: boolean
  /** Actor recorded as accepting unattended operation. */
  readonly acceptedBy: string
}

/** Campaign state projection (DH-a wire form). */
export interface CampaignState {
  readonly taskId: string
  readonly status: 'running' | 'passed' | 'exhausted' | 'stopped' | 'failed'
  readonly startedAt: number
  readonly updatedAt: number
  readonly rounds: number
  readonly lastAttemptId?: string
  readonly lastOutcome?: 'passed' | 'failed' | 'cancelled' | 'late' | 'unknown'
  readonly reason?: string
  readonly acknowledgement: string
}

/** Result of one facade-forwarded mutating operation. */
export interface FacadeOperationResult {
  readonly taskId: string
  readonly operationId: string
  readonly revision: number
  readonly replayed: boolean
}

/** Budget approval in the facade's wire form, including the DH-a `preset` marker. */
export interface BudgetApprovalWire {
  readonly preset?: 'unlimited'
  readonly mode: 'rounds' | 'time' | 'both'
  readonly maxRounds?: number
  readonly durationMs?: number
  readonly phaseTimeoutMs?: number
  readonly maxStepsPerAttempt?: number
  readonly noProgressAttemptLimit?: number
  readonly testPlanVersion: number
  readonly taskSpecVersion: number
  readonly approvedBy: string
}

/** Launch profile handed to `createTask` (host-only wire form). */
export interface LaunchProfileWire {
  readonly worktree: string
  readonly acceptancePath: string
  readonly dataHome?: string | undefined
  readonly confirmedBy?: string | undefined
}

/** Task spec in the facade's wire form. */
export interface TaskSpecWire {
  readonly taskId: string
  readonly version: number
  readonly requirement: string
  readonly allowedModificationScope: readonly string[]
  readonly stableBaselineDigest: string
  readonly createdBy: string
}

/** Draft plan in the facade's wire form. */
export interface PlanDraftWire {
  readonly requiredCases: readonly RequiredCaseInput[]
  readonly manualCases: readonly string[]
}

/** Frozen plan in the facade's wire form. */
export interface FrozenPlanWire extends PlanDraftWire {
  readonly testPlanId: string
  readonly version: number
  readonly taskSpecVersion: number
}

/** The parts of the facade's `getTask` detail the status tool projects. */
export interface TaskDetailView {
  readonly projection: {
    readonly status: string
    readonly revision: number
    readonly spec?: { readonly requirement: string } | undefined
    readonly consumedRounds: number
    readonly consumedTimeMs: number
    readonly planningAuthorized: boolean
    readonly noProgressCount: number
  }
  readonly card: {
    readonly launchProfile?: {
      readonly worktree: string
      readonly acceptancePath: string
      readonly dataHome?: string | undefined
    } | undefined
  }
}

/**
 * Structural view of the self-development Remote facade (DH-a wire forms).
 * Declared here, not imported, because the facade gains campaign methods in DH-a.
 */
export interface SelfDevelopmentRemoteFacade {
  createTask(spec: TaskSpecWire, expectedRevision: number, launchProfile?: LaunchProfileWire): Promise<FacadeOperationResult>
  authorizePlanning(taskId: string, expectedRevision: number, authorizedBy: string): Promise<FacadeOperationResult>
  submitPlanDraft(taskId: string, expectedRevision: number, draft: PlanDraftWire): Promise<FacadeOperationResult>
  confirmPlan(taskId: string, expectedRevision: number, plan: FrozenPlanWire, actor: string): Promise<FacadeOperationResult>
  approveBudget(taskId: string, expectedRevision: number, approval: BudgetApprovalWire): Promise<FacadeOperationResult>
  startCampaign(taskId: string, expectedRevision: number, options: CampaignOptions): Promise<{ taskId: string; campaign: CampaignState }>
  campaign(taskId: string): Promise<CampaignState | undefined>
  stopCampaign(taskId: string, reason: string): Promise<CampaignState>
  getTask(taskId: string): Promise<TaskDetailView>
  /** Record that the user's "merge to stable" request counts as trial approval for the task (DI-b wave). */
  recordTrialApproval(taskId: string, expectedRevision: number, approvedBy: string): Promise<FacadeOperationResult>
}

/** Structural view of the approval service (`ctx.get('approval')`). */
export interface ApprovalPort {
  request(req: {
    readonly agent: unknown
    readonly toolName: string
    readonly reason?: string
    readonly callId?: unknown
    readonly signal?: AbortSignal
  }): Promise<ApprovalOutcome>
}

/**
 * Structural view of the optional `systemPrompt` service (`ctx.get('systemPrompt')`),
 * covering only the two members this package calls.
 */
export interface SystemPromptPort {
  /** Register one section; returns its disposer. */
  section(section: { readonly name: string; readonly order: number; readonly text: string }): () => void
  /** The centrally allocated order for a named position (see `@deepseek-ai/dsh-system-prompt`'s `SECTION_ORDERS`). */
  getSectionOrder(name: string): number
}

/** One allocated task workspace (workspaces service projection). */
export interface TaskWorkspaceView {
  readonly taskId: string
  readonly projectRoot: string
  readonly baseCommit: string
  readonly worktree: string
  readonly branch: string
  readonly dataHome: string
  readonly allocatedAt: number
}

/** Structural view of the optional workspaces service. */
export interface WorkspacesPort {
  allocate(req: { readonly taskId: string; readonly projectRoot: string }): Promise<TaskWorkspaceView>
  /**
   * Merge one task's worktree into the stable branch (DI-a wire form, DI-b
   * wave). Serializes internally; rebases onto a moved target tip and
   * re-verifies before fast-forwarding — see {@link IntegrationRequest}.
   */
  integrate(request: IntegrationRequest): Promise<IntegrationResult>
}

/**
 * One integration request (DI-a `workflow-self-development-workspaces` wire
 * form, frozen interface). `verify` runs after a rebase (if the target tip
 * moved) and before the fast-forward, whether or not the base moved — a
 * clean base still owes the repository its gates.
 */
export interface IntegrationRequest {
  readonly taskId: string
  readonly targetBranch: string
  readonly actor: string
  readonly verify?: (worktree: string) => Promise<VerifyOutcome>
}

/** Outcome of one `verify(worktree)` call; a thrown `verify` counts as `{ ok: false }` to the caller. */
export type VerifyOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** Result of one {@link WorkspacesPort.integrate} call (DI-a frozen interface). */
export type IntegrationResult =
  | { readonly status: 'integrated'; readonly commit: string; readonly baseMoved: boolean }
  | { readonly status: 'conflict'; readonly files: readonly string[]; readonly baseMoved: true }
  | { readonly status: 'verification-failed'; readonly reason: string; readonly baseMoved: boolean }
  | { readonly status: 'failed'; readonly reason: string }

/**
 * Structural view of the optional runner verification port
 * (`ctx.get('selfDevelopmentRunner')`), covering only the acceptance-only
 * entry point `self_development_merge` calls before a fast-forward — DI-a is
 * adding this export to `@deepseek-ai/dsh-workflow-self-development-runner`
 * without changing the executor itself.
 */
export interface RunnerVerifyPort {
  verifyAcceptance(
    worktree: string,
    acceptancePath: string,
    options: { readonly experimentsRoot: string; readonly killGraceMs?: number },
  ): Promise<VerifyOutcome>
}

/** One unified campaign notification event (events service projection; DH-a adds the campaign kinds). */
export interface CampaignEvent {
  readonly taskId: string
  readonly kind: string
  readonly title: string
  readonly occurredAt: number
}

/** Structural view of the optional events service. */
export interface CampaignEventSource {
  subscribe(listener: (event: CampaignEvent) => void): () => void
}

/** One running or finished trial instance (trial service projection, DH-c). */
export interface TrialInstance {
  readonly taskId: string
  readonly url: string
  readonly port: number
  readonly startedAt: number
}

/** Structural view of the optional trial service (DH-c). */
export interface TrialPort {
  trials(): Promise<readonly TrialInstance[]>
}

/** Successful proposal outcome. */
export interface ProposeSuccess {
  readonly ok: true
  readonly taskId: string
  readonly workspace: string
  readonly baselineDigest: string
  readonly steps: readonly ProposeStep[]
  readonly campaign: CampaignState
}

/** Failed proposal outcome: every completed step plus the failure reason. */
export interface ProposeFailure {
  readonly ok: false
  readonly taskId?: string
  readonly steps: readonly ProposeStep[]
  readonly reason: string
  readonly error?: ProposeError
}

/** Result of `self_development_propose`. */
export type ProposeOutcome = ProposeSuccess | ProposeFailure

/** Result of `self_development_status`. */
export interface StatusReport {
  readonly ok: boolean
  readonly reason?: string
  readonly task?: {
    readonly status: string
    readonly revision: number
    readonly requirement?: string
    readonly consumedRounds: number
    readonly consumedTimeMs: number
    readonly planningAuthorized: boolean
    readonly noProgressCount: number
  }
  readonly campaign?: CampaignState
  /** Always present: the derived acceptance-definition and campaign-record paths, plus the launch profile's paths once one exists. */
  readonly paths: {
    readonly worktree?: string
    readonly acceptancePath: string
    readonly dataHome?: string
    readonly campaignRecord: string
  }
  readonly trialUrl?: string
  /** The most recent campaign event the events service delivered for this task, when one arrived. */
  readonly latestEvent?: {
    readonly kind: string
    readonly title: string
    readonly occurredAt: number
  }
  readonly error?: ProposeError
}

/** Result of `self_development_stop`. */
export interface StopOutcome {
  readonly ok: boolean
  readonly reason?: string
  readonly campaign?: CampaignState
  readonly error?: ProposeError
}

/** Tool input of `self_development_merge`. */
export interface MergeInput {
  /** The task to merge; omitted takes the most recently proposed `awaiting-trial` task. */
  readonly taskId?: string | undefined
}

/** One completed step of a merge, recorded for the tool result (mirrors {@link ProposeStep}). */
export interface MergeStep {
  /** Step name in execution order (`approval`, `recordTrialApproval`, `integrate`, then `upgrade` or `repair` when applicable). */
  readonly step: string
  /** One-line detail: the produced status, operation id, or failure message. */
  readonly detail: string
}

/** Result of the post-integration upgrade attempt (`runUpgrade`). */
export interface UpgradeOutcome {
  readonly ok: boolean
  /** One-line detail: what ran, or why it failed. */
  readonly detail: string
}

/** Successful merge outcome: the task always resolved, whatever `result.status` settled on. */
export interface MergeSuccess {
  readonly ok: true
  readonly taskId: string
  readonly steps: readonly MergeStep[]
  /** The facade's integration result — `integrated`, `conflict`, `verification-failed`, or `failed`. */
  readonly result: IntegrationResult
  /** Present when `result.status` is `conflict` or `verification-failed`: the auto-started repair campaign's outcome. */
  readonly repair?: ProposeOutcome
  /** Present when `result.status` is `integrated` and `upgrade.kind` is not `none`. */
  readonly upgrade?: UpgradeOutcome
}

/** Failed merge outcome: resolution, approval, or a facade call failed before any integration result existed. */
export interface MergeFailure {
  readonly ok: false
  readonly taskId?: string
  readonly steps: readonly MergeStep[]
  readonly reason: string
  readonly error?: ProposeError
}

/** Result of `self_development_merge`. */
export type MergeOutcome = MergeSuccess | MergeFailure

/**
 * Payload of the `self-development-chat/merge-integrated` Cordis event this
 * package emits (see `index.ts`'s `declare module '@deepseek-ai/cordis'`).
 * `index.ts` also fans this out to `self-development/merge-integrated`
 * (`{ taskId, revision }`), the name and shape
 * `@deepseek-ai/dsh-workflow-self-development-events` actually subscribes to
 * (`packages/workflow/workflow-self-development-events/src/merge.ts`) —
 * `revision` here is the `FacadeOperationResult` `recordTrialApproval`
 * returned, threaded through so both destinations can be built from one payload.
 */
export interface MergeIntegratedEventPayload {
  readonly taskId: string
  readonly commit: string
  readonly baseMoved: boolean
  readonly occurredAt: number
  readonly revision: number
}

/**
 * Payload of the `self-development-chat/merge-blocked` Cordis event this
 * package emits; see {@link MergeIntegratedEventPayload} — `index.ts` fans
 * this out to `self-development/merge-blocked` (`{ taskId, status, revision }`) too.
 */
export interface MergeBlockedEventPayload {
  readonly taskId: string
  readonly status: 'conflict' | 'verification-failed' | 'failed'
  readonly occurredAt: number
  readonly revision: number
  readonly files?: readonly string[]
  readonly reason?: string
}
