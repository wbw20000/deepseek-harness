/** Host wiring that feeds Session-referenced attachment ids to the local attachment garbage collector. @module internal */

import { errorChain } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentId as AttachmentIdType } from '@deepseek-ai/dsh-attachment'
import { forEachContentAttachment, forEachSessionEventAttachment } from './attachment-references.ts'

/**
 * Optional registration seam of the local attachment backend. Matched
 * structurally so this package keeps `@deepseek-ai/dsh-attachment` as its
 * only attachment dependency: backends without the method simply keep their
 * scheduled garbage collection skip-based.
 */
interface GarbageReferenceSourceRegistry {
  setGarbageReferenceSource?(
    source: () => Iterable<AttachmentIdType> | Promise<Iterable<AttachmentIdType> | undefined> | undefined,
  ): () => void
}

/**
 * Enumerate every attachment id the Host's sessions reference: all persisted
 * sessions (including ones not loaded into memory), live in-memory sessions,
 * and pending queued messages of registered Agents.
 * @param ctx - Host context carrying Session query, Session, and Agent services.
 * @returns the union of referenced attachment ids.
 * @throws when the Session corpus cannot be read; the caller must then skip the collection pass.
 */
async function collectReferencedAttachmentIds(ctx: Context): Promise<Set<AttachmentIdType>> {
  const records = await ctx.sessionQuery.listSessions()
  const ids = new Set<AttachmentIdType>()
  for (const record of records) {
    using observation = await ctx.sessionQuery.observeSession(record.header.id, { projectionMode: 'none' })
    for (const event of observation.events) {
      forEachSessionEventAttachment(event, (attachment) => { ids.add(AttachmentId(attachment.attachmentId)) })
    }
  }
  for (const agent of ctx.agents.list()) {
    for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
      forEachContentAttachment(message.content, (attachment) => { ids.add(AttachmentId(attachment.attachmentId)) })
    }
  }
  return ids
}

/**
 * Build the garbage-reference source. Any enumeration failure resolves to
 * `undefined`, which makes the scheduled pass delete nothing; the failure is
 * logged here because the attachment backend cannot name the failing source.
 * @param ctx - Host context carrying Session query, Session, and Agent services.
 * @returns the source resolving the referenced ids, or `undefined` after a failure.
 */
function createGarbageReferenceSource(ctx: Context): () => Promise<Set<AttachmentIdType> | undefined> {
  return async () => {
    try {
      return await collectReferencedAttachmentIds(ctx)
    } catch (error) {
      ctx.logger.warn(
        `session-controller: attachment reference enumeration failed; skipping this garbage-collection pass: ${errorChain(error)}`,
      )
      return undefined
    }
  }
}

/**
 * Register the Session-derived garbage-reference source on the attachment
 * backend. Backends without `setGarbageReferenceSource` keep their timer in
 * warn-skip mode; the registration disposer joins the caller's effect chain.
 * @param ctx - Host context carrying the attachment backend.
 */
export function registerAttachmentGarbageReferenceSource(ctx: Context): void {
  const registry = ctx.attachments as GarbageReferenceSourceRegistry
  if (typeof registry.setGarbageReferenceSource !== 'function') {
    ctx.logger.info(
      'session-controller: attachments service exposes no setGarbageReferenceSource; scheduled attachment garbage collection stays skipped',
    )
    return
  }
  const dispose = registry.setGarbageReferenceSource(createGarbageReferenceSource(ctx))
  ctx.effect(() => dispose, 'session-controller: attachment garbage-reference source')
}
