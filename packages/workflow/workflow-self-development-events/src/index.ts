/**
 * Opt-in event consumer for the self-development task-control foundation. The
 * service folds every durable `self-development/committed` commit into the
 * unified notification event, keeps a bounded in-memory recent buffer for UI
 * pull, fans events out to subscribers, and optionally hands each event to a
 * configured local-notification command. It registers no tool, prompt, or
 * durable store: events live in this process only.
 * @module @deepseek-ai/dsh-workflow-self-development-events
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveSelfDevelopmentEventsConfig } from './config.ts'
import { mapCampaignEndedToEvent, mapCampaignPassedToEvent } from './campaign.ts'
import type { CampaignEndedPayload, CampaignPassedPayload } from './campaign.ts'
import { mapCommittedToEvent } from './mapping.ts'
import type { CommittedPayload } from './mapping.ts'
import { runNotify } from './notify.ts'
import type { NotifyOptions } from './notify.ts'
import type { ResolvedSelfDevelopmentEventsConfig, SelfDevelopmentEvent, SelfDevelopmentEventsConfig } from './types.ts'

export * from './types.ts'
export { DEFAULT_RECENT_LIMIT, resolveSelfDevelopmentEventsConfig } from './config.ts'
export { mapCampaignEndedToEvent, mapCampaignPassedToEvent } from './campaign.ts'
export type { CampaignEndedPayload, CampaignEndedStatus, CampaignPassedPayload } from './campaign.ts'
export { mapCommittedToEvent } from './mapping.ts'
export type { CommittedPayload } from './mapping.ts'
export { NOTIFY_TIMEOUT_MS, runNotify } from './notify.ts'
export type { NotifyOptions } from './notify.ts'

/** Host integrations replaceable by direct unit tests. */
export interface SelfDevelopmentEventsInternals {
  /** Host clock used for event times; defaults to `Date.now`. */
  readonly now?: () => number
  /** Timeout group stop override handed to every notification spawn. */
  readonly stopGroup?: (pid: number) => void
  /** Notification deadline override for direct unit tests. */
  readonly timeoutMs?: number
}

/**
 * Unified self-development event projection. Subscribing consumers and the
 * recent buffer see every mapped event exactly once, in commit order. Without
 * a configured `localNotificationCommand` the service never spawns.
 */
export class SelfDevelopmentEvents extends Service {
  static inject = ['selfDevelopmentTasks']

  /** Runtime schema for the service config; defaults live in config resolution. */
  static Config = z.object({
    // Absent must stay absent: notifications-off is `undefined`, not an empty argv.
    localNotificationCommand: z.array(z.string()).default(undefined as unknown as string[]),
    recentLimit: z.number(),
  }) as unknown as z<SelfDevelopmentEventsConfig>

  /** Validated deployment configuration the service runs under. */
  private readonly resolved: ResolvedSelfDevelopmentEventsConfig
  /** Chronological in-memory recent buffer, bounded by `recentLimit`. */
  private readonly recentBuffer: SelfDevelopmentEvent[] = []
  /** Live subscriber callbacks. */
  private readonly listeners = new Set<(event: SelfDevelopmentEvent) => void>()
  /** In-flight notification deliveries awaited at disposal. */
  private readonly inFlight = new Set<Promise<void>>()
  /** Notification options derived from the test-replaceable integrations. */
  private readonly notifyOptions: NotifyOptions
  /** Host clock for event times. */
  private readonly now: () => number

  /**
   * @param ctx - owning Cordis context.
   * @param config - deployment configuration for the notification command and buffer bound.
   * @param internals - host integrations replaceable by direct unit tests.
   * @throws Error when `recentLimit` is not a positive integer or the notification argv is empty. Misconfiguration fails at load.
   */
  constructor(ctx: Context, config: SelfDevelopmentEventsConfig, internals: SelfDevelopmentEventsInternals = {}) {
    super(ctx, 'selfDevelopmentEvents')
    this.resolved = resolveSelfDevelopmentEventsConfig(config)
    this.now = internals.now ?? Date.now
    this.notifyOptions = {
      ...(internals.stopGroup === undefined ? {} : { stopGroup: internals.stopGroup }),
      ...(internals.timeoutMs === undefined ? {} : { timeoutMs: internals.timeoutMs }),
    }
    ctx.effect(() => async () => {
      await this.drain()
    }, 'self-development-events: drain in-flight notifications')
    ctx.on('self-development/committed', (payload) => { this.ingest(payload) })
    ctx.on('self-development/campaign-passed', (payload) => { this.ingestCampaignPassed(payload) })
    ctx.on('self-development/campaign-ended', (payload) => { this.ingestCampaignEnded(payload) })
  }

  /**
   * Read the retained recent events, oldest first.
   * @param limit - maximum number of events to return, taken from the most
   *   recent tail of the buffer; defaults to every retained event.
   * @returns the retained events in chronological order, oldest first.
   */
  recent(limit?: number): readonly SelfDevelopmentEvent[] {
    const count = limit ?? this.recentBuffer.length
    if (count <= 0) return []
    return this.recentBuffer.slice(-count)
  }

  /**
   * Subscribe one listener to every mapped event from now on. The buffer is
   * not replayed: a subscriber sees only events observed after subscribing.
   * @param listener - callback invoked once per event in commit order.
   * @returns the disposer that removes the listener.
   */
  subscribe(listener: (event: SelfDevelopmentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Await every in-flight notification delivery. */
  private async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }

  /**
   * Fold one durable commit into the unified event and publish it, when the
   * commit maps to one.
   */
  private ingest(payload: CommittedPayload): void {
    const event = mapCommittedToEvent(payload, this.now)
    if (event === undefined) return
    this.publish(event)
  }

  /** Fold one campaign-passed payload into the unified event and publish it. */
  private ingestCampaignPassed(payload: CampaignPassedPayload): void {
    this.publish(mapCampaignPassedToEvent(payload, this.now))
  }

  /** Fold one campaign-ended payload into the unified event and publish it. */
  private ingestCampaignEnded(payload: CampaignEndedPayload): void {
    this.publish(mapCampaignEndedToEvent(payload, this.now))
  }

  /**
   * Publish one already-mapped event to the buffer and the subscribers, and
   * start one notification delivery when configured.
   */
  private publish(event: SelfDevelopmentEvent): void {
    this.recentBuffer.push(event)
    if (this.recentBuffer.length > this.resolved.recentLimit) {
      this.recentBuffer.splice(0, this.recentBuffer.length - this.resolved.recentLimit)
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error: unknown) {
        this.ctx.logger.warn('self-development-events: a subscriber failed for task "%s"', event.taskId)
        this.ctx.logger.warn(error)
      }
    }
    if (this.resolved.localNotificationCommand === undefined) return
    this.deliver(event)
  }

  /**
   * Deliver one event through the configured command. Delivery failures are
   * logged and never retried, and they never reach the buffer or subscribers.
   */
  private deliver(event: SelfDevelopmentEvent): void {
    const command = this.resolved.localNotificationCommand as readonly string[]
    const task = runNotify(event, command, this.notifyOptions).then((failure) => {
      if (failure !== undefined) {
        this.ctx.logger.warn('self-development-events: local notification failed: %s', failure)
      }
    })
    this.inFlight.add(task)
    void task.finally(() => {
      this.inFlight.delete(task)
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    selfDevelopmentEvents: SelfDevelopmentEvents
  }
}

export default SelfDevelopmentEvents
