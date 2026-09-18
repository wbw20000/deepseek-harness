/**
 * Budget validation and approval-ordering behavior: invalid budget inputs are
 * rejected exactly, planning authorization stays separate from development
 * approval, consumed budget survives revisions, and a lowered limit stops the
 * task immediately.
 * @module budget.spec
 */

import { describe, expect, it } from 'vitest'
import { BUDGET_ONE_ROUND, DRAFT, SPEC, fullCapabilitySource, header, makeTaskDir, openReadyTask } from './helpers.ts'

describe('budget validation', () => {
  it('rejects a budget with neither rounds nor time', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    const rejection = controller.approveBudget({
      ...header(revision, 'budget-empty'),
      approval: { ...BUDGET_ONE_ROUND, mode: 'both', maxRounds: undefined, durationMs: undefined },
    })
    await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_BUDGET' })
  })

  it.each([
    ['zero rounds', { mode: 'rounds', maxRounds: 0, phaseTimeoutMs: 1000, maxStepsPerAttempt: 1 }],
    ['negative rounds', { mode: 'rounds', maxRounds: -1, phaseTimeoutMs: 1000, maxStepsPerAttempt: 1 }],
    ['fractional rounds', { mode: 'rounds', maxRounds: 1.5, phaseTimeoutMs: 1000, maxStepsPerAttempt: 1 }],
    ['infinite time', { mode: 'time', durationMs: Number.POSITIVE_INFINITY, noProgressAttemptLimit: 3 }],
    ['NaN time', { mode: 'time', durationMs: Number.NaN, noProgressAttemptLimit: 3 }],
    ['negative time', { mode: 'time', durationMs: -5, noProgressAttemptLimit: 3 }],
  ])('rejects %s', async (_name, patch) => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    const rejection = controller.approveBudget({ ...header(revision, 'budget-bad'), approval: { ...BUDGET_ONE_ROUND, ...patch } })
    await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_OPERATION' })
  })

  it('rejects a rounds-only budget without phase and step bounds', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    const rejection = controller.approveBudget({
      ...header(revision, 'budget-no-phase'),
      approval: { mode: 'rounds', maxRounds: 2, testPlanVersion: 1, taskSpecVersion: 1, approvedBy: 'user' },
    })
    await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_BUDGET' })
  })

  it('rejects a time-only budget without a no-progress bound', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    const rejection = controller.approveBudget({
      ...header(revision, 'budget-no-progress'),
      approval: { mode: 'time', durationMs: 60000, testPlanVersion: 1, taskSpecVersion: 1, approvedBy: 'user' },
    })
    await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_BUDGET' })
  })

  it('rejects an approval that does not bind the frozen plan version', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    const rejection = controller.approveBudget({
      ...header(revision, 'budget-old-plan'),
      approval: { ...BUDGET_ONE_ROUND, testPlanVersion: 2 },
    })
    await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_BUDGET' })
  })
})

describe('approval ordering', () => {
  it('refuses plan drafting without the separate planning authorization', async () => {
    const { dir, clock } = await makeTaskDir()
    const journal = await (await import('../src/journal.ts')).TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
    const { SelfDevelopmentTaskController } = await import('../src/controller.ts')
    const controller = await SelfDevelopmentTaskController.open({ taskId: 'task-1', journal, clock, capabilitySource: fullCapabilitySource })
    await controller.createTask({ ...header(0, 'create'), spec: SPEC })
    const rejection = controller.submitPlanDraft({ ...header(1, 'draft-early'), draft: DRAFT })
    await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_STATE' })
    expect(controller.projection.consumedRounds).toBe(0)
  })

  it('refuses an attempt launch without capability evidence and consumes nothing', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, BUDGET_ONE_ROUND, undefined)
    const rejection = controller.startAttempt({
      ...header(revision, 'attempt-no-evidence'),
      sourceDigest: 'b'.repeat(64),
      artifactDigest: 'c'.repeat(64),
      sideEffect: async () => {
        throw new Error('side effect must never run')
      },
    })
    await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_CAPABILITY_MISSING' })
    expect(controller.projection.status).toBe('ready')
    expect(controller.projection.consumedRounds).toBe(0)
  })

  it('keeps consumed rounds and time across a budget revision and stops when the limit is already spent', async () => {
    const { dir, clock } = await makeTaskDir()
    const budget = { ...BUDGET_ONE_ROUND, maxRounds: 2, noProgressAttemptLimit: 99 }
    const { controller, revision } = await openReadyTask(dir, clock, budget, fullCapabilitySource)
    const failure = controller.startAttempt({
      ...header(revision, 'attempt-1'),
      sourceDigest: 'b'.repeat(64),
      artifactDigest: 'c'.repeat(64),
      sideEffect: async () => {
        throw new Error('build failed')
      },
    })
    await expect(failure).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
    expect(controller.projection.consumedRounds).toBe(1)
    const lowered = await controller.approveBudget({
      ...header(controller.projection.revision, 'budget-lower'),
      approval: { ...budget, maxRounds: 1 },
    })
    expect(controller.projection.status).toBe('stopped')
    expect(controller.projection.stopReason).toBe('budget-exhausted')
    expect(controller.projection.consumedRounds).toBe(1)
    void lowered
  })

  it('keeps consumed rounds when a budget revision raises the limit after a failure', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, { ...BUDGET_ONE_ROUND, maxRounds: 2 }, fullCapabilitySource)
    const failure = controller.startAttempt({
      ...header(revision, 'attempt-1'),
      sourceDigest: 'b'.repeat(64),
      artifactDigest: 'c'.repeat(64),
      sideEffect: async () => {
        throw new Error('build failed')
      },
    })
    await expect(failure).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
    expect(controller.projection.status).toBe('ready')
    await controller.approveBudget({
      ...header(controller.projection.revision, 'budget-raise'),
      approval: { ...BUDGET_ONE_ROUND, maxRounds: 5 },
    })
    expect(controller.projection.status).toBe('ready')
    expect(controller.projection.approval?.maxRounds).toBe(5)
    expect(controller.projection.consumedRounds).toBe(1)
  })

  it('replays a confirmed operation exactly and refuses the same key with a different payload', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    const request = { ...header(revision, 'budget-dup'), approval: BUDGET_ONE_ROUND }
    const first = await controller.approveBudget(request)
    const replay = await controller.approveBudget({ ...request, expectedRevision: first.revision })
    expect(replay).toMatchObject({ replayed: true })
    const mismatch = controller.approveBudget({
      ...request, expectedRevision: first.revision, approval: { ...BUDGET_ONE_ROUND, maxRounds: 9 },
    })
    await expect(mismatch).rejects.toMatchObject({ code: 'SELF_DEV_OPERATION_PAYLOAD_MISMATCH' })
  })

  it('refuses an operation whose expected revision does not match', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    const stale = controller.authorizePlanning({ ...header(revision + 1, 'stale'), authorizedBy: 'user' })
    await expect(stale).rejects.toMatchObject({ code: 'SELF_DEV_REVISION_CONFLICT' })
  })
})

describe('fake clock isolation', () => {
  it('never reads the host clock', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, { ...BUDGET_ONE_ROUND, mode: 'both', durationMs: 1000, noProgressAttemptLimit: 5 }, fullCapabilitySource)
    const before = clock.observe()
    const failure = controller.startAttempt({
      ...header(revision, 'attempt-clock'),
      sourceDigest: 'b'.repeat(64),
      artifactDigest: 'c'.repeat(64),
      sideEffect: async () => new Promise(resolve => setTimeout(resolve, 5)).then(() => {
        throw new Error('slow failure')
      }),
    })
    await expect(failure).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
    expect(clock.observe()).toEqual(before)
    expect(controller.projection.consumedTimeMs).toBe(0)
  })
})
