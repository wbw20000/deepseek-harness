/**
 * Durable task journal: an append-only, hash-chained JSONL log with bounded
 * segments, a protected checkpoint, and an atomically replaced projection
 * file. The journal owns one private task directory under the configured
 * control root and fsyncs every mutation — record, checkpoint, projection,
 * and the containing directory after a new file appears — before the caller
 * may observe it.
 *
 * The chain and checkpoint detect accidental truncation and task-side
 * tampering. They prove nothing against a host administrator or any attacker
 * that can rewrite the journal and the checkpoint together: the control
 * directory must live outside the experiment's writable scope for the
 * protection to mean anything.
 * @module @deepseek-ai/dsh-workflow-self-development/journal
 */

import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { SelfDevelopmentError, TASK_JOURNAL_SCHEMA_VERSION, digestJson } from './runtime.ts'
import { committedOperationSchema, parseInput, taskEventSchema } from './schema.ts'
import type { CommittedOperation, CommittedRecord, JournalReadResult, TaskEvent } from './types.ts'

/** Journal configuration owned by the service config. */
export interface JournalOptions {
  /** Records per segment file before rotation. */
  readonly maxRecordsPerSegment: number
  /** Committed records between checkpoint rewrites. */
  readonly checkpointInterval: number
}

/**
 * Fixed read bounds. These are protocol invariants, not deployment tunables:
 * a journal file larger than this is not a journal this package wrote.
 */
const MAX_SEGMENT_BYTES = 256 * 1024 * 1024
/** Fixed read bound for one record line. */
const MAX_RECORD_BYTES = 1024 * 1024
/** Fixed read bound for the checkpoint and projection files. */
const MAX_STATE_FILE_BYTES = 1024 * 1024

/** Segment file name for the segment that starts at `firstSeq`. */
function segmentName(firstSeq: number): string {
  return `events.${String(firstSeq).padStart(8, '0')}.jsonl`
}

const SEGMENT_PATTERN = /^events\.(\d{8})\.jsonl$/u

/** Wire form of the protected checkpoint. */
interface Checkpoint {
  readonly schemaVersion: number
  readonly seq: number
  readonly hash: string
  readonly segment: string
}

/** Compute a record's chain hash over its identity fields. */
function recordHash(record: Omit<CommittedRecord, 'hash'>): string {
  return digestJson({
    schemaVersion: record.schemaVersion,
    seq: record.seq,
    prevHash: record.prevHash,
    operation: record.operation,
    event: record.event,
  })
}

/** Errno code of a filesystem error, for distinguishing absence from denial. */
function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** Whether an unreadable path is genuinely absent rather than denied or wrong-shaped. */
function isAbsence(error: unknown): boolean {
  return errnoOf(error) === 'ENOENT'
}

/**
 * Append one line durably: write every byte (a single `write` may be short),
 * fsync the file, and fsync the directory once a new file appears so the
 * directory entry survives a crash too.
 */
async function appendDurableLine(path: string, line: string, syncDirectory: boolean): Promise<void> {
  const handle = await open(path, 'a')
  try {
    const bytes = Buffer.from(line, 'utf8')
    let written = 0
    while (written < bytes.length) {
      const { bytesWritten } = await handle.write(bytes.subarray(written))
      if (bytesWritten <= 0) throw new Error(`write to ${path} made no progress`)
      written += bytesWritten
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (syncDirectory) await syncDirectoryEntry(path)
}

/**
 * Flush a directory entry so a newly created or renamed file is reachable
 * after a crash. Unsupported platforms skip the call rather than fake it.
 */
async function syncDirectoryEntry(path: string): Promise<void> {
  if (process.platform === 'win32') {
    // Windows has no portable directory-fsync; the atomic rename ordering is
    // the durability guarantee this platform gets.
    return
  }
  const handle = await open(dirname(path), 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Flush a file written by an atomic rename: the content bytes and the
 * directory entry both need an fsync for the replacement to be durable.
 */
async function syncAtomicWrite(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectoryEntry(path)
}

/** Durable journal and projection storage for one task. */
export class TaskJournal {
  /** First sequence number of the segment currently being appended to. */
  #segmentFirstSeq = 1
  /** Records committed to the current segment. */
  #segmentRecordCount = 0
  /** Last committed record, or undefined for an empty journal. */
  #last: CommittedRecord | undefined

  private constructor(
    private readonly taskDir: string,
    private readonly options: JournalOptions,
  ) {}

  /**
   * Open (or create) the journal directory for one task. Opening refuses a
   * journal that fails verification; the files stay untouched for review.
   * @param taskDir - private directory this journal owns exclusively.
   * @param options - segment and checkpoint bounds.
   * @returns the opened journal positioned after every committed record.
   * @throws SelfDevelopmentError with `SELF_DEV_JOURNAL_UNAVAILABLE` when the directory cannot be prepared or the journal is not intact.
   */
  static async open(taskDir: string, options: JournalOptions): Promise<TaskJournal> {
    try {
      await mkdir(taskDir, { recursive: true })
    } catch (error: unknown) {
      throw new SelfDevelopmentError(
        `cannot create task journal directory ${taskDir}: ${String(error)}`,
        'SELF_DEV_JOURNAL_UNAVAILABLE',
      )
    }
    const journal = new TaskJournal(taskDir, options)
    const read = await journal.read()
    if (read.status !== 'ok') {
      throw new SelfDevelopmentError(
        `task journal ${taskDir} is not intact (${read.status}): ${read.detail ?? 'unknown reason'}`,
        'SELF_DEV_JOURNAL_UNAVAILABLE',
      )
    }
    const last = read.records.at(-1)
    journal.#last = last
    if (last !== undefined) {
      const files = await journal.listSegmentFiles()
      const currentSegment = files.at(-1)
      journal.#segmentFirstSeq = currentSegment === undefined ? 1 : Number(SEGMENT_PATTERN.exec(currentSegment)?.[1])
      journal.#segmentRecordCount = last.seq - journal.#segmentFirstSeq + 1
    }
    return journal
  }

  /** List committed segment file names in order. */
  private async listSegmentFiles(): Promise<string[]> {
    return (await readdir(this.taskDir))
      .filter(name => SEGMENT_PATTERN.test(name))
      .sort()
  }

  /**
   * Read and verify the whole journal: segment names and order, bounded
   * regular-file reads, terminal newlines, full event schemas, chain
   * continuity, record hashes, and the protected checkpoint. A read never
   * rewrites the original files; a rejected journal keeps its bytes for
   * human review. Absence and denial are distinguished: a missing checkpoint
   * over a nonempty log is corruption, while an unreadable one reports the
   * errno.
   * @returns the verified records, or the failure status with its reason.
   */
  async read(): Promise<JournalReadResult> {
    let segmentFiles: string[]
    try {
      segmentFiles = await this.listSegmentFiles()
    } catch (error: unknown) {
      return { status: 'corrupt', records: [], detail: `cannot list task journal (${errnoOf(error) ?? 'unknown error'}): ${String(error)}` }
    }
    let checkpoint: Checkpoint | undefined
    try {
      checkpoint = await this.readCheckpoint()
    } catch (error: unknown) {
      return { status: 'corrupt', records: [], detail: String(error) }
    }
    if (checkpoint === undefined && segmentFiles.length === 0) {
      return { status: 'ok', records: [], detail: undefined }
    }
    const records: CommittedRecord[] = []
    let prevHash = ''
    let expectedSeq = 1
    for (const [segmentIndex, file] of segmentFiles.entries()) {
      const segmentStart = Number(SEGMENT_PATTERN.exec(file)?.[1])
      if (segmentStart !== expectedSeq) {
        return {
          status: 'corrupt',
          records,
          detail: `segment ${file} starts at ${segmentStart}, but the chain expects ${expectedSeq}`,
        }
      }
      const segmentText = await this.readSegment(file)
      if (typeof segmentText === 'object') return { status: 'corrupt', records, detail: segmentText.detail }
      const text = segmentText
      if (!text.endsWith('\n')) {
        const isTailSegment = segmentIndex === segmentFiles.length - 1
        return isTailSegment
          ? { status: 'incomplete-tail', records, detail: `segment ${file} does not end with a terminal newline` }
          : { status: 'corrupt', records, detail: `segment ${file} does not end with a terminal newline` }
      }
      const lines = text.split('\n')
      lines.pop()
      for (const [lineIndex, line] of lines.entries()) {
        const isTail = segmentIndex === segmentFiles.length - 1 && lineIndex === lines.length - 1
        if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
          return { status: 'corrupt', records, detail: `segment ${file} line ${lineIndex + 1} is over the ${MAX_RECORD_BYTES}-byte record bound` }
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          // A malformed last line is an interrupted write; anywhere else the
          // log is inconsistent and side effects must stay refused.
          return isTail
            ? { status: 'incomplete-tail', records, detail: `segment ${file} ends in a partial record` }
            : { status: 'corrupt', records, detail: `segment ${file} line ${lineIndex + 1} is not valid JSON` }
        }
        const verified = verifyRecord(parsed, expectedSeq, prevHash, file, lineIndex + 1)
        if (typeof verified === 'string') return { status: 'corrupt', records, detail: verified }
        records.push(verified)
        prevHash = verified.hash
        expectedSeq = verified.seq + 1
      }
    }
    if (checkpoint !== undefined) {
      const last = records.at(-1)
      if (last === undefined || last.seq < checkpoint.seq) {
        return {
          status: 'corrupt',
          records,
          detail: `checkpoint proves records through ${checkpoint.seq}, journal ends at ${last?.seq ?? 0}`,
        }
      }
      if (records[checkpoint.seq - 1]?.hash !== checkpoint.hash) {
        return { status: 'corrupt', records, detail: `checkpoint hash does not match record ${checkpoint.seq}` }
      }
    } else if (records.length > 0) {
      return {
        status: 'corrupt',
        records,
        detail: `journal holds ${records.length} committed records without a checkpoint`,
      }
    }
    return { status: 'ok', records, detail: undefined }
  }

  /**
   * Read one segment after proving it is a regular file inside the size
   * bounds. Returns the file text, or the rejection detail.
   */
  private async readSegment(file: string): Promise<string | { detail: string }> {
    const path = join(this.taskDir, file)
    try {
      const stats = await lstat(path)
      if (!stats.isFile()) return { detail: `segment ${file} is not a regular file (${stats.isDirectory() ? 'directory' : 'special file'})` }
      if (stats.size > MAX_SEGMENT_BYTES) return { detail: `segment ${file} is ${stats.size} bytes, over the ${MAX_SEGMENT_BYTES}-byte read bound` }
      return await readFile(path, 'utf8')
    } catch (error: unknown) {
      return { detail: `cannot read segment ${file} (${errnoOf(error) ?? 'unknown error'}): ${String(error)}` }
    }
  }

  /**
   * Read and structure-check the protected checkpoint. Absence returns
   * undefined; every other failure — denial, a directory in its place, an
   * oversized file, invalid content — throws with the distinguishing reason.
   */
  private async readCheckpoint(): Promise<Checkpoint | undefined> {
    const path = join(this.taskDir, 'checkpoint.json')
    let text: string
    try {
      const stats = await lstat(path)
      if (!stats.isFile()) throw new Error(`checkpoint is not a regular file (${stats.isDirectory() ? 'directory' : 'special file'})`)
      if (stats.size > MAX_STATE_FILE_BYTES) throw new Error(`checkpoint is ${stats.size} bytes, over the ${MAX_STATE_FILE_BYTES}-byte read bound`)
      text = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if (isAbsence(error)) return undefined
      if (error instanceof Error && error.message.startsWith('checkpoint')) throw error
      throw new Error(`checkpoint is unreadable (${errnoOf(error) ?? 'unknown error'}): ${String(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error: unknown) {
      throw new Error(`checkpoint is not valid JSON: ${String(error)}`)
    }
    const value = parsed as Record<string, unknown>
    if (value.schemaVersion !== TASK_JOURNAL_SCHEMA_VERSION
      || typeof value.seq !== 'number' || typeof value.hash !== 'string' || typeof value.segment !== 'string') {
      throw new Error('checkpoint does not satisfy the journal schema')
    }
    return { schemaVersion: value.schemaVersion, seq: value.seq, hash: value.hash, segment: value.segment }
  }

  /**
   * Commit one event durably: append the record, fsync it, rotate the
   * segment at the configured bound, and refresh the checkpoint at the
   * configured interval. The caller may only start side effects after this
   * resolves.
   * @param event - the event to commit.
   * @param operation - operation header that produced the event, when present.
   * @returns the committed record.
   * @throws SelfDevelopmentError with `SELF_DEV_JOURNAL_UNAVAILABLE` when the append cannot be persisted.
   */
  async append(event: TaskEvent, operation: CommittedOperation | undefined): Promise<CommittedRecord> {
    if (this.#segmentRecordCount >= this.options.maxRecordsPerSegment) {
      this.#segmentFirstSeq = (this.#last?.seq ?? 0) + 1
      this.#segmentRecordCount = 0
    }
    const seq = (this.#last?.seq ?? 0) + 1
    const record: Omit<CommittedRecord, 'hash'> = {
      schemaVersion: TASK_JOURNAL_SCHEMA_VERSION,
      seq,
      prevHash: this.#last?.hash ?? '',
      operation,
      event,
    }
    const committed: CommittedRecord = { ...record, hash: recordHash(record) }
    const target = join(this.taskDir, segmentName(this.#segmentFirstSeq))
    try {
      // A segment's first record may be creating the file, so its directory
      // entry is flushed with the content.
      await appendDurableLine(target, `${JSON.stringify(committed)}\n`, this.#segmentRecordCount === 0)
    } catch (error: unknown) {
      throw new SelfDevelopmentError(
        `cannot append to task journal ${target}: ${String(error)}`,
        'SELF_DEV_JOURNAL_UNAVAILABLE',
      )
    }
    this.#last = committed
    this.#segmentRecordCount += 1
    if (seq === 1 || this.#segmentRecordCount >= this.options.maxRecordsPerSegment
      || seq % this.options.checkpointInterval === 0) {
      try {
        await this.writeCheckpoint(committed)
      } catch (error: unknown) {
        throw new SelfDevelopmentError(
          `cannot persist task checkpoint after record ${seq}: ${String(error)}`,
          'SELF_DEV_JOURNAL_UNAVAILABLE',
        )
      }
    }
    return committed
  }

  /** Atomically replace the protected checkpoint and flush it to durable storage. */
  private async writeCheckpoint(last: CommittedRecord): Promise<void> {
    const checkpoint: Checkpoint = {
      schemaVersion: TASK_JOURNAL_SCHEMA_VERSION,
      seq: last.seq,
      hash: last.hash,
      segment: segmentName(this.#segmentFirstSeq),
    }
    const path = join(this.taskDir, 'checkpoint.json')
    await writeFileAtomic(
      path,
      `${JSON.stringify(checkpoint, null, 2)}\n`,
      { mode: 0o600 },
    )
    await syncAtomicWrite(path)
  }

  /**
   * Replace the projection file with one atomic write and flush it. The
   * projection is derived state; the journal always stays authoritative.
   * @param state - JSON-encodable projection snapshot.
   */
  async writeProjection(state: unknown): Promise<void> {
    const path = join(this.taskDir, 'projection.json')
    await writeFileAtomic(
      path,
      `${JSON.stringify(state, null, 2)}\n`,
      { mode: 0o600 },
    )
    await syncAtomicWrite(path)
  }

  /**
   * Read the stored projection snapshot, if one is present and valid.
   * @returns the parsed snapshot, or undefined when the file is absent.
   * @throws SelfDevelopmentError with `SELF_DEV_JOURNAL_UNAVAILABLE` when the projection is present but unreadable.
   */
  async readProjection(): Promise<unknown> {
    let text: string
    const path = join(this.taskDir, 'projection.json')
    try {
      const stats = await lstat(path)
      if (!stats.isFile()) throw new Error('projection is not a regular file')
      if (stats.size > MAX_STATE_FILE_BYTES) throw new Error('projection exceeds the state-file byte limit')
      text = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
      throw new SelfDevelopmentError(`projection file is unreadable: ${String(error)}`, 'SELF_DEV_JOURNAL_UNAVAILABLE')
    }
    try {
      return JSON.parse(text)
    } catch (error: unknown) {
      throw new SelfDevelopmentError(`projection file is not valid JSON: ${String(error)}`, 'SELF_DEV_JOURNAL_UNAVAILABLE')
    }
  }
}

/** Type-check, chain-check, and schema-check one parsed record, returning a rejection reason on failure. */
function verifyRecord(
  parsed: unknown,
  expectedSeq: number,
  prevHash: string,
  file: string,
  lineNo: number,
): CommittedRecord | string {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return `segment ${file} line ${lineNo} is not a record object`
  }
  const value = parsed as Record<string, unknown>
  if (value.schemaVersion !== TASK_JOURNAL_SCHEMA_VERSION) {
    return `segment ${file} line ${lineNo} carries unknown schemaVersion`
  }
  if (typeof value.seq !== 'number' || typeof value.prevHash !== 'string' || typeof value.hash !== 'string'
    || value.event === undefined || typeof value.event !== 'object' || value.event === null) {
    return `segment ${file} line ${lineNo} does not satisfy the record schema`
  }
  try {
    // Every durable event must satisfy the package event schema, including a
    // null, missing, or unknown discriminant, before the fold ever sees it.
    parseInput(taskEventSchema, 'committed event', value.event)
  } catch {
    return `segment ${file} line ${lineNo} carries an event outside the durable event schema`
  }
  if (value.operation !== undefined && value.operation !== null) {
    try {
      parseInput(committedOperationSchema, 'committed operation', value.operation)
    } catch {
      return `segment ${file} line ${lineNo} carries an invalid operation header`
    }
  }
  const candidate = value as unknown as CommittedRecord
  if (candidate.seq !== expectedSeq) {
    return `segment ${file} line ${lineNo} breaks sequence order`
  }
  if (candidate.prevHash !== prevHash) {
    return `segment ${file} line ${lineNo} breaks the hash chain`
  }
  const { hash, ...identity } = candidate
  if (recordHash(identity) !== hash) {
    return `segment ${file} line ${lineNo} hash does not cover its content`
  }
  return candidate
}
