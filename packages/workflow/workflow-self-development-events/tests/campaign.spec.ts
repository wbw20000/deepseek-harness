/**
 * Campaign-lifecycle event mapping: `mapCampaignPassedToEvent` and
 * `mapCampaignEndedToEvent` produce the two fixed-template titles, and the
 * real service folds the raw `self-development/campaign-passed` and
 * `self-development/campaign-ended` Cordis events into its buffer and
 * subscribers exactly like a durable commit does.
 * @module campaign.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SelfDevelopmentTasks } from '@deepseek-ai/dsh-workflow-self-development'
import { mapCampaignEndedToEvent, mapCampaignPassedToEvent } from '../src/campaign.ts'
import type { CampaignEndedPayload, CampaignEndedStatus, CampaignPassedPayload } from '../src/campaign.ts'
import SelfDevelopmentEvents from '../src/index.ts'
import type { SelfDevelopmentEvent } from '../src/types.ts'

/** Host-clock stub: every event observes the same fixed instant. */
const now = (): number => 1_700_000_000_000

describe('mapCampaignPassedToEvent', () => {
  it('produces the fixed title under kind awaiting-trial, carrying the given task id and revision', () => {
    const payload: CampaignPassedPayload = { taskId: 'task-1', revision: 9 }
    expect(mapCampaignPassedToEvent(payload, now)).toEqual({
      taskId: 'task-1',
      kind: 'awaiting-trial',
      sessionId: undefined,
      title: 'Task passed, trial ready',
      occurredAt: now(),
      revision: 9,
    } satisfies SelfDevelopmentEvent)
  })
})

describe('mapCampaignEndedToEvent', () => {
  it.each([
    ['exhausted', 'failed'],
    ['stopped', 'stopped'],
    ['failed', 'failed'],
  ] as const)('maps status %s to kind %s and interpolates only the closed-vocabulary status into the title', (status, kind) => {
    const payload: CampaignEndedPayload = { taskId: 'task-2', status, revision: 4 }
    expect(mapCampaignEndedToEvent(payload, now)).toEqual({
      taskId: 'task-2',
      kind,
      sessionId: undefined,
      title: `Campaign ended: ${status}`,
      occurredAt: now(),
      revision: 4,
    } satisfies SelfDevelopmentEvent)
  })

  it('never carries a free-text reason into the title, only the closed status vocabulary', () => {
    const statuses: readonly CampaignEndedStatus[] = ['exhausted', 'stopped', 'failed']
    for (const status of statuses) {
      const event = mapCampaignEndedToEvent({ taskId: 'task-3', status, revision: 1 }, now)
      expect(event.title).toBe(`Campaign ended: ${status}`)
      expect(event.title).not.toContain('reason')
    }
  })
})

describe('service wiring for the raw campaign events', () => {
  let root: string | undefined
  let context: Context | undefined

  afterEach(async () => {
    await context?.fiber.dispose()
    context = undefined
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  /** Boot the real task-control service (unused by these tests beyond satisfying `inject`) and the events service. */
  async function makeHarness(): Promise<SelfDevelopmentEvents> {
    const control = await mkdtemp(join(tmpdir(), 'self-dev-events-campaign-'))
    root = control
    context = new Context()
    new SelfDevelopmentTasks(context, {
      controlDirectory: join(control, 'control'),
      maxRecordsPerSegment: 64,
      checkpointInterval: 4,
    })
    return new SelfDevelopmentEvents(context, { recentLimit: 200 }, { now })
  }

  it('folds an emitted campaign-passed event into the recent buffer and subscribers', async () => {
    const events = await makeHarness()
    const seen: SelfDevelopmentEvent[] = []
    events.subscribe((event) => { seen.push(event) })
    context!.emit('self-development/campaign-passed', { taskId: 'task-a', revision: 3 })
    expect(events.recent()).toEqual([
      { taskId: 'task-a', kind: 'awaiting-trial', sessionId: undefined, title: 'Task passed, trial ready', occurredAt: now(), revision: 3 },
    ])
    expect(seen).toHaveLength(1)
  })

  it('folds an emitted campaign-ended event into the recent buffer and subscribers', async () => {
    const events = await makeHarness()
    context!.emit('self-development/campaign-ended', { taskId: 'task-b', status: 'exhausted', revision: 6 })
    expect(events.recent()).toEqual([
      { taskId: 'task-b', kind: 'failed', sessionId: undefined, title: 'Campaign ended: exhausted', occurredAt: now(), revision: 6 },
    ])
  })

  it('keeps campaign events and committed events in one chronological buffer', async () => {
    const events = await makeHarness()
    context!.emit('self-development/campaign-passed', { taskId: 'task-c', revision: 1 })
    context!.emit('self-development/campaign-ended', { taskId: 'task-d', status: 'stopped', revision: 2 })
    expect(events.recent().map(event => event.title)).toEqual([
      'Task passed, trial ready',
      'Campaign ended: stopped',
    ])
  })
})
