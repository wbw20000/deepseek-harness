/**
 * Wire and view types of the self-development Remote facade. Types only:
 * every runtime validator, card builder, and service method lives in a
 * sibling module. The shapes mirror the human-review confirmation card so
 * the M4 UI and the phone whitelist render read-only data, never decisions.
 * @module @deepseek-ai/dsh-workflow-self-development-remote/types
 */

import type {
  Attempt,
  BudgetApproval,
  FrozenTestPlan,
  RequiredCase,
  TaskSpec,
  TaskStatus,
  TaskStopReason,
  TaskHandoffReason,
} from '@deepseek-ai/dsh-workflow-self-development'

export type {
  Attempt,
  BudgetApproval,
  FrozenTestPlan,
  RequiredCase,
  TaskSpec,
  TaskStatus,
  TaskStopReason,
  TaskHandoffReason,
}

/** Which limits a budget approval carries, as the core defines it. */
export type BudgetMode = BudgetApproval['mode']

/**
 * The calling side of one Remote request, mirroring the frozen
 * `ConnectionCaller` contract of the connection service. The connection layer
 * derives `loopback` from the request's Host header: a loopback host is this
 * machine, which is what makes a caller the stable host.
 */
export interface RemoteConnectionCaller {
  /** Owning chat session id, when the caller is bound to one. */
  readonly sessionId: string | undefined
  /** Host header the request arrived with, as `host:port`. */
  readonly host: string
  /** Whether the request's Host header resolved to the loopback interface. */
  readonly loopback: boolean
  /** Serial of the client certificate the request authenticated with, when present. */
  readonly certificateSerial: string | undefined
}

/**
 * Structural view of the optional `connection` service, mirroring the frozen
 * `ctx.connection.caller.current()` contract. Declared here, not imported,
 * because the service is optional and this package must stay loadable in
 * deployments that mount no connection service.
 */
export interface RemoteConnectionService {
  /** Caller context of the Remote request currently being served. */
  readonly caller: { readonly current: () => RemoteConnectionCaller | undefined }
}

/** Deployment configuration of the Remote facade. */
export interface RemoteConfig {
  /**
   * Master switch. Every method refuses with `self-development/disabled`
   * while this is `false`, so mounting the plugin alone enables nothing.
   */
  readonly enabled: boolean
  /**
   * Actors allowed to drive mutating operations. Empty means no restriction;
   * non-empty requires the operation's actor field (spec creator, budget
   * approver, plan confirmer, confirmed human, trial approver) to appear here.
   */
  readonly allowedActors: readonly string[]
  /**
   * The task-control service's private control directory. The facade reads it
   * only to list task journal directories; it never writes under it.
   */
  readonly controlDirectory: string
}

/** Wire form of a TaskSpec handed to `createTask`. */
export interface TaskSpecInput {
  /** Task identity; must match the journal directory the operation opens. */
  readonly taskId: string
  /** TaskSpec version this record carries. */
  readonly version: number
  /** Requirement text agreed with the user. */
  readonly requirement: string
  /** Repository paths the development worker may modify. */
  readonly allowedModificationScope: readonly string[]
  /** Digest of the stable release commit the task starts from. */
  readonly stableBaselineDigest: string
  /** Human actor that created the task; checked against `allowedActors`. */
  readonly createdBy: string
}

/** Wire form of a plan draft handed to `submitPlanDraft`. */
export interface PlanDraftInput {
  /** Draft cases, in the order submitted by the planner. */
  readonly requiredCases: readonly RequiredCase[]
  /** Acceptance items explicitly reserved for human verification. */
  readonly manualCases: readonly string[]
}

/** Wire form of a confirmed plan handed to `confirmPlan`; the core computes and freezes the digest. */
export interface ConfirmedPlanInput {
  /** Test plan identity. */
  readonly testPlanId: string
  /** Monotonic plan version inside the task. */
  readonly version: number
  /** TaskSpec version the plan was written against. */
  readonly taskSpecVersion: number
  /** Confirmed required cases. */
  readonly requiredCases: readonly RequiredCase[]
  /** Confirmed manual acceptance items. */
  readonly manualCases: readonly string[]
}

/** Wire form of a budget approval handed to `approveBudget`. */
export interface BudgetApprovalInput {
  /** Which limits the approval carries. */
  readonly mode: BudgetMode
  /** Maximum attempt rounds; required when mode allows rounds. */
  readonly maxRounds?: number | undefined
  /** Maximum development run time in milliseconds; required when mode allows time. */
  readonly durationMs?: number | undefined
  /** Maximum milliseconds for one phase; required for a rounds-only budget. */
  readonly phaseTimeoutMs?: number | undefined
  /** Maximum model/tool steps inside one attempt; required for a rounds-only budget. */
  readonly maxStepsPerAttempt?: number | undefined
  /** Maximum consecutive attempts without new evidence; required for a time-only budget. */
  readonly noProgressAttemptLimit?: number | undefined
  /** Frozen plan version the approval binds. */
  readonly testPlanVersion: number
  /** TaskSpec version the approval binds. */
  readonly taskSpecVersion: number
  /** Human actor that approved the budget; checked against `allowedActors`. */
  readonly approvedBy: string
}

/**
 * One unified self-development notification event, in the events consumer's
 * title-level projection: fixed-template titles with round numbers and
 * closed-vocabulary reasons only — never the journal's free-text failure
 * reasons, handoff details, or requirement text.
 */
export interface RecentEvent {
  /** Task the event belongs to. */
  readonly taskId: string
  /** What the human should notice. */
  readonly kind: 'turn-finished' | 'failed' | 'awaiting-decision' | 'awaiting-trial' | 'stopped'
  /** Owning chat session; absent for self-development tasks. */
  readonly sessionId?: string
  /** Fixed-template summary chosen by the events mapping. */
  readonly title: string
  /** Host-clock milliseconds when the durable commit was observed. */
  readonly occurredAt: number
  /** Task projection revision after the commit that produced the event. */
  readonly revision: number
}

/** One listed task row for progress views. */
export interface TaskSummary {
  /** Task identity. */
  readonly taskId: string
  /** Current lifecycle state. */
  readonly status: TaskStatus
  /** Projection revision the row was read at. */
  readonly revision: number
  /** First 80 characters of the requirement text. */
  readonly title: string
}

/** The approved budget terms shown on the confirmation card; absent terms mean the field is not set. */
export interface CardBudget {
  /** Which limits the approval carries; absent before the first approval. */
  readonly mode?: BudgetMode
  /** Maximum attempt rounds, when the mode allows rounds. */
  readonly maxRounds?: number
  /** Maximum total development run time in milliseconds, when the mode allows time. */
  readonly durationMs?: number
  /** Maximum milliseconds for one phase. */
  readonly phaseTimeoutMs?: number
  /** Maximum model/tool steps inside one attempt. */
  readonly maxStepsPerAttempt?: number
  /** Maximum consecutive attempts without new evidence. */
  readonly noProgressAttemptLimit?: number
}

/**
 * Read-only view of the human-review confirmation card for one task. Every
 * field is derived from the task projection; the facade adds no decision of
 * its own and never marks a field confirmed that the journal does not record.
 */
export interface ConfirmationCard {
  /** Task the card belongs to. */
  readonly taskId: string
  /** 任务与目标: the requirement text, empty before the spec exists. */
  readonly taskAndGoal: string
  /** 验收行为: the confirmed plan's required cases, empty before confirmation. */
  readonly acceptanceCases: readonly RequiredCase[]
  /** 验收行为: acceptance items explicitly reserved for human verification. */
  readonly manualCases: readonly string[]
  /** 规划授权记录: whether planning work is authorized for the current revision cycle. */
  readonly planningAuthorized: boolean
  /** 建议预算及依据: basis text; the literal `无依据` while no history source exists. */
  readonly suggestedBudgetBasis: string
  /** 稳定基线: digest of the stable release commit the task starts from; absent before the spec exists. */
  readonly stableBaselineDigest?: string
  /** 允许修改范围: repository paths the development worker may modify. */
  readonly allowedModificationScope: readonly string[]
  /** 预算模式/轮数/时间上限: the approved budget terms. */
  readonly budget: CardBudget
  /** 已用预算: consumed rounds and time; never reset by a budget revision. */
  readonly consumedBudget: { readonly rounds: number; readonly timeMs: number }
  /** 费用及调用限制: literal `未知，不放行` — the facade knows no balance, so nothing auto-proceeds. */
  readonly costLimits: string
}

/**
 * JSON-safe wire view of the core {@link TaskProjection}: the projection's
 * required `| undefined` fields appear here as absent optional properties,
 * which is how the Remote boundary represents `undefined` over JSON.
 */
export interface RemoteTaskProjection {
  /** Current lifecycle state. */
  readonly status: TaskStatus
  /** Current TaskSpec. */
  readonly spec?: TaskSpec
  /** Frozen plan, once confirmed. */
  readonly plan?: FrozenTestPlan
  /** Current budget approval. */
  readonly approval?: BudgetApproval
  /** Whether planning work is authorized for the current revision cycle. */
  readonly planningAuthorized: boolean
  /** Attempt rounds consumed; never reset by a budget revision. */
  readonly consumedRounds: number
  /** Development run time consumed in milliseconds; never reset by a budget revision. */
  readonly consumedTimeMs: number
  /** Whether the remaining time budget is frozen pending human review. */
  readonly timeBudgetFrozen: boolean
  /** Attempt in flight, while status is `attempting`. */
  readonly currentAttempt?: Attempt
  /** Verified result that moved the task to `awaiting-trial`. */
  readonly verifiedResultDigest?: string
  /** Trial approval identities, once a human trial approval is recorded. */
  readonly trialApproval?: { readonly approvedBy: string; readonly resultDigest: string }
  /** Consecutive attempts with an unchanged failure fingerprint. */
  readonly noProgressCount: number
  /** Terminal stop reason, once stopped. */
  readonly stopReason?: TaskStopReason
  /** Handoff reason, once handed off. */
  readonly handoffReason?: TaskHandoffReason
  /** Human-readable handoff detail, once handed off. */
  readonly handoffDetail?: string
  /** Projection revision; increments once per committed event. */
  readonly revision: number
}

/** `getTask` result: the JSON-safe projection plus the confirmation-card view. */
export interface TaskDetail {
  /** Control state projected from the journal, mapped onto the wire view. */
  readonly projection: RemoteTaskProjection
  /** The read-only confirmation-card view. */
  readonly card: ConfirmationCard
}

/** Result of one facade-forwarded mutating operation. */
export interface RemoteOperationResult {
  /** Task the operation addressed. */
  readonly taskId: string
  /** Operation id the facade generated; keep it to replay the operation exactly. */
  readonly operationId: string
  /** Projection revision after the operation. */
  readonly revision: number
  /** Whether the call replayed an already committed operation. */
  readonly replayed: boolean
}

/** Request the UI or phone sends to launch one supervised attempt. */
export interface RemoteRunAttemptRequest {
  /** Task the attempt belongs to. */
  readonly taskId: string
  /** Task revision the caller observed; the launch applies only at this revision. */
  readonly expectedRevision: number
  /** Experiment worktree as handed in; it must resolve inside the runner's experiments root. */
  readonly worktree: string
  /** Worktree-relative artifact paths the acceptance covers. */
  readonly artifactPaths: readonly string[]
  /** Absolute path of the stable-side acceptance definition. */
  readonly acceptancePath: string
  /**
   * Host-only per-attempt data directory, forwarded as the runner's `dshHome`.
   * Assigned by the stable-side workspace service; a phone caller must omit
   * this field, and the wire schema marks it `hostOnly` for that reason.
   */
  readonly dataHome?: string | undefined
  /** Non-empty name of the person who gave the confirmation; checked against `allowedActors`. */
  readonly confirmedBy: string
  /** Loopback ports the supervised session may bind. */
  readonly loopbackAllowlist: readonly number[]
  /**
   * Explicit human-presence acknowledgement. The request is refused without
   * `true`; a UI must never default, pre-select, or imply this field.
   */
  readonly presenceAcknowledged: boolean
}

/**
 * `runAttempt` result: the runner's outcome mapped onto the JSON-safe wire
 * view (the outcome's required `| undefined` fields appear as absent optional
 * properties), plus the facade-generated operation id.
 */
export interface RemoteRunAttemptOutcome {
  /** Core operation result, including whether the call replayed an already committed launch. */
  readonly operation: { readonly revision: number; readonly replayed: boolean }
  /** Attempt id of the side effect this process executed; absent on a replay. */
  readonly attemptId?: string
  /** Absolute path of the published attempt evidence; absent on a replay. */
  readonly evidencePath?: string
  /** Why the outcome file could not be written; absent when it was recorded. */
  readonly outcomeWriteError?: { readonly code: string; readonly message: string }
  /**
   * The experiment worktree the launched attempt runs in, as accepted by this
   * facade's request validation; absent on a replay, where this process never
   * saw the launch.
   */
  readonly worktree?: string
  /** Operation id the facade generated for this launch. */
  readonly operationId: string
}
