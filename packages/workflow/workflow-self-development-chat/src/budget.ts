/** Budget selection validation and the mapping to the facade's budget-approval wire form. */

import { MAX_BUDGET_HOURS, ROUNDS_ATTEMPT_BOUNDS, UNLIMITED_BUDGET } from './config.ts'
import type { BudgetApprovalWire, ProposeBudget } from './types.ts'

/**
 * Validate one budget selection at the tool boundary. The tool schema DSL has
 * no numeric bounds, so the frozen `hours ≤ 24` limit and the positive-integer
 * rules are enforced here, before the approval card is shown.
 * @param budget - the budget the tool call selected.
 * @returns the violated rule as a human-readable reason, or `undefined` when the budget is valid.
 */
export function budgetViolation(budget: ProposeBudget): string | undefined {
  if ('preset' in budget) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- defends the config call site: z.any() gives no shape guarantee.
    return budget.preset === 'unlimited' ? undefined : `budget preset must be "unlimited", got ${JSON.stringify(budget.preset)}`
  }
  if (budget.mode === 'rounds') {
    return Number.isInteger(budget.maxRounds) && budget.maxRounds > 0
      ? undefined
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- same defensive reason as above.
      : `budget maxRounds must be a positive integer, got ${JSON.stringify(budget.maxRounds ?? null)}`
  }
  return typeof budget.hours === 'number' && Number.isFinite(budget.hours) && budget.hours > 0 && budget.hours <= MAX_BUDGET_HOURS
    ? undefined
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- same defensive reason as above.
    : `budget hours must be between 0 and ${MAX_BUDGET_HOURS}, got ${JSON.stringify(budget.hours ?? null)}`
}

/**
 * Map a validated budget selection to the facade's `approveBudget` wire form.
 * The `unlimited` preset carries the DH-a `preset` marker plus the expanded
 * time-budget fields, so the call is valid against the facade before and after
 * the DH-a wire change; explicit fields always win in the facade's expansion.
 * @param budget - the validated budget selection.
 * @param base - the plan and spec versions the approval binds, and the approving actor.
 * @returns the wire form handed to `approveBudget`.
 */
export function toBudgetApproval(
  budget: ProposeBudget,
  base: { readonly testPlanVersion: number; readonly taskSpecVersion: number; readonly approvedBy: string },
): BudgetApprovalWire {
  if ('preset' in budget) {
    return { preset: 'unlimited', mode: 'time', ...UNLIMITED_BUDGET, ...base }
  }
  if (budget.mode === 'rounds') {
    return {
      mode: 'rounds',
      maxRounds: budget.maxRounds,
      phaseTimeoutMs: ROUNDS_ATTEMPT_BOUNDS.phaseTimeoutMs,
      maxStepsPerAttempt: ROUNDS_ATTEMPT_BOUNDS.maxStepsPerAttempt,
      ...base,
    }
  }
  return {
    mode: 'time',
    durationMs: budget.hours * 3600 * 1000,
    noProgressAttemptLimit: UNLIMITED_BUDGET.noProgressAttemptLimit,
    ...base,
  }
}
