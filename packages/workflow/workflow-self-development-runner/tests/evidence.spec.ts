/**
 * Attempt evidence and outcomes: path derivation, strict validation of every
 * stored field, durable republication, and the diagnostic-record rule that
 * evidence without an outcome file never asserts a passed core log.
 * @module evidence.spec
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TestResult } from '@deepseek-ai/dsh-workflow-self-development'
import { attemptEvidencePath, readAttemptEvidence, writeAttemptEvidence, writeAttemptOutcome } from '../src/evidence.ts'
import type { AttemptEvidence, AttemptOutcome } from '../src/evidence.ts'
import { SelfDevelopmentRunnerError } from '../src/runtime.ts'

const BOOT_ID = 'a'.repeat(64)
const ATTEMPT = 'f'.repeat(64)
const DIGEST_SOURCE = '1'.repeat(64)
const DIGEST_ARTIFACT = '2'.repeat(64)
const ACCEPTANCE_DIGEST = '3'.repeat(64)

const TASK = 'task-1'

const executor = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
  stepsUsed: 3,
  stepCapHit: false,
  stdoutCapHit: false,
  stdoutTruncated: false,
  durationMs: 1200,
  sessionId: 'session-1',
  finalText: 'done',
  stderrTail: '',
}

const result = {
  taskId: TASK,
  attemptId: ATTEMPT,
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
  cases: [],
} as unknown as TestResult

const evidence: AttemptEvidence = {
  schemaVersion: 1,
  taskId: TASK,
  attemptId: ATTEMPT,
  operationId: 'op-1',
  capabilitySource: 'human-presence',
  launch: { sourceDigest: DIGEST_SOURCE, artifactDigest: DIGEST_ARTIFACT },
  sandbox: { kind: 'disabled' },
  tested: { sourceDigest: DIGEST_SOURCE, artifactDigest: DIGEST_ARTIFACT },
  afterAcceptance: undefined,
  contentStable: false,
  acceptanceDefinitionDigest: ACCEPTANCE_DIGEST,
  executor,
  acceptance: undefined,
  phases: [{ phaseId: 'develop', durationMs: 900 }, { phaseId: 'accept', durationMs: 300 }],
  result,
  recordedAt: { bootId: BOOT_ID, monotonicMs: 400 },
}

const outcome: AttemptOutcome = {
  schemaVersion: 1,
  attemptId: ATTEMPT,
  committed: 'passed',
  revision: 7,
  error: undefined,
}

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Create one fresh temporary evidence root for a test. */
async function tempRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-evidence-'))
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

/** Write one mutated copy of the pristine evidence to the evidence path and re-read it. */
async function storedEvidenceWith(mutation: (stored: Record<string, unknown>) => void): Promise<unknown> {
  const path = attemptEvidencePath(root as string, TASK, ATTEMPT)
  const stored = JSON.parse(JSON.stringify(evidence)) as Record<string, unknown>
  mutation(stored)
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`)
  return readAttemptEvidence(root as string, TASK, ATTEMPT)
}

/** Write a raw string to the outcome file and re-read the attempt. */
async function storedRawOutcome(content: string): Promise<unknown> {
  const path = join(attemptEvidencePath(root as string, TASK, ATTEMPT), '..', `${ATTEMPT}.outcome.json`)
  await writeFile(path, content)
  return readAttemptEvidence(root as string, TASK, ATTEMPT)
}

/** Assert one mutated evidence field makes the stored record invalid. */
async function expectEvidenceTamperInvalid(mutation: (stored: Record<string, unknown>) => void): Promise<void> {
  const error = await expectInvalid(() => storedEvidenceWith(mutation))
  expect(error.code).toBe('SELF_DEV_RUNNER_EVIDENCE_INVALID')
}

/** Assert one mutated outcome field makes the stored outcome invalid. */
async function expectOutcomeTamperInvalid(mutation: (stored: Record<string, unknown>) => void): Promise<void> {
  const stored = JSON.parse(JSON.stringify(outcome)) as Record<string, unknown>
  mutation(stored)
  const error = await expectInvalid(async () => writeAttemptOutcome(root as string, TASK, stored as unknown as AttemptOutcome))
  expect(error.code).toBe('SELF_DEV_RUNNER_EVIDENCE_INVALID')
}

describe('attemptEvidencePath', () => {
  it('derives the documented evidence path', () => {
    expect(attemptEvidencePath('/evidence', TASK, ATTEMPT)).toBe(`/evidence/tasks/${TASK}/attempts/${ATTEMPT}.json`)
  })

  it('rejects invalid ids and a relative root without creating anything', async () => {
    const base = await tempRoot()
    for (const attemptId of ['xyz', ATTEMPT.slice(1), ATTEMPT.toUpperCase(), '../x', 5 as unknown as string]) {
      await expectInvalid(async () => attemptEvidencePath(base, TASK, attemptId))
    }
    await expectInvalid(async () => attemptEvidencePath(base, '../x', ATTEMPT))
    await expectInvalid(async () => attemptEvidencePath('relative-root', TASK, ATTEMPT))
    await expect(readdir(base)).resolves.toEqual([])
  })
})

describe('writeAttemptEvidence and readAttemptEvidence', () => {
  it('round-trips evidence without an outcome as an undecided diagnostic record', async () => {
    const base = await tempRoot()
    await expect(writeAttemptEvidence(base, evidence)).resolves.toBe('written')
    await expect(writeAttemptEvidence(base, evidence)).resolves.toBe('unchanged')
    const read = await readAttemptEvidence(base, TASK, ATTEMPT)
    expect(read).toEqual({ evidence, outcome: undefined })
    expect(read?.evidence.phases).not.toBe(evidence.phases)
  })

  it('round-trips evidence recording an enabled seatbelt sandbox by its profile digest', async () => {
    const base = await tempRoot()
    const sandboxed = { ...evidence, sandbox: { kind: 'seatbelt' as const, profileDigest: 'b'.repeat(64) } }
    await writeAttemptEvidence(base, sandboxed)
    await expect(readAttemptEvidence(base, TASK, ATTEMPT)).resolves.toEqual({ evidence: sandboxed, outcome: undefined })
  })

  it('writes the outcome beside the evidence and round-trips it', async () => {
    const base = await tempRoot()
    await writeAttemptEvidence(base, evidence)
    await expect(writeAttemptOutcome(base, TASK, outcome)).resolves.toBe('written')
    await expect(writeAttemptOutcome(base, TASK, outcome)).resolves.toBe('unchanged')
    const attempts = await readdir(join(base, 'tasks', TASK, 'attempts'))
    expect(attempts).toEqual([`${ATTEMPT}.json`, `${ATTEMPT}.outcome.json`])
    await expect(readAttemptEvidence(base, TASK, ATTEMPT)).resolves.toEqual({ evidence, outcome })
  })

  it('rejects a different evidence or outcome at the same path with a conflict', async () => {
    const base = await tempRoot()
    await writeAttemptEvidence(base, evidence)
    const conflict = expect(writeAttemptEvidence(base, { ...evidence, contentStable: true })).rejects.toMatchObject({
      code: 'SELF_DEV_RUNNER_EVIDENCE_CONFLICT',
    })
    await conflict
    await writeAttemptOutcome(base, TASK, outcome)
    await expect(writeAttemptOutcome(base, TASK, { ...outcome, committed: 'failed' })).rejects.toMatchObject({
      code: 'SELF_DEV_RUNNER_EVIDENCE_CONFLICT',
    })
  })

  it('returns undefined when no evidence exists', async () => {
    const base = await tempRoot()
    await expect(readAttemptEvidence(base, TASK, ATTEMPT)).resolves.toBeUndefined()
  })

  it('rejects invalid write payloads without creating directories', async () => {
    const base = await tempRoot()
    await expectInvalid(async () => writeAttemptEvidence(base, { ...evidence, attemptId: 'not-hex' }))
    await expectInvalid(async () => writeAttemptOutcome(base, TASK, { ...outcome, committed: 'weird' as AttemptOutcome['committed'] }))
    await expect(readdir(base)).resolves.toEqual([])
  })

  it('rejects tampered stored evidence with SELF_DEV_RUNNER_EVIDENCE_INVALID', async () => {
    const base = await tempRoot()
    await writeAttemptEvidence(base, evidence)
    await expectEvidenceTamperInvalid((stored) => { stored.schemaVersion = 2 })
    await expectEvidenceTamperInvalid((stored) => { stored.capabilitySource = 'unattended' })
    await expectEvidenceTamperInvalid((stored) => { stored.contentStable = 'yes' })
    await expectEvidenceTamperInvalid((stored) => { stored.launch = { ...evidence.launch, sourceDigest: 'abc' } })
    await expectEvidenceTamperInvalid((stored) => { stored.launch = 5 })
    await expectEvidenceTamperInvalid((stored) => { delete stored.sandbox })
    await expectEvidenceTamperInvalid((stored) => { stored.sandbox = null })
    await expectEvidenceTamperInvalid((stored) => { stored.sandbox = { kind: 'unattended' } })
    await expectEvidenceTamperInvalid((stored) => { stored.sandbox = { kind: 'seatbelt' } })
    await expectEvidenceTamperInvalid((stored) => { stored.sandbox = { kind: 'seatbelt', profileDigest: 'not-hex' } })
    await expectEvidenceTamperInvalid((stored) => { stored.tested = { ...evidence.tested, artifactDigest: null } })
    await expectEvidenceTamperInvalid((stored) => { stored.afterAcceptance = { sourceDigest: 'x' } })
    await expectEvidenceTamperInvalid((stored) => { stored.executor = null })
    await expectEvidenceTamperInvalid((stored) => { delete stored.result })
    await expectEvidenceTamperInvalid((stored) => { stored.acceptance = 5 })
    await expectEvidenceTamperInvalid((stored) => { stored.acceptance = null })
    await expectEvidenceTamperInvalid((stored) => { stored.phases = 'develop' })
    await expectEvidenceTamperInvalid((stored) => { stored.phases = [5] })
    await expectEvidenceTamperInvalid((stored) => { stored.phases = [{ phaseId: '', durationMs: 1 }] })
    await expectEvidenceTamperInvalid((stored) => { stored.phases = [{ phaseId: 'develop', durationMs: -1 }] })
    await expectEvidenceTamperInvalid((stored) => { stored.phases = [{ phaseId: 'develop', durationMs: Number.POSITIVE_INFINITY }] })
    await expectEvidenceTamperInvalid((stored) => { stored.acceptanceDefinitionDigest = 'short' })
    await expectEvidenceTamperInvalid((stored) => { stored.recordedAt = { bootId: BOOT_ID, monotonicMs: -1 } })
    await expectEvidenceTamperInvalid((stored) => { stored.recordedAt = { bootId: 'zz', monotonicMs: 1 } })
    await expectEvidenceTamperInvalid((stored) => { stored.recordedAt = { bootId: 5, monotonicMs: 1 } })
    await expectEvidenceTamperInvalid((stored) => { stored.recordedAt = 5 })
    await expectEvidenceTamperInvalid((stored) => { stored.attemptId = 'a'.repeat(64) })
    await expectEvidenceTamperInvalid((stored) => { stored.operationId = '../bad' })
    await expectEvidenceTamperInvalid((stored) => { stored.taskId = 'task-2' })
    await expectEvidenceTamperInvalid((stored) => { stored.attemptId = 'e'.repeat(64) })
    await expectEvidenceTamperInvalid((stored) => { stored.taskId = 5 })
    await expectEvidenceTamperInvalid((stored) => { stored.operationId = 5 })
    const raw = attemptEvidencePath(base, TASK, ATTEMPT)
    await writeFile(raw, 'null\n')
    await expectInvalid(async () => readAttemptEvidence(base, TASK, ATTEMPT))
  })

  it('rejects an invalid outcome file with SELF_DEV_RUNNER_EVIDENCE_INVALID', async () => {
    const base = await tempRoot()
    await writeAttemptEvidence(base, evidence)
    await writeAttemptOutcome(base, TASK, outcome)
    await expectInvalid(async () => storedRawOutcome('{not json'))
    await expectInvalid(async () => storedRawOutcome('null\n'))
    await expectInvalid(async () => storedRawOutcome(`${JSON.stringify({ ...outcome, attemptId: 'e'.repeat(64) })}\n`))
    await expectInvalid(async () => storedRawOutcome(`${JSON.stringify({ ...outcome, schemaVersion: 2 })}\n`))
    await expectOutcomeTamperInvalid((stored) => { stored.committed = 'weird' })
    await expectOutcomeTamperInvalid((stored) => { stored.revision = -1 })
    await expectOutcomeTamperInvalid((stored) => { stored.revision = 1.5 })
    await expectOutcomeTamperInvalid((stored) => { stored.error = 'boom' })
    await expectOutcomeTamperInvalid((stored) => { stored.error = { code: 5, message: 'boom' } })
    await expectOutcomeTamperInvalid((stored) => { stored.error = { code: 'X' } })
    await expectOutcomeTamperInvalid((stored) => { stored.attemptId = 'not-hex' })
  })

  it('round-trips an outcome that records a failure with an error', async () => {
    const base = await tempRoot()
    await writeAttemptEvidence(base, evidence)
    const failed = { ...outcome, committed: 'failed' as const, revision: undefined, error: { code: 'X', message: 'boom' } }
    await writeAttemptOutcome(base, TASK, failed)
    await expect(readAttemptEvidence(base, TASK, ATTEMPT)).resolves.toEqual({ evidence, outcome: failed })
  })
})
