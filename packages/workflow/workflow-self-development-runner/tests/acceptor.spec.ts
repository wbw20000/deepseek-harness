/**
 * Independent acceptor behavior: stable-side acceptance definitions outside
 * the experiments root, frozen-plan coverage checks, per-case process groups
 * with deadlines, and post-exit assertion evaluation. Subprocess cases use the
 * `fake-case` fixture and are reaped through the runner's own process-group
 * teardown; every test awaits the run's completion signal and teardown reaps
 * any fixture pid a running test recorded.
 * @module acceptor.spec
 */

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkAcceptanceCoversPlan, loadAcceptance, runAcceptance as executeAcceptance } from '../src/acceptor.ts'
import type { AcceptanceCase } from '../src/acceptor.ts'
import type { RunnerConfig } from '../src/types.ts'
import type { FrozenTestPlan } from '@deepseek-ai/dsh-workflow-self-development'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, realpath: vi.fn(actual.realpath), readFile: vi.fn(actual.readFile) }
})

/** Absolute path of the fake acceptance command fixture. */
const fixture = fileURLToPath(new URL('./fixtures/fake-case.mjs', import.meta.url))

let root: string | undefined
/** Fixture pids recorded by running tests; teardown kills any surviving group. */
const casePids: number[] = []
let scopeAbort = new AbortController()
const runs: Promise<unknown>[] = []

/** Keep every subprocess run owned until teardown, including failed assertions. */
function runAcceptance(config: RunnerConfig, request: Parameters<typeof executeAcceptance>[1]): ReturnType<typeof executeAcceptance> {
  const run = executeAcceptance(config, { ...request, signal: AbortSignal.any([request.signal, scopeAbort.signal]) })
  runs.push(run)
  return run
}

afterEach(async () => {
  scopeAbort.abort()
  await Promise.allSettled(runs.splice(0))
  scopeAbort = new AbortController()
  for (const pid of casePids) {
    try {
      // The pid doubles as the detached process group: kill the whole group in
      // case a descendant outlived the direct child.
      process.kill(-pid, 'SIGKILL')
    } catch {
      // The run's own group teardown already collected the process.
    }
  }
  casePids.length = 0
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.restoreAllMocks()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(realpath).mockReset().mockImplementation(actual.realpath)
  vi.mocked(readFile).mockReset().mockImplementation(actual.readFile)
})

/** Root directory of the fixture the running test created. */
function fixtureRoot(): string {
  const current = root
  if (current === undefined) throw new Error('fixture missing root')
  return current
}

/** A temporary experiments tree with one worktree inside it. */
async function makeFixture(): Promise<{ config: RunnerConfig; experimentsRoot: string; worktree: string }> {
  root = await mkdtemp(join(tmpdir(), 'self-dev-acceptor-'))
  const experimentsRoot = join(root, 'experiments')
  const worktree = join(experimentsRoot, 'wt')
  await mkdir(worktree, { recursive: true })
  return {
    config: {
      nodeBinary: process.execPath,
      dshBin: join(root, 'unused-dsh-bin'),
      dshHome: join(root, 'dsh-home'),
      experimentsRoot,
      evidenceRoot: join(root, 'evidence'),
      killGraceMs: 200,
    },
    experimentsRoot,
    worktree,
  }
}

/** A frozen plan requiring one case with the given assertion identities. */
function planWith(caseId: string, assertionIds: readonly string[]): FrozenTestPlan {
  return {
    testPlanId: 'plan-1',
    version: 1,
    taskSpecVersion: 1,
    requiredCases: [{ caseId, requirement: 'must pass', assertionIds }],
    manualCases: [],
    digest: 'd'.repeat(64),
  } as unknown as FrozenTestPlan
}

/** A case whose process exits with the given code. */
function exitCase(caseId: string, code: number, expected: number): AcceptanceCase {
  return {
    caseId,
    command: ['node', fixture, 'exit', String(code)],
    timeoutMs: 5000,
    assertions: [{ assertionId: `${caseId}-exit`, kind: 'exit-code', expected }],
  }
}

/** A case echoing one text and asserting on stdout and the exit code. */
function echoCase(caseId: string, text: string, expectedText: string): AcceptanceCase {
  return {
    caseId,
    command: ['node', fixture, 'echo', text],
    timeoutMs: 5000,
    assertions: [
      { assertionId: `${caseId}-stdout`, kind: 'stdout-includes', text: expectedText },
      { assertionId: `${caseId}-exit`, kind: 'exit-code', expected: 0 },
    ],
  }
}

/** A case writing one file and asserting on its existence and content. */
function fileCase(caseId: string, writtenPath: string, writtenText: string, assertedPath: string, assertedText: string): AcceptanceCase {
  return {
    caseId,
    command: ['node', fixture, 'write', writtenPath, writtenText],
    timeoutMs: 5000,
    assertions: [
      { assertionId: `${caseId}-exists`, kind: 'file-exists', path: assertedPath },
      { assertionId: `${caseId}-includes`, kind: 'file-includes', path: assertedPath, text: assertedText },
    ],
  }
}

describe('loadAcceptance', () => {
  it('rejects duplicate case and assertion identities', async () => {
    const { config } = await makeFixture()
    const path = join(fixtureRoot(), 'duplicates.json')
    const duplicate = exitCase('same', 0, 0)
    await writeFile(path, JSON.stringify({ cases: [duplicate, duplicate] }))
    await expect(loadAcceptance(path, config.experimentsRoot)).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' })
    await writeFile(path, JSON.stringify({ cases: [{ ...duplicate, assertions: [...duplicate.assertions, ...duplicate.assertions] }] }))
    await expect(loadAcceptance(path, config.experimentsRoot)).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' })
  })
  it('loads a definition stored outside the experiments root', async () => {
    const { config } = await makeFixture()
    const definition = {
      cases: [
        echoCase('build', 'all-good', 'all-good'),
        fileCase('files', 'out/ok.txt', 'fine', 'out/ok.txt', 'fine'),
        { caseId: 'with-cwd', command: ['node', fixture, 'exit', '0'], cwd: 'nested', timeoutMs: 1000, assertions: [{ assertionId: 'w1', kind: 'file-exists', path: 'nested' }] },
      ],
    }
    const path = join(fixtureRoot(), 'acceptance.json')
    await writeFile(path, JSON.stringify(definition))
    expect(await loadAcceptance(path, config.experimentsRoot)).toEqual(definition.cases)
  })

  it('rejects a definition inside the experiments root', async () => {
    const { config, experimentsRoot } = await makeFixture()
    const inside = join(experimentsRoot, 'acceptance.json')
    await writeFile(inside, JSON.stringify({ cases: [] }))
    await expect(loadAcceptance(inside, config.experimentsRoot)).rejects.toThrow(
      expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
    )
    // The experiments root itself is inside by definition.
    await expect(loadAcceptance(experimentsRoot, config.experimentsRoot)).rejects.toThrow(
      expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
    )
  })

  it('rejects a definition reached through a symlink into the experiments root', async () => {
    const { config, experimentsRoot } = await makeFixture()
    const inside = join(experimentsRoot, 'wt', 'acceptance.json')
    await writeFile(inside, JSON.stringify({ cases: [] }))
    const link = join(fixtureRoot(), 'link.json')
    await symlink(inside, link)
    await expect(loadAcceptance(link, config.experimentsRoot)).rejects.toThrow(
      expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
    )
  })

  it('classifies the definition through the filesystem, not the spelling', async () => {
    const { experimentsRoot } = await makeFixture()
    // A definition outside the root reached through a symlinked directory
    // still loads: realpath resolves both sides to the same filesystem truth.
    const stable = join(fixtureRoot(), 'stable')
    await mkdir(stable)
    await writeFile(join(stable, 'acceptance.json'), JSON.stringify({ cases: [] }))
    await symlink(stable, join(fixtureRoot(), 'stable-link'))
    expect(await loadAcceptance(join(fixtureRoot(), 'stable-link', 'acceptance.json'), experimentsRoot)).toEqual([])
    await expect(loadAcceptance(join(stable, 'acceptance.json'), join(fixtureRoot(), 'no-such-root')))
      .rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' })
  })

  it('rejects an unreadable or malformed definition file', async () => {
    const { experimentsRoot } = await makeFixture()
    await expect(loadAcceptance(join(fixtureRoot(), 'missing.json'), experimentsRoot)).rejects.toThrow(
      expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
    )
    const malformed = join(fixtureRoot(), 'malformed.json')
    await writeFile(malformed, '{not json')
    await expect(loadAcceptance(malformed, experimentsRoot)).rejects.toThrow(
      expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
    )
    for (const payload of ['[]', '{"cases":3}', '{"cases":["nope"]}']) {
      await writeFile(malformed, payload)
      await expect(loadAcceptance(malformed, experimentsRoot)).rejects.toThrow(
        expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
      )
    }
  })

  it('rejects every case that violates the definition', async () => {
    const { config } = await makeFixture()
    const path = join(fixtureRoot(), 'acceptance.json')
    const command = ['node', fixture, 'exit', '0']
    const assertion = { assertionId: 'a1', kind: 'exit-code', expected: 0 }
    const invalid: readonly unknown[] = [
      'not-an-object',
      null,
      {},
      { caseId: '', command, timeoutMs: 10, assertions: [assertion] },
      { caseId: 'c', timeoutMs: 10, assertions: [assertion] },
      { caseId: 'c', command: [], timeoutMs: 10, assertions: [assertion] },
      { caseId: 'c', command: ['node', 3], timeoutMs: 10, assertions: [assertion] },
      { caseId: 'c', command, assertions: [assertion] },
      { caseId: 'c', command, timeoutMs: 1.5, assertions: [assertion] },
      { caseId: 'c', command, timeoutMs: 0, assertions: [assertion] },
      { caseId: 'c', command, timeoutMs: 10, assertions: [assertion], cwd: 5 },
      { caseId: 'c', command, timeoutMs: 10 },
      { caseId: 'c', command, timeoutMs: 10, assertions: [] },
      { caseId: 'c', command, timeoutMs: 10, assertions: ['nope'] },
      { caseId: 'c', command, timeoutMs: 10, assertions: [{ assertionId: '', kind: 'exit-code', expected: 0 }] },
      { caseId: 'c', command, timeoutMs: 10, assertions: [{ assertionId: 'a', kind: 'unheard-of' }] },
      { caseId: 'c', command, timeoutMs: 10, assertions: [{ assertionId: 'a', kind: 'exit-code' }] },
      { caseId: 'c', command, timeoutMs: 10, assertions: [{ assertionId: 'a', kind: 'exit-code', expected: 1.5 }] },
      { caseId: 'c', command, timeoutMs: 10, assertions: [{ assertionId: 'a', kind: 'stdout-includes' }] },
      { caseId: 'c', command, timeoutMs: 10, assertions: [{ assertionId: 'a', kind: 'file-exists' }] },
      { caseId: 'c', command, timeoutMs: 10, assertions: [{ assertionId: 'a', kind: 'file-exists', path: '' }] },
      { caseId: 'c', command, timeoutMs: 10, assertions: [{ assertionId: 'a', kind: 'file-includes', path: 'x' }] },
      { caseId: 'c', command, timeoutMs: 10, assertions: [{ assertionId: 'a', kind: 'file-includes', path: '', text: 'x' }] },
      { caseId: 'c', command, timeoutMs: 10, assertions: [{ assertionId: 'a', kind: 'file-includes', text: 'x' }] },
    ]
    for (const [index, payload] of invalid.entries()) {
      await writeFile(path, JSON.stringify({ cases: [payload] }))
      await expect(loadAcceptance(path, config.experimentsRoot), `invalid case at index ${index}`).rejects.toThrow(
        expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
      )
    }
  })
})

describe('checkAcceptanceCoversPlan', () => {
  const cases: readonly AcceptanceCase[] = [{
    caseId: 'build',
    command: ['node', fixture, 'exit', '0'],
    timeoutMs: 1000,
    assertions: [
      { assertionId: 'a1', kind: 'exit-code', expected: 0 },
      { assertionId: 'a2', kind: 'stdout-includes', text: 'ok' },
    ],
  }]

  it('accepts when every required case and assertion is defined', () => {
    expect(() => {
      checkAcceptanceCoversPlan(cases, planWith('build', ['a1', 'a2']))
    }).not.toThrow()
  })

  it('rejects a required case that has no definition', () => {
    expect(() => {
      checkAcceptanceCoversPlan(cases, planWith('missing', ['a1']))
    }).toThrow(
      expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
    )
  })

  it('rejects a required assertion that has no definition', () => {
    expect(() => {
      checkAcceptanceCoversPlan(cases, planWith('build', ['a1', 'a2', 'a3']))
    }).toThrow(
      expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
    )
  })
})

describe.skipIf(process.platform === 'win32')('runAcceptance', () => {
  it('does not spawn after cancellation during the final cwd check', async () => {
    const { config, worktree } = await makeFixture()
    const controller = new AbortController()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let observations = 0
    vi.mocked(realpath).mockImplementation(async (path) => {
      const result = await actual.realpath(path)
      if (++observations === 3) controller.abort()
      return result
    })
    const testCase = { ...exitCase('cancel', 0, 0), command: ['node', fixture, 'write', 'spawned', 'unsafe'], cwd: '.' }
    const result = await runAcceptance(config, { worktree, cases: [testCase], signal: controller.signal })
    expect(result.cancelled).toBe(true)
    expect(result.exitCode).not.toBe(0)
    await expect(readFile(join(worktree, 'spawned'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not restart escalation when cancellation follows the case deadline', async () => {
    const { config, worktree } = await makeFixture()
    const controller = new AbortController()
    const kill = vi.spyOn(process, 'kill')
    const testCase = { ...exitCase('stubborn', 0, 0), command: ['node', fixture, 'hang', '30000'], timeoutMs: 2000 }
    const pending = runAcceptance({ ...config, killGraceMs: 1000 }, { worktree, cases: [testCase], signal: controller.signal })
    await expect.poll(() => kill.mock.calls.some(([, signal]) => signal === 'SIGTERM'), { timeout: 10000 }).toBe(true)
    controller.abort()
    const result = await pending
    expect(result.timedOut).toBe(true)
    expect(result.cancelled).toBe(true)
    expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGTERM')).toHaveLength(1)
  }, 20_000)

  it('records pgidReused when the group signal answers EPERM after the case group exited', async () => {
    const { config, worktree } = await makeFixture()
    const killOriginal = process.kill.bind(process)
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      // The reassigned group refuses our signal; a plain pid probe stays real.
      if (pid < 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      return killOriginal(pid, signal)
    })
    const result = await runAcceptance(config, { worktree, cases: [exitCase('reused', 0, 0)], signal: new AbortController().signal })
    expect(result).toMatchObject({ exitCode: 0, cancelled: false })
    expect(result.pgidReused).toBe(true)
    // No signal may reach the group that now owns the reassigned pgid.
    expect(kill.mock.calls.filter(([pid]) => pid < 0).every(([, signal]) => signal === 0)).toBe(true)
  }, 20_000)

  it('fails file assertions when a command creates an outside ancestor link', async () => {
    const { config, worktree } = await makeFixture()
    const outside = join(fixtureRoot(), 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'canary.txt'), 'canary')
    const testCase = {
      ...fileCase('link', 'unused', '', 'escape/canary.txt', 'canary'),
      command: ['node', fixture, 'symlink', outside, 'escape'],
    }
    const result = await runAcceptance(config, { worktree, cases: [testCase], signal: new AbortController().signal })
    expect(result.cases[0]?.assertions.every(assertion => assertion.status === 'fail')).toBe(true)
    expect(result.exitCode).not.toBe(0)
  })

  it('fails a content assertion when the file cannot be read after its metadata check', async () => {
    const { config, worktree } = await makeFixture()
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    const result = await runAcceptance(config, { worktree, cases: [fileCase('denied', 'output', 'text', 'output', 'text')], signal: new AbortController().signal })
    expect(result.cases[0]?.assertions.map(assertion => assertion.status)).toEqual(['pass', 'fail'])
    expect(result.exitCode).not.toBe(0)
  })
  it('rejects assertion paths and cwd reached through an outside ancestor before spawning', async () => {
    const { config, worktree } = await makeFixture()
    const outside = join(fixtureRoot(), 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'canary.txt'), 'outside-canary')
    await symlink(outside, join(worktree, 'escape'))
    const testCase = fileCase('outside', 'spawned.txt', 'spawned', 'escape/canary.txt', 'outside-canary')
    await expect(runAcceptance(config, { worktree, cases: [testCase], signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' })
    await expect(readFile(join(worktree, 'spawned.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(runAcceptance(config, { worktree, cases: [{ ...exitCase('cwd', 0, 0), cwd: 'escape' }], signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' })
  })
  it('passes the four assertion kinds when a case holds', async () => {
    const { config, worktree } = await makeFixture()
    const run = await runAcceptance(config, {
      worktree,
      cases: [
        echoCase('echo-pass', 'all-good', 'all-good'),
        fileCase('file-pass', 'out/ok.txt', 'fine', 'out/ok.txt', 'fine'),
      ],
      signal: new AbortController().signal,
    })
    expect(run.cases.map(result => result.caseId)).toEqual(['echo-pass', 'file-pass'])
    expect(run.cases.flatMap(result => result.assertions.map(assertion => assertion.status))).toEqual([
      'pass', 'pass', 'pass', 'pass',
    ])
    expect(run).toMatchObject({ exitCode: 0, signal: null, timedOut: false, cancelled: false })
    expect(run.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('fails assertions the case output contradicts and keeps the first nonzero exit code', async () => {
    const { config, worktree } = await makeFixture()
    const run = await runAcceptance(config, {
      worktree,
      cases: [
        echoCase('echo-fail', 'wrong-text', 'expected-text'),
        exitCase('exit-fail', 2, 0),
        exitCase('exit-again', 3, 0),
        fileCase('file-fail', 'out/other.txt', 'other', 'out/missing.txt', 'nope'),
      ],
      signal: new AbortController().signal,
    })
    expect(run.cases.map(result => result.assertions.map(assertion => assertion.status))).toEqual([
      ['fail', 'pass'],
      ['fail'],
      ['fail'],
      ['fail', 'fail'],
    ])
    expect(run.exitCode).toBe(2)
    expect(run).toMatchObject({ signal: null, timedOut: false, cancelled: false })
  })

  it('runs a case in the worktree-relative working directory it names', async () => {
    const { config, worktree } = await makeFixture()
    await mkdir(join(worktree, 'nested'), { recursive: true })
    const run = await runAcceptance(config, {
      worktree,
      cases: [{
        caseId: 'nested',
        command: ['node', fixture, 'write', 'c.txt', 'in-nested'],
        cwd: 'nested',
        timeoutMs: 5000,
        assertions: [{ assertionId: 'n1', kind: 'file-includes', path: 'nested/c.txt', text: 'in-nested' }],
      }],
      signal: new AbortController().signal,
    })
    const nestedResult = run.cases[0]
    if (nestedResult === undefined) throw new Error('fixture missing case result')
    expect(nestedResult.assertions[0]?.status).toBe('pass')
  })

  it('runs bare node commands with the configured node binary, others verbatim', async () => {
    if (process.platform === 'win32') return // The proof uses a POSIX shell wrapper.
    const { config, worktree } = await makeFixture()
    const proof = join(fixtureRoot(), 'node-wrapper-proof')
    const wrapper = join(fixtureRoot(), 'fake-node.sh')
    await writeFile(wrapper, `#!/bin/sh\nprintf wrapped > '${proof}'\nexec '${process.execPath}' "$@"\n`)
    await chmod(wrapper, 0o755)
    const run = await runAcceptance({ ...config, nodeBinary: wrapper }, {
      worktree,
      cases: [
        echoCase('via-node', 'through-wrapper', 'through-wrapper'),
        { caseId: 'direct', command: [process.execPath, fixture, 'echo', 'verbatim'], timeoutMs: 5000, assertions: [{ assertionId: 'd1', kind: 'stdout-includes', text: 'verbatim' }] },
      ],
      signal: new AbortController().signal,
    })
    expect(await readFile(proof, 'utf8')).toBe('wrapped')
    expect(run.cases.flatMap(result => result.assertions.map(assertion => assertion.status))).toEqual(['pass', 'pass', 'pass'])
  })

  it('rejects a case whose cwd escapes the worktree', async () => {
    const { config, worktree } = await makeFixture()
    const cwdCase = (cwd: string): AcceptanceCase => ({
      caseId: 'cwd',
      command: ['node', fixture, 'exit', '0'],
      cwd,
      timeoutMs: 1000,
      assertions: [{ assertionId: 'c1', kind: 'exit-code', expected: 0 }],
    })
    const signal = new AbortController().signal
    await expect(runAcceptance(config, { worktree, cases: [cwdCase('../..')], signal })).rejects.toThrow(
      expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
    )
    await expect(runAcceptance(config, { worktree, cases: [cwdCase('nested/../../..')], signal })).rejects.toThrow(
      expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
    )
    await expect(runAcceptance(config, { worktree, cases: [cwdCase('/tmp')], signal })).rejects.toThrow(
      expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
    )
    // The worktree root itself is a valid cwd.
    await expect(runAcceptance(config, { worktree, cases: [cwdCase('./.')], signal })).resolves.toMatchObject({
      exitCode: 0,
    })
  })

  it('rejects file assertions whose symlink points outside the worktree', async () => {
    const { config, worktree } = await makeFixture()
    const outside = join(fixtureRoot(), 'outside.txt')
    await writeFile(outside, 'secret\n')
    await symlink(outside, join(worktree, 'link.txt'))
    await expect(runAcceptance(config, {
      worktree,
      cases: [{
        caseId: 'link',
        command: ['node', fixture, 'exit', '0'],
        timeoutMs: 5000,
        assertions: [
          { assertionId: 'l-exists', kind: 'file-exists', path: 'link.txt' },
          { assertionId: 'l-includes', kind: 'file-includes', path: 'link.txt', text: 'secret' },
        ],
      }],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' })
    // A plain worktree file still passes through the same lstat check.
    const plain = await runAcceptance(config, {
      worktree,
      cases: [fileCase('plain', 'out/ok.txt', 'fine', 'out/ok.txt', 'fine')],
      signal: new AbortController().signal,
    })
    expect(plain.cases.flatMap(result => result.assertions.map(assertion => assertion.status))).toEqual(['pass', 'pass'])
  })

  it('fails a file-includes assertion whose path is not a readable file', async () => {
    const { config, worktree } = await makeFixture()
    // The path exists (the lstat probe passes) but cannot be read as a file.
    await mkdir(join(worktree, 'out'), { recursive: true })
    const run = await runAcceptance(config, {
      worktree,
      cases: [{
        caseId: 'dir',
        command: ['node', fixture, 'exit', '0'],
        timeoutMs: 5000,
        assertions: [{ assertionId: 'd1', kind: 'file-includes', path: 'out', text: 'anything' }],
      }],
      signal: new AbortController().signal,
    })
    const dirResult = run.cases[0]
    if (dirResult === undefined) throw new Error('fixture missing case result')
    expect(dirResult.assertions).toEqual([{ assertionId: 'd1', status: 'fail' }])
  })

  it('fails every assertion when stdout exceeds the retention limit', async () => {
    const { config, worktree } = await makeFixture()
    const floodCase = (caseId: string, text: string | undefined, asserted: string): AcceptanceCase => ({
      caseId,
      command: text === undefined ? ['node', fixture, 'flood', '1200000'] : ['node', fixture, 'flood', '1200000', text],
      timeoutMs: 20000,
      assertions: [
        { assertionId: `${caseId}-stdout`, kind: 'stdout-includes', text: asserted },
        { assertionId: `${caseId}-exit`, kind: 'exit-code', expected: 0 },
      ],
    })
    const run = await runAcceptance(config, {
      worktree,
      cases: [
        floodCase('flood-early', 'early-needle', 'early-needle'),
        floodCase('flood-late', undefined, 'truncation-marker'),
      ],
      signal: new AbortController().signal,
    })
    expect(run.cases.map(result => result.assertions.map(assertion => assertion.status))).toEqual([
      ['fail', 'fail'],
      ['fail', 'fail'],
    ])
    expect(run.exitCode).not.toBe(0)
  })

  it('fails every assertion when a case exceeds its deadline', async () => {
    const { config, worktree } = await makeFixture()
    const pidPath = join(fixtureRoot(), 'case.pid')
    const run = await runAcceptance(config, {
      worktree,
      cases: [{
        caseId: 'slow',
        command: ['node', fixture, 'pidfile', pidPath, '10000'],
        timeoutMs: 400,
        assertions: [
          { assertionId: 's1', kind: 'exit-code', expected: 0 },
          { assertionId: 's2', kind: 'stdout-includes', text: 'x' },
        ],
      }],
      signal: new AbortController().signal,
    })
    casePids.push(Number(await readFile(pidPath, 'utf8')))
    const slowResult = run.cases[0]
    if (slowResult === undefined) throw new Error('fixture missing case result')
    expect(slowResult.assertions).toEqual([
      { assertionId: 's1', status: 'fail' },
      { assertionId: 's2', status: 'fail' },
    ])
    expect(run).toMatchObject({ exitCode: 1, timedOut: true, cancelled: false, signal: 'SIGTERM' })
    if (process.platform !== 'win32') {
      // The group teardown collected the fixture: its pid is no longer alive.
      const pid = casePids[0]
      if (pid === undefined) throw new Error('fixture missing recorded pid')
      expect(() => process.kill(pid, 0)).toThrow()
    }
  })

  it('escalates to SIGKILL when a case ignores SIGTERM', async () => {
    if (process.platform === 'win32') return // POSIX signal semantics carry the test.
    const { config, worktree } = await makeFixture()
    const run = await runAcceptance({ ...config, killGraceMs: 150 }, {
      worktree,
      cases: [{
        caseId: 'hang',
        command: ['node', fixture, 'hang', '10000'],
        timeoutMs: 300,
        assertions: [{ assertionId: 'h1', kind: 'exit-code', expected: 0 }],
      }],
      signal: new AbortController().signal,
    })
    expect(run).toMatchObject({ exitCode: 1, timedOut: true, signal: 'SIGKILL' })
  })

  it('fails every assertion when a case ends by a signal of its own', async () => {
    if (process.platform === 'win32') return // POSIX signal semantics carry the test.
    const { config, worktree } = await makeFixture()
    const run = await runAcceptance(config, {
      worktree,
      cases: [{
        caseId: 'crash',
        command: ['node', fixture, 'crash'],
        timeoutMs: 5000,
        assertions: [{ assertionId: 'c1', kind: 'exit-code', expected: 0 }],
      }],
      signal: new AbortController().signal,
    })
    const crashResult = run.cases[0]
    if (crashResult === undefined) throw new Error('fixture missing case result')
    expect(crashResult.assertions).toEqual([{ assertionId: 'c1', status: 'fail' }])
    expect(run).toMatchObject({ exitCode: 1, signal: 'SIGTERM', timedOut: false, cancelled: false })
  })

  it('kills the running case and skips the rest when the request signal aborts', async () => {
    const { config, worktree } = await makeFixture()
    const controller = new AbortController()
    const abortTimer = setTimeout(() => {
      controller.abort()
    }, 150)
    const run = await runAcceptance(config, {
      worktree,
      cases: [
        { caseId: 'long', command: ['node', fixture, 'sleep', '3000'], timeoutMs: 3000, assertions: [{ assertionId: 'l1', kind: 'exit-code', expected: 0 }] },
        exitCase('after', 0, 0),
      ],
      signal: controller.signal,
    })
    clearTimeout(abortTimer)
    expect(run.cases.map(result => result.caseId)).toEqual(['long', 'after'])
    expect(run.cases.flatMap(result => result.assertions.map(assertion => assertion.status))).toEqual(['fail', 'fail'])
    expect(run).toMatchObject({ exitCode: 1, cancelled: true, timedOut: false })
  })

  it('fails every assertion without spawning when the signal is already aborted', async () => {
    const { config, worktree } = await makeFixture()
    const controller = new AbortController()
    controller.abort()
    const run = await runAcceptance(config, {
      worktree,
      cases: [exitCase('skipped', 0, 0)],
      signal: controller.signal,
    })
    expect(run.cases).toEqual([{ caseId: 'skipped', assertions: [{ assertionId: 'skipped-exit', status: 'fail' }] }])
    expect(run).toMatchObject({ exitCode: 1, cancelled: true, timedOut: false, signal: null })
  })

  it('rejects a file assertion whose path escapes the worktree', async () => {
    const { config, worktree } = await makeFixture()
    const escape = (path: string): AcceptanceCase => ({
      caseId: 'escape',
      command: ['node', fixture, 'exit', '0'],
      timeoutMs: 1000,
      assertions: [{ assertionId: 'e1', kind: 'file-exists', path }],
    })
    const signal = new AbortController().signal
    await expect(runAcceptance(config, { worktree, cases: [escape('../outside.txt')], signal })).rejects.toThrow(
      expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
    )
    await expect(runAcceptance(config, { worktree, cases: [escape('a/../../outside.txt')], signal })).rejects.toThrow(
      expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
    )
    await expect(runAcceptance(config, { worktree, cases: [escape('/etc/passwd')], signal })).rejects.toThrow(
      expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }),
    )
  })

  it('rejects the run when a case command cannot spawn', async () => {
    const { config, worktree } = await makeFixture()
    await expect(runAcceptance({ ...config, nodeBinary: join(fixtureRoot(), 'no-such-node') }, {
      worktree,
      cases: [exitCase('unspawnable', 0, 0)],
      signal: new AbortController().signal,
    })).rejects.toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_EXECUTOR_FAILED' }))
  })

  it('rejects a case that names no command', async () => {
    const { config, worktree } = await makeFixture()
    await expect(runAcceptance(config, {
      worktree,
      cases: [{
        caseId: 'empty',
        command: [],
        timeoutMs: 1000,
        assertions: [{ assertionId: 'e1', kind: 'exit-code', expected: 0 }],
      }],
      signal: new AbortController().signal,
    })).rejects.toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_ACCEPTANCE_INVALID' }))
  })
})

/**
 * Reason printed on every skipped case below: `sandboxEffectivelyEnabled` and
 * `assertSandboxAvailable` read the real `process.platform` inside the
 * acceptor (they take no override, unlike their unit-tested counterparts in
 * `sandbox.spec.ts`), so only an actual darwin host ever wraps a case spawn.
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

describe.skipIf(process.platform === 'win32')('macOS sandbox wrapping', () => {
  itDarwinOnly('wraps a case spawn in sandbox-exec by default; the profile names the worktree, the data home, and only the configured deny-read root', async () => {
    const { config, worktree } = await makeFixture()
    const base = fixtureRoot()
    const log = join(base, 'sandbox-exec.log')
    const fakeSandboxExec = join(base, 'fake-sandbox-exec.sh')
    const denyRoot = join(base, 'deny-me')
    await mkdir(denyRoot, { recursive: true })
    await mkdir(config.dshHome, { recursive: true })
    // Records every argv on one line each, then execs the real command
    // (skipping the leading `-p <profile>` this fake was invoked with) so the
    // wrapped case still actually runs.
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
    const run = await runAcceptance(sandboxed, {
      worktree,
      cases: [echoCase('e', 'hi', 'hi')],
      signal: new AbortController().signal,
    })
    expect(run.exitCode).toBe(0)
    const lines = (await readFile(log, 'utf8')).split('\n')
    expect(lines[0]).toBe('-p')
    const profile = lines[1] ?? ''
    expect(profile).toContain(await realpath(worktree))
    expect(profile).toContain(await realpath(config.dshHome))
    const denyForms = profile.match(/\(deny file-read\* \(subpath [^)]*\)\)/g) ?? []
    expect(denyForms).toEqual([`(deny file-read* (subpath ${JSON.stringify(await realpath(denyRoot))}))`])
  }, 20_000)

  itDarwinOnly('does not wrap the case spawn when sandbox.enabled is false', async () => {
    const { config, worktree } = await makeFixture()
    const base = fixtureRoot()
    const log = join(base, 'sandbox-exec.log')
    const fakeSandboxExec = join(base, 'fake-sandbox-exec.sh')
    await writeFakeSandboxExec(fakeSandboxExec, `#!/bin/sh\n: > '${log}'\nexit 0\n`)
    const disabled: RunnerConfig = {
      ...config,
      sandbox: { enabled: false, denyReadRoots: [], extraWritableRoots: [], sandboxExec: fakeSandboxExec },
    }
    const run = await runAcceptance(disabled, {
      worktree,
      cases: [echoCase('e', 'hi', 'hi')],
      signal: new AbortController().signal,
    })
    expect(run.exitCode).toBe(0)
    // The fake sandbox-exec was never invoked at all: the plain unwrapped
    // spawn ran the case command directly.
    await expect(readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  }, 20_000)

  itDarwinOnly('rejects with the executor error code when sandbox-exec cannot launch the case command at all', async () => {
    const { config, worktree } = await makeFixture()
    const fakeSandboxExec = join(fixtureRoot(), 'fake-sandbox-exec-launch-fail.sh')
    // Succeeds only for the probe's own `/usr/bin/true` invocation; any other
    // program (the real case spawn below) gets sandbox-exec's own
    // launch-failure stderr signature instead of ever running.
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
    await expect(runAcceptance(sandboxed, {
      worktree,
      cases: [exitCase('c', 0, 0)],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_EXECUTOR_FAILED' })
  }, 20_000)

  itDarwinOnly('rejects with SELF_DEV_RUNNER_SANDBOX_UNAVAILABLE before spawning any case when the probe fails', async () => {
    const { config, worktree } = await makeFixture()
    const fakeSandboxExec = join(fixtureRoot(), 'fake-sandbox-exec-probe-fail.sh')
    await writeFakeSandboxExec(fakeSandboxExec, '#!/bin/sh\nexit 9\n')
    const sandboxed: RunnerConfig = {
      ...config,
      sandbox: { enabled: true, denyReadRoots: [], extraWritableRoots: [], sandboxExec: fakeSandboxExec },
    }
    await expect(runAcceptance(sandboxed, {
      worktree,
      cases: [exitCase('c', 0, 0)],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_SANDBOX_UNAVAILABLE' })
  }, 20_000)

  itDarwinOnly('tears down immediately when cancellation fires while the sandbox probe is still in flight', async () => {
    // Real sandbox-exec: spawning it for the probe genuinely crosses the
    // event loop, so a synchronous abort() right after the call below lands
    // in the gap between runCase's first await and its 'abort' listener
    // registration — the exact race `if (signal.aborted) onAbort()`
    // (acceptor.ts) closes.
    const { config, worktree } = await makeFixture()
    const sandboxed: RunnerConfig = {
      ...config,
      sandbox: { enabled: true, denyReadRoots: [], extraWritableRoots: [], sandboxExec: '/usr/bin/sandbox-exec' },
    }
    const controller = new AbortController()
    const pending = runAcceptance(sandboxed, {
      worktree,
      cases: [{
        caseId: 'hang',
        command: ['node', fixture, 'hang', '5000'],
        timeoutMs: 5000,
        assertions: [{ assertionId: 'h1', kind: 'exit-code', expected: 0 }],
      }],
      signal: controller.signal,
    })
    controller.abort()
    const run = await pending
    expect(run.cancelled).toBe(true)
  }, 20_000)

  // Not darwin-gated: sandboxing is disabled here, so this exercises the
  // ordinary unwrapped `spawn()` 'error' event on every platform — the same
  // path the suite relied on before sandboxing existed, which a bad
  // nodeBinary no longer reaches by default now that sandbox-exec itself (not
  // the missing binary) is what spawn() launches on darwin.
  it('rejects with the executor error code through the plain spawn error path when sandboxing is disabled', async () => {
    const { config, worktree } = await makeFixture()
    const disabled: RunnerConfig = {
      ...config,
      nodeBinary: join(fixtureRoot(), 'no-such-node'),
      sandbox: { enabled: false, denyReadRoots: [], extraWritableRoots: [], sandboxExec: '/usr/bin/sandbox-exec' },
    }
    await expect(runAcceptance(disabled, {
      worktree,
      cases: [exitCase('unspawnable', 0, 0)],
      signal: new AbortController().signal,
    })).rejects.toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_EXECUTOR_FAILED' }))
  }, 20_000)
})
