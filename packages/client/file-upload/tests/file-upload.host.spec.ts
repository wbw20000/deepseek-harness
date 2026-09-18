/** FileUploads service behavior through the real streaming route and local attachment store. */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandFileReceiptResolver } from '@deepseek-ai/dsh-commands'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FileUploads from '../src/index.ts'
import type { FileUploadReceiptId } from '../src/types.ts'

function request(input: {
  sessionId?: string
  name?: string
  body?: string
  headers?: Record<string, string>
} = {}): Request {
  const query = new URLSearchParams()
  if (input.sessionId !== undefined) query.set('sessionId', input.sessionId)
  if (input.name !== undefined) query.set('name', input.name)
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  return new Request(`http://host/api/session/uploadFileBinary${suffix}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      ...input.headers,
    },
    ...(input.body === undefined ? {} : { body: new Blob([input.body]) }),
  })
}

interface Harness {
  ctx: Context
  uploads: FileUploads
  route: (request: Request) => Promise<Response>
  store: LocalAttachmentStore
  root: string
  register: (id: string, origin?: 'ordinary' | 'subagent') => Agent
  live: Map<string, Agent>
  receiptResolver: { current: CommandFileReceiptResolver | undefined }
}

describe('FileUploads service through the streaming route', () => {
  const homes: string[] = []
  const contexts: Context[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    while (contexts.length > 0) await contexts.pop()?.fiber.dispose()
    while (homes.length > 0) await rm(homes.pop() as string, { recursive: true, force: true })
  })

  async function harness(): Promise<Harness> {
    const home = await mkdtemp(join(tmpdir(), 'dsh-file-upload-'))
    homes.push(home)
    const ctx = new Context()
    contexts.push(ctx)
    // The byte limit stays tiny so every test payload exercises real admission.
    const store = new LocalAttachmentStore(ctx, { dshHome: home, maxUploadBytes: 8 })
    const live = new Map<string, Agent>()
    ctx.provide('agents', { get: (id: SessionId) => live.get(id) } as never)
    const receiptResolver: { current: CommandFileReceiptResolver | undefined } = { current: undefined }
    ctx.provide('commands', {
      registerFileReceiptResolver: (resolve: CommandFileReceiptResolver) => {
        receiptResolver.current = resolve
        return () => {
          if (receiptResolver.current === resolve) receiptResolver.current = undefined
        }
      },
    } as never)
    let route: ((request: Request) => Promise<Response>) | undefined
    ctx.provide('connection', {
      fetch: {
        register: (entry: { fetch: (request: Request) => Promise<Response> }) => {
          route = entry.fetch
          return () => {}
        },
      },
    } as never)
    const uploads = new FileUploads(ctx)
    if (route === undefined) throw new Error('file upload route was not registered')
    const register = (id: string, origin: 'ordinary' | 'subagent' = 'ordinary'): Agent => {
      const session = { id: SessionId(id), header: { origin } } as unknown as Session
      const agent = { id: SessionId(id), session } as unknown as Agent
      ;(agent as { ctx: Context }).ctx = createScope(ctx, agent).ctx
      live.set(id, agent)
      return agent
    }
    return { ctx, uploads, route, store, root: join(home, 'attachments', 'v1'), register, live, receiptResolver }
  }

  function stream(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
    return (async function* (): AsyncIterable<Uint8Array> {
      for (const chunk of chunks) yield chunk
    })()
  }

  it('stores a streamed upload with declared length and type through the real route', async () => {
    const h = await harness()
    const agent = h.register('s1')
    const saveFileStream = vi.spyOn(h.store, 'saveFileStream')
    const response = await h.route(request({
      sessionId: 's1',
      name: 'notes.txt',
      body: 'hello',
      headers: { 'content-length': '5', 'x-dsh-file-type': 'Text/Plain' },
    }))
    expect(response.status).toBe(200)
    const result = await response.json() as {
      ok: boolean
      value: { receiptId: FileUploadReceiptId; file: FileAttachmentRef }
    }
    expect(result.ok).toBe(true)
    expect(result.value.file).toMatchObject({ name: 'notes.txt', bytes: 5 })
    expect(saveFileStream).toHaveBeenCalledWith(expect.objectContaining({
      declaredBytes: 5,
      mediaType: 'text/plain',
    }))
    expect(h.uploads.resolve(agent, result.value.receiptId)).toEqual(result.value.file)
    await expect(readFile(h.store.fileHostPath(result.value.file))).resolves.toEqual(Buffer.from('hello'))
    expect(h.receiptResolver.current?.(agent, result.value.receiptId)).toEqual(result.value.file)
  })

  it('rejects an over-limit declared length through the real store before reading the body', async () => {
    const h = await harness()
    h.register('s1')
    const saveFileStream = vi.spyOn(h.store, 'saveFileStream')
    const response = await h.route(request({
      sessionId: 's1',
      body: 'hello',
      headers: { 'content-length': '9' },
    }))
    expect(response.status).toBe(413)
    expect(saveFileStream).not.toHaveBeenCalled()
    await expect(readdir(join(h.root, 'file-objects'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an unaccepted declared file type through the real store', async () => {
    const h = await harness()
    h.register('s1')
    const saveFileStream = vi.spyOn(h.store, 'saveFileStream')
    const response = await h.route(request({
      sessionId: 's1',
      body: 'hello',
      headers: { 'x-dsh-file-type': 'application/x-hostile' },
    }))
    expect(response.status).toBe(415)
    expect(saveFileStream).not.toHaveBeenCalled()
    await expect(readdir(join(h.root, 'file-objects'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('catches a lying Content-Length in the real store while counting the stream', async () => {
    const h = await harness()
    h.register('s1')
    const response = await h.route(request({
      sessionId: 's1',
      body: 'twelve-bytes',
      headers: { 'content-length': '2' },
    }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'session/attachment-invalid', details: { reason: 'FILE_TOO_LARGE' } },
    })
    await expect(readdir(join(h.root, 'file-objects'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(h.root, 'tmp'))).resolves.toEqual([])
  })

  it('passes declared length and type through uploadStream and keeps absent fields absent', async () => {
    const h = await harness()
    h.register('s1')
    const saveFileStream = vi.spyOn(h.store, 'saveFileStream')
    const declared = await h.uploads.uploadStream({
      sessionId: SessionId('s1'),
      data: stream(new Uint8Array(4)),
      signal: new AbortController().signal,
      name: 'a.bin',
      declaredBytes: 4,
      mediaType: 'text/plain',
    })
    expect(declared.file).toMatchObject({ name: 'a.bin', bytes: 4 })
    expect(saveFileStream).toHaveBeenLastCalledWith(expect.objectContaining({
      declaredBytes: 4,
      mediaType: 'text/plain',
    }))

    const bareData = stream(new Uint8Array(2))
    const bare = await h.uploads.uploadStream({ sessionId: SessionId('s1'), data: bareData })
    expect(bare.file).toMatchObject({ name: 'file', bytes: 2 })
    expect(saveFileStream).toHaveBeenLastCalledWith({ data: bareData })
  })

  it('stages encoded uploads and maps storage failures through the error vocabulary', async () => {
    const h = await harness()
    const agent = h.register('s1')
    const empty = await h.uploads.upload(agent, { data: '' }, new AbortController().signal)
    expect(empty.file).toMatchObject({ name: 'file', bytes: 0 })
    const named = await h.uploads.upload(agent, { data: 'aGVsbG8=', name: 'f.txt' }, new AbortController().signal)
    expect(named.file).toMatchObject({ name: 'f.txt', bytes: 5 })
    expect(h.uploads.resolve(agent, 'missing' as FileUploadReceiptId)).toBeUndefined()

    await expect(h.uploads.upload(agent, { data: 'not-base64!' }, new AbortController().signal))
      .rejects.toMatchObject({
        code: 'session/attachment-invalid',
        details: { reason: 'INVALID_FILE_BASE64' },
      })
    vi.spyOn(h.store, 'saveFile').mockRejectedValueOnce(new Error('disk offline'))
    await expect(h.uploads.upload(agent, { data: 'aGVsbG8=' }, new AbortController().signal))
      .rejects.toMatchObject({
        code: 'gateway/internal',
        message: 'failed to store file upload: Error: disk offline',
      })
    expect(h.uploads.resolve(agent, named.receiptId)).toEqual(named.file)
  })

  it('publishes no receipt when its exact Agent is no longer live during storage', async () => {
    const h = await harness()
    const agent = h.register('s1')
    h.live.delete('s1')
    await expect(h.uploads.upload(agent, { data: 'aGVsbG8=', name: 'late.bin' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/not-found', message: 'session "s1" was disposed before its file upload completed' })
    expect(h.uploads.resolve(agent, 'missing' as FileUploadReceiptId)).toBeUndefined()
  })

  it('resolves a cold Agent through the registered resolver and releases the registration', async () => {
    const h = await harness()
    const coldAgent = h.register('cold')
    h.live.delete('cold')
    const resolveAgent = vi.fn(async () => {
      h.live.set('cold', coldAgent)
      return coldAgent
    })
    const disposeResolver = h.uploads.registerAgentResolver(resolveAgent)
    expect(() => { h.uploads.registerAgentResolver(resolveAgent) }).toThrow('already registered')
    await expect(h.uploads.uploadStream({
      sessionId: SessionId('cold'),
      data: stream(new Uint8Array(1)),
    })).resolves.toMatchObject({ file: { bytes: 1 } })
    expect(resolveAgent).toHaveBeenCalledWith(SessionId('cold'))
    disposeResolver()

    const replacement = vi.fn(async () => coldAgent)
    const disposeReplacement = h.uploads.registerAgentResolver(replacement)
    disposeResolver()
    expect(() => { h.uploads.registerAgentResolver(replacement) }).toThrow('already registered')
    disposeReplacement()
  })

  it('rejects a cold upload when no Agent resolver is registered', async () => {
    const h = await harness()
    await expect(h.uploads.uploadStream({
      sessionId: SessionId('cold'),
      data: stream(),
    })).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('rejects subagent uploads and access outside the receiving Agent scope', async () => {
    const h = await harness()
    const child = h.register('s2', 'subagent')
    await expect(h.uploads.upload(child, { data: 'aGVsbG8=' }, new AbortController().signal))
      .rejects.toMatchObject({
        code: 'subagent/attachment-invalid',
        details: { reason: 'SUBAGENT_FILE_UNSUPPORTED' },
      })

    const agent = h.register('s1')
    const receipt = await h.uploads.upload(agent, { data: 'aGVsbG8=' }, new AbortController().signal)
    const foreignScope = { ...agent, ctx: h.ctx } as Agent
    expect(() => h.uploads.resolve(foreignScope, receipt.receiptId))
      .toThrow('operation requires the Agent\'s own scope')
  })

  it('binds prompt receipts, restores them on disposal, and refuses unknown receipts', async () => {
    const h = await harness()
    const agent = h.register('s1')
    const first = await h.uploads.upload(agent, { data: 'aGVsbG8=' }, new AbortController().signal)
    const second = await h.uploads.upload(agent, { data: 'aGVsbG8=' }, new AbortController().signal)
    expect(() => h.uploads.bindPrompt(agent, [first.receiptId, 'unknown' as FileUploadReceiptId], 'req-1'))
      .toThrow('File was not uploaded for this session.')
    expect(h.uploads.resolve(agent, first.receiptId)).toEqual(first.file)

    const binding = h.uploads.bindPrompt(agent, [first.receiptId, second.receiptId], 'req-1')
    binding[Symbol.dispose]()
    expect(h.uploads.resolve(agent, first.receiptId)).toEqual(first.file)

    const committed = h.uploads.bindPrompt(agent, [first.receiptId], 'req-2')
    committed.commit()
    committed[Symbol.dispose]()
    expect(h.receiptResolver.current?.(agent, first.receiptId)).toEqual(first.file)

    const rebound = h.uploads.bindPrompt(agent, [first.receiptId], 'req-3')
    rebound[Symbol.dispose]()
    h.uploads.retirePrompt(agent, 'req-2')
    expect(h.uploads.resolve(agent, first.receiptId)).toBeUndefined()
    expect(h.uploads.resolve(agent, second.receiptId)).toEqual(second.file)
    h.uploads.retirePrompt(agent, 'never-staged')

    const last = h.uploads.bindPrompt(agent, [second.receiptId], 'req-4')
    last.commit()
    h.uploads.retirePrompt(agent, 'req-4')
    expect(h.uploads.resolve(agent, second.receiptId)).toBeUndefined()
  })

  it('retires observed prompt receipts and drops staged state with the Session', async () => {
    const h = await harness()
    const other = h.register('s2')
    h.ctx.emit('session/event', other.session, {
      type: 'user/message',
      data: { source: { kind: 'user', rpcId: 'req-1' } },
    } as unknown as SessionEvent)

    const agent = h.register('s1')
    const observed = await h.uploads.upload(agent, { data: 'aGVsbG8=' }, new AbortController().signal)
    const observedBinding = h.uploads.bindPrompt(agent, [observed.receiptId], 'req-1')
    observedBinding.commit()
    const kept = await h.uploads.upload(agent, { data: 'aGVsbG8=' }, new AbortController().signal)
    const retained = h.uploads.bindPrompt(agent, [kept.receiptId], 'req-2')
    retained.commit()
    h.ctx.emit('session/event', agent.session, {
      type: 'session/start',
      data: {},
    } as unknown as SessionEvent)
    h.ctx.emit('session/event', agent.session, {
      type: 'user/message',
      data: { source: { kind: 'agent', rpcId: 'req-1' } },
    } as unknown as SessionEvent)
    h.ctx.emit('session/event', agent.session, {
      type: 'user/message',
      data: { source: { kind: 'user' } },
    } as unknown as SessionEvent)
    h.ctx.emit('session/event', agent.session, {
      type: 'user/message',
      data: { source: { kind: 'user', rpcId: 1 } },
    } as unknown as SessionEvent)
    expect(h.uploads.resolve(agent, observed.receiptId)).toEqual(observed.file)

    h.ctx.emit('session/event', agent.session, {
      type: 'user/message',
      data: { source: { kind: 'user', rpcId: 'req-1' } },
    } as unknown as SessionEvent)
    expect(h.uploads.resolve(agent, observed.receiptId)).toBeUndefined()
    expect(h.uploads.resolve(agent, kept.receiptId)).toEqual(kept.file)

    h.ctx.emit('session/disposed', agent.session)
    expect(h.uploads.resolve(agent, kept.receiptId)).toBeUndefined()
    expect(h.uploads.resolve(other, 'missing' as FileUploadReceiptId)).toBeUndefined()
  })
})
