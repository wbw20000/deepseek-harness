/**
 * Final POSIX process-group cleanup after the direct child's pipes close.
 * Failure to confirm group exit rejects the run; it never permits verification
 * to continue while descendants may still write. This does not collect a
 * descendant that starts a new session or process group.
 *
 * Ownership of the numeric group id is judged by the group leader this runner
 * spawned: its pid, the caller's own observation of that leader's exit, and —
 * where the host allows reading it — the `ps -o lstart=` start-time
 * fingerprint captured right after spawn. The operating system can reassign a
 * freed pgid quickly, so an `EPERM` group signal while the fingerprinted
 * leader is no longer observable is reported as `pgidReused` instead of
 * failing the run; an `EPERM` with the leader still ours is a real cleanup
 * failure and still rejects.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/process-group
 */

import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { SelfDevelopmentRunnerError } from './runtime.ts'

/**
 * What the caller knows about the group leader it spawned. Only this
 * combination separates "our group still runs" from "the numeric pgid was
 * reassigned to a group we cannot signal".
 */
export interface ProcessGroupLeader {
  /** Detached child's PID, which is also the process group id. */
  readonly pid: number
  /**
   * The caller observed the leader's death through its own child events, so
   * Node has reaped it; a pid that still accepts signals after that belongs
   * to a different process.
   */
  readonly exited: boolean
  /** `ps -o lstart=` start time read right after spawn; `undefined` when the host denies the read. */
  readonly startedAt: string | undefined
}

/** Observed outcome of the final process-group cleanup. */
export interface ProcessGroupExit {
  /**
   * The group signal answered `EPERM` while the spawned leader was no longer
   * observable as ours, so the numeric pgid was probably reassigned to another
   * process group and this cleanup cannot signal it.
   */
  readonly pgidReused: boolean
}

/**
 * Refuse unsupported process-group semantics before launching a child.
 * @param platform - host platform observed by the caller.
 * @throws SelfDevelopmentRunnerError on Windows, which has no POSIX group signals.
 */
export function assertProcessGroupSupport(platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    throw new SelfDevelopmentRunnerError('the supervised runner requires POSIX process groups; Windows execution is unavailable', 'SELF_DEV_RUNNER_CONFIG_INVALID')
  }
}

/**
 * Read the group leader's start-time fingerprint immediately after spawn,
 * while its pid cannot yet have been reassigned: a Node child is reaped only
 * after the caller has observed its `exit` event.
 * @param pid - detached child's PID.
 * @returns the fingerprint, or `undefined` when the host denies the read; cleanup
 *   then relies on the caller's exit observation and still fails closed when
 *   it cannot separate a reused pgid from a live leader.
 */
export function readGroupLeaderStartedAt(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile('ps', ['-o', 'lstart=', '-p', String(pid)], (error, stdout) => {
        resolve(error === null ? stdout.trim() : undefined)
      })
    } catch {
      // The host denied executing `ps`; cleanup falls back to the caller's own
      // exit observation instead of failing the run on a missing fingerprint.
      resolve(undefined)
    }
  })
}

/**
 * Kill remaining group members and wait for the group to disappear.
 * @param groupPid - detached child's PID, absent when spawning failed.
 * @param timeoutMs - maximum additional wait for group exit after SIGKILL.
 * @param leader - what the caller knows about the group leader it spawned;
 *   absent keeps the older fail-closed reading of every signal error.
 * @returns completion with whether the pgid was judged reassigned.
 * @throws SelfDevelopmentRunnerError when signalling fails with the leader still
 *   ours, or exit is unconfirmed.
 */
export async function finishProcessGroup(
  groupPid: number | undefined,
  timeoutMs: number,
  leader?: ProcessGroupLeader,
): Promise<ProcessGroupExit> {
  if (groupPid === undefined) return { pgidReused: false }
  const startedAt = performance.now()
  let first = true
  for (;;) {
    try {
      process.kill(-groupPid, 0)
      if (first) process.kill(-groupPid, 'SIGKILL')
    } catch (error) {
      if (isErrno(error, 'ESRCH')) return { pgidReused: false }
      if (isErrno(error, 'EPERM') && leader !== undefined && !(await leaderStillOurs(leader))) {
        return { pgidReused: true }
      }
      throw new SelfDevelopmentRunnerError(`process group ${String(groupPid)} cleanup failed: ${String(error)}`, 'SELF_DEV_RUNNER_EXECUTOR_FAILED')
    }
    first = false
    const remaining = timeoutMs - (performance.now() - startedAt)
    if (remaining <= 0) {
      throw new SelfDevelopmentRunnerError(`process group ${String(groupPid)} exit was not confirmed within ${String(timeoutMs)} ms`, 'SELF_DEV_RUNNER_EXECUTOR_FAILED')
    }
    await delay(Math.min(15, remaining))
  }
}

/**
 * Whether the fingerprinted leader is still the process we spawned: its pid
 * must accept a liveness probe, and — unless the caller already observed this
 * leader's death, which makes any surviving pid a reused one — the start time
 * must still match. An unreadable start time keeps the fail-closed reading
 * for a leader the caller has not observed exiting.
 * @param leader - the spawned leader's pid, exit observation, and fingerprint.
 * @returns true only when the leader is observably the one we spawned.
 */
async function leaderStillOurs(leader: ProcessGroupLeader): Promise<boolean> {
  try {
    process.kill(leader.pid, 0)
  } catch {
    // The spawned leader is gone, so the group id no longer names our group.
    return false
  }
  if (leader.startedAt === undefined) return !leader.exited
  return (await readGroupLeaderStartedAt(leader.pid)) === leader.startedAt
}

/**
 * Whether the thrown signal error carries the given errno code.
 * @param error - error from `process.kill`.
 * @param code - errno code to match.
 * @returns true when the error is an object carrying exactly that code.
 */
function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}
