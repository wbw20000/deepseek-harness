/**
 * Finite time budgets for one supervised attempt: derive the attempt's bounds
 * from a human-approved budget and the task's consumed run time, shrink each
 * phase limit by the time already spent, and arm in-run deadlines that abort
 * an internal signal when a limit elapses. Every bound is enforced while the
 * attempt runs, not only judged after it ends.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/budget
 */

import { SelfDevelopmentRunnerError } from './runtime.ts'
import type { AttemptBudget } from './types.ts'
import type { BudgetApproval } from '@deepseek-ai/dsh-workflow-self-development'

/**
 * Whether `value` is a non-negative finite number of milliseconds.
 * @param value - number to classify.
 * @returns true when value is finite and not negative.
 */
function isNonNegativeFiniteMs(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

/**
 * Whether `value` is a positive finite number of milliseconds.
 * @param value - number to classify.
 * @returns true when value is finite and greater than zero.
 */
function isPositiveFiniteMs(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

/**
 * Derive one attempt's finite bounds from the approved budget and the task's
 * already consumed run time. A budget that bounds neither a phase nor the
 * total is refused before anything launches, and so is a total that is
 * already spent.
 * @param approval - human-approved budget, or `undefined` when none was given.
 * @param consumedTimeMs - milliseconds the task already consumed; must be
 *   non-negative and finite.
 * @returns the derived attempt budget.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_BUDGET_INVALID` when the approval is
 *   missing, `phaseTimeoutMs` or `durationMs` is present but not a positive
 *   finite bound, both derived bounds would be `undefined`, the total
 *   remaining time is not positive, or `consumedTimeMs` is negative,
 *   `NaN`, or infinite.
 */
export function planAttemptBudget(approval: BudgetApproval | undefined, consumedTimeMs: number): AttemptBudget {
  if (approval === undefined) {
    throw new SelfDevelopmentRunnerError('attempt budget requires an approval', 'SELF_DEV_RUNNER_BUDGET_INVALID')
  }
  if (!isNonNegativeFiniteMs(consumedTimeMs)) {
    throw new SelfDevelopmentRunnerError(
      `consumed time ${consumedTimeMs} must be non-negative and finite`,
      'SELF_DEV_RUNNER_BUDGET_INVALID',
    )
  }
  const phaseMs = approval.phaseTimeoutMs
  if (phaseMs !== undefined && !isPositiveFiniteMs(phaseMs)) {
    throw new SelfDevelopmentRunnerError(`phase timeout ${phaseMs} must be positive and finite`, 'SELF_DEV_RUNNER_BUDGET_INVALID')
  }
  const { durationMs } = approval
  if (durationMs !== undefined && !isPositiveFiniteMs(durationMs)) {
    throw new SelfDevelopmentRunnerError(`duration ${durationMs} must be positive and finite`, 'SELF_DEV_RUNNER_BUDGET_INVALID')
  }
  const totalRemainingMs = durationMs === undefined ? undefined : durationMs - consumedTimeMs
  if (phaseMs === undefined && totalRemainingMs === undefined) {
    throw new SelfDevelopmentRunnerError(
      'attempt budget must bound a phase or the total run time; an unbounded run is refused',
      'SELF_DEV_RUNNER_BUDGET_INVALID',
    )
  }
  if (totalRemainingMs !== undefined && totalRemainingMs <= 0) {
    throw new SelfDevelopmentRunnerError(
      `total remaining run time ${totalRemainingMs} is spent; the task must stop instead of launching`,
      'SELF_DEV_RUNNER_BUDGET_INVALID',
    )
  }
  return { phaseMs, totalRemainingMs, maxSteps: approval.maxStepsPerAttempt }
}

/**
 * Milliseconds one phase may still run: the smaller of the approved phase
 * bound and the total remaining time minus the time already spent in earlier
 * phases. A non-positive result means the deadline already passed and the
 * caller must not start the phase.
 * @param budget - the attempt's derived budget.
 * @param elapsedBeforePhaseMs - milliseconds spent before this phase starts;
 *   must be non-negative and finite.
 * @returns the phase's millisecond limit, `0` when it already passed, and
 *   `Number.POSITIVE_INFINITY` when the budget bounds neither side.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_BUDGET_INVALID` when `elapsedBeforePhaseMs`
 *   is negative, `NaN`, or infinite.
 */
export function phaseLimitMs(budget: AttemptBudget, elapsedBeforePhaseMs: number): number {
  if (!isNonNegativeFiniteMs(elapsedBeforePhaseMs)) {
    throw new SelfDevelopmentRunnerError(
      `elapsed-before-phase ${elapsedBeforePhaseMs} must be non-negative and finite`,
      'SELF_DEV_RUNNER_BUDGET_INVALID',
    )
  }
  let limit = Number.POSITIVE_INFINITY
  if (budget.phaseMs !== undefined) limit = Math.min(limit, budget.phaseMs)
  if (budget.totalRemainingMs !== undefined) limit = Math.min(limit, budget.totalRemainingMs - elapsedBeforePhaseMs)
  return limit <= 0 ? 0 : limit
}

/**
 * One armed in-run deadline. The `signal` aborts when the limit elapses or
 * the external signal aborts; `timedOut()` is true only when the limit itself
 * elapsed, never for an external abort. `dispose()` clears the timer and the
 * external listener and stays idempotent.
 */
export interface ArmedDeadline {
  /** Internal signal that aborts at the limit or with the external signal. */
  readonly signal: AbortSignal
  /**
   * Whether the limit itself elapsed and aborted the internal signal.
   * @returns true only when the limit elapsed.
   */
  timedOut(): boolean
  /**
   * Clear the timer and the external-signal listener so the deadline never
   * aborts afterwards. Safe to call more than once.
   */
  dispose(): void
}

/**
 * Arm an in-run deadline: after `limitMs` the internal signal aborts and
 * `timedOut()` reports the timeout. An external signal that is already
 * aborted — or aborts later — aborts the internal signal immediately, keeps
 * `timedOut()` false, and cancels the timer.
 * @param limitMs - positive finite milliseconds before the deadline fires.
 * @param external - signal whose abort cancels the deadline without
 *   reporting a timeout.
 * @returns the armed deadline; dispose it when the phase ends.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_BUDGET_INVALID` when `limitMs` is not a
 *   positive finite number.
 */
export function armDeadline(limitMs: number, external: AbortSignal): ArmedDeadline {
  if (!isPositiveFiniteMs(limitMs)) {
    throw new SelfDevelopmentRunnerError(`deadline limit ${limitMs} must be positive and finite`, 'SELF_DEV_RUNNER_BUDGET_INVALID')
  }
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancelTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const onExternalAbort = (): void => {
    cancelTimer()
    if (!controller.signal.aborted) controller.abort()
  }
  if (external.aborted) {
    onExternalAbort()
  } else {
    timer = setTimeout(() => {
      timer = undefined
      timedOut = true
      controller.abort()
    }, limitMs)
    external.addEventListener('abort', onExternalAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      cancelTimer()
      external.removeEventListener('abort', onExternalAbort)
    },
  }
}
