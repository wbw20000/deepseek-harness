/**
 * Task data-home provisioning: copy the deployment's `dataHomeTemplate`
 * directory into a task's own `DSH_HOME`. The copy excludes the template's
 * `sessions/` and `attachments/` subtrees and every `*.lock` file: sessions
 * and attachments belong to the allocating installation, and lock files name
 * processes and resources of the template's own deployment, not the task's.
 * @module @deepseek-ai/dsh-workflow-self-development-workspaces/template
 */

import { cp, mkdir, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { SelfDevelopmentWorkspacesError } from './runtime.ts'

/** Directory basenames never copied into a task data home. */
const EXCLUDED_DIRECTORIES = new Set(['sessions', 'attachments'])

/**
 * Copy the template data home into `dataHome`, creating the target directory.
 * Excluded names are pruned during the walk, so a large `sessions/` tree is
 * never read. File modes travel with each copied entry.
 * @param templateRoot - absolute template directory; must exist.
 * @param dataHome - absolute task data home to create and fill.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_ALLOC_FAILED` when the
 *   template is missing or any copy step fails.
 */
export async function copyDataHomeTemplate(templateRoot: string, dataHome: string): Promise<void> {
  try {
    await mkdir(dataHome, { recursive: true })
    await cp(templateRoot, dataHome, {
      recursive: true,
      filter: (source: string): boolean => {
        if (source === templateRoot) return true
        const name = basename(source)
        if (EXCLUDED_DIRECTORIES.has(name)) return false
        if (name.endsWith('.lock')) return false
        return true
      },
    })
  } catch (error) {
    throw new SelfDevelopmentWorkspacesError(
      `task data home ${dataHome} could not be copied from template ${templateRoot}: ${detail(error)}`,
      'SELF_DEV_WORKSPACE_ALLOC_FAILED',
    )
  }
}

/**
 * Whether the template directory exists and is a directory.
 * @param templateRoot - absolute candidate template directory.
 * @returns true when the path exists and is a directory.
 */
export async function templateExists(templateRoot: string): Promise<boolean> {
  return stat(templateRoot).then(
    stats => stats.isDirectory(),
    (error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false
      throw error
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
