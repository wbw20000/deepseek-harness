/** Unified self-development notification vocabulary for the events package. Types only. */

/**
 * What one self-development event asks a human to notice. `turn-finished` is
 * reserved for the later finite-loop projection of "one round ended, the next
 * is waiting"; today a finished round that returns the task to `ready`
 * publishes `failed` instead.
 */
export type SelfDevelopmentEventKind = 'turn-finished' | 'failed' | 'awaiting-decision' | 'awaiting-trial' | 'stopped'

/**
 * One unified self-development notification event. The content is title-level
 * only: it never carries a filesystem path, a credential, or the task
 * requirement text. `sessionId` stays optional because a self-development task
 * is not bound to a chat session; the same shape stays consumable by session-
 * bound notification consumers that do carry one.
 */
export interface SelfDevelopmentEvent {
  /** Task the event belongs to. */
  readonly taskId: string
  /** What the human should notice. */
  readonly kind: SelfDevelopmentEventKind
  /** Owning chat session; always `undefined` for self-development tasks. */
  readonly sessionId: string | undefined
  /** Fixed-template summary chosen by the mapping: round number and closed-vocabulary reasons only, never journal free text. */
  readonly title: string
  /** Host-clock milliseconds when the durable commit was observed. */
  readonly occurredAt: number
  /** Task projection revision after the commit that produced the event. */
  readonly revision: number
}

/** Deployment configuration for the events service. */
export interface SelfDevelopmentEventsConfig {
  /**
   * Local notification command argv, spawned once per event with the event
   * JSON on its stdin. `undefined` — the default — disables notifications.
   */
  readonly localNotificationCommand?: readonly string[] | undefined
  /** Events retained in the in-memory recent buffer; older events are dropped. */
  readonly recentLimit?: number | undefined
}

/** Validated deployment configuration the service runs under. */
export interface ResolvedSelfDevelopmentEventsConfig {
  /** Local notification argv, or `undefined` for no notifications. */
  readonly localNotificationCommand: readonly string[] | undefined
  /** Events retained in the in-memory recent buffer. */
  readonly recentLimit: number
}
