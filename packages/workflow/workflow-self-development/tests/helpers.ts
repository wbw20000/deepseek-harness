/**
 * Shared fixtures for the self-development task-control tests: a fake clock
 * at the only nondeterministic input, a disposable task directory, and the
 * standard task taken to `ready` status.
 * @module helpers
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { SelfDevelopmentTaskController } from '../src/controller.ts'
import { TaskJournal } from '../src/journal.ts'
import { CapabilityDigest, SelfDevOperationId, SelfDevTaskId } from '../src/runtime.ts'
import type { Attempt, CapabilitySource, OperationHeader, TrustedClock } from '../src/types.ts'

/** Fixed 64-hex digest used as the stable baseline. */
export const BASELINE = 'a'.repeat(64)
/** Fixed 64-hex digest used as the attempt source. */
export const SOURCE = 'b'.repeat(64)
/** Fixed 64-hex digest used as the attempt artifact. */
export const ARTIFACT = 'c'.repeat(64)
/** The one task id every fixture uses. */
export const TASK_ID = SelfDevTaskId('task-1')
/** Standard TaskSpec wire form. */
export const SPEC = {
  taskId: TASK_ID,
  version: 1,
  requirement: 'add chat transcript search',
  allowedModificationScope: ['packages/workflow/workflow-self-development/src'],
  stableBaselineDigest: BASELINE,
  createdBy: 'user',
} as const
/** Standard frozen-plan wire form. */
export const PLAN = {
  testPlanId: 'plan-1',
  version: 1,
  taskSpecVersion: 1,
  requiredCases: [{ caseId: 'c1', requirement: 'search finds a known message', assertionIds: ['a1'] }],
  manualCases: ['manual-review'],
} as const
/** Standard plan-draft wire form (no frozen-plan identity yet). */
export const DRAFT = {
  requiredCases: PLAN.requiredCases,
  manualCases: PLAN.manualCases,
} as const
/** Standard one-round budget wire form. */
export const BUDGET_ONE_ROUND = {
  mode: 'rounds',
  maxRounds: 1,
  phaseTimeoutMs: 60000,
  maxStepsPerAttempt: 50,
  testPlanVersion: 1,
  taskSpecVersion: 1,
  approvedBy: 'user',
} as const

/** Fake clock advanced explicitly by each test. */
export class FakeClock implements TrustedClock {
  #bootId = 'boot-1'
  #monotonicMs = 1000

  /** Read the current observation. */
  observe(): { bootId: string; monotonicMs: number } {
    return { bootId: this.#bootId, monotonicMs: this.#monotonicMs }
  }

  /** Advance the monotonic clock. */
  advance(ms: number): void {
    this.#monotonicMs += ms
  }

  /** Simulate a host reboot: new boot session, far larger monotonic reading. */
  reboot(): void {
    this.#bootId = 'boot-2'
    this.#monotonicMs += 5_000_000
  }
}

/** Per-test disposable task directory. */
export interface TaskFixture {
  /** Temporary root, removed after the test. */
  readonly root: string
  /** Journal directory for the task. */
  readonly dir: string
  /** Fake clock shared by the test and the controller. */
  readonly clock: FakeClock
}

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

/** Create a disposable task directory registered for cleanup. */
export async function makeTaskDir(): Promise<TaskFixture> {
  const root = await mkdtemp(join(tmpdir(), 'self-dev-task-'))
  roots.push(root)
  return { root, dir: join(root, 'tasks', TASK_ID), clock: new FakeClock() }
}

/** Operation header for the next expected revision. */
export function header(revision: number, operationId: string): OperationHeader {
  return { taskId: TASK_ID, expectedRevision: revision, operationId: SelfDevOperationId(operationId) }
}

/** Open a controller and drive the standard task to `ready` status. */
export async function openReadyTask(
  dir: string,
  clock: FakeClock,
  budget: Record<string, unknown> = BUDGET_ONE_ROUND,
  capabilitySource?: Parameters<typeof SelfDevelopmentTaskController.open>[0]['capabilitySource'],
): Promise<{ controller: SelfDevelopmentTaskController; revision: number }> {
  const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
  const controller = await SelfDevelopmentTaskController.open({ taskId: TASK_ID, journal, clock, capabilitySource })
  let revision = 0
  await controller.createTask({ ...header(revision, 'create'), spec: SPEC })
  revision = 1
  await controller.authorizePlanning({ ...header(revision, 'authorize'), authorizedBy: 'user' })
  revision = 2
  await controller.submitPlanDraft({ ...header(revision, 'draft'), draft: DRAFT })
  revision = 3
  await controller.confirmPlan({ ...header(revision, 'confirm'), plan: PLAN })
  revision = 4
  await controller.approveBudget({ ...header(revision, 'budget'), approval: budget })
  revision = controller.projection.status === 'ready' ? 5 : 6
  return { controller, revision }
}

/** Build a fully passing result for the given attempt. */
export function passingResult(attempt: Attempt): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    attemptId: attempt.attemptId,
    sourceDigest: attempt.sourceDigest,
    artifactDigest: attempt.artifactDigest,
    testPlanDigest: attempt.testPlanDigest,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    phases: [{ phaseId: 'test', durationMs: 1 }],
    stepsUsed: 1,
    cases: [{ caseId: 'c1', assertions: [{ assertionId: 'a1', status: 'pass' }] }],
  }
}

/** Override one deep field of a passing result for rejection tests. */
export function resultWith(attempt: Attempt, patch: Record<string, unknown>): Record<string, unknown> {
  return { ...passingResult(attempt), ...patch }
}

/** All capabilities covered, as the future evidence provider would report. */
export const capabilityEvidence = [
  { capability: 'supervisor', digest: CapabilityDigest('d'.repeat(64)) },
  { capability: 'storage-quota', digest: CapabilityDigest('d'.repeat(64)) },
  { capability: 'sandbox-coverage', digest: CapabilityDigest('d'.repeat(64)) },
  { capability: 'external-verifier', digest: CapabilityDigest('d'.repeat(64)) },
]

/** Capability source covering every required capability. */
export const fullCapabilitySource: CapabilitySource = {
  evidence: () => capabilityEvidence,
}
