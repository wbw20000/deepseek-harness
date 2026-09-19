/**
 * Path and task-id validation behavior: the safe task-id alphabet, and
 * realpath containment that classifies existing, missing, and symlinked
 * targets through their deepest existing ancestor.
 * @module paths.spec
 */

import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { realpathIfInside, validateTaskId } from '../src/paths.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('task id validation', () => {
  it('accepts plain safe names', () => {
    expect(validateTaskId('task-a')).toBe('task-a')
    expect(validateTaskId('Task_9.fix-2')).toBe('Task_9.fix-2')
  })

  it.each([
    ['empty', ''],
    ['leading dot', '.hidden'],
    ['dot-dot segment', 'a/../b'],
    ['slash', 'a/b'],
    ['lock suffix', 'task.lock'],
    ['space', 'task a'],
    ['non-string', 42 as unknown as string],
  ])('refuses a %s task id', (_name, taskId) => {
    expect(() => validateTaskId(taskId)).toThrow(
      expect.objectContaining({ code: 'SELF_DEV_WORKSPACE_TASK_INVALID' }),
    )
  })
})

describe('realpath containment', () => {
  it('accepts a target inside the base and resolves symlinks', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-paths-'))
    const base = join(root, 'base')
    await mkdir(join(base, 'task'), { recursive: true })
    const target = await symlink(join(base, 'task'), join(root, 'link'), 'dir').then(() => join(root!, 'link'))
    expect(await realpathIfInside(base, join(target, 'worktree'))).toBe(await realpathOf(join(base, 'task')))
  })

  it('refuses a symlinked base escape', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-paths-'))
    const base = join(root, 'base')
    const outside = join(root, 'outside')
    await mkdir(base, { recursive: true })
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(base, 'escape'), 'dir')
    expect(await realpathIfInside(base, join(base, 'escape', 'worktree'))).toBeUndefined()
  })

  it('refuses a target outside the base', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-paths-'))
    const base = join(root, 'base')
    await mkdir(base, { recursive: true })
    await writeFile(join(root, 'sibling.txt'), 'x')
    expect(await realpathIfInside(base, join(root, 'sibling.txt'))).toBeUndefined()
  })

  it('returns undefined when the base does not exist', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-paths-'))
    expect(await realpathIfInside(join(root, 'missing'), join(root, 'anything'))).toBeUndefined()
  })

  it('accepts the base itself as its own contained target', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-paths-'))
    const base = join(root, 'base')
    await mkdir(base, { recursive: true })
    expect(await realpathIfInside(base, base)).toBe(await realpath(base))
  })

  it('propagates unexpected realpath failures such as denied traversal', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-paths-'))
    const base = join(root, 'base')
    await mkdir(join(base, 'secret', 'inner'), { recursive: true })
    await chmod(base, 0o000)
    try {
      await expect(realpathIfInside(root, join(base, 'secret', 'inner', 'worktree')))
        .rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(base, 0o755)
    }
  })
})

/** The realpath of an existing path. */
function realpathOf(path: string): Promise<string> {
  return realpath(path)
}
