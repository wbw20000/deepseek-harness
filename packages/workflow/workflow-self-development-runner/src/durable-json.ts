/**
 * Stable-side durable JSON primitives: exclusive temporary file, file sync,
 * atomic rename, and directory sync for every launch record and attempt
 * evidence file. A record exists durably only after the rename lands, so an
 * interrupted write never leaves a readable half-published file.
 *
 * Single-writer assumption: the existence check and the rename are not
 * mutually exclusive across processes, and `wx` only protects the temporary
 * file; when several processes write the same target concurrently, the last
 * rename wins.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/durable-json
 */

import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { SelfDevelopmentRunnerError } from './runtime.ts'
import type { SelfDevelopmentRunnerErrorCode } from './runtime.ts'

/**
 * Encode `value` as the exact bytes a durable write publishes.
 * @param value - JSON-encodable value to encode.
 * @returns the pretty-printed JSON bytes with one trailing newline.
 */
function encodeJson(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * Reject a non-absolute target path before any filesystem call: a relative
 * path would resolve against the process working directory, which is not a
 * stable side.
 * @param path - target path as handed in.
 * @returns the same path once proven absolute.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when `path` is not
 *   absolute.
 */
function absolutePath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new SelfDevelopmentRunnerError(
      `durable JSON path ${JSON.stringify(path)} must be absolute`,
      'SELF_DEV_RUNNER_EVIDENCE_INVALID',
    )
  }
  return path
}

/**
 * Wrap one filesystem failure as the durable-write failure code, keeping the
 * original error as `cause`.
 * @param action - filesystem action that failed, for the message.
 * @param error - original failure.
 * @returns a boundary error carrying the original error as cause.
 */
function withCause(code: SelfDevelopmentRunnerErrorCode, message: string, error: unknown): SelfDevelopmentRunnerError {
  const boundary = new SelfDevelopmentRunnerError(message, code)
  boundary.cause = error
  return boundary
}

function failed(action: string, error: unknown): SelfDevelopmentRunnerError {
  return withCause('SELF_DEV_RUNNER_EVIDENCE_FAILED', `durable JSON ${action} failed: ${detail(error)}`, error)
}

/**
 * Describe one unknown failure for a boundary message.
 * @param error - thrown value of any type.
 * @returns the error's message, or its string form when it is not an Error.
 */
function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Best-effort removal of a leftover temporary file. The publish already
 * failed, so this cleanup failure is reported in the message and must not
 * mask the original cause.
 * @param tempPath - temporary file that may still exist.
 * @param error - original publish failure to keep as cause.
 * @returns an error whose message names the cleanup outcome and whose cause is
 *   the original failure.
 */
async function cleanupTemp(tempPath: string, error: unknown): Promise<SelfDevelopmentRunnerError> {
  const boundary = failed('write', error)
  try {
    await rm(tempPath, { force: true })
  } catch (cleanupError) {
    boundary.message += ` (temporary file ${tempPath} could not be removed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)})`
  }
  return boundary
}

/**
 * Sync the directory that received a rename so the new name survives a crash.
 * @param directory - absolute directory to sync.
 * @returns resolves when the directory entry is durable.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_FAILED` when the directory
 *   cannot be opened or synced.
 */
async function syncDirectory(directory: string): Promise<void> {
  let handle
  try {
    handle = await open(directory, 'r')
  } catch (error) {
    throw failed('directory open', error)
  }
  try {
    await handle.sync()
  } catch (error) {
    throw failed('directory sync', error)
  } finally {
    await handle.close()
  }
}

/**
 * Write JSON durably: encode, compare against an existing target, and
 * otherwise publish through an exclusive temporary file in the target
 * directory — file sync, rename, directory sync. The parent directory is
 * created when missing.
 * @param path - absolute target file path.
 * @param value - JSON-encodable value to write.
 * @returns `'written'` when the target now holds these bytes, `'unchanged'`
 *   when it already held exactly these bytes and was left untouched.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when `path` is not
 *   absolute, with `SELF_DEV_RUNNER_EVIDENCE_CONFLICT` when the target exists
 *   with different bytes, or with `SELF_DEV_RUNNER_EVIDENCE_FAILED` when any
 *   I/O step fails (the temporary file is then removed best-effort and the
 *   original error is kept as cause).
 */
export async function writeDurableJson(path: string, value: unknown): Promise<'written' | 'unchanged'> {
  absolutePath(path)
  const bytes = encodeJson(value)
  const existing = await stat(path).then(
    () =>
      readFile(path).catch((error: unknown) => {
        throw failed('read', error)
      }),
    (error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
      throw failed('read', error)
    },
  )
  if (existing !== undefined) {
    if (existing.equals(bytes)) return 'unchanged'
    throw new SelfDevelopmentRunnerError(
      `durable JSON target ${path} already holds different content`,
      'SELF_DEV_RUNNER_EVIDENCE_CONFLICT',
    )
  }
  const directory = dirname(path)
  const tempPath = join(directory, `${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
  try {
    await mkdir(directory, { recursive: true })
    const handle = await open(tempPath, 'wx')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, path)
    await syncDirectory(directory)
  } catch (error) {
    throw await cleanupTemp(tempPath, error)
  }
  return 'written'
}

/**
 * Read a JSON file previously published by `writeDurableJson`.
 * @param path - absolute target file path.
 * @returns the parsed value, or `undefined` when the file does not exist.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when `path` is not
 *   absolute, the file cannot be read, or its bytes are not valid JSON.
 */
export async function readDurableJson(path: string): Promise<unknown> {
  absolutePath(path)
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw withCause(
      'SELF_DEV_RUNNER_EVIDENCE_INVALID',
      `durable JSON read of ${path} failed: ${detail(error)}`,
      error,
    )
  }
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw withCause(
      'SELF_DEV_RUNNER_EVIDENCE_INVALID',
      `durable JSON file ${path} is not valid JSON: ${detail(error)}`,
      error,
    )
  }
}
