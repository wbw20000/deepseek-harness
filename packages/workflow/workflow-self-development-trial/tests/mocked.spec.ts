/**
 * Branches of the spawn-driven modules that a real process tree cannot
 * reach: children without standard streams or a process id, the failed-open
 * teardown paths, and the forget bookkeeping after an unobserved exit.
 *
 * `node:child_process`'s `spawn`, `./process-group.ts`'s `stopProcessGroup`,
 * and `./web-process.ts`'s `spawnWebProcess` are each replaced with a mock
 * that delegates to the real implementation by default. A test that needs
 * direct control sets a one-shot override (`spawnControl.next` for the next
 * `spawn` call) or an explicit `vi.fn()` configuration (`stopMock`,
 * `spawnWebMock`); everything else keeps running for real, which is how the
 * `openTrial teardown bookkeeping` tests still drive a genuine build through
 * a fake `pnpm` while only the web-process step is faked.
 * @module mocked.spec
 */

import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ChildProcess } from 'node:child_process'
import { runBuild } from '../src/build.ts'
import { spawnWebProcess } from '../src/web-process.ts'
import { stopProcessGroup } from '../src/process-group.ts'
import SelfDevelopmentTrial from '../src/index.ts'
import { SelfDevelopmentTrialError } from '../src/errors.ts'
import { trialLogPath, trialRecordPath } from '../src/registry.ts'
import { expectOpened, makeWorktree } from './helpers.ts'
import type { TrialRecord } from '../src/types.ts'

/**
 * The configured answer of the mocked `spawn` for its next call only, and
 * the real `spawn` underneath. Setting `next` fakes exactly one upcoming
 * spawn (consumed and cleared on use); every other call falls through to
 * `actual`, which is how the build step keeps spawning a real fake-`pnpm`
 * process even inside this file's `openTrial` tests.
 */
const spawnControl = vi.hoisted(() => ({
  next: undefined as unknown as ChildProcess | undefined,
  actual: undefined as unknown as (...args: unknown[]) => ChildProcess,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  spawnControl.actual = actual.spawn as unknown as (...args: unknown[]) => ChildProcess
  return {
    ...actual,
    spawn: (...args: unknown[]): ChildProcess => {
      if (spawnControl.next !== undefined) {
        const child = spawnControl.next
        spawnControl.next = undefined
        return child
      }
      return spawnControl.actual(...args)
    },
  }
})

/** The real `stopProcessGroup`, for the one test that drives it through a mocked `process.kill`. */
const processGroupControl = vi.hoisted(() => ({
  actual: undefined as unknown as (typeof import('../src/process-group.ts'))['stopProcessGroup'],
}))

vi.mock('../src/process-group.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/process-group.ts')>()
  processGroupControl.actual = actual.stopProcessGroup
  return { ...actual, stopProcessGroup: vi.fn() }
})

vi.mock('../src/web-process.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/web-process.ts')>()
  return {
    ...actual,
    spawnWebProcess: vi.fn((options: Parameters<typeof actual.spawnWebProcess>[0]) => actual.spawnWebProcess(options)),
  }
})

const stopMock = vi.mocked(stopProcessGroup)
const spawnWebMock = vi.mocked(spawnWebProcess)

let base: string | undefined
let context: Context | undefined

beforeEach(() => {
  stopMock.mockResolvedValue(undefined)
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (base !== undefined) await rm(base, { recursive: true, force: true })
  base = undefined
  spawnControl.next = undefined
  vi.clearAllMocks()
})

/**
 * A child double with the given pid and standard streams. `ChildProcess`'s
 * pid/stdout/stderr/exitCode fields are declared readonly on the real type,
 * so the double is assembled through `Object.assign` rather than sequential
 * property writes — the double is a plain EventEmitter underneath, not an
 * actual `Readable`, hence the trailing cast.
 */
function childDouble(options: { pid?: number; streams?: boolean; exitCode?: number | null } = {}): ChildProcess {
  const streams = options.streams ?? true
  return Object.assign(new EventEmitter(), {
    ...(options.pid === undefined ? {} : { pid: options.pid }),
    stdout: streams ? new EventEmitter() : null,
    stderr: streams ? new EventEmitter() : null,
    exitCode: options.exitCode ?? null,
  }) as unknown as ChildProcess
}

/** A worktree whose build resolves through the real build module. */
async function buildableWorktree(name: string): Promise<string> {
  base = await mkdtemp(join(tmpdir(), 'dsh-trial-mock-'))
  const worktree = await makeWorktree(base, name)
  await writeFile(join(worktree.root, 'node_modules', '.bin', 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return worktree.root
}

/** A never-settling exit observation. */
function never(): Promise<void> {
  return new Promise<void>(() => {})
}

describe('web-process against a streamless child', () => {
  it('reports the spawn refusal without touching the missing streams', async () => {
    const child = childDouble({ streams: false })
    spawnControl.next = child
    const spawned = spawnWebProcess({
      nodeBinary: '/bin/node',
      worktree: '/tmp/wt',
      port: 4000,
      dshHome: '/tmp/home',
      readyTimeoutMs: 1000,
      onOutput: () => {},
    })
    child.emit('error', new Error('denied'))
    await expect(spawned.url).rejects.toThrow(/could not spawn/)
  })

  it('settles once and ignores later failures', async () => {
    const child = childDouble({ streams: false })
    spawnControl.next = child
    const spawned = spawnWebProcess({
      nodeBinary: '/bin/node',
      worktree: '/tmp/wt',
      port: 4000,
      dshHome: '/tmp/home',
      readyTimeoutMs: 1000,
      onOutput: () => {},
    })
    const settled = spawned.url
    child.emit('error', new Error('denied'))
    // 'error' is a once-listener (consuming itself, per Node's EventEmitter
    // semantics for that event), so a later ignored event has to be a kind
    // that doesn't crash the process when unlistened; 'exit' still hits the
    // settled guard below without that hazard.
    child.emit('exit', 1)
    await expect(settled).rejects.toThrow(/could not spawn/)
  })
})

describe('runBuild against a childless spawn', () => {
  it('rejects the deadline with nothing to stop when the child has no pid', async () => {
    spawnControl.next = childDouble({ streams: false })
    await expect(runBuild('/tmp/wt', ['/bin/pnpm', 'run', 'build'], '/bin/node', 20, () => {}))
      .rejects.toThrow(/timed out after 20 ms/)
  })

  it('reports the stop refusal when the deadline teardown fails', async () => {
    const child = childDouble({ streams: false, pid: 4242 })
    spawnControl.next = child
    // This test wants the real signalGroup/process.kill chain, not the
    // beforeEach's resolved-undefined stub, so it can watch the mocked
    // process.kill's EPERM surface through runBuild's timeout path.
    stopMock.mockImplementation(processGroupControl.actual)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    })
    await expect(runBuild('/tmp/wt', ['/bin/pnpm', 'run', 'build'], '/bin/node', 20, () => {}))
      .rejects.toThrow(/refused SIGTERM/)
    expect(kill).toHaveBeenCalled()
  })
})

describe('openTrial teardown bookkeeping', () => {
  /** Boot one manager whose facade read points at `worktree`. */
  async function makeService(worktree: string): Promise<{ service: SelfDevelopmentTrial; control: string }> {
    base = base ?? await mkdtemp(join(tmpdir(), 'dsh-trial-mock-'))
    context = new Context()
    const control = join(base, 'control')
    const service = new SelfDevelopmentTrial(context, {
      nodeBinary: '/bin/node',
      controlDirectory: control,
      portRange: [21000, 21010],
      buildTimeoutMs: 10_000,
      readyTimeoutMs: 10_000,
      autoOpen: false,
    }, {
      getTask: async () => ({ card: { launchProfile: { worktree, dataHome: join(base!, 'home') } } }),
      // Empty, not the real host PATH: these tests exercise buildableWorktree's
      // own fake node_modules/.bin/pnpm, which the new PATH-first resolution
      // order would otherwise shadow if the test host happens to have a real
      // pnpm on PATH.
      pathEnv: '',
    })
    return { service, control }
  }

  it('tears the web process down and records nothing when the pid is missing', async () => {
    const worktree = await buildableWorktree('no-pid')
    const { service, control } = await makeService(worktree)
    spawnWebMock.mockReturnValue({
      child: childDouble({ streams: false }),
      exited: never(),
      url: Promise.resolve('http://127.0.0.1:4000/?token=abc'),
    })
    await expect(service.openTrial('task-no-pid'))
      .rejects.toMatchObject({ code: 'self-development/trial-start-failed' })
    expect(stopMock).not.toHaveBeenCalled()
    // discard() returns before logging anything when the pid is missing, so
    // no log file is ever created for this task.
    await expect(readFile(trialLogPath(control, 'task-no-pid'), 'utf8')).rejects.toThrow()
  })

  it('stops the group after a failed ready and logs the stop', async () => {
    const worktree = await buildableWorktree('failed-ready')
    const { service, control } = await makeService(worktree)
    const child = childDouble({ pid: 4242 })
    // A lazy implementation, not an eagerly-constructed rejected promise: the
    // rejection must not exist until openTrial is actually about to await
    // it, or Node can flag it unhandled during the build/port-allocation
    // steps that run first. The real spawnWebProcess always rejects with a
    // SelfDevelopmentTrialError, so the double matches that shape too.
    spawnWebMock.mockImplementation(() => ({
      child,
      exited: never(),
      url: Promise.reject(new SelfDevelopmentTrialError('self-development/trial-start-failed', 'never ready')),
    }))
    await expect(service.openTrial('task-failed-ready'))
      .rejects.toMatchObject({ code: 'self-development/trial-start-failed' })
    expect(stopMock).toHaveBeenCalledWith(4242, expect.any(Promise))
    const log = await import('node:fs/promises').then(fs => fs.readFile(trialLogPath(control, 'task-failed-ready'), 'utf8'))
    expect(log).toContain('trial open failed; the web process was stopped')
  })

  it('logs a teardown failure after a failed open without losing the original error', async () => {
    const worktree = await buildableWorktree('stop-refused')
    const { service } = await makeService(worktree)
    spawnWebMock.mockImplementation(() => ({
      child: childDouble({ pid: 4242 }),
      exited: never(),
      url: Promise.reject(new SelfDevelopmentTrialError('self-development/trial-start-failed', 'never ready')),
    }))
    stopMock.mockRejectedValue(new Error('stop refused'))
    await expect(service.openTrial('task-stop-refused'))
      .rejects.toMatchObject({ code: 'self-development/trial-start-failed' })
  })

  it('registers an instance with a mocked leader and forgets only the matching child', async () => {
    const worktree = await buildableWorktree('forget')
    const { service, control } = await makeService(worktree)
    const url = 'http://127.0.0.1:4000/?token=abc'
    const child = childDouble({ pid: 7777 })
    spawnWebMock.mockReturnValue({ child, exited: never(), url: Promise.resolve(url) })
    const opened = expectOpened(await service.openTrial('task-forget'))
    expect(opened).toMatchObject({ url, pid: 7777 })
    // The mocked web process ignores the allocated port argument, so the
    // record's port is whatever the real allocatePort assigned — read back
    // from the open result rather than assumed.
    const stored = JSON.parse(await readFile(trialRecordPath(control, 'task-forget'), 'utf8')) as TrialRecord
    expect(stored).toMatchObject({
      version: 1,
      taskId: 'task-forget',
      url,
      port: opened.port,
      pid: 7777,
      worktree,
      dshHome: join(base!, 'home'),
    })
    expect(stored.startedAt).toEqual(expect.any(Number))

    const internals = service as unknown as {
      forget: (taskId: string, child: ChildProcess) => Promise<void>
      instances: Map<string, { record: TrialRecord; child: ChildProcess; exited: Promise<void> }>
    }
    // A different child never removes the registration.
    await internals.forget('task-forget', childDouble({ pid: 1 }))
    expect(internals.instances.has('task-forget')).toBe(true)
    // An unknown task is a no-op.
    await internals.forget('task-absent', child)
    // The registered child removes it and its sidecar.
    await internals.forget('task-forget', child)
    expect(internals.instances.has('task-forget')).toBe(false)
    await expect(readFile(trialRecordPath(control, 'task-forget'), 'utf8')).rejects.toThrow()
  })

  it('closes a mocked instance through the registered pid', async () => {
    const worktree = await buildableWorktree('close-mock')
    const { service } = await makeService(worktree)
    spawnWebMock.mockReturnValue({
      child: childDouble({ pid: 8888 }),
      exited: Promise.resolve(),
      url: Promise.resolve('http://127.0.0.1:4000/?token=abc'),
    })
    await expect(service.openTrial('task-close-mock')).resolves.toMatchObject({ pid: 8888 })
    stopMock.mockClear()
    await expect(service.closeTrial('task-close-mock')).resolves.toBeUndefined()
    expect(stopMock).toHaveBeenCalledWith(8888, expect.any(Promise))
  })
})
