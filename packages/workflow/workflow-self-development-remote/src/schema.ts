/**
 * Wire validation for every Remote facade method. Remote callers reach these
 * methods over a wire boundary, so each argument is parsed here before the
 * core or runner sees it; the owning package re-validates its own contract
 * afterwards. Error codes of the core and the runner are never rewrapped.
 * @module @deepseek-ai/dsh-workflow-self-development-remote/schema
 */

import { z as zod } from 'zod'
import { validateTaskId } from '@deepseek-ai/dsh-workflow-self-development'
import { SelfDevelopmentRemoteError } from './errors.ts'
import type { BudgetApprovalInput, RemoteRunAttemptRequest, TaskSpecInput } from './types.ts'

/** Non-empty string with no length beyond what the field needs. */
const nonEmpty = zod.string().min(1)

/** Matches the digests the task-control package brands. */
const digestSchema = zod.string().regex(/^[0-9a-f]{64}$/u, 'digest must be 64 lowercase hex characters')

/** Wire form of one required acceptance case; mirrors the core's plan schema. */
const requiredCaseSchema = zod.strictObject({
  caseId: nonEmpty,
  requirement: nonEmpty,
  assertionIds: zod.array(nonEmpty).min(1),
})

/** Wire form of a TaskSpec; mirrors the core's `taskSpecSchema`. */
const taskSpecSchema = zod.strictObject({
  taskId: nonEmpty,
  version: zod.number().int().min(1),
  requirement: nonEmpty,
  allowedModificationScope: zod.array(nonEmpty).min(1),
  stableBaselineDigest: digestSchema,
  createdBy: nonEmpty,
})

/** Wire form of a plan draft; mirrors the core's `planDraftSchema`. */
const planDraftSchema = zod.strictObject({
  requiredCases: zod.array(requiredCaseSchema).min(1),
  manualCases: zod.array(nonEmpty),
})

/** Wire form of a confirmed plan; mirrors the core's `confirmedPlanSchema`. */
const confirmedPlanSchema = zod.strictObject({
  testPlanId: nonEmpty,
  version: zod.number().int().min(1),
  taskSpecVersion: zod.number().int().min(1),
  requiredCases: zod.array(requiredCaseSchema).min(1),
  manualCases: zod.array(nonEmpty),
})

/** Wire form of a budget approval; mirrors the core's `budgetApprovalSchema`. */
const budgetApprovalSchema = zod.strictObject({
  mode: zod.enum(['rounds', 'time', 'both']),
  maxRounds: zod.number().int().min(1).optional(),
  durationMs: zod.number().positive().optional(),
  phaseTimeoutMs: zod.number().positive().optional(),
  maxStepsPerAttempt: zod.number().int().min(1).optional(),
  noProgressAttemptLimit: zod.number().int().min(1).optional(),
  testPlanVersion: zod.number().int().min(1),
  taskSpecVersion: zod.number().int().min(1),
  approvedBy: nonEmpty,
})

/** Wire form of a `runAttempt` request. */
const runAttemptSchema = zod.strictObject({
  taskId: nonEmpty,
  expectedRevision: zod.number().int().min(0),
  worktree: zod.string().refine(isAbsolute, 'worktree must be an absolute path'),
  artifactPaths: zod.array(zod.string().min(1)).min(1),
  acceptancePath: zod.string().refine(isAbsolute, 'acceptancePath must be an absolute path'),
  confirmedBy: nonEmpty,
  loopbackAllowlist: zod.array(zod.number().int().min(0).max(65535)),
  presenceAcknowledged: zod.boolean(),
})

/**
 * Parse one wire value against a schema and re-throw as a facade error, so a
 * malformed Remote argument rejects with one boundary error type.
 * @param schema - schema the value must satisfy.
 * @param field - argument name the value arrived under.
 * @param value - value as received from the Remote caller.
 * @returns the parsed value.
 * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_CONFIG_INVALID` when the value does not
 *   satisfy the schema.
 */
function parse<T>(schema: zod.ZodType<T>, field: string, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const detail = result.error.issues
      .map(issue => `${issue.path.length === 0 ? field : issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new SelfDevelopmentRemoteError(`${field} is invalid: ${detail}`, 'SELF_DEV_REMOTE_CONFIG_INVALID')
  }
  return result.data
}

/**
 * Whether a path is absolute on the current platform.
 * @param value - path as received.
 * @returns whether the path is absolute.
 */
function isAbsolute(value: string): boolean {
  return value.startsWith('/')
}

/**
 * Validate a task id against the task-control package's grammar.
 * @param taskId - task identity as received.
 * @returns the same id once proven to be a plain path component.
 * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_CONFIG_INVALID` when the id is not a
 *   plain task id.
 */
export function parseTaskId(taskId: string): string {
  try {
    validateTaskId(taskId)
  } catch (error: unknown) {
    /* v8 ignore next 3 -- validateTaskId only throws SelfDevelopmentError, so the non-Error branch is unreachable. */
    throw new SelfDevelopmentRemoteError(
      `taskId ${JSON.stringify(taskId)} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      'SELF_DEV_REMOTE_CONFIG_INVALID',
    )
  }
  return taskId
}

/**
 * Validate a `createTask` spec and its revision header.
 * @param spec - TaskSpec in wire form.
 * @param expectedRevision - revision the caller observed.
 * @returns the parsed spec and revision.
 * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_CONFIG_INVALID` when either field is malformed.
 */
export function parseCreateTaskInput(spec: unknown, expectedRevision: unknown): {
  readonly spec: TaskSpecInput
  readonly expectedRevision: number
} {
  const parsed = parse(taskSpecSchema, 'spec', spec)
  parseTaskId(parsed.taskId)
  return {
    spec: parsed,
    expectedRevision: parse(zod.number().int().min(0), 'expectedRevision', expectedRevision),
  }
}

/**
 * Validate an actor name.
 * @param actor - actor as received.
 * @returns the same actor once proven non-empty.
 * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_CONFIG_INVALID` when the name is empty.
 */
export function parseActor(actor: string): string {
  return parse(nonEmpty, 'actor', actor)
}

/**
 * Validate an `authorizePlanning` request body.
 * @param taskId - task identity as received.
 * @param expectedRevision - revision the caller observed.
 * @param authorizedBy - human actor granting the authorization.
 * @returns the parsed body.
 * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_CONFIG_INVALID` when a field is malformed.
 */
export function parseAuthorizePlanningInput(
  taskId: string,
  expectedRevision: number,
  authorizedBy: string,
): { readonly taskId: string; readonly expectedRevision: number; readonly authorizedBy: string } {
  return {
    taskId: parseTaskId(taskId),
    expectedRevision: parse(zod.number().int().min(0), 'expectedRevision', expectedRevision),
    authorizedBy: parse(nonEmpty, 'authorizedBy', authorizedBy),
  }
}

/**
 * Validate a `submitPlanDraft` request body.
 * @param taskId - task identity as received.
 * @param expectedRevision - revision the caller observed.
 * @param draft - plan draft in wire form.
 * @returns the parsed body.
 * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_CONFIG_INVALID` when a field is malformed.
 */
export function parseSubmitPlanDraftInput(taskId: string, expectedRevision: number, draft: unknown): {
  readonly taskId: string
  readonly expectedRevision: number
  readonly draft: unknown
} {
  return {
    taskId: parseTaskId(taskId),
    expectedRevision: parse(zod.number().int().min(0), 'expectedRevision', expectedRevision),
    draft: parse(planDraftSchema, 'draft', draft),
  }
}

/**
 * Validate a `confirmPlan` request body.
 * @param taskId - task identity as received.
 * @param expectedRevision - revision the caller observed.
 * @param plan - confirmed plan in wire form.
 * @param actor - human actor confirming the plan.
 * @returns the parsed body.
 * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_CONFIG_INVALID` when a field is malformed.
 */
export function parseConfirmPlanInput(
  taskId: string,
  expectedRevision: number,
  plan: unknown,
  actor: string,
): {
  readonly taskId: string
  readonly expectedRevision: number
  readonly plan: unknown
  readonly actor: string
} {
  return {
    taskId: parseTaskId(taskId),
    expectedRevision: parse(zod.number().int().min(0), 'expectedRevision', expectedRevision),
    plan: parse(confirmedPlanSchema, 'plan', plan),
    actor: parseActor(actor),
  }
}

/**
 * Validate an `approveBudget` request body.
 * @param taskId - task identity as received.
 * @param expectedRevision - revision the caller observed.
 * @param approval - budget approval in wire form.
 * @returns the parsed body.
 * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_CONFIG_INVALID` when a field is malformed.
 */
export function parseApproveBudgetInput(taskId: string, expectedRevision: number, approval: unknown): {
  readonly taskId: string
  readonly expectedRevision: number
  readonly approval: BudgetApprovalInput
} {
  return {
    taskId: parseTaskId(taskId),
    expectedRevision: parse(zod.number().int().min(0), 'expectedRevision', expectedRevision),
    approval: parse(budgetApprovalSchema, 'approval', approval),
  }
}

/**
 * Validate a `stop` request body.
 * @param taskId - task identity as received.
 * @param expectedRevision - revision the caller observed.
 * @param reason - optional stop reason; only `cancelled` exists today.
 * @returns the parsed body.
 * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_CONFIG_INVALID` when a field is malformed.
 */
export function parseStopInput(
  taskId: string,
  expectedRevision: number,
  reason: 'cancelled' | undefined,
): { readonly taskId: string; readonly expectedRevision: number; readonly reason: 'cancelled' | undefined } {
  return {
    taskId: parseTaskId(taskId),
    expectedRevision: parse(zod.number().int().min(0), 'expectedRevision', expectedRevision),
    reason: reason === undefined ? undefined : parse(zod.literal('cancelled'), 'reason', reason),
  }
}

/**
 * Validate a `recordTrialApproval` request body.
 * @param taskId - task identity as received.
 * @param expectedRevision - revision the caller observed.
 * @param approvedBy - human actor approving the trial.
 * @returns the parsed body.
 * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_CONFIG_INVALID` when a field is malformed.
 */
export function parseRecordTrialApprovalInput(taskId: string, expectedRevision: number, approvedBy: string): {
  readonly taskId: string
  readonly expectedRevision: number
  readonly approvedBy: string
} {
  return {
    taskId: parseTaskId(taskId),
    expectedRevision: parse(zod.number().int().min(0), 'expectedRevision', expectedRevision),
    approvedBy: parse(nonEmpty, 'approvedBy', approvedBy),
  }
}

/**
 * Validate a `runAttempt` request.
 * @param request - the supervised attempt request in wire form.
 * @returns the parsed request.
 * @throws SelfDevelopmentRemoteError with `SELF_DEV_REMOTE_CONFIG_INVALID` when a field is malformed.
 */
export function parseRunAttemptRequest(request: unknown): RemoteRunAttemptRequest {
  return parse(runAttemptSchema, 'request', request)
}
