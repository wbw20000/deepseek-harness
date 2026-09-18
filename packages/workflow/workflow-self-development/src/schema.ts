/**
 * Package-owned schema validation for durable and wire inputs. Every value
 * that enters from a journal file, a config file, or a trusted-host call is
 * parsed here before the domain logic sees it; same-process callers of the
 * typed controller methods are not re-validated.
 * @module @deepseek-ai/dsh-workflow-self-development/schema
 */

import { z as zod } from 'zod'
import { SelfDevelopmentError } from './runtime.ts'

/** hex sha-256 digest as it appears on the wire. */
const digestSchema = zod.string().regex(/^[0-9a-f]{64}$/u, 'digest must be 64 lowercase hex characters')

/** Non-empty string with no surrounding whitespace tolerance. */
const nonEmpty = zod.string().min(1)

/** Parsed wire form of a required acceptance case. */
const requiredCaseSchema = zod.strictObject({
  caseId: nonEmpty,
  requirement: nonEmpty,
  assertionIds: zod.array(nonEmpty).min(1),
})

/** Wire form of a {@link TaskSpec}. */
export const taskSpecSchema = zod.strictObject({
  taskId: nonEmpty,
  version: zod.number().int().min(1),
  requirement: nonEmpty,
  allowedModificationScope: zod.array(nonEmpty).min(1),
  stableBaselineDigest: digestSchema,
  createdBy: nonEmpty,
})

/** Wire form of a {@link TestPlanDraft}. */
export const planDraftSchema = zod.strictObject({
  requiredCases: zod.array(requiredCaseSchema).min(1),
  manualCases: zod.array(nonEmpty),
})

/** Wire form of a confirmed {@link FrozenTestPlan} minus the computed digest. */
export const confirmedPlanSchema = zod.strictObject({
  testPlanId: nonEmpty,
  version: zod.number().int().min(1),
  taskSpecVersion: zod.number().int().min(1),
  requiredCases: zod.array(requiredCaseSchema).min(1),
  manualCases: zod.array(nonEmpty),
})

/** Wire form of a {@link BudgetApproval}. */
export const budgetApprovalSchema = zod.strictObject({
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

/** Wire form of one {@link AssertionResult}. */
const assertionResultSchema = zod.strictObject({
  assertionId: nonEmpty,
  status: zod.enum(['pass', 'fail', 'skipped']),
})

/** Wire form of one {@link CaseResult}. */
const caseResultSchema = zod.strictObject({
  caseId: nonEmpty,
  assertions: zod.array(assertionResultSchema),
})

/** Wire form of one observed {@link PhaseRun}. */
const phaseRunSchema = zod.strictObject({
  phaseId: nonEmpty,
  durationMs: zod.number().nonnegative(),
})

/** Wire form of an externally supplied {@link TestResult}. */
export const testResultSchema = zod.strictObject({
  taskId: nonEmpty,
  attemptId: nonEmpty,
  sourceDigest: digestSchema,
  artifactDigest: digestSchema,
  testPlanDigest: digestSchema,
  exitCode: zod.number().int().nullable(),
  signal: zod.string().nullable(),
  timedOut: zod.boolean(),
  cancelled: zod.boolean(),
  cases: zod.array(caseResultSchema),
  phases: zod.array(phaseRunSchema).optional(),
  stepsUsed: zod.number().int().nonnegative().optional(),
})

/** Wire form of every durable {@link TaskEvent} stored in a journal record. */
export const taskEventSchema = zod.discriminatedUnion('type', [
  zod.strictObject({ type: zod.literal('task/created'), spec: taskSpecSchema }),
  zod.strictObject({ type: zod.literal('task/planning-authorized'), authorizedBy: nonEmpty }),
  zod.strictObject({ type: zod.literal('plan/drafted'), draft: planDraftSchema }),
  zod.strictObject({ type: zod.literal('plan/confirmed'), plan: confirmedPlanSchema.extend({ digest: digestSchema }) }),
  zod.strictObject({ type: zod.literal('budget/approved'), approval: budgetApprovalSchema }),
  zod.strictObject({ type: zod.literal('attempt/started'), attempt: zod.strictObject({
    attemptId: nonEmpty,
    attemptNumber: zod.number().int().min(1),
    startedAt: zod.strictObject({ bootId: nonEmpty, monotonicMs: zod.number().nonnegative() }),
    testPlanDigest: digestSchema,
    sourceDigest: digestSchema,
    artifactDigest: digestSchema,
    capabilityDigest: digestSchema,
  }) }),
  zod.strictObject({ type: zod.literal('attempt/failed'), attemptId: nonEmpty, reason: nonEmpty,
    failureDigest: zod.string().regex(/^[0-9a-f]{64}$/u), elapsedMs: zod.number().nonnegative(),
    timeAccounting: zod.enum(['measured', 'uncertain']) }),
  zod.strictObject({ type: zod.literal('task/passed'), attemptId: nonEmpty, resultDigest: nonEmpty,
    elapsedMs: zod.number().nonnegative(), timeAccounting: zod.enum(['measured', 'uncertain']) }),
  zod.strictObject({ type: zod.literal('trial/approved'), approvedBy: nonEmpty, resultDigest: nonEmpty }),
  zod.strictObject({ type: zod.literal('task/stopped'), reason: zod.enum(['cancelled', 'budget-exhausted', 'no-progress']) }),
  zod.strictObject({ type: zod.literal('handoff/raised'), reason: zod.enum(['journal-incomplete-tail', 'journal-corrupted', 'attempt-interrupted', 'clock-uncertain']), detail: nonEmpty }),
])

/** Wire form of the idempotency facts stored with a committed operation. */
export const committedOperationSchema = zod.strictObject({
  id: nonEmpty,
  expectedRevision: zod.number().int().min(0),
  payloadDigest: zod.string().regex(/^[0-9a-f]{64}$/u, 'digest must be 64 lowercase hex characters'),
})

/** Wire form of an {@link OperationHeader}. */
export const operationHeaderSchema = zod.strictObject({
  taskId: nonEmpty,
  expectedRevision: zod.number().int().min(0),
  operationId: nonEmpty,
})

/**
 * Parse one durable or wire value with a package-owned schema.
 * @param schema - zod schema owning the value's structure.
 * @param schemaName - schema name used in the rejection message.
 * @param value - untrusted value to parse.
 * @returns the parsed value.
 * @throws SelfDevelopmentError with `SELF_DEV_INVALID_OPERATION` when the value does not satisfy the schema.
 */
export function parseInput<S extends zod.ZodType>(schema: S, schemaName: string, value: unknown): zod.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new SelfDevelopmentError(
      `${schemaName} does not satisfy the package schema: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
      'SELF_DEV_INVALID_OPERATION',
    )
  }
  return parsed.data
}
