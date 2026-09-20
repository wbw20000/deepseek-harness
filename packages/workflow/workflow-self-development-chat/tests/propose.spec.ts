/**
 * The proposal orchestration: schema-level input rejection, the single
 * approval gate, the eight-step sequence with its exact facade arguments,
 * the mid-sequence failure report, and the workspace fallback. The facade,
 * approval, and workspace ports are fakes; the baseline digest is stubbed so
 * no proposal test shells out to git.
 * @module propose.spec
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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

import { readBaselineDigest } from '../src/baseline.ts'
import { proposeInputViolation, resolveProposeInput, runPropose } from '../src/propose.ts'
import type { ProposeDeps } from '../src/propose.ts'
import { resolveChatConfig } from '../src/config.ts'
import type {
  ApprovalPort,
  CampaignState,
  FacadeOperationResult,
  IntegrationResult,
  LaunchProfileWire,
  ResolvedProposeInput,
  SelfDevelopmentRemoteFacade,
  TaskDetailView,
  TaskWorkspaceView,
  WorkspacesPort,
} from '../src/types.ts'

/** Standard campaign state a fake startCampaign returns. */
const CAMPAIGN: CampaignState = {
  taskId: 'task-1',
  status: 'running',
  startedAt: 1,
  updatedAt: 2,
  rounds: 1,
  acknowledgement: 'unattended-accepted',
}

/** A valid acceptance definition with cases c1 and c2. */
const ACCEPTANCE = {
  cases: [
    { caseId: 'c1', command: ['node', 'test.js'], timeoutMs: 5000, assertions: [{ assertionId: 'c1-a1', kind: 'exit-code', expected: 0 }] },
    { caseId: 'c2', command: ['node', 'lint.js'], timeoutMs: 5000, assertions: [{ assertionId: 'c2-a1', kind: 'exit-code', expected: 0 }] },
  ],
}

/** A valid proposal input, fully specified (every optional field filled) so it also satisfies `ResolvedProposeInput` directly. */
function proposeInput(overrides: Record<string, unknown> = {}): ResolvedProposeInput {
  return {
    requirement: 'add chat transcript search',
    allowedModificationScope: ['packages/**'],
    plan: {
      requiredCases: [{ caseId: 'c1', requirement: 'search finds a known message', assertionIds: ['c1-a1'] }],
      manualCases: ['manual-review'],
    },
    acceptance: ACCEPTANCE,
    budget: { preset: 'unlimited' },
    unattended: true,
    parallel: true,
    ...overrides,
  }
}

/** Recording facade fake; `failOn` throws for one step, `campaigns` answers `campaign()`. */
class FakeFacade implements SelfDevelopmentRemoteFacade {
  calls: { name: string; args: unknown[] }[] = []
  revision = 0
  failOn: string | undefined
  failWith: Error = new Error('boom')
  campaigns = new Map<string, CampaignState>()

  async createTask(spec: unknown, expectedRevision: number, launchProfile: LaunchProfileWire): Promise<FacadeOperationResult> {
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
    return { taskId, campaign: { ...CAMPAIGN, taskId, updatedAt: result.revision } }
  }

  async campaign(taskId: string): Promise<CampaignState | undefined> {
    this.calls.push({ name: 'campaign', args: [taskId] })
    return this.campaigns.get(taskId)
  }

  async stopCampaign(taskId: string, reason: string): Promise<CampaignState> {
    this.calls.push({ name: 'stopCampaign', args: [taskId, reason] })
    return { ...CAMPAIGN, taskId, status: 'stopped', reason }
  }

  async getTask(taskId: string): Promise<TaskDetailView> {
    this.calls.push({ name: 'getTask', args: [taskId] })
    return {
      projection: {
        status: 'ready',
        revision: 5,
        spec: { requirement: 'add chat transcript search' },
        consumedRounds: 2,
        consumedTimeMs: 3000,
        planningAuthorized: true,
        noProgressCount: 0,
      },
      card: {
        launchProfile: {
          worktree: '/exp/task-1',
          acceptancePath: '/control/acceptance/task-1.json',
          dataHome: '/exp/task-1/.data',
        },
      },
    }
  }

  /** Not exercised by this file's tests (merge is covered by merge.spec.ts); wired through `step` for consistency. */
  async recordTrialApproval(taskId: string, expectedRevision: number, approvedBy: string): Promise<FacadeOperationResult> {
    return this.step('recordTrialApproval', [taskId, expectedRevision, approvedBy])
  }

  /** Record one step, apply the configured failure, and bump the revision. */
  private step(name: string, args: unknown[]): FacadeOperationResult {
    this.calls.push({ name, args })
    if (this.failOn === name) throw this.failWith
    this.revision += 1
    return { taskId: 'task-1', operationId: `op-${name}`, revision: this.revision, replayed: false }
  }
}

/** Approval fake recording every request. */
class FakeApproval implements ApprovalPort {
  requests: unknown[] = []
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'allowed-once'

  async request(request: { readonly agent: unknown; readonly toolName: string; readonly reason?: string }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> {
    this.requests.push(request)
    return this.outcome
  }
}

/** Workspaces fake with a configurable allocation. */
class FakeWorkspaces implements WorkspacesPort {
  allocations: { taskId: string; projectRoot: string }[] = []
  worktree = '/exp/task-1'
  dataHome: string | undefined = '/exp/task-1/.data'
  failWith: Error | undefined

  async allocate(request: { taskId: string; projectRoot: string }): Promise<TaskWorkspaceView> {
    this.allocations.push(request)
    if (this.failWith !== undefined) throw this.failWith
    return {
      taskId: request.taskId,
      projectRoot: request.projectRoot,
      baseCommit: 'a'.repeat(40),
      worktree: this.worktree,
      branch: `self-dev/${request.taskId}`,
      dataHome: this.dataHome ?? '/exp/.data',
      allocatedAt: 1,
    }
  }

  /** Not exercised by this file's tests (merge is covered by merge.spec.ts). */
  integrate(): Promise<IntegrationResult> {
    throw new Error('FakeWorkspaces.integrate is not exercised in propose.spec.ts')
  }
}

/** Harness bundling the fakes and a temp control directory. */
async function makeDeps(overrides: Partial<ProposeDeps> = {}): Promise<{
  facade: FakeFacade
  approval: FakeApproval
  workspaces: FakeWorkspaces
  deps: ProposeDeps
  control: string
  root: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'self-dev-chat-propose-'))
  const control = join(root, 'control')
  const facade = new FakeFacade()
  const approval = new FakeApproval()
  const workspaces = new FakeWorkspaces()
  const deps: ProposeDeps = {
    facade,
    approval,
    workspaces,
    config: resolveChatConfig({
      stableRepo: '/repo',
      controlDirectory: control,
      experimentsRoot: join(root, 'exp'),
      actor: 'user',
      targetBranch: 'stable',
    }),
    agent: { id: 'agent-1' },
    callId: 'call-1',
    knownTaskIds: [],
    ...overrides,
  }
  return { facade, approval, workspaces, deps, control, root }
}

const roots: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('proposeInputViolation', () => {
  it('accepts a valid input', () => {
    expect(proposeInputViolation(proposeInput())).toBeUndefined()
  })

  it('rejects empty requirement, empty scope, and empty required cases', () => {
    expect(proposeInputViolation(proposeInput({ requirement: '   ' }))).toContain('requirement')
    expect(proposeInputViolation(proposeInput({ allowedModificationScope: [] }))).toContain('allowedModificationScope')
    expect(proposeInputViolation(proposeInput({ plan: { requiredCases: [], manualCases: [] } }))).toContain('requiredCases')
  })

  it('rejects an over-ceiling time budget and a plan case the definition lacks', () => {
    expect(proposeInputViolation(proposeInput({ budget: { mode: 'time', hours: 25 } }))).toContain('hours')
    expect(proposeInputViolation(proposeInput({
      plan: { requiredCases: [{ caseId: 'c9', requirement: 'r', assertionIds: [] }], manualCases: [] },
    }))).toContain('c9')
  })
})

describe('runPropose', () => {
  it('fails closed before any approval request when controlDirectory resolves inside experimentsRoot', async () => {
    // The exact field-test bug this guards: the runner refuses to judge an
    // acceptance definition placed inside the experiments root, so a nested
    // controlDirectory failed every campaign round closed for 20,000 rounds.
    // Re-checked here (not only once at construction) in case the directories
    // were swapped after the service was constructed; before the approval
    // request, since there is no reason to ask the user first.
    const root = await mkdtemp(join(tmpdir(), 'self-dev-chat-propose-placement-'))
    roots.push(root)
    const experimentsRoot = join(root, 'exp')
    const controlDirectory = join(experimentsRoot, 'control')
    await mkdir(controlDirectory, { recursive: true })
    const facade = new FakeFacade()
    const approval = new FakeApproval()
    const deps: ProposeDeps = {
      facade,
      approval,
      workspaces: new FakeWorkspaces(),
      config: resolveChatConfig({ stableRepo: '/repo', controlDirectory, experimentsRoot, actor: 'user', targetBranch: 'stable' }),
      agent: { id: 'agent-1' },
      callId: 'call-1',
      knownTaskIds: [],
    }
    const outcome = await runPropose(deps, proposeInput())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.steps).toEqual([])
    expect(outcome.reason).toContain('must live outside experimentsRoot')
    expect(approval.requests).toHaveLength(0)
    expect(facade.calls).toHaveLength(0)
  })

  it('asks once and performs no facade call when the approval is not allowed-once', async () => {
    const { facade, approval, deps } = await makeDeps()
    approval.outcome = 'rejected'
    const outcome = await runPropose(deps, proposeInput())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.steps).toEqual([])
    expect(outcome.reason).toContain('approval outcome was rejected')
    expect(approval.requests).toHaveLength(1)
    expect(facade.calls).toHaveLength(0)
  })

  it('fails closed when no approval service is mounted', async () => {
    const { deps } = await makeDeps({ approval: undefined })
    const outcome = await runPropose(deps, proposeInput())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.steps).toEqual([])
    expect(outcome.reason).toContain('approval service is not mounted')
  })

  it('shows the bilingual card content, allocates, writes acceptance, and drives all six facade steps in order', async () => {
    const { facade, approval, deps, control } = await makeDeps()
    const outcome = await runPropose(deps, proposeInput())

    // The approval card names everything the single approval covers.
    const request = approval.requests[0] as { agent: unknown; toolName: string; reason: string; callId: unknown }
    expect(request.toolName).toBe('self_development_propose')
    expect(request.agent).toEqual({ id: 'agent-1' })
    expect(request.callId).toBe('call-1')
    expect(request.reason).toContain('需求：add chat transcript search')
    expect(request.reason).toContain('验收用例：c1；人工核验：manual-review')
    expect(request.reason).toContain('预算：不限制（时间上限 24 小时）')
    expect(request.reason).toContain('无人值守：是——一次确认覆盖全部轮次，无 OS 隔离')
    expect(request.reason).toContain(`工作区：${join(control, '..', 'exp')}`)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(readBaselineDigest).toHaveBeenCalledWith(deps.config.stableRepo)
    expect(outcome.baselineDigest).toBe('d'.repeat(64))
    expect(outcome.steps.map(step => step.step)).toEqual([
      'approval', 'workspace', 'baseline', 'acceptance', 'createTask',
      'authorizePlanning', 'submitPlanDraft', 'confirmPlan', 'approveBudget', 'startCampaign',
    ])
    expect(outcome.campaign.status).toBe('running')
    expect(outcome.workspace).toBe('/exp/task-1')

    const names = facade.calls.map(call => call.name)
    expect(names).toEqual([
      'createTask', 'authorizePlanning', 'submitPlanDraft', 'confirmPlan', 'approveBudget', 'startCampaign',
    ])

    // Revisions thread from each operation result into the next call.
    const revisions = facade.calls.map(call => call.args[1] as number)
    expect(revisions).toEqual([0, 1, 2, 3, 4, 5])

    const spec = facade.calls[0]!.args[0] as Record<string, unknown>
    expect(spec).toMatchObject({
      version: 1,
      requirement: 'add chat transcript search',
      allowedModificationScope: ['packages/**'],
      stableBaselineDigest: 'd'.repeat(64),
      createdBy: 'user',
    })
    const launchProfile = facade.calls[0]!.args[2] as LaunchProfileWire
    expect(launchProfile).toMatchObject({
      worktree: '/exp/task-1',
      dataHome: '/exp/task-1/.data',
      acceptancePath: expect.stringContaining(join(control, 'acceptance')) as string,
      confirmedBy: 'user',
    })
    const draft = facade.calls[2]!.args[2]
    expect(draft).toEqual({
      requiredCases: [{ caseId: 'c1', requirement: 'search finds a known message', assertionIds: ['c1-a1'] }],
      manualCases: ['manual-review'],
    })
    const frozen = facade.calls[3]!.args[2]
    expect(frozen).toMatchObject({ testPlanId: `plan-${outcome.taskId}`, version: 1, taskSpecVersion: 1 })
    const budget = facade.calls[4]!.args[2]
    expect(budget).toMatchObject({ preset: 'unlimited', mode: 'time', durationMs: 24 * 3600 * 1000, approvedBy: 'user' })
    const campaignOptions = facade.calls[5]!.args[2]
    expect(campaignOptions).toEqual({ unattended: true, acceptedBy: 'user' })
  })

  it('allocates through the workspaces service with the stable repo as project root', async () => {
    const { workspaces, deps } = await makeDeps()
    const outcome = await runPropose(deps, proposeInput())
    expect(outcome.ok).toBe(true)
    expect(workspaces.allocations).toHaveLength(1)
    expect(workspaces.allocations[0]!.projectRoot).toBe('/repo')
    expect(workspaces.allocations[0]!.taskId).toBe(outcome.ok ? outcome.taskId : undefined)
  })

  it('falls back to an existing pre-allocated experiments directory and refuses a missing one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'self-dev-chat-fb-'))
    roots.push(root)
    const experimentsRoot = join(root, 'exp')
    // deriveTaskId('fallback task', 'fallback') kebab-cases every word from the
    // requirement, then appends the suffix — "fallback-task-fallback", not
    // just "fallback-task".
    await mkdir(join(experimentsRoot, 'fallback-task-fallback'), { recursive: true })
    const { deps } = await makeDeps({
      workspaces: undefined,
      config: resolveChatConfig({
        stableRepo: '/repo',
        controlDirectory: join(root, 'control'),
        experimentsRoot,
        actor: 'user',
        targetBranch: 'stable',
      }),
      // The task id is derived from the requirement; seed it deterministically.
      taskIdSuffix: 'fallback',
    })
    const outcome = await runPropose(deps, proposeInput({ requirement: 'fallback task' }))
    expect(outcome).toMatchObject({ ok: true, workspace: join(experimentsRoot, 'fallback-task-fallback') })

    const missing = await makeDeps({
      workspaces: undefined,
      config: resolveChatConfig({
        stableRepo: '/repo',
        controlDirectory: join(root, 'control'),
        experimentsRoot: join(root, 'no-such-root'),
        actor: 'user',
        targetBranch: 'stable',
      }),
      taskIdSuffix: 'missing',
    })
    const refused = await runPropose(missing.deps, proposeInput({ requirement: 'missing task' }))
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.reason).toBe('workspace allocation failed')
    expect(refused.steps.map(step => step.step)).toEqual(['approval', 'workspace'])
    expect(refused.error?.message).toContain('does not exist')
  })

  it('reports the workspace failure with its error code', async () => {
    const { workspaces, deps } = await makeDeps()
    workspaces.failWith = Object.assign(new Error('chain locked'), { code: 'self-development/workspace-busy' })
    const outcome = await runPropose(deps, proposeInput())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toEqual({ code: 'self-development/workspace-busy', message: 'chain locked' })
    expect(outcome.steps.map(step => step.step)).toEqual(['approval', 'workspace'])
  })

  it('stops at the first failing facade step and reports the steps done so far', async () => {
    const { facade, deps } = await makeDeps()
    facade.failOn = 'approveBudget'
    facade.failWith = Object.assign(new Error('budget over ceiling'), { details: { code: 'self-development/config-invalid' } })
    const outcome = await runPropose(deps, proposeInput())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('facade step approveBudget failed')
    expect(outcome.error).toEqual({ code: 'self-development/config-invalid', message: 'budget over ceiling' })
    expect(outcome.steps.map(step => step.step)).toEqual([
      'approval', 'workspace', 'baseline', 'acceptance', 'createTask',
      'authorizePlanning', 'submitPlanDraft', 'confirmPlan',
    ])
  })

  it('refuses a non-parallel proposal while a known task has a running campaign', async () => {
    const { facade, deps } = await makeDeps()
    facade.campaigns.set('earlier-task', { ...CAMPAIGN, taskId: 'earlier-task', status: 'running' })
    const outcome = await runPropose({ ...deps, knownTaskIds: ['earlier-task'] }, proposeInput({ parallel: false }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('parallel is false and task earlier-task has a running campaign')
    expect(outcome.steps).toEqual([])
    // The conflict check itself is one read-only `campaign` call; no mutating
    // facade call (createTask, approveBudget, ...) ever runs.
    expect(facade.calls).toEqual([{ name: 'campaign', args: ['earlier-task'] }])
  })

  it('allows a non-parallel proposal when every known campaign has settled', async () => {
    const { facade, deps } = await makeDeps()
    facade.campaigns.set('earlier-task', { ...CAMPAIGN, taskId: 'earlier-task', status: 'passed' })
    const outcome = await runPropose({ ...deps, knownTaskIds: ['earlier-task'] }, proposeInput({ parallel: false }))
    expect(outcome.ok).toBe(true)
  })

  it('defaults the unattended choice from the deployment config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'self-dev-chat-def-'))
    roots.push(root)
    const { facade, deps } = await makeDeps({
      config: resolveChatConfig({
        stableRepo: '/repo',
        controlDirectory: join(root, 'control'),
        experimentsRoot: join(root, 'exp'),
        actor: 'user',
        targetBranch: 'stable',
        defaultUnattended: false,
      }),
    })
    const outcome = await runPropose(deps, proposeInput({ unattended: undefined as unknown as boolean }))
    expect(outcome.ok).toBe(true)
    expect(facade.calls[5]!.args[2]).toEqual({ unattended: false, acceptedBy: 'user' })
  })

  it('rejects invalid input end to end, before any port is touched', async () => {
    const { facade, approval, deps } = await makeDeps()
    const outcome = await runPropose(deps, proposeInput({ requirement: '   ' }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('requirement')
    expect(approval.requests).toEqual([])
    expect(facade.calls).toEqual([])
  })

  it('treats a failed campaign lookup as not-running during the parallel check', async () => {
    const { facade, deps } = await makeDeps()
    facade.campaign = async () => {
      facade.calls.push({ name: 'campaign', args: ['earlier-task'] })
      throw new Error('facade restarting')
    }
    const outcome = await runPropose({ ...deps, knownTaskIds: ['earlier-task'] }, proposeInput({ parallel: false }))
    expect(outcome.ok).toBe(true)
  })

  it('omits an absent callId and forwards a provided signal to the approval request', async () => {
    const { approval, deps } = await makeDeps()
    const controller = new AbortController()
    const outcome = await runPropose({ ...deps, callId: undefined, signal: controller.signal }, proposeInput())
    expect(outcome.ok).toBe(true)
    const request = approval.requests[0] as { callId?: unknown; signal?: AbortSignal }
    expect('callId' in request).toBe(false)
    expect(request.signal).toBe(controller.signal)
  })

  it('omits dataHome from the launch profile when there is no workspaces service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'self-dev-chat-nodh-'))
    roots.push(root)
    const experimentsRoot = join(root, 'exp')
    await mkdir(join(experimentsRoot, 'no-data-home-task'), { recursive: true })
    const { facade, deps } = await makeDeps({
      workspaces: undefined,
      config: resolveChatConfig({
        stableRepo: '/repo',
        controlDirectory: join(root, 'control'),
        experimentsRoot,
        actor: 'user',
        targetBranch: 'stable',
      }),
      taskIdSuffix: 'task',
    })
    const outcome = await runPropose(deps, proposeInput({ requirement: 'no data home' }))
    expect(outcome.ok).toBe(true)
    const launchProfile = facade.calls[0]!.args[2] as Record<string, unknown>
    expect('dataHome' in launchProfile).toBe(false)
    expect(launchProfile).toMatchObject({ worktree: join(experimentsRoot, 'no-data-home-task') })
  })

  it('reports a baseline digest failure as the steps done so far', async () => {
    const { approval, deps } = await makeDeps()
    vi.mocked(readBaselineDigest).mockRejectedValueOnce(new Error('fatal: not a git repository'))
    const outcome = await runPropose(deps, proposeInput())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('fatal: not a git repository')
    expect(outcome.steps.map(step => step.step)).toEqual(['approval', 'workspace'])
    expect(approval.requests).toHaveLength(1)
  })

  it('reports an acceptance-write failure as the steps done so far', async () => {
    const { deps, control } = await makeDeps()
    // A file sitting where the acceptance directory must be created blocks
    // the recursive mkdir with ENOTDIR.
    await mkdir(control, { recursive: true })
    await writeFile(join(control, 'acceptance'), 'blocker')
    const outcome = await runPropose(deps, proposeInput())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.steps.map(step => step.step)).toEqual(['approval', 'workspace', 'baseline'])
  })
})

describe('resolveProposeInput', () => {
  const config = resolveChatConfig({
    stableRepo: '/repo',
    controlDirectory: '/repo/control',
    experimentsRoot: '/exp',
    actor: 'user',
    targetBranch: 'stable',
    defaultBudget: { mode: 'rounds', maxRounds: 9 },
    defaultUnattended: false,
  })

  it('fills every omitted field from the deployment config, and true for parallel', () => {
    const resolved = resolveProposeInput(proposeInput({ budget: undefined, unattended: undefined, parallel: undefined }), config)
    expect(resolved.budget).toEqual({ mode: 'rounds', maxRounds: 9 })
    expect(resolved.unattended).toBe(false)
    expect(resolved.parallel).toBe(true)
  })

  it('keeps every explicit field', () => {
    const resolved = resolveProposeInput(proposeInput({ budget: { preset: 'unlimited' }, unattended: true, parallel: false }), config)
    expect(resolved.budget).toEqual({ preset: 'unlimited' })
    expect(resolved.unattended).toBe(true)
    expect(resolved.parallel).toBe(false)
  })
})
