/**
 * Opt-in service for supervised-mode self-development attempts. The service
 * validates its deployment configuration at construction and later composes
 * the trusted clock, human-presence evidence, headless executor, and
 * independent acceptor into one `startAttempt` side effect. It owns every
 * attempt it starts: `stop` and service disposal abort the owned attempt,
 * then wait for the executor and acceptor process groups and the evidence
 * writes to finish before returning. It registers no tool, prompt, or event,
 * and it enables no unattended execution.
 * @module @deepseek-ai/dsh-workflow-self-development-runner
 */

import { isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SelfDevOperationId, SelfDevTaskId } from '@deepseek-ai/dsh-workflow-self-development'
import type { TaskOperationResult } from '@deepseek-ai/dsh-workflow-self-development'
import { runSupervisedAttempt } from './attempt.ts'
import type { SupervisedAttemptRequest, SupervisedAttemptOutcome } from './attempt.ts'
import { verifyAcceptance } from './verify.ts'
import type { VerifyAcceptanceResult } from './verify.ts'
import { HostClock } from './clock.ts'
import { SelfDevelopmentRunnerError } from './runtime.ts'
import { isInsideReal } from './path-containment.ts'
import { DEFAULT_SANDBOX_CONFIG, assertSandboxRootsAbsolute } from './sandbox.ts'
import type { RunnerConfig } from './types.ts'

export { HostClock, parseKernBoottime, readBootTimeSysctl } from './clock.ts'
export { HumanPresenceCapabilitySource } from './presence.ts'
export { artifactDigestOf, sourceDigestOf } from './digests.ts'
export { SelfDevelopmentRunnerError, SelfDevelopmentRunnerErrorCode } from './runtime.ts'
export { runHeadlessExecutor } from './executor.ts'
export { checkAcceptanceCoversPlan, loadAcceptance, runAcceptance } from './acceptor.ts'
export { verifyAcceptance } from './verify.ts'
export type { VerifyAcceptanceConfig, VerifyAcceptanceResult } from './verify.ts'
export {
  DEFAULT_SANDBOX_CONFIG,
  assertSandboxAvailable,
  buildSeatbeltProfile,
  prepareSandboxProfile,
  probeSandbox,
  resolveSandboxRoot,
  sandboxEffectivelyEnabled,
  wrapCommand,
} from './sandbox.ts'
export type { PreparedSandbox, SandboxAvailability, SeatbeltProfileInput } from './sandbox.ts'
export type { BootTime, BootTimeReader } from './clock.ts'
export type { PresenceAcknowledgement, PresenceConfirmation } from './presence.ts'
export type { ExecutorRequest, ExecutorRun } from './executor.ts'
export type { AcceptanceAssertion, AcceptanceCase, AcceptanceRun } from './acceptor.ts'
export type { RunnerConfig, SandboxConfig } from './types.ts'
export { planAttemptBudget, phaseLimitMs, armDeadline } from './budget.ts'
export type { ArmedDeadline } from './budget.ts'
export { assertConfirmationBinds, resolveAttemptDshHome, resolveExperimentWorktree } from './binding.ts'
export type { LaunchFacts } from './binding.ts'
export { readLaunchRecord, writeLaunchRecord, launchRecordPath } from './launch-record.ts'
export type { LaunchRecord } from './launch-record.ts'
export { writeAttemptEvidence, writeAttemptOutcome, readAttemptEvidence, attemptEvidencePath } from './evidence.ts'
export type { AttemptEvidence, AttemptOutcome, DigestPair } from './evidence.ts'
export { writeDurableJson, readDurableJson } from './durable-json.ts'
export { runSupervisedAttempt } from './attempt.ts'
export type { SupervisedAttemptRequest, SupervisedAttemptOutcome } from './attempt.ts'

/** One attempt this runner owns: its cancellation handle and its settle point. */
interface ActiveAttempt {
  /** Aborted by `stop` and by service disposal; composed with the caller's signal. */
  readonly abort: AbortController
  /** Settles once the attempt's process groups and evidence writes are done; carries no rejection. */
  readonly settled: Promise<void>
}

/** Cordis service composing the supervised-mode attempt pipeline. */
export class SelfDevelopmentRunner extends Service {
  static inject = ['selfDevelopmentTasks']

  /** Runtime schema for the service config; every field is deployment-owned. */
  static Config = z.object({
    nodeBinary: z.string().required(),
    dshBin: z.string().required(),
    dshHome: z.string().required(),
    experimentsRoot: z.string().required(),
    evidenceRoot: z.string().required(),
    killGraceMs: z.number().step(1).required(),
    // Every field defaults, so an omitted `sandbox` key parses to
    // DEFAULT_SANDBOX_CONFIG's values (enabled, no extra roots, the system
    // `sandbox-exec`) — sandboxing on by default, per the decision this
    // package implements.
    sandbox: z.object({
      enabled: z.boolean().default(true),
      denyReadRoots: z.array(z.string()).default([]),
      extraWritableRoots: z.array(z.string()).default([]),
      sandboxExec: z.string().default(DEFAULT_SANDBOX_CONFIG.sandboxExec),
    }),
  }) as unknown as z<RunnerConfig>

  // Cordis service shadows read state through a prototype-extended proxy, so
  // these use TypeScript privacy instead of #-private fields: private-field
  // access fails the brand check on the shadow receiver.

  /** Validated deployment configuration every attempt runs under. */
  private readonly config: RunnerConfig

  /** The singleton trusted clock handed to the core and to every attempt. */
  private clockInstance: HostClock | undefined

  /** Attempts this runner owns, by task id. */
  private readonly active = new Map<string, ActiveAttempt>()

  /**
   * @param ctx - owning Cordis context.
   * @param config - deployment configuration for the runner's binaries, homes, and process teardown.
   * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_CONFIG_INVALID` when a path field is
   *   missing, empty, or not absolute, `evidenceRoot` sits inside or equals `experimentsRoot`, or
   *   `killGraceMs` is not a positive finite integer. Misconfiguration fails at load.
   */
  constructor(ctx: Context, config: RunnerConfig) {
    super(ctx, 'selfDevelopmentRunner')
    this.config = validateConfig(config)
    // Service disposal aborts every attempt this runner owns, then waits for
    // the executor and acceptor process groups and the evidence writes to
    // finish. Nothing is ever scanned by process name.
    this.ctx.effect(() => async () => {
      const entries = [...this.active.values()]
      for (const entry of entries) entry.abort.abort()
      await Promise.allSettled(entries.map(entry => entry.settled))
    })
  }

  /**
   * The runner's trusted clock. The first call creates one `HostClock`; later
   * calls return the same instance, so every task and attempt shares one
   * boot-session observer.
   * @returns the singleton trusted clock.
   */
  clock(): HostClock {
    const existing = this.clockInstance
    if (existing !== undefined) return existing
    const created = new HostClock()
    this.clockInstance = created
    return created
  }

  /**
   * Run one supervised attempt for a task. A second attempt for the same task
   * while one is in flight in this runner is refused before the core is
   * touched; worktree, confirmation, launch-record, and evidence validation
   * are `runSupervisedAttempt`'s responsibility.
   * @param req - the supervised attempt to run, keyed by task id.
   * @returns the core operation result with the attempt id, evidence path, and
   *   outcome write failure of this process's execution.
   * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_ATTEMPT_ACTIVE` when this runner
   *   already owns an in-flight attempt for `req.taskId`.
   * @throws whatever the core's `open` or `runSupervisedAttempt` rejects with,
   *   verbatim: a journal handoff is a human decision and is never wrapped,
   *   retried, or recorded as an attempt outcome here.
   */
  runAttempt(req: SupervisedAttemptRequest): Promise<SupervisedAttemptOutcome> {
    const active = this.active.get(req.taskId)
    if (active !== undefined) {
      return Promise.reject(new SelfDevelopmentRunnerError(
        `task ${req.taskId} already has an in-flight attempt in this runner`,
        'SELF_DEV_RUNNER_ATTEMPT_ACTIVE',
      ))
    }
    const abort = new AbortController()
    const running = this.executeAttempt(req, abort).finally(() => {
      this.active.delete(req.taskId)
    })
    this.active.set(req.taskId, { abort, settled: running.then(() => undefined, () => undefined) })
    return running
  }

  /**
   * Stop a task and finish this runner's own work for it. The core commits
   * `task/stopped` and aborts the attempt's launch signal first; this runner
   * then aborts its own cancellation handle and waits until the attempt's
   * promise has settled — the executor and acceptor process groups have exited
   * and the evidence writes are done — before returning the core's result.
   * Without an in-flight attempt, only the core stop runs.
   * @param req - task, expected revision, and idempotency key of the stop.
   * @returns the core's stop operation result.
   * @throws whatever the core's `open` or `stop` rejects with, verbatim.
   */
  async stop(req: {
    readonly taskId: string
    readonly expectedRevision: number
    readonly operationId: string
  }): Promise<TaskOperationResult> {
    const controller = await this.ctx.selfDevelopmentTasks.open(req.taskId, this.clock())
    const result = await controller.stop({
      taskId: SelfDevTaskId(req.taskId),
      expectedRevision: req.expectedRevision,
      operationId: SelfDevOperationId(req.operationId),
    })
    const entry = this.active.get(req.taskId)
    if (entry !== undefined) {
      entry.abort.abort()
      // The attempt's rejection stays with runAttempt's caller; the stop only
      // needs the process groups and evidence writes to have finished.
      await entry.settled
    }
    return result
  }

  /**
   * The task ids of the attempts this runner currently owns.
   * @returns a read-only snapshot; later ownership changes are not reflected.
   */
  activeTasks(): readonly string[] {
    return [...this.active.keys()]
  }

  /**
   * Judge one acceptance definition against a worktree through the acceptor
   * alone, under this runner's `experimentsRoot` and `killGraceMs`: no headless
   * dsh agent runs, no attempt is recorded, and nothing here touches the
   * task-control core. This is the service-side entry point for the verify-only
   * {@link verifyAcceptance} function, for callers that reach the runner through
   * `ctx.get` — such as a merge's pre-fast-forward verification gate.
   * @param worktree - absolute path of the worktree the acceptance cases run against.
   * @param acceptancePath - absolute path of the acceptance definition; must resolve outside `experimentsRoot`.
   * @param options - optional overall deadline for the whole run in milliseconds.
   * @returns `{ ok: true, report }` once the acceptor completed — assertion failures are inside `report`,
   *   not a failure of this call — or `{ ok: false, reason }` when the definition could not be loaded or a
   *   case could not be spawned or torn down. Never throws.
   */
  verifyAcceptance(
    worktree: string,
    acceptancePath: string,
    options: { readonly phaseTimeoutMs?: number } = {},
  ): Promise<VerifyAcceptanceResult> {
    return verifyAcceptance(worktree, acceptancePath, {
      experimentsRoot: this.config.experimentsRoot,
      killGraceMs: this.config.killGraceMs,
      ...(this.config.sandbox === undefined ? {} : { sandbox: this.config.sandbox }),
      ...(options.phaseTimeoutMs === undefined ? {} : { phaseTimeoutMs: options.phaseTimeoutMs }),
    })
  }

  /**
   * Run one supervised attempt under this runner's clock, config, and
   * cancellation handle. The caller's signal, when present, is composed with
   * the runner's own: either one aborting aborts the attempt.
   * @param req - the supervised attempt to run.
   * @param abort - the cancellation handle `stop` and disposal abort.
   * @returns the outcome of the attempt.
   */
  private async executeAttempt(
    req: SupervisedAttemptRequest,
    abort: AbortController,
  ): Promise<SupervisedAttemptOutcome> {
    const controller = await this.ctx.selfDevelopmentTasks.open(req.taskId, this.clock())
    const signal = req.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, req.signal])
    return runSupervisedAttempt({ controller, clock: this.clock(), config: this.config }, { ...req, signal })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    selfDevelopmentRunner: SelfDevelopmentRunner
  }
}

export default SelfDevelopmentRunner

/** Config fields that must be absolute host paths. */
const ABSOLUTE_FIELDS = ['nodeBinary', 'dshBin', 'dshHome', 'experimentsRoot', 'evidenceRoot'] as const

/**
 * Validate the deployment configuration at construction time.
 * @param config - configuration as parsed from cordis.yml.
 * @returns the same configuration once every field is proven usable.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_CONFIG_INVALID` when a path field is
 *   missing, empty, or not absolute, `evidenceRoot` sits inside or equals `experimentsRoot`,
 *   `killGraceMs` is not a positive finite integer, or a configured `sandbox.sandboxExec`,
 *   `sandbox.denyReadRoots` entry, or `sandbox.extraWritableRoots` entry is not an absolute path.
 */
function validateConfig(config: RunnerConfig): RunnerConfig {
  const invalid = (detail: string): SelfDevelopmentRunnerError =>
    new SelfDevelopmentRunnerError(`self-development runner config is invalid: ${detail}`, 'SELF_DEV_RUNNER_CONFIG_INVALID')
  for (const field of ABSOLUTE_FIELDS) {
    const value = config[field]
    if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
      throw invalid(`${field} ${JSON.stringify(value)} must be an absolute path`)
    }
  }
  if (isInsideReal(resolve(config.experimentsRoot), resolve(config.evidenceRoot))) {
    throw invalid(`evidenceRoot ${JSON.stringify(config.evidenceRoot)} must live outside experimentsRoot ${JSON.stringify(config.experimentsRoot)}`)
  }
  if (!Number.isInteger(config.killGraceMs) || config.killGraceMs < 1) {
    throw invalid(`killGraceMs must be a positive finite integer, got ${String(config.killGraceMs)}`)
  }
  assertSandboxRootsAbsolute(config.sandbox ?? DEFAULT_SANDBOX_CONFIG)
  return config
}
