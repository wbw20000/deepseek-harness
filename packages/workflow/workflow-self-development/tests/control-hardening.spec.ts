/**
 * Control regressions beyond the durable-rejection set: trusted-runner
 * cancellation, method-scoped idempotency, frozen public snapshots, phase
 * and step overrun verdicts, and honest replay across reopen.
 * @module control-hardening.spec
 */

import { describe, expect, it } from 'vitest'
import { TaskJournal } from '../src/journal.ts'
import { SelfDevelopmentTaskController } from '../src/controller.ts'
import { BUDGET_ONE_ROUND, SPEC, SOURCE, ARTIFACT, TASK_ID, fullCapabilitySource, header, makeTaskDir, openReadyTask, passingResult, resultWith } from './helpers.ts'

/** Open a ready task with a two-round budget and capability evidence. */
async function openTwoRoundTask() {
  const { dir, clock } = await makeTaskDir()
  const { controller, revision } = await openReadyTask(
    dir, clock, { ...BUDGET_ONE_ROUND, maxRounds: 2 }, fullCapabilitySource,
  )
  return { dir, clock, controller, revision }
}

describe('trusted-runner cancellation', () => {
  it('records a cancelled failure and never the late success when the signal aborts mid-run', async () => {
    const { controller, revision } = await openTwoRoundTask()
    const external = new AbortController()
    const settled = controller.startAttempt({
      ...header(revision, 'attempt-abort'), sourceDigest: SOURCE, artifactDigest: ARTIFACT, signal: external.signal,
      sideEffect: async (attempt, signal) => {
        await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
        return passingResult(attempt)
      },
    })
    await waitForAttempting(controller)
    external.abort()
    await expect(settled).rejects.toMatchObject({ code: 'SELF_DEV_ATTEMPT_CANCELLED' })
    expect(controller.projection.consumedRounds).toBe(1)
    expect(controller.projection.verifiedResultDigest).toBeUndefined()
    expect(controller.projection.status).toBe('ready')
  })

  it('refuses a launch whose cancellation signal is already aborted without consuming the round', async () => {
    const { controller, revision } = await openTwoRoundTask()
    const refused = controller.startAttempt({
      ...header(revision, 'attempt-aborted'), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      signal: AbortSignal.abort(),
      sideEffect: async () => { throw new Error('side effect must never run') },
    })
    await expect(refused).rejects.toMatchObject({ code: 'SELF_DEV_ATTEMPT_CANCELLED' })
    expect(controller.projection.consumedRounds).toBe(0)
    expect(controller.projection.status).toBe('ready')
  })

  it('hands the attempt its own cancellation signal that stop aborts', async () => {
    const { controller, revision } = await openTwoRoundTask()
    const observed: AbortSignal[] = []
    const running = controller.startAttempt({
      ...header(revision, 'attempt-signal'), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async (_attempt, signal) => {
        observed.push(signal)
        await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
        return passingResult(_attempt)
      },
    })
    const stopPromise = waitForAttempting(controller, () => {
      void controller.stop({ ...header(controller.projection.revision, 'stop-signal'), reason: 'cancelled' })
    })
    await expect(running).rejects.toBeTruthy()
    await stopPromise
    expect(observed[0]?.aborted).toBe(true)
    expect(controller.projection.status).toBe('stopped')
  })
})

describe('method-scoped idempotency', () => {
  it('refuses one operation id reused across two controller methods', async () => {
    const { dir, clock } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
    const controller = await SelfDevelopmentTaskController.open({ taskId: TASK_ID, journal, clock, capabilitySource: undefined })
    await controller.createTask({ ...header(0, 'shared-key'), spec: SPEC })
    const crossMethod = controller.authorizePlanning({ ...header(1, 'shared-key'), authorizedBy: 'user' })
    await expect(crossMethod).rejects.toMatchObject({ code: 'SELF_DEV_OPERATION_PAYLOAD_MISMATCH' })
    expect(controller.projection.status).toBe('draft')
  })

  it('replays a reopened journal operation as a replay, never as a fresh success', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await controller.stop({ ...header(revision, 'stop-once'), reason: 'cancelled' })
    const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
    const reopened = await SelfDevelopmentTaskController.open({ taskId: TASK_ID, journal, clock, capabilitySource: undefined })
    const replay = await reopened.stop({ ...header(reopened.projection.revision, 'stop-once'), reason: 'cancelled' })
    expect(replay).toMatchObject({ replayed: true })
  })
})

describe('public snapshot immutability', () => {
  it('returns a frozen projection whose mutation cannot reach the fold state', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller } = await openReadyTask(dir, clock)
    const projection = controller.projection as { status: string; trialApproval?: unknown; spec?: { requirement: string } }
    expect(Object.isFrozen(projection)).toBe(true)
    expect(() => { (projection as { status: string }).status = 'handoff' }).toThrow()
    expect(controller.projection.status).toBe('ready')
    void projection.spec
  })

  it('returns frozen plan and approval objects', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller } = await openReadyTask(dir, clock)
    expect(Object.isFrozen(controller.plan)).toBe(true)
    expect(Object.isFrozen(controller.projection.approval)).toBe(true)
  })
})

describe('phase and step overrun verdicts', () => {
  it('rejects a result whose reported phase overran the approved phase timeout', async () => {
    const { controller, revision } = await openTwoRoundTask()
    const rejection = controller.startAttempt({
      ...header(revision, 'attempt-phase'), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async attempt => resultWith(attempt, { phases: [{ phaseId: 'build', durationMs: 60001 }] }),
    })
    await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_LATE_RESULT' })
    expect(controller.projection.status).not.toBe('awaiting-trial')
    expect(controller.projection.verifiedResultDigest).toBeUndefined()
  })

  it('rejects a result that reports more steps than the approved cap', async () => {
    const { controller, revision } = await openTwoRoundTask()
    const rejection = controller.startAttempt({
      ...header(revision, 'attempt-steps'), sourceDigest: SOURCE, artifactDigest: ARTIFACT,
      sideEffect: async attempt => resultWith(attempt, { stepsUsed: 51 }),
    })
    await expect(rejection).rejects.toMatchObject({ code: 'SELF_DEV_LATE_RESULT' })
    expect(controller.projection.verifiedResultDigest).toBeUndefined()
  })
})

/** Wait until the controller reports an in-flight attempt, then run `body` from outside the queue. */
async function waitForAttempting(controller: SelfDevelopmentTaskController, body?: () => void): Promise<void> {
  for (let waited = 0; controller.projection.status !== 'attempting' && waited < 2000; waited += 5) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  body?.()
}
