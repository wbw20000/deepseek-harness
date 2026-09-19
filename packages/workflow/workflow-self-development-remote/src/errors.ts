/**
 * Facade-local errors. The facade's own refusal decisions are real
 * `RemoteError`s, so the Gateway encodes their code and message onto the wire
 * unchanged. Core and runner rejections are never wrapped by this class: the
 * facade boundary converts them into the shared `self-development/core`
 * failure, which carries the owning package's machine-routable code in
 * `details.code` (see the facade's boundary conversion).
 * @module @deepseek-ai/dsh-workflow-self-development-remote/errors
 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SelfDevelopmentErrorCode } from '@deepseek-ai/dsh-workflow-self-development'
import type { SelfDevelopmentRunnerErrorCode } from '@deepseek-ai/dsh-workflow-self-development-runner'

/** Every machine-routable code this facade throws itself. */
export type SelfDevelopmentRemoteErrorCode =
  | 'self-development/config-invalid'
  | 'self-development/disabled'
  | 'self-development/actor-forbidden'
  | 'self-development/host-only-field'
  | 'self-development/presence-unconfirmed'
  | 'self-development/runner-unavailable'
  | 'self-development/task-unknown'

/**
 * Error the remote facade raises for its own refusal decisions. A caller that
 * needs the underlying core or runner reason reads `details.code` on the
 * `self-development/core` failure, never a field of this class.
 */
export class SelfDevelopmentRemoteError extends RemoteError<SelfDevelopmentRemoteErrorCode> {
  override name = 'SelfDevelopmentRemoteError'

  /**
   * @param code - machine-routable facade code declared in `RemoteErrorDetailsMap`.
   * @param message - human-readable refusal reason.
   */
  constructor(code: SelfDevelopmentRemoteErrorCode, message: string) {
    super(code, message, {})
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The service config or a Remote argument failed its shape validation at the facade boundary. */
    'self-development/config-invalid': {}
    /** The facade is not enabled; every method refuses. */
    'self-development/disabled': {}
    /** The operation's actor is not in the configured allowlist. */
    'self-development/actor-forbidden': {}
    /** A non-host caller invoked an isolation-setting operation or set a `hostOnly` wire field. */
    'self-development/host-only-field': {}
    /** `runAttempt` did not receive `presenceAcknowledged: true` literally. */
    'self-development/presence-unconfirmed': {}
    /** The method needs the supervised runner plugin, which is not loaded. */
    'self-development/runner-unavailable': {}
    /** A read path addressed a task that has no journal directory. */
    'self-development/task-unknown': {}
    /** A core or runner rejection converted at the facade boundary; `code` is the owning package's original code. */
    'self-development/core': { readonly code: SelfDevelopmentErrorCode | SelfDevelopmentRunnerErrorCode }
  }
}
