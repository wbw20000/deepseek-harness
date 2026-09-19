/**
 * Wire mapping for Remote returns. The core projection and the runner outcome
 * type carry required `| undefined` fields, which the Typert Remote boundary
 * rejects: over JSON, an absent property is the representation of `undefined`,
 * so the wire views express them as optional properties. The mappers are the
 * one place that performs that mapping; no field is renamed or dropped.
 * @module @deepseek-ai/dsh-workflow-self-development-remote/wire
 */

import type { TaskProjection } from '@deepseek-ai/dsh-workflow-self-development'
import type { SupervisedAttemptOutcome } from '@deepseek-ai/dsh-workflow-self-development-runner'
import type { RemoteRunAttemptOutcome, RemoteTaskProjection } from './types.ts'

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
 * @returns the wire outcome; absent fields mean `undefined`.
 */
export function toWireOutcome(
  outcome: SupervisedAttemptOutcome,
  operationId: string,
): RemoteRunAttemptOutcome {
  return {
    operation: outcome.operation,
    ...(outcome.attemptId === undefined ? {} : { attemptId: outcome.attemptId }),
    ...(outcome.evidencePath === undefined ? {} : { evidencePath: outcome.evidencePath }),
    ...(outcome.outcomeWriteError === undefined ? {} : { outcomeWriteError: outcome.outcomeWriteError }),
    operationId,
  }
}
