/**
 * Unit behavior of the trial-manager support modules: port probing and
 * allocation, sidecar storage, build-command resolution and execution, web
 * readiness capture and token redaction, and process-group teardown. Real
 * child processes run from temporary directories only.
 * @module units.spec
 */

import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { spawnWebProcess, redactToken, READY_URL_PATTERN, WEB_ARGV_PREFIX } from '../src/web-process.ts'
import { runBuild, resolveBuildCommand, statIsFile, worktreePnpmPath, corepackPath, BUILD_ARGV } from '../src/build.ts'
import { signalGroup, stopProcessGroup, waitForExit, TERM_GRACE_MS, KILL_WAIT_MS } from '../src/process-group.ts'
import {
  appendTrialLog,
  removeTrialRecord,
  trialLogPath,
  trialRecordPath,
  TRIAL_RECORD_FILE_MODE,
  writeTrialRecord,
} from '../src/registry.ts'
import { allocatePort, isPortFree } from '../src/ports.ts'
import { SelfDevelopmentTrialError, errorText } from '../src/errors.ts'
import type { TrialRecord } from '../src/types.ts'

let base: string | undefined

afterEach(async () => {
  if (base !== undefined) await rm(base, { recursive: true, force: true })
  base = undefined
  vi.restoreAllMocks()
})

async function makeBase(): Promise<string> {
  base = await mkdtemp(join(tmpdir(), 'dsh-trial-unit-'))
  return base
}

/** A record for sidecar tests. */
function record(taskId: string): TrialRecord {
  return {
    version: 1,
    taskId,
    url: 'http://127.0.0.1:4000/?token=abc',
    port: 4000,
    pid: 4242,
    startedAt: 7,
    worktree: '/tmp/wt',
    dshHome: '/tmp/home',
  }
}

describe('token redaction', () => {
  it('redacts token query values and keeps every other byte', () => {
    expect(redactToken('dsh web: http://127.0.0.1:4000/?token=abc'))
      .toBe('dsh web: http://127.0.0.1:4000/?token=<redacted>')
    // A bare `token=` not in query-string position (no leading `?`/`&`) is
    // left alone by design: redaction targets query values, not free text.
    expect(redactToken('url http://x/y?token=secre&t=1 and "token=quoted"'))
      .toBe('url http://x/y?token=<redacted>&t=1 and "token=quoted"')
    expect(redactToken('plain output without tokens')).toBe('plain output without tokens')
  })

  it('keeps the readiness pattern and argv prefix fixed', () => {
    expect(READY_URL_PATTERN.exec('boot ok\ndsh web: http://127.0.0.1:4000/?token=abc')?.[1])
      .toBe('http://127.0.0.1:4000/?token=abc')
    expect(WEB_ARGV_PREFIX).toEqual(['apps/cli/lib/bin.js', 'web', '--host', '127.0.0.1'])
  })
})

describe('port allocation', () => {
  it('reports bound ports as occupied and frees them after close', async () => {
    const { createServer } = await import('node:net')
    const blocker = createServer()
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () =>{  resolve((blocker.address() as { port: number }).port) })
    })
    expect(await isPortFree(port)).toBe(false)
    await new Promise<void>((resolve) => { blocker.close(() =>{  resolve() }) })
    expect(await isPortFree(port)).toBe(true)
  })

  it('allocates the first free port, skips taken ones, and refuses an exhausted range', async () => {
    const { createServer } = await import('node:net')
    const free = await allocatePort(30000, 30010, new Set())
    expect(free).toBeGreaterThanOrEqual(30000)
    const skipped = await allocatePort(free, free + 1, new Set([free]))
    expect(skipped).toBe(free + 1)
    const blocker = createServer()
    const occupied = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () =>{  resolve((blocker.address() as { port: number }).port) })
    })
    try {
      await expect(allocatePort(occupied, occupied, new Set()))
        .rejects.toMatchObject({ code: 'self-development/trial-port-exhausted' })
    } finally {
      await new Promise<void>((resolve) => { blocker.close(() =>{  resolve() }) })
    }
  })
})

describe('sidecar storage', () => {
  it('writes the record atomically with 0600 and the directory with 0700', async () => {
    const root = await makeBase()
    const control = join(root, 'control')
    await writeTrialRecord(control, 'task-store', record('task-store'))
    const stored = JSON.parse(await readFile(trialRecordPath(control, 'task-store'), 'utf8')) as TrialRecord
    expect(stored).toEqual(record('task-store'))
    const file = await stat(trialRecordPath(control, 'task-store'))
    expect(file.mode & 0o777).toBe(TRIAL_RECORD_FILE_MODE)
    const directory = await stat(join(control, 'trials'))
    expect(directory.mode & 0o777).toBe(0o700)
  })

  it('overwrites an existing record and removes it, tolerating a missing file', async () => {
    const root = await makeBase()
    const control = join(root, 'control')
    await writeTrialRecord(control, 'task-rm', record('task-rm'))
    await writeTrialRecord(control, 'task-rm', { ...record('task-rm'), port: 4001 })
    expect(JSON.parse(await readFile(trialRecordPath(control, 'task-rm'), 'utf8')) as TrialRecord).toMatchObject({ port: 4001 })
    await removeTrialRecord(control, 'task-rm')
    await expect(removeTrialRecord(control, 'task-rm')).resolves.toBeUndefined()
    await expect(removeTrialRecord(control, 'task-rm')).resolves.toBeUndefined()
  })

  it('raises a removal error other than a missing file', async () => {
    const root = await makeBase()
    const control = join(root, 'control')
    await mkdir(join(control, 'trials'), { recursive: true })
    await mkdir(trialRecordPath(control, 'task-dir'))
    await expect(removeTrialRecord(control, 'task-dir')).rejects.toThrow()
  })

  it('appends log lines and normalizes the trailing newline', async () => {
    const root = await makeBase()
    const control = join(root, 'control')
    await appendTrialLog(control, 'task-log', 'first\n')
    await appendTrialLog(control, 'task-log', 'second')
    expect(await readFile(trialLogPath(control, 'task-log'), 'utf8')).toBe('first\nsecond\n')
  })
})

describe('build command resolution', () => {
  it('prefers the worktree pnpm and falls back to the node-sibling corepack', async () => {
    const root = await makeBase()
    const pnpm = worktreePnpmPath(root)
    expect(pnpm).toBe(join(root, 'node_modules', '.bin', 'pnpm'))
    expect(BUILD_ARGV).toEqual(['run', '--silent', 'build'])
    await expect(resolveBuildCommand(root, '/bin/node', async () => false))
      .rejects.toMatchObject({ code: 'self-development/trial-build-failed' })
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
    await writeFile(pnpm, '#!/bin/sh\n')
    await chmod(pnpm, 0o755)
    expect(await resolveBuildCommand(root, '/bin/node')).toEqual([pnpm, ...BUILD_ARGV])
    const withCorepack = join(root, 'with-corepack')
    await mkdir(withCorepack, { recursive: true })
    const corepack = corepackPath(join(withCorepack, 'node'))
    expect(corepack).toBe(join(withCorepack, 'corepack'))
    await writeFile(corepack, '#!/bin/sh\n')
    await chmod(corepack, 0o755)
    expect(await resolveBuildCommand(withCorepack, join(withCorepack, 'node'), statIsFile))
      .toEqual([corepack, 'pnpm', ...BUILD_ARGV])
  })

  it('probes file existence fail-closed', async () => {
    const root = await makeBase()
    expect(await statIsFile(join(root, 'absent'))).toBe(false)
    expect(await statIsFile(root)).toBe(false)
    const file = join(root, 'file')
    await writeFile(file, 'x\n')
    expect(await statIsFile(file)).toBe(true)
  })
})

describe('runBuild', () => {
  it('streams stdout and stderr and resolves on exit zero', async () => {
    const root = await makeBase()
    const chunks: string[] = []
    await runBuild(
      root,
      [process.execPath, '-e', 'console.log("built"); console.error("warned")'],
      process.execPath,
      10_000,
      (chunk) => { chunks.push(chunk) },
    )
    expect(chunks.join('')).toContain('built')
    expect(chunks.join('')).toContain('warned')
  })

  it('rejects on a nonzero exit and on a signal death', async () => {
    const root = await makeBase()
    await expect(runBuild(root, [process.execPath, '-e', 'process.exit(2)'], process.execPath, 10_000, () => {}))
      .rejects.toThrow(/failed with code 2/)
    await expect(runBuild(root, [process.execPath, '-e', 'process.kill(process.pid, "SIGKILL")'], process.execPath, 10_000, () => {}))
      .rejects.toThrow(/failed with signal SIGKILL/)
  })

  it('rejects when the build command cannot spawn', async () => {
    const root = await makeBase()
    await expect(runBuild(root, [join(root, 'absent-binary')], process.execPath, 10_000, () => {}))
      .rejects.toMatchObject({ code: 'self-development/trial-build-failed' })
  })

  it('rejects an empty build command before spawning anything', async () => {
    const root = await makeBase()
    await expect(runBuild(root, [], process.execPath, 10_000, () => {}))
      .rejects.toMatchObject({ code: 'self-development/trial-build-failed' })
  })

  it('stops the group and rejects when the deadline passes', async () => {
    const root = await makeBase()
    await expect(runBuild(
      root,
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      process.execPath,
      150,
      () => {},
    )).rejects.toThrow(/timed out after 150 ms/)
  })
})

describe('spawnWebProcess', () => {
  it('resolves the readiness URL and redacts the token in the output sink', async () => {
    const root = await makeBase()
    const bin = join(root, 'apps', 'cli', 'lib', 'bin.js')
    await mkdir(join(root, 'apps', 'cli', 'lib'), { recursive: true })
    await writeFile(bin, [
      'console.log(\'dsh web: http://127.0.0.1:4000/?token=abc\')',
      'process.on(\'SIGTERM\', () => process.exit(0))',
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const chunks: string[] = []
    const spawned = spawnWebProcess({
      nodeBinary: process.execPath,
      worktree: root,
      port: 4000,
      dshHome: join(root, 'home'),
      readyTimeoutMs: 10_000,
      onOutput: (chunk) => { chunks.push(chunk) },
    })
    const url = await spawned.url
    expect(url).toBe('http://127.0.0.1:4000/?token=abc')
    expect(chunks.join('')).not.toContain('token=abc')
    spawned.child.kill('SIGTERM')
    await spawned.exited
  })

  it('rejects when the process exits early or cannot spawn', async () => {
    const root = await makeBase()
    const silent = spawnWebProcess({
      nodeBinary: process.execPath,
      worktree: root,
      port: 4001,
      dshHome: root,
      readyTimeoutMs: 10_000,
      onOutput: () => {},
    })
    await expect(silent.url).rejects.toThrow(/exited before printing/)
    const missing = spawnWebProcess({
      nodeBinary: join(root, 'absent-node'),
      worktree: root,
      port: 4002,
      dshHome: root,
      readyTimeoutMs: 10_000,
      onOutput: () => {},
    })
    await expect(missing.url).rejects.toThrow(/could not spawn/)
  })

  it('rejects when the readiness deadline passes with the process still up', async () => {
    const root = await makeBase()
    const bin = join(root, 'apps', 'cli', 'lib', 'bin.js')
    await mkdir(join(root, 'apps', 'cli', 'lib'), { recursive: true })
    // Stays up and prints only a non-matching line, so the only way `url`
    // can settle is the readiness deadline itself.
    await writeFile(bin, [
      'console.log(\'booting, no readiness line here\')',
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const spawned = spawnWebProcess({
      nodeBinary: process.execPath,
      worktree: root,
      port: 4003,
      dshHome: root,
      readyTimeoutMs: 50,
      onOutput: () => {},
    })
    try {
      await expect(spawned.url).rejects.toThrow(/no readiness line within 50 ms/)
    } finally {
      spawned.child.kill('SIGKILL')
    }
  })
})

describe('error text and codes', () => {
  it('renders errors and non-error rejections alike', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain')).toBe('plain')
    expect(errorText(42)).toBe('42')
  })

  it('raises RemoteError refusals with a machine-routable code', () => {
    const error = new SelfDevelopmentTrialError('self-development/trial-start-failed', 'no')
    expect(error).toBeInstanceOf(RemoteError)
    expect(error.code).toBe('self-development/trial-start-failed')
    expect(error.name).toBe('SelfDevelopmentTrialError')
  })
})

describe('process-group teardown', () => {
  it('signals by group id and treats an already-gone group as done', async () => {
    const dead = 2 ** 24
    expect(() =>{  signalGroup(dead, 'SIGTERM') }).not.toThrow()
    expect(() =>{  signalGroup(dead, 'SIGKILL') }).not.toThrow()
  })

  it('raises a refused group signal', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    })
    expect(() =>{  signalGroup(4242, 'SIGTERM') }).toThrow(/refused SIGTERM/)
  })

  it('waits a bounded time for the caller exit observation', async () => {
    await expect(waitForExit(Promise.resolve(), 100)).resolves.toBe(true)
    await expect(waitForExit(new Promise<void>(() => {}), 20)).resolves.toBe(false)
  })

  it('stops a cooperative group on SIGTERM', async () => {
    const root = await makeBase()
    const child = await spawnSleeper(root)
    await stopProcessGroup(child.pid, child.exited, 200, 200)
    await child.exited
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const root = await makeBase()
    const child = await spawnSleeper(root, true)
    const stopped = stopProcessGroup(child.pid, child.exited, 150, 2000)
    await stopped
    await child.exited
  })

  it('confirms exit once SIGKILL lands, deterministically', async () => {
    // A real ignore-SIGTERM child reaches the same branch (the test above),
    // but its timing against the grace window isn't guaranteed, so the
    // "SIGKILL actually confirmed the exit" branch gets a mocked, exact
    // repro too: exited resolves only once the SIGKILL signal is observed.
    let resolveExited: () => void = () => {}
    const exited = new Promise<void>((resolve) => { resolveExited = resolve })
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') resolveExited()
      return true
    })
    await stopProcessGroup(4242, exited, 10, 2000)
    expect(kill.mock.calls.map(call => call[1])).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('rejects when exit is never confirmed', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true)
    await expect(stopProcessGroup(4242, new Promise<void>(() => {}), 10, 10))
      .rejects.toMatchObject({ code: 'self-development/trial-stop-failed' })
    expect(TERM_GRACE_MS).toBe(5000)
    expect(KILL_WAIT_MS).toBe(5000)
  })

  it('rejects when the group signal is refused', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    })
    await expect(stopProcessGroup(4242, new Promise<void>(() => {}), 10, 10))
      .rejects.toMatchObject({ code: 'self-development/trial-stop-failed' })
  })
})

/** Spawn one detached node sleeper under its own process group. */
function spawnSleeper(root: string, ignoreTerm = false): Promise<{ pid: number; exited: Promise<void> }> {
  const script = ignoreTerm
    ? 'process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)'
    : 'process.on(\'SIGTERM\', () => process.exit(0)); setInterval(() => {}, 1000)'
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: root, detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      resolve({ pid: child.pid!, exited: new Promise((done) => { child.once('exit', () => { done() }) }) })
    })
  })
}
