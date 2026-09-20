/**
 * Trial-manager errors. The manager's own refusal decisions are real
 * `RemoteError`s, so the Gateway encodes their code and message onto the wire
 * unchanged. Facade rejections pass through unwrapped: the facade already
 * throws Remote errors with its own codes.
 * @module @deepseek-ai/dsh-workflow-self-development-trial/errors
 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** Every machine-routable code this manager throws itself. */
export type SelfDevelopmentTrialErrorCode =
  | 'self-development/config-invalid'
  | 'self-development/host-only-field'
  | 'self-development/task-unknown'
  | 'self-development/trial-unavailable'
  | 'self-development/trial-build-failed'
  | 'self-development/trial-port-exhausted'
  | 'self-development/trial-start-failed'
  | 'self-development/trial-stop-failed'

/**
 * Error the trial manager raises for its own refusal decisions: invalid
 * configuration, a non-host caller, a missing facade or data-home source, a
 * failed or timed-out worktree build, and an exhausted port range.
 */
export class SelfDevelopmentTrialError extends RemoteError<SelfDevelopmentTrialErrorCode> {
  override name = 'SelfDevelopmentTrialError'

  /**
   * @param code - machine-routable manager code declared in `RemoteErrorDetailsMap`.
   * @param message - human-readable refusal reason.
   */
  constructor(code: SelfDevelopmentTrialErrorCode, message: string) {
    super(code, message, {})
  }
}

/**
 * The message of a caught value, whatever it is: every throw site of this
 * manager raises `Error`s, but a rejection that arrived from outside (a
 * filesystem oddity, a host callback) may not.
 * @param error - the caught value.
 * @returns `error.message` for an `Error`, otherwise `String(error)`.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The service config or a Remote argument failed its shape validation at the manager boundary. */
    'self-development/config-invalid': {}
    /** A non-host caller invoked a trial operation; trial instances belong to the stable host. */
    'self-development/host-only-field': {}
    /** A call addressed a task that has no journal directory. */
    'self-development/task-unknown': {}
    /** A required source service (facade or runner data home) is not loaded. */
    'self-development/trial-unavailable': {}
    /** The worktree build failed or timed out; the trial log carries the output. */
    'self-development/trial-build-failed': {}
    /** Every port in the configured range is occupied. */
    'self-development/trial-port-exhausted': {}
    /** The web process could not spawn or never printed its readiness URL. */
    'self-development/trial-start-failed': {}
    /** The trial process group did not exit within the teardown deadline. */
    'self-development/trial-stop-failed': {}
  }
}
