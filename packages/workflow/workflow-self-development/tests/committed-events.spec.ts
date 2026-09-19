/**
 * Post-commit event emission: the `self-development/committed` Cordis event,
 * the injected `onCommitted` observer, and the containment of throwing
 * observers. A commit is durable before any observer runs, so no observer can
 * change the task state or fail the calling operation.
 * @module committed-events.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SelfDevelopmentTaskController } from '../src/controller.ts'
import { TaskJournal } from '../src/journal.ts'
import SelfDevelopmentTasks from '../src/index.ts'
import { attemptInputs, ARTIFACT, FakeClock, header, openReadyTask, SOURCE, SPEC } from './helpers.ts'
import type { SelfDevelopmentCommittedPayload } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Build the service against a fresh absolute control directory. */
async function makeService(): Promise<{ service: SelfDevelopmentTasks; control: string }> {
  const control = await mkdtemp(join(tmpdir(), 'self-dev-events-'))
  root = control
  context = new Context()
  const service = new SelfDevelopmentTasks(context, {
    controlDirectory: join(control, 'control'),
    maxRecordsPerSegment: 64,
    checkpointInterval: 4,
  })
  return { service, control }
}

describe('self-development/committed event', () => {
  it('emits one payload per durable commit with the record and the post-commit projection', async () => {
    const { service } = await makeService()
    const payloads: SelfDevelopmentCommittedPayload[] = []
    context!.on('self-development/committed', (payload) => { payloads.push(payload) })
    const clock = new FakeClock()
    const controller = await service.open('task-1', clock)
    await controller.createTask({ ...header(0, 'create'), spec: SPEC })
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.taskId).toBe('task-1')
    expect(payloads[0]?.record.event.type).toBe('task/created')
    expect(payloads[0]?.projection).toMatchObject({ status: 'draft', revision: 1 })
    expect(payloads[0]?.record.seq).toBe(1)
  })

  it('emits recovery commits when a restarted host reopens a task left attempting', async () => {
    const { control } = await makeService()
    const clock = new FakeClock()
    const { controller, revision } = await openReadyTask(join(control, 'control', 'tasks', 'task-1'), clock)
    void controller.startAttempt({
      ...header(revision, 'attempt'), ...attemptInputs(clock), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: () => new Promise(() => {}),
    })
    const payloads: SelfDevelopmentCommittedPayload[] = []
    const restartContext = new Context()
    restartContext.on('self-development/committed', (payload) => { payloads.push(payload) })
    const restarted = new SelfDevelopmentTasks(restartContext, {
      controlDirectory: join(control, 'control'),
      maxRecordsPerSegment: 64,
      checkpointInterval: 4,
    })
    const state = await restarted.state('task-1', new FakeClock())
    expect(state.status).toBe('handoff')
    expect(payloads.map(payload => payload.record.event.type)).toEqual(['attempt/failed', 'handoff/raised'])
    await restartContext.fiber.dispose()
  })

  it('contains a throwing listener: the commit stays durable and the failure is logged', async () => {
    const { service } = await makeService()
    context!.on('self-development/committed', () => { throw new Error('listener exploded') })
    const warn = vi.spyOn(context!.logger, 'warn').mockImplementation(() => {})
    const clock = new FakeClock()
    const controller = await service.open('task-1', clock)
    await controller.createTask({
      ...header(0, 'create'),
      spec: { taskId: 'task-1', version: 1, requirement: 'add chat transcript search', allowedModificationScope: ['src'], stableBaselineDigest: 'a'.repeat(64), createdBy: 'user' },
    })
    expect(controller.projection).toMatchObject({ status: 'draft', revision: 1 })
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('onCommitted controller observer', () => {
  it('receives every committed record with the latest projection and survives throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-dev-observer-'))
    root = dir
    const observed: { seq: number; status: string }[] = []
    const journal = await TaskJournal.open(join(dir, 'task-1'), { maxRecordsPerSegment: 64, checkpointInterval: 4 })
    const clock = new FakeClock()
    const controller = await SelfDevelopmentTaskController.open({
      taskId: 'task-1',
      journal,
      clock,
      onCommitted: (record, projection) => {
        observed.push({ seq: record.seq, status: projection.status })
        throw new Error('observer exploded')
      },
    })
    await controller.createTask({
      ...header(0, 'create'),
      spec: { taskId: 'task-1', version: 1, requirement: 'add chat transcript search', allowedModificationScope: ['src'], stableBaselineDigest: 'a'.repeat(64), createdBy: 'user' },
    })
    await controller.authorizePlanning({ ...header(1, 'authorize'), authorizedBy: 'user' })
    expect(observed).toEqual([
      { seq: 1, status: 'draft' },
      { seq: 2, status: 'planning-authorized' },
    ])
    expect(controller.projection.revision).toBe(2)
  })
})
