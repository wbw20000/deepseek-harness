/** Scheduled garbage collection against asynchronous session-derived reference sources. */

import { readFile, rm, mkdtemp, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalAttachmentStore from '../src/index.ts'

async function bytesOf(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}

describe('attachment garbage-reference source', () => {
  const homes: string[] = []
  const disposers: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (disposers.length > 0) await disposers.pop()?.().catch(() => {})
    while (homes.length > 0) await rm(homes.pop() as string, { recursive: true, force: true })
  })

  async function home(): Promise<string> {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-gc-source-'))
    homes.push(dshHome)
    return dshHome
  }

  async function backdate(path: string): Promise<void> {
    const stale = new Date(Date.now() - 60_000)
    await utimes(path, stale, stale)
  }

  function service(ctx: Context, dshHome: string, config: Record<string, unknown> = {}): LocalAttachmentStore {
    const store = new LocalAttachmentStore(ctx, { dshHome, ...config })
    disposers.push(() => ctx.fiber.dispose())
    return store
  }

  it('awaits an asynchronous reference source before collecting', async () => {
    const dshHome = await home()
    const ctx = new Context()
    const store = service(ctx, dshHome, { gcIntervalMs: 10, gcGracePeriodMs: 0 })
    const kept = await store.saveFile({ data: Uint8Array.of(1), name: 'kept.txt' })
    const dropped = await store.saveFile({ data: Uint8Array.of(2), name: 'dropped.txt' })
    await backdate(store.fileHostPath(dropped))
    store.setGarbageReferenceSource(() => Promise.resolve().then(() => [kept.attachmentId]))
    await vi.waitFor(async () => {
      await expect(readFile(store.fileHostPath(dropped))).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await expect(bytesOf(store.fileHostPath(kept))).resolves.toEqual(Uint8Array.of(1))
  })

  it('collects nothing while an asynchronous source resolves without references', async () => {
    const dshHome = await home()
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const store = service(ctx, dshHome, { gcIntervalMs: 5, gcGracePeriodMs: 0 })
    // Registered before the first tick so the run tests the undefined
    // resolution, not the missing-source warning.
    store.setGarbageReferenceSource(() => Promise.resolve<Iterable<AttachmentId> | undefined>(undefined))
    const ref = await store.saveFile({ data: Uint8Array.of(1), name: 'kept.txt' })
    await backdate(store.fileHostPath(ref))
    // A short sleep is the proof here: the assertion is that no collection
    // happens, which a polling wait cannot express.
    await new Promise(resolve => setTimeout(resolve, 40))
    await expect(bytesOf(store.fileHostPath(ref))).resolves.toEqual(Uint8Array.of(1))
    expect(warn).not.toHaveBeenCalled()
  })

  it('collects nothing and warns while the source throws', async () => {
    const dshHome = await home()
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const store = service(ctx, dshHome, { gcIntervalMs: 5, gcGracePeriodMs: 0 })
    const ref = await store.saveFile({ data: Uint8Array.of(1), name: 'kept.txt' })
    await backdate(store.fileHostPath(ref))
    store.setGarbageReferenceSource(() => {
      throw new Error('session corpus unavailable')
    })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('garbage-reference source failed'))
    })
    await expect(bytesOf(store.fileHostPath(ref))).resolves.toEqual(Uint8Array.of(1))
  })

  it('collects nothing and warns while the source hangs past its deadline', async () => {
    const dshHome = await home()
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const store = service(ctx, dshHome, { gcIntervalMs: 5, gcGracePeriodMs: 0, gcReferenceTimeoutMs: 10 })
    const ref = await store.saveFile({ data: Uint8Array.of(1), name: 'kept.txt' })
    await backdate(store.fileHostPath(ref))
    // A never-settling promise is the fixture; the deadline is the behavior under test.
    store.setGarbageReferenceSource(() => new Promise<Iterable<AttachmentId>>(() => {}))
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`exceeded ${store.gcReferenceTimeoutMs}ms`))
    })
    await expect(bytesOf(store.fileHostPath(ref))).resolves.toEqual(Uint8Array.of(1))
  })

  it('runs one pass at a time while an asynchronous pass is still reading', async () => {
    const dshHome = await home()
    const ctx = new Context()
    const store = service(ctx, dshHome, { gcIntervalMs: 5, gcGracePeriodMs: 0 })
    let calls = 0
    let release: (() => void) | undefined
    const gated = new Promise<Iterable<AttachmentId>>((resolve) => {
      release = () => { resolve([]) }
    })
    store.setGarbageReferenceSource(() => {
      calls += 1
      return calls === 1 ? gated : Promise.resolve([])
    })
    await vi.waitFor(() => {
      expect(calls).toBe(1)
    })
    // A short sleep is the proof here: the assertion is that no second pass
    // starts, which a polling wait cannot express.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(calls).toBe(1)
    release?.()
    await vi.waitFor(() => {
      expect(calls).toBeGreaterThan(1)
    })
  })
})
