/**
 * Deterministic domain rules for the self-development task-control
 * foundation: budget validation, plan freezing, result verification, and the
 * event fold. No I/O happens here, so every rule is unit-testable against a
 * fake clock and plain values.
 * @module @deepseek-ai/dsh-workflow-self-development/domain
 */

import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import {
  SelfDevelopmentError,
  digestJson,
  TaskSpecVersion,
  TestPlanDigest,
  TestPlanVersion,
} from './runtime.ts'
import type {
  Attempt,
  BudgetApproval,
  BudgetMode,
  ClockObservation,
  ConfirmedPlanInput,
  FrozenTestPlan,
  SelfDevTaskId,
  TaskEvent,
  TaskFoldState,
  TaskSpec,
  TestResult,
  TimeAccounting,
} from './types.ts'

/**
 * Initial fold state for a task that has no committed events yet.
 * @returns a draft task with no approvals or consumed budget.
 */
export function initialFoldState(): TaskFoldState {
  return {
    status: 'draft',
    spec: undefined,
    plan: undefined,
    approval: undefined,
    planningAuthorized: false,
    consumedRounds: 0,
    consumedTimeMs: 0,
    timeBudgetFrozen: false,
    currentAttempt: undefined,
    verifiedResultDigest: undefined,
    trialApproval: undefined,
    noProgressCount: 0,
    stopReason: undefined,
    handoffReason: undefined,
    handoffDetail: undefined,
    revision: 0,
    lastDraft: undefined,
    lastFailureDigest: undefined,
  }
}

/**
 * Validate a parsed budget approval against the frozen plan and TaskSpec it
 * must bind. Rounds and time are the primary limits; a rounds-only budget
 * must also carry finite per-phase and per-attempt step bounds so one round
 * cannot hide unbounded work, and a time-only budget must carry the
 * no-progress bound so rewriting a failure summary cannot extend the task.
 * @param approval - schema-parsed approval to validate.
 * @param spec - current TaskSpec the approval must bind.
 * @param plan - frozen plan the approval must bind.
 * @returns the same approval, frozen.
 * @throws SelfDevelopmentError with `SELF_DEV_INVALID_BUDGET` when a required limit is missing or an identity does not bind.
 */
export function validateBudgetApproval(
  approval: BudgetApproval,
  spec: TaskSpec,
  plan: FrozenTestPlan,
): BudgetApproval {
  const modeLimits: Record<BudgetMode, readonly (keyof BudgetApproval)[]> = {
    rounds: ['maxRounds'],
    time: ['durationMs'],
    both: ['maxRounds', 'durationMs'],
  }
  const missing = modeLimits[approval.mode].filter(key => approval[key] === undefined)
  if (missing.length > 0) {
    throw new SelfDevelopmentError(
      `budget mode ${approval.mode} requires ${missing.join(', ')}`,
      'SELF_DEV_INVALID_BUDGET',
    )
  }
  if (approval.mode !== 'time') {
    if (approval.phaseTimeoutMs === undefined || approval.maxStepsPerAttempt === undefined) {
      throw new SelfDevelopmentError(
        'a budget with rounds requires finite phaseTimeoutMs and maxStepsPerAttempt',
        'SELF_DEV_INVALID_BUDGET',
      )
    }
  }
  if (approval.mode === 'time' && approval.noProgressAttemptLimit === undefined) {
    throw new SelfDevelopmentError(
      'a time-only budget requires noProgressAttemptLimit',
      'SELF_DEV_INVALID_BUDGET',
    )
  }
  if (approval.testPlanVersion !== plan.version || approval.taskSpecVersion !== spec.version) {
    throw new SelfDevelopmentError(
      `budget binds plan ${approval.testPlanVersion} and spec ${approval.taskSpecVersion},`
        + ` current plan ${plan.version} and spec ${spec.version}`,
      'SELF_DEV_INVALID_BUDGET',
    )
  }
  return deepFreeze(approval)
}

/**
 * Freeze a confirmed plan: bind it to the TaskSpec version, digest it, and
 * deep-freeze the result so later code cannot edit acceptance semantics.
 * @param plan - schema-parsed confirmed plan.
 * @param spec - TaskSpec the plan was written against.
 * @returns the frozen plan with its digest.
 * @throws SelfDevelopmentError with `SELF_DEV_INVALID_PLAN` when the plan binds a different TaskSpec version.
 */
export function freezeTestPlan(plan: ConfirmedPlanInput, spec: TaskSpec): FrozenTestPlan {
  if (plan.taskSpecVersion !== spec.version) {
    throw new SelfDevelopmentError(
      `plan binds TaskSpec ${plan.taskSpecVersion}, current TaskSpec is ${spec.version}`,
      'SELF_DEV_INVALID_PLAN',
    )
  }
  const frozen: FrozenTestPlan = deepFreeze({
    ...plan,
    version: TestPlanVersion(plan.version),
    taskSpecVersion: TaskSpecVersion(plan.taskSpecVersion),
    digest: TestPlanDigest(digestJson(plan)),
  })
  return frozen
}

/**
 * Verify one externally supplied result against the frozen plan and the
 * attempt it claims to answer. Only a complete run — exit zero, no signal,
 * no timeout, no cancellation — where every required case ran and every
 * required assertion passed can pass; zero, skipped, missing, timed-out,
 * signalled, and cancelled results never pass. A run or phase that overran
 * the approved phase deadline or step cap is late and can never pass; the
 * host supervisor is responsible for enforcing those limits while the
 * attempt runs.
 * @param params.taskId - task the result must answer.
 * @param params.attempt - attempt the result must answer.
 * @param params.result - schema-parsed report from the trusted verifier.
 * @param params.approval - the approved budget, when one is recorded; supplies the phase deadline and step cap the report must not overrun.
 * @returns the sha-256 digest of the verified result.
 * @throws SelfDevelopmentError with `SELF_DEV_IDENTITY_MISMATCH` when the report answers another task, attempt, source, artifact, or plan.
 * @throws SelfDevelopmentError with `SELF_DEV_INVALID_RESULT` when the run or any required assertion did not complete.
 * @throws SelfDevelopmentError with `SELF_DEV_LATE_RESULT` when the run or a reported phase overran the approved deadline or step cap.
 */
export function verifyAttemptResult(params: {
  taskId: SelfDevTaskId
  attempt: Attempt
  plan: FrozenTestPlan
  result: TestResult
  approval?: BudgetApproval
}): string {
  const { taskId, attempt, plan, result, approval } = params
  if (result.taskId !== taskId || result.attemptId !== attempt.attemptId
    || result.sourceDigest !== attempt.sourceDigest
    || result.artifactDigest !== attempt.artifactDigest
    || result.testPlanDigest !== attempt.testPlanDigest) {
    throw new SelfDevelopmentError(
      'result identity does not match the current task, attempt, source, artifact, and plan',
      'SELF_DEV_IDENTITY_MISMATCH',
    )
  }
  if (plan.digest !== attempt.testPlanDigest) {
    throw new SelfDevelopmentError(
      'attempt plan digest does not match the frozen plan',
      'SELF_DEV_IDENTITY_MISMATCH',
    )
  }
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.cancelled) {
    throw new SelfDevelopmentError(
      `run did not complete cleanly (exitCode ${result.exitCode}, signal ${result.signal},`
        + ` timedOut ${result.timedOut}, cancelled ${result.cancelled})`,
      'SELF_DEV_INVALID_RESULT',
    )
  }
  const phaseTimeoutMs = approval?.phaseTimeoutMs
  if (phaseTimeoutMs !== undefined) {
    if (result.phases === undefined || result.phases.length === 0) {
      throw new SelfDevelopmentError('phase observations are required by the approved phase limit', 'SELF_DEV_INVALID_RESULT')
    }
    const overrun = result.phases.find(phase => phase.durationMs > phaseTimeoutMs)
    if (overrun !== undefined) {
      throw new SelfDevelopmentError(
        `phase ${overrun.phaseId} ran ${overrun.durationMs} ms, over the approved phaseTimeoutMs ${phaseTimeoutMs}`,
        'SELF_DEV_LATE_RESULT',
      )
    }
  }
  if (approval?.maxStepsPerAttempt !== undefined && result.stepsUsed === undefined) {
    throw new SelfDevelopmentError('step observations are required by the approved step limit', 'SELF_DEV_INVALID_RESULT')
  }
  if (approval?.maxStepsPerAttempt !== undefined
    && result.stepsUsed !== undefined
    && result.stepsUsed > approval.maxStepsPerAttempt) {
    throw new SelfDevelopmentError(
      `attempt used ${result.stepsUsed} steps, over the approved maxStepsPerAttempt ${approval.maxStepsPerAttempt}`,
      'SELF_DEV_LATE_RESULT',
    )
  }
  const byCaseId = new Map(result.cases.map(caseResult => [caseResult.caseId, caseResult]))
  if (byCaseId.size !== result.cases.length) {
    throw new SelfDevelopmentError('test result contains duplicate case identities', 'SELF_DEV_INVALID_RESULT')
  }
  for (const caseResult of result.cases) {
    if (new Set(caseResult.assertions.map(assertion => assertion.assertionId)).size !== caseResult.assertions.length) {
      throw new SelfDevelopmentError('test result contains duplicate assertion identities', 'SELF_DEV_INVALID_RESULT')
    }
  }
  for (const requiredCase of plan.requiredCases) {
    const caseResult = byCaseId.get(requiredCase.caseId)
    if (caseResult === undefined) {
      throw new SelfDevelopmentError(
        `required case ${requiredCase.caseId} is missing from the result`,
        'SELF_DEV_INVALID_RESULT',
      )
    }
    const byAssertionId = new Map(caseResult.assertions.map(a => [a.assertionId, a.status]))
    for (const assertionId of requiredCase.assertionIds) {
      if (byAssertionId.get(assertionId) !== 'pass') {
        throw new SelfDevelopmentError(
          `required assertion ${requiredCase.caseId}/${assertionId} did not pass`
            + ` (status ${byAssertionId.get(assertionId) ?? 'missing'})`,
          'SELF_DEV_INVALID_RESULT',
        )
      }
    }
  }
  return digestJson(result)
}

/**
 * Fold one committed event into the task state. The fold is total: a valid
 * journal always replays to the same state, and an event that violates the
 * state machine throws, which the journal reader reports as corruption.
 * @param state - state before the event.
 * @param event - committed event to apply.
 * @returns the state after the event.
 * @throws SelfDevelopmentError with `SELF_DEV_INVALID_STATE` when the event cannot apply to the state.
 */
export function foldEvent(state: TaskFoldState, event: TaskEvent): TaskFoldState {
  const next = writableFold(state)
  switch (event.type) {
    case 'task/created': {
      if (state.spec !== undefined || state.status !== 'draft') {
        throw new SelfDevelopmentError('task/created cannot apply to an existing task', 'SELF_DEV_INVALID_STATE')
      }
      next.spec = event.spec
      next.revision += 1
      return next
    }
    case 'task/planning-authorized': {
      assertStatus(state, 'draft', 'task/planning-authorized')
      next.planningAuthorized = true
      next.status = 'planning-authorized'
      next.revision += 1
      return next
    }
    case 'plan/drafted': {
      assertStatus(state, 'planning-authorized', 'plan/drafted')
      next.status = 'awaiting-plan-confirmation'
      next.lastDraft = event.draft
      next.revision += 1
      return next
    }
    case 'plan/confirmed': {
      assertStatus(state, 'awaiting-plan-confirmation', 'plan/confirmed')
      if (state.lastDraft === undefined
        || draftContentDigest(event.plan) !== draftContentDigest(state.lastDraft)) {
        throw new SelfDevelopmentError(
          'plan confirmation does not match the human-visible draft content',
          'SELF_DEV_INVALID_PLAN',
        )
      }
      next.plan = event.plan
      next.lastDraft = undefined
      // A new frozen plan invalidates older verified results and trial approvals.
      next.verifiedResultDigest = undefined
      next.trialApproval = undefined
      next.status = 'awaiting-development-approval'
      next.revision += 1
      return next
    }
    case 'budget/approved': {
      if (state.status !== 'awaiting-development-approval' && state.status !== 'ready'
        && !(state.status === 'stopped' && state.stopReason === 'budget-exhausted')) {
        throw new SelfDevelopmentError(
          `budget/approved cannot apply in status ${state.status}`,
          'SELF_DEV_INVALID_STATE',
        )
      }
      next.approval = event.approval
      // Consumed rounds and time survive every budget revision by design.
      next.status = 'ready'
      next.stopReason = undefined
      next.revision += 1
      return next
    }
    case 'attempt/started': {
      assertStatus(state, 'ready', 'attempt/started')
      next.currentAttempt = event.attempt
      next.status = 'attempting'
      // The round is consumed at the durable start commit, never refunded.
      next.consumedRounds += 1
      next.verifiedResultDigest = undefined
      next.trialApproval = undefined
      next.revision += 1
      return next
    }
    case 'attempt/failed': {
      if (state.status !== 'attempting' || state.currentAttempt?.attemptId !== event.attemptId) {
        throw new SelfDevelopmentError(
          `attempt/failed cannot apply without the in-flight attempt ${event.attemptId}`,
          'SELF_DEV_INVALID_STATE',
        )
      }
      next.currentAttempt = undefined
      next.status = 'ready'
      applyTimeConsumption(next, event.elapsedMs, event.timeAccounting)
      next.noProgressCount = state.lastFailureDigest === event.failureDigest
        ? state.noProgressCount + 1
        : 1
      next.lastFailureDigest = event.failureDigest
      next.revision += 1
      return next
    }
    case 'task/passed': {
      if (state.status !== 'attempting' || state.currentAttempt?.attemptId !== event.attemptId) {
        throw new SelfDevelopmentError(
          `task/passed cannot apply without the in-flight attempt ${event.attemptId}`,
          'SELF_DEV_INVALID_STATE',
        )
      }
      next.currentAttempt = undefined
      next.status = 'awaiting-trial'
      next.verifiedResultDigest = event.resultDigest
      next.lastFailureDigest = undefined
      next.noProgressCount = 0
      applyTimeConsumption(next, event.elapsedMs, event.timeAccounting)
      next.revision += 1
      return next
    }
    case 'trial/approved': {
      assertStatus(state, 'awaiting-trial', 'trial/approved')
      if (state.verifiedResultDigest !== event.resultDigest) {
        throw new SelfDevelopmentError(
          'trial approval does not bind the current verified result',
          'SELF_DEV_INVALID_STATE',
        )
      }
      next.trialApproval = { approvedBy: event.approvedBy, resultDigest: event.resultDigest }
      next.revision += 1
      return next
    }
    case 'task/stopped': {
      if (!['draft', 'planning-authorized', 'awaiting-plan-confirmation', 'awaiting-development-approval',
        'ready', 'attempting', 'awaiting-trial'].includes(state.status)) {
        throw new SelfDevelopmentError(
          `task/stopped cannot apply in status ${state.status}`,
          'SELF_DEV_INVALID_STATE',
        )
      }
      next.status = 'stopped'
      next.stopReason = event.reason
      next.currentAttempt = undefined
      next.revision += 1
      return next
    }
    case 'handoff/raised': {
      if (state.status === 'handoff') {
        throw new SelfDevelopmentError('task is already in handoff', 'SELF_DEV_INVALID_STATE')
      }
      next.status = 'handoff'
      next.handoffReason = event.reason
      next.handoffDetail = event.detail
      next.currentAttempt = undefined
      next.revision += 1
      return next
    }
  }
}

/** Digest over the draft content a plan confirmation must repeat exactly. */
function draftContentDigest(draft: { readonly requiredCases: FrozenTestPlan['requiredCases']; readonly manualCases: FrozenTestPlan['manualCases'] }): string {
  return digestJson({ requiredCases: draft.requiredCases, manualCases: draft.manualCases })
}

/** Mutable copy of a fold state for the fold's local transition. */
function writableFold(state: TaskFoldState): { -readonly [K in keyof TaskFoldState]: TaskFoldState[K] } {
  return { ...state }
}

/** Add one finished attempt's run time, freezing the budget on uncertain intervals. */
function applyTimeConsumption(
  state: { -readonly [K in keyof TaskFoldState]: TaskFoldState[K] },
  elapsedMs: number,
  accounting: TimeAccounting,
): void {
  if (accounting === 'uncertain') {
    state.timeBudgetFrozen = true
    return
  }
  state.consumedTimeMs += elapsedMs
}

/** Reject an event that cannot apply in the given status. */
function assertStatus(
  state: TaskFoldState,
  expected: TaskFoldState['status'] | undefined,
  eventType: TaskEvent['type'],
): void {
  if (state.status !== expected) {
    throw new SelfDevelopmentError(
      `${eventType} cannot apply in status ${state.status}`,
      'SELF_DEV_INVALID_STATE',
    )
  }
}

/**
 * Decide whether a new attempt may start under the current approval and
 * consumed budget. Time and rounds are first-bound-wins: whichever limit the
 * budget exhausts first stops the task, and the other limit's remainder
 * never grants continuation.
 * @param state - current fold state.
 * @returns `allowed` with the rejection reason when starting is refused.
 */
export function checkAttemptBudget(state: TaskFoldState): { allowed: boolean; reason: string | undefined } {
  const approval = state.approval
  if (approval === undefined) return { allowed: false, reason: 'no approved budget' }
  if (state.timeBudgetFrozen) {
    return { allowed: false, reason: 'remaining time budget is frozen pending human review' }
  }
  if (approval.maxRounds !== undefined && state.consumedRounds >= approval.maxRounds) {
    return { allowed: false, reason: `round budget exhausted (${state.consumedRounds}/${approval.maxRounds})` }
  }
  if (approval.durationMs !== undefined && state.consumedTimeMs >= approval.durationMs) {
    return { allowed: false, reason: `time budget exhausted (${state.consumedTimeMs}/${approval.durationMs} ms)` }
  }
  return { allowed: true, reason: undefined }
}

/**
 * Account the run time of one finished attempt from two trusted observations.
 * @param startedAt - observation committed at attempt start.
 * @param finishedAt - observation taken when the attempt ended.
 * @returns the measured interval, or zero with `uncertain` across boot sessions.
 */
export function measureAttemptTime(
  startedAt: ClockObservation,
  finishedAt: ClockObservation,
): { elapsedMs: number; timeAccounting: TimeAccounting } {
  if (startedAt.bootId !== finishedAt.bootId || finishedAt.monotonicMs < startedAt.monotonicMs) {
    return { elapsedMs: 0, timeAccounting: 'uncertain' }
  }
  return { elapsedMs: finishedAt.monotonicMs - startedAt.monotonicMs, timeAccounting: 'measured' }
}
