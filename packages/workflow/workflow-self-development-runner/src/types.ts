/**
 * Domain types for the supervised-mode self-development runner. Types only:
 * every runtime constructor, validator, and digest lives in a sibling module.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/types
 */

/**
 * Deployment configuration for the macOS file-level sandbox (Tier 1,
 * `sandbox-exec`/Seatbelt) that wraps every headless-executor and
 * acceptance-case spawn. Absent on `RunnerConfig`, every field defaults as if
 * this object were `{ enabled: true, denyReadRoots: [], extraWritableRoots:
 * [], sandboxExec: '/usr/bin/sandbox-exec' }` — see `DEFAULT_SANDBOX_CONFIG`
 * in `sandbox.ts`. This is a macOS-only file-write fence: it does not isolate
 * the network, process visibility, or any non-darwin host.
 */
export interface SandboxConfig {
  /**
   * Whether the executor's and every acceptance case's spawn is wrapped in
   * `sandbox-exec`. `false` is an explicit deployment opt-out into no
   * isolation at all — the README's "cannot claim" section then applies to
   * the whole attempt, not just to the sandbox's own limits. Only meaningful
   * on `darwin`: on every other platform this package has no sandbox tier,
   * so spawns run unwrapped regardless of this field, and the unavailable
   * mechanism never refuses a launch there.
   */
  readonly enabled: boolean
  /**
   * Absolute paths whose real, symlink-resolved target is denied all reads
   * inside the sandbox, regardless of the writable grants below. Deployment
   * examples: the operating user's `~/.dsh`, the stable runtime's control
   * directory, and `evidenceRoot`. Each root is resolved through the
   * filesystem before it reaches the profile text, so a symlinked root (for
   * example `~/.dsh` pointing elsewhere) is judged by its real target, not
   * its configured spelling. Every entry must be an absolute path.
   */
  readonly denyReadRoots: readonly string[]
  /**
   * Additional absolute paths a spawn may write to, beyond the experiment
   * worktree, the attempt's data directory, and the temporary-directory
   * spellings the sandbox always grants. Every entry must be an absolute
   * path.
   */
  readonly extraWritableRoots: readonly string[]
  /** Absolute path of the `sandbox-exec` executable the probe and every wrap invoke. */
  readonly sandboxExec: string
}

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
  /** Milliseconds before SIGKILL escalation and the separate final group-exit confirmation limit. */
  readonly killGraceMs: number
  /**
   * macOS file-level sandbox (Tier 1) wrapping the executor and acceptance-case
   * spawns; absent runs as `DEFAULT_SANDBOX_CONFIG` (enabled, no extra
   * roots) — see `SandboxConfig`. Optional here so a `RunnerConfig` built
   * directly (as every pre-sandbox test still does) keeps compiling and keeps
   * the safe default; the deployed service's schema always supplies a fully
   * defaulted object.
   */
  readonly sandbox?: SandboxConfig
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

/**
 * Finite limits one attempt runs under, derived from the approved budget and
 * the task's already consumed run time. Every phase deadline is computed from
 * these while the attempt runs; a budget that bounds neither a phase nor the
 * total is refused before anything launches.
 */
export interface AttemptBudget {
  /** Approved milliseconds one phase may run, or `undefined` when the approval carries no phase limit. */
  readonly phaseMs: number | undefined
  /** Milliseconds left of the approved total run time, or `undefined` when the approval carries no time limit. */
  readonly totalRemainingMs: number | undefined
  /** Approved model/tool step cap inside one attempt, or `undefined` when the approval carries none. */
  readonly maxSteps: number | undefined
}
