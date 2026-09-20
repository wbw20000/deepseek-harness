/**
 * Service boundary behavior: boot-time config validation for the supervised
 * runner's absolute-path, evidence-placement, and kill-grace rules, the
 * Loader composition smoke for the opt-in service lifecycle, and the runner's
 * own lifecycle: the singleton clock, active-task ownership, the concurrent
 * attempt refusal, and the stop that finishes owned work.
 * @module service.spec
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import {
  SelfDevOperationId,
  SelfDevTaskId,
  SelfDevelopmentTasks,
  TestPlanVersion,
  TaskSpecVersion,
} from '@deepseek-ai/dsh-workflow-self-development'
import type { BudgetApproval, SelfDevelopmentTaskController } from '@deepseek-ai/dsh-workflow-self-development'
import SelfDevelopmentRunner from '../src/index.ts'
import { HostClock } from '../src/clock.ts'
import { DEFAULT_SANDBOX_CONFIG } from '../src/sandbox.ts'
import type { PresenceConfirmation } from '../src/presence.ts'
import type { RunnerConfig, SandboxConfig } from '../src/types.ts'

const execFileAsync = promisify(execFile)
const fakeDsh = fileURLToPath(new URL('./fixtures/fake-dsh-attempt.mjs', import.meta.url))
const fakeCase = fileURLToPath(new URL('./fixtures/fake-case.mjs', import.meta.url))

const TASK_ID = 'task-e3-service'
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

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Build a valid runner config rooted at a fresh temporary directory pair. */
async function makeConfig(overrides: Partial<RunnerConfig> = {}): Promise<RunnerConfig> {
  const base = await mkdtemp(join(tmpdir(), 'self-dev-runner-'))
  root = base
  return {
    nodeBinary: join(base, 'node'),
    dshBin: join(base, 'apps', 'cli', 'lib', 'bin.js'),
    dshHome: join(base, 'home'),
    experimentsRoot: join(base, 'experiments'),
    evidenceRoot: join(base, 'evidence'),
    killGraceMs: 1000,
    ...overrides,
  }
}

describe('boot-time config validation', () => {
  it.each([
    ['nodeBinary'],
    ['dshBin'],
    ['dshHome'],
    ['experimentsRoot'],
    ['evidenceRoot'],
  ] as const)('refuses a relative %s at construction', async (field) => {
    const config = await makeConfig({ [field]: 'relative/path' })
    const rejected = () => new SelfDevelopmentRunner(new Context(), config)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it.each([
    ['nodeBinary'],
    ['dshBin'],
    ['dshHome'],
    ['experimentsRoot'],
    ['evidenceRoot'],
  ] as const)('refuses an empty %s at construction', async (field) => {
    const config = await makeConfig({ [field]: '' })
    const rejected = () => new SelfDevelopmentRunner(new Context(), config)
    expect(rejected).toThrow(/must be an absolute path/)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it.each([
    ['nodeBinary'],
    ['dshBin'],
    ['dshHome'],
    ['experimentsRoot'],
    ['evidenceRoot'],
    ['killGraceMs'],
  ] as const)('refuses a missing %s at construction', async (field) => {
    // Bypass the Config schema the way a hand-built config object would.
    const full = await makeConfig()
    const partial = Object.fromEntries(Object.entries(full).filter(([key]) => key !== field))
    const config = partial as unknown as RunnerConfig
    const rejected = () => new SelfDevelopmentRunner(new Context(), config)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it('refuses an evidenceRoot equal to experimentsRoot', async () => {
    const config = await makeConfig()
    const rejected = () => new SelfDevelopmentRunner(new Context(), { ...config, evidenceRoot: config.experimentsRoot })
    expect(rejected).toThrow(/evidenceRoot/)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it('refuses an evidenceRoot inside experimentsRoot', async () => {
    const config = await makeConfig()
    const rejected = () => new SelfDevelopmentRunner(new Context(), { ...config, evidenceRoot: join(config.experimentsRoot, 'evidence') })
    expect(rejected).toThrow(/evidenceRoot/)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it('refuses an evidence directory inside a two-dot-prefixed child name', async () => {
    const config = await makeConfig()
    const rejected = () => new SelfDevelopmentRunner(new Context(), { ...config, evidenceRoot: join(config.experimentsRoot, '..records') })
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it.each([
    ['zero grace', 0],
    ['negative grace', -1],
    ['fractional grace', 2.5],
    ['infinite grace', Number.POSITIVE_INFINITY],
    ['NaN grace', Number.NaN],
  ])('refuses %s', async (_name, killGraceMs) => {
    const config = await makeConfig({ killGraceMs })
    const rejected = () => new SelfDevelopmentRunner(new Context(), config)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it.each([
    ['sandboxExec', { sandboxExec: 'relative/sandbox-exec' }],
    ['denyReadRoots', { denyReadRoots: ['relative-root'] }],
    ['extraWritableRoots', { extraWritableRoots: ['relative-root'] }],
  ] as const)('refuses a relative sandbox.%s entry at construction', async (_field, sandboxOverride) => {
    const config = await makeConfig({ sandbox: { ...DEFAULT_SANDBOX_CONFIG, ...sandboxOverride } })
    const rejected = () => new SelfDevelopmentRunner(new Context(), config)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })
})

describe('sandbox config defaults', () => {
  it('defaults an entirely omitted sandbox field to DEFAULT_SANDBOX_CONFIG through the Cordis schema', async () => {
    const config = await makeConfig()
    expect('sandbox' in config).toBe(false)
    const parsed = SelfDevelopmentRunner.Config(config)
    expect(parsed.sandbox).toEqual(DEFAULT_SANDBOX_CONFIG)
  })

  it('fills in every missing sandbox sub-field when the deployment configures only some', async () => {
    // Deliberately incomplete: the schema (not this test) supplies the rest,
    // which is exactly what this case checks.
    const config = await makeConfig({ sandbox: { enabled: false } as SandboxConfig })
    const parsed = SelfDevelopmentRunner.Config(config)
    expect(parsed.sandbox).toEqual({ ...DEFAULT_SANDBOX_CONFIG, enabled: false })
  })

  it('keeps every explicitly configured sandbox field as given', async () => {
    const explicit = { enabled: true, denyReadRoots: ['/deny'], extraWritableRoots: ['/extra'], sandboxExec: '/opt/sandbox-exec' }
    const config = await makeConfig({ sandbox: explicit })
    const parsed = SelfDevelopmentRunner.Config(config)
    expect(parsed.sandbox).toEqual(explicit)
  })

  it('constructs successfully with the schema-parsed default sandbox (sandboxing on by default)', async () => {
    const config = await makeConfig()
    const parsed = SelfDevelopmentRunner.Config(config)
    context = new Context()
    const service = new SelfDevelopmentRunner(context, parsed)
    expect(service.name).toBe('selfDevelopmentRunner')
  })
})

describe('service lifecycle', () => {
  it('mounts with a valid config and registers ctx.selfDevelopmentRunner', async () => {
    const config = await makeConfig()
    context = new Context()
    const service = new SelfDevelopmentRunner(context, config)
    expect(context.selfDevelopmentRunner).toBeInstanceOf(SelfDevelopmentRunner)
    expect(service.name).toBe('selfDevelopmentRunner')
  })
})

describe('verifyAcceptance (service method)', () => {
  /** A worktree inside the configured experiments root plus a definition path outside it. */
  async function makeVerifyFixture(config: RunnerConfig): Promise<{ worktree: string; acceptancePath: string }> {
    const worktree = join(config.experimentsRoot, 'wt')
    await mkdir(worktree, { recursive: true })
    return { worktree, acceptancePath: join(config.experimentsRoot, '..', 'acceptance.json') }
  }

  it('runs the definition through the acceptor under the service config, with and without a deadline', async () => {
    const config = await makeConfig({ killGraceMs: 200 })
    context = new Context()
    const service = new SelfDevelopmentRunner(context, config)
    const { worktree, acceptancePath } = await makeVerifyFixture(config)
    await writeFile(acceptancePath, JSON.stringify({
      cases: [{
        caseId: 'case-pass',
        command: ['node', fakeCase, 'exit', '0'],
        timeoutMs: 5000,
        assertions: [{ assertionId: 'case-pass-exit', kind: 'exit-code', expected: 0 }],
      }],
    }))
    const bare = await service.verifyAcceptance(worktree, acceptancePath)
    expect(bare.ok).toBe(true)
    if (!bare.ok) throw new Error('unreachable')
    expect(bare.report.cases).toEqual([{ caseId: 'case-pass', assertions: [{ assertionId: 'case-pass-exit', status: 'pass' }] }])
    const bounded = await service.verifyAcceptance(worktree, acceptancePath, { phaseTimeoutMs: 5000 })
    expect(bounded.ok).toBe(true)
  })

  it('hands the service sandbox config to the verify-only path', async () => {
    const config = await makeConfig({
      killGraceMs: 200,
      sandbox: { enabled: false, denyReadRoots: [], extraWritableRoots: [], sandboxExec: '/usr/bin/sandbox-exec' },
    })
    context = new Context()
    const service = new SelfDevelopmentRunner(context, config)
    const { worktree, acceptancePath } = await makeVerifyFixture(config)
    await writeFile(acceptancePath, JSON.stringify({
      cases: [{
        caseId: 'case-pass',
        command: ['node', fakeCase, 'exit', '0'],
        timeoutMs: 5000,
        assertions: [{ assertionId: 'case-pass-exit', kind: 'exit-code', expected: 0 }],
      }],
    }))
    const result = await service.verifyAcceptance(worktree, acceptancePath)
    expect(result.ok).toBe(true)
  })

  it('reports a definition inside the experiments root as ok:false without throwing', async () => {
    const config = await makeConfig({ killGraceMs: 200 })
    context = new Context()
    const service = new SelfDevelopmentRunner(context, config)
    const { worktree } = await makeVerifyFixture(config)
    const insidePath = join(config.experimentsRoot, 'acceptance.json')
    await writeFile(insidePath, JSON.stringify({ cases: [] }))
    const result = await service.verifyAcceptance(worktree, insidePath)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('experiments')
  })
})

describe('Loader composition smoke', () => {
  it('boots the opt-in service from cordis.yml', async () => {
    const config = await makeConfig()
    const configPath = join(config.experimentsRoot, '..', 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-workflow-self-development-runner'",
      '  config:',
      `    nodeBinary: '${config.nodeBinary}'`,
      `    dshBin: '${config.dshBin}'`,
      `    dshHome: '${config.dshHome}'`,
      `    experimentsRoot: '${config.experimentsRoot}'`,
      `    evidenceRoot: '${config.evidenceRoot}'`,
      '    killGraceMs: 1000',
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = `${pathToFileURL(config.experimentsRoot).href}/`
    // The runner declares `inject: ['selfDevelopmentTasks']`; the smoke test
    // stubs that dependency because the task-control package is not mounted.
    context.provide('selfDevelopmentTasks', {} as never)
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier !== '@deepseek-ai/dsh-workflow-self-development-runner') {
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
    expect(context.selfDevelopmentRunner).toBeInstanceOf(SelfDevelopmentRunner)
    await context.fiber.dispose()
    context = undefined
  })
})

/** One end-to-end harness: git worktree, acceptance definition, both services, and a task at ready. */
interface AttemptHarness {
  readonly config: RunnerConfig
  readonly clock: HostClock
  readonly runner: SelfDevelopmentRunner
  readonly controller: SelfDevelopmentTaskController
  readonly taskId: string
  readonly worktree: string
  readonly acceptancePath: string
  readonly acceptanceDefinitionDigest: string
}

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

/** Create the experiment worktree as a real git repository holding one tracked marker file. */
async function makeWorktree(experimentsRoot: string): Promise<string> {
  const worktree = join(experimentsRoot, 'wt')
  await execFileAsync('git', ['init', '-q', '-b', 'main', worktree])
  await writeFile(join(worktree, 'marker.txt'), 'WIP')
  await execFileAsync('git', ['-C', worktree, '-c', 'user.email=e3@example.invalid', '-c', 'user.name=e3', 'add', 'marker.txt'])
  await execFileAsync('git', [
    '-C', worktree, '-c', 'user.email=e3@example.invalid', '-c', 'user.name=e3', 'commit', '-q', '-m', 'baseline',
  ])
  return worktree
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
 * Build the attempt harness: temporary worktree, acceptance definition, both
 * services constructed on one context, and a task driven to ready.
 * @param requirement - the executor task text; the fixture keys its behavior on it.
 */
async function makeAttemptHarness(requirement: string): Promise<AttemptHarness> {
  const base = await mkdtemp(join(tmpdir(), 'self-dev-runner-service-'))
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
  context = new Context()
  const tasks = new SelfDevelopmentTasks(context, {
    controlDirectory: join(base, 'control'),
    maxRecordsPerSegment: 100,
    checkpointInterval: 10,
  })
  const runner = new SelfDevelopmentRunner(context, config)
  const clock = runner.clock()
  const controller = await tasks.open(TASK_ID, clock)
  await driveToReady(controller, requirement)
  return {
    config,
    clock,
    runner,
    controller,
    taskId: TASK_ID,
    worktree,
    acceptancePath,
    acceptanceDefinitionDigest: createHash('sha256').update(definition).digest('hex'),
  }
}

/** A human confirmation binding the harness's current launch facts. */
function presenceFor(harness: AttemptHarness): PresenceConfirmation {
  const plan = harness.controller.projection.plan
  if (plan === undefined) throw new Error('harness task did not reach a confirmed plan')
  return {
    confirmedBy: 'tester',
    confirmedAt: harness.clock.observe(),
    worktree: harness.worktree,
    loopbackAllowlist: [0],
    acknowledgement: 'supervised-not-unattended',
    taskId: harness.taskId,
    testPlanDigest: plan.digest,
    acceptanceDefinitionDigest: harness.acceptanceDefinitionDigest,
    artifactPaths: ['marker.txt'],
  }
}

/** One supervised attempt request against the harness's current revision. */
function attemptRequest(
  harness: AttemptHarness,
  operationId: string,
  overrides: { readonly signal?: AbortSignal } = {},
): Parameters<typeof harness.runner.runAttempt>[0] {
  return {
    taskId: harness.taskId,
    expectedRevision: harness.controller.projection.revision,
    operationId,
    worktree: harness.worktree,
    artifactPaths: ['marker.txt'],
    acceptancePath: harness.acceptancePath,
    presence: presenceFor(harness),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  }
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
async function lastPgid(harness: AttemptHarness): Promise<number> {
  return Number(await readFile(join(harness.config.dshHome, 'last-pgid'), 'utf8'))
}

/** The committed field of the single attempt outcome file the harness has produced so far. */
async function outcomeCommitted(harness: AttemptHarness): Promise<string> {
  const attempts = join(harness.config.evidenceRoot, 'tasks', harness.taskId, 'attempts')
  const files = await readdir(attempts)
  const outcome = files.find(name => name.endsWith('.outcome.json'))
  if (outcome === undefined) throw new Error(`no outcome file in ${JSON.stringify(files)}`)
  return (JSON.parse(await readFile(join(attempts, outcome), 'utf8')) as { committed: string }).committed
}

describe('runner lifecycle', () => {
  it('serves one trusted clock singleton and starts with no active tasks', async () => {
    const config = await makeConfig()
    context = new Context()
    const runner = new SelfDevelopmentRunner(context, config)
    const first = runner.clock()
    expect(first).toBeInstanceOf(HostClock)
    expect(runner.clock()).toBe(first)
    expect(runner.activeTasks()).toEqual([])
  })

  it('stops a ready task that owns no attempt and only commits the core stop', { timeout: 60_000 }, async () => {
    const harness = await makeAttemptHarness('dev')
    const revision = harness.controller.projection.revision
    const result = await harness.runner.stop({ taskId: TASK_ID, expectedRevision: revision, operationId: 'stop-only' })
    expect(result.replayed).toBe(false)
    expect(harness.controller.projection.status).toBe('stopped')
    expect(harness.runner.activeTasks()).toEqual([])
  })

  it('refuses a second attempt for a task it already owns and finishes the first through stop', { timeout: 60_000 }, async () => {
    const harness = await makeAttemptHarness('hang')
    const first = harness.runner.runAttempt(attemptRequest(harness, 'op-1', { signal: new AbortController().signal }))
    await expect.poll(async () => readFile(join(harness.config.dshHome, 'last-pgid'), 'utf8').catch(() => ''), { timeout: 10_000 })
      .not.toBe('')
    const pgid = await lastPgid(harness)
    expect(harness.runner.activeTasks()).toEqual([TASK_ID])

    await expect(harness.runner.runAttempt(attemptRequest(harness, 'op-2')))
      .rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_ATTEMPT_ACTIVE' })
    expect(harness.runner.activeTasks()).toEqual([TASK_ID])

    const revision = harness.controller.projection.revision
    const result = await harness.runner.stop({ taskId: TASK_ID, expectedRevision: revision, operationId: 'stop-1' })
    expect(result.replayed).toBe(false)
    await expect(first).rejects.toMatchObject({ code: 'SELF_DEV_ATTEMPT_CANCELLED' })
    await expect.poll(() => groupGone(pgid), { timeout: 10_000 }).toBe(true)
    expect(harness.runner.activeTasks()).toEqual([])
    expect(await outcomeCommitted(harness)).toBe('cancelled')
  })
})
