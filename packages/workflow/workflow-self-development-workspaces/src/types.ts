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
}

/** Outcome of one serialized integration of a task's worktree into a target branch. */
export type IntegrationResult =
  | { status: 'integrated'; commit: string }
  | { status: 'conflict'; files: readonly string[]; baseMoved: true }
  | { status: 'failed'; reason: string }

/** Request to integrate one allocated task's worktree into a target branch. */
export interface IntegrationRequest {
  /** The allocated task whose worktree integrates. */
  readonly taskId: string
  /** The project branch to fast-forward to the task's worktree HEAD. */
  readonly targetBranch: string
  /** Human-readable actor recorded nowhere but the caller's own log; reserved for audit context. */
  readonly actor: string
}
