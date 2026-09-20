/** Shared test fixtures: wire-view builders and scriptable faces. */
import { vi } from 'vitest'
import { SelfDevTaskId, TaskSpecVersion, TestPlanDigest, TestPlanVersion } from '@deepseek-ai/dsh-workflow-self-development'
import type { SelfDevelopmentApi, SelfDevelopmentAvailability } from '../src/client/face.ts'
import type { ConfirmationCard, LaunchProfile, RecentEvent, RemoteTaskProjection, TaskDetail, TaskSummary } from '@deepseek-ai/dsh-workflow-self-development-remote'

/** One task row. */
export function summary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return { taskId: SelfDevTaskId('task-1'), status: 'ready', revision: 3, title: '修复导出按钮', ...overrides }
}

/** One required acceptance case. */
export function requiredCase(caseId = 'case-1'): { caseId: string; requirement: string; assertionIds: string[] } {
  return { caseId, requirement: '导出按钮点击后生成文件', assertionIds: ['assert-1'] }
}

/** One card view in the shape the facade builds, optionally carrying the launch profile. */
export function card(overrides: Partial<ConfirmationCard> = {}): ConfirmationCard {
  return {
    taskId: 'task-1',
    taskAndGoal: '为导出菜单补充一个批量导出入口',
    acceptanceCases: [requiredCase()],
    manualCases: ['深色模式下核对图标对比度'],
    planningAuthorized: true,
    suggestedBudgetBasis: '无依据',
    stableBaselineDigest: 'a'.repeat(64),
    allowedModificationScope: ['apps/web/src/**'],
    budget: { mode: 'both', maxRounds: 4, durationMs: 600000 },
    consumedBudget: { rounds: 1, timeMs: 90000 },
    costLimits: '未知，不放行',
    ...overrides,
  }
}

/** One projection in the wire view's JSON convention. */
export function projection(overrides: Partial<RemoteTaskProjection> = {}): RemoteTaskProjection {
  return {
    status: 'ready',
    planningAuthorized: true,
    consumedRounds: 1,
    consumedTimeMs: 90000,
    timeBudgetFrozen: false,
    noProgressCount: 0,
    revision: 3,
    spec: {
      taskId: SelfDevTaskId('task-1'), version: TaskSpecVersion(1), requirement: '为导出菜单补充一个批量导出入口',
      allowedModificationScope: ['apps/web/src/**'], stableBaselineDigest: 'a'.repeat(64), createdBy: 'mima',
    },
    plan: {
      testPlanId: 'plan-1', version: TestPlanVersion(2), taskSpecVersion: TaskSpecVersion(1), digest: TestPlanDigest('b'.repeat(64)),
      requiredCases: [requiredCase()], manualCases: ['深色模式下核对图标对比度'],
    },
    ...overrides,
  }
}

/** One task detail: projection plus its card. */
export function detail(overrides: { projection?: Partial<RemoteTaskProjection>; card?: Partial<ConfirmationCard> } = {}): TaskDetail {
  return { projection: projection(overrides.projection), card: card(overrides.card) }
}

/** A view minus the given optional keys, for exactOptionalPropertyTypes-safe omissions. */
export function omit<T extends object>(value: T, keys: readonly (keyof T & string)[]): T {
  const excluded = new Set<string>(keys)
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !excluded.has(key)),
  ) as unknown as T
}

/** A projection minus optional keys, for statuses that carry neither a plan nor a spec. */
export function projectionWithout(
  base: RemoteTaskProjection,
  keys: readonly ('plan' | 'spec' | 'handoffDetail')[],
): RemoteTaskProjection {
  return omit(base, keys)
}

/** One unified event in the facade's wire view. */
export function event(overrides: Partial<RecentEvent> = {}): RecentEvent {
  return { taskId: 'task-1', kind: 'turn-finished', origin: 'commit', title: '第 1 轮结束', occurredAt: 1_700_000_000_000, revision: 2, ...overrides }
}

/** One stored launch profile, as `card.launchProfile` carries it. */
export function launchProfile(): LaunchProfile {
  return {
    worktree: '/experiments/wt-1',
    acceptancePath: '/repo/acceptance.yml',
    artifactPaths: ['apps/web/dist/**'],
    loopbackAllowlist: [],
    confirmedBy: 'mima',
    updatedAt: 1_700_000_000_000,
  }
}

/** A scripted Remote face: every method records its call and answers with the given result. */
export function scriptableApi(handlers: Partial<Record<keyof SelfDevelopmentApi, unknown>> = {}): SelfDevelopmentApi {
  const ok = (value: object) => ({ ok: true as const, value })
  const base = {
    listTasks: vi.fn(async () => ok([summary()])),
    getTask: vi.fn(async () => ok(detail())),
    recentEvents: vi.fn(async () => ok([])),
    createTask: vi.fn(async () => ok({ taskId: 'task-2', operationId: 'op-0', revision: 1, replayed: false })),
    submitPlanDraft: vi.fn(async () => ok({ taskId: 'task-1', operationId: 'op-7', revision: 4, replayed: false })),
    setLaunchProfile: vi.fn(async () => ok({ taskId: 'task-1', launchProfile: launchProfile() })),
    authorizePlanning: vi.fn(async () => ok({ taskId: 'task-1', operationId: 'op-1', revision: 4, replayed: false })),
    confirmPlan: vi.fn(async () => ok({ taskId: 'task-1', operationId: 'op-2', revision: 4, replayed: false })),
    approveBudget: vi.fn(async () => ok({ taskId: 'task-1', operationId: 'op-3', revision: 4, replayed: false })),
    runAttempt: vi.fn(async () => ok({
      operation: { revision: 4, replayed: false }, attemptId: 'attempt-1', evidencePath: '/tmp/evidence',
      worktree: '/experiments/wt-1', operationId: 'op-4',
    })),
    stop: vi.fn(async () => ok({ taskId: 'task-1', operationId: 'op-5', revision: 4, replayed: false })),
    recordTrialApproval: vi.fn(async () => ok({ taskId: 'task-1', operationId: 'op-6', revision: 4, replayed: false })),
  }
  return { ...base, ...handlers } as SelfDevelopmentApi
}

/** The availability fact a live composition reports. */
export const live: SelfDevelopmentAvailability = { remote: true }

/** The availability fact a composition without the namespace reports. */
export const offline: SelfDevelopmentAvailability = { remote: false }
