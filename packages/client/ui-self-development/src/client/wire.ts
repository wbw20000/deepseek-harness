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
  ConfirmationCard,
  PlanDraftInput,
  RemoteRunAttemptRequest,
  RemoteTaskProjection,
  TaskSpecInput,
} from '@deepseek-ai/dsh-workflow-self-development-remote'

/** Which limits a budget approval carries, as the core defines it. */
export type BudgetMode = BudgetApproval['mode']

/**
 * Per-task launch profile as the panel writes it through `setLaunchProfile` or
 * the optional third `createTask` argument. Every field is host-only on the
 * wire; a non-host caller is refused with `self-development/host-only-field`.
 * `artifactPaths`, `dataHome`, `loopbackAllowlist`, and `confirmedBy` are
 * optional: the facade fills them from the spec scope, per-attempt defaults,
 * and the single allowed actor respectively.
 */
export interface LaunchProfileInput {
  /** Absolute experiment worktree path. */
  readonly worktree: string
  /** Absolute acceptance definition path. */
  readonly acceptancePath: string
  /** Absolute artifact paths; omitted means the spec's allowed scope. */
  readonly artifactPaths?: readonly string[]
  /** Per-attempt data home; omitted means the facade default. */
  readonly dataHome?: string
  /** Loopback port allowlist; omitted means an empty list. */
  readonly loopbackAllowlist?: readonly number[]
  /** Person giving the presence confirmation; omitted means the single allowed actor. */
  readonly confirmedBy?: string
}

/**
 * Stored launch profile as `card.launchProfile` carries it back: every input
 * field resolved, plus the last-write timestamp. `dataHome` stays optional.
 */
export type LaunchProfile = Required<Omit<LaunchProfileInput, 'dataHome'>> & {
  readonly dataHome?: string
  readonly updatedAt: number
}

/**
 * The confirmation card as this wave extends it with the launch profile.
 * The generated card gains the field when DG-a lands; until then the panel
 * reads it through {@link launchProfileOf}, which keeps the wire type the
 * single authority and the cast local and documented.
 */
export type ConfirmationCardView = ConfirmationCard & {
  readonly launchProfile?: LaunchProfile
  readonly trialApproval?: { readonly approvedBy: string; readonly resultDigest: string }
}

/**
 * Read the launch profile off a card view.
 * @param card - the confirmation card the facade built.
 * @returns the stored profile, or `undefined` when the task has none.
 */
export function launchProfileOf(card: ConfirmationCard): LaunchProfile | undefined {
  const view = card as ConfirmationCardView
  return view.launchProfile
}

/**
 * Read the trial approval, preferring the projection's own record and falling
 * back to the card's copy for wire views that carry it there.
 * @param projection - the loaded projection.
 * @param card - the loaded confirmation card.
 * @returns the recorded approval, or `undefined` when none exists.
 */
export function trialApprovalOf(
  projection: RemoteTaskProjection,
  card: ConfirmationCard,
): { readonly approvedBy: string; readonly resultDigest: string } | undefined {
  return projection.trialApproval ?? (card as ConfirmationCardView).trialApproval
}

/**
 * `runAttempt` request as this wave allows it: the three keys every launch
 * carries, with every profile-derived field optional and an explicit value
 * taking precedence over the stored profile. Structurally compatible with the
 * generated request, which makes the same fields required; the facade
 * re-refuses anything it cannot resolve from the profile.
 */
export type RunAttemptRequest = Omit<
  RemoteRunAttemptRequest,
  'worktree' | 'artifactPaths' | 'acceptancePath' | 'loopbackAllowlist' | 'confirmedBy'
> & {
  readonly worktree?: string
  readonly artifactPaths?: readonly string[]
  readonly acceptancePath?: string
  readonly loopbackAllowlist?: readonly number[]
  readonly confirmedBy?: string
}

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

/** Override fields of the advanced run-attempt form; an empty string means "keep the profile value". */
export interface RunAttemptForm {
  /** Experiment worktree path; empty keeps the profile value. */
  readonly worktree: string
  /** Comma-separated artifact paths; empty keeps the profile value. */
  readonly artifactPaths: string
  /** Acceptance definition path; empty keeps the profile value. */
  readonly acceptancePath: string
  /** Per-attempt data home; host-only on the wire. */
  readonly dataHome: string
  /** Comma-separated loopback ports. */
  readonly ports: string
}

/**
 * Build the `runAttempt` request from the advanced overrides. The request
 * always carries the three launch keys; an override field is included only
 * when the form filled it, so an untouched form resolves every value from the
 * stored profile. `presenceAcknowledged` is `true` only because the caller
 * passes the dialog acknowledgement; the panel never defaults it. The
 * host-only `dataHome` is omitted when the form left it empty or the client
 * runs on a phone, matching the wire schema's `hostOnly` mark.
 * @param taskId - the task the round belongs to.
 * @param expectedRevision - the revision the panel observed.
 * @param form - the advanced form's override fields.
 * @param phone - whether this client renders the phone whitelist view.
 * @param presenceAcknowledged - the dialog's explicit acknowledgement.
 * @param confirmedBy - the acting person; included only when non-empty.
 * @returns the request as the facade validates it.
 */
export function buildRunAttemptRequest(
  taskId: string,
  expectedRevision: number,
  form: RunAttemptForm,
  phone: boolean,
  presenceAcknowledged: boolean,
  confirmedBy = '',
): RunAttemptRequest {
  const dataHome = form.dataHome.trim()
  const worktree = form.worktree.trim()
  const acceptancePath = form.acceptancePath.trim()
  const artifactPaths = parsePaths(form.artifactPaths)
  const loopbackAllowlist = parsePorts(form.ports)
  const actor = confirmedBy.trim()
  return {
    taskId,
    expectedRevision,
    ...(worktree === '' ? {} : { worktree }),
    ...(artifactPaths.length === 0 ? {} : { artifactPaths }),
    ...(acceptancePath === '' ? {} : { acceptancePath }),
    ...(dataHome === '' || phone ? {} : { dataHome }),
    ...(loopbackAllowlist.length === 0 ? {} : { loopbackAllowlist }),
    ...(actor === '' ? {} : { confirmedBy: actor }),
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

/** Text fields of the new-task form. */
export interface NewTaskForm {
  /** Task identity; names the journal directory the facade opens. */
  readonly taskId: string
  /** Requirement text agreed with the user. */
  readonly requirement: string
  /** Comma-separated repository paths the worker may modify. */
  readonly scope: string
  /** Digest of the stable release commit the task starts from. */
  readonly baseline: string
  /** Human actor that created the task. */
  readonly createdBy: string
}

/**
 * Build the `createTask` spec. The version is always the first one: a new task
 * carries exactly one spec. The scope splits like every comma-separated path
 * list, and the facade's wire schema re-validates the digest shape.
 * @param form - the new-task form's fields.
 * @returns the spec as the facade validates it.
 */
export function buildCreateTaskSpec(form: NewTaskForm): TaskSpecInput {
  return {
    taskId: form.taskId.trim(),
    version: 1,
    requirement: form.requirement.trim(),
    allowedModificationScope: parsePaths(form.scope),
    stableBaselineDigest: form.baseline.trim(),
    createdBy: form.createdBy.trim(),
  }
}

/** Text fields of an optional launch profile on the new-task form. */
export interface ProfileForm {
  /** Absolute experiment worktree path. */
  readonly worktree: string
  /** Absolute acceptance definition path. */
  readonly acceptancePath: string
  /** Comma-separated artifact paths; empty omits the field. */
  readonly artifactPaths: string
}

/**
 * Build the launch-profile input from the optional profile fields.
 * @param form - the profile form's fields.
 * @returns the input, or `undefined` when the form left both required paths empty.
 */
export function buildLaunchProfileInput(form: ProfileForm): LaunchProfileInput | undefined {
  const worktree = form.worktree.trim()
  const acceptancePath = form.acceptancePath.trim()
  if (worktree === '' && acceptancePath === '') return undefined
  return {
    worktree,
    acceptancePath,
    ...(parsePaths(form.artifactPaths).length === 0 ? {} : { artifactPaths: parsePaths(form.artifactPaths) }),
  }
}

/** Text fields of one plan-draft case row. */
export interface PlanDraftCaseForm {
  /** Draft case id. */
  readonly caseId: string
  /** Requirement the case verifies. */
  readonly requirement: string
  /** Comma-separated assertion ids. */
  readonly assertionIds: string
}

/**
 * Build the plan-draft input. A row without a case id or a requirement is
 * dropped, so a half-typed row never reaches the wire schema.
 * @param cases - the case rows in display order.
 * @param manualCases - comma-separated manual acceptance items.
 * @returns the draft as the facade validates it.
 */
export function buildPlanDraft(cases: readonly PlanDraftCaseForm[], manualCases: string): PlanDraftInput {
  const requiredCases = cases
    .map(row => ({
      caseId: row.caseId.trim(),
      requirement: row.requirement.trim(),
      assertionIds: parsePaths(row.assertionIds),
    }))
    .filter(row => row.caseId !== '' && row.requirement !== '')
  return { requiredCases, manualCases: parsePaths(manualCases) }
}
