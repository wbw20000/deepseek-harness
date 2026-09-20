/**
 * Mapping from the Remote facade's campaign-lifecycle events to the unified
 * notification event, plus the Cordis event declarations those events use.
 * Campaign events never arrive through the durable `self-development/committed`
 * stream: the core task-control package owns no notion of a campaign, so the
 * Remote facade — the campaign loop's only owner — emits these two events
 * directly. Both titles are fixed templates, exactly like
 * `mapCommittedToEvent`'s: `CampaignEndedPayload.status` is the only
 * campaign-loop detail either title carries, never the free-text
 * `CampaignState.reason`.
 * @module @deepseek-ai/dsh-workflow-self-development-events/campaign
 */

import type { SelfDevelopmentEvent, SelfDevelopmentEventKind } from './types.ts'

/** Payload of the `self-development/campaign-passed` event. */
export interface CampaignPassedPayload {
  /** Task the passed campaign belongs to. */
  readonly taskId: string
  /** Task projection revision observed when the passing round committed. */
  readonly revision: number
}

/** Closed-vocabulary end status a `self-development/campaign-ended` event reports; `passed` has its own dedicated event. */
export type CampaignEndedStatus = 'exhausted' | 'stopped' | 'failed'

/** Payload of the `self-development/campaign-ended` event. */
export interface CampaignEndedPayload {
  /** Task the ended campaign belongs to. */
  readonly taskId: string
  /** How the campaign's loop ended. */
  readonly status: CampaignEndedStatus
  /** Task projection revision observed when the campaign ended. */
  readonly revision: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One unattended campaign reached a passing round — the same durable
     * `task/passed` outcome a manual `runAttempt` produces, reached through
     * the campaign's own automatic rounds instead. Fixed title; carries no
     * round number or free text.
     * @param payload - the task id and the post-commit projection revision.
     * @mode emit
     */
    'self-development/campaign-passed'(payload: CampaignPassedPayload): void
    /**
     * One unattended campaign's loop ended without a pass: its budget was
     * exhausted, a human called `stopCampaign`, or an unrecognized failure
     * ended it. The closed-vocabulary `status` reaches the title; the
     * free-text `CampaignState.reason` never leaves the Remote facade.
     * @param payload - the task id, the closed-vocabulary end status, and the observed revision.
     * @mode emit
     */
    'self-development/campaign-ended'(payload: CampaignEndedPayload): void
  }
}

/**
 * Map one `campaign-passed` payload to the unified notification event.
 * @param payload - the campaign-passed payload.
 * @param now - host clock used for `occurredAt`.
 * @returns the notification event.
 */
export function mapCampaignPassedToEvent(payload: CampaignPassedPayload, now: () => number): SelfDevelopmentEvent {
  return {
    taskId: payload.taskId,
    kind: 'awaiting-trial',
    origin: 'campaign',
    sessionId: undefined,
    title: 'Task passed, trial ready',
    occurredAt: now(),
    revision: payload.revision,
  }
}

/** Notification kind per closed-vocabulary campaign end status. */
const ENDED_KIND: Readonly<Record<CampaignEndedStatus, SelfDevelopmentEventKind>> = {
  exhausted: 'failed',
  stopped: 'stopped',
  failed: 'failed',
}

/**
 * Map one `campaign-ended` payload to the unified notification event.
 * @param payload - the campaign-ended payload.
 * @param now - host clock used for `occurredAt`.
 * @returns the notification event; the title interpolates only the
 *   closed-vocabulary `status`, never the campaign's free-text reason.
 */
export function mapCampaignEndedToEvent(payload: CampaignEndedPayload, now: () => number): SelfDevelopmentEvent {
  return {
    taskId: payload.taskId,
    kind: ENDED_KIND[payload.status],
    origin: 'campaign',
    sessionId: undefined,
    title: `Campaign ended: ${payload.status}`,
    occurredAt: now(),
    revision: payload.revision,
  }
}
