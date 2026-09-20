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
import { acceptanceDefinition, baseUrlOf, makeEnvironment } from './helpers.ts'
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
async function bootComposition(
  env: Environment,
  overrides: { readonly roundDelayMs?: number } = {},
): Promise<SelfDevelopmentRemote> {
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
    // Omitted when not overridden: the deployment schema's own default (1000)
    // then applies, exactly like maxConcurrentCampaigns above it.
    ...(overrides.roundDelayMs === undefined ? [] : [`    roundDelayMs: ${overrides.roundDelayMs}`]),
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
      .rejects.toMatchObject({ code: 'self-development/core', details: { code: 'SELF_DEV_INVALID_RESULT' } })

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
      .rejects.toMatchObject({ code: 'self-development/core', details: { code: 'SELF_DEV_INVALID_STATE' } })

    let revision = (await facade.authorizePlanning(TASK_ID, 1, 'phone-user')).revision
    revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
    revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'phone-user')).revision
    revision = (await facade.approveBudget(TASK_ID, revision, APPROVAL)).revision

    await expect(facade.runAttempt({ ...attemptRequest(env, revision), acceptancePath: join(env.base, 'missing.json') }))
      .rejects.toMatchObject({ code: 'self-development/core', details: { code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' } })
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
    await expect(attempt).rejects.toMatchObject({ code: 'self-development/core', details: { code: 'SELF_DEV_ATTEMPT_CANCELLED' } })
    const detail = await facade.getTask(TASK_ID)
    expect(detail.projection.status).toBe('stopped')
    expect(await facade.activeTasks()).toEqual([])
  })

  it('recognizes the core\'s reactive no-progress stop and ends the campaign as exhausted after exactly one round, never launching a second', { timeout: 60_000 }, async () => {
    const env = await makeEnvironment()
    root = env.base
    const facade = await bootComposition(env)

    let revision = (await facade.createTask(SPEC, 0)).revision
    revision = (await facade.authorizePlanning(TASK_ID, revision, 'phone-user')).revision
    revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
    revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'phone-user')).revision
    // maxRounds is generous on purpose: the round budget must not be what
    // ends this campaign — noProgressAttemptLimit: 1 must be. The fake CLI's
    // 'dev' task fails its very first launch (writes WIP2, acceptance wants
    // DONE), and the core's own noProgressCount starts at 1 on the very
    // first failure, so one failed round already meets the limit.
    revision = (await facade.approveBudget(TASK_ID, revision, {
      mode: 'rounds', maxRounds: 20, phaseTimeoutMs: 20_000, maxStepsPerAttempt: 10, noProgressAttemptLimit: 1,
      testPlanVersion: TestPlanVersion(1), taskSpecVersion: TaskSpecVersion(1), approvedBy: 'phone-user',
    })).revision
    await facade.setLaunchProfile(TASK_ID, {
      worktree: env.worktree, acceptancePath: env.acceptancePath, artifactPaths: ['marker.txt', 'marker.txt'],
      confirmedBy: 'phone-user', loopbackAllowlist: [0],
    })

    await facade.startCampaign(TASK_ID, revision, { unattended: true, acceptedBy: 'phone-user' })
    await expect.poll(async () => (await facade.campaign(TASK_ID))?.status, { timeout: 30_000 }).toBe('exhausted')

    const finalState = await facade.campaign(TASK_ID)
    expect(finalState).toMatchObject({ status: 'exhausted', rounds: 1 })
    expect(finalState?.reason).toContain('no-progress')
    const detail = await facade.getTask(TASK_ID)
    expect(detail.projection.status).toBe('stopped')
    expect(detail.projection.stopReason).toBe('no-progress')
    expect(detail.projection.consumedRounds).toBe(1)
    // The fake CLI records one line per launch under DSH_HOME/launches — a
    // buggy loop that failed to recognize the reactive stop would have kept
    // retrying instantly and this would already show more than one line.
    const launches = await readFile(join(env.runnerConfig.dshHome, 'launches'), 'utf8')
    expect(launches.trim().split('\n')).toHaveLength(1)
    expect(await facade.activeTasks()).toEqual([])
  })

  it('recognizes the core\'s reactive budget-exhausted stop (maxRounds: 1) and ends the campaign as exhausted after exactly one round', { timeout: 60_000 }, async () => {
    const env = await makeEnvironment()
    root = env.base
    const facade = await bootComposition(env)

    let revision = (await facade.createTask(SPEC, 0)).revision
    revision = (await facade.authorizePlanning(TASK_ID, revision, 'phone-user')).revision
    revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
    revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'phone-user')).revision
    revision = (await facade.approveBudget(TASK_ID, revision, {
      mode: 'rounds', maxRounds: 1, phaseTimeoutMs: 20_000, maxStepsPerAttempt: 10,
      testPlanVersion: TestPlanVersion(1), taskSpecVersion: TaskSpecVersion(1), approvedBy: 'phone-user',
    })).revision
    await facade.setLaunchProfile(TASK_ID, {
      worktree: env.worktree, acceptancePath: env.acceptancePath, artifactPaths: ['marker.txt', 'marker.txt'],
      confirmedBy: 'phone-user', loopbackAllowlist: [0],
    })

    await facade.startCampaign(TASK_ID, revision, { unattended: true, acceptedBy: 'phone-user' })
    await expect.poll(async () => (await facade.campaign(TASK_ID))?.status, { timeout: 30_000 }).toBe('exhausted')

    const finalState = await facade.campaign(TASK_ID)
    expect(finalState).toMatchObject({ status: 'exhausted', rounds: 1 })
    expect(finalState?.reason).toContain('budget-exhausted')
    const detail = await facade.getTask(TASK_ID)
    expect(detail.projection.stopReason).toBe('budget-exhausted')
    expect(detail.projection.consumedRounds).toBe(1)
    const launches = await readFile(join(env.runnerConfig.dshHome, 'launches'), 'utf8')
    expect(launches.trim().split('\n')).toHaveLength(1)
  })

  it('reads the live core status before every round and ends a campaign as stopped when it finds the task already attempting, without ever reaching the runner', { timeout: 60_000 }, async () => {
    const env = await makeEnvironment()
    root = env.base
    const facade = await bootComposition(env)

    let revision = (await facade.createTask({ ...SPEC, requirement: 'hang' }, 0)).revision
    revision = (await facade.authorizePlanning(TASK_ID, revision, 'phone-user')).revision
    revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
    revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'phone-user')).revision
    revision = (await facade.approveBudget(TASK_ID, revision, APPROVAL)).revision
    await facade.setLaunchProfile(TASK_ID, {
      worktree: env.worktree, acceptancePath: env.acceptancePath, artifactPaths: ['marker.txt', 'marker.txt'],
      confirmedBy: 'phone-user', loopbackAllowlist: [0],
    })

    // A manual runAttempt — not through any campaign — leaves the task
    // 'attempting' while its own fake-CLI child hangs (ignores SIGTERM,
    // waits for SIGKILL). The core was never stopped, so there is no
    // stopReason to key off: exactly the branch a check keyed only on
    // no-progress/budget-exhausted stop reasons would miss.
    const manual = facade.runAttempt(attemptRequest(env, revision))
    manual.catch(() => undefined)
    await expect.poll(
      () => readFile(join(env.runnerConfig.dshHome, 'last-pgid'), 'utf8').catch(() => ''),
      { timeout: 30_000 },
    ).not.toBe('')
    expect((await facade.getTask(TASK_ID)).projection.status).toBe('attempting')

    await facade.startCampaign(TASK_ID, revision, { unattended: true, acceptedBy: 'phone-user' })
    await expect.poll(async () => (await facade.campaign(TASK_ID))?.status, { timeout: 30_000 }).toBe('stopped')

    const finalState = await facade.campaign(TASK_ID)
    expect(finalState?.reason).toContain('attempting')
    expect(finalState?.rounds).toBe(0)

    // Clean up the still-hanging manual attempt so the process group does
    // not outlive the test.
    const inFlight = await facade.getTask(TASK_ID)
    await facade.stop(TASK_ID, inFlight.projection.revision)
    await expect(manual).rejects.toBeDefined()
  })

  it('ends a campaign as failed after exactly one round when the launch profile\'s acceptance definition lives inside the experiments root, without the fake CLI ever running', { timeout: 60_000 }, async () => {
    const env = await makeEnvironment()
    root = env.base
    const facade = await bootComposition(env)

    let revision = (await facade.createTask(SPEC, 0)).revision
    revision = (await facade.authorizePlanning(TASK_ID, revision, 'phone-user')).revision
    revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
    revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'phone-user')).revision
    revision = (await facade.approveBudget(TASK_ID, revision, APPROVAL)).revision

    // Same definition bytes as env.acceptancePath, placed inside the
    // experiments root instead of outside it: the runner's own
    // loadAcceptance refuses this before controller.startAttempt commits
    // anything, exactly the pre-flight rejection the revision guard exists
    // to catch — and unlike env.acceptancePath, this is never about the file
    // being unreadable or missing (the other loadAcceptance failure already
    // covered above), so it isolates the placement rule specifically.
    const insideAcceptancePath = join(env.runnerConfig.experimentsRoot, 'inside-acceptance.json')
    await writeFile(insideAcceptancePath, acceptanceDefinition())
    await facade.setLaunchProfile(TASK_ID, {
      worktree: env.worktree, acceptancePath: insideAcceptancePath, artifactPaths: ['marker.txt', 'marker.txt'],
      confirmedBy: 'phone-user', loopbackAllowlist: [0],
    })

    await facade.startCampaign(TASK_ID, revision, { unattended: true, acceptedBy: 'phone-user' })
    await expect.poll(async () => (await facade.campaign(TASK_ID))?.status, { timeout: 30_000 }).toBe('failed')

    const finalState = await facade.campaign(TASK_ID)
    expect(finalState).toMatchObject({ status: 'failed', rounds: 0 })
    expect(finalState?.reason).toContain('must live outside the experiments root')
    // The core never saw attempt/started: status never left ready and no
    // round was consumed, unlike an attempt that genuinely reaches the core
    // and fails there (consumedRounds would be 1, as the very first test in
    // this file shows for that different scenario).
    const detail = await facade.getTask(TASK_ID)
    expect(detail.projection.status).toBe('ready')
    expect(detail.projection.consumedRounds).toBe(0)
    // The fake CLI is only ever invoked from inside the executor, which
    // loadAcceptance's rejection never lets this launch reach — so its
    // DSH_HOME/launches ledger was never created at all.
    await expect(readFile(join(env.runnerConfig.dshHome, 'launches'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await facade.activeTasks()).toEqual([])
  })

  it('waits at least roundDelayMs before launching the round after one that genuinely failed at the core', { timeout: 60_000 }, async () => {
    const env = await makeEnvironment()
    root = env.base
    const roundDelayMs = 1200
    const facade = await bootComposition(env, { roundDelayMs })

    let revision = (await facade.createTask(SPEC, 0)).revision
    revision = (await facade.authorizePlanning(TASK_ID, revision, 'phone-user')).revision
    revision = (await facade.submitPlanDraft(TASK_ID, revision, DRAFT)).revision
    revision = (await facade.confirmPlan(TASK_ID, revision, PLAN, 'phone-user')).revision
    revision = (await facade.approveBudget(TASK_ID, revision, APPROVAL)).revision
    await facade.setLaunchProfile(TASK_ID, {
      worktree: env.worktree, acceptancePath: env.acceptancePath, artifactPaths: ['marker.txt', 'marker.txt'],
      confirmedBy: 'phone-user', loopbackAllowlist: [0],
    })

    // SPEC's 'dev' requirement writes WIP2 on its first launch — acceptance
    // wants DONE, so round one genuinely reaches and fails at the core —
    // and DONE on its second, so round two passes: the same fixture
    // behavior the very first test in this file drives through a direct
    // runAttempt, here driven automatically by an unattended campaign.
    await facade.startCampaign(TASK_ID, revision, { unattended: true, acceptedBy: 'phone-user' })
    await expect.poll(async () => (await facade.campaign(TASK_ID))?.rounds, { timeout: 30_000 }).toBe(1)
    const afterRoundOne = Date.now()
    await expect.poll(async () => (await facade.campaign(TASK_ID))?.rounds, { timeout: 30_000 }).toBe(2)
    const afterRoundTwo = Date.now()

    // roundDelayMs is awaited in full before round two's own real work (a
    // fake-CLI spawn plus acceptance) even starts, so the gap between the
    // two rounds settling is always at least roundDelayMs on top of round
    // two's own execution time — comfortably larger than the low hundreds
    // of milliseconds a single fake-CLI launch plus acceptance takes
    // elsewhere in this file, so a missing or skipped wait fails this bound.
    expect(afterRoundTwo - afterRoundOne).toBeGreaterThanOrEqual(roundDelayMs)

    await expect.poll(async () => (await facade.campaign(TASK_ID))?.status, { timeout: 30_000 }).toBe('passed')
  })
})
