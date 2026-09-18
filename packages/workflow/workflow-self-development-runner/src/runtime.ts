/**
 * Runtime constructors and constants for the supervised runner: the boundary
 * error and its machine-routable codes.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/runtime
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Machine-routable error codes thrown at the supervised runner's boundaries. */
export const SelfDevelopmentRunnerErrorCode = [
  'SELF_DEV_RUNNER_CONFIG_INVALID',
  'SELF_DEV_RUNNER_WORKTREE_INVALID',
  'SELF_DEV_RUNNER_CLOCK_UNAVAILABLE',
  'SELF_DEV_RUNNER_ACCEPTANCE_INVALID',
  'SELF_DEV_RUNNER_EXECUTOR_FAILED',
  'SELF_DEV_RUNNER_EVIDENCE_FAILED',
  'SELF_DEV_RUNNER_EVIDENCE_CONFLICT',
  'SELF_DEV_RUNNER_EVIDENCE_INVALID',
  'SELF_DEV_RUNNER_PRESENCE_MISMATCH',
  'SELF_DEV_RUNNER_BUDGET_INVALID',
  'SELF_DEV_RUNNER_LAUNCH_MISMATCH',
  'SELF_DEV_RUNNER_ATTEMPT_ACTIVE',
] as const

/** One machine-routable supervised-runner failure code. */
export type SelfDevelopmentRunnerErrorCode = typeof SelfDevelopmentRunnerErrorCode[number]

/** Error thrown at the supervised runner's boundary. */
export class SelfDevelopmentRunnerError extends HarnessError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  // Keep the constructor to narrow HarnessError's string code at this boundary.
  // oxlint-disable-next-line typescript/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: SelfDevelopmentRunnerErrorCode) {
    super(message, code)
  }
}
