/**
 * Injected faces of the self-development panel. Types only: components receive
 * these through the slot framework's inject share and never touch ctx. The
 * Remote face narrows the generated `selfDevelopmentRemote` namespace to the
 * methods this UI drives, so tests can substitute plain objects; the
 * per-round evidence timeline reads the same facade's `recentEvents`.
 * @module
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  BudgetApprovalInput,
  ConfirmedPlanInput,
  RecentEvent,
  RemoteOperationResult,
  RemoteRunAttemptOutcome,
  RemoteRunAttemptRequest,
  TaskDetail,
  TaskSummary,
} from '@deepseek-ai/dsh-workflow-self-development-remote'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/**
 * The Remote methods this UI may call, as property-syntax callbacks the slot
 * framework hands to components. The read paths, the recent-event read, and
 * every mutating operation go through the stable-side facade; there is no
 * upgrade-approval method on the facade and none here.
 */
export interface SelfDevelopmentApi {
  /** List every task with its progress row. */
  readonly listTasks: () => Promise<RemoteResult<readonly TaskSummary[]>>
  /** Read one task's projection and confirmation-card view. */
  readonly getTask: (taskId: string) => Promise<RemoteResult<TaskDetail>>
  /** Read the facade's retained recent notification events, oldest first. */
  readonly recentEvents: () => Promise<RemoteResult<readonly RecentEvent[]>>
  /** Grant the planning authorization for one task. */
  readonly authorizePlanning: (
    taskId: string, expectedRevision: number, authorizedBy: string,
  ) => Promise<RemoteResult<RemoteOperationResult>>
  /** Freeze the human-confirmed plan. */
  readonly confirmPlan: (
    taskId: string, expectedRevision: number, plan: ConfirmedPlanInput, actor: string,
  ) => Promise<RemoteResult<RemoteOperationResult>>
  /** Record a human budget approval. */
  readonly approveBudget: (
    taskId: string, expectedRevision: number, approval: BudgetApprovalInput,
  ) => Promise<RemoteResult<RemoteOperationResult>>
  /** Launch one supervised attempt. */
  readonly runAttempt: (request: RemoteRunAttemptRequest) => Promise<RemoteResult<RemoteRunAttemptOutcome>>
  /** Stop a task at human request. */
  readonly stop: (taskId: string, expectedRevision: number, reason?: 'cancelled') => Promise<RemoteResult<RemoteOperationResult>>
  /** Record a human trial approval bound to the verified result. */
  readonly recordTrialApproval: (
    taskId: string, expectedRevision: number, approvedBy: string,
  ) => Promise<RemoteResult<RemoteOperationResult>>
}

/** Registrant-private fact pushed by the client apply's readiness fiber. */
export interface SelfDevelopmentAvailability {
  /** Whether the generated `selfDevelopmentRemote` namespace is mounted. */
  readonly remote: boolean
}

/**
 * The inject face both registered seats share. `remote` is deliberately
 * optional: an absent namespace renders the not-enabled view, and the
 * availability observable re-renders the panel when the mount completes.
 */
export interface SelfDevelopmentInjected {
  /** The mounted Remote methods, or `undefined` when the facade is absent. */
  readonly remote: SelfDevelopmentApi | undefined
  /**
   * Whether this client renders the phone whitelist view: a non-loopback Host
   * connection. The whitelist keeps every read and every whitelisted
   * authorization button, hides the experiment and evidence paths, and omits
   * the host-only `dataHome`.
   */
  readonly phone: boolean
  readonly hooks: { readonly availability: HostObservable<SelfDevelopmentAvailability> }
}
