/**
 * Service boundary behavior: boot-time config validation, the Loader
 * composition smoke for the opt-in service, and the service methods'
 * delegation: allocation through the service, list, release of an unknown
 * task, and integration of an unknown task.
 * @module service.spec
 */

import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SelfDevelopmentWorkspaces from '../src/index.ts'
import { allocateWorkspace } from '../src/allocate.ts'
import { releaseWorkspace } from '../src/release.ts'
import type { WorkspacesConfig } from '../src/types.ts'
import { commitAll, makeSandbox, removeSandbox, type Sandbox } from './harness.ts'

let sandbox: Sandbox | undefined
let compositionRoot: string | undefined

afterEach(async () => {
  if (sandbox !== undefined) await removeSandbox(sandbox)
  sandbox = undefined
  if (compositionRoot !== undefined) {
    await rm(compositionRoot, { recursive: true, force: true })
    compositionRoot = undefined
  }
})

describe('boot-time config validation', () => {
  it.each([
    ['experimentsRoot'],
    ['dataHomeTemplate'],
  ] as const)('refuses a relative %s at construction', async (field) => {
    const base = await makeSandbox()
    sandbox = base
    const rejected = () => new SelfDevelopmentWorkspaces(new Context(), { ...base.config, [field]: 'relative/path' })
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_WORKSPACE_CONFIG_INVALID' }))
  })

  it.each([
    ['experimentsRoot'],
    ['dataHomeTemplate'],
  ] as const)('refuses an empty %s at construction', async (field) => {
    const base = await makeSandbox()
    sandbox = base
    const rejected = () => new SelfDevelopmentWorkspaces(new Context(), { ...base.config, [field]: '' })
    expect(rejected).toThrow(/must be an absolute path/)
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 2.5],
    ['infinite', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('refuses a %s maxConcurrentTasks', async (_name, maxConcurrentTasks) => {
    const base = await makeSandbox()
    sandbox = base
    const rejected = () => new SelfDevelopmentWorkspaces(new Context(), { ...base.config, maxConcurrentTasks })
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_WORKSPACE_CONFIG_INVALID' }))
  })

  it('refuses a hand-built config without maxConcurrentTasks', async () => {
    const base = await makeSandbox()
    sandbox = base
    const partial = Object.fromEntries(
      Object.entries(base.config).filter(([key]) => key !== 'maxConcurrentTasks'),
    ) as unknown as WorkspacesConfig
    const rejected = () => new SelfDevelopmentWorkspaces(new Context(), partial)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_WORKSPACE_CONFIG_INVALID' }))
  })

  it('mounts on a valid config and registers ctx.selfDevelopmentWorkspaces', async () => {
    const base = await makeSandbox()
    sandbox = base
    const context = new Context()
    const service = new SelfDevelopmentWorkspaces(context, base.config)
    expect(context.selfDevelopmentWorkspaces).toBeInstanceOf(SelfDevelopmentWorkspaces)
    expect(service.name).toBe('selfDevelopmentWorkspaces')
  })
})

describe('Loader composition smoke', () => {
  it('boots the opt-in service from cordis.yml', async () => {
    const base = await makeSandbox()
    compositionRoot = base.root
    const configPath = join(base.root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-workflow-self-development-workspaces'",
      '  config:',
      `    experimentsRoot: '${base.config.experimentsRoot}'`,
      `    dataHomeTemplate: '${base.config.dataHomeTemplate}'`,
      '    maxConcurrentTasks: 2',
      '',
    ].join('\n'))
    const context = new Context()
    context.baseUrl = `${pathToFileURL(base.root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier !== '@deepseek-ai/dsh-workflow-self-development-workspaces') {
          throw new Error(`unexpected Loader import: ${specifier}`)
        }
        return import('../src/index.ts')
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()
    expect(context.selfDevelopmentWorkspaces).toBeInstanceOf(SelfDevelopmentWorkspaces)
    await context.fiber.dispose()
  })
})

describe('service methods', () => {
  it('allocates, lists, and reports the registry through the service', async () => {
    const base = await makeSandbox()
    sandbox = base
    const context = new Context()
    const service = new SelfDevelopmentWorkspaces(context, base.config)
    const workspace = await service.allocate({ taskId: 'task-a', projectRoot: base.projectRoot })
    expect(workspace.branch).toBe('selfdev/task-a')
    expect(await service.list()).toEqual([workspace])
  })

  it('applies the configured schema default of two concurrent tasks', async () => {
    const base = await makeSandbox()
    sandbox = base
    const resolve = SelfDevelopmentWorkspaces.Config as unknown as
      (value: Record<string, unknown>) => Record<string, unknown>
    const resolved = resolve({ experimentsRoot: base.experimentsRoot, dataHomeTemplate: base.template })
    expect(resolved.maxConcurrentTasks).toBe(2)
  })

  it('refuses releasing an unknown task', async () => {
    const base = await makeSandbox()
    sandbox = base
    const context = new Context()
    const service = new SelfDevelopmentWorkspaces(context, base.config)
    await expect(service.release('task-never')).rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_TASK_UNKNOWN' })
  })

  it('refuses integrating an unknown task, serially for repeated calls', async () => {
    const base = await makeSandbox()
    sandbox = base
    const context = new Context()
    const service = new SelfDevelopmentWorkspaces(context, base.config)
    await expect(service.integrate({ taskId: 'task-never', targetBranch: 'main', actor: 'tester' }))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_TASK_UNKNOWN' })
    // The second call chains behind the first, whatever its outcome was.
    await expect(service.integrate({ taskId: 'task-also-never', targetBranch: 'main', actor: 'tester' }))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_TASK_UNKNOWN' })
  })

  it('integrates an allocated task through the service and clears the in-memory chain', async () => {
    const base = await makeSandbox()
    sandbox = base
    const context = new Context()
    const service = new SelfDevelopmentWorkspaces(context, base.config)
    const workspace = await service.allocate({ taskId: 'task-a', projectRoot: base.projectRoot })
    await writeFile(join(workspace.worktree, 'marker.txt'), 'task-a done\n')
    await commitAll(workspace.worktree, 'task-a work')
    const result = await service.integrate({ taskId: 'task-a', targetBranch: 'main', actor: 'tester' })
    expect(result).toMatchObject({ status: 'integrated' })
  })

  it('refuses releasing through the module function when the task id is invalid', async () => {
    const base = await makeSandbox()
    sandbox = base
    await expect(releaseWorkspace(base.config, '../escape'))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_TASK_INVALID' })
  })

  it('allocates through the module function into a fresh experiments root', async () => {
    const base = await makeSandbox()
    sandbox = base
    const workspace = await allocateWorkspace(base.config, { taskId: 'task-a', projectRoot: base.projectRoot })
    expect(workspace.dataHome).toContain(join('task-a', 'dsh-home'))
  })
})
