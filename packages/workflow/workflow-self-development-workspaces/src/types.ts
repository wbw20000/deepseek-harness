/**
 * Domain types for self-development workspace allocation and serialized
 * integration. Types only: every runtime constructor, validator, and git
 * step lives in a sibling module.
 * @module @deepseek-ai/dsh-workflow-self-development-workspaces/types
 */

/** Deployment configuration for the workspace allocation service. */
export interface WorkspacesConfig {
  /** Absolute path of the parent directory that holds every task worktree and data home. */
  readonly experimentsRoot: string
  /**
   * Absolute path of the template directory copied into each task's
   * `DSH_HOME`; `sessions/` and `attachments/` subtrees and `*.lock` files are
   * excluded from the copy.
   */
  readonly dataHomeTemplate: string
  /** Maximum number of workspaces this service keeps allocated at once. */
  readonly maxConcurrentTasks: number
  /**
   * Optional command run once inside a newly created worktree — after the git
   * worktree and data home exist, before the allocation registers — for
   * example to install dependencies a project's own worktree does not carry
   * (`git worktree add` copies no `node_modules`). Absent skips setup
   * entirely; a repeated `allocate` that returns an already-registered
   * workspace never reruns it.
   */
  readonly setup?: WorkspaceSetupConfig
}

/** One deployment-configured setup command and its wall-clock deadline. */
export interface WorkspaceSetupConfig {
  /** Argv spawned with `cwd` the worktree root; `command[0]` resolves through `PATH`. */
  readonly command: readonly string[]
  /** Wall-clock milliseconds before the command's whole process group is killed as a failed setup. */
  readonly timeoutMs: number
}

/** One task's allocated workspace: its worktree, branch, data home, and baseline. */
export interface TaskWorkspace {
  /** The task the workspace is allocated to; also the branch and directory name. */
  readonly taskId: string
  /** Absolute path of the project repository the worktree was created from. */
  readonly projectRoot: string
  /** Commit the task's branch was created at; the integration baseline. */
  readonly baseCommit: string
  /** Absolute path of the task's git worktree under `experimentsRoot`. */
  readonly worktree: string
  /** Branch name of the worktree: `selfdev/<taskId>`. */
  readonly branch: string
  /** Absolute path of the task's copied `DSH_HOME` under `experimentsRoot`. */
  readonly dataHome: string
  /** Wall-clock milliseconds when the workspace was allocated. */
  readonly allocatedAt: number
  /** Wall-clock milliseconds when the configured setup command completed; absent when no setup is configured. */
  readonly setupCompletedAt?: number
}

/**
 * Outcome of one caller-supplied verification gate run against the
 * post-rebase worktree, immediately before an integration would fast-forward.
 */
export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Outcome of one serialized integration of a task's worktree into a target
 * branch. `baseMoved` is true whenever the target tip differed from the
 * allocation's `baseCommit` and a rebase was attempted, whether or not that
 * rebase changed any commit id. `verification-failed` is reported only when
 * `IntegrationRequest.verify` was supplied and it resolved `{ ok: false }` or
 * threw; the target branch is left untouched and, when a rebase ran, its
 * result stays in the worktree for a follow-up fix.
 */
export type IntegrationResult =
  | { status: 'integrated'; commit: string; baseMoved: boolean }
  | { status: 'conflict'; files: readonly string[]; baseMoved: true }
  | { status: 'verification-failed'; reason: string; baseMoved: boolean }
  | { status: 'failed'; reason: string }

/** Request to integrate one allocated task's worktree into a target branch. */
export interface IntegrationRequest {
  /** The allocated task whose worktree integrates. */
  readonly taskId: string
  /** The project branch to fast-forward to the task's worktree HEAD. */
  readonly targetBranch: string
  /** Human-readable actor recorded nowhere but the caller's own log; reserved for audit context. */
  readonly actor: string
  /**
   * Optional verification gate run against the worktree after a rebase (when
   * one was needed) and before the fast-forward, whether or not the baseline
   * had moved. A rejection or a throw both stop the integration before the
   * fast-forward: {@link IntegrationResult}'s `verification-failed` reports a
   * thrown error the same as an `{ ok: false }` resolution, carrying its
   * string form as `reason`.
   */
  readonly verify?: (worktree: string) => Promise<VerifyOutcome>
}
