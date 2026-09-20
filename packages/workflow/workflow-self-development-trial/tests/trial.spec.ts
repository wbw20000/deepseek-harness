/**
 * Trial-manager service behavior against fake processes: open, repeat open,
 * close, disposal, the non-DSH refusal, build failures and the deadline,
 * port exhaustion, the self-exit forget, host-only refusals, and the
 * `campaign-passed` auto open. Real child processes run from temporary
 * directories only.
 * @module trial.spec
 */

import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import SelfDevelopmentTrial from '../src/index.ts'
import { trialLogPath, trialRecordPath } from '../src/registry.ts'
import type { CampaignPassedEvent, TrialConfig, TrialEventSource, TrialRecord } from '../src/types.ts'
import { expectOpened, freePort, isAlive, makeEnvironment, makeWorktree, removeEnvironment, trialConfig, until } from './helpers.ts'
import type { TrialEnvironment } from './helpers.ts'

let environment: TrialEnvironment | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (environment !== undefined) await removeEnvironment(environment)
  environment = undefined
})

/** Task-detail view the stub facade read returns. */
function taskDetail(
  worktree: string | undefined,
  dataHome?: string,
): { card: { launchProfile?: { worktree: string; dataHome?: string } } } {
  return {
    card: worktree === undefined
      ? {}
      : { launchProfile: { worktree, ...(dataHome === undefined ? {} : { dataHome }) } },
  }
}

interface ServiceHandle {
  readonly service: SelfDevelopmentTrial
  /** Emit one event through the injected event source. */
  readonly emit: (event: CampaignPassedEvent) => void
  /** How many listeners the injected event source holds. */
  readonly subscriberCount: () => number
  /** The service logger's warn spy. */
  readonly warn: ReturnType<typeof vi.fn>
}

/**
 * Boot one manager over a fresh environment.
 * @param options - launch-profile source, autoOpen, and extra context services.
 */
async function makeService(options: {
  /** Reuse an already-created environment instead of making a fresh one; needed whenever the test
   * builds a worktree (or another environment-rooted path) before booting the service. */
  readonly environment?: TrialEnvironment
  readonly worktree?: string
  /** `null` opts out of the auto-supplied data home, for the tests that exercise its absence. */
  readonly dataHome?: string | null
  readonly autoOpen?: boolean
  readonly config?: Partial<TrialConfig>
  readonly runnerDshHome?: string
  readonly callerLoopback?: boolean
  readonly facadeGetTask?: (taskId: string) => Promise<unknown>
  /** `PATH` the build step searches for a bare `pnpm`; defaults to empty so the fixture worktree's
   * own pnpm (not whatever the test-running host happens to have on PATH) is what gets used. */
  readonly pathEnv?: string
} = {}): Promise<ServiceHandle> {
  environment = options.environment ?? await makeEnvironment()
  context = new Context()
  const warn = vi.spyOn(context.logger, 'warn')
  if (options.runnerDshHome !== undefined) {
    context.provide('selfDevelopmentRunner', { config: { dshHome: options.runnerDshHome } })
  }
  if (options.facadeGetTask !== undefined) {
    context.provide('selfDevelopmentRemote', { getTask: options.facadeGetTask })
  }
  if (options.callerLoopback !== undefined) {
    context.provide('connection', { caller: { current: () => ({ loopback: options.callerLoopback! }) } })
  }
  const listeners: Array<(event: CampaignPassedEvent) => void> = []
  const events: TrialEventSource = {
    subscribe: (listener) => {
      listeners.push(listener)
      return () => {
        const at = listeners.indexOf(listener)
        if (at >= 0) listeners.splice(at, 1)
      }
    },
  }
  let worktree = options.worktree
  if (worktree === undefined && options.facadeGetTask === undefined) {
    worktree = (await makeWorktree(environment.base, 'worktree')).root
  }
  // Every fixture-driven openTrial needs a data home unless the test is
  // exercising the "no data home anywhere" refusal itself (dataHome: null).
  const dataHome = options.dataHome === null ? undefined : (options.dataHome ?? join(environment.base, 'data-home'))
  const config: Partial<TrialConfig> = {
    ...options.config,
    ...(options.autoOpen === undefined ? {} : { autoOpen: options.autoOpen }),
  }
  const service = new SelfDevelopmentTrial(context, trialConfig(environment, config), {
    ...(options.facadeGetTask === undefined ? { getTask: async () => taskDetail(worktree, dataHome) } : {}),
    events,
    pathEnv: options.pathEnv ?? '',
  })
  return {
    service,
    emit: (event) => { for (const listener of listeners) listener(event) },
    subscriberCount: () => listeners.length,
    warn,
  }
}

/** The sidecar record of one task. */
async function readRecord(taskId: string): Promise<TrialRecord> {
  return JSON.parse(await readFile(trialRecordPath(environment!.controlDirectory, taskId), 'utf8')) as TrialRecord
}

async function recordExists(taskId: string): Promise<boolean> {
  try {
    await stat(trialRecordPath(environment!.controlDirectory, taskId))
    return true
  } catch {
    return false
  }
}

describe('openTrial', () => {
  it('builds a DSH worktree, boots its web process, and registers the record', async () => {
    const { service } = await makeService()
    const dataHome = join(environment!.base, 'data-home')
    const result = expectOpened(await service.openTrial('task-open'))
    const record = await readRecord('task-open')
    expect(result).toEqual({ url: record.url, port: record.port, pid: record.pid })
    expect(record.url).toBe(`http://127.0.0.1:${String(result.port)}/?token=abc`)
    expect(result.port).toBeGreaterThanOrEqual(environment!.portRange[0])
    expect(result.port).toBeLessThanOrEqual(environment!.portRange[1])
    expect(result.pid).toBeGreaterThan(0)
    expect(record.worktree).toContain('worktree')
    expect(record.dshHome).toBe(dataHome)
    expect(await service.trials()).toEqual([
      { taskId: 'task-open', url: record.url, port: record.port, startedAt: record.startedAt },
    ])
    const sidecar = await stat(trialRecordPath(environment!.controlDirectory, 'task-open'))
    expect(sidecar.mode & 0o777).toBe(0o600)
    const log = await readFile(trialLogPath(environment!.controlDirectory, 'task-open'), 'utf8')
    expect(log).toContain(`home=${dataHome}`)
    expect(log).toContain('dsh web: http://')
    expect(log).not.toContain('token=abc')
    expect(log).toContain('token=<redacted>')
    expect(log).toContain('building')
    expect(isAlive(result.pid)).toBe(true)
  })

  it('returns the existing instance for a repeated open', async () => {
    const { service } = await makeService()
    const first = await service.openTrial('task-repeat')
    const second = await service.openTrial('task-repeat')
    expect(second).toEqual(first)
    expect(await service.trials()).toHaveLength(1)
  })

  it('skips ports already handed to live instances', async () => {
    const { service } = await makeService()
    const first = expectOpened(await service.openTrial('task-b'))
    const second = expectOpened(await service.openTrial('task-a'))
    expect(second.port).toBeGreaterThan(first.port)
    expect(await service.trials().then(rows => rows.map(row => row.taskId))).toEqual(['task-a', 'task-b'])
  })

  it('refuses a worktree whose manifest is not the DSH root', async () => {
    environment = await makeEnvironment()
    const other = await makeWorktree(environment.base, 'other', { dshRoot: false })
    const { service } = await makeService({ environment, worktree: other.root })
    await expect(service.openTrial('task-other')).resolves.toEqual({
      url: undefined,
      reason: `worktree is not a DSH repository; artifacts at ${other.root}`,
    })
    expect(await service.trials()).toEqual([])
  })

  it('refuses a worktree without a manifest', async () => {
    environment = await makeEnvironment()
    const empty = await makeWorktree(environment.base, 'empty', { manifest: false })
    const { service } = await makeService({ environment, worktree: empty.root })
    await expect(service.openTrial('task-empty')).resolves.toMatchObject({ url: undefined })
  })

  it('fails the open when the build exits nonzero and logs the failure', async () => {
    environment = await makeEnvironment()
    const failing = await makeWorktree(environment.base, 'failing', { pnpm: 'fail' })
    const { service } = await makeService({ environment, worktree: failing.root })
    const error = await service.openTrial('task-build-fail').then(
      () => { throw new Error('expected openTrial to reject') },
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(RemoteError)
    expect(error).toMatchObject({ code: 'self-development/trial-build-failed' })
    const log = await readFile(trialLogPath(environment.controlDirectory, 'task-build-fail'), 'utf8')
    expect(log).toContain('trial build failed: build in')
    expect(log).toContain('code 3')
  })

  it('fails the open when the build exceeds its deadline', async () => {
    environment = await makeEnvironment()
    const slow = await makeWorktree(environment.base, 'slow', { pnpm: 'slow' })
    const { service } = await makeService({ environment, worktree: slow.root, config: { buildTimeoutMs: 300 } })
    await expect(service.openTrial('task-build-slow'))
      .rejects.toMatchObject({ code: 'self-development/trial-build-failed' })
    const log = await readFile(trialLogPath(environment.controlDirectory, 'task-build-slow'), 'utf8')
    expect(log).toContain('timed out after 300 ms')
  })

  it('fails the open when the build is stopped by a signal', async () => {
    environment = await makeEnvironment()
    const signalling = await makeWorktree(environment.base, 'signalling', { pnpm: 'signal' })
    const { service } = await makeService({ environment, worktree: signalling.root })
    await expect(service.openTrial('task-build-signal'))
      .rejects.toMatchObject({ code: 'self-development/trial-build-failed' })
    const log = await readFile(trialLogPath(environment.controlDirectory, 'task-build-signal'), 'utf8')
    expect(log).toContain('signal SIGKILL')
  })

  it('fails the open when neither the worktree nor the node binary carries pnpm', async () => {
    environment = await makeEnvironment()
    const bare = await makeWorktree(environment.base, 'bare', { pnpm: 'none' })
    const { service } = await makeService({ environment, worktree: bare.root })
    await expect(service.openTrial('task-no-pnpm'))
      .rejects.toThrow(/no pnpm found for the build/)
  })

  it('falls through to process.env.PATH when no pathEnv override is configured', async () => {
    // Every other test pins pathEnv to '' through makeService so the fixture
    // worktree's own pnpm is what gets used; this is the one test for the
    // production default (internals.pathEnv omitted), driven through a
    // stubbed process.env.PATH rather than the real host PATH.
    environment = await makeEnvironment()
    const bare = await makeWorktree(environment.base, 'no-worktree-pnpm', { pnpm: 'none' })
    const pathDir = join(environment.base, 'stubbed-path')
    await mkdir(pathDir, { recursive: true })
    const fakePnpm = join(pathDir, 'pnpm')
    // A plain shell script, not a `#!/usr/bin/env node` one: stubbing PATH to
    // just this directory (below) would otherwise also hide the `node` the
    // shebang needs to resolve.
    await writeFile(fakePnpm, '#!/bin/sh\necho building\n')
    await chmod(fakePnpm, 0o755)
    vi.stubEnv('PATH', pathDir)
    try {
      context = new Context()
      const dataHome = join(environment.base, 'path-fallback-home')
      const service = new SelfDevelopmentTrial(context, trialConfig(environment), {
        getTask: async () => ({ card: { launchProfile: { worktree: bare.root, dataHome } } }),
        events: { subscribe: () => () => {} },
        // No pathEnv here: falls through to process.env.PATH, stubbed above.
      })
      expectOpened(await service.openTrial('task-path-fallback'))
      const log = await readFile(trialLogPath(environment.controlDirectory, 'task-path-fallback'), 'utf8')
      expect(log).toContain('building')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('fails the open when every port in the range is occupied', async () => {
    const occupied = await freePort()
    const blocker = createServer()
    await new Promise<void>((resolve) => { blocker.listen(occupied, '127.0.0.1', resolve) })
    try {
      const { service } = await makeService({ config: { portRange: [occupied, occupied] } })
      await expect(service.openTrial('task-ports'))
        .rejects.toMatchObject({ code: 'self-development/trial-port-exhausted' })
    } finally {
      await new Promise<void>((resolve) => { blocker.close(() =>{  resolve() }) })
    }
  })

  it('fails the open when the web process exits before its readiness line', async () => {
    environment = await makeEnvironment()
    const exiting = await makeWorktree(environment.base, 'exiting', { bin: 'exit-first' })
    const { service } = await makeService({ environment, worktree: exiting.root })
    const error = await service.openTrial('task-start-fail').then(
      () => { throw new Error('expected openTrial to reject') },
      (reason: unknown) => reason,
    )
    expect(error).toMatchObject({ code: 'self-development/trial-start-failed' })
    expect((error as Error).message).toContain('exited before printing a readiness line')
    expect(await service.trials()).toEqual([])
    expect(await recordExists('task-start-fail')).toBe(false)
    const log = await readFile(trialLogPath(environment.controlDirectory, 'task-start-fail'), 'utf8')
    expect(log).toContain('trial open failed; the web process was stopped')
  })

  it('uses the runner data home when the launch profile has none', async () => {
    environment = await makeEnvironment()
    const runnerHome = join(environment.base, 'runner-home')
    const { service } = await makeService({ environment, dataHome: null, runnerDshHome: runnerHome })
    expectOpened(await service.openTrial('task-runner-home'))
    const log = await readFile(trialLogPath(environment.controlDirectory, 'task-runner-home'), 'utf8')
    expect(log).toContain(`home=${runnerHome}`)
  })

  it('refuses the open when neither the profile nor the runner supplies a data home', async () => {
    const { service } = await makeService({ dataHome: null })
    await expect(service.openTrial('task-no-home'))
      .rejects.toMatchObject({ code: 'self-development/trial-unavailable' })
  })

  it('fails the open when the log file cannot be written', async () => {
    const { service, warn } = await makeService()
    // Sabotage the control directory only after construction: nothing
    // touches it until the first write inside openTrial.
    await writeFile(environment!.controlDirectory, 'not a directory\n')
    await expect(service.openTrial('task-log-fail')).rejects.toThrow()
    await until(() => warn.mock.calls.length > 0)
  })

  it('propagates a facade rejection verbatim', async () => {
    const facadeError = Object.assign(new Error('no such task'), { code: 'self-development/task-unknown' })
    const { service } = await makeService({ facadeGetTask: () => Promise.reject(facadeError) })
    await expect(service.openTrial('task-unknown')).rejects.toBe(facadeError)
  })

  it('refuses the open when the task has no launch profile', async () => {
    const { service } = await makeService({ facadeGetTask: () => Promise.resolve(taskDetail(undefined)) })
    await expect(service.openTrial('task-no-profile'))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
  })

  it('refuses a malformed task id', async () => {
    const { service } = await makeService()
    await expect(service.openTrial('../escape'))
      .rejects.toMatchObject({ code: 'self-development/config-invalid' })
  })

  it('refuses a non-host caller and admits a loopback one', async () => {
    const refused = await makeService({ callerLoopback: false })
    await expect(refused.service.openTrial('task-phone'))
      .rejects.toMatchObject({ code: 'self-development/host-only-field' })
    await expect(refused.service.closeTrial('task-phone'))
      .rejects.toMatchObject({ code: 'self-development/host-only-field' })
    await expect(refused.service.trials())
      .rejects.toMatchObject({ code: 'self-development/host-only-field' })

    const admitted = await makeService({ callerLoopback: true })
    expectOpened(await admitted.service.openTrial('task-host'))
    await expect(admitted.service.trials()).resolves.toHaveLength(1)
  })
})

describe('closeTrial', () => {
  it('stops the process group, removes the registration, and tolerates a second close', async () => {
    const { service } = await makeService()
    const opened = expectOpened(await service.openTrial('task-close'))
    await service.closeTrial('task-close')
    await until(() => !isAlive(opened.pid))
    expect(await service.trials()).toEqual([])
    expect(await recordExists('task-close')).toBe(false)
    await expect(service.closeTrial('task-close')).resolves.toBeUndefined()
  })

  it('removes a stale sidecar for a task without a live instance', async () => {
    const { service } = await makeService()
    await mkdir(join(environment!.controlDirectory, 'trials'), { recursive: true })
    await writeFile(trialRecordPath(environment!.controlDirectory, 'task-stale'), '{}\n')
    await expect(service.closeTrial('task-stale')).resolves.toBeUndefined()
    expect(await recordExists('task-stale')).toBe(false)
  })

  it('forgets an instance that exits on its own', async () => {
    environment = await makeEnvironment()
    const leaving = await makeWorktree(environment.base, 'leaving', { bin: 'exit-later' })
    const { service } = await makeService({ environment, worktree: leaving.root })
    const opened = expectOpened(await service.openTrial('task-self-exit'))
    await until(() => !isAlive(opened.pid))
    await until(async () => !(await recordExists('task-self-exit')))
    expect(await service.trials()).toEqual([])
  })
})

describe('service disposal', () => {
  it('closes every live instance when the service unloads', async () => {
    const { service } = await makeService()
    const first = expectOpened(await service.openTrial('task-dispose-a'))
    const second = expectOpened(await service.openTrial('task-dispose-b'))
    await context!.fiber.dispose()
    await until(() => !isAlive(first.pid) && !isAlive(second.pid))
    expect(await recordExists('task-dispose-a')).toBe(false)
    expect(await recordExists('task-dispose-b')).toBe(false)
  })

  it('drops only the event subscription when no instance is live', async () => {
    const { subscriberCount } = await makeService()
    await context!.fiber.dispose()
    expect(subscriberCount()).toBe(0)
  })
})

describe('campaign-passed auto open', () => {
  it('opens the trial automatically when a campaign-passed event arrives', async () => {
    const { service, emit } = await makeService()
    emit({ taskId: 'task-auto', kind: 'campaign-passed', title: 'campaign passed', occurredAt: 1 })
    await until(async () => (await service.trials()).length === 1)
    expect(await service.trials()).toMatchObject([{ taskId: 'task-auto' }])
  })

  it('ignores other event kinds', async () => {
    const { service, emit, subscriberCount } = await makeService()
    emit({ taskId: 'task-other', kind: 'campaign-failed', title: 'nope', occurredAt: 1 } as unknown as CampaignPassedEvent)
    expect(await service.trials()).toEqual([])
    expect(subscriberCount()).toBe(1)
  })

  it('logs an automatic-open failure without rejecting, both to the logger and the task log', async () => {
    const { emit, warn } = await makeService({
      facadeGetTask: () => Promise.reject(Object.assign(new Error('no such task'), { code: 'self-development/task-unknown' })),
    })
    emit({ taskId: 'task-broken', kind: 'campaign-passed', title: 'passed', occurredAt: 1 })
    await until(() => warn.mock.calls.some(call => String(call[0]).includes('automatic open')))
    expect(warn).toHaveBeenCalled()
    // The host's general log is not always watched; the failure also has to
    // show up in the task's own trial log, without the launch token (there
    // is none here, but the write still goes through the same redacting path).
    await until(async () => {
      try {
        return (await readFile(trialLogPath(environment!.controlDirectory, 'task-broken'), 'utf8')).includes('automatic open failed')
      } catch {
        return false
      }
    })
    const log = await readFile(trialLogPath(environment!.controlDirectory, 'task-broken'), 'utf8')
    expect(log).toContain('automatic open failed')
    expect(log).toContain('no such task')
  })

  it('keeps no subscription when autoOpen is false', async () => {
    const { emit, subscriberCount } = await makeService({ autoOpen: false })
    emit({ taskId: 'task-closed-auto', kind: 'campaign-passed', title: 'passed', occurredAt: 1 })
    expect(subscriberCount()).toBe(0)
  })

  it('subscribes to nothing when autoOpen is true but no event source is reachable anywhere', async () => {
    // No internals.events override and no context-provided selfDevelopmentEvents:
    // subscribeEvents's own ctx.get fallback resolves to undefined too, so
    // construction and later disposal both have to handle a source-less run.
    environment = await makeEnvironment()
    context = new Context()
    const service = new SelfDevelopmentTrial(context, trialConfig(environment))
    expect(service).toBeInstanceOf(SelfDevelopmentTrial)
    await expect(context.fiber.dispose()).resolves.toBeUndefined()
  })

  it('subscribes to an events service mounted after construction, re-subscribes when it is re-provided, and lets go on disposal', async () => {
    environment = await makeEnvironment()
    context = new Context()
    const worktree = (await makeWorktree(environment.base, 'worktree')).root
    const dataHome = join(environment.base, 'data-home')
    const service = new SelfDevelopmentTrial(context, trialConfig(environment), {
      getTask: async () => taskDetail(worktree, dataHome),
      pathEnv: '',
    })
    const sourceOf = (): { source: TrialEventSource; listeners: Array<(event: CampaignPassedEvent) => void> } => {
      const listeners: Array<(event: CampaignPassedEvent) => void> = []
      return {
        listeners,
        source: {
          subscribe: (listener) => {
            listeners.push(listener)
            return () => { listeners.splice(listeners.indexOf(listener), 1) }
          },
        },
      }
    }
    // `provide` on an active root notifies dependents through `internal/service`,
    // exactly as a mounting events plugin's activation does.
    const early = sourceOf()
    context.provide('selfDevelopmentEvents', early.source as never)
    expect(early.listeners).toHaveLength(1)
    for (const listener of early.listeners) listener({ taskId: 'task-late', kind: 'campaign-passed', title: 'passed', occurredAt: 1 })
    await until(async () => (await service.trials()).length === 1)
    expect(await service.trials()).toMatchObject([{ taskId: 'task-late' }])
    // Re-provided: the old subscription is dropped and the new source is subscribed.
    const late = sourceOf()
    context.set('selfDevelopmentEvents', late.source as never)
    context.reflect.notify(['selfDevelopmentEvents'])
    expect(early.listeners).toHaveLength(0)
    expect(late.listeners).toHaveLength(1)
    await context.fiber.dispose()
    expect(late.listeners).toHaveLength(0)
  })
})

describe('config validation', () => {
  it.each([
    ['relative nodeBinary', { nodeBinary: 'node' }, /nodeBinary .*absolute path/],
    ['empty nodeBinary', { nodeBinary: '' }, /nodeBinary .*absolute path/],
    ['relative controlDirectory', { controlDirectory: 'relative/control' }, /controlDirectory .*absolute path/],
    ['empty controlDirectory', { controlDirectory: '' }, /controlDirectory .*absolute path/],
    ['relative pnpmBinary', { pnpmBinary: 'pnpm' }, /pnpmBinary .*absolute path/],
    ['empty pnpmBinary', { pnpmBinary: '' }, /pnpmBinary .*absolute path/],
    ['non-integer port', { portRange: [3000.5, 3010] as [number, number] }, /between 1 and 65535/],
    ['port below the range', { portRange: [0, 10] as [number, number] }, /between 1 and 65535/],
    ['port above the range', { portRange: [3000, 65536] as [number, number] }, /between 1 and 65535/],
    ['descending range', { portRange: [4000, 3999] as [number, number] }, /ascending/],
    ['zero build timeout', { buildTimeoutMs: 0 }, /buildTimeoutMs/],
    ['fractional ready timeout', { readyTimeoutMs: 1.5 }, /readyTimeoutMs/],
  ])('refuses %s at construction', async (_name, overrides, message) => {
    await expect(makeService({ config: overrides })).rejects.toThrow(message)
  })
})

describe('facade read fallback', () => {
  it('reads the task through the context-provided facade when no internal override is set', async () => {
    environment = await makeEnvironment()
    const worktree = (await makeWorktree(environment.base, 'worktree')).root
    const made = { card: { launchProfile: { worktree, dataHome: join(environment.base, 'data') } } }
    const { service } = await makeService({ environment, facadeGetTask: () => Promise.resolve(made) })
    expectOpened(await service.openTrial('task-facade'))
  })
})
