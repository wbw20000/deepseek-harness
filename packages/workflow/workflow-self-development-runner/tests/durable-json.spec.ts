/**
 * Durable JSON publication: exclusive temporary file, file and directory
 * sync, atomic rename, byte-identical `unchanged`, conflict rejection, and
 * boundary error classification for every failure path.
 * @module durable-json.spec
 */

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readDurableJson, writeDurableJson } from '../src/durable-json.ts'
import { SelfDevelopmentRunnerError } from '../src/runtime.ts'

const mockState = vi.hoisted(() => ({
  rmError: undefined as unknown,
  failFileSync: false,
  failDirSync: false,
  syncLog: [] as Array<{ path: string; directory: boolean }>,
}))

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const [path, flags] = args as [string, string | undefined]
      const directory = flags === 'r'
      const handle = await actual.open(...args)
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') {
            return async () => {
              if (directory ? mockState.failDirSync : mockState.failFileSync) throw new Error('sync blocked by test')
              mockState.syncLog.push({ path, directory })
              return target.sync()
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? (value as (...callArgs: unknown[]) => unknown).bind(target) : value
        },
      })
    }),
    rename: vi.fn(actual.rename),
    rm: vi.fn(async (...args: Parameters<typeof actual.rm>) => {
      if (mockState.rmError !== undefined) throw mockState.rmError
      return actual.rm(...args)
    }),
  }
})

const EVIDENCE_VALUE = { taskId: 'task-1', digest: 'a'.repeat(64) }

let root: string | undefined

afterEach(async () => {
  mockState.rmError = undefined
  mockState.failFileSync = false
  mockState.failDirSync = false
  mockState.syncLog = []
  vi.restoreAllMocks()
  if (root !== undefined) {
    await chmod(root, 0o700).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
  root = undefined
})

/** Create one fresh temporary evidence root for a test. */
async function tempRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-durable-json-'))
  return root
}

/** Expect a boundary rejection and return it for code and cause assertions. */
async function expectBoundary(run: () => Promise<unknown>, code: SelfDevelopmentRunnerError['code']): Promise<SelfDevelopmentRunnerError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(SelfDevelopmentRunnerError)
    return error as SelfDevelopmentRunnerError
  }
  throw new Error(`expected rejection with ${code}`)
}

/** Assert the directory holds no leftover `.tmp-` publication residue. */
async function expectNoTempResidue(directory: string): Promise<void> {
  const entries = await readdir(directory)
  expect(entries.filter(entry => entry.includes('.tmp-'))).toEqual([])
}

describe('writeDurableJson', () => {
  it('writes pretty JSON with a trailing newline and reads it back', async () => {
    const target = join(await tempRoot(), 'record.json')
    await expect(writeDurableJson(target, EVIDENCE_VALUE)).resolves.toBe('written')
    await expect(readFile(target, 'utf8')).resolves.toBe(`${JSON.stringify(EVIDENCE_VALUE, null, 2)}\n`)
    await expect(readDurableJson(target)).resolves.toEqual(EVIDENCE_VALUE)
  })

  it('returns unchanged without rewriting a byte-identical target', async () => {
    const target = join(await tempRoot(), 'record.json')
    await writeDurableJson(target, EVIDENCE_VALUE)
    const before = await stat(target)
    await expect(writeDurableJson(target, EVIDENCE_VALUE)).resolves.toBe('unchanged')
    const after = await stat(target)
    expect(after.ino).toBe(before.ino)
  })

  it('rejects a differing target with SELF_DEV_RUNNER_EVIDENCE_CONFLICT', async () => {
    const target = join(await tempRoot(), 'record.json')
    await writeDurableJson(target, EVIDENCE_VALUE)
    const error = await expectBoundary(() => writeDurableJson(target, { taskId: 'task-2' }), 'SELF_DEV_RUNNER_EVIDENCE_CONFLICT')
    expect(error.code).toBe('SELF_DEV_RUNNER_EVIDENCE_CONFLICT')
  })

  it('fails with the boundary code when the existing target is an unreadable directory', async () => {
    const directory = await tempRoot()
    const target = join(directory, 'record.json')
    await mkdir(target)
    const error = await expectBoundary(() => writeDurableJson(target, EVIDENCE_VALUE), 'SELF_DEV_RUNNER_EVIDENCE_FAILED')
    expect(error.code).toBe('SELF_DEV_RUNNER_EVIDENCE_FAILED')
    expect(error.message).toContain('read failed')
    expect(error.cause).toBeInstanceOf(Error)
    await expect(readdir(target)).resolves.toEqual([])
  })

  it('creates missing parent directories', async () => {
    const target = join(await tempRoot(), 'tasks', 'task-1', 'launches', 'op-1.json')
    await expect(writeDurableJson(target, EVIDENCE_VALUE)).resolves.toBe('written')
  })

  it('publishes through rename and leaves only the target in the directory', async () => {
    const directory = await tempRoot()
    const target = join(directory, 'record.json')
    await writeDurableJson(target, EVIDENCE_VALUE)
    await expect(readdir(directory)).resolves.toEqual(['record.json'])
  })

  it('fails with no target and no residue when rename fails', async () => {
    const { rename } = await import('node:fs/promises')
    const directory = await tempRoot()
    const target = join(directory, 'record.json')
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('rename blocked'), { code: 'EACCES' }))
    const error = await expectBoundary(() => writeDurableJson(target, EVIDENCE_VALUE), 'SELF_DEV_RUNNER_EVIDENCE_FAILED')
    expect(error.code).toBe('SELF_DEV_RUNNER_EVIDENCE_FAILED')
    expect(error.message).toContain('write failed')
    expect(error.cause).toBeInstanceOf(Error)
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await expectNoTempResidue(directory)
  })

  it('reports cleanup failure in the message while keeping the original cause', async () => {
    const { rename } = await import('node:fs/promises')
    const directory = await tempRoot()
    const target = join(directory, 'record.json')
    vi.mocked(rename).mockRejectedValueOnce(new Error('rename blocked'))
    mockState.rmError = new Error('rm blocked by test')
    const error = await expectBoundary(() => writeDurableJson(target, EVIDENCE_VALUE), 'SELF_DEV_RUNNER_EVIDENCE_FAILED')
    expect(error.message).toContain('could not be removed')
    expect((error.cause as Error).message).toBe('rename blocked')
    mockState.rmError = undefined
  })

  it('describes non-Error failures from rename and cleanup', async () => {
    const { rename } = await import('node:fs/promises')
    const directory = await tempRoot()
    const target = join(directory, 'record.json')
    vi.mocked(rename).mockRejectedValueOnce('rename blocked')
    mockState.rmError = 'rm blocked'
    const error = await expectBoundary(() => writeDurableJson(target, EVIDENCE_VALUE), 'SELF_DEV_RUNNER_EVIDENCE_FAILED')
    expect(error.message).toContain('rename blocked')
    expect(error.message).toContain('rm blocked')
    expect(error.cause).toBe('rename blocked')
    mockState.rmError = undefined
  })

  it('syncs both the temporary file and the target directory', async () => {
    const directory = await tempRoot()
    const target = join(directory, 'record.json')
    await writeDurableJson(target, EVIDENCE_VALUE)
    const [fileSync, directorySync] = mockState.syncLog
    expect(fileSync?.directory).toBe(false)
    expect(fileSync?.path).toContain('.tmp-')
    expect(directorySync).toEqual({ path: directory, directory: true })
  })

  it('fails without residue when the file sync fails', async () => {
    const directory = await tempRoot()
    const target = join(directory, 'record.json')
    mockState.failFileSync = true
    const error = await expectBoundary(() => writeDurableJson(target, EVIDENCE_VALUE), 'SELF_DEV_RUNNER_EVIDENCE_FAILED')
    expect((error.cause as Error).message).toBe('sync blocked by test')
    await expectNoTempResidue(directory)
    mockState.failFileSync = false
  })

  it('fails when the directory cannot be reopened for sync', async () => {
    const directory = await tempRoot()
    const sub = join(directory, 'tasks')
    const target = join(sub, 'record.json')
    await expect(writeDurableJson(target, EVIDENCE_VALUE)).resolves.toBe('written')
    await chmod(sub, 0o300)
    try {
      const error = await expectBoundary(() => writeDurableJson(join(sub, 'other.json'), EVIDENCE_VALUE), 'SELF_DEV_RUNNER_EVIDENCE_FAILED')
      expect(error.message).toContain('directory open')
    } finally {
      await chmod(sub, 0o700)
    }
  })

  it('fails when the directory sync fails', async () => {
    const directory = await tempRoot()
    const target = join(directory, 'record.json')
    mockState.failDirSync = true
    const error = await expectBoundary(() => writeDurableJson(target, EVIDENCE_VALUE), 'SELF_DEV_RUNNER_EVIDENCE_FAILED')
    expect(error.message).toContain('directory sync')
    expect(error.cause).toBeInstanceOf(Error)
    mockState.failDirSync = false
  })

  it('fails on a read-only parent directory without residue', async () => {
    const directory = await tempRoot()
    const target = join(directory, 'record.json')
    await chmod(directory, 0o500)
    try {
      const error = await expectBoundary(() => writeDurableJson(target, EVIDENCE_VALUE), 'SELF_DEV_RUNNER_EVIDENCE_FAILED')
      expect(error.message).toContain('write failed')
    } finally {
      await chmod(directory, 0o700)
    }
    await expectNoTempResidue(directory)
  })

  it('rejects relative paths before touching the filesystem', async () => {
    const directory = await tempRoot()
    const error = await expectBoundary(() => writeDurableJson('relative/record.json', EVIDENCE_VALUE), 'SELF_DEV_RUNNER_EVIDENCE_INVALID')
    expect(error.code).toBe('SELF_DEV_RUNNER_EVIDENCE_INVALID')
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('fails when the target path traverses a file', async () => {
    const directory = await tempRoot()
    const blocker = join(directory, 'blocker')
    await writeFile(blocker, 'x')
    const error = await expectBoundary(() => writeDurableJson(join(blocker, 'record.json'), EVIDENCE_VALUE), 'SELF_DEV_RUNNER_EVIDENCE_FAILED')
    expect(error.code).toBe('SELF_DEV_RUNNER_EVIDENCE_FAILED')
  })
})

describe('readDurableJson', () => {
  it('returns undefined for a missing file', async () => {
    const target = join(await tempRoot(), 'missing.json')
    await expect(readDurableJson(target)).resolves.toBeUndefined()
  })

  it('rejects non-JSON bytes with SELF_DEV_RUNNER_EVIDENCE_INVALID', async () => {
    const target = join(await tempRoot(), 'broken.json')
    await writeFile(target, '{not json')
    const error = await expectBoundary(() => readDurableJson(target), 'SELF_DEV_RUNNER_EVIDENCE_INVALID')
    expect(error.code).toBe('SELF_DEV_RUNNER_EVIDENCE_INVALID')
  })

  it('rejects unreadable targets with SELF_DEV_RUNNER_EVIDENCE_INVALID', async () => {
    const directory = await tempRoot()
    const error = await expectBoundary(() => readDurableJson(directory), 'SELF_DEV_RUNNER_EVIDENCE_INVALID')
    expect(error.message).toContain('read of')
  })

  it('rejects relative paths', async () => {
    await tempRoot()
    await expectBoundary(() => readDurableJson('relative/record.json'), 'SELF_DEV_RUNNER_EVIDENCE_INVALID')
  })
})
