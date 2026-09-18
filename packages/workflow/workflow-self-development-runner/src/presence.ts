/**
 * Human-presence capability evidence source: turns one concrete confirmation,
 * given by a person who was present at launch, into capability evidence for
 * the task-control package's `startAttempt` contract. Each digest binds the
 * capability name to that confirmation, so the recorded evidence names a real
 * human acknowledgement and never claims unattended isolation.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/presence
 */

import { isAbsolute } from 'node:path'
import { CapabilityDigest, digestJson } from '@deepseek-ai/dsh-workflow-self-development'
import type { CapabilityEvidence, CapabilitySource, ClockObservation } from '@deepseek-ai/dsh-workflow-self-development'
import { SelfDevelopmentRunnerError } from './runtime.ts'

/** The only acknowledgement wording a supervised launch accepts. */
const SUPERVISED_ACKNOWLEDGEMENT = 'supervised-not-unattended'

/** Matches the boot ids `HostClock` derives (lowercase sha-256 hex). */
const BOOT_ID_PATTERN = /^[0-9a-f]{64}$/

/** Matches the task-control package's task id grammar: one plain path component of 1–64 characters. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

/** Matches the sha-256 hex digests the task-control package brands. */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/**
 * One concrete human confirmation captured at attempt launch. It records who
 * confirmed, when (one trusted clock observation), which experiment worktree
 * the attempt runs in, which loopback ports the session may use, and that the
 * confirmation asserts supervision — not unattended isolation. It also binds
 * the launch facts the person reviewed: the task, the frozen plan, the
 * acceptance definition bytes, and the artifact path set, so a confirmation
 * given for one launch cannot be replayed against different content.
 */
export interface PresenceConfirmation {
  /** Non-empty name of the person who gave the confirmation. */
  readonly confirmedBy: string
  /** Trusted clock observation at the moment of confirmation. */
  readonly confirmedAt: ClockObservation
  /** Absolute path of the experiment worktree this confirmation covers. */
  readonly worktree: string
  /** Loopback ports the supervised session may bind. */
  readonly loopbackAllowlist: readonly number[]
  /** Literal acknowledgement that this launch is supervised, not unattended. */
  readonly acknowledgement: 'supervised-not-unattended'
  /** Task the confirmation covers; a launch must address the same task id. */
  readonly taskId: string
  /** Frozen test plan digest the person confirmed the launch runs against. */
  readonly testPlanDigest: string
  /** sha-256 hex digest of the stable-side acceptance definition bytes the person reviewed. */
  readonly acceptanceDefinitionDigest: string
  /** Worktree-relative artifact paths the acceptance covers, kept as a unique ascending list. */
  readonly artifactPaths: readonly string[]
}

/**
 * Validate a confirmation at the config boundary, before any digest can
 * record it.
 * @param value - confirmation as handed to the constructor.
 * @returns an owned copy of the validated confirmation.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_CONFIG_INVALID` when the confirmer is
 *   not a non-empty string, the clock observation is not a trusted shape, the
 *   worktree is not absolute, the loopback allowlist is not a port list within
 *   0–65535, the acknowledgement does not state supervision, the task id is not
 *   a plain path component, a digest is not lowercase sha-256 hex, or an
 *   artifact path is absolute or carries an empty, dot, or dot-dot segment.
 */
function validateConfirmation(value: unknown): PresenceConfirmation {
  const invalid = (detail: string): SelfDevelopmentRunnerError =>
    new SelfDevelopmentRunnerError(`human-presence confirmation is invalid: ${detail}`, 'SELF_DEV_RUNNER_CONFIG_INVALID')
  if (typeof value !== 'object' || value === null) throw invalid('confirmation must be an object')
  const confirmation = value as Record<string, unknown>
  if (typeof confirmation.confirmedBy !== 'string' || confirmation.confirmedBy.length === 0) {
    throw invalid(`confirmedBy ${JSON.stringify(confirmation.confirmedBy)} must be a non-empty name`)
  }
  if (typeof confirmation.confirmedAt !== 'object' || confirmation.confirmedAt === null) {
    throw invalid(`confirmedAt ${JSON.stringify(confirmation.confirmedAt)} must be a clock observation`)
  }
  const confirmedAt = confirmation.confirmedAt as Record<string, unknown>
  if (typeof confirmedAt.bootId !== 'string' || !BOOT_ID_PATTERN.test(confirmedAt.bootId)) {
    throw invalid(`confirmedAt.bootId ${JSON.stringify(confirmedAt.bootId)} must be lowercase sha-256 hex`)
  }
  if (typeof confirmedAt.monotonicMs !== 'number' || !Number.isInteger(confirmedAt.monotonicMs) || confirmedAt.monotonicMs < 0) {
    throw invalid(`confirmedAt.monotonicMs ${String(confirmedAt.monotonicMs)} must be a non-negative integer`)
  }
  if (typeof confirmation.worktree !== 'string' || !isAbsolute(confirmation.worktree)) {
    throw invalid(`worktree ${JSON.stringify(confirmation.worktree)} must be an absolute path`)
  }
  if (
    !Array.isArray(confirmation.loopbackAllowlist)
    || !confirmation.loopbackAllowlist.every((port: unknown) => typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535)
  ) {
    throw invalid(`loopbackAllowlist ${JSON.stringify(confirmation.loopbackAllowlist)} must list ports 0–65535`)
  }
  if (confirmation.acknowledgement !== SUPERVISED_ACKNOWLEDGEMENT) {
    throw invalid(`acknowledgement must be the literal ${JSON.stringify(SUPERVISED_ACKNOWLEDGEMENT)}`)
  }
  if (typeof confirmation.taskId !== 'string' || !TASK_ID_PATTERN.test(confirmation.taskId)) {
    throw invalid(`taskId ${JSON.stringify(confirmation.taskId)} must be a plain task id (1–64 characters: letter or digit, then letters, digits, dots, underscores, or hyphens)`)
  }
  const { testPlanDigest, acceptanceDefinitionDigest } = confirmation
  if (typeof testPlanDigest !== 'string' || !DIGEST_PATTERN.test(testPlanDigest)) {
    throw invalid(`testPlanDigest ${JSON.stringify(testPlanDigest)} must be lowercase sha-256 hex`)
  }
  if (typeof acceptanceDefinitionDigest !== 'string' || !DIGEST_PATTERN.test(acceptanceDefinitionDigest)) {
    throw invalid(`acceptanceDefinitionDigest ${JSON.stringify(acceptanceDefinitionDigest)} must be lowercase sha-256 hex`)
  }
  if (!Array.isArray(confirmation.artifactPaths)) {
    throw invalid(`artifactPaths ${JSON.stringify(confirmation.artifactPaths)} must list worktree-relative paths`)
  }
  const artifactPaths = [...new Set(confirmation.artifactPaths.map((entry: unknown) => validateArtifactPath(entry, invalid)))].sort()
  return {
    confirmedBy: confirmation.confirmedBy,
    confirmedAt: { bootId: confirmedAt.bootId, monotonicMs: confirmedAt.monotonicMs },
    worktree: confirmation.worktree,
    loopbackAllowlist: [...(confirmation.loopbackAllowlist as number[])],
    acknowledgement: confirmation.acknowledgement,
    taskId: confirmation.taskId,
    testPlanDigest,
    acceptanceDefinitionDigest,
    artifactPaths,
  }
}

/**
 * Validate one worktree-relative artifact path. Only plain segments are
 * accepted: an absolute path or an empty, dot, or dot-dot segment could widen
 * the confirmed artifact set beyond what the person reviewed.
 * @param value - one entry of `artifactPaths` as handed to the constructor.
 * @param invalid - error factory of the enclosing validation.
 * @returns the same path once proven relative and plain.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_CONFIG_INVALID` when the entry is not a
 *   non-empty string, is absolute, or carries an empty, dot, or dot-dot segment.
 */
function validateArtifactPath(value: unknown, invalid: (detail: string) => SelfDevelopmentRunnerError): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`artifactPaths entry ${JSON.stringify(value)} must be a non-empty worktree-relative path`)
  }
  if (isAbsolute(value) || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw invalid(`artifactPaths entry ${JSON.stringify(value)} must be relative without empty, dot, or dot-dot segments`)
  }
  return value
}

/**
 * Capability source that proves every required capability through one human
 * confirmation. Evidence items carry `source: 'human-presence'`; the task
 * controller records the attempt as human-supervised.
 */
export class HumanPresenceCapabilitySource implements CapabilitySource {
  /** The validated confirmation every digest binds to. */
  readonly #confirmation: PresenceConfirmation

  /**
   * @param confirmation - concrete human confirmation captured at launch.
   * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_CONFIG_INVALID` when the confirmation
   *   fails validation, so a malformed record can never reach the journal.
   */
  constructor(confirmation: unknown) {
    this.#confirmation = validateConfirmation(confirmation)
  }

  /**
   * Produce one human-presence evidence item per required capability.
   * @param requiredCapabilities - capability names the attempt needs.
   * @returns one evidence item per name, each digest bound to the capability
   *   and this confirmation.
   */
  evidence(requiredCapabilities: readonly string[]): readonly CapabilityEvidence[] {
    return requiredCapabilities.map(capability => ({
      capability,
      source: 'human-presence' as const,
      digest: CapabilityDigest(digestJson({
        capability,
        source: 'human-presence',
        confirmation: this.#confirmation,
      })),
    }))
  }
}
