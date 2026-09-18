/** Dedupe gate and failure dominance for outbound notifications. */

import type { NotificationEvent, NotificationKind } from './types.ts'

/**
 * Per-session, per-kind admission window. The dedupe key is
 * `${sessionId}:${kind}`: inside the window one session emits one notification
 * per kind. A recorded `turn-failed` also dominates: the paired
 * `turn-finished` of the same failed turn is dropped while the failure is
 * still inside the window, so a failed turn cannot notify twice. Entries whose
 * window has elapsed are dropped lazily on the next gate operation, so the
 * maps never grow with the sessions a long-running host observes.
 */
export class NotificationGate {
  /** Last admission time per dedupe key. */
  private readonly lastSentAt = new Map<string, number>()
  /** Last failure time per session. */
  private readonly lastFailedAt = new Map<string, number>()

  /**
   * @param windowMs - admission window in milliseconds.
   * @param now - host clock.
   */
  constructor(private readonly windowMs: number, private readonly now: () => number) {}

  /** Tracked dedupe and failure keys; expired entries are dropped lazily. */
  get size(): number {
    return this.lastSentAt.size + this.lastFailedAt.size
  }

  /**
   * Decide whether one notification may go out, without recording it.
   * @param event - candidate notification.
   * @returns whether the notification passes the dedupe window and failure dominance.
   */
  admit(event: NotificationEvent): boolean {
    this.sweep()
    if (event.kind === 'turn-finished' && this.recentlyFailed(event.sessionId)) return false
    const sentAt = this.lastSentAt.get(key(event))
    return sentAt === undefined || this.now() - sentAt >= this.windowMs
  }

  /**
   * Record one admitted notification at the current time.
   * @param event - admitted notification.
   */
  record(event: NotificationEvent): void {
    this.sweep()
    this.lastSentAt.set(key(event), this.now())
  }

  /**
   * Mark the session as failed inside the window, suppressing its paired finish.
   * @param sessionId - session whose turn failed.
   */
  markTurnFailed(sessionId: string): void {
    this.sweep()
    this.lastFailedAt.set(sessionId, this.now())
  }

  /** Drop every entry whose window has elapsed. */
  private sweep(): void {
    const now = this.now()
    for (const [key, sentAt] of this.lastSentAt) {
      if (now - sentAt >= this.windowMs) this.lastSentAt.delete(key)
    }
    for (const [sessionId, failedAt] of this.lastFailedAt) {
      if (now - failedAt >= this.windowMs) this.lastFailedAt.delete(sessionId)
    }
  }

  /** Whether the session failed inside the window. */
  private recentlyFailed(sessionId: string): boolean {
    return this.lastFailedAt.get(sessionId) !== undefined
  }
}

/** Build the dedupe key for one event. */
function key(event: NotificationEvent): `${string}:${NotificationKind}` {
  return `${event.sessionId}:${event.kind}`
}
