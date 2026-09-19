/**
 * Wire mapper behavior: the JSON-safe projection and outcome views keep every
 * field, express `undefined` as an absent property, and never rename a field.
 * @module wire.spec
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
import { toWireEvent, toWireOutcome, toWireProjection } from '../src/wire.ts'
import type { SupervisedAttemptOutcome } from '@deepseek-ai/dsh-workflow-self-development-runner'
import type { SelfDevelopmentEvent } from '@deepseek-ai/dsh-workflow-self-development-events'
import type { TaskProjection } from '@deepseek-ai/dsh-workflow-self-development'

/** A projection that fills every field, including every normally-absent one. */
const FULL_PROJECTION: TaskProjection = {
  status: 'handoff',
  spec: {
    taskId: SelfDevTaskId('task-wire'),
    version: TaskSpecVersion(1),
    requirement: 'goal',
    allowedModificationScope: ['marker.txt'],
    stableBaselineDigest: 'a'.repeat(64),
    createdBy: 'tester',
  },
  plan: {
    testPlanId: 'plan-1',
    version: TestPlanVersion(1),
    taskSpecVersion: TaskSpecVersion(1),
    requiredCases: [{ caseId: 'build', requirement: 'r', assertionIds: ['a1'] }],
    manualCases: [],
    digest: TestPlanDigest('b'.repeat(64)),
  },
  approval: {
    mode: 'rounds',
    maxRounds: 3,
    phaseTimeoutMs: 5_000,
    maxStepsPerAttempt: 7,
    testPlanVersion: TestPlanVersion(1),
    taskSpecVersion: TaskSpecVersion(1),
    approvedBy: 'tester',
  },
  planningAuthorized: true,
  consumedRounds: 1,
  consumedTimeMs: 2_000,
  timeBudgetFrozen: false,
  currentAttempt: {
    attemptId: SelfDevAttemptId('attempt-1'),
    attemptNumber: 1,
    startedAt: { bootId: 'c'.repeat(64), monotonicMs: 10 },
    testPlanDigest: TestPlanDigest('b'.repeat(64)),
    sourceDigest: SourceDigest('d'.repeat(64)),
    artifactDigest: ArtifactDigest('e'.repeat(64)),
    capabilityDigest: CapabilityDigest('f'.repeat(64)),
    capabilitySource: 'human-presence',
  },
  verifiedResultDigest: 'digest-1',
  trialApproval: { approvedBy: 'tester', resultDigest: 'digest-1' },
  noProgressCount: 0,
  stopReason: 'budget-exhausted',
  handoffReason: 'attempt-interrupted',
  handoffDetail: 'attempt was in flight',
  revision: 9,
}

describe('toWireProjection', () => {
  it('keeps every populated field, including the normally absent ones', () => {
    const wire = toWireProjection(FULL_PROJECTION)
    expect(wire.status).toBe('handoff')
    expect(wire.spec?.requirement).toBe('goal')
    expect(wire.plan?.digest).toBe('b'.repeat(64))
    expect(wire.approval?.mode).toBe('rounds')
    expect(wire.currentAttempt?.attemptNumber).toBe(1)
    expect(wire.verifiedResultDigest).toBe('digest-1')
    expect(wire.trialApproval).toEqual({ approvedBy: 'tester', resultDigest: 'digest-1' })
    expect(wire.stopReason).toBe('budget-exhausted')
    expect(wire.handoffReason).toBe('attempt-interrupted')
    expect(wire.handoffDetail).toBe('attempt was in flight')
    expect(wire.revision).toBe(9)
  })

  it('expresses undefined fields as absent properties', () => {
    const wire = toWireProjection({
      status: 'draft',
      spec: undefined,
      plan: undefined,
      approval: undefined,
      planningAuthorized: false,
      consumedRounds: 0,
      consumedTimeMs: 0,
      timeBudgetFrozen: false,
      currentAttempt: undefined,
      verifiedResultDigest: undefined,
      trialApproval: undefined,
      noProgressCount: 0,
      stopReason: undefined,
      handoffReason: undefined,
      handoffDetail: undefined,
      revision: 0,
    })
    expect(wire).toEqual({
      status: 'draft',
      planningAuthorized: false,
      consumedRounds: 0,
      consumedTimeMs: 0,
      timeBudgetFrozen: false,
      noProgressCount: 0,
      revision: 0,
    })
  })
})

describe('toWireOutcome', () => {
  it('keeps the attempt identity, evidence path, and outcome write error when present', () => {
    const outcome: SupervisedAttemptOutcome = {
      operation: { revision: 6, replayed: false },
      attemptId: 'attempt-2',
      evidencePath: '/evidence/attempts/attempt-2.json',
      outcomeWriteError: { code: 'EACCES', message: 'denied' },
    }
    expect(toWireOutcome(outcome, 'op-1', '/experiments/wt-2')).toEqual({
      operation: { revision: 6, replayed: false },
      attemptId: 'attempt-2',
      evidencePath: '/evidence/attempts/attempt-2.json',
      outcomeWriteError: { code: 'EACCES', message: 'denied' },
      worktree: '/experiments/wt-2',
      operationId: 'op-1',
    })
  })

  it('expresses a replay and a clean outcome write as absent properties', () => {
    const outcome: SupervisedAttemptOutcome = {
      operation: { revision: 4, replayed: true },
      attemptId: undefined,
      evidencePath: undefined,
      outcomeWriteError: undefined,
    }
    expect(toWireOutcome(outcome, 'op-2', undefined)).toEqual({
      operation: { revision: 4, replayed: true },
      operationId: 'op-2',
    })
  })
})

describe('toWireEvent', () => {
  it('keeps the title-level fields and drops the always-undefined session id', () => {
    const event: SelfDevelopmentEvent = {
      taskId: 'task-1',
      kind: 'awaiting-decision',
      sessionId: undefined,
      title: 'Plan drafted, awaiting confirmation',
      occurredAt: 1_700_000_000_000,
      revision: 3,
    }
    expect(toWireEvent(event)).toEqual({
      taskId: 'task-1',
      kind: 'awaiting-decision',
      title: 'Plan drafted, awaiting confirmation',
      occurredAt: 1_700_000_000_000,
      revision: 3,
    })
  })

  it('keeps a session id when the producer carries one', () => {
    const event: SelfDevelopmentEvent = {
      taskId: 'task-1',
      kind: 'failed',
      sessionId: 'chat-7',
      title: 'Round 2 failed',
      occurredAt: 1_700_000_060_000,
      revision: 5,
    }
    expect(toWireEvent(event)).toEqual({
      taskId: 'task-1',
      kind: 'failed',
      sessionId: 'chat-7',
      title: 'Round 2 failed',
      occurredAt: 1_700_000_060_000,
      revision: 5,
    })
  })
})
