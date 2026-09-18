/** Authenticated raw-byte upload route registered on the Connection fetch registry. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { FileUploads } from './index.ts'
import type { FileUploadValue } from './types.ts'

type FileUploadHttpResult =
  | { readonly ok: true; readonly value: FileUploadValue }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: object }
  }

/**
 * Header carrying the uploaded file's declared media type. The transport
 * framing type stays `application/octet-stream`; this header declares what
 * the bytes represent and is checked against the deployment allowlist.
 */
export const FILE_TYPE_HEADER = 'x-dsh-file-type'

/**
 * Handle one authenticated raw-byte upload.
 * A declared `Content-Length` above the deployment byte limit or a declared
 * file type outside the deployment allowlist is rejected before any byte is
 * read or stored.
 * @param service - Host upload service receiving streamed bytes.
 * @param request - authenticated HTTP request from Connection.
 * @returns JSON result using HTTP status 200 after request validation, or 413/415 from write-ahead admission.
 */
export async function handleFileUploadHttp(service: FileUploads, request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/octet-stream') {
    return new Response('content type must be application/octet-stream', { status: 415 })
  }
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') {
    return new Response('sessionId is required', { status: 400 })
  }
  const declaredType = request.headers.get(FILE_TYPE_HEADER)?.trim().toLowerCase() || undefined
  const declaredBytes = declaredContentLength(request.headers.get('content-length'))
  if (declaredBytes === 'invalid') {
    return new Response('content-length must be a byte count', { status: 400 })
  }
  try {
    service.admitUpload({
      ...(declaredType === undefined ? {} : { mediaType: declaredType }),
      ...(declaredBytes === undefined ? {} : { bytes: declaredBytes }),
    })
  } catch (error) {
    return admissionFailure(error)
  }
  const name = url.searchParams.get('name') ?? undefined
  let result: FileUploadHttpResult
  try {
    result = {
      ok: true,
      value: await service.uploadStream({
        sessionId: brandString<SessionId>(sessionId),
        data: requestBodyChunks(request.body),
        signal: request.signal,
        ...(declaredType === undefined ? {} : { mediaType: declaredType }),
        ...(declaredBytes === undefined ? {} : { declaredBytes }),
        ...(name === undefined ? {} : { name }),
      }),
    }
  } catch (error) {
    const failure = remoteErrorOf(error)
    result = {
      ok: false,
      error: failure !== undefined
        ? { code: failure.code, message: failure.message, details: failure.details }
        : {
          code: 'gateway/internal',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
    }
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Map one write-ahead admission failure to its HTTP status.
 * @param error - failure raised by {@link FileUploads.admitUpload}.
 * @returns the refusal response; unexpected failures propagate.
 */
function admissionFailure(error: unknown): Response {
  const code = (error as { code?: unknown }).code
  if (code === 'FILE_TOO_LARGE') {
    return new Response('declared upload exceeds the configured byte limit', { status: 413 })
  }
  if (code === 'UNSUPPORTED_FILE_TYPE') {
    return new Response('declared file type is not accepted by this deployment', { status: 415 })
  }
  throw error
}

/**
 * Parse the declared request byte count.
 * @param value - raw `Content-Length` header value.
 * @returns the declared byte count, `undefined` when the header is absent, or `invalid`.
 */
function declaredContentLength(value: string | null): number | undefined | 'invalid' {
  if (value === null) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 'invalid'
  return parsed
}

async function* requestBodyChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (body === null) return
  const reader = body.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    reader.releaseLock()
  }
}
