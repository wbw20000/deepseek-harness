/**
 * Trial workspace seeding: register the task worktree in the trial data
 * home's workspace registry before its `dsh web` starts, so the trial GUI
 * opens on the worktree instead of asking the person to add a workspace.
 *
 * The registry is the workspace domain's single-unit JSON document
 * (`storages/workspace.json`, the layout the default `storage-json` backend
 * writes): a unit header naming the domain and its version, the global
 * order/bootstrap state, and the `workspaces` table. The record shape and
 * the version come from the workspace package's own domain spec, so a
 * schema change there fails this module's validation instead of writing a
 * stale record. A registry the host does not read (another storage backend)
 * is left with a harmless extra file.
 * @module @deepseek-ai/dsh-workflow-self-development-trial/workspace-seed
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  WorkspaceId,
  realpathNormalize,
  workspaceDomainSpec,
  workspaceDomainState,
  workspaceRecord,
  type WorkspaceDomainState,
  type WorkspaceRecord,
} from '@deepseek-ai/dsh-workspace'

/** The registry file, relative to the data home. */
export const WORKSPACE_UNIT_FILE = join('storages', 'workspace.json')

/** Why the worktree was, or was not, written into the registry. */
export type SeedOutcome =
  /** The worktree record was written. */
  | { readonly kind: 'seeded'; readonly path: string }
  /** The registry already held the worktree. */
  | { readonly kind: 'present'; readonly path: string }
  /** The registry was left alone; the reason names why. */
  | { readonly kind: 'skipped'; readonly reason: string }

/** The single-unit document as `storage-json` lays it out. */
interface UnitDocument {
  readonly unit: { readonly name: string; readonly version: number }
  readonly global: WorkspaceDomainState
  readonly tables: { readonly workspaces: Record<string, WorkspaceRecord> }
}

/**
 * Parse an existing registry document, validating the header against the
 * workspace domain spec and every record against its schema.
 * @param text - the file's content.
 * @returns the document.
 * @throws Error naming the first field that does not match.
 */
function parseDocument(text: string): UnitDocument {
  const raw: unknown = JSON.parse(text)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('registry file is not a JSON object')
  const { unit, global: globalValue, tables } = raw as Record<string, unknown>
  const header = typeof unit === 'object' && unit !== null ? unit as Record<string, unknown> : undefined
  if (header?.['name'] !== workspaceDomainSpec.name || header['version'] !== workspaceDomainSpec.version) {
    throw new Error(`registry header is not ${workspaceDomainSpec.name} v${String(workspaceDomainSpec.version)}`)
  }
  const state = workspaceDomainState.parse(globalValue)
  const table = typeof tables === 'object' && tables !== null ? (tables as Record<string, unknown>)['workspaces'] : undefined
  if (typeof table !== 'object' || table === null || Array.isArray(table)) throw new Error('registry has no workspaces table')
  const workspaces: Record<string, WorkspaceRecord> = {}
  for (const [id, record] of Object.entries(table as Record<string, unknown>)) workspaces[id] = workspaceRecord.parse(record)
  return { unit: { name: workspaceDomainSpec.name, version: workspaceDomainSpec.version }, global: state, tables: { workspaces } }
}

/**
 * Write the document atomically: a fresh temporary file in the same
 * directory, renamed over the target.
 * @param path - the registry file.
 * @param document - the document to store.
 */
async function writeDocument(path: string, document: UnitDocument): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`)
  await rename(temporary, path)
}

/**
 * Ensure the trial data home's workspace registry lists the worktree.
 *
 * A missing registry is created with the worktree as its only workspace and
 * `initialized: false`, so the registry's own history bootstrap still runs
 * on first open and attaches the campaign's stored sessions to the record. An
 * existing registry gains the record at the front of the display order and
 * keeps its bootstrap state. A registry with a pending mutation marker is not
 * touched: the registry recovers it on open, and a second writer would only
 * confuse that recovery.
 * @param dshHome - the trial data home.
 * @param worktree - the task worktree, an existing absolute directory.
 * @param title - display title for a newly written record.
 * @param now - host clock for the record's timestamps.
 * @returns what happened.
 * @throws whatever the filesystem rejects with other than a missing registry, and a parse
 *   error for a registry this module does not recognise; the caller decides whether the
 *   trial still opens.
 */
export async function seedTrialWorkspace(dshHome: string, worktree: string, title: string, now: () => number): Promise<SeedOutcome> {
  const path = await realpathNormalize(worktree)
  const file = join(dshHome, WORKSPACE_UNIT_FILE)
  let existing: UnitDocument | undefined
  try {
    existing = parseDocument(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing?.global.pendingMutation !== undefined) {
    return { kind: 'skipped', reason: `registry has a pending ${existing.global.pendingMutation.operation}; left for the host to recover` }
  }
  if (existing !== undefined && Object.values(existing.tables.workspaces).some(record => record.path === path)) {
    return { kind: 'present', path }
  }
  const id = WorkspaceId(randomUUID())
  const stamp = new Date(now()).toISOString()
  const record: WorkspaceRecord = { path, title, sessionIds: [], createdAt: stamp, updatedAt: stamp }
  const document: UnitDocument = existing === undefined
    ? {
      unit: { name: workspaceDomainSpec.name, version: workspaceDomainSpec.version },
      global: { initialized: false, workspaceIds: [id], archivedSessionIds: [] },
      tables: { workspaces: { [id]: record } },
    }
    : {
      ...existing,
      global: { ...existing.global, workspaceIds: [id, ...existing.global.workspaceIds] },
      tables: { workspaces: { ...existing.tables.workspaces, [id]: record } },
    }
  await mkdir(join(dshHome, 'storages'), { recursive: true })
  await writeDocument(file, document)
  return { kind: 'seeded', path }
}
