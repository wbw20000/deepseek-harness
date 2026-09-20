/**
 * The Cordis wiring: config validation, tool registration, the tool execute
 * wrappers and their result-line rendering, `contextPorts` reading the
 * mounted services, campaign-event subscription (updating `latestEvents` and
 * delivering a best-effort chat notice), and disposal. The facade, approval,
 * workspaces, events, and trial ports are fakes; the baseline digest is
 * stubbed so no test shells out to git.
 * @module index.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

vi.mock('../src/baseline.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/baseline.ts')>()
  return {
    ...actual,
    readBaselineDigest: vi.fn(async () => 'd'.repeat(64)),
  }
})

import SelfDevelopmentChat from '../src/index.ts'
import type { ChatPorts } from '../src/index.ts'
import type { NotifiableAgent } from '../src/notify.ts'
import type {
  ApprovalOutcome,
  CampaignEvent,
  CampaignState,
  FacadeOperationResult,
  LaunchProfileWire,
  SelfDevelopmentRemoteFacade,
  TaskDetailView,
} from '../src/types.ts'

/** Standard campaign state a fake `startCampaign`/`stopCampaign` returns. */
const CAMPAIGN: CampaignState = {
  taskId: 'task-1',
  status: 'running',
  startedAt: 1,
  updatedAt: 2,
  rounds: 1,
  acknowledgement: 'unattended-accepted',
}

/** A valid acceptance definition with one case. */
const ACCEPTANCE = {
  cases: [
    { caseId: 'c1', command: ['node', 'test.js'], timeoutMs: 5000, assertions: [{ assertionId: 'c1-a1', kind: 'exit-code', expected: 0 }] },
  ],
}

/** Valid `self_development_propose` tool arguments. */
function proposeArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requirement: 'add chat transcript search',
    allowedModificationScope: ['packages/**'],
    plan: {
      requiredCases: [{ caseId: 'c1', requirement: 'search finds a known message', assertionIds: ['c1-a1'] }],
      manualCases: [],
    },
    acceptance: ACCEPTANCE,
    ...overrides,
  }
}

/** Always-succeeding facade fake; every mutating call bumps the revision by one. */
class FakeFacade implements SelfDevelopmentRemoteFacade {
  calls: { name: string; args: unknown[] }[] = []
  revision = 0
  campaigns = new Map<string, CampaignState>()
  getTaskDetail: TaskDetailView = {
    projection: {
      status: 'ready',
      revision: 5,
      spec: { requirement: 'add chat transcript search' },
      consumedRounds: 0,
      consumedTimeMs: 0,
      planningAuthorized: true,
      noProgressCount: 0,
    },
    card: { launchProfile: { worktree: '/exp/task-1', acceptancePath: '/control/acceptance/task-1.json' } },
  }

  private step(name: string, args: unknown[]): FacadeOperationResult {
    this.calls.push({ name, args })
    this.revision += 1
    return { taskId: 'task-1', operationId: `op-${name}`, revision: this.revision, replayed: false }
  }

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
    return this.getTaskDetail
  }
}

/** Approval fake; `outcome` controls every `request()` reply. */
class FakeApproval {
  requests: unknown[] = []
  outcome: ApprovalOutcome = 'allowed-once'

  async request(request: unknown): Promise<ApprovalOutcome> {
    this.requests.push(request)
    return this.outcome
  }
}

/** Always-succeeding workspaces fake, so a proposal never depends on a real pre-allocated directory. */
class FakeWorkspaces {
  async allocate(request: { taskId: string; projectRoot: string }): Promise<{
    taskId: string
    projectRoot: string
    baseCommit: string
    worktree: string
    branch: string
    dataHome: string
    allocatedAt: number
  }> {
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
}

/** Minimal `ctx.tools` fake: records every registration and its disposer calls. */
class FakeTools {
  registered: ToolDefinition[] = []
  disposed: string[] = []

  register(definition: ToolDefinition): () => void {
    this.registered.push(definition)
    return () => {
      this.disposed.push(definition.name)
      this.registered = this.registered.filter(entry => entry !== definition)
    }
  }

  find(name: string): ToolDefinition {
    const definition = this.registered.find(entry => entry.name === name)
    if (definition === undefined) throw new Error(`tool ${name} was not registered`)
    return definition
  }
}

/** Minimal `ctx.get('selfDevelopmentEvents')` fake. */
/** Minimal `ctx.get('systemPrompt')` fake, recording every registered section and its disposal. */
class FakeSystemPrompt {
  sections: { name: string; order: number; text: string }[] = []
  disposedNames: string[] = []

  section(section: { readonly name: string; readonly order: number; readonly text: string }): () => void {
    this.sections.push({ ...section })
    return () => {
      this.disposedNames.push(section.name)
      this.sections = this.sections.filter(entry => entry.name !== section.name)
    }
  }

  getSectionOrder(name: string): number {
    return name === 'SELF_DEVELOPMENT_CHAT' ? 1650 : 0
  }
}

class FakeEvents {
  listeners: ((event: CampaignEvent) => void)[] = []
  unsubscribed = false

  subscribe(listener: (event: CampaignEvent) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.unsubscribed = true
      this.listeners = this.listeners.filter(entry => entry !== listener)
    }
  }

  emit(event: CampaignEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

/** A fake `NotifiableAgent`, recording every delivered notice. */
function fakeAgent(status: 'idle' | 'running' = 'idle'): NotifiableAgent & { delivered: { via: 'followup' | 'inject'; text: string }[] } {
  const delivered: { via: 'followup' | 'inject'; text: string }[] = []
  return {
    status,
    delivered,
    followup(message) {
      const block = message.content[0]
      delivered.push({ via: 'followup', text: block?.type === 'text' ? block.text : '' })
    },
    inject(message) {
      const block = message.content[0]
      delivered.push({ via: 'inject', text: block?.type === 'text' ? block.text : '' })
    },
  }
}

/** Build a `ToolRunContext` fake carrying only the fields this package reads. */
function fakeExec(overrides: { agent?: unknown; callId?: unknown; signal?: AbortSignal } = {}): ToolRunContext {
  const callId = (overrides.callId as ReturnType<typeof ToolCallId> | undefined) ?? ToolCallId('call-1')
  return {
    callId,
    rootCallId: callId,
    name: 'self_development_propose',
    arguments: {},
    signal: overrides.signal ?? new AbortController().signal,
    token: Symbol('token'),
    deferContext: () => {},
    concludeTurn: () => {},
    ...(overrides.agent === undefined ? {} : { agent: overrides.agent }),
  } as unknown as ToolRunContext
}

// `writeAcceptanceDefinition` writes real files under `controlDirectory` (it
// is not a port), so every test needs a real, writable temp directory there
// even though the facade, approval, and workspaces ports are fakes.
let root: string | undefined
let VALID_CONFIG: { stableRepo: string; controlDirectory: string; experimentsRoot: string; actor: string }

let context: Context | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'self-dev-chat-index-'))
  VALID_CONFIG = {
    stableRepo: '/repo',
    controlDirectory: join(root, 'control'),
    experimentsRoot: join(root, 'exp'),
    actor: 'user',
  }
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.clearAllMocks()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Build a context with `ctx.tools` mounted, and the given ports passed explicitly (bypassing `contextPorts`). */
function makeService(ports: Partial<ChatPorts> & { facade: SelfDevelopmentRemoteFacade }, config: Record<string, unknown> = VALID_CONFIG): {
  ctx: Context
  tools: FakeTools
  service: SelfDevelopmentChat
} {
  context = new Context()
  const tools = new FakeTools()
  context.provide('tools', tools as never)
  const fullPorts: ChatPorts = {
    approval: undefined,
    workspaces: new FakeWorkspaces(),
    events: undefined,
    trial: undefined,
    systemPrompt: undefined,
    ...ports,
  }
  const service = new SelfDevelopmentChat(context, config as never, fullPorts)
  return { ctx: context, tools, service }
}

describe('construction', () => {
  it('registers the three tools and validates the deployment config', () => {
    const { tools } = makeService({ facade: new FakeFacade() })
    expect(tools.registered.map(t => t.name)).toEqual([
      'self_development_propose', 'self_development_status', 'self_development_stop',
    ])
  })

  it('rejects an invalid default budget at construction', () => {
    expect(() => makeService(
      { facade: new FakeFacade() },
      { ...VALID_CONFIG, defaultBudget: { mode: 'time', hours: 99 } },
    )).toThrow('defaultBudget')
  })

  it('unregisters every tool and the event subscription on disposal', async () => {
    const events = new FakeEvents()
    const { ctx, tools } = makeService({ facade: new FakeFacade(), events })
    expect(events.listeners).toHaveLength(1)
    await ctx.fiber.dispose()
    expect(tools.disposed.sort()).toEqual(['self_development_propose', 'self_development_status', 'self_development_stop'])
    expect(events.unsubscribed).toBe(true)
  })

  it('reads every port from the mounted services when none are passed explicitly', async () => {
    context = new Context()
    const tools = new FakeTools()
    const facade = new FakeFacade()
    const approval = new FakeApproval()
    context.provide('tools', tools as never)
    context.provide('selfDevelopmentRemote', facade as never)
    context.provide('approval', approval as never)
    context.provide('selfDevelopmentWorkspaces', new FakeWorkspaces() as never)
    new SelfDevelopmentChat(context, VALID_CONFIG)
    const def = tools.find('self_development_propose')
    const value = await def.execute(proposeArgs(), fakeExec())
    expect((value as { ok: boolean }).ok).toBe(true)
    expect(approval.requests).toHaveLength(1)
  })

  it('omits agent, callId, and signal from the propose deps when the exec carries none of them', async () => {
    const { tools } = makeService({ facade: new FakeFacade(), approval: new FakeApproval() })
    const def = tools.find('self_development_propose')
    const bareExec = {
      name: 'self_development_propose',
      arguments: {},
      rootCallId: ToolCallId('root'),
      token: Symbol('token'),
      deferContext: () => {},
      concludeTurn: () => {},
    } as unknown as ToolRunContext
    const value = await def.execute(proposeArgs(), bareExec)
    expect((value as { ok: boolean }).ok).toBe(true)
  })
})

describe('self-development guidance section', () => {
  it('registers the guidance section at the centrally allocated order, naming every tool', () => {
    const systemPrompt = new FakeSystemPrompt()
    makeService({ facade: new FakeFacade(), systemPrompt })
    expect(systemPrompt.sections).toHaveLength(1)
    const section = systemPrompt.sections[0]!
    expect(section.name).toBe('tool:self-development')
    expect(section.order).toBe(1650)
    expect(section.text).toContain('self_development_propose')
    expect(section.text).toContain('self_development_status')
    expect(section.text).toContain('self_development_stop')
    expect(section.text).toContain('do NOT edit files in')
    expect(section.text).toContain('do NOT run the tests yourself')
  })

  it('unregisters the guidance section on disposal', async () => {
    const systemPrompt = new FakeSystemPrompt()
    const { ctx } = makeService({ facade: new FakeFacade(), systemPrompt })
    expect(systemPrompt.sections).toHaveLength(1)
    await ctx.fiber.dispose()
    expect(systemPrompt.sections).toHaveLength(0)
    expect(systemPrompt.disposedNames).toEqual(['tool:self-development'])
  })

  it('does not register when guidance is disabled, even with systemPrompt mounted', () => {
    const systemPrompt = new FakeSystemPrompt()
    makeService({ facade: new FakeFacade(), systemPrompt }, { ...VALID_CONFIG, guidance: false })
    expect(systemPrompt.sections).toEqual([])
  })

  it('skips and logs at debug when no systemPrompt service is mounted', () => {
    const ctx = new Context()
    context = ctx
    const tools = new FakeTools()
    ctx.provide('tools', tools as never)
    const debug = vi.spyOn(ctx.logger, 'debug').mockImplementation(() => {})
    expect(() => new SelfDevelopmentChat(ctx, VALID_CONFIG, {
      facade: new FakeFacade(),
      approval: undefined,
      workspaces: undefined,
      events: undefined,
      trial: undefined,
      systemPrompt: undefined,
    })).not.toThrow()
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('systemPrompt is not mounted'))
  })
})

describe('self_development_propose tool', () => {
  it('runs the proposal and renders the success line', async () => {
    const facade = new FakeFacade()
    const { tools } = makeService({ facade, approval: new FakeApproval() })
    const def = tools.find('self_development_propose')
    const agent = fakeAgent()
    const value = await def.execute(proposeArgs(), fakeExec({ agent }))
    const outcome = value as { ok: boolean; taskId: string }
    expect(outcome.ok).toBe(true)
    expect(outcome.taskId).toBeTruthy()
    const rendered = def.output.render(proposeArgs(), value as never)
    expect(rendered[0]?.type).toBe('text')
    expect((rendered[0] as { text: string }).text).toContain('campaign started')
  })

  it('reports failure without registering an agent notice', async () => {
    const approval = new FakeApproval()
    approval.outcome = 'rejected'
    const { tools } = makeService({ facade: new FakeFacade(), approval })
    const def = tools.find('self_development_propose')
    const value = await def.execute(proposeArgs(), fakeExec({ agent: fakeAgent() }))
    const outcome = value as { ok: boolean; reason: string; taskId?: string }
    expect(outcome.ok).toBe(false)
    const rendered = def.output.render(proposeArgs(), value as never)
    expect((rendered[0] as { text: string }).text).toContain('proposal failed')
  })

  it('renders the failure line with a placeholder when no task was created', async () => {
    const approval = new FakeApproval()
    approval.outcome = 'cancelled'
    const { tools } = makeService({ facade: new FakeFacade(), approval })
    const def = tools.find('self_development_propose')
    const value = await def.execute(proposeArgs(), fakeExec())
    const rendered = def.output.render(proposeArgs(), value as never)
    expect((rendered[0] as { text: string }).text).toContain('(not created)')
  })
})

describe('self_development_status tool', () => {
  it('reports the task and renders a summary line', async () => {
    const facade = new FakeFacade()
    const { tools } = makeService({ facade })
    const def = tools.find('self_development_status')
    const value = await def.execute({ taskId: 'task-1' }, fakeExec())
    const rendered = def.output.render({ taskId: 'task-1' }, value as never)
    expect((rendered[0] as { text: string }).text).toContain('Task status: ready')
  })

  it('renders the failure line when the lookup fails', async () => {
    const facade = new FakeFacade()
    facade.getTask = async () => { throw Object.assign(new Error('unknown task'), { code: 'self-development/task-unknown' }) }
    const { tools } = makeService({ facade })
    const def = tools.find('self_development_status')
    const value = await def.execute({ taskId: 'task-9' }, fakeExec())
    const rendered = def.output.render({ taskId: 'task-9' }, value as never)
    expect((rendered[0] as { text: string }).text).toContain('Status failed')
  })

  it('renders the campaign, last outcome, and trial summary when a campaign is running', async () => {
    const facade = new FakeFacade()
    facade.campaigns.set('task-1', { ...CAMPAIGN, lastOutcome: 'failed' })
    const trial = { trials: async () => [{ taskId: 'task-1', url: 'http://127.0.0.1:4173/?token=t', port: 4173, startedAt: 1 }] }
    const { tools } = makeService({ facade, trial: trial })
    const def = tools.find('self_development_status')
    const value = await def.execute({ taskId: 'task-1' }, fakeExec())
    const rendered = def.output.render({ taskId: 'task-1' }, value as never)
    expect((rendered[0] as { text: string }).text).toBe('Task status: ready, campaign running, round 1, last failed; trial http://127.0.0.1:4173/?token=t')
  })

  it('renders the reason when a failure carries no structured error', () => {
    const { tools } = makeService({ facade: new FakeFacade() })
    const def = tools.find('self_development_status')
    const synthetic = { ok: false, reason: 'facade unavailable', paths: { acceptancePath: '/a', campaignRecord: '/c' } }
    const rendered = def.output.render({ taskId: 'task-1' }, synthetic)
    expect((rendered[0] as { text: string }).text).toBe('Status failed — facade unavailable')
  })

  it('omits the last-outcome clause when the campaign has not failed or finished yet', async () => {
    const facade = new FakeFacade()
    facade.campaigns.set('task-1', CAMPAIGN)
    const { tools } = makeService({ facade })
    const def = tools.find('self_development_status')
    const value = await def.execute({ taskId: 'task-1' }, fakeExec())
    const rendered = def.output.render({ taskId: 'task-1' }, value as never)
    expect((rendered[0] as { text: string }).text).toBe('Task status: ready, campaign running, round 1')
  })
})

describe('self_development_stop tool', () => {
  it('stops the campaign and renders a summary line', async () => {
    const facade = new FakeFacade()
    const { tools } = makeService({ facade })
    const def = tools.find('self_development_stop')
    const value = await def.execute({ taskId: 'task-1', reason: 'user asked' }, fakeExec())
    const rendered = def.output.render({ taskId: 'task-1', reason: 'user asked' }, value as never)
    expect((rendered[0] as { text: string }).text).toContain('Campaign stopped: stopped')
    expect(facade.calls.some(call => call.name === 'stopCampaign')).toBe(true)
  })

  it('renders the failure line when the stop is refused', async () => {
    const facade = new FakeFacade()
    facade.stopCampaign = async () => { throw new Error('nothing is running') }
    const { tools } = makeService({ facade })
    const def = tools.find('self_development_stop')
    const value = await def.execute({ taskId: 'task-1', reason: 'user asked' }, fakeExec())
    const rendered = def.output.render({ taskId: 'task-1', reason: 'user asked' }, value as never)
    expect((rendered[0] as { text: string }).text).toContain('Stop failed')
  })

  it('renders the reason when a failure carries no structured error', () => {
    const { tools } = makeService({ facade: new FakeFacade() })
    const def = tools.find('self_development_stop')
    const synthetic = { ok: false, reason: 'facade unavailable' }
    const rendered = def.output.render({ taskId: 'task-1', reason: 'user asked' }, synthetic)
    expect((rendered[0] as { text: string }).text).toBe('Stop failed — facade unavailable')
  })
})

describe('campaign-event delivery', () => {
  it('delivers a follow-up notice to an idle proposing agent and records the latest event for status', async () => {
    const facade = new FakeFacade()
    const events = new FakeEvents()
    const { tools, service } = makeService({ facade, approval: new FakeApproval(), events })
    const agent = fakeAgent('idle')
    const proposeDef = tools.find('self_development_propose')
    const proposed = await proposeDef.execute(proposeArgs(), fakeExec({ agent })) as { taskId: string }

    events.emit({ taskId: proposed.taskId, kind: 'campaign-passed', title: 'Round 1 passed', occurredAt: 1 })
    expect(agent.delivered).toHaveLength(1)
    expect(agent.delivered[0]).toMatchObject({ via: 'followup' })

    const statusDef = tools.find('self_development_status')
    const statusValue = await statusDef.execute({ taskId: proposed.taskId }, fakeExec()) as {
      latestEvent?: { kind: string }
    }
    expect(statusValue.latestEvent?.kind).toBe('campaign-passed')

    // The registry entry is consumed: a second event for the same task finds no agent.
    events.emit({ taskId: proposed.taskId, kind: 'campaign-ended', title: 'again', occurredAt: 2 })
    expect(agent.delivered).toHaveLength(1)
    void service
  })

  it('injects into a busy agent instead of opening a follow-up turn', async () => {
    const facade = new FakeFacade()
    const events = new FakeEvents()
    const { tools } = makeService({ facade, approval: new FakeApproval(), events })
    const agent = fakeAgent('running')
    const proposeDef = tools.find('self_development_propose')
    const proposed = await proposeDef.execute(proposeArgs(), fakeExec({ agent })) as { taskId: string }
    events.emit({ taskId: proposed.taskId, kind: 'campaign-ended', title: 'ended', occurredAt: 1 })
    expect(agent.delivered).toEqual([{ via: 'inject', text: expect.stringContaining('ended') as unknown as string }])
  })

  it('ignores a non-terminal event and a task with no registered agent', async () => {
    const facade = new FakeFacade()
    const events = new FakeEvents()
    const { tools } = makeService({ facade, approval: new FakeApproval(), events })
    const agent = fakeAgent()
    const proposeDef = tools.find('self_development_propose')
    const proposed = await proposeDef.execute(proposeArgs(), fakeExec({ agent })) as { taskId: string }
    events.emit({ taskId: proposed.taskId, kind: 'turn-finished', title: 'noop', occurredAt: 1 })
    expect(agent.delivered).toEqual([])

    const statusDef = tools.find('self_development_status')
    const beforeUnknown = await statusDef.execute({ taskId: 'never-proposed' }, fakeExec()) as {
      latestEvent?: unknown
    }
    events.emit({ taskId: 'never-proposed', kind: 'campaign-passed', title: 'x', occurredAt: 1 })
    expect(beforeUnknown.latestEvent).toBeUndefined()
  })

  it('does nothing when no events service is mounted', () => {
    const { tools } = makeService({ facade: new FakeFacade(), approval: new FakeApproval() })
    expect(tools.registered).toHaveLength(3)
  })
})
