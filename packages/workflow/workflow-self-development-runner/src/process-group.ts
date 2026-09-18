/**
 * Final POSIX process-group cleanup after the direct child's pipes close.
 * Failure to confirm group exit rejects the run; it never permits verification
 * to continue while descendants may still write. This does not collect a
 * descendant that starts a new session or process group.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/process-group
 */

import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { SelfDevelopmentRunnerError } from './runtime.ts'

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
 * Kill remaining group members and wait for the group to disappear.
 * @param groupPid - detached child's PID, absent when spawning failed.
 * @param timeoutMs - maximum additional wait for group exit after SIGKILL.
 * @returns completion only when no member remains visible to the OS probe.
 * @throws SelfDevelopmentRunnerError when signalling fails or exit is unconfirmed.
 */
export async function finishProcessGroup(groupPid: number | undefined, timeoutMs: number): Promise<void> {
  if (groupPid === undefined) return
  const startedAt = performance.now()
  let first = true
  for (;;) {
    try {
      process.kill(-groupPid, 0)
      if (first) process.kill(-groupPid, 'SIGKILL')
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return
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
