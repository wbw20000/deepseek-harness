/**
 * Host-only field and phone-whitelist behavior: the caller's Host-header
 * loopback decides who counts as the stable host, `runAttempt` and
 * `createTask` are refused from a phone caller before the core or runner is
 * touched, and the wire schema's `hostOnly` metadata is collected and
 * enforced automatically. The connection service is a structural test double
 * of the frozen `ctx.connection.caller.current()` contract.
 * @module host-only.spec
 */

import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import { SelfDevelopmentTasks, TestPlanVersion, TaskSpecVersion } from '@deepseek-ai/dsh-workflow-self-development'
import SelfDevelopmentRemote from '../src/index.ts'
import { SelfDevelopmentRemoteError } from '../src/errors.ts'
import { assertHostOnlyFields, registerHostOnlyFields } from '../src/schema.ts'
import type { RemoteConnectionCaller, RemoteRunAttemptRequest } from '../src/types.ts'
import { makeEnvironment } from './helpers.ts'

const TASK_ID = 'task-remote-host-only'

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

const RUN_REQUEST: RemoteRunAttemptRequest = {
  taskId: TASK_ID,
  expectedRevision: 5,
  worktree: '/tmp/wt',
  artifactPaths: ['marker.txt'],
  acceptancePath: '/tmp/acceptance.json',
  confirmedBy: 'tester',
  loopbackAllowlist: [],
  presenceAcknowledged: true,
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

/**
 * Boot the real task-control service and the facade over one environment,
 * with a structural `connection` double whose current caller the spec can
 * swap between phases.
 */
async function makeFacade(): Promise<{
  readonly facade: SelfDevelopmentRemote
  readonly setCaller: (caller: RemoteConnectionCaller | undefined) => void
}> {
  const env = await makeEnvironment()
  root = env.base
  context = new Context()
  new SelfDevelopmentTasks(context, {
    controlDirectory: env.controlDirectory,
    maxRecordsPerSegment: 100,
    checkpointInterval: 10,
  })
  let current: RemoteConnectionCaller | undefined
  context.provide('connection', { caller: { current: () => current } })
  const facade = new SelfDevelopmentRemote(context, {
    enabled: true,
    allowedActors: [],
    controlDirectory: env.controlDirectory,
    maxConcurrentCampaigns: 2,
    roundDelayMs: 0,
  })
  return { facade, setCaller: (caller) => { current = caller } }
}

describe('caller determination', () => {
  it('treats a deployment without the connection service as the host', async () => {
    const env = await makeEnvironment()
    root = env.base
    context = new Context()
    new SelfDevelopmentTasks(context, {
      controlDirectory: env.controlDirectory,
      maxRecordsPerSegment: 100,
      checkpointInterval: 10,
    })
    const facade = new SelfDevelopmentRemote(context, {
      enabled: true,
      allowedActors: [],
      controlDirectory: env.controlDirectory,
      maxConcurrentCampaigns: 2,
      roundDelayMs: 0,
    })
    await expect(facade.createTask(SPEC, 0)).resolves.toMatchObject({ taskId: TASK_ID, replayed: false })
    // The host may set the host-only dataHome; the request then runs past the
    // gates and refuses only because no runner plugin is loaded.
    await expect(facade.runAttempt({ ...RUN_REQUEST, dataHome: '/tmp/dsh-home' }))
      .rejects.toMatchObject({ code: 'self-development/runner-unavailable' })
  })

  it('treats an absent caller context as the host and keeps every method available', async () => {
    const { facade } = await makeFacade()
    await expect(facade.createTask(SPEC, 0)).resolves.toMatchObject({ taskId: TASK_ID, replayed: false })
    await expect(facade.authorizePlanning(TASK_ID, 1, 'tester')).resolves.toMatchObject({ revision: 2 })
    await expect(facade.submitPlanDraft(TASK_ID, 2, DRAFT)).resolves.toMatchObject({ revision: 3 })
    await expect(facade.confirmPlan(TASK_ID, 3, PLAN, 'tester')).resolves.toMatchObject({ revision: 4 })
    await expect(facade.approveBudget(TASK_ID, 4, APPROVAL)).resolves.toMatchObject({ revision: 5 })
    await expect(facade.runAttempt({ ...RUN_REQUEST, dataHome: '/tmp/dsh-home' }))
      .rejects.toMatchObject({ code: 'self-development/runner-unavailable' })
    await expect(facade.stop(TASK_ID, 5)).resolves.toMatchObject({ taskId: TASK_ID, revision: 6 })
  })

  it('treats a loopback Host header as the host', async () => {
    const { facade, setCaller } = await makeFacade()
    setCaller(callerOf(true))
    await expect(facade.createTask(SPEC, 0)).resolves.toMatchObject({ taskId: TASK_ID, replayed: false })
    await expect(facade.runAttempt({ ...RUN_REQUEST, dataHome: '/tmp/dsh-home' }))
      .rejects.toMatchObject({ code: 'self-development/runner-unavailable' })
  })
})

describe('non-host caller refusals', () => {
  it('refuses runAttempt and createTask before the core is touched and keeps the revision', async () => {
    const { facade, setCaller } = await makeFacade()
    await facade.createTask(SPEC, 0)
    await facade.authorizePlanning(TASK_ID, 1, 'tester')
    await facade.submitPlanDraft(TASK_ID, 2, DRAFT)
    await facade.confirmPlan(TASK_ID, 3, PLAN, 'tester')
    await facade.approveBudget(TASK_ID, 4, APPROVAL)
    setCaller(callerOf(false))

    await expect(facade.runAttempt(RUN_REQUEST))
      .rejects.toThrow('a phone caller may watch progress, interject, confirm the plan and budget, stop, and approve or reject the trial')
    await expect(facade.runAttempt(RUN_REQUEST))
      .rejects.toMatchObject({ code: 'self-development/host-only-field' })
    await expect(facade.runAttempt({ ...RUN_REQUEST, dataHome: '/tmp/dsh-home' }))
      .rejects.toThrow('runAttempt.dataHome is host-only')
    await expect(facade.createTask(SPEC, 5))
      .rejects.toThrow('createTask assigns isolation settings (stableBaselineDigest and allowedModificationScope)')
    await expect(facade.createTask(SPEC, 5))
      .rejects.toMatchObject({ code: 'self-development/host-only-field' })
    const detail = await facade.getTask(TASK_ID)
    expect(detail.projection.revision).toBe(5)
  })

  it('keeps the phone-whitelist methods available to a non-host caller', async () => {
    const { facade, setCaller } = await makeFacade()
    await facade.createTask(SPEC, 0)
    setCaller(callerOf(false))

    await expect(facade.listTasks()).resolves.toHaveLength(1)
    await expect(facade.getTask(TASK_ID)).resolves.toMatchObject({ projection: { revision: 1 } })
    await expect(facade.recentEvents()).resolves.toEqual([])
    await expect(facade.activeTasks()).resolves.toEqual([])
    await expect(facade.authorizePlanning(TASK_ID, 1, 'phone-user')).resolves.toMatchObject({ revision: 2 })
    await expect(facade.submitPlanDraft(TASK_ID, 2, DRAFT)).resolves.toMatchObject({ revision: 3 })
    await expect(facade.confirmPlan(TASK_ID, 3, PLAN, 'phone-user')).resolves.toMatchObject({ revision: 4 })
    await expect(facade.approveBudget(TASK_ID, 4, { ...APPROVAL, approvedBy: 'phone-user' }))
      .resolves.toMatchObject({ revision: 5 })
    // The gate passed: the refusal comes from the core, which has no verified
    // result to bind a trial approval to yet.
    await expect(facade.recordTrialApproval(TASK_ID, 5, 'phone-user'))
      .rejects.toMatchObject({ code: 'self-development/core', details: { code: 'SELF_DEV_INVALID_STATE' } })
    await expect(facade.stop(TASK_ID, 5, 'cancelled')).resolves.toMatchObject({ taskId: TASK_ID, revision: 6 })
  })
})

describe('hostOnly metadata collection', () => {
  /** Temporary wire schema exercising top-level, nested, and object-level hostOnly markers. */
  const temporarySchema = zod.strictObject({
    plain: zod.string(),
    secret: zod.string().meta({ hostOnly: true }).optional(),
    nested: zod.object({ inner: zod.string().meta({ hostOnly: true }).optional() }),
    blob: zod.object({ x: zod.string() }).meta({ hostOnly: true }).optional(),
  })
  registerHostOnlyFields('temporary', temporarySchema)

  /**
   * Run the generic check against the temporary schema and return the facade
   * error it raised, or `undefined` when the call passed.
   */
  function runCheck(
    input: Record<string, unknown>,
    schemaName = 'temporary',
    callerIsHost = false,
  ): SelfDevelopmentRemoteError | undefined {
    try {
      assertHostOnlyFields(schemaName, input, callerIsHost)
      return undefined
    } catch (error) {
      return error as SelfDevelopmentRemoteError
    }
  }

  it('refuses a top-level host-only field from a non-host caller', () => {
    const caught = runCheck({ plain: 'a', secret: 's' })
    expect(caught).toBeInstanceOf(SelfDevelopmentRemoteError)
    expect(caught?.code).toBe('self-development/host-only-field')
    expect(caught?.message).toBe('temporary.secret is host-only; a non-host caller must omit it')
  })

  it('refuses a nested host-only field and passes its absent form', () => {
    const caught = runCheck({ plain: 'a', nested: { inner: 'i' } })
    expect(caught?.code).toBe('self-development/host-only-field')
    expect(caught?.message).toBe('temporary.nested.inner is host-only; a non-host caller must omit it')
    expect(runCheck({ plain: 'a', nested: {} })).toBeUndefined()
  })

  it('refuses a whole host-only object field from a non-host caller', () => {
    const caught = runCheck({ plain: 'a', blob: { x: '1' } })
    expect(caught?.code).toBe('self-development/host-only-field')
    expect(caught?.message).toBe('temporary.blob is host-only; a non-host caller must omit it')
  })

  it('passes a host caller and a schema without registered fields', () => {
    expect(runCheck({ plain: 'a', secret: 's' }, 'temporary', true)).toBeUndefined()
    expect(runCheck({ plain: 'a', secret: 's' }, 'schema-without-fields')).toBeUndefined()
  })
})
