/**
 * The merge orchestration: the approval hard gate, default and explicit task
 * resolution (only `awaiting-trial`), `recordTrialApproval`, the four
 * `integrate` outcomes and their events, the auto-started unattended repair
 * campaign on `conflict`/`verification-failed` (no second approval), and the
 * post-integration upgrade hook. The facade, approval, workspaces, and
 * runner ports are fakes; the baseline digest is stubbed so the repair
 * campaign's own `runPropose` call never shells out to git.
 * @module merge.spec
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/baseline.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/baseline.ts')>()
  return {
    ...actual,
    readBaselineDigest: vi.fn(async () => 'd'.repeat(64)),
  }
})

import { acceptancePath } from '../src/acceptance.ts'
import { resolveChatConfig } from '../src/config.ts'
import { runMerge } from '../src/merge.ts'
import type { MergeDeps } from '../src/merge.ts'
import type {
  ApprovalPort,
  CampaignState,
  FacadeOperationResult,
  IntegrationRequest,
  IntegrationResult,
  LaunchProfileWire,
  MergeBlockedEventPayload,
  MergeIntegratedEventPayload,
  RunnerVerifyPort,
  SelfDevelopmentRemoteFacade,
  TaskDetailView,
  TaskWorkspaceView,
  VerifyOutcome,
  WorkspacesPort,
} from '../src/types.ts'

/** A valid acceptance definition with cases c1 and c2 — matches `writeAcceptanceDefinitionAt`'s default. */
const ACCEPTANCE_TEXT = JSON.stringify({
  cases: [
    { caseId: 'c1', command: ['node', 'test.js'], timeoutMs: 5000, assertions: [{ assertionId: 'c1-a1', kind: 'exit-code', expected: 0 }] },
    { caseId: 'c2', command: ['node', 'lint.js'], timeoutMs: 5000, assertions: [{ assertionId: 'c2-a1', kind: 'exit-code', expected: 0 }] },
  ],
})

/** Write the standard acceptance definition to `<controlDirectory>/acceptance/<taskId>.json`, as `propose` would have. */
async function writeAcceptanceAt(controlDirectory: string, taskId: string): Promise<void> {
  const path = acceptancePath(controlDirectory, taskId)
  await mkdir(join(controlDirectory, 'acceptance'), { recursive: true })
  await writeFile(path, ACCEPTANCE_TEXT, 'utf8')
}

/** One `TaskDetailView` fixture, `awaiting-trial` by default. */
function taskDetail(overrides: Partial<TaskDetailView['projection']> = {}): TaskDetailView {
  return {
    projection: {
      status: 'awaiting-trial',
      revision: 5,
      spec: { requirement: 'add chat transcript search' },
      consumedRounds: 3,
      consumedTimeMs: 4000,
      planningAuthorized: true,
      noProgressCount: 0,
      ...overrides,
    },
    card: { launchProfile: { worktree: '/exp/task-1', acceptancePath: '/control/acceptance/task-1.json' } },
  }
}

/** Recording facade fake: `tasks` answers `getTask` per id (falling back to `defaultTask`), mutations bump `revision`. */
class FakeFacade implements SelfDevelopmentRemoteFacade {
  calls: { name: string; args: unknown[] }[] = []
  revision = 0
  tasks = new Map<string, TaskDetailView>()
  defaultTask: TaskDetailView | undefined = taskDetail()
  getTaskFailFor: Set<string> = new Set()
  recordTrialApprovalFailWith: Error | undefined
  integrateResult: IntegrationResult = { status: 'integrated', commit: 'c'.repeat(40), baseMoved: false }

  private step(name: string, args: unknown[]): FacadeOperationResult {
    this.calls.push({ name, args })
    this.revision += 1
    return { taskId: 'task-1', operationId: `op-${name}`, revision: this.revision, replayed: false }
  }

  async createTask(spec: unknown, expectedRevision: number, launchProfile?: LaunchProfileWire): Promise<FacadeOperationResult> {
    return this.step('createTask', [spec, expectedRevision, launchProfile])
  }

  async authorizePlanning(taskId: string, expectedRevision: number, authorizedBy: string): Promise<FacadeOperationResult> {
    return this.step('authorizePlanning', [taskId, expectedRevision, authorizedBy])
  }

  async submitPlanDraft(taskId: string, expectedRevision: number, draft: unknown): Promise<FacadeOperationResult> {
    return this.step('submitPlanDraft', [taskId, expectedRevision, draft])
  }

  async confirmPlan(taskId: string, expectedRevision: number, plan: unknown, actor: string): Promise<FacadeOperationResult> {
    return this.step('confirmPlan', [taskId, expectedRevision, plan, actor])
  }

  async approveBudget(taskId: string, expectedRevision: number, approval: unknown): Promise<FacadeOperationResult> {
    return this.step('approveBudget', [taskId, expectedRevision, approval])
  }

  async startCampaign(taskId: string, expectedRevision: number, options: unknown): Promise<{ taskId: string; campaign: CampaignState }> {
    const result = this.step('startCampaign', [taskId, expectedRevision, options])
    return {
      taskId,
      campaign: {
        taskId,
        status: 'running',
        startedAt: 1,
        updatedAt: result.revision,
        rounds: 0,
        acknowledgement: 'unattended-accepted',
      },
    }
  }

  async campaign(taskId: string): Promise<CampaignState | undefined> {
    this.calls.push({ name: 'campaign', args: [taskId] })
    return undefined
  }

  async stopCampaign(taskId: string, reason: string): Promise<CampaignState> {
    this.calls.push({ name: 'stopCampaign', args: [taskId, reason] })
    return { taskId, status: 'stopped', startedAt: 1, updatedAt: 2, rounds: 1, reason, acknowledgement: 'unattended-accepted' }
  }

  async getTask(taskId: string): Promise<TaskDetailView> {
    this.calls.push({ name: 'getTask', args: [taskId] })
    if (this.getTaskFailFor.has(taskId)) throw new Error(`getTask(${taskId}) failed`)
    const detail = this.tasks.get(taskId) ?? this.defaultTask
    if (detail === undefined) throw new Error(`no task ${taskId}`)
    return detail
  }

  async recordTrialApproval(taskId: string, expectedRevision: number, approvedBy: string): Promise<FacadeOperationResult> {
    this.calls.push({ name: 'recordTrialApproval', args: [taskId, expectedRevision, approvedBy] })
    if (this.recordTrialApprovalFailWith !== undefined) throw this.recordTrialApprovalFailWith
    this.revision += 1
    return { taskId, operationId: 'op-recordTrialApproval', revision: this.revision, replayed: false }
  }
}

/** Approval fake recording every request. */
class FakeApproval implements ApprovalPort {
  requests: { readonly toolName: string; readonly reason?: string }[] = []
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'allowed-once'

  async request(request: { readonly agent: unknown; readonly toolName: string; readonly reason?: string }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> {
    this.requests.push(request)
    return this.outcome
  }
}

/** Workspaces fake: `allocate` for the repair campaign's own propose call, `integrate` for the merge itself. */
class FakeWorkspaces implements WorkspacesPort {
  integrateRequests: IntegrationRequest[] = []
  integrateResult: IntegrationResult = { status: 'integrated', commit: 'c'.repeat(40), baseMoved: false }
  integrateFailWith: Error | undefined

  async allocate(request: { taskId: string; projectRoot: string }): Promise<TaskWorkspaceView> {
    return {
      taskId: request.taskId,
      projectRoot: request.projectRoot,
      baseCommit: 'a'.repeat(40),
      worktree: `/exp/${request.taskId}`,
      branch: `self-dev/${request.taskId}`,
      dataHome: `/exp/${request.taskId}/.data`,
      allocatedAt: 1,
    }
  }

  async integrate(request: IntegrationRequest): Promise<IntegrationResult> {
    this.integrateRequests.push(request)
    if (this.integrateFailWith !== undefined) throw this.integrateFailWith
    return this.integrateResult
  }
}

/** Runner verification fake. */
class FakeRunner implements RunnerVerifyPort {
  calls: { worktree: string; acceptancePath: string }[] = []
  outcome: VerifyOutcome = { ok: true }

  async verifyAcceptance(worktree: string, acceptancePath: string): Promise<VerifyOutcome> {
    this.calls.push({ worktree, acceptancePath })
    return this.outcome
  }
}

let root: string | undefined

afterEach(async () => {
  vi.clearAllMocks()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Harness bundling the fakes and a temp control directory. */
async function makeDeps(overrides: Partial<MergeDeps> = {}): Promise<{
  facade: FakeFacade
  approval: FakeApproval
  workspaces: FakeWorkspaces
  runner: FakeRunner
  deps: MergeDeps
  control: string
}> {
  root = await mkdtemp(join(tmpdir(), 'self-dev-chat-merge-'))
  const control = join(root, 'control')
  const facade = new FakeFacade()
  const approval = new FakeApproval()
  const workspaces = new FakeWorkspaces()
  const runner = new FakeRunner()
  const deps: MergeDeps = {
    facade,
    approval,
    workspaces,
    runner,
    config: resolveChatConfig({
      stableRepo: '/repo',
      controlDirectory: control,
      experimentsRoot: join(root, 'exp'),
      actor: 'user',
      targetBranch: 'stable',
    }),
    agent: { id: 'agent-1' },
    callId: 'call-1',
    knownTaskIds: ['task-1'],
    // Simulates a dirty worktree by default, so the "nothing to merge"
    // pre-check never short-circuits a test that is not itself about that
    // check — every existing scenario proceeds to the normal merge attempt,
    // exactly as before this pre-check existed.
    git: async (args: readonly string[]) => (args[0] === 'status' ? 'M some-file.txt' : 'unused-rev'),
    ...overrides,
  }
  return { facade, approval, workspaces, runner, deps, control }
}

describe('runMerge: task resolution', () => {
  it('rejects an explicit taskId that is not awaiting-trial', async () => {
    const { facade, deps } = await makeDeps()
    facade.tasks.set('task-9', taskDetail({ status: 'ready' }))
    const outcome = await runMerge(deps, { taskId: 'task-9' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('task-9')
    expect(outcome.reason).toContain('not awaiting-trial')
  })

  it('rejects an explicit taskId whose lookup fails', async () => {
    const { facade, deps } = await makeDeps()
    facade.getTaskFailFor.add('task-9')
    const outcome = await runMerge(deps, { taskId: 'task-9' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('lookup failed')
  })

  it('rejects when no task is awaiting-trial and none was given', async () => {
    const { facade, deps } = await makeDeps({ knownTaskIds: ['task-1', 'task-2'] })
    facade.tasks.set('task-1', taskDetail({ status: 'ready' }))
    facade.tasks.set('task-2', taskDetail({ status: 'exhausted' }))
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('no awaiting-trial task found')
  })

  it('takes the most recently known awaiting-trial task, searching newest first', async () => {
    const { facade, deps } = await makeDeps({ knownTaskIds: ['task-1', 'task-2', 'task-3'] })
    facade.tasks.set('task-1', taskDetail({ status: 'awaiting-trial' }))
    facade.tasks.set('task-2', taskDetail({ status: 'ready' })) // newer than task-1, but not awaiting-trial: skipped
    facade.tasks.set('task-3', taskDetail({ status: 'exhausted' })) // newest, also not a match
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.taskId).toBe('task-1')
  })

  it('skips a lookup failure for a newer known task and falls through to an older awaiting-trial one', async () => {
    const { facade, deps } = await makeDeps({ knownTaskIds: ['task-1', 'task-2'] })
    facade.tasks.set('task-1', taskDetail({ status: 'awaiting-trial' }))
    facade.getTaskFailFor.add('task-2') // newest known id, but its lookup throws: caught and skipped
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.taskId).toBe('task-1')
  })

  it('skips a hole in knownTaskIds without throwing', async () => {
    const { facade, deps } = await makeDeps({ knownTaskIds: ['task-1', undefined as unknown as string] })
    facade.tasks.set('task-1', taskDetail({ status: 'awaiting-trial' }))
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.taskId).toBe('task-1')
  })
})

describe('runMerge: nothing to merge', () => {
  it('rejects before any approval request when the worktree is clean and already at the target tip', async () => {
    const { approval, deps } = await makeDeps({
      git: async (args: readonly string[]) => (args[0] === 'status' ? '' : 'same-commit'),
    })
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('nothing to merge')
    expect(approval.requests).toEqual([])
  })

  it('proceeds normally when the worktree is dirty even though HEAD already equals the target tip', async () => {
    const { deps } = await makeDeps({
      git: async (args: readonly string[]) => (args[0] === 'status' ? 'M dirty.txt' : 'same-commit'),
    })
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(true)
  })

  it('proceeds normally when the worktree is clean but HEAD differs from the target tip', async () => {
    const { deps } = await makeDeps({
      git: async (args: readonly string[]) => {
        if (args[0] === 'status') return ''
        return args[1] === 'HEAD' ? 'commit-a' : 'commit-b'
      },
    })
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(true)
  })

  it('fails open (proceeds normally) when the git check itself throws', async () => {
    const { deps } = await makeDeps({ git: async () => { throw new Error('git not found') } })
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(true)
  })

  it('fails open when the task has no launch profile worktree yet, without calling git', async () => {
    const { facade, deps } = await makeDeps({ git: async () => { throw new Error('must not be called without a worktree') } })
    const withoutLaunchProfile = facade.defaultTask
    if (withoutLaunchProfile === undefined) throw new Error('test setup: defaultTask must be set')
    facade.defaultTask = { ...withoutLaunchProfile, card: { launchProfile: undefined } }
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(true)
  })
})

describe('runMerge: required ports fail closed before any approval request', () => {
  it('fails when the runner is not mounted', async () => {
    const { approval, deps } = await makeDeps({ runner: undefined })
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('selfDevelopmentRunner is not mounted')
    expect(approval.requests).toEqual([])
  })

  it('fails when workspaces is not mounted', async () => {
    const { approval, deps } = await makeDeps({ workspaces: undefined })
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('workspaces service is not mounted')
    expect(approval.requests).toEqual([])
  })

  it('fails when approval is not mounted', async () => {
    const { deps } = await makeDeps({ approval: undefined })
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('approval service is not mounted')
  })
})

describe('runMerge: approval', () => {
  it('asks once, naming the task and target branch, and does nothing else when not allowed-once', async () => {
    const { facade, approval, workspaces, deps } = await makeDeps()
    approval.outcome = 'rejected'
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('approval outcome was rejected')
    expect(approval.requests).toHaveLength(1)
    expect(approval.requests[0]?.toolName).toBe('self_development_merge')
    expect(approval.requests[0]?.reason).toContain('task-1')
    expect(approval.requests[0]?.reason).toContain('stable')
    expect(facade.calls.filter(call => call.name === 'recordTrialApproval')).toEqual([])
    expect(workspaces.integrateRequests).toEqual([])
  })

  it('omits callId from the approval request when none was given', async () => {
    const { deps } = await makeDeps({ callId: undefined })
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(true)
  })
})

describe('runMerge: recordTrialApproval', () => {
  it('records approval with the task\'s current revision before integrating', async () => {
    const { facade, deps } = await makeDeps()
    await runMerge(deps, {})
    const call = facade.calls.find(entry => entry.name === 'recordTrialApproval')
    expect(call?.args).toEqual(['task-1', 5, 'user'])
  })

  it('reports a recordTrialApproval failure without integrating', async () => {
    const { facade, workspaces, deps } = await makeDeps()
    facade.recordTrialApprovalFailWith = new Error('conflict: already approved')
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('recordTrialApproval failed')
    expect(outcome.error?.message).toBe('conflict: already approved')
    expect(workspaces.integrateRequests).toEqual([])
  })
})

describe('runMerge: integrate outcomes', () => {
  it('reports an integrate failure', async () => {
    const { workspaces, deps } = await makeDeps()
    workspaces.integrateFailWith = new Error('lock timeout')
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('integrate failed')
    expect(outcome.error?.message).toBe('lock timeout')
  })

  it('passes taskId, targetBranch, actor, a verify function, and a snapshot request to integrate', async () => {
    const { workspaces, deps } = await makeDeps()
    await runMerge(deps, {})
    expect(workspaces.integrateRequests).toHaveLength(1)
    const request = workspaces.integrateRequests[0]
    expect(request?.taskId).toBe('task-1')
    expect(request?.targetBranch).toBe('stable')
    expect(request?.actor).toBe('user')
    expect(typeof request?.verify).toBe('function')
    // taskDetail()'s default projection.spec.requirement is 'add chat transcript search'.
    expect(request?.snapshot).toEqual({
      message: 'selfdev(task-1): add chat transcript search',
      author: { name: 'DSH self-development', email: 'self-development@dsh.local' },
    })
  })

  it('uses the configured commitIdentity as the snapshot author', async () => {
    const { workspaces, deps: baseDeps } = await makeDeps()
    const deps: MergeDeps = {
      ...baseDeps,
      config: resolveChatConfig({ ...baseDeps.config, commitIdentity: { name: 'Custom Bot', email: 'bot@example.com' } }),
    }
    await runMerge(deps, {})
    expect(workspaces.integrateRequests[0]?.snapshot?.author).toEqual({ name: 'Custom Bot', email: 'bot@example.com' })
  })

  it('caps the snapshot message\'s requirement portion at 72 characters, and falls back without a requirement', async () => {
    const { facade, workspaces, deps } = await makeDeps()
    const longRequirement = 'x'.repeat(100)
    facade.defaultTask = taskDetail({ spec: { requirement: longRequirement } })
    await runMerge(deps, {})
    expect(workspaces.integrateRequests[0]?.snapshot?.message).toBe(`selfdev(task-1): ${'x'.repeat(72)}`)

    const { facade: facade2, workspaces: workspaces2, deps: deps2 } = await makeDeps()
    facade2.defaultTask = taskDetail({ spec: undefined })
    await runMerge(deps2, {})
    expect(workspaces2.integrateRequests[0]?.snapshot?.message).toBe('selfdev(task-1)')
  })

  it('on integrated: emits merge-integrated and skips the upgrade when upgrade.kind is none', async () => {
    const { workspaces, deps } = await makeDeps()
    workspaces.integrateResult = { status: 'integrated', commit: 'f'.repeat(40), baseMoved: true }
    let integratedPayload: MergeIntegratedEventPayload | undefined
    const outcome = await runMerge({ ...deps, emitIntegrated: (payload) => { integratedPayload = payload } }, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toEqual({ status: 'integrated', commit: 'f'.repeat(40), baseMoved: true })
    expect(outcome.upgrade).toBeUndefined()
    // revision: 1 — the FakeFacade's recordTrialApproval is the only
    // revision-bumping call before the event fires (see its own class doc).
    expect(integratedPayload).toMatchObject({ taskId: 'task-1', commit: 'f'.repeat(40), baseMoved: true, revision: 1 })
    expect(integratedPayload?.snapshotCommit).toBeUndefined()
  })

  it('on integrated: carries a snapshotCommit into the local event payload when integrate reports one', async () => {
    const { workspaces, deps } = await makeDeps()
    workspaces.integrateResult = { status: 'integrated', commit: 'f'.repeat(40), baseMoved: true, snapshotCommit: 'a'.repeat(40) }
    let integratedPayload: MergeIntegratedEventPayload | undefined
    const outcome = await runMerge({ ...deps, emitIntegrated: (payload) => { integratedPayload = payload } }, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result).toMatchObject({ snapshotCommit: 'a'.repeat(40) })
    expect(integratedPayload?.snapshotCommit).toBe('a'.repeat(40))
  })

  it('on integrated: runs the configured upgrade and reports its outcome', async () => {
    const { deps: baseDeps } = await makeDeps()
    const deps: MergeDeps = {
      ...baseDeps,
      config: resolveChatConfig({
        ...baseDeps.config,
        upgrade: { kind: 'source', projectRoot: '/deploy', restartCommand: ['restart'] },
      }),
    }
    let upgradeCalledWithBranch: string | undefined
    const outcome = await runMerge({
      ...deps,
      upgradeDeps: {
        git: async (args) => { upgradeCalledWithBranch = args[2]; return 'Already up to date.' },
        readTextFile: async () => undefined,
        runCommand: async () => {},
        spawnDetached: () => {},
        exit: () => {},
        scheduleExit: (run) => { run() },
      },
    }, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.upgrade?.ok).toBe(true)
    expect(outcome.steps.some(step => step.step === 'upgrade')).toBe(true)
    expect(upgradeCalledWithBranch).toBe('stable')
  })

  it('on conflict: emits merge-blocked with the files and auto-starts an unattended repair campaign without a second approval', async () => {
    const { approval, control, deps } = await makeDeps()
    await writeAcceptanceAt(control, 'task-1')
    const workspaces = deps.workspaces as FakeWorkspaces
    workspaces.integrateResult = { status: 'conflict', files: ['src/a.ts', 'src/b.ts'], baseMoved: true }
    let blockedPayload: MergeBlockedEventPayload | undefined
    const outcome = await runMerge({ ...deps, emitBlocked: (payload) => { blockedPayload = payload } }, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.status).toBe('conflict')
    expect(outcome.repair?.ok).toBe(true)
    expect(approval.requests).toHaveLength(1) // the merge card only — no second card for the repair
    expect(blockedPayload).toMatchObject({ taskId: 'task-1', status: 'conflict', files: ['src/a.ts', 'src/b.ts'], revision: 1 })
    if (outcome.repair?.ok !== true) return
    expect(outcome.repair.taskId).not.toBe('task-1')
  })

  it('conflict repair requirement names the target branch and the conflicted files', async () => {
    const { control, deps } = await makeDeps()
    await writeAcceptanceAt(control, 'task-1')
    const workspaces = deps.workspaces as FakeWorkspaces
    workspaces.integrateResult = { status: 'conflict', files: ['src/a.ts'], baseMoved: true }
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const facade = deps.facade as FakeFacade
    const createTaskCall = facade.calls.find(call => call.name === 'createTask')
    const spec = createTaskCall?.args[0] as { requirement: string } | undefined
    expect(spec?.requirement).toContain('stable')
    expect(spec?.requirement).toContain('src/a.ts')
  })

  it('on verification-failed: emits merge-blocked with the reason and auto-starts a repair campaign naming it', async () => {
    const { control, deps } = await makeDeps()
    await writeAcceptanceAt(control, 'task-1')
    const workspaces = deps.workspaces as FakeWorkspaces
    workspaces.integrateResult = { status: 'verification-failed', reason: 'gate "pnpm test" exited with code 1', baseMoved: false }
    let blockedPayload: MergeBlockedEventPayload | undefined
    const outcome = await runMerge({ ...deps, emitBlocked: (payload) => { blockedPayload = payload } }, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.status).toBe('verification-failed')
    expect(outcome.repair?.ok).toBe(true)
    expect(blockedPayload).toMatchObject({ taskId: 'task-1', status: 'verification-failed', reason: 'gate "pnpm test" exited with code 1', revision: 1 })
    const facade = deps.facade as FakeFacade
    const createTaskCall = facade.calls.find(call => call.name === 'createTask')
    const spec = createTaskCall?.args[0] as { requirement: string } | undefined
    expect(spec?.requirement).toContain('gate "pnpm test" exited with code 1')
  })

  it('reports a repair campaign that failed to start (e.g. the acceptance definition is missing) without throwing', async () => {
    const { deps } = await makeDeps()
    // No writeAcceptanceAt: the definition file this repair would read was never written.
    const workspaces = deps.workspaces as FakeWorkspaces
    workspaces.integrateResult = { status: 'conflict', files: ['src/a.ts'], baseMoved: true }
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.repair?.ok).toBe(false)
    expect(outcome.steps.find(step => step.step === 'repair')?.detail).toBeTruthy()
  })

  it('reports a repair campaign that failed to start when the written acceptance definition is no longer valid JSON', async () => {
    const { control, deps } = await makeDeps()
    await mkdir(join(control, 'acceptance'), { recursive: true })
    await writeFile(join(control, 'acceptance', 'task-1.json'), '{ not valid json', 'utf8')
    const workspaces = deps.workspaces as FakeWorkspaces
    workspaces.integrateResult = { status: 'conflict', files: ['src/a.ts'], baseMoved: true }
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.repair?.ok).toBe(false)
    if (outcome.repair?.ok !== false) return
    expect(outcome.repair.reason).toContain('no longer valid')
  })

  it('starts the repair campaign without an agent or callId, and forwards a given signal and taskIdSuffix', async () => {
    const { control, deps } = await makeDeps({ agent: undefined, callId: undefined, signal: new AbortController().signal, taskIdSuffix: 'repair-fixed' })
    await writeAcceptanceAt(control, 'task-1')
    const workspaces = deps.workspaces as FakeWorkspaces
    workspaces.integrateResult = { status: 'conflict', files: ['src/a.ts'], baseMoved: true }
    const outcome = await runMerge(deps, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.repair?.ok).toBe(true)
    if (outcome.repair?.ok !== true) return
    expect(outcome.repair.taskId.endsWith('repair-fixed')).toBe(true)
  })

  it('on failed: emits merge-blocked with the reason and starts no repair campaign', async () => {
    const { approval, deps } = await makeDeps()
    const workspaces = deps.workspaces as FakeWorkspaces
    workspaces.integrateResult = { status: 'failed', reason: 'stable branch was force-pushed mid-merge' }
    let blockedPayload: MergeBlockedEventPayload | undefined
    const outcome = await runMerge({ ...deps, emitBlocked: (payload) => { blockedPayload = payload } }, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.status).toBe('failed')
    expect(outcome.repair).toBeUndefined()
    expect(blockedPayload).toMatchObject({ taskId: 'task-1', status: 'failed', reason: 'stable branch was force-pushed mid-merge', revision: 1 })
    expect(approval.requests).toHaveLength(1)
  })
})
