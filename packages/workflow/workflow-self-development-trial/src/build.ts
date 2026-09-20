/**
 * Worktree build step of `openTrial`: resolve a pnpm to run it with, run
 * `pnpm run --silent build` inside the worktree under its own process group,
 * and fail the open when the build exits nonzero or exceeds its deadline.
 * @module @deepseek-ai/dsh-workflow-self-development-trial/build
 */

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { SelfDevelopmentTrialError } from './errors.ts'
import { KILL_WAIT_MS, stopProcessGroup, TERM_GRACE_MS } from './process-group.ts'

/**
 * The build argv the worktree's pnpm receives. `--silent` keeps the build
 * output to the build scripts' own output.
 */
export const BUILD_ARGV: readonly string[] = ['run', '--silent', 'build']

/** A path exists and is a regular file. */
export type FileExists = (path: string) => Promise<boolean>

/**
 * Whether a path exists and is a regular file.
 * @param path - candidate path.
 * @returns true when `stat` reports a regular file; every other outcome, including
 *   a denied read, reads as absent.
 */
export async function statIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * The worktree-local pnpm binary the build prefers, when it is installed.
 * @param worktree - the experiment worktree.
 * @returns `<worktree>/node_modules/.bin/pnpm`.
 */
export function worktreePnpmPath(worktree: string): string {
  return join(worktree, 'node_modules', '.bin', 'pnpm')
}

/**
 * The corepack shim next to the configured node binary, used when the
 * worktree has no local pnpm.
 * @param nodeBinary - the configured node binary.
 * @returns `<dir of nodeBinary>/corepack`.
 */
export function corepackPath(nodeBinary: string): string {
  return join(dirname(nodeBinary), 'corepack')
}

/**
 * Search `PATH` for an executable named `name`, POSIX-`which`-equivalent:
 * the first entry whose `<dir>/<name>` exists wins. A missing or empty
 * `PATH` matches nothing.
 * @param name - executable name to search for, e.g. `'pnpm'`.
 * @param pathEnv - the `PATH` value to search, `path.delimiter`-separated; `undefined` or empty
 *   matches nothing.
 * @param fileExists - existence probe; defaults to {@link statIsFile}.
 * @returns the first matching absolute path, or `undefined` when no `PATH` entry has one.
 */
export async function resolveFromPath(
  name: string,
  pathEnv: string | undefined,
  fileExists: FileExists = statIsFile,
): Promise<string | undefined> {
  if (pathEnv === undefined || pathEnv.length === 0) return undefined
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, name)
    if (await fileExists(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve the build command for one worktree, trying candidates in order:
 * the deployment's explicitly configured `pnpmBinary`, `pnpm` on the host
 * `PATH`, the worktree's own installed pnpm, and finally the corepack shim
 * next to `nodeBinary`. Every candidate is tried in full before the open
 * fails — a configured `pnpmBinary` that happens not to exist is not a hard
 * error by itself, it just falls through exactly like a `PATH` entry
 * without a `pnpm` would.
 * @param worktree - the experiment worktree to build in.
 * @param nodeBinary - the configured node binary, whose sibling corepack is the last-resort fallback.
 * @param pnpmBinary - the deployment's explicitly configured pnpm binary, tried first when set.
 * @param pathEnv - the `PATH` value to search for a bare `pnpm`; the caller resolves this once
 *   (normally from `process.env.PATH`) so a direct unit test can pin it independently of the host.
 * @param fileExists - existence probe; defaults to {@link statIsFile}.
 * @returns the argv to spawn: `[pnpm, 'run', '--silent', 'build']`, or `[corepack, 'pnpm', 'run',
 *   '--silent', 'build']` for the corepack fallback.
 * @throws SelfDevelopmentTrialError with `self-development/trial-build-failed` when no candidate
 *   exists; the message names every one that was checked.
 */
export async function resolveBuildCommand(
  worktree: string,
  nodeBinary: string,
  pnpmBinary: string | undefined,
  pathEnv: string | undefined,
  fileExists: FileExists = statIsFile,
): Promise<readonly string[]> {
  if (pnpmBinary !== undefined && await fileExists(pnpmBinary)) return [pnpmBinary, ...BUILD_ARGV]
  const onPath = await resolveFromPath('pnpm', pathEnv, fileExists)
  if (onPath !== undefined) return [onPath, ...BUILD_ARGV]
  const worktreePnpm = worktreePnpmPath(worktree)
  if (await fileExists(worktreePnpm)) return [worktreePnpm, ...BUILD_ARGV]
  const corepack = corepackPath(nodeBinary)
  if (await fileExists(corepack)) return [corepack, 'pnpm', ...BUILD_ARGV]
  const checked = [
    `pnpmBinary (${pnpmBinary ?? 'not configured'})`,
    `PATH for "pnpm" (${pathEnv === undefined || pathEnv.length === 0 ? 'unset' : pathEnv})`,
    worktreePnpm,
    corepack,
  ].join(', ')
  throw new SelfDevelopmentTrialError(
    'self-development/trial-build-failed',
    `no pnpm found for the build: checked ${checked}; none exist`,
  )
}

/**
 * Run the resolved build command in the worktree under its own process
 * group. stdout and stderr stream to `onOutput` as they arrive; the caller
 * owns redaction and persistence. A deadline overrun tears the group down
 * before the failure is raised.
 * @param worktree - the experiment worktree to build in.
 * @param command - the build argv from {@link resolveBuildCommand}; its first element is the
 *   executable, already resolved by the caller.
 * @param _nodeBinary - unused here; kept so the caller's build-step signature mirrors
 *   {@link resolveBuildCommand}, which is what actually resolves it into `command`.
 * @param timeoutMs - maximum wall time of the build.
 * @param onOutput - sink for the build's stdout and stderr.
 * @throws SelfDevelopmentTrialError with `self-development/trial-build-failed` when the build
 *   command is empty, exceeds `timeoutMs`, could not spawn, or exits nonzero.
 */
export async function runBuild(
  worktree: string,
  command: readonly string[],
  _nodeBinary: string,
  timeoutMs: number,
  onOutput: (chunk: string) => void,
): Promise<void> {
  const [executable, ...args] = command
  if (executable === undefined) {
    throw new SelfDevelopmentTrialError('self-development/trial-build-failed', `build command in ${worktree} is empty`)
  }
  const started = spawn(executable, args, {
    cwd: worktree,
    detached: true,
    // Explicit, not relied on as spawn()'s own default: the build needs the
    // host's PATH (a resolved pnpm may itself shell out to node/corepack on
    // PATH) and HOME (pnpm's own config/cache lookup), and this keeps that
    // intentional rather than an inherited accident.
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise<void>((resolve) => {
    started.once('exit', () =>{  resolve() })
  })
  // stdio is fixed to ['ignore', 'pipe', 'pipe'] above, so a real spawn()
  // never gives started.stdout/stderr as null; the optional chaining stays
  // for the mocked streamless-child doubles the unit tests spawn in place of
  // a real child, which is also why oxlint's static non-nullness read is
  // suppressed here rather than acted on.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  started.stdout?.on('data', (chunk: Buffer) => { onOutput(chunk.toString('utf8')) })
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  started.stderr?.on('data', (chunk: Buffer) => { onOutput(chunk.toString('utf8')) })
  const spawnFailure = new Promise<never>((_, reject) => {
    started.once('error', (error) => {
      reject(new SelfDevelopmentTrialError(
        'self-development/trial-build-failed',
        `build ${JSON.stringify(command[0])} could not spawn in ${worktree}: ${error.message}`,
      ))
    })
  })
  // Resolves (never rejects) once the wall clock passes timeoutMs, flagging
  // `timedOut` instead of racing a rejection against `exited`: the teardown
  // below signals the very process `exited` observes, so a race between "the
  // deadline decided to stop it" and "it stopped" would let the stop's own
  // side effect resolve `exited` first and silently swallow the timeout.
  let timedOut = false
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true
      resolve()
    }, timeoutMs)
    timer.unref()
    started.once('exit', () =>{  clearTimeout(timer) })
  })
  await Promise.race([exited, spawnFailure, deadline])
  // timedOut is reassigned inside the deadline timer's closure above; the
  // analyzer does not track that mutation through the preceding await.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  if (timedOut) {
    if (started.pid !== undefined) {
      await stopProcessGroup(started.pid, exited, TERM_GRACE_MS, KILL_WAIT_MS)
    }
    throw new SelfDevelopmentTrialError(
      'self-development/trial-build-failed',
      `build in ${worktree} timed out after ${String(timeoutMs)} ms and its process group was stopped`,
    )
  }
  if (started.exitCode !== 0) {
    const ended = started.exitCode === null
      ? `signal ${String(started.signalCode)}`
      : `code ${String(started.exitCode)}`
    throw new SelfDevelopmentTrialError(
      'self-development/trial-build-failed',
      `build in ${worktree} failed with ${ended}`,
    )
  }
}
