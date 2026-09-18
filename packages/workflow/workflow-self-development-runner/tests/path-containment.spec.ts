/** Realpath checks for existing and not-yet-created experiment paths. @module path-containment.spec */
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isInsideReal, realpathIfInside, staysInside } from '../src/path-containment.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, realpath: vi.fn(actual.realpath) }
})

let root: string | undefined
afterEach(async () => {
  vi.mocked(realpath).mockReset()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(realpath).mockImplementation(actual.realpath)
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('path containment', () => {
  it('accepts sibling names beginning with two dots without accepting parent traversal', () => {
    const base = resolve('fixture')
    expect(isInsideReal(base, base)).toBe(true)
    expect(isInsideReal(base, join(base, '..notes'))).toBe(true)
    expect(isInsideReal(base, resolve(base, '..'))).toBe(false)
    expect(isInsideReal(base, resolve(base, '../sibling'))).toBe(false)
  })

  it('resolves ancestor symlinks and missing suffixes without allowing escape', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-paths-'))
    const base = join(root, 'base')
    const outside = join(root, 'outside')
    await Promise.all([mkdir(base), mkdir(outside)])
    await symlink(outside, join(base, 'escape'))
    expect(await realpathIfInside(base, base)).toBe(await realpath(base))
    expect(await realpathIfInside(base, outside)).toBeUndefined()
    expect(await realpathIfInside(base, join(base, 'missing'))).toBeUndefined()
    expect(await realpathIfInside(join(root, 'missing'), base)).toBeUndefined()
    expect(await staysInside(base, join(base, 'new', 'file'))).toBe(true)
    expect(await staysInside(base, join(base, 'escape', 'new', 'file'))).toBe(false)
    expect(await staysInside(join(root, 'missing'), base)).toBe(false)
  })

  it('rejects a target when no ancestor resolves', async () => {
    vi.mocked(realpath).mockResolvedValueOnce('/base').mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    expect(await staysInside('/base', '/unresolvable/file')).toBe(false)
  })

  it('can climb a non-directory suffix to its existing ancestor', async () => {
    vi.mocked(realpath).mockResolvedValueOnce('/base')
      .mockRejectedValueOnce(Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }))
      .mockResolvedValueOnce('/base')
    expect(await staysInside('/base', '/base/file')).toBe(true)
  })

  it.each([Object.assign(new Error('denied'), { code: 'EACCES' }), null, 'failed'])('does not treat a resolution error as a missing path: %s', async (error) => {
    vi.mocked(realpath).mockResolvedValueOnce('/base').mockRejectedValueOnce(error)
    await expect(staysInside('/base', '/base/file')).rejects.toBe(error)
  })
})
