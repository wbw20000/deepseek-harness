/**
 * Per-task launch profiles: `setLaunchProfile` stores a resolved profile
 * atomically, `createTask`'s third argument stores one only after the core
 * commits the creation, `getTask` renders the stored profile on the card,
 * and `runAttempt` derives its five optional launch fields from the profile
 * with explicit values winning. A runner test double records the request the
 * facade forwards, and the connection double swaps the caller between the
 * stable host and a phone.
 * @module launch-profile.spec
 */

import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HostClock } from '@deepseek-ai/dsh-workflow-self-development-runner'
import type {
  SelfDevelopmentRunner,
  SupervisedAttemptOutcome,
  SupervisedAttemptRequest,
} from '@deepseek-ai/dsh-workflow-self-development-runner'
import { SelfDevelopmentTasks, TestPlanVersion, TaskSpecVersion } from '@deepseek-ai/dsh-workflow-self-development'
import SelfDevelopmentRemote from '../src/index.ts'
import { launchProfilePath } from '../src/launch-profile.ts'
import type { LaunchProfileInput, RemoteConnectionCaller } from '../src/types.ts'
import { makeEnvironment } from './helpers.ts'

const TASK_ID = 'task-remote-launch-profile'

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

/** One caller context as the frozen connection contract defines it. */
function callerOf(loopback: boolean): RemoteConnectionCaller {
  return {
    sessionId: 'chat-1',
    host: loopback ? '127.0.0.1:8787' : 'phone.example.invalid:8787',
    loopback,
    certificateSerial: undefined,
  }
}

/** A runner test double that records every forwarded attempt request. */
function runnerStub(): {
  readonly service: SelfDevelopmentRunner
  readonly requests: SupervisedAttemptRequest[]
} {
  const requests: SupervisedAttemptRequest[] = []
  const service = {
    runAttempt: vi.fn(async (request: SupervisedAttemptRequest): Promise<SupervisedAttemptOutcome> => {
      requests.push(request)
      return {
        operation: { revision: request.expectedRevision + 1, replayed: false },
        attemptId: 'attempt-stub',
        evidencePath: '/evidence/attempt-stub.json',
        outcomeWriteError: undefined,
      }
    }),
    stop: vi.fn(),
    activeTasks: () => [],
    clock: () => new HostClock(),
  }
  return { service: service as unknown as SelfDevelopmentRunner, requests }
}

/**
 * Boot the real task-control service and the facade over one environment,
 * with a runner double and a swappable connection caller.
 */
async function makeFacade(options: {
  readonly allowedActors?: string[]
  readonly withRunner?: boolean
} = {}): Promise<{
  readonly facade: SelfDevelopmentRemote
  readonly env: Awaited<ReturnType<typeof makeEnvironment>>
  readonly setCaller: (caller: RemoteConnectionCaller | undefined) => void
  readonly requests: SupervisedAttemptRequest[]
}> {
  const env = await makeEnvironment()
  root = env.base
  context = new Context()
  new SelfDevelopmentTasks(context, {
    controlDirectory: env.controlDirectory,
    maxRecordsPerSegment: 100,
    checkpointInterval: 10,
  })
  const runner = options.withRunner === false ? undefined : runnerStub()
  if (runner !== undefined) context.provide('selfDevelopmentRunner', runner.service)
  let current: RemoteConnectionCaller | undefined
  context.provide('connection', { caller: { current: () => current } })
  const facade = new SelfDevelopmentRemote(context, {
    enabled: true,
    allowedActors: options.allowedActors ?? [],
    controlDirectory: env.controlDirectory,
    maxConcurrentCampaigns: 2,
  })
  return { facade, env, setCaller: (caller) => { current = caller }, requests: runner?.requests ?? [] }
}

/** Drive the task to revision 5 (spec, planning, plan, budget) so an attempt may launch. */
async function readyTask(facade: SelfDevelopmentRemote, createdBy = SPEC.createdBy): Promise<number> {
  await facade.createTask({ ...SPEC, createdBy }, 0)
  let revision = (await facade.authorizePlanning(TASK_ID, 1, 'tester')).revision
  revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
  revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'tester')).revision
  revision = (await facade.approveBudget(TASK_ID, revision, APPROVAL)).revision
  return revision
}

/** A full launch profile input over one environment's real paths. */
function profileInput(env: Awaited<ReturnType<typeof makeEnvironment>>): LaunchProfileInput {
  return {
    worktree: env.worktree,
    acceptancePath: env.acceptancePath,
    artifactPaths: ['marker.txt'],
    loopbackAllowlist: [8080],
    confirmedBy: 'tester',
  }
}

describe('setLaunchProfile storage', () => {
  it('stores a resolved profile, returns it, and renders it on the card', async () => {
    const { facade, env } = await makeFacade()
    await facade.createTask(SPEC, 0)
    const before = await facade.getTask(TASK_ID)
    expect(before.card.launchProfile).toBeUndefined()

    const stored = await facade.setLaunchProfile(TASK_ID, profileInput(env))
    expect(stored.taskId).toBe(TASK_ID)
    expect(stored.launchProfile).toMatchObject({
      worktree: env.worktree,
      acceptancePath: env.acceptancePath,
      artifactPaths: ['marker.txt'],
      loopbackAllowlist: [8080],
      confirmedBy: 'tester',
    })
    expect(typeof stored.launchProfile.updatedAt).toBe('number')

    const path = launchProfilePath(env.controlDirectory, TASK_ID)
    const [fileMode, directoryMode] = await Promise.all([
      stat(path).then(s => s.mode & 0o777),
      stat(join(env.controlDirectory, 'launch-profiles')).then(s => s.mode & 0o777),
    ])
    expect(fileMode).toBe(0o600)
    expect(directoryMode).toBe(0o700)

    const detail = await facade.getTask(TASK_ID)
    expect(detail.card.launchProfile).toEqual(stored.launchProfile)
  })

  it('derives artifactPaths from the spec, confirmedBy from a sole allowed actor, and loopbackAllowlist from []', async () => {
    const { facade, env } = await makeFacade({ allowedActors: ['alice'] })
    await facade.createTask({ ...SPEC, createdBy: 'alice' }, 0)
    const stored = await facade.setLaunchProfile(TASK_ID, {
      worktree: env.worktree,
      acceptancePath: env.acceptancePath,
    })
    expect(stored.launchProfile.updatedAt).toEqual(expect.any(Number))
    expect(stored.launchProfile).toEqual({
      worktree: env.worktree,
      acceptancePath: env.acceptancePath,
      artifactPaths: ['marker.txt'],
      loopbackAllowlist: [],
      confirmedBy: 'alice',
      updatedAt: stored.launchProfile.updatedAt,
    })
  })

  it('keeps an explicit dataHome in the stored profile', async () => {
    const { facade, env } = await makeFacade()
    await facade.createTask(SPEC, 0)
    const stored = await facade.setLaunchProfile(TASK_ID, { ...profileInput(env), dataHome: '/tmp/dsh-home' })
    expect(stored.launchProfile.dataHome).toBe('/tmp/dsh-home')
    const reread = await facade.getTask(TASK_ID)
    expect(reread.card.launchProfile?.dataHome).toBe('/tmp/dsh-home')
  })

  it('refuses a relative worktree, an empty artifactPaths list, and an out-of-range port', async () => {
    const { facade, env } = await makeFacade()
    await facade.createTask(SPEC, 0)
    await expect(facade.setLaunchProfile(TASK_ID, { ...profileInput(env), worktree: 'relative/wt' }))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.setLaunchProfile(TASK_ID, { ...profileInput(env), artifactPaths: [] }))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.setLaunchProfile(TASK_ID, { ...profileInput(env), loopbackAllowlist: [70_000] }))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(facade.setLaunchProfile(TASK_ID, { ...profileInput(env), acceptancePath: 'relative/acceptance' }))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
  })

  it('refuses a task with no journal and a spec-less journal', async () => {
    const { facade, env } = await makeFacade()
    await expect(facade.setLaunchProfile('never-created', profileInput(env)))
      .rejects.toMatchObject({ code: 'self-development/task-unknown' })
    await mkdir(join(env.controlDirectory, 'tasks', 'bare-task'), { recursive: true })
    // Without a spec the artifactPaths default has no source; an explicit
    // list bypasses the derivation.
    await expect(facade.setLaunchProfile('bare-task', {
      worktree: env.worktree,
      acceptancePath: env.acceptancePath,
    })).rejects.toThrow('launchProfile.artifactPaths is missing and the task has no spec to derive it from')
    // An explicit artifactPaths list needs no spec, so the same call stores.
    await expect(facade.setLaunchProfile('bare-task', profileInput(env)))
      .resolves.toMatchObject({ taskId: 'bare-task', launchProfile: { artifactPaths: ['marker.txt'] } })
  })

  it('refuses a profile whose confirmedBy cannot be derived from allowedActors', async () => {
    const { facade, env } = await makeFacade({ allowedActors: ['alice', 'bob'] })
    await facade.createTask({ ...SPEC, createdBy: 'alice' }, 0)
    await expect(facade.setLaunchProfile(TASK_ID, {
      worktree: env.worktree,
      acceptancePath: env.acceptancePath,
    })).rejects.toThrow('launchProfile.confirmedBy is missing and allowedActors does not name exactly one actor')
  })

  it('actor-checks an explicit confirmedBy against the allowlist', async () => {
    const { facade, env } = await makeFacade({ allowedActors: ['alice'] })
    await facade.createTask({ ...SPEC, createdBy: 'alice' }, 0)
    await expect(facade.setLaunchProfile(TASK_ID, { ...profileInput(env), confirmedBy: 'mallory' }))
      .rejects.toMatchObject({ code: 'self-development/actor-forbidden' })
  })
})

describe('stored profile validation', () => {
  it('refuses a corrupt profile file with its path, never its content', async () => {
    const { facade, env } = await makeFacade()
    await facade.createTask(SPEC, 0)
    await facade.setLaunchProfile(TASK_ID, profileInput(env))
    const path = launchProfilePath(env.controlDirectory, TASK_ID)
    await writeFile(path, '{broken')
    const refusal = await facade.getTask(TASK_ID).then(
      () => { throw new Error('expected getTask to refuse') },
      (error: unknown) => error,
    )
    expect(refusal).toMatchObject({ code: 'self-development/config-invalid' })
    expect((refusal as Error).message).toContain(path)
    expect((refusal as Error).message).not.toContain('{broken')
  })

  it('refuses a profile file whose JSON misses a required field', async () => {
    const { facade, env } = await makeFacade()
    await facade.createTask(SPEC, 0)
    await facade.setLaunchProfile(TASK_ID, profileInput(env))
    const path = launchProfilePath(env.controlDirectory, TASK_ID)
    const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    delete stored.confirmedBy
    await writeFile(path, JSON.stringify(stored))
    await expect(facade.getTask(TASK_ID))
      .rejects.toThrow(`launch profile ${path} is invalid`)
    // A root-level shape failure (not an object) reports the whole profile.
    await writeFile(path, 'null')
    await expect(facade.getTask(TASK_ID))
      .rejects.toThrow('launch profile ' + path + ' is invalid: profile:')
  })

  it('propagates a non-missing-file read failure instead of treating the profile as absent', async () => {
    const { facade, env } = await makeFacade()
    await facade.createTask(SPEC, 0)
    await facade.setLaunchProfile(TASK_ID, profileInput(env))
    const directory = join(env.controlDirectory, 'launch-profiles')
    await chmod(directory, 0o000)
    try {
      await expect(facade.getTask(TASK_ID)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(directory, 0o700)
    }
  })
})

describe('createTask with a launch profile', () => {
  it('writes the profile so the task is immediately readable with it', async () => {
    const { facade, env } = await makeFacade()
    await facade.createTask(SPEC, 0, profileInput(env))
    const detail = await facade.getTask(TASK_ID)
    expect(detail.card.launchProfile).toMatchObject({
      worktree: env.worktree,
      acceptancePath: env.acceptancePath,
      artifactPaths: ['marker.txt'],
      loopbackAllowlist: [8080],
      confirmedBy: 'tester',
    })
  })

  it('derives artifactPaths from the spec being created before the journal exists', async () => {
    const { facade, env } = await makeFacade({ allowedActors: ['alice'] })
    await facade.createTask({ ...SPEC, createdBy: 'alice' }, 0, {
      worktree: env.worktree,
      acceptancePath: env.acceptancePath,
    })
    const detail = await facade.getTask(TASK_ID)
    expect(detail.card.launchProfile).toMatchObject({ artifactPaths: ['marker.txt'], confirmedBy: 'alice' })
  })

  it('leaves no profile file when the core refuses the creation', async () => {
    const { facade, env } = await makeFacade()
    await expect(facade.createTask({ ...SPEC, taskId: 'task-remote-conflict' }, 5, profileInput(env)))
      .rejects.toMatchObject({
        code: 'self-development/core',
        details: { code: 'SELF_DEV_REVISION_CONFLICT' },
      })
    await expect(stat(launchProfilePath(env.controlDirectory, 'task-remote-conflict')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('resolves the profile before creating, so an underivable confirmer creates nothing', async () => {
    const { facade, env } = await makeFacade()
    await expect(facade.createTask(SPEC, 0, {
      worktree: env.worktree,
      acceptancePath: env.acceptancePath,
    })).rejects.toThrow('launchProfile.confirmedBy is missing and allowedActors does not name exactly one actor')
    await expect(stat(launchProfilePath(env.controlDirectory, TASK_ID)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(facade.getTask(TASK_ID)).rejects.toMatchObject({ code: 'self-development/task-unknown' })
  })
})

describe('runAttempt derivation', () => {
  it('launches with only taskId, expectedRevision, and presenceAcknowledged, filling the rest from the profile', async () => {
    const { facade, env, requests } = await makeFacade()
    const revision = await readyTask(facade)
    const stored = await facade.setLaunchProfile(TASK_ID, profileInput(env))
    requests.length = 0

    const outcome = await facade.runAttempt({
      taskId: TASK_ID,
      expectedRevision: revision,
      presenceAcknowledged: true,
    })
    expect(outcome.worktree).toBe(env.worktree)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      taskId: TASK_ID,
      expectedRevision: revision,
      worktree: env.worktree,
      artifactPaths: ['marker.txt'],
      acceptancePath: env.acceptancePath,
      presence: {
        confirmedBy: 'tester',
        loopbackAllowlist: [8080],
        artifactPaths: ['marker.txt'],
        worktree: env.worktree,
      },
    })
    expect(requests[0]?.dshHome).toBeUndefined()
    expect(stored.launchProfile.confirmedBy).toBe('tester')
  })

  it('prefers explicit values over the profile', async () => {
    const { facade, env, requests } = await makeFacade()
    const revision = await readyTask(facade)
    await facade.setLaunchProfile(TASK_ID, profileInput(env))
    requests.length = 0

    await facade.runAttempt({
      taskId: TASK_ID,
      expectedRevision: revision,
      worktree: join(env.base, 'other-wt'),
      artifactPaths: ['marker.txt', 'notes.txt', 'marker.txt'],
      presenceAcknowledged: true,
    })
    expect(requests[0]).toMatchObject({
      worktree: join(env.base, 'other-wt'),
      artifactPaths: ['marker.txt', 'notes.txt'],
      acceptancePath: env.acceptancePath,
      presence: {
        loopbackAllowlist: [8080],
        confirmedBy: 'tester',
        worktree: join(env.base, 'other-wt'),
        artifactPaths: ['marker.txt', 'notes.txt'],
      },
    })
  })

  it('refuses a field that is neither explicit nor derivable, naming the field', async () => {
    const { facade } = await makeFacade()
    const revision = await readyTask(facade)
    await expect(facade.runAttempt({ taskId: TASK_ID, expectedRevision: revision, presenceAcknowledged: true }))
      .rejects.toThrow('runAttempt.worktree is missing and the task has no launch profile')
    await expect(facade.runAttempt({
      taskId: TASK_ID,
      expectedRevision: revision,
      worktree: '/tmp/wt',
      presenceAcknowledged: true,
    })).rejects.toThrow('runAttempt.artifactPaths is missing and the task has no launch profile')
    await expect(facade.runAttempt({
      taskId: TASK_ID,
      expectedRevision: revision,
      worktree: '/tmp/wt',
      artifactPaths: ['marker.txt'],
      acceptancePath: '/tmp/acceptance.json',
      presenceAcknowledged: true,
    })).rejects.toThrow('runAttempt.loopbackAllowlist is missing and the task has no launch profile')
    await expect(facade.runAttempt({
      taskId: TASK_ID,
      expectedRevision: revision,
      worktree: '/tmp/wt',
      artifactPaths: ['marker.txt'],
      acceptancePath: '/tmp/acceptance.json',
      loopbackAllowlist: [],
      presenceAcknowledged: true,
    })).rejects.toThrow('runAttempt.confirmedBy is missing and the task has no launch profile')
  })

  it('launches without any profile when every field is explicit', async () => {
    const { facade, env, requests } = await makeFacade()
    const revision = await readyTask(facade)
    await expect(facade.runAttempt({
      taskId: TASK_ID,
      expectedRevision: revision,
      worktree: env.worktree,
      artifactPaths: ['marker.txt'],
      acceptancePath: env.acceptancePath,
      confirmedBy: 'tester',
      loopbackAllowlist: [],
      presenceAcknowledged: true,
    })).resolves.toMatchObject({ worktree: env.worktree, operation: { replayed: false } })
    expect(requests).toHaveLength(1)
  })

  it('validates the task id before reading any profile, so a traversal never leaves launch-profiles/', async () => {
    const { facade, env, requests } = await makeFacade()
    // A JSON file planted outside launch-profiles/ that a traversing id would otherwise reach.
    await mkdir(env.controlDirectory, { recursive: true })
    await writeFile(join(env.controlDirectory, 'escape.json'), '{planted-outside')
    const rejection = facade.runAttempt({ taskId: '../escape', expectedRevision: 0, presenceAcknowledged: true })
    await expect(rejection).rejects.toMatchObject({ code: 'self-development/config-invalid' })
    await expect(rejection).rejects.toThrow(/taskId/u)
    await expect(rejection).rejects.not.toThrow(/escape\.json/u)
    expect(requests).toHaveLength(0)
  })

  it('still refuses presenceAcknowledged: false before deriving anything', async () => {
    const { facade } = await makeFacade()
    const revision = await readyTask(facade)
    await expect(facade.runAttempt({ taskId: TASK_ID, expectedRevision: revision, presenceAcknowledged: false }))
      .rejects.toMatchObject({ code: 'self-development/presence-unconfirmed' })
  })
})

describe('non-host callers', () => {
  it('refuses setLaunchProfile, a profile-carrying createTask, and runAttempt from a phone', async () => {
    const { facade, env, setCaller } = await makeFacade()
    await facade.createTask(SPEC, 0)
    setCaller(callerOf(false))

    await expect(facade.setLaunchProfile(TASK_ID, profileInput(env)))
      .rejects.toMatchObject({ code: 'self-development/host-only-field' })
    await expect(facade.setLaunchProfile(TASK_ID, profileInput(env)))
      .rejects.toThrow('setLaunchProfile assigns isolation settings (worktree, acceptancePath, artifactPaths, dataHome)')
    await expect(facade.createTask(SPEC, 5, profileInput(env)))
      .rejects.toMatchObject({ code: 'self-development/host-only-field' })
    await expect(facade.createTask(SPEC, 5, profileInput(env)))
      .rejects.toThrow('launchProfile.worktree is host-only; a non-host caller must omit it')
    await expect(facade.runAttempt({
      taskId: TASK_ID,
      expectedRevision: 1,
      worktree: env.worktree,
      artifactPaths: ['marker.txt'],
      acceptancePath: env.acceptancePath,
      confirmedBy: 'tester',
      loopbackAllowlist: [],
      presenceAcknowledged: true,
    })).rejects.toMatchObject({ code: 'self-development/host-only-field' })
  })
})
