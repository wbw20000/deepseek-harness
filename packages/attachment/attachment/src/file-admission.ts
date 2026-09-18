/** Write-ahead admission for verbatim file uploads. @module @deepseek-ai/dsh-attachment/file-admission */

import { AttachmentError } from './error.ts'
import type { FileAdmissionLimits } from './types.ts'

/**
 * Media type assumed for an upload that declares none. Every client that
 * predates declared upload types sends raw bytes under this type, so the
 * default allowlist must contain it to keep those uploads working.
 */
export const UNDECLARED_FILE_MEDIA_TYPE = 'application/octet-stream'

/**
 * Default accepted media types for verbatim file uploads: images, text, and
 * common document formats. Deployments widen this with `type/*` entries or
 * the match-all wildcard; audio and video stay excluded by default because the
 * shipped attachment consumers are documents and screenshots.
 */
export const DEFAULT_ALLOWED_FILE_MIME_TYPES: readonly string[] = Object.freeze([
  'image/*',
  'text/*',
  'application/json',
  'application/pdf',
  'application/rtf',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  UNDECLARED_FILE_MEDIA_TYPE,
])

/**
 * Default maximum bytes accepted for one verbatim file upload. This matches
 * the buffered `/api` request-body cap (`DEFAULT_MAX_REQUEST_BODY_BYTES` in
 * `@deepseek-ai/dsh-client-connection`); the streaming upload route bypasses
 * that buffered cap, so file admission re-imposes the same bound here.
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 300 * 1024 * 1024

const MEDIA_TYPE_PATTERN = /^\*\/\*|[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/

/**
 * Resolve the effective media type of an upload that may declare none.
 * @param declared - caller-declared media type, when present.
 * @returns the lower-cased declared type, or the undeclared default.
 */
export function resolveFileMediaType(declared: string | undefined): string {
  const trimmed = declared?.trim().toLowerCase()
  return trimmed === undefined || trimmed === '' ? UNDECLARED_FILE_MEDIA_TYPE : trimmed
}

/**
 * Check one resolved media type against an allowlist entry. An entry may be
 * an exact type, a `type/*` wildcard, or the match-all wildcard.
 * @param mediaType - resolved lower-cased upload media type.
 * @param entry - allowlist entry.
 * @returns whether the entry accepts the media type.
 */
function matchesEntry(mediaType: string, entry: string): boolean {
  if (entry === '*/*') return true
  const slash = entry.indexOf('/')
  /* v8 ignore next -- allowlist entries are schema-validated to carry a slash before this runs. */
  if (slash < 0) return entry === mediaType
  if (entry.endsWith('/*')) return mediaType.startsWith(`${entry.slice(0, slash)}/`)
  return entry === mediaType
}

/**
 * Check one resolved media type against the deployment allowlist.
 * @param mediaType - resolved lower-cased upload media type.
 * @param allowed - deployment allowlist entries.
 * @returns whether any entry accepts the media type.
 */
export function isFileMediaTypeAllowed(mediaType: string, allowed: readonly string[]): boolean {
  return allowed.some(entry => matchesEntry(mediaType, entry))
}

/**
 * Validate allowlist entries before they can take effect. Misconfiguration
 * fails loud instead of silently rejecting every upload.
 * @param allowed - configured allowlist entries.
 * @throws an Error when an entry is not a media type or wildcard pattern.
 */
export function assertAllowedMediaTypes(allowed: readonly string[]): void {
  for (const entry of allowed) {
    if (!MEDIA_TYPE_PATTERN.test(entry)) {
      throw new Error(`attachment: allowedMimeTypes entry "${entry}" is not a media type or type/* wildcard`)
    }
  }
}

/**
 * Admit one verbatim file upload against the resolved policy. Callers invoke
 * this before any byte reaches storage so an over-limit declaration or an
 * unaccepted media type never creates a partial object.
 * @param request - declared byte count and media type; an omitted byte count
 * defers the size check to the stream itself, and an omitted media type resolves
 * to the undeclared default.
 * @param limits - deployment-resolved admission policy.
 * @throws an AttachmentError with `FILE_TOO_LARGE` or `UNSUPPORTED_FILE_TYPE`.
 */
export function admitFileUpload(
  request: { readonly bytes?: number; readonly mediaType?: string },
  limits: FileAdmissionLimits,
): void {
  if (request.bytes !== undefined && request.bytes > limits.maxUploadBytes) {
    throw new AttachmentError('File upload exceeds the configured byte limit.', 'FILE_TOO_LARGE')
  }
  const mediaType = resolveFileMediaType(request.mediaType)
  if (!isFileMediaTypeAllowed(mediaType, limits.allowedMimeTypes)) {
    throw new AttachmentError(`File type ${mediaType} is not accepted by this deployment.`, 'UNSUPPORTED_FILE_TYPE')
  }
}
