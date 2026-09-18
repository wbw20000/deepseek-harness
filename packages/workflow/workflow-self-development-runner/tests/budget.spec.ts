/**
 * Finite attempt budgets: deriving a budget from an approval and consumed
 * time, per-phase limits that shrink with the total remaining time, and
 * in-run deadlines that abort through an internal signal.
 * @module budget.spec
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { armDeadline, phaseLimitMs, planAttemptBudget } from '../src/budget.ts'
import type { AttemptBudget } from '../src/types.ts'
import { SelfDevelopmentRunnerError } from '../src/runtime.ts'
import { TaskSpecVersion, TestPlanVersion, type BudgetApproval } from '@deepseek-ai/dsh-workflow-self-development'

const base = {
  testPlanVersion: TestPlanVersion(1),
  taskSpecVersion: TaskSpecVersion(1),
  approvedBy: 'operator-1',
} as const

const ROUNDS_ONLY: BudgetApproval = {
  mode: 'rounds',
  maxRounds: 3,
  phaseTimeoutMs: 1000,
  maxStepsPerAttempt: 20,
  ...base,
}

/** Time-only approval: bounds the total run time, no phase bound. */
const timeOnly = (durationMs: number): BudgetApproval => ({ mode: 'time', durationMs, ...base })

/** Approval bounding both one phase and the total run time. */
const both = (phaseTimeoutMs: number, durationMs: number): BudgetApproval => ({ mode: 'both', phaseTimeoutMs, durationMs, ...base })

/** Rounds-only approval without a phase or total time bound. */
const roundsWithoutTimeBound = (): BudgetApproval => ({ mode: 'rounds', maxRounds: 3, ...base })

/** Error code of a thrown runner error, failing the test when none is thrown. */
const thrownCode = (run: () => void): string => {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(SelfDevelopmentRunnerError)
    return (error as SelfDevelopmentRunnerError).code
  }
  throw new Error('expected the call to throw')
}

describe('planAttemptBudget', () => {
  it('derives a rounds-only budget with no total remaining time', () => {
    const budget = planAttemptBudget(ROUNDS_ONLY, 0)
    expect(budget).toEqual({ phaseMs: 1000, totalRemainingMs: undefined, maxSteps: 20 })
    expect(phaseLimitMs(budget, 0)).toBe(1000)
    expect(phaseLimitMs(budget, 999)).toBe(1000)
  })

  it('derives a time-only budget whose phase limit is the total remaining time', () => {
    const budget = planAttemptBudget(timeOnly(5000), 2000)
    expect(budget).toEqual({ phaseMs: undefined, totalRemainingMs: 3000, maxSteps: undefined })
    expect(phaseLimitMs(budget, 0)).toBe(3000)
    expect(phaseLimitMs(budget, 1000)).toBe(2000)
  })

  it('derives a both-mode budget whose phase limit is the smaller side', () => {
    const phaseBound = planAttemptBudget(both(1000, 5000), 0)
    expect(phaseLimitMs(phaseBound, 0)).toBe(1000)
    const totalBound = planAttemptBudget(both(5000, 3000), 1000)
    expect(phaseLimitMs(totalBound, 0)).toBe(2000)
  })

  it('returns 0 when the total remaining time cannot start a phase', () => {
    const budget = planAttemptBudget(timeOnly(1000), 0)
    expect(phaseLimitMs(budget, 1000)).toBe(0)
    expect(phaseLimitMs(budget, 1500)).toBe(0)
  })

  it('ignores both undefined sides for a directly assembled budget', () => {
    const budget: AttemptBudget = { phaseMs: undefined, totalRemainingMs: undefined, maxSteps: undefined }
    expect(phaseLimitMs(budget, 0)).toBe(Number.POSITIVE_INFINITY)
  })

  it('rejects a missing approval', () => {
    expect(thrownCode(() => planAttemptBudget(undefined, 0))).toBe('SELF_DEV_RUNNER_BUDGET_INVALID')
  })

  it('rejects a budget that bounds neither a phase nor the total', () => {
    expect(thrownCode(() => planAttemptBudget(roundsWithoutTimeBound(), 0))).toBe('SELF_DEV_RUNNER_BUDGET_INVALID')
  })

  it.each([0, -1])('rejects a non-positive duration bound: %s', (durationMs) => {
    expect(thrownCode(() => planAttemptBudget({ ...ROUNDS_ONLY, durationMs }, 0))).toBe('SELF_DEV_RUNNER_BUDGET_INVALID')
  })

  it('rejects a total remaining time past the duration', () => {
    expect(thrownCode(() => planAttemptBudget({ ...ROUNDS_ONLY, durationMs: 500 }, 600))).toBe('SELF_DEV_RUNNER_BUDGET_INVALID')
  })

  it('rejects a duration that is not a finite bound', () => {
    expect(thrownCode(() => planAttemptBudget({ ...ROUNDS_ONLY, durationMs: Number.NaN }, 0))).toBe('SELF_DEV_RUNNER_BUDGET_INVALID')
    expect(thrownCode(() => planAttemptBudget({ ...ROUNDS_ONLY, durationMs: -5 }, 0))).toBe('SELF_DEV_RUNNER_BUDGET_INVALID')
  })

  it('rejects a phase timeout that is not a finite bound', () => {
    expect(thrownCode(() => planAttemptBudget({ ...ROUNDS_ONLY, phaseTimeoutMs: Number.POSITIVE_INFINITY }, 0))).toBe('SELF_DEV_RUNNER_BUDGET_INVALID')
    expect(thrownCode(() => planAttemptBudget({ ...ROUNDS_ONLY, phaseTimeoutMs: 0 }, 0))).toBe('SELF_DEV_RUNNER_BUDGET_INVALID')
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects consumed time that is not non-negative and finite: %s', (consumedTimeMs) => {
    expect(thrownCode(() => planAttemptBudget({ ...ROUNDS_ONLY, durationMs: 5000 }, consumedTimeMs))).toBe('SELF_DEV_RUNNER_BUDGET_INVALID')
  })
})

describe('phaseLimitMs', () => {
  it('rejects an elapsed time that is not non-negative and finite', () => {
    const budget = planAttemptBudget(ROUNDS_ONLY, 0)
    expect(thrownCode(() => phaseLimitMs(budget, -1))).toBe('SELF_DEV_RUNNER_BUDGET_INVALID')
    expect(thrownCode(() => phaseLimitMs(budget, Number.NaN))).toBe('SELF_DEV_RUNNER_BUDGET_INVALID')
    expect(thrownCode(() => phaseLimitMs(budget, Number.POSITIVE_INFINITY))).toBe('SELF_DEV_RUNNER_BUDGET_INVALID')
  })
})

describe('armDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts its internal signal when the limit elapses and reports the timeout', () => {
    const deadline = armDeadline(500, new AbortController().signal)
    expect(deadline.signal.aborted).toBe(false)
    vi.advanceTimersByTime(499)
    expect(deadline.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut()).toBe(true)
  })

  it('follows an external abort without reporting a timeout, and never flips afterwards', () => {
    const external = new AbortController()
    const deadline = armDeadline(500, external.signal)
    external.abort()
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(deadline.timedOut()).toBe(false)
  })

  it('aborts immediately for an already-aborted external signal', () => {
    const external = new AbortController()
    external.abort()
    const deadline = armDeadline(500, external.signal)
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut()).toBe(false)
  })

  it('keeps timedOut true when the external signal aborts after the deadline fired', () => {
    const external = new AbortController()
    const deadline = armDeadline(500, external.signal)
    vi.advanceTimersByTime(500)
    expect(deadline.timedOut()).toBe(true)
    external.abort()
    expect(deadline.timedOut()).toBe(true)
  })

  it('keeps the signal un-aborted after dispose, and dispose stays idempotent', () => {
    const deadline = armDeadline(500, new AbortController().signal)
    deadline.dispose()
    vi.advanceTimersByTime(1000)
    expect(deadline.signal.aborted).toBe(false)
    expect(() => {
      deadline.dispose()
    }).not.toThrow()
  })

  it('stays disposable after the deadline already fired', () => {
    const deadline = armDeadline(500, new AbortController().signal)
    vi.advanceTimersByTime(500)
    expect(() => {
      deadline.dispose()
    }).not.toThrow()
    expect(deadline.timedOut()).toBe(true)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects a limit that is not a positive finite number: %s', (limitMs) => {
    expect(thrownCode(() => armDeadline(limitMs, new AbortController().signal))).toBe('SELF_DEV_RUNNER_BUDGET_INVALID')
  })
})
