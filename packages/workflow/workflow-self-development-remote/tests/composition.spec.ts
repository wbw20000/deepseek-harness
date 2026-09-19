/**
 * Real-Loader composition of the three self-development services: the core
 * task-control service, the supervised runner, and the Remote facade boot
 * together from `cordis.yml`, and the whole human lifecycle — create,
 * authorize, draft, confirm, approve, failed attempt, passing attempt, and
 * trial approval — runs through the facade's `@Remote` methods against real
 * journals, a real git worktree, and the fake-dsh executor fixture.
 * @module composition.spec
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { TestPlanVersion, TaskSpecVersion } from '@deepseek-ai/dsh-workflow-self-development'
import SelfDevelopmentRemote from '../src/index.ts'
import { baseUrlOf, makeEnvironment } from './helpers.ts'
import type { Environment } from './helpers.ts'

const TASK_ID = 'task-remote-composition'

const SPEC = {
  taskId: TASK_ID,
  version: 1,
  requirement: 'dev',
  allowedModificationScope: ['marker.txt'],
  stableBaselineDigest: 'b'.repeat(64),
  createdBy: 'phone-user',
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
  approvedBy: 'phone-user',
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Boot all three services from a real `cordis.yml` through the Loader. */
async function bootComposition(env: Environment): Promise<SelfDevelopmentRemote> {
  const configPath = join(env.base, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-workflow-self-development'",
    '  config:',
    `    controlDirectory: '${env.controlDirectory}'`,
    '    maxRecordsPerSegment: 100',
    '    checkpointInterval: 10',
    "- name: '@deepseek-ai/dsh-workflow-self-development-runner'",
    '  config:',
    `    nodeBinary: '${env.runnerConfig.nodeBinary}'`,
    `    dshBin: '${env.runnerConfig.dshBin}'`,
    `    dshHome: '${env.runnerConfig.dshHome}'`,
    `    experimentsRoot: '${env.runnerConfig.experimentsRoot}'`,
    `    evidenceRoot: '${env.runnerConfig.evidenceRoot}'`,
    `    killGraceMs: ${env.runnerConfig.killGraceMs}`,
    "- name: '@deepseek-ai/dsh-workflow-self-development-remote'",
    '  config:',
    '    enabled: true',
    `    controlDirectory: '${env.controlDirectory}'`,
    '',
  ].join('\n'))
  const booted = new Context()
  context = booted
  booted.baseUrl = baseUrlOf(env.base)
  await booted.plugin(Loader)
  booted.loader.builtins.include = Include
  booted.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/dsh-workflow-self-development') {
        return import('@deepseek-ai/dsh-workflow-self-development')
      }
      if (specifier === '@deepseek-ai/dsh-workflow-self-development-runner') {
        return import('@deepseek-ai/dsh-workflow-self-development-runner')
      }
      if (specifier === '@deepseek-ai/dsh-workflow-self-development-remote') {
        return import('../src/index.ts')
      }
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof booted.loader.internal>
  await booted.loader.create({
    name: 'cordis:include',
    config: { path: configPath },
  })
  await booted.loader.await()
  return booted.selfDevelopmentRemote
}

/** One supervised attempt request against the composition's current revision. */
function attemptRequest(env: Environment, expectedRevision: number) {
  return {
    taskId: TASK_ID,
    expectedRevision,
    worktree: env.worktree,
    artifactPaths: ['marker.txt', 'marker.txt'],
    acceptancePath: env.acceptancePath,
    confirmedBy: 'phone-user',
    loopbackAllowlist: [0],
    presenceAcknowledged: true,
  }
}

describe('real-Loader composition through the Remote facade', () => {
  it('runs the full human lifecycle, a failed attempt, a passing attempt, and the trial approval', { timeout: 60_000 }, async () => {
    const env = await makeEnvironment()
    root = env.base
    const facade = await bootComposition(env)

    let revision = (await facade.createTask(SPEC, 0)).revision
    expect(revision).toBe(1)
    revision = (await facade.authorizePlanning(TASK_ID, revision, 'phone-user')).revision
    revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
    revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'phone-user')).revision
    revision = (await facade.approveBudget(TASK_ID, revision, APPROVAL)).revision
    expect(revision).toBe(5)

    // The first launch writes WIP2, so acceptance fails, the round is
    // consumed, and the core settles the attempt as a failed round.
    await expect(facade.runAttempt(attemptRequest(env, revision)))
      .rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })

    const afterFailure = await facade.getTask(TASK_ID)
    expect(afterFailure.projection.status).toBe('ready')
    expect(afterFailure.projection.consumedRounds).toBe(1)
    revision = afterFailure.projection.revision

    // The second launch writes DONE: acceptance passes and the task awaits trial.
    const passed = await facade.runAttempt(attemptRequest(env, revision))
    expect(passed.operation.replayed).toBe(false)
    expect(passed.attemptId).toBeDefined()
    expect(passed.evidencePath).toBeDefined()
    expect(passed.outcomeWriteError).toBeUndefined()
    const awaiting = await facade.getTask(TASK_ID)
    expect(awaiting.projection.status).toBe('awaiting-trial')
    expect(awaiting.projection.consumedRounds).toBe(2)

    const trial = await facade.recordTrialApproval(TASK_ID, awaiting.projection.revision, 'phone-user')
    expect(trial.replayed).toBe(false)
    const approved = await facade.getTask(TASK_ID)
    expect(approved.projection.trialApproval).toMatchObject({ approvedBy: 'phone-user' })
    expect(await facade.activeTasks()).toEqual([])

    const listed = await facade.listTasks()
    expect(listed).toEqual([{
      taskId: TASK_ID,
      status: 'awaiting-trial',
      revision: approved.projection.revision,
      title: 'dev',
    }])
  })

  it('refuses a launch before a confirmed plan or with an unreadable acceptance definition', { timeout: 60_000 }, async () => {
    const env = await makeEnvironment()
    root = env.base
    const facade = await bootComposition(env)
    await facade.createTask(SPEC, 0)

    // No confirmed plan yet: the facade refuses before the runner is touched.
    await expect(facade.runAttempt(attemptRequest(env, 1)))
      .rejects.toMatchObject({ code: 'SELF_DEV_INVALID_STATE' })

    let revision = (await facade.authorizePlanning(TASK_ID, 1, 'phone-user')).revision
    revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
    revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'phone-user')).revision
    revision = (await facade.approveBudget(TASK_ID, revision, APPROVAL)).revision

    await expect(facade.runAttempt({ ...attemptRequest(env, revision), acceptancePath: join(env.base, 'missing.json') }))
      .rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' })
  })

  it('forwards the host-only dataHome to the runner as the attempt data directory', { timeout: 60_000 }, async () => {
    const env = await makeEnvironment()
    root = env.base
    const facade = await bootComposition(env)
    let revision = (await facade.createTask(SPEC, 0)).revision
    revision = (await facade.authorizePlanning(TASK_ID, revision, 'phone-user')).revision
    revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
    revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'phone-user')).revision
    revision = (await facade.approveBudget(TASK_ID, revision, APPROVAL)).revision

    // The workspace-assigned data home, laid out like the workspaces service
    // allocates it. Its launch ledger is pre-seeded, so the fixture's first
    // launch under it already writes DONE and the attempt can pass.
    const dataHome = join(env.runnerConfig.experimentsRoot, TASK_ID, 'dsh-home')
    await mkdir(dataHome, { recursive: true })
    await writeFile(join(dataHome, 'launches'), 'seed\n')

    const passed = await facade.runAttempt({ ...attemptRequest(env, revision), dataHome })
    expect(passed.operation.replayed).toBe(false)
    expect(passed.attemptId).toBeDefined()
    // The fixture files its launch ledger under the DSH_HOME it was handed:
    // the seeded line plus this launch proves dataHome was forwarded, and the
    // configured dshHome stays untouched.
    await expect(readFile(join(dataHome, 'launches'), 'utf8')).resolves.toBe('seed\ndev\n')
    await expect(readFile(join(env.runnerConfig.dshHome, 'launches'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stops a task with an in-flight attempt through the runner-backed stop', { timeout: 60_000 }, async () => {
    const env = await makeEnvironment()
    root = env.base
    const facade = await bootComposition(env)

    let revision = (await facade.createTask({ ...SPEC, requirement: 'hang' }, 0)).revision
    revision = (await facade.authorizePlanning(TASK_ID, revision, 'phone-user')).revision
    revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
    revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'phone-user')).revision
    revision = (await facade.approveBudget(TASK_ID, revision, APPROVAL)).revision

    const attempt = facade.runAttempt(attemptRequest(env, revision))
    // The unhandled-rejection guard keeps a failed expectation from turning
    // the attempt's own cancellation into an unhandled rejection.
    attempt.catch(() => undefined)
    await expect.poll(
      () => readFile(join(env.runnerConfig.dshHome, 'last-pgid'), 'utf8').catch(() => ''),
      { timeout: 30_000 },
    ).not.toBe('')
    const inFlight = await facade.getTask(TASK_ID)
    expect(inFlight.projection.status).toBe('attempting')
    const result = await facade.stop(TASK_ID, inFlight.projection.revision)
    expect(result.replayed).toBe(false)
    await expect(attempt).rejects.toMatchObject({ code: 'SELF_DEV_ATTEMPT_CANCELLED' })
    const detail = await facade.getTask(TASK_ID)
    expect(detail.projection.status).toBe('stopped')
    expect(await facade.activeTasks()).toEqual([])
  })
})
