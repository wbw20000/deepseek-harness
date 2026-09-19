/**
 * Path and name validation for workspace allocation. Task ids become branch
 * names and directory names, so they are restricted to a plain safe alphabet.
 * Every registered path is re-resolved through `realpath` before the service
 * removes it, so only paths that still sit inside the experiments root are
 * ever deleted. Re-run these checks at the moment a path is used: this is a
 * coordination service, not an adversarial isolation claim against a racing
 * writer.
 * @module @deepseek-ai/dsh-workflow-self-development-workspaces/paths
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { SelfDevelopmentWorkspacesError } from './runtime.ts'

/** Alphabet a task id may use: it names a branch and a directory. */
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

/**
 * Validate a task id before it names a branch or a directory.
 * @param taskId - task id as handed in.
 * @returns the same id once proven safe.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_TASK_INVALID` when the
 *   id is empty, not a plain dot-and-dash word, contains `..`, or ends in
 *   `.lock` (which would collide with the lock-file suffix).
 */
export function validateTaskId(taskId: string): string {
  if (typeof taskId !== 'string' || taskId.length === 0 || !TASK_ID_PATTERN.test(taskId)
    || taskId.includes('..') || taskId.endsWith('.lock')) {
    throw new SelfDevelopmentWorkspacesError(
      `task id ${JSON.stringify(taskId)} must match ${TASK_ID_PATTERN.source} without ".." or a ".lock" suffix`,
      'SELF_DEV_WORKSPACE_TASK_INVALID',
    )
  }
  return taskId
}

/**
 * Resolve `target` through the filesystem and return its realpath when it
 * stays inside `base`. Non-existent targets resolve through their deepest
 * existing ancestor, so allocation can validate a worktree path before git
 * creates it.
 * @param base - absolute reference directory.
 * @param target - absolute path to resolve and classify.
 * @returns the target's realpath, or `undefined` when either side does not
 *   resolve or the target resolves outside `base`.
 */
export async function realpathIfInside(base: string, target: string): Promise<string | undefined> {
  const baseReal = await realpath(base).catch(() => undefined)
  if (baseReal === undefined) return undefined
  let probe = target
  for (;;) {
    const resolved = await realpath(probe).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error
        && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
      throw error
    })
    if (resolved !== undefined) return isInside(baseReal, resolved) ? resolved : undefined
    // The walk stops at the deepest existing ancestor; the filesystem root
    // always resolves, so the loop terminates.
    probe = probe.slice(0, probe.lastIndexOf(sep))
  }
}

/**
 * Whether an already-resolved `target` is `base` itself or lies under it.
 * @param baseReal - realpath of the reference directory.
 * @param targetReal - realpath of the path to classify.
 * @returns true when target is base or lies inside it.
 */
function isInside(baseReal: string, targetReal: string): boolean {
  if (targetReal === baseReal) return true
  const rel = relative(baseReal, targetReal)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
