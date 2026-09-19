/**
 * Registry behavior: the registry file is the durable authority for allocated
 * paths, published through an atomic rename, and every structural mismatch
 * fails loudly instead of being silently repaired.
 * @module registry.spec
 */

import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readRegistry, registryExists, registryPath, writeRegistry, type WorkspaceRegistry } from '../src/registry.ts'

const WORKSPACE = {
  taskId: 'task-a',
  projectRoot: '/tmp/project',
  baseCommit: 'a'.repeat(40),
  worktree: '/tmp/experiments/task-a/worktree',
  branch: 'selfdev/task-a',
  dataHome: '/tmp/experiments/task-a/dsh-home',
  allocatedAt: 1,
}

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A registry file with one known workspace entry. */
function registryWith(workspaces: readonly unknown[]): WorkspaceRegistry {
  return { version: 1, workspaces: workspaces as WorkspaceRegistry['workspaces'] }
}

describe('workspace registry', () => {
  it('round-trips a registry write and read', async () => {
    root = await mkRoot()
    await writeRegistry(root, registryWith([WORKSPACE]))
    expect(await readRegistry(root)).toEqual(registryWith([WORKSPACE]))
    const raw = JSON.parse(await readFile(registryPath(root), 'utf8')) as WorkspaceRegistry
    expect(raw.version).toBe(1)
  })

  it('reads an empty registry when the file does not exist', async () => {
    root = await mkRoot()
    expect(await readRegistry(root)).toEqual({ version: 1, workspaces: [] })
    expect(await registryExists(root)).toBe(false)
  })

  it('reports registry existence', async () => {
    root = await mkRoot()
    await writeRegistry(root, registryWith([]))
    expect(await registryExists(root)).toBe(true)
  })

  it('creates missing parent directories when writing', async () => {
    root = await mkRoot()
    const nested = join(root, 'deep', 'experiments')
    await writeRegistry(nested, registryWith([]))
    expect(existsSync(registryPath(nested))).toBe(true)
  })

  it('refuses a corrupt registry file', async () => {
    root = await mkRoot()
    await writeFile(registryPath(root), 'not json\n')
    await expect(readRegistry(root)).rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_REGISTRY_INVALID' })
  })

  it.each([
    ['a non-object payload', '"just a string"'],
    ['a wrong version', JSON.stringify({ version: 2, workspaces: [] })],
    ['a missing workspace list', JSON.stringify({ version: 1 })],
  ])('refuses %s', async (_name, content) => {
    root = await mkRoot()
    await writeFile(registryPath(root), content)
    await expect(readRegistry(root)).rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_REGISTRY_INVALID' })
  })

  it('refuses an unreadable registry file', async () => {
    root = await mkRoot()
    await writeRegistry(root, registryWith([]))
    await chmod(root, 0o000)
    try {
      await expect(readRegistry(root)).rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_REGISTRY_INVALID' })
      await expect(registryExists(root)).rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_REGISTRY_INVALID' })
    } finally {
      await chmod(root, 0o755)
    }
  })

  it('refuses a write that cannot create the target directory', async () => {
    root = await mkRoot()
    // A file where the experiments root directory would go blocks the mkdir.
    await writeFile(join(root, 'blocked'), 'file\n')
    await expect(writeRegistry(join(root, 'blocked'), registryWith([])))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_REGISTRY_INVALID' })
  })
})

/** Create one fresh temporary root for a registry file. */
async function mkRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'self-dev-registry-'))
}
