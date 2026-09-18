/**
 * Opt-in service exposing the self-development task-control foundation. The
 * service owns one configured private control directory, caches one
 * controller per task, and hands the trusted clock and capability evidence
 * source to every open call. It performs no development work itself: the
 * worker, verifier, and release integration are later consumers.
 * @module @deepseek-ai/dsh-workflow-self-development
 */

import { isAbsolute, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SelfDevelopmentTaskController } from './controller.ts'
import { SelfDevelopmentError, validateTaskId } from './runtime.ts'
import { TaskJournal } from './journal.ts'
import type { CapabilitySource, TaskProjection, TrustedClock } from './types.ts'

export { SelfDevelopmentTaskController } from './controller.ts'
export { TaskJournal } from './journal.ts'
export {
  ArtifactDigest,
  CapabilityDigest,
  SelfDevAttemptId,
  SelfDevelopmentError,
  SelfDevelopmentErrorCode,
  SelfDevOperationId,
  SelfDevTaskId,
  SourceDigest,
  TaskSpecVersion,
  TestPlanDigest,
  TestPlanVersion,
  TASK_JOURNAL_SCHEMA_VERSION,
  digestJson,
  validateTaskId,
} from './runtime.ts'
export {
  checkAttemptBudget,
  foldEvent,
  freezeTestPlan,
  initialFoldState,
  measureAttemptTime,
  validateBudgetApproval,
  verifyAttemptResult,
} from './domain.ts'
export type { JournalOptions } from './journal.ts'
export type {
  Attempt,
  BudgetApproval,
  CapabilityEvidence,
  CapabilitySource,
  CaseResult,
  ClockObservation,
  CommittedOperation,
  CommittedRecord,
  ConfirmedPlanInput,
  FrozenTestPlan,
  JournalReadResult,
  JournalReadStatus,
  OperationHeader,
  PhaseRun,
  RequiredCase,
  SupervisorObligations,
  TaskEvent,
  TaskFoldState,
  TaskHandoffReason,
  TaskOperationResult,
  TaskProjection,
  TaskSpec,
  TaskStatus,
  TaskStopReason,
  TestPlanDraft,
  TestResult,
  TimeAccounting,
  TrustedClock,
} from './types.ts'

/** Deployment configuration for the task-control service. */
export interface Config {
  /**
   * Private control directory this service owns, e.g. under the managed
   * installation's `control/` directory. Task journals live in
   * `<controlDirectory>/tasks/<taskId>/`.
   */
  controlDirectory: string
  /** Journal records per segment file before rotation. */
  maxRecordsPerSegment: number
  /** Committed records between protected checkpoint rewrites. */
  checkpointInterval: number
}

/** Cordis service holding the per-task controllers. */
export class SelfDevelopmentTasks extends Service {
  static inject = []

  /** Runtime schema for the service config; every field is deployment-owned. */
  static Config = z.object({
    controlDirectory: z.string().required(),
    maxRecordsPerSegment: z.number().step(1).min(1).required(),
    checkpointInterval: z.number().step(1).min(1).required(),
  }) as unknown as z<Config>

  // Cordis service shadows read state through a prototype-extended proxy, so
  // these use TypeScript privacy instead of #-private fields.
  /** Resolved deployment configuration. */
  private readonly resolved: Config

  /** Controllers by task id; the promise serializes concurrent open calls. */
  private readonly controllers = new Map<string, Promise<SelfDevelopmentTaskController>>()

  /**
   * @param ctx - owning Cordis context.
   * @param config - deployment configuration for the control directory and journal bounds.
   * @throws SelfDevelopmentError with `SELF_DEV_CONFIG_INVALID` when the control directory is not
   *   absolute or a journal bound is not a positive finite integer. Misconfiguration fails at load.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'selfDevelopmentTasks')
    this.resolved = validateConfig(config)
  }

  /**
   * Open (or resume) one task's controller against its private journal.
   * Repeated calls return the same controller.
   * @param taskId - task identity naming the journal directory.
   * @param clock - trusted clock observation source supplied by the host.
   * @param capabilitySource - capability evidence source; absence rejects attempt launches.
   * @returns the task controller.
   * @throws SelfDevelopmentError with `SELF_DEV_JOURNAL_UNAVAILABLE` when the journal failed verification; the caller must expose handoff.
   */
  open(taskId: string, clock: TrustedClock, capabilitySource?: CapabilitySource): Promise<SelfDevelopmentTaskController> {
    // The id becomes a path component; validate it before any join or mkdir.
    // A rejected promise, not a synchronous throw, keeps every caller on the
    // same await path.
    try {
      validateTaskId(taskId)
    } catch (error: unknown) {
      // validateTaskId only throws SelfDevelopmentError, so the rejection
      // forwards the boundary error type without re-wrapping.
      return Promise.reject(error)
    }
    const existing = this.controllers.get(taskId)
    if (existing !== undefined) return existing
    const created = (async () => {
      const journal = await TaskJournal.open(join(this.resolved.controlDirectory, 'tasks', taskId), {
        maxRecordsPerSegment: this.resolved.maxRecordsPerSegment,
        checkpointInterval: this.resolved.checkpointInterval,
      })
      return SelfDevelopmentTaskController.open({ taskId, journal, clock, capabilitySource })
    })().catch((error: unknown) => {
      // A refused journal stays refused until a human resolves it; drop the
      // cached promise so a later open re-verifies the files as they are.
      this.controllers.delete(taskId)
      throw error
    })
    this.controllers.set(taskId, created)
    return created
  }

  /**
   * Read a task's projection without the caller needing a controller.
   * @param taskId - task identity.
   * @param clock - trusted clock observation source supplied by the host.
   * @returns the current projection.
   */
  async state(taskId: string, clock: TrustedClock): Promise<TaskProjection> {
    const controller = await this.open(taskId, clock)
    return controller.projection
  }

  /**
   * Classify a journal rejection for callers that surface handoff state.
   * @param error - error thrown by {@link SelfDevelopmentTasks.open}.
   * @returns true when the error means the task journal refused side effects.
   */
  isJournalHandoff(error: unknown): boolean {
    return error instanceof SelfDevelopmentError && error.code === 'SELF_DEV_JOURNAL_UNAVAILABLE'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    selfDevelopmentTasks: SelfDevelopmentTasks
  }
}

export default SelfDevelopmentTasks

/**
 * Validate the deployment configuration at construction time.
 * @param config - configuration as parsed from cordis.yml.
 * @returns the same configuration once every field is proven usable.
 * @throws SelfDevelopmentError with `SELF_DEV_CONFIG_INVALID` when the control directory is not an
 *   absolute path or a journal bound is not a positive finite integer.
 */
function validateConfig(config: Config): Config {
  const invalid = (detail: string): SelfDevelopmentError =>
    new SelfDevelopmentError(`self-development service config is invalid: ${detail}`, 'SELF_DEV_CONFIG_INVALID')
  if (config.controlDirectory.length === 0 || !isAbsolute(config.controlDirectory)) {
    throw invalid(`controlDirectory ${JSON.stringify(config.controlDirectory)} must be an absolute path`)
  }
  for (const key of ['maxRecordsPerSegment', 'checkpointInterval'] as const) {
    const value = config[key]
    if (!Number.isInteger(value) || value < 1 || !Number.isFinite(value)) {
      throw invalid(`${key} must be a positive finite integer, got ${String(value)}`)
    }
  }
  return config
}
