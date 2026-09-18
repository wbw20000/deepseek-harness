/** Filesystem fault injection for UTF-8 writes and durable directory entries. @module journal-io.spec */
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskJournal } from '../src/journal.ts'
import { TaskSpecVersion } from '../src/runtime.ts'
import { makeTaskDir, SPEC } from './helpers.ts'

const fault = vi.hoisted(() => ({ shortWrites: false, failCheckpointSync: false, synced: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args)
      const path = String(args[0])
      const write = handle.write.bind(handle)
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (fault.failCheckpointSync && path.endsWith('checkpoint.json')) throw new Error('synthetic checkpoint sync failure')
        fault.synced.push(path)
        await sync()
      }
      if (fault.shortWrites && path.endsWith('.jsonl') && args[1] === 'a') {
        // Simulate the OS returning a short byte count, including mid-codepoint writes.
        handle.write = (async (value: string | Uint8Array) => {
          const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)
          const { bytesWritten } = await write(bytes.subarray(0, 7))
          return { bytesWritten, buffer: value }
        }) as typeof handle.write
      }
      return handle
    },
  }
})

afterEach(() => { fault.shortWrites = false; fault.failCheckpointSync = false; fault.synced.length = 0 })

it('preserves Chinese and emoji when a write accepts only part of the UTF-8 bytes', async () => {
  const { dir } = await makeTaskDir()
  const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 1 })
  fault.shortWrites = true
  const requirement = '手机实时对话，开发进度 🚀'
  await journal.append({ type: 'task/created', spec: { ...SPEC, version: TaskSpecVersion(1), requirement } }, undefined)
  const line = await readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
  const record = JSON.parse(line) as { event: { spec: { requirement: string } } }
  expect(record.event.spec.requirement).toBe(requirement)
  expect((await journal.read()).status).toBe('ok')
})

it('flushes the containing directory after creating a segment and replacing metadata', async () => {
  const { dir } = await makeTaskDir()
  const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 1 })
  await journal.append({ type: 'task/created', spec: { ...SPEC, version: TaskSpecVersion(1) } }, undefined)
  await journal.writeProjection({ revision: 1 })
  if (process.platform !== 'win32') expect(fault.synced.filter(path => path === dir)).toHaveLength(3)
})

it('can reopen immediately after the first acknowledged task record', async () => {
  const { dir } = await makeTaskDir()
  const options = { maxRecordsPerSegment: 64, checkpointInterval: 4 }
  const journal = await TaskJournal.open(dir, options)
  await journal.append({ type: 'task/created', spec: { ...SPEC, version: TaskSpecVersion(1) } }, undefined)
  const reopened = await TaskJournal.open(dir, options)
  expect((await reopened.read()).records).toHaveLength(1)
})

it('refuses an oversized projection before decoding it', async () => {
  const { dir } = await makeTaskDir()
  const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
  await writeFile(join(dir, 'projection.json'), ' '.repeat(1024 * 1024 + 1))
  await expect(journal.readProjection()).rejects.toThrow('state-file byte limit')
})

// Windows symlink creation depends on developer mode or elevated privileges.
it.skipIf(process.platform === 'win32')('refuses a symlinked projection without reading its target', async () => {
  const { dir, root } = await makeTaskDir()
  const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
  const outside = join(root, 'outside.json')
  await writeFile(outside, '{"revision":999}')
  await symlink(outside, join(dir, 'projection.json'))
  await expect(journal.readProjection()).rejects.toThrow('not a regular file')
})

it('classifies a checkpoint sync failure as an unavailable journal', async () => {
  const { dir } = await makeTaskDir()
  const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 1 })
  fault.failCheckpointSync = true
  await expect(journal.append({ type: 'task/created', spec: { ...SPEC, version: TaskSpecVersion(1) } }, undefined))
    .rejects.toMatchObject({ code: 'SELF_DEV_JOURNAL_UNAVAILABLE' })
})
