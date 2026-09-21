/**
 * Opt-in host-only trial-instance manager for self-development campaigns.
 * After a campaign passes, `openTrial` builds the task's experiment worktree
 * with the worktree's own pnpm and boots its `dsh web` on a loopback port
 * from the configured range, with the experiment data home, as a process
 * group this service owns until `closeTrial` or service disposal. The
 * instance's URL — including its launch token — is registered in a 0600
 * sidecar; the shared log file is redacted. The service registers no tool,
 * prompt, or durable store of its own.
 * @module @deepseek-ai/dsh-workflow-self-development-trial
 */

import type { ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { validateTaskId } from '@deepseek-ai/dsh-workflow-self-development'
// Type-only: pulls the facade's Context merge so the injected
// `selfDevelopmentRemote` read below is typed.
import type {} from '@deepseek-ai/dsh-workflow-self-development-remote'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { runBuild, resolveBuildCommand } from './build.ts'
import { SelfDevelopmentTrialError, errorText } from './errors.ts'
import { allocatePort } from './ports.ts'
import { stopProcessGroup } from './process-group.ts'
import { appendTrialLog, removeTrialRecord, writeTrialRecord } from './registry.ts'
import type {
  CampaignPassedEvent,
  OpenTrialResult,
  TrialConfig,
  TrialEventSource,
  TrialRecord,
  TrialSummary,
  TrialTaskDetail,
} from './types.ts'
import { spawnWebProcess, redactToken } from './web-process.ts'
import { seedTrialWorkspace } from './workspace-seed.ts'

/** Default build deadline: twenty minutes per the campaign plan. */
export const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60 * 1000

/** Default readiness deadline for the `dsh web: …` line. */
export const DEFAULT_READY_TIMEOUT_MS = 60_000

/**
 * Host integrations replaceable by direct unit tests: the facade read, the
 * event subscription, and the clock. In a deployment every default comes
 * from the owning service.
 */
export interface SelfDevelopmentTrialInternals {
  /** Facade `getTask` override for direct unit tests. */
  readonly getTask?: (taskId: string) => Promise<TrialTaskDetail>
  /** Events subscription override for direct unit tests. */
  readonly events?: TrialEventSource
  /** Host clock used for `startedAt`; defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * `PATH` value the build step searches for a bare `pnpm`; defaults to
   * `process.env.PATH`. Overridable so a direct unit test can pin the
   * build's pnpm resolution independently of the host running the test.
   */
  readonly pathEnv?: string
}

/** One live trial instance this service owns. */
interface TrialInstance {
  /** Registered record, also stored as the task's sidecar. */
  readonly record: TrialRecord
  /** The spawned group leader. */
  readonly child: ChildProcess
  /** Settles when the group leader exits; never rejects. */
  readonly exited: Promise<void>
}

/**
 * Host-only trial-instance service. Ordinary chat messages never reach its
 * methods: each is a `@Remote` method invoked explicitly through the Typert
 * gateway, and a non-host caller is refused.
 */
export class SelfDevelopmentTrial extends TypertRemoteService {
  static inject = ['selfDevelopmentRemote']

  /** Runtime schema for the service config; every field is deployment-owned. */
  static Config = z.object({
    nodeBinary: z.string().required(),
    controlDirectory: z.string().required(),
    portRange: z.tuple([z.number().step(1), z.number().step(1)]),
    buildTimeoutMs: z.number().step(1).default(DEFAULT_BUILD_TIMEOUT_MS),
    readyTimeoutMs: z.number().step(1).default(DEFAULT_READY_TIMEOUT_MS),
    autoOpen: z.boolean().default(true),
    pnpmBinary: z.string(),
  }) as unknown as z<TrialConfig>

  /** Validated deployment configuration. */
  private readonly resolved: TrialConfig

  /** Live instances this service owns, by task id. */
  private readonly instances = new Map<string, TrialInstance>()

  /**
   * Opens in flight, by task id: a build plus a web-process start take
   * minutes, and a second `openTrial` for the same task in that window — a
   * status poll racing the automatic open — joins the first instead of
   * building and spawning a second instance on another port.
   */
  private readonly opening = new Map<string, Promise<OpenTrialResult>>()

  /** Test-replaceable integrations. */
  private readonly internals: SelfDevelopmentTrialInternals

  /** Host clock for `startedAt`. */
  private readonly now: () => number

  /** Disposer of the `campaign-passed` subscription, when one was taken. */
  private unsubscribeEvents: (() => void) | undefined

  /**
   * @param ctx - owning Cordis context carrying the Remote facade.
   * @param config - deployment configuration for the binaries, control directory, port range, and deadlines.
   * @param internals - host integrations replaceable by direct unit tests.
   * @throws SelfDevelopmentTrialError with `self-development/config-invalid` when a path field is
   *   not absolute, the port range is not a valid ascending port pair, or a deadline is not a
   *   positive integer. Misconfiguration fails at load.
   */
  constructor(ctx: Context, config: TrialConfig, internals: SelfDevelopmentTrialInternals = {}) {
    super(ctx, 'selfDevelopmentTrial', { namespace: 'selfDevelopmentTrial' })
    this.resolved = validateConfig(config)
    this.internals = internals
    this.now = internals.now ?? Date.now
    // Service disposal closes every instance this service owns and drops the
    // campaign-passed subscription. Nothing is ever scanned by process name.
    this.ctx.effect(() => async () => {
      this.unsubscribeEvents?.()
      await Promise.allSettled([...this.instances.keys()].map(taskId => this.closeTrial(taskId)))
    })
    if (this.resolved.autoOpen) this.subscribeEvents()
  }

  /**
   * Open (or reuse) one task's trial instance. The worktree and data home
   * come from the task's stored launch profile through the facade's
   * `getTask`; a profile without `dataHome` falls back to the runner's
   * configured `dshHome`. A worktree whose root `package.json` is not the
   * DSH root returns a reason instead of an instance.
   * @param taskId - task identity.
   * @returns the ready instance's URL, port, and pid, or `url: undefined` with the reason
   *   when the worktree is not a DSH repository.
   * @throws SelfDevelopmentTrialError with `self-development/host-only-field` from a non-host caller,
   *   `self-development/config-invalid` when the task id is malformed or the task has no launch
   *   profile, `self-development/task-unknown` when the facade does not know the task,
   *   `self-development/trial-unavailable` when neither the profile nor the runner supplies a data
   *   home, `self-development/trial-build-failed` when the worktree build fails or times out,
   *   `self-development/trial-port-exhausted` when no port in the range is free, or
   *   `self-development/trial-start-failed` when the web process never becomes ready.
   * @throws whatever the facade rejects with, verbatim: the facade owns its own error codes.
   */
  @Remote('openTrial')
  async openTrial(taskId: string): Promise<OpenTrialResult> {
    this.assertCallerIsHost('openTrial')
    const id = parseTaskId(taskId)
    const existing = this.instances.get(id)
    if (existing !== undefined) {
      return { url: existing.record.url, port: existing.record.port, pid: existing.record.pid }
    }
    const inFlight = this.opening.get(id)
    if (inFlight !== undefined) return inFlight
    const opened = this.openFresh(id)
    this.opening.set(id, opened)
    try {
      return await opened
    } finally {
      this.opening.delete(id)
    }
  }

  /**
   * The task ids whose trial is being built or started right now — an
   * `openTrial` that has not settled yet. A status surface reports these as
   * "trial building" instead of "no trial", since a build takes minutes.
   * @returns the in-flight task ids, sorted.
   * @throws SelfDevelopmentTrialError with `self-development/host-only-field` from a non-host caller.
   */
  @Remote('pending')
  // oxlint-disable-next-line typescript/require-await -- see trials(): the async turns the host check's throw into a rejection.
  async pending(): Promise<readonly string[]> {
    this.assertCallerIsHost('pending')
    return [...this.opening.keys()].sort((left, right) => left.localeCompare(right))
  }

  /**
   * Build and start one task's trial instance; `openTrial` owns the
   * in-flight bookkeeping around this.
   * @param id - the validated task id.
   * @returns the ready instance's URL, port, and pid, or the refusal for a non-DSH worktree.
   */
  private async openFresh(id: string): Promise<OpenTrialResult> {
    const profile = (await this.getTask(id)).card.launchProfile
    if (profile === undefined) {
      throw new SelfDevelopmentTrialError(
        'self-development/config-invalid',
        `task ${JSON.stringify(id)} has no launch profile; openTrial derives the worktree from it`,
      )
    }
    const dshHome = profile.dataHome ?? this.runnerDshHome()
    const worktree = profile.worktree
    if (!await isDshRepository(worktree)) {
      return { url: undefined, reason: `worktree is not a DSH repository; artifacts at ${worktree}` }
    }
    await this.build(id, worktree)
    await this.seedWorkspace(id, worktree, dshHome)
    const port = await allocatePort(this.resolved.portRange[0], this.resolved.portRange[1], this.takenPorts())
    const spawned = spawnWebProcess({
      nodeBinary: this.resolved.nodeBinary,
      worktree,
      port,
      dshHome,
      readyTimeoutMs: this.resolved.readyTimeoutMs,
      onOutput: (chunk) => { void this.log(id, chunk) },
    })
    let url: string
    try {
      url = await spawned.url
    } catch (error) {
      await this.discard(id, spawned)
      throw error
    }
    const pid = spawned.child.pid
    if (pid === undefined) {
      await this.discard(id, spawned)
      throw new SelfDevelopmentTrialError(
        'self-development/trial-start-failed',
        `trial web process for ${worktree} spawned without a process id`,
      )
    }
    const record: TrialRecord = {
      version: 1,
      taskId: id,
      url,
      port,
      pid,
      startedAt: this.now(),
      worktree,
      dshHome,
    }
    await writeTrialRecord(this.resolved.controlDirectory, id, record)
    this.instances.set(id, { record, child: spawned.child, exited: spawned.exited })
    spawned.child.once('exit', () => { void this.forget(id, spawned.child) })
    return { url, port, pid }
  }

  /**
   * Close one task's trial instance: SIGTERM to the registered process
   * group, a five-second grace, then SIGKILL, and a bounded wait for the
   * group leader this service spawned to exit. The registration and the
   * sidecar are removed. Closing a task without a live instance still
   * removes a stale sidecar.
   * @param taskId - task identity.
   * @throws SelfDevelopmentTrialError with `self-development/host-only-field` from a non-host caller,
   *   `self-development/config-invalid` when the task id is malformed, or
   *   `self-development/trial-stop-failed` when the group cannot be signalled or its exit is not
   *   confirmed within the teardown deadlines.
   */
  @Remote('closeTrial')
  async closeTrial(taskId: string): Promise<void> {
    this.assertCallerIsHost('closeTrial')
    const id = parseTaskId(taskId)
    const instance = this.instances.get(id)
    if (instance === undefined) {
      await removeTrialRecord(this.resolved.controlDirectory, id)
      return
    }
    this.instances.delete(id)
    await stopProcessGroup(instance.record.pid, instance.exited)
    await removeTrialRecord(this.resolved.controlDirectory, id)
  }

  /**
   * List the live trial instances this process owns.
   * @returns one row per live instance, sorted by task id; a process restart starts from `[]`
   *   because instances are never resurrected from sidecars.
   * @throws SelfDevelopmentTrialError with `self-development/host-only-field` from a non-host caller.
   */
  @Remote('trials')
  // async is load-bearing here, not stylistic: it is what turns
  // assertCallerIsHost's synchronous throw into a rejected promise instead
  // of a same-tick exception at the call site, matching openTrial's and
  // closeTrial's rejection behavior for a non-host caller.
  // oxlint-disable-next-line typescript/require-await
  async trials(): Promise<readonly TrialSummary[]> {
    this.assertCallerIsHost('trials')
    return [...this.instances.values()]
      .map(instance => ({
        taskId: instance.record.taskId,
        url: instance.record.url,
        port: instance.record.port,
        startedAt: instance.record.startedAt,
      }))
      .sort((left, right) => left.taskId.localeCompare(right.taskId))
  }

  /**
   * Read the task detail the facade projects. The facade is a declared
   * injection; direct unit tests replace the read with an internal override.
   * @param taskId - validated task identity.
   * @returns the facade's task detail.
   */
  private getTask(taskId: string): Promise<TrialTaskDetail> {
    if (this.internals.getTask !== undefined) return this.internals.getTask(taskId)
    return this.ctx.selfDevelopmentRemote.getTask(taskId)
  }

  /**
   * Read the supervised runner's configured data home structurally: the
   * runner is optional in this deployment and keeps its configuration
   * private, so the read goes through `ctx.get` and a structural view of the
   * one field this service needs instead of a declared injection.
   * @returns the runner's `dshHome`.
   * @throws SelfDevelopmentTrialError with `self-development/trial-unavailable` when the runner
   *   plugin is not loaded; a launch profile without `dataHome` then has no source.
   */
  private runnerDshHome(): string {
    const runner = (this.ctx as unknown as { get(name: string): unknown }).get('selfDevelopmentRunner') as
      | { config?: { dshHome?: string } }
      | undefined
    const dshHome = runner?.config?.dshHome
    if (dshHome === undefined) {
      throw new SelfDevelopmentTrialError(
        'self-development/trial-unavailable',
        'no data home for the trial instance: the launch profile has no dataHome and selfDevelopmentRunner is not loaded',
      )
    }
    return dshHome
  }

  /**
   * Build the worktree before spawning. Build output streams into the task's
   * log; a failure is logged and re-raised so the open fails loudly.
   * @param taskId - validated task identity naming the log file.
   * @param worktree - the verified DSH worktree to build.
   * @throws SelfDevelopmentTrialError with `self-development/trial-build-failed` when the build
   *   fails, times out, or has no pnpm to run.
   */
  private async build(taskId: string, worktree: string): Promise<void> {
    const pathEnv = this.internals.pathEnv ?? process.env.PATH
    const command = await resolveBuildCommand(worktree, this.resolved.nodeBinary, this.resolved.pnpmBinary, pathEnv)
    try {
      await runBuild(worktree, command, this.resolved.nodeBinary, this.resolved.buildTimeoutMs, (chunk) => {
        void this.log(taskId, chunk)
      })
    } catch (error) {
      await this.log(taskId, `trial build failed: ${errorText(error)}`)
      throw error
    }
  }

  /**
   * Register the worktree in the trial data home's workspace registry so
   * the GUI opens on it. Seeding is a convenience: a failure is logged to the
   * trial log and the open continues, since the person can still add the
   * workspace by hand.
   * @param taskId - validated task identity naming the log file and the workspace title.
   * @param worktree - the verified DSH worktree.
   * @param dshHome - the trial data home whose registry is seeded.
   */
  private async seedWorkspace(taskId: string, worktree: string, dshHome: string): Promise<void> {
    try {
      const outcome = await seedTrialWorkspace(dshHome, worktree, `${taskId} (trial)`, this.now)
      await this.log(taskId, outcome.kind === 'skipped'
        ? `trial workspace not seeded: ${outcome.reason}`
        : `trial workspace ${outcome.kind}: ${outcome.path}`)
    } catch (error) {
      await this.log(taskId, `trial workspace seeding failed; add the worktree as a workspace by hand: ${errorText(error)}`)
    }
  }

  /**
   * Drop a spawned process after a failed open: stop its group and log the
   * failure. Stopping is best-effort here — the open already failed.
   * @param taskId - validated task identity naming the log file.
   * @param spawned - the process that never became ready.
   */
  private async discard(taskId: string, spawned: { readonly child: ChildProcess; readonly exited: Promise<void> }): Promise<void> {
    const pid = spawned.child.pid
    if (pid === undefined) return
    try {
      await stopProcessGroup(pid, spawned.exited)
    } catch (error) {
      await this.log(taskId, `trial teardown after failed open: ${errorText(error)}`)
      return
    }
    await this.log(taskId, 'trial open failed; the web process was stopped')
  }

  /**
   * Forget one instance after its group leader exits on its own, so
   * `trials()` never lists a dead URL. A close that already removed the
   * entry makes this a no-op.
   * @param taskId - task the instance belongs to.
   * @param child - the group leader whose exit was observed.
   */
  private async forget(taskId: string, child: ChildProcess): Promise<void> {
    const instance = this.instances.get(taskId)
    if (instance === undefined || instance.child !== child) return
    this.instances.delete(taskId)
    await removeTrialRecord(this.resolved.controlDirectory, taskId)
  }

  /**
   * Append redacted text to the task's trial log. Logging never blocks an
   * open or a close; a write failure is logged to the service logger only.
   * @param taskId - task identity naming the log file.
   * @param text - raw output or a message; the launch token is redacted here.
   */
  private async log(taskId: string, text: string): Promise<void> {
    try {
      await appendTrialLog(this.resolved.controlDirectory, taskId, redactToken(text))
    } catch (error) {
      this.ctx.logger.warn('self-development-trial: log write failed for task "%s"', taskId)
      this.ctx.logger.warn(error)
    }
  }

  /**
   * Ports already handed to live instances of this process, refused by the
   * allocator before the bind probe.
   * @returns the set of allocated ports.
   */
  private takenPorts(): Set<number> {
    return new Set([...this.instances.values()].map(instance => instance.record.port))
  }

  /**
   * Subscribe to the events consumer's `campaign-passed` notifications when
   * the consumer is mounted. The events kind arrives once DH-a's mapping
   * lands; this worktree's consumer emits no such kind yet, so the
   * subscription stays inert until then. An automatic open that fails is
   * logged to both the service logger and the task's own trial log — a
   * notification must still never propagate — so the failure is visible
   * even when the host's general log stream is not being watched.
   */
  private subscribeEvents(): void {
    const readSource = (): TrialEventSource | undefined => this.internals.events
      ?? (this.ctx as unknown as { get(name: string): unknown }).get('selfDevelopmentEvents') as
        | TrialEventSource
        | undefined
    const source = readSource()
    if (source === undefined) {
      // Not mounted yet (or not at all): this row sits after the events row
      // in the shipped overlay, yet activation order is not row order, and
      // a field test never auto-opened a single trial because this
      // subscription was attempted only once, at construction. Subscribe
      // when the service appears; re-subscribe if it is re-provided.
      let unsubscribe: (() => void) | undefined
      const stopWatching = this.ctx.on('internal/service', (name: string) => {
        if (name !== 'selfDevelopmentEvents') return
        unsubscribe?.()
        unsubscribe = undefined
        const mounted = readSource()
        if (mounted !== undefined) unsubscribe = this.subscribeTo(mounted)
      })
      this.unsubscribeEvents = () => {
        stopWatching()
        unsubscribe?.()
      }
      return
    }
    this.unsubscribeEvents = this.subscribeTo(source)
  }

  /**
   * Take the `campaign-passed` subscription on one event source.
   * @param source - the events consumer to subscribe to.
   * @returns the subscription's disposer.
   */
  private subscribeTo(source: TrialEventSource): () => void {
    return source.subscribe((event: CampaignPassedEvent) => {
      // The events service folds a passed campaign into kind `awaiting-trial`
      // under origin `campaign`; a single passed round is the same kind under
      // origin `commit`, and a merge result is origin `merge`, so both fields
      // are checked — a round passing mid-campaign must not open a trial.
      if (event.origin !== 'campaign' || event.kind !== 'awaiting-trial') return
      void this.openTrial(event.taskId).catch((error: unknown) => {
        const message = errorText(error)
        this.ctx.logger.warn(
          'self-development-trial: automatic open for task "%s" failed: %s',
          event.taskId,
          message,
        )
        void this.log(event.taskId, `automatic open failed: ${message}`)
      })
    })
  }

  /**
   * Refuse a non-host caller. The connection layer derives the answer from
   * the request's Host header; without a connection service, or outside any
   * `@Remote` request, the call counts as the stable host.
   * @param operation - the method the caller invoked.
   * @throws SelfDevelopmentTrialError with `self-development/host-only-field` from a caller whose
   *   Host header is not loopback; every trial operation spawns and kills host processes.
   */
  private assertCallerIsHost(operation: string): void {
    const connection = (this.ctx as unknown as { get(name: string): unknown }).get('connection') as
      | { caller: { current: () => { loopback: boolean } | undefined } }
      | undefined
    const caller = connection?.caller.current()
    if (caller === undefined || caller.loopback) return
    throw new SelfDevelopmentTrialError(
      'self-development/host-only-field',
      `${operation} spawns and stops host processes and is reserved for the stable host; a phone caller may watch progress through the facade`,
    )
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-only trial-instance manager for self-development campaigns. */
    selfDevelopmentTrial: SelfDevelopmentTrial
  }
}

export default SelfDevelopmentTrial

/**
 * Check that a worktree is a DSH repository: its root `package.json` names
 * `@deepseek-ai/dsh-root`. An absent or unreadable manifest is not a DSH
 * repository.
 * @param worktree - candidate worktree root.
 * @returns true only when the root manifest names the DSH root package.
 */
async function isDshRepository(worktree: string): Promise<boolean> {
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(`${worktree}/package.json`, 'utf8'))
  } catch {
    return false
  }
  return (manifest as { name?: unknown }).name === '@deepseek-ai/dsh-root'
}

/**
 * Validate the deployment configuration at construction time.
 * @param config - configuration as parsed from cordis.yml.
 * @returns the same configuration once every field is proven usable.
 * @throws SelfDevelopmentTrialError with `self-development/config-invalid` when a path field is not
 *   absolute, a port bound is not a valid port, or the range is not ascending.
 */
function validateConfig(config: TrialConfig): TrialConfig {
  const invalid = (detail: string): SelfDevelopmentTrialError =>
    new SelfDevelopmentTrialError('self-development/config-invalid', `self-development trial config is invalid: ${detail}`)
  if (config.nodeBinary.length === 0 || !isAbsolute(config.nodeBinary)) {
    throw invalid(`nodeBinary ${JSON.stringify(config.nodeBinary)} must be an absolute path`)
  }
  if (config.controlDirectory.length === 0 || !isAbsolute(config.controlDirectory)) {
    throw invalid(`controlDirectory ${JSON.stringify(config.controlDirectory)} must be an absolute path`)
  }
  if (config.pnpmBinary !== undefined && (config.pnpmBinary.length === 0 || !isAbsolute(config.pnpmBinary))) {
    throw invalid(`pnpmBinary ${JSON.stringify(config.pnpmBinary)} must be an absolute path`)
  }
  const [from, to] = config.portRange
  for (const bound of config.portRange) {
    if (!Number.isInteger(bound) || bound < 1 || bound > 65535) {
      throw invalid(`portRange ${JSON.stringify(config.portRange)} must name ports between 1 and 65535`)
    }
  }
  if (from > to) throw invalid(`portRange ${JSON.stringify(config.portRange)} must be ascending`)
  for (const field of ['buildTimeoutMs', 'readyTimeoutMs'] as const) {
    if (!Number.isInteger(config[field]) || config[field] <= 0) {
      throw invalid(`${field} must be a positive integer of milliseconds`)
    }
  }
  return config
}

/**
 * Validate a task id at the manager boundary, converting the core's error
 * into a manager refusal.
 * @param taskId - task identity as handed in.
 * @returns the validated id.
 * @throws SelfDevelopmentTrialError with `self-development/config-invalid` when the id is malformed.
 */
function parseTaskId(taskId: string): string {
  try {
    return validateTaskId(taskId)
  } catch (error) {
    throw new SelfDevelopmentTrialError(
      'self-development/config-invalid',
      `taskId ${JSON.stringify(taskId)} is invalid: ${errorText(error)}`,
    )
  }
}
