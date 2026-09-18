/**
 * Task controller: the serialized owner of one self-development task's
 * lifecycle. Every mutating call is a trusted-host operation carrying an
 * expected revision and an idempotency key; the controller validates the full
 * state transition before any durable append, commits each event durably
 * before the requested side effect starts, runs the side effect outside the
 * serialized section, and refuses all operations once a journal write ended
 * in an ambiguous durable outcome or the task is in handoff.
 * @module @deepseek-ai/dsh-workflow-self-development/controller
 */

import { z as zod } from 'zod'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import {
  CAPABILITY_SOURCE_KINDS,
  REQUIRED_ATTEMPT_CAPABILITIES,
  SelfDevAttemptId,
  SelfDevOperationId,
  SelfDevelopmentError,
  SelfDevTaskId,
  TaskSpecVersion,
  digestJson,
} from './runtime.ts'
import {
  budgetApprovalSchema,
  confirmedPlanSchema,
  operationHeaderSchema,
  parseInput,
  planDraftSchema,
  taskSpecSchema,
  testResultSchema,
} from './schema.ts'
import {
  checkAttemptBudget,
  foldEvent,
  freezeTestPlan,
  initialFoldState,
  measureAttemptTime,
  validateBudgetApproval,
  verifyAttemptResult,
} from './domain.ts'
import type { JournalOptions, TaskJournal } from './journal.ts'
import type {
  Attempt,
  BudgetApproval,
  CapabilitySource,
  CapabilitySourceKind,
  CommittedRecord,
  FrozenTestPlan,
  OperationHeader,
  TaskEvent,
  TaskFoldState,
  TaskOperationResult,
  TaskProjection,
  TaskSpec,
  TestResult,
  TrustedClock,
} from './types.ts'

/** Upper bound on a failure reason stored in the journal. */
const FAILURE_REASON_MAX_CHARS = 2000

const startAttemptFieldsSchema = zod.strictObject({
  sourceDigest: zod.string().regex(/^[0-9a-f]{64}$/u, 'digest must be 64 lowercase hex characters'),
  artifactDigest: zod.string().regex(/^[0-9a-f]{64}$/u, 'digest must be 64 lowercase hex characters'),
})

/** Requests accepted by {@link SelfDevelopmentTaskController}. */
export interface ControllerRequests {
  createTask: { readonly spec: unknown }
  authorizePlanning: { readonly authorizedBy: string }
  submitPlanDraft: { readonly draft: unknown }
  confirmPlan: { readonly plan: unknown }
  approveBudget: { readonly approval: unknown }
  startAttempt: {
    readonly sourceDigest: string
    readonly artifactDigest: string
    /**
     * The side effect the host asks the controller to run for this attempt,
     * e.g. one development round performed by the future worker. The
     * controller commits `attempt/started` before invoking it and treats any
     * rejection as a consumed failed round. The callback runs outside the
     * controller's serialized section, so `stop` stays accepted while it is
     * pending, and it must honor the `AbortSignal` handed to it; a plain
     * signal is cooperative cancellation for a trusted runner, never
     * child-process supervision.
     */
    readonly sideEffect: (attempt: Attempt, signal: AbortSignal) => Promise<unknown>
    /**
     * Trusted-runner cancellation input observed by the controller. Once it
     * aborts, the pending attempt can only settle as a cancelled failure: a
     * result that arrives afterwards never records a pass. The controller
     * never creates one of these itself and never treats one as process
     * supervision.
     */
    readonly signal?: AbortSignal
  }
  stop: { readonly reason?: 'cancelled' }
  recordTrialApproval: { readonly approvedBy: string }
}

/**
 * A durable `attempt/started` commit whose side effect has not settled yet.
 * The launch keeps the attempt identity, the idempotency facts, and the
 * cancellation state that outlives the serialized start section.
 */
interface AttemptLaunch {
  readonly operation: OperationCommit
  readonly attempt: Attempt
  /** Cancellation the side effect observes; aborted by `stop` or by the trusted-runner signal. */
  readonly abort: AbortController
  readonly cancelled: () => boolean
  readonly dispose: () => void
}

/** Request identity retained across all records of one operation. */
interface OperationCommit {
  readonly id: string
  readonly payloadDigest: string
  readonly expectedRevision: number
}

/**
 * Serialized controller for one task's durable lifecycle.
 *
 * Overlapping trusted-host calls are queued: each operation checks the
 * current revision inside the serialized section, so two callers carrying
 * the same expected revision cannot both commit (compare-and-set).
 */
export class SelfDevelopmentTaskController {
  /** Idempotency records: operation id to payload digest and recorded outcome. */
  readonly #operations = new Map<string, { payloadDigest: string; result: TaskOperationResult }>()
  /** Tail of the serialized operation chain. */
  #tail: Promise<unknown> = Promise.resolve()
  /** In-flight launches by attempt id, owning the cancellation the side effect observes. */
  readonly #activeAttempts = new Map<string, { abort: AbortController }>()
  /** Latched once a journal write ended in an ambiguous durable outcome. */
  #journalRefused = false

  private constructor(
    private readonly taskId: string,
    private readonly journal: TaskJournal,
    private readonly clock: TrustedClock,
    private readonly capabilitySource: CapabilitySource | undefined,
    private state: TaskFoldState,
    records: readonly CommittedRecord[],
  ) {
    for (const record of records) {
      if (record.operation === undefined) continue
      // An operation committed by an earlier process replays only as a
      // replay: its side effect either completed or was interrupted as the
      // events show, so its outcome can never masquerade as a fresh success.
      this.#operations.set(record.operation.id, {
        payloadDigest: record.operation.payloadDigest,
        result: { revision: record.seq, replayed: true },
      })
    }
  }

  /**
   * Open (or resume) the controller for one task. Resuming folds the journal,
   * marks an in-flight attempt interrupted, freezes the time budget when the
   * interval crossed a boot session, and rebuilds a stale projection.
   * @param params.taskId - task identity the controller owns.
   * @param params.journal - opened journal for the task.
   * @param params.clock - trusted clock source.
   * @param params.capabilitySource - evidence source required to launch attempts; absence rejects launching.
   * @returns the ready controller.
   * @throws SelfDevelopmentError with `SELF_DEV_JOURNAL_UNAVAILABLE` when the journal failed verification; callers must expose handoff.
   */
  static async open(params: {
    taskId: string
    journal: TaskJournal
    clock: TrustedClock
    capabilitySource: CapabilitySource | undefined
  }): Promise<SelfDevelopmentTaskController> {
    const read = await params.journal.read()
    if (read.status !== 'ok') {
      throw new SelfDevelopmentError(
        `task journal is not intact (${read.status}): ${read.detail ?? 'unknown reason'}`,
        'SELF_DEV_JOURNAL_UNAVAILABLE',
      )
    }
    let state = initialFoldState()
    for (const record of read.records) state = foldEvent(state, record.event)
    const controller = new SelfDevelopmentTaskController(
      params.taskId, params.journal, params.clock, params.capabilitySource, state, read.records,
    )
    await controller.recoverInterruptedAttempt()
    await controller.rebuildProjection()
    return controller
  }

  /** Interrupt an attempt left in flight by a previous process, without re-running anything. */
  private async recoverInterruptedAttempt(): Promise<void> {
    if (this.state.status !== 'attempting' || this.state.currentAttempt === undefined) return
    const attempt = this.state.currentAttempt
    const { elapsedMs, timeAccounting } = measureAttemptTime(attempt.startedAt, this.clock.observe())
    await this.commit({
      type: 'attempt/failed',
      attemptId: attempt.attemptId,
      reason: 'interrupted-by-restart',
      failureDigest: digestJson('interrupted-by-restart'),
      elapsedMs,
      timeAccounting,
    })
    if (timeAccounting === 'uncertain') {
      await this.commit({
        type: 'handoff/raised',
        reason: 'clock-uncertain',
        detail: 'the interrupted attempt spanned a boot session; remaining time budget is frozen pending human review',
      })
      return
    }
    await this.commit({
      type: 'handoff/raised',
      reason: 'attempt-interrupted',
      detail: `attempt ${attempt.attemptId} was in flight when the host restarted; no side effect was re-run`,
    })
  }

  /** Rebuild the projection file when it disagrees with the folded journal. */
  private async rebuildProjection(): Promise<void> {
    const stored = await this.journal.readProjection() as { revision?: number } | undefined
    if (stored !== undefined && stored.revision === this.state.revision) return
    await this.journal.writeProjection(this.projection)
  }

  /** Current published projection: a frozen snapshot the caller cannot mutate. */
  get projection(): TaskProjection {
    const { lastDraft: _lastDraft, lastFailureDigest: _lastFailureDigest, ...snapshot } = this.state
    const projection = snapshot.trialApproval === undefined
      ? snapshot
      : { ...snapshot, trialApproval: { ...snapshot.trialApproval } }
    return deepFreeze(projection)
  }

  /** Current TaskSpec accessor used by typed callers. */
  get spec(): TaskSpec | undefined {
    return this.state.spec
  }

  /** Current frozen plan accessor used by typed callers. */
  get plan(): FrozenTestPlan | undefined {
    return this.state.plan
  }

  /**
   * Queue one mutating call behind the operations already accepted, so
   * overlapping trusted-host calls apply one at a time.
   * @param body - the serialized operation body.
   * @returns the body's result.
   */
  #enqueue<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(body, body)
    this.#tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Validate the operation header, replay semantics, and expected revision,
   * then run the operation body inside the serialized section.
   * @param method - controller method that owns the operation; part of the idempotency digest so one key cannot cross methods.
   * @param request - raw request carrying the header and the payload.
   * @param body - operation body run once the checks pass.
   * @returns the body's result, or the recorded result on exact replay.
   */
  async #execute<T>(
    method: string,
    request: OperationHeader & object,
    body: (header: ParsedOperationHeader, payloadDigest: string) => Promise<T>,
  ): Promise<T> {
    this.#assertJournalIntact()
    const header = parseInput(operationHeaderSchema, 'operation header', {
      taskId: request.taskId,
      expectedRevision: request.expectedRevision,
      operationId: request.operationId,
    })
    if (header.taskId !== this.taskId) {
      throw new SelfDevelopmentError(
        `operation addresses task ${header.taskId}, controller owns ${this.taskId}`,
        'SELF_DEV_INVALID_OPERATION',
      )
    }
    // The digest covers the method plus an explicit execution payload. The
    // side-effect callback is never part of it: a callback is a process-local
    // execution instruction, not durable replay content.
    const payloadDigest = digestJson({ method, payload: operationPayload(request) })
    const known = this.#operations.get(header.operationId)
    if (known !== undefined) {
      if (known.payloadDigest !== payloadDigest) {
        throw new SelfDevelopmentError(
          `operation ${header.operationId} was already committed with a different payload`,
          'SELF_DEV_OPERATION_PAYLOAD_MISMATCH',
        )
      }
      return { ...known.result, replayed: true } as T
    }
    if (header.expectedRevision !== this.state.revision) {
      throw new SelfDevelopmentError(
        `operation expects revision ${header.expectedRevision}, task is at revision ${this.state.revision}`,
        'SELF_DEV_REVISION_CONFLICT',
      )
    }
    const result = await body(header, payloadDigest)
    /* v8 ignore next 3 -- each operation body commits an event with its own operation id before returning. */
    if (!this.#operations.has(header.operationId)) {
      this.#operations.set(header.operationId, { payloadDigest, result: { revision: this.state.revision, replayed: false } })
    }
    return result
  }

  /** Refuse every operation once a journal write ended in an ambiguous durable outcome. */
  #assertJournalIntact(): void {
    if (!this.#journalRefused) return
    throw new SelfDevelopmentError(
      'an earlier journal write failed after an unknown amount reached the disk; the task refuses every'
        + ' operation until a human reviews the journal files and hands the task back',
      'SELF_DEV_JOURNAL_UNAVAILABLE',
    )
  }

  /**
   * Commit one event: fold it first, append only when the transition is
   * valid, then apply the fold. When the event belongs to an operation, its
   * id is remembered so an interrupted operation replays instead of
   * repeating its side effects.
   * @param event - the event to commit.
   * @param operation - id and payload digest of the owning operation, when present.
   * @throws SelfDevelopmentError with `SELF_DEV_JOURNAL_UNAVAILABLE` when the append failed: the
   *   durable outcome is ambiguous, so every later operation is refused.
   */
  private async commit(event: TaskEvent, operation?: OperationCommit): Promise<CommittedRecord> {
    this.#assertJournalIntact()
    // Validate the transition against the current state before anything
    // reaches the disk, so a rejected operation cannot poison the journal.
    const next = foldEvent(this.state, event)
    let record: CommittedRecord
    try {
      record = await this.journal.append(event, operation === undefined ? undefined : {
        id: SelfDevOperationId(operation.id),
        expectedRevision: operation.expectedRevision,
        payloadDigest: operation.payloadDigest,
      })
    } catch (error: unknown) {
      this.#journalRefused = true
      for (const active of this.#activeAttempts.values()) active.abort.abort()
      throw error
    }
    this.state = next
    if (operation !== undefined) {
      this.#operations.set(operation.id, {
        payloadDigest: operation.payloadDigest,
        result: { revision: this.state.revision, replayed: false },
      })
    }
    return record
  }

  /**
   * Commit every event one operation produced and refresh the projection.
   * The full event sequence is validated against the fold before the first
   * append, so a multi-event operation either validates completely or
   * appends nothing.
   * @param operation - id and payload digest of the owning operation.
   * @param events - events to commit in order.
   */
  private async commitEvents(
    operation: OperationCommit,
    events: readonly TaskEvent[],
  ): Promise<void> {
    let validated = this.state
    for (const event of events) validated = foldEvent(validated, event)
    for (const event of events) await this.commit(event, operation)
    await this.journal.writeProjection(this.projection)
  }

  /** Reject operations once the task reached handoff. */
  #assertNotHandoff(): void {
    if (this.state.status === 'handoff') {
      throw new SelfDevelopmentError(
        /* v8 ignore next -- the handoff/raised event schema requires a non-empty detail, so the ?? fallback never runs. */
        `task is in handoff (${this.state.handoffReason}): ${this.state.handoffDetail ?? ''}`,
        'SELF_DEV_INVALID_STATE',
      )
    }
  }

  /**
   * Create the task from a parsed, versioned TaskSpec.
   * @param request - operation header plus `spec` (wire form).
   * @returns the operation result.
   */
  createTask(request: OperationHeader & ControllerRequests['createTask']): Promise<TaskOperationResult> {
    return this.#enqueue(() => this.#execute('createTask', request, async (header, payloadDigest) => {
      if (this.state.spec !== undefined) {
        throw new SelfDevelopmentError('task already has a TaskSpec', 'SELF_DEV_INVALID_STATE')
      }
      const parsed = parseInput(taskSpecSchema, 'task spec', request.spec)
      if (parsed.taskId !== header.taskId) {
        throw new SelfDevelopmentError('spec taskId does not match the operation taskId', 'SELF_DEV_INVALID_OPERATION')
      }
      const spec: TaskSpec = deepFreeze({
        taskId: SelfDevTaskId(parsed.taskId),
        version: TaskSpecVersion(parsed.version),
        requirement: parsed.requirement,
        allowedModificationScope: parsed.allowedModificationScope,
        stableBaselineDigest: parsed.stableBaselineDigest,
        createdBy: parsed.createdBy,
      })
      await this.commitEvents({ id: header.operationId, expectedRevision: header.expectedRevision, payloadDigest }, [{ type: 'task/created', spec }])
      return { revision: this.state.revision, replayed: false }
    }))
  }

  /**
   * Grant the separate planning authorization. This never approves
   * development: it only permits drafting a plan, and it consumes no
   * development rounds.
   * @param request - operation header plus `authorizedBy`.
   * @returns the operation result.
   */
  authorizePlanning(request: OperationHeader & ControllerRequests['authorizePlanning']): Promise<TaskOperationResult> {
    return this.#enqueue(() => this.#execute('authorizePlanning', request, async (header, payloadDigest) => {
      this.#assertNotHandoff()
      const { authorizedBy } = request
      if (typeof authorizedBy !== 'string' || authorizedBy.length === 0) {
        throw new SelfDevelopmentError('authorizedBy must be a non-empty string', 'SELF_DEV_INVALID_OPERATION')
      }
      await this.commitEvents({ id: header.operationId, expectedRevision: header.expectedRevision, payloadDigest }, [{ type: 'task/planning-authorized', authorizedBy }])
      return { revision: this.state.revision, replayed: false }
    }))
  }

  /**
   * Submit a drafted plan for human confirmation.
   * @param request - operation header plus `draft` (wire form).
   * @returns the operation result.
   */
  submitPlanDraft(request: OperationHeader & ControllerRequests['submitPlanDraft']): Promise<TaskOperationResult> {
    return this.#enqueue(() => this.#execute('submitPlanDraft', request, async (header, payloadDigest) => {
      this.#assertNotHandoff()
      const draft = parseInput(planDraftSchema, 'plan draft', request.draft)
      await this.commitEvents({ id: header.operationId, expectedRevision: header.expectedRevision, payloadDigest }, [{ type: 'plan/drafted', draft }])
      return { revision: this.state.revision, replayed: false }
    }))
  }

  /**
   * Freeze the human-confirmed plan. The frozen identity binds budget
   * approvals, attempts, results, and trial approvals.
   * @param request - operation header plus `plan` (wire form).
   * @returns the operation result.
   */
  confirmPlan(request: OperationHeader & ControllerRequests['confirmPlan']): Promise<TaskOperationResult> {
    return this.#enqueue(() => this.#execute('confirmPlan', request, async (header, payloadDigest) => {
      this.#assertNotHandoff()
      const parsed = parseInput(confirmedPlanSchema, 'confirmed plan', request.plan)
      if (this.state.spec === undefined) {
        throw new SelfDevelopmentError('plan confirmation requires a TaskSpec', 'SELF_DEV_INVALID_STATE')
      }
      const plan = freezeTestPlan(parsed, this.state.spec)
      await this.commitEvents({ id: header.operationId, expectedRevision: header.expectedRevision, payloadDigest }, [{ type: 'plan/confirmed', plan }])
      return { revision: this.state.revision, replayed: false }
    }))
  }

  /**
   * Record a human budget approval, or replace the current one. Consumed
   * rounds and time are never reset; a limit already below consumption stops
   * the task immediately.
   * @param request - operation header plus `approval` (wire form).
   * @returns the operation result.
   */
  approveBudget(request: OperationHeader & ControllerRequests['approveBudget']): Promise<TaskOperationResult> {
    return this.#enqueue(() => this.#execute('approveBudget', request, async (header, payloadDigest) => {
      this.#assertNotHandoff()
      const parsed = parseInput(budgetApprovalSchema, 'budget approval', request.approval)
      if (this.state.spec === undefined || this.state.plan === undefined) {
        throw new SelfDevelopmentError('budget approval requires a TaskSpec and a frozen plan', 'SELF_DEV_INVALID_STATE')
      }
      const approval = validateBudgetApproval(parsed as BudgetApproval, this.state.spec, this.state.plan)
      const firstEvent: TaskEvent = { type: 'budget/approved', approval }
      const events: TaskEvent[] = [firstEvent]
      const after = foldEvent(this.state, firstEvent)
      if (!checkAttemptBudget(after).allowed && !after.timeBudgetFrozen) {
        events.push({ type: 'task/stopped', reason: 'budget-exhausted' })
      }
      await this.commitEvents({ id: header.operationId, expectedRevision: header.expectedRevision, payloadDigest }, events)
      return { revision: this.state.revision, replayed: false }
    }))
  }

  /**
   * Launch one development attempt. Requires capability evidence for every
   * required capability, a startable budget, and status `ready`. The
   * serialized section ends at the durable `attempt/started` commit; the
   * side effect then runs outside it, so `stop` and every other operation
   * stay accepted while the attempt is pending, and the settle step
   * re-enters the serialized section. A crash after the commit consumes the
   * round exactly once, a restart never duplicates the side effect, and a
   * cancelled or superseded attempt never records a pass.
   * @param request - operation header, source and artifact digests, the side effect, and an optional trusted-runner cancellation signal.
   * @returns the operation result of the settled attempt.
   */
  startAttempt(request: OperationHeader & ControllerRequests['startAttempt']): Promise<TaskOperationResult> {
    const externalSignal = request.signal
    const started = this.#enqueue(() => this.#execute('startAttempt', request, async (header, payloadDigest) =>
      this.#beginAttempt(header, payloadDigest, externalSignal, request)))
    return started.then(launch => isAttemptLaunch(launch)
      ? this.#runAttempt(launch, request.sideEffect)
      : launch as TaskOperationResult)
  }

  /**
   * Validate the launch and commit `attempt/started` durably. This whole
   * body runs inside the serialized section; the side effect does not.
   */
  async #beginAttempt(
    header: ParsedOperationHeader,
    payloadDigest: string,
    externalSignal: AbortSignal | undefined,
    request: OperationHeader & ControllerRequests['startAttempt'],
  ): Promise<AttemptLaunch> {
    this.#assertNotHandoff()
    if (externalSignal?.aborted) {
      throw new SelfDevelopmentError(
        'attempt launch refused: the trusted-runner cancellation signal is already aborted',
        'SELF_DEV_ATTEMPT_CANCELLED',
      )
    }
    if (this.state.status !== 'ready') {
      throw new SelfDevelopmentError(
        `attempt launch requires status ready, task is ${this.state.status}`,
        'SELF_DEV_INVALID_STATE',
      )
    }
    const capability = this.#resolveCapabilityEvidence()
    const budget = checkAttemptBudget(this.state)
    if (!budget.allowed) {
      throw new SelfDevelopmentError(`attempt launch refused: ${budget.reason}`, 'SELF_DEV_BUDGET_EXHAUSTED')
    }
    const parsed = parseInput(startAttemptFieldsSchema, 'start attempt', {
      sourceDigest: request.sourceDigest,
      artifactDigest: request.artifactDigest,
    })
    const startedAt = this.clock.observe()
    const attemptNumber = this.state.consumedRounds + 1
    const attempt: Attempt = deepFreeze({
      attemptId: SelfDevAttemptId(digestJson({
        taskId: header.taskId,
        attemptNumber,
        sourceDigest: parsed.sourceDigest,
        artifactDigest: parsed.artifactDigest,
        startedAt,
      })),
      attemptNumber,
      startedAt,
      testPlanDigest: frozenPlan(this.state).digest,
      sourceDigest: parsed.sourceDigest as Attempt['sourceDigest'],
      artifactDigest: parsed.artifactDigest as Attempt['artifactDigest'],
      capabilityDigest: capability.digest as Attempt['capabilityDigest'],
      capabilitySource: capability.source,
    })
    const operation = { id: header.operationId, expectedRevision: header.expectedRevision, payloadDigest }
    const abort = new AbortController()
    const onExternalAbort = (): void => { abort.abort() }
    const launch: AttemptLaunch = {
      operation,
      attempt,
      abort,
      cancelled: () => abort.signal.aborted,
      dispose: () => { externalSignal?.removeEventListener('abort', onExternalAbort) },
    }
    this.#activeAttempts.set(attempt.attemptId, { abort })
    if (externalSignal !== undefined) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
    try {
      await this.commit({ type: 'attempt/started', attempt }, operation)
    } catch (error: unknown) {
      this.#activeAttempts.delete(attempt.attemptId)
      launch.dispose()
      throw error
    }
    return launch
  }

  /**
   * Run the requested side effect outside the serialized section and settle
   * the attempt back inside it. The side effect observes the launch's
   * `AbortSignal`; whatever it returns can only commit while the attempt is
   * still the task's active one.
   */
  async #runAttempt(
    launch: AttemptLaunch,
    sideEffect: ControllerRequests['startAttempt']['sideEffect'],
  ): Promise<TaskOperationResult> {
    const { attempt } = launch
    let outcome: { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: unknown }
    try {
      outcome = { ok: true, result: await sideEffect(attempt, launch.abort.signal) }
    } catch (error: unknown) {
      outcome = { ok: false, error }
    }
    return this.#enqueue(() => this.#settleAttempt(launch, outcome))
  }

  /**
   * Settle a pending attempt inside the serialized section. An attempt that
   * lost ownership — a committed stop or handoff — can only report its late
   * result as diagnostic; a cancelled launch can only record a failed
   * attempt; consumed rounds and time are never refunded.
   */
  async #settleAttempt(
    launch: AttemptLaunch,
    outcome: { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: unknown },
  ): Promise<TaskOperationResult> {
    const { attempt } = launch
    // Quiescence acknowledgement: the launch stops owning a cancellation
    // handle here, after the side effect settled.
    this.#activeAttempts.delete(attempt.attemptId)
    launch.dispose()
    this.#assertJournalIntact()
    if (!attemptStillActive(this.state, attempt.attemptId)) {
      throw new SelfDevelopmentError(
        `attempt ${attempt.attemptId} is no longer the task's active attempt; its late result stays`
          + ' diagnostic and nothing was committed',
        'SELF_DEV_ATTEMPT_CANCELLED',
      )
    }
    if (launch.cancelled()) {
      await this.#recordAttemptFailure(
        launch.operation, attempt,
        new SelfDevelopmentError('cancelled by the trusted runner before completion', 'SELF_DEV_ATTEMPT_CANCELLED'),
      )
      throw new SelfDevelopmentError(
        `attempt ${attempt.attemptId} was cancelled before completion; the consumed round and time stay consumed`,
        'SELF_DEV_ATTEMPT_CANCELLED',
      )
    }
    if (!outcome.ok) {
      await this.#recordAttemptFailure(launch.operation, attempt, outcome.error)
      throw outcome.error instanceof SelfDevelopmentError
        ? outcome.error
        : new SelfDevelopmentError(`attempt ${attempt.attemptId} failed: ${message(outcome.error)}`, 'SELF_DEV_INVALID_RESULT')
    }
    try {
      return await this.#finishAttempt(launch.operation, attempt, outcome.result)
    } catch (error: unknown) {
      // A rejected result — late, misidentified, or incomplete — still
      // settles the attempt as a consumed failure, exactly once.
      if (attemptStillActive(this.state, attempt.attemptId)) {
        await this.#recordAttemptFailure(launch.operation, attempt, error)
      }
      throw error
    }
  }

  /**
   * Digest the capability evidence and require every capability to be covered
   * by an item declaring a valid source kind. The attempt's aggregate source
   * is `human-presence` when any item is human-presence evidence, otherwise
   * `machine`.
   */
  #resolveCapabilityEvidence(): { digest: string; source: CapabilitySourceKind } {
    if (this.capabilitySource === undefined) {
      throw new SelfDevelopmentError(
        `no capability evidence source is configured; required capabilities: ${REQUIRED_ATTEMPT_CAPABILITIES.join(', ')}`,
        'SELF_DEV_CAPABILITY_MISSING',
      )
    }
    const evidence = this.capabilitySource.evidence(REQUIRED_ATTEMPT_CAPABILITIES)
    const covered = new Set(evidence.map(item => item.capability))
    const missing = REQUIRED_ATTEMPT_CAPABILITIES.filter(name => !covered.has(name))
    if (missing.length > 0) {
      throw new SelfDevelopmentError(
        `capability evidence missing for: ${missing.join(', ')}`,
        'SELF_DEV_CAPABILITY_MISSING',
      )
    }
    const invalid = evidence.find(item => !CAPABILITY_SOURCE_KINDS.includes(item.source))
    if (invalid !== undefined) {
      throw new SelfDevelopmentError(
        `capability evidence for ${invalid.capability} has no valid source`,
        'SELF_DEV_CAPABILITY_MISSING',
      )
    }
    const source = evidence.some(item => item.source === 'human-presence') ? 'human-presence' : 'machine'
    return { digest: digestJson(evidence), source }
  }

  /** Verify and commit a completed attempt result. */
  async #finishAttempt(
    operation: OperationCommit,
    attempt: Attempt,
    rawResult: unknown,
  ): Promise<TaskOperationResult> {
    const { elapsedMs, timeAccounting } = measureAttemptTime(attempt.startedAt, this.clock.observe())
    const approval = approvedBudget(this.state)
    if (approval.durationMs !== undefined && timeAccounting === 'measured'
      && this.state.consumedTimeMs + elapsedMs >= approval.durationMs) {
      // A result completing at or after the deadline is late: it stays
      // diagnostic and cannot move the task to awaiting-trial.
      throw new SelfDevelopmentError(
        'attempt finished at or after the time budget deadline',
        'SELF_DEV_LATE_RESULT',
      )
    }
    const result = parseInput(testResultSchema, 'test result', rawResult) as unknown as TestResult
    const resultDigest = verifyAttemptResult({
      taskId: SelfDevTaskId(this.taskId), attempt, plan: frozenPlan(this.state), result, approval,
    })
    const events: TaskEvent[] = [{
      type: 'task/passed', attemptId: attempt.attemptId, resultDigest, elapsedMs, timeAccounting,
    }]
    if (timeAccounting === 'uncertain') {
      events.push({
        type: 'handoff/raised',
        reason: 'clock-uncertain',
        detail: 'the attempt spanned a boot session; remaining time budget is frozen pending human review',
      })
    }
    for (const event of events) await this.commit(event, operation)
    await this.journal.writeProjection(this.projection)
    return { revision: this.state.revision, replayed: false }
  }

  /** Record a failed attempt, then enforce the no-progress and budget floors. */
  async #recordAttemptFailure(
    operation: OperationCommit,
    attempt: Attempt,
    error: unknown,
  ): Promise<void> {
    const { elapsedMs, timeAccounting } = measureAttemptTime(attempt.startedAt, this.clock.observe())
    const reason = (message(error) || 'runner failed without an error message').slice(0, FAILURE_REASON_MAX_CHARS)
    await this.commit({
      type: 'attempt/failed',
      attemptId: attempt.attemptId,
      reason,
      failureDigest: digestJson(reason),
      elapsedMs,
      timeAccounting,
    }, operation)
    const events: TaskEvent[] = []
    if (timeAccounting === 'uncertain') {
      events.push({
        type: 'handoff/raised',
        reason: 'clock-uncertain',
        detail: 'the attempt spanned a boot session; remaining time budget is frozen pending human review',
      })
    } else if (this.state.approval?.noProgressAttemptLimit !== undefined
      && this.state.noProgressCount >= this.state.approval.noProgressAttemptLimit) {
      events.push({ type: 'task/stopped', reason: 'no-progress' })
    } else if (!checkAttemptBudget(this.state).allowed) {
      events.push({ type: 'task/stopped', reason: 'budget-exhausted' })
    }
    for (const event of events) await this.commit(event, operation)
    await this.journal.writeProjection(this.projection)
  }

  /**
   * Stop the task at human request. The stop commits durably while a pending
   * attempt is still running, and the pending attempt's cancellation handle
   * aborts so its side effect can quiesce; a result arriving afterwards stays
   * diagnostic and cannot flip the task into `awaiting-trial`. Consumed
   * rounds and time are never refunded.
   * @param request - operation header plus an optional `reason`.
   * @returns the operation result.
   */
  stop(request: OperationHeader & ControllerRequests['stop']): Promise<TaskOperationResult> {
    return this.#enqueue(() => this.#execute('stop', request, async (header, payloadDigest) => {
      this.#assertNotHandoff()
      const pending = this.state.status === 'attempting' ? this.state.currentAttempt : undefined
      try {
        await this.commitEvents({ id: header.operationId, expectedRevision: header.expectedRevision, payloadDigest }, [{ type: 'task/stopped', reason: request.reason ?? 'cancelled' }])
      } finally {
        if (pending !== undefined) this.#activeAttempts.get(pending.attemptId)?.abort.abort()
      }
      return { revision: this.state.revision, replayed: false }
    }))
  }

  /**
   * Record a human trial approval bound to the current verified result. Any
   * later attempt or plan change invalidates it. No upgrade path exists in
   * this increment: consumers read the recorded approval, nothing activates.
   * @param request - operation header plus `approvedBy`.
   * @returns the operation result.
   */
  recordTrialApproval(request: OperationHeader & ControllerRequests['recordTrialApproval']): Promise<TaskOperationResult> {
    return this.#enqueue(() => this.#execute('recordTrialApproval', request, async (header, payloadDigest) => {
      this.#assertNotHandoff()
      const { approvedBy } = request
      if (typeof approvedBy !== 'string' || approvedBy.length === 0) {
        throw new SelfDevelopmentError('approvedBy must be a non-empty string', 'SELF_DEV_INVALID_OPERATION')
      }
      if (this.state.verifiedResultDigest === undefined) {
        throw new SelfDevelopmentError('no verified result is waiting for trial', 'SELF_DEV_INVALID_STATE')
      }
      await this.commitEvents({ id: header.operationId, expectedRevision: header.expectedRevision, payloadDigest }, [{
        type: 'trial/approved',
        approvedBy,
        resultDigest: this.state.verifiedResultDigest,
      }])
      return { revision: this.state.revision, replayed: false }
    }))
  }
}

/** Header as parsed from the wire: ids are plain strings until the domain brands them. */
type ParsedOperationHeader = {
  taskId: string
  expectedRevision: number
  operationId: string
}

/** The frozen plan every launched attempt binds; the fold guarantees it exists. */
function frozenPlan(state: TaskFoldState): FrozenTestPlan {
  if (state.plan === undefined) throw new SelfDevelopmentError('frozen plan is missing', 'SELF_DEV_INVALID_STATE')
  return state.plan
}

/** The approval every launched attempt binds; the fold guarantees it exists. */
function approvedBudget(state: TaskFoldState): BudgetApproval {
  /* v8 ignore next -- the fold guarantees attempting and ready states carry an approval, so this narrowing guard never fires. */
  if (state.approval === undefined) throw new SelfDevelopmentError('budget approval is missing', 'SELF_DEV_INVALID_STATE')
  return state.approval
}

/** Strip the header and the execution-only fields from an operation request, leaving the durable payload to digest. */
function operationPayload(request: OperationHeader & object): Record<string, unknown> {
  const { taskId: _taskId, expectedRevision: _expectedRevision, operationId: _operationId,
    sideEffect: _sideEffect, signal: _signal, ...payload } = request as OperationHeader & Record<string, unknown>
  return payload
}

/**
 * Whether the attempt is still the one the fold state has in flight. The
 * state reads through a parameter so call-site narrowing cannot hide that an
 * awaited callee may have committed a terminal event.
 */
function attemptStillActive(state: TaskFoldState, attemptId: Attempt['attemptId']): boolean {
  return state.status === 'attempting' && state.currentAttempt?.attemptId === attemptId
}

/** Whether a resolved start serialized section produced a launch rather than a recorded replay. */
function isAttemptLaunch(value: unknown): value is AttemptLaunch {
  return typeof value === 'object' && value !== null && 'attempt' in value && 'abort' in value
}

/** Human-readable message of an unknown thrown value. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Re-exported for consumers that need the journal options type with the controller. */
export type { JournalOptions }
