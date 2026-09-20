/** Shared normalization of a thrown facade/workspace error into the wire error view. */

import type { ProposeError } from './types.ts'

/**
 * Normalize one thrown error into {@link ProposeError}. Facade rejections that
 * wrap an owning package's original code carry it in `details.code` (the
 * remote facade's `self-development/core` convention: the generic wrapper
 * code sits on `.code`, the specific original code on `.details.code`), so
 * `details.code` is preferred when present; every other thrown shape falls
 * back to a top-level `.code`, then to no code at all.
 * @param error - the thrown value, of any shape.
 * @returns the normalized `{ code?, message }` view.
 */
export function errorOf(error: unknown): ProposeError {
  const candidate = error as
    | { readonly code?: unknown; readonly details?: { readonly code?: unknown }; readonly message?: unknown }
    | null
    | undefined
  const detailsCode = candidate?.details?.code
  const topCode = candidate?.code
  const code = typeof detailsCode === 'string' ? detailsCode : typeof topCode === 'string' ? topCode : undefined
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error)
  return {
    ...(code === undefined ? {} : { code }),
    message,
  }
}
