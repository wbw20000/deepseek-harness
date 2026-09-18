/**
 * Filesystem containment checks for paths an experiment may influence: the
 * acceptor's case working directories and assertion paths, and the digests'
 * artifact paths. Every check resolves through `realpath`, so a symlinked
 * ancestor component cannot carry a path outside its reference directory.
 * Re-run these at the moment a path is used: this is a supervised route, not
 * an adversarial isolation claim against a racing writer.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/path-containment
 */

import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Whether `targetReal` — an already-resolved path — is `baseReal` itself or
 * lies under it.
 * @param baseReal - realpath of the reference directory.
 * @param targetReal - realpath of the path to classify.
 * @returns true when target is base or lies inside it.
 */
export function isInsideReal(baseReal: string, targetReal: string): boolean {
  const rel = relative(baseReal, targetReal)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Resolve `target` through the filesystem and return its realpath when the
 * resolved path stays inside `base`.
 * @param base - absolute reference directory.
 * @param target - absolute path to resolve and classify.
 * @returns the target's realpath, or `undefined` when either side does not
 *   resolve or the target resolves outside `base`.
 */
export async function realpathIfInside(base: string, target: string): Promise<string | undefined> {
  const [baseReal, targetReal] = await Promise.all([
    realpath(base).catch(() => undefined),
    realpath(target).catch(() => undefined),
  ])
  if (baseReal === undefined || targetReal === undefined) return undefined
  return isInsideReal(baseReal, targetReal) ? targetReal : undefined
}

/**
 * Whether `target` names a path inside the real directory `base`. Components
 * that do not exist yet are classified through their deepest existing
 * ancestor, so a symlinked ancestor directory is caught before a later create
 * or read can follow it. Callers lexically normalize `target` first; the
 * remaining components below the resolved ancestor are then plain names.
 * @param base - absolute reference directory.
 * @param target - absolute path to classify.
 * @returns true when the deepest existing ancestor of target resolves inside
 *   base (or target itself does).
 */
export async function staysInside(base: string, target: string): Promise<boolean> {
  const baseReal = await realpath(base).catch(() => undefined)
  if (baseReal === undefined) return false
  let probe = resolve(target)
  for (;;) {
    const resolved = await realpath(probe).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error
        && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
      throw error
    })
    if (resolved !== undefined) return isInsideReal(baseReal, resolved)
    const parent = dirname(probe)
    if (parent === probe) return false
    probe = parent
  }
}
