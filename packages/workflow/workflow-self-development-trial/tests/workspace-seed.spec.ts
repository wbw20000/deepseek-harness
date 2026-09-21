/**
 * The trial workspace seed: a missing registry is created around the
 * worktree, an existing one gains the worktree at the front, a registry
 * that already holds it or carries a pending mutation is left untouched,
 * and a registry this module does not recognise is refused rather than
 * overwritten.
 * @module workspace-seed.spec
 */

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { workspaceDomainSpec, workspaceDomainState, workspaceRecord } from '@deepseek-ai/dsh-workspace'
import { seedTrialWorkspace, WORKSPACE_UNIT_FILE } from '../src/workspace-seed.ts'

let base: string | undefined

afterEach(async () => {
  if (base !== undefined) await rm(base, { recursive: true, force: true })
  base = undefined
})

/** A temporary root with a data home and a worktree directory. */
async function fixture(): Promise<{ dshHome: string; worktree: string; file: string }> {
  // The canonical root: macOS's temporary directory is itself a symlink, and the
  // seed stores `fs.realpath` canons.
  base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-trial-seed-')))
  const dshHome = join(base, 'dsh-home')
  const worktree = join(base, 'worktree')
  await mkdir(dshHome, { recursive: true })
  await mkdir(worktree, { recursive: true })
  return { dshHome, worktree, file: join(dshHome, WORKSPACE_UNIT_FILE) }
}

type StoredState = ReturnType<typeof workspaceDomainState.parse>
type StoredRecord = ReturnType<typeof workspaceRecord.parse>

/** Parse the stored document the way the registry validates it. */
async function stored(file: string): Promise<{ unit: unknown; global: StoredState; workspaces: Record<string, StoredRecord> }> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as { unit: unknown; global: unknown; tables: { workspaces: Record<string, unknown> } }
  const workspaces: Record<string, StoredRecord> = {}
  for (const [id, record] of Object.entries(raw.tables.workspaces)) workspaces[id] = workspaceRecord.parse(record)
  return { unit: raw.unit, global: workspaceDomainState.parse(raw.global), workspaces }
}

const now = (): number => 1_700_000_000_000

/** An existing registry document as the registry writes one. */
function document(global: object, workspaces: Record<string, object>): string {
  return `${JSON.stringify({ unit: { name: 'workspace', version: workspaceDomainSpec.version }, global, tables: { workspaces } }, null, 2)}\n`
}

describe('seedTrialWorkspace', () => {
  it('creates a missing registry around the worktree and leaves the history bootstrap to the registry', async () => {
    const { dshHome, worktree, file } = await fixture()
    await rm(dshHome, { recursive: true })
    const outcome = await seedTrialWorkspace(dshHome, worktree, 'task (trial)', now)
    expect(outcome).toEqual({ kind: 'seeded', path: worktree })
    const { unit, global, workspaces } = await stored(file)
    expect(unit).toEqual({ name: workspaceDomainSpec.name, version: workspaceDomainSpec.version })
    expect(global.initialized).toBe(false)
    expect(global.workspaceIds).toHaveLength(1)
    const id = global.workspaceIds[0] as string
    expect(workspaces[id]).toEqual({
      path: worktree,
      title: 'task (trial)',
      sessionIds: [],
      createdAt: '2023-11-14T22:13:20.000Z',
      updatedAt: '2023-11-14T22:13:20.000Z',
    })
  })

  it('prepends the worktree to an initialized registry and keeps its other workspaces', async () => {
    const { dshHome, worktree, file } = await fixture()
    await mkdir(join(dshHome, 'storages'))
    const other = { path: join(dshHome, 'elsewhere'), title: 'other', sessionIds: ['s1'], createdAt: 't', updatedAt: 't' }
    await writeFile(file, document({ initialized: true, workspaceIds: ['other-id'], archivedSessionIds: ['s9'] }, { 'other-id': other }))
    const outcome = await seedTrialWorkspace(dshHome, worktree, 'task (trial)', now)
    expect(outcome).toEqual({ kind: 'seeded', path: worktree })
    const { global, workspaces } = await stored(file)
    expect(global.initialized).toBe(true)
    expect(global.archivedSessionIds).toEqual(['s9'])
    expect(global.workspaceIds).toHaveLength(2)
    expect(global.workspaceIds[1]).toBe('other-id')
    expect(workspaces['other-id']).toEqual(other)
    expect(workspaces[global.workspaceIds[0] as string]?.path).toBe(worktree)
    expect(Object.keys(workspaces)).toHaveLength(2)
  })

  it('stores the canonical path and reports a registry that already holds the worktree', async () => {
    const { dshHome, worktree, file } = await fixture()
    const link = join(base as string, 'link')
    await symlink(worktree, link)
    expect(await seedTrialWorkspace(dshHome, link, 'first', now)).toEqual({ kind: 'seeded', path: worktree })
    const before = await readFile(file, 'utf8')
    expect(await seedTrialWorkspace(dshHome, worktree, 'second', now)).toEqual({ kind: 'present', path: worktree })
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(Object.values((await stored(file)).workspaces).map(record => record.title)).toEqual(['first'])
  })

  it('leaves a registry with a pending mutation for the registry to recover', async () => {
    const { dshHome, worktree, file } = await fixture()
    await mkdir(join(dshHome, 'storages'))
    const content = document({ initialized: true, workspaceIds: [], archivedSessionIds: [], pendingMutation: { operation: 'create', workspaceId: 'w' } }, {})
    await writeFile(file, content)
    expect(await seedTrialWorkspace(dshHome, worktree, 'task', now))
      .toEqual({ kind: 'skipped', reason: 'registry has a pending create; left for the host to recover' })
    expect(await readFile(file, 'utf8')).toBe(content)
  })

  it('refuses a registry it does not recognise instead of overwriting it', async () => {
    const { dshHome, worktree, file } = await fixture()
    await mkdir(join(dshHome, 'storages'))
    const cases: Array<[string, RegExp]> = [
      ['[]', /registry file is not a JSON object/],
      [JSON.stringify({ unit: { name: 'sessions', version: 1 }, global: {}, tables: {} }), /registry header is not workspace v/],
      [JSON.stringify({ unit: 'workspace', global: {}, tables: {} }), /registry header is not workspace v/],
      [document({ initialized: true, workspaceIds: [], archivedSessionIds: [] }, {}).replace('"workspaces"', '"other"'), /registry has no workspaces table/],
      [JSON.stringify({ unit: { name: 'workspace', version: workspaceDomainSpec.version }, global: { initialized: true, workspaceIds: [] }, tables: [] }), /registry has no workspaces table/],
      [JSON.stringify({ unit: { name: 'workspace', version: workspaceDomainSpec.version }, global: { initialized: true, workspaceIds: [] }, tables: 'x' }), /registry has no workspaces table/],
      [document({ initialized: true, workspaceIds: ['w'], archivedSessionIds: [] }, { w: { path: 1 } }), /expected string/i],
      ['{', /JSON/],
    ]
    for (const [content, message] of cases) {
      await writeFile(file, content)
      await expect(seedTrialWorkspace(dshHome, worktree, 'task', now)).rejects.toThrow(message)
      expect(await readFile(file, 'utf8')).toBe(content)
    }
  })

  it('propagates a registry that cannot be read for another reason than absence', async () => {
    const { dshHome, worktree, file } = await fixture()
    await mkdir(file, { recursive: true })
    await expect(seedTrialWorkspace(dshHome, worktree, 'task', now)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('rejects a worktree that is not a fully qualified existing directory', async () => {
    const { dshHome } = await fixture()
    await expect(seedTrialWorkspace(dshHome, 'relative/worktree', 'task', now)).rejects.toThrow('not fully qualified')
    await expect(seedTrialWorkspace(dshHome, join(base as string, 'missing'), 'task', now)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
