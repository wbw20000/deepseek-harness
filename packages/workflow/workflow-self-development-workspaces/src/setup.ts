/**
 * Deployment-configured setup command run inside a newly allocated worktree,
 * after the git worktree and data home exist and before the allocation
 * registers — for example `["pnpm", "install", "--offline",
 * "--frozen-lockfile"]` for a task worktree of the harness's own repository,
 * whose `git worktree add` carries no `node_modules`. The command runs
 * detached so it heads its own POSIX process group; the same "kill the whole
 * group, not just the direct child" idea the supervised runner's
 * `process-group.ts` uses for acceptance cases, simplified here because a
 * deployment-configured command is trusted, not judged as adversarial
 * evidence: no pgid-reuse forensics, just a kill and move on. The child's
 * environment carries only `PATH` and `HOME` — no ambient credential or
 * provider variable reaches it.
 * @module @deepseek-ai/dsh-workflow-self-development-workspaces/setup
 */

import { spawn } from 'node:child_process'
import { SelfDevelopmentWorkspacesError } from './runtime.ts'
import type { WorkspaceSetupConfig } from './types.ts'

/** Bytes of combined stdout/stderr retained for a failure message. */
const OUTPUT_TAIL_BYTES = 2048

/**
 * Refuse an unsupported process-group platform before spawning the setup
 * command. Negative-pid group signaling is POSIX-only.
 * @param platform - host platform observed by the caller.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_SETUP_FAILED` on
 *   Windows, which has no POSIX process groups.
 */
export function assertSetupPlatformSupport(platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    throw new SelfDevelopmentWorkspacesError(
      'workspace setup requires POSIX process groups; Windows execution is unavailable',
      'SELF_DEV_WORKSPACE_SETUP_FAILED',
    )
  }
}

/**
 * Run the configured setup command inside `worktree` and wait for it to
 * finish. A non-zero exit, a signal-terminated command, or a deadline all
 * fail the setup; whichever failure fires, nothing the command's own process
 * group still owns is left running — the worktree is about to be deleted by
 * the caller. A clean exit leaves the group alone.
 * @param worktree - absolute worktree root the command runs in as `cwd`.
 * @param setup - the configured argv and wall-clock deadline.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_SETUP_FAILED` when
 *   `command` is empty, the platform has no POSIX process groups, the command cannot
 *   spawn, exits non-zero, ends by signal, or does not finish within `timeoutMs`; the
 *   message carries the command and the last 2 KiB of its combined stdout and stderr.
 */
export async function runWorkspaceSetup(worktree: string, setup: WorkspaceSetupConfig): Promise<void> {
  const [program, ...args] = setup.command
  if (program === undefined) {
    throw new SelfDevelopmentWorkspacesError('setup.command must be a non-empty argv', 'SELF_DEV_WORKSPACE_SETUP_FAILED')
  }
  assertSetupPlatformSupport(process.platform)
  const outcome = await spawnSetup(worktree, program, args, setup.timeoutMs)
  if (outcome.timedOut) {
    throw failure(setup.command, `did not finish within ${String(setup.timeoutMs)} ms`, outcome.chunks)
  }
  if (outcome.signal !== null) {
    throw failure(setup.command, `was killed by signal ${outcome.signal}`, outcome.chunks)
  }
  if (outcome.code !== 0) {
    throw failure(setup.command, `exited with code ${String(outcome.code)}`, outcome.chunks)
  }
}

/** One setup command's raw completion facts. */
interface SetupOutcome {
  /** Process exit code, or `null` when the process ended by signal or was never confirmed to exit normally. */
  readonly code: number | null
  /** Terminating signal, or `null` when the process exited normally. */
  readonly signal: NodeJS.Signals | null
  /** Whether the configured deadline fired before the command closed on its own. */
  readonly timedOut: boolean
  /** Retained stdout and stderr chunks in arrival order. */
  readonly chunks: readonly Buffer[]
}

/**
 * Spawn the setup command detached, enforce its deadline by killing the whole
 * process group, and resolve once the direct child's pipes close.
 * @param worktree - absolute worktree root; the spawn `cwd`.
 * @param program - the command's first argv entry.
 * @param args - the remaining argv entries.
 * @param timeoutMs - wall-clock deadline before the group is killed as a timeout.
 * @returns the raw completion facts.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_SETUP_FAILED` when the
 *   command cannot spawn at all.
 */
function spawnSetup(worktree: string, program: string, args: readonly string[], timeoutMs: number): Promise<SetupOutcome> {
  return new Promise((resolveOutcome, rejectOutcome) => {
    const child = spawn(program, args, {
      cwd: worktree,
      // Only the paths a setup command needs; no ambient credential or
      // provider variable reaches it.
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const groupPid = child.pid
    const chunks: Buffer[] = []
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const killGroup = (signal: NodeJS.Signals): void => {
      if (groupPid === undefined) return
      try {
        process.kill(-groupPid, signal)
      } catch {
        // ESRCH: the group already exited.
      }
    }
    const deadline = setTimeout(() => {
      timedOut = true
      killGroup('SIGKILL')
    }, timeoutMs)
    child.on('error', (error: Error) => {
      clearTimeout(deadline)
      rejectOutcome(new SelfDevelopmentWorkspacesError(
        `setup command ${JSON.stringify([program, ...args])} could not start: ${error.message}`,
        'SELF_DEV_WORKSPACE_SETUP_FAILED',
      ))
    })
    child.on('close', (code, signal) => {
      clearTimeout(deadline)
      // Node reports exactly one of a numeric code or a signal for a process
      // that ran at all, never code 0 alongside a signal, so `code !== 0`
      // alone also catches a signal-terminated leader (its code is `null`).
      if (!timedOut && code !== 0) {
        // A non-zero exit or a signal-terminated leader might still have live
        // group-mates; the worktree this ran in is about to be torn down, so
        // nothing should outlive this call. A timeout already killed the
        // group above; a clean exit leaves the group alone.
        killGroup('SIGKILL')
      }
      resolveOutcome({ code, signal, timedOut, chunks })
    })
  })
}

/**
 * Build the setup-failure error, carrying the command and the retained output tail.
 * @param command - the configured argv, for the message.
 * @param reason - the specific way the command failed.
 * @param chunks - the retained stdout/stderr chunks.
 * @returns the boundary error.
 */
function failure(command: readonly string[], reason: string, chunks: readonly Buffer[]): SelfDevelopmentWorkspacesError {
  return new SelfDevelopmentWorkspacesError(
    `setup command ${JSON.stringify(command)} ${reason}; output tail: ${tail(chunks)}`,
    'SELF_DEV_WORKSPACE_SETUP_FAILED',
  )
}

/**
 * The last {@link OUTPUT_TAIL_BYTES} bytes of the retained output, decoded as UTF-8.
 * @param chunks - every retained stdout/stderr chunk in arrival order.
 * @returns the decoded tail; the whole output when it is shorter than the cap.
 */
function tail(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).subarray(-OUTPUT_TAIL_BYTES).toString('utf8')
}
