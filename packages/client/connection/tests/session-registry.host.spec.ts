/** Session registry semantics: issue, lookup, revoke, durability, and fail-closed persistence. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { SessionRegistry, type SessionRegistryStore, type StoredSessionRegistry } from '../src/session-registry.ts'
import { RecordCredentials } from './browser-credentials.ts'

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

afterEach(() => {
  vi.useRealTimers()
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
        { sessionId: 'expired', deviceLabel: 'old', issuedAt: 1, expiresAt: 2, revokedAt: undefined },
        { sessionId: 'live', deviceLabel: 'kept', issuedAt: 1, expiresAt: Date.now() + 1000, revokedAt: undefined },
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
})
