/**
 * Unattended campaigns: the `campaigns/<taskId>.json` storage layer
 * (`campaign.ts`), the `startCampaign`/`campaign`/`stopCampaign` facade
 * methods, the campaign loop's round-by-round state machine driven through a
 * scripted runner double, the restart recovery scan, the concurrency cap,
 * host-only enforcement, and `approveBudget`'s `preset: 'unlimited'`
 * convenience field.
 * @module campaign.spec
 */

import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HostClock, SelfDevelopmentRunnerError } from '@deepseek-ai/dsh-workflow-self-development-runner'
import type {
  SelfDevelopmentRunner,
  SupervisedAttemptOutcome,
  SupervisedAttemptRequest,
} from '@deepseek-ai/dsh-workflow-self-development-runner'
import {
  SelfDevelopmentError,
  SelfDevelopmentTasks,
  SelfDevOperationId,
  SelfDevTaskId,
  TestPlanVersion,
  TaskSpecVersion,
} from '@deepseek-ai/dsh-workflow-self-development'
import SelfDevelopmentEvents from '@deepseek-ai/dsh-workflow-self-development-events'
import SelfDevelopmentRemote from '../src/index.ts'
import { SelfDevelopmentRemoteError } from '../src/errors.ts'
import {
  campaignPath,
  countRunningCampaigns,
  listCampaigns,
  PROCESS_RESTARTED_REASON,
  readCampaign,
  stopRunningCampaignsAfterRestart,
  writeCampaign,
} from '../src/campaign.ts'
import type { CampaignRecord } from '../src/campaign.ts'
import type { CampaignOptions, RemoteConnectionCaller } from '../src/types.ts'
import { makeEnvironment } from './helpers.ts'
import type { Environment } from './helpers.ts'

const TASK_ID = 'task-remote-campaign'

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
  maxRounds: 20,
  durationMs: 3_600_000,
  phaseTimeoutMs: 20_000,
  maxStepsPerAttempt: 10,
  noProgressAttemptLimit: 5,
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

/** One caller context as the frozen connection contract defines it. */
function callerOf(loopback: boolean): RemoteConnectionCaller {
  return {
    sessionId: 'chat-1',
    host: loopback ? '127.0.0.1:8787' : 'phone.example.invalid:8787',
    loopback,
    certificateSerial: undefined,
  }
}

/** One pending round: settles only when the test calls `settle`. */
interface HangingRound {
  readonly settlePass: (attemptId: string) => void
  readonly settleError: (error: unknown) => void
}

/** A runner test double whose `runAttempt` outcomes are scripted per call. */
function scriptedRunner(): {
  readonly service: SelfDevelopmentRunner
  readonly requests: SupervisedAttemptRequest[]
  readonly stopCalls: Array<{ readonly taskId: string; readonly expectedRevision: number; readonly operationId: string }>
  /** Queue one outcome (`'pass'` or any value to throw, `Error` or not) for the next `runAttempt` call. */
  enqueue(outcome: unknown): void
  /** Queue a round that stays pending until the returned controls settle it. */
  enqueueHanging(): HangingRound
} {
  const requests: SupervisedAttemptRequest[] = []
  const stopCalls: Array<{ taskId: string; expectedRevision: number; operationId: string }> = []
  const queue: unknown[] = []
  const hangs: Array<{ resolve: (outcome: SupervisedAttemptOutcome) => void; reject: (error: unknown) => void }> = []
  const service = {
    runAttempt: vi.fn(async (request: SupervisedAttemptRequest): Promise<SupervisedAttemptOutcome> => {
      requests.push(request)
      const next = queue.shift() ?? 'pass'
      if (next === 'hang') {
        return new Promise<SupervisedAttemptOutcome>((resolve, reject) => {
          hangs.push({ resolve, reject })
        })
      }
      if (next !== 'pass') throw next
      const attemptId = `attempt-${requests.length}`
      return {
        operation: { revision: request.expectedRevision + 1, replayed: false },
        attemptId,
        evidencePath: `/evidence/${attemptId}.json`,
        outcomeWriteError: undefined,
      }
    }),
    stop: vi.fn(async (request: { taskId: string; expectedRevision: number; operationId: string }) => {
      stopCalls.push(request)
      return { taskId: request.taskId, operationId: request.operationId, revision: request.expectedRevision + 1, replayed: false }
    }),
    activeTasks: () => [],
    clock: () => new HostClock(),
  }
  return {
    service: service as unknown as SelfDevelopmentRunner,
    requests,
    stopCalls,
    enqueue: (outcome) => { queue.push(outcome) },
    enqueueHanging: () => {
      queue.push('hang')
      const index = hangs.length
      return {
        settlePass: (attemptId) => {
          // The hang resolves through the same queue position it was pushed
          // at, so this only ever targets the round this call scripted.
          hangs[index]?.resolve({
            operation: { revision: 1, replayed: false },
            attemptId,
            evidencePath: `/evidence/${attemptId}.json`,
            outcomeWriteError: undefined,
          })
        },
        settleError: (error) => { hangs[index]?.reject(error) },
      }
    },
  }
}

/** Boot the real task-control service, the real events consumer, and the facade over one environment. */
async function makeHarness(options: {
  readonly allowedActors?: readonly string[]
  readonly maxConcurrentCampaigns?: number
  readonly withRunner?: boolean
} = {}): Promise<{
  readonly facade: SelfDevelopmentRemote
  readonly events: SelfDevelopmentEvents
  readonly tasks: SelfDevelopmentTasks
  readonly env: Environment
  readonly runner: ReturnType<typeof scriptedRunner> | undefined
  readonly setCaller: (caller: RemoteConnectionCaller | undefined) => void
}> {
  const env = await makeEnvironment()
  root = env.base
  context = new Context()
  const tasks = new SelfDevelopmentTasks(context, {
    controlDirectory: env.controlDirectory,
    maxRecordsPerSegment: 100,
    checkpointInterval: 10,
  })
  const events = new SelfDevelopmentEvents(context, { recentLimit: 200 })
  const runner = options.withRunner === false ? undefined : scriptedRunner()
  if (runner !== undefined) context.provide('selfDevelopmentRunner', runner.service)
  let current: RemoteConnectionCaller | undefined
  context.provide('connection', { caller: { current: () => current } })
  const facade = new SelfDevelopmentRemote(context, {
    enabled: true,
    allowedActors: [...(options.allowedActors ?? [])],
    controlDirectory: env.controlDirectory,
    maxConcurrentCampaigns: options.maxConcurrentCampaigns ?? 2,
  })
  return { facade, events, tasks, env, runner, setCaller: (caller) => { current = caller } }
}

/** Drive one task to `ready` (spec, planning, plan, budget) and set its launch profile, under the given actor. */
async function readyTaskWithProfile(
  facade: SelfDevelopmentRemote,
  env: Environment,
  actor = 'tester',
): Promise<number> {
  let revision = (await facade.createTask({ ...SPEC, createdBy: actor }, 0)).revision
  revision = (await facade.authorizePlanning(TASK_ID, revision, actor)).revision
  revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
  revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, actor)).revision
  revision = (await facade.approveBudget(TASK_ID, revision, { ...APPROVAL, approvedBy: actor })).revision
  await facade.setLaunchProfile(TASK_ID, {
    worktree: env.worktree,
    acceptancePath: env.acceptancePath,
    artifactPaths: ['marker.txt'],
    confirmedBy: actor,
    loopbackAllowlist: [],
  })
  return revision
}

/** Standard `startCampaign` options. */
function options(overrides: Partial<CampaignOptions> = {}): CampaignOptions {
  return { unattended: true, acceptedBy: 'tester', ...overrides }
}

describe('boot-time config validation', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
  ])('refuses a %s maxConcurrentCampaigns at construction', async (_name, maxConcurrentCampaigns) => {
    const env = await makeEnvironment()
    root = env.base
    context = new Context()
    const rejected = () => new SelfDevelopmentRemote(context!, {
      enabled: true, allowedActors: [], controlDirectory: env.controlDirectory, maxConcurrentCampaigns,
    })
    expect(rejected).toThrow(expect.objectContaining({ code: 'self-development/config-invalid' }))
  })
})

describe('campaign record storage', () => {
  it('derives the documented record path', () => {
    expect(campaignPath('/control', 'task-1')).toBe('/control/campaigns/task-1.json')
  })

  it('returns undefined when no record exists', async () => {
    const env = await makeEnvironment()
    root = env.base
    await expect(readCampaign(env.controlDirectory, 'task-1')).resolves.toBeUndefined()
  })

  it('round-trips a record through the atomic writer, mode 0600 inside a 0700 directory', async () => {
    const env = await makeEnvironment()
    root = env.base
    const record: CampaignRecord = {
      taskId: 'task-1',
      status: 'running',
      startedAt: 1000,
      updatedAt: 1000,
      rounds: 0,
      acknowledgement: 'unattended-accepted',
      unattended: true,
      acceptedBy: 'tester',
    }
    await writeCampaign(env.controlDirectory, 'task-1', record)
    await expect(readCampaign(env.controlDirectory, 'task-1')).resolves.toEqual(record)
    const { stat } = await import('node:fs/promises')
    const fileMode = (await stat(campaignPath(env.controlDirectory, 'task-1'))).mode & 0o777
    const dirMode = (await stat(join(env.controlDirectory, 'campaigns'))).mode & 0o777
    expect(fileMode).toBe(0o600)
    expect(dirMode).toBe(0o700)
  })

  it('rejects non-JSON content, naming only the path', async () => {
    const env = await makeEnvironment()
    root = env.base
    await mkdir(join(env.controlDirectory, 'campaigns'), { recursive: true })
    await writeFile(campaignPath(env.controlDirectory, 'task-1'), 'not json')
    const rejection = await readCampaign(env.controlDirectory, 'task-1').catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(SelfDevelopmentRemoteError)
    expect((rejection as SelfDevelopmentRemoteError).code).toBe('self-development/config-invalid')
    expect((rejection as Error).message).toBe(`campaign record ${campaignPath(env.controlDirectory, 'task-1')} is not valid JSON`)
    expect((rejection as Error).message).not.toContain('not json')
  })

  it('rejects a record that fails shape validation, naming the path and the violated field', async () => {
    const env = await makeEnvironment()
    root = env.base
    await mkdir(join(env.controlDirectory, 'campaigns'), { recursive: true })
    await writeFile(campaignPath(env.controlDirectory, 'task-1'), JSON.stringify({ taskId: 'task-1' }))
    const rejection = await readCampaign(env.controlDirectory, 'task-1').catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(SelfDevelopmentRemoteError)
    expect((rejection as SelfDevelopmentRemoteError).code).toBe('self-development/config-invalid')
    expect((rejection as Error).message).toContain(campaignPath(env.controlDirectory, 'task-1'))
  })

  it('rethrows a non-ENOENT read failure', async () => {
    const env = await makeEnvironment()
    root = env.base
    await mkdir(campaignPath(env.controlDirectory, 'task-1'), { recursive: true })
    await expect(readCampaign(env.controlDirectory, 'task-1')).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('rejects a null or scalar stored record with the generic "record" prefix, not a field path', async () => {
    const env = await makeEnvironment()
    root = env.base
    await mkdir(join(env.controlDirectory, 'campaigns'), { recursive: true })
    const path = campaignPath(env.controlDirectory, 'task-1')
    await writeFile(path, 'null\n')
    await expect(readCampaign(env.controlDirectory, 'task-1'))
      .rejects.toMatchObject({ code: 'self-development/config-invalid', message: expect.stringContaining('record:') as unknown as string })
    await writeFile(path, '42\n')
    await expect(readCampaign(env.controlDirectory, 'task-1'))
      .rejects.toMatchObject({ code: 'self-development/config-invalid', message: expect.stringContaining('record:') as unknown as string })
  })

  it('rethrows a non-ENOENT listing failure', async () => {
    const env = await makeEnvironment()
    root = env.base
    await writeCampaign(env.controlDirectory, 'task-1', {
      taskId: 'task-1', status: 'running', startedAt: 1, updatedAt: 1, rounds: 0,
      acknowledgement: 'unattended-accepted', unattended: true, acceptedBy: 'tester',
    })
    const directory = join(env.controlDirectory, 'campaigns')
    await chmod(directory, 0o000)
    try {
      await expect(listCampaigns(env.controlDirectory)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(directory, 0o755)
    }
  })

  it('lists every stored record, skipping non-file and non-.json entries', async () => {
    const env = await makeEnvironment()
    root = env.base
    const record = (taskId: string): CampaignRecord => ({
      taskId,
      status: 'running',
      startedAt: 1,
      updatedAt: 1,
      rounds: 0,
      acknowledgement: 'unattended-accepted',
      unattended: true,
      acceptedBy: 'tester',
    })
    await writeCampaign(env.controlDirectory, 'task-a', record('task-a'))
    await writeCampaign(env.controlDirectory, 'task-b', { ...record('task-b'), status: 'passed' })
    await mkdir(join(env.controlDirectory, 'campaigns', 'not-a-file.json'), { recursive: true })
    await writeFile(join(env.controlDirectory, 'campaigns', 'stray.txt'), 'ignored')
    const listed = await listCampaigns(env.controlDirectory)
    expect(listed.map(entry => entry.taskId).sort()).toEqual(['task-a', 'task-b'])
  })

  it('returns an empty list before any campaign directory exists', async () => {
    const env = await makeEnvironment()
    root = env.base
    await expect(listCampaigns(env.controlDirectory)).resolves.toEqual([])
    await expect(countRunningCampaigns(env.controlDirectory)).resolves.toBe(0)
  })

  it('counts only running campaigns', async () => {
    const env = await makeEnvironment()
    root = env.base
    const base = {
      startedAt: 1, updatedAt: 1, rounds: 0, acknowledgement: 'unattended-accepted' as const, unattended: true, acceptedBy: 'tester',
    }
    await writeCampaign(env.controlDirectory, 'task-a', { ...base, taskId: 'task-a', status: 'running' })
    await writeCampaign(env.controlDirectory, 'task-b', { ...base, taskId: 'task-b', status: 'passed' })
    await writeCampaign(env.controlDirectory, 'task-c', { ...base, taskId: 'task-c', status: 'running' })
    await expect(countRunningCampaigns(env.controlDirectory)).resolves.toBe(2)
  })

  it('marks every running campaign stopped with the restart reason and leaves terminal ones untouched', async () => {
    const env = await makeEnvironment()
    root = env.base
    const base = {
      startedAt: 1, updatedAt: 1, rounds: 2, acknowledgement: 'unattended-accepted' as const, unattended: true, acceptedBy: 'tester',
    }
    await writeCampaign(env.controlDirectory, 'task-a', { ...base, taskId: 'task-a', status: 'running' })
    await writeCampaign(env.controlDirectory, 'task-b', { ...base, taskId: 'task-b', status: 'passed' })
    await stopRunningCampaignsAfterRestart(env.controlDirectory)
    const a = await readCampaign(env.controlDirectory, 'task-a')
    expect(a?.status).toBe('stopped')
    expect(a?.reason).toBe(PROCESS_RESTARTED_REASON)
    expect(a?.updatedAt).toBeGreaterThanOrEqual(1)
    const b = await readCampaign(env.controlDirectory, 'task-b')
    expect(b?.status).toBe('passed')
    expect(b?.reason).toBeUndefined()
  })

  it('is a no-op over an empty control directory', async () => {
    const env = await makeEnvironment()
    root = env.base
    await expect(stopRunningCampaignsAfterRestart(env.controlDirectory)).resolves.toBeUndefined()
  })
})

describe('startCampaign wire validation and gates', () => {
  it('refuses malformed options before the runner is touched', async () => {
    const { facade } = await makeHarness()
    await expect(facade.startCampaign(TASK_ID, 0, { acceptedBy: 'tester' } as unknown as CampaignOptions))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.startCampaign(TASK_ID, 0, { unattended: true } as unknown as CampaignOptions))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.startCampaign(TASK_ID, 0, { unattended: true, acceptedBy: '' }))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.startCampaign(TASK_ID, 0, { unattended: true, acceptedBy: 'tester', maxConcurrentCampaigns: 0 }))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.startCampaign(TASK_ID, -1, options()))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
  })

  it('refuses a non-host caller before the runner is touched', async () => {
    const { facade, setCaller } = await makeHarness()
    setCaller(callerOf(false))
    await expect(facade.startCampaign(TASK_ID, 0, options()))
      .rejects.toMatchObject({ code: 'self-development/host-only-field' })
    await expect(facade.campaign(TASK_ID)).rejects.toMatchObject({ code: 'self-development/host-only-field' })
    await expect(facade.stopCampaign(TASK_ID, 'user request'))
      .rejects.toMatchObject({ code: 'self-development/host-only-field' })
  })

  it('refuses an unlisted acceptedBy actor', async () => {
    const { facade } = await makeHarness({ allowedActors: ['alice'] })
    await expect(facade.startCampaign(TASK_ID, 0, options({ acceptedBy: 'bob' })))
      .rejects.toMatchObject({ code: 'self-development/actor-forbidden' })
  })

  it('refuses without the runner plugin loaded', async () => {
    const { facade } = await makeHarness({ withRunner: false })
    await expect(facade.startCampaign(TASK_ID, 0, options()))
      .rejects.toMatchObject({ code: 'self-development/runner-unavailable' })
  })

  it('refuses a second campaign for a task that already has one running', async () => {
    const { facade, env, runner } = await makeHarness()
    const hanging = runner!.enqueueHanging()
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(() => {
      expect(runner!.requests).toHaveLength(1)
    })
    await expect(facade.startCampaign(TASK_ID, revision, options()))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
    // Settle the still-open round so no write races the test's directory cleanup.
    hanging.settlePass('attempt-cleanup')
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('passed')
    })
  })

  it('refuses a campaign that would exceed maxConcurrentCampaigns', async () => {
    const { facade, env, runner } = await makeHarness({ maxConcurrentCampaigns: 1 })
    runner!.enqueueHanging()
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    const otherEnv = await makeEnvironment()
    // Second task under the same control directory so it competes for the same cap.
    await writeFile(join(otherEnv.worktree, 'marker.txt'), 'WIP')
    const secondSpec = { ...SPEC, taskId: 'task-remote-campaign-2' }
    let secondRevision = (await facade.createTask(secondSpec, 0)).revision
    secondRevision = (await facade.authorizePlanning('task-remote-campaign-2', secondRevision, 'tester')).revision
    secondRevision = (await facade.submitPlanDraft('task-remote-campaign-2', secondRevision, DRAFT)).revision
    secondRevision = (await facade.confirmPlan('task-remote-campaign-2', secondRevision, PLAN, 'tester')).revision
    secondRevision = (await facade.approveBudget('task-remote-campaign-2', secondRevision, APPROVAL)).revision
    await facade.setLaunchProfile('task-remote-campaign-2', {
      worktree: env.worktree, acceptancePath: env.acceptancePath, artifactPaths: ['marker.txt'], confirmedBy: 'tester', loopbackAllowlist: [],
    })
    await expect(facade.startCampaign('task-remote-campaign-2', secondRevision, options({ maxConcurrentCampaigns: 1 })))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await rm(otherEnv.base, { recursive: true, force: true })
  })

  it('lets exactly one of two truly concurrent startCampaign calls for the same task succeed', async () => {
    const { facade, env } = await makeHarness()
    const revision = await readyTaskWithProfile(facade, env)
    // Both calls race from the same tick: without campaignStartLock
    // serializing the check-then-write section, both could observe
    // runningCampaigns.has(id) === false and both write.
    const results = await Promise.allSettled([
      facade.startCampaign(TASK_ID, revision, options()),
      facade.startCampaign(TASK_ID, revision, options()),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: 'self-development/config-invalid' })
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('passed')
    })
  })

  it('lets exactly one of two truly concurrent startCampaign calls for different tasks succeed under maxConcurrentCampaigns: 1', async () => {
    const { facade, env } = await makeHarness({ maxConcurrentCampaigns: 1 })
    const revision = await readyTaskWithProfile(facade, env)
    const secondTaskId = 'task-remote-campaign-2'
    let secondRevision = (await facade.createTask({ ...SPEC, taskId: secondTaskId }, 0)).revision
    secondRevision = (await facade.authorizePlanning(secondTaskId, secondRevision, 'tester')).revision
    secondRevision = (await facade.submitPlanDraft(secondTaskId, secondRevision, DRAFT)).revision
    secondRevision = (await facade.confirmPlan(secondTaskId, secondRevision, PLAN, 'tester')).revision
    secondRevision = (await facade.approveBudget(secondTaskId, secondRevision, APPROVAL)).revision
    await facade.setLaunchProfile(secondTaskId, {
      worktree: env.worktree, acceptancePath: env.acceptancePath, artifactPaths: ['marker.txt'], confirmedBy: 'tester', loopbackAllowlist: [],
    })
    const results = await Promise.allSettled([
      facade.startCampaign(TASK_ID, revision, options()),
      facade.startCampaign(secondTaskId, secondRevision, options()),
    ])
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: 'self-development/config-invalid' })
    await vi.waitFor(async () => {
      const [first, second] = await Promise.all([facade.campaign(TASK_ID), facade.campaign(secondTaskId)])
      const statuses = [first?.status, second?.status].filter(status => status !== undefined)
      expect(statuses).toEqual(['passed'])
    })
  })
})

describe('campaign round loop', () => {
  it('passes on the first round: rounds 1, status passed, campaign-passed event emitted', async () => {
    const { facade, events, env } = await makeHarness()
    const revision = await readyTaskWithProfile(facade, env)
    const started = await facade.startCampaign(TASK_ID, revision, options())
    expect(started.campaign).toMatchObject({ taskId: TASK_ID, status: 'running', rounds: 0, acknowledgement: 'unattended-accepted' })
    await vi.waitFor(async () => {
      const state = await facade.campaign(TASK_ID)
      expect(state?.status).toBe('passed')
    })
    const finalState = await facade.campaign(TASK_ID)
    expect(finalState).toMatchObject({ status: 'passed', rounds: 1, lastOutcome: 'passed' })
    expect(finalState?.lastAttemptId).toBeDefined()
    await vi.waitFor(() => {
      expect(events.recent().some(event => event.title === 'Task passed, trial ready')).toBe(true)
    })
    expect(await facade.activeTasks()).toEqual([])
  })

  it('retries an unattended campaign through two failures to a pass: 3 rounds, 3 operation ids, 3 distinct fresh confirmations all unattended-accepted', async () => {
    const { facade, runner, env } = await makeHarness()
    runner!.enqueue(new SelfDevelopmentError('acceptance failed', 'SELF_DEV_INVALID_RESULT'))
    runner!.enqueue(new SelfDevelopmentError('acceptance failed again', 'SELF_DEV_INVALID_RESULT'))
    runner!.enqueue('pass')
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('passed')
    })
    expect(runner!.requests).toHaveLength(3)
    const operationIds = runner!.requests.map(request => request.operationId)
    expect(new Set(operationIds).size).toBe(3)
    const confirmations = runner!.requests.map(request => request.presence)
    expect(confirmations[0]).not.toBe(confirmations[1])
    expect(confirmations[1]).not.toBe(confirmations[2])
    expect(confirmations[0]).not.toBe(confirmations[2])
    for (const presence of confirmations) {
      expect(presence.acknowledgement).toBe('unattended-accepted')
      expect(presence.confirmedBy).toBe('tester')
      expect(presence.taskId).toBe(TASK_ID)
    }
    const finalState = await facade.campaign(TASK_ID)
    expect(finalState).toMatchObject({ status: 'passed', rounds: 3 })
  })

  it('stops an unattended campaign at exhausted when the core refuses to start another round', async () => {
    const { facade, runner, env } = await makeHarness()
    runner!.enqueue(new SelfDevelopmentError('acceptance failed', 'SELF_DEV_INVALID_RESULT'))
    runner!.enqueue(new SelfDevelopmentError('attempt launch refused: budget exhausted', 'SELF_DEV_BUDGET_EXHAUSTED'))
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('exhausted')
    })
    const finalState = await facade.campaign(TASK_ID)
    // The refused round never started: only the one round that actually
    // consumed budget is counted.
    expect(finalState).toMatchObject({ status: 'exhausted', rounds: 1, lastOutcome: 'failed' })
    expect(finalState?.reason).toContain('budget exhausted')
    expect(runner!.requests).toHaveLength(2)
  })

  it('ends a campaign as failed on an unrecognized crash, without retrying and without swallowing the reason', async () => {
    const { facade, runner, env } = await makeHarness()
    runner!.enqueue(new Error('unexpected bug'))
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('failed')
    })
    const finalState = await facade.campaign(TASK_ID)
    expect(finalState).toMatchObject({ status: 'failed', rounds: 0 })
    expect(finalState?.reason).toBe('unexpected bug')
    expect(runner!.requests).toHaveLength(1)
  })

  it('ends a campaign as failed on a non-Error thrown value, stringifying it as the reason', async () => {
    const { facade, runner, env } = await makeHarness()
    runner!.enqueue('a plain string rejection')
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('failed')
    })
    expect((await facade.campaign(TASK_ID))?.reason).toBe('a plain string rejection')
  })

  it('records lastOutcome late for a round that overran its approved deadline, without ending the campaign', async () => {
    const { facade, runner, env } = await makeHarness()
    runner!.enqueue(new SelfDevelopmentError('the run overran its approved deadline', 'SELF_DEV_LATE_RESULT'))
    runner!.enqueue('pass')
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('passed')
    })
    expect(runner!.requests).toHaveLength(2)
  })

  it('ends the campaign as stopped, without retrying, on SELF_DEV_INVALID_STATE (the second net behind the pre-round status check)', async () => {
    const { facade, runner, env } = await makeHarness()
    runner!.enqueue(new SelfDevelopmentError('attempt launch requires status ready, task is stopped', 'SELF_DEV_INVALID_STATE'))
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('stopped')
    })
    const finalState = await facade.campaign(TASK_ID)
    // Never consumed: SELF_DEV_INVALID_STATE fires before the core commits
    // attempt/started, so no round outcome is recorded for it.
    expect(finalState).toMatchObject({ status: 'stopped', rounds: 0 })
    expect(finalState?.lastOutcome).toBeUndefined()
    expect(runner!.requests).toHaveLength(1)
  })

  it('ends the campaign as stopped, without retrying, on SELF_DEV_RUNNER_ATTEMPT_ACTIVE', async () => {
    const { facade, runner, env } = await makeHarness()
    runner!.enqueue(new SelfDevelopmentRunnerError('task already has an in-flight attempt in this runner', 'SELF_DEV_RUNNER_ATTEMPT_ACTIVE'))
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('stopped')
    })
    const finalState = await facade.campaign(TASK_ID)
    expect(finalState).toMatchObject({ status: 'stopped', rounds: 0 })
    expect(runner!.requests).toHaveLength(1)
  })

  it('reads the live core status before every round and maps a cancelled stop observed between rounds to stopped, not exhausted', async () => {
    const { facade, runner, env, tasks } = await makeHarness()
    const hanging = runner!.enqueueHanging()
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(() => {
      expect(runner!.requests).toHaveLength(1)
    })
    // Cancel the task directly through the real core, independent of the
    // campaign machinery entirely (the runner double's own stop() never
    // touches the core, and this is not stopCampaign) — the core is stopped
    // with no round of its own having rejected anything yet.
    const controller = await tasks.open(TASK_ID, new HostClock())
    await controller.stop({
      taskId: SelfDevTaskId(TASK_ID),
      expectedRevision: controller.projection.revision,
      operationId: SelfDevOperationId('manual-cancel'),
    })
    // Round 1's own double is unaffected by that direct core cancel (it
    // never observed an abort signal), so it is settled here as an ordinary
    // retryable failure — what lets the loop reach its *next* iteration's
    // pre-round check, which is what actually observes the cancellation.
    hanging.settleError(new SelfDevelopmentError('acceptance failed', 'SELF_DEV_INVALID_RESULT'))
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('stopped')
    })
    const finalState = await facade.campaign(TASK_ID)
    expect(finalState).toMatchObject({ status: 'stopped', rounds: 1, lastOutcome: 'failed' })
    expect(finalState?.reason).toContain('cancelled')
    // The pre-check caught the cancellation before a second round ever
    // reached the runner.
    expect(runner!.requests).toHaveLength(1)
  })

  it('logs a warning and never lets an unhandled rejection escape when the loop itself throws outside its own classification', async () => {
    const { facade, env } = await makeHarness()
    const revision = await readyTaskWithProfile(facade, env)
    const warn = vi.spyOn(context!.logger, 'warn').mockImplementation(() => {})
    const crash = new Error('loop infrastructure failure')
    const loopSpy = vi.spyOn(facade as unknown as { runCampaignLoop: (taskId: string, revision: number) => Promise<void> }, 'runCampaignLoop')
      .mockRejectedValueOnce(crash)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('self-development-remote: campaign loop crashed for task "%s"', TASK_ID)
    })
    expect(warn).toHaveBeenCalledWith(crash)
    loopSpy.mockRestore()
  })

  it('stops an unattended: false campaign after its one automatic round fails, leaving further rounds to a manual runAttempt', async () => {
    const { facade, runner, env } = await makeHarness()
    runner!.enqueue(new SelfDevelopmentError('acceptance failed', 'SELF_DEV_INVALID_RESULT'))
    const revision = await readyTaskWithProfile(facade, env)
    const started = await facade.startCampaign(TASK_ID, revision, options({ unattended: false }))
    // unattended: false means this call's own acceptance covers only the one
    // round it is about to launch automatically — the same wording a direct
    // runAttempt asserts — never the campaign-wide 'unattended-accepted'.
    expect(started.campaign.acknowledgement).toBe('supervised-not-unattended')
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('stopped')
    })
    const finalState = await facade.campaign(TASK_ID)
    expect(finalState).toMatchObject({ status: 'stopped', rounds: 1, lastOutcome: 'failed', acknowledgement: 'supervised-not-unattended' })
    expect(finalState?.reason).toContain('unattended is false')
    // Exactly one round ran (no auto-continue), and it carried the
    // supervised acknowledgement, not the campaign-wide one.
    expect(runner!.requests).toHaveLength(1)
    expect(runner!.requests[0]?.presence.acknowledgement).toBe('supervised-not-unattended')
  })

  it('still reaches passed on an unattended: false campaign whose one automatic round succeeds', async () => {
    const { facade, runner, env } = await makeHarness()
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options({ unattended: false }))
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('passed')
    })
    expect(runner!.requests).toHaveLength(1)
    expect(runner!.requests[0]?.presence.acknowledgement).toBe('supervised-not-unattended')
    expect((await facade.campaign(TASK_ID))?.acknowledgement).toBe('supervised-not-unattended')
  })

  it('lists a task with a hanging round under activeTasks even though the runner double reports none itself', async () => {
    const { facade, runner, env } = await makeHarness()
    const hanging = runner!.enqueueHanging()
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await expect(facade.activeTasks()).resolves.toEqual([TASK_ID])
    // Settle the round so no write races the test's own directory cleanup;
    // the request must actually have reached the runner double first.
    await vi.waitFor(() => {
      expect(runner!.requests).toHaveLength(1)
    })
    hanging.settlePass('attempt-cleanup')
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('passed')
    })
  })

  it('never lets a round that succeeds after stopCampaign already finalized the campaign revert it from stopped', async () => {
    const { facade, runner, env } = await makeHarness()
    const hanging = runner!.enqueueHanging()
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(() => {
      expect(runner!.requests).toHaveLength(1)
    })
    const stopped = await facade.stopCampaign(TASK_ID, 'operator requested a stop')
    expect(stopped.status).toBe('stopped')
    // The round happens to succeed just after the stop was already recorded.
    hanging.settlePass('attempt-late')
    await new Promise(resolve => setTimeout(resolve, 20))
    const state = await facade.campaign(TASK_ID)
    expect(state).toMatchObject({ status: 'stopped', reason: 'operator requested a stop', rounds: 0 })
  })
})

describe('campaign read path', () => {
  it('returns undefined for a task that never had a campaign', async () => {
    const { facade } = await makeHarness()
    await expect(facade.campaign(TASK_ID)).resolves.toBeUndefined()
  })

  it('refuses a malformed task id', async () => {
    const { facade } = await makeHarness()
    await expect(facade.campaign('../escape')).rejects.toMatchObject({ code: 'self-development/config-invalid' })
  })

  it('reflects a restart-recovered campaign as stopped once a new facade instance scans it', async () => {
    // A fresh context and facade instance over one environment, standing in
    // for the process that restarted — a second `selfDevelopmentRemote`
    // cannot be registered on a context that already has one.
    const env = await makeEnvironment()
    root = env.base
    context = new Context()
    new SelfDevelopmentTasks(context, {
      controlDirectory: env.controlDirectory,
      maxRecordsPerSegment: 100,
      checkpointInterval: 10,
    })
    const now = Date.now()
    await writeCampaign(env.controlDirectory, TASK_ID, {
      taskId: TASK_ID, status: 'running', startedAt: now, updatedAt: now, rounds: 2,
      acknowledgement: 'unattended-accepted', unattended: true, acceptedBy: 'tester',
    })
    const recovered = new SelfDevelopmentRemote(context, {
      enabled: true, allowedActors: [], controlDirectory: env.controlDirectory, maxConcurrentCampaigns: 2,
    })
    const state = await recovered.campaign(TASK_ID)
    expect(state).toMatchObject({ status: 'stopped', reason: PROCESS_RESTARTED_REASON, rounds: 2 })
  })
})

describe('stopCampaign', () => {
  it('returns the loop\'s own actual outcome when it finalizes first while stopCampaign is still awaiting the runner\'s stop', async () => {
    const { facade, runner, env } = await makeHarness()
    const hangingRound = runner!.enqueueHanging()
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(() => {
      expect(runner!.requests).toHaveLength(1)
    })
    // Pause stopCampaign at its own await of runner.stop(), so the loop can
    // race ahead and finish its own finalization (write, clear
    // runningCampaigns, clear the in-flight finalizing entry) first.
    let releaseStop: (() => void) | undefined
    vi.spyOn(runner!.service, 'stop').mockImplementation((request: { taskId: string; expectedRevision: number; operationId: string }) =>
      new Promise((resolve) => {
        releaseStop = () => { resolve({ revision: request.expectedRevision + 1, replayed: false }) }
      }))
    const stopping = facade.stopCampaign(TASK_ID, 'operator requested a stop')
    await vi.waitFor(() => {
      expect(releaseStop).toBeDefined()
    })
    // The round settles as budget-exhausted on its own, independent of the
    // still-pending stop: the loop wins the finalization race outright and
    // completes it in full before stopCampaign is released.
    hangingRound.settleError(new SelfDevelopmentError('attempt launch refused: budget exhausted', 'SELF_DEV_BUDGET_EXHAUSTED'))
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('exhausted')
    })
    releaseStop!()
    const stopped = await stopping
    // stopCampaign must report the campaign's real, already-settled outcome
    // — not overwrite it with 'stopped', and not misreport a stale view.
    expect(stopped.status).toBe('exhausted')
  })

  it('refuses without the runner plugin loaded', async () => {
    const { facade } = await makeHarness({ withRunner: false })
    await expect(facade.stopCampaign(TASK_ID, 'user request'))
      .rejects.toMatchObject({ code: 'self-development/runner-unavailable' })
  })

  it('refuses an empty reason', async () => {
    const { facade } = await makeHarness()
    await expect(facade.stopCampaign(TASK_ID, '')).rejects.toMatchObject({ code: 'self-development/config-invalid' })
  })

  it('refuses when no campaign record exists for the task', async () => {
    const { facade } = await makeHarness()
    await expect(facade.stopCampaign(TASK_ID, 'user request'))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
  })

  it('is a no-op returning the stored state when the campaign is already terminal', async () => {
    const { facade, env } = await makeHarness()
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('passed')
    })
    const stopped = await facade.stopCampaign(TASK_ID, 'user request')
    expect(stopped.status).toBe('passed')
  })

  it('cancels an in-flight round through the runner, then finalizes stopped with the caller\'s reason and never lets the loop overwrite it', async () => {
    const { facade, runner, events, env } = await makeHarness()
    const hanging = runner!.enqueueHanging()
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(() => {
      expect(runner!.requests).toHaveLength(1)
    })
    const stopped = await facade.stopCampaign(TASK_ID, 'operator requested a stop')
    expect(stopped).toMatchObject({ status: 'stopped', reason: 'operator requested a stop' })
    expect(runner!.stopCalls).toHaveLength(1)
    expect(runner!.stopCalls[0]?.taskId).toBe(TASK_ID)
    // The runner settles the cancelled attempt after stopCampaign already
    // finalized the record; the loop's own classification must not overwrite
    // the caller's reason.
    hanging.settleError(new SelfDevelopmentError('cancelled by the trusted runner before completion', 'SELF_DEV_ATTEMPT_CANCELLED'))
    await new Promise(resolve => setTimeout(resolve, 20))
    const state = await facade.campaign(TASK_ID)
    expect(state).toMatchObject({ status: 'stopped', reason: 'operator requested a stop' })
    await vi.waitFor(() => {
      expect(events.recent().some(event => event.title === 'Campaign ended: stopped')).toBe(true)
    })
    expect(events.recent().filter(event => event.title === 'Campaign ended: stopped')).toHaveLength(1)
  })

  it('ends a campaign as stopped when the core cancels the in-flight round independently of stopCampaign', async () => {
    const { facade, runner, env } = await makeHarness()
    const hanging = runner!.enqueueHanging()
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(() => {
      expect(runner!.requests).toHaveLength(1)
    })
    hanging.settleError(new SelfDevelopmentError('cancelled by the trusted runner before completion', 'SELF_DEV_ATTEMPT_CANCELLED'))
    await vi.waitFor(async () => {
      expect((await facade.campaign(TASK_ID))?.status).toBe('stopped')
    })
    const state = await facade.campaign(TASK_ID)
    expect(state?.rounds).toBe(1)
    expect(state?.lastOutcome).toBe('cancelled')
  })

  it('lets only one of two concurrent stopCampaign calls finalize and write the record', async () => {
    const { facade, runner, env } = await makeHarness()
    runner!.enqueueHanging()
    const revision = await readyTaskWithProfile(facade, env)
    await facade.startCampaign(TASK_ID, revision, options())
    await vi.waitFor(() => {
      expect(runner!.requests).toHaveLength(1)
    })
    // Force both stopCampaign calls to reach the runner's stop() — proving
    // both still observed the campaign as 'running' — before either is
    // allowed to proceed to finalizeCampaign, so the race is deterministic
    // instead of depending on incidental fs/microtask timing.
    const parked: Array<() => void> = []
    vi.spyOn(runner!.service, 'stop').mockImplementation((request: { taskId: string; expectedRevision: number; operationId: string }) =>
      new Promise((resolve) => {
        parked.push(() => { resolve({ revision: request.expectedRevision + 1, replayed: false }) })
        if (parked.length === 2) { for (const release of parked.splice(0)) release() }
      }))
    const [first, second] = await Promise.all([
      facade.stopCampaign(TASK_ID, 'reason A'),
      facade.stopCampaign(TASK_ID, 'reason B'),
    ])
    // Exactly one call's reason wins and is persisted; the losing call's
    // return value reflects that same actual outcome, never a stale
    // pre-finalization "running" view of its own.
    expect(first.status).toBe('stopped')
    expect(second.status).toBe('stopped')
    expect(first.reason).toBe(second.reason)
    expect(['reason A', 'reason B']).toContain(first.reason)
    const winningReason = (await facade.campaign(TASK_ID))?.reason
    expect(winningReason).toBe(first.reason)
  })
})

describe('approveBudget preset: unlimited', () => {
  it('expands the preset to the documented 24-hour time budget', async () => {
    const { facade } = await makeHarness()
    let revision = (await facade.createTask(SPEC, 0)).revision
    revision = (await facade.authorizePlanning(TASK_ID, revision, 'tester')).revision
    revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
    revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'tester')).revision
    await facade.approveBudget(TASK_ID, revision, {
      preset: 'unlimited', testPlanVersion: TestPlanVersion(1), taskSpecVersion: TaskSpecVersion(1), approvedBy: 'tester',
    })
    const card = (await facade.getTask(TASK_ID)).card.budget
    expect(card).toEqual({
      mode: 'time',
      maxRounds: undefined,
      durationMs: 86_400_000,
      phaseTimeoutMs: 600_000,
      maxStepsPerAttempt: 40,
      noProgressAttemptLimit: 5,
    })
  })

  it('carries an explicit maxRounds through the preset expansion even though the preset itself never sets one', async () => {
    const { facade } = await makeHarness()
    let revision = (await facade.createTask(SPEC, 0)).revision
    revision = (await facade.authorizePlanning(TASK_ID, revision, 'tester')).revision
    revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
    revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'tester')).revision
    await facade.approveBudget(TASK_ID, revision, {
      preset: 'unlimited', maxRounds: 3, testPlanVersion: TestPlanVersion(1), taskSpecVersion: TaskSpecVersion(1), approvedBy: 'tester',
    })
    const card = (await facade.getTask(TASK_ID)).card.budget
    expect(card.maxRounds).toBe(3)
    expect(card.mode).toBe('time')
  })

  it('lets an explicit field override its preset-expanded default', async () => {
    const { facade } = await makeHarness()
    let revision = (await facade.createTask(SPEC, 0)).revision
    revision = (await facade.authorizePlanning(TASK_ID, revision, 'tester')).revision
    revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
    revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'tester')).revision
    await facade.approveBudget(TASK_ID, revision, {
      preset: 'unlimited',
      maxStepsPerAttempt: 7,
      testPlanVersion: TestPlanVersion(1),
      taskSpecVersion: TaskSpecVersion(1),
      approvedBy: 'tester',
    })
    const card = (await facade.getTask(TASK_ID)).card.budget
    expect(card.maxStepsPerAttempt).toBe(7)
    expect(card.durationMs).toBe(86_400_000)
  })

  it('refuses a budget with neither mode nor preset', async () => {
    const { facade } = await makeHarness()
    await facade.createTask(SPEC, 0)
    await expect(facade.approveBudget(TASK_ID, 1, {
      testPlanVersion: TestPlanVersion(1), taskSpecVersion: TaskSpecVersion(1), approvedBy: 'tester',
    }))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
  })

  it('refuses an explicit durationMs over the 24-hour cap, with or without preset', async () => {
    const { facade } = await makeHarness()
    await facade.createTask(SPEC, 0)
    await expect(facade.approveBudget(TASK_ID, 1, {
      mode: 'time', durationMs: 86_400_001, noProgressAttemptLimit: 3,
      testPlanVersion: TestPlanVersion(1), taskSpecVersion: TaskSpecVersion(1), approvedBy: 'tester',
    })).rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.approveBudget(TASK_ID, 1, {
      preset: 'unlimited', durationMs: 90_000_000,
      testPlanVersion: TestPlanVersion(1), taskSpecVersion: TaskSpecVersion(1), approvedBy: 'tester',
    })).rejects.toMatchObject({ code: 'self-development/config-invalid' })
  })
})
