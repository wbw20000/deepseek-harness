/**
 * Release behavior: a release removes the registered worktree and data home,
 * drops the registry entry, and leaves every unregistered path alone. A
 * vanished worktree is pruned, an unknown or invalid task id is refused, and
 * a registered path that moved outside the experiments root is refused
 * instead of deleted.
 * @module release.spec
 */

import { existsSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { allocateWorkspace } from '../src/allocate.ts'
import { readRegistry, writeRegistry } from '../src/registry.ts'
import { releaseWorkspace } from '../src/release.ts'
import { makeSandbox, removeSandbox, git, type Sandbox } from './harness.ts'

let sandbox: Sandbox | undefined

afterEach(async () => {
  if (sandbox !== undefined) await removeSandbox(sandbox)
  sandbox = undefined
})

/** Allocate one task in the current sandbox. */
async function allocate(taskId: string) {
  return allocateWorkspace(sandbox!.config, { taskId, projectRoot: sandbox!.projectRoot })
}

describe('release', () => {
  it('removes the worktree and data home, drops the registry entry, and keeps unregistered paths', async () => {
    sandbox = await makeSandbox()
    const first = await allocate('task-a')
    const second = await allocate('task-b')
    const decoy = join(sandbox.experimentsRoot, 'task-a', 'manual-decoy.txt')
    await writeFile(decoy, 'not registered\n')
    await releaseWorkspace(sandbox.config, 'task-a')
    expect(existsSync(first.worktree)).toBe(false)
    expect(existsSync(first.dataHome)).toBe(false)
    // Only the registered paths are deleted: the decoy inside the task's
    // directory and the other task's workspace both survive.
    expect(existsSync(decoy)).toBe(true)
    expect(existsSync(second.worktree)).toBe(true)
    expect(existsSync(second.dataHome)).toBe(true)
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces.map(workspace => workspace.taskId)).toEqual(['task-b'])
    await expect(git(sandbox.projectRoot, ['worktree', 'list', '--porcelain']))
      .resolves.not.toContain('selfdev/task-a')
  })

  it('prunes a worktree whose directory vanished outside the service', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    await rm(workspace.worktree, { recursive: true, force: true })
    await releaseWorkspace(sandbox.config, 'task-a')
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces).toEqual([])
    await expect(git(sandbox.projectRoot, ['worktree', 'list', '--porcelain']))
      .resolves.not.toContain('task-a')
  })

  it('tolerates a data home that is already gone', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    await rm(workspace.dataHome, { recursive: true, force: true })
    await expect(releaseWorkspace(sandbox.config, 'task-a')).resolves.toBeUndefined()
    expect(await readRegistry(sandbox.experimentsRoot)).toMatchObject({ workspaces: [] })
  })

  it('refuses to delete a registered worktree that now resolves outside the experiments root', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    const outside = join(sandbox.root, 'outside')
    await rm(workspace.worktree, { recursive: true, force: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'precious.txt'), 'keep me\n')
    // The registered worktree path is now a symlink pointing outside; release
    // must refuse instead of following it.
    await symlink(outside, workspace.worktree, 'dir')
    const caught = await releaseWorkspace(sandbox.config, 'task-a').then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({ code: 'SELF_DEV_WORKSPACE_RELEASE_FAILED' })
    expect(caught instanceof Error ? caught.message : String(caught)).toContain('refusing')
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true)
    await rm(workspace.worktree, { force: true })
  })

  it('refuses an unregistered task id', async () => {
    sandbox = await makeSandbox()
    await expect(releaseWorkspace(sandbox.config, 'task-never-allocated'))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_TASK_UNKNOWN' })
  })

  it('refuses an invalid task id', async () => {
    sandbox = await makeSandbox()
    await expect(releaseWorkspace(sandbox.config, '../escape'))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_TASK_INVALID' })
  })

  it('refuses to operate when the registry moved outside the experiments root', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocate('task-a')
    // Rewrite the registry entry so the recorded data home points outside;
    // the release must refuse instead of following the moved path.
    await writeRegistry(sandbox.experimentsRoot, {
      version: 1,
      workspaces: [{ ...workspace, dataHome: join(sandbox.root, 'elsewhere', 'dsh-home') }],
    })
    await mkdir(join(sandbox.root, 'elsewhere', 'dsh-home'), { recursive: true })
    await expect(releaseWorkspace(sandbox.config, 'task-a'))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_RELEASE_FAILED' })
    expect(existsSync(join(sandbox.root, 'elsewhere', 'dsh-home'))).toBe(true)
  })

  it('keeps a release racing an allocation from losing a registry entry', async () => {
    sandbox = await makeSandbox({ maxConcurrentTasks: 2 })
    await allocate('task-a')
    // Release and allocation read the registry at the same moment: without
    // the serial chain the release's write would drop the new allocation.
    await Promise.all([
      releaseWorkspace(sandbox.config, 'task-a'),
      allocate('task-b'),
    ])
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces.map(workspace => workspace.taskId)).toEqual(['task-b'])
    await expect(git(sandbox.projectRoot, ['worktree', 'list', '--porcelain']))
      .resolves.not.toContain('selfdev/task-a')
    await expect(git(sandbox.projectRoot, ['branch', '--list', 'selfdev/*']))
      .resolves.toContain('selfdev/task-b')
  })
})
