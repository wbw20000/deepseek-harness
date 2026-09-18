/** Garbage collection and byte accounting for local attachment objects. @module internal */

import { readdir, rm, rmdir, stat, unlink } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { GarbageCollectionResult } from '@deepseek-ai/dsh-attachment'

const REFERENCE_PATTERN = /^sha256:([a-f0-9]{64})$/

/**
 * Resolve one referenced attachment id to its content-addressed digest.
 * @param id - attachment id from a session reference.
 * @returns the hex digest naming stored objects.
 * @throws an AttachmentError when the id is not a content-addressed attachment reference.
 */
function digestOf(id: string): string {
  const match = REFERENCE_PATTERN.exec(id)
  if (match?.[1] === undefined) {
    throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  }
  return match[1]
}

/** One stat'ed file inside a content-addressed object tree. */
interface ObjectFile {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly mtimeMs: number
}

/**
 * Collect the stat'ed files of one object tree. A missing tree contributes
 * nothing: a fresh home has neither image objects nor file objects yet.
 * @param dir - absolute object-tree directory.
 * @returns every file directly or indirectly below `dir`.
 */
async function listObjectFiles(dir: string): Promise<ObjectFile[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const files: ObjectFile[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listObjectFiles(path))
      continue
    }
    if (!entry.isFile()) continue
    const stats = await stat(path)
    files.push({ path, sha256: entry.name, bytes: stats.size, mtimeMs: stats.mtimeMs })
  }
  return files
}

/**
 * Sum the bytes held by durable attachment objects. Alias directories under
 * `files/` are deliberately excluded: they are hard links into
 * `file-objects/`, so counting them would double the same bytes, and every
 * counted path is one physical object's canonical name.
 * @param root - absolute versioned attachment root.
 * @returns total durable object bytes.
 */
export async function scanStoredObjectBytes(root: string): Promise<number> {
  const trees = [join(root, 'objects'), join(root, 'file-objects')]
  let bytes = 0
  for (const tree of trees) {
    for (const object of await listObjectFiles(tree)) {
      bytes += object.bytes
    }
  }
  return bytes
}

/**
 * Delete unreferenced objects whose last modification is older than the grace
 * period. File aliases below `files/` are removed together with their
 * content-addressed object, and now-empty shard directories are pruned.
 * @param root - absolute versioned attachment root.
 * @param referenced - hex digests of attachment ids some session still references.
 * @param olderThanMs - grace period; objects modified within it are never collected.
 * @returns bytes and object count reclaimed by this pass.
 * @throws an AttachmentError when deletion fails or a referenced id is malformed.
 */
export async function collectUnreferencedObjects(
  root: string,
  referenced: Iterable<string>,
  olderThanMs: number,
): Promise<GarbageCollectionResult> {
  const referencedSet = new Set<string>()
  for (const id of referenced) referencedSet.add(digestOf(id))
  const cutoff = Date.now() - olderThanMs
  let collectedBytes = 0
  let collectedCount = 0
  const trees = [
    { objects: join(root, 'objects'), aliases: undefined },
    { objects: join(root, 'file-objects'), aliases: join(root, 'files') },
  ] as const
  try {
    for (const tree of trees) {
      for (const object of await listObjectFiles(tree.objects)) {
        if (referencedSet.has(object.sha256) || object.mtimeMs > cutoff) continue
        await unlink(object.path)
        collectedBytes += object.bytes
        collectedCount += 1
        if (tree.aliases === undefined) {
          await pruneEmptyShard(join(tree.objects, object.sha256.slice(0, 2)))
          continue
        }
        await rm(join(tree.aliases, object.sha256.slice(0, 2), object.sha256), { recursive: true, force: true })
        await pruneEmptyShard(join(tree.aliases, object.sha256.slice(0, 2)))
        await pruneEmptyShard(join(tree.objects, object.sha256.slice(0, 2)))
      }
    }
  } catch (error) {
    throw new AttachmentError('Unable to collect unreferenced attachments.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
  return { collectedBytes, collectedCount }
}

/**
 * Remove one shard directory when it no longer holds entries.
 * @param dir - absolute shard directory that may now be empty.
 */
async function pruneEmptyShard(dir: string): Promise<void> {
  await rmdir(dir).catch((error: unknown) => {
    /* v8 ignore start -- A concurrent writer refills (ENOTEMPTY) or removes (ENOENT)
       the shard between the unlink and the rmdir; other failures mean corruption. */
    if (error instanceof Error && 'code' in error
      && (error.code === 'ENOTEMPTY' || error.code === 'ENOENT')) return
    throw error
    /* v8 ignore stop */
  })
}
