/** Independent-review regressions for durable operation identity and cleanup. @module review-regressions.spec */
import { getEventListeners } from 'node:events'
import { expect, it } from 'vitest'
import { SelfDevelopmentTaskController } from '../src/controller.ts'
import { TaskJournal } from '../src/journal.ts'
import { attemptInputs, ARTIFACT, BUDGET_ONE_ROUND, SOURCE, TASK_ID, header, makeTaskDir, openReadyTask, passingResult } from './helpers.ts'

it('reopens after a runner rejects with an empty error message', async () => {
  const { dir, clock } = await makeTaskDir()
  const { controller, revision } = await openReadyTask(dir, clock, BUDGET_ONE_ROUND)
  await expect(controller.startAttempt({
    ...header(revision, 'empty-error'), ...attemptInputs(clock), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
    sideEffect: async () => { throw new Error('') },
  })).rejects.toBeDefined()
  const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
  expect((await journal.read()).status).toBe('ok')
})

it('replays the same operation revision before and after reopening', async () => {
  const { dir, clock } = await makeTaskDir()
  const { controller, revision } = await openReadyTask(dir, clock, BUDGET_ONE_ROUND)
  let launches = 0
  const request = {
    ...header(revision, 'success'), ...attemptInputs(clock), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
    sideEffect: async (attempt: Parameters<typeof passingResult>[0]) => { launches += 1; return passingResult(attempt) },
  }
  const original = await controller.startAttempt(request)
  expect(await controller.startAttempt(request)).toEqual({ ...original, replayed: true })
  await controller.recordTrialApproval({ ...header(original.revision, 'trial'), approvedBy: 'user' })
  const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
  const reopened = await SelfDevelopmentTaskController.open({ taskId: TASK_ID, journal, clock })
  expect(await reopened.startAttempt(request)).toEqual({ ...original, replayed: true })
  expect(launches).toBe(1)
})

it('records the original expected revision on every event of a budget update', async () => {
  const { dir, clock } = await makeTaskDir()
  const { controller, revision } = await openReadyTask(dir, clock, BUDGET_ONE_ROUND)
  await expect(controller.startAttempt({
    ...header(revision, 'failed'), ...attemptInputs(clock), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
    sideEffect: async () => { throw new Error('build failed') },
  })).rejects.toBeDefined()
  const expectedRevision = controller.projection.revision
  await controller.approveBudget({ ...header(expectedRevision, 'same-budget'), approval: BUDGET_ONE_ROUND })
  const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
  const operations = (await journal.read()).records.filter(record => record.operation?.id === 'same-budget')
  expect(operations).toHaveLength(2)
  expect(operations.map(record => record.operation?.expectedRevision)).toEqual([expectedRevision, expectedRevision])
})

it('removes the external abort listener when an attempt settles', async () => {
  const { dir, clock } = await makeTaskDir()
  const { controller, revision } = await openReadyTask(dir, clock, BUDGET_ONE_ROUND)
  const shutdown = new AbortController()
  const listenersBefore = getEventListeners(shutdown.signal, 'abort').length
  await controller.startAttempt({
    ...header(revision, 'listener'), ...attemptInputs(clock), sourceDigest: SOURCE, artifactDigest: ARTIFACT, signal: shutdown.signal,
    sideEffect: async attempt => passingResult(attempt),
  })
  expect(getEventListeners(shutdown.signal, 'abort')).toHaveLength(listenersBefore)
})

it.each([
  ['missing phases', { phases: undefined }],
  ['empty phases', { phases: [] }],
  ['missing steps', { stepsUsed: undefined }],
  ['conflicting duplicate cases', { cases: [
    { caseId: 'c1', assertions: [{ assertionId: 'a1', status: 'fail' }] },
    { caseId: 'c1', assertions: [{ assertionId: 'a1', status: 'pass' }] },
  ] }],
  ['conflicting duplicate assertions', { cases: [{ caseId: 'c1', assertions: [
    { assertionId: 'a1', status: 'fail' }, { assertionId: 'a1', status: 'pass' },
  ] }] }],
])('rejects an incomplete or ambiguous report: %s', async (_name, patch) => {
  const { dir, clock } = await makeTaskDir()
  const { controller, revision } = await openReadyTask(dir, clock, BUDGET_ONE_ROUND)
  await expect(controller.startAttempt({
    ...header(revision, 'incomplete-report'), ...attemptInputs(clock), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
    sideEffect: async attempt => ({ ...passingResult(attempt), phases: [{ phaseId: 'test', durationMs: 1 }], stepsUsed: 1, ...patch }),
  })).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
  expect(controller.projection.verifiedResultDigest).toBeUndefined()
})
