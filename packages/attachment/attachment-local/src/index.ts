/** Local durable attachment backend rooted below `DSH_HOME`. @module @deepseek-ai/dsh-attachment-local */

import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentError, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  assertAllowedMediaTypes,
  DEFAULT_ALLOWED_FILE_MIME_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
} from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentStorageUsage,
  AttachmentId,
  FileAdmissionLimits,
  FileAttachmentRef,
  GarbageCollectionRequest,
  GarbageCollectionResult,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveFileAttachment,
  SaveFileStreamAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { dshCachePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { NormalizationPolicy } from './normalization.ts'
import { CompressionLimiter, compressionFailure } from './compression-limiter.ts'
import { commitPreparedImageFile, normalizedImagePath, prepareImageFile, readImageFile, validateImageFile } from './store.ts'
import {
  readFileStreamVerbatim, saveFileStreamVerbatim, saveFileVerbatim, storedFilePath,
} from './file-store.ts'
import { readRequestImageFile, requestImageVariantId } from './request-image.ts'
import { StorageBudget } from './budget.ts'
import { collectUnreferencedObjects } from './gc.ts'

/**
 * Caller-registered source of attachment ids some session still references.
 * The source may resolve asynchronously (enumerating persisted session logs
 * cannot stay synchronous); a source that cannot read its references returns
 * or resolves to `undefined`, which makes the scheduled pass skip instead of
 * deleting.
 */
export type GarbageReferenceSource = () =>
  | Iterable<AttachmentId>
  | Promise<Iterable<AttachmentId> | undefined>
  | undefined

export { canPassThroughNormalization, normalizeImage } from './normalization.ts'
export type { NormalizedImage, NormalizationPolicy } from './normalization.ts'
export { commitPreparedImageFile, prepareImageFile, readImageFile, saveImageFile, validateImageFile } from './store.ts'
export type { PreparedImageFile } from './store.ts'
export { readRequestImageFile, requestImageVariantId } from './request-image.ts'

/** Default maximum encoded bytes for one submitted image; oversized sources are refused, not shrunk. */
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** Default maximum images in one prompt. */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
/** Default maximum aggregate image bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024
/** Default maximum intrinsic pixels for one submitted image. */
export const DEFAULT_MAX_IMAGE_PIXELS = 64_000_000
/** Default per-side pixel cap for one submitted image. */
export const DEFAULT_MAX_IMAGE_DIMENSION = 8192
/**
 * Default total-pixel budget of the stored normalized image. A larger source
 * is admitted and downscaled proportionally, so admission bounds what rides
 * every later model request without refusing ordinary large sources; extreme
 * aspect ratios keep their short-edge resolution instead of collapsing under
 * a long-edge rule.
 */
export const DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS = 2048 * 2048
/** Default long-edge cap of the stored normalized image, applied after the total-pixel budget. */
export const DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION = 8192
/** Default encoded-byte target for one stored normalized image. */
export const DEFAULT_NORMALIZED_IMAGE_MAX_BYTES = 4 * 1024 * 1024
/** Conservative default number of simultaneous native image transformations per store. */
export const DEFAULT_IMAGE_COMPRESSION_CONCURRENCY = 2
/** Maximum configurable native image transformations per store. */
export const MAX_IMAGE_COMPRESSION_CONCURRENCY = 8
/** Default grace period the garbage-collection timer applies to unreferenced objects. */
export const DEFAULT_GC_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000
/** Default deadline one asynchronous garbage-reference read may take before the pass skips. */
export const DEFAULT_GC_REFERENCE_TIMEOUT_MS = 30 * 1000

/** Local attachment backend configuration. */
export interface Config {
  /** Explicit harness home; omitted follows `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Maximum encoded bytes accepted for one submitted image. Default: 20 MiB. */
  maxImageBytes?: number
  /** Maximum image count accepted in one submitted message. Default: 20. */
  maxImagesPerMessage?: number
  /** Maximum aggregate encoded image bytes accepted in one submitted message. Default: 200 MiB. */
  maxMessageImageBytes?: number
  /** Maximum intrinsic width multiplied by height accepted for one submitted image. Default: 64,000,000. */
  maxImagePixels?: number
  /** Maximum intrinsic width and maximum intrinsic height accepted for one submitted image. Default: 8192px. */
  maxImageDimension?: number
  /** Total-pixel budget of the stored provider-independent normalized image. */
  normalizedImageMaxPixels?: number
  /** Long-edge pixel cap of the stored provider-independent normalized image, applied after the total-pixel budget. */
  normalizedImageMaxDimension?: number
  /**
   * Encoded-byte target of the stored provider-independent normalized image;
   * the smallest quality-ladder output is kept when no quality fits.
   */
  normalizedImageMaxBytes?: number
  /** Maximum simultaneous normalization or request-image transformations in this service instance. */
  imageCompressionConcurrency?: number
  /** Maximum bytes accepted for one verbatim file upload. Default: 300 MiB, matching the buffered request-body cap. */
  maxUploadBytes?: number
  /**
   * Media types accepted for verbatim file uploads; exact types, `type/*`
   * wildcards, and the match-all wildcard are honored. Default: images, text,
   * and common document formats.
   */
  allowedMimeTypes?: string[]
  /** Durable attachment disk budget in bytes; 0 removes the budget. Default: 0. */
  diskBudgetBytes?: number
  /** Budget fraction at or above which one debounced warning fires; greater than 0 and at most 1. Default: 0.8. */
  budgetWarnRatio?: number
  /** Garbage-collection timer interval in milliseconds; 0 disables the timer. Default: 0. */
  gcIntervalMs?: number
  /** Grace period the garbage-collection timer applies to unreferenced objects. Default: 24 hours. */
  gcGracePeriodMs?: number
  /**
   * Deadline one asynchronous garbage-reference read may take; a source still
   * pending past it skips that collection pass. Default: 30 seconds.
   */
  gcReferenceTimeoutMs?: number
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new Error('Attachment request cancelled with a non-Error reason.', { cause: reason })
}

class SharedRequest<T> {
  readonly controller = new AbortController()
  readonly promise: Promise<T>
  private settled = false
  private waiters = 0

  constructor(start: (signal: AbortSignal) => Promise<T>) {
    this.promise = start(this.controller.signal).finally(() => {
      this.settled = true
    })
  }

  wait(signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    this.waiters += 1
    if (signal === undefined) {
      return this.promise.finally(() => {
        this.release(false)
      })
    }
    let released = false
    const release = (cancelled: boolean): void => {
      if (released) return
      released = true
      this.release(cancelled, signal)
    }
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        release(true)
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', abort, { once: true })
      void this.promise.then((value) => {
        signal.removeEventListener('abort', abort)
        release(false)
        resolve(value)
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort)
        release(false)
        reject(compressionFailure(error))
      })
    })
  }

  private release(cancelled: boolean, signal?: AbortSignal): void {
    this.waiters -= 1
    if (cancelled && this.waiters === 0 && !this.settled && signal !== undefined) {
      this.controller.abort(abortReason(signal))
    }
  }
}

/** Persistent content-addressed local attachment store. */
export class LocalAttachmentStore extends AttachmentStore {
  static Config: z<Config> = z.object({
    dshHome: z.string(),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
    maxImagesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
    maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
    maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
    maxImageDimension: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_DIMENSION),
    normalizedImageMaxPixels: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS),
    normalizedImageMaxDimension: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION),
    normalizedImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_NORMALIZED_IMAGE_MAX_BYTES),
    imageCompressionConcurrency: z.number().step(1).min(1).max(MAX_IMAGE_COMPRESSION_CONCURRENCY)
      .default(DEFAULT_IMAGE_COMPRESSION_CONCURRENCY),
    maxUploadBytes: z.number().step(1).min(1).default(DEFAULT_MAX_UPLOAD_BYTES),
    allowedMimeTypes: z.array(z.string()).default([...DEFAULT_ALLOWED_FILE_MIME_TYPES]),
    diskBudgetBytes: z.number().step(1).min(0).default(0),
    // schemastery bounds are inclusive, so the exclusive lower bound rides a
    // transform; the constructor keeps the same rule for direct construction.
    budgetWarnRatio: z.transform(z.number().min(0).max(1), (value) => {
      if (value > 0) return value
      throw new TypeError(`expected budgetWarnRatio greater than 0 but got ${value}`)
    }).default(0.8),
    gcIntervalMs: z.number().step(1).min(0).default(0),
    gcGracePeriodMs: z.number().step(1).min(1).default(DEFAULT_GC_GRACE_PERIOD_MS),
    gcReferenceTimeoutMs: z.number().step(1).min(1).default(DEFAULT_GC_REFERENCE_TIMEOUT_MS),
  })

  /** Absolute versioned storage root. */
  readonly root: string
  readonly imageLimits: ImageAttachmentLimits
  override readonly fileAdmission: FileAdmissionLimits
  /** Resolved provider-independent normalization policy. */
  readonly normalizationPolicy: Readonly<NormalizationPolicy>
  /** Resolved instance-level compression limit. */
  readonly imageCompressionConcurrency: number
  /** Grace period the garbage-collection timer applies to unreferenced objects. */
  readonly gcGracePeriodMs: number
  /** Deadline one asynchronous garbage-reference read may take before the pass skips. */
  readonly gcReferenceTimeoutMs: number
  private readonly cacheRoot: string
  private readonly compression: CompressionLimiter
  private readonly budget: StorageBudget
  private readonly requestInflight = new Map<string, SharedRequest<RequestImageAttachment>>()
  private garbageReferenceSource: GarbageReferenceSource | undefined
  private garbageCollectionRunning = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const dshHome = resolveDshHome(config.dshHome)
    this.root = join(dshHome, 'attachments', 'v1')
    this.cacheRoot = dshCachePath({ dshHome }, 'attachments')
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: config.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: config.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    })
    this.fileAdmission = Object.freeze({
      maxUploadBytes: config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
      allowedMimeTypes: Object.freeze([...(config.allowedMimeTypes ?? DEFAULT_ALLOWED_FILE_MIME_TYPES)]),
    })
    assertAllowedMediaTypes(this.fileAdmission.allowedMimeTypes)
    const budgetWarnRatio = config.budgetWarnRatio ?? 0.8
    if (!(budgetWarnRatio > 0) || budgetWarnRatio > 1) {
      throw new Error('attachment-local: budgetWarnRatio must be greater than 0 and at most 1')
    }
    this.gcGracePeriodMs = config.gcGracePeriodMs ?? DEFAULT_GC_GRACE_PERIOD_MS
    this.gcReferenceTimeoutMs = config.gcReferenceTimeoutMs ?? DEFAULT_GC_REFERENCE_TIMEOUT_MS
    this.budget = new StorageBudget(
      this.root,
      config.diskBudgetBytes ?? 0,
      budgetWarnRatio,
      (message) => {
        this.ctx.logger.warn(message)
      },
    )
    // Startup orphan cleanup runs whether or not the budget is enabled, so a
    // crash cannot leave staging files behind on a budgetless deployment.
    void this.budget.sweepOrphans().catch((error: unknown) => {
      this.ctx.logger.warn(`attachment-local: startup orphan cleanup failed: ${String(error)}`)
    })
    this.normalizationPolicy = Object.freeze({
      maxPixels: config.normalizedImageMaxPixels ?? DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
      maxDimension: config.normalizedImageMaxDimension ?? DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
      maxBytes: config.normalizedImageMaxBytes ?? DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
    })
    const compressionConcurrency = config.imageCompressionConcurrency ?? DEFAULT_IMAGE_COMPRESSION_CONCURRENCY
    if (!Number.isSafeInteger(compressionConcurrency)
      || compressionConcurrency < 1
      || compressionConcurrency > MAX_IMAGE_COMPRESSION_CONCURRENCY) {
      throw new Error(
        `attachment-local: imageCompressionConcurrency must be an integer from 1 through ${MAX_IMAGE_COMPRESSION_CONCURRENCY}`,
      )
    }
    this.imageCompressionConcurrency = compressionConcurrency
    this.compression = new CompressionLimiter(compressionConcurrency)
    const gcIntervalMs = config.gcIntervalMs ?? 0
    if (gcIntervalMs > 0) {
      ctx.effect(() => {
        const timer = setInterval(() => {
          this.collectGarbageScheduled().catch((error: unknown) => {
            this.ctx.logger.warn(`attachment-local: scheduled garbage collection failed: ${String(error)}`)
          })
        }, gcIntervalMs)
        timer.unref()
        return () => {
          clearInterval(timer)
        }
      }, 'attachment-local: garbage-collection timer')
    }
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await this.compression.run(() => validateImageFile(input, this.imageLimits, this.normalizationPolicy))
  }

  override async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    this.validateImageBatch(inputs)
    const prepared = await Promise.all(inputs.map(input => this.compression.run(
      () => prepareImageFile(input, this.imageLimits, this.normalizationPolicy),
    )))
    const refs: ImageAttachmentRef[] = []
    for (const image of prepared) {
      const reservation = await this.budget.reserve(image.data.byteLength)
      try {
        refs.push(await commitPreparedImageFile(this.root, image))
      } finally {
        await reservation.release()
      }
    }
    await this.afterSave()
    return refs
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const prepared = await this.compression.run(
      () => prepareImageFile(input, this.imageLimits, this.normalizationPolicy),
    )
    const reservation = await this.budget.reserve(prepared.data.byteLength)
    try {
      const ref = await commitPreparedImageFile(this.root, prepared)
      await this.afterSave()
      return ref
    } finally {
      await reservation.release()
    }
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    return readImageFile(this.root, ref, signal)
  }

  override imageHostPath(ref: ImageAttachmentRef): string {
    return normalizedImagePath(this.root, ref)
  }

  override async saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    this.admitFileUpload({
      bytes: input.data.byteLength,
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    })
    const reservation = await this.budget.reserve(input.data.byteLength)
    try {
      const ref = await saveFileVerbatim(this.root, input)
      await this.afterSave()
      return ref
    } finally {
      await reservation.release()
    }
  }

  override async saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    this.admitFileUpload({
      ...(input.declaredBytes === undefined ? {} : { bytes: input.declaredBytes }),
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    })
    const reservation = await this.budget.reserve(input.declaredBytes ?? 0)
    try {
      const ref = await saveFileStreamVerbatim(this.root, {
        ...input,
        data: this.limitStream(input.data, reservation),
      })
      await this.afterSave()
      return ref
    } finally {
      await reservation.release()
    }
  }

  /**
   * Wrap one upload stream with byte counting. The running total refuses
   * uploads above the byte limit and keeps the disk-budget reservation in
   * step with an undeclared stream, so a lying or missing Content-Length
   * cannot bypass admission.
   * @param data - exact upload bytes in order.
   * @param reservation - the upload's disk-budget reservation.
   * @returns counted bytes in order.
   */
  private async *limitStream(
    data: AsyncIterable<Uint8Array>,
    reservation: Awaited<ReturnType<StorageBudget['reserve']>>,
  ): AsyncIterable<Uint8Array> {
    let total = 0
    for await (const chunk of data) {
      total += chunk.byteLength
      if (total > this.fileAdmission.maxUploadBytes) {
        throw new AttachmentError('File upload exceeds the configured byte limit.', 'FILE_TOO_LARGE')
      }
      await reservation.grow(total)
      yield chunk
    }
  }

  /**
   * Refresh the stored-bytes snapshot after a successful save, which also
   * re-evaluates the budget warning.
   */
  private async afterSave(): Promise<void> {
    await this.budget.refresh()
  }

  /**
   * Report durable attachment storage consumption against the disk budget.
   * The snapshot reflects a fresh scan of the durable object trees.
   * @returns a read-only usage snapshot.
   */
  async usage(): Promise<AttachmentStorageUsage> {
    await this.budget.prepare()
    await this.budget.refresh()
    return this.budget.usage()
  }

  /**
   * Delete durable attachment objects that no session references and whose
   * last modification is older than the grace period. Triggering a pass is the
   * caller's decision; the caller also owns the referenced set, because only
   * it knows which sessions are live.
   * @param request - currently referenced attachment ids and the grace period.
   * @returns bytes and object count reclaimed by this pass.
   */
  async collectGarbage(request: GarbageCollectionRequest): Promise<GarbageCollectionResult> {
    if (!(request.olderThanMs >= 0)) {
      throw new Error('attachment-local: olderThanMs must be a non-negative number of milliseconds')
    }
    return this.budget.prepare().then(async () => collectUnreferencedObjects(
      this.root,
      request.referenced,
      request.olderThanMs,
    )).then(async (result) => {
      await this.budget.refresh()
      return result
    })
  }

  /**
   * Register the source the garbage-collection timer consults for referenced
   * attachment ids. The timer skips a run while the source reports no
   * readable reference set, fails, or exceeds {@link gcReferenceTimeoutMs}.
   * @param source - source resolving the referenced attachment ids, or `undefined` when references are not yet readable.
   * @returns disposer removing this source.
   */
  setGarbageReferenceSource(source: GarbageReferenceSource): () => void {
    this.garbageReferenceSource = source
    this.budget.resetGarbageSourceWarning()
    return () => {
      if (this.garbageReferenceSource === source) this.garbageReferenceSource = undefined
    }
  }

  /** Run one timer-driven collection pass against the registered reference source. */
  private async collectGarbageScheduled(): Promise<void> {
    // An asynchronous source can outlive its interval tick; a still-running
    // pass makes the next tick skip instead of racing a concurrent deletion.
    if (this.garbageCollectionRunning) return
    this.garbageCollectionRunning = true
    try {
      const source = this.garbageReferenceSource
      if (source === undefined) {
        this.budget.warnMissingGarbageSource()
        return
      }
      const referenced = await this.readReferences(source)
      if (referenced === undefined) return
      await this.collectGarbage({ referenced, olderThanMs: this.gcGracePeriodMs })
    } finally {
      this.garbageCollectionRunning = false
    }
  }

  /**
   * Read one reference set under the timeout and failure safety valve. A
   * source that throws, hangs past `gcReferenceTimeoutMs`, or reports no
   * readable references yields `undefined`, and the pass deletes nothing.
   * @param source - the registered garbage-reference source.
   * @returns the referenced attachment ids, or `undefined` when the pass must skip.
   */
  private async readReferences(source: GarbageReferenceSource): Promise<Iterable<AttachmentId> | undefined> {
    try {
      const read = source()
      if (read === undefined) return undefined
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          Promise.resolve(read),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`garbage-reference source exceeded ${String(this.gcReferenceTimeoutMs)}ms`))
            }, this.gcReferenceTimeoutMs)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      this.ctx.logger.warn(
        `attachment-local: garbage-reference source failed; skipping this collection pass: ${String(error)}`,
      )
      return undefined
    }
  }

  override readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    return readFileStreamVerbatim(this.root, ref, signal)
  }

  override fileHostPath(ref: FileAttachmentRef): string {
    return storedFilePath(this.root, ref)
  }

  override async readImageRequest(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    return this.requestVersion(ref, target, undefined, signal)
  }

  private requestVersion(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    stored: StoredImageAttachment | undefined,
    signal: AbortSignal | undefined,
  ): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    const variantId = requestImageVariantId(ref, target)
    const key = String(variantId)
    let operation = this.requestInflight.get(key)
    if (operation?.controller.signal.aborted) {
      this.requestInflight.delete(key)
      operation = undefined
    }
    if (operation === undefined) {
      const shared = new SharedRequest<RequestImageAttachment>(sharedSignal => this.compression.run(async () => {
        const request = await readRequestImageFile(
          this.cacheRoot,
          stored ?? await this.readImage(ref, sharedSignal),
          target,
          sharedSignal,
        )
        return request
      }))
      operation = shared
      this.requestInflight.set(key, shared)
      void shared.promise.finally(() => {
        if (this.requestInflight.get(key) === shared) this.requestInflight.delete(key)
      }).catch(() => {})
    }
    return operation.wait(signal)
  }

}

export default LocalAttachmentStore
