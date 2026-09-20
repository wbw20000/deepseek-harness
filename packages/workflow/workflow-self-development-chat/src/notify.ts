/**
 * Best-effort chat delivery of a settled campaign's result to the agent that
 * proposed it. The mechanism mirrors `@deepseek-ai/dsh-tool-jobs`'s background-job
 * completion delivery: an idle agent gets a follow-up turn so the result
 * surfaces proactively, a busy agent gets the notice injected for its next
 * step. Delivery is in-memory and best-effort by design — see the package
 * README's Known Limitations for what this does not cover.
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { CardLocale } from './card.ts'
import type { CampaignEvent } from './types.ts'

/** The subset of `Agent` (`@deepseek-ai/dsh-agent`) this package delivers notices through. */
export interface NotifiableAgent {
  readonly status: 'idle' | 'running'
  followup(message: UserMessage): void
  inject(message: UserMessage): void
}

/** Campaign event kinds this package treats as a settled, notice-worthy campaign. */
const TERMINAL_KINDS: ReadonlySet<string> = new Set(['campaign-passed', 'campaign-ended'])

/**
 * Whether an event kind should produce a chat notice.
 * @param kind - the campaign event's `kind` field.
 * @returns `true` for `campaign-passed` and `campaign-ended`.
 */
export function isTerminalCampaignKind(kind: string): boolean {
  return TERMINAL_KINDS.has(kind)
}

/**
 * Build the chat notice for one settled-campaign event.
 * @param event - the campaign-passed or campaign-ended event.
 * @param locale - the deployment's card language.
 * @returns the message to deliver to the proposing agent.
 */
export function campaignNoticeMessage(event: CampaignEvent, locale: CardLocale): UserMessage {
  const passed = event.kind === 'campaign-passed'
  const text = locale === 'zh'
    ? `任务 ${event.taskId} 的自开发战役${passed ? '已通过' : '已结束'}：${event.title}。用 self_development_status 查看详情${passed ? '和试验版地址' : ''}。`
    : `Task ${event.taskId}'s self-development campaign ${passed ? 'passed' : 'ended'}: ${event.title}. `
      + `Use self_development_status for details${passed ? ' and the trial URL' : ''}.`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'workflow-self-development-chat',
      form: 'notice',
      summary: boundContextSummary(text),
    },
  })
}

/**
 * Deliver one settled-campaign notice to the agent that proposed it, when
 * this process still holds a live reference to it. The registry entry is
 * consumed once: a later event for the same task (there should not be one,
 * since campaigns end exactly once) finds nothing to deliver to.
 * Delivery is best-effort: an agent whose process has restarted or whose
 * session has since ended is silently skipped — status polling through
 * `self_development_status` remains the reliable path.
 * @param agentsByTask - the live registry of proposing agents, keyed by task id; consumed once per task.
 * @param event - the campaign event that arrived from the events service.
 * @param locale - the deployment's card language.
 */
export function deliverCampaignNotice(
  agentsByTask: Map<string, NotifiableAgent>,
  event: CampaignEvent,
  locale: CardLocale,
): void {
  if (!isTerminalCampaignKind(event.kind)) return
  const agent = agentsByTask.get(event.taskId)
  if (agent === undefined) return
  agentsByTask.delete(event.taskId)
  const message = campaignNoticeMessage(event, locale)
  if (agent.status === 'idle') {
    agent.followup(message)
    return
  }
  agent.inject(message)
}
