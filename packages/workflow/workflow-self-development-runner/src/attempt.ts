/**
 * Supervised attempt orchestration: one human confirmation, one launch record,
 * and one `startAttempt` side effect that runs the headless executor and the
 * independent acceptor under the approved budget, publishes durable evidence,
 * and records the terminal outcome beside it. The order is fixed: state and
 * revision are judged before any digest is computed, the confirmation binds
 * the real launch facts before the launch record exists, and the launch record
 * exists before the core commits `attempt/started` — so a retry either replays
 * the recorded launch inputs or refuses to a human instead of re-deriving them.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/attempt
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  SelfDevelopmentError,
  SelfDevOperationId,
  SelfDevTaskId,
} from '@deepseek-ai/dsh-workflow-self-development'
import type {
  Attempt,
  CaseResult,
  FrozenTestPlan,
  PhaseRun,
  SelfDevelopmentTaskController,
  TaskOperationResult,
  TaskProjection,
  TestResult,
} from '@deepseek-ai/dsh-workflow-self-development'
import { checkAcceptanceCoversPlan, loadAcceptance, runAcceptance } from './acceptor.ts'
import type { AcceptanceCase, AcceptanceRun } from './acceptor.ts'
import { assertConfirmationBinds, resolveAttemptDshHome, resolveExperimentWorktree } from './binding.ts'
import { armDeadline, phaseLimitMs, planAttemptBudget } from './budget.ts'
import type { HostClock } from './clock.ts'
import { artifactDigestOf, sourceDigestOf } from './digests.ts'
import { attemptEvidencePath, writeAttemptEvidence, writeAttemptOutcome } from './evidence.ts'
import type { AttemptOutcome, DigestPair } from './evidence.ts'
import { runHeadlessExecutor } from './executor.ts'
import type { ExecutorRun } from './executor.ts'
import { readLaunchRecord, writeLaunchRecord } from './launch-record.ts'
import type { LaunchRecord } from './launch-record.ts'
import { HumanPresenceCapabilitySource } from './presence.ts'
import type { PresenceConfirmation } from './presence.ts'
import { SelfDevelopmentRunnerError } from './runtime.ts'
import type { AttemptBudget, RunnerConfig } from './types.ts'

/** One supervised attempt a caller asks this process to run. */
export interface SupervisedAttemptRequest {
  /** Task the attempt belongs to. */
  readonly taskId: string
  /** Task revision the caller observed; the launch applies only at this revision. */
  readonly expectedRevision: number
  /** Idempotency key of the launch; the same key replays the recorded launch instead of re-running. */
  readonly operationId: string
  /** Experiment worktree as handed in (never real-pathed); it must resolve inside the experiments root. */
  readonly worktree: string
  /**
   * Per-attempt data directory handed to the executor and the acceptor as the
   * child's `DSH_HOME`. Absent runs with `config.dshHome` unchanged. When
   * present it must be absolute, resolve inside the experiments root, and
   * differ from `config.dshHome` and from the worktree; it is otherwise
   * rejected with `SELF_DEV_RUNNER_WORKTREE_INVALID`.
   */
  readonly dshHome?: string
  /** Worktree-relative artifact paths the acceptance covers. */
  readonly artifactPaths: readonly string[]
  /** Absolute path of the stable-side acceptance definition; it must live outside the experiments root. */
  readonly acceptancePath: string
  /** The human confirmation captured for this launch. */
  readonly presence: PresenceConfirmation
  /** Caller cancellation signal; an aborted signal can only settle the attempt as a cancelled failure. */
  readonly signal?: AbortSignal
}

/** What one supervised attempt call left behind. */
export interface SupervisedAttemptOutcome {
  /** Core operation result, including whether the call replayed an already committed launch. */
  readonly operation: TaskOperationResult
  /** Attempt id of the side effect this process executed; `undefined` on a replay. */
  readonly attemptId: string | undefined
  /** Absolute path of the published attempt evidence; `undefined` on a replay. */
  readonly evidencePath: string | undefined
  /** Why the outcome file could not be written, or `undefined` when it was recorded. */
  readonly outcomeWriteError: { readonly code: string; readonly message: string } | undefined
}

/** Task facts a launch needs, judged from the projection before anything is written. */
interface AttemptPlan {
  /** Task the attempt belongs to. */
  readonly taskId: string
  /** Requirement text the headless executor runs under. */
  readonly requirement: string
  /** Frozen plan the attempt runs against. */
  readonly plan: FrozenTestPlan
  /** Derived finite bounds the attempt runs under. */
  readonly budget: AttemptBudget
}

/** Digests that name the content a launch was bound to. */
interface LaunchInputs {
  /** sha-256 hex digest of the launch's source snapshot. */
  readonly sourceDigest: string
  /** sha-256 hex digest of the launch's built artifact. */
  readonly artifactDigest: string
}

/** Everything one attempt execution needs, resolved before the core committed the launch. */
interface AttemptContext {
  /** Deployment configuration owning the binaries, homes, and kill grace. */
  readonly config: RunnerConfig
  /** The supervised attempt request as handed in. */
  readonly req: SupervisedAttemptRequest
  /** Task facts judged from the projection. */
  readonly plan: AttemptPlan
  /** Digests the launch record was written with. */
  readonly launch: LaunchInputs
  /** Real path of the experiment worktree. */
  readonly worktreeReal: string
  /** Real path of the data directory this attempt runs with; `config.dshHome` when the request names none. */
  readonly dshHomeReal: string
  /** sha-256 hex digest of the acceptance definition bytes. */
  readonly acceptanceDefinitionDigest: string
  /** Validated acceptance cases the acceptor runs. */
  readonly cases: readonly AcceptanceCase[]
}

/** Execution facts one attempt observed, before the core result identity is wrapped around them. */
interface AttemptExecution {
  /** Digest A: content identity taken after the development phase ended. */
  readonly tested: DigestPair
  /** Digest B: content identity taken after acceptance, or `undefined` when acceptance never ran. */
  readonly afterAcceptance: DigestPair | undefined
  /** Whether digest A and digest B are equal. */
  readonly contentStable: boolean
  /** Observed executor result of the development phase. */
  readonly executor: ExecutorRun
  /** Observed acceptance result, or `undefined` when acceptance never ran. */
  readonly acceptance: AcceptanceRun | undefined
  /** Observed phase runs in execution order. */
  readonly phases: readonly PhaseRun[]
  /** Process exit code of the attempt run. */
  readonly exitCode: number | null
  /** Terminating signal of the attempt run. */
  readonly signal: string | null
  /** Whether a deadline ended the run. */
  readonly timedOut: boolean
  /** Whether cancellation ended the run. */
  readonly cancelled: boolean
  /** Per-case assertion results the run produced. */
  readonly cases: readonly CaseResult[]
  /** Model/tool steps the executor used. */
  readonly stepsUsed: number
}

/** Execution facts plus the core result built from them. */
interface ExecutedAttempt extends AttemptExecution {
  /** The structured result handed back to the task controller. */
  readonly result: TestResult
}

/**
 * Run one supervised attempt end to end: judge the task state, bind the human
 * confirmation to the real launch facts, write or replay the launch record,
 * and let the core commit `attempt/started` before the executor and the
 * acceptor run. The executor is never started by this function outside the
 * core's side effect, and a replaying operation returns without executing
 * anything.
 * @param deps - controller owning the task, the trusted clock, and the runner configuration.
 * @param req - the supervised attempt to run.
 * @returns the core operation result with the attempt id, evidence path, and
 *   outcome write failure of this process's execution.
 * @throws SelfDevelopmentError with `SELF_DEV_INVALID_STATE` when the task is not `ready` or lacks a
 *   spec, frozen plan, or approved budget, `SELF_DEV_REVISION_CONFLICT` when `expectedRevision` does
 *   not match the projection, or whatever the core's `startAttempt` rejects with.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_WORKTREE_INVALID` or
 *   `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` when the worktree, the requested data
 *   directory, or the acceptance definition is unusable,
 *   `SELF_DEV_RUNNER_PRESENCE_MISMATCH` when the confirmation does not bind the launch facts,
 *   `SELF_DEV_RUNNER_LAUNCH_MISMATCH` when an existing launch record does not match this launch, and
 *   `SELF_DEV_RUNNER_BUDGET_INVALID` when the approved budget bounds nothing.
 */
export async function runSupervisedAttempt(
  deps: {
    readonly controller: SelfDevelopmentTaskController
    readonly clock: HostClock
    readonly config: RunnerConfig
  },
  req: SupervisedAttemptRequest,
): Promise<SupervisedAttemptOutcome> {
  const plan = preflight(deps.controller, req)
  const worktreeReal = await resolveExperimentWorktree(deps.config.experimentsRoot, req.worktree)
  const dshHomeReal = req.dshHome === undefined
    ? deps.config.dshHome
    : await resolveAttemptDshHome(deps.config, req.dshHome, worktreeReal)
  const cases = await loadAcceptance(req.acceptancePath, deps.config.experimentsRoot)
  checkAcceptanceCoversPlan(cases, plan.plan)
  const acceptanceDefinitionDigest = await acceptanceDefinitionDigestOf(req.acceptancePath)
  await assertConfirmationBinds(req.presence, {
    taskId: plan.taskId,
    worktreeReal,
    testPlanDigest: plan.plan.digest,
    acceptanceDefinitionDigest,
    artifactPaths: req.artifactPaths,
  })
  const launch = await bindLaunchInputs(deps.clock, deps.config, req, plan, worktreeReal, dshHomeReal, acceptanceDefinitionDigest)
  const context: AttemptContext = {
    config: deps.config,
    req,
    plan,
    launch,
    worktreeReal,
    dshHomeReal,
    acceptanceDefinitionDigest,
    cases,
  }
  let attemptId: string | undefined
  let evidencePath: string | undefined
  let operation: TaskOperationResult
  try {
    operation = await deps.controller.startAttempt({
      taskId: SelfDevTaskId(plan.taskId),
      expectedRevision: req.expectedRevision,
      operationId: SelfDevOperationId(req.operationId),
      sourceDigest: launch.sourceDigest,
      artifactDigest: launch.artifactDigest,
      clock: deps.clock,
      capabilitySource: new HumanPresenceCapabilitySource(req.presence),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
      sideEffect: async (attempt, signal) => {
        attemptId = attempt.attemptId
        const executed = await executeAttempt(context, attempt, signal)
        await writeAttemptEvidence(deps.config.evidenceRoot, {
          schemaVersion: 1,
          taskId: plan.taskId,
          attemptId: attempt.attemptId,
          operationId: req.operationId,
          capabilitySource: 'human-presence',
          launch: { sourceDigest: attempt.sourceDigest, artifactDigest: attempt.artifactDigest },
          tested: executed.tested,
          afterAcceptance: executed.afterAcceptance,
          contentStable: executed.contentStable,
          acceptanceDefinitionDigest,
          executor: executed.executor,
          acceptance: executed.acceptance,
          phases: executed.phases,
          result: executed.result,
          recordedAt: deps.clock.observe(),
        })
        evidencePath = attemptEvidencePath(deps.config.evidenceRoot, plan.taskId, attempt.attemptId)
        return executed.result
      },
    })
  } catch (error) {
    // The attempt already settled as a failure in the core log; the outcome
    // decision is recorded best-effort and must not replace the core's own
    // rejection, so a failed outcome write is swallowed here.
    await writeSettledOutcome(deps.config.evidenceRoot, plan.taskId, attemptId, {
      committed: committedFor(error),
      revision: undefined,
      error: { code: errorCodeOf(error), message: errorMessageOf(error) },
    })
    throw error
  }
  if (operation.replayed) {
    return { operation, attemptId: undefined, evidencePath: undefined, outcomeWriteError: undefined }
  }
  const outcomeWriteError = await writeSettledOutcome(deps.config.evidenceRoot, plan.taskId, attemptId, {
    committed: 'passed',
    revision: operation.revision,
    error: undefined,
  })
  return { operation, attemptId, evidencePath, outcomeWriteError }
}

/**
 * Judge the task state before any digest is computed or any file is written.
 * @param controller - controller owning the task.
 * @param req - the supervised attempt request carrying the expected revision.
 * @returns the task facts the launch runs under.
 * @throws SelfDevelopmentError with `SELF_DEV_INVALID_STATE` when the task is not `ready` or lacks a
 *   spec, frozen plan, or approved budget, `SELF_DEV_REVISION_CONFLICT` when `expectedRevision` does
 *   not match the projection, and `SELF_DEV_RUNNER_BUDGET_INVALID` when the approved budget bounds
 *   nothing.
 */
function preflight(controller: SelfDevelopmentTaskController, req: SupervisedAttemptRequest): AttemptPlan {
  const projection = controller.projection
  if (projection.status !== 'ready') {
    throw new SelfDevelopmentError(
      `attempt launch requires status ready, task ${req.taskId} is ${projection.status}`,
      'SELF_DEV_INVALID_STATE',
    )
  }
  if (req.expectedRevision !== projection.revision) {
    throw new SelfDevelopmentError(
      `attempt launch requires revision ${req.expectedRevision}, task ${req.taskId} is at revision ${projection.revision}`,
      'SELF_DEV_REVISION_CONFLICT',
    )
  }
  const { spec, plan, approval } = projection
  if (spec === undefined || plan === undefined || approval === undefined) {
    throw new SelfDevelopmentError(
      `attempt launch requires a spec, a frozen plan, and an approved budget; task ${req.taskId}`
        + ` is missing ${missingLaunchInputs(spec, plan, approval)}`,
      'SELF_DEV_INVALID_STATE',
    )
  }
  return {
    taskId: req.taskId,
    requirement: spec.requirement,
    plan,
    budget: planAttemptBudget(approval, projection.consumedTimeMs),
  }
}

/**
 * Name the launch inputs the projection is missing.
 * @param spec - the projected TaskSpec, or `undefined` when missing.
 * @param plan - the projected frozen plan, or `undefined` when missing.
 * @param approval - the projected budget approval, or `undefined` when missing.
 * @returns the missing input names, joined for a rejection message.
 */
function missingLaunchInputs(
  spec: TaskProjection['spec'],
  plan: FrozenTestPlan | undefined,
  approval: TaskProjection['approval'],
): string {
  const missing: string[] = []
  if (spec === undefined) missing.push('the spec')
  if (plan === undefined) missing.push('the plan')
  if (approval === undefined) missing.push('the approval')
  return missing.join(', ')
}

/**
 * Digest the raw bytes of the acceptance definition.
 * @param path - absolute path of the acceptance definition.
 * @returns the lowercase sha-256 hex digest of the file bytes.
 */
async function acceptanceDefinitionDigestOf(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Write the operation-bound launch record, or verify an existing one still
 * matches this launch. A record is written exactly once per operation; a
 * later call with the same operation id must re-run against the recorded
 * content or refuse to a human.
 * @param clock - trusted clock observing the record's `recordedAt`.
 * @param config - deployment configuration owning the evidence root.
 * @param req - the supervised attempt request.
 * @param plan - task facts judged from the projection.
 * @param worktreeReal - real path of the experiment worktree.
 * @param dshHomeReal - real path of the data directory this launch runs with.
 * @param acceptanceDefinitionDigest - digest of the acceptance definition bytes.
 * @returns the digests the launch is bound to.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_LAUNCH_MISMATCH` when an existing record
 *   does not match this launch's facts or content, `SELF_DEV_RUNNER_EVIDENCE_FAILED` when the record
 *   cannot be written, and `SELF_DEV_RUNNER_WORKTREE_INVALID` when the worktree cannot be digested.
 */
async function bindLaunchInputs(
  clock: HostClock,
  config: RunnerConfig,
  req: SupervisedAttemptRequest,
  plan: AttemptPlan,
  worktreeReal: string,
  dshHomeReal: string,
  acceptanceDefinitionDigest: string,
): Promise<LaunchInputs> {
  const sourceDigest = await sourceDigestOf(worktreeReal)
  const artifactDigest = await artifactDigestOf(worktreeReal, req.artifactPaths)
  const record = await readLaunchRecord(config.evidenceRoot, plan.taskId, req.operationId)
  if (record !== undefined) {
    assertRecordMatches(record, {
      worktreeReal,
      dshHomeReal,
      configDshHome: config.dshHome,
      acceptancePath: req.acceptancePath,
      acceptanceDefinitionDigest,
      testPlanDigest: plan.plan.digest,
      artifactPaths: req.artifactPaths,
      sourceDigest,
      artifactDigest,
    })
    return { sourceDigest, artifactDigest }
  }
  await writeLaunchRecord(config.evidenceRoot, {
    schemaVersion: 1,
    taskId: plan.taskId,
    operationId: req.operationId,
    expectedRevision: req.expectedRevision,
    worktreeReal,
    dshHomeReal,
    artifactPaths: sortedUnique(req.artifactPaths),
    acceptancePath: req.acceptancePath,
    acceptanceDefinitionDigest,
    testPlanDigest: plan.plan.digest,
    sourceDigest,
    artifactDigest,
    budget: plan.budget,
    presence: req.presence,
    recordedAt: clock.observe(),
  })
  return { sourceDigest, artifactDigest }
}

/**
 * Compare an existing launch record against the current launch. The record's
 * `expectedRevision` field records which revision the launch expected and is
 * deliberately not compared: a retry
 * after a failed attempt necessarily arrives at a higher revision, and the
 * core's replay check — which precedes its own revision check and excludes
 * the header from the payload digest — is what binds the retried operation.
 * The content facts are compared exactly: a retry either replays the recorded
 * launch inputs or refuses to a human.
 * @param record - the record read back from the evidence root.
 * @param current - the launch facts and freshly computed digests of this call.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_LAUNCH_MISMATCH` naming every field that
 *   diverged, so the launch is refused to a human instead of re-derived.
 */
function assertRecordMatches(
  record: LaunchRecord,
  current: {
    readonly worktreeReal: string
    /** Real path of the data directory this launch runs with. */
    readonly dshHomeReal: string
    /** The configured `dshHome`, which a record written before `dshHomeReal` existed is judged against. */
    readonly configDshHome: string
    readonly acceptancePath: string
    readonly acceptanceDefinitionDigest: string
    readonly testPlanDigest: string
    readonly artifactPaths: readonly string[]
    readonly sourceDigest: string
    readonly artifactDigest: string
  },
): void {
  const diverged: string[] = []
  if (record.worktreeReal !== current.worktreeReal) diverged.push('worktreeReal does not match the launched worktree')
  // Records written before the field existed carried only `config.dshHome`, so
  // an absent field is read as that configured value, never as this launch's.
  const recordedDshHomeReal = record.dshHomeReal ?? current.configDshHome
  if (recordedDshHomeReal !== current.dshHomeReal) {
    diverged.push('dshHomeReal does not match the launched data directory')
  }
  if (record.acceptancePath !== current.acceptancePath) diverged.push('acceptancePath does not match the launched definition')
  if (record.acceptanceDefinitionDigest !== current.acceptanceDefinitionDigest) {
    diverged.push('acceptanceDefinitionDigest does not match the launched definition')
  }
  if (record.testPlanDigest !== current.testPlanDigest) diverged.push('testPlanDigest does not match the launched plan')
  if (record.artifactPaths.join(',') !== sortedUnique(current.artifactPaths).join(',')) {
    diverged.push('artifactPaths do not match the launched artifact set')
  }
  if (record.sourceDigest !== current.sourceDigest) diverged.push('sourceDigest does not match the worktree content')
  if (record.artifactDigest !== current.artifactDigest) diverged.push('artifactDigest does not match the artifact content')
  if (diverged.length > 0) {
    throw new SelfDevelopmentRunnerError(
      `launch record for operation ${record.operationId} does not match this launch: ${diverged.join('; ')}`,
      'SELF_DEV_RUNNER_LAUNCH_MISMATCH',
    )
  }
}

/**
 * Deduplicate and sort worktree-relative artifact paths into the canonical
 * recorded order.
 * @param paths - artifact paths as handed in.
 * @returns the unique ascending paths.
 */
function sortedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort()
}

/**
 * Run one attempt's development and acceptance phases and build the result
 * the core verifies. The development phase runs first under its limit; the
 * acceptance phase only runs after a clean, capped, untorn development run,
 * and its own deadline aborts it without reporting an executor timeout.
 * @param context - everything the execution needs, resolved at launch.
 * @param attempt - the attempt the core committed.
 * @param signal - the attempt's cancellation signal.
 * @returns the executed facts plus the structured result.
 * @throws SelfDevelopmentRunnerError when the executor or the acceptor cannot run, or when the
 *   worktree cannot be digested after a phase.
 */
async function executeAttempt(context: AttemptContext, attempt: Attempt, signal: AbortSignal): Promise<ExecutedAttempt> {
  const developLimitMs = phaseLimitMs(context.plan.budget, 0)
  /* v8 ignore start -- planAttemptBudget refuses an unbounded or spent budget, so this limit is positive here */
  if (developLimitMs === 0) {
    return spentBudgetExecution({
      taskId: context.plan.taskId,
      attempt,
      plan: context.plan.plan,
      acceptanceDefinitionDigest: context.acceptanceDefinitionDigest,
      executor: notStartedExecutor(true),
      phases: [{ phaseId: 'develop', durationMs: 0 }],
    })
  }
  /* v8 ignore end */
  const developDeadline = armDeadline(developLimitMs, signal)
  let executor: ExecutorRun
  try {
    executor = await runHeadlessExecutor(context.config, {
      worktree: context.worktreeReal,
      task: context.plan.requirement,
      phaseTimeoutMs: developLimitMs,
      maxSteps: context.plan.budget.maxSteps,
      signal: developDeadline.signal,
      ...(context.req.dshHome === undefined ? {} : { dshHome: context.req.dshHome }),
    })
  } finally {
    developDeadline.dispose()
  }
  const phases: PhaseRun[] = [{ phaseId: 'develop', durationMs: executor.durationMs }]
  const tested = {
    sourceDigest: await sourceDigestOf(context.worktreeReal),
    artifactDigest: await artifactDigestOf(context.worktreeReal, context.req.artifactPaths),
  }
  const executorFailed = executor.exitCode !== 0 || executor.signal !== null || executor.timedOut
    || executor.cancelled || executor.stepCapHit || executor.stdoutCapHit
  if (executorFailed) {
    const execution: AttemptExecution = {
      tested,
      afterAcceptance: undefined,
      contentStable: false,
      executor,
      acceptance: undefined,
      phases,
      exitCode: executor.exitCode ?? 1,
      signal: executor.signal,
      timedOut: executor.timedOut,
      cancelled: executor.cancelled,
      cases: failedCases(context.plan.plan),
      stepsUsed: executor.stepsUsed,
    }
    return finishExecution(context, attempt, execution)
  }
  const acceptLimitMs = phaseLimitMs(context.plan.budget, executor.durationMs)
  /* v8 ignore start -- the develop deadline bounds the spend, so the accept limit is positive whenever acceptance is reached */
  if (acceptLimitMs === 0) {
    return spentBudgetExecution({
      taskId: context.plan.taskId,
      attempt,
      plan: context.plan.plan,
      acceptanceDefinitionDigest: context.acceptanceDefinitionDigest,
      executor,
      phases,
    })
  }
  /* v8 ignore end */
  const acceptDeadline = armDeadline(acceptLimitMs, signal)
  let acceptance: AcceptanceRun
  try {
    acceptance = await runAcceptance(context.config, {
      worktree: context.worktreeReal,
      cases: context.cases,
      signal: acceptDeadline.signal,
      ...(context.req.dshHome === undefined ? {} : { dshHome: context.req.dshHome }),
    })
  } finally {
    acceptDeadline.dispose()
  }
  const phasesWithAcceptance: PhaseRun[] = [...phases, { phaseId: 'accept', durationMs: acceptance.durationMs }]
  const afterAcceptance = {
    sourceDigest: await sourceDigestOf(context.worktreeReal),
    artifactDigest: await artifactDigestOf(context.worktreeReal, context.req.artifactPaths),
  }
  const contentStable = tested.sourceDigest === afterAcceptance.sourceDigest
    && tested.artifactDigest === afterAcceptance.artifactDigest
  const execution: AttemptExecution = {
    tested,
    afterAcceptance,
    contentStable,
    executor,
    acceptance,
    phases: phasesWithAcceptance,
    exitCode: contentStable ? acceptance.exitCode : 1,
    signal: acceptance.signal,
    timedOut: acceptance.timedOut || acceptDeadline.timedOut(),
    cancelled: acceptance.cancelled && !acceptDeadline.timedOut(),
    cases: acceptance.cases,
    stepsUsed: executor.stepsUsed,
  }
  return finishExecution(context, attempt, execution)
}

/** The attempt identity and launch digests a spent-budget result binds to. */
export interface SpentBudgetAttempt {
  /** Attempt the core committed. */
  readonly attemptId: string
  /** Launch-input source digest the attempt committed. */
  readonly sourceDigest: string
  /** Launch-input artifact digest the attempt committed. */
  readonly artifactDigest: string
  /** Frozen plan digest the attempt committed. */
  readonly testPlanDigest: string
}

/** Inputs of an attempt whose approved budget was spent before a phase could start. */
export interface SpentBudgetInput {
  /** Task the attempt belongs to. */
  readonly taskId: string
  /** Attempt identity and launch digests the result binds to. */
  readonly attempt: SpentBudgetAttempt
  /** Frozen plan naming the required cases and assertions. */
  readonly plan: FrozenTestPlan
  /** sha-256 hex digest of the acceptance definition bytes. */
  readonly acceptanceDefinitionDigest: string
  /** Executor facts to record; a never-started executor when development itself was refused. */
  readonly executor: ExecutorRun
  /** Phase runs observed before the budget ran out. */
  readonly phases: readonly PhaseRun[]
}

/**
 * Assemble the execution of an attempt whose approved budget was spent before
 * a phase could start: no acceptance ran, the content digests stay the
 * launch's own, every required assertion is accounted as failed, and the run
 * reports the spent limit as a timeout.
 * @param input - the attempt identity, plan, acceptance digest, executor facts, and phase runs.
 * @returns the executed facts plus the structured result.
 */
export function spentBudgetExecution(input: SpentBudgetInput): ExecutedAttempt {
  const execution: AttemptExecution = {
    tested: { sourceDigest: input.attempt.sourceDigest, artifactDigest: input.attempt.artifactDigest },
    afterAcceptance: undefined,
    contentStable: false,
    executor: input.executor,
    acceptance: undefined,
    phases: [...input.phases],
    exitCode: 1,
    signal: null,
    timedOut: true,
    cancelled: false,
    cases: failedCases(input.plan),
    stepsUsed: input.executor.stepsUsed,
  }
  const result = toTestResult({
    taskId: input.taskId,
    attempt: {
      attemptId: input.attempt.attemptId as Attempt['attemptId'],
      sourceDigest: input.attempt.sourceDigest as Attempt['sourceDigest'],
      artifactDigest: input.attempt.artifactDigest as Attempt['artifactDigest'],
      testPlanDigest: input.attempt.testPlanDigest as Attempt['testPlanDigest'],
    },
    acceptanceDefinitionDigest: input.acceptanceDefinitionDigest,
    execution,
  })
  return { ...execution, result }
}

/**
 * Executor facts for a phase that never spawned a child.
 * @param timedOut - whether the refused phase reports its spent limit as a timeout.
 * @returns an executor run with no process facts and zero steps.
 */
function notStartedExecutor(timedOut: boolean): ExecutorRun {
  return {
    exitCode: null,
    signal: null,
    timedOut,
    cancelled: false,
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

/**
 * Case results that account for every required assertion as failed: an
 * attempt that never reached acceptance has no passing evidence.
 * @param plan - the frozen plan naming the required cases and assertions.
 * @returns one all-failed case result per required case.
 */
function failedCases(plan: FrozenTestPlan): readonly CaseResult[] {
  return plan.requiredCases.map(requiredCase => ({
    caseId: requiredCase.caseId,
    assertions: requiredCase.assertionIds.map(assertionId => ({ assertionId, status: 'fail' as const })),
  }))
}

/**
 * Wrap the observed execution facts into the structured result the core
 * verifies against the attempt and the frozen plan.
 * @param context - everything the execution needed, resolved at launch.
 * @param attempt - the attempt the core committed.
 * @param execution - the observed execution facts.
 * @returns the executed facts plus the structured result.
 */
function finishExecution(context: AttemptContext, attempt: Attempt, execution: AttemptExecution): ExecutedAttempt {
  const result = toTestResult({
    taskId: context.plan.taskId,
    attempt,
    acceptanceDefinitionDigest: context.acceptanceDefinitionDigest,
    execution,
  })
  return { ...execution, result }
}

/**
 * Build the structured result one execution answers with.
 * @param input - task and attempt identity, the acceptance digest, and the observed execution facts.
 * @returns the result the core verifies against the attempt and the frozen plan.
 */
function toTestResult(input: {
  readonly taskId: string
  readonly attempt: Pick<Attempt, 'attemptId' | 'sourceDigest' | 'artifactDigest' | 'testPlanDigest'>
  readonly acceptanceDefinitionDigest: string
  readonly execution: AttemptExecution
}): TestResult {
  const { attempt, execution } = input
  return {
    taskId: SelfDevTaskId(input.taskId),
    attemptId: attempt.attemptId,
    sourceDigest: attempt.sourceDigest,
    artifactDigest: attempt.artifactDigest,
    testedSourceDigest: execution.tested.sourceDigest as TestResult['testedSourceDigest'],
    testedArtifactDigest: execution.tested.artifactDigest as TestResult['testedArtifactDigest'],
    acceptanceDefinitionDigest: input.acceptanceDefinitionDigest as TestResult['acceptanceDefinitionDigest'],
    testPlanDigest: attempt.testPlanDigest,
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    cancelled: execution.cancelled,
    cases: execution.cases,
    phases: execution.phases,
    stepsUsed: execution.stepsUsed,
  }
}

/**
 * Record one attempt's terminal outcome beside its evidence. An attempt whose
 * side effect never ran has no attempt id and no outcome; an outcome write
 * failure is returned instead of thrown so it never masks the core's own
 * decision.
 * @param evidenceRoot - absolute stable-side evidence directory.
 * @param taskId - task the attempt belongs to.
 * @param attemptId - attempt id, or `undefined` when the side effect never ran.
 * @param decision - the terminal decision to record.
 * @returns the outcome write failure, or `undefined` when the outcome was recorded.
 */
async function writeSettledOutcome(
  evidenceRoot: string,
  taskId: string,
  attemptId: string | undefined,
  decision: {
    readonly committed: AttemptOutcome['committed']
    readonly revision: number | undefined
    readonly error: AttemptOutcome['error']
  },
): Promise<SupervisedAttemptOutcome['outcomeWriteError']> {
  if (attemptId === undefined) return undefined
  try {
    await writeAttemptOutcome(evidenceRoot, taskId, {
      schemaVersion: 1,
      attemptId,
      committed: decision.committed,
      revision: decision.revision,
      error: decision.error,
    })
    return undefined
  } catch (error) {
    return { code: errorCodeOf(error), message: errorMessageOf(error) }
  }
}

/**
 * Map a core rejection to the terminal decision the outcome records.
 * @param error - the error the core settled the attempt with.
 * @returns `cancelled` for a cancelled attempt, `late` for a late result, and `failed` otherwise.
 */
function committedFor(error: unknown): AttemptOutcome['committed'] {
  const code = errorCodeOf(error)
  if (code === 'SELF_DEV_ATTEMPT_CANCELLED') return 'cancelled'
  if (code === 'SELF_DEV_LATE_RESULT') return 'late'
  return 'failed'
}

/**
 * Read the machine-routable code of a thrown value.
 * @param error - the thrown value.
 * @returns the error's code when it is a boundary error, its error class name, or `UNKNOWN`.
 */
function errorCodeOf(error: unknown): string {
  if (error instanceof SelfDevelopmentError || error instanceof SelfDevelopmentRunnerError) return error.code
  return error instanceof Error ? error.name : 'UNKNOWN'
}

/**
 * Read the message of a thrown value.
 * @param error - the thrown value.
 * @returns the error's message, or its string form when it is not an Error.
 */
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
