/**
 * Service boundary behavior: boot-time config validation, task-id path
 * validation before any directory is created, and the Loader composition
 * smoke for the opt-in service lifecycle.
 * @module service.spec
 */

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SelfDevelopmentTasks from '../src/index.ts'
import { SelfDevOperationId, SelfDevTaskId } from '../src/runtime.ts'
import { attemptInputs, BUDGET_ONE_ROUND, FakeClock, SOURCE, ARTIFACT, TASK_ID, SPEC, PLAN, DRAFT, header, passingResult } from './helpers.ts'
import type { SelfDevelopmentTaskController } from '../src/controller.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Build the service against a fresh absolute control directory. */
async function makeService(
  overrides: Partial<ConstructorParameters<typeof SelfDevelopmentTasks>[1]> = {},
): Promise<{ service: SelfDevelopmentTasks; root: string }> {
  const control = await mkdtemp(join(tmpdir(), 'self-dev-service-'))
  root = control
  context = new Context()
  const service = new SelfDevelopmentTasks(context, {
    controlDirectory: join(control, 'control'),
    maxRecordsPerSegment: 64,
    checkpointInterval: 4,
    ...overrides,
  })
  return { service, root: control }
}

describe('boot-time config validation', () => {
  it('refuses a relative control directory at construction', async () => {
    const rejected = () => new SelfDevelopmentTasks(new Context(), {
      controlDirectory: 'relative/control',
      maxRecordsPerSegment: 64,
      checkpointInterval: 4,
    })
    expect(rejected).toThrow(/controlDirectory/)
  })

  it.each([
    ['zero segments', { maxRecordsPerSegment: 0 }],
    ['fractional checkpoint interval', { checkpointInterval: 2.5 }],
    ['infinite bound', { maxRecordsPerSegment: Number.POSITIVE_INFINITY }],
    ['NaN bound', { checkpointInterval: Number.NaN }],
  ])('refuses %s', (_name, overrides) => {
    const rejected = () => new SelfDevelopmentTasks(new Context(), {
      controlDirectory: '/tmp/self-dev-config',
      maxRecordsPerSegment: 64,
      checkpointInterval: 4,
      ...overrides,
    })
    expect(rejected).toThrow(/config is invalid/)
  })
})

describe('task-id path validation', () => {
  it.each([
    ['../escape'],
    ['/etc/passwd'],
    ['a/b'],
    [''],
  ])('refuses task id %s before any directory is created', async (escape) => {
    const { service, root: control } = await makeService()
    const rejected = service.open(escape, new FakeClock())
    await expect(rejected).rejects.toThrow(/path component/)
    await expect(stat(join(control, 'control', 'tasks', escape))).rejects.toBeTruthy()
  })
})

describe('service lifecycle', () => {
  it('drives one full task through the service and caches the controller', async () => {
    const { service } = await makeService()
    const clock = new FakeClock()
    const controller = await service.open(TASK_ID, clock)
    expect(await service.open(TASK_ID, clock)).toBe(controller)
    await controller.createTask({ ...header(0, 'create'), spec: SPEC })
    await controller.authorizePlanning({ ...header(1, 'authorize'), authorizedBy: 'user' })
    await controller.submitPlanDraft({ ...header(2, 'draft'), draft: DRAFT })
    await controller.confirmPlan({ ...header(3, 'confirm'), plan: PLAN })
    await controller.approveBudget({ ...header(4, 'budget'), approval: BUDGET_ONE_ROUND })
    await controller.startAttempt({
      ...header(5, 'attempt'), ...attemptInputs(clock), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async attempt => passingResult(attempt),
    })
    const state = await service.state(TASK_ID, clock)
    expect(state).toMatchObject({ status: 'awaiting-trial', revision: 7 })
    expect(service.isJournalHandoff(new Error('unrelated'))).toBe(false)
  })
})

describe('Loader composition smoke', () => {
  it('boots the opt-in service from cordis.yml and drives one task lifecycle', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(join(configPath), [
      "- name: '@deepseek-ai/dsh-workflow-self-development'",
      '  config:',
      `    controlDirectory: '${join(root, 'control')}'`,
      '    maxRecordsPerSegment: 64',
      '    checkpointInterval: 4',
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = `${pathToFileURL(root).href}/`
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier !== '@deepseek-ai/dsh-workflow-self-development') {
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
    const service = context.selfDevelopmentTasks
    expect(service).toBeInstanceOf(SelfDevelopmentTasks)
    const controller: SelfDevelopmentTaskController = await service.open('loader-task', new FakeClock())
    await controller.createTask({
      taskId: SelfDevTaskId('loader-task'), expectedRevision: 0, operationId: SelfDevOperationId('create'), spec: { ...SPEC, taskId: 'loader-task' },
    })
    expect(controller.projection.status).toBe('draft')
    await context.fiber.dispose()
    context = undefined
  })
})
