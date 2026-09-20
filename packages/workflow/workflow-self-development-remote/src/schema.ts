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
import type { CampaignRecord } from './campaign.ts'
import type {
  LaunchProfile,
  LaunchProfileInput,
  BudgetApprovalInput,
  CampaignOptions,
  RemoteRunAttemptRequest,
  TaskSpecInput,
} from './types.ts'

/** Non-empty string with no length beyond what the field needs. */
const nonEmpty = zod.string().min(1)

/** Absolute path string, as every stored facade path field must be. */
const absolutePath = zod.string().refine(isAbsolute, 'must be an absolute path')

/** Loopback port number a supervised session may bind. */
const loopbackPort = zod.number().int().min(0).max(65535)

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

/**
 * Milliseconds in 24 hours: the hard cap `approveBudget`'s effective
 * `durationMs` may not exceed, whether explicit or preset-expanded.
 */
export const MAX_BUDGET_DURATION_MS = 24 * 60 * 60 * 1000

/**
 * The `preset: 'unlimited'` expansion: a 24-hour time budget with a
 * conservative per-phase, per-attempt, and no-progress bound.
 */
export const UNLIMITED_BUDGET_PRESET = {
  mode: 'time' as const,
  durationMs: MAX_BUDGET_DURATION_MS,
  phaseTimeoutMs: 600_000,
  maxStepsPerAttempt: 40,
  noProgressAttemptLimit: 5,
}

/** Wire form of a budget approval; mirrors the core's `budgetApprovalSchema`, plus the `preset` convenience field. */
const budgetApprovalSchema = zod.strictObject({
  preset: zod.literal('unlimited').optional(),
  mode: zod.enum(['rounds', 'time', 'both']).optional(),
  maxRounds: zod.number().int().min(1).optional(),
  durationMs: zod.number().positive().optional(),
  phaseTimeoutMs: zod.number().positive().optional(),
  maxStepsPerAttempt: zod.number().int().min(1).optional(),
  noProgressAttemptLimit: zod.number().int().min(1).optional(),
  testPlanVersion: zod.number().int().min(1),
  taskSpecVersion: zod.number().int().min(1),
  approvedBy: nonEmpty,
}).refine(value => value.preset !== undefined || value.mode !== undefined, {
  message: 'mode is required when preset is absent',
  path: ['mode'],
}).refine(value => value.durationMs === undefined || value.durationMs <= MAX_BUDGET_DURATION_MS, {
  message: `durationMs must not exceed the 24-hour cap (${MAX_BUDGET_DURATION_MS}ms)`,
  path: ['durationMs'],
})

/**
 * Expand a wire budget approval's `preset` convenience field into concrete
 * budget fields, so the core never sees the literal. A field the caller also
 * set explicitly overrides that field's preset default. Absent `preset`
 * returns the input with only that field stripped; `budgetApprovalSchema`
 * already proved `mode` is then present and `durationMs` is within the cap.
 * @param input - wire approval already proven to satisfy `budgetApprovalSchema`.
 * @returns the approval with `preset` removed and `mode` always present.
 */
function expandBudgetPreset(input: zod.infer<typeof budgetApprovalSchema>): BudgetApprovalInput {
  const { preset, ...explicit } = input
  if (preset === undefined) return explicit
  return {
    mode: explicit.mode ?? UNLIMITED_BUDGET_PRESET.mode,
    ...(explicit.maxRounds === undefined ? {} : { maxRounds: explicit.maxRounds }),
    durationMs: explicit.durationMs ?? UNLIMITED_BUDGET_PRESET.durationMs,
    phaseTimeoutMs: explicit.phaseTimeoutMs ?? UNLIMITED_BUDGET_PRESET.phaseTimeoutMs,
    maxStepsPerAttempt: explicit.maxStepsPerAttempt ?? UNLIMITED_BUDGET_PRESET.maxStepsPerAttempt,
    noProgressAttemptLimit: explicit.noProgressAttemptLimit ?? UNLIMITED_BUDGET_PRESET.noProgressAttemptLimit,
    testPlanVersion: explicit.testPlanVersion,
    taskSpecVersion: explicit.taskSpecVersion,
    approvedBy: explicit.approvedBy,
  }
}

/**
 * Wire form of `startCampaign`'s options. Not marked `hostOnly` field-by-field:
 * `startCampaign`, `campaign`, and `stopCampaign` are host-only in full (the
 * facade refuses the whole method for a non-host caller with
 * `assertCallerIsHost`, the same gate `setLaunchProfile` uses), so no field
 * needs the per-field `assertHostOnlyFields` mechanism.
 */
const campaignOptionsSchema = zod.strictObject({
  unattended: zod.boolean(),
  acceptedBy: nonEmpty,
  maxConcurrentCampaigns: zod.number().int().min(1).optional(),
})

/** Stored form of one campaign record file: `CampaignState` plus the `startCampaign` options it derives rounds from. */
const campaignRecordSchema = zod.strictObject({
  taskId: nonEmpty,
  status: zod.enum(['running', 'passed', 'exhausted', 'stopped', 'failed']),
  startedAt: zod.number(),
  updatedAt: zod.number(),
  rounds: zod.number().int().min(0),
  lastAttemptId: nonEmpty.optional(),
  lastOutcome: zod.enum(['passed', 'failed', 'cancelled', 'late', 'unknown']).optional(),
  reason: nonEmpty.optional(),
  acknowledgement: zod.enum(['supervised-not-unattended', 'unattended-accepted']),
  unattended: zod.boolean(),
  acceptedBy: nonEmpty,
})

/** Wire form of a `runAttempt` request. The five launch fields are optional: an absent field is derived from the task's launch profile. */
const runAttemptSchema = zod.strictObject({
  taskId: nonEmpty,
  expectedRevision: zod.number().int().min(0),
  worktree: absolutePath.optional(),
  artifactPaths: zod.array(zod.string().min(1)).min(1).optional(),
  acceptancePath: absolutePath.optional(),
  // host-only: the per-attempt data directory is assigned by the stable-side
  // workspace service, so a phone caller must omit it; the stable host passes
  // the workspaces `allocate` result's `dataHome` through as the runner's `dshHome`.
  dataHome: absolutePath
    .meta({ hostOnly: true })
    .optional(),
  confirmedBy: nonEmpty.optional(),
  loopbackAllowlist: zod.array(loopbackPort).optional(),
  presenceAcknowledged: zod.boolean(),
})

/**
 * Wire form of a launch profile handed to `setLaunchProfile` or as
 * `createTask`'s third argument. Every field is marked `hostOnly`: the whole
 * argument is an isolation-and-confirmation setting, so a non-host caller
 * that sends any profile at all is refused with
 * `self-development/host-only-field`.
 */
const launchProfileInputSchema = zod.strictObject({
  worktree: absolutePath.meta({ hostOnly: true }),
  acceptancePath: absolutePath.meta({ hostOnly: true }),
  artifactPaths: zod.array(zod.string().min(1)).min(1).meta({ hostOnly: true }).optional(),
  dataHome: absolutePath.meta({ hostOnly: true }).optional(),
  loopbackAllowlist: zod.array(loopbackPort).meta({ hostOnly: true }).optional(),
  confirmedBy: nonEmpty.meta({ hostOnly: true }).optional(),
})

/** Stored form of one launch profile file: the input with every derived field filled. */
const launchProfileSchema = launchProfileInputSchema.extend({
  artifactPaths: zod.array(zod.string().min(1)).min(1),
  loopbackAllowlist: zod.array(loopbackPort),
  confirmedBy: nonEmpty,
  updatedAt: zod.number(),
})

/**
 * Host-only field paths per wire schema, keyed by schema name. Populated only
 * through {@link registerHostOnlyFields} so the paths always come from the
 * schemas' `hostOnly` metadata, never from a second hand-written list.
 */
const hostOnlyFieldsBySchema = new Map<string, readonly string[]>()

/**
 * Read the `hostOnly` marker of one wire-schema node, looking through the
 * wrapper the schema carries it under (`.meta({ hostOnly: true }).optional()`
 * stores the marker on the inner schema, `.optional().meta(...)` on the
 * wrapper itself).
 * @param schema - schema node as it appears in the wire schema.
 * @returns whether the node is marked host-only.
 */
function nodeIsHostOnly(schema: zod.ZodType): boolean {
  const meta = zod.globalRegistry.get(schema) as { readonly hostOnly?: boolean } | undefined
  if (meta?.hostOnly === true) return true
  const inner = schema as Partial<{ unwrap?: () => zod.ZodType }>
  if (typeof inner.unwrap !== 'function') return false
  return nodeIsHostOnly(inner.unwrap())
}

/**
 * Collect the dotted paths of every field a wire schema marks `hostOnly`,
 * recursing into nested objects. New host-only fields are picked up by
 * marking them with `.meta({ hostOnly: true })`; nothing else to update.
 * @param schema - wire schema to scan.
 * @param prefix - dotted path prefix of `schema` inside its root schema.
 * @returns the collected field paths, in schema order.
 */
function collectHostOnlyFieldPaths(schema: zod.ZodType, prefix = ''): readonly string[] {
  const paths: string[] = []
  const shape = (schema as Partial<{ shape?: Record<string, zod.ZodType> }>).shape
  if (shape === undefined) return paths
  for (const [key, value] of Object.entries(shape)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (nodeIsHostOnly(value)) {
      paths.push(path)
      continue
    }
    paths.push(...collectHostOnlyFieldPaths(value, path))
  }
  return paths
}

/**
 * Register a wire schema's host-only fields under the name its facade method
 * checks with. Every schema carrying a `hostOnly` field registers here.
 * @param schemaName - name the facade's `assertHostOnlyFields` call addresses.
 * @param schema - wire schema whose `hostOnly` markers define the fields.
 */
export function registerHostOnlyFields(schemaName: string, schema: zod.ZodType): void {
  hostOnlyFieldsBySchema.set(schemaName, collectHostOnlyFieldPaths(schema))
}

registerHostOnlyFields('runAttempt', runAttemptSchema)
registerHostOnlyFields('launchProfile', launchProfileInputSchema)

/**
 * Read a parsed wire value at one dotted field path.
 * @param input - parsed value as it will reach the core or runner.
 * @param path - dotted field path collected from the schema's metadata.
 * @returns the value at the path; `undefined` when absent or when an
 *   intermediate object is absent.
 */
function readPath(input: unknown, path: string): unknown {
  let current: unknown = input
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Refuse a request that carries any host-only field from a non-host caller.
 * Runs after wire parsing and before the core or runner is touched, so an
 * isolation-setting field from a phone caller never reaches either.
 * @param schemaName - name the wire schema was registered under.
 * @param input - parsed request value to inspect.
 * @param callerIsHost - whether the caller counts as the stable host.
 * @throws SelfDevelopmentRemoteError with `self-development/host-only-field` when `callerIsHost` is
 *   `false` and any registered host-only field of the schema is set to a
 *   non-`undefined` value.
 */
export function assertHostOnlyFields(schemaName: string, input: unknown, callerIsHost: boolean): void {
  if (callerIsHost) return
  const fields = hostOnlyFieldsBySchema.get(schemaName)
  if (fields === undefined) return
  for (const field of fields) {
    if (readPath(input, field) === undefined) continue
    throw new SelfDevelopmentRemoteError(
      'self-development/host-only-field',
      `${schemaName}.${field} is host-only; a non-host caller must omit it`,
    )
  }
}

/**
 * Parse one wire value against a schema and re-throw as a facade error, so a
 * malformed Remote argument rejects with one boundary error type.
 * @param schema - schema the value must satisfy.
 * @param field - argument name the value arrived under.
 * @param value - value as received from the Remote caller.
 * @returns the parsed value.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when the value does not
 *   satisfy the schema.
 */
function parse<T>(schema: zod.ZodType<T>, field: string, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const detail = result.error.issues
      .map(issue => `${issue.path.length === 0 ? field : issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new SelfDevelopmentRemoteError('self-development/config-invalid', `${field} is invalid: ${detail}`)
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
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when the id is not a
 *   plain task id.
 */
export function parseTaskId(taskId: string): string {
  try {
    validateTaskId(taskId)
  } catch (error: unknown) {
    /* v8 ignore next 3 -- validateTaskId only throws SelfDevelopmentError, so the non-Error branch is unreachable. */
    throw new SelfDevelopmentRemoteError(
      'self-development/config-invalid',
      `taskId ${JSON.stringify(taskId)} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return taskId
}

/**
 * Validate a `createTask` spec, its revision header, and the optional launch
 * profile.
 * @param spec - TaskSpec in wire form.
 * @param expectedRevision - revision the caller observed.
 * @param launchProfile - optional launch profile in wire form.
 * @returns the parsed spec, revision, and profile.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when any field is malformed.
 */
export function parseCreateTaskInput(spec: unknown, expectedRevision: unknown, launchProfile: unknown): {
  readonly spec: TaskSpecInput
  readonly expectedRevision: number
  readonly launchProfile: LaunchProfileInput | undefined
} {
  const parsed = parse(taskSpecSchema, 'spec', spec)
  parseTaskId(parsed.taskId)
  return {
    spec: parsed,
    expectedRevision: parse(zod.number().int().min(0), 'expectedRevision', expectedRevision),
    launchProfile: launchProfile === undefined
      ? undefined
      : parse(launchProfileInputSchema, 'launchProfile', launchProfile),
  }
}

/**
 * Validate a launch profile handed to `setLaunchProfile`.
 * @param profile - launch profile in wire form.
 * @returns the parsed profile with the derived fields still absent.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when a field is malformed.
 */
export function parseLaunchProfileInput(profile: unknown): LaunchProfileInput {
  return parse(launchProfileInputSchema, 'launchProfile', profile)
}

/**
 * Validate the stored launch profile read back from one file. The failure
 * message names the file path and the violated field, never the file content.
 * @param path - absolute path of the profile file the value was read from.
 * @param value - the parsed JSON value of the file.
 * @returns the validated profile.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when the value does not
 *   satisfy the stored profile schema.
 */
export function parseStoredLaunchProfile(path: string, value: unknown): LaunchProfile {
  const result = launchProfileSchema.safeParse(value)
  if (!result.success) {
    const detail = result.error.issues
      .map(issue => `${issue.path.length === 0 ? 'profile' : issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new SelfDevelopmentRemoteError('self-development/config-invalid', `launch profile ${path} is invalid: ${detail}`)
  }
  return result.data
}

/**
 * Validate an `expectedRevision` header shared by every mutating method.
 * @param expectedRevision - revision as received.
 * @returns the same revision once proven a non-negative integer.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when it is not a
 *   non-negative integer.
 */
export function parseExpectedRevision(expectedRevision: unknown): number {
  return parse(zod.number().int().min(0), 'expectedRevision', expectedRevision)
}

/**
 * Validate `stopCampaign`'s free-text `reason`. Non-empty only: the facade
 * places no vocabulary restriction on it, but an event title never carries it
 * verbatim (see the events package's `campaign-ended` mapping).
 * @param reason - stop reason as received.
 * @returns the same reason once proven non-empty.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when it is empty.
 */
export function parseCampaignStopReason(reason: unknown): string {
  return parse(nonEmpty, 'reason', reason)
}

/**
 * Validate an actor name.
 * @param actor - actor as received.
 * @returns the same actor once proven non-empty.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when the name is empty.
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
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when a field is malformed.
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
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when a field is malformed.
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
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when a field is malformed.
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
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when a field is malformed.
 */
export function parseApproveBudgetInput(taskId: string, expectedRevision: number, approval: unknown): {
  readonly taskId: string
  readonly expectedRevision: number
  readonly approval: BudgetApprovalInput
} {
  return {
    taskId: parseTaskId(taskId),
    expectedRevision: parse(zod.number().int().min(0), 'expectedRevision', expectedRevision),
    approval: expandBudgetPreset(parse(budgetApprovalSchema, 'approval', approval)),
  }
}

/**
 * Validate a `startCampaign` options argument.
 * @param options - campaign options in wire form.
 * @returns the parsed options.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when a field is malformed.
 */
export function parseCampaignOptions(options: unknown): CampaignOptions {
  return parse(campaignOptionsSchema, 'options', options)
}

/**
 * Validate the stored campaign record read back from one file. The failure
 * message names the file path and the violated field, never the file content.
 * @param path - absolute path of the campaign file the value was read from.
 * @param value - the parsed JSON value of the file.
 * @returns the validated record.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when the value does not
 *   satisfy the stored campaign record schema.
 */
export function parseStoredCampaignRecord(path: string, value: unknown): CampaignRecord {
  const result = campaignRecordSchema.safeParse(value)
  if (!result.success) {
    const detail = result.error.issues
      .map(issue => `${issue.path.length === 0 ? 'record' : issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new SelfDevelopmentRemoteError('self-development/config-invalid', `campaign record ${path} is invalid: ${detail}`)
  }
  return result.data
}

/**
 * Validate a `stop` request body.
 * @param taskId - task identity as received.
 * @param expectedRevision - revision the caller observed.
 * @param reason - optional stop reason; only `cancelled` exists today.
 * @returns the parsed body.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when a field is malformed.
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
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when a field is malformed.
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
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when a field is malformed.
 */
export function parseRunAttemptRequest(request: unknown): RemoteRunAttemptRequest {
  return parse(runAttemptSchema, 'request', request)
}
