/**
 * Unit mapping from one durable `self-development/committed` payload to the
 * unified notification event: the kind per durable event type, the
 * decision-status fall-through, and titles that stay free of reason text.
 * @module mapping.spec
 */

import { describe, expect, it } from 'vitest'
import {
  ArtifactDigest,
  CapabilityDigest,
  SelfDevAttemptId,
  SelfDevTaskId,
  SourceDigest,
  TaskSpecVersion,
  TestPlanDigest,
  TestPlanVersion,
} from '@deepseek-ai/dsh-workflow-self-development'
import { mapCommittedToEvent } from '../src/mapping.ts'
import type { CommittedPayload } from '../src/mapping.ts'
import type { Attempt, CommittedRecord, TaskEvent, TaskProjection, TaskSpec } from '@deepseek-ai/dsh-workflow-self-development'

/** Host-clock stub: every event observes the same fixed instant. */
const now = (): number => 1_700_000_000_000

/** A minimal frozen-plan stand-in carrying only the branded identity fields. */
const PLAN = {
  testPlanId: 'plan-1',
  version: TestPlanVersion(1),
  taskSpecVersion: TaskSpecVersion(1),
  requiredCases: [],
  manualCases: [],
  digest: TestPlanDigest('d'.repeat(64)),
} as const

/** A minimal in-flight attempt stand-in carrying the branded launch identity. */
const ATTEMPT: Attempt = {
  attemptId: SelfDevAttemptId('a1'),
  attemptNumber: 1,
  startedAt: { bootId: 'boot-1', monotonicMs: 1000 },
  testPlanDigest: PLAN.digest,
  sourceDigest: SourceDigest('b'.repeat(64)),
  artifactDigest: ArtifactDigest('c'.repeat(64)),
  capabilityDigest: CapabilityDigest('d'.repeat(64)),
  capabilitySource: 'machine',
}

/** A minimal BudgetApproval stand-in. */
const BUDGET = {
  mode: 'rounds',
  maxRounds: 1,
  phaseTimeoutMs: 60000,
  maxStepsPerAttempt: 50,
  testPlanVersion: TestPlanVersion(1),
  taskSpecVersion: TaskSpecVersion(1),
  approvedBy: 'user',
} as const

/** A minimal TaskSpec stand-in. */
const SPEC: TaskSpec = {
  taskId: SelfDevTaskId('task-1'),
  version: TaskSpecVersion(1),
  requirement: 'add chat transcript search',
  allowedModificationScope: ['src'],
  stableBaselineDigest: 'a'.repeat(64),
  createdBy: 'user',
}

/** A projection standing in for the fold output; tests override what they assert on. */
function projection(overrides: Partial<TaskProjection> = {}): TaskProjection {
  return {
    status: 'ready',
    spec: undefined,
    plan: undefined,
    approval: undefined,
    planningAuthorized: false,
    consumedRounds: 1,
    consumedTimeMs: 0,
    timeBudgetFrozen: false,
    currentAttempt: undefined,
    verifiedResultDigest: undefined,
    trialApproval: undefined,
    noProgressCount: 0,
    stopReason: undefined,
    handoffReason: undefined,
    handoffDetail: undefined,
    revision: 7,
    ...overrides,
  }
}

/** A committed record wrapping one event; identity fields are irrelevant to the mapping. */
function record(event: TaskEvent, seq = 1): CommittedRecord {
  return { schemaVersion: 1, seq, prevHash: '', hash: '', operation: undefined, event }
}

/** One mapped payload. */
function payload(event: TaskEvent, projectionOverrides: Partial<TaskProjection> = {}): CommittedPayload {
  return { taskId: 'task-1', record: record(event), projection: projection(projectionOverrides) }
}

describe('mapCommittedToEvent', () => {
  it('maps attempt/failed to failed with the round number and no reason text', () => {
    const event = mapCommittedToEvent(payload(
      { type: 'attempt/failed', attemptId: ATTEMPT.attemptId, reason: 'runner exited 1', failureDigest: 'd', elapsedMs: 5, timeAccounting: 'measured' },
      { consumedRounds: 3 },
    ), now)
    expect(event).toEqual({
      taskId: 'task-1',
      kind: 'failed',
      origin: 'commit',
      sessionId: undefined,
      title: 'Round 3 failed',
      occurredAt: 1_700_000_000_000,
      revision: 7,
    })
  })

  it('keeps reason and detail free text out of the title, including paths and quotes', () => {
    const hostile = 'boom /tmp/private/segfault.log `rm -rf /` $(cat /etc/passwd) "quoted"'
    const failed = mapCommittedToEvent(payload(
      { type: 'attempt/failed', attemptId: ATTEMPT.attemptId, reason: hostile, failureDigest: 'd', elapsedMs: 5, timeAccounting: 'measured' },
    ), now)
    const handoff = mapCommittedToEvent(payload(
      { type: 'handoff/raised', reason: 'journal-corrupted', detail: hostile },
    ), now)
    expect(failed?.title).toBe('Round 1 failed')
    expect(handoff?.title).toBe('Task handed off (journal-corrupted)')
    for (const event of [failed, handoff]) {
      expect(event?.title).not.toContain('/tmp/private')
      expect(event?.title).not.toContain('"quoted"')
      expect(event?.title).not.toContain('`rm -rf /`')
    }
  })

  it('maps handoff/raised to failed with the handoff reason enum in the title', () => {
    const event = mapCommittedToEvent(payload(
      { type: 'handoff/raised', reason: 'attempt-interrupted', detail: 'attempt a1 was in flight' },
    ), now)
    expect(event?.kind).toBe('failed')
    expect(event?.title).toBe('Task handed off (attempt-interrupted)')
    expect(event?.title).not.toContain('a1 was in flight')
  })

  it('maps task/passed to awaiting-trial and task/stopped to stopped', () => {
    const passed = mapCommittedToEvent(payload(
      { type: 'task/passed', attemptId: ATTEMPT.attemptId, resultDigest: 'd', elapsedMs: 5, timeAccounting: 'measured' },
      { consumedRounds: 2 },
    ), now)
    expect(passed?.kind).toBe('awaiting-trial')
    expect(passed?.title).toBe('Round 2 passed, awaiting trial')
    const stopped = mapCommittedToEvent(payload(
      { type: 'task/stopped', reason: 'cancelled' },
      { status: 'stopped' },
    ), now)
    expect(stopped?.kind).toBe('stopped')
    expect(stopped?.title).toBe('Task stopped (cancelled)')
  })

  it('maps plan/drafted to awaiting-decision', () => {
    const event = mapCommittedToEvent(payload(
      { type: 'plan/drafted', draft: { requiredCases: [], manualCases: [] } },
      { status: 'awaiting-plan-confirmation' },
    ), now)
    expect(event?.kind).toBe('awaiting-decision')
    expect(event?.title).toBe('Plan drafted, awaiting confirmation')
  })

  it('maps the decision-status fall-through for plan/confirmed and budget/approved', () => {
    const confirmed = mapCommittedToEvent(payload(
      { type: 'plan/confirmed', plan: PLAN },
      { status: 'awaiting-development-approval' },
    ), now)
    expect(confirmed?.kind).toBe('awaiting-decision')
    expect(confirmed?.title).toBe('Plan confirmed, awaiting development approval')
    const approved = mapCommittedToEvent(payload(
      { type: 'budget/approved', approval: BUDGET },
      { status: 'ready' },
    ), now)
    expect(approved?.kind).toBe('awaiting-decision')
    expect(approved?.title).toBe('Budget approved, task ready')
  })

  it('skips bookkeeping events that leave no human decision pending', () => {
    const skipped: [TaskEvent, Partial<TaskProjection>][] = [
      [{ type: 'task/created', spec: SPEC }, { status: 'draft' }],
      [{ type: 'task/planning-authorized', authorizedBy: 'user' }, { status: 'planning-authorized' }],
      [{ type: 'attempt/started', attempt: ATTEMPT }, { status: 'attempting' }],
      [{ type: 'trial/approved', approvedBy: 'user', resultDigest: 'd' }, { status: 'awaiting-trial' }],
      [{ type: 'budget/approved', approval: BUDGET }, { status: 'stopped' }],
    ]
    for (const [event, overrides] of skipped) {
      expect(mapCommittedToEvent(payload(event, overrides), now)).toBeUndefined()
    }
  })
})
