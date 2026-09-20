/**
 * Wire mapping for Remote returns. The core projection and the runner outcome
 * type carry required `| undefined` fields, which the Typert Remote boundary
 * rejects: over JSON, an absent property is the representation of `undefined`,
 * so the wire views express them as optional properties. The mappers are the
 * one place that performs that mapping; no field is renamed or dropped.
 * @module @deepseek-ai/dsh-workflow-self-development-remote/wire
 */

import type { TaskProjection } from '@deepseek-ai/dsh-workflow-self-development'
import type { SelfDevelopmentEvent } from '@deepseek-ai/dsh-workflow-self-development-events'
import type { SupervisedAttemptOutcome } from '@deepseek-ai/dsh-workflow-self-development-runner'
import type { CampaignRecord } from './campaign.ts'
import type { CampaignState, RecentEvent, RemoteRunAttemptOutcome, RemoteTaskProjection } from './types.ts'

/**
 * Project one core task projection onto the JSON-safe wire view.
 * @param projection - control state projected from the journal.
 * @returns the wire projection; absent fields mean `undefined`.
 */
export function toWireProjection(projection: TaskProjection): RemoteTaskProjection {
  return {
    status: projection.status,
    ...(projection.spec === undefined ? {} : { spec: projection.spec }),
    ...(projection.plan === undefined ? {} : { plan: projection.plan }),
    ...(projection.approval === undefined ? {} : { approval: projection.approval }),
    planningAuthorized: projection.planningAuthorized,
    consumedRounds: projection.consumedRounds,
    consumedTimeMs: projection.consumedTimeMs,
    timeBudgetFrozen: projection.timeBudgetFrozen,
    ...(projection.currentAttempt === undefined ? {} : { currentAttempt: projection.currentAttempt }),
    ...(projection.verifiedResultDigest === undefined
      ? {}
      : { verifiedResultDigest: projection.verifiedResultDigest }),
    ...(projection.trialApproval === undefined ? {} : { trialApproval: projection.trialApproval }),
    noProgressCount: projection.noProgressCount,
    ...(projection.stopReason === undefined ? {} : { stopReason: projection.stopReason }),
    ...(projection.handoffReason === undefined ? {} : { handoffReason: projection.handoffReason }),
    ...(projection.handoffDetail === undefined ? {} : { handoffDetail: projection.handoffDetail }),
    revision: projection.revision,
  }
}

/**
 * Project one runner attempt outcome onto the JSON-safe wire view.
 * @param outcome - the runner's attempt outcome.
 * @param operationId - the facade-generated operation id of the launch.
 * @param worktree - the experiment worktree this facade's request validation accepted.
 * @returns the wire outcome; absent fields mean `undefined`.
 */
export function toWireOutcome(
  outcome: SupervisedAttemptOutcome,
  operationId: string,
  worktree: string | undefined,
): RemoteRunAttemptOutcome {
  return {
    operation: outcome.operation,
    ...(outcome.attemptId === undefined ? {} : { attemptId: outcome.attemptId }),
    ...(outcome.evidencePath === undefined ? {} : { evidencePath: outcome.evidencePath }),
    ...(outcome.outcomeWriteError === undefined ? {} : { outcomeWriteError: outcome.outcomeWriteError }),
    ...(worktree === undefined ? {} : { worktree }),
    operationId,
  }
}

/**
 * Project one stored campaign record onto its public {@link CampaignState}
 * view, dropping the internal `unattended`/`acceptedBy` fields the record
 * carries only to derive later rounds.
 * @param record - the stored campaign record.
 * @returns the public view; absent optional fields mean `undefined`.
 */
export function toCampaignState(record: CampaignRecord): CampaignState {
  return {
    taskId: record.taskId,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    rounds: record.rounds,
    ...(record.lastAttemptId === undefined ? {} : { lastAttemptId: record.lastAttemptId }),
    ...(record.lastOutcome === undefined ? {} : { lastOutcome: record.lastOutcome }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    acknowledgement: record.acknowledgement,
  }
}

/**
 * Project one unified notification event onto the JSON-safe wire view.
 * @param event - the events consumer's mapped notification event.
 * @returns the wire event; the always-`undefined` `sessionId` becomes an absent property.
 */
export function toWireEvent(event: SelfDevelopmentEvent): RecentEvent {
  return {
    taskId: event.taskId,
    kind: event.kind,
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    title: event.title,
    occurredAt: event.occurredAt,
    revision: event.revision,
  }
}
