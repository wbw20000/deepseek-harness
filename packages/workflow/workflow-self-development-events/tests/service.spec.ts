/**
 * Service behavior through the real task-control service: the mapped event
 * sequence over a full task flow, the bounded recent buffer, subscriber
 * delivery, and the optional local-notification command.
 * @module service.spec
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CapabilityDigest,
  SelfDevOperationId,
  SelfDevTaskId,
  SelfDevelopmentTasks,
} from '@deepseek-ai/dsh-workflow-self-development'
import type { Attempt, SelfDevelopmentTaskController, TrustedClock } from '@deepseek-ai/dsh-workflow-self-development'
import SelfDevelopmentEvents from '../src/index.ts'
import { resolveSelfDevelopmentEventsConfig } from '../src/config.ts'
import type { NotifyOptions } from '../src/notify.ts'
import type { SelfDevelopmentEvent, SelfDevelopmentEventsConfig } from '../src/types.ts'

/** Events observed at the `runNotify` seam, in call order. */
const notifyCalls = vi.hoisted(() => [] as SelfDevelopmentEvent[])

// Wrap the real delivery so every test keeps spawning the real command while
// the spawn seam itself stays observable.
vi.mock('../src/notify.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/notify.ts')>()
  return {
    ...actual,
    runNotify: (event: SelfDevelopmentEvent, command: readonly string[], options?: NotifyOptions) => {
      notifyCalls.push(event)
      return actual.runNotify(event, command, options)
    },
  }
})

/** Fixed 64-hex digests for the attempt launch inputs. */
const SOURCE = 'b'.repeat(64)
const ARTIFACT = 'c'.repeat(64)
const TESTED_SOURCE = 'e'.repeat(64)
const TESTED_ARTIFACT = 'f'.repeat(64)
const ACCEPTANCE_DEFINITION = '9'.repeat(64)

/** Standard TaskSpec wire form. */
const SPEC = {
  taskId: SelfDevTaskId('task-1'),
  version: 1,
  requirement: 'add chat transcript search',
  allowedModificationScope: ['packages/workflow/workflow-self-development/src'],
  stableBaselineDigest: 'a'.repeat(64),
  createdBy: 'user',
} as const

/** Standard frozen-plan wire form. */
const PLAN = {
  testPlanId: 'plan-1',
  version: 1,
  taskSpecVersion: 1,
  requiredCases: [{ caseId: 'c1', requirement: 'search finds a known message', assertionIds: ['a1'] }],
  manualCases: ['manual-review'],
} as const

/** Standard plan-draft wire form. */
const DRAFT = { requiredCases: PLAN.requiredCases, manualCases: PLAN.manualCases } as const

/** Two-round budget wire form so a failing attempt does not end the task. */
const BUDGET_TWO_ROUNDS = {
  mode: 'rounds',
  maxRounds: 2,
  phaseTimeoutMs: 60000,
  maxStepsPerAttempt: 50,
  testPlanVersion: 1,
  taskSpecVersion: 1,
  approvedBy: 'user',
} as const

/** Fake trusted clock advanced explicitly by each test. */
class FakeClock implements TrustedClock {
  #bootId = 'boot-1'
  #monotonicMs = 1000

  /** Read the current observation. */
  observe(): { bootId: string; monotonicMs: number } {
    return { bootId: this.#bootId, monotonicMs: this.#monotonicMs }
  }

  /** Advance the monotonic clock between attempt boundaries. */
  advance(ms: number): void {
    this.#monotonicMs += ms
  }
}

/** Per-test disposable root. */
let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Harness holding the real task-control service and the events service over one control directory. */
interface Harness {
  readonly tasks: SelfDevelopmentTasks
  readonly events: SelfDevelopmentEvents
  readonly control: string
  readonly now: number
}

/**
 * Build the harness; every event observes one fixed instant. `config` may be
 * a plain partial config or a function of the fresh control directory, for
 * configs that need a path inside it.
 */
async function makeHarness(
  config: Partial<SelfDevelopmentEventsConfig> | ((control: string) => Partial<SelfDevelopmentEventsConfig>) = {},
  internals: ConstructorParameters<typeof SelfDevelopmentEvents>[2] = {},
): Promise<Harness> {
  const control = await mkdtemp(join(tmpdir(), 'self-dev-events-svc-'))
  root = control
  context = new Context()
  const now = 1_700_000_000_000
  const tasks = new SelfDevelopmentTasks(context, {
    controlDirectory: join(control, 'control'),
    maxRecordsPerSegment: 64,
    checkpointInterval: 4,
  })
  const resolvedConfig = typeof config === 'function' ? config(control) : config
  const events = new SelfDevelopmentEvents(
    context,
    { recentLimit: 200, ...resolvedConfig },
    { now: () => now, ...internals },
  )
  return { tasks, events, control, now }
}

/** Operation header for the next expected revision. */
function header(
  revision: number,
  operationId: string,
): { taskId: ReturnType<typeof SelfDevTaskId>; expectedRevision: number; operationId: ReturnType<typeof SelfDevOperationId> } {
  return { taskId: SelfDevTaskId('task-1'), expectedRevision: revision, operationId: SelfDevOperationId(operationId) }
}

/** Fully passing verifier result for one attempt. */
function passingResult(attempt: Attempt): Record<string, unknown> {
  return {
    taskId: 'task-1',
    attemptId: attempt.attemptId,
    sourceDigest: attempt.sourceDigest,
    artifactDigest: attempt.artifactDigest,
    testedSourceDigest: TESTED_SOURCE,
    testedArtifactDigest: TESTED_ARTIFACT,
    acceptanceDefinitionDigest: ACCEPTANCE_DEFINITION,
    testPlanDigest: attempt.testPlanDigest,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    phases: [{ phaseId: 'test', durationMs: 1 }],
    stepsUsed: 1,
    cases: [{ caseId: 'c1', assertions: [{ assertionId: 'a1', status: 'pass' }] }],
  }
}

/** Capability evidence covering every required capability. */
const fullCapabilitySource = {
  evidence: () => CAPABILITY_EVIDENCE,
}

/** All capabilities covered, as a real evidence source would report. */
const CAPABILITY_EVIDENCE = [
  { capability: 'supervisor', source: 'machine' as const, digest: CapabilityDigest('d'.repeat(64)) },
  { capability: 'storage-quota', source: 'machine' as const, digest: CapabilityDigest('d'.repeat(64)) },
  { capability: 'sandbox-coverage', source: 'machine' as const, digest: CapabilityDigest('d'.repeat(64)) },
  { capability: 'external-verifier', source: 'machine' as const, digest: CapabilityDigest('d'.repeat(64)) },
] as const

/** Drive the standard task from creation to `ready` status. */
async function driveToReady(controller: SelfDevelopmentTaskController, clock: FakeClock): Promise<void> {
  await controller.createTask({ ...header(0, 'create'), spec: SPEC })
  await controller.authorizePlanning({ ...header(1, 'authorize'), authorizedBy: 'user' })
  await controller.submitPlanDraft({ ...header(2, 'draft'), draft: DRAFT })
  await controller.confirmPlan({ ...header(3, 'confirm'), plan: PLAN })
  await controller.approveBudget({ ...header(4, 'budget'), approval: BUDGET_TWO_ROUNDS })
  clock.advance(1)
}

describe('unified event sequence over the real service', () => {
  it('maps the full task flow: decision, decision, decision, failure, trial, stop', async () => {
    const { tasks, events, now } = await makeHarness()
    const seen: SelfDevelopmentEvent[] = []
    events.subscribe((event) => { seen.push(event) })
    const clock = new FakeClock()
    const controller = await tasks.open('task-1', clock)
    await driveToReady(controller, clock)
    await controller.startAttempt({
      ...header(5, 'attempt-1'), clock, capabilitySource: fullCapabilitySource, sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: () => { throw new Error('runner exited 1') },
    }).catch(() => {})
    clock.advance(1)
    await controller.startAttempt({
      ...header(7, 'attempt-2'), clock, capabilitySource: fullCapabilitySource, sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async attempt => passingResult(attempt),
    })
    await controller.recordTrialApproval({ ...header(9, 'trial'), approvedBy: 'user' })
    await controller.stop({ ...header(10, 'stop') })
    expect(seen).toEqual([
      { taskId: 'task-1', kind: 'awaiting-decision', origin: 'commit', sessionId: undefined, title: 'Plan drafted, awaiting confirmation', occurredAt: now, revision: 3 },
      { taskId: 'task-1', kind: 'awaiting-decision', origin: 'commit', sessionId: undefined, title: 'Plan confirmed, awaiting development approval', occurredAt: now, revision: 4 },
      { taskId: 'task-1', kind: 'awaiting-decision', origin: 'commit', sessionId: undefined, title: 'Budget approved, task ready', occurredAt: now, revision: 5 },
      { taskId: 'task-1', kind: 'failed', origin: 'commit', sessionId: undefined, title: 'Round 1 failed', occurredAt: now, revision: 7 },
      { taskId: 'task-1', kind: 'awaiting-trial', origin: 'commit', sessionId: undefined, title: 'Round 2 passed, awaiting trial', occurredAt: now, revision: 9 },
      { taskId: 'task-1', kind: 'stopped', origin: 'commit', sessionId: undefined, title: 'Task stopped (cancelled)', occurredAt: now, revision: 11 },
    ])
  })
})

describe('recent buffer', () => {
  it('retains only the configured number of events and slices on read', async () => {
    const { tasks, events } = await makeHarness({ recentLimit: 2 })
    const clock = new FakeClock()
    const controller = await tasks.open('task-1', clock)
    await driveToReady(controller, clock)
    expect(events.recent().map(event => event.title)).toEqual([
      'Plan confirmed, awaiting development approval',
      'Budget approved, task ready',
    ])
    expect(events.recent(1).map(event => event.title)).toEqual(['Budget approved, task ready'])
    expect(events.recent(0)).toEqual([])
  })
})

describe('subscribe', () => {
  it('stops delivering after the disposer runs and contains subscriber errors', async () => {
    const { tasks, events } = await makeHarness()
    const warn = vi.spyOn(context!.logger, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    const dispose = events.subscribe((event) => {
      seen.push(event.kind)
      throw new Error('subscriber exploded')
    })
    const clock = new FakeClock()
    const controller = await tasks.open('task-1', clock)
    await controller.createTask({ ...header(0, 'create'), spec: SPEC })
    await controller.authorizePlanning({ ...header(1, 'authorize'), authorizedBy: 'user' })
    await controller.submitPlanDraft({ ...header(2, 'draft'), draft: DRAFT })
    expect(seen).toEqual(['awaiting-decision'])
    dispose()
    await controller.confirmPlan({ ...header(3, 'confirm'), plan: PLAN })
    expect(seen).toEqual(['awaiting-decision'])
    expect(warn).toHaveBeenCalledWith('self-development-events: a subscriber failed for task "%s"', 'task-1')
    expect(controller.projection.status).toBe('awaiting-development-approval')
  })
})

describe('local notification command', () => {
  it('spawns once per mapped event and hands it the sanitized event JSON on stdin', async () => {
    const { tasks, control } = await makeHarness(control => ({
      localNotificationCommand: [process.execPath, new URL('./fixtures/record-stdin.mjs', import.meta.url).pathname, join(control, 'notices.log')],
    }))
    const out = join(control, 'notices.log')
    const clock = new FakeClock()
    const controller = await tasks.open('task-1', clock)
    await driveToReady(controller, clock)
    await vi.waitFor(async () => {
      const text = await readFile(out, 'utf8')
      expect(text.trim().split('\n')).toHaveLength(3)
    })
    const lines = (await readFile(out, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map(line => line.kind)).toEqual(['awaiting-decision', 'awaiting-decision', 'awaiting-decision'])
    for (const line of lines) {
      // JSON serialization drops the `undefined` sessionId: self-development
      // events are not bound to a chat session, so the key is simply absent.
      expect(Object.keys(line).sort()).toEqual(['kind', 'occurredAt', 'origin', 'revision', 'taskId', 'title'])
      expect(JSON.stringify(line)).not.toContain('chat transcript search')
    }
  })

  it('logs a failed delivery and never retries', async () => {
    const { tasks } = await makeHarness({
      localNotificationCommand: [process.execPath, '-e', 'process.exit(3)'],
    })
    const warn = vi.spyOn(context!.logger, 'warn').mockImplementation(() => {})
    const controller = await tasks.open('task-1', new FakeClock())
    await controller.createTask({ ...header(0, 'create'), spec: SPEC })
    await controller.authorizePlanning({ ...header(1, 'authorize'), authorizedBy: 'user' })
    await controller.submitPlanDraft({ ...header(2, 'draft'), draft: DRAFT })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('self-development-events: local notification failed: %s', 'exited with code 3')
    })
  })

  it('honors the injected notification deadline and group stop', async () => {
    const sleeper = new URL('./fixtures/sleeper.mjs', import.meta.url).pathname
    const { tasks } = await makeHarness(
      { localNotificationCommand: [process.execPath, sleeper] },
      { timeoutMs: 100, stopGroup: (pid) => { process.kill(-pid, 'SIGKILL') } },
    )
    const warn = vi.spyOn(context!.logger, 'warn').mockImplementation(() => {})
    const controller = await tasks.open('task-1', new FakeClock())
    await controller.createTask({ ...header(0, 'create'), spec: SPEC })
    await controller.authorizePlanning({ ...header(1, 'authorize'), authorizedBy: 'user' })
    await controller.submitPlanDraft({ ...header(2, 'draft'), draft: DRAFT })
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('self-development-events: local notification failed: %s', 'timed out after 100 ms')
    })
  })

  it('never spawns when no command is configured', async () => {
    notifyCalls.length = 0
    const { tasks } = await makeHarness()
    const clock = new FakeClock()
    const controller = await tasks.open('task-1', clock)
    await driveToReady(controller, clock)
    // Every mapped event was ingested synchronously by the time driveToReady
    // returns, so a configured command would already have been called here.
    expect(notifyCalls).toEqual([])
  })
})

describe('config resolution', () => {
  it('applies the documented defaults once', () => {
    expect(resolveSelfDevelopmentEventsConfig({})).toEqual({ localNotificationCommand: undefined, recentLimit: 200 })
  })

  it('stamps events with the host clock when no internals are injected', async () => {
    const control = await mkdtemp(join(tmpdir(), 'self-dev-events-svc-'))
    root = control
    context = new Context()
    const tasks = new SelfDevelopmentTasks(context, {
      controlDirectory: join(control, 'control'),
      maxRecordsPerSegment: 64,
      checkpointInterval: 4,
    })
    const events = new SelfDevelopmentEvents(context, { recentLimit: 200 })
    const controller = await tasks.open('task-1', new FakeClock())
    await controller.createTask({ ...header(0, 'create'), spec: SPEC })
    await controller.authorizePlanning({ ...header(1, 'authorize'), authorizedBy: 'user' })
    await controller.submitPlanDraft({ ...header(2, 'draft'), draft: DRAFT })
    const [event] = events.recent(1)
    expect(event?.title).toBe('Plan drafted, awaiting confirmation')
    expect(Math.abs((event?.occurredAt ?? 0) - Date.now())).toBeLessThan(5_000)
  })

  it.each([
    ['an empty argv', { localNotificationCommand: [] }],
    ['an argv with an empty part', { localNotificationCommand: ['osascript', ''] }],
    ['a zero recent limit', { recentLimit: 0 }],
    ['a fractional recent limit', { recentLimit: 2.5 }],
  ])('refuses %s at construction', (_name, overrides) => {
    const rejected = () => new SelfDevelopmentEvents(new Context(), { recentLimit: 200, ...overrides })
    expect(rejected).toThrow(/self-development-events/)
  })
})
