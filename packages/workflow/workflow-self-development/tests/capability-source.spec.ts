/**
 * Capability evidence tests: the two named source kinds, the bumped journal
 * schema, per-item source validation, refusal of journals written by older
 * schema versions, and the per-attempt evidence contract — every `startAttempt`
 * request supplies its own clock and evidence source, and the service caches
 * neither.
 * @module capability-source
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CAPABILITY_SOURCE_KINDS, TASK_JOURNAL_SCHEMA_VERSION, CapabilityDigest } from '../src/runtime.ts'
import { TaskJournal } from '../src/journal.ts'
import SelfDevelopmentTasks from '../src/index.ts'
import {
  ARTIFACT,
  BUDGET_ONE_ROUND,
  DRAFT,
  FakeClock,
  PLAN,
  SPEC,
  SOURCE,
  TASK_ID,
  attemptInputs,
  capabilityEvidence,
  fullCapabilitySource,
  header,
  makeTaskDir,
  openReadyTask,
  passingResult,
} from './helpers.ts'
import type { Attempt, CapabilitySource } from '../src/types.ts'

/** Last journal record parsed from disk. */
interface StoredRecord { event: { type: string; attempt?: Attempt } }

/** Parse every journal record from one segment. */
function records(text: string): StoredRecord[] {
  return text.trim().split('\n').map(line => JSON.parse(line) as StoredRecord)
}

/** Evidence items with the `source` field stripped, as an old provider would report. */
const sourcelessEvidence: CapabilitySource = {
  evidence: names => names.map(capability => ({ capability, digest: CapabilityDigest('d'.repeat(64)) })) as never,
}

/** Evidence items carrying a source outside the known kinds. */
const unknownSourceEvidence: CapabilitySource = {
  evidence: names => names.map(capability => ({ capability, source: 'oracle', digest: CapabilityDigest('d'.repeat(64)) })) as never,
}

describe('capability source kinds', () => {
  it('names exactly the two kinds and bumps the journal schema', () => {
    expect([...CAPABILITY_SOURCE_KINDS]).toEqual(['human-presence', 'machine'])
    expect(TASK_JOURNAL_SCHEMA_VERSION).toBe(3)
  })

  it('refuses evidence that declares no valid source', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await expect(controller.startAttempt({
      ...header(revision, 'attempt-sourceless'),
      ...attemptInputs(clock, sourcelessEvidence),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async () => { throw new Error('side effect must not run') },
    })).rejects.toMatchObject({
      code: 'SELF_DEV_CAPABILITY_MISSING',
      message: 'capability evidence for supervisor has no valid source',
    })
    expect(controller.projection.status).toBe('ready')
  })

  it('refuses evidence whose source is outside the known kinds', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await expect(controller.startAttempt({
      ...header(revision, 'attempt-unknown-source'),
      ...attemptInputs(clock, unknownSourceEvidence),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async () => { throw new Error('side effect must not run') },
    })).rejects.toMatchObject({ code: 'SELF_DEV_CAPABILITY_MISSING' })
  })

  it('records human presence on the attempt when any item is human-presence evidence', async () => {
    const { dir, clock } = await makeTaskDir()
    const humanSource: CapabilitySource = {
      evidence: names => names.map(capability => ({
        capability,
        source: capability === 'supervisor' ? ('human-presence' as const) : ('machine' as const),
        digest: CapabilityDigest('d'.repeat(64)),
      })),
    }
    const { controller, revision } = await openReadyTask(dir, clock)
    let observed: Attempt | undefined
    await controller.startAttempt({
      ...header(revision, 'attempt-human'),
      ...attemptInputs(clock, humanSource),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async (attempt) => {
        observed = attempt
        // The projection path carries the source while the attempt is active.
        expect(controller.projection.currentAttempt?.capabilitySource).toBe('human-presence')
        return passingResult(attempt)
      },
    })
    expect(observed?.capabilitySource).toBe('human-presence')
    const line = await readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
    const started = records(line).find(record => record.event.type === 'attempt/started')
    expect(started?.event.attempt?.capabilitySource).toBe('human-presence')
  })

  it('records machine when every item is machine evidence', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    let observed: Attempt | undefined
    await controller.startAttempt({
      ...header(revision, 'attempt-machine'),
      ...attemptInputs(clock),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async (attempt) => {
        observed = attempt
        return passingResult(attempt)
      },
    })
    expect(observed?.capabilitySource).toBe('machine')
  })

  it('refuses a journal written under schemaVersion 1 and raises handoff', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
    await journal.append({ type: 'task/planning-authorized', authorizedBy: 'user' }, undefined)
    const stale = await readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
    // Rewrite the current version marker so a future bump keeps this a v1 fixture instead of a no-op.
    const marker = `"schemaVersion":${TASK_JOURNAL_SCHEMA_VERSION}`
    expect(stale).toContain(marker)
    await writeFile(join(dir, 'events.00000001.jsonl'), stale.replace(marker, '"schemaVersion":1'))
    const options = { maxRecordsPerSegment: 64, checkpointInterval: 4 }
    const rejection = await TaskJournal.open(dir, options).then(() => null, (error: unknown) => error)
    expect((rejection as { code?: string }).code).toBe('SELF_DEV_JOURNAL_UNAVAILABLE')
    expect((rejection as { message?: string }).message).toMatch(/carries unknown schemaVersion/u)
  })

  it('refuses a journal written under schemaVersion 2, whose passing results bind only launch-input digests', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
    await journal.append({ type: 'task/planning-authorized', authorizedBy: 'user' }, undefined)
    const stale = await readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
    const marker = `"schemaVersion":${TASK_JOURNAL_SCHEMA_VERSION}`
    expect(stale).toContain(marker)
    await writeFile(join(dir, 'events.00000001.jsonl'), stale.replace(marker, '"schemaVersion":2'))
    const options = { maxRecordsPerSegment: 64, checkpointInterval: 4 }
    const rejection = await TaskJournal.open(dir, options).then(() => null, (error: unknown) => error)
    expect((rejection as { code?: string }).code).toBe('SELF_DEV_JOURNAL_UNAVAILABLE')
    expect((rejection as { message?: string }).message).toMatch(/carries unknown schemaVersion/u)
  })
})

describe('per-attempt evidence and clock', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  /** Build the service against a fresh absolute control directory. */
  async function makeService(): Promise<SelfDevelopmentTasks> {
    root = await mkdtemp(join(tmpdir(), 'self-dev-capability-'))
    return new SelfDevelopmentTasks(new Context(), {
      controlDirectory: join(root, 'control'),
      maxRecordsPerSegment: 64,
      checkpointInterval: 4,
    })
  }

  it('records each round with the evidence source its own attempt supplied', async () => {
    const { dir, clock } = await makeTaskDir()
    const humanSource: CapabilitySource = {
      evidence: names => names.map(capability => ({
        capability,
        source: 'human-presence' as const,
        digest: CapabilityDigest('d'.repeat(64)),
      })),
    }
    const { controller, revision } = await openReadyTask(dir, clock, { ...BUDGET_ONE_ROUND, maxRounds: 2 })
    await expect(controller.startAttempt({
      ...header(revision, 'attempt-round-1'),
      ...attemptInputs(clock, fullCapabilitySource),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async () => { throw new Error('first build failed') },
    })).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_RESULT' })
    await controller.startAttempt({
      ...header(controller.projection.revision, 'attempt-round-2'),
      ...attemptInputs(clock, humanSource),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async attempt => passingResult(attempt),
    })
    expect(controller.projection.status).toBe('awaiting-trial')
    const line = await readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
    const started = records(line).filter(record => record.event.type === 'attempt/started')
    expect(started.map(record => record.event.attempt?.capabilitySource)).toEqual(['machine', 'human-presence'])
    expect(started[0]?.event.attempt?.capabilityDigest).not.toBe(started[1]?.event.attempt?.capabilityDigest)
  })

  it('drives one task through the service with evidence supplied only at startAttempt', async () => {
    const service = await makeService()
    const clock = new FakeClock()
    // state() before open() must not swallow the later attempt's evidence.
    expect(await service.state(TASK_ID, clock)).toMatchObject({ status: 'draft' })
    const controller = await service.open(TASK_ID, clock)
    await controller.createTask({ ...header(0, 'create'), spec: SPEC })
    await controller.authorizePlanning({ ...header(1, 'authorize'), authorizedBy: 'user' })
    await controller.submitPlanDraft({ ...header(2, 'draft'), draft: DRAFT })
    await controller.confirmPlan({ ...header(3, 'confirm'), plan: PLAN })
    await controller.approveBudget({ ...header(4, 'budget'), approval: BUDGET_ONE_ROUND })
    await controller.startAttempt({
      ...header(5, 'attempt'),
      ...attemptInputs(clock, fullCapabilitySource),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async attempt => passingResult(attempt),
    })
    expect(controller.projection.status).toBe('awaiting-trial')
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['not a source object', { evidence: 1 }],
  ])('refuses an attempt whose capability source is %s and commits nothing', async (_name, missing) => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    const before = controller.projection.revision
    let sideEffectRan = false
    const request = {
      ...header(revision, 'attempt-missing-source'),
      clock,
      capabilitySource: missing,
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async () => {
        sideEffectRan = true
        return null
      },
    } as unknown as Parameters<typeof controller.startAttempt>[0]
    await expect(controller.startAttempt(request)).rejects.toMatchObject({ code: 'SELF_DEV_CAPABILITY_MISSING' })
    expect(controller.projection.revision).toBe(before)
    expect(sideEffectRan).toBe(false)
  })

  it('replays a committed start with a different evidence source instance and runs the side effect once', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    let sideEffectCalls = 0
    const request = {
      ...header(revision, 'attempt-replay'),
      ...attemptInputs(clock, fullCapabilitySource),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async (attempt: Attempt) => {
        sideEffectCalls += 1
        return passingResult(attempt)
      },
    }
    const first = await controller.startAttempt(request)
    const freshSource: CapabilitySource = { evidence: () => capabilityEvidence }
    const replay = await controller.startAttempt({
      ...request,
      ...attemptInputs(clock, freshSource),
      expectedRevision: controller.projection.revision,
    })
    expect(replay).toMatchObject({ replayed: true, revision: first.revision })
    expect(sideEffectCalls).toBe(1)
    expect(controller.projection.status).toBe('awaiting-trial')
  })

  it('settles the attempt with the request clock, not the clock the controller opened with', async () => {
    const { dir, clock: recoveryClock } = await makeTaskDir()
    const attemptClock = new FakeClock()
    const { controller, revision } = await openReadyTask(dir, recoveryClock)
    await controller.startAttempt({
      ...header(revision, 'attempt-two-clocks'),
      ...attemptInputs(attemptClock, fullCapabilitySource),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async (attempt) => {
        attemptClock.advance(250)
        return passingResult(attempt)
      },
    })
    const line = await readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
    const passed = records(line).find(record => record.event.type === 'task/passed')
    expect(passed?.event).toMatchObject({ type: 'task/passed', elapsedMs: 250 })
    // The recovery clock never advanced: it plays no role in a new attempt.
    expect(recoveryClock.observe()).toEqual({ bootId: 'boot-1', monotonicMs: 1000 })
  })
})
