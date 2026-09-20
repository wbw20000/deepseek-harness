/**
 * Facade behavior against the real task-control service: the disabled switch,
 * wire validation, the actor allowlist, the missing-runner refusals, the
 * read paths and their confirmation card, and the boundary conversion of core
 * rejections into `self-development/core`. The supervised attempt lifecycle
 * itself runs in the real-Loader composition spec.
 * @module facade.spec
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SelfDevelopmentError, SelfDevelopmentTasks, TaskSpecVersion, TestPlanVersion } from '@deepseek-ai/dsh-workflow-self-development'
import SelfDevelopmentEvents from '@deepseek-ai/dsh-workflow-self-development-events'
import SelfDevelopmentRemote from '../src/index.ts'
import { SelfDevelopmentRemoteError } from '../src/errors.ts'
import type { RemoteRunAttemptRequest } from '../src/types.ts'
import { makeEnvironment } from './helpers.ts'
import type { Environment } from './helpers.ts'

const TASK_ID = 'task-remote-facade'

const SPEC = {
  taskId: TASK_ID,
  version: 1,
  requirement: '让标记文件读作 DONE',
  allowedModificationScope: ['marker.txt'],
  stableBaselineDigest: 'a'.repeat(64),
  createdBy: 'tester',
}

const DRAFT = {
  requiredCases: [{ caseId: 'build', requirement: 'the marker reads DONE', assertionIds: ['a1', 'a2'] }],
  manualCases: [],
}

const PLAN = {
  testPlanId: 'plan-1',
  version: TestPlanVersion(1),
  taskSpecVersion: TaskSpecVersion(1),
  ...DRAFT,
}

const APPROVAL = {
  mode: 'both' as const,
  maxRounds: 5,
  durationMs: 120_000,
  phaseTimeoutMs: 20_000,
  maxStepsPerAttempt: 10,
  testPlanVersion: TestPlanVersion(1),
  taskSpecVersion: TaskSpecVersion(1),
  approvedBy: 'tester',
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot the real task-control service and the facade over one environment. */
async function makeFacade(options: {
  readonly enabled?: boolean
  readonly allowedActors?: string[]
  /** Load the real events consumer alongside the facade. */
  readonly withEvents?: boolean
} = {}): Promise<SelfDevelopmentRemote> {
  const env = await makeEnvironment()
  root = env.base
  context = new Context()
  new SelfDevelopmentTasks(context, {
    controlDirectory: env.controlDirectory,
    maxRecordsPerSegment: 100,
    checkpointInterval: 10,
  })
  if (options.withEvents === true) new SelfDevelopmentEvents(context, {})
  return new SelfDevelopmentRemote(context, {
    enabled: options.enabled ?? true,
    allowedActors: options.allowedActors ?? [],
    controlDirectory: env.controlDirectory,
    maxConcurrentCampaigns: 2,
    roundDelayMs: 0,
  })
}

describe('boot-time config validation', () => {
  it('refuses a relative control directory at construction', async () => {
    const env: Environment = await makeEnvironment()
    root = env.base
    context = new Context()
    const rejected = () => new SelfDevelopmentRemote(context!, {
      enabled: true,
      allowedActors: [],
      controlDirectory: 'relative/control',
      maxConcurrentCampaigns: 2,
      roundDelayMs: 0,
    })
    expect(rejected).toThrow(expect.objectContaining({ code: 'self-development/config-invalid' }))
  })
})

describe('disabled switch', () => {
  it('refuses every method with a RemoteError carrying self-development/disabled while enabled is false', async () => {
    const facade = await makeFacade({ enabled: false })
    const refusal = await facade.listTasks().then(
      () => { throw new Error('expected listTasks to refuse') },
      (error: unknown) => error,
    )
    expect(refusal).toBeInstanceOf(RemoteError)
    expect(refusal).toBeInstanceOf(SelfDevelopmentRemoteError)
    expect((refusal as SelfDevelopmentRemoteError).code).toBe('self-development/disabled')
    expect((refusal as SelfDevelopmentRemoteError).name).toBe('SelfDevelopmentRemoteError')
    await expect(facade.getTask(TASK_ID)).rejects.toMatchObject({ code: 'self-development/disabled' })
    await expect(facade.getTask(TASK_ID)).rejects.toMatchObject({ code: 'self-development/disabled' })
    await expect(facade.createTask(SPEC, 0)).rejects.toMatchObject({ code: 'self-development/disabled' })
    await expect(facade.authorizePlanning(TASK_ID, 1, 'tester'))
      .rejects.toMatchObject({ code: 'self-development/disabled' })
    await expect(facade.submitPlanDraft(TASK_ID, 2, DRAFT)).rejects.toMatchObject({ code: 'self-development/disabled' })
    await expect(facade.confirmPlan(TASK_ID, 3, PLAN, 'tester')).rejects.toMatchObject({ code: 'self-development/disabled' })
    await expect(facade.approveBudget(TASK_ID, 4, APPROVAL)).rejects.toMatchObject({ code: 'self-development/disabled' })
    await expect(facade.stop(TASK_ID, 5)).rejects.toMatchObject({ code: 'self-development/disabled' })
    await expect(facade.recordTrialApproval(TASK_ID, 6, 'tester'))
      .rejects.toMatchObject({ code: 'self-development/disabled' })
    await expect(facade.runAttempt({
      taskId: TASK_ID,
      expectedRevision: 5,
      worktree: '/tmp/wt',
      artifactPaths: ['marker.txt'],
      acceptancePath: '/tmp/acceptance.json',
      confirmedBy: 'tester',
      loopbackAllowlist: [],
      presenceAcknowledged: true,
    })).rejects.toMatchObject({ code: 'self-development/disabled' })
    await expect(facade.activeTasks()).rejects.toMatchObject({ code: 'self-development/disabled' })
    await expect(facade.recentEvents()).rejects.toMatchObject({ code: 'self-development/disabled' })
  })
})

describe('wire validation', () => {
  it('refuses a malformed spec, revision, and task id', async () => {
    const facade = await makeFacade()
    await expect(facade.createTask({ ...SPEC, requirement: '' }, 0))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.createTask(SPEC, -1)).rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.getTask('../escape')).rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.authorizePlanning(TASK_ID, 1, '')).rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.submitPlanDraft(TASK_ID, 2, {
      requiredCases: [{ caseId: '', requirement: 'r', assertionIds: ['a1'] }],
      manualCases: [],
    })).rejects.toMatchObject({ code: 'self-development/config-invalid' })
  })

  it('refuses runAttempt without an explicit presence acknowledgement', async () => {
    const facade = await makeFacade()
    const base = {
      taskId: TASK_ID,
      expectedRevision: 5,
      worktree: '/tmp/wt',
      artifactPaths: ['marker.txt'],
      acceptancePath: '/tmp/acceptance.json',
      confirmedBy: 'tester',
      loopbackAllowlist: [],
    }
    await expect(facade.runAttempt(base as unknown as RemoteRunAttemptRequest))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.runAttempt({ ...base, presenceAcknowledged: false }))
      .rejects.toMatchObject({ code: 'self-development/presence-unconfirmed' })
    await expect(facade.runAttempt({ ...base, worktree: 'relative/wt', presenceAcknowledged: true }))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.runAttempt({ ...base, acceptancePath: 'relative/acceptance.json', presenceAcknowledged: true }))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.runAttempt({ ...base, dataHome: 'relative/home', presenceAcknowledged: true }))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
  })
})

describe('actor allowlist', () => {
  it('refuses the actor-gated methods for an unlisted actor before the core is touched', async () => {
    const facade = await makeFacade({ allowedActors: ['alice'] })
    await expect(facade.createTask(SPEC, 0)).rejects.toMatchObject({ code: 'self-development/actor-forbidden' })
    await expect(facade.createTask({ ...SPEC, createdBy: 'alice' }, 0)).resolves.toMatchObject({
      taskId: TASK_ID,
      replayed: false,
    })
    await expect(facade.confirmPlan(TASK_ID, 3, PLAN, 'bob'))
      .rejects.toMatchObject({ code: 'self-development/actor-forbidden' })
    await expect(facade.approveBudget(TASK_ID, 4, { ...APPROVAL, approvedBy: 'bob' }))
      .rejects.toMatchObject({ code: 'self-development/actor-forbidden' })
    await expect(facade.recordTrialApproval(TASK_ID, 4, 'bob'))
      .rejects.toMatchObject({ code: 'self-development/actor-forbidden' })
  })

  it('keeps progress, planning, drafting, and stop open to any actor', async () => {
    const facade = await makeFacade({ allowedActors: ['alice'] })
    await facade.createTask({ ...SPEC, createdBy: 'alice' }, 0)
    await facade.authorizePlanning(TASK_ID, 1, 'nobody')
    await facade.submitPlanDraft(TASK_ID, 2, DRAFT)
    await facade.confirmPlan(TASK_ID, 3, PLAN, 'alice')
    await facade.approveBudget(TASK_ID, 4, { ...APPROVAL, approvedBy: 'alice' })
    await expect(facade.stop(TASK_ID, 5, 'cancelled')).resolves.toMatchObject({ taskId: TASK_ID, replayed: false })
  })
})

describe('missing runner', () => {
  it('refuses runAttempt with self-development/runner-unavailable and keeps activeTasks empty', async () => {
    const facade = await makeFacade()
    await expect(facade.runAttempt({
      taskId: TASK_ID,
      expectedRevision: 0,
      worktree: '/tmp/wt',
      artifactPaths: ['marker.txt'],
      acceptancePath: '/tmp/acceptance.json',
      confirmedBy: 'tester',
      loopbackAllowlist: [],
      presenceAcknowledged: true,
    })).rejects.toMatchObject({ code: 'self-development/runner-unavailable' })
    await expect(facade.activeTasks()).resolves.toEqual([])
  })
})

describe('recent events', () => {
  it('returns an empty buffer when the events consumer plugin is not loaded', async () => {
    const facade = await makeFacade()
    await expect(facade.recentEvents()).resolves.toEqual([])
  })

  it('returns the events consumer\'s title-level buffer after a plan draft commit', async () => {
    const facade = await makeFacade({ withEvents: true })
    await facade.createTask(SPEC, 0)
    await facade.authorizePlanning(TASK_ID, 1, 'tester')
    await facade.submitPlanDraft(TASK_ID, 2, DRAFT)
    const events = await facade.recentEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      taskId: TASK_ID,
      kind: 'awaiting-decision',
      title: 'Plan drafted, awaiting confirmation',
      revision: 3,
    })
    expect(typeof events[0]?.occurredAt).toBe('number')
  })
})

describe('read paths and the confirmation card', () => {
  it('refuses getTask for an unknown task without creating its journal directory', async () => {
    const facade = await makeFacade()
    await expect(facade.getTask('never-created')).rejects.toMatchObject({ code: 'self-development/task-unknown' })
    await expect(facade.listTasks()).resolves.toEqual([])
  })

  it('returns an empty card for a task journal that exists without a spec', async () => {
    const facade = await makeFacade()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root!, 'control', 'tasks', 'empty-task'), { recursive: true })
    const listed = await facade.listTasks()
    expect(listed).toEqual([{
      taskId: 'empty-task',
      status: 'draft',
      revision: 0,
      title: '',
    }])
    const detail = await facade.getTask('empty-task')
    expect(detail.projection.spec).toBeUndefined()
    expect(detail.card.taskAndGoal).toBe('')
    expect(detail.card.acceptanceCases).toEqual([])
    expect(detail.card.manualCases).toEqual([])
    expect(detail.card.stableBaselineDigest).toBeUndefined()
    expect(detail.card.allowedModificationScope).toEqual([])
    expect(detail.card.budget).toEqual({
      mode: undefined,
      maxRounds: undefined,
      durationMs: undefined,
      phaseTimeoutMs: undefined,
      maxStepsPerAttempt: undefined,
      noProgressAttemptLimit: undefined,
    })
  })

  it('skips non-directory entries and rethrows non-ENOENT listing failures', async () => {
    const facade = await makeFacade()
    await facade.createTask(SPEC, 0)
    const { chmod, writeFile } = await import('node:fs/promises')
    await writeFile(join(root!, 'control', 'tasks', 'stray-file'), 'not a journal')
    await expect(facade.listTasks()).resolves.toHaveLength(1)
    await chmod(join(root!, 'control', 'tasks'), 0o000)
    try {
      await expect(facade.listTasks()).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(join(root!, 'control', 'tasks'), 0o755)
    }
  })

  it('returns the full card after the lifecycle reaches a budget approval', async () => {
    const facade = await makeFacade()
    await facade.createTask(SPEC, 0)
    const beforePlanning = await facade.getTask(TASK_ID)
    expect(beforePlanning.card.planningAuthorized).toBe(false)
    expect(beforePlanning.card.acceptanceCases).toEqual([])
    expect(beforePlanning.card.budget.mode).toBeUndefined()
    const listed = await facade.listTasks()
    expect(listed).toEqual([{
      taskId: TASK_ID,
      status: 'draft',
      revision: 1,
      title: '让标记文件读作 DONE',
    }])
    await facade.authorizePlanning(TASK_ID, 1, 'tester')
    await facade.submitPlanDraft(TASK_ID, 2, DRAFT)
    await facade.confirmPlan(TASK_ID, 3, PLAN, 'tester')
    await facade.approveBudget(TASK_ID, 4, APPROVAL)

    const detail = await facade.getTask(TASK_ID)
    expect(detail.projection.status).toBe('ready')
    expect(detail.projection.revision).toBe(5)
    expect(detail.card).toEqual({
      taskId: TASK_ID,
      taskAndGoal: '让标记文件读作 DONE',
      acceptanceCases: PLAN.requiredCases,
      manualCases: [],
      planningAuthorized: true,
      suggestedBudgetBasis: '无依据',
      stableBaselineDigest: SPEC.stableBaselineDigest,
      allowedModificationScope: ['marker.txt'],
      budget: {
        mode: 'both',
        maxRounds: 5,
        durationMs: 120_000,
        phaseTimeoutMs: 20_000,
        maxStepsPerAttempt: 10,
        noProgressAttemptLimit: undefined,
      },
      consumedBudget: { rounds: 0, timeMs: 0 },
      costLimits: '未知，不放行',
    })
  })

  it('projects rounds-only and time-only budgets onto the card with absent unset terms', async () => {
    const facade = await makeFacade()
    await facade.createTask(SPEC, 0)
    await facade.authorizePlanning(TASK_ID, 1, 'tester')
    await facade.submitPlanDraft(TASK_ID, 2, DRAFT)
    await facade.confirmPlan(TASK_ID, 3, PLAN, 'tester')

    await facade.approveBudget(TASK_ID, 4, {
      mode: 'rounds',
      maxRounds: 3,
      phaseTimeoutMs: 5_000,
      maxStepsPerAttempt: 7,
      testPlanVersion: TestPlanVersion(1),
      taskSpecVersion: TaskSpecVersion(1),
      approvedBy: 'tester',
    })
    const roundsCard = (await facade.getTask(TASK_ID)).card.budget
    expect(roundsCard).toEqual({
      mode: 'rounds',
      maxRounds: 3,
      phaseTimeoutMs: 5_000,
      maxStepsPerAttempt: 7,
    })

    await facade.approveBudget(TASK_ID, 5, {
      mode: 'time',
      durationMs: 60_000,
      noProgressAttemptLimit: 2,
      testPlanVersion: TestPlanVersion(1),
      taskSpecVersion: TaskSpecVersion(1),
      approvedBy: 'tester',
    })
    const timeCard = (await facade.getTask(TASK_ID)).card.budget
    expect(timeCard).toEqual({
      mode: 'time',
      durationMs: 60_000,
      noProgressAttemptLimit: 2,
    })
  })

  it('trims the task row title to 80 code points', async () => {
    const facade = await makeFacade()
    const long = `标${'记'.repeat(100)}END`
    await facade.createTask({ ...SPEC, requirement: long }, 0)
    const listed = await facade.listTasks()
    expect(listed[0]?.title).toBe(`标${'记'.repeat(79)}`)
    expect(Array.from(listed[0]?.title ?? '')).toHaveLength(80)
  })
})

describe('core boundary conversion', () => {
  it('converts the core revision conflict into the self-development/core failure with the original code', async () => {
    const facade = await makeFacade()
    await facade.createTask(SPEC, 0)
    const rejection = await facade.authorizePlanning(TASK_ID, 99, 'tester').then(
      () => { throw new Error('expected authorizePlanning to refuse') },
      (error: unknown) => error,
    )
    expect(rejection).toBeInstanceOf(RemoteError)
    expect((rejection as RemoteError).code).toBe('self-development/core')
    expect((rejection as RemoteError<'self-development/core'>).details.code).toBe('SELF_DEV_REVISION_CONFLICT')
    expect((rejection as { cause: unknown }).cause).toBeInstanceOf(SelfDevelopmentError)
  })

  it('refuses a duplicate spec under a fresh facade operation id with the core code in details', async () => {
    const facade = await makeFacade()
    const first = await facade.createTask(SPEC, 0)
    expect(first.replayed).toBe(false)
    // A second facade call generates its own operation id, so the core treats
    // it as a new operation and refuses the duplicate spec.
    await expect(facade.createTask(SPEC, 1)).rejects.toMatchObject({
      code: 'self-development/core',
      details: { code: 'SELF_DEV_INVALID_STATE' },
    })
    expect(first.operationId).not.toBe('')
  })

  it('stops through the core when the runner is absent', async () => {
    const facade = await makeFacade()
    await facade.createTask(SPEC, 0)
    await expect(facade.stop(TASK_ID, 1)).resolves.toMatchObject({ taskId: TASK_ID, revision: 2 })
    const detail = await facade.getTask(TASK_ID)
    expect(detail.projection.status).toBe('stopped')
    expect(detail.projection.stopReason).toBe('cancelled')
  })
})
