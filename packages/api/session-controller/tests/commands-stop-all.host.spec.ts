/**
 * `session.stopAll` command receipts: discarded pending identities in inbox
 * clear order, idempotent re-stops, resolver failure passthrough, and the
 * subagent ownership fence shared with `cancel`.
 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { describe, expect, it, vi } from 'vitest'
import {
  ApiSessionAgentController, SessionStopAllGate,
} from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installSessionReadTestServices, createSessionTestController } from './test-remote.ts'

async function commandHarness(): Promise<{
  ctx: Context
  controller: SessionCommandController
  agent: Agent
  cancel: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  const session = ctx.sessions.create(SessionId('stop-all-session'), {
    meta: { cwd: '/workspace' },
  })
  const cancel = vi.fn()
  const agent = {
    id: session.id,
    session,
    inbox: createInboxStub(),
    status: 'running',
    ctx,
    cancel,
  } as unknown as Agent
  await ctx.agents.register(agent)
  const agents = {
    resolveAgent: (id: SessionId) => Promise.resolve(id === agent.id
      ? { agent }
      : { error: new RemoteError('session/not-found', 'missing', { sessionId: id }) }),
    stopAllGate: new SessionStopAllGate(ctx),
  } as unknown as ApiSessionAgentController
  return {
    ctx,
    controller: new SessionCommandController(ctx, agents, '/workspace'),
    agent,
    cancel,
  }
}

function queued(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('session.stopAll command', () => {
  it('discards every pending occurrence and cancels without keeping the inbox', async () => {
    const { controller, agent, cancel } = await commandHarness()
    const steering = queued('steering')
    const turn = queued('turn')
    agent.inbox.append('next-step', steering)
    agent.inbox.append('next-turn', turn)

    await expect(controller.stopAll({ sessionId: agent.id })).resolves.toEqual({
      accepted: true,
      discardedItemIds: [steering.id, turn.id],
    })
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
  })

  it('is idempotent: a repeated stop returns the same receipt shape with an empty discard', async () => {
    const { controller, agent, cancel } = await commandHarness()
    agent.inbox.append('next-turn', queued('only'))
    await expect(controller.stopAll({ sessionId: agent.id })).resolves.toEqual({
      accepted: true,
      discardedItemIds: [expect.any(String)],
    })
    agent.inbox.clear()
    await expect(controller.stopAll({ sessionId: agent.id })).resolves.toEqual({
      accepted: true,
      discardedItemIds: [],
    })
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it('propagates the cold Agent resolver rejection unchanged', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    try {
      const error = new RemoteError('session/not-found', 'missing session', {
        sessionId: SessionId('cold'),
      })
      const controller = new SessionCommandController(ctx, {
        resolveAgent: () => Promise.resolve({ error }),
        stopAllGate: new SessionStopAllGate(ctx),
      } as unknown as ApiSessionAgentController, '/workspace')
      await expect(controller.stopAll({ sessionId: SessionId('cold') })).rejects.toBe(error)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the subagent ownership fence of ordinary delivery', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    installSessionReadTestServices(ctx)
    const session = ctx.sessions.create(SessionId('stop-all-child'), {
      meta: { cwd: '/workspace', origin: 'subagent', parentSession: SessionId('offline-parent') },
    })
    const cancel = vi.fn()
    const agent = {
      id: session.id,
      session,
      inbox: createInboxStub(),
      status: 'idle',
      ctx,
      cancel,
    } as unknown as Agent
    await ctx.agents.register(agent)
    const controller = new SessionCommandController(ctx, {
      resolveAgent: () => Promise.resolve({ agent }),
      stopAllGate: new SessionStopAllGate(ctx),
    } as unknown as ApiSessionAgentController, '/workspace')

    await expect(controller.stopAll({ sessionId: session.id })).rejects.toMatchObject({
      code: 'session/agent-busy',
    })
    expect(cancel).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('delegates the Remote facade endpoint to the command', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    installSessionReadTestServices(ctx)
    const session = ctx.sessions.create(SessionId('facade-session'), {
      meta: { cwd: '/workspace' },
    })
    const cancel = vi.fn()
    await ctx.agents.register({
      id: session.id,
      session,
      inbox: createInboxStub(),
      status: 'idle',
      ctx,
      cancel,
    } as unknown as Agent)
    const controller = createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd: '/tmp',
    })

    await expect(controller.stopAll({ sessionId: session.id })).resolves.toEqual({
      accepted: true,
      discardedItemIds: [],
    })
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    await ctx.fiber.dispose()
  })
})
