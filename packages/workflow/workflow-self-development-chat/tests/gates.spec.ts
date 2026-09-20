/**
 * The `verify(worktree)` builder: the real `sh -c` gate runner (exit code,
 * non-zero failure, and a real short timeout — no test waits out the real
 * 20-minute gate budget), and `buildVerify`'s own sequencing (runner first,
 * then every gate in order, stopping at the first failure).
 * @module gates.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GATE_TIMEOUT_MS, buildVerify, judgeAcceptanceRun, runShellCommand } from '../src/gates.ts'
import type { GateRunResult } from '../src/gates.ts'
import { resolveChatConfig } from '../src/config.ts'
import type { AcceptanceRunView, RunnerVerifyPort, RunnerVerifyResult } from '../src/types.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('runShellCommand', () => {
  it('runs a command with sh -c and reports a clean exit', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-chat-gates-'))
    const result = await runShellCommand('echo hello', root, 5000)
    expect(result).toEqual({ code: 0, timedOut: false, output: 'hello\n' })
  })

  it('reports a non-zero exit code without timing out', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-chat-gates-'))
    const result = await runShellCommand('exit 3', root, 5000)
    expect(result.code).toBe(3)
    expect(result.timedOut).toBe(false)
  })

  it('combines stdout and stderr in emission order', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-chat-gates-'))
    const result = await runShellCommand('echo out && echo err 1>&2', root, 5000)
    expect(result.output).toContain('out')
    expect(result.output).toContain('err')
  })

  it('kills a command past the deadline and reports timedOut, not a normal exit', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-chat-gates-'))
    const result = await runShellCommand('sleep 5', root, 200)
    expect(result.timedOut).toBe(true)
    expect(result.code).toBeNull()
  })

  it('falls back to a null code (not the non-numeric spawn error code) for a spawn failure such as a missing cwd', async () => {
    const result = await runShellCommand('echo unreachable', '/no/such/directory/self-dev-chat-gates', 5000)
    expect(result.timedOut).toBe(false)
    expect(result.code).toBeNull()
    expect(result.output).toBe('')
  })
})

/** An all-pass acceptor run: one case whose two assertions passed. */
const PASSING_RUN: AcceptanceRunView = {
  cases: [{ caseId: 'smoke', assertions: [{ assertionId: 'exit-zero', status: 'pass' }, { assertionId: 'stdout', status: 'pass' }] }],
  exitCode: 0,
  timedOut: false,
  cancelled: false,
}

/** A runner fake with a configurable result, recording every call. */
class FakeRunner implements RunnerVerifyPort {
  calls: { worktree: string; acceptancePath: string; phaseTimeoutMs: number | undefined }[] = []
  result: RunnerVerifyResult = { ok: true, report: PASSING_RUN }

  async verifyAcceptance(
    worktree: string,
    acceptancePath: string,
    options: { readonly phaseTimeoutMs?: number } = {},
  ): Promise<RunnerVerifyResult> {
    this.calls.push({ worktree, acceptancePath, phaseTimeoutMs: options.phaseTimeoutMs })
    return this.result
  }
}

const CONFIG = resolveChatConfig({
  stableRepo: '/repo',
  controlDirectory: '/control',
  experimentsRoot: '/exp',
  actor: 'user',
  targetBranch: 'stable',
})

describe('buildVerify', () => {
  it('calls the runner with the worktree, the task acceptance path, and the gate deadline', async () => {
    const runner = new FakeRunner()
    const verify = buildVerify(runner, CONFIG, 'task-1')
    const outcome = await verify('/exp/task-1')
    expect(outcome).toEqual({ ok: true })
    expect(runner.calls).toEqual([{ worktree: '/exp/task-1', acceptancePath: '/control/acceptance/task-1.json', phaseTimeoutMs: GATE_TIMEOUT_MS }])
  })

  it('fails without running any gate when the runner could not run the definition', async () => {
    const runner = new FakeRunner()
    runner.result = { ok: false, reason: 'definition resolves inside the experiments root' }
    let gateCalls = 0
    const config = resolveChatConfig({ ...CONFIG, integrationGates: ['node test.mjs'] })
    const verify = buildVerify(runner, config, 'task-1', { runShell: async () => { gateCalls += 1; return { code: 0, timedOut: false, output: '' } } })
    const outcome = await verify('/exp/task-1')
    expect(outcome).toEqual({ ok: false, reason: 'acceptance could not be run: definition resolves inside the experiments root' })
    expect(gateCalls).toBe(0)
  })

  it('fails without running any gate when a completed run has a failed assertion', async () => {
    const runner = new FakeRunner()
    runner.result = {
      ok: true,
      report: {
        cases: [
          { caseId: 'smoke', assertions: [{ assertionId: 'exit-zero', status: 'pass' }, { assertionId: 'stdout', status: 'fail' }] },
          { caseId: 'second', assertions: [{ assertionId: 'exists', status: 'skipped' }] },
        ],
        exitCode: 1,
        timedOut: false,
        cancelled: false,
      },
    }
    let gateCalls = 0
    const config = resolveChatConfig({ ...CONFIG, integrationGates: ['node test.mjs'] })
    const verify = buildVerify(runner, config, 'task-1', { runShell: async () => { gateCalls += 1; return { code: 0, timedOut: false, output: '' } } })
    const outcome = await verify('/exp/task-1')
    expect(outcome).toEqual({ ok: false, reason: 'acceptance failed (exit code 1): case smoke: stdout fail; case second: exists skipped' })
    expect(gateCalls).toBe(0)
  })

  it('treats a thrown runner call as ok: false', async () => {
    const runner: RunnerVerifyPort = { verifyAcceptance: async () => { throw new Error('boom') } }
    const verify = buildVerify(runner, CONFIG, 'task-1')
    const outcome = await verify('/exp/task-1')
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('threw')
  })

  it('runs every configured gate in order after the runner passes, and passes when all do', async () => {
    const runner = new FakeRunner()
    const config = resolveChatConfig({ ...CONFIG, integrationGates: ['pnpm run --silent build', 'node test.mjs'] })
    const seen: string[] = []
    const verify = buildVerify(runner, config, 'task-1', {
      runShell: async (command) => { seen.push(command); return { code: 0, timedOut: false, output: '' } },
    })
    const outcome = await verify('/exp/task-1')
    expect(outcome).toEqual({ ok: true })
    expect(seen).toEqual(['pnpm run --silent build', 'node test.mjs'])
  })

  it('stops at the first failing gate and does not run the rest', async () => {
    const runner = new FakeRunner()
    const config = resolveChatConfig({ ...CONFIG, integrationGates: ['first', 'second'] })
    const seen: string[] = []
    const verify = buildVerify(runner, config, 'task-1', {
      runShell: async (command): Promise<GateRunResult> => {
        seen.push(command)
        return command === 'first' ? { code: 1, timedOut: false, output: 'boom' } : { code: 0, timedOut: false, output: '' }
      },
    })
    const outcome = await verify('/exp/task-1')
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('"first"')
    expect(!outcome.ok && outcome.reason).toContain('exited with code 1')
    expect(seen).toEqual(['first'])
  })

  it('names the timeout, not an exit code, when a gate times out', async () => {
    const runner = new FakeRunner()
    const config = resolveChatConfig({ ...CONFIG, integrationGates: ['slow'] })
    const verify = buildVerify(runner, config, 'task-1', {
      runShell: async () => ({ code: null, timedOut: true, output: '' }),
    })
    const outcome = await verify('/exp/task-1')
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('timed out after')
  })

  it('keeps only the last 2 KB of a failing gate\'s output in the reason', async () => {
    const runner = new FakeRunner()
    const config = resolveChatConfig({ ...CONFIG, integrationGates: ['noisy'] })
    const head = 'HEAD-MARKER-NOT-KEPT'
    const tail = 'TAIL-MARKER-KEPT'
    const output = head + 'x'.repeat(4000) + tail
    const verify = buildVerify(runner, config, 'task-1', {
      runShell: async () => ({ code: 1, timedOut: false, output }),
    })
    const outcome = await verify('/exp/task-1')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain(tail)
    expect(outcome.reason).not.toContain(head)
    // The kept tail itself is bounded to 2 KB, well under the full ~4 KB output.
    const keptOutputLength = outcome.reason.length - outcome.reason.indexOf('Output tail:\n') - 'Output tail:\n'.length
    expect(keptOutputLength).toBeLessThanOrEqual(2048)
  })
})

describe('judgeAcceptanceRun', () => {
  it('passes an all-pass run', () => {
    expect(judgeAcceptanceRun(PASSING_RUN)).toEqual({ ok: true })
  })

  it('passes a run with no cases', () => {
    expect(judgeAcceptanceRun({ cases: [], exitCode: 0, timedOut: false, cancelled: false })).toEqual({ ok: true })
  })

  it('reports a timed-out run and a cancelled run even when every assertion passed', () => {
    expect(judgeAcceptanceRun({ ...PASSING_RUN, timedOut: true })).toEqual({ ok: false, reason: 'acceptance failed (exit code 0): a case reached its deadline' })
    expect(judgeAcceptanceRun({ ...PASSING_RUN, cancelled: true })).toEqual({ ok: false, reason: 'acceptance failed (exit code 0): the run was cancelled' })
  })
})
