/**
 * Controller coverage completions: journal-verification refusals at open,
 * header and payload validation branches, launch refusals, journal fault
 * injection around an attempt launch and settlement, boot-crossing time
 * accounting, and trial-approval validation.
 * @module coverage-controller.spec
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SelfDevelopmentTaskController } from '../src/controller.ts'
import { TaskJournal } from '../src/journal.ts'
import { digestJson, SelfDevTaskId, SelfDevelopmentError, TASK_JOURNAL_SCHEMA_VERSION } from '../src/runtime.ts'
import {
  ARTIFACT,
  BUDGET_ONE_ROUND,
  DRAFT,
  FakeClock,
  PLAN,
  SOURCE,
  SPEC,
  TASK_ID,
  capabilityEvidence,
  fullCapabilitySource,
  header,
  makeTaskDir,
  openReadyTask,
  passingResult,
} from './helpers.ts'
import type { CommittedRecord, TaskEvent } from '../src/types.ts'

/** Two-round budget so a failed attempt leaves the task ready, not stopped. */
const BUDGET_TWO_ROUNDS = { ...BUDGET_ONE_ROUND, maxRounds: 2 }

/** The frozen plan wire form as it is stored inside a `plan/confirmed` event. */
const FROZEN_PLAN = { ...PLAN, digest: digestJson(PLAN) }

/** The attempt identity every hand-built journal event uses. */
const ATTEMPT = {
  attemptId: 'attempt-1',
  attemptNumber: 1,
  startedAt: { bootId: 'boot-1', monotonicMs: 1000 },
  testPlanDigest: FROZEN_PLAN.digest,
  sourceDigest: SOURCE,
  artifactDigest: ARTIFACT,
  capabilityDigest: 'd'.repeat(64),
  capabilitySource: 'machine',
} as const

/** Open a fresh controller on a real empty journal. */
async function openEmptyController(capabilitySource?: Parameters<typeof SelfDevelopmentTaskController.open>[0]['capabilitySource']) {
  const { dir, clock } = await makeTaskDir()
  const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
  const controller = await SelfDevelopmentTaskController.open({ taskId: TASK_ID, journal, clock, capabilitySource })
  return { dir, journal, controller }
}

/** Capture the rejection reason of a promise expected to fail. */
async function rejectionOf(promise: Promise<unknown>): Promise<SelfDevelopmentError> {
  try {
    await promise
  } catch (error) {
    return error as SelfDevelopmentError
  }
  throw new Error('expected the operation to reject')
}

/** Parse the final record of the first journal segment on disk. */
async function lastStoredRecord(dir: string): Promise<{ event: { type: string; reason?: string } }> {
  const text = await readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
  return JSON.parse(text.trim().split('\n').at(-1)!) as { event: { type: string; reason?: string } }
}

/**
 * In-memory journal double for fault injection. The controller consumes the
 * journal only through `read`/`append`/`readProjection`/`writeProjection`, so
 * the double implements exactly that surface; the `JournalReadResult` contract
 * allows a failure detail of `undefined`, which no production journal
 * produces but the controller must still format.
 */
function stubJournal() {
  let seq = 0
  let appendFails = false
  let projectionFails = false
  const stub = {
    read: async () => ({ status: 'ok' as const, records: [] as CommittedRecord[], detail: undefined }),
    append: async (event: TaskEvent, operation: CommittedRecord['operation']) => {
      if (appendFails) throw new SelfDevelopmentError('synthetic append failure', 'SELF_DEV_JOURNAL_UNAVAILABLE')
      seq += 1
      return { schemaVersion: TASK_JOURNAL_SCHEMA_VERSION, seq, prevHash: '', hash: digestJson({ seq }), operation, event } as CommittedRecord
    },
    readProjection: async () => undefined,
    writeProjection: async () => {
      if (projectionFails) {
        projectionFails = false
        throw new Error('synthetic projection write failure')
      }
    },
  }
  return {
    journal: stub as unknown as TaskJournal,
    failAppend: (): void => { appendFails = true },
    failProjectionOnce: (): void => { projectionFails = true },
  }
}

/** Drive a controller on a stub journal to `ready` status. */
async function openReadyOn(journal: TaskJournal) {
  const controller = await SelfDevelopmentTaskController.open({
    taskId: TASK_ID, journal, clock: new FakeClock(), capabilitySource: fullCapabilitySource,
  })
  let revision = 0
  await controller.createTask({ ...header(revision, 'create'), spec: SPEC })
  revision = 1
  await controller.authorizePlanning({ ...header(revision, 'authorize'), authorizedBy: 'user' })
  revision = 2
  await controller.submitPlanDraft({ ...header(revision, 'draft'), draft: DRAFT })
  revision = 3
  await controller.confirmPlan({ ...header(revision, 'confirm'), plan: PLAN })
  revision = 4
  await controller.approveBudget({ ...header(revision, 'budget'), approval: BUDGET_TWO_ROUNDS })
  return { controller, revision: 5 }
}

describe('journal verification at open', () => {
  it('refuses to open a controller over an incomplete-tail journal', async () => {
    const { dir, clock } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
    await journal.append({ type: 'task/planning-authorized', authorizedBy: 'user' }, undefined)
    const segment = join(dir, 'events.00000001.jsonl')
    const text = await readFile(segment, 'utf8')
    await writeFile(segment, text.slice(0, -1))
    const error = await rejectionOf(SelfDevelopmentTaskController.open({ taskId: TASK_ID, journal, clock, capabilitySource: undefined }))
    expect(error.code).toBe('SELF_DEV_JOURNAL_UNAVAILABLE')
    expect(error.message).toContain('task journal is not intact (incomplete-tail)')
    expect(error.message).toContain('does not end with a terminal newline')
  })

  it('reports an unknown reason when the failed journal read carries no detail', async () => {
    // JournalReadResult permits a failure detail of undefined; the controller
    // must still produce a complete rejection message for that contract value.
    const broken = {
      read: async () => ({ status: 'corrupt' as const, records: [] as CommittedRecord[], detail: undefined }),
    }
    const error = await rejectionOf(SelfDevelopmentTaskController.open({
      taskId: TASK_ID, journal: broken as unknown as TaskJournal, clock: new FakeClock(), capabilitySource: undefined,
    }))
    expect(error.code).toBe('SELF_DEV_JOURNAL_UNAVAILABLE')
    expect(error.message).toBe('task journal is not intact (corrupt): unknown reason')
  })
})

describe('typed accessors and header validation', () => {
  it('exposes the committed TaskSpec through the typed accessor', async () => {
    const { controller } = await openEmptyController()
    expect(controller.spec).toBeUndefined()
    await controller.createTask({ ...header(0, 'create'), spec: SPEC })
    expect(controller.spec).toMatchObject({ taskId: TASK_ID, requirement: SPEC.requirement, createdBy: 'user' })
  })

  it('refuses an operation addressed to another task', async () => {
    const { controller } = await openEmptyController()
    const error = await rejectionOf(controller.createTask({
      ...header(0, 'wrong-owner'), taskId: SelfDevTaskId('other-task'), spec: SPEC,
    }))
    expect(error.code).toBe('SELF_DEV_INVALID_OPERATION')
    expect(error.message).toBe('operation addresses task other-task, controller owns task-1')
  })

  it('refuses a second TaskSpec on an existing task', async () => {
    const { controller } = await openEmptyController()
    await controller.createTask({ ...header(0, 'create'), spec: SPEC })
    const error = await rejectionOf(controller.createTask({ ...header(1, 'create-again'), spec: SPEC }))
    expect(error.code).toBe('SELF_DEV_INVALID_STATE')
    expect(error.message).toBe('task already has a TaskSpec')
  })

  it('refuses a TaskSpec whose taskId differs from the operation taskId', async () => {
    const { controller } = await openEmptyController()
    const error = await rejectionOf(controller.createTask({
      ...header(0, 'mismatch'), spec: { ...SPEC, taskId: 'task-2' },
    }))
    expect(error.code).toBe('SELF_DEV_INVALID_OPERATION')
    expect(error.message).toBe('spec taskId does not match the operation taskId')
  })

  it('refuses an empty authorizedBy', async () => {
    const { controller } = await openEmptyController()
    const error = await rejectionOf(controller.authorizePlanning({ ...header(0, 'auth-empty'), authorizedBy: '' }))
    expect(error.code).toBe('SELF_DEV_INVALID_OPERATION')
    expect(error.message).toBe('authorizedBy must be a non-empty string')
  })

  it('refuses a plan confirmation before a TaskSpec exists', async () => {
    const { controller } = await openEmptyController()
    const error = await rejectionOf(controller.confirmPlan({ ...header(0, 'confirm-early'), plan: PLAN }))
    expect(error.code).toBe('SELF_DEV_INVALID_STATE')
    expect(error.message).toBe('plan confirmation requires a TaskSpec')
  })

  it('refuses a budget approval before a TaskSpec exists', async () => {
    const { controller } = await openEmptyController()
    const error = await rejectionOf(controller.approveBudget({ ...header(0, 'budget-early'), approval: BUDGET_TWO_ROUNDS }))
    expect(error.code).toBe('SELF_DEV_INVALID_STATE')
    expect(error.message).toBe('budget approval requires a TaskSpec and a frozen plan')
  })

  it('refuses a budget approval with a TaskSpec but no frozen plan', async () => {
    const { controller } = await openEmptyController()
    await controller.createTask({ ...header(0, 'create'), spec: SPEC })
    const error = await rejectionOf(controller.approveBudget({ ...header(1, 'budget-noplan'), approval: BUDGET_TWO_ROUNDS }))
    expect(error.code).toBe('SELF_DEV_INVALID_STATE')
    expect(error.message).toBe('budget approval requires a TaskSpec and a frozen plan')
  })
})

describe('launch refusals', () => {
  it('refuses a launch whose capability evidence misses a required capability', async () => {
    const { dir, clock } = await makeTaskDir()
    const partialSource = {
      evidence: () => capabilityEvidence.filter(item => item.capability !== 'external-verifier'),
    }
    const { controller, revision } = await openReadyTask(dir, clock, BUDGET_TWO_ROUNDS, partialSource)
    const error = await rejectionOf(controller.startAttempt({
      ...header(revision, 'attempt-missing-cap'), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async () => { throw new Error('side effect must never run') },
    }))
    expect(error.code).toBe('SELF_DEV_CAPABILITY_MISSING')
    expect(error.message).toBe('capability evidence missing for: external-verifier')
    expect(controller.projection.consumedRounds).toBe(0)
    expect(controller.projection.status).toBe('ready')
  })

  it('refuses a launch while the remaining time budget is frozen after an interrupted attempt', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
    // Rebuild the durable state of a crash between the uncertain attempt/failed
    // commit and its handoff/raised commit: ready, round consumed, budget frozen.
    const events = [
      { type: 'task/created', spec: SPEC },
      { type: 'task/planning-authorized', authorizedBy: 'user' },
      { type: 'plan/drafted', draft: DRAFT },
      { type: 'plan/confirmed', plan: FROZEN_PLAN },
      { type: 'budget/approved', approval: BUDGET_TWO_ROUNDS },
      { type: 'attempt/started', attempt: ATTEMPT },
      {
        type: 'attempt/failed', attemptId: ATTEMPT.attemptId, reason: 'host restarted',
        failureDigest: digestJson('host restarted'), elapsedMs: 0, timeAccounting: 'uncertain',
      },
    ] as unknown as TaskEvent[]
    for (const event of events) await journal.append(event, undefined)
    const controller = await SelfDevelopmentTaskController.open({
      taskId: TASK_ID, journal, clock: new FakeClock(), capabilitySource: fullCapabilitySource,
    })
    expect(controller.projection.status).toBe('ready')
    expect(controller.projection.timeBudgetFrozen).toBe(true)
    expect(controller.projection.consumedRounds).toBe(1)
    const error = await rejectionOf(controller.startAttempt({
      ...header(controller.projection.revision, 'attempt-frozen'), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async () => { throw new Error('side effect must never run') },
    }))
    expect(error.code).toBe('SELF_DEV_BUDGET_EXHAUSTED')
    expect(error.message).toBe('attempt launch refused: remaining time budget is frozen pending human review')
    expect(controller.projection.consumedRounds).toBe(1)
  })

  it('refuses a launch when the durable state is ready without a frozen plan', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
    // A journal-only path to `ready`: a budget-exhausted stop folded from
    // `draft`, then a budget approval. The fold accepts it, so the launch
    // must refuse instead of binding an attempt to a missing plan.
    const events = [
      { type: 'task/created', spec: SPEC },
      { type: 'task/stopped', reason: 'budget-exhausted' },
      { type: 'budget/approved', approval: BUDGET_TWO_ROUNDS },
    ] as unknown as TaskEvent[]
    for (const event of events) await journal.append(event, undefined)
    const controller = await SelfDevelopmentTaskController.open({
      taskId: TASK_ID, journal, clock: new FakeClock(), capabilitySource: fullCapabilitySource,
    })
    expect(controller.projection.status).toBe('ready')
    expect(controller.plan).toBeUndefined()
    const error = await rejectionOf(controller.startAttempt({
      ...header(controller.projection.revision, 'attempt-noplan'), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async () => { throw new Error('side effect must never run') },
    }))
    expect(error.code).toBe('SELF_DEV_INVALID_STATE')
    expect(error.message).toBe('frozen plan is missing')
    expect(controller.projection.consumedRounds).toBe(0)
  })
})

describe('journal faults during an attempt', () => {
  it('cleans up the launch and refuses every later operation when the start commit fails', async () => {
    const { journal, failAppend } = stubJournal()
    const { controller, revision } = await openReadyOn(journal)
    failAppend()
    const error = await rejectionOf(controller.startAttempt({
      ...header(revision, 'attempt-disk'), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async () => { throw new Error('side effect must never run') },
    }))
    expect(error.code).toBe('SELF_DEV_JOURNAL_UNAVAILABLE')
    expect(error.message).toBe('synthetic append failure')
    expect(controller.projection.status).toBe('ready')
    expect(controller.projection.consumedRounds).toBe(0)
    const refused = await rejectionOf(controller.stop({ ...header(controller.projection.revision, 'stop-after'), reason: 'cancelled' }))
    expect(refused.code).toBe('SELF_DEV_JOURNAL_UNAVAILABLE')
    expect(refused.message).toContain('the task refuses every')
  })

  it('keeps a committed pass diagnostic-consistent when the projection write fails', async () => {
    const { journal, failProjectionOnce } = stubJournal()
    const { controller, revision } = await openReadyOn(journal)
    failProjectionOnce()
    const error = await rejectionOf(controller.startAttempt({
      ...header(revision, 'attempt-projection'), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async attempt => passingResult(attempt),
    }))
    expect(error.message).toBe('synthetic projection write failure')
    // The pass committed durably before the projection write failed, and the
    // late-failure path recorded no second attempt outcome for it.
    expect(controller.projection.status).toBe('awaiting-trial')
    expect(controller.projection.verifiedResultDigest).toBeDefined()
    expect(controller.projection.currentAttempt).toBeUndefined()
  })
})

describe('attempt settlement', () => {
  it('rethrows a SelfDevelopmentError from the side effect unchanged and records its message as the failure reason', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, BUDGET_TWO_ROUNDS, fullCapabilitySource)
    const failure = new SelfDevelopmentError('verifier rejected the artifact', 'SELF_DEV_INVALID_RESULT')
    const rejection = controller.startAttempt({
      ...header(revision, 'attempt-selfdev'), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async () => { throw failure },
    })
    const error = await rejectionOf(rejection)
    expect(error).toBe(failure)
    expect(controller.projection.status).toBe('ready')
    expect(controller.projection.consumedRounds).toBe(1)
    const stored = await lastStoredRecord(dir)
    expect(stored.event.type).toBe('attempt/failed')
    expect(stored.event.reason).toBe('verifier rejected the artifact')
  })

  it('wraps a non-Error rejection in SELF_DEV_INVALID_RESULT and records its string form', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, BUDGET_TWO_ROUNDS, fullCapabilitySource)
    const rejection = controller.startAttempt({
      ...header(revision, 'attempt-nonerror'), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async () => { throw 'boom' },
    })
    const error = await rejectionOf(rejection)
    expect(error.code).toBe('SELF_DEV_INVALID_RESULT')
    expect(error.message).toContain('failed: boom')
    expect(controller.projection.status).toBe('ready')
    const stored = await lastStoredRecord(dir)
    expect(stored.event.type).toBe('attempt/failed')
    expect(stored.event.reason).toBe('boom')
  })

  it('raises a clock-uncertain handoff when a failed attempt spanned a boot session', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, BUDGET_TWO_ROUNDS, fullCapabilitySource)
    const rejection = controller.startAttempt({
      ...header(revision, 'attempt-reboot-fail'), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async () => {
        clock.reboot()
        throw new Error('runner crashed mid-round')
      },
    })
    const error = await rejectionOf(rejection)
    expect(error.code).toBe('SELF_DEV_INVALID_RESULT')
    expect(controller.projection.status).toBe('handoff')
    expect(controller.projection.handoffReason).toBe('clock-uncertain')
    expect(controller.projection.handoffDetail).toContain('spanned a boot session')
    expect(controller.projection.timeBudgetFrozen).toBe(true)
    expect(controller.projection.consumedTimeMs).toBe(0)
  })

  it('raises a clock-uncertain handoff after recording a pass whose attempt spanned a boot session', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, BUDGET_TWO_ROUNDS, fullCapabilitySource)
    await controller.startAttempt({
      ...header(revision, 'attempt-reboot-pass'), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async (attempt) => {
        clock.reboot()
        return passingResult(attempt)
      },
    })
    expect(controller.projection.status).toBe('handoff')
    expect(controller.projection.handoffReason).toBe('clock-uncertain')
    expect(controller.projection.verifiedResultDigest).toBeDefined()
    expect(controller.projection.timeBudgetFrozen).toBe(true)
  })
})

describe('trial approval validation', () => {
  it('refuses an empty approvedBy', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    const error = await rejectionOf(controller.recordTrialApproval({ ...header(revision, 'trial-empty'), approvedBy: '' }))
    expect(error.code).toBe('SELF_DEV_INVALID_OPERATION')
    expect(error.message).toBe('approvedBy must be a non-empty string')
  })

  it('refuses a trial approval when no verified result is waiting', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    const error = await rejectionOf(controller.recordTrialApproval({ ...header(revision, 'trial-early'), approvedBy: 'user' }))
    expect(error.code).toBe('SELF_DEV_INVALID_STATE')
    expect(error.message).toBe('no verified result is waiting for trial')
    expect(controller.projection.trialApproval).toBeUndefined()
  })
})
