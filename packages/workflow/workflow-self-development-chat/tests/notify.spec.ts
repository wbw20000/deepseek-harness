/**
 * Best-effort chat delivery of a settled campaign's result: the terminal-kind
 * filter, the bilingual notice text, and idle-vs-busy delivery through the
 * `NotifiableAgent` port.
 * @module notify.spec
 */

import { describe, expect, it } from 'vitest'
import { campaignNoticeMessage, deliverCampaignNotice, isSettledCampaignEvent } from '../src/notify.ts'
import type { NotifiableAgent } from '../src/notify.ts'
import type { CampaignEvent } from '../src/types.ts'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** A fake `NotifiableAgent`, recording every delivered message. */
function fakeAgent(status: 'idle' | 'running'): NotifiableAgent & { delivered: { via: 'followup' | 'inject'; message: UserMessage }[] } {
  const delivered: { via: 'followup' | 'inject'; message: UserMessage }[] = []
  return {
    status,
    delivered,
    followup(message) {
      delivered.push({ via: 'followup', message })
    },
    inject(message) {
      delivered.push({ via: 'inject', message })
    },
  }
}

/** Extract the sole text block from a message. */
function textOf(message: UserMessage): string {
  const block = message.content[0]
  return block?.type === 'text' ? block.text : ''
}

const PASSED_EVENT: CampaignEvent = { taskId: 'task-1', kind: 'awaiting-trial', origin: 'campaign', title: 'Round 2 passed', occurredAt: 1 }
const ENDED_EVENT: CampaignEvent = { taskId: 'task-1', kind: 'stopped', origin: 'campaign', title: 'Task stopped (cancelled)', occurredAt: 2 }

describe('isSettledCampaignEvent', () => {
  it('accepts only campaign-origin events, whatever their kind', () => {
    expect(isSettledCampaignEvent(PASSED_EVENT)).toBe(true)
    expect(isSettledCampaignEvent(ENDED_EVENT)).toBe(true)
    expect(isSettledCampaignEvent({ origin: 'campaign' })).toBe(true)
    // The same kinds under a commit origin are single rounds of a running campaign.
    expect(isSettledCampaignEvent({ origin: 'commit' })).toBe(false)
    expect(isSettledCampaignEvent({ origin: 'merge' })).toBe(false)
  })
})

describe('campaignNoticeMessage', () => {
  it('renders an English passed notice pointing at self_development_status', () => {
    const message = campaignNoticeMessage(PASSED_EVENT, 'en')
    const text = textOf(message)
    expect(text).toContain("Task task-1's self-development campaign passed")
    expect(text).toContain('Round 2 passed')
    expect(text).toContain('and the trial URL')
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'workflow-self-development-chat', form: 'notice' })
  })

  it('renders an English ended notice without the trial-URL mention', () => {
    const text = textOf(campaignNoticeMessage(ENDED_EVENT, 'en'))
    expect(text).toContain('campaign ended: Task stopped (cancelled)')
    expect(text).not.toContain('trial URL')
  })

  it('renders bilingual Chinese notices for both outcomes', () => {
    expect(textOf(campaignNoticeMessage(PASSED_EVENT, 'zh'))).toBe('任务 task-1 的自开发战役已通过：Round 2 passed。用 self_development_status 查看详情和试验版地址（试验版实例要先构建，通常需要几分钟；地址还没出来就过一会儿再查）。')
    expect(textOf(campaignNoticeMessage(ENDED_EVENT, 'zh'))).toBe('任务 task-1 的自开发战役已结束：Task stopped (cancelled)。用 self_development_status 查看详情。')
  })
})

describe('deliverCampaignNotice', () => {
  it('opens a follow-up turn for an idle agent and consumes the registry entry', () => {
    const agent = fakeAgent('idle')
    const agentsByTask = new Map<string, NotifiableAgent>([['task-1', agent]])
    deliverCampaignNotice(agentsByTask, PASSED_EVENT, 'en')
    expect(agent.delivered).toHaveLength(1)
    expect(agent.delivered[0]?.via).toBe('followup')
    expect(agentsByTask.has('task-1')).toBe(false)
  })

  it('injects for a busy agent instead of opening a turn', () => {
    const agent = fakeAgent('running')
    const agentsByTask = new Map<string, NotifiableAgent>([['task-1', agent]])
    deliverCampaignNotice(agentsByTask, ENDED_EVENT, 'en')
    expect(agent.delivered).toEqual([{ via: 'inject', message: expect.anything() as unknown as UserMessage }])
  })

  it('ignores a non-terminal event without touching the registry', () => {
    const agent = fakeAgent('idle')
    const agentsByTask = new Map<string, NotifiableAgent>([['task-1', agent]])
    deliverCampaignNotice(agentsByTask, { taskId: 'task-1', kind: 'awaiting-trial', origin: 'commit', title: 'Round 1 passed, awaiting trial', occurredAt: 1 }, 'en')
    expect(agent.delivered).toEqual([])
    expect(agentsByTask.has('task-1')).toBe(true)
  })

  it('is a no-op when no agent is registered for the task', () => {
    const agentsByTask = new Map<string, NotifiableAgent>()
    expect(() => { deliverCampaignNotice(agentsByTask, PASSED_EVENT, 'en') }).not.toThrow()
  })
})
