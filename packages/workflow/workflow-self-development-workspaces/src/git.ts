/**
 * Git invocation helper for workspace allocation and integration. Every call
 * spawns `git` with an explicit argv vector — no shell — under a wall-clock
 * timeout that kills the child, and every call runs with `cwd` pinned to a
 * project root or worktree the caller already validated. Stderr is captured
 * for boundary messages; neither stream reaches this process's console.
 * @module @deepseek-ai/dsh-workflow-self-development-workspaces/git
 */

import { spawn } from 'node:child_process'
import { SelfDevelopmentWorkspacesError } from './runtime.ts'

/** Default wall-clock limit of one git invocation. */
export const GIT_TIMEOUT_MS = 120_000

/** Collected result of one successful git invocation. */
export interface GitRun {
  /** The command's standard output, decoded as UTF-8. */
  readonly stdout: string
  /** The command's standard error, decoded as UTF-8. */
  readonly stderr: string
}

/**
 * Run one git command and return its output.
 * @param cwd - absolute working directory; callers pass only project roots or
 *   worktrees they allocated or resolved through `realpath`.
 * @param args - argument vector passed verbatim after `git`.
 * @param timeoutMs - wall-clock limit; a timed-out child is killed outright
 *   (git children have no graceful-shutdown protocol worth a grace window)
 *   and the call fails.
 * @returns the command's decoded output.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_GIT_FAILED` when the
 *   child cannot spawn, exits non-zero, or runs past `timeoutMs`; the message
 *   carries the argv head and the captured stderr tail.
 */
export function runGit(cwd: string, args: readonly string[], timeoutMs: number = GIT_TIMEOUT_MS): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      fail(new SelfDevelopmentWorkspacesError(
        `git ${args[0] ?? ''} timed out after ${String(timeoutMs)}ms`,
        'SELF_DEV_WORKSPACE_GIT_FAILED',
      ))
      child.kill('SIGKILL')
    }, timeoutMs)

    /**
     * Settle the promise as failed; a later close event sees `settled` and
     * only cleans up the timeout.
     * @param error - the rejection reason.
     */
    function fail(error: SelfDevelopmentWorkspacesError): void {
      settled = true
      clearTimeout(timer)
      reject(error)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: Error) => {
      fail(new SelfDevelopmentWorkspacesError(`git ${JSON.stringify(args[0])} could not spawn: ${error.message}`, 'SELF_DEV_WORKSPACE_GIT_FAILED'))
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code !== 0) {
        const tail = stderr.length > 0 ? `: ${stripUrlUserInfo(stderr.trim().slice(-2000))}` : ''
        const ended = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
        reject(new SelfDevelopmentWorkspacesError(`git ${args.join(' ')} failed with ${ended}${tail}`, 'SELF_DEV_WORKSPACE_GIT_FAILED'))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/**
 * Strip userinfo from URLs in git output before the output reaches a boundary
 * message, so a remote URL with embedded credentials — `https://user:pass@host`
 * — is reported as the bare origin. Userinfo in `scp`-like remotes
 * (`user@host:path`) carries no password and is left alone.
 * @param text - captured git output destined for an error message.
 * @returns the text with `scheme://user:password@` collapsed to `scheme://`.
 */
function stripUrlUserInfo(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/<>@]*@/gi, '$1')
}

/**
 * Resolve one revision to its full commit id.
 * @param cwd - absolute project root or worktree.
 * @param revision - git revision expression, for example `HEAD` or a branch name.
 * @returns the resolved commit id, or `undefined` when the revision does not resolve.
 */
export async function revParse(cwd: string, revision: string): Promise<string | undefined> {
  return runGit(cwd, ['rev-parse', '--verify', '--quiet', revision])
    .then(result => result.stdout.trim() || undefined)
    .catch(() => undefined)
}

/**
 * Whether `ancestor` is an ancestor of (or equal to) `commit`.
 * @param cwd - absolute project root or worktree.
 * @param ancestor - candidate ancestor commit id.
 * @param commit - candidate descendant commit id.
 * @returns the merge-base verdict; `false` when either commit does not resolve.
 */
export async function isAncestor(cwd: string, ancestor: string, commit: string): Promise<boolean> {
  const result = await runGit(cwd, ['merge-base', '--is-ancestor', ancestor, commit]).then(
    () => true,
    () => false,
  )
  return result
}
