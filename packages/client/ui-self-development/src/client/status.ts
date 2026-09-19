/**
 * Pure view helpers of the self-development panel: status, stop-reason, event
 * and error-code dictionary keys, plus the action-visibility matrix. The
 * matrix is the single authority for which authorization button a status
 * offers; the panel renders exactly these and never an upgrade action.
 * @module
 */

import type { SelfDevelopmentEventKind } from '@deepseek-ai/dsh-workflow-self-development-events'
import type { BudgetApproval, TaskHandoffReason, TaskStatus, TaskStopReason } from '@deepseek-ai/dsh-workflow-self-development'
import type { SelfDevelopmentKey } from './locales.ts'

/** A translate seat over the self-development dictionary. */
export type Translate = (key: SelfDevelopmentKey, params?: Record<string, unknown>) => string

/** Which limits a budget approval carries, as the core defines it. */
export type BudgetMode = BudgetApproval['mode']

/** Dictionary key of one budget mode. */
const BUDGET_MODE_KEYS: Readonly<Record<BudgetMode, SelfDevelopmentKey>> = {
  rounds: 'budgetModeRounds',
  time: 'budgetModeTime',
  both: 'budgetModeBoth',
}

/**
 * Dictionary key of a budget mode.
 * @param mode - the approved budget's mode.
 * @returns the key the `t` seat translates.
 */
export function budgetModeKey(mode: BudgetMode): SelfDevelopmentKey {
  return BUDGET_MODE_KEYS[mode]
}

/** One authorization action the panel may offer. */
export type ActionId =
  | 'authorizePlanning'
  | 'confirmPlan'
  | 'approveBudget'
  | 'runAttempt'
  | 'stop'
  | 'recordTrialApproval'

/** Dictionary key of one task status badge. */
const STATUS_KEYS: Readonly<Record<TaskStatus, SelfDevelopmentKey>> = {
  draft: 'statusDraft',
  'planning-authorized': 'statusPlanningAuthorized',
  'awaiting-plan-confirmation': 'statusAwaitingPlanConfirmation',
  'awaiting-development-approval': 'statusAwaitingDevelopmentApproval',
  ready: 'statusReady',
  attempting: 'statusAttempting',
  'awaiting-trial': 'statusAwaitingTrial',
  stopped: 'statusStopped',
  handoff: 'statusHandoff',
}

/**
 * Dictionary key of a status badge.
 * @param status - the projection's lifecycle state.
 * @returns the key the `t` seat translates.
 */
export function statusKey(status: TaskStatus): SelfDevelopmentKey {
  return STATUS_KEYS[status]
}

/** Dictionary key of one terminal stop reason. */
const STOP_KEYS: Readonly<Record<TaskStopReason, SelfDevelopmentKey>> = {
  cancelled: 'stopCancelled',
  'budget-exhausted': 'stopBudgetExhausted',
  'no-progress': 'stopNoProgress',
}

/**
 * Dictionary key of a terminal stop reason.
 * @param reason - the projection's stop reason.
 * @returns the key the `t` seat translates.
 */
export function stopReasonKey(reason: TaskStopReason): SelfDevelopmentKey {
  return STOP_KEYS[reason]
}

/** Dictionary key of one handoff reason. */
const HANDOFF_KEYS: Readonly<Record<TaskHandoffReason, SelfDevelopmentKey>> = {
  'journal-incomplete-tail': 'handoffJournalIncompleteTail',
  'journal-corrupted': 'handoffJournalCorrupted',
  'attempt-interrupted': 'handoffAttemptInterrupted',
  'clock-uncertain': 'handoffClockUncertain',
}

/**
 * Dictionary key of a handoff reason.
 * @param reason - the projection's handoff reason.
 * @returns the key the `t` seat translates.
 */
export function handoffReasonKey(reason: TaskHandoffReason): SelfDevelopmentKey {
  return HANDOFF_KEYS[reason]
}

/** Dictionary key of one event kind. */
const EVENT_KEYS: Readonly<Record<SelfDevelopmentEventKind, SelfDevelopmentKey>> = {
  'turn-finished': 'kindTurnFinished',
  failed: 'kindFailed',
  'awaiting-decision': 'kindAwaitingDecision',
  'awaiting-trial': 'kindAwaitingTrial',
  stopped: 'kindStopped',
}

/**
 * Dictionary key of a timeline event kind.
 * @param kind - the event's closed-vocabulary kind.
 * @returns the key the `t` seat translates.
 */
export function eventKindKey(kind: SelfDevelopmentEventKind): SelfDevelopmentKey {
  return EVENT_KEYS[kind]
}

/** Facade and core error codes the panel maps to fixed wording. */
const ERROR_KEYS: Readonly<Record<string, SelfDevelopmentKey>> = {
  SELF_DEV_REMOTE_DISABLED: 'errorSelfDevRemoteDisabled',
  SELF_DEV_REMOTE_CONFIG_INVALID: 'errorSelfDevRemoteConfigInvalid',
  SELF_DEV_REMOTE_TASK_UNKNOWN: 'errorSelfDevRemoteTaskUnknown',
  SELF_DEV_REMOTE_ACTOR_FORBIDDEN: 'errorSelfDevRemoteActorForbidden',
  SELF_DEV_REMOTE_PRESENCE_UNCONFIRMED: 'errorSelfDevRemotePresenceUnconfirmed',
  SELF_DEV_REMOTE_RUNNER_UNAVAILABLE: 'errorSelfDevRemoteRunnerUnavailable',
  SELF_DEV_INVALID_STATE: 'errorSelfDevInvalidState',
  SELF_DEV_RUNNER_ACCEPTANCE_INVALID: 'errorSelfDevRunnerAcceptanceInvalid',
}

/**
 * Dictionary key of a Remote rejection. Unknown codes fall back to the
 * generic message, which carries the wire error text verbatim.
 * @param code - the machine-routable code carried by the rejection.
 * @returns the key the `t` seat translates.
 */
export function errorKey(code: string): SelfDevelopmentKey {
  return ERROR_KEYS[code] ?? 'errorGeneric'
}

/**
 * The authorization actions a status offers. `confirmPlan` additionally needs
 * a plan view to freeze and `recordTrialApproval` a verified result; the
 * caller passes those facts so the matrix stays a pure function.
 * @param status - the projection's lifecycle state.
 * @param hasPlan - whether the projection carries a plan view.
 * @param hasVerifiedResult - whether the projection carries a verified result.
 * @returns the visible actions in display order.
 */
export function actionsFor(status: TaskStatus, hasPlan: boolean, hasVerifiedResult: boolean): readonly ActionId[] {
  switch (status) {
    case 'draft': return ['authorizePlanning']
    case 'awaiting-plan-confirmation': return hasPlan ? ['confirmPlan'] : []
    case 'awaiting-development-approval': return ['approveBudget']
    case 'ready': return ['runAttempt', 'stop']
    case 'attempting': return ['stop']
    case 'awaiting-trial': return hasVerifiedResult ? ['recordTrialApproval'] : []
    case 'planning-authorized':
    case 'stopped':
    case 'handoff': return []
  }
}

/** Panel label of one action, keyed by the action id. */
const ACTION_LABELS: Readonly<Record<ActionId, SelfDevelopmentKey>> = {
  authorizePlanning: 'actionAuthorizePlanning',
  confirmPlan: 'actionConfirmPlan',
  approveBudget: 'actionApproveBudget',
  runAttempt: 'actionStartAttempt',
  stop: 'actionStop',
  recordTrialApproval: 'actionRecordTrialApproval',
}

/**
 * Panel label key of one action.
 * @param action - the action the button starts.
 * @returns the label key the `t` seat translates.
 */
export function actionLabelKey(action: ActionId): SelfDevelopmentKey {
  return ACTION_LABELS[action]
}

/** Dialog copy of one action, keyed by the action id. */
const DIALOG_TITLES: Readonly<Record<ActionId, SelfDevelopmentKey>> = {
  authorizePlanning: 'dialogAuthorizePlanningTitle',
  confirmPlan: 'dialogConfirmPlanTitle',
  approveBudget: 'dialogApproveBudgetTitle',
  runAttempt: 'dialogStartAttemptTitle',
  stop: 'dialogStopTitle',
  recordTrialApproval: 'dialogTrialApprovalTitle',
}

/** Dialog description of one action, keyed by the action id. */
const DIALOG_DETAILS: Readonly<Record<ActionId, SelfDevelopmentKey>> = {
  authorizePlanning: 'dialogAuthorizePlanningDetail',
  confirmPlan: 'dialogConfirmPlanDetail',
  approveBudget: 'dialogApproveBudgetDetail',
  runAttempt: 'dialogStartAttemptDetail',
  stop: 'dialogStopDetail',
  recordTrialApproval: 'dialogTrialApprovalDetail',
}

/**
 * Dialog title key of one action.
 * @param action - the action the dialog confirms.
 * @returns the title key the `t` seat translates.
 */
export function dialogTitleKey(action: ActionId): SelfDevelopmentKey {
  return DIALOG_TITLES[action]
}

/**
 * Dialog description key of one action.
 * @param action - the action the dialog confirms.
 * @returns the description key the `t` seat translates.
 */
export function dialogDetailKey(action: ActionId): SelfDevelopmentKey {
  return DIALOG_DETAILS[action]
}
