/**
 * Headless executor behavior: step counting from `status` events, final-text
 * accumulation, phase deadline and step-cap teardown with SIGTERM→SIGKILL
 * escalation against the whole process group, cancellation, the stderr tail
 * bound, and the stdout accumulation bound. A run the executor tore down
 * reports the executor's own signal with no exit code, even when the child
 * exits 0 after catching SIGTERM, and the run settles on `close` so events
 * draining after the child died are still counted. Every case owns one
 * temporary worktree and the suite leaves no fixture process alive.
 * @module executor.spec
 */

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runHeadlessExecutor as executeHeadless } from '../src/executor.ts'
import type { ExecutorRequest } from '../src/executor.ts'
import type { RunnerConfig } from '../src/types.ts'

const fixture = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))

let root: string | undefined
let worktree: string | undefined
/** Grandchild pids announced by the `orphan` fixture, killed again in teardown. */
const orphanPids: number[] = []
let scopeAbort = new AbortController()
const runs: Promise<unknown>[] = []

/** Keep every subprocess run owned until teardown, including failed assertions. */
function runHeadlessExecutor(config: RunnerConfig, request: ExecutorRequest): ReturnType<typeof executeHeadless> {
  const run = executeHeadless(config, { ...request, signal: AbortSignal.any([request.signal, scopeAbort.signal]) })
  runs.push(run)
  return run
}

afterEach(async () => {
  scopeAbort.abort()
  await Promise.allSettled(runs.splice(0))
  scopeAbort = new AbortController()
  for (const pid of orphanPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The process-group teardown already collected the grandchild.
    }
  }
  orphanPids.length = 0
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  worktree = undefined
  vi.restoreAllMocks()
})

/** Build a runner config and a fresh experiment worktree under one temp root. */
async function makeConfig(overrides: Partial<RunnerConfig> = {}): Promise<RunnerConfig> {
  const base = await mkdtemp(join(tmpdir(), 'self-dev-executor-'))
  root = base
  worktree = join(base, 'worktree')
  await mkdir(worktree, { recursive: true })
  return {
    nodeBinary: process.execPath,
    dshBin: fixture,
    dshHome: join(base, 'dsh-home'),
    experimentsRoot: join(base, 'experiments'),
    evidenceRoot: join(base, 'evidence'),
    killGraceMs: 200,
    ...overrides,
  }
}

/** One executor request against the suite's fixture, keyed on the task text. */
function req(task: string, overrides: Partial<ExecutorRequest> = {}): ExecutorRequest {
  return {
    worktree: worktree ?? '',
    task,
    phaseTimeoutMs: 5000,
    maxSteps: 10,
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe.skipIf(process.platform === 'win32')('headless executor', () => {
  it('keeps the first session id and decodes multibyte text without a trailing newline', async () => {
    const run = await runHeadlessExecutor(await makeConfig(), req('unicode-tail'))
    expect(run.sessionId).toBe('first-session')
    expect(run.finalText).toBe('中文🙂')
    expect(run.exitCode).toBe(0)
  }, 20_000)
  // Per-case timeout widened above the lane default: this process-bound suite
  // must absorb deadline + kill grace + group-escalation + reaping under CI
  // contention, and no case here has a tighter deadline than its own subject.
  it('counts steps from status events and returns the final text', async () => {
    const run = await runHeadlessExecutor(await makeConfig(), req('ok'))
    expect(run).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      stepsUsed: 3,
      stepCapHit: false,
    })
    expect(run.sessionId).toMatch(/^session-/)
    expect(run.finalText).toContain('done')
    expect(run.stderrTail).toBe('')
    expect(run.durationMs).toBeGreaterThanOrEqual(0)
  }, 20_000)

  it('runs past every step when no cap is configured', async () => {
    const run = await runHeadlessExecutor(await makeConfig(), req('ok', { maxSteps: undefined }))
    expect(run).toMatchObject({ exitCode: 0, stepsUsed: 3, stepCapHit: false })
  }, 20_000)

  it('hands the configured dshHome to the child when the request names none', async () => {
    const config = await makeConfig()
    await runHeadlessExecutor(config, req('env-dump'))
    await expect(readFile(join(worktree ?? '', 'dsh-home-dump.txt'), 'utf8')).resolves.toBe(config.dshHome)
  }, 20_000)

  it('hands the requested data directory to the child as DSH_HOME', async () => {
    const config = await makeConfig()
    const dshHome = join(root ?? '', 'per-attempt-home')
    await mkdir(dshHome, { recursive: true })
    await runHeadlessExecutor(config, req('env-dump', { dshHome }))
    await expect(readFile(join(worktree ?? '', 'dsh-home-dump.txt'), 'utf8')).resolves.toBe(dshHome)
  }, 20_000)

  it('tolerates non-JSON and malformed events and keeps the 4 KiB stderr tail', async () => {
    const run = await runHeadlessExecutor(await makeConfig(), req('fail'))
    expect(run.exitCode).toBe(1)
    expect(run.signal).toBeNull()
    // The malformed session and text events leave both fields untouched.
    expect(run.sessionId).toBeUndefined()
    expect(run.finalText).toBe('')
    expect(run.stderrTail.length).toBeLessThanOrEqual(4096)
    expect(run.stderrTail).toContain('STDERR-TAIL-MARKER')
    // Only the tail survives: the head marker is past the 4 KiB bound.
    expect(run.stderrTail).not.toContain('HEAD-OF-STDERR-MARKER')
  }, 20_000)

  it('kills the process group at the phase deadline even when SIGTERM is ignored', async () => {
    const run = await runHeadlessExecutor(await makeConfig(), req('slow', { phaseTimeoutMs: 500 }))
    expect(run.timedOut).toBe(true)
    expect(run.cancelled).toBe(false)
    expect(run.exitCode).toBeNull()
    expect(run.signal).toBe('SIGKILL')
  }, 20_000)

  it('stops at the step cap', async () => {
    const run = await runHeadlessExecutor(await makeConfig(), req('steps-5', { maxSteps: 2 }))
    expect(run.stepCapHit).toBe(true)
    expect(run.stepsUsed).toBeGreaterThanOrEqual(3)
    expect(run.exitCode).toBeNull()
    expect(run.timedOut).toBe(false)
  }, 20_000)

  it('reports the executor kill signal, not exit 0, when a step-capped child exits gracefully', async () => {
    const run = await runHeadlessExecutor(await makeConfig(), req('graceful', { maxSteps: 2 }))
    expect(run.stepCapHit).toBe(true)
    expect(run.timedOut).toBe(false)
    expect(run.cancelled).toBe(false)
    expect(run.signal).not.toBeNull()
    expect(run.exitCode).toBeNull()
    expect(run.signal).toBe('SIGTERM')
  }, 20_000)

  it('reports the executor kill signal, not exit 0, when a phase-timeout child exits gracefully', async () => {
    const run = await runHeadlessExecutor(await makeConfig(), req('graceful', { phaseTimeoutMs: 300, maxSteps: undefined }))
    expect(run.timedOut).toBe(true)
    expect(run.stepCapHit).toBe(false)
    expect(run.cancelled).toBe(false)
    expect(run.signal).not.toBeNull()
    expect(run.exitCode).toBeNull()
    expect(run.signal).toBe('SIGTERM')
  }, 20_000)

  it('does not restart the kill grace when cancellation follows a step-cap stop', async () => {
    const controller = new AbortController()
    const config = await makeConfig({ killGraceMs: 400 })
    const kill = vi.spyOn(process, 'kill')
    const pending = runHeadlessExecutor(config, req('slow-steps', { maxSteps: 2, signal: controller.signal }))
    await expect.poll(() => kill.mock.calls.some(([, signal]) => signal === 'SIGTERM'), { timeout: 5000 }).toBe(true)
    controller.abort()
    const run = await pending
    expect(run.stepCapHit).toBe(true)
    expect(run.cancelled).toBe(true)
    expect(run.exitCode).toBeNull()
    expect(run.signal).toBe('SIGKILL')
    expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGTERM')).toHaveLength(1)
    expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1)
    kill.mockRestore()
  }, 20_000)

  it('does not escalate to SIGKILL after a graceful child exits within the kill grace', async () => {
    const kill = vi.spyOn(process, 'kill')
    try {
      const config = await makeConfig()
      const run = await runHeadlessExecutor(config, req('graceful', { maxSteps: 2 }))
      expect(run.signal).toBe('SIGTERM')
      // The escalation timer had to be cancelled: past the grace window no
      // SIGKILL may reach the already-gone process group.
      await new Promise(resolve => setTimeout(resolve, config.killGraceMs + 150))
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toEqual([])
    } finally {
      kill.mockRestore()
    }
  }, 20_000)

  it('counts every event written before the child exited, not only those read before exit', async () => {
    const run = await runHeadlessExecutor(await makeConfig(), req('flood-events'))
    // 300 synchronous 1 KiB writes exceed the kernel pipe buffer, so the tail
    // events only drain after the child process is gone.
    expect(run.exitCode).toBe(0)
    expect(run.finalText.match(/evt-\d+-/g)).toHaveLength(300)
    expect(run.finalText).toContain('evt-299-')
  }, 20_000)

  it('settles on close so events a grandchild writes after the child exited are all counted', async () => {
    const run = await runHeadlessExecutor(await makeConfig(), req('late-writes'))
    // The fixture process is gone long before its grandchild's events arrive;
    // only a `close` settlement, which waits for stdout EOF, can count them.
    expect(run.exitCode).toBe(0)
    expect(run.stepsUsed).toBe(3)
    expect(run.finalText.match(/late-evt-\d-/g)).toHaveLength(10)
    expect(run.finalText).toContain('late-evt-9-')
  }, 20_000)

  it('stops accumulating stdout at the 1 MiB bound and flags stdoutTruncated', async () => {
    const run = await runHeadlessExecutor(await makeConfig(), req('flood-stdout'))
    expect(run.exitCode).toBeNull()
    expect(run.signal).not.toBeNull()
    expect(run.stdoutTruncated).toBe(true)
    expect(run.finalText.length).toBeLessThanOrEqual(1024 * 1024)
    // Steps are counted only while lines were still parsed: the fixture's
    // sixth step_start arrives after the bound and must not be counted.
    expect(run.stepsUsed).toBe(5)
  }, 20_000)

  it('kills descendants with the group on cancellation', async () => {
    if (process.platform === 'win32') return // POSIX process groups and `sleep` have no Windows equivalent.
    const controller = new AbortController()
    const pending = runHeadlessExecutor(await makeConfig(), req('orphan', { signal: controller.signal }))
    // The fixture announces its grandchild both on stdout and in its cwd; the
    // file is the synchronizable readiness signal for the abort below.
    const pidPath = join(worktree ?? '', 'orphan-grandchild.pid')
    await expect.poll(async () => {
      try {
        return Number(await readFile(pidPath, 'utf8'))
      } catch {
        return 0
      }
    }, { timeout: 5000 }).toBeGreaterThan(0)
    const grandchildPid = Number(await readFile(pidPath, 'utf8'))
    orphanPids.push(grandchildPid)
    controller.abort()
    const run = await pending
    expect(run.cancelled).toBe(true)
    expect(run.timedOut).toBe(false)
    expect(run.finalText).toContain(`grandchild-pid:${String(grandchildPid)}`)
    // The grandchild shared the fixture's process group, so the group kill
    // collected it: a liveness probe must eventually report it gone.
    await expect.poll(() => {
      try {
        process.kill(grandchildPid, 0)
        return false
      } catch {
        return true
      }
    }, { timeout: 5000 }).toBe(true)
  }, 20_000)

  it('collects descendants before returning when the CLI exits normally', async () => {
    if (process.platform === 'win32') return
    const run = await runHeadlessExecutor(await makeConfig(), req('orphan-exit'))
    const grandchildPid = Number(await readFile(join(worktree ?? '', 'orphan-grandchild.pid'), 'utf8'))
    orphanPids.push(grandchildPid)
    expect(run.exitCode).toBe(0)
    expect(() => process.kill(grandchildPid, 0)).toThrow()
  }, 20_000)

  it('reports a cancelled run without spawning when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runHeadlessExecutor(await makeConfig(), req('ok', { signal: controller.signal }))
    expect(run).toMatchObject({
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: true,
      stepsUsed: 0,
      stepCapHit: false,
      sessionId: undefined,
      finalText: '',
      stderrTail: '',
      durationMs: 0,
    })
  }, 20_000)

  it('rejects with the executor error code when the binary cannot spawn', async () => {
    const config = await makeConfig({ nodeBinary: join(root ?? '', 'missing-node') })
    await expect(runHeadlessExecutor(config, req('ok')))
      .rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_EXECUTOR_FAILED' })
  }, 20_000)

  it('records pgidReused when the group signal answers EPERM after the child exited', async () => {
    const killOriginal = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      // The reassigned group refuses our signal; a plain pid probe stays real.
      if (pid < 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      return killOriginal(pid, signal)
    })
    const run = await runHeadlessExecutor(await makeConfig(), req('ok'))
    expect(run).toMatchObject({ exitCode: 0, signal: null, pgidReused: true })
  }, 20_000)

  // Real-subprocess loop over the whole spawn → stream → teardown → group-exit
  // confirmation path: it catches pgid-reuse teardown failures that only
  // appear under load, so it must not assert anything the OS does not
  // guarantee, and the timeout stays far above one contended run.
  const smokeRuns = Array.from({ length: 20 }, (_, index) => [index + 1] as const)
  it.each(smokeRuns)('spawns, runs, and confirms group exit repeatedly: run %i', async () => {
    const run = await runHeadlessExecutor(await makeConfig(), req('ok'))
    expect(run).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      stepsUsed: 3,
      stepCapHit: false,
      pgidReused: false,
    })
  }, 20_000)
})

/**
 * Reason printed on every skipped case below: `sandboxEffectivelyEnabled` and
 * `assertSandboxAvailable` read the real `process.platform` inside the
 * executor (they take no override, unlike their unit-tested counterparts in
 * `sandbox.spec.ts`), so only an actual darwin host ever wraps a spawn.
 */
const DARWIN_ONLY_REASON = 'sandbox-exec wrapping reads the real process.platform, so it only runs on darwin'

/** Run a sandbox-wrapping case on darwin, or record it skipped with a printed reason elsewhere. */
function itDarwinOnly(name: string, fn: () => Promise<void>, timeout?: number): void {
  if (process.platform !== 'darwin') {
    it.skip(`${name} (skipped: ${DARWIN_ONLY_REASON})`, fn)
    return
  }
  it(name, fn, timeout)
}

/** Write an executable POSIX shell fake `sandbox-exec` at `path`. */
async function writeFakeSandboxExec(path: string, body: string): Promise<void> {
  await writeFile(path, body)
  await chmod(path, 0o755)
}

describe('macOS sandbox wrapping', () => {
  itDarwinOnly('wraps the spawn in sandbox-exec by default; the profile names the worktree, the data home, and only the configured deny-read root', async () => {
    const config = await makeConfig()
    const base = root ?? ''
    const log = join(base, 'sandbox-exec.log')
    const fakeSandboxExec = join(base, 'fake-sandbox-exec.sh')
    const denyRoot = join(base, 'deny-me')
    await mkdir(denyRoot, { recursive: true })
    // Pre-created so the assertions below can realpath() it directly; the
    // profile resolver itself (resolveSandboxRoot) tolerates a not-yet-created
    // data home too, proven separately in sandbox.spec.ts.
    await mkdir(config.dshHome, { recursive: true })
    // Records every argv on one line each, then execs the real command
    // (skipping the leading `-p <profile>` this fake was invoked with) so the
    // wrapped fixture still actually runs.
    await writeFakeSandboxExec(fakeSandboxExec, [
      '#!/bin/sh',
      `: > '${log}'`,
      `for a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done`,
      'shift 2',
      'exec "$@"',
      '',
    ].join('\n'))
    const sandboxed: RunnerConfig = {
      ...config,
      sandbox: { enabled: true, denyReadRoots: [denyRoot], extraWritableRoots: [], sandboxExec: fakeSandboxExec },
    }
    const run = await runHeadlessExecutor(sandboxed, req('ok'))
    expect(run.exitCode).toBe(0)
    expect(run.sessionId).toMatch(/^session-/)
    const lines = (await readFile(log, 'utf8')).split('\n')
    expect(lines[0]).toBe('-p')
    const profile = lines[1] ?? ''
    expect(profile).toContain(await realpath(worktree ?? ''))
    expect(profile).toContain(await realpath(config.dshHome))
    const denyForms = profile.match(/\(deny file-read\* \(subpath [^)]*\)\)/g) ?? []
    expect(denyForms).toEqual([`(deny file-read* (subpath ${JSON.stringify(await realpath(denyRoot))}))`])
    expect(lines[2]).toBe(config.nodeBinary)
  }, 20_000)

  itDarwinOnly('does not wrap the spawn when sandbox.enabled is false', async () => {
    const config = await makeConfig()
    const base = root ?? ''
    const log = join(base, 'sandbox-exec.log')
    const fakeSandboxExec = join(base, 'fake-sandbox-exec.sh')
    await writeFakeSandboxExec(fakeSandboxExec, `#!/bin/sh\n: > '${log}'\nexit 0\n`)
    const disabled: RunnerConfig = {
      ...config,
      sandbox: { enabled: false, denyReadRoots: [], extraWritableRoots: [], sandboxExec: fakeSandboxExec },
    }
    const run = await runHeadlessExecutor(disabled, req('ok'))
    expect(run.exitCode).toBe(0)
    // The fake sandbox-exec was never invoked at all: the plain unwrapped
    // spawn ran the CLI directly.
    await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 20_000)

  itDarwinOnly('rejects with the executor error code when sandbox-exec cannot launch the CLI at all', async () => {
    const config = await makeConfig()
    const fakeSandboxExec = join(root ?? '', 'fake-sandbox-exec-launch-fail.sh')
    // Succeeds only for the probe's own `/usr/bin/true` invocation; any other
    // program (the real spawn below) gets sandbox-exec's own launch-failure
    // stderr signature instead of ever running.
    await writeFakeSandboxExec(fakeSandboxExec, [
      '#!/bin/sh',
      'shift 2',
      'if [ "$1" = "/usr/bin/true" ]; then exec /usr/bin/true; fi',
      'echo "sandbox-exec: fake launch failure for $1" >&2',
      'exit 1',
    ].join('\n'))
    const sandboxed: RunnerConfig = {
      ...config,
      sandbox: { enabled: true, denyReadRoots: [], extraWritableRoots: [], sandboxExec: fakeSandboxExec },
    }
    await expect(runHeadlessExecutor(sandboxed, req('ok')))
      .rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_EXECUTOR_FAILED' })
  }, 20_000)

  itDarwinOnly('rejects with SELF_DEV_RUNNER_SANDBOX_UNAVAILABLE before spawning the CLI when the probe fails', async () => {
    const config = await makeConfig()
    const fakeSandboxExec = join(root ?? '', 'fake-sandbox-exec-probe-fail.sh')
    await writeFakeSandboxExec(fakeSandboxExec, '#!/bin/sh\nexit 9\n')
    const sandboxed: RunnerConfig = {
      ...config,
      sandbox: { enabled: true, denyReadRoots: [], extraWritableRoots: [], sandboxExec: fakeSandboxExec },
    }
    await expect(runHeadlessExecutor(sandboxed, req('ok')))
      .rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_SANDBOX_UNAVAILABLE' })
  }, 20_000)

  itDarwinOnly('tears down immediately when cancellation fires while the sandbox probe is still in flight', async () => {
    // Real sandbox-exec: spawning it for the probe genuinely crosses the
    // event loop, so a synchronous abort() right after the call below lands
    // in the gap between the function's first await and its 'abort' listener
    // registration — the exact race `if (request.signal.aborted) onAbort()`
    // (executor.ts) closes.
    const config = await makeConfig()
    const sandboxed: RunnerConfig = {
      ...config,
      sandbox: { enabled: true, denyReadRoots: [], extraWritableRoots: [], sandboxExec: '/usr/bin/sandbox-exec' },
    }
    const controller = new AbortController()
    const pending = runHeadlessExecutor(sandboxed, req('slow', { signal: controller.signal }))
    controller.abort()
    const run = await pending
    expect(run.cancelled).toBe(true)
    expect(run.exitCode).toBeNull()
  }, 20_000)

  // Not darwin-gated: sandboxing is disabled here, so this exercises the
  // ordinary unwrapped `spawn()` 'error' event on every platform — the same
  // path the whole suite relied on before sandboxing existed, which a bad
  // nodeBinary no longer reaches by default now that sandbox-exec itself (not
  // the missing binary) is what spawn() launches on darwin.
  it('rejects with the executor error code through the plain spawn error path when sandboxing is disabled', async () => {
    const config = await makeConfig({ nodeBinary: join(root ?? '', 'missing-node') })
    const disabled: RunnerConfig = {
      ...config,
      sandbox: { enabled: false, denyReadRoots: [], extraWritableRoots: [], sandboxExec: '/usr/bin/sandbox-exec' },
    }
    await expect(runHeadlessExecutor(disabled, req('ok')))
      .rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_EXECUTOR_FAILED' })
  }, 20_000)
})
