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

/**
 * Whether an event is a settled, notice-worthy campaign result. The events
 * service folds a settled campaign into its shared kind vocabulary
 * (`awaiting-trial` for a pass, `failed`/`stopped` for an end) under
 * `origin: 'campaign'`; a single failed or passed round is the same kind
 * under `origin: 'commit'` while the campaign keeps running, and a merge
 * result is `origin: 'merge'`, so the origin — never the kind or the fixed
 * title text — is what marks a campaign result.
 * @param event - the event as the events service published it.
 * @returns `true` only for a campaign-origin event.
 */
export function isSettledCampaignEvent(event: Pick<CampaignEvent, 'origin'>): boolean {
  return event.origin === 'campaign'
}

/**
 * Build the chat notice for one settled-campaign event.
 * @param event - the campaign-passed or campaign-ended event.
 * @param locale - the deployment's card language.
 * @returns the message to deliver to the proposing agent.
 */
export function campaignNoticeMessage(event: CampaignEvent, locale: CardLocale): UserMessage {
  const passed = event.kind === 'awaiting-trial'
  const text = locale === 'zh'
    ? `任务 ${event.taskId} 的自开发战役${passed ? '已通过' : '已结束'}：${event.title}。用 self_development_status 查看详情${passed ? '和试验版地址（试验版实例要先构建，通常需要几分钟；地址还没出来就过一会儿再查）' : ''}。`
    : `Task ${event.taskId}'s self-development campaign ${passed ? 'passed' : 'ended'}: ${event.title}. `
      + `Use self_development_status for details${passed ? ' and the trial URL (the trial instance builds first, usually a few minutes; ask again if the URL is not there yet)' : ''}.`
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
  if (!isSettledCampaignEvent(event)) return
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
