/**
 * Per-task trial-record storage: one JSON sidecar per task under the control
 * directory's `trials` subdirectory, written atomically with the same
 * temporary-file-and-rename template the launch-profile store uses. The
 * sidecar is the only place the launch token is persisted; the log file next
 * to it is redacted.
 * @module @deepseek-ai/dsh-workflow-self-development-trial/registry
 */

import { appendFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { TrialRecord } from './types.ts'

/** Directory mode the manager creates the trials directory with. */
export const TRIALS_DIRECTORY_MODE = 0o700

/** File mode every stored record is written with. */
export const TRIAL_RECORD_FILE_MODE = 0o600

/**
 * The file path of one task's trial record.
 * @param controlDirectory - the manager's configured control directory.
 * @param taskId - task identity naming the file.
 * @returns the absolute path `<controlDirectory>/trials/<taskId>.json`.
 */
export function trialRecordPath(controlDirectory: string, taskId: string): string {
  return join(controlDirectory, 'trials', `${taskId}.json`)
}

/**
 * The file path of one task's trial log.
 * @param controlDirectory - the manager's configured control directory.
 * @param taskId - task identity naming the file.
 * @returns the absolute path `<controlDirectory>/trials/<taskId>.log`.
 */
export function trialLogPath(controlDirectory: string, taskId: string): string {
  return join(controlDirectory, 'trials', `${taskId}.log`)
}

/**
 * Store one trial record atomically: the bytes land in a fresh 0600
 * temporary file inside the trials directory and rename over the target, so
 * a reader never observes a partial record.
 * @param controlDirectory - the manager's configured control directory.
 * @param taskId - task identity naming the file.
 * @param record - the record to store.
 * @throws whatever the filesystem rejects with; the caller converts it at the service boundary.
 */
export async function writeTrialRecord(
  controlDirectory: string,
  taskId: string,
  record: TrialRecord,
): Promise<void> {
  const directory = join(controlDirectory, 'trials')
  await mkdir(directory, { recursive: true, mode: TRIALS_DIRECTORY_MODE })
  const temporary = join(directory, `${taskId}.json.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: TRIAL_RECORD_FILE_MODE })
  await rename(temporary, trialRecordPath(controlDirectory, taskId))
}

/**
 * Remove one task's trial record. A missing file is already the target state.
 * @param controlDirectory - the manager's configured control directory.
 * @param taskId - task identity naming the file.
 * @throws whatever the filesystem rejects with other than a missing file.
 */
export async function removeTrialRecord(controlDirectory: string, taskId: string): Promise<void> {
  try {
    await unlink(trialRecordPath(controlDirectory, taskId))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/**
 * Append one redacted line to a task's trial log, creating the trials
 * directory on first write. The token is redacted by the caller before the
 * text reaches this function; this module never receives an unredacted URL.
 * @param controlDirectory - the manager's configured control directory.
 * @param taskId - task identity naming the file.
 * @param line - already-redacted text; a trailing newline is added when absent.
 */
export async function appendTrialLog(controlDirectory: string, taskId: string, line: string): Promise<void> {
  const directory = join(controlDirectory, 'trials')
  await mkdir(directory, { recursive: true, mode: TRIALS_DIRECTORY_MODE })
  const text = line.endsWith('\n') ? line : `${line}\n`
  await appendFile(trialLogPath(controlDirectory, taskId), text, { mode: TRIAL_RECORD_FILE_MODE })
}
