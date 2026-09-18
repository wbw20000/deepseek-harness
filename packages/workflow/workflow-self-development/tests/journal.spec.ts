/**
 * Durable journal behavior, exercised against real files that an external
 * reader re-reads: chain and checkpoint verification, interrupted attempts on
 * restart, uncertain cross-boot intervals, and refusal to run side effects on
 * a malformed, truncated, or rewritten log.
 * @module journal.spec
 */

import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskJournal } from '../src/journal.ts'
import { SelfDevelopmentError, SelfDevTaskId, digestJson } from '../src/runtime.ts'
import { SelfDevelopmentTaskController } from '../src/controller.ts'
import { attemptInputs, BUDGET_ONE_ROUND, SOURCE, ARTIFACT, TASK_ID, header, makeTaskDir, openReadyTask, passingResult } from './helpers.ts'

const JOURNAL_OPTIONS = { maxRecordsPerSegment: 4, checkpointInterval: 2 } as const

/** Seed a journal with the full ready-state chain so an attempt/started record folds. */
async function seedReadyJournal(journal: TaskJournal, startedAt: { bootId: string; monotonicMs: number }): Promise<void> {
  const spec = {
    taskId: SelfDevTaskId(TASK_ID), version: 1 as never, requirement: 'r',
    allowedModificationScope: ['src'], stableBaselineDigest: 'a'.repeat(64), createdBy: 'user',
  }
  await journal.append({ type: 'task/created', spec }, undefined)
  await journal.append({ type: 'task/planning-authorized', authorizedBy: 'user' }, undefined)
  await journal.append({ type: 'plan/drafted', draft: { requiredCases: [{ caseId: 'c1', requirement: 'r', assertionIds: ['a1'] }], manualCases: [] } }, undefined)
  await journal.append({ type: 'plan/confirmed', plan: {
    testPlanId: 'plan-1', version: 1 as never, taskSpecVersion: 1 as never,
    requiredCases: [{ caseId: 'c1', requirement: 'r', assertionIds: ['a1'] }], manualCases: [],
    digest: 'a'.repeat(64) as never,
  } }, undefined)
  await journal.append({ type: 'budget/approved', approval: {
    mode: 'rounds', maxRounds: 2, phaseTimeoutMs: 1000, maxStepsPerAttempt: 10,
    testPlanVersion: 1 as never, taskSpecVersion: 1 as never, approvedBy: 'user',
  } }, undefined)
  await journal.append({
    type: 'attempt/started',
    attempt: {
      attemptId: 'attempt-1' as never, attemptNumber: 1, startedAt,
      testPlanDigest: 'a'.repeat(64) as never, sourceDigest: SOURCE as never,
      artifactDigest: ARTIFACT as never, capabilityDigest: 'c'.repeat(64) as never,
      capabilitySource: 'machine',
    },
  }, undefined)
}

describe('real file journal effects', () => {
  it('stores a hash chain that an external reader can re-verify from disk', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, { ...BUDGET_ONE_ROUND, maxRounds: 2 })
    await controller.startAttempt({
      ...header(revision, 'attempt-disk'),
      ...attemptInputs(clock),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async attempt => passingResult(attempt),
    })
    const text = await readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
    const records = text.trim().split('\n').map(line => JSON.parse(line) as { seq: number; prevHash: string; hash: string; event: { type: string } })
    expect(records.length).toBeGreaterThanOrEqual(6)
    let prevHash = ''
    for (const [index, record] of records.entries()) {
      expect(record.seq).toBe(index + 1)
      expect(record.prevHash).toBe(prevHash)
      const { hash, ...identity } = record
      expect(digestJson(identity)).toBe(hash)
      prevHash = hash
    }
    expect(records.at(-1)?.event.type).toBe('task/passed')
  })

  it('rotates segments and rewrites the protected checkpoint', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, { ...BUDGET_ONE_ROUND, maxRounds: 2 })
    await controller.startAttempt({
      ...header(revision, 'attempt-rotate'),
      ...attemptInputs(clock),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async attempt => passingResult(attempt),
    })
    const files = await readFile(join(dir, 'checkpoint.json'), 'utf8')
    const checkpoint = JSON.parse(files) as { seq: number; segment: string }
    expect(checkpoint.seq).toBeGreaterThan(0)
    expect(checkpoint.segment).toMatch(/^events\.\d{8}\.jsonl$/u)
  })
})

describe('restart and recovery', () => {
  it('reopens with the same projection after a clean stop', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await controller.stop({ ...header(revision, 'stop'), reason: 'cancelled' })
    const journal = await TaskJournal.open(dir, JOURNAL_OPTIONS)
    const reopened = await SelfDevelopmentTaskController.open({ taskId: TASK_ID, journal, clock })
    expect(reopened.projection).toMatchObject({ status: 'stopped', stopReason: 'cancelled', revision: controller.projection.revision })
  })

  it('interrupts an in-flight attempt on restart without repeating side effects or refunding the round', async () => {
    const { dir, clock } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, JOURNAL_OPTIONS)
    // Simulate a crash right after the durable start commit: the ready chain
    // plus one attempt/started record exist and no side effect ever completed.
    await seedReadyJournal(journal, { bootId: 'boot-1', monotonicMs: 5000 })
    clock.advance(10000)
    const reopened = await SelfDevelopmentTaskController.open({
      taskId: TASK_ID, journal: await TaskJournal.open(dir, JOURNAL_OPTIONS), clock,
    })
    expect(reopened.projection.status).toBe('handoff')
    expect(reopened.projection.handoffReason).toBe('attempt-interrupted')
    expect(reopened.projection.consumedRounds).toBe(1)
    // Further operations refuse: the human decides how to proceed.
    const rejected = reopened.stop({ ...header(reopened.projection.revision, 'stop-after'), reason: 'cancelled' })
    await expect(rejected).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_STATE' })
  })

  it('freezes the remaining time budget when the interrupted attempt crossed a boot session', async () => {
    const { dir, clock } = await makeTaskDir()
    clock.reboot()
    const journal = await TaskJournal.open(dir, JOURNAL_OPTIONS)
    await seedReadyJournal(journal, { bootId: 'boot-1', monotonicMs: 5000 })
    const reopened = await SelfDevelopmentTaskController.open({ taskId: TASK_ID, journal, clock })
    expect(reopened.projection.handoffReason).toBe('clock-uncertain')
    expect(reopened.projection.timeBudgetFrozen).toBe(true)
  })
})

describe('corrupt and incomplete journals', () => {
  it('preserves a malformed tail byte-for-byte and refuses to open', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await controller.stop({ ...header(revision, 'stop'), reason: 'cancelled' })
    const segment = join(dir, 'events.00000001.jsonl')
    const before = await readFile(segment, 'utf8')
    const partial = before + '{"seq":99,"prevHash":"'
    await writeFile(segment, partial)
    const reopening = TaskJournal.open(dir, JOURNAL_OPTIONS)
    await expect(reopening).rejects.toMatchObject({ code: 'SELF_DEV_JOURNAL_UNAVAILABLE' })
    expect(await readFile(segment, 'utf8')).toBe(partial)
  })

  it('detects truncation the protected checkpoint proves existed', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await controller.stop({ ...header(revision, 'stop'), reason: 'cancelled' })
    const segment = join(dir, 'events.00000001.jsonl')
    const records = (await readFile(segment, 'utf8')).trim().split('\n')
    await writeFile(segment, `${records.slice(0, -3).join('\n')}\n`)
    const reopening = TaskJournal.open(dir, JOURNAL_OPTIONS)
    await expect(reopening).rejects.toThrow(/checkpoint/)
  })

  it('detects a rewritten record whose hash no longer covers its content', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await controller.stop({ ...header(revision, 'stop'), reason: 'cancelled' })
    const segment = join(dir, 'events.00000001.jsonl')
    const text = await readFile(segment, 'utf8')
    const rewritten = text.replace('user', 'attacker')
    expect(rewritten).not.toBe(text)
    await writeFile(segment, rewritten)
    const reopening = TaskJournal.open(dir, JOURNAL_OPTIONS)
    await expect(reopening).rejects.toThrow(/hash|sequence|chain/)
  })

  it('detects a reordered event log', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await controller.stop({ ...header(revision, 'stop'), reason: 'cancelled' })
    const segment = join(dir, 'events.00000001.jsonl')
    const records = (await readFile(segment, 'utf8')).trim().split('\n')
    const reordered = [records[1]!, records[0]!, ...records.slice(2)].join('\n')
    await writeFile(segment, `${reordered}\n`)
    const reopening = TaskJournal.open(dir, JOURNAL_OPTIONS)
    await expect(reopening).rejects.toMatchObject({ code: 'SELF_DEV_JOURNAL_UNAVAILABLE' })
  })

  it('keeps SelfDevelopmentError as the only boundary error class', () => {
    expect(new SelfDevelopmentError('x', 'SELF_DEV_INVALID_STATE').code).toBe('SELF_DEV_INVALID_STATE')
  })

  it('fails closed when a nonempty journal has no checkpoint at all', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await controller.stop({ ...header(revision, 'stop'), reason: 'cancelled' })
    await rm(join(dir, 'checkpoint.json'))
    const reopening = TaskJournal.open(dir, JOURNAL_OPTIONS)
    await expect(reopening).rejects.toThrow(/without a checkpoint/)
  })

  it('distinguishes an unreadable checkpoint from an absent one', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await controller.stop({ ...header(revision, 'stop'), reason: 'cancelled' })
    if (process.getuid?.() === 0) return
    await chmod(join(dir, 'checkpoint.json'), 0o000)
    try {
      const reopening = TaskJournal.open(dir, JOURNAL_OPTIONS)
      await expect(reopening).rejects.toThrow(/EACCES|unreadable/)
    } finally {
      await chmod(join(dir, 'checkpoint.json'), 0o600)
    }
  })

  it('refuses a symlinked segment instead of reading through it', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await controller.stop({ ...header(revision, 'stop'), reason: 'cancelled' })
    const real = join(dir, 'events.00000001.jsonl')
    const text = await readFile(real, 'utf8')
    await rm(real)
    await writeFile(join(dir, 'outside.jsonl'), text)
    await symlink(join(dir, 'outside.jsonl'), real)
    const reopening = TaskJournal.open(dir, JOURNAL_OPTIONS)
    await expect(reopening).rejects.toThrow(/not a regular file/)
  })

  it('refuses a directory placed where a segment belongs', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await controller.stop({ ...header(revision, 'stop'), reason: 'cancelled' })
    const real = join(dir, 'events.00000001.jsonl')
    await rm(real)
    await mkdir(real)
    const reopening = TaskJournal.open(dir, JOURNAL_OPTIONS)
    await expect(reopening).rejects.toThrow(/not a regular file/)
  })

  it.each([
    ['an unknown event discriminant', { type: 'task/upgraded', payload: {} }],
    ['a null event', null],
    ['a missing event discriminant', { spec: { taskId: 'task-1' } }],
  ])('refuses %s', async (_name, event) => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await controller.stop({ ...header(revision, 'stop'), reason: 'cancelled' })
    const segment = join(dir, 'events.00000001.jsonl')
    const text = await readFile(segment, 'utf8')
    const forged = JSON.stringify({ ...JSON.parse(text.trim().split('\n').at(-1)!), event })
    await writeFile(segment, `${text}${forged}\n`)
    const reopening = TaskJournal.open(dir, JOURNAL_OPTIONS)
    await expect(reopening).rejects.toThrow(/schema/)
  })

  it('treats a missing terminal newline as an incomplete tail', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await controller.stop({ ...header(revision, 'stop'), reason: 'cancelled' })
    const segment = join(dir, 'events.00000001.jsonl')
    const text = await readFile(segment, 'utf8')
    await writeFile(segment, text.replace(/\n$/u, ''))
    const reopening = TaskJournal.open(dir, JOURNAL_OPTIONS)
    await expect(reopening).rejects.toThrow(/terminal newline/)
  })

  it('refuses a segment whose name does not match its sequence position', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock)
    await controller.stop({ ...header(revision, 'stop'), reason: 'cancelled' })
    const segment = join(dir, 'events.00000001.jsonl')
    await rename(segment, join(dir, 'events.00000009.jsonl'))
    const reopening = TaskJournal.open(dir, JOURNAL_OPTIONS)
    await expect(reopening).rejects.toThrow(/starts at 9/)
  })
})
