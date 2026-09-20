/**
 * Types of the trial-instance manager. Runtime code lives in sibling modules.
 * @module @deepseek-ai/dsh-workflow-self-development-trial/types
 */

/** Deployment configuration of the trial-instance manager. */
export interface TrialConfig {
  /** Node binary used to spawn the worktree's `apps/cli/lib/bin.js web` process; absolute path. */
  readonly nodeBinary: string
  /**
   * The facade's control directory. The manager writes only its own
   * `trials/<taskId>.json` sidecars and `trials/<taskId>.log` files under it;
   * it never touches the `tasks/` or `launch-profiles/` subtrees.
   */
  readonly controlDirectory: string
  /** Inclusive `[from, to]` loopback port range trial instances are allocated from. */
  readonly portRange: readonly [number, number]
  /** Maximum wall time of one worktree build before the open fails. */
  readonly buildTimeoutMs: number
  /** Maximum wait for the `dsh web: http://…` readiness line after spawn. */
  readonly readyTimeoutMs: number
  /** Whether a `campaign-passed` event automatically opens the task's trial instance. */
  readonly autoOpen: boolean
  /**
   * Explicit pnpm binary to try first when resolving the build command;
   * absolute path. Falls through to `pnpm` on the host `PATH`, the
   * worktree's own installed pnpm, and the corepack shim next to
   * `nodeBinary` when unset or when the configured path does not exist.
   */
  readonly pnpmBinary?: string
}

/**
 * The launch-profile fields the manager reads off the facade's `getTask`
 * card. The full card and projection stay owned by the facade; only the
 * worktree and the per-attempt data directory matter here.
 */
export interface TrialLaunchProfileView {
  /** Experiment worktree the attempts ran in; absolute path. */
  readonly worktree: string
  /** Per-attempt data directory; absent when the host omitted it. */
  readonly dataHome?: string | undefined
}

/** The part of the facade's `getTask` result the manager consumes. */
export interface TrialTaskDetail {
  /** Read-only confirmation card carrying the stored launch profile, when one exists. */
  readonly card: { readonly launchProfile?: TrialLaunchProfileView | undefined }
}

/**
 * One `campaign-passed` notification event, as the events consumer publishes
 * it once DH-a lands the kind. This worktree predates that mapping, so the
 * manager consumes the event structurally and matches only this kind.
 */
export interface CampaignPassedEvent {
  /** Task the campaign passed for. */
  readonly taskId: string
  /** Fixed kind literal DH-a adds to the events vocabulary. */
  readonly kind: 'campaign-passed'
  /** Fixed-template summary; carried through untouched. */
  readonly title: string
  /** Host-clock milliseconds when the event was observed. */
  readonly occurredAt: number
}

/** Structural view of the events consumer the manager subscribes to. */
export interface TrialEventSource {
  /** Subscribe one listener; returns the disposer. */
  readonly subscribe: (listener: (event: CampaignPassedEvent) => void) => () => void
}

/**
 * One registered trial instance: the spawned group leader's durable facts.
 * The sidecar stores this record, including the launch token inside `url`,
 * so the log file never has to carry it.
 */
export interface TrialRecord {
  /** Record format version. */
  readonly version: 1
  /** Task the instance belongs to. */
  readonly taskId: string
  /** Ready URL including the launch token. */
  readonly url: string
  /** Loopback port the instance listens on. */
  readonly port: number
  /** Process id of the spawned group leader. */
  readonly pid: number
  /** Host-clock milliseconds when the instance became ready. */
  readonly startedAt: number
  /** Worktree the instance serves. */
  readonly worktree: string
  /** Data directory the instance runs with. */
  readonly dshHome: string
}

/** One live trial row as `trials()` returns it; no pid and no token-free copy of the url. */
export interface TrialSummary {
  /** Task the instance belongs to. */
  readonly taskId: string
  /** Ready URL including the launch token. */
  readonly url: string
  /** Loopback port the instance listens on. */
  readonly port: number
  /** Host-clock milliseconds when the instance became ready. */
  readonly startedAt: number
}

/**
 * Result of one `openTrial` call. The refusal branch's `url` is optional
 * rather than typed as a bare `undefined`: a Remote boundary type must stay
 * JSON-safe, and an optional key that JSON drops when absent is how this
 * codebase expresses "not present" across the wire; a field whose only type
 * is the literal `undefined` is not representable in JSON at all. Reading
 * `result.url` behaves identically either way for a consumer.
 */
export type OpenTrialResult =
  | { readonly url: string; readonly port: number; readonly pid: number }
  | { readonly url?: undefined; readonly reason: string }
