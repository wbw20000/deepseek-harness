/** Disk-budget reservation ledger for local attachment storage. @module internal */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { scanStoredObjectBytes } from './gc.ts'
import type { AttachmentStorageUsage } from '@deepseek-ai/dsh-attachment'

/** On-disk reservation record left behind for crash recovery. */
interface ReservationRecord {
  /** Reserved byte count, updated while an undeclared stream grows. */
  bytes: number
  /** Creation instant in ISO form, for diagnostics only. */
  createdAt: string
}

/** One active reservation against the disk budget. */
export interface UploadReservation {
  /**
   * Raise the reservation to a new running total for a stream that declared
   * no length. The new total is rejected when the budget can no longer hold it.
   * @param totalBytes - bytes written by this upload so far.
   * @throws an AttachmentError with `DISK_BUDGET_EXCEEDED` when the budget is exceeded.
   */
  grow(totalBytes: number): Promise<void>
  /** Release the reservation and drop its record. */
  release(): Promise<void>
}

/**
 * Budget accounting for one local attachment root. Reservations live in
 * memory and as records beside the store, so a concurrent total can never
 * exceed the budget and a crashed process's records are discoverable at the
 * next startup.
 */
export class StorageBudget {
  private readonly reservations: string
  private readonly staging: string
  private reserved = 0
  private usedBytes = 0
  private prepared = false
  private warned = false
  private gcSourceWarned = false

  /**
   * @param root - absolute versioned attachment root.
   * @param budgetBytes - disk budget in bytes; 0 disables budgeting.
   * @param warnRatio - budget fraction at or above which a warning fires.
   * @param warn - warning sink, normally the harness logger.
   */
  constructor(
    readonly root: string,
    readonly budgetBytes: number,
    readonly warnRatio: number,
    private readonly warn: (message: string) => void,
  ) {
    this.reservations = join(root, 'reservations')
    this.staging = join(root, 'tmp')
  }

  /**
   * Run the one-time startup recovery: drop orphan reservation records and
   * staging files left by a crashed process, then take the initial
   * stored-bytes snapshot. Later calls return immediately.
   */
  async prepare(): Promise<void> {
    if (this.prepared) return
    await mkdir(this.reservations, { recursive: true, mode: 0o700 })
    await this.sweepOrphans()
    this.prepared = true
    await this.refresh()
  }

  /**
   * Delete orphan reservation records and staging files left by a crashed
   * process. The ledger cannot distinguish a live process from a crash, so
   * callers own the single-writer assumption this sweep requires. Either
   * directory may be absent on a fresh store; other failures propagate.
   */
  async sweepOrphans(): Promise<void> {
    for (const entry of await this.listOrphans(this.reservations)) {
      await rm(join(this.reservations, entry), { recursive: true, force: true })
    }
    for (const entry of await this.listOrphans(this.staging)) {
      await rm(join(this.staging, entry), { recursive: true, force: true })
    }
  }

  /**
   * List one sweep directory, treating an absent directory as empty.
   * @param dir - absolute directory path.
   * @returns entry names, or an empty array when the directory does not exist.
   */
  private async listOrphans(dir: string): Promise<string[]> {
    return readdir(dir).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    })
  }

  /**
   * Rescan stored object bytes and re-evaluate the warning threshold.
   * @returns the refreshed stored-bytes snapshot.
   */
  async refresh(): Promise<number> {
    this.usedBytes = await scanStoredObjectBytes(this.root)
    this.evaluateWarning()
    return this.usedBytes
  }

  /**
   * Reserve byte capacity for one upload before any byte is written.
   * @param bytes - declared byte count, or 0 for a stream of unknown length.
   * @returns the reservation to grow and release around the write.
   * @throws an AttachmentError with `DISK_BUDGET_EXCEEDED` when the budget cannot hold the upload.
   */
  async reserve(bytes: number): Promise<UploadReservation> {
    if (this.budgetBytes === 0) {
      return { grow: () => Promise.resolve(), release: () => Promise.resolve() }
    }
    await this.prepare()
    const amount = { value: bytes }
    this.assertFits(bytes)
    this.reserved += bytes
    const record = join(this.reservations, `${randomUUID()}.json`)
    try {
      await this.writeRecord(record, amount.value)
    } catch (error) {
      this.reserved -= bytes
      throw new AttachmentError('Unable to record upload reservation.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
    }
    return {
      grow: async (totalBytes: number): Promise<void> => {
        const delta = totalBytes - amount.value
        if (delta <= 0) return
        this.assertFits(delta)
        this.reserved += delta
        amount.value = totalBytes
        try {
          await this.writeRecord(record, totalBytes)
        } catch (error) {
          this.reserved -= delta
          amount.value = totalBytes - delta
          throw new AttachmentError('Unable to record upload reservation.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
        }
      },
      release: async (): Promise<void> => {
        this.reserved -= amount.value
        amount.value = 0
        await unlink(record).catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
          throw error
        })
      },
    }
  }

  /**
   * Read-only usage snapshot against the budget. The snapshot reflects the
   * last rescan; callers wanting a fresh value call {@link refresh} first.
   * @returns current usage facts.
   */
  usage(): AttachmentStorageUsage {
    return {
      usedBytes: this.usedBytes,
      budgetBytes: this.budgetBytes,
      budgetWarnRatio: this.warnRatio,
      overBudgetWarn: this.budgetBytes > 0 && this.usedBytes >= this.budgetBytes * this.warnRatio,
      overBudget: this.budgetBytes > 0 && this.usedBytes > this.budgetBytes,
    }
  }

  /**
   * Warn once when the garbage-collection timer has no reference source to
   * consult; the warning repeats only after a source is registered and
   * removed again.
   */
  warnMissingGarbageSource(): void {
    if (this.gcSourceWarned) return
    this.gcSourceWarned = true
    this.warn('attachment-local: gcIntervalMs is set but no reference source is registered; scheduled garbage collection is skipped')
  }

  /**
   * Reset the missing-source warning latch so a later unregistered state
   * warns again.
   */
  resetGarbageSourceWarning(): void {
    this.gcSourceWarned = false
  }

  /**
   * Re-evaluate the budget warning after usage moves. One warning fires per
   * crossing of the threshold, and the latch resets when usage falls back
   * below it, so a later crossing warns again instead of repeating on every
   * save.
   */
  private evaluateWarning(): void {
    const usage = this.usage()
    if (!usage.overBudgetWarn) {
      this.warned = false
      return
    }
    if (this.warned) return
    this.warned = true
    this.warn(
      `attachment-local: attachment storage holds ${usage.usedBytes} bytes of its ${usage.budgetBytes} byte budget `
      + `(warning threshold ${this.warnRatio})`,
    )
  }

  /**
   * Verify the budget can absorb one more reservation on top of stored bytes
   * and every active reservation.
   * @param bytes - additional bytes to reserve.
   * @throws an AttachmentError with `DISK_BUDGET_EXCEEDED` when the budget is exceeded.
   */
  private assertFits(bytes: number): void {
    if (this.usedBytes + this.reserved + bytes > this.budgetBytes) {
      throw new AttachmentError('File upload exceeds the configured disk budget.', 'DISK_BUDGET_EXCEEDED')
    }
  }

  /**
   * Persist one reservation record beside the store.
   * @param record - absolute record path.
   * @param bytes - reserved byte count.
   */
  private async writeRecord(record: string, bytes: number): Promise<void> {
    const payload: ReservationRecord = { bytes, createdAt: new Date().toISOString() }
    await writeFile(record, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
}
