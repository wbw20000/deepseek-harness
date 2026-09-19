/**
 * Wire-request builders and failure rendering of the self-development panel.
 * Pure functions over form text and the loaded projection: the panel feeds
 * them, and the facade's wire schema re-validates everything at the boundary.
 * @module
 */

import type { Translate } from './status.ts'
import { errorKey } from './status.ts'
import type { BudgetApproval } from '@deepseek-ai/dsh-workflow-self-development'
import type {
  BudgetApprovalInput,
  ConfirmedPlanInput,
  RemoteRunAttemptRequest,
} from '@deepseek-ai/dsh-workflow-self-development-remote'

/** Which limits a budget approval carries, as the core defines it. */
export type BudgetMode = BudgetApproval['mode']

/** Failure view of a Remote rejection: its machine-routable code and message. */
export interface RemoteFailureView {
  readonly code: string
  readonly message: string
}

/**
 * Render a Remote rejection as panel copy. A code the vocabulary knows maps to
 * its fixed wording; an unknown code falls back to the generic message carrying
 * the wire text verbatim.
 * @param t - the dictionary seat.
 * @param error - the rejection's code and message.
 * @returns the localized failure line.
 */
export function failureText(t: Translate, error: RemoteFailureView): string {
  const key = errorKey(error.code)
  return key === 'errorGeneric' ? t('errorGeneric', { message: error.message }) : t(key)
}

/**
 * Parse the loopback-port allowlist text. Entries that are not non-negative
 * integers within the port range are dropped, so a stray character never
 * reaches the wire schema as a half-valid list.
 * @param text - comma-separated port numbers as typed.
 * @returns the parsed ports, in typed order.
 */
export function parsePorts(text: string): number[] {
  return text
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => /^\d+$/u.test(entry) && Number(entry) <= 65535)
    .map(entry => Number(entry))
}

/**
 * Split a comma-separated path list into trimmed, non-empty entries.
 * @param text - comma-separated paths as typed.
 * @returns the trimmed paths, in typed order.
 */
export function parsePaths(text: string): string[] {
  return text.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
}

/** Text fields of the run-attempt form. */
export interface RunAttemptForm {
  /** Person giving the confirmation; the presence acknowledgement's owner. */
  readonly confirmedBy: string
  /** Experiment worktree path; stable-side supplied. */
  readonly worktree: string
  /** Comma-separated artifact paths; stable-side supplied. */
  readonly artifactPaths: string
  /** Acceptance definition path; stable-side supplied. */
  readonly acceptancePath: string
  /** Per-attempt data home; stable-side supplied and host-only on the wire. */
  readonly dataHome: string
  /** Comma-separated loopback ports. */
  readonly ports: string
}

/**
 * Build the `runAttempt` request from the form. `presenceAcknowledged` is
 * `true` only because the caller passes the dialog acknowledgement; the panel
 * never defaults it. The host-only `dataHome` is omitted when the form left it
 * empty or the client runs on a phone, matching the wire schema's `hostOnly`
 * mark.
 * @param taskId - the task the round belongs to.
 * @param expectedRevision - the revision the panel observed.
 * @param form - the form's text fields.
 * @param phone - whether this client renders the phone whitelist view.
 * @param presenceAcknowledged - the dialog's explicit acknowledgement.
 * @returns the request as the facade validates it.
 */
export function buildRunAttemptRequest(
  taskId: string,
  expectedRevision: number,
  form: RunAttemptForm,
  phone: boolean,
  presenceAcknowledged: boolean,
): RemoteRunAttemptRequest {
  const dataHome = form.dataHome.trim()
  return {
    taskId,
    expectedRevision,
    worktree: form.worktree.trim(),
    artifactPaths: parsePaths(form.artifactPaths),
    acceptancePath: form.acceptancePath.trim(),
    ...(dataHome === '' || phone ? {} : { dataHome }),
    confirmedBy: form.confirmedBy.trim(),
    loopbackAllowlist: parsePorts(form.ports),
    presenceAcknowledged,
  }
}

/** Text fields of the budget form; an empty string means the field is unset. */
export interface BudgetForm {
  /** Which limits the approval carries. */
  readonly mode: BudgetMode
  readonly maxRounds: string
  readonly durationMs: string
  readonly phaseTimeoutMs: string
  readonly maxStepsPerAttempt: string
  readonly noProgressAttemptLimit: string
}

/**
 * Read one optional positive number from the form.
 * @param text - the field's text.
 * @returns the number, or `undefined` when the field is empty or not a positive number.
 */
function optionalPositive(text: string): number | undefined {
  if (text.trim() === '') return undefined
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Build the budget approval from the form, binding it to the frozen plan and
 * spec versions the loaded projection carries. Consumed budget never appears
 * here: the facade resets nothing.
 * @param form - the budget form's fields.
 * @param testPlanVersion - the frozen plan version the approval binds.
 * @param taskSpecVersion - the TaskSpec version the approval binds.
 * @param approvedBy - the approving human actor.
 * @returns the approval as the facade validates it.
 */
export function buildBudgetApproval(
  form: BudgetForm,
  testPlanVersion: number,
  taskSpecVersion: number,
  approvedBy: string,
): BudgetApprovalInput {
  const maxRounds = optionalPositive(form.maxRounds)
  const durationMs = optionalPositive(form.durationMs)
  const phaseTimeoutMs = optionalPositive(form.phaseTimeoutMs)
  const maxStepsPerAttempt = optionalPositive(form.maxStepsPerAttempt)
  const noProgressAttemptLimit = optionalPositive(form.noProgressAttemptLimit)
  return {
    mode: form.mode,
    ...(maxRounds === undefined ? {} : { maxRounds }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(phaseTimeoutMs === undefined ? {} : { phaseTimeoutMs }),
    ...(maxStepsPerAttempt === undefined ? {} : { maxStepsPerAttempt }),
    ...(noProgressAttemptLimit === undefined ? {} : { noProgressAttemptLimit }),
    testPlanVersion,
    taskSpecVersion,
    approvedBy: approvedBy.trim(),
  }
}

/**
 * Build the confirmed-plan input from the plan view the projection carries.
 * The digest is deliberately absent: the facade computes and freezes it.
 * @param plan - the plan view awaiting confirmation.
 * @returns the confirmed plan as the facade validates it.
 */
export function buildConfirmedPlan(plan: {
  readonly testPlanId: string
  readonly version: number
  readonly taskSpecVersion: number
  readonly requiredCases: ConfirmedPlanInput['requiredCases']
  readonly manualCases: ConfirmedPlanInput['manualCases']
}): ConfirmedPlanInput {
  return {
    testPlanId: plan.testPlanId,
    version: plan.version,
    taskSpecVersion: plan.taskSpecVersion,
    requiredCases: plan.requiredCases,
    manualCases: plan.manualCases,
  }
}
