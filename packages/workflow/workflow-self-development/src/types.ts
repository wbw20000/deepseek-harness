/**
 * Domain types for the self-development task-control foundation. Types only:
 * every runtime constructor, validator, and fold lives in a sibling module.
 * @module @deepseek-ai/dsh-workflow-self-development/types
 */

import type { Branded, BrandedNumber } from '@deepseek-ai/dsh-brand'

/** One controlled development task. Opaque across process and wire boundaries. */
export type SelfDevTaskId = Branded<'self-dev-task-id'>
/** One trusted-host control operation, replayable exactly once. */
export type SelfDevOperationId = Branded<'self-dev-operation-id'>
/** One development attempt inside one task. */
export type SelfDevAttemptId = Branded<'self-dev-attempt-id'>
/** sha-256 hex digest of the attempt's source snapshot. */
export type SourceDigest = Branded<'self-dev-source-digest'>
/** sha-256 hex digest of the attempt's built artifact. */
export type ArtifactDigest = Branded<'self-dev-artifact-digest'>
/** sha-256 hex digest of one frozen test plan. */
export type TestPlanDigest = Branded<'self-dev-test-plan-digest'>
/** sha-256 hex digest of capability evidence accepted at attempt launch. */
export type CapabilityDigest = Branded<'self-dev-capability-digest'>
/** Monotonic counter of a task's test plan versions. */
export type TestPlanVersion = BrandedNumber<'self-dev-test-plan-version'>
/** Monotonic counter of a task's TaskSpec versions. */
export type TaskSpecVersion = BrandedNumber<'self-dev-task-spec-version'>

/**
 * One trusted clock observation supplied by the host. `bootId` identifies the
 * OS boot session and `monotonicMs` counts a monotonic host clock that
 * includes sleep. A Node-only clock does not prove either property; the
 * intended production source is the future Swift supervisor.
 */
export interface ClockObservation {
  /** Identity of the current OS boot session. */
  readonly bootId: string
  /** Monotonic milliseconds including sleep, since an unstated epoch. */
  readonly monotonicMs: number
}

/** Source of trusted clock observations injected into the controller. */
export interface TrustedClock {
  /** Read the current trusted observation. */
  observe(): ClockObservation
}

/** Parsed, versioned task requirement. */
export interface TaskSpec {
  /** Task identity. */
  readonly taskId: SelfDevTaskId
  /** TaskSpec version this record carries. */
  readonly version: TaskSpecVersion
  /** Requirement text agreed with the user. */
  readonly requirement: string
  /** Repository paths the development worker may modify. */
  readonly allowedModificationScope: readonly string[]
  /** Digest of the stable release commit the task starts from. */
  readonly stableBaselineDigest: string
  /** Human actor that created the task. */
  readonly createdBy: string
}

/** One required acceptance case in a frozen test plan. */
export interface RequiredCase {
  /** Stable case identity reused by every result report. */
  readonly caseId: string
  /** Requirement this case verifies. */
  readonly requirement: string
  /** Assertion identities that must all run and pass. */
  readonly assertionIds: readonly string[]
}

/** Draft plan awaiting human confirmation; not yet binding. */
export interface TestPlanDraft {
  /** Draft cases, in the order submitted by the planner. */
  readonly requiredCases: readonly RequiredCase[]
  /** Acceptance items explicitly reserved for human verification. */
  readonly manualCases: readonly string[]
}

/** Human-confirmed plan. Digest and identity bind every later operation. */
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

/** Frozen confirmed plan with its computed digest. */
export interface FrozenTestPlan extends ConfirmedPlanInput {
  /** Test plan identity. */
  readonly testPlanId: string
  /** Monotonic plan version inside the task. */
  readonly version: TestPlanVersion
  /** TaskSpec version the plan was written against. */
  readonly taskSpecVersion: TaskSpecVersion
  /** Digest over the frozen plan content. */
  readonly digest: TestPlanDigest
}

/** What the budget limits. */
export type BudgetMode = 'rounds' | 'time' | 'both'

/** Human-approved development budget. Only a human entry point creates one. */
export interface BudgetApproval {
  /** Which limits the approval carries. */
  readonly mode: BudgetMode
  /** Maximum attempt rounds; required when mode allows rounds. */
  readonly maxRounds?: number
  /** Maximum development run time in milliseconds; required when mode allows time. */
  readonly durationMs?: number
  /** Maximum milliseconds for one phase; required for a rounds-only budget. */
  readonly phaseTimeoutMs?: number
  /** Maximum model/tool steps inside one attempt; required for a rounds-only budget. */
  readonly maxStepsPerAttempt?: number
  /** Maximum consecutive attempts without new evidence; required for a time-only budget. */
  readonly noProgressAttemptLimit?: number
  /** Frozen plan version the approval binds. */
  readonly testPlanVersion: TestPlanVersion
  /** TaskSpec version the approval binds. */
  readonly taskSpecVersion: TaskSpecVersion
  /** Human actor that approved the budget. */
  readonly approvedBy: string
}

/** Capability claim the controller accepts from its injected evidence source. */
export interface CapabilityEvidence {
  /** Capability name, e.g. `supervisor` or `external-verifier`. */
  readonly capability: string
  /** Digest over the evidence that proves the capability for this launch. */
  readonly digest: CapabilityDigest
}

/** Source of capability evidence injected into the controller. */
export interface CapabilitySource {
  /**
   * Return evidence for every required capability, or throw when one cannot
   * be proven. The production provider does not exist yet.
   */
  evidence(requiredCapabilities: readonly string[]): readonly CapabilityEvidence[]
}

/** One committed development attempt. */
export interface Attempt {
  /** Attempt identity. */
  readonly attemptId: SelfDevAttemptId
  /** One-based round number; the first development attempt is round 1. */
  readonly attemptNumber: number
  /** Clock observation committed at start. */
  readonly startedAt: ClockObservation
  /** Digest of the frozen plan the attempt runs against. */
  readonly testPlanDigest: TestPlanDigest
  /** Digest of the source snapshot the attempt modifies. */
  readonly sourceDigest: SourceDigest
  /** Digest of the artifact the attempt builds. */
  readonly artifactDigest: ArtifactDigest
  /** Digest over the capability evidence accepted at launch. */
  readonly capabilityDigest: CapabilityDigest
}

/** Status of one executed case assertion. */
export type AssertionStatus = 'pass' | 'fail' | 'skipped'

/** Result of one assertion inside an externally supplied report. */
export interface AssertionResult {
  /** Assertion identity from the frozen plan. */
  readonly assertionId: string
  /** Observed status. */
  readonly status: AssertionStatus
}

/** Result of one case inside an externally supplied report. */
export interface CaseResult {
  /** Case identity from the frozen plan. */
  readonly caseId: string
  /** Every assertion the runner executed or accounted for. */
  readonly assertions: readonly AssertionResult[]
}

/**
 * Structured result supplied by the trusted verifier for one attempt. The
 * process facts stay independent so a zero exit can never mask a signal,
 * timeout, or cancellation. `phases` and `stepsUsed` are the verifier's
 * observed execution facts; the host supervisor, not this package, enforces
 * the phase deadline and step cap while the attempt runs (see
 * {@link SupervisorObligations}).
 */
export interface TestResult {
  /** Task the report claims to answer. */
  readonly taskId: SelfDevTaskId
  /** Attempt the report claims to answer. */
  readonly attemptId: SelfDevAttemptId
  /** Source digest the report claims to have tested. */
  readonly sourceDigest: SourceDigest
  /** Artifact digest the report claims to have tested. */
  readonly artifactDigest: ArtifactDigest
  /** Frozen plan digest the report claims to have executed. */
  readonly testPlanDigest: TestPlanDigest
  /** Process exit code; `null` when the process never exited normally. */
  readonly exitCode: number | null
  /** Terminating signal; `null` when no signal ended the process. */
  readonly signal: string | null
  /** Whether the trusted runner ended the run at its deadline. */
  readonly timedOut: boolean
  /** Whether cancellation ended the run before completion. */
  readonly cancelled: boolean
  /** Per-case assertion results. */
  readonly cases: readonly CaseResult[]
  /** Observed phase durations; a nonempty list is required when the approval has a phase limit. */
  readonly phases?: readonly PhaseRun[]
  /** Observed model/tool step count, required when the approval has a step limit. */
  readonly stepsUsed?: number
}

/** One observed phase inside a {@link TestResult}. */
export interface PhaseRun {
  /** Phase identity from the execution plan. */
  readonly phaseId: string
  /** Observed wall-clock duration of the phase in milliseconds. */
  readonly durationMs: number
}

/**
 * What the host supervisor must enforce while a real attempt runs. This
 * package validates the resulting report and refuses overruns, but it has no
 * process control of its own: an `AbortSignal` is a cooperative cancellation
 * token for a trusted runner, never child-process supervision. Real
 * execution stays refused — via required capability evidence — until a
 * supervisor that actually enforces these obligations exists.
 */
export interface SupervisorObligations {
  /** Kill one phase at the approved `phaseTimeoutMs` and report the overrun instead of letting it continue. */
  readonly enforcePhaseDeadline: true
  /** Stop an attempt at the approved `maxStepsPerAttempt` and report the overrun. */
  readonly enforceStepCap: true
  /** Terminate the runner child process on cancellation and confirm quiescence before reporting any result. */
  readonly enforceCancellation: true
  /** Supply trusted clock observations (`bootId` plus monotonic-with-sleep) for every attempt boundary. */
  readonly trustedClock: true
}

/** Why a task stopped. */
export type TaskStopReason = 'cancelled' | 'budget-exhausted' | 'no-progress'

/** Why a task entered handoff and refuses side effects. */
export type TaskHandoffReason =
  | 'journal-incomplete-tail'
  | 'journal-corrupted'
  | 'attempt-interrupted'
  | 'clock-uncertain'

/**
 * How the run time of one finished attempt was accounted. `measured` means
 * both clock observations came from one provable boot session; `uncertain`
 * means the interval crossed a boot boundary, cannot be proven, and freezes
 * the remaining time budget until a human reviews the task.
 */
export type TimeAccounting = 'measured' | 'uncertain'

/** Task lifecycle states. */
export type TaskStatus =
  | 'draft'
  | 'planning-authorized'
  | 'awaiting-plan-confirmation'
  | 'awaiting-development-approval'
  | 'ready'
  | 'attempting'
  | 'awaiting-trial'
  | 'stopped'
  | 'handoff'

/** Durable task events. The journal record wraps one event. */
export type TaskEvent =
  | { readonly type: 'task/created'; readonly spec: TaskSpec }
  | { readonly type: 'task/planning-authorized'; readonly authorizedBy: string }
  | { readonly type: 'plan/drafted'; readonly draft: TestPlanDraft }
  | { readonly type: 'plan/confirmed'; readonly plan: FrozenTestPlan }
  | { readonly type: 'budget/approved'; readonly approval: BudgetApproval }
  | { readonly type: 'attempt/started'; readonly attempt: Attempt }
  | { readonly type: 'attempt/failed'; readonly attemptId: SelfDevAttemptId; readonly reason: string; readonly failureDigest: string; readonly elapsedMs: number; readonly timeAccounting: TimeAccounting }
  | { readonly type: 'task/passed'; readonly attemptId: SelfDevAttemptId; readonly resultDigest: string; readonly elapsedMs: number; readonly timeAccounting: TimeAccounting }
  | { readonly type: 'trial/approved'; readonly approvedBy: string; readonly resultDigest: string }
  | { readonly type: 'task/stopped'; readonly reason: TaskStopReason }
  | { readonly type: 'handoff/raised'; readonly reason: TaskHandoffReason; readonly detail: string }

/** Replayable operation header every mutating controller call carries. */
export interface OperationHeader {
  /** Task the operation addresses. */
  readonly taskId: SelfDevTaskId
  /** Revision the caller observed; the operation applies only at this revision. */
  readonly expectedRevision: number
  /** Idempotency key; the same key with the same payload replays its outcome. */
  readonly operationId: SelfDevOperationId
}

/** Control state projected from the journal. */
export interface TaskProjection {
  /** Current lifecycle state. */
  readonly status: TaskStatus
  /** Current TaskSpec. */
  readonly spec: TaskSpec | undefined
  /** Frozen plan, once confirmed. */
  readonly plan: FrozenTestPlan | undefined
  /** Current budget approval. */
  readonly approval: BudgetApproval | undefined
  /** Whether planning work is authorized for the current revision cycle. */
  readonly planningAuthorized: boolean
  /** Attempt rounds consumed; never reset by a budget revision. */
  readonly consumedRounds: number
  /** Development run time consumed in milliseconds; never reset by a budget revision. */
  readonly consumedTimeMs: number
  /** Whether the remaining time budget is frozen pending human review. */
  readonly timeBudgetFrozen: boolean
  /** Attempt in flight, while status is `attempting`. */
  readonly currentAttempt: Attempt | undefined
  /** Verified result that moved the task to `awaiting-trial`. */
  readonly verifiedResultDigest: string | undefined
  /** Trial approval identities, once a human trial approval is recorded. */
  readonly trialApproval: { readonly approvedBy: string; readonly resultDigest: string } | undefined
  /** Consecutive attempts with an unchanged failure fingerprint. */
  readonly noProgressCount: number
  /** Terminal stop reason, once stopped. */
  readonly stopReason: TaskStopReason | undefined
  /** Handoff reason, once handed off. */
  readonly handoffReason: TaskHandoffReason | undefined
  /** Human-readable handoff detail, once handed off. */
  readonly handoffDetail: string | undefined
  /** Projection revision; increments once per committed event. */
  readonly revision: number
}

/**
 * Internal fold state: the projection plus bookkeeping that never publishes.
 * `lastDraft` is the human-visible draft the next plan confirmation must
 * match; `lastFailureDigest` drives no-progress counting.
 */
export interface TaskFoldState extends TaskProjection {
  /** Draft submitted by the last `plan/drafted` event, awaiting confirmation. */
  readonly lastDraft: TestPlanDraft | undefined
  /** Failure fingerprint of the last failed attempt, used for no-progress counting. */
  readonly lastFailureDigest: string | undefined
}

/** Read outcome of one journal load. */
export type JournalReadStatus = 'ok' | 'incomplete-tail' | 'corrupt'

/** Result of reading one task journal. */
export interface JournalReadResult {
  /** How the read ended. */
  readonly status: JournalReadStatus
  /** Records that verified completely, in order. */
  readonly records: readonly CommittedRecord[]
  /** Human-readable description of the first rejected record, when present. */
  readonly detail: string | undefined
}

/** One hash-chained journal record as durably stored. */
export interface CommittedRecord {
  /** Journal schema version. */
  readonly schemaVersion: number
  /** One-based sequence inside the task journal. */
  readonly seq: number
  /** Hash of the previous record; empty string at seq 1. */
  readonly prevHash: string
  /** Hash over this record's identity fields. */
  readonly hash: string
  /** Operation header that produced the event, when the event came from an operation. */
  readonly operation: CommittedOperation | undefined
  /** The committed event. */
  readonly event: TaskEvent
}

/** Idempotency facts stored with a committed operation. */
export interface CommittedOperation {
  /** Operation id, unique inside the task. */
  readonly id: SelfDevOperationId
  /** Revision the operation required. */
  readonly expectedRevision: number
  /** Digest over the operation payload. */
  readonly payloadDigest: string
}

/** Request shape shared by every mutating controller operation. */
export type TaskOperationRequest = OperationHeader & Record<string, unknown>

/** Result of one mutating controller operation. */
export interface TaskOperationResult {
  /** Projection revision after the operation. */
  readonly revision: number
  /** Whether the call replayed an already committed operation. */
  readonly replayed: boolean
}
