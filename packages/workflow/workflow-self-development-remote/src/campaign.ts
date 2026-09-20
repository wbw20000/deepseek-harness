/**
 * Per-task campaign record storage: one JSON file per task under the control
 * directory's `campaigns` subdirectory. A campaign record is per-task runtime
 * state the facade owns exclusively — the core journal never records it — so
 * a restart never finds `startAttempt`'s own recovery covering it: the scan
 * below is this package's own recovery step for campaigns it left running.
 * @module @deepseek-ai/dsh-workflow-self-development-remote/campaign
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { SelfDevelopmentRemoteError } from './errors.ts'
import { parseStoredCampaignRecord } from './schema.ts'
import type { CampaignState } from './types.ts'

/** Directory mode the facade creates the campaigns directory with. */
const DIRECTORY_MODE = 0o700

/** File mode every stored campaign record is written with. */
const FILE_MODE = 0o600

/** Reason a restart records on every campaign it finds `running`. */
export const PROCESS_RESTARTED_REASON = 'process restarted'

/**
 * Stored campaign record: the public {@link CampaignState} fields plus the
 * `startCampaign` options every automatic round derives from. Never exposed
 * to a caller as-is; `toCampaignState` in `wire.ts` projects the public view.
 */
export interface CampaignRecord extends CampaignState {
  /** Whether this campaign's rounds keep launching automatically past the first. */
  readonly unattended: boolean
  /** The person who accepted this campaign; every derived round's `confirmedBy`. */
  readonly acceptedBy: string
}

/**
 * The file path of one task's campaign record.
 * @param controlDirectory - the facade's configured control directory.
 * @param taskId - task identity naming the file.
 * @returns the absolute path `<controlDirectory>/campaigns/<taskId>.json`.
 */
export function campaignPath(controlDirectory: string, taskId: string): string {
  return join(controlDirectory, 'campaigns', `${taskId}.json`)
}

/**
 * Read one task's stored campaign record.
 * @param controlDirectory - the facade's configured control directory.
 * @param taskId - task identity naming the file.
 * @returns the stored record, or `undefined` when the task has no campaign.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when the file exists but
 *   is not valid JSON or fails the stored shape validation; the message names the file path,
 *   never its content.
 * @throws whatever the filesystem rejects with other than a missing file.
 */
export async function readCampaign(controlDirectory: string, taskId: string): Promise<CampaignRecord | undefined> {
  const path = campaignPath(controlDirectory, taskId)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // JSON.parse failure messages can quote the file's bytes, so the refusal
    // names only the path.
    throw new SelfDevelopmentRemoteError('self-development/config-invalid', `campaign record ${path} is not valid JSON`)
  }
  return parseStoredCampaignRecord(path, parsed)
}

/**
 * Store one campaign record atomically: the bytes land in a fresh 0600
 * temporary file inside the campaigns directory and rename over the target,
 * so a reader never observes a partial record.
 * @param controlDirectory - the facade's configured control directory.
 * @param taskId - task identity naming the file.
 * @param record - the record to store.
 * @throws whatever the filesystem rejects with; the caller converts it at the facade boundary.
 */
export async function writeCampaign(controlDirectory: string, taskId: string, record: CampaignRecord): Promise<void> {
  const directory = join(controlDirectory, 'campaigns')
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE })
  const temporary = join(directory, `${taskId}.json.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE })
  await rename(temporary, campaignPath(controlDirectory, taskId))
}

/**
 * List every stored campaign record under the control directory.
 * @param controlDirectory - the facade's configured control directory.
 * @returns one record per `campaigns/*.json` file, in directory order; `[]`
 *   before any campaign has ever started.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when a listed file fails
 *   its shape validation.
 * @throws whatever the filesystem rejects with other than a missing directory.
 */
export async function listCampaigns(controlDirectory: string): Promise<readonly CampaignRecord[]> {
  const directory = join(controlDirectory, 'campaigns')
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const records: CampaignRecord[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const taskId = entry.name.slice(0, -'.json'.length)
    const record = await readCampaign(controlDirectory, taskId)
    // readCampaign returns undefined only on ENOENT, and nothing in this
    // package ever deletes a campaign file, so a listed entry going missing
    // before this read is a race this codebase's own writers never trigger.
    /* v8 ignore next */
    if (record !== undefined) records.push(record)
  }
  return records
}

/**
 * Count campaigns currently `running`, for the `maxConcurrentCampaigns` gate.
 * @param controlDirectory - the facade's configured control directory.
 * @returns the number of stored records with `status: 'running'`.
 */
export async function countRunningCampaigns(controlDirectory: string): Promise<number> {
  const records = await listCampaigns(controlDirectory)
  return records.filter(record => record.status === 'running').length
}

/**
 * This process's one-time campaign recovery step: every stored campaign left
 * `running` by a previous process — this process crashed, was killed, or
 * restarted mid-loop — is marked `stopped` with
 * {@link PROCESS_RESTARTED_REASON}. Never auto-resumed: an unattended
 * campaign's loop is this process's own in-memory task, so nothing here can
 * tell a genuinely abandoned campaign from one about to be resumed by a
 * caller that has not called `startCampaign` again yet.
 * @param controlDirectory - the facade's configured control directory.
 * @returns nothing; each affected record is rewritten in place.
 */
export async function stopRunningCampaignsAfterRestart(controlDirectory: string): Promise<void> {
  const records = await listCampaigns(controlDirectory)
  const now = Date.now()
  for (const record of records) {
    if (record.status !== 'running') continue
    await writeCampaign(controlDirectory, record.taskId, {
      ...record,
      status: 'stopped',
      reason: PROCESS_RESTARTED_REASON,
      updatedAt: now,
    })
  }
}
