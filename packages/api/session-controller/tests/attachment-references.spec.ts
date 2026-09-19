/** Session-log attachment-reference discovery branches not exercised by command authorization. */

import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { forEachContentAttachment, forEachSessionEventAttachment } from '../src/attachment-references.ts'

function fileAttachment(attachmentId: string): FileAttachmentRef {
  return { attachmentId: AttachmentId(attachmentId), name: 'a.txt', bytes: 1 }
}

function collect(content: unknown): string[] {
  const ids: string[] = []
  forEachContentAttachment(content, (attachment) => { ids.push(attachment.attachmentId) })
  return ids
}

describe('attachment-reference discovery', () => {
  it('ignores non-array content and unusable entries', () => {
    expect(collect(undefined)).toEqual([])
    expect(collect({ type: 'image', attachment: fileAttachment('a') })).toEqual([])
    expect(collect([null, [], 'text', 3])).toEqual([])
  })

  it('ignores blocks whose attachment is not a durable reference object', () => {
    expect(collect([
      { type: 'image' },
      { type: 'image', attachment: 'sha256:a' },
      { type: 'file', attachment: { name: 'a.txt' } },
      { type: 'file', attachment: { attachmentId: 7 } },
      { type: 'text', text: 'plain' },
    ])).toEqual([])
  })

  it('descends into tool-result blocks to find nested attachments', () => {
    expect(collect([
      { type: 'text', text: 'plain' },
      { type: 'tool-result', content: [{ type: 'file', attachment: fileAttachment('nested') }] },
      { type: 'tool-result', content: [{ type: 'tool-result', content: [{ type: 'image', attachment: {
        attachmentId: 'deep', mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      } }] }] },
    ])).toEqual(['nested', 'deep'])
  })

  it('reads direct, folded, inserted, and assistant-stream attachment references', () => {
    const event = {
      type: 'assistant/message',
      seq: 0,
      time: 1,
      surfaceOp: 'append',
      data: {
        content: [{ type: 'file', attachment: fileAttachment('direct') }],
        message: createAssistantMessage({
          content: [{ type: 'file', attachment: fileAttachment('folded') }],
          source: { provider: 'fixture', model: 'fixture' },
        }),
        inserted: [{ content: [{ type: 'file', attachment: fileAttachment('inserted') }] }],
        stream: [],
      },
    } as unknown as SessionEvent
    const ids: string[] = []
    forEachSessionEventAttachment(event, (attachment) => { ids.push(attachment.attachmentId) })
    expect(ids).toEqual(['direct', 'folded', 'inserted'])
  })

  it('reads assistant stream block settlements for attachment references', () => {
    const event = {
      type: 'assistant/attempt',
      seq: 0,
      time: 1,
      surfaceOp: 'append',
      data: {
        stream: [{
          type: 'chunk',
          chunk: {
            type: 'block-end',
            block: { type: 'file', attachment: fileAttachment('streamed') },
          },
        }],
      },
    } as unknown as SessionEvent
    const ids: string[] = []
    forEachSessionEventAttachment(event, (attachment) => { ids.push(attachment.attachmentId) })
    expect(ids).toEqual(['streamed'])
  })

  it('skips non-message event payloads without content fields', () => {
    const event = {
      type: 'turn/start',
      seq: 0,
      time: 1,
      surfaceOp: 'append',
      data: { reason: 'initial' },
    } as unknown as SessionEvent
    const ids: string[] = []
    forEachSessionEventAttachment(event, (attachment) => { ids.push(attachment.attachmentId) })
    expect(ids).toEqual([])
  })

  it('builds the fixtures through the production message constructors', () => {
    const message = createUserMessage({
      content: [{ type: 'file', attachment: fileAttachment('queued') }],
      source: { kind: 'user' },
    })
    const ids: string[] = []
    forEachContentAttachment(message.content, (attachment) => { ids.push(attachment.attachmentId) })
    expect(ids).toEqual(['queued'])
  })
})
