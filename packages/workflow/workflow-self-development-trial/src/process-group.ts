/**
 * POSIX process-group teardown for the web and build children this service
 * spawns. Ownership of the numeric group id is judged by the caller's own
 * spawn record — the direct child's pid and its unobserved `exit` event —
 * exactly the approach the supervised runner's process-group module takes.
 * Processes are never looked up by name.
 * @module @deepseek-ai/dsh-workflow-self-development-trial/process-group
 */

import { setTimeout as delay } from 'node:timers/promises'
import { SelfDevelopmentTrialError, errorText } from './errors.ts'

/**
 * Grace the group gets after SIGTERM before SIGKILL. The campaign plan fixes
 * this at five seconds for trial teardown; it is not deployment configuration.
 */
export const TERM_GRACE_MS = 5000

/** Maximum additional wait for exit confirmation after SIGKILL. */
export const KILL_WAIT_MS = 5000

/**
 * Send one signal to a live process group. The caller keeps the exit
 * observation through its own child object, so an `ESRCH` here only means
 * the group is already gone and the child's exit event remains the source of
 * truth; an `EPERM` while the spawned child has not exited is a real failure.
 * @param pid - the spawned group leader's pid.
 * @param signal - the signal to deliver.
 * @throws SelfDevelopmentTrialError with `self-development/trial-stop-failed` when the group signal
 *   is refused with `EPERM` while the child the caller spawned has not exited.
 */
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    throw new SelfDevelopmentTrialError(
      'self-development/trial-stop-failed',
      `process group ${String(pid)} refused ${signal}: ${errorText(error)}`,
    )
  }
}

/**
 * Resolve whether the direct child has exited, bounded by a deadline.
 * @param exited - the caller's exit observation for the child it spawned; never rejects.
 * @param timeoutMs - maximum wait.
 * @returns true once the child exited, false when the deadline passed first.
 */
export async function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([
    exited.then(() => true),
    delay(timeoutMs).then(() => false),
  ])
}

/**
 * Tear one spawned process group down: SIGTERM, a five-second grace, then
 * SIGKILL, and a bounded wait for the caller's own exit observation. The
 * numeric pgid is never probed for liveness as an ownership test; the child
 * object the caller spawned is the only exit source.
 * @param pid - the spawned group leader's pid.
 * @param exited - the caller's exit observation for that child; never rejects.
 * @param graceMs - wait after SIGTERM; defaults to {@link TERM_GRACE_MS}.
 * @param killWaitMs - wait after SIGKILL; defaults to {@link KILL_WAIT_MS}.
 * @throws SelfDevelopmentTrialError with `self-development/trial-stop-failed` when a signal is
 *   refused while the child is still ours, or when exit is not confirmed within the deadlines.
 */
export async function stopProcessGroup(
  pid: number,
  exited: Promise<void>,
  graceMs: number = TERM_GRACE_MS,
  killWaitMs: number = KILL_WAIT_MS,
): Promise<void> {
  signalGroup(pid, 'SIGTERM')
  if (await waitForExit(exited, graceMs)) return
  signalGroup(pid, 'SIGKILL')
  if (await waitForExit(exited, killWaitMs)) return
  throw new SelfDevelopmentTrialError(
    'self-development/trial-stop-failed',
    `process group ${String(pid)} did not exit within ${String(graceMs + killWaitMs)} ms`,
  )
}
