/** Host garbage-reference wiring: Session-referenced attachments survive scheduled collection. */

import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AdmittedPromptContentPart, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { describe, expect, it, vi } from 'vitest'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

async function bytesOf(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}

/** Mutable persisted-session corpus double: tests write and delete sessions between passes. */
function mutablePersistence() {
  const sessions = new Map<SessionId, { readonly header: SessionHeader; readonly events: SessionEvent[] }>()
  let listingFailed = false
  const double = testSessionPersistence(new Context(), {
    list: (signal?: AbortSignal) => {
      signal?.throwIfAborted()
      if (listingFailed) return Promise.reject(new Error('persistence listing failed'))
      return Promise.resolve([...sessions.values()].map(entry => entry.header))
    },
    inspect: (sessionId: SessionId) => {
      const entry = sessions.get(sessionId)
      if (entry === undefined) return Promise.resolve(undefined)
      return Promise.resolve({ meta: entry.header, inheritedEventCount: 0, events: entry.events })
    },
  })
  return {
    add(header: SessionHeader, events: SessionEvent[]): void {
      sessions.set(header.id, { header, events })
    },
    remove(id: SessionId): void {
      sessions.delete(id)
    },
    failListing(): void {
      listingFailed = true
    },
    double,
  }
}

class SpecSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

async function harness(
  persistence: ReturnType<typeof mutablePersistence>,
): Promise<{ ctx: Context; store: LocalAttachmentStore; backdate: (path: string) => Promise<void> }> {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-session-gc-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.provide('sessionPersistence', persistence.double as never)
  const store = new LocalAttachmentStore(ctx, { dshHome, gcIntervalMs: 10, gcGracePeriodMs: 30_000 })
  if (ctx.get('sessionProjections') === undefined) new SessionProjectionRegistry(ctx)
  if (ctx.get('sessionQuery') === undefined) new SpecSessionQuery(ctx)
  createSessionTestController(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    cwd: '/workspace',
  })
  return {
    ctx,
    store,
    backdate: async (path: string): Promise<void> => {
      const stale = new Date(Date.now() - 60_000)
      await utimes(path, stale, stale)
    },
  }
}

function persistedHeader(id: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    cwd: '/workspace',
    isSeeded: false,
  }
}

/** One committed user message whose content carries an attachment reference. */
function persistedAttachmentEvent(
  blockType: 'image' | 'file',
  attachment: FileAttachmentRef | ImageAttachmentRef,
  seq: number,
): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: seq + 1,
    surfaceOp: 'append',
    data: {
      ...createUserMessage({
        content: [{ type: blockType, attachment }] as AdmittedPromptContentPart[],
        source: { kind: 'user' },
      }),
      id: MessageId(`gc-cold-${seq}`),
    },
  } as unknown as SessionEvent
}

describe('Session-controller attachment garbage references', () => {
  it('collects unreferenced attachments and keeps Session-referenced ones', async () => {
    const persistence = mutablePersistence()
    const { ctx, store, backdate } = await harness(persistence)
    const kept = await store.saveFile({ data: Uint8Array.of(1), name: 'kept.txt' })
    const dropped = await store.saveFile({ data: Uint8Array.of(2, 2), name: 'dropped.txt' })
    const session = ctx.sessions.create(SessionId('gc-live'), { meta: { cwd: '/workspace' } })
    session.append('user/message', createUserMessage({
      content: [{ type: 'file', attachment: kept }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    // Read the baseline before anything is collectable, so the measurement
    // cannot race the collection timer.
    const before = await store.usage()
    await backdate(store.fileHostPath(dropped))

    await vi.waitFor(async () => {
      await expect(readFile(store.fileHostPath(dropped))).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await expect(bytesOf(store.fileHostPath(kept))).resolves.toEqual(Uint8Array.of(1))
    const after = await store.usage()
    expect(after.usedBytes).toBe(before.usedBytes - 2)
    await ctx.fiber.dispose()
  })

  it('counts pending queued messages of registered Agents', async () => {
    const persistence = mutablePersistence()
    const { ctx, store, backdate } = await harness(persistence)
    const queued = await store.saveFile({ data: Uint8Array.of(3), name: 'queued.txt' })
    const dropped = await store.saveFile({ data: Uint8Array.of(4), name: 'dropped.txt' })
    await backdate(store.fileHostPath(dropped))

    const session = ctx.sessions.create(SessionId('gc-queue'), { meta: { cwd: '/workspace' } })
    const agent = {
      id: session.id,
      session,
      status: 'running',
      inbox: {
        nextTurn: [createUserMessage({
          content: [{ type: 'file', attachment: queued }],
          source: { kind: 'user' },
        })],
        nextStep: [],
      },
    } as unknown as Agent
    await ctx.agents.register(agent)

    await vi.waitFor(async () => {
      await expect(readFile(store.fileHostPath(dropped))).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await expect(bytesOf(store.fileHostPath(queued))).resolves.toEqual(Uint8Array.of(3))
    await ctx.fiber.dispose()
  })

  it('keeps cold persisted-session references and reclaims them after the session is deleted', async () => {
    const persistence = mutablePersistence()
    const { ctx, store, backdate } = await harness(persistence)
    const held = await store.saveFile({ data: Uint8Array.of(5), name: 'held.txt' })
    const dropped = await store.saveFile({ data: Uint8Array.of(6), name: 'dropped.txt' })
    const header = persistedHeader('gc-cold')
    persistence.add(header, [persistedAttachmentEvent('file', held, 0)])
    // Backdated only after the cold session references `held`, so the first
    // pass tests retention rather than racing the reference registration.
    await backdate(store.fileHostPath(held))
    await backdate(store.fileHostPath(dropped))

    await vi.waitFor(async () => {
      await expect(readFile(store.fileHostPath(dropped))).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await expect(bytesOf(store.fileHostPath(held))).resolves.toEqual(Uint8Array.of(5))

    persistence.remove(header.id)
    await vi.waitFor(async () => {
      await expect(readFile(store.fileHostPath(held))).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await ctx.fiber.dispose()
  })

  it('deletes nothing while the persisted-session listing fails', async () => {
    const persistence = mutablePersistence()
    const { ctx, store, backdate } = await harness(persistence)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const first = await store.saveFile({ data: Uint8Array.of(7), name: 'first.txt' })
    const second = await store.saveFile({ data: Uint8Array.of(8), name: 'second.txt' })
    // Failed before backdating, so no pass can see a healthy listing while
    // the objects are already collectable.
    persistence.failListing()
    await backdate(store.fileHostPath(first))
    await backdate(store.fileHostPath(second))

    // A short sleep is the proof here: the assertion is that nothing is
    // collected, which a polling wait cannot express.
    await new Promise(resolve => setTimeout(resolve, 60))
    await expect(bytesOf(store.fileHostPath(first))).resolves.toEqual(Uint8Array.of(7))
    await expect(bytesOf(store.fileHostPath(second))).resolves.toEqual(Uint8Array.of(8))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('attachment reference enumeration failed'))
    await ctx.fiber.dispose()
  })

  it('a newly created service counts a persisted session written by the previous fixture', async () => {
    const first = mutablePersistence()
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-session-gc-new-'))
    const ctxA = new Context()
    await ctxA.plugin(SessionStore)
    await ctxA.plugin(AgentRegistry)
    ctxA.provide('sessionPersistence', first.double as never)
    const storeA = new LocalAttachmentStore(ctxA, { dshHome })
    const held = await storeA.saveFile({ data: Uint8Array.of(9), name: 'held.txt' })
    first.add(persistedHeader('gc-restart'), [persistedAttachmentEvent('file', held, 0)])
    await ctxA.fiber.dispose()

    const ctxB = new Context()
    await ctxB.plugin(SessionStore)
    await ctxB.plugin(AgentRegistry)
    ctxB.provide('sessionPersistence', first.double as never)
    const storeB = new LocalAttachmentStore(ctxB, { dshHome, gcIntervalMs: 10, gcGracePeriodMs: 30_000 })
    const dropped = await storeB.saveFile({ data: Uint8Array.of(10), name: 'dropped.txt' })
    const stale = new Date(Date.now() - 60_000)
    await utimes(storeB.fileHostPath(dropped), stale, stale)
    if (ctxB.get('sessionProjections') === undefined) new SessionProjectionRegistry(ctxB)
    if (ctxB.get('sessionQuery') === undefined) new SpecSessionQuery(ctxB)
    createSessionTestController(ctxB, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd: '/workspace',
    })
    await vi.waitFor(async () => {
      await expect(readFile(storeB.fileHostPath(dropped))).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await expect(bytesOf(storeB.fileHostPath(held))).resolves.toEqual(Uint8Array.of(9))
    await ctxB.fiber.dispose()
    await rm(dshHome, { recursive: true, force: true })
  })

  it('logs and continues when the attachments service cannot register a reference source', async () => {
    const persistence = mutablePersistence()
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-session-gc-skip-'))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    ctx.provide('sessionPersistence', persistence.double as never)
    const info = vi.spyOn(ctx.logger, 'info')
    ctx.provide('attachments', { imageLimits: {} } as never)
    if (ctx.get('sessionProjections') === undefined) new SessionProjectionRegistry(ctx)
    if (ctx.get('sessionQuery') === undefined) new SpecSessionQuery(ctx)
    createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd: '/workspace',
    })
    expect(info).toHaveBeenCalledWith(expect.stringContaining('no setGarbageReferenceSource'))
    await ctx.fiber.dispose()
    await rm(dshHome, { recursive: true, force: true })
  })
})
