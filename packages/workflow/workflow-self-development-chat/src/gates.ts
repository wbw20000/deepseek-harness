/**
 * The `verify(worktree)` function passed to `workspaces.integrate`: the
 * runner's independent acceptance verification, then every configured
 * integration gate command in order. Neither step trusts the model — the
 * runner check is a separate process, and the gates run in a real shell.
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { acceptancePath } from './acceptance.ts'
import type { ResolvedChatConfig } from './config.ts'
import type { AcceptanceRunView, RunnerVerifyPort, VerifyOutcome } from './types.ts'

const execAsync = promisify(exec)

/** Wall-clock timeout for one integration gate command. */
export const GATE_TIMEOUT_MS = 20 * 60_000

/** Bytes of combined stdout+stderr kept in a gate failure's reason. */
export const GATE_OUTPUT_TAIL_BYTES = 2048

/** Outcome of one `sh -c` gate command run. */
export interface GateRunResult {
  /** Process exit code; `null` when the run was killed by the timeout. */
  readonly code: number | null
  /** Whether the timeout (not the command itself) ended the run. */
  readonly timedOut: boolean
  /** Combined stdout and stderr, in emission order. */
  readonly output: string
}

/** Injectable shell runner for {@link buildVerify}, replaceable by direct unit tests. */
export interface GateDeps {
  readonly runShell?: (command: string, cwd: string, timeoutMs: number) => Promise<GateRunResult>
}

/**
 * Run one gate command with `sh -c`, killing it after `timeoutMs`. Exported
 * (distinct from the fixed {@link GATE_TIMEOUT_MS} `buildVerify` uses by
 * default) so direct unit tests can verify the real exit-code and timeout
 * detection against a short, test-friendly deadline instead of waiting out
 * the real 20-minute gate budget.
 * @param command - the shell command line to run.
 * @param cwd - the worktree to run it in.
 * @param timeoutMs - wall-clock deadline; the child is killed past it.
 * @returns the exit code, whether the timeout fired, and the combined output.
 */
export async function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<GateRunResult> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
    return { code: 0, timedOut: false, output: stdout + stderr }
  } catch (error: unknown) {
    const candidate = error as { readonly code?: unknown; readonly killed?: unknown; readonly stdout?: unknown; readonly stderr?: unknown }
    // `child_process.exec`'s own rejection always carries `stdout`/`stderr`
    // as strings (empty ones for a spawn-time failure such as a missing
    // cwd, confirmed against a real ENOENT) — the fallback is defensive
    // against a shape Node does not actually produce here.
    /* v8 ignore next -- see above; not reachable through a real exec rejection. */
    const stdout = typeof candidate.stdout === 'string' ? candidate.stdout : ''
    /* v8 ignore next -- see above; not reachable through a real exec rejection. */
    const stderr = typeof candidate.stderr === 'string' ? candidate.stderr : ''
    return {
      code: typeof candidate.code === 'number' ? candidate.code : null,
      // `child_process.exec`'s own timeout option sets `killed: true` only
      // when ITS timer fired the kill; any other non-zero exit leaves it
      // `false` (or absent), so this reliably distinguishes the two causes.
      timedOut: candidate.killed === true,
      output: stdout + stderr,
    }
  }
}

/** The last `maxBytes` bytes of `text`, decoded safely so the cut never crashes on a multi-byte boundary. */
function tailBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return text
  return buffer.subarray(buffer.byteLength - maxBytes).toString('utf8')
}

/** Output lines that are build-tool chatter, never the failure itself; they are dropped before the tail is taken. */
const GATE_NOISE_LINE = /PLUGIN_TIMINGS|^\s*$/

/** Output lines that name a failure; when any exist they are what the tail is taken from. */
const GATE_FAILURE_LINE = /\berror\b|\bfailed\b|✖|×|\bTS\d{4}\b/i

/**
 * The part of a gate's combined output worth carrying into a reason: the
 * lines that name an error when there are any, else every non-noise line,
 * either way cut to the last {@link GATE_OUTPUT_TAIL_BYTES} bytes. A field
 * test's `pnpm run typecheck` failure arrived as 2 KB of bundler timing
 * warnings with the one `error TS2741` line scrolled off above them.
 * @param output - the gate's combined stdout and stderr.
 * @returns the excerpt, trimmed.
 */
export function gateOutputExcerpt(output: string): string {
  const lines = output.split('\n').filter(line => !GATE_NOISE_LINE.test(line))
  const failures = lines.filter(line => GATE_FAILURE_LINE.test(line))
  const kept = failures.length > 0 ? failures : lines
  return tailBytes(kept.join('\n'), GATE_OUTPUT_TAIL_BYTES).trim()
}

/** Build one gate failure's reason: the command, why it failed, and the output excerpt. */
function gateFailureReason(command: string, result: GateRunResult): string {
  const cause = result.timedOut ? `timed out after ${GATE_TIMEOUT_MS}ms` : `exited with code ${String(result.code)}`
  return `integration gate "${command}" ${cause}. Output tail:\n${gateOutputExcerpt(result.output)}`
}

/**
 * Judge the acceptor's completed run: every assertion of every case must be
 * `pass`, and the run must have neither timed out nor been cancelled. The
 * runner reports assertion failures inside the run, never as its own failure,
 * so this is where a failed case becomes a `verification-failed` reason.
 * @param report - the acceptor's completed run.
 * @returns `{ ok: true }` for an all-pass run, else the failed assertions and run facts in one reason.
 */
export function judgeAcceptanceRun(report: AcceptanceRunView): VerifyOutcome {
  const failures: string[] = []
  for (const testCase of report.cases) {
    const failed = testCase.assertions.filter(assertion => assertion.status !== 'pass')
    if (failed.length > 0) {
      failures.push(`case ${testCase.caseId}: ${failed.map(assertion => `${assertion.assertionId} ${assertion.status}`).join(', ')}`)
    }
  }
  if (report.timedOut) failures.push('a case reached its deadline')
  if (report.cancelled) failures.push('the run was cancelled')
  if (failures.length === 0) return { ok: true }
  return { ok: false, reason: `acceptance failed (exit code ${report.exitCode}): ${failures.join('; ')}` }
}

/**
 * Build the `verify(worktree)` function `self_development_merge` passes to
 * `workspaces.integrate`: first the runner's own acceptance verification
 * (independent of the model, per the DI frozen interface), then every
 * configured `integrationGates` command in order with `sh -c`. The first
 * failure of either stops the sequence.
 * @param runner - the runner verification port; the caller checks this is
 *   mounted before building `verify` at all — merging to stable without an
 *   independent acceptance check is not a degrade this function offers.
 * @param config - resolved deployment config, for the acceptance path, the
 *   experiments root, and the configured integration gates.
 * @param taskId - the task whose acceptance definition is being verified.
 * @param deps - injectable shell runner, replaceable by direct unit tests.
 * @returns the `verify` function.
 */
export function buildVerify(
  runner: RunnerVerifyPort,
  config: ResolvedChatConfig,
  taskId: string,
  deps: GateDeps = {},
): (worktree: string) => Promise<VerifyOutcome> {
  const runShell = deps.runShell ?? runShellCommand
  return async (worktree: string): Promise<VerifyOutcome> => {
    let acceptanceOutcome: VerifyOutcome
    try {
      const result = await runner.verifyAcceptance(worktree, acceptancePath(config.controlDirectory, taskId), {
        phaseTimeoutMs: GATE_TIMEOUT_MS,
      })
      acceptanceOutcome = result.ok ? judgeAcceptanceRun(result.report) : { ok: false, reason: `acceptance could not be run: ${result.reason}` }
    } catch (error: unknown) {
      acceptanceOutcome = { ok: false, reason: `runner acceptance verification threw: ${(error as Error).message}` }
    }
    if (!acceptanceOutcome.ok) return acceptanceOutcome
    for (const command of config.integrationGates) {
      const result = await runShell(command, worktree, GATE_TIMEOUT_MS)
      if (result.timedOut || result.code !== 0) {
        return { ok: false, reason: gateFailureReason(command, result) }
      }
    }
    return { ok: true }
  }
}
