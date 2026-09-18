/**
 * Human-confirmation binding to real launch facts: a confirmation binds the
 * task, the worktree as resolved through the filesystem, the frozen plan and
 * acceptance-definition digests, and the artifact path set. Comparing case
 * names and assertion names alone cannot prove the launched tests are the
 * ones a person confirmed, so every fact is checked here before a launch.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/binding
 */

import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { realpathIfInside } from './path-containment.ts'
import type { PresenceConfirmation } from './presence.ts'
import { SelfDevelopmentRunnerError } from './runtime.ts'

/** Real filesystem facts of the launch a confirmation must bind. */
export interface LaunchFacts {
  /** Task id the attempt launches. */
  readonly taskId: string
  /** Absolute, already-realpathed experiment worktree the attempt launches in. */
  readonly worktreeReal: string
  /** Frozen test plan digest the attempt runs against. */
  readonly testPlanDigest: string
  /** sha-256 hex digest of the acceptance definition bytes the attempt runs. */
  readonly acceptanceDefinitionDigest: string
  /** Artifact paths the acceptance covers, in any order, possibly repeated. */
  readonly artifactPaths: readonly string[]
}

/**
 * Whether the confirmed and launched artifact paths are the same set.
 * @param confirmed - the confirmation's unique ascending artifact paths.
 * @param launched - the launch's artifact paths, in any order, possibly repeated.
 * @returns true when both sides name the same set of paths.
 */
function sameArtifactPaths(confirmed: readonly string[], launched: readonly string[]): boolean {
  const confirmedSet = new Set(confirmed)
  const launchedSet = new Set(launched)
  return confirmedSet.size === launchedSet.size && [...launchedSet].every(path => confirmedSet.has(path))
}

/**
 * Check that a human confirmation binds the real launch facts: the task id,
 * the worktree's realpath, the test plan and acceptance definition digests,
 * and the artifact path set. Any divergence refuses the launch, so a
 * confirmation given for one launch cannot be replayed against another.
 * @param confirmation - the human confirmation captured at launch.
 * @param facts - the launch's real filesystem facts.
 * @returns a promise that resolves when every fact matches.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_PRESENCE_MISMATCH` when a fact differs,
 *   naming the field that diverged, or when the confirmed worktree does not
 *   resolve through the filesystem.
 */
export async function assertConfirmationBinds(confirmation: PresenceConfirmation, facts: LaunchFacts): Promise<void> {
  const mismatch = (detail: string): SelfDevelopmentRunnerError =>
    new SelfDevelopmentRunnerError(
      `human-presence confirmation does not bind the launch facts: ${detail}`,
      'SELF_DEV_RUNNER_PRESENCE_MISMATCH',
    )
  if (confirmation.taskId !== facts.taskId) throw mismatch('taskId does not address the launched task')
  const confirmedWorktreeReal = await realpath(confirmation.worktree).catch(() => undefined)
  if (confirmedWorktreeReal === undefined || confirmedWorktreeReal !== facts.worktreeReal) {
    throw mismatch('worktree does not resolve to the launched worktree')
  }
  if (confirmation.testPlanDigest !== facts.testPlanDigest) throw mismatch('testPlanDigest does not match the launched plan')
  if (confirmation.acceptanceDefinitionDigest !== facts.acceptanceDefinitionDigest) {
    throw mismatch('acceptanceDefinitionDigest does not match the launched acceptance definition')
  }
  if (!sameArtifactPaths(confirmation.artifactPaths, facts.artifactPaths)) {
    throw mismatch('artifactPaths do not match the launched artifact set')
  }
}

/**
 * Resolve an experiment worktree for launch: the path must resolve, through
 * the filesystem, to a location inside the experiments root, and the
 * resolved worktree must carry a `.git` entry — a file for a linked git
 * worktree, a directory for a plain repository.
 * @param experimentsRoot - absolute parent directory holding every experiment worktree.
 * @param worktree - absolute or root-relative candidate worktree path.
 * @returns the worktree's realpath.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_WORKTREE_INVALID` when the path does not
 *   resolve inside the experiments root or the resolved worktree has no
 *   `.git` entry.
 */
export async function resolveExperimentWorktree(experimentsRoot: string, worktree: string): Promise<string> {
  const worktreeReal = await realpathIfInside(experimentsRoot, worktree)
  if (worktreeReal === undefined) {
    throw new SelfDevelopmentRunnerError(
      `experiment worktree ${worktree} does not resolve inside the experiments root`,
      'SELF_DEV_RUNNER_WORKTREE_INVALID',
    )
  }
  const gitEntry = await stat(join(worktreeReal, '.git')).catch(() => undefined)
  if (gitEntry === undefined) {
    throw new SelfDevelopmentRunnerError(
      `experiment worktree ${worktreeReal} has no .git entry`,
      'SELF_DEV_RUNNER_WORKTREE_INVALID',
    )
  }
  return worktreeReal
}
