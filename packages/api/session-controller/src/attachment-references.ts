/** Session-log attachment-reference discovery shared by authorization and garbage collection. @module internal */

import { assistantStreamChunks } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Event data fields that may carry prompt content blocks with attachments. */
interface AttachmentEventSource {
  readonly content?: unknown
  readonly message?: { readonly content?: unknown }
  readonly inserted?: readonly { readonly content?: unknown }[]
  readonly stream?: unknown
}

/**
 * Visit the durable reference of every attachment-bearing content block in
 * one prompt-content value. Image and file blocks carry an `attachment`
 * object with an `attachmentId`; tool-result blocks nest further content
 * that is searched recursively.
 * @param content - raw content blocks from a message or event payload.
 * @param visit - receiver of each attachment reference object.
 */
export function forEachContentAttachment(
  content: unknown,
  visit: (attachment: { readonly attachmentId: string }) => void,
): void {
  if (!Array.isArray(content)) return
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { readonly type?: unknown; readonly attachment?: unknown; readonly content?: unknown }
    if (block.type !== 'image' && block.type !== 'file') {
      if (block.type === 'tool-result') forEachContentAttachment(block.content, visit)
      continue
    }
    const attachment = block.attachment
    if (typeof attachment !== 'object' || attachment === null) continue
    const attachmentId = (attachment as { readonly attachmentId?: unknown }).attachmentId
    if (typeof attachmentId !== 'string') continue
    visit(attachment as { readonly attachmentId: string })
  }
}

/**
 * Visit every attachment id one committed Session event references: direct
 * prompt content, folded message content, inserted history, and assistant
 * stream block settlements.
 * @param event - committed Session event.
 * @param visit - receiver of each attachment reference object.
 */
export function forEachSessionEventAttachment(
  event: SessionEvent,
  visit: (attachment: { readonly attachmentId: string }) => void,
): void {
  const data = event.data as AttachmentEventSource
  forEachContentAttachment(data.content, visit)
  if (data.message !== undefined) forEachContentAttachment(data.message.content, visit)
  for (const inserted of data.inserted ?? []) forEachContentAttachment(inserted.content, visit)
  if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    for (const chunk of assistantStreamChunks(event.data.stream as never, 'block-end')) {
      forEachContentAttachment([chunk.block], visit)
    }
  }
}
