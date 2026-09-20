/**
 * Boundary error and its machine-routable codes for workspace allocation and
 * serialized integration.
 * @module @deepseek-ai/dsh-workflow-self-development-workspaces/runtime
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Machine-routable error codes thrown at the workspace service's boundaries. */
export const SelfDevelopmentWorkspacesErrorCode = [
  'SELF_DEV_WORKSPACE_CONFIG_INVALID',
  'SELF_DEV_WORKSPACE_TASK_INVALID',
  'SELF_DEV_WORKSPACE_LIMIT',
  'SELF_DEV_WORKSPACE_TASK_UNKNOWN',
  'SELF_DEV_WORKSPACE_ALLOC_FAILED',
  'SELF_DEV_WORKSPACE_SETUP_FAILED',
  'SELF_DEV_WORKSPACE_RELEASE_FAILED',
  'SELF_DEV_WORKSPACE_REGISTRY_INVALID',
  'SELF_DEV_WORKSPACE_GIT_FAILED',
  'SELF_DEV_WORKSPACE_INTEGRATION_BUSY',
] as const

/** One machine-routable workspace-service failure code. */
export type SelfDevelopmentWorkspacesErrorCode = typeof SelfDevelopmentWorkspacesErrorCode[number]

/** Error thrown at the workspace service's boundary. */
export class SelfDevelopmentWorkspacesError extends HarnessError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  // Keep the constructor to narrow HarnessError's string code at this boundary.
  // oxlint-disable-next-line typescript/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: SelfDevelopmentWorkspacesErrorCode) {
    super(message, code)
  }
}
