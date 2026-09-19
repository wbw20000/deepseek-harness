/**
 * Independent acceptance runner behavior: loading a stable-side acceptance
 * definition, checking it covers a frozen test plan, and running each case in
 * its own process group inside the experiment worktree. Definition placement
 * and path checks do not protect against another process with the same OS
 * user's permissions.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/acceptor
 */

import { spawn, type SpawnOptionsWithStdioTuple } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CaseResult, FrozenTestPlan } from '@deepseek-ai/dsh-workflow-self-development'
import { isInsideReal, staysInside } from './path-containment.ts'
import { SelfDevelopmentRunnerError } from './runtime.ts'
import { assertProcessGroupSupport, finishProcessGroup } from './process-group.ts'
import type { RunnerConfig } from './types.ts'

/** One assertion a case's process must satisfy after it exits. */
export type AcceptanceAssertion = { readonly assertionId: string } & (
  | { readonly kind: 'exit-code'; readonly expected: number }
  | { readonly kind: 'stdout-includes'; readonly text: string }
  | { readonly kind: 'file-exists'; readonly path: string }
  | { readonly kind: 'file-includes'; readonly path: string; readonly text: string })

/** One independently executed acceptance case. */
export interface AcceptanceCase {
  /** Stable case identity from the frozen test plan. */
  readonly caseId: string
  /** Command to spawn; `node` in the first position is replaced by the configured node binary. */
  readonly command: readonly string[]
  /** Worktree-relative working directory; defaults to the worktree root. Must resolve inside the worktree. */
  readonly cwd?: string | undefined
  /** Wall-clock deadline for the case process in milliseconds. */
  readonly timeoutMs: number
  /** Assertions evaluated after the process exits. */
  readonly assertions: readonly AcceptanceAssertion[]
}

/** Observed outcome of running every acceptance case once. */
export interface AcceptanceRun {
  /** Per-case assertion results in definition order. */
  readonly cases: readonly CaseResult[]
  /** `0` when every assertion passed, otherwise the first nonzero case exit code or `1`. */
  readonly exitCode: number
  /** Terminating signal of the last case that ended by signal, else `null`. */
  readonly signal: string | null
  /** Whether any case reached its deadline. */
  readonly timedOut: boolean
  /** Whether the request signal aborted the run before it finished. */
  readonly cancelled: boolean
  /** Wall-clock duration of the whole run in milliseconds. */
  readonly durationMs: number
}

/** Spawn environment: only the paths and permission mode the case needs. */
const SPAWN_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DSH_PERMISSION_MODE: 'workspace-write',
} as const

/** Upper bound on the stdout one case may accumulate; past it the tail is dropped. */
const STDOUT_MAX_BYTES = 1 << 20

/**
 * Read and validate the stable-side acceptance definition. The definition must
 * live outside the experiments root; this is a placement rule, not OS access
 * control. The experiments root itself must resolve:
 * a root whose `realpath` fails fails the load closed instead of reading the
 * definition as uncontained.
 * @param path - absolute path of the acceptance definition JSON (`{ "cases": [...] }`).
 * @param experimentsRoot - absolute path of the parent directory holding every experiment worktree.
 * @returns the validated acceptance cases in definition order, with unique case ids.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` when the path resolves
 *   inside `experimentsRoot`, `experimentsRoot` does not resolve, the file is unreadable or not valid
 *   JSON, a case violates the definition, or two cases share a `caseId`.
 */
export async function loadAcceptance(path: string, experimentsRoot: string): Promise<readonly AcceptanceCase[]> {
  const experimentsReal = await realpath(experimentsRoot).catch(() => undefined)
  if (experimentsReal === undefined) {
    throw new SelfDevelopmentRunnerError(
      `experiments root ${experimentsRoot} does not resolve, so the acceptance definition ${path} cannot be judged outside it`,
      'SELF_DEV_RUNNER_ACCEPTANCE_INVALID',
    )
  }
  const definitionReal = await realpath(path).catch(() => undefined)
  if (definitionReal !== undefined && isInsideReal(experimentsReal, definitionReal)) {
    throw new SelfDevelopmentRunnerError(
      `acceptance definition ${path} must live outside the experiments root ${experimentsRoot}`,
      'SELF_DEV_RUNNER_ACCEPTANCE_INVALID',
    )
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new SelfDevelopmentRunnerError(
      `acceptance definition ${path} is unreadable: ${String(error)}`,
      'SELF_DEV_RUNNER_ACCEPTANCE_INVALID',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SelfDevelopmentRunnerError(
      `acceptance definition ${path} is not valid JSON: ${String(error)}`,
      'SELF_DEV_RUNNER_ACCEPTANCE_INVALID',
    )
  }
  const body: unknown = parsed
  if (!isAcceptanceBody(body)) {
    throw new SelfDevelopmentRunnerError(
      `acceptance definition ${path} must be an object with a cases array`,
      'SELF_DEV_RUNNER_ACCEPTANCE_INVALID',
    )
  }
  const cases = body.cases.map(parseCase)
  const seenCaseIds = new Set<string>()
  for (const testCase of cases) {
    if (seenCaseIds.has(testCase.caseId)) {
      throw new SelfDevelopmentRunnerError(
        `acceptance definition ${path} defines case ${testCase.caseId} more than once`,
        'SELF_DEV_RUNNER_ACCEPTANCE_INVALID',
      )
    }
    seenCaseIds.add(testCase.caseId)
  }
  return cases
}

/**
 * Whether the parsed JSON is the `{ "cases": [...] }` definition object.
 * @param value - parsed JSON value.
 * @returns true when the value carries a cases array.
 */
function isAcceptanceBody(value: unknown): value is { cases: readonly unknown[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { cases?: unknown }).cases)
}

/**
 * Check that the acceptance definition defines every case and assertion the
 * frozen test plan requires. The plan, not the definition, is authoritative.
 * @param cases - validated acceptance cases.
 * @param plan - the human-confirmed frozen test plan.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` when a required
 *   `caseId` or one of its required `assertionIds` has no definition.
 */
export function checkAcceptanceCoversPlan(cases: readonly AcceptanceCase[], plan: FrozenTestPlan): void {
  for (const required of plan.requiredCases) {
    const found = cases.find(candidate => candidate.caseId === required.caseId)
    if (found === undefined) {
      throw new SelfDevelopmentRunnerError(
        `acceptance definition does not define required case ${required.caseId}`,
        'SELF_DEV_RUNNER_ACCEPTANCE_INVALID',
      )
    }
    for (const assertionId of required.assertionIds) {
      if (!found.assertions.some(assertion => assertion.assertionId === assertionId)) {
        throw new SelfDevelopmentRunnerError(
          `acceptance case ${required.caseId} does not define required assertion ${assertionId}`,
          'SELF_DEV_RUNNER_ACCEPTANCE_INVALID',
        )
      }
    }
  }
}

/**
 * Run every acceptance case inside the worktree, each in its own detached
 * process group with its own deadline, and evaluate the assertions after the
 * process exits. A case that reaches its deadline, is aborted through the
 * request signal, ends by signal, or produced more stdout than the retention
 * bound fails every assertion: an incomplete run is never acceptable
 * evidence. The run rejects on an invalid definition before spawning anything.
 * @param config - runner configuration supplying the node binary, the experiment home, and the kill grace.
 * @param req - the worktree to run in, the validated cases, the data directory
 *   the case processes inherit as `DSH_HOME`, and an abort signal owned by the caller.
 * @returns the observed per-case results and process facts.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` when a `file-*`
 *   assertion path or a case `cwd` escapes the worktree — lexically or through a
 *   symlinked ancestor — or with `SELF_DEV_RUNNER_EXECUTOR_FAILED` when a case command
 *   cannot be spawned or its process group cannot be confirmed exited. Windows
 *   execution rejects with `SELF_DEV_RUNNER_CONFIG_INVALID` before spawning.
 */
export async function runAcceptance(
  config: RunnerConfig,
  req: { worktree: string; cases: readonly AcceptanceCase[]; signal: AbortSignal; dshHome?: string },
): Promise<AcceptanceRun> {
  assertProcessGroupSupport(process.platform)
  for (const testCase of req.cases) {
    if (testCase.cwd !== undefined) {
      await assertCwdInsideWorktree(req.worktree, testCase.cwd, testCase.caseId)
    }
    for (const assertion of testCase.assertions) {
      if (assertion.kind === 'file-exists' || assertion.kind === 'file-includes') {
        await assertPathInsideWorktree(req.worktree, assertion.path, testCase.caseId, assertion.assertionId)
      }
    }
  }
  const startedAt = Date.now()
  const cases: CaseResult[] = []
  let timedOut = false
  let cancelled = false
  let signalName: string | null = null
  let failingExitCode: number | undefined
  for (const testCase of req.cases) {
    if (req.signal.aborted) {
      cancelled = true
      cases.push(failedCase(testCase))
      continue
    }
    const outcome = await runCase(config, req.worktree, testCase, req.signal, req.dshHome)
    timedOut = timedOut || outcome.timedOut
    cancelled = cancelled || outcome.cancelled
    if (outcome.signal !== null) signalName = outcome.signal
    if (outcome.exitCode !== null && outcome.exitCode !== 0 && failingExitCode === undefined) {
      failingExitCode = outcome.exitCode
    }
    const assertions = await evaluateAssertions(req.worktree, testCase, outcome)
    cases.push({ caseId: testCase.caseId, assertions })
  }
  const allPassed = cases.every(result => result.assertions.every(assertion => assertion.status === 'pass'))
  return {
    cases,
    exitCode: allPassed ? 0 : failingExitCode ?? 1,
    signal: signalName,
    timedOut,
    cancelled,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * Reject an assertion path that would read outside the worktree. The lexical
 * check rejects `..` and absolute spellings; the filesystem check rejects a
 * symlinked ancestor directory carrying the path outside the worktree. The
 * same check re-runs at assertion evaluation, when the path is actually read.
 * @param worktree - absolute worktree root.
 * @param path - worktree-relative assertion path.
 * @param caseId - owning case, for the rejection message.
 * @param assertionId - owning assertion, for the rejection message.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` when the resolved
 *   path leaves the worktree.
 */
async function assertPathInsideWorktree(worktree: string, path: string, caseId: string, assertionId: string): Promise<void> {
  const resolved = resolve(worktree, path)
  if (!isInsideReal(worktree, resolved) || !(await staysInside(worktree, resolved))) {
    throw new SelfDevelopmentRunnerError(
      `acceptance case ${caseId} assertion ${assertionId} path ${path} escapes the worktree`,
      'SELF_DEV_RUNNER_ACCEPTANCE_INVALID',
    )
  }
}

/**
 * Reject a case working directory that would run the case outside the
 * worktree, checked again immediately before the spawn that uses it.
 * @param worktree - absolute worktree root.
 * @param cwd - worktree-relative working directory from the definition.
 * @param caseId - owning case, for the rejection message.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` when the resolved
 *   cwd leaves the worktree, lexically or through a symlinked ancestor.
 */
async function assertCwdInsideWorktree(worktree: string, cwd: string, caseId: string): Promise<void> {
  const resolved = resolve(worktree, cwd)
  if (!isInsideReal(worktree, resolved) || !(await staysInside(worktree, resolved))) {
    throw new SelfDevelopmentRunnerError(
      `acceptance case ${caseId} cwd ${cwd} escapes the worktree ${worktree}`,
      'SELF_DEV_RUNNER_ACCEPTANCE_INVALID',
    )
  }
}

/**
 * Validate and normalize one acceptance case from parsed JSON.
 * @param value - the raw JSON value of one case.
 * @returns the validated case.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` describing the first violated rule.
 */
function parseCase(value: unknown): AcceptanceCase {
  const failure = (reason: string): SelfDevelopmentRunnerError =>
    new SelfDevelopmentRunnerError(`invalid acceptance case ${JSON.stringify(value)}: ${reason}`, 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID')
  if (typeof value !== 'object' || value === null) throw failure('case must be an object')
  const candidate = value as Record<string, unknown>
  if (typeof candidate.caseId !== 'string' || candidate.caseId === '') throw failure('caseId must be a non-empty string')
  if (!Array.isArray(candidate.command) || candidate.command.length === 0 || candidate.command.some(part => typeof part !== 'string')) {
    throw failure('command must be a non-empty array of strings')
  }
  if (typeof candidate.timeoutMs !== 'number' || !Number.isInteger(candidate.timeoutMs) || candidate.timeoutMs <= 0) {
    throw failure('timeoutMs must be a positive integer')
  }
  if (!Array.isArray(candidate.assertions) || candidate.assertions.length === 0) throw failure('assertions must be a non-empty array')
  const cwd = candidate.cwd === undefined ? undefined : candidate.cwd
  if (cwd !== undefined && typeof cwd !== 'string') throw failure('cwd must be a string when present')
  const assertions = candidate.assertions.map(assertion => parseAssertion(assertion, failure))
  if (new Set(assertions.map(assertion => assertion.assertionId)).size !== assertions.length) {
    throw failure('assertionId must be unique within a case')
  }
  return {
    caseId: candidate.caseId,
    command: candidate.command,
    cwd,
    timeoutMs: candidate.timeoutMs,
    assertions,
  }
}

/**
 * Validate and normalize one assertion from parsed JSON.
 * @param value - the raw JSON value of one assertion.
 * @param failure - builds the rejection for the surrounding case.
 * @returns the validated assertion.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` for an unknown kind or a missing field.
 */
function parseAssertion(value: unknown, failure: (reason: string) => SelfDevelopmentRunnerError): AcceptanceAssertion {
  if (typeof value !== 'object' || value === null) throw failure('assertion must be an object')
  const candidate = value as Record<string, unknown>
  if (typeof candidate.assertionId !== 'string' || candidate.assertionId === '') throw failure('assertionId must be a non-empty string')
  switch (candidate.kind) {
    case 'exit-code':
      if (typeof candidate.expected !== 'number' || !Number.isInteger(candidate.expected)) throw failure('exit-code assertion needs an integer expected')
      return { assertionId: candidate.assertionId, kind: 'exit-code', expected: candidate.expected }
    case 'stdout-includes':
      if (typeof candidate.text !== 'string') throw failure('stdout-includes assertion needs a text')
      return { assertionId: candidate.assertionId, kind: 'stdout-includes', text: candidate.text }
    case 'file-exists':
      if (typeof candidate.path !== 'string' || candidate.path === '') throw failure('file-exists assertion needs a path')
      return { assertionId: candidate.assertionId, kind: 'file-exists', path: candidate.path }
    case 'file-includes':
      if (typeof candidate.path !== 'string' || candidate.path === '') throw failure('file-includes assertion needs a path')
      if (typeof candidate.text !== 'string') throw failure('file-includes assertion needs a text')
      return { assertionId: candidate.assertionId, kind: 'file-includes', path: candidate.path, text: candidate.text }
    default:
      throw failure(`unknown assertion kind ${JSON.stringify(candidate.kind)}`)
  }
}

/** One case process's raw outcome, before the assertions are evaluated. */
interface CaseOutcome {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly cancelled: boolean
  /** Retained stdout; empty once the case passed `STDOUT_MAX_BYTES` and none was read. */
  readonly stdout: string
  /** Whether stdout grew past `STDOUT_MAX_BYTES` and its tail was dropped. */
  readonly stdoutTruncated: boolean
}

/**
 * Spawn one case in its own detached process group, enforce its deadline, and
 * wait for the group to die. The runner tears the group down with `SIGTERM`
 * and escalates to `SIGKILL` after the configured grace; teardown is one-way,
 * so a deadline firing after an abort (or the reverse) never re-arms the grace
 * window or sends a second signal. Stdout is retained only up to
 * `STDOUT_MAX_BYTES`; the tail past the cap is dropped.
 * @param config - runner configuration.
 * @param worktree - absolute worktree root the case runs in.
 * @param testCase - the case to execute.
 * @param signal - caller-owned abort signal.
 * @param dshHome - data directory the case process inherits as `DSH_HOME`; absent runs with `config.dshHome`.
 * @returns the raw process outcome.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` when the case's
 *   working directory no longer stays inside the worktree at spawn time, or with
 *   `SELF_DEV_RUNNER_EXECUTOR_FAILED` when the command cannot spawn.
 */
async function runCase(
  config: RunnerConfig,
  worktree: string,
  testCase: AcceptanceCase,
  signal: AbortSignal,
  dshHome: string | undefined,
): Promise<CaseOutcome> {
  const program = testCase.command[0]
  if (program === undefined) {
    throw new SelfDevelopmentRunnerError(
      `acceptance case ${testCase.caseId} names no command`,
      'SELF_DEV_RUNNER_ACCEPTANCE_INVALID',
    )
  }
  // Re-check the cwd at the moment it is used: this is a supervised route,
  // not an adversarial TOCTOU isolation claim, but the spawn itself must never
  // receive a directory outside the worktree.
  if (testCase.cwd !== undefined) await assertCwdInsideWorktree(worktree, testCase.cwd, testCase.caseId)
  if (signal.aborted) return { exitCode: null, signal: null, timedOut: false, cancelled: true, stdout: '', stdoutTruncated: false }
  return new Promise((resolveCase, rejectCase) => {
    const command = program === 'node' ? config.nodeBinary : program
    // Ambient provider credentials and proxy variables are not inherited.
    // HOME and DSH_HOME still refer to files accessible under the child's UID.
    const options: SpawnOptionsWithStdioTuple<'ignore', 'pipe', 'pipe'> = {
      cwd: resolve(worktree, testCase.cwd ?? '.'),
      env: { ...SPAWN_ENV, DSH_HOME: dshHome ?? config.dshHome },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    const child = spawn(command, testCase.command.slice(1), options)
    // A spawn that fails before creating the process (ENOENT, EACCES) assigns
    // no pid and reports through the 'error' event; there is no group to tear down.
    const groupPid = child.pid
    let stdout = ''
    let stdoutTruncated = false
    let timedOut = false
    let cancelled = false
    let graceTimer: NodeJS.Timeout | undefined
    // Timer callbacks contain signal errors; final group-exit confirmation
    // rejects a run whose cleanup cannot be verified.
    const killGroup = (name: NodeJS.Signals): void => {
      if (groupPid === undefined) return
      try {
        process.kill(-groupPid, name)
      } catch {
        // ESRCH: the group already exited.
      }
    }
    /** Whether teardown has begun; it is one-way and never re-arms. */
    let teardownBegun = false
    const teardown = (timedOutHere: boolean, cancelledHere: boolean): void => {
      if (timedOutHere) timedOut = true
      if (cancelledHere) cancelled = true
      if (teardownBegun) return
      teardownBegun = true
      killGroup('SIGTERM')
      graceTimer = setTimeout(() => {
        killGroup('SIGKILL')
      }, config.killGraceMs)
    }
    const deadline = setTimeout(() => {
      teardown(true, false)
    }, testCase.timeoutMs)
    const onAbort = (): void => {
      teardown(false, true)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      // A runaway case must not grow the buffer without bound: once the cap is
      // reached the tail is dropped, so `stdout-includes` only ever matches the
      // retained head. Slicing at the byte cap can split a multibyte character.
      if (stdoutTruncated) return
      const over = Buffer.byteLength(stdout) + Buffer.byteLength(chunk) - STDOUT_MAX_BYTES
      if (over <= 0) {
        stdout += chunk
        return
      }
      stdout += Buffer.from(chunk, 'utf8').subarray(0, Buffer.byteLength(chunk) - over).toString('utf8')
      stdoutTruncated = true
    })
    // Drain stderr: an unread pipe would block a chatty case at the 64 KiB buffer.
    child.stderr.resume()
    const cleanup = (): void => {
      clearTimeout(deadline)
      clearTimeout(graceTimer)
      signal.removeEventListener('abort', onAbort)
    }
    // 'error' and 'close' are independent; whichever settles first wins and a
    // repeat settle is a no-op. 'close' also fires after a failed spawn.
    child.on('error', (error: Error) => {
      cleanup()
      killGroup('SIGKILL')
      rejectCase(new SelfDevelopmentRunnerError(
        `acceptance case ${testCase.caseId} could not start: ${error.message}`,
        'SELF_DEV_RUNNER_EXECUTOR_FAILED',
      ))
    })
    child.on('close', (exitCode, terminatingSignal) => {
      cleanup()
      void finishProcessGroup(groupPid, config.killGraceMs).then(
        () => { resolveCase({ exitCode, signal: terminatingSignal, timedOut, cancelled, stdout, stdoutTruncated }) },
        rejectCase,
      )
    })
  })
}

/** One evaluated assertion, structurally the core package's `AssertionResult`. */
interface EvaluatedAssertion {
  /** Assertion identity from the acceptance case. */
  readonly assertionId: string
  /** Observed status; the acceptor only ever reports `pass` or `fail`. */
  readonly status: 'pass' | 'fail'
}

/**
 * Evaluate every assertion of one case against the recorded process outcome.
 * A deadline, an abort, a signal-terminated process, or stdout retained only
 * up to the byte cap fails all assertions: the run was shortened, so its
 * recorded output cannot verify any assertion.
 * @param worktree - absolute worktree root the file assertions read under.
 * @param testCase - the executed case.
 * @param outcome - the recorded process outcome.
 * @returns one result per assertion in definition order.
 */
async function evaluateAssertions(
  worktree: string,
  testCase: AcceptanceCase,
  outcome: CaseOutcome,
): Promise<readonly EvaluatedAssertion[]> {
  if (outcome.timedOut || outcome.cancelled || outcome.signal !== null || outcome.stdoutTruncated) {
    return testCase.assertions.map(assertion => ({ assertionId: assertion.assertionId, status: 'fail' as const }))
  }
  return Promise.all(testCase.assertions.map(async assertion => ({
    assertionId: assertion.assertionId,
    status: await assertionPassed(worktree, assertion, outcome) ? 'pass' as const : 'fail' as const,
  })))
}

/**
 * Evaluate one assertion. `file-*` paths are worktree-relative and are
 * re-checked through the filesystem at the moment they are read, so a symlink
 * planted by the case — as the path itself or as an ancestor directory —
 * cannot satisfy an assertion with outside content. A check that fails at use
 * time fails the assertion; it never throws a pass.
 * @param worktree - absolute worktree root.
 * @param assertion - the assertion to evaluate.
 * @param outcome - the recorded process outcome.
 * @returns true when the assertion observed what it expected.
 */
async function assertionPassed(
  worktree: string,
  assertion: AcceptanceAssertion,
  outcome: CaseOutcome,
): Promise<boolean> {
  switch (assertion.kind) {
    case 'exit-code':
      return outcome.exitCode === assertion.expected
    case 'stdout-includes':
      return outcome.stdout.includes(assertion.text)
    case 'file-exists':
      return await staysInside(worktree, resolve(worktree, assertion.path)) &&
        await lstat(resolve(worktree, assertion.path)).then(info => !info.isSymbolicLink(), () => false)
    case 'file-includes': {
      if (!(await staysInside(worktree, resolve(worktree, assertion.path)))) return false
      const info = await lstat(resolve(worktree, assertion.path)).catch(() => undefined)
      if (info === undefined || !info.isFile()) return false
      const content = await readFile(resolve(worktree, assertion.path), 'utf8').catch(() => undefined)
      return content !== undefined && content.includes(assertion.text)
    }
  }
}

/**
 * A placeholder all-fail result for a case the run never executed because the
 * request signal had already aborted.
 * @param testCase - the skipped case.
 * @returns the all-fail case result.
 */
function failedCase(testCase: AcceptanceCase): CaseResult {
  return {
    caseId: testCase.caseId,
    assertions: testCase.assertions.map(assertion => ({ assertionId: assertion.assertionId, status: 'fail' as const })),
  }
}
