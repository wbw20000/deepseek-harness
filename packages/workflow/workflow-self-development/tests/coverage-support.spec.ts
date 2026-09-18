/**
 * Behavior tests closing the coverage gap for the self-development domain
 * rules, journal verification refusals, runtime digest branding, the schema
 * rejection fallback, and the service journal-handoff cache. Filesystem
 * faults are injected at the `node:fs/promises` boundary; every fault is
 * scoped to one test and reset in `afterEach`.
 * @module coverage-support.spec
 */

import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z as zod } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import {
  checkAttemptBudget,
  foldEvent,
  freezeTestPlan,
  initialFoldState,
  verifyAttemptResult,
} from '../src/domain.ts'
import { TaskJournal } from '../src/journal.ts'
import SelfDevelopmentTasks from '../src/index.ts'
import { parseInput } from '../src/schema.ts'
import {
  ArtifactDigest,
  CapabilityDigest,
  SelfDevAttemptId,
  SelfDevelopmentError,
  SourceDigest,
  TASK_JOURNAL_SCHEMA_VERSION,
  TaskSpecVersion,
  TestPlanDigest,
} from '../src/runtime.ts'
import { BUDGET_ONE_ROUND, FakeClock, makeTaskDir, passingResult, PLAN, SPEC, TASK_ID } from './helpers.ts'
import type { FileHandle } from 'node:fs/promises'
import type { Attempt, BudgetApproval, TaskSpec, TestPlanDigest as TestPlanDigestBrand, TestResult } from '../src/types.ts'

/** Filesystem fault registry shared with the `node:fs/promises` mock below. */
const fault = vi.hoisted(() => ({
  actual: undefined as unknown as typeof import('node:fs/promises'),
  overrides: {} as Record<string, ((...args: unknown[]) => unknown) | undefined>,
  zeroSegmentWrites: false,
  closedShortWriteHandle: false,
  openPaths: [] as string[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  fault.actual = original
  const delegate = (name: string): ((...args: unknown[]) => unknown) => async (...args) => {
    const override = fault.overrides[name]
    if (override !== undefined) return override(...args)
    return (original[name as keyof typeof original] as (...args: unknown[]) => unknown)(...args)
  }
  return {
    ...original,
    open: async (...args: unknown[]) => {
      const handle = (await delegate('open')(...args)) as FileHandle
      fault.openPaths.push(String(args[0]))
      if (fault.zeroSegmentWrites && args[1] === 'a' && String(args[0]).endsWith('.jsonl')) {
        handle.write = (async () => ({ bytesWritten: 0 })) as unknown as typeof handle.write
        const close = handle.close.bind(handle)
        handle.close = async () => {
          fault.closedShortWriteHandle = true
          await close()
        }
      }
      return handle
    },
    readdir: delegate('readdir'),
    lstat: delegate('lstat'),
    readFile: delegate('readFile'),
  }
})

afterEach(() => {
  fault.overrides = {}
  fault.zeroSegmentWrites = false
  fault.closedShortWriteHandle = false
  fault.openPaths.length = 0
})

/** Run the body with `process.platform` reporting the given value, restoring it afterwards. */
async function withPlatform<R>(platform: NodeJS.Platform, run: () => Promise<R>): Promise<R> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

/** Return the SelfDevelopmentError a synchronous call threw, failing the test when nothing was thrown. */
function rejectionOf(run: () => unknown): SelfDevelopmentError {
  try {
    run()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SelfDevelopmentError)
    return error as SelfDevelopmentError
  }
  throw new Error('expected the call to throw SelfDevelopmentError')
}

/** Return the SelfDevelopmentError a promise rejected with, failing the test when it resolved. */
async function rejectionFrom(promise: Promise<unknown>): Promise<SelfDevelopmentError> {
  try {
    await promise
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SelfDevelopmentError)
    return error as SelfDevelopmentError
  }
  throw new Error('expected the promise to reject with SelfDevelopmentError')
}

const spec: TaskSpec = { ...SPEC, taskId: TASK_ID, version: TaskSpecVersion(1) }
const budget = BUDGET_ONE_ROUND as BudgetApproval
const journalOptions = { maxRecordsPerSegment: 64, checkpointInterval: 4 }

function makeAttempt(testPlanDigest: TestPlanDigestBrand): Attempt {
  return {
    attemptId: SelfDevAttemptId('attempt-support'),
    attemptNumber: 1,
    startedAt: { bootId: 'boot-1', monotonicMs: 1000 },
    testPlanDigest,
    sourceDigest: SourceDigest('b'.repeat(64)),
    artifactDigest: ArtifactDigest('c'.repeat(64)),
    capabilityDigest: CapabilityDigest('d'.repeat(64)),
    capabilitySource: 'machine',
  }
}

/** One journal record line with package-valid defaults and the given overrides. */
function recordLine(patch: Record<string, unknown>): string {
  const record = {
    schemaVersion: TASK_JOURNAL_SCHEMA_VERSION,
    seq: 1,
    prevHash: '',
    event: { type: 'task/planning-authorized', authorizedBy: 'user' },
    hash: '0'.repeat(64),
    ...patch,
  }
  return `${JSON.stringify(record)}\n`
}

describe('runtime digest branding', () => {
  it('brands source and artifact digests without changing the value', () => {
    const raw = 'e'.repeat(64)
    expect(SourceDigest(raw)).toBe(raw)
    expect(ArtifactDigest(raw)).toBe(raw)
  })
})

describe('schema rejection fallback', () => {
  it('reports "unknown issue" when a schema rejection carries no issue message', () => {
    const issueLessSchema = {
      safeParse: () => ({ success: false as const, error: { issues: [] } }),
    } as unknown as zod.ZodType
    const rejection = rejectionOf(() => parseInput(issueLessSchema, 'stub value', {}))
    expect(rejection.code).toBe('SELF_DEV_INVALID_OPERATION')
    expect(rejection.message).toBe('stub value does not satisfy the package schema: unknown issue')
  })
})

describe('domain rules', () => {
  it('refuses a confirmed plan bound to a different TaskSpec version', () => {
    const rejection = rejectionOf(() => freezeTestPlan({ ...PLAN, taskSpecVersion: 2 }, spec))
    expect(rejection.code).toBe('SELF_DEV_INVALID_PLAN')
    expect(rejection.message).toBe('plan binds TaskSpec 2, current TaskSpec is 1')
  })

  it('refuses an attempt whose plan digest does not match the frozen plan', () => {
    const frozen = freezeTestPlan(PLAN, spec)
    const attempt = makeAttempt(TestPlanDigest('e'.repeat(64)))
    const result = passingResult(attempt) as unknown as TestResult
    const rejection = rejectionOf(() => verifyAttemptResult({ taskId: TASK_ID, attempt, plan: frozen, result }))
    expect(rejection.code).toBe('SELF_DEV_IDENTITY_MISMATCH')
    expect(rejection.message).toBe('attempt plan digest does not match the frozen plan')
  })

  it('refuses task/created on a state that already carries a spec', () => {
    const rejection = rejectionOf(() => foldEvent({ ...initialFoldState(), spec }, { type: 'task/created', spec }))
    expect(rejection.code).toBe('SELF_DEV_INVALID_STATE')
    expect(rejection.message).toBe('task/created cannot apply to an existing task')
  })

  it('refuses budget/approved before the plan is confirmed', () => {
    const rejection = rejectionOf(() => foldEvent(initialFoldState(), { type: 'budget/approved', approval: budget }))
    expect(rejection.code).toBe('SELF_DEV_INVALID_STATE')
    expect(rejection.message).toBe('budget/approved cannot apply in status draft')
  })

  it('refuses attempt/failed when no matching attempt is in flight', () => {
    const event = { type: 'attempt/failed' as const, attemptId: SelfDevAttemptId('attempt-gone'), reason: 'boom', failureDigest: 'f'.repeat(64), elapsedMs: 1, timeAccounting: 'measured' as const }
    const rejection = rejectionOf(() => foldEvent({ ...initialFoldState(), status: 'ready' }, event))
    expect(rejection.code).toBe('SELF_DEV_INVALID_STATE')
    expect(rejection.message).toBe('attempt/failed cannot apply without the in-flight attempt attempt-gone')
  })

  it('refuses a trial approval that does not bind the verified result digest', () => {
    const state = { ...initialFoldState(), status: 'awaiting-trial' as const, verifiedResultDigest: 'digest-a' }
    const rejection = rejectionOf(() => foldEvent(state, { type: 'trial/approved', approvedBy: 'user', resultDigest: 'digest-b' }))
    expect(rejection.code).toBe('SELF_DEV_INVALID_STATE')
    expect(rejection.message).toBe('trial approval does not bind the current verified result')
  })

  it('refuses task/stopped on a task that is already stopped', () => {
    const rejection = rejectionOf(() => foldEvent({ ...initialFoldState(), status: 'stopped' }, { type: 'task/stopped', reason: 'cancelled' }))
    expect(rejection.code).toBe('SELF_DEV_INVALID_STATE')
    expect(rejection.message).toBe('task/stopped cannot apply in status stopped')
  })

  it('refuses handoff/raised on a task that is already in handoff', () => {
    const state = { ...initialFoldState(), status: 'handoff' as const }
    const rejection = rejectionOf(() => foldEvent(state, { type: 'handoff/raised', reason: 'journal-corrupted', detail: 'tail' }))
    expect(rejection.code).toBe('SELF_DEV_INVALID_STATE')
    expect(rejection.message).toBe('task is already in handoff')
  })

  it('refuses a new attempt when no budget is approved', () => {
    expect(checkAttemptBudget(initialFoldState())).toEqual({ allowed: false, reason: 'no approved budget' })
  })

  it('refuses a new attempt while the time budget is frozen pending human review', () => {
    const state = { ...initialFoldState(), approval: budget, timeBudgetFrozen: true }
    expect(checkAttemptBudget(state)).toEqual({ allowed: false, reason: 'remaining time budget is frozen pending human review' })
  })
})

describe('journal verification', () => {
  it('reports the journal as unavailable when the task directory cannot be created', async () => {
    const { root } = await makeTaskDir()
    const blocker = join(root, 'blocker')
    await writeFile(blocker, 'not a directory')
    const rejection = await rejectionFrom(TaskJournal.open(join(blocker, 'tasks', TASK_ID), journalOptions))
    expect(rejection.code).toBe('SELF_DEV_JOURNAL_UNAVAILABLE')
    expect(rejection.message).toMatch(new RegExp(`cannot create task journal directory .*blocker.tasks.${TASK_ID}`))
  })

  it('refuses the append when the segment write makes no progress and still closes the handle', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    fault.zeroSegmentWrites = true
    const rejection = await rejectionFrom(journal.append({ type: 'task/planning-authorized', authorizedBy: 'user' }, undefined))
    expect(rejection.code).toBe('SELF_DEV_JOURNAL_UNAVAILABLE')
    expect(rejection.message).toMatch(/made no progress/)
    expect(fault.closedShortWriteHandle).toBe(true)
  })

  it('skips the directory flush on win32 while still persisting the segment record', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await withPlatform('win32', () => journal.append({ type: 'task/planning-authorized', authorizedBy: 'user' }, undefined))
    expect(fault.openPaths).not.toContain(dir)
    expect(fault.openPaths).toContain(join(dir, 'events.00000001.jsonl'))
    const line = await fault.actual.readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
    expect(JSON.parse(line)).toMatchObject({ seq: 1 })
  })

  it('continues sequence numbering when the segment listing is emptied during reopen', async () => {
    const { dir } = await makeTaskDir()
    const first = await TaskJournal.open(dir, journalOptions)
    const created = await first.append({ type: 'task/planning-authorized', authorizedBy: 'user' }, undefined)
    let listings = 0
    fault.overrides.readdir = async (path) => {
      listings += 1
      if (listings >= 2 && String(path) === dir) return []
      return fault.actual.readdir(String(path))
    }
    const reopened = await TaskJournal.open(dir, journalOptions)
    const next = await reopened.append({ type: 'task/stopped', reason: 'cancelled' }, undefined)
    expect(next.seq).toBe(2)
    fault.overrides.readdir = undefined
    const lines = (await fault.actual.readFile(join(dir, 'events.00000001.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!)).toMatchObject({ seq: 2, prevHash: created.hash })
    expect((await reopened.read()).records).toHaveLength(2)
  })

  it('reports the errno when the journal directory listing fails', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    fault.overrides.readdir = async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    }
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toMatch(/cannot list task journal \(EACCES\): Error: denied/)
  })

  it('reports an unknown error when the listing failure carries no errno', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    fault.overrides.readdir = async () => {
      throw new Error('listing exploded')
    }
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toMatch(/cannot list task journal \(unknown error\): Error: listing exploded/)
  })

  it('refuses a non-tail segment without a terminal newline as corrupt', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'events.00000001.jsonl'), recordLine({}).replace(/\n$/u, ''))
    await writeFile(join(dir, 'events.00000002.jsonl'), recordLine({ seq: 2, prevHash: '0'.repeat(64) }))
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('segment events.00000001.jsonl does not end with a terminal newline')
  })

  it('refuses a record line over the fixed byte bound', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'events.00000001.jsonl'), `x${'x'.repeat(1024 * 1024)}\n`)
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('segment events.00000001.jsonl line 1 is over the 1048576-byte record bound')
  })

  it('reports a malformed tail line as an incomplete tail', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'events.00000001.jsonl'), 'not json\n')
    const read = await journal.read()
    expect(read.status).toBe('incomplete-tail')
    expect(read.detail).toBe('segment events.00000001.jsonl ends in a partial record')
  })

  it('refuses a malformed record before the tail as corrupt', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'events.00000001.jsonl'), `not json\n${recordLine({})}`)
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('segment events.00000001.jsonl line 1 is not valid JSON')
  })

  it('refuses a segment over the fixed read bound without reading it', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'events.00000001.jsonl'), '')
    await truncate(join(dir, 'events.00000001.jsonl'), 256 * 1024 * 1024 + 1)
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('segment events.00000001.jsonl is 268435457 bytes, over the 268435456-byte read bound')
  })

  it('reports the errno when a segment cannot be stat-ed', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'events.00000001.jsonl'), recordLine({}))
    fault.overrides.lstat = async (path) => {
      if (String(path).endsWith('events.00000001.jsonl')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return fault.actual.lstat(String(path))
    }
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toMatch(/cannot read segment events\.00000001\.jsonl \(EACCES\): Error: denied/)
  })

  it('reports an unknown error when a segment stat failure carries no errno', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'events.00000001.jsonl'), recordLine({}))
    fault.overrides.lstat = async (path) => {
      if (String(path).endsWith('events.00000001.jsonl')) throw new Error('stat exploded')
      return fault.actual.lstat(String(path))
    }
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toMatch(/cannot read segment events\.00000001\.jsonl \(unknown error\): Error: stat exploded/)
  })

  it('refuses a checkpoint that is a directory instead of a regular file', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await mkdir(join(dir, 'checkpoint.json'))
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('Error: checkpoint is not a regular file (directory)')
  })

  // Creating symlinks on Windows requires developer mode or elevation.
  it.skipIf(process.platform === 'win32')('refuses a checkpoint that is a special file instead of a regular file', async () => {
    const { dir, root } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await symlink(join(root, 'missing-target'), join(dir, 'checkpoint.json'))
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('Error: checkpoint is not a regular file (special file)')
  })

  it('refuses a checkpoint over the state-file byte bound', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'checkpoint.json'), ' '.repeat(1024 * 1024 + 1))
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('Error: checkpoint is 1048577 bytes, over the 1048576-byte read bound')
  })

  it('reports the errno when the checkpoint cannot be read', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'checkpoint.json'), '{}\n')
    fault.overrides.readFile = async (path) => {
      if (String(path).endsWith('checkpoint.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return fault.actual.readFile(String(path))
    }
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('Error: checkpoint is unreadable (EACCES): Error: denied')
  })

  it('reports an unknown error when a checkpoint read failure carries no errno', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'checkpoint.json'), '{}\n')
    fault.overrides.readFile = async (path) => {
      if (String(path).endsWith('checkpoint.json')) throw new Error('read exploded')
      return fault.actual.readFile(String(path))
    }
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('Error: checkpoint is unreadable (unknown error): Error: read exploded')
  })

  it('refuses a checkpoint that is not valid JSON', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'checkpoint.json'), 'not json')
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toMatch(/^Error: checkpoint is not valid JSON: /)
  })

  it('refuses a checkpoint outside the journal schema', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'checkpoint.json'), JSON.stringify({ schemaVersion: TASK_JOURNAL_SCHEMA_VERSION + 1, seq: 1, hash: '0'.repeat(64), segment: 'events.00000001.jsonl' }))
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('Error: checkpoint does not satisfy the journal schema')
  })

  it('refuses a checkpoint whose hash does not match the committed record', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await journal.append({ type: 'task/planning-authorized', authorizedBy: 'user' }, undefined)
    await writeFile(join(dir, 'checkpoint.json'), JSON.stringify({ schemaVersion: TASK_JOURNAL_SCHEMA_VERSION, seq: 1, hash: 'f'.repeat(64), segment: 'events.00000001.jsonl' }, null, 2))
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('checkpoint hash does not match record 1')
  })

  it('names "unknown reason" when a refused read reports no detail', async () => {
    const { dir } = await makeTaskDir()
    const readSpy = vi.spyOn(TaskJournal.prototype, 'read')
      .mockResolvedValue({ status: 'corrupt', records: [], detail: undefined })
    // Restore the prototype spy even when the open unexpectedly resolves, so a
    // failing assertion cannot leak the mock into the following journal cases.
    const rejection = await (async () => {
      try {
        return await rejectionFrom(TaskJournal.open(dir, journalOptions))
      } finally {
        readSpy.mockRestore()
      }
    })()
    expect(rejection.code).toBe('SELF_DEV_JOURNAL_UNAVAILABLE')
    expect(rejection.message).toMatch(/task journal .* is not intact \(corrupt\): unknown reason/u)
  })

  it('refuses committed records that have no checkpoint', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await journal.append({ type: 'task/planning-authorized', authorizedBy: 'user' }, undefined)
    await rm(join(dir, 'checkpoint.json'))
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('journal holds 1 committed records without a checkpoint')
  })

  it('refuses a checkpoint that proves more records than the journal holds', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await journal.append({ type: 'task/planning-authorized', authorizedBy: 'user' }, undefined)
    await writeFile(join(dir, 'checkpoint.json'), JSON.stringify({ schemaVersion: TASK_JOURNAL_SCHEMA_VERSION, seq: 5, hash: '0'.repeat(64), segment: 'events.00000001.jsonl' }, null, 2))
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('checkpoint proves records through 5, journal ends at 1')
  })

  it('refuses a checkpoint over an empty journal', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'checkpoint.json'), JSON.stringify({ schemaVersion: TASK_JOURNAL_SCHEMA_VERSION, seq: 1, hash: '0'.repeat(64), segment: 'events.00000001.jsonl' }, null, 2))
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('checkpoint proves records through 1, journal ends at 0')
  })

  it('rotates onto a fresh segment when the record bound is already exhausted', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 0, checkpointInterval: 1 })
    const committed = await journal.append({ type: 'task/planning-authorized', authorizedBy: 'user' }, undefined)
    expect(committed.seq).toBe(1)
    const line = await fault.actual.readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
    expect(JSON.parse(line)).toMatchObject({ seq: 1, hash: committed.hash })
    expect((await journal.read()).status).toBe('ok')
  })

  it('reports the journal as unavailable when the segment cannot be appended', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await mkdir(join(dir, 'events.00000001.jsonl'))
    const rejection = await rejectionFrom(journal.append({ type: 'task/planning-authorized', authorizedBy: 'user' }, undefined))
    expect(rejection.code).toBe('SELF_DEV_JOURNAL_UNAVAILABLE')
    expect(rejection.message).toMatch(/cannot append to task journal .*events\.00000001\.jsonl/)
  })

  it('reports the projection as unavailable when it is not valid JSON', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'projection.json'), 'not json')
    const rejection = await rejectionFrom(journal.readProjection())
    expect(rejection.code).toBe('SELF_DEV_JOURNAL_UNAVAILABLE')
    expect(rejection.message).toMatch(/^projection file is not valid JSON: /)
  })

  it('refuses a journal line that is not a record object', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'events.00000001.jsonl'), 'null\n')
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('segment events.00000001.jsonl line 1 is not a record object')
  })

  it('refuses a record carrying an unknown schema version', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'events.00000001.jsonl'), recordLine({ schemaVersion: 99 }))
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('segment events.00000001.jsonl line 1 carries unknown schemaVersion')
  })

  it('refuses a record carrying an operation header outside the package schema', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'events.00000001.jsonl'), recordLine({ operation: {} }))
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('segment events.00000001.jsonl line 1 carries an invalid operation header')
  })

  it('refuses a record that breaks the hash chain', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, journalOptions)
    await writeFile(join(dir, 'events.00000001.jsonl'), recordLine({ prevHash: 'nope' }))
    const read = await journal.read()
    expect(read.status).toBe('corrupt')
    expect(read.detail).toBe('segment events.00000001.jsonl line 1 breaks the hash chain')
  })
})

describe('service journal handoff', () => {
  let context: Context | undefined
  let controlRoot: string | undefined

  afterEach(async () => {
    await context?.fiber.dispose()
    context = undefined
    if (controlRoot !== undefined) await rm(controlRoot, { recursive: true, force: true })
    controlRoot = undefined
  })

  /** Build the service against a fresh absolute control directory. */
  async function makeService(): Promise<{ service: SelfDevelopmentTasks; taskDir: (taskId: string) => string }> {
    controlRoot = await mkdtemp(join(tmpdir(), 'self-dev-coverage-'))
    context = new Context()
    const service = new SelfDevelopmentTasks(context, {
      controlDirectory: join(controlRoot, 'control'),
      maxRecordsPerSegment: 64,
      checkpointInterval: 4,
    })
    const root = controlRoot
    return { service, taskDir: taskId => join(root, 'control', 'tasks', taskId) }
  }

  it('drops the cached open promise when the journal refuses and re-verifies on the next open', async () => {
    const { service, taskDir } = await makeService()
    await mkdir(taskDir('broken-task'), { recursive: true })
    await writeFile(join(taskDir('broken-task'), 'events.00000001.jsonl'), 'not json\n')
    const clock = new FakeClock()
    const first = await rejectionFrom(service.open('broken-task', clock))
    expect(first.code).toBe('SELF_DEV_JOURNAL_UNAVAILABLE')
    expect(first.message).toMatch(/is not intact \(incomplete-tail\)/)
    await expect(service.open('broken-task', clock)).rejects.toBeInstanceOf(SelfDevelopmentError)
    await rm(join(taskDir('broken-task'), 'events.00000001.jsonl'))
    const controller = await service.open('broken-task', clock)
    expect(controller.projection).toMatchObject({ status: 'draft', revision: 0 })
  })

  it('classifies journal refusals for handoff surfacing', async () => {
    const { service, taskDir } = await makeService()
    await mkdir(taskDir('handoff-task'), { recursive: true })
    await writeFile(join(taskDir('handoff-task'), 'events.00000001.jsonl'), 'not json\n')
    const refused = await service.open('handoff-task', new FakeClock()).then(() => undefined, (error: unknown) => error)
    expect(service.isJournalHandoff(refused)).toBe(true)
    expect(service.isJournalHandoff(new SelfDevelopmentError('other boundary', 'SELF_DEV_INVALID_OPERATION'))).toBe(false)
    expect(service.isJournalHandoff(new Error('unrelated'))).toBe(false)
  })
})
