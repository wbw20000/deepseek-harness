/**
 * Real-Loader composition of the two self-development services: the core
 * task-control service and the supervised runner boot together from
 * `cordis.yml`, and every rule-9 scenario runs through
 * `ctx.selfDevelopmentRunner` against real journals, real git worktrees, and
 * the fake-dsh executor fixture. Each case owns its temporary directory, and
 * the suite spawns only its own fixture processes.
 * @module composition.spec
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import {
  SelfDevOperationId,
  SelfDevTaskId,
  SelfDevelopmentTasks,
  TaskJournal,
  TestPlanVersion,
  TaskSpecVersion,
} from '@deepseek-ai/dsh-workflow-self-development'
import type {
  BudgetApproval,
  CommittedRecord,
  SelfDevelopmentTaskController,
} from '@deepseek-ai/dsh-workflow-self-development'
import SelfDevelopmentRunner from '../src/index.ts'
import { resolveExperimentWorktree } from '../src/binding.ts'
import { artifactDigestOf, sourceDigestOf } from '../src/digests.ts'
import { HumanPresenceCapabilitySource } from '../src/presence.ts'
import type { PresenceConfirmation } from '../src/presence.ts'
import type { RunnerConfig } from '../src/types.ts'

const execFileAsync = promisify(execFile)
const fakeDsh = fileURLToPath(new URL('./fixtures/fake-dsh-attempt.mjs', import.meta.url))
const fakeCase = fileURLToPath(new URL('./fixtures/fake-case.mjs', import.meta.url))

const TASK_ID = 'task-e3-composition'
const REQUIRED_CASES = [{ caseId: 'build', requirement: 'the marker reads DONE', assertionIds: ['a1', 'a2'] }]
const PLAN_INPUT = {
  testPlanId: 'plan-1',
  version: TestPlanVersion(1),
  taskSpecVersion: TaskSpecVersion(1),
  requiredCases: REQUIRED_CASES,
  manualCases: [],
}
const APPROVAL: BudgetApproval = {
  mode: 'both',
  maxRounds: 5,
  durationMs: 120_000,
  phaseTimeoutMs: 20_000,
  maxStepsPerAttempt: 10,
  testPlanVersion: TestPlanVersion(1),
  taskSpecVersion: TaskSpecVersion(1),
  approvedBy: 'tester',
}

/** Harness files on disk: control directory, worktree, acceptance definition, and both service configs. */
interface Environment {
  readonly base: string
  readonly config: RunnerConfig
  readonly controlDirectory: string
  readonly experimentsRoot: string
  readonly worktree: string
  readonly acceptancePath: string
  readonly acceptanceDefinitionDigest: string
}

/** One booted Loader context over an {@link Environment}, with its task driven to ready. */
interface Composition {
  readonly env: Environment
  readonly context: Context
  readonly runner: SelfDevelopmentRunner
  readonly controller: SelfDevelopmentTaskController
  readonly taskId: string
}

/** Root of the harness most recently built; removed after every test. */
let root: string | undefined
/** Context most recently booted; disposed after every test unless the test disposed it. */
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** The acceptance definition every harness publishes: case `build` with assertions `a1` and `a2`. */
function acceptanceDefinition(): string {
  return JSON.stringify({
    cases: [{
      caseId: 'build',
      command: ['node', fakeCase, 'read', 'marker.txt'],
      timeoutMs: 10_000,
      assertions: [
        { assertionId: 'a1', kind: 'exit-code', expected: 0 },
        { assertionId: 'a2', kind: 'file-includes', path: 'marker.txt', text: 'DONE' },
      ],
    }],
  })
}

/** Run one git command and fail the test on a nonzero exit. */
async function runGit(args: readonly string[]): Promise<void> {
  await execFileAsync('git', args)
}

/** Create the experiment worktree as a real git repository holding one tracked marker file. */
async function makeWorktree(experimentsRoot: string): Promise<string> {
  const worktree = join(experimentsRoot, 'wt')
  await runGit(['init', '-q', '-b', 'main', worktree])
  await writeFile(join(worktree, 'marker.txt'), 'WIP')
  const identity = ['-c', 'user.email=e3@example.invalid', '-c', 'user.name=e3']
  await runGit(['-C', worktree, ...identity, 'add', 'marker.txt'])
  await runGit(['-C', worktree, ...identity, 'commit', '-q', '-m', 'baseline'])
  return worktree
}

/** Build the harness files: worktree, acceptance definition, and both service configurations. */
async function makeEnvironment(): Promise<Environment> {
  const base = await mkdtemp(join(tmpdir(), 'self-dev-runner-composition-'))
  root = base
  const experimentsRoot = join(base, 'experiments')
  const worktree = await makeWorktree(experimentsRoot)
  const acceptancePath = join(base, 'acceptance.json')
  const definition = acceptanceDefinition()
  await writeFile(acceptancePath, definition)
  const config: RunnerConfig = {
    nodeBinary: process.execPath,
    dshBin: fakeDsh,
    dshHome: join(base, 'dsh-home'),
    experimentsRoot,
    evidenceRoot: join(base, 'evidence'),
    killGraceMs: 400,
  }
  return {
    base,
    config,
    controlDirectory: join(base, 'control'),
    experimentsRoot,
    worktree,
    acceptancePath,
    acceptanceDefinitionDigest: createHash('sha256').update(definition).digest('hex'),
  }
}

/** Boot both services from a real `cordis.yml` through the Loader. */
async function bootComposition(env: Environment): Promise<Context> {
  const configPath = join(env.base, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-workflow-self-development'",
    '  config:',
    `    controlDirectory: '${env.controlDirectory}'`,
    '    maxRecordsPerSegment: 100',
    '    checkpointInterval: 10',
    "- name: '@deepseek-ai/dsh-workflow-self-development-runner'",
    '  config:',
    `    nodeBinary: '${env.config.nodeBinary}'`,
    `    dshBin: '${env.config.dshBin}'`,
    `    dshHome: '${env.config.dshHome}'`,
    `    experimentsRoot: '${env.config.experimentsRoot}'`,
    `    evidenceRoot: '${env.config.evidenceRoot}'`,
    '    killGraceMs: 400',
    '',
  ].join('\n'))
  const booted = new Context()
  context = booted
  booted.baseUrl = `${pathToFileURL(env.base).href}/`
  await booted.plugin(Loader)
  booted.loader.builtins.include = Include
  booted.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === '@deepseek-ai/dsh-workflow-self-development') {
        return import('@deepseek-ai/dsh-workflow-self-development')
      }
      if (specifier === '@deepseek-ai/dsh-workflow-self-development-runner') {
        return import('../src/index.ts')
      }
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof booted.loader.internal>
  await booted.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await booted.loader.await()
  return booted
}

/** Drive one fresh controller through create, planning, confirmation, and budget approval to ready. */
async function driveToReady(controller: SelfDevelopmentTaskController, requirement: string): Promise<void> {
  let revision = controller.projection.revision
  const header = (operationId: string) => ({
    taskId: SelfDevTaskId(TASK_ID),
    expectedRevision: revision,
    operationId: SelfDevOperationId(operationId),
  })
  revision = (await controller.createTask({
    ...header('create'),
    spec: {
      taskId: SelfDevTaskId(TASK_ID),
      version: 1,
      requirement,
      allowedModificationScope: ['marker.txt'],
      stableBaselineDigest: createHash('sha256').update('baseline').digest('hex'),
      createdBy: 'tester',
    },
  })).revision
  revision = (await controller.authorizePlanning({ ...header('authorize'), authorizedBy: 'tester' })).revision
  revision = (await controller.submitPlanDraft({
    ...header('draft'),
    draft: { requiredCases: PLAN_INPUT.requiredCases, manualCases: PLAN_INPUT.manualCases },
  })).revision
  revision = (await controller.confirmPlan({ ...header('confirm'), plan: { ...PLAN_INPUT } })).revision
  await controller.approveBudget({ ...header('approve'), approval: { ...APPROVAL } })
}

/**
 * Boot the composition and drive one task to ready.
 * @param requirement - the executor task text; the fixture keys its behavior on it.
 */
async function makeComposition(requirement: string): Promise<Composition> {
  const env = await makeEnvironment()
  const booted = await bootComposition(env)
  const runner = booted.selfDevelopmentRunner
  const controller = await booted.selfDevelopmentTasks.open(TASK_ID, runner.clock())
  await driveToReady(controller, requirement)
  return { env, context: booted, runner, controller, taskId: TASK_ID }
}

/** A human confirmation binding the composition's current launch facts. */
function presenceFor(composition: Composition): PresenceConfirmation {
  const plan = composition.controller.projection.plan
  if (plan === undefined) throw new Error('composition task did not reach a confirmed plan')
  return {
    confirmedBy: 'tester',
    confirmedAt: composition.runner.clock().observe(),
    worktree: composition.env.worktree,
    loopbackAllowlist: [0],
    acknowledgement: 'supervised-not-unattended',
    taskId: composition.taskId,
    testPlanDigest: plan.digest,
    acceptanceDefinitionDigest: composition.env.acceptanceDefinitionDigest,
    artifactPaths: ['marker.txt'],
  }
}

/** One supervised attempt request against the composition's current revision. */
function attemptRequest(
  composition: Composition,
  operationId: string,
  overrides: { readonly signal?: AbortSignal } = {},
): Parameters<typeof composition.runner.runAttempt>[0] {
  return {
    taskId: composition.taskId,
    expectedRevision: composition.controller.projection.revision,
    operationId,
    worktree: composition.env.worktree,
    artifactPaths: ['marker.txt'],
    acceptancePath: composition.env.acceptancePath,
    presence: presenceFor(composition),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  }
}

/** The number of executor launches the fixture recorded under the harness's DSH home. */
async function launchCount(env: Environment): Promise<number> {
  const text = await readFile(join(env.config.dshHome, 'launches'), 'utf8').catch(() => '')
  return text.length === 0 ? 0 : text.trim().split('\n').length
}

/** The committed records of the harness's task journal, read back through a fresh journal. */
async function journalRecords(env: Environment): Promise<readonly CommittedRecord[]> {
  const journal = await TaskJournal.open(join(env.controlDirectory, 'tasks', TASK_ID), {
    maxRecordsPerSegment: 100,
    checkpointInterval: 10,
  })
  return (await journal.read()).records
}

/** Whether a process group is gone, judged by the ESRCH of a signal-zero probe. */
function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** The process group id the executor fixture recorded for its most recent launch. */
async function lastPgid(env: Environment): Promise<number> {
  return Number(await readFile(join(env.config.dshHome, 'last-pgid'), 'utf8'))
}

/** The committed field of the single attempt outcome file the harness has produced so far. */
async function outcomeCommitted(env: Environment): Promise<string> {
  const attempts = join(env.config.evidenceRoot, 'tasks', TASK_ID, 'attempts')
  const files = await readdir(attempts)
  const outcome = files.find(name => name.endsWith('.outcome.json'))
  if (outcome === undefined) throw new Error(`no outcome file in ${JSON.stringify(files)}`)
  return (JSON.parse(await readFile(join(attempts, outcome), 'utf8')) as { committed: string }).committed
}

describe('real-Loader composition', () => {
  it('boots both services from one cordis.yml with the runner injecting the task service', { timeout: 60_000 }, async () => {
    const env = await makeEnvironment()
    const booted = await bootComposition(env)
    expect(booted.selfDevelopmentTasks).toBeInstanceOf(SelfDevelopmentTasks)
    expect(booted.selfDevelopmentRunner).toBeInstanceOf(SelfDevelopmentRunner)
    expect(SelfDevelopmentRunner.inject).toEqual(['selfDevelopmentTasks'])
    expect(booted.selfDevelopmentRunner.clock()).toBe(booted.selfDevelopmentRunner.clock())
  })

  it('runs a failed attempt and then a fixed passing attempt through the runner', { timeout: 60_000 }, async () => {
    const composition = await makeComposition('dev')
    await expect(composition.runner.runAttempt(attemptRequest(composition, 'op-1')))
      .rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
    expect(composition.controller.projection.status).toBe('ready')
    expect(composition.controller.projection.consumedRounds).toBe(1)
    const second = await composition.runner.runAttempt(attemptRequest(composition, 'op-2', { signal: new AbortController().signal }))
    expect(second.operation.replayed).toBe(false)
    expect(composition.controller.projection.status).toBe('awaiting-trial')
    expect(composition.runner.activeTasks()).toEqual([])
  })

  it('stops a running attempt, exits the executor process group, and records a cancelled outcome', { timeout: 60_000 }, async () => {
    const composition = await makeComposition('hang')
    const attempt = composition.runner.runAttempt(attemptRequest(composition, 'op-1'))
    await expect.poll(async () => readFile(join(composition.env.config.dshHome, 'last-pgid'), 'utf8').catch(() => ''), { timeout: 10_000 })
      .not.toBe('')
    const pgid = await lastPgid(composition.env)
    expect(groupGone(pgid)).toBe(false)

    const result = await composition.runner.stop({
      taskId: TASK_ID,
      expectedRevision: composition.controller.projection.revision,
      operationId: 'stop-1',
    })
    expect(result.replayed).toBe(false)
    await expect(attempt).rejects.toMatchObject({ code: 'SELF_DEV_ATTEMPT_CANCELLED' })
    await expect.poll(() => groupGone(pgid), { timeout: 10_000 }).toBe(true)
    expect(composition.runner.activeTasks()).toEqual([])
    expect(await outcomeCommitted(composition.env)).toBe('cancelled')
  })

  it('finishes the owned attempt and its process group before fiber disposal resolves', { timeout: 60_000 }, async () => {
    const composition = await makeComposition('hang')
    const attempt = composition.runner.runAttempt(attemptRequest(composition, 'op-1'))
    let attemptSettled = false
    const tracked = attempt.catch(() => {
      attemptSettled = true
    })
    await expect.poll(async () => readFile(join(composition.env.config.dshHome, 'last-pgid'), 'utf8').catch(() => ''), { timeout: 10_000 })
      .not.toBe('')
    const pgid = await lastPgid(composition.env)
    expect(groupGone(pgid)).toBe(false)

    await composition.context.fiber.dispose()
    context = undefined
    await tracked
    await expect(attempt).rejects.toMatchObject({ code: 'SELF_DEV_ATTEMPT_CANCELLED' })
    expect(groupGone(pgid)).toBe(true)
    expect(attemptSettled).toBe(true)
    expect(composition.runner.activeTasks()).toEqual([])
  })

  it('records a failed attempt when the evidence write fails and never passes the task', { timeout: 60_000 }, async () => {
    const composition = await makeComposition('dev')
    // The launch record directory is pre-created and stays writable; only new
    // directories under the read-only tasks root fail, so the attempt runs and
    // its evidence write is what fails.
    await mkdir(join(composition.env.config.evidenceRoot, 'tasks', TASK_ID, 'launches'), { recursive: true })
    await chmod(join(composition.env.config.evidenceRoot, 'tasks'), 0o555)
    try {
      await expect(composition.runner.runAttempt(attemptRequest(composition, 'op-1')))
        .rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
    } finally {
      await chmod(join(composition.env.config.evidenceRoot, 'tasks'), 0o755)
    }
    const records = await journalRecords(composition.env)
    expect(records.some(record => record.event.type === 'attempt/failed')).toBe(true)
    expect(records.some(record => record.event.type === 'task/passed')).toBe(false)
    expect(composition.controller.projection.status).toBe('ready')
    expect(composition.runner.activeTasks()).toEqual([])
  })

  it('replays a committed operation id without launching the executor again', { timeout: 60_000 }, async () => {
    const composition = await makeComposition('fail')
    await expect(composition.runner.runAttempt(attemptRequest(composition, 'op-replay')))
      .rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
    const count = await launchCount(composition.env)
    const replayed = await composition.runner.runAttempt(attemptRequest(composition, 'op-replay'))
    expect(replayed.operation.replayed).toBe(true)
    expect(replayed.attemptId).toBeUndefined()
    expect(replayed.evidencePath).toBeUndefined()
    expect(await launchCount(composition.env)).toBe(count)
    expect(composition.runner.activeTasks()).toEqual([])
  })

  it('recovers a crashed in-flight attempt as handoff and refuses a launch without a launch record', { timeout: 60_000 }, async () => {
    const env = await makeEnvironment()
    const contextA = await bootComposition(env)
    const runnerA = contextA.selfDevelopmentRunner
    const controllerA = await contextA.selfDevelopmentTasks.open(TASK_ID, runnerA.clock())
    await driveToReady(controllerA, 'dev')
    const worktreeReal = await resolveExperimentWorktree(env.config.experimentsRoot, env.worktree)
    // The simulated crash: an attempt whose side effect never resolves, left
    // in flight by disposing the context instead of settling it.
    const crashed = controllerA.startAttempt({
      taskId: SelfDevTaskId(TASK_ID),
      expectedRevision: controllerA.projection.revision,
      operationId: SelfDevOperationId('op-crash'),
      sourceDigest: await sourceDigestOf(worktreeReal),
      artifactDigest: await artifactDigestOf(worktreeReal, ['marker.txt']),
      clock: runnerA.clock(),
      capabilitySource: new HumanPresenceCapabilitySource(presenceFor({
        env, context: contextA, runner: runnerA, controller: controllerA, taskId: TASK_ID,
      })),
      sideEffect: () => new Promise<never>(() => {}),
    })
    // The simulated crash leaves this launch pending forever; nothing awaits it.
    void crashed
    await contextA.fiber.dispose()
    context = undefined

    const contextB = await bootComposition(env)
    const runnerB = contextB.selfDevelopmentRunner
    const state = await contextB.selfDevelopmentTasks.state(TASK_ID, runnerB.clock())
    expect(state.status).toBe('handoff')
    expect(state.handoffReason).toBe('attempt-interrupted')
    const controllerB = await contextB.selfDevelopmentTasks.open(TASK_ID, runnerB.clock())
    await expect(runnerB.runAttempt(attemptRequest({
      env, context: contextB, runner: runnerB, controller: controllerB, taskId: TASK_ID,
    }, 'op-after-crash'))).rejects.toThrow(/handoff/)
    const launches = join(env.config.evidenceRoot, 'tasks', TASK_ID, 'launches')
    expect(await readdir(launches).catch(() => [])).toEqual([])
    await contextB.fiber.dispose()
    context = undefined
  })
})
