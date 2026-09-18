/** Write-ahead verbatim-file admission policy. */

import { describe, expect, it } from 'vitest'
import {
  admitFileUpload,
  assertAllowedMediaTypes,
  AttachmentError,
  DEFAULT_ALLOWED_FILE_MIME_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
  isAttachmentError,
  isFileAdmissionError,
  isFileMediaTypeAllowed,
  resolveFileMediaType,
  UNDECLARED_FILE_MEDIA_TYPE,
} from '../src/index.ts'
import type { FileAdmissionLimits } from '../src/index.ts'

const LIMITS: FileAdmissionLimits = {
  maxUploadBytes: 10,
  allowedMimeTypes: ['image/*', 'application/pdf', UNDECLARED_FILE_MEDIA_TYPE],
}

function admissionError(run: () => void): AttachmentError {
  try {
    run()
  } catch (error) {
    if (isAttachmentError(error)) return error
    throw error
  }
  throw new Error('expected the upload to be refused')
}

describe('verbatim file admission', () => {
  it('resolves an undeclared media type to the raw-bytes default', () => {
    expect(resolveFileMediaType(undefined)).toBe('application/octet-stream')
    expect(resolveFileMediaType('')).toBe('application/octet-stream')
    expect(resolveFileMediaType('   ')).toBe('application/octet-stream')
    expect(resolveFileMediaType('Application/PDF')).toBe('application/pdf')
  })

  it('matches exact entries, type wildcards, and the match-all wildcard', () => {
    expect(isFileMediaTypeAllowed('application/pdf', LIMITS.allowedMimeTypes)).toBe(true)
    expect(isFileMediaTypeAllowed('image/png', LIMITS.allowedMimeTypes)).toBe(true)
    expect(isFileMediaTypeAllowed('application/octet-stream', LIMITS.allowedMimeTypes)).toBe(true)
    expect(isFileMediaTypeAllowed('application/zip', LIMITS.allowedMimeTypes)).toBe(false)
    expect(isFileMediaTypeAllowed('text/plain', ['*/*'])).toBe(true)
    expect(isFileMediaTypeAllowed('text/plain', ['TEXT/*'])).toBe(false)
  })

  it('validates allowlist entries and rejects malformed ones', () => {
    expect(() => {
      assertAllowedMediaTypes(['image/*', 'application/pdf'])
    }).not.toThrow()
    expect(() => {
      assertAllowedMediaTypes(['not-a-media-type'])
    }).toThrow('allowedMimeTypes entry "not-a-media-type"')
    expect(() => {
      assertAllowedMediaTypes(['image//'])
    }).toThrow('allowedMimeTypes entry "image//"')
  })

  it('refuses an over-limit declaration and an unaccepted media type before any write', () => {
    expect(admissionError(() => {
      admitFileUpload({ bytes: 11, mediaType: 'application/pdf' }, LIMITS)
    })).toMatchObject({ code: 'FILE_TOO_LARGE' })
    expect(isFileAdmissionError(admissionError(() => {
      admitFileUpload({ bytes: 11, mediaType: 'application/pdf' }, LIMITS)
    }))).toBe(true)

    expect(admissionError(() => {
      admitFileUpload({ bytes: 5, mediaType: 'application/zip' }, LIMITS)
    })).toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' })
  })

  it('admits an in-limit undeclared upload and defers an absent byte count', () => {
    expect(() => {
      admitFileUpload({ bytes: 10 }, LIMITS)
    }).not.toThrow()
    expect(() => {
      admitFileUpload({ mediaType: 'application/pdf' }, LIMITS)
    }).not.toThrow()
    expect(() => {
      admitFileUpload({ bytes: 0, mediaType: 'image/png' }, LIMITS)
    }).not.toThrow()
  })

  it('keeps the documented defaults for the deployment policy', () => {
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(300 * 1024 * 1024)
    expect(DEFAULT_ALLOWED_FILE_MIME_TYPES).toContain('image/*')
    expect(DEFAULT_ALLOWED_FILE_MIME_TYPES).toContain('text/*')
    expect(DEFAULT_ALLOWED_FILE_MIME_TYPES).toContain('application/pdf')
    expect(DEFAULT_ALLOWED_FILE_MIME_TYPES).toContain('application/octet-stream')
  })
})
