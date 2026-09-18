/** Durable rejection and asynchronous cancellation regressions. @module controller-regressions.spec */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SelfDevelopmentTaskController } from '../src/controller.ts'
import { TaskJournal } from '../src/journal.ts'
import { attemptInputs, ARTIFACT, BUDGET_ONE_ROUND, SOURCE, TASK_ID, header, makeTaskDir, openReadyTask, passingResult } from './helpers.ts'

it('rejects an invalid transition without appending a poison event', async () => {
  const { dir, clock } = await makeTaskDir()
  const { controller, revision } = await openReadyTask(dir, clock)
  const file = join(dir, 'events.00000001.jsonl')
  const before = await readFile(file, 'utf8')
  await expect(controller.authorizePlanning({ ...header(revision, 'bad-state'), authorizedBy: 'user' }))
    .rejects.toMatchObject({ code: 'SELF_DEV_INVALID_STATE' })
  expect(await readFile(file, 'utf8')).toBe(before)
  const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
  const reopened = await SelfDevelopmentTaskController.open({ taskId: TASK_ID, journal, clock })
  expect(reopened.projection.status).toBe('ready')
})

it('accepts cancellation while an attempt is pending and rejects its late success', async () => {
  const { dir, clock } = await makeTaskDir()
  const { controller, revision } = await openReadyTask(dir, clock, BUDGET_ONE_ROUND)
  const entered = Promise.withResolvers<boolean>()
  const release = Promise.withResolvers<boolean>()
  const running = controller.startAttempt({
    ...header(revision, 'pending-attempt'), ...attemptInputs(clock), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
    sideEffect: async (attempt) => { entered.resolve(true); await release.promise; return passingResult(attempt) },
  }).then(() => undefined, () => undefined)
  await entered.promise
  let accepted = false
  const stop = controller.stop({ ...header(controller.projection.revision, 'cancel-pending'), reason: 'cancelled' })
    .then(() => { accepted = true }, () => undefined)
  try {
    await vi.waitFor(() => { expect(accepted).toBe(true) }, { timeout: 2000 })
  } finally {
    release.resolve(true)
    await running
    await stop
  }
  expect(controller.projection.status).toBe('stopped')
  expect(controller.projection.verifiedResultDigest).toBeUndefined()
})

it('refuses a pending result after a stop encounters an ambiguous journal failure', async () => {
  const { dir, clock } = await makeTaskDir()
  const { controller, revision } = await openReadyTask(dir, clock, BUDGET_ONE_ROUND)
  const entered = Promise.withResolvers<boolean>()
  const release = Promise.withResolvers<boolean>()
  const running = controller.startAttempt({
    ...header(revision, 'attempt-before-disk-failure'), ...attemptInputs(clock), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
    sideEffect: async (attempt) => { entered.resolve(true); await release.promise; return passingResult(attempt) },
  }).then(value => ({ value }), (error: unknown) => ({ error }))
  await entered.promise
  const diskFailure = vi.spyOn(TaskJournal.prototype, 'append').mockRejectedValueOnce(new Error('synthetic fsync failure'))
  try {
    await expect(controller.stop({ ...header(controller.projection.revision, 'stop-with-disk-failure') })).rejects.toThrow('fsync failure')
  } finally {
    diskFailure.mockRestore()
    release.resolve(true)
  }
  const settled = await running
  expect(settled).toHaveProperty('error')
  expect(controller.projection.verifiedResultDigest).toBeUndefined()
  expect(controller.projection.status).not.toBe('awaiting-trial')
})
