/** Task id derivation from a requirement, and the stable baseline digest read from the stable repository. */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Maximum number of requirement words folded into the task id. */
const TASK_ID_WORD_COUNT = 4

/** Fallback stem when the requirement yields no usable word. */
const TASK_ID_FALLBACK = 'task'

/**
 * Derive the task id from the requirement: kebab-cased first words plus a random suffix.
 * @param requirement - the consolidated requirement text.
 * @param suffix - six-character random suffix; defaults to hex from `randomBytes`.
 * @returns a kebab-case task id such as `add-json-flag-a1b2c3`.
 */
export function deriveTaskId(requirement: string, suffix: string = randomBytes(3).toString('hex')): string {
  const words = requirement
    .toLowerCase()
    .split(/\s+/u)
    .slice(0, TASK_ID_WORD_COUNT)
    // Dash is the join separator between words, never a kept word character:
    // keeping it here would let a token like "--json" survive as a bare "-"
    // (or leave leading/trailing dashes on a token like "chat-search"),
    // producing double-dash joins such as "cli---json".
    .map(word => word.replace(/[^a-z0-9]/gu, ''))
    .filter(word => word.length > 0)
  const stem = words.length > 0 ? words.join('-') : TASK_ID_FALLBACK
  return `${stem}-${suffix}`
}

/**
 * Run one git command in a directory and return its trimmed stdout.
 * @param args - git arguments without the `git` program name.
 * @param cwd - directory the command runs in.
 * @returns the command's trimmed stdout.
 */
export async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, encoding: 'utf8' })
  return stdout.trim()
}

/**
 * Read the stable baseline digest: sha256 over the stable repository's current HEAD commit id.
 * The digest is the task's `stableBaselineDigest`, recorded at proposal time so the
 * campaign's baseline is fixed even if the stable branch moves afterwards.
 * @param stableRepo - absolute path of the stable repository.
 * @param run - git runner, replaceable by direct unit tests.
 * @returns the 64-character lowercase hex digest.
 * @throws Error when git fails or prints no commit id.
 */
export async function readBaselineDigest(
  stableRepo: string,
  run: (args: readonly string[], cwd: string) => Promise<string> = runGit,
): Promise<string> {
  const commitId = await run(['rev-parse', 'HEAD'], stableRepo)
  if (commitId.length === 0) {
    throw new Error(`git rev-parse HEAD in ${stableRepo} printed no commit id`)
  }
  return createHash('sha256').update(commitId).digest('hex')
}
