/**
 * Attempt evidence: the durable record of what one supervised attempt tested
 * and how it ended, published under
 * `<evidenceRoot>/tasks/<taskId>/attempts/<attemptId>.json` with the terminal
 * decision beside it as `<attemptId>.outcome.json`. Evidence without an
 * outcome file is a diagnostic record only: it never asserts that the core
 * log passed.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/evidence
 */

import { isAbsolute, join } from 'node:path'
import { validateTaskId } from '@deepseek-ai/dsh-workflow-self-development'
import type { ClockObservation, PhaseRun, TestResult } from '@deepseek-ai/dsh-workflow-self-development'
import { readDurableJson, writeDurableJson } from './durable-json.ts'
import type { AcceptanceRun } from './acceptor.ts'
import type { ExecutorRun } from './executor.ts'
import { SelfDevelopmentRunnerError } from './runtime.ts'

/** Matches the sha-256 hex attempt ids a launch produces. */
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{64}$/

/** Matches the operation ids a launch record may be filed under. */
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Matches the sha-256 hex digests recorded on attempt evidence. */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** Terminal decisions an attempt outcome may record. */
const OUTCOME_COMMITTED = ['passed', 'failed', 'cancelled', 'late', 'unknown'] as const

/** Schema version of the attempt evidence and outcome file format. */
const EVIDENCE_SCHEMA_VERSION = 1

/** Digest pair that names one content identity: the tested source and artifact. */
export interface DigestPair {
  /** sha-256 hex digest of the source snapshot. */
  readonly sourceDigest: string
  /** sha-256 hex digest of the built artifact. */
  readonly artifactDigest: string
}

/**
 * Durable evidence for one attempt. `tested` records digest A taken after the
 * development phase, `afterAcceptance` digest B taken after acceptance; an
 * attempt that never reached acceptance carries `undefined` there and
 * `contentStable: false`.
 */
export interface AttemptEvidence {
  /** File format version; readers refuse evidence they do not understand. */
  readonly schemaVersion: 1
  /** Task the attempt belongs to; also the second path component. */
  readonly taskId: string
  /** sha-256 hex attempt id; also the file name stem. */
  readonly attemptId: string
  /** Operation the attempt's launch was bound to. */
  readonly operationId: string
  /** Capability source class of the launch; only human presence exists today. */
  readonly capabilitySource: 'human-presence'
  /** Launch-input identity: the digests the launch record was written with. */
  readonly launch: DigestPair
  /**
   * Sandbox status this attempt's executor and acceptance-case spawns ran
   * under: `disabled` when the deployment configured `sandbox.enabled: false`
   * or ran off `darwin` (this package's only sandbox tier), else `seatbelt`
   * with the sha-256 digest of the resolved SBPL profile text — the digest,
   * not the full profile, so evidence never carries the deployment's real
   * absolute path layout (worktree, data home, and every deny-read root)
   * off the stable host it was written on.
   */
  readonly sandbox: { readonly kind: 'disabled' } | { readonly kind: 'seatbelt'; readonly profileDigest: string }
  /** Digest A: content identity taken after the development phase ended. */
  readonly tested: DigestPair
  /** Digest B: content identity taken after acceptance, or `undefined` before acceptance. */
  readonly afterAcceptance: DigestPair | undefined
  /** Whether digest A and digest B are equal. */
  readonly contentStable: boolean
  /** sha-256 hex digest of the acceptance definition bytes. */
  readonly acceptanceDefinitionDigest: string
  /** Observed executor result of the attempt. */
  readonly executor: ExecutorRun
  /** Observed acceptance result, or `undefined` when acceptance never ran. */
  readonly acceptance: AcceptanceRun | undefined
  /** Observed phase runs in execution order. */
  readonly phases: readonly PhaseRun[]
  /** Test result the attempt produced. */
  readonly result: TestResult
  /** Trusted clock observation at the moment the evidence was written. */
  readonly recordedAt: ClockObservation
}

/**
 * Terminal decision for one attempt. Written beside the evidence only once
 * the core log has actually been judged; its presence is what lifts the
 * evidence from a diagnostic record to a decided outcome.
 */
export interface AttemptOutcome {
  /** File format version. */
  readonly schemaVersion: 1
  /** sha-256 hex attempt id the decision belongs to. */
  readonly attemptId: string
  /** Terminal decision recorded for the attempt. */
  readonly committed: 'passed' | 'failed' | 'cancelled' | 'late' | 'unknown'
  /** Task revision the attempt produced, or `undefined` when none was committed. */
  readonly revision: number | undefined
  /** Structured failure that ended the attempt, or `undefined` when it passed. */
  readonly error: { readonly code: string; readonly message: string } | undefined
}

/**
 * Build the invalid-evidence error for this module.
 * @param detail - human-readable rejection reason.
 * @param cause - original failure when the rejection wraps one.
 * @returns the boundary error with `SELF_DEV_RUNNER_EVIDENCE_INVALID`.
 */
function invalid(detail: string, cause?: unknown): SelfDevelopmentRunnerError {
  const error = new SelfDevelopmentRunnerError(`attempt evidence is invalid: ${detail}`, 'SELF_DEV_RUNNER_EVIDENCE_INVALID')
  if (cause !== undefined) error.cause = cause
  return error
}

/**
 * Validate a task id through the core package's grammar and reclassify the
 * rejection at this boundary.
 * @param taskId - raw task identifier, as read from evidence or handed in.
 * @returns the same id once proven a plain path component.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the value is
 *   not a string or the core `validateTaskId` rejects the id.
 */
function validTaskId(taskId: unknown): string {
  if (typeof taskId !== 'string') throw invalid(`taskId ${JSON.stringify(taskId)} must be a string`)
  try {
    validateTaskId(taskId)
  } catch (error) {
    throw invalid(`taskId ${JSON.stringify(taskId)} is not a valid task id`, error)
  }
  return taskId
}

/**
 * Validate an attempt id against the sha-256 hex grammar.
 * @param attemptId - raw attempt identifier, as read from evidence or handed in.
 * @returns the same id once proven lowercase sha-256 hex.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the value is
 *   not a string of 64 lowercase hex characters.
 */
function validAttemptId(attemptId: unknown): string {
  if (typeof attemptId !== 'string' || !ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw invalid(`attemptId ${JSON.stringify(attemptId)} must be lowercase sha-256 hex`)
  }
  return attemptId
}

/**
 * Validate an absolute evidence root before any path is derived from it.
 * @param evidenceRoot - evidence directory as handed in.
 * @returns the same root once proven absolute.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the root is
 *   not an absolute path.
 */
function validEvidenceRoot(evidenceRoot: string): string {
  if (!isAbsolute(evidenceRoot)) {
    throw invalid(`evidenceRoot ${JSON.stringify(evidenceRoot)} must be an absolute path`)
  }
  return evidenceRoot
}

/**
 * Validate an operation id against the launch-record grammar.
 * @param operationId - raw operation identifier, as read from evidence.
 * @returns the same id once proven well-formed.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the value is
 *   not a string matching the operation grammar.
 */
function validOperationId(operationId: unknown): string {
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
    throw invalid(`operationId ${JSON.stringify(operationId)} must match ${OPERATION_ID_PATTERN.source}`)
  }
  return operationId
}

/**
 * Validate one sha-256 hex digest field.
 * @param value - digest as read from evidence.
 * @param field - field name for the rejection message.
 * @returns the same digest once proven lowercase sha-256 hex.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the value is
 *   not a string of 64 lowercase hex characters.
 */
function validDigest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw invalid(`${field} ${JSON.stringify(value)} must be lowercase sha-256 hex`)
  }
  return value
}

/**
 * Validate one digest pair.
 * @param value - pair as read from evidence.
 * @param field - field name for the rejection message.
 * @returns an owned copy of the validated pair.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the value is
 *   not an object carrying two lowercase sha-256 hex digests.
 */
function validDigestPair(value: unknown, field: string): DigestPair {
  if (typeof value !== 'object' || value === null) throw invalid(`${field} ${JSON.stringify(value)} must be a digest pair`)
  const pair = value as Record<string, unknown>
  return {
    sourceDigest: validDigest(pair.sourceDigest, `${field}.sourceDigest`),
    artifactDigest: validDigest(pair.artifactDigest, `${field}.artifactDigest`),
  }
}

/**
 * Validate one optional digest pair.
 * @param value - pair or `undefined`/missing key as read from evidence.
 * @param field - field name for the rejection message.
 * @returns an owned copy of the validated pair, or `undefined`.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the value is
 *   present and not a valid digest pair.
 */
function validOptionalDigestPair(value: unknown, field: string): DigestPair | undefined {
  return value === undefined ? undefined : validDigestPair(value, field)
}

/**
 * Validate the recorded sandbox status.
 * @param value - `sandbox` as read from evidence.
 * @returns an owned copy of the validated record.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the value is not
 *   `{ kind: 'disabled' }` or `{ kind: 'seatbelt', profileDigest: <sha-256 hex> }`.
 */
function validSandboxRecord(value: unknown): AttemptEvidence['sandbox'] {
  if (typeof value !== 'object' || value === null) throw invalid(`sandbox ${JSON.stringify(value)} must be an object`)
  const record = value as Record<string, unknown>
  if (record.kind === 'disabled') return { kind: 'disabled' }
  if (record.kind === 'seatbelt') return { kind: 'seatbelt', profileDigest: validDigest(record.profileDigest, 'sandbox.profileDigest') }
  throw invalid(`sandbox.kind ${JSON.stringify(record.kind)} must be 'disabled' or 'seatbelt'`)
}

/**
 * Validate the recorded clock observation.
 * @param value - `recordedAt` as read from evidence.
 * @returns an owned copy of the validated observation.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the value is
 *   not a trusted clock observation shape.
 */
function validClockObservation(value: unknown): ClockObservation {
  if (typeof value !== 'object' || value === null) {
    throw invalid(`recordedAt ${JSON.stringify(value)} must be a clock observation`)
  }
  const observation = value as Record<string, unknown>
  if (typeof observation.bootId !== 'string' || !DIGEST_PATTERN.test(observation.bootId)) {
    throw invalid(`recordedAt.bootId ${JSON.stringify(observation.bootId)} must be lowercase sha-256 hex`)
  }
  if (typeof observation.monotonicMs !== 'number' || !Number.isInteger(observation.monotonicMs) || observation.monotonicMs < 0) {
    throw invalid(`recordedAt.monotonicMs ${JSON.stringify(observation.monotonicMs)} must be a non-negative integer`)
  }
  return { bootId: observation.bootId, monotonicMs: observation.monotonicMs }
}

/**
 * Validate one phase run entry.
 * @param value - one entry of `phases`.
 * @returns an owned copy of the validated phase run.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the entry is
 *   not an object with a non-empty `phaseId` and a non-negative finite
 *   `durationMs`.
 */
function validPhaseRun(value: unknown): PhaseRun {
  if (typeof value !== 'object' || value === null) throw invalid(`phases entry ${JSON.stringify(value)} must be a phase run`)
  const phase = value as Record<string, unknown>
  if (typeof phase.phaseId !== 'string' || phase.phaseId.length === 0) {
    throw invalid(`phases entry phaseId ${JSON.stringify(phase.phaseId)} must be a non-empty string`)
  }
  if (typeof phase.durationMs !== 'number' || !Number.isFinite(phase.durationMs) || phase.durationMs < 0) {
    throw invalid(`phases entry durationMs ${JSON.stringify(phase.durationMs)} must be a non-negative finite number`)
  }
  return { phaseId: phase.phaseId, durationMs: phase.durationMs }
}

/**
 * Validate a raw decoded attempt evidence and build an owned copy. `executor`,
 * `acceptance`, and `result` are only required to be objects; their inner
 * contracts belong to the executor and acceptor modules.
 * @param value - decoded JSON as read from disk.
 * @returns a newly constructed validated evidence.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when any field
 *   fails its validation.
 */
function parseAttemptEvidence(value: unknown): AttemptEvidence {
  if (typeof value !== 'object' || value === null) throw invalid('evidence must be an object')
  const evidence = value as Record<string, unknown>
  if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw invalid(`schemaVersion ${JSON.stringify(evidence.schemaVersion)} must be ${EVIDENCE_SCHEMA_VERSION}`)
  }
  if (evidence.capabilitySource !== 'human-presence') {
    throw invalid(`capabilitySource ${JSON.stringify(evidence.capabilitySource)} must be 'human-presence'`)
  }
  if (typeof evidence.contentStable !== 'boolean') {
    throw invalid(`contentStable ${JSON.stringify(evidence.contentStable)} must be a boolean`)
  }
  for (const field of ['executor', 'result'] as const) {
    if (typeof evidence[field] !== 'object' || evidence[field] === null) {
      throw invalid(`${field} must be an object`)
    }
  }
  if (evidence.acceptance !== undefined && (typeof evidence.acceptance !== 'object' || evidence.acceptance === null)) {
    throw invalid('acceptance must be an object or undefined')
  }
  if (!Array.isArray(evidence.phases)) throw invalid(`phases ${JSON.stringify(evidence.phases)} must be an array`)
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    taskId: validTaskId(evidence.taskId),
    attemptId: validAttemptId(evidence.attemptId),
    operationId: validOperationId(evidence.operationId),
    capabilitySource: 'human-presence',
    launch: validDigestPair(evidence.launch, 'launch'),
    sandbox: validSandboxRecord(evidence.sandbox),
    tested: validDigestPair(evidence.tested, 'tested'),
    afterAcceptance: validOptionalDigestPair(evidence.afterAcceptance, 'afterAcceptance'),
    contentStable: evidence.contentStable,
    acceptanceDefinitionDigest: validDigest(evidence.acceptanceDefinitionDigest, 'acceptanceDefinitionDigest'),
    executor: evidence.executor as ExecutorRun,
    acceptance: evidence.acceptance as AcceptanceRun | undefined,
    phases: evidence.phases.map(entry => validPhaseRun(entry)),
    result: evidence.result as TestResult,
    recordedAt: validClockObservation(evidence.recordedAt),
  }
}

/**
 * Validate a raw decoded attempt outcome and build an owned copy.
 * @param value - decoded JSON as read from disk.
 * @returns a newly constructed validated outcome.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when any field
 *   fails its validation.
 */
function parseAttemptOutcome(value: unknown): AttemptOutcome {
  if (typeof value !== 'object' || value === null) throw invalid('outcome must be an object')
  const outcome = value as Record<string, unknown>
  if (outcome.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw invalid(`schemaVersion ${JSON.stringify(outcome.schemaVersion)} must be ${EVIDENCE_SCHEMA_VERSION}`)
  }
  if (typeof outcome.committed !== 'string' || !(OUTCOME_COMMITTED as readonly string[]).includes(outcome.committed)) {
    throw invalid(`committed ${JSON.stringify(outcome.committed)} must be one of ${OUTCOME_COMMITTED.join(', ')}`)
  }
  let failure: AttemptOutcome['error'] = undefined
  if (outcome.error !== undefined) {
    const candidate = outcome.error
    if (typeof candidate !== 'object' || candidate === null
      || typeof (candidate as Record<string, unknown>).code !== 'string'
      || typeof (candidate as Record<string, unknown>).message !== 'string') {
      throw invalid('error must be an object with string code and message, or undefined')
    }
    failure = candidate as { readonly code: string; readonly message: string }
  }
  let revision: number | undefined = undefined
  if (outcome.revision !== undefined) {
    const candidate = outcome.revision
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0) {
      throw invalid(`revision ${JSON.stringify(outcome.revision)} must be a non-negative integer or undefined`)
    }
    revision = candidate
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    attemptId: validAttemptId(outcome.attemptId),
    committed: outcome.committed as AttemptOutcome['committed'],
    revision,
    error: failure,
  }
}

/**
 * File path of one attempt's evidence file.
 * @param evidenceRoot - absolute stable-side evidence directory.
 * @param taskId - task the attempt belongs to.
 * @param attemptId - sha-256 hex attempt id.
 * @returns the absolute evidence path
 *   `<evidenceRoot>/tasks/<taskId>/attempts/<attemptId>.json`.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the evidence
 *   root is not absolute, the task id is not a plain path component, or the
 *   attempt id is not sha-256 hex. No directory is created for an invalid id.
 */
export function attemptEvidencePath(evidenceRoot: string, taskId: string, attemptId: string): string {
  return join(validEvidenceRoot(evidenceRoot), 'tasks', validTaskId(taskId), 'attempts', `${validAttemptId(attemptId)}.json`)
}

/**
 * File path of one attempt's outcome file.
 * @param evidenceRoot - absolute stable-side evidence directory.
 * @param taskId - task the attempt belongs to.
 * @param attemptId - sha-256 hex attempt id.
 * @returns the absolute outcome path
 *   `<evidenceRoot>/tasks/<taskId>/attempts/<attemptId>.outcome.json`.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` under the same
 *   conditions as `attemptEvidencePath`.
 */
function attemptOutcomePath(evidenceRoot: string, taskId: string, attemptId: string): string {
  return attemptEvidencePath(evidenceRoot, taskId, attemptId).replace(/\.json$/u, '.outcome.json')
}

/**
 * Write one attempt's evidence durably. The evidence is validated first; an
 * invalid id or record never creates a directory or file. Writing evidence
 * alone does not decide the attempt: the outcome file does.
 * @param evidenceRoot - absolute stable-side evidence directory.
 * @param evidence - attempt evidence to publish.
 * @returns `'written'` when the evidence was published, `'unchanged'` when the
 *   identical evidence was already present.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the evidence
 *   root, ids, or structure fail validation, `SELF_DEV_RUNNER_EVIDENCE_CONFLICT` when the path
 *   already holds different bytes, or `SELF_DEV_RUNNER_EVIDENCE_FAILED` when the durable write
 *   fails.
 */
export async function writeAttemptEvidence(evidenceRoot: string, evidence: AttemptEvidence): Promise<'written' | 'unchanged'> {
  validEvidenceRoot(evidenceRoot)
  validTaskId(evidence.taskId)
  validAttemptId(evidence.attemptId)
  const validated = parseAttemptEvidence(evidence)
  return writeDurableJson(attemptEvidencePath(evidenceRoot, validated.taskId, validated.attemptId), validated)
}

/**
 * Write one attempt's terminal outcome durably. This file is what marks the
 * evidence as decided; without it the evidence stays a diagnostic record.
 * @param evidenceRoot - absolute stable-side evidence directory.
 * @param taskId - task the attempt belongs to.
 * @param outcome - terminal decision to publish.
 * @returns `'written'` when the outcome was published, `'unchanged'` when the
 *   identical outcome was already present.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the evidence
 *   root, task id, or outcome structure fail validation, `SELF_DEV_RUNNER_EVIDENCE_CONFLICT` when
 *   the path already holds different bytes, or `SELF_DEV_RUNNER_EVIDENCE_FAILED` when the durable
 *   write fails.
 */
export async function writeAttemptOutcome(evidenceRoot: string, taskId: string, outcome: AttemptOutcome): Promise<'written' | 'unchanged'> {
  validEvidenceRoot(evidenceRoot)
  validTaskId(taskId)
  const validated = parseAttemptOutcome(outcome)
  return writeDurableJson(attemptOutcomePath(evidenceRoot, taskId, validated.attemptId), validated)
}

/**
 * Read one attempt's evidence and its outcome, validating both. Evidence
 * without an outcome file is a diagnostic record only: it does not assert
 * that the core log passed. A missing evidence file is not an error; a
 * present but invalid evidence or outcome file is.
 * @param evidenceRoot - absolute stable-side evidence directory.
 * @param taskId - task the attempt belongs to.
 * @param attemptId - sha-256 hex attempt id.
 * @returns the validated evidence with its outcome (or `undefined` when no
 *   outcome has been recorded yet), or `undefined` when no evidence exists.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the evidence
 *   root or ids are invalid, the evidence file cannot be read as JSON or fails
 *   validation, or an existing outcome file cannot be read as JSON or fails
 *   validation (including an outcome whose attempt id differs from the
 *   addressed one).
 */
export async function readAttemptEvidence(
  evidenceRoot: string,
  taskId: string,
  attemptId: string,
): Promise<{ evidence: AttemptEvidence; outcome: AttemptOutcome | undefined } | undefined> {
  const path = attemptEvidencePath(evidenceRoot, taskId, attemptId)
  const rawEvidence = await readDurableJson(path)
  if (rawEvidence === undefined) return undefined
  const evidence = parseAttemptEvidence(rawEvidence)
  if (evidence.taskId !== taskId) throw invalid(`stored taskId ${JSON.stringify(evidence.taskId)} does not match the addressed ${JSON.stringify(taskId)}`)
  if (evidence.attemptId !== attemptId) throw invalid(`stored attemptId ${JSON.stringify(evidence.attemptId)} does not match the addressed ${JSON.stringify(attemptId)}`)
  const rawOutcome = await readDurableJson(attemptOutcomePath(evidenceRoot, taskId, attemptId))
  if (rawOutcome === undefined) return { evidence, outcome: undefined }
  const outcome = parseAttemptOutcome(rawOutcome)
  if (outcome.attemptId !== attemptId) {
    throw invalid(`stored outcome attemptId ${JSON.stringify(outcome.attemptId)} does not match the addressed ${JSON.stringify(attemptId)}`)
  }
  return { evidence, outcome }
}
