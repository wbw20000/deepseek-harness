/**
 * Runtime constructors and constants for the self-development task-control
 * foundation: branded ids, boundary error, and canonical digests.
 * @module @deepseek-ai/dsh-workflow-self-development/runtime
 */

import { createHash } from 'node:crypto'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  ArtifactDigest,
  CapabilityDigest,
  SelfDevAttemptId,
  SelfDevOperationId,
  SelfDevTaskId,
  SourceDigest,
  TaskSpecVersion,
  TestPlanDigest,
  TestPlanVersion,
} from './types.ts'

/**
 * Schema version of the durable task journal and projection. Bumping it is a
 * format change: readers must refuse older journals instead of guessing.
 */
export const TASK_JOURNAL_SCHEMA_VERSION = 1

/** Capabilities the trusted host must establish before an attempt may launch. */
export const REQUIRED_ATTEMPT_CAPABILITIES = [
  'supervisor',
  'storage-quota',
  'sandbox-coverage',
  'external-verifier',
] as const

/** Machine-routable error codes thrown at this package's boundaries. */
export const SelfDevelopmentErrorCode = [
  'SELF_DEV_INVALID_SPEC',
  'SELF_DEV_INVALID_PLAN',
  'SELF_DEV_INVALID_BUDGET',
  'SELF_DEV_INVALID_RESULT',
  'SELF_DEV_INVALID_OPERATION',
  'SELF_DEV_REVISION_CONFLICT',
  'SELF_DEV_OPERATION_PAYLOAD_MISMATCH',
  'SELF_DEV_INVALID_STATE',
  'SELF_DEV_CAPABILITY_MISSING',
  'SELF_DEV_BUDGET_EXHAUSTED',
  'SELF_DEV_IDENTITY_MISMATCH',
  'SELF_DEV_LATE_RESULT',
  'SELF_DEV_ATTEMPT_CANCELLED',
  'SELF_DEV_JOURNAL_UNAVAILABLE',
  'SELF_DEV_CONFIG_INVALID',
] as const

/** One machine-routable task-control failure code. */
export type SelfDevelopmentErrorCode = typeof SelfDevelopmentErrorCode[number]

/** Error thrown at the self-development task-control boundary. */
export class SelfDevelopmentError extends HarnessError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  // Keep the constructor to narrow HarnessError's string code at this boundary.
  // oxlint-disable-next-line typescript/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: SelfDevelopmentErrorCode) {
    super(message, code)
  }
}

/**
 * Brand a raw string as a task id.
 * @param id - raw task identifier.
 * @returns the same string with the compile-time brand.
 */
export function SelfDevTaskId(id: string): SelfDevTaskId {
  return brandString<SelfDevTaskId>(id)
}

/**
 * Brand a raw string as an operation id.
 * @param id - raw operation identifier.
 * @returns the same string with the compile-time brand.
 */
export function SelfDevOperationId(id: string): SelfDevOperationId {
  return brandString<SelfDevOperationId>(id)
}

/**
 * Brand a raw string as an attempt id.
 * @param id - raw attempt identifier.
 * @returns the same string with the compile-time brand.
 */
export function SelfDevAttemptId(id: string): SelfDevAttemptId {
  return brandString<SelfDevAttemptId>(id)
}

/**
 * Brand a raw digest string as a source digest.
 * @param digest - raw sha-256 hex digest.
 * @returns the same string with the compile-time brand.
 */
export function SourceDigest(digest: string): SourceDigest {
  return brandString<SourceDigest>(digest)
}

/**
 * Brand a raw digest string as an artifact digest.
 * @param digest - raw sha-256 hex digest.
 * @returns the same string with the compile-time brand.
 */
export function ArtifactDigest(digest: string): ArtifactDigest {
  return brandString<ArtifactDigest>(digest)
}

/**
 * Brand a raw digest string as a test plan digest.
 * @param digest - raw sha-256 hex digest.
 * @returns the same string with the compile-time brand.
 */
export function TestPlanDigest(digest: string): TestPlanDigest {
  return brandString<TestPlanDigest>(digest)
}

/**
 * Brand a raw digest string as a capability-evidence digest.
 * @param digest - raw sha-256 hex digest.
 * @returns the same string with the compile-time brand.
 */
export function CapabilityDigest(digest: string): CapabilityDigest {
  return brandString<CapabilityDigest>(digest)
}

/**
 * Brand a raw number as a TaskSpec version.
 * @param version - raw one-based version counter.
 * @returns the same number with the compile-time brand.
 */
export function TaskSpecVersion(version: number): TaskSpecVersion {
  return brandNumber<TaskSpecVersion>(version)
}

/**
 * Brand a raw number as a test plan version.
 * @param version - raw one-based version counter.
 * @returns the same number with the compile-time brand.
 */
export function TestPlanVersion(version: number): TestPlanVersion {
  return brandNumber<TestPlanVersion>(version)
}

/**
 * Task ids become path components under the control directory, so the id
 * grammar is fixed here and enforced before any path join or `mkdir`.
 * @param id - raw task identifier.
 * @returns the same string with the compile-time brand.
 * @throws SelfDevelopmentError with `SELF_DEV_INVALID_OPERATION` when the id is not 1–64 characters
 *   of `[A-Za-z0-9]` followed by `[A-Za-z0-9._-]`: no path separators, no `..`, no escape spelling.
 */
export function validateTaskId(id: string): SelfDevTaskId {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(id)) {
    throw new SelfDevelopmentError(
      `task id ${JSON.stringify(id)} is not a plain path component (1–64 characters: letter or digit, then letters, digits, dots, underscores, or hyphens)`,
      'SELF_DEV_INVALID_OPERATION',
    )
  }
  return SelfDevTaskId(id)
}

/**
 * Digest one JSON-encodable value with sha-256. Callers digest values built
 * from this package's own types, so object key order follows construction and
 * stays stable for the same logical record.
 * @param value - JSON-encodable value to digest.
 * @returns lowercase hex sha-256 digest.
 */
export function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
