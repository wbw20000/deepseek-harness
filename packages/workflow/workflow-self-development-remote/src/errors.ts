/**
 * Facade-local errors. Core and runner rejections are never wrapped: they
 * propagate verbatim so the caller sees the owning package's machine-routable
 * code. This class only carries the facade's own refusal decisions.
 * @module @deepseek-ai/dsh-workflow-self-development-remote/errors
 */

/** Every machine-routable code this facade throws itself. */
export type SelfDevelopmentRemoteErrorCode =
  | 'SELF_DEV_REMOTE_CONFIG_INVALID'
  | 'SELF_DEV_REMOTE_DISABLED'
  | 'SELF_DEV_REMOTE_ACTOR_FORBIDDEN'
  | 'SELF_DEV_REMOTE_PRESENCE_UNCONFIRMED'
  | 'SELF_DEV_REMOTE_RUNNER_UNAVAILABLE'
  | 'SELF_DEV_REMOTE_TASK_UNKNOWN'

/**
 * Error the remote facade raises for its own refusal decisions. A caller that
 * needs the underlying core or runner reason reads `code` on the rejection as
 * thrown by the owning package, never on this class.
 */
export class SelfDevelopmentRemoteError extends Error {
  override name = 'SelfDevelopmentRemoteError'

  /**
   * @param message - human-readable refusal reason.
   * @param code - machine-routable facade code.
   */
  constructor(message: string, readonly code: SelfDevelopmentRemoteErrorCode) {
    super(message)
  }
}
