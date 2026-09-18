import { runInNewContext } from 'node:vm'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { handleFileUploadHttp } from '../src/http-route.ts'
import type { FileUploads } from '../src/index.ts'

function request(input: {
  method?: string
  sessionId?: string
  name?: string
  contentType?: string
  body?: Uint8Array
  headers?: Record<string, string>
} = {}): Request {
  const query = new URLSearchParams()
  if (input.sessionId !== undefined) query.set('sessionId', input.sessionId)
  if (input.name !== undefined) query.set('name', input.name)
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  return new Request(`http://host/api/session/uploadFileBinary${suffix}`, {
    method: input.method ?? 'POST',
    headers: {
      ...(input.contentType === undefined ? {} : { 'content-type': input.contentType }),
      ...input.headers,
    },
    ...(input.body === undefined ? {} : { body: new Blob([Uint8Array.from(input.body).buffer]) }),
  })
}

function uploads(result: unknown): FileUploads & {
  uploadStream: Mock<FileUploads['uploadStream']>
  admitUpload: Mock<FileUploads['admitUpload']>
  uploadedChunks: Uint8Array[]
} {
  const uploadedChunks: Uint8Array[] = []
  const uploadStream = vi.fn<FileUploads['uploadStream']>(async (input) => {
    for await (const chunk of input.data) uploadedChunks.push(chunk)
    return await result as Awaited<ReturnType<FileUploads['uploadStream']>>
  })
  return {
    uploadedChunks,
    uploadStream,
    admitUpload: vi.fn(),
  } as unknown as FileUploads & {
    uploadStream: Mock<FileUploads['uploadStream']>
    admitUpload: Mock<FileUploads['admitUpload']>
    uploadedChunks: Uint8Array[]
  }
}

describe('background file upload Fetch route', () => {
  it('accepts one authenticated streaming POST request', async () => {
    const service = uploads(Promise.resolve({}))
    expect((await handleFileUploadHttp(service, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).status).toBe(200)
  })

  it('rejects the wrong method, media type, and missing Session id without storing', async () => {
    const service = uploads(Promise.resolve({}))
    const wrongMethod = await handleFileUploadHttp(service, request({ method: 'GET' }))
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')

    const wrongType = await handleFileUploadHttp(service, request({ contentType: 'application/json' }))
    expect(wrongType.status).toBe(415)
    expect(await wrongType.text()).toBe('content type must be application/octet-stream')

    const missingSession = await handleFileUploadHttp(
      service,
      request({ contentType: 'application/octet-stream' }),
    )
    expect(missingSession.status).toBe(400)
    expect(await missingSession.text()).toBe('sessionId is required')
    expect(service.uploadStream).not.toHaveBeenCalled()
  })

  it('stores the request bytes and returns the staged receipt', async () => {
    const value = {
      receiptId: 'receipt-1',
      file: { attachmentId: 'file-1', name: 'large & final.bin', bytes: 4 },
    }
    const service = uploads(Promise.resolve(value))
    const response = await handleFileUploadHttp(service, request({
      sessionId: 's1',
      name: 'large & final.bin',
      contentType: 'application/octet-stream; charset=binary',
      body: Uint8Array.of(1, 2, 3, 4),
    }))
    expect(service.uploadStream).toHaveBeenCalledOnce()
    const upload = service.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1', name: 'large & final.bin' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(service.uploadedChunks).toEqual([Uint8Array.of(1, 2, 3, 4)])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true, value })
  })

  it('returns business and internal storage failures and keeps an absent name absent', async () => {
    const business = uploads(Promise.reject(new RemoteError(
      'session/attachment-invalid', 'denied', { reason: 'NOPE' },
    )))
    const businessResponse = await handleFileUploadHttp(business, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))
    expect(business.uploadStream).toHaveBeenCalledOnce()
    const upload = business.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(business.uploadedChunks).toEqual([])
    expect(await businessResponse.json()).toEqual({
      ok: false,
      error: { code: 'session/attachment-invalid', message: 'denied', details: { reason: 'NOPE' } },
    })

    const internal = uploads(Promise.reject(new Error('disk offline')))
    expect(await (await handleFileUploadHttp(internal, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'disk offline', details: {} },
    })

    const foreignError = runInNewContext('new Error("disk exception")') as unknown as Error
    const exception = uploads(Promise.reject(foreignError))
    expect(await (await handleFileUploadHttp(exception, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'Error: disk exception', details: {} },
    })
  })

  it('rejects an over-limit declared Content-Length with 413 before reading the body', async () => {
    const service = uploads(Promise.resolve({}))
    service.admitUpload.mockImplementation(() => {
      throw new AttachmentError('File upload exceeds the configured byte limit.', 'FILE_TOO_LARGE')
    })
    const response = await handleFileUploadHttp(service, request({
      sessionId: 's1',
      contentType: 'application/octet-stream',
      body: Uint8Array.of(1, 2, 3, 4),
      headers: { 'content-length': '999999999' },
    }))
    expect(response.status).toBe(413)
    expect(service.uploadStream).not.toHaveBeenCalled()
    expect(service.uploadedChunks).toEqual([])
    expect(await response.text()).toBe('declared upload exceeds the configured byte limit')
  })

  it('rejects an unaccepted declared file type with 415 before reading the body', async () => {
    const service = uploads(Promise.resolve({}))
    service.admitUpload.mockImplementation(() => {
      throw new AttachmentError('File type application/x-hostile is not accepted by this deployment.', 'UNSUPPORTED_FILE_TYPE')
    })
    const response = await handleFileUploadHttp(service, request({
      sessionId: 's1',
      contentType: 'application/octet-stream',
      body: Uint8Array.of(1),
      headers: { 'x-dsh-file-type': 'application/x-hostile' },
    }))
    expect(response.status).toBe(415)
    expect(service.uploadStream).not.toHaveBeenCalled()
    expect(await response.text()).toBe('declared file type is not accepted by this deployment')
  })

  it('forwards the declared length and file type and refuses an invalid Content-Length', async () => {
    const service = uploads(Promise.resolve({}))
    const declared = await handleFileUploadHttp(service, request({
      sessionId: 's1',
      contentType: 'application/octet-stream',
      body: Uint8Array.of(1, 2),
      headers: { 'content-length': '2', 'x-dsh-file-type': 'Application/PDF ' },
    }))
    expect(declared.status).toBe(200)
    expect(service.admitUpload).toHaveBeenCalledWith({ bytes: 2, mediaType: 'application/pdf' })
    expect(service.uploadStream.mock.calls[0]?.[0]).toMatchObject({ declaredBytes: 2, mediaType: 'application/pdf' })

    const invalid = await handleFileUploadHttp(service, request({
      sessionId: 's1',
      contentType: 'application/octet-stream',
      headers: { 'content-length': 'many' },
    }))
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).toBe('content-length must be a byte count')
    expect(service.uploadStream).toHaveBeenCalledOnce()
  })

  it('propagates an unexpected admission failure instead of mapping it', async () => {
    const service = uploads(Promise.resolve({}))
    service.admitUpload.mockImplementation(() => {
      throw new Error('attachment store unavailable')
    })
    await expect(handleFileUploadHttp(service, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).rejects.toThrow('attachment store unavailable')
    expect(service.uploadStream).not.toHaveBeenCalled()
  })
})
