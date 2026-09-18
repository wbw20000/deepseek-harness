/** Host-event-to-notification assembly with title-level sanitization. */

import type { NotificationEvent } from './types.ts'

/**
 * Build the notification for one agent turn ending.
 * @param sessionId - session whose turn finished.
 * @param now - observation time in host-clock milliseconds.
 * @returns the title-level notification.
 */
export function turnFinishedEvent(sessionId: string, now: number): NotificationEvent {
  return { kind: 'turn-finished', sessionId, title: 'Turn finished', occurredAt: now }
}

/**
 * Build the notification for one session failure. The session-controller
 * error message is deliberately dropped: it quotes error chains that can
 * carry paths or message content.
 * @param sessionId - session that failed.
 * @param now - observation time in host-clock milliseconds.
 * @returns the title-level notification.
 */
export function turnFailedEvent(sessionId: string, now: number): NotificationEvent {
  return { kind: 'turn-failed', sessionId, title: 'Turn failed', occurredAt: now }
}

/**
 * Build the notification for one pending approval. The tool name is the only
 * session-derived content: it is an identifier from the closed tool catalog,
 * never message text, a path, or a tool argument.
 * @param sessionId - session waiting for the decision.
 * @param toolName - tool whose operation requires a decision.
 * @param now - observation time in host-clock milliseconds.
 * @returns the title-level notification.
 */
export function awaitingConfirmationEvent(sessionId: string, toolName: string, now: number): NotificationEvent {
  return { kind: 'awaiting-confirmation', sessionId, title: `Approval needed: ${toolName}`, occurredAt: now }
}
