/**
 * Mapping from the merge-to-stable flow's two outcome events to the unified
 * notification event, plus the Cordis event declarations those events use.
 * Merge events never arrive through the durable `self-development/committed`
 * stream: the core task-control package owns no notion of a git integration
 * or a stable-side upgrade, so the chat tool that drives `workspaces.integrate`
 * emits these two events directly — the same shape as the campaign-lifecycle
 * events in `campaign.ts`. Both titles are fixed templates: `merge-blocked`'s
 * `<status>` is the only merge-flow detail either title carries, never the
 * integration's free-text `reason`.
 * @module @deepseek-ai/dsh-workflow-self-development-events/merge
 */

import type { SelfDevelopmentEvent } from './types.ts'

/** Payload of the `self-development/merge-integrated` event. */
export interface MergeIntegratedPayload {
  /** Task whose worktree was integrated into the stable branch. */
  readonly taskId: string
  /** Task projection revision observed when the merge was recorded. */
  readonly revision: number
}

/** Payload of the `self-development/merge-blocked` event. */
export interface MergeBlockedPayload {
  /** Task whose merge attempt was blocked. */
  readonly taskId: string
  /**
   * Closed-vocabulary reason the merge did not complete, reaching the title
   * verbatim — never the merge flow's free-text detail (a git failure reason,
   * a gate command's output tail, an approval refusal). Owned by the merge
   * flow, not by this package: a `workspaces.integrate` result status
   * (`conflict`, `verification-failed`, `failed`) or a chat-level refusal
   * (for example a task that is not `awaiting-trial`).
   */
  readonly status: string
  /** Task projection revision observed when the merge was blocked. */
  readonly revision: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One task's worktree was integrated into the stable branch and the
     * stable side is being rebuilt and restarted. Fixed title; carries no
     * commit id or target branch.
     * @param payload - the task id and the observed projection revision.
     * @mode emit
     */
    'self-development/merge-integrated'(payload: MergeIntegratedPayload): void
    /**
     * One merge attempt did not complete: a hard-gate refusal, a task not
     * `awaiting-trial`, or `workspaces.integrate` reporting `conflict`,
     * `verification-failed`, or `failed`. The closed-vocabulary `status`
     * reaches the title; the merge flow's free-text detail never leaves it.
     * @param payload - the task id, the closed-vocabulary block status, and the observed revision.
     * @mode emit
     */
    'self-development/merge-blocked'(payload: MergeBlockedPayload): void
  }
}

/**
 * Map one `merge-integrated` payload to the unified notification event.
 * @param payload - the merge-integrated payload.
 * @param now - host clock used for `occurredAt`.
 * @returns the notification event.
 */
export function mapMergeIntegratedToEvent(payload: MergeIntegratedPayload, now: () => number): SelfDevelopmentEvent {
  return {
    taskId: payload.taskId,
    kind: 'awaiting-trial',
    origin: 'merge',
    sessionId: undefined,
    title: 'Task integrated into stable',
    occurredAt: now(),
    revision: payload.revision,
  }
}

/**
 * Map one `merge-blocked` payload to the unified notification event.
 * @param payload - the merge-blocked payload.
 * @param now - host clock used for `occurredAt`.
 * @returns the notification event; the title interpolates only the
 *   closed-vocabulary `status`, never the merge flow's free-text reason.
 */
export function mapMergeBlockedToEvent(payload: MergeBlockedPayload, now: () => number): SelfDevelopmentEvent {
  return {
    taskId: payload.taskId,
    kind: 'failed',
    origin: 'merge',
    sessionId: undefined,
    title: `Merge blocked: ${payload.status}`,
    occurredAt: now(),
    revision: payload.revision,
  }
}
