/**
 * The trial web process: spawn the worktree's built CLI under its own process
 * group with the experiment data home, stream its redacted output to the
 * caller's sink, and resolve the `dsh web: http://…` readiness URL from its
 * stdout. The URL carries the launch token; the token is redacted before any
 * output reaches the sink, so the log file never stores it.
 * @module @deepseek-ai/dsh-workflow-self-development-trial/web-process
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { SelfDevelopmentTrialError } from './errors.ts'

/**
 * The fixed web argv prefix; the port is appended between `--port` and
 * `--no-open`. Only `dsh web` launches supported Node apps, so the trial
 * instance goes through the profile's own CLI.
 */
export const WEB_ARGV_PREFIX: readonly string[] = ['apps/cli/lib/bin.js', 'web', '--host', '127.0.0.1']

/** The stdout line pattern the CLI prints once the web app is ready. */
export const READY_URL_PATTERN = /dsh web: (http:\/\/[^\s]+)/

/**
 * Redact a launch token out of web output. Query-string token values lose
 * their bytes; everything else passes through unchanged.
 * @param text - raw process output.
 * @returns the text with every `token=` query value replaced by `<redacted>`.
 */
export function redactToken(text: string): string {
  return text.replace(/([?&]token=)[^&\s"']+/g, '$1<redacted>')
}

/** One spawned trial web process and its readiness observation. */
export interface SpawnedWebProcess {
  /** The detached group leader; the caller owns its teardown. */
  readonly child: ChildProcess
  /** Settles when the direct child exits; never rejects. */
  readonly exited: Promise<void>
  /** Settles with the ready URL, or rejects with the start failure. */
  readonly url: Promise<string>
}

/**
 * Spawn the trial web process. stdout and stderr stream through
 * {@link redactToken} into `onOutput` as they arrive; the URL promise
 * settles on the first readiness line, on an early exit, on a spawn error,
 * or on the readiness deadline, whichever comes first.
 * @param options - node binary, worktree, port, data home, readiness deadline, and output sink.
 * @returns the spawned process with its exit and URL observations.
 */
export function spawnWebProcess(options: {
  readonly nodeBinary: string
  readonly worktree: string
  readonly port: number
  readonly dshHome: string
  readonly readyTimeoutMs: number
  readonly onOutput: (chunk: string) => void
}): SpawnedWebProcess {
  const child = spawn(options.nodeBinary, [...WEB_ARGV_PREFIX, '--port', String(options.port), '--no-open'], {
    cwd: options.worktree,
    detached: true,
    env: { ...process.env, DSH_HOME: options.dshHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () =>{  resolve() })
  })
  const url = new Promise<string>((resolve, reject) => {
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      fail(`no readiness line within ${String(options.readyTimeoutMs)} ms`)
    }, options.readyTimeoutMs)
    timer.unref()
    const sink = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      // The sink only ever redacts for the log; matching happens against the
      // raw buffer so the resolved URL keeps its real launch token — the
      // sidecar record and the caller need it, only the shared log doesn't.
      options.onOutput(redactToken(text))
      buffer += text
      const match = READY_URL_PATTERN.exec(buffer)
      // The pattern's one capturing group is mandatory (not inside a `?`
      // quantifier), so a non-null match always captured it — checked
      // explicitly rather than asserted, to keep this lint-clean.
      const captured = match?.[1]
      if (captured !== undefined) settle(() => { resolve(captured) })
    }
    const fail = (message: string): void => {
      settle(() =>{  reject(new SelfDevelopmentTrialError(
        'self-development/trial-start-failed',
        `trial web process for ${options.worktree} never became ready: ${message}`,
      )) })
    }
    const settle = (apply: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      apply()
    }
    // stdio is fixed to ['ignore', 'pipe', 'pipe'] above, so a real spawn()
    // never gives child.stdout/stderr as null; the optional chaining stays
    // for the mocked streamless-child doubles the unit tests spawn in place
    // of a real child, which is also why oxlint's static non-nullness read
    // is suppressed here rather than acted on.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    child.stdout?.on('data', sink)
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    child.stderr?.on('data', sink)
    child.once('error', (error) => {
      fail(`could not spawn ${JSON.stringify(options.nodeBinary)}: ${error.message}`)
    })
    void exited.then(() => {
      fail('the process exited before printing a readiness line')
    })
  })
  return { child, exited, url }
}
