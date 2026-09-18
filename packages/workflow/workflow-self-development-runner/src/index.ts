/**
 * Opt-in service for supervised-mode self-development attempts. The service
 * validates its deployment configuration at construction and later composes
 * the trusted clock, human-presence evidence, headless executor, and
 * independent acceptor into one `startAttempt` side effect. It registers no
 * tool, prompt, or event, and it enables no unattended execution.
 * @module @deepseek-ai/dsh-workflow-self-development-runner
 */

import { isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SelfDevelopmentRunnerError } from './runtime.ts'
import { isInsideReal } from './path-containment.ts'
import type { RunnerConfig } from './types.ts'

export { HostClock, parseKernBoottime, readBootTimeSysctl } from './clock.ts'
export { HumanPresenceCapabilitySource } from './presence.ts'
export { artifactDigestOf, sourceDigestOf } from './digests.ts'
export { SelfDevelopmentRunnerError, SelfDevelopmentRunnerErrorCode } from './runtime.ts'
export { runHeadlessExecutor } from './executor.ts'
export { checkAcceptanceCoversPlan, loadAcceptance, runAcceptance } from './acceptor.ts'
export type { BootTime, BootTimeReader } from './clock.ts'
export type { PresenceConfirmation } from './presence.ts'
export type { ExecutorRequest, ExecutorRun } from './executor.ts'
export type { AcceptanceAssertion, AcceptanceCase, AcceptanceRun } from './acceptor.ts'
export type { RunnerConfig } from './types.ts'
export { planAttemptBudget, phaseLimitMs, armDeadline } from './budget.ts'
export type { ArmedDeadline } from './budget.ts'
export { assertConfirmationBinds, resolveExperimentWorktree } from './binding.ts'
export type { LaunchFacts } from './binding.ts'
export { readLaunchRecord, writeLaunchRecord, launchRecordPath } from './launch-record.ts'
export type { LaunchRecord } from './launch-record.ts'
export { writeAttemptEvidence, writeAttemptOutcome, readAttemptEvidence, attemptEvidencePath } from './evidence.ts'
export type { AttemptEvidence, AttemptOutcome, DigestPair } from './evidence.ts'
export { writeDurableJson, readDurableJson } from './durable-json.ts'
export { runSupervisedAttempt } from './attempt.ts'
export type { SupervisedAttemptRequest, SupervisedAttemptOutcome } from './attempt.ts'

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
  }) as unknown as z<RunnerConfig>

  // Cordis service shadows read state through a prototype-extended proxy, so
  // these use TypeScript privacy instead of #-private fields.

  /**
   * @param ctx - owning Cordis context.
   * @param config - deployment configuration for the runner's binaries, homes, and process teardown.
   * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_CONFIG_INVALID` when a path field is
   *   missing, empty, or not absolute, `evidenceRoot` sits inside or equals `experimentsRoot`, or
   *   `killGraceMs` is not a positive finite integer. Misconfiguration fails at load.
   */
  constructor(ctx: Context, config: RunnerConfig) {
    super(ctx, 'selfDevelopmentRunner')
    // Misconfiguration fails at load: keep the validated shape local to the
    // constructor until the attempt pipeline (later tasks) consumes it.
    validateConfig(config)
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
 *   missing, empty, or not absolute, `evidenceRoot` sits inside or equals `experimentsRoot`, or
 *   `killGraceMs` is not a positive finite integer.
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
  return config
}
