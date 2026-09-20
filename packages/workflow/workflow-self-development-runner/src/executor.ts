/**
 * Headless executor: runs one `dsh --profile headless --json <task>` child in
 * an experiment worktree, counts steps from the JSON event stream, and tears
 * the child's whole process group down on the phase deadline, the step cap, or
 * cancellation. The child is a detached group leader, so `SIGTERM` followed by
 * a `killGraceMs` `SIGKILL` reaches every descendant, not just the CLI itself.
 *
 * Once the executor sends a teardown signal, the run is reported as torn down:
 * `signal` is the executor's own signal and `exitCode` is `null`, even when the
 * child caught `SIGTERM` and exited 0 — a run the executor killed never reads
 * as a pass. `timedOut`, `cancelled`, `stepCapHit`, and `stdoutCapHit` are
 * independent facts; any of them can be true alone or together.
 *
 * Teardown is a one-way transition. The first teardown trigger fixes the
 * `SIGTERM` time and therefore the `SIGKILL` escalation time; a later abort,
 * deadline, step, or overflow event only records its own flag and never sends
 * another signal or re-arms the grace window.
 *
 * Stdout is decoded as a UTF-8 stream, so a multibyte character split across
 * chunks still parses. Past `STDOUT_MAX_BYTES` the run fails closed: the
 * executor tears the group down and reports `stdoutTruncated` and
 * `stdoutCapHit`, so an unbounded stream cannot outrun the step cap. The
 * `sessionId` is the first well-formed `session` event's id only; later
 * session events cannot rebrand the run.
 *
 * After the child's `close` event, remaining group members are killed and
 * group exit is confirmed before settlement. Events that only drain
 * after the process died (a grandchild inheriting stdout, a tail still in the
 * kernel pipe) are therefore counted.
 *
 * Fixed limitation: the group kill is POSIX process-group semantics. A
 * descendant that calls `setsid` and leaves the group escapes the teardown.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/executor
 */

import { spawn } from 'node:child_process'
import type { SpawnOptionsWithStdioTuple } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { SelfDevelopmentRunnerError } from './runtime.ts'
import { assertProcessGroupSupport, finishProcessGroup, readGroupLeaderStartedAt } from './process-group.ts'
import { DEFAULT_SANDBOX_CONFIG, assertSandboxAvailable, sandboxEffectivelyEnabled, sandboxLaunchFailed, spawnConfined } from './sandbox.ts'
import type { RunnerConfig } from './types.ts'

/** One supervised headless execution request. */
export interface ExecutorRequest {
  /** Absolute path of the experiment worktree the child runs in and may write. */
  readonly worktree: string
  /** Task text passed to the headless profile as its single positional argument. */
  readonly task: string
  /**
   * Data directory passed to the child as `DSH_HOME`; absent runs with
   * `config.dshHome`, the deployment's single experiment home.
   */
  readonly dshHome?: string
  /** Milliseconds the whole phase may run before the process group is torn down. */
  readonly phaseTimeoutMs: number
  /** Step cap from the frozen plan; `undefined` runs without a cap. */
  readonly maxSteps: number | undefined
  /** Cancellation signal; an already-aborted signal never spawns the child. */
  readonly signal: AbortSignal
}

/** Observed process and stream facts of one headless execution. */
export interface ExecutorRun {
  /**
   * Child exit code, or `null` when a signal terminated the child or the
   * executor tore the run down.
   */
  readonly exitCode: number | null
  /**
   * Signal that ended the run: the executor's own teardown signal when the
   * executor tore the run down (then `exitCode` is `null` regardless of how
   * the child actually exited), otherwise the signal the child died from, or
   * `null` when it exited on its own.
   */
  readonly signal: string | null
  /** Whether the phase deadline fired and tore the child down. */
  readonly timedOut: boolean
  /** Whether `request.signal` aborted and tore the child down. */
  readonly cancelled: boolean
  /** Number of `status`/`step_start` events observed on stdout. */
  readonly stepsUsed: number
  /** Whether the step cap fired and tore the child down. */
  readonly stepCapHit: boolean
  /** Whether the stdout byte cap fired and tore the child down. */
  readonly stdoutCapHit: boolean
  /** Wall-clock milliseconds from request start to child exit confirmation. */
  readonly durationMs: number
  /** `sessionId` of the first well-formed `session` event, when one arrived. */
  readonly sessionId: string | undefined
  /** Concatenation of every well-formed `text` event in arrival order. */
  readonly finalText: string
  /** Last 4 KiB of the child's stderr, decoded lossily at multibyte splits. */
  readonly stderrTail: string
  /**
   * Whether stdout grew past `STDOUT_MAX_BYTES`. The overflow tears the run
   * down, and lines past the bound are neither retained nor parsed, so steps
   * and final text reflect only what fit before the cap fired.
   */
  readonly stdoutTruncated: boolean
  /**
   * Whether final cleanup observed `EPERM` on the group signal while the
   * spawned group leader (pid plus `ps` start-time fingerprint) no longer
   * existed: the numeric pgid was probably reassigned after our group exited,
   * so the cleanup cannot signal a group it does not own. That state is
   * recorded instead of failing the run. Absent on a run that never spawned.
   */
  readonly pgidReused?: boolean
}

/** Byte bound of the retained stderr tail. */
const STDERR_TAIL_BYTES = 4096

/**
 * Byte bound of accumulated stdout. Crossing it fails the run closed: the
 * executor tears the group down instead of letting execution continue past a
 * cap that also bounds step counting.
 */
const STDOUT_MAX_BYTES = 1024 * 1024

/** Teardown signals the executor itself sends to the child's process group. */
type ExecutorTeardownSignal = 'SIGTERM' | 'SIGKILL'

/**
 * Run one headless execution and report how it ended.
 * @param config - deployment configuration owning the binaries and the kill grace.
 * @param request - worktree, task, data directory, budgets, and cancellation signal for this run.
 * @returns process and stream facts after pipe closure and group-exit confirmation.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EXECUTOR_FAILED` when the
 *   child cannot spawn or group exit cannot be confirmed; `SELF_DEV_RUNNER_CONFIG_INVALID`
 *   on Windows, before spawning.
 */
export async function runHeadlessExecutor(config: RunnerConfig, request: ExecutorRequest): Promise<ExecutorRun> {
  assertProcessGroupSupport(process.platform)
  const startedAtMs = Date.now()
  if (request.signal.aborted) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: true,
      stepsUsed: 0,
      stepCapHit: false,
      stdoutCapHit: false,
      durationMs: 0,
      sessionId: undefined,
      finalText: '',
      stderrTail: '',
      stdoutTruncated: false,
    }
  }
  const sandboxConfig = config.sandbox ?? DEFAULT_SANDBOX_CONFIG
  await assertSandboxAvailable(sandboxConfig)
  const dshHomeReal = request.dshHome ?? config.dshHome
  // Ambient provider credentials and proxy variables are not inherited.
  // HOME and DSH_HOME still refer to files accessible under the child's UID.
  const options: SpawnOptionsWithStdioTuple<'ignore', 'pipe', 'pipe'> = {
    cwd: request.worktree,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DSH_HOME: dshHomeReal,
      DSH_PERMISSION_MODE: 'workspace-write',
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
  const rawArgv = [config.dshBin, '--profile', 'headless', '--json', request.task]
  const sandboxWrapped = sandboxEffectivelyEnabled(sandboxConfig)
  // sandbox-exec `execve`s the target program in place: the pid it reports is
  // the same pid `node`/the CLI ultimately runs under, so the process-group
  // leader fingerprint captured below is unaffected by the wrap.
  const child = sandboxWrapped
    ? await spawnConfined(sandboxConfig, { worktreeReal: request.worktree, dshHomeReal }, config.nodeBinary, rawArgv, options)
    : spawn(config.nodeBinary, rawArgv, options)
  // Fingerprint the group leader now, before its `exit` event can reap it and
  // free the pgid for reuse. The read never rejects; a missing fingerprint
  // leaves the caller's own exit observation to separate a reused pgid from a
  // live leader during final cleanup.
  /* v8 ignore next -- a POSIX spawn that yields no pid has no process; its 'error' reject path never reads the leader record. */
  const leaderStartedAt = child.pid === undefined ? undefined : readGroupLeaderStartedAt(child.pid)

  return await new Promise((resolve, reject) => {
    let stepsUsed = 0
    let stepCapHit = false
    let stdoutCapHit = false
    let timedOut = false
    let cancelled = false
    let sessionId: string | undefined
    let finalText = ''
    let stderrTail = Buffer.alloc(0)
    let stdoutTruncated = false
    /** Signal this executor last sent to the group, or `null` before teardown. */
    let teardownSignal: ExecutorTeardownSignal | null = null
    /** Whether teardown has begun; it is one-way and never re-arms. */
    let teardownBegun = false
    let killGraceTimer: NodeJS.Timeout | undefined

    /**
     * Signal the child's whole process group. Delivery races child exit, so a
     * gone group (ESRCH) or a platform without group signalling stays a no-op.
     */
    const killGroup = (sig: NodeJS.Signals): void => {
      /* v8 ignore next -- teardown only runs while a spawned child owns the group; a
         spawn failure settles through its error event before any timer or event fires. */
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, sig)
      } catch {
        // The group is already gone; teardown stays best-effort and idempotent.
      }
    }

    /**
     * Begin tearing the child's process group down: one `SIGTERM` now and one
     * `SIGKILL` after the configured grace. The first call fixes the escalation
     * time; later deadline, abort, step, or overflow events only record their
     * own flag, so nothing extends the grace window past the first `SIGTERM`.
     */
    const beginTeardown = (): void => {
      if (teardownBegun) return
      teardownBegun = true
      teardownSignal = 'SIGTERM'
      killGroup('SIGTERM')
      killGraceTimer = setTimeout(() => {
        teardownSignal = 'SIGKILL'
        killGroup('SIGKILL')
      }, config.killGraceMs)
    }

    const onAbort = (): void => {
      cancelled = true
      beginTeardown()
    }
    request.signal.addEventListener('abort', onAbort, { once: true })
    // The sandbox probe and profile resolution above are the first `await`s
    // between the early aborted-check and this listener: a signal that fired
    // during that gap already dispatched its (one-shot) 'abort' event and
    // would never reach `onAbort` otherwise, leaving a cancelled attempt
    // running until its own deadline instead of tearing down immediately.
    if (request.signal.aborted) onAbort()

    const deadline = setTimeout(() => {
      timedOut = true
      beginTeardown()
    }, request.phaseTimeoutMs)

    /** Cancel the phase deadline and any pending SIGKILL escalation. */
    const stopTeardownTimers = (): void => {
      clearTimeout(deadline)
      if (killGraceTimer !== undefined) clearTimeout(killGraceTimer)
    }

    /** Apply one NDJSON event from the child's stdout to the run's facts. */
    const handleLine = (line: string): void => {
      if (line.length === 0) return
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        // A non-JSON stdout line is not an event; the run continues.
        return
      }
      if (typeof event !== 'object' || event === null) return
      const record = event as Record<string, unknown>
      if (record.type === 'session') {
        // The run's identity is fixed by the first well-formed session event;
        // a later session event cannot rebrand it.
        if (sessionId === undefined && typeof record.sessionId === 'string') sessionId = record.sessionId
      } else if (record.type === 'status' && record.phase === 'step_start') {
        stepsUsed += 1
        if (!stepCapHit && request.maxSteps !== undefined && stepsUsed > request.maxSteps) {
          stepCapHit = true
          beginTeardown()
        }
      } else if (record.type === 'text' && typeof record.text === 'string') {
        finalText += record.text
      }
    }

    // Stdout decodes as one UTF-8 stream: a multibyte character split across
    // chunks stays intact because the decoder holds the incomplete tail, and a
    // trailing half line at exit is parsed once EOF confirms it. Neither case
    // invents or drops an event.
    const decoder = new StringDecoder('utf8')
    let pending = ''
    let stdoutBytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return
      if (stdoutBytes + chunk.length > STDOUT_MAX_BYTES) {
        // Fail closed: an unbounded stream must not outrun the step cap, so
        // the overflow tears the group down and the run reports non-success
        // with `stdoutTruncated` and `stdoutCapHit`.
        stdoutTruncated = true
        stdoutCapHit = true
        pending = ''
        beginTeardown()
        return
      }
      stdoutBytes += chunk.length
      pending += decoder.write(chunk)
      let newlineAt = pending.indexOf('\n')
      while (newlineAt >= 0) {
        handleLine(pending.slice(0, newlineAt))
        pending = pending.slice(newlineAt + 1)
        newlineAt = pending.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES)
    })

    child.on('close', (code, signal) => {
      if (!stdoutTruncated) {
        // EOF completes any partial line and any split multibyte character.
        pending += decoder.end()
        handleLine(pending)
        pending = ''
      }
      stopTeardownTimers()
      request.signal.removeEventListener('abort', onAbort)
      const result: ExecutorRun = {
        // A run the executor tore down reports the executor's own signal and
        // no exit code, even when the child exited 0 after catching SIGTERM.
        exitCode: teardownSignal === null ? code : null,
        signal: teardownSignal ?? signal,
        timedOut,
        cancelled,
        stepsUsed,
        stepCapHit,
        stdoutCapHit,
        durationMs: Date.now() - startedAtMs,
        sessionId,
        finalText,
        stderrTail: stderrTail.toString('utf8'),
        stdoutTruncated,
      }
      void (async () => {
        // `close` fires only after the leader exited and Node reaped it, so
        // the record always says `exited: true` here.
        /* v8 ignore next 3 -- a POSIX spawn that yields no pid has no process; its 'error' reject path never reaches the cleanup. */
        const leader = child.pid === undefined
          ? undefined
          : { pid: child.pid, exited: true, startedAt: await leaderStartedAt }
        const groupExit = await finishProcessGroup(child.pid, config.killGraceMs, leader)
        if (sandboxWrapped && sessionId === undefined && sandboxLaunchFailed(result.stderrTail)) {
          // sandbox-exec could not execve() the CLI at all (missing binary,
          // EACCES, or a profile the kernel refused): the CLI never ran, so
          // this is a spawn failure, not a CLI exit — reported the same way
          // an unwrapped ENOENT would be, through the 'error' handler below.
          throw new SelfDevelopmentRunnerError(
            `headless executor could not spawn ${JSON.stringify(config.nodeBinary)} under sandbox-exec: ${result.stderrTail.trim()}`,
            'SELF_DEV_RUNNER_EXECUTOR_FAILED',
          )
        }
        resolve({ ...result, pgidReused: groupExit.pgidReused })
      })().then(undefined, reject)
    })

    child.on('error', (error: Error) => {
      stopTeardownTimers()
      request.signal.removeEventListener('abort', onAbort)
      reject(new SelfDevelopmentRunnerError(`headless executor could not spawn ${JSON.stringify(config.nodeBinary)}: ${error.message}`, 'SELF_DEV_RUNNER_EXECUTOR_FAILED'))
    })
  })
}
