/**
 * The durable workspace registry: `<experimentsRoot>/workspaces.json`. The
 * registry is the single authority for which paths this service allocated, so
 * `release` deletes nothing it did not register here. Every write publishes
 * through an exclusive temporary file and an atomic rename, so an interrupted
 * write never leaves a readable half-published registry.
 * @module @deepseek-ai/dsh-workflow-self-development-workspaces/registry
 */

import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { SelfDevelopmentWorkspacesError } from './runtime.ts'
import type { TaskWorkspace } from './types.ts'

/** Registry schema version; a different version is refused, never migrated. */
const REGISTRY_VERSION = 1

/** On-disk registry record. */
export interface WorkspaceRegistry {
  /** Schema version of this file. */
  readonly version: number
  /** One entry per currently allocated workspace. */
  readonly workspaces: readonly TaskWorkspace[]
}

/**
 * The registry file path for an experiments root.
 * @param experimentsRoot - absolute experiments root.
 * @returns the absolute registry path.
 */
export function registryPath(experimentsRoot: string): string {
  return join(experimentsRoot, 'workspaces.json')
}

/**
 * Read the registry, returning an empty registry when the file does not exist.
 * @param experimentsRoot - absolute experiments root.
 * @returns the parsed registry.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_REGISTRY_INVALID` when the
 *   file cannot be read, is not valid JSON, or does not match the expected
 *   registry structure.
 */
export async function readRegistry(experimentsRoot: string): Promise<WorkspaceRegistry> {
  let bytes: Buffer
  try {
    bytes = await readFile(registryPath(experimentsRoot))
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { version: REGISTRY_VERSION, workspaces: [] }
    }
    throw new SelfDevelopmentWorkspacesError(
      `workspace registry ${registryPath(experimentsRoot)} could not be read: ${detail(error)}`,
      'SELF_DEV_WORKSPACE_REGISTRY_INVALID',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new SelfDevelopmentWorkspacesError(
      `workspace registry ${registryPath(experimentsRoot)} is not valid JSON: ${detail(error)}`,
      'SELF_DEV_WORKSPACE_REGISTRY_INVALID',
    )
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as WorkspaceRegistry).workspaces)
    || (parsed as WorkspaceRegistry).version !== REGISTRY_VERSION) {
    throw new SelfDevelopmentWorkspacesError(
      `workspace registry ${registryPath(experimentsRoot)} does not match version ${String(REGISTRY_VERSION)}`,
      'SELF_DEV_WORKSPACE_REGISTRY_INVALID',
    )
  }
  return parsed as WorkspaceRegistry
}

/**
 * Publish the registry atomically: exclusive temporary file, rename over the
 * target, parent directory created when missing. The registry exists durably
 * only after the rename lands. Last writer wins across processes; within one
 * process the serial chain (`runInSerialChain`) orders allocation and release
 * so their read-modify-write cycles cannot overwrite each other, while across
 * processes the deployment keeps one writer per experiments root.
 * @param experimentsRoot - absolute experiments root.
 * @param registry - the complete registry to publish.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_REGISTRY_INVALID` when any
 *   write step fails (the temporary file is removed best-effort).
 */
export async function writeRegistry(experimentsRoot: string, registry: WorkspaceRegistry): Promise<void> {
  const target = registryPath(experimentsRoot)
  const directory = dirname(target)
  const tempPath = join(directory, `workspaces.json.tmp-${String(process.pid)}-${randomBytes(8).toString('hex')}`)
  try {
    await mkdir(directory, { recursive: true })
    const handle = await open(tempPath, 'wx')
    try {
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    await rename(tempPath, target)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw new SelfDevelopmentWorkspacesError(
      `workspace registry ${target} could not be written: ${detail(error)}`,
      'SELF_DEV_WORKSPACE_REGISTRY_INVALID',
    )
  }
}

/**
 * Whether the registry file exists. Used by tests and by `release` to report
 * a registry that was removed out from under the service.
 * @param experimentsRoot - absolute experiments root.
 * @returns true when the registry file exists.
 */
export async function registryExists(experimentsRoot: string): Promise<boolean> {
  return stat(registryPath(experimentsRoot)).then(
    () => true,
    (error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false
      throw new SelfDevelopmentWorkspacesError(
        `workspace registry ${registryPath(experimentsRoot)} could not be inspected: ${detail(error)}`,
        'SELF_DEV_WORKSPACE_REGISTRY_INVALID',
      )
    },
  )
}

/**
 * Describe one unknown failure for a boundary message.
 * @param error - thrown value of any type.
 * @returns the value's string form, which carries the message for Error values.
 */
function detail(error: unknown): string {
  return String(error)
}
