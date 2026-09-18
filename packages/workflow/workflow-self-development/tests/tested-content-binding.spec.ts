/**
 * Tested-content binding: a passing report carries the digests of what the
 * runner actually tested plus the acceptance definition it executed, and
 * those digests — not the launch-input digests alone — are what `task/passed`
 * and a human trial approval bind.
 * @module tested-content-binding.spec
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { freezeTestPlan, verifyAttemptResult } from '../src/domain.ts'
import { parseInput, testResultSchema } from '../src/schema.ts'
import {
  AcceptanceDefinitionDigest,
  ArtifactDigest,
  CapabilityDigest,
  SelfDevAttemptId,
  SourceDigest,
  TaskSpecVersion,
  digestJson,
} from '../src/runtime.ts'
import {
  ACCEPTANCE_DEFINITION,
  ARTIFACT,
  BUDGET_ONE_ROUND,
  PLAN,
  SOURCE,
  SPEC,
  TASK_ID,
  TESTED_ARTIFACT,
  TESTED_SOURCE,
  fullCapabilitySource,
  header,
  makeTaskDir,
  openReadyTask,
  passingResult,
  resultWith,
} from './helpers.ts'
import type { Attempt, TestPlanDigest, TestResult } from '../src/types.ts'

/** Last journal record parsed from disk. */
interface StoredRecord { event: { type: string; resultDigest?: string } }

/** Parse every journal record from one segment. */
function records(text: string): StoredRecord[] {
  return text.trim().split('\n').map(line => JSON.parse(line) as StoredRecord)
}

/** A copy of the report with one top-level field removed. */
function omit(report: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(report).filter(([key]) => key !== field))
}

/** A schema-valid result whose tested-content digests differ from the launch inputs. */
function typedResult(attempt: Attempt, patch: Partial<TestResult> = {}): TestResult {
  return {
    taskId: TASK_ID,
    attemptId: attempt.attemptId,
    sourceDigest: attempt.sourceDigest,
    artifactDigest: attempt.artifactDigest,
    testedSourceDigest: SourceDigest(TESTED_SOURCE),
    testedArtifactDigest: ArtifactDigest(TESTED_ARTIFACT),
    acceptanceDefinitionDigest: AcceptanceDefinitionDigest(ACCEPTANCE_DEFINITION),
    testPlanDigest: attempt.testPlanDigest,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    cases: [{ caseId: 'c1', assertions: [{ assertionId: 'a1', status: 'pass' }] }],
    ...patch,
  }
}

/** One attempt whose launch-input digests match the digest constants. */
function makeAttempt(planDigest: TestPlanDigest): Attempt {
  return {
    attemptId: SelfDevAttemptId('attempt-binding'),
    attemptNumber: 1,
    startedAt: { bootId: 'boot-1', monotonicMs: 1000 },
    testPlanDigest: planDigest,
    sourceDigest: SourceDigest(SOURCE),
    artifactDigest: ArtifactDigest(ARTIFACT),
    capabilityDigest: CapabilityDigest('d'.repeat(64)),
    capabilitySource: 'machine',
  }
}

describe('tested-content binding', () => {
  it('passes a report whose tested digests differ from the launch-input digests', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, BUDGET_ONE_ROUND, fullCapabilitySource)
    await controller.startAttempt({
      ...header(revision, 'attempt-tested'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async (attempt) => {
        const report = passingResult(attempt)
        expect(report.testedSourceDigest).not.toEqual(attempt.sourceDigest)
        expect(report.testedArtifactDigest).not.toEqual(attempt.artifactDigest)
        return report
      },
    })
    expect(controller.projection.status).toBe('awaiting-trial')
    expect(controller.projection.verifiedResultDigest).toBeDefined()
  })

  it('computes a different result digest when any tested-content digest changes', () => {
    const spec = { ...SPEC, taskId: TASK_ID, version: TaskSpecVersion(1) }
    const frozen = freezeTestPlan({ ...PLAN, taskSpecVersion: TaskSpecVersion(1) }, spec)
    const attempt = makeAttempt(frozen.digest)
    const baseline = verifyAttemptResult({ taskId: TASK_ID, attempt, plan: frozen, result: typedResult(attempt) })
    const changed: readonly [string, Partial<TestResult>][] = [
      ['testedSourceDigest', { testedSourceDigest: SourceDigest('1'.repeat(64)) }],
      ['testedArtifactDigest', { testedArtifactDigest: ArtifactDigest('2'.repeat(64)) }],
      ['acceptanceDefinitionDigest', { acceptanceDefinitionDigest: AcceptanceDefinitionDigest('3'.repeat(64)) }],
    ]
    for (const [field, patch] of changed) {
      const digest = verifyAttemptResult({ taskId: TASK_ID, attempt, plan: frozen, result: typedResult(attempt, patch) })
      expect(digest, field).not.toBe(baseline)
    }
  })

  it('binds the manual trial approval to the digest over the exact reported content', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, BUDGET_ONE_ROUND, fullCapabilitySource)
    let reported: Record<string, unknown> | undefined
    await controller.startAttempt({
      ...header(revision, 'attempt-trial'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async (attempt) => {
        reported = passingResult(attempt)
        return reported
      },
    })
    // The stored digest covers the report as received, tested-content digests
    // included. The controller digests the schema-parsed report, whose key
    // order follows the schema, so the expectation parses the same way.
    const bound = digestJson(parseInput(testResultSchema, 'test result', reported))
    expect(controller.projection.verifiedResultDigest).toBe(bound)
    await controller.recordTrialApproval({ ...header(controller.projection.revision, 'trial'), approvedBy: 'user' })
    expect(controller.projection.trialApproval?.resultDigest).toBe(bound)
    const line = await readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
    const passed = records(line).find(record => record.event.type === 'task/passed')
    expect(passed?.event.resultDigest).toBe(bound)
  })

  it('rejects a report missing a tested-content digest before any task/passed', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller } = await openReadyTask(dir, clock, { ...BUDGET_ONE_ROUND, maxRounds: 3 }, fullCapabilitySource)
    const fields = ['testedSourceDigest', 'testedArtifactDigest', 'acceptanceDefinitionDigest'] as const
    for (const [index, field] of fields.entries()) {
      const rejection = controller.startAttempt({
        ...header(controller.projection.revision, `attempt-missing-${field}`),
        sourceDigest: SOURCE,
        artifactDigest: ARTIFACT,
        sideEffect: async attempt => omit(passingResult(attempt), field),
      })
      await expect(rejection, field).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_OPERATION' })
      expect(controller.projection.status, field).not.toBe('awaiting-trial')
      expect(controller.projection.verifiedResultDigest, field).toBeUndefined()
      expect(controller.projection.consumedRounds, field).toBe(index + 1)
    }
    const line = await readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
    expect(records(line).some(record => record.event.type === 'task/passed')).toBe(false)
  })

  it.each(['testedSourceDigest', 'testedArtifactDigest', 'acceptanceDefinitionDigest'].flatMap(field => [
    [field, 'uppercase hex', 'E'.repeat(64)],
    [field, 'a 63-character digest', 'e'.repeat(63)],
    [field, 'a non-hex digest', `x${'e'.repeat(63)}`],
  ] as const))('rejects a report whose %s is %s', async (field, _name, damaged) => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, { ...BUDGET_ONE_ROUND, maxRounds: 2 }, fullCapabilitySource)
    await expect(controller.startAttempt({
      ...header(revision, 'attempt-damaged'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async attempt => resultWith(attempt, { [field]: damaged }),
    })).rejects.toMatchObject({ code: 'SELF_DEV_INVALID_OPERATION' })
    expect(controller.projection.verifiedResultDigest).toBeUndefined()
  })
})
