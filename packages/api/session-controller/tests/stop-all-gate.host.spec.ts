/**
 * Full-task stop through the real Agent loop: `stopAll` ends the active turn
 * with a user cancel, discards the pending queue, arms the durable
 * `stopAll` flag, and the pre-step gate blocks automatic continuations until
 * an explicit user message runs and clears the flag.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'

type AdapterScript = ConstructorParameters<typeof MockAdapter>[0]

const ownedContexts = new Set<Context>()
let nextSession = 1

afterEach(async () => {
  await Promise.all([...ownedContexts].map(ctx => ctx.fiber.dispose()))
  ownedContexts.clear()
})

async function harness(
  script: AdapterScript,
  withProjection = true,
): Promise<{
  ctx: Context
  commands: SessionCommandController
  agent: Agent
  adapter: MockAdapter
}> {
  const ctx = new Context()
  ownedContexts.add(ctx)
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agents = new ApiSessionAgentController(ctx)
  if (withProjection) agents.stopAllGate.registerProjection()
  const commands = new SessionCommandController(ctx, agents, '/workspace')
  const agent = await loop.create(
    SessionId(`stop-all-${String(nextSession++)}`),
    { provider: 'mock', model: 'mock' },
    { cwd: '/workspace' },
  )
  return { ctx, commands, agent, adapter }
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function pluginMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'fixture' },
  })
}

/** Resolve when the Agent first reports the requested status. */
function waitForStatus(ctx: Context, agent: Agent, status: 'running' | 'idle'): Promise<void> {
  if (agent.status === status) return Promise.resolve()
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status: next }) => {
      if (subject === agent && next === status) {
        dispose()
        resolve()
      }
    })
  })
}

function log(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

function queuedIds(agent: Agent): string[] {
  return [...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(message => message.id)
}

describe('session.stopAll through the real loop', () => {
  it('stops the running turn, empties the queue, and blocks automatic continuations', async () => {
    const { ctx, commands, agent, adapter } = await harness([
      { hangAfter: textResponse('stalled') },
      textResponse('resumed'),
    ])
    agent.followup(userMessage('run'))
    await waitForStatus(ctx, agent, 'running')
    // The scripted stream hangs after its first chunks, so the turn is live
    // inside a model call while the queue fills.
    await expect.poll(() => adapter.requests).toHaveLength(1)
    const first = userMessage('queued one')
    const second = userMessage('queued two')
    agent.inbox.append('next-turn', first)
    agent.inbox.append('next-turn', second)

    const changes: Array<{ stopped: boolean; seq: number }> = []
    ctx.sessionProjections.onChanged((_session, key, value, seq) => {
      if (key === 'stopAll') {
        changes.push({ stopped: (value as { stopped: boolean }).stopped, seq })
      }
    })

    await expect(commands.stopAll({ sessionId: agent.id })).resolves.toEqual({
      accepted: true,
      discardedItemIds: [first.id, second.id],
    })
    await agent.whenIdle()

    expect(log(agent).some(event => event.type === 'turn/end'
      && event.data.reason.kind === 'aborted'
      && event.data.reason.reason.kind === 'user')).toBe(true)
    expect(queuedIds(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(1)

    // The flag reached clients through the projection change feed at the
    // first event the armed fold consumed.
    expect(changes[0]).toMatchObject({ stopped: true })
    expect(ctx.sessionProjections.snapshot(agent.session).values.stopAll).toEqual({
      stopped: true,
    })

    // A queued consumption replay and a hook continuation cannot enter a
    // model step: the wake ends as a blocked turn with no request.
    agent.followup(pluginMessage('hook continuation'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(log(agent).some(event => event.type === 'turn/end'
      && event.data.reason.kind === 'blocked')).toBe(true)
    expect(log(agent).filter(event => event.type === 'user/message')
      .map(event => event.data.content[0]))
      .toEqual([{ type: 'text', text: 'run' }])
    expect(ctx.sessionProjections.snapshot(agent.session).values.stopAll).toEqual({
      stopped: true,
    })

    // The user's explicit message punches through and clears the flag.
    agent.followup(userMessage('resume'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(log(agent).some(event => event.type === 'user/message'
      && JSON.stringify(event.data.content).includes('resume'))).toBe(true)
    expect(ctx.sessionProjections.snapshot(agent.session).values.stopAll).toEqual({
      stopped: false,
    })
    expect(changes.at(-1)).toMatchObject({ stopped: false })
  })

  it('clears a pending queue without a running turn and still gates continuations', async () => {
    const { ctx, commands, agent, adapter } = await harness([textResponse('after resume')])
    const only = userMessage('queued')
    const steering = userMessage('steering')
    agent.inbox.append('next-turn', only)
    agent.inbox.append('next-step', steering)

    await expect(commands.stopAll({ sessionId: agent.id })).resolves.toEqual({
      accepted: true,
      discardedItemIds: [steering.id, only.id],
    })
    expect(queuedIds(agent)).toEqual([])
    expect(ctx.sessionProjections.snapshot(agent.session).values.stopAll).toEqual({
      stopped: true,
    })

    // The adapter holds no script for the blocked wake: an ungated
    // continuation would fail loudly instead of passing silently.
    agent.followup(pluginMessage('scheduled follow-up'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)

    agent.followup(userMessage('back to work'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(ctx.sessionProjections.snapshot(agent.session).values.stopAll).toEqual({
      stopped: false,
    })
  })

  it('returns the same receipt shape for an idle empty Session and still arms the gate', async () => {
    const { ctx, commands, agent, adapter } = await harness([])
    await expect(commands.stopAll({ sessionId: agent.id })).resolves.toEqual({
      accepted: true,
      discardedItemIds: [],
    })
    await expect(commands.stopAll({ sessionId: agent.id })).resolves.toEqual({
      accepted: true,
      discardedItemIds: [],
    })
    expect(adapter.requests).toHaveLength(0)

    // Nothing was running, so no event has armed the durable flag yet; the
    // first continuation attempt materializes it and is rejected.
    expect(ctx.sessionProjections.snapshot(agent.session).values.stopAll)
      .toEqual({ stopped: false })
    agent.followup(pluginMessage('late continuation'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(ctx.sessionProjections.snapshot(agent.session).values.stopAll)
      .toEqual({ stopped: true })
  })

  it('keeps an earlier pre-step rejection untouched while the gate is armed', async () => {
    const { commands, agent, adapter } = await harness([])
    agent.ctx.on('agent/pre-step', async ({ messages }, next) => {
      const decision = await next()
      const text = JSON.stringify(messages[0]?.content)
      if (decision.kind === 'enter' && text?.includes('veto')) return { kind: 'reject' }
      return decision
    })
    agent.inbox.append('next-turn', userMessage('queued'))
    await commands.stopAll({ sessionId: agent.id })
    agent.followup(pluginMessage('vetoed continuation'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(log(agent).some(event => event.type === 'turn/end'
      && event.data.reason.kind === 'blocked')).toBe(true)
  })

  it('replays an armed log when the projection registers after the stop', async () => {
    const { ctx, commands, agent, adapter } = await harness([], false)
    agent.followup(userMessage('before the stop'))
    await agent.whenIdle()
    await commands.stopAll({ sessionId: agent.id })
    agent.followup(userMessage('explicit after the stop'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)

    // The late registration folds the whole log under the live arm cut:
    // pre-arm events stay unarmed, the stop's own events arm the flag, and
    // the later explicit user message clears it again.
    agentsOf(ctx, commands).stopAllGate.registerProjection()
    expect(ctx.sessionProjections.snapshot(agent.session).values.stopAll).toEqual({
      stopped: false,
    })
  })
})

/** Read the Agent controller the command controller delegates to. */
function agentsOf(_ctx: Context, commands: SessionCommandController): ApiSessionAgentController {
  return (commands as unknown as { agents: ApiSessionAgentController }).agents
}
