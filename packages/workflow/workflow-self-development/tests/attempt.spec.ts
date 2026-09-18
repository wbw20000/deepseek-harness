/**
 * Attempt behavior: the durable start commit precedes every side effect, the
 * first failed build consumes the round, time and rounds are first-bound-wins,
 * late and misidentified results never pass, and incomplete runs never pass.
 * @module attempt.spec
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUDGET_ONE_ROUND, SOURCE, ARTIFACT, fullCapabilitySource, header, makeTaskDir, openReadyTask, passingResult, resultWith } from './helpers.ts'
import type { Attempt } from '../src/types.ts'

/** Last journal record parsed from disk. */
interface StoredRecord { event: { type: string; attempt?: Attempt } }
import { TaskSpecVersion, TestPlanDigest, TestPlanVersion, digestJson } from '../src/runtime.ts'
import { foldEvent, initialFoldState } from '../src/domain.ts'

/** Parse the final record of one journal segment. */
function lastRecord(text: string): StoredRecord {
  return JSON.parse(text.trim().split('\n').at(-1)!) as StoredRecord
}

describe('attempt lifecycle', () => {
  it('commits attempt/started durably before running the requested side effect', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, BUDGET_ONE_ROUND, fullCapabilitySource)
    let journalLine = ''
    await controller.startAttempt({
      ...header(revision, 'attempt-order'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async () => {
        journalLine = await readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
        return passingResult(lastRecord(journalLine).event.attempt!)
      },
    })
    const started = lastRecord(journalLine)
    expect(started.event.type).toBe('attempt/started')
    expect(controller.projection.status).toBe('awaiting-trial')
  })

  it('consumes the only round on a first failed build and stops', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, BUDGET_ONE_ROUND, fullCapabilitySource)
    const rejection = controller.startAttempt({
      ...header(revision, 'attempt-fail'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async () => {
        throw new Error('first build failed')
      },
    })
    await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
    expect(controller.projection.status).toBe('stopped')
    expect(controller.projection.stopReason).toBe('budget-exhausted')
    expect(controller.projection.consumedRounds).toBe(1)
  })

  it('stops with the time reason when the deadline passes first, rejecting the late result', async () => {
    const { dir, clock } = await makeTaskDir()
    const budget = { mode: 'both', maxRounds: 5, durationMs: 1000, phaseTimeoutMs: 500, maxStepsPerAttempt: 10, noProgressAttemptLimit: 5, testPlanVersion: 1, taskSpecVersion: 1, approvedBy: 'user' }
    const { controller, revision } = await openReadyTask(dir, clock, budget, fullCapabilitySource)
    let attemptSeen: Parameters<typeof passingResult>[0] | undefined
    const rejection = controller.startAttempt({
      ...header(revision, 'attempt-late'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async (attempt) => {
        attemptSeen = attempt
        clock.advance(1000)
        return passingResult(attempt)
      },
    })
    await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_LATE_RESULT' })
    expect(controller.projection.status).toBe('stopped')
    expect(controller.projection.stopReason).toBe('budget-exhausted')
    expect(controller.projection.consumedRounds).toBe(1)
    // The passing report is diagnostic only: no verified result was recorded.
    expect(controller.projection.verifiedResultDigest).toBeUndefined()
    void attemptSeen
  })

  it('stops with the rounds reason when the round budget is spent first', async () => {
    const { dir, clock } = await makeTaskDir()
    const budget = { mode: 'both', maxRounds: 1, durationMs: 600000, phaseTimeoutMs: 500, maxStepsPerAttempt: 10, testPlanVersion: 1, taskSpecVersion: 1, approvedBy: 'user' }
    const { controller, revision } = await openReadyTask(dir, clock, budget, fullCapabilitySource)
    const rejection = controller.startAttempt({
      ...header(revision, 'attempt-rounds'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async () => {
        throw new Error('build failed')
      },
    })
    await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
    expect(controller.projection.stopReason).toBe('budget-exhausted')
    expect(controller.projection.consumedTimeMs).toBeLessThan(600000)
  })

  it('stops with the no-progress reason when repeated attempts repeat one failure fingerprint', async () => {
    const { dir, clock } = await makeTaskDir()
    const budget = { ...BUDGET_ONE_ROUND, maxRounds: 3, noProgressAttemptLimit: 2 }
    const { controller, revision } = await openReadyTask(dir, clock, budget, fullCapabilitySource)
    const first = controller.startAttempt({ ...header(revision, 'a1'), sourceDigest: SOURCE, artifactDigest: ARTIFACT, sideEffect: async () => { throw new Error('same failure') } })
    await expect(first).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
    const second = controller.startAttempt({ ...header(controller.projection.revision, 'a2'), sourceDigest: SOURCE, artifactDigest: ARTIFACT, sideEffect: async () => { throw new Error('same failure') } })
    await expect(second).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
    expect(controller.projection.status).toBe('stopped')
    expect(controller.projection.stopReason).toBe('no-progress')
  })
})

describe('result verification', () => {
  it('rejects results bound to another attempt, source, artifact, or plan', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller } = await openReadyTask(dir, clock, { ...BUDGET_ONE_ROUND, maxRounds: 4 }, fullCapabilitySource)
    const cases: readonly [string, (attempt: Parameters<typeof passingResult>[0]) => Record<string, unknown>][] = [
      ['attempt', (attempt: Parameters<typeof passingResult>[0]) => resultWith(attempt, { attemptId: 'other-attempt' })],
      ['source', (attempt: Parameters<typeof passingResult>[0]) => resultWith(attempt, { sourceDigest: 'e'.repeat(64) })],
      ['artifact', (attempt: Parameters<typeof passingResult>[0]) => resultWith(attempt, { artifactDigest: 'f'.repeat(64) })],
      ['plan', (attempt: Parameters<typeof passingResult>[0]) => resultWith(attempt, { testPlanDigest: '1'.repeat(64) })],
    ]
    for (const [index, [label, patch]] of cases.entries()) {
      const rejection = controller.startAttempt({
        ...header(controller.projection.revision, `attempt-${label}`),
        sourceDigest: SOURCE,
        artifactDigest: ARTIFACT,
        sideEffect: async attempt => patch(attempt),
      })
      await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_IDENTITY_MISMATCH' })
      expect(controller.projection.consumedRounds, label).toBe(index + 1)
    }
  })

  it.each([
    ['a zero-case report', { cases: [] }],
    ['a skipped assertion', { cases: [{ caseId: 'c1', assertions: [{ assertionId: 'a1', status: 'skipped' }] }] }],
    ['a missing assertion', { cases: [{ caseId: 'c1', assertions: [] }] }],
    ['a failed assertion', { cases: [{ caseId: 'c1', assertions: [{ assertionId: 'a1', status: 'fail' }] }] }],
    ['a timeout', { timedOut: true }],
    ['a signal', { signal: 'SIGTERM' }],
    ['a cancellation', { cancelled: true }],
    ['a non-zero exit', { exitCode: 1 }],
  ])('never lets %s pass', async (_name, patch) => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, { ...BUDGET_ONE_ROUND, maxRounds: 2 }, fullCapabilitySource)
    const rejection = controller.startAttempt({
      ...header(revision, 'attempt-incomplete'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async attempt => resultWith(attempt, patch),
    })
    await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
    expect(controller.projection.status).not.toBe('awaiting-trial')
    expect(controller.projection.verifiedResultDigest).toBeUndefined()
  })

  it('cannot apply a passing result after the task stopped', () => {
    const stopped = foldEvent(foldEvent(initialFoldState(), { type: 'task/created', spec: {
      taskId: 'task-1' as never, version: 1 as never, requirement: 'r', allowedModificationScope: ['src'], stableBaselineDigest: 'a'.repeat(64), createdBy: 'user',
    } }), { type: 'task/stopped', reason: 'cancelled' })
    expect(() => foldEvent(stopped, { type: 'task/passed', attemptId: 'a' as never, resultDigest: digestJson('x'), elapsedMs: 0, timeAccounting: 'measured' }))
      .toThrow(/task\/passed/)
  })

  it('binds a trial approval to the verified result and refuses further launches', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, BUDGET_ONE_ROUND, fullCapabilitySource)
    await controller.startAttempt({
      ...header(revision, 'attempt-pass'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async attempt => passingResult(attempt),
    })
    expect(controller.projection.verifiedResultDigest).toBeDefined()
    await controller.recordTrialApproval({ ...header(controller.projection.revision, 'trial'), approvedBy: 'user' })
    expect(controller.projection.trialApproval).toMatchObject({ approvedBy: 'user' })
    // No upgrade or continuation path exists: awaiting-trial refuses launches.
    const relaunch = controller.startAttempt({
      ...header(controller.projection.revision, 'attempt-again'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async attempt => passingResult(attempt),
    })
    await expect(relaunch).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_STATE' })
    expect(controller.projection.status).toBe('awaiting-trial')
  })

  it('invalidates a trial approval and verified result when a new plan version commits', () => {
    const draft = { requiredCases: [], manualCases: [] }
    const awaitingTrial = {
      ...initialFoldState(),
      status: 'awaiting-plan-confirmation',
      verifiedResultDigest: 'digest-1',
      trialApproval: { approvedBy: 'user', resultDigest: 'digest-1' },
      revision: 3,
      lastDraft: draft,
    } as const
    const afterPlan = foldEvent(awaitingTrial, {
      type: 'plan/confirmed',
      plan: { testPlanId: 'plan-2', version: TestPlanVersion(2), taskSpecVersion: TaskSpecVersion(1), requiredCases: [], manualCases: [], digest: TestPlanDigest('digest-2') },
    })
    expect(afterPlan.trialApproval).toBeUndefined()
    expect(afterPlan.verifiedResultDigest).toBeUndefined()
    expect(afterPlan.lastDraft).toBeUndefined()
  })

  it('rejects a plan confirmation whose content differs from the human-visible draft', () => {
    const awaitingConfirmation = {
      ...initialFoldState(),
      status: 'awaiting-plan-confirmation',
      revision: 2,
      lastDraft: { requiredCases: [{ caseId: 'c1', requirement: 'search finds a known message', assertionIds: ['a1'] }], manualCases: [] },
    } as const
    const swapped = () => foldEvent(awaitingConfirmation, {
      type: 'plan/confirmed',
      plan: { testPlanId: 'plan-1', version: TestPlanVersion(1), taskSpecVersion: TaskSpecVersion(1), requiredCases: [], manualCases: [], digest: TestPlanDigest('digest') },
    })
    expect(swapped).toThrow(/draft/)
  })
})
