/**
 * Supervised attempt orchestration end to end: a real task controller, journal,
 * git worktree, executor fixture, and acceptor drive `runSupervisedAttempt`
 * through the safety revision's rules in order — preflight refusal, binding,
 * launch record, launch, side effect, evidence, and outcome. The suite spawns
 * only its own fixture processes and removes every temporary directory.
 * @module attempt.spec
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rmdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SelfDevAttemptId,
  SelfDevelopmentError,
  SelfDevOperationId,
  SelfDevTaskId,
  SelfDevelopmentTaskController,
  TaskJournal,
  TestPlanVersion,
  TaskSpecVersion,
} from '@deepseek-ai/dsh-workflow-self-development'
import type {
  Attempt,
  BudgetApproval,
  CommittedRecord,
  FrozenTestPlan,
  TaskOperationResult,
  TaskProjection,
} from '@deepseek-ai/dsh-workflow-self-development'
import { HostClock } from '../src/clock.ts'
import { resolveExperimentWorktree } from '../src/binding.ts'
import { planAttemptBudget } from '../src/budget.ts'
import { runSupervisedAttempt, spentBudgetExecution } from '../src/attempt.ts'
import type { SupervisedAttemptRequest } from '../src/attempt.ts'
import { artifactDigestOf, sourceDigestOf } from '../src/digests.ts'
import { readAttemptEvidence } from '../src/evidence.ts'
import { writeLaunchRecord } from '../src/launch-record.ts'
import type { LaunchRecord } from '../src/launch-record.ts'
import type { PresenceConfirmation } from '../src/presence.ts'
import type { RunnerConfig } from '../src/types.ts'

const execFileAsync = promisify(execFile)
const fakeDsh = fileURLToPath(new URL('./fixtures/fake-dsh-attempt.mjs', import.meta.url))
const fakeCase = fileURLToPath(new URL('./fixtures/fake-case.mjs', import.meta.url))

const TASK_ID = 'task-e2c'
const REQUIRED_CASES = [{ caseId: 'build', requirement: 'the marker reads DONE', assertionIds: ['a1', 'a2'] }]
const PLAN_INPUT = {
  testPlanId: 'plan-1',
  version: TestPlanVersion(1),
  taskSpecVersion: TaskSpecVersion(1),
  requiredCases: REQUIRED_CASES,
  manualCases: [],
}
const SPEC_INPUT = {
  taskId: TASK_ID,
  version: 1,
  requirement: 'dev',
  allowedModificationScope: ['marker.txt'],
  stableBaselineDigest: createHash('sha256').update('baseline').digest('hex'),
  createdBy: 'tester',
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

/** Root of the harness most recently built; removed after every test. */
let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** One end-to-end harness: git worktree, acceptance definition, task journal, and runner config. */
interface Harness {
  readonly config: RunnerConfig
  readonly clock: HostClock
  readonly controller: SelfDevelopmentTaskController
  readonly journal: TaskJournal
  readonly taskId: string
  readonly worktree: string
  readonly acceptancePath: string
  readonly acceptanceDefinitionDigest: string
  readonly testPlanDigest: string
}

/** Run one git command and fail the test on a nonzero exit. */
async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { cwd })
}

/** Create the experiment worktree as a real git repository holding one tracked marker file. */
async function makeWorktree(experimentsRoot: string): Promise<string> {
  const worktree = join(experimentsRoot, 'wt')
  await execFileAsync('git', ['init', '-q', '-b', 'main', worktree])
  await writeFile(join(worktree, 'marker.txt'), 'WIP')
  await runGit(worktree, ['-c', 'user.email=e2c@example.invalid', '-c', 'user.name=e2c', 'add', 'marker.txt'])
  await runGit(worktree, [
    '-c', 'user.email=e2c@example.invalid', '-c', 'user.name=e2c', 'commit', '-q', '-m', 'baseline',
  ])
  return worktree
}

/** Options that vary one harness: the executor task text, the budget, and the acceptance command. */
interface HarnessOptions {
  readonly requirement?: string
  readonly approval?: BudgetApproval
  readonly caseCommand?: readonly string[]
}

/** The acceptance definition every harness publishes: case `build` with assertions `a1` and `a2`. */
function acceptanceDefinition(caseCommand: readonly string[]): string {
  return JSON.stringify({
    cases: [{
      caseId: 'build',
      command: [...caseCommand],
      timeoutMs: 10_000,
      assertions: [
        { assertionId: 'a1', kind: 'exit-code', expected: 0 },
        { assertionId: 'a2', kind: 'file-includes', path: 'marker.txt', text: 'DONE' },
      ],
    }],
  })
}

/** Build the harness: temporary git worktree, acceptance definition, journal, and a task driven to ready. */
async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), 'self-dev-attempt-'))
  root = base
  const experimentsRoot = join(base, 'experiments')
  const worktree = await makeWorktree(experimentsRoot)
  const acceptancePath = join(base, 'acceptance.json')
  const definition = acceptanceDefinition(options.caseCommand ?? ['node', fakeCase, 'read', 'marker.txt'])
  await writeFile(acceptancePath, definition)
  const config: RunnerConfig = {
    nodeBinary: process.execPath,
    dshBin: fakeDsh,
    dshHome: join(base, 'dsh-home'),
    experimentsRoot,
    evidenceRoot: join(base, 'evidence'),
    killGraceMs: 400,
  }
  const clock = new HostClock()
  const journal = await TaskJournal.open(join(base, 'control', TASK_ID), {
    maxRecordsPerSegment: 100,
    checkpointInterval: 10,
  })
  const controller = await SelfDevelopmentTaskController.open({ taskId: TASK_ID, journal, clock })
  await driveToReady(controller, options)
  const projection = controller.projection
  if (projection.plan === undefined) throw new Error('harness task did not reach a confirmed plan')
  return {
    config,
    clock,
    controller,
    journal,
    taskId: TASK_ID,
    worktree,
    acceptancePath,
    acceptanceDefinitionDigest: createHash('sha256').update(definition).digest('hex'),
    testPlanDigest: projection.plan.digest,
  }
}

/** Drive one fresh controller through create, planning, confirmation, and budget approval to ready. */
async function driveToReady(controller: SelfDevelopmentTaskController, options: HarnessOptions): Promise<void> {
  let revision = controller.projection.revision
  const header = (operationId: string) => ({
    taskId: SelfDevTaskId(TASK_ID),
    expectedRevision: revision,
    operationId: SelfDevOperationId(operationId),
  })
  const requirement = options.requirement ?? 'dev'
  revision = (await controller.createTask({ ...header('create'), spec: { ...SPEC_INPUT, requirement } })).revision
  revision = (await controller.authorizePlanning({ ...header('authorize'), authorizedBy: 'tester' })).revision
  revision = (await controller.submitPlanDraft({
    ...header('draft'),
    draft: { requiredCases: PLAN_INPUT.requiredCases, manualCases: PLAN_INPUT.manualCases },
  })).revision
  revision = (await controller.confirmPlan({ ...header('confirm'), plan: { ...PLAN_INPUT } })).revision
  await controller.approveBudget({ ...header('approve'), approval: options.approval ?? { ...APPROVAL } })
}

/** The dependencies `runSupervisedAttempt` reads from one harness. */
function depsOf(harness: Harness): {
  readonly controller: SelfDevelopmentTaskController
  readonly clock: HostClock
  readonly config: RunnerConfig
} {
  return { controller: harness.controller, clock: harness.clock, config: harness.config }
}

/** A human confirmation binding the harness's current launch facts. */
function presenceFor(harness: Harness, overrides: Partial<PresenceConfirmation> = {}): PresenceConfirmation {
  return {
    confirmedBy: 'tester',
    confirmedAt: harness.clock.observe(),
    worktree: harness.worktree,
    loopbackAllowlist: [0],
    acknowledgement: 'supervised-not-unattended',
    taskId: harness.taskId,
    testPlanDigest: harness.testPlanDigest,
    acceptanceDefinitionDigest: harness.acceptanceDefinitionDigest,
    artifactPaths: ['marker.txt'],
    ...overrides,
  }
}

/** One supervised attempt request against the harness's current revision. */
function attemptRequest(
  harness: Harness,
  operationId: string,
  overrides: Partial<SupervisedAttemptRequest> = {},
): SupervisedAttemptRequest {
  return {
    taskId: harness.taskId,
    expectedRevision: harness.controller.projection.revision,
    operationId,
    worktree: harness.worktree,
    artifactPaths: ['marker.txt'],
    acceptancePath: harness.acceptancePath,
    presence: presenceFor(harness),
    ...overrides,
  }
}

/** The number of executor launches the fixture recorded under the harness's DSH home. */
async function launchCount(harness: Harness): Promise<number> {
  const text = await readFile(join(harness.config.dshHome, 'launches'), 'utf8').catch(() => '')
  return text.length === 0 ? 0 : text.trim().split('\n').length
}

/** The committed records of the harness's task journal, read back through the core. */
async function journalRecords(harness: Harness): Promise<readonly CommittedRecord[]> {
  return (await harness.journal.read()).records
}

/**
 * Run one attempt the core settles as a failure and assert the rejection code.
 * A failed attempt rethrows the core's rejection, so its evidence is addressed
 * through the journal's attempt id.
 * @param harness - the harness to run against.
 * @param operationId - operation the attempt is bound to.
 * @param expectedCode - the machine-routable code the core rejects with.
 * @param overrides - request overrides for the attempt.
 */
async function runFailingAttempt(
  harness: Harness,
  operationId: string,
  expectedCode: string,
  overrides: Partial<SupervisedAttemptRequest> = {},
): Promise<void> {
  await expect(runSupervisedAttempt(depsOf(harness), attemptRequest(harness, operationId, overrides)))
    .rejects.toMatchObject({ code: expectedCode })
}

/** The attempt id of the journal's `attemptNumber + 1`-th `attempt/started` record. */
async function attemptIdOf(harness: Harness, attemptNumber: number): Promise<string> {
  const started = (await journalRecords(harness))
    .filter(record => record.event.type === 'attempt/started')
    .map(record => (record.event as { attempt: Attempt }).attempt)
  const attempt = started[attemptNumber - 1]
  if (attempt === undefined) throw new Error(`no attempt number ${String(attemptNumber)} was started`)
  return attempt.attemptId
}

/** The attempt id the journal's first `attempt/started` record committed. */
async function firstAttemptId(harness: Harness): Promise<string> {
  const started = (await journalRecords(harness)).find(record => record.event.type === 'attempt/started')
  if (started === undefined || started.event.type !== 'attempt/started') throw new Error('no attempt was started')
  return started.event.attempt.attemptId
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

/**
 * Write a launch record by hand: the pre-seeded record a test needs before
 * the orchestration would write one itself.
 * @param harness - the harness supplying every fact the record binds.
 * @param operationId - operation the record is filed under.
 * @param mutate - the divergence to inject, when the test studies a mismatch.
 */
async function seedLaunchRecord(
  harness: Harness,
  operationId: string,
  mutate: (record: LaunchRecord) => LaunchRecord = record => record,
): Promise<void> {
  const worktreeReal = await resolveExperimentWorktree(harness.config.experimentsRoot, harness.worktree)
  const revision = harness.controller.projection.revision
  await writeLaunchRecord(harness.config.evidenceRoot, mutate({
    schemaVersion: 1,
    taskId: harness.taskId,
    operationId,
    expectedRevision: revision,
    worktreeReal,
    artifactPaths: ['marker.txt'],
    acceptancePath: harness.acceptancePath,
    acceptanceDefinitionDigest: harness.acceptanceDefinitionDigest,
    testPlanDigest: harness.testPlanDigest,
    sourceDigest: await sourceDigestOf(worktreeReal),
    artifactDigest: await artifactDigestOf(worktreeReal, ['marker.txt']),
    budget: planAttemptBudget(APPROVAL, 0),
    presence: presenceFor(harness),
    recordedAt: harness.clock.observe(),
  }))
}

describe('supervised attempt', () => {
  it('runs a failed attempt, then a passing attempt, and leaves decided evidence for both', { timeout: 60_000 }, async () => {
    const harness = await makeHarness()
    await runFailingAttempt(harness, 'op-1', 'SELF_DEV_INVALID_RESULT')
    expect(harness.controller.projection.status).toBe('ready')
    expect(harness.controller.projection.consumedRounds).toBe(1)
    const firstEvidence = await readAttemptEvidence(harness.config.evidenceRoot, TASK_ID, await attemptIdOf(harness, 1))
    expect(firstEvidence?.evidence.tested.sourceDigest).not.toBe(firstEvidence?.evidence.launch.sourceDigest)
    expect(firstEvidence?.evidence.contentStable).toBe(true)
    expect(firstEvidence?.evidence.acceptance).toBeDefined()
    expect(firstEvidence?.outcome?.committed).toBe('failed')
    expect(firstEvidence?.outcome?.revision).toBeUndefined()
    expect(firstEvidence?.evidence.phases.map(phase => phase.phaseId)).toEqual(['develop', 'accept'])

    const second = await runSupervisedAttempt(
      depsOf(harness),
      attemptRequest(harness, 'op-2', { signal: new AbortController().signal }),
    )
    expect(second.operation.replayed).toBe(false)
    expect(harness.controller.projection.status).toBe('awaiting-trial')
    const secondEvidence = await readAttemptEvidence(harness.config.evidenceRoot, TASK_ID, second.attemptId ?? '')
    expect(secondEvidence?.outcome?.committed).toBe('passed')
    expect(secondEvidence?.evidence.result.exitCode).toBe(0)
    expect(secondEvidence?.evidence.contentStable).toBe(true)

    const started = (await journalRecords(harness))
      .filter(record => record.event.type === 'attempt/started')
      .map(record => (record.event as { attempt: Attempt }).attempt)
    expect(started).toHaveLength(2)
    expect(started.every(attempt => attempt.capabilitySource === 'human-presence')).toBe(true)

    // A task that already passed refuses a further launch before any digest is computed.
    const afterPass = harness.controller.projection.revision
    await expect(runSupervisedAttempt(depsOf(harness), attemptRequest(harness, 'op-3')))
      .rejects.toMatchObject({ code: 'SELF_DEV_INVALID_STATE' })
    expect(harness.controller.projection.revision).toBe(afterPass)
  })

  it('fails an attempt whose second step crosses the approved step cap', { timeout: 60_000 }, async () => {
    const harness = await makeHarness({
      requirement: 'steps',
      approval: { ...APPROVAL, maxStepsPerAttempt: 1 },
    })
    await runFailingAttempt(harness, 'op-1', 'SELF_DEV_INVALID_RESULT', { artifactPaths: ['marker.txt'] })
    const evidence = await readAttemptEvidence(harness.config.evidenceRoot, TASK_ID, await attemptIdOf(harness, 1))
    expect(evidence?.evidence.executor.stepCapHit).toBe(true)
    expect(evidence?.evidence.result.signal).toBe('SIGTERM')
    expect(evidence?.evidence.acceptance).toBeUndefined()
    const failed = (await journalRecords(harness)).find(record => record.event.type === 'attempt/failed')
    if (failed?.event.type !== 'attempt/failed') throw new Error('no attempt failed')
    expect(failed.event.reason).toContain('SIGTERM')
  })

  it('fails an attempt whose development phase runs past its own limit', { timeout: 60_000 }, async () => {
    const harness = await makeHarness({
      requirement: 'hang',
      approval: { ...APPROVAL, phaseTimeoutMs: 100 },
    })
    await runFailingAttempt(harness, 'op-1', 'SELF_DEV_INVALID_RESULT')
    const evidence = await readAttemptEvidence(harness.config.evidenceRoot, TASK_ID, await attemptIdOf(harness, 1))
    expect(evidence?.evidence.executor.timedOut).toBe(true)
    expect(evidence?.evidence.result.timedOut).toBe(true)
    expect(evidence?.evidence.acceptance).toBeUndefined()
    expect(harness.controller.projection.status).toBe('ready')
    expect(harness.controller.projection.consumedRounds).toBe(1)
  })

  it('times an attempt out when the acceptance deadline fires first', { timeout: 60_000 }, async () => {
    const harness = await makeHarness({
      requirement: 'dev',
      approval: {
        mode: 'time',
        durationMs: 3_000,
        noProgressAttemptLimit: 5,
        testPlanVersion: TestPlanVersion(1),
        taskSpecVersion: TaskSpecVersion(1),
        approvedBy: 'tester',
      },
      caseCommand: ['node', fakeCase, 'sleep', '8000'],
    })
    await runFailingAttempt(harness, 'op-1', 'SELF_DEV_LATE_RESULT')
    const evidence = await readAttemptEvidence(harness.config.evidenceRoot, TASK_ID, await attemptIdOf(harness, 1))
    expect(evidence?.evidence.result.timedOut).toBe(true)
    expect(evidence?.evidence.result.cancelled).toBe(false)
    expect(evidence?.evidence.acceptance?.cancelled).toBe(true)
    expect(evidence?.evidence.contentStable).toBe(true)
    expect(evidence?.outcome?.committed).toBe('late')
    // A time-only budget whose attempt consumed its whole duration stops the task.
    expect(harness.controller.projection.status).toBe('stopped')
    expect(harness.controller.projection.stopReason).toBe('budget-exhausted')
  })

  it('refuses to pass when the worktree changes while acceptance runs', { timeout: 60_000 }, async () => {
    const harness = await makeHarness({ requirement: 'dev', caseCommand: ['node', fakeCase, 'write', 'tampered.txt', 'changed'] })
    await runFailingAttempt(harness, 'op-1', 'SELF_DEV_INVALID_RESULT')
    const evidence = await readAttemptEvidence(harness.config.evidenceRoot, TASK_ID, await attemptIdOf(harness, 1))
    expect(evidence?.evidence.contentStable).toBe(false)
    expect(evidence?.evidence.afterAcceptance).toBeDefined()
    expect(evidence?.evidence.result.exitCode).toBe(1)
    expect(harness.controller.projection.status).toBe('ready')
    expect(harness.controller.projection.verifiedResultDigest).toBeUndefined()
  })

  it('settles a stopped attempt as cancelled and tears the fixture process group down', { timeout: 60_000 }, async () => {
    const harness = await makeHarness({ requirement: 'hang' })
    const pending = runSupervisedAttempt(depsOf(harness), attemptRequest(harness, 'op-1'))
    const pgidPath = join(harness.config.dshHome, 'last-pgid')
    await expect.poll(async () => readFile(pgidPath, 'utf8').then(() => true, () => false), { timeout: 20_000 }).toBe(true)
    const pgid = Number(await readFile(pgidPath, 'utf8'))
    const revision = harness.controller.projection.revision
    await harness.controller.stop({
      taskId: SelfDevTaskId(TASK_ID),
      expectedRevision: revision,
      operationId: SelfDevOperationId('stop-op'),
      reason: 'cancelled',
    })
    await expect(pending).rejects.toMatchObject({ code: 'SELF_DEV_ATTEMPT_CANCELLED' })
    await expect.poll(() => groupGone(pgid), { timeout: 20_000 }).toBe(true)
    const evidence = await readAttemptEvidence(harness.config.evidenceRoot, TASK_ID, await firstAttemptId(harness))
    expect(evidence?.outcome?.committed).toBe('cancelled')
    expect(evidence?.evidence.result.cancelled).toBe(true)
    expect(harness.controller.projection.status).toBe('stopped')
  })

  it('replays a retry of the same operation without launching the executor again', { timeout: 60_000 }, async () => {
    const harness = await makeHarness({ requirement: 'fail' })
    await runFailingAttempt(harness, 'op-1', 'SELF_DEV_INVALID_RESULT')
    expect(await launchCount(harness)).toBe(1)
    const second = await runSupervisedAttempt(depsOf(harness), attemptRequest(harness, 'op-1'))
    expect(second.operation.replayed).toBe(true)
    expect(second.attemptId).toBeUndefined()
    expect(second.evidencePath).toBeUndefined()
    expect(second.outcomeWriteError).toBeUndefined()
    expect(await launchCount(harness)).toBe(1)
  })

  it.each([
    ['worktreeReal', (record: LaunchRecord): LaunchRecord => ({ ...record, worktreeReal: join(record.worktreeReal, 'elsewhere') })],
    ['acceptancePath', (record: LaunchRecord): LaunchRecord => ({ ...record, acceptancePath: `${record.acceptancePath}.other` })],
    ['acceptanceDefinitionDigest', (record: LaunchRecord): LaunchRecord => ({ ...record, acceptanceDefinitionDigest: 'f'.repeat(64) })],
    ['testPlanDigest', (record: LaunchRecord): LaunchRecord => ({ ...record, testPlanDigest: 'f'.repeat(64) })],
    ['artifactPaths', (record: LaunchRecord): LaunchRecord => ({ ...record, artifactPaths: ['other.txt'] })],
    ['sourceDigest', (record: LaunchRecord): LaunchRecord => ({ ...record, sourceDigest: 'f'.repeat(64) })],
    ['artifactDigest', (record: LaunchRecord): LaunchRecord => ({ ...record, artifactDigest: 'f'.repeat(64) })],
  ])('refuses a launch whose recorded %s no longer matches', { timeout: 120_000 }, async (_field, mutate) => {
    const harness = await makeHarness({ requirement: 'dev' })
    await seedLaunchRecord(harness, 'op-1', mutate)
    await writeFile(join(harness.worktree, 'marker.txt'), 'TAMPERED')
    const revisionBefore = harness.controller.projection.revision
    await expect(runSupervisedAttempt(depsOf(harness), attemptRequest(harness, 'op-1')))
      .rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_LAUNCH_MISMATCH' })
    expect(harness.controller.projection.revision).toBe(revisionBefore)
  })

  it('refuses a confirmation that binds a different artifact set', { timeout: 60_000 }, async () => {
    const harness = await makeHarness()
    const revisionBefore = harness.controller.projection.revision
    const request = attemptRequest(harness, 'op-1', { presence: presenceFor(harness, { artifactPaths: ['other.txt'] }) })
    await expect(runSupervisedAttempt(depsOf(harness), request)).rejects.toMatchObject({
      code: 'SELF_DEV_RUNNER_PRESENCE_MISMATCH',
    })
    expect(harness.controller.projection.revision).toBe(revisionBefore)
    await expect(readdir(join(harness.config.evidenceRoot, 'tasks'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails an attempt whose evidence cannot be written, without passing the task', { timeout: 60_000 }, async () => {
    const harness = await makeHarness({ requirement: 'dev' })
    await seedLaunchRecord(harness, 'op-1')
    const taskDir = join(harness.config.evidenceRoot, 'tasks', TASK_ID)
    await chmod(taskDir, 0o500)
    try {
      const revisionBefore = harness.controller.projection.revision
      await expect(runSupervisedAttempt(depsOf(harness), attemptRequest(harness, 'op-1')))
        .rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
      expect(harness.controller.projection.status).toBe('ready')
      expect(harness.controller.projection.consumedRounds).toBe(1)
      expect(harness.controller.projection.revision).toBe(revisionBefore + 2)
      expect(await readdir(taskDir)).toEqual(['launches'])
    } finally {
      await chmod(taskDir, 0o700)
    }
    const failed = (await journalRecords(harness)).find(record => record.event.type === 'task/passed')
    expect(failed).toBeUndefined()
  })

  it('refuses a launch whose expected revision no longer matches the projection', { timeout: 60_000 }, async () => {
    const harness = await makeHarness()
    const request = attemptRequest(harness, 'op-1', { expectedRevision: harness.controller.projection.revision + 1 })
    await expect(runSupervisedAttempt(depsOf(harness), request)).rejects.toBeInstanceOf(SelfDevelopmentError)
    await expect(runSupervisedAttempt(depsOf(harness), request)).rejects.toMatchObject({
      code: 'SELF_DEV_REVISION_CONFLICT',
    })
    await expect(readdir(join(harness.config.evidenceRoot, 'tasks'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

/** A projection with one field replaced, for studying the preflight's defensive refusals. */
function projectionOf(harness: Harness, overrides: Partial<TaskProjection>): TaskProjection {
  return { ...harness.controller.projection, ...overrides }
}

/** A controller double whose startAttempt behavior a unit test owns. */
function fakeController(
  projection: TaskProjection,
  startAttempt: (request: Parameters<SelfDevelopmentTaskController['startAttempt']>[0]) => Promise<TaskOperationResult>,
): SelfDevelopmentTaskController {
  return { projection, startAttempt } as unknown as SelfDevelopmentTaskController
}

/** The attempt id the outcome-directory trick pre-blocks. */
const UNIT_ATTEMPT_ID = createHash('sha256').update('unit-attempt').digest('hex')

/** An attempt the core would have committed, built from the harness's real launch digests. */
async function fakeAttempt(harness: Harness): Promise<Attempt> {
  const worktreeReal = await resolveExperimentWorktree(harness.config.experimentsRoot, harness.worktree)
  return {
    attemptId: SelfDevAttemptId(UNIT_ATTEMPT_ID),
    attemptNumber: 1,
    startedAt: harness.clock.observe(),
    testPlanDigest: harness.testPlanDigest as Attempt['testPlanDigest'],
    sourceDigest: await sourceDigestOf(worktreeReal),
    artifactDigest: await artifactDigestOf(worktreeReal, ['marker.txt']),
    capabilityDigest: SelfDevAttemptId(UNIT_ATTEMPT_ID) as unknown as Attempt['capabilityDigest'],
    capabilitySource: 'human-presence',
  }
}

/** The evidence directory of the harness's task. */
function attemptsDir(harness: Harness): string {
  return join(harness.config.evidenceRoot, 'tasks', TASK_ID, 'attempts')
}

describe('supervised attempt refusals', () => {
  it.each([
    ['spec', { spec: undefined }],
    ['plan', { plan: undefined }],
    ['approval', { approval: undefined }],
  ] as const)('refuses a ready projection without a %s before any digest is computed', { timeout: 60_000 },
    async (_input, overrides) => {
      const harness = await makeHarness()
      const controller = fakeController(projectionOf(harness, overrides), async () => {
        throw new Error('the side effect must never be reached')
      })
      await expect(runSupervisedAttempt({ ...depsOf(harness), controller }, attemptRequest(harness, 'op-1')))
        .rejects.toMatchObject({ code: 'SELF_DEV_INVALID_STATE' })
      await expect(readdir(join(harness.config.evidenceRoot, 'tasks'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

  it('skips the outcome file when the core rejects before running the side effect', { timeout: 60_000 }, async () => {
    const harness = await makeHarness({ requirement: 'fail' })
    const controller = fakeController(harness.controller.projection, async () => {
      throw new SelfDevelopmentError('the round budget is exhausted', 'SELF_DEV_BUDGET_EXHAUSTED')
    })
    await expect(runSupervisedAttempt({ ...depsOf(harness), controller }, attemptRequest(harness, 'op-1')))
      .rejects.toMatchObject({ code: 'SELF_DEV_BUDGET_EXHAUSTED' })
    await expect(readdir(attemptsDir(harness))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records an outcome write failure without changing a committed result', { timeout: 60_000 }, async () => {
    const harness = await makeHarness({ requirement: 'fail' })
    const attempt = await fakeAttempt(harness)
    await mkdir(join(attemptsDir(harness), `${UNIT_ATTEMPT_ID}.outcome.json`), { recursive: true })
    const controller = fakeController(harness.controller.projection, async (request) => {
      await request.sideEffect(attempt, new AbortController().signal)
      return { revision: 7, replayed: false }
    })
    const outcome = await runSupervisedAttempt({ ...depsOf(harness), controller }, attemptRequest(harness, 'op-1'))
    expect(outcome.operation.revision).toBe(7)
    expect(outcome.attemptId).toBe(UNIT_ATTEMPT_ID)
    expect(outcome.evidencePath).toBeDefined()
    expect(outcome.outcomeWriteError).toMatchObject({ code: 'SELF_DEV_RUNNER_EVIDENCE_FAILED' })
    await rmdir(join(attemptsDir(harness), `${UNIT_ATTEMPT_ID}.outcome.json`))
    const evidence = await readAttemptEvidence(harness.config.evidenceRoot, TASK_ID, UNIT_ATTEMPT_ID)
    expect(evidence?.outcome).toBeUndefined()
  })

  it('records a late decision and swallows an outcome write failure on an already rejected attempt', { timeout: 60_000 }, async () => {
    const harness = await makeHarness({ requirement: 'fail' })
    const attempt = await fakeAttempt(harness)
    await mkdir(join(attemptsDir(harness), `${UNIT_ATTEMPT_ID}.outcome.json`), { recursive: true })
    const controller = fakeController(harness.controller.projection, async (request) => {
      await request.sideEffect(attempt, new AbortController().signal)
      throw new SelfDevelopmentError('the result arrived after the time budget deadline', 'SELF_DEV_LATE_RESULT')
    })
    await expect(runSupervisedAttempt({ ...depsOf(harness), controller }, attemptRequest(harness, 'op-1')))
      .rejects.toMatchObject({ code: 'SELF_DEV_LATE_RESULT' })
    await rmdir(join(attemptsDir(harness), `${UNIT_ATTEMPT_ID}.outcome.json`))
    const evidence = await readAttemptEvidence(harness.config.evidenceRoot, TASK_ID, UNIT_ATTEMPT_ID)
    expect(evidence?.outcome).toBeUndefined()
  })

  it('records a failed decision for a rejection no boundary code classifies', { timeout: 60_000 }, async () => {
    const harness = await makeHarness({ requirement: 'fail' })
    const attempt = await fakeAttempt(harness)
    const controller = fakeController(harness.controller.projection, async (request) => {
      await request.sideEffect(attempt, new AbortController().signal)
      throw new Error('boom')
    })
    await expect(runSupervisedAttempt({ ...depsOf(harness), controller }, attemptRequest(harness, 'op-1')))
      .rejects.toMatchObject({ message: 'boom' })
    const evidence = await readAttemptEvidence(harness.config.evidenceRoot, TASK_ID, UNIT_ATTEMPT_ID)
    expect(evidence?.outcome).toMatchObject({ committed: 'failed', error: { code: 'Error', message: 'boom' } })
  })

  it('records an unknown code for a thrown value that is not an error', { timeout: 60_000 }, async () => {
    const harness = await makeHarness({ requirement: 'fail' })
    const attempt = await fakeAttempt(harness)
    const controller = fakeController(harness.controller.projection, async (request) => {
      await request.sideEffect(attempt, new AbortController().signal)
      throw 'boom'
    })
    await expect(runSupervisedAttempt({ ...depsOf(harness), controller }, attemptRequest(harness, 'op-1')))
      .rejects.toBe('boom')
    const evidence = await readAttemptEvidence(harness.config.evidenceRoot, TASK_ID, UNIT_ATTEMPT_ID)
    expect(evidence?.outcome).toMatchObject({ committed: 'failed', error: { code: 'UNKNOWN', message: 'boom' } })
  })
})

describe('spent-budget execution', () => {
  it('assembles a timed-out failure that fails every required assertion and never runs acceptance', () => {
    const executed = spentBudgetExecution({
      taskId: TASK_ID,
      attempt: {
        attemptId: 'a'.repeat(64),
        sourceDigest: 'b'.repeat(64),
        artifactDigest: 'c'.repeat(64),
        testPlanDigest: 'd'.repeat(64),
      },
      plan: { ...PLAN_INPUT, digest: 'e'.repeat(64) } as unknown as FrozenTestPlan,
      acceptanceDefinitionDigest: 'f'.repeat(64),
      executor: {
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        stepsUsed: 0,
        stepCapHit: false,
        stdoutCapHit: false,
        durationMs: 0,
        sessionId: undefined,
        finalText: '',
        stderrTail: '',
        stdoutTruncated: false,
      },
      phases: [{ phaseId: 'develop', durationMs: 0 }],
    })
    expect(executed.result).toMatchObject({
      taskId: TASK_ID,
      exitCode: 1,
      signal: null,
      timedOut: true,
      cancelled: false,
      stepsUsed: 0,
    })
    expect(executed.result.testedSourceDigest).toBe('b'.repeat(64))
    expect(executed.cases).toEqual([{
      caseId: 'build',
      assertions: [
        { assertionId: 'a1', status: 'fail' },
        { assertionId: 'a2', status: 'fail' },
      ],
    }])
    expect(executed.phases).toEqual([{ phaseId: 'develop', durationMs: 0 }])
    expect(executed.contentStable).toBe(false)
    expect(executed.afterAcceptance).toBeUndefined()
    expect(executed.acceptance).toBeUndefined()
  })
})
