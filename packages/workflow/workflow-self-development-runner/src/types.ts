/**
 * Domain types for the supervised-mode self-development runner. Types only:
 * every runtime constructor, validator, and digest lives in a sibling module.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/types
 */

/** Deployment configuration for the supervised runner service. */
export interface RunnerConfig {
  /** Absolute path of the `node` binary the executor and acceptance commands run under. */
  readonly nodeBinary: string
  /** Absolute path of the harness CLI entry (`apps/cli/lib/bin.js`) the executor spawns. */
  readonly dshBin: string
  /** Absolute path of the experiment Agent's `DSH_HOME`; never the operating user's `~/.dsh`. */
  readonly dshHome: string
  /** Absolute path of the parent directory that holds every experiment worktree. */
  readonly experimentsRoot: string
  /** Absolute path of the stable-side evidence directory; must live outside `experimentsRoot`. */
  readonly evidenceRoot: string
  /** Milliseconds between `SIGTERM` and `SIGKILL` when the runner tears down a process group. */
  readonly killGraceMs: number
}

/**
 * sha-256 hex digest of an experiment worktree's source snapshot. Mirrors the
 * core task-control package's `SourceDigest` brand (same brand id), so a
 * digest composed here is accepted by its `startAttempt` contract.
 */
export type SourceDigest = import('@deepseek-ai/dsh-brand').Branded<'self-dev-source-digest'>

/**
 * sha-256 hex digest of an experiment worktree's built artifact. Mirrors the
 * core task-control package's `ArtifactDigest` brand (same brand id).
 */
export type ArtifactDigest = import('@deepseek-ai/dsh-brand').Branded<'self-dev-artifact-digest'>
