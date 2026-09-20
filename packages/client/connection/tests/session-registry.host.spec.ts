/** Session registry semantics: issue, lookup, revoke, durability, and fail-closed persistence. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import {
  SESSION_REGISTRY_RECORD_KEY,
  SessionRegistry,
  credentialSessionRegistryStore,
  type SessionRegistryStore,
  type StoredSessionRegistry,
} from '../src/session-registry.ts'
import { RecordCredentials } from './browser-credentials.ts'

/** Temporary credentials homes to remove after the run. */
const dirs: string[] = []

/** Store double with controllable load/save behavior. */
class MemoryStore implements SessionRegistryStore {
  snapshot: StoredSessionRegistry | undefined
  loadError: Error | undefined = undefined
  saveError: unknown = undefined
  saves = 0

  constructor(snapshot?: StoredSessionRegistry) {
    this.snapshot = snapshot
  }

  load(): Promise<StoredSessionRegistry | undefined> {
    if (this.loadError !== undefined) return Promise.reject(this.loadError)
    return Promise.resolve(this.snapshot)
  }

  async save(snapshot: StoredSessionRegistry): Promise<void> {
    this.saves += 1
    if (this.saveError !== undefined) throw this.saveError
    this.snapshot = snapshot
  }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('SessionRegistry', () => {
  it('issues, reads, lists, and revokes sessions', async () => {
    const store = new MemoryStore()
    const registry = new SessionRegistry(store)
    await registry.loaded
    const issued = await registry.issue('phone', Date.now() + 60_000)
    expect(issued.deviceLabel).toBe('phone')
    expect(issued.revokedAt).toBeUndefined()
    expect(await registry.get(issued.sessionId)).toMatchObject({ deviceLabel: 'phone' })
    expect(await registry.get('unknown')).toBeUndefined()
    expect(registry.lookup('unknown')).toBeUndefined()
    expect(await registry.list()).toEqual([issued])

    expect(await registry.revoke(issued.sessionId)).toBe(true)
    expect(typeof (await registry.get(issued.sessionId))?.revokedAt).toBe('number')
    expect(await registry.revoke(issued.sessionId)).toBe(false)
    expect(await registry.revoke('unknown')).toBe(false)
    await registry.flush()
    expect(store.snapshot).toMatchObject({ version: 1 })
  })

  it('rejects invalid labels and expiries before registering anything', async () => {
    const registry = new SessionRegistry(new MemoryStore())
    await registry.loaded
    await expect(registry.issue('', Date.now() + 1000)).rejects.toThrow(/deviceLabel/u)
    await expect(registry.issue('phone', Date.now() - 1)).rejects.toThrow(/expiresAt/u)
    expect(() => registry.issueSync('phone', Date.now() - 1)).toThrow(/expiresAt/u)
    expect(await registry.list()).toEqual([])
  })

  it('drops expired registrations on load and at issue time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const store = new MemoryStore({
      version: 1,
      sessions: [
        { sessionId: 'expired', deviceLabel: 'old', issuedAt: 1, expiresAt: 2, revokedAt: undefined, certificateSerial: undefined },
        { sessionId: 'live', deviceLabel: 'kept', issuedAt: 1, expiresAt: Date.now() + 1000, revokedAt: undefined, certificateSerial: undefined },
      ],
    })
    const registry = new SessionRegistry(store)
    await registry.loaded
    expect((await registry.list()).map(session => session.sessionId)).toEqual(['live'])

    registry.issueSync('short', Date.now() + 1)
    vi.setSystemTime(new Date(Date.now() + 5_000))
    const next = registry.issueSync('fresh', Date.now() + 60_000)
    expect((await registry.list()).map(session => session.sessionId)).toEqual([next.sessionId])
  })

  it('rewrites a corrupt or unreadable snapshot as an empty registry', async () => {
    const corruptSnapshots: unknown[] = [
      { version: 2, sessions: [] },
      { version: 1, sessions: [{ sessionId: '', deviceLabel: 'x', issuedAt: 1, expiresAt: 2 }] },
      { version: 1, sessions: [{ sessionId: 's', deviceLabel: 'x', issuedAt: 'now', expiresAt: 2 }] },
    ]
    const cases: ReadonlyArray<{ snapshot?: StoredSessionRegistry; loadError?: Error }> = [
      ...corruptSnapshots.map(snapshot => ({ snapshot: snapshot as StoredSessionRegistry })),
      { loadError: new Error('unreadable store') },
    ]
    for (const broken of cases) {
      const store = new MemoryStore()
      if (broken.snapshot !== undefined) store.snapshot = broken.snapshot
      if (broken.loadError !== undefined) store.loadError = broken.loadError
      const registry = new SessionRegistry(store)
      await registry.loaded
      expect(await registry.list()).toEqual([])
      await registry.flush()
      expect(store.snapshot).toMatchObject({ version: 1, sessions: [] })
    }
  })

  it('latches a failed corrupt-snapshot rewrite and raises it at the next write', async () => {
    const store = new MemoryStore({ version: 2, sessions: [] } as unknown as StoredSessionRegistry)
    store.saveError = 'store is read-only'
    const registry = new SessionRegistry(store)
    await registry.loaded
    expect(await registry.list()).toEqual([])
    await expect(registry.flush()).rejects.toBe('store is read-only')
    store.saveError = undefined
    await expect(registry.issue('phone', Date.now() + 60_000)).resolves.toBeDefined()
  })

  it('keeps a valid snapshot across reloads, including tombstones', async () => {
    const store = new MemoryStore()
    const first = new SessionRegistry(store)
    await first.loaded
    const issued = await first.issue('phone', Date.now() + 60_000)
    await first.revoke(issued.sessionId)

    const second = new SessionRegistry(store)
    await second.loaded
    expect(typeof (await second.get(issued.sessionId))?.revokedAt).toBe('number')
  })

  it('binds a certificate serial at issue and revokes every session of one serial', async () => {
    const store = new MemoryStore()
    const registry = new SessionRegistry(store)
    await registry.loaded

    const bound = await registry.issue('phone', Date.now() + 60_000, '1a2b3c4d')
    const boundSync = registry.issueSync('phone-2', Date.now() + 60_000, '1a2b3c4d')
    const unbound = await registry.issue('desktop', Date.now() + 60_000)
    expect(bound.certificateSerial).toBe('1a2b3c4d')
    expect(unbound.certificateSerial).toBeUndefined()
    expect((await registry.list()).map(session => session.certificateSerial))
      .toEqual(['1a2b3c4d', '1a2b3c4d', undefined])

    // An unknown serial revokes nothing and writes nothing (the five saves so
    // far are the three issues; `issue` flushes its internal `issueSync`).
    expect(await registry.revokeBySerial('ffff')).toEqual([])
    expect(store.saves).toBe(5)
    expect(await registry.revokeBySerial('1a2b3c4d')).toEqual([bound.sessionId, boundSync.sessionId])
    expect((await registry.get(bound.sessionId))?.revokedAt).toBeDefined()
    expect((await registry.get(boundSync.sessionId))?.revokedAt).toBeDefined()
    expect((await registry.get(unbound.sessionId))?.revokedAt).toBeUndefined()
    // Already-revoked sessions are not reported twice.
    expect(await registry.revokeBySerial('1a2b3c4d')).toEqual([])
    await registry.flush()
    expect(store.snapshot?.sessions.every(session => session.certificateSerial === '1a2b3c4d'
      ? session.revokedAt !== undefined
      : true)).toBe(true)
  })

  it('rejects malformed certificate serials at issue and at serial revocation', async () => {
    const registry = new SessionRegistry(new MemoryStore())
    await registry.loaded
    for (const invalid of ['1A2B', '0x1a2b', 'g', '1a 2b', 'f'.repeat(65)]) {
      await expect(registry.issue('phone', Date.now() + 60_000, invalid)).rejects.toThrow(/certificateSerial/u)
      expect(() => registry.issueSync('phone', Date.now() + 60_000, invalid)).toThrow(/certificateSerial/u)
    }
    expect(await registry.list()).toEqual([])
    await expect(registry.revokeBySerial('1A2B')).rejects.toThrow(/certificateSerial/u)
  })

  it('keeps bound serials across reloads and rewrites a snapshot with a malformed serial', async () => {
    const store = new MemoryStore()
    const first = new SessionRegistry(store)
    await first.loaded
    const issued = await first.issue('phone', Date.now() + 60_000, '1a2b3c4d')
    const reloaded = new SessionRegistry(store)
    await reloaded.loaded
    expect(await reloaded.get(issued.sessionId)).toMatchObject({ certificateSerial: '1a2b3c4d' })

    // A snapshot entry with a malformed serial is corrupt: fail closed and
    // rewrite empty, exactly like every other structural defect.
    const corrupt = new MemoryStore({
      version: 1,
      sessions: [{ sessionId: 's', deviceLabel: 'x', issuedAt: 1, expiresAt: 2, revokedAt: undefined, certificateSerial: '1A2B' }],
    } as unknown as StoredSessionRegistry)
    const restarted = new SessionRegistry(corrupt)
    await restarted.loaded
    expect(await restarted.list()).toEqual([])
    await restarted.flush()
    expect(corrupt.snapshot).toMatchObject({ version: 1, sessions: [] })
  })

  it('raises a failed durable write to the next caller and to flush', async () => {
    const store = new MemoryStore()
    const registry = new SessionRegistry(store)
    await registry.loaded
    store.saveError = 'credentials file is not writable'

    // issueSync commits to memory and latches the write failure.
    const session = registry.issueSync('phone', Date.now() + 60_000)
    expect(await registry.get(session.sessionId)).toBeDefined()
    await expect(registry.flush()).rejects.toBe('credentials file is not writable')
    await expect(registry.issue('phone', Date.now() + 60_000)).rejects.toBe('credentials file is not writable')

    store.saveError = undefined
    expect(await registry.issue('phone', Date.now() + 60_000)).toMatchObject({ deviceLabel: 'phone' })
    expect(await registry.revoke(session.sessionId)).toBe(true)
    expect(store.saves).toBeGreaterThan(1)

    // An awaited failure is surfaced exactly once.
    store.saveError = 'credentials file is not writable'
    await expect(registry.issue('again', Date.now() + 60_000)).rejects.toBe('credentials file is not writable')
    store.saveError = undefined
    await expect(registry.issue('again', Date.now() + 60_000)).resolves.toMatchObject({ deviceLabel: 'again' })
  })

  it('persists through the credentials-backed store beside the signing secret', async () => {
    const { credentialSessionRegistryStore } = await import('../src/session-registry.ts')
    const credentials = new RecordCredentials()
    const registry = new SessionRegistry(credentialSessionRegistryStore(credentials as unknown as CredentialProvider))
    await registry.loaded
    const issued = await registry.issue('phone', Date.now() + 60_000)
    await credentials.settle()

    const reloaded = new SessionRegistry(credentialSessionRegistryStore(credentials as unknown as CredentialProvider))
    await reloaded.loaded
    expect(await reloaded.get(issued.sessionId)).toMatchObject({ deviceLabel: 'phone' })

    credentials.writeError = new Error('credentials file is not writable')
    await expect(reloaded.revoke(issued.sessionId)).rejects.toThrow('credentials file is not writable')
    // The in-memory revocation stands even though the durable write failed.
    expect((await reloaded.get(issued.sessionId))?.revokedAt).toBeDefined()
  })

  it('persists snapshots the real local credentials document accepts, unset fields omitted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-session-registry-'))
    dirs.push(dir)
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })

    const registry = new SessionRegistry(credentialSessionRegistryStore(ctx.credentials))
    await registry.loaded

    // Two unbound issues in a row, as two browser logins do: neither may latch
    // a write failure for the next login to trip over.
    const first = await registry.issue('phone', Date.now() + 60_000)
    await registry.issue('desktop', Date.now() + 60_000)
    await registry.flush()

    const payload = grantPayload(await ctx.credentials.readRecord(SESSION_REGISTRY_RECORD_KEY))
    expect(payload.sessions.map(session => (session as { deviceLabel: string }).deviceLabel))
      .toEqual(['phone', 'desktop'])
    // Unset fields are absent, not `undefined`; reading back, a missing key is
    // `undefined`, so the stored form round-trips through JSON unchanged.
    const storedFirst = payload.sessions[0] as Record<string, unknown> | undefined
    expect(storedFirst?.revokedAt).toBeUndefined()
    expect(storedFirst?.certificateSerial).toBeUndefined()
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
    expect(await readFile(join(dir, '.credentials.yaml'), 'utf8')).toContain('browser-sessions')

    // A revocation adds a numeric revokedAt and the snapshot stays writable.
    expect(await registry.revoke(first.sessionId)).toBe(true)
    await registry.flush()
    const revokedPayload = grantPayload(await ctx.credentials.readRecord(SESSION_REGISTRY_RECORD_KEY))
    const revokedSessions = revokedPayload.sessions as Array<Record<string, unknown> | undefined>
    expect(typeof revokedSessions[0]?.revokedAt).toBe('number')
    expect(revokedSessions[0]?.certificateSerial).toBeUndefined()
    expect(JSON.parse(JSON.stringify(revokedPayload))).toEqual(revokedPayload)
    await expect(registry.issue('third', Date.now() + 60_000)).resolves.toBeDefined()
    await registry.flush()
  })
})

/** The grant payload behind the browser-sessions record, or a failure naming the defect. */
function grantPayload(record: { kind?: string; payload?: unknown } | undefined): { sessions: unknown[] } {
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('browser-sessions credential record is not a grant object')
  }
  return record.payload as { sessions: unknown[] }
}
