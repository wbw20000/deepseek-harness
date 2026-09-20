/**
 * Mapping from one durable `self-development/committed` payload to the unified
 * notification event. The mapping reads only the committed event and the
 * post-commit projection, and every title is a fixed English template: it
 * carries the round number and closed-vocabulary reasons only — never the
 * failure reason, the handoff detail, a path, or the task requirement.
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { CommittedRecord, TaskProjection, TaskStatus } from '@deepseek-ai/dsh-workflow-self-development'
import type { SelfDevelopmentEvent, SelfDevelopmentEventKind } from './types.ts'

/** The statuses that are waiting on a human decision, not on the worker. */
const DECISION_STATUSES: readonly TaskStatus[] = ['awaiting-development-approval', 'ready']

/** One durable commit payload, as the core service emits it. */
export interface CommittedPayload {
  /** Task the committed event belongs to. */
  readonly taskId: string
  /** Hash-chained journal record as durably stored. */
  readonly record: CommittedRecord
  /** Frozen task projection after the commit. */
  readonly projection: TaskProjection
}

/**
 * Map one durable commit to the unified notification event, or `undefined`
 * when the commit is controller bookkeeping that needs no human attention.
 * @param payload - the committed record and the frozen post-commit projection.
 * @param now - host clock used for `occurredAt`.
 * @returns the notification event, or `undefined` when nothing maps.
 */
export function mapCommittedToEvent(payload: CommittedPayload, now: () => number): SelfDevelopmentEvent | undefined {
  const { taskId, record, projection } = payload
  const event = record.event
  switch (event.type) {
    case 'attempt/failed':
      // The consumed round is already folded in, so it is this attempt's
      // number. The runner's reason text stays in the task journal; it never
      // enters the title.
      return build(taskId, 'failed', `Round ${projection.consumedRounds} failed`, projection, now)
    case 'handoff/raised':
      // `reason` is a closed enum; the free-text `detail` stays in the journal.
      return build(taskId, 'failed', `Task handed off (${event.reason})`, projection, now)
    case 'task/passed':
      return build(taskId, 'awaiting-trial', `Round ${projection.consumedRounds} passed, awaiting trial`, projection, now)
    case 'task/stopped':
      return build(taskId, 'stopped', `Task stopped (${event.reason})`, projection, now)
    case 'plan/drafted':
      return build(taskId, 'awaiting-decision', 'Plan drafted, awaiting confirmation', projection, now)
    case 'task/created':
    case 'task/planning-authorized':
    case 'plan/confirmed':
    case 'budget/approved':
    case 'attempt/started':
    case 'trial/approved':
      // These events matter only through the human-decision status they leave
      // behind (a confirmed plan awaits the development approval, an approved
      // budget leaves the task ready); everything else is bookkeeping.
      return DECISION_STATUSES.includes(projection.status)
        ? build(taskId, 'awaiting-decision', decisionTitle(projection.status), projection, now)
        : undefined
    /* v8 ignore next -- the TaskEvent union is closed; this retains compile-time exhaustiveness. */
    default:
      return assertNever(event, 'durable self-development task event')
  }
}

/** The fixed title for a commit that leaves the task waiting on a human decision. */
function decisionTitle(status: TaskStatus): string {
  return status === 'awaiting-development-approval'
    ? 'Plan confirmed, awaiting development approval'
    : 'Budget approved, task ready'
}

/** Assemble one event with its template title and observation time. */
function build(
  taskId: string,
  kind: SelfDevelopmentEventKind,
  title: string,
  projection: TaskProjection,
  now: () => number,
): SelfDevelopmentEvent {
  return {
    taskId,
    kind,
    origin: 'commit',
    sessionId: undefined,
    title,
    occurredAt: now(),
    revision: projection.revision,
  }
}
