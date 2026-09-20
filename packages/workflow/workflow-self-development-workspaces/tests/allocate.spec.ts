/**
 * Allocation behavior: two tasks get independent worktrees, branches, and
 * data homes that do not see each other's writes; the third task is refused
 * at the configured limit instead of queued; a repeated allocation returns
 * the existing record; and every invalid request fails with its boundary
 * code before or after any filesystem effect. Concurrent allocations against
 * one experiments root serialize: the limit refuses exactly one of three
 * racing callers, and two racing allocations of one task id return one record.
 * @module allocate.spec
 */

import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { allocateWorkspace } from '../src/allocate.ts'
import { readRegistry } from '../src/registry.ts'
import { makeSandbox, removeSandbox, commitAll, git, type Sandbox } from './harness.ts'
import type { TaskWorkspace } from '../src/types.ts'

/** Absolute path of the fake setup command fixture, shared with setup.spec.ts. */
const setupFixture = fileURLToPath(new URL('./fixtures/setup-case.mjs', import.meta.url))

let sandbox: Sandbox | undefined

afterEach(async () => {
  if (sandbox !== undefined) await removeSandbox(sandbox)
  sandbox = undefined
})

describe('allocation', () => {
  it('gives two tasks independent worktrees, branches, and data homes', async () => {
    sandbox = await makeSandbox()
    const first = await allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: sandbox.projectRoot })
    const second = await allocateWorkspace(sandbox.config, { taskId: 'task-b', projectRoot: sandbox.projectRoot })
    expect(first).toMatchObject({
      taskId: 'task-a',
      projectRoot: await realpath(sandbox.projectRoot),
      branch: 'selfdev/task-a',
    })
    expect(first.worktree).not.toBe(second.worktree)
    expect(first.dataHome).not.toBe(second.dataHome)
    expect(existsSync(first.worktree)).toBe(true)
    expect(existsSync(join(first.dataHome, 'settings.json'))).toBe(true)
    const branches = await git(sandbox.projectRoot, ['branch', '--list', 'selfdev/*'])
    expect(branches).toContain('selfdev/task-a')
    expect(branches).toContain('selfdev/task-b')
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces.map(workspace => workspace.taskId)).toEqual(['task-a', 'task-b'])
  })

  it('keeps task writes invisible across worktrees', async () => {
    sandbox = await makeSandbox()
    const first = await allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: sandbox.projectRoot })
    const second = await allocateWorkspace(sandbox.config, { taskId: 'task-b', projectRoot: sandbox.projectRoot })
    await writeFile(join(first.worktree, 'marker.txt'), 'task-a only\n')
    await expect(readFile(join(second.worktree, 'marker.txt'), 'utf8')).resolves.toBe('baseline\n')
    await writeFile(join(first.dataHome, 'private.txt'), 'a\n')
    expect(existsSync(join(second.dataHome, 'private.txt'))).toBe(false)
  })

  it('copies the template but excludes sessions, attachments, and lock files', async () => {
    sandbox = await makeSandbox()
    const template = join(sandbox.root, 'rich-template')
    await mkdir(join(template, 'sessions', 'nested'), { recursive: true })
    await mkdir(join(template, 'attachments'), { recursive: true })
    await mkdir(join(template, 'deep', 'sessions'), { recursive: true })
    await writeFile(join(template, 'keep.txt'), 'keep\n')
    await writeFile(join(template, 'sessions', 's.json'), 'session\n')
    await writeFile(join(template, 'attachments', 'a.bin'), 'attachment\n')
    await writeFile(join(template, 'left.lock'), 'lock\n')
    await writeFile(join(template, 'deep', 'sessions', 's.json'), 'nested session\n')
    const workspace = await allocateWorkspace(
      { ...sandbox.config, dataHomeTemplate: template },
      { taskId: 'task-a', projectRoot: sandbox.projectRoot },
    )
    expect(await readFile(join(workspace.dataHome, 'keep.txt'), 'utf8')).toBe('keep\n')
    expect(existsSync(join(workspace.dataHome, 'sessions'))).toBe(false)
    expect(existsSync(join(workspace.dataHome, 'attachments'))).toBe(false)
    expect(existsSync(join(workspace.dataHome, 'left.lock'))).toBe(false)
    expect(existsSync(join(workspace.dataHome, 'deep', 'sessions'))).toBe(false)
  })

  it('records the requested baseCommit instead of HEAD', async () => {
    sandbox = await makeSandbox()
    await writeFile(join(sandbox.projectRoot, 'second.txt'), 'second\n')
    const head = await commitAll(sandbox.projectRoot, 'second commit')
    const workspace = await allocateWorkspace(sandbox.config, {
      taskId: 'task-a',
      projectRoot: sandbox.projectRoot,
      baseCommit: 'HEAD~1',
    })
    expect(workspace.baseCommit).not.toBe(head)
    expect(await git(sandbox.projectRoot, ['rev-parse', 'HEAD~1'])).toContain(workspace.baseCommit)
  })

  it('returns the existing record for a repeated allocation', async () => {
    sandbox = await makeSandbox()
    const first = await allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: sandbox.projectRoot })
    const again = await allocateWorkspace(sandbox.config, {
      taskId: 'task-a',
      projectRoot: join(sandbox.root, 'somewhere-else'),
    })
    expect(again).toEqual(first)
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces).toHaveLength(1)
  })

  it('refuses the third task at the configured limit instead of queuing it', async () => {
    sandbox = await makeSandbox({ maxConcurrentTasks: 2 })
    await allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: sandbox.projectRoot })
    await allocateWorkspace(sandbox.config, { taskId: 'task-b', projectRoot: sandbox.projectRoot })
    await expect(allocateWorkspace(sandbox.config, { taskId: 'task-c', projectRoot: sandbox.projectRoot }))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_LIMIT' })
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces.map(workspace => workspace.taskId)).toEqual(['task-a', 'task-b'])
  })
})

describe('allocation rejections', () => {
  it.each([
    ['empty', ''],
    ['dotted path', 'a/../b'],
    ['slash', 'a/b'],
    ['leading dot', '.hidden'],
    ['lock suffix', 'task.lock'],
    ['space', 'task a'],
  ])('refuses a %s task id', async (_name, taskId) => {
    sandbox = await makeSandbox()
    await expect(allocateWorkspace(sandbox.config, { taskId, projectRoot: sandbox.projectRoot }))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_TASK_INVALID' })
  })

  it('refuses a relative project root', async () => {
    sandbox = await makeSandbox()
    await expect(allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: 'relative/project' }))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_ALLOC_FAILED' })
  })

  it('refuses a project root that does not exist', async () => {
    sandbox = await makeSandbox()
    await expect(allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: join(sandbox.root, 'missing') }))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_ALLOC_FAILED' })
  })

  it('refuses a project root without a committed baseline', async () => {
    sandbox = await makeSandbox()
    const empty = join(sandbox.root, 'empty')
    await mkdir(empty, { recursive: true })
    await git(empty, ['init', '-q'])
    const caught = await allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: empty }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({ code: 'SELF_DEV_WORKSPACE_ALLOC_FAILED' })
    expect(caught instanceof Error ? caught.message : String(caught)).toContain('HEAD')
  })

  it('refuses a baseCommit that does not resolve', async () => {
    sandbox = await makeSandbox()
    await expect(allocateWorkspace(sandbox.config, {
      taskId: 'task-a',
      projectRoot: sandbox.projectRoot,
      baseCommit: 'refs/heads/missing-baseline',
    })).rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_ALLOC_FAILED' })
  })

  it('refuses a missing data-home template', async () => {
    sandbox = await makeSandbox()
    const config = { ...sandbox.config, dataHomeTemplate: join(sandbox.root, 'no-such-template') }
    await expect(allocateWorkspace(config, { taskId: 'task-a', projectRoot: sandbox.projectRoot }))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_ALLOC_FAILED' })
  })

  it('rolls the worktree back when the data home cannot be created', async () => {
    sandbox = await makeSandbox()
    // A file where the task's data home would go makes the copy fail after
    // the worktree exists; the allocation must leave neither behind.
    await mkdir(join(sandbox.experimentsRoot, 'task-a'), { recursive: true })
    await writeFile(join(sandbox.experimentsRoot, 'task-a', 'dsh-home'), 'not a directory\n')
    await expect(allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: sandbox.projectRoot }))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_ALLOC_FAILED' })
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces).toEqual([])
    await expect(git(sandbox.projectRoot, ['worktree', 'list', '--porcelain'])).resolves.not.toContain('task-a')
  })

  it('rolls the worktree and branch back when the task directory cannot be created', async () => {
    sandbox = await makeSandbox()
    // An experiments root that refuses new entries makes the task `mkdir` fail
    // before the worktree exists; the best-effort teardown must still run and
    // the failure must surface as the boundary code.
    await mkdir(sandbox.experimentsRoot, { recursive: true })
    await chmod(sandbox.experimentsRoot, 0o555)
    try {
      await expect(allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: sandbox.projectRoot }))
        .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_ALLOC_FAILED' })
    } finally {
      await chmod(sandbox.experimentsRoot, 0o755)
    }
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces).toEqual([])
    await expect(git(sandbox.projectRoot, ['worktree', 'list', '--porcelain'])).resolves.not.toContain('task-a')
    await expect(git(sandbox.projectRoot, ['branch', '--list', 'selfdev/*'])).resolves.toBe('')
  })

  it('refuses a task root that is a symlink pointing outside the experiments root', async () => {
    sandbox = await makeSandbox()
    await mkdir(sandbox.experimentsRoot, { recursive: true })
    const outside = join(sandbox.root, 'outside')
    await mkdir(outside, { recursive: true })
    const decoy = join(outside, 'decoy.txt')
    await writeFile(decoy, 'untouched\n')
    await symlink(outside, join(sandbox.experimentsRoot, 'task-a'), 'dir')
    const caught = await allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: sandbox.projectRoot }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({ code: 'SELF_DEV_WORKSPACE_ALLOC_FAILED' })
    expect(caught instanceof Error ? caught.message : String(caught)).toContain('inside')
    // The refusal happens before any creation: the bait directory outside the
    // experiments root is not written, no worktree or branch exists, and the
    // registry stays empty.
    expect(await readFile(decoy, 'utf8')).toBe('untouched\n')
    expect(readdirSync(outside)).toEqual(['decoy.txt'])
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces).toEqual([])
    await expect(git(sandbox.projectRoot, ['worktree', 'list', '--porcelain'])).resolves.not.toContain('task-a')
    await expect(git(sandbox.projectRoot, ['branch', '--list', 'selfdev/*'])).resolves.toBe('')
    await rm(join(sandbox.experimentsRoot, 'task-a'), { force: true })
    await rm(outside, { recursive: true, force: true })
  })
})

describe('concurrent allocation', () => {
  it('serializes concurrent allocations so the limit refuses exactly one', async () => {
    sandbox = await makeSandbox({ maxConcurrentTasks: 2 })
    const outcomes = await Promise.allSettled([
      allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: sandbox.projectRoot }),
      allocateWorkspace(sandbox.config, { taskId: 'task-b', projectRoot: sandbox.projectRoot }),
      allocateWorkspace(sandbox.config, { taskId: 'task-c', projectRoot: sandbox.projectRoot }),
    ])
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    const fulfilled = outcomes.filter((outcome): outcome is PromiseFulfilledResult<TaskWorkspace> => outcome.status === 'fulfilled')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({ code: 'SELF_DEV_WORKSPACE_LIMIT' })
    expect(fulfilled).toHaveLength(2)
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces.map(workspace => workspace.taskId).sort()).toEqual(['task-a', 'task-b'])
    await expect(git(sandbox.projectRoot, ['worktree', 'list', '--porcelain'])).resolves.not.toContain('task-c')
    await expect(git(sandbox.projectRoot, ['branch', '--list', 'selfdev/task-c'])).resolves.toBe('')
  })

  it('keeps concurrent allocations of one task id idempotent', async () => {
    sandbox = await makeSandbox()
    const [first, second] = await Promise.all([
      allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: sandbox.projectRoot }),
      allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: sandbox.projectRoot }),
    ])
    expect(second).toEqual(first)
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces).toHaveLength(1)
    const worktrees = await git(sandbox.projectRoot, ['worktree', 'list', '--porcelain'])
    expect(worktrees.split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(2)
    await expect(git(sandbox.projectRoot, ['branch', '--list', 'selfdev/*'])).resolves.toContain('selfdev/task-a')
  })
})

describe('workspace setup', () => {
  it('runs the configured command after the worktree and data home exist, before the registry write, and stamps setupCompletedAt', async () => {
    sandbox = await makeSandbox()
    // The allocation layout is deterministic (<experimentsRoot>/<taskId>/dsh-home),
    // so the check can name this task's about-to-exist data home ahead of time.
    // Fails closed (exit 9) unless the copied template file is already there,
    // proving setup runs after the data-home copy, not before it.
    const dataHomeCheck = join(sandbox.experimentsRoot, 'task-a', 'dsh-home', 'settings.json')
    const config = {
      ...sandbox.config,
      setup: { command: ['node', setupFixture, 'check-exists', dataHomeCheck], timeoutMs: 5000 },
    }
    const workspace = await allocateWorkspace(config, { taskId: 'task-a', projectRoot: sandbox.projectRoot })
    expect(typeof workspace.setupCompletedAt).toBe('number')
    expect(workspace.setupCompletedAt!).toBeGreaterThanOrEqual(workspace.allocatedAt)
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces[0]!.setupCompletedAt).toBe(workspace.setupCompletedAt)
  })

  it('runs the command inside the worktree itself, which already exists as a git checkout by the time it runs', async () => {
    sandbox = await makeSandbox()
    const config = {
      ...sandbox.config,
      setup: { command: ['node', setupFixture, 'check-exists', '.git'], timeoutMs: 5000 },
    }
    await expect(allocateWorkspace(config, { taskId: 'task-a', projectRoot: sandbox.projectRoot })).resolves.toMatchObject({
      taskId: 'task-a',
    })
  })

  it('tears the allocation down and reports SELF_DEV_WORKSPACE_SETUP_FAILED without registering it when setup exits non-zero', async () => {
    sandbox = await makeSandbox()
    const config = { ...sandbox.config, setup: { command: ['node', setupFixture, 'exit', '1'], timeoutMs: 5000 } }
    await expect(allocateWorkspace(config, { taskId: 'task-a', projectRoot: sandbox.projectRoot }))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_SETUP_FAILED' })
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces).toEqual([])
    await expect(git(sandbox.projectRoot, ['worktree', 'list', '--porcelain'])).resolves.not.toContain('task-a')
    await expect(git(sandbox.projectRoot, ['branch', '--list', 'selfdev/*'])).resolves.toBe('')
    expect(existsSync(join(sandbox.experimentsRoot, 'task-a'))).toBe(false)
  })

  it('tears the allocation down when setup does not finish within its configured timeout', async () => {
    sandbox = await makeSandbox()
    const config = { ...sandbox.config, setup: { command: ['node', setupFixture, 'sleep', '5000'], timeoutMs: 200 } }
    const caught = await allocateWorkspace(config, { taskId: 'task-a', projectRoot: sandbox.projectRoot }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(caught).toMatchObject({ code: 'SELF_DEV_WORKSPACE_SETUP_FAILED' })
    expect(caught instanceof Error ? caught.message : String(caught)).toContain('did not finish within 200 ms')
    const listed = await readRegistry(sandbox.experimentsRoot)
    expect(listed.workspaces).toEqual([])
    expect(existsSync(join(sandbox.experimentsRoot, 'task-a'))).toBe(false)
  })

  it('never reruns setup for an idempotent repeat allocation of an already-registered task', async () => {
    sandbox = await makeSandbox()
    const counter = join(sandbox.root, 'setup-run-count.txt')
    const config = { ...sandbox.config, setup: { command: ['node', setupFixture, 'append', counter, 'x'], timeoutMs: 5000 } }
    const first = await allocateWorkspace(config, { taskId: 'task-a', projectRoot: sandbox.projectRoot })
    await expect(readFile(counter, 'utf8')).resolves.toBe('x')
    const again = await allocateWorkspace(config, { taskId: 'task-a', projectRoot: join(sandbox.root, 'somewhere-else') })
    expect(again).toEqual(first)
    // Still exactly one run: the idempotent path returns the registered
    // record before any git, copy, or setup step runs again.
    await expect(readFile(counter, 'utf8')).resolves.toBe('x')
  })

  it('allocates normally when no setup is configured, leaving setupCompletedAt absent', async () => {
    sandbox = await makeSandbox()
    const workspace = await allocateWorkspace(sandbox.config, { taskId: 'task-a', projectRoot: sandbox.projectRoot })
    expect(workspace.setupCompletedAt).toBeUndefined()
    expect(Object.hasOwn(workspace, 'setupCompletedAt')).toBe(false)
  })
})
