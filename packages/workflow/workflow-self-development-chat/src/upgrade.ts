/**
 * Post-integration upgrade: rebuild and restart the stable version from
 * source, or hand off to the packaged launcher. Every side effect (git,
 * pnpm, the detached restart, and this process's own exit) is injectable so
 * tests run against temporary scripts instead of the real toolchain.
 */

import { spawn, execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { runGit } from './baseline.ts'
import type { UpgradeConfig, UpgradeSourceConfig } from './config.ts'
import type { UpgradeOutcome } from './types.ts'

export type { UpgradeOutcome }

const execFileAsync = promisify(execFile)

/** Milliseconds to wait after the upgrade result is returned before this process exits. */
export const UPGRADE_EXIT_DELAY_MS = 2000

/** Rough estimate of the stable version's rebuild-and-restart time, for chat copy naming a concrete number. */
export const RESTART_ESTIMATE_SECONDS = 30

/**
 * Injectable side effects for {@link runUpgrade}; every field defaults to the
 * real implementation. Direct unit tests replace `git`/`runCommand` with
 * temporary-script runners and `spawnDetached`/`exit`/`scheduleExit` with
 * recording fakes, so no test actually restarts or exits this process.
 */
export interface UpgradeDeps {
  /** Run one git command and return its trimmed stdout; defaults to `baseline.ts`'s `runGit`. */
  readonly git?: (args: readonly string[], cwd: string) => Promise<string>
  /** Read one file as utf8 text, or `undefined` when it does not exist; defaults to a real read. */
  readonly readTextFile?: (path: string) => Promise<string | undefined>
  /** Run one command to completion (install/build); defaults to a real `execFile`. */
  readonly runCommand?: (argv: readonly string[], cwd: string) => Promise<void>
  /** Start one detached, unref'd process and forget it; defaults to a real `spawn`. */
  readonly spawnDetached?: (command: readonly string[], cwd: string | undefined) => void
  /** End this process; defaults to `process.exit`. */
  readonly exit?: (code: number) => void
  /** Schedule `run` after `delayMs`, unref'd; defaults to a real `setTimeout`. */
  readonly scheduleExit?: (run: () => void, delayMs: number) => void
}

/**
 * Validate one upgrade config's kind-specific required fields. Kept separate
 * from `resolveChatConfig` the same way `budgetViolation` is: the caller
 * decides when to check it, so this module never joins `config.ts`'s own
 * import graph.
 * @param upgrade - the deployment's configured upgrade strategy.
 * @returns the first violated rule, or `undefined` when the config is valid.
 */
export function upgradeViolation(upgrade: UpgradeConfig): string | undefined {
  if (upgrade.kind === 'source') {
    if (typeof upgrade.projectRoot !== 'string' || upgrade.projectRoot.length === 0 || !isAbsolute(upgrade.projectRoot)) {
      return 'upgrade.projectRoot must be an absolute path'
    }
    if (!Array.isArray(upgrade.restartCommand) || upgrade.restartCommand.length === 0) {
      return 'upgrade.restartCommand must be a non-empty array'
    }
    return undefined
  }
  if (upgrade.kind === 'launcher') {
    if (typeof upgrade.dshUpgradeBin !== 'string' || upgrade.dshUpgradeBin.length === 0) {
      return 'upgrade.dshUpgradeBin must be a non-empty string'
    }
    return undefined
  }
  return undefined
}

/** Default `readTextFile`: `undefined` for a missing file, otherwise its utf8 text. */
async function defaultReadTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Default `runCommand`: `execFile`, surfacing stderr (or the message) on a
 * non-zero exit. Exported so a direct unit test can exercise it (and its
 * defensive empty-argv guard) against a real temporary script, instead of
 * only indirectly through `runUpgrade`'s own default-dependency wiring.
 * @param argv - the program name followed by its arguments.
 * @param cwd - directory the command runs in.
 * @throws Error when `argv` names no program, or the command exits non-zero.
 */
export async function defaultRunCommand(argv: readonly string[], cwd: string): Promise<void> {
  const [command, ...args] = argv
  if (command === undefined) throw new Error('command must name a program')
  await execFileAsync(command, args, { cwd })
}

/**
 * Default `spawnDetached`: a detached, `stdio: 'ignore'`, unref'd `spawn` —
 * outlives this process's own exit. Exported for the same reason as
 * {@link defaultRunCommand}: a direct test can point it at a real, harmless
 * temporary script and observe it ran, without going through `runUpgrade`.
 * @param command - the program name followed by its arguments.
 * @param cwd - directory the command runs in, or `undefined` to inherit this process's.
 * @throws Error when `command` names no program.
 */
export function defaultSpawnDetached(command: readonly string[], cwd: string | undefined): void {
  const [program, ...args] = command
  if (program === undefined) throw new Error('command must name a program')
  const child = spawn(program, args, { cwd, detached: true, stdio: 'ignore' })
  child.unref()
}

/**
 * Default `scheduleExit`: a real, unref'd `setTimeout`. Exported so a direct
 * test can verify the real timer fires with a short, test-friendly delay,
 * instead of waiting out the real {@link UPGRADE_EXIT_DELAY_MS}.
 * @param run - callback fired once, after `delayMs`.
 * @param delayMs - delay in milliseconds before `run` fires.
 */
export function defaultScheduleExit(run: () => void, delayMs: number): void {
  const timer = setTimeout(run, delayMs)
  timer.unref()
}

/** One-line detail naming the failing step and the clearest diagnostic text available on the thrown error. */
function commandFailureDetail(prefix: string, error: unknown): string {
  const candidate = error as { readonly message?: unknown; readonly stderr?: unknown }
  const stderr = typeof candidate.stderr === 'string' ? candidate.stderr.trim() : ''
  const message = typeof candidate.message === 'string' ? candidate.message : String(error)
  return `${prefix}: ${stderr.length > 0 ? stderr : message}`
}

/**
 * Run the source-tree upgrade: fast-forward `targetBranch` into
 * `upgrade.projectRoot` (a no-op when `integrate` already fast-forwarded
 * that same worktree — `git merge --ff-only` exits 0 and prints
 * "Already up to date" in that case), install only when merging changed
 * `pnpm-lock.yaml` (unless `installIfLockfileChanged` is `false`), build,
 * then detach the restart command and schedule this process's own exit.
 */
async function runSourceUpgrade(
  upgrade: UpgradeSourceConfig,
  targetBranch: string,
  git: (args: readonly string[], cwd: string) => Promise<string>,
  readTextFile: (path: string) => Promise<string | undefined>,
  runCommand: (argv: readonly string[], cwd: string) => Promise<void>,
  spawnDetached: (command: readonly string[], cwd: string | undefined) => void,
  exit: (code: number) => void,
  scheduleExit: (run: () => void, delayMs: number) => void,
): Promise<UpgradeOutcome> {
  const lockfilePath = join(upgrade.projectRoot, 'pnpm-lock.yaml')
  const before = await readTextFile(lockfilePath)
  try {
    await git(['merge', '--ff-only', targetBranch], upgrade.projectRoot)
  } catch (error: unknown) {
    return { ok: false, detail: commandFailureDetail(`git merge --ff-only ${targetBranch} failed`, error) }
  }
  if (upgrade.installIfLockfileChanged !== false) {
    const after = await readTextFile(lockfilePath)
    if (after !== before) {
      try {
        await runCommand(['pnpm', 'install', '--offline', '--frozen-lockfile'], upgrade.projectRoot)
      } catch (error: unknown) {
        return { ok: false, detail: commandFailureDetail('pnpm install --offline --frozen-lockfile failed', error) }
      }
    }
  }
  try {
    await runCommand(['pnpm', 'run', '--silent', 'build'], upgrade.projectRoot)
  } catch (error: unknown) {
    return { ok: false, detail: commandFailureDetail('pnpm run --silent build failed', error) }
  }
  spawnDetached(upgrade.restartCommand, upgrade.projectRoot)
  scheduleExit(() =>{  exit(0) }, UPGRADE_EXIT_DELAY_MS)
  return {
    ok: true,
    detail: `merged ${targetBranch}, rebuilt, and restarted via ${upgrade.restartCommand.join(' ')} `
      + `(stable version should refresh in about ${RESTART_ESTIMATE_SECONDS}s)`,
  }
}

/**
 * Run the configured post-integration upgrade. `none` does nothing; `source`
 * rebuilds and restarts this deployment (see {@link runSourceUpgrade});
 * `launcher` only spawns `dshUpgradeBin upgrade --task <taskId>` detached —
 * interface and docs only this wave, not field-tested (see the package README).
 * @param upgrade - the deployment's configured upgrade strategy.
 * @param targetBranch - the branch that was just merged, for `source`'s fast-forward.
 * @param taskId - the merged task id, forwarded to the launcher.
 * @param deps - injectable side effects, replaceable by direct unit tests.
 * @returns whether the upgrade succeeded, with a one-line detail either way.
 */
export async function runUpgrade(
  upgrade: UpgradeConfig,
  targetBranch: string,
  taskId: string,
  deps: UpgradeDeps = {},
): Promise<UpgradeOutcome> {
  if (upgrade.kind === 'none') {
    return { ok: true, detail: 'upgrade.kind is none; no rebuild or restart was attempted' }
  }
  const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached
  if (upgrade.kind === 'launcher') {
    spawnDetached([upgrade.dshUpgradeBin, 'upgrade', '--task', taskId], undefined)
    return {
      ok: true,
      detail: `spawned ${upgrade.dshUpgradeBin} upgrade --task ${taskId} (launcher upgrades are untested this wave)`,
    }
  }
  return runSourceUpgrade(
    upgrade,
    targetBranch,
    deps.git ?? runGit,
    deps.readTextFile ?? defaultReadTextFile,
    deps.runCommand ?? defaultRunCommand,
    spawnDetached,
    deps.exit ?? ((code: number) => process.exit(code)),
    deps.scheduleExit ?? defaultScheduleExit,
  )
}
