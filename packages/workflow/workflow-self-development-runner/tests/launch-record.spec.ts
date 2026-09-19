/**
 * Operation-bound launch records: path derivation, strict validation of every
 * stored field, byte-identical republication, and the guarantee that invalid
 * ids or records never create a directory.
 * @module launch-record.spec
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launchRecordPath, readLaunchRecord, writeLaunchRecord } from '../src/launch-record.ts'
import type { LaunchRecord } from '../src/launch-record.ts'
import type { PresenceConfirmation } from '../src/presence.ts'
import { SelfDevelopmentRunnerError } from '../src/runtime.ts'

const BOOT_ID = 'a'.repeat(64)
const PLAN_DIGEST = 'b'.repeat(64)
const ACCEPTANCE_DIGEST = 'c'.repeat(64)
const SOURCE_DIGEST = 'd'.repeat(64)
const ARTIFACT_DIGEST = 'e'.repeat(64)

const TASK = 'task-1'
const OPERATION = 'op-1'

const presence: PresenceConfirmation = {
  confirmedBy: 'operator-1',
  confirmedAt: { bootId: BOOT_ID, monotonicMs: 100 },
  worktree: '/experiments/wt-1',
  loopbackAllowlist: [4173],
  acknowledgement: 'supervised-not-unattended',
  taskId: TASK,
  testPlanDigest: PLAN_DIGEST,
  acceptanceDefinitionDigest: ACCEPTANCE_DIGEST,
  artifactPaths: ['dist/cli.js'],
}

const record: LaunchRecord = {
  schemaVersion: 1,
  taskId: TASK,
  operationId: OPERATION,
  expectedRevision: 3,
  worktreeReal: '/experiments/wt-1',
  artifactPaths: ['dist/cli.js', 'lib'],
  acceptancePath: '/stable/acceptance.md',
  acceptanceDefinitionDigest: ACCEPTANCE_DIGEST,
  testPlanDigest: PLAN_DIGEST,
  sourceDigest: SOURCE_DIGEST,
  artifactDigest: ARTIFACT_DIGEST,
  budget: { phaseMs: 60_000, totalRemainingMs: undefined, maxSteps: 40 },
  presence,
  recordedAt: { bootId: BOOT_ID, monotonicMs: 200 },
}

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Create one fresh temporary evidence root for a test. */
async function tempRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-launch-record-'))
  return root
}

/** Expect a boundary rejection and return it for code assertions. */
async function expectInvalid(run: () => Promise<unknown>): Promise<SelfDevelopmentRunnerError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(SelfDevelopmentRunnerError)
    return error as SelfDevelopmentRunnerError
  }
  throw new Error('expected a SELF_DEV_RUNNER_EVIDENCE_INVALID rejection')
}

/** Write one mutated copy of the pristine record to the record path and re-read it. */
async function storedWith(mutation: (stored: Record<string, unknown>) => void): Promise<unknown> {
  const path = launchRecordPath(root as string, TASK, OPERATION)
  const stored = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
  mutation(stored)
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`)
  return readLaunchRecord(root as string, TASK, OPERATION)
}

/** Assert one mutated field makes the stored record invalid. */
async function expectTamperInvalid(mutation: (stored: Record<string, unknown>) => void): Promise<void> {
  const error = await expectInvalid(() => storedWith(mutation))
  expect(error.code).toBe('SELF_DEV_RUNNER_EVIDENCE_INVALID')
}

describe('launchRecordPath', () => {
  it('derives the documented record path', () => {
    expect(launchRecordPath('/evidence', 'task-1', 'op-1')).toBe('/evidence/tasks/task-1/launches/op-1.json')
  })

  it('rejects an invalid task id, operation id, or relative root without creating anything', async () => {
    const base = await tempRoot()
    const empty = join(base, 'probe')
    await mkdir(empty)
    for (const taskId of ['../x', '', 'x'.repeat(65)]) {
      await expectInvalid(async () => launchRecordPath(base, taskId, OPERATION))
    }
    for (const operationId of ['../bad', '.hidden', 'has space', `${'a'.repeat(128)}b`]) {
      await expectInvalid(async () => launchRecordPath(base, TASK, operationId))
    }
    await expectInvalid(async () => launchRecordPath('relative-root', TASK, OPERATION))
    await expect(readReaddir(empty)).resolves.toEqual([])
  })

  /** readdir wrapper that keeps the loop above readable. */
  function readReaddir(directory: string): Promise<string[]> {
    return readdir(directory)
  }
})

describe('writeLaunchRecord and readLaunchRecord', () => {
  it('round-trips a record through the durable writer', async () => {
    const base = await tempRoot()
    await expect(writeLaunchRecord(base, record)).resolves.toBe('written')
    await expect(writeLaunchRecord(base, record)).resolves.toBe('unchanged')
    const read = await readLaunchRecord(base, TASK, OPERATION)
    expect(read).toEqual(record)
    expect(read?.presence).not.toBe(presence)
    expect(read?.artifactPaths).not.toBe(record.artifactPaths)
  })

  it('returns undefined when no record exists', async () => {
    const base = await tempRoot()
    await expect(readLaunchRecord(base, TASK, OPERATION)).resolves.toBeUndefined()
  })

  it('rejects a different record at the same path with a conflict', async () => {
    const base = await tempRoot()
    await writeLaunchRecord(base, record)
    await expect(writeLaunchRecord(base, { ...record, expectedRevision: 4 })).rejects.toMatchObject({
      code: 'SELF_DEV_RUNNER_EVIDENCE_CONFLICT',
    })
  })

  it('rejects writes of structurally invalid records without creating directories', async () => {
    const base = await tempRoot()
    await expectInvalid(async () => writeLaunchRecord(base, { ...record, expectedRevision: -1 }))
    await expectInvalid(async () => writeLaunchRecord(base, { ...record, taskId: '../x' }))
    await expect(readdir(base)).resolves.toEqual([])
  })

  it('rejects tampered stored records with SELF_DEV_RUNNER_EVIDENCE_INVALID', async () => {
    const base = await tempRoot()
    await writeLaunchRecord(base, record)
    await expectTamperInvalid((stored) => { stored.sourceDigest = 'abc' })
    await expectTamperInvalid((stored) => { stored.sourceDigest = 42 })
    await expectTamperInvalid((stored) => { stored.artifactPaths = ['lib', 'dist/cli.js'] })
    await expectTamperInvalid((stored) => { stored.artifactPaths = ['a', 'a'] })
    await expectTamperInvalid((stored) => { stored.artifactPaths = 5 })
    await expectTamperInvalid((stored) => { stored.artifactPaths = ['/abs'] })
    await expectTamperInvalid((stored) => { stored.artifactPaths = ['a//b'] })
    await expectTamperInvalid((stored) => { stored.artifactPaths = ['a/./b'] })
    await expectTamperInvalid((stored) => { stored.artifactPaths = ['a/../b'] })
    await expectTamperInvalid((stored) => { stored.artifactPaths = [''] })
    await expectTamperInvalid((stored) => { stored.artifactPaths = [5] })
    await expectTamperInvalid((stored) => { stored.artifactPaths = ['lib', 'dist/cli.js', 'lib'] })
    await expectTamperInvalid((stored) => { delete stored.budget })
    await expectTamperInvalid((stored) => { stored.budget = 5 })
    await expectTamperInvalid((stored) => { stored.budget = { ...record.budget, phaseMs: -1 } })
    await expectTamperInvalid((stored) => { stored.budget = { ...record.budget, phaseMs: null } })
    await expectTamperInvalid((stored) => { stored.schemaVersion = 2 })
    await expectTamperInvalid((stored) => { stored.presence = { ...presence, acknowledgement: 'unattended' } })
    await expectTamperInvalid((stored) => { stored.presence = 'operator-1' })
    await expectTamperInvalid((stored) => { stored.expectedRevision = 1.5 })
    await expectTamperInvalid((stored) => { stored.expectedRevision = -1 })
    await expectTamperInvalid((stored) => { stored.worktreeReal = 'experiments/wt-1' })
    await expectTamperInvalid((stored) => { stored.worktreeReal = 5 })
    await expectTamperInvalid((stored) => { stored.dshHomeReal = 'experiments/dsh-home' })
    await expectTamperInvalid((stored) => { stored.dshHomeReal = 5 })
    await expectTamperInvalid((stored) => { stored.acceptancePath = 'stable/acceptance.md' })
    await expectTamperInvalid((stored) => { stored.operationId = 5 })
    await expectTamperInvalid((stored) => { stored.recordedAt = { bootId: 'zz', monotonicMs: 1 } })
    await expectTamperInvalid((stored) => { stored.recordedAt = { bootId: BOOT_ID, monotonicMs: -1 } })
    await expectTamperInvalid((stored) => { stored.recordedAt = { bootId: BOOT_ID, monotonicMs: 1.5 } })
    await expectTamperInvalid((stored) => { stored.recordedAt = 5 })
    await expectTamperInvalid((stored) => { stored.operationId = 'op-2' })
    await expectTamperInvalid((stored) => { stored.taskId = 'task-2' })
    await expectTamperInvalid((stored) => { stored.taskId = 5 })
  })

  it('rejects a record whose budget carries a non-finite field at write time', async () => {
    const base = await tempRoot()
    await expectInvalid(async () => writeLaunchRecord(base, {
      ...record,
      budget: { phaseMs: Number.POSITIVE_INFINITY, totalRemainingMs: undefined, maxSteps: undefined },
    }))
  })

  it('rejects a null or scalar stored record', async () => {
    const base = await tempRoot()
    await writeLaunchRecord(base, record)
    const path = launchRecordPath(base, TASK, OPERATION)
    await writeFile(path, 'null\n')
    await expectInvalid(async () => readLaunchRecord(base, TASK, OPERATION))
    await writeFile(path, '42\n')
    await expectInvalid(async () => readLaunchRecord(base, TASK, OPERATION))
  })

  it('round-trips a record whose budget carries no limits', async () => {
    const base = await tempRoot()
    const emptyBudget = { phaseMs: undefined, totalRemainingMs: undefined, maxSteps: undefined }
    await writeLaunchRecord(base, { ...record, budget: emptyBudget })
    await expect(readLaunchRecord(base, TASK, OPERATION)).resolves.toEqual({ ...record, budget: emptyBudget })
  })

  it('round-trips a record that carries a data directory and keeps the field absent otherwise', async () => {
    const base = await tempRoot()
    const withDataHome = { ...record, dshHomeReal: '/experiments/task-1/dsh-home' }
    await writeLaunchRecord(base, withDataHome)
    await expect(readLaunchRecord(base, TASK, OPERATION)).resolves.toEqual(withDataHome)
    const withoutDataHome = await tempRoot()
    await writeLaunchRecord(withoutDataHome, record)
    const read = await readLaunchRecord(withoutDataHome, TASK, OPERATION)
    expect(read).toEqual(record)
    expect('dshHomeReal' in (read as object)).toBe(false)
  })
})
