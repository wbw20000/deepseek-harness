/**
 * Confirmation-card builder: turns one task projection into the read-only
 * view the M4 UI and the phone whitelist render. The card adds no approval,
 * suggestion, or balance of its own: an unknown cost balance stays refused
 * and a missing history source says so, in the fixed wording the human-review
 * card template requires.
 * @module @deepseek-ai/dsh-workflow-self-development-remote/card
 */

import type { TaskProjection } from '@deepseek-ai/dsh-workflow-self-development'
import type { BudgetApproval, CardBudget, ConfirmationCard, LaunchProfile } from './types.ts'

/** 建议预算及依据 fallback: this increment has no similar-task history source. */
const BUDGET_BASIS_UNAVAILABLE = '无依据'

/** 费用及调用限制 fallback: an unknown balance never auto-proceeds. */
const COST_LIMITS_UNKNOWN = '未知，不放行'

/** Characters of the requirement text shown as a task row title. */
export const TITLE_MAX_CHARS = 80

/**
 * Build the confirmation-card view of one projection.
 * @param taskId - task the projection belongs to.
 * @param projection - control state projected from the journal.
 * @param launchProfile - the task's stored launch profile, or `undefined` when the host has set none.
 * @returns the read-only card view.
 */
export function buildConfirmationCard(
  taskId: string,
  projection: TaskProjection,
  launchProfile?: LaunchProfile,
): ConfirmationCard {
  const { spec, plan, approval } = projection
  return {
    taskId,
    taskAndGoal: spec?.requirement ?? '',
    acceptanceCases: plan?.requiredCases ?? [],
    manualCases: plan?.manualCases ?? [],
    planningAuthorized: projection.planningAuthorized,
    suggestedBudgetBasis: BUDGET_BASIS_UNAVAILABLE,
    ...(spec === undefined ? {} : { stableBaselineDigest: spec.stableBaselineDigest }),
    allowedModificationScope: spec?.allowedModificationScope ?? [],
    budget: buildCardBudget(approval),
    consumedBudget: { rounds: projection.consumedRounds, timeMs: projection.consumedTimeMs },
    costLimits: COST_LIMITS_UNKNOWN,
    ...(launchProfile === undefined ? {} : { launchProfile }),
  }
}

/**
 * Project the approved budget onto the card's terms; absent terms mean the
 * field is not set.
 * @param approval - the current budget approval, or `undefined` before the first approval.
 * @returns the budget terms the card shows.
 */
function buildCardBudget(approval: BudgetApproval | undefined): CardBudget {
  if (approval === undefined) return {}
  return {
    mode: approval.mode,
    ...(approval.maxRounds === undefined ? {} : { maxRounds: approval.maxRounds }),
    ...(approval.durationMs === undefined ? {} : { durationMs: approval.durationMs }),
    ...(approval.phaseTimeoutMs === undefined ? {} : { phaseTimeoutMs: approval.phaseTimeoutMs }),
    ...(approval.maxStepsPerAttempt === undefined ? {} : { maxStepsPerAttempt: approval.maxStepsPerAttempt }),
    ...(approval.noProgressAttemptLimit === undefined
      ? {}
      : { noProgressAttemptLimit: approval.noProgressAttemptLimit }),
  }
}

/**
 * Trim a requirement text to the task-row title length.
 * @param requirement - requirement text from the spec.
 * @returns the first {@link TITLE_MAX_CHARS} characters, counted as code points.
 */
export function taskTitle(requirement: string): string {
  return Array.from(requirement).slice(0, TITLE_MAX_CHARS).join('')
}
