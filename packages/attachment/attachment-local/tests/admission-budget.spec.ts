/** Attachment admission, disk-budget reservation, and garbage-collection behavior. */

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalAttachmentStore from '../src/index.ts'

async function bytesOf(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
}

async function raster(): Promise<Uint8Array> {
  return new Uint8Array(await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer())
}

function chunks(...sizes: number[]): AsyncIterable<Uint8Array> {
  return (async function* (): AsyncIterable<Uint8Array> {
    for (const size of sizes) yield new Uint8Array(size)
  })()
}

function filled(size: number, value: number): AsyncIterable<Uint8Array> {
  return (async function* (): AsyncIterable<Uint8Array> {
    yield new Uint8Array(size).fill(value)
  })()
}

describe('attachment admission and disk budget', () => {
  const homes: string[] = []

  afterEach(async () => {
    while (homes.length > 0) {
      await rm(homes.pop() as string, { recursive: true, force: true })
    }
  })

  async function home(): Promise<string> {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-attachment-admission-'))
    homes.push(dshHome)
    return dshHome
  }

  function store(dshHome: string, config: Record<string, unknown> = {}): LocalAttachmentStore {
    return new LocalAttachmentStore(new Context(), { dshHome, ...config })
  }

  async function firstReservationRecord(dshHome: string): Promise<string> {
    const entries = await readdir(join(root(dshHome), 'reservations'))
    return join(root(dshHome), 'reservations', entries[0] as string)
  }

  function root(dshHome: string): string {
    return join(dshHome, 'attachments', 'v1')
  }

  async function backdate(path: string): Promise<void> {
    const stale = new Date(Date.now() - 60_000)
    await utimes(path, stale, stale)
  }

  it('exposes the documented defaults for the new configuration fields', () => {
    const resolved = LocalAttachmentStore.Config({}) as Record<string, unknown>
    expect(resolved.maxUploadBytes).toBe(300 * 1024 * 1024)
    expect(resolved.diskBudgetBytes).toBe(0)
    expect(resolved.budgetWarnRatio).toBe(0.8)
    expect(resolved.gcIntervalMs).toBe(0)
    expect(resolved.gcGracePeriodMs).toBe(24 * 60 * 60 * 1000)
    expect(resolved.allowedMimeTypes).toContain('application/octet-stream')
  })

  it('rejects a misconfigured warning ratio and malformed allowlist entries at load', async () => {
    const dshHome = await home()
    expect(() => store(dshHome, { budgetWarnRatio: 0 })).toThrow('budgetWarnRatio')
    expect(() => store(dshHome, { budgetWarnRatio: 1.5 })).toThrow('budgetWarnRatio')
    expect(() => store(dshHome, { allowedMimeTypes: ['garbage'] })).toThrow('allowedMimeTypes')
    expect(() => LocalAttachmentStore.Config({ budgetWarnRatio: 0 })).toThrow('greater than 0')
    expect(LocalAttachmentStore.Config({ budgetWarnRatio: 1 })).toMatchObject({ budgetWarnRatio: 1 })
  })

  it('refuses an over-limit verbatim file before writing any byte', async () => {
    const dshHome = await home()
    const service = store(dshHome, { maxUploadBytes: 4 })
    await expect(service.saveFile({ data: new Uint8Array(5), name: 'big.bin' }))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await expect(service.saveFileStream({
      data: chunks(3, 3),
      declaredBytes: 6,
      name: 'big.bin',
    })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await expect(readdir(root(dshHome))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an unaccepted declared media type and accepts the default raw-bytes type', async () => {
    const dshHome = await home()
    const service = store(dshHome)
    await expect(service.saveFile({
      data: Uint8Array.of(1),
      name: 'song.mp3',
      mediaType: 'audio/mpeg',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' })
    await expect(service.saveFileStream({
      data: chunks(1),
      mediaType: 'audio/mpeg',
      name: 'song.mp3',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' })
    const ref = await service.saveFile({ data: Uint8Array.of(1, 2), name: 'raw.bin' })
    expect(ref.bytes).toBe(2)
    const text = await service.saveFile({
      data: Uint8Array.of(3),
      name: 'notes.txt',
      mediaType: 'text/plain',
    })
    expect(text.bytes).toBe(1)
  })

  it('counts an undeclared or under-declared stream and deletes the partial staging file', async () => {
    const dshHome = await home()
    const service = store(dshHome, { maxUploadBytes: 8 })
    await expect(service.saveFileStream({ data: chunks(4, 4, 4), name: 'liar.bin' }))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await expect(service.saveFileStream({ data: chunks(4, 4, 4), declaredBytes: 2, name: 'liar.bin' }))
      .rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    const staging = join(root(dshHome), 'tmp')
    const leftovers = await readdir(staging).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    })
    expect(leftovers).toEqual([])
    await expect(readdir(join(root(dshHome), 'file-objects'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stores a zero-byte upload and keeps hostile display names inside the store', async () => {
    const dshHome = await home()
    const service = store(dshHome)
    const empty = await service.saveFileStream({ data: chunks(), name: 'empty.bin' })
    expect(empty.bytes).toBe(0)
    expect(empty.name).toBe('empty.bin')

    const traversal = await service.saveFile({ data: Uint8Array.of(9), name: '../../../etc/passwd' })
    const windowsTraversal = await service.saveFileStream({
      data: chunks(1),
      name: '..\\..\\..\\windows\\system.ini',
    })
    for (const ref of [traversal, windowsTraversal]) {
      expect(service.fileHostPath(ref)?.startsWith(root(dshHome))).toBe(true)
      expect(service.fileHostPath(ref)).not.toContain('..')
    }
    expect(traversal.name).toBe('passwd')
    expect(windowsTraversal.name).toBe('system.ini')

    const sameName = await service.saveFile({ data: Uint8Array.of(1), name: 'notes.bin' })
    const sameNameAgain = await service.saveFile({ data: Uint8Array.of(1, 2), name: 'notes.bin' })
    expect(sameName.attachmentId).not.toBe(sameNameAgain.attachmentId)
    for (const ref of [sameName, sameNameAgain]) {
      await expect(readFile(service.fileHostPath(ref))).resolves.toBeDefined()
    }
  })

  it('refuses uploads beyond the disk budget before writing and releases capacity on failure', async () => {
    const dshHome = await home()
    const service = store(dshHome, { diskBudgetBytes: 100 })
    await expect(service.saveFile({ data: new Uint8Array(101), name: 'over.bin' }))
      .rejects.toMatchObject({ code: 'DISK_BUDGET_EXCEEDED' })
    await expect(readdir(root(dshHome), { withFileTypes: true }).then(entries => entries.map(e => e.name)))
      .resolves.toEqual(['reservations'])

    const controller = new AbortController()
    async function* abortedUpload(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(30)
      controller.abort(new Error('client went away'))
      yield new Uint8Array(30)
    }
    const aborted = service.saveFileStream({
      data: abortedUpload(),
      declaredBytes: 60,
      name: 'aborted.bin',
      signal: controller.signal,
    }).catch((error: unknown) => error)
    expect(await aborted).toMatchObject({ message: 'client went away' })
    await expect(service.saveFile({ data: new Uint8Array(50), name: 'fits.bin' }))
      .resolves.toMatchObject({ bytes: 50 })
    await expect(readdir(join(root(dshHome), 'reservations'))).resolves.toEqual([])
    await expect(readdir(join(root(dshHome), 'tmp')).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    })).resolves.toEqual([])
  })

  it('keeps concurrent reservations within the budget and admits uploads again after release', async () => {
    const dshHome = await home()
    const service = store(dshHome, { diskBudgetBytes: 100 })
    const uploads = [0, 1, 2, 3].map(index => service.saveFileStream({
      data: filled(40, index + 1),
      declaredBytes: 40,
      name: `concurrent-${index}.bin`,
    }).then(
      () => 'stored' as const,
      (error: unknown) => (error as { code?: string }).code,
    ))
    const results = await Promise.all(uploads)
    expect(results.filter(code => code === 'stored')).toHaveLength(2)
    expect(results.filter(code => code === 'DISK_BUDGET_EXCEEDED')).toHaveLength(2)

    // The two stored uploads keep 80 budget bytes occupied; released
    // reservations leave exactly 20 more for a new upload.
    await expect(service.saveFile({ data: new Uint8Array(21), name: 'over.bin' }))
      .rejects.toMatchObject({ code: 'DISK_BUDGET_EXCEEDED' })
    await expect(service.saveFile({ data: new Uint8Array(20), name: 'refill.bin' }))
      .resolves.toMatchObject({ bytes: 20 })
  })

  it('charges undeclared streams against the budget while they grow', async () => {
    const dshHome = await home()
    const service = store(dshHome, { diskBudgetBytes: 50 })
    // One stream grows while the other is parked, so each refusal is
    // deterministic: the budget refuses a grow that would push the shared
    // total past 50 bytes, and the parked stream fails when it resumes.
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    async function* parkedUpload(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(30)
      await gate
      yield new Uint8Array(30)
    }
    const parked = service.saveFileStream({ data: parkedUpload(), name: 'parked.bin' })
      .catch((error: unknown) => (error as { code?: string }).code)
    await vi.waitFor(async () => {
      const entries = await readdir(join(root(dshHome), 'reservations'))
      expect(entries).toHaveLength(1)
    }, 2_000)
    const growing = await service.saveFileStream({ data: chunks(10, 10, 10, 10), name: 'growing.bin' })
      .then(
        () => 'stored' as const,
        (error: unknown) => (error as { code?: string }).code,
      )
    expect(growing).toBe('DISK_BUDGET_EXCEEDED')
    releaseGate?.()
    expect(await parked).toBe('DISK_BUDGET_EXCEEDED')
    await expect(readdir(join(root(dshHome), 'reservations'))).resolves.toEqual([])
  })

  it('includes stored bytes in the budget check and clears the reservation ledger after saves', async () => {
    const dshHome = await home()
    const service = store(dshHome, { diskBudgetBytes: 100 })
    await service.saveFile({ data: new Uint8Array(60), name: 'first.bin' })
    await expect(service.saveFile({ data: new Uint8Array(41), name: 'second.bin' }))
      .rejects.toMatchObject({ code: 'DISK_BUDGET_EXCEEDED' })
    await expect(service.saveFile({ data: new Uint8Array(40), name: 'third.bin' }))
      .resolves.toMatchObject({ bytes: 40 })
    await expect(readdir(join(root(dshHome), 'reservations'))).resolves.toEqual([])
  })

  it('reports usage against the budget with warning and over-budget flags', async () => {
    const dshHome = await home()
    const service = store(dshHome)
    await service.saveFile({ data: new Uint8Array(30), name: 'a.bin' })
    const unlimited = await service.usage()
    expect(unlimited.usedBytes).toBe(30)
    expect(unlimited.budgetBytes).toBe(0)
    expect(unlimited.overBudgetWarn).toBe(false)
    expect(unlimited.overBudget).toBe(false)

    const tightened = store(dshHome, { diskBudgetBytes: 40, budgetWarnRatio: 0.5 })
    const usage = await tightened.usage()
    expect(usage.budgetBytes).toBe(40)
    expect(usage.overBudgetWarn).toBe(true)
    expect(usage.overBudget).toBe(false)
    await expect(tightened.saveFile({ data: new Uint8Array(60), name: 'b.bin' }))
      .rejects.toMatchObject({ code: 'DISK_BUDGET_EXCEEDED' })
  })

  it('warns once per threshold crossing through the context logger', async () => {
    const dshHome = await home()
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const service = new LocalAttachmentStore(ctx, { dshHome, diskBudgetBytes: 100, budgetWarnRatio: 0.5 })
    const warned = await service.saveFile({ data: new Uint8Array(60), name: 'warned.bin' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0])).toMatch(/budget/)
    await backdate(service.fileHostPath(warned))

    await service.saveFile({ data: new Uint8Array(10), name: 'still-warned.bin' })
    expect(warn).toHaveBeenCalledTimes(1)

    await service.collectGarbage({ referenced: [], olderThanMs: 0 })
    const usage = await service.usage()
    expect(usage.usedBytes).toBe(0)

    await service.saveFile({ data: new Uint8Array(5), name: 'back-below.bin' })
    expect(warn).toHaveBeenCalledTimes(1)
    await service.saveFile({ data: new Uint8Array(60), name: 'crossing-again.bin' })
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('keeps a reservation record beside the store and drops it on release', async () => {
    const dshHome = await home()
    const service = store(dshHome, { diskBudgetBytes: 100 })
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    async function* heldUpload(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(4)
      await gate
      yield new Uint8Array(6)
    }
    const saving = service.saveFileStream({
      data: heldUpload(),
      declaredBytes: 10,
      name: 'recorded.bin',
    })
    try {
      await vi.waitFor(async () => {
        const entries = await readdir(join(root(dshHome), 'reservations'))
        expect(entries).toHaveLength(1)
        // The record holds the declared reservation while the stream is held.
        const record = JSON.parse(
          await readFile(join(root(dshHome), 'reservations', entries[0] as string), 'utf8'),
        ) as { bytes: number }
        expect(record.bytes).toBe(10)
      }, 2_000)
    } finally {
      releaseGate?.()
    }
    await saving
    await expect(readdir(join(root(dshHome), 'reservations'))).resolves.toEqual([])
  })

  it('cleans orphan reservation records and staging files left by a crashed process', async () => {
    const dshHome = await home()
    await mkdir(join(root(dshHome), 'reservations'), { recursive: true })
    await mkdir(join(root(dshHome), 'tmp'), { recursive: true })
    await writeFile(join(root(dshHome), 'reservations', 'orphan.json'), '{"bytes":50}\n')
    await writeFile(join(root(dshHome), 'tmp', 'orphan-staging'), 'partial bytes')

    const service = store(dshHome, { diskBudgetBytes: 60 })
    await expect(service.saveFile({ data: new Uint8Array(40), name: 'after-crash.bin' }))
      .resolves.toMatchObject({ bytes: 40 })
    await expect(readdir(join(root(dshHome), 'reservations'))).resolves.toEqual([])
    await expect(readdir(join(root(dshHome), 'tmp'))).resolves.toEqual([])
  })

  it('cleans crash orphans at startup even when the budget is disabled', async () => {
    const dshHome = await home()
    await mkdir(join(root(dshHome), 'reservations'), { recursive: true })
    await mkdir(join(root(dshHome), 'tmp'), { recursive: true })
    await writeFile(join(root(dshHome), 'reservations', 'orphan.json'), '{"bytes":50}\n')
    await writeFile(join(root(dshHome), 'tmp', 'orphan-staging'), 'partial bytes')

    const service = store(dshHome)
    await vi.waitFor(async () => {
      await expect(readdir(join(root(dshHome), 'reservations'))).resolves.toEqual([])
      await expect(readdir(join(root(dshHome), 'tmp'))).resolves.toEqual([])
    })
    await expect(service.saveFile({ data: new Uint8Array(8), name: 'budgetless.bin' }))
      .resolves.toMatchObject({ bytes: 8 })
  })

  it('warns instead of crashing when startup orphan cleanup fails', async () => {
    const dshHome = await home()
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    await mkdir(join(root(dshHome), 'tmp'), { recursive: true })
    await chmod(join(root(dshHome), 'tmp'), 0o000)
    try {
      new LocalAttachmentStore(ctx, { dshHome })
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/startup orphan cleanup failed/))
      })
      await ctx.fiber.dispose()
    } finally {
      await chmod(join(root(dshHome), 'tmp'), 0o700)
    }
  })

  it('collects unreferenced objects past the grace period together with their file aliases', async () => {
    const dshHome = await home()
    const service = store(dshHome)
    const kept = await service.saveFile({ data: Uint8Array.of(1, 2, 3), name: 'kept.txt' })
    const dropped = await service.saveFile({ data: Uint8Array.of(4, 5), name: 'dropped.txt' })
    const image = await service.saveImage({ data: await raster(), mediaType: 'image/png' })
    await backdate(service.fileHostPath(dropped))
    await backdate(service.fileHostPath(kept))
    // A sibling object keeps the shard alive, so the shard prune must
    // tolerate a non-empty directory.
    const droppedShard = join(root(dshHome), 'file-objects', String(dropped.attachmentId).slice(7, 9))
    await writeFile(join(droppedShard, 'sibling-decoy'), 'not an object')

    await expect(service.collectGarbage({
      referenced: [kept.attachmentId, image.attachmentId],
      olderThanMs: 30_000,
    })).resolves.toEqual({ collectedBytes: 2, collectedCount: 1 })

    await expect(bytesOf(service.fileHostPath(kept))).resolves.toEqual(Uint8Array.of(1, 2, 3))
    await expect(readFile(service.fileHostPath(dropped)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(root(dshHome), 'files', String(dropped.attachmentId).slice(6, 8))))
      .rejects.toMatchObject({ code: 'ENOENT' })
    const usage = await service.usage()
    expect(usage.usedBytes).toBe(3 + image.bytes + 'not an object'.length)
  })

  it('collects an unreferenced image object and prunes its empty shard', async () => {
    const dshHome = await home()
    const service = store(dshHome)
    const image = await service.saveImage({ data: await raster(), mediaType: 'image/png' })
    await backdate(service.imageHostPath(image))
    const shard = join(root(dshHome), 'objects', String(image.attachmentId).slice(7, 9))
    await expect(service.collectGarbage({ referenced: [], olderThanMs: 0 }))
      .resolves.toMatchObject({ collectedCount: 1 })
    await expect(readdir(shard)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(service.usage()).resolves.toMatchObject({ usedBytes: 0 })
  })

  it('reports scan failures instead of pretending the store is empty', async () => {
    const dshHome = await home()
    const service = store(dshHome)
    await service.saveFile({ data: Uint8Array.of(1), name: 'guarded.txt' })
    await chmod(join(root(dshHome), 'file-objects'), 0o000)
    try {
      await expect(service.usage()).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(join(root(dshHome), 'file-objects'), 0o700)
    }
  })

  it('fails loud when staging cleanup cannot list the staging directory', async () => {
    const dshHome = await home()
    const service = store(dshHome, { diskBudgetBytes: 100 })
    await mkdir(join(root(dshHome), 'tmp'), { recursive: true })
    await chmod(join(root(dshHome), 'tmp'), 0o000)
    try {
      await expect(service.saveFile({ data: Uint8Array.of(1), name: 'blocked.bin' }))
        .rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(join(root(dshHome), 'tmp'), 0o700)
    }
  })

  it('keeps growing an undeclared stream only while the reservation record can be updated', async () => {
    const dshHome = await home()
    const service = store(dshHome, { diskBudgetBytes: 100 })
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    async function* growingUpload(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(4)
      await gate
      yield new Uint8Array(4)
    }
    const saving = service.saveFileStream({ data: growingUpload(), name: 'growing.bin' })
      .catch((error: unknown) => error)
    await vi.waitFor(async () => {
      const entries = await readdir(join(root(dshHome), 'reservations'))
      expect(entries).toHaveLength(1)
      expect((JSON.parse(
        await readFile(join(root(dshHome), 'reservations', entries[0] as string), 'utf8'),
      ) as { bytes: number }).bytes).toBe(4)
    }, 2_000)
    // Truncating the existing record still works, so the record file itself
    // must be read-only to fail the grow update.
    await chmod(await firstReservationRecord(dshHome), 0o400)
    releaseGate?.()
    expect(await saving).toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
  })

  it('tolerates a reservation record that vanished before release', async () => {
    const dshHome = await home()
    const service = store(dshHome, { diskBudgetBytes: 100 })
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    async function* heldUpload(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(4)
      await gate
    }
    const saving = service.saveFileStream({ data: heldUpload(), declaredBytes: 10, name: 'vanishing.bin' })
    try {
      await vi.waitFor(async () => {
        const entries = await readdir(join(root(dshHome), 'reservations'))
        expect(entries).toHaveLength(1)
        await rm(join(root(dshHome), 'reservations', entries[0] as string))
      }, 2_000)
    } finally {
      releaseGate?.()
    }
    await expect(saving).resolves.toMatchObject({ bytes: 4 })
    await expect(service.saveFile({ data: new Uint8Array(60), name: 'full.bin' }))
      .resolves.toMatchObject({ bytes: 60 })
  })

  it('keeps objects inside the grace period and validates the request', async () => {
    const dshHome = await home()
    const service = store(dshHome)
    const ref = await service.saveFile({ data: Uint8Array.of(1), name: 'fresh.txt' })
    await expect(service.collectGarbage({ referenced: [], olderThanMs: 100 * 365 * 24 * 60 * 60 * 1000 }))
      .resolves.toEqual({ collectedBytes: 0, collectedCount: 0 })
    await expect(bytesOf(service.fileHostPath(ref))).resolves.toEqual(Uint8Array.of(1))
    await expect(service.collectGarbage({ referenced: [], olderThanMs: -1 }))
      .rejects.toThrow('olderThanMs')
    await expect(service.collectGarbage({ referenced: ['sha256:nope' as AttachmentId], olderThanMs: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })
  })

  it('collects from a fresh home without object trees', async () => {
    const dshHome = await home()
    const service = store(dshHome)
    await expect(service.collectGarbage({ referenced: [], olderThanMs: 0 }))
      .resolves.toEqual({ collectedBytes: 0, collectedCount: 0 })
  })

  it('wraps object-tree failures as attachment storage failures', async () => {
    const dshHome = await home()
    const service = store(dshHome)
    const ref = await service.saveFile({ data: Uint8Array.of(1), name: 'locked.txt' })
    await backdate(service.fileHostPath(ref))
    const shard = join(root(dshHome), 'file-objects', String(ref.attachmentId).slice(7, 9))
    await chmod(shard, 0o500)
    try {
      await expect(service.collectGarbage({ referenced: [], olderThanMs: 0 }))
        .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
    } finally {
      await chmod(shard, 0o700)
    }
  })

  it('ignores non-file entries while scanning stored objects', async () => {
    const dshHome = await home()
    const service = store(dshHome)
    const ref = await service.saveFile({ data: Uint8Array.of(1, 2), name: 'scanned.txt' })
    const shard = join(root(dshHome), 'file-objects', String(ref.attachmentId).slice(7, 9))
    await symlink(join(shard, String(ref.attachmentId).slice(7)), join(shard, 'alias-link')).catch(() => {})
    await expect(service.usage()).resolves.toMatchObject({ usedBytes: 2 })
  })

  it('reserves image publications against the budget', async () => {
    const dshHome = await home()
    const service = store(dshHome, { diskBudgetBytes: 3 })
    await expect(service.saveImage({ data: await raster(), mediaType: 'image/png' }))
      .rejects.toMatchObject({ code: 'DISK_BUDGET_EXCEEDED' })
  })

  it('fails loud when a reservation record cannot be written', async () => {
    const dshHome = await home()
    const service = store(dshHome, { diskBudgetBytes: 100 })
    await mkdir(join(root(dshHome), 'reservations'), { recursive: true })
    await chmod(join(root(dshHome), 'reservations'), 0o500)
    try {
      await expect(service.saveFile({ data: new Uint8Array(10), name: 'unrecorded.bin' }))
        .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
      await expect(readdir(join(root(dshHome), 'file-objects'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await chmod(join(root(dshHome), 'reservations'), 0o700)
    }
    await expect(service.saveFile({ data: new Uint8Array(10), name: 'retried.bin' }))
      .resolves.toMatchObject({ bytes: 10 })
  })

  it('fails loud when a reservation record cannot be released', async () => {
    const dshHome = await home()
    const service = store(dshHome, { diskBudgetBytes: 100 })
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    async function* gatedUpload(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(10)
      await gate
    }
    const saving = service.saveFileStream({ data: gatedUpload(), declaredBytes: 10, name: 'held.bin' })
      .catch((error: unknown) => error)
    try {
      await vi.waitFor(async () => {
        expect(await readdir(join(root(dshHome), 'reservations'))).toHaveLength(1)
      }, 2_000)
      await chmod(join(root(dshHome), 'reservations'), 0o500)
    } finally {
      releaseGate?.()
    }
    expect(await saving).toMatchObject({ code: 'EACCES' })
    await chmod(join(root(dshHome), 'reservations'), 0o700)
  })

  it('runs the garbage-collection timer against a registered reference source', async () => {
    const dshHome = await home()
    const ctx = new Context()
    const service = new LocalAttachmentStore(ctx, { dshHome, gcIntervalMs: 10, gcGracePeriodMs: 0 })
    const kept = await service.saveFile({ data: Uint8Array.of(1), name: 'kept.txt' })
    const dropped = await service.saveFile({ data: Uint8Array.of(2), name: 'dropped.txt' })
    await backdate(service.fileHostPath(dropped))
    const dispose = service.setGarbageReferenceSource(() => [kept.attachmentId])
    await vi.waitFor(async () => {
      await expect(readFile(service.fileHostPath(dropped))).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await expect(bytesOf(service.fileHostPath(kept))).resolves.toEqual(Uint8Array.of(1))
    dispose()
    await ctx.fiber.dispose()
  })

  it('skips a timer run while the source reports no readable references', async () => {
    const dshHome = await home()
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const service = new LocalAttachmentStore(ctx, { dshHome, gcIntervalMs: 5, gcGracePeriodMs: 0 })
    const ref = await service.saveFile({ data: Uint8Array.of(1), name: 'kept.txt' })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no reference source/))
    })
    await expect(bytesOf(service.fileHostPath(ref))).resolves.toEqual(Uint8Array.of(1))

    const disposeStale = service.setGarbageReferenceSource(() => undefined)
    const dispose = service.setGarbageReferenceSource(() => undefined)
    // A short sleep is the proof here: the assertion is that no second warning
    // fires, which a polling wait cannot express.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(warn).toHaveBeenCalledTimes(1)
    disposeStale()
    dispose()
    service.setGarbageReferenceSource(() => [])
    await vi.waitFor(async () => {
      await expect(readFile(service.fileHostPath(ref))).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await ctx.fiber.dispose()
  })

  it('logs a failed scheduled collection instead of crashing the timer', async () => {
    const dshHome = await home()
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const service = new LocalAttachmentStore(ctx, { dshHome, gcIntervalMs: 5, gcGracePeriodMs: 0 })
    service.setGarbageReferenceSource(() => ['sha256:nope' as AttachmentId])
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/scheduled garbage collection failed/))
    })
    await ctx.fiber.dispose()
  })
})
