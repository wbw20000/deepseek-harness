/**
 * Operation-bound launch records: the recoverable, operation-bound record of
 * one supervised launch's inputs, published under
 * `<evidenceRoot>/tasks/<taskId>/launches/<operationId>.json`. Rule 7 of the
 * safety revision: retries must replay the recorded launch inputs instead of
 * recomputing them, so the record is written once and read back validated.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/launch-record
 */

import { isAbsolute, join } from 'node:path'
import { validateTaskId } from '@deepseek-ai/dsh-workflow-self-development'
import type { ClockObservation } from '@deepseek-ai/dsh-workflow-self-development'
import { readDurableJson, writeDurableJson } from './durable-json.ts'
import { HumanPresenceCapabilitySource } from './presence.ts'
import type { PresenceConfirmation } from './presence.ts'
import { SelfDevelopmentRunnerError } from './runtime.ts'
import type { AttemptBudget } from './types.ts'

/** Matches the operation ids a launch record may be filed under. */
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Matches the sha-256 hex digests recorded on a launch record. */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** Schema version of the launch record file format. */
const LAUNCH_RECORD_SCHEMA_VERSION = 1

/**
 * The recorded, operation-bound launch inputs of one supervised attempt.
 * Retries read this record back instead of recomputing launch inputs, so an
 * idempotent payload cannot drift when development changed the worktree.
 */
export interface LaunchRecord {
  /** File format version; readers refuse records they do not understand. */
  readonly schemaVersion: 1
  /** Task the launch belongs to; also the second path component under `evidenceRoot`. */
  readonly taskId: string
  /** Operation the launch is bound to; also the file name stem. */
  readonly operationId: string
  /** Non-negative task revision the launch expects. */
  readonly expectedRevision: number
  /** realpath of the experiment worktree the launch runs in. */
  readonly worktreeReal: string
  /** Worktree-relative artifact paths, deduplicated ascending. */
  readonly artifactPaths: readonly string[]
  /** Absolute stable-side acceptance definition path. */
  readonly acceptancePath: string
  /** sha-256 hex digest of the acceptance definition bytes. */
  readonly acceptanceDefinitionDigest: string
  /** sha-256 hex digest of the frozen test plan. */
  readonly testPlanDigest: string
  /** sha-256 hex digest of the launch's source snapshot. */
  readonly sourceDigest: string
  /** sha-256 hex digest of the launch's built artifact. */
  readonly artifactDigest: string
  /** Finite limits the attempt runs under; absent approvals carry `undefined`. */
  readonly budget: AttemptBudget
  /** The human confirmation captured at launch. */
  readonly presence: PresenceConfirmation
  /** Trusted clock observation at the moment the record was written. */
  readonly recordedAt: ClockObservation
}

/**
 * Build the invalid-record error for this module.
 * @param detail - human-readable rejection reason.
 * @param cause - original failure when the rejection wraps one.
 * @returns the boundary error with `SELF_DEV_RUNNER_EVIDENCE_INVALID`.
 */
function invalid(detail: string, cause?: unknown): SelfDevelopmentRunnerError {
  const error = new SelfDevelopmentRunnerError(`launch record is invalid: ${detail}`, 'SELF_DEV_RUNNER_EVIDENCE_INVALID')
  if (cause !== undefined) error.cause = cause
  return error
}

/**
 * Validate a task id through the core package's grammar and reclassify the
 * rejection at this boundary.
 * @param taskId - raw task identifier, as read from a record or handed in.
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
 * Validate an operation id against the launch-record grammar.
 * @param operationId - raw operation identifier, as read from a record or handed in.
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
 * Validate one sha-256 hex digest field.
 * @param value - digest as read from a record.
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
 * Validate one worktree-relative artifact path. Only plain segments are
 * accepted: an absolute path or an empty, dot, or dot-dot segment would widen
 * the recorded artifact set beyond what was confirmed.
 * @param value - one entry of `artifactPaths`.
 * @returns the same path once proven relative and plain.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the entry is
 *   not a non-empty string, is absolute, or carries an empty, dot, or dot-dot
 *   segment.
 */
function validArtifactPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)
    || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw invalid(`artifactPaths entry ${JSON.stringify(value)} must be a relative path without empty, dot, or dot-dot segments`)
  }
  return value
}

/**
 * Validate the artifact path list: plain relative entries, deduplicated,
 * ascending.
 * @param value - `artifactPaths` as read from a record.
 * @returns an owned copy of the validated list.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the value is
 *   not an array of plain relative paths in deduplicated ascending order.
 */
function validArtifactPaths(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalid(`artifactPaths ${JSON.stringify(value)} must be an array`)
  const paths = value.map(entry => validArtifactPath(entry))
  const sorted = [...paths].sort()
  if (new Set(paths).size !== paths.length || paths.some((entry, index) => entry !== sorted[index])) {
    throw invalid('artifactPaths must be deduplicated and ascending')
  }
  return paths
}

/**
 * Validate one budget field: a non-negative finite number or absent.
 * @param value - one budget field as read from a record.
 * @param field - field name for the rejection message.
 * @returns the same number, or `undefined` when absent.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the value is
 *   present and not a non-negative finite number.
 */
function validBudgetField(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalid(`budget.${field} ${JSON.stringify(value)} must be a non-negative finite number or absent`)
  }
  return value
}

/**
 * Validate the recorded budget.
 * @param value - `budget` as read from a record.
 * @returns an owned copy of the validated budget.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the value is
 *   not an object whose three fields are each a non-negative finite number or
 *   absent.
 */
function validBudget(value: unknown): AttemptBudget {
  if (typeof value !== 'object' || value === null) throw invalid(`budget ${JSON.stringify(value)} must be an object`)
  const budget = value as Record<string, unknown>
  return {
    phaseMs: validBudgetField(budget.phaseMs, 'phaseMs'),
    totalRemainingMs: validBudgetField(budget.totalRemainingMs, 'totalRemainingMs'),
    maxSteps: validBudgetField(budget.maxSteps, 'maxSteps'),
  }
}

/**
 * Validate the recorded human confirmation by constructing the capability
 * source from it: only confirmations the source accepts are legal here.
 * @param value - `presence` as read from a record.
 * @returns an owned copy of the validated confirmation.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the
 *   `HumanPresenceCapabilitySource` constructor rejects the confirmation.
 */
function validPresence(value: unknown): PresenceConfirmation {
  let presence: PresenceConfirmation
  try {
    new HumanPresenceCapabilitySource(value)
    presence = value as PresenceConfirmation
  } catch (error) {
    throw invalid('presence must be a constructible human-presence confirmation', error)
  }
  return {
    confirmedBy: presence.confirmedBy,
    confirmedAt: { bootId: presence.confirmedAt.bootId, monotonicMs: presence.confirmedAt.monotonicMs },
    worktree: presence.worktree,
    loopbackAllowlist: [...presence.loopbackAllowlist],
    acknowledgement: presence.acknowledgement,
    taskId: presence.taskId,
    testPlanDigest: presence.testPlanDigest,
    acceptanceDefinitionDigest: presence.acceptanceDefinitionDigest,
    artifactPaths: [...presence.artifactPaths],
  }
}

/**
 * Validate the recorded clock observation.
 * @param value - `recordedAt` as read from a record.
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
 * Validate one absolute path field.
 * @param value - field value as read from a record.
 * @param field - field name for the rejection message.
 * @returns the same path once proven absolute.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the value is
 *   not an absolute path string.
 */
function requireAbsolute(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw invalid(`${field} ${JSON.stringify(value)} must be an absolute path`)
  }
  return value
}

/**
 * Validate one non-negative integer field.
 * @param value - field value as read from a record.
 * @param field - field name for the rejection message.
 * @returns the same number once proven a non-negative integer.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the value is
 *   not a non-negative integer.
 */
function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid(`${field} ${JSON.stringify(value)} must be a non-negative integer`)
  }
  return value
}

/**
 * Validate a raw decoded launch record and build an owned copy. Every field
 * is checked; the caller never receives the unvalidated input.
 * @param value - decoded JSON as read from disk.
 * @returns a newly constructed validated record.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when any field
 *   fails its validation.
 */
function parseLaunchRecord(value: unknown): LaunchRecord {
  if (typeof value !== 'object' || value === null) throw invalid('record must be an object')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== LAUNCH_RECORD_SCHEMA_VERSION) {
    throw invalid(`schemaVersion ${JSON.stringify(record.schemaVersion)} must be ${LAUNCH_RECORD_SCHEMA_VERSION}`)
  }
  return {
    schemaVersion: LAUNCH_RECORD_SCHEMA_VERSION,
    taskId: validTaskId(record.taskId),
    operationId: validOperationId(record.operationId),
    expectedRevision: requireNonNegativeInteger(record.expectedRevision, 'expectedRevision'),
    worktreeReal: requireAbsolute(record.worktreeReal, 'worktreeReal'),
    artifactPaths: validArtifactPaths(record.artifactPaths),
    acceptancePath: requireAbsolute(record.acceptancePath, 'acceptancePath'),
    acceptanceDefinitionDigest: validDigest(record.acceptanceDefinitionDigest, 'acceptanceDefinitionDigest'),
    testPlanDigest: validDigest(record.testPlanDigest, 'testPlanDigest'),
    sourceDigest: validDigest(record.sourceDigest, 'sourceDigest'),
    artifactDigest: validDigest(record.artifactDigest, 'artifactDigest'),
    budget: validBudget(record.budget),
    presence: validPresence(record.presence),
    recordedAt: validClockObservation(record.recordedAt),
  }
}

/**
 * File path of one launch record.
 * @param evidenceRoot - absolute stable-side evidence directory.
 * @param taskId - task the launch belongs to.
 * @param operationId - operation the launch is bound to.
 * @returns the absolute record path
 *   `<evidenceRoot>/tasks/<taskId>/launches/<operationId>.json`.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the evidence
 *   root is not absolute, the task id is not a plain path component, or the
 *   operation id does not match the operation grammar. No directory is
 *   created for an invalid id.
 */
export function launchRecordPath(evidenceRoot: string, taskId: string, operationId: string): string {
  return join(validEvidenceRoot(evidenceRoot), 'tasks', validTaskId(taskId), 'launches', `${validOperationId(operationId)}.json`)
}

/**
 * Write one launch record durably. The record is validated first; an invalid
 * record or id never creates a directory or file.
 * @param evidenceRoot - absolute stable-side evidence directory.
 * @param record - launch record to publish.
 * @returns `'written'` when the record was published, `'unchanged'` when the
 *   identical record was already present.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the evidence
 *   root, ids, or record structure fail validation, `SELF_DEV_RUNNER_EVIDENCE_CONFLICT` when the
 *   path already holds different bytes, or `SELF_DEV_RUNNER_EVIDENCE_FAILED` when the durable
 *   write fails.
 */
export async function writeLaunchRecord(evidenceRoot: string, record: LaunchRecord): Promise<'written' | 'unchanged'> {
  validEvidenceRoot(evidenceRoot)
  validTaskId(record.taskId)
  validOperationId(record.operationId)
  const validated = parseLaunchRecord(record)
  return writeDurableJson(launchRecordPath(evidenceRoot, validated.taskId, validated.operationId), validated)
}

/**
 * Read one launch record and validate it strictly. A missing file is not an
 * error; a present but invalid file is.
 * @param evidenceRoot - absolute stable-side evidence directory.
 * @param taskId - task the launch belongs to.
 * @param operationId - operation the launch is bound to.
 * @returns a newly constructed validated record, or `undefined` when no
 *   record exists at the path.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_EVIDENCE_INVALID` when the evidence
 *   root or ids are invalid, or when the stored file cannot be read as JSON or
 *   fails validation (including a stored task or operation id that differs
 *   from the addressed one).
 */
export async function readLaunchRecord(evidenceRoot: string, taskId: string, operationId: string): Promise<LaunchRecord | undefined> {
  const path = launchRecordPath(evidenceRoot, taskId, operationId)
  const raw = await readDurableJson(path)
  if (raw === undefined) return undefined
  const record = parseLaunchRecord(raw)
  if (record.taskId !== taskId) throw invalid(`stored taskId ${JSON.stringify(record.taskId)} does not match the addressed ${JSON.stringify(taskId)}`)
  if (record.operationId !== operationId) {
    throw invalid(`stored operationId ${JSON.stringify(record.operationId)} does not match the addressed ${JSON.stringify(operationId)}`)
  }
  return record
}
