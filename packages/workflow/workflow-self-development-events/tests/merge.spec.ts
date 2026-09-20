/**
 * Merge-to-stable event mapping: `mapMergeIntegratedToEvent` and
 * `mapMergeBlockedToEvent` produce the two fixed-template titles, and the
 * real service folds the raw `self-development/merge-integrated` and
 * `self-development/merge-blocked` Cordis events into its buffer and
 * subscribers exactly like a durable commit does.
 * @module merge.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SelfDevelopmentTasks } from '@deepseek-ai/dsh-workflow-self-development'
import { mapMergeBlockedToEvent, mapMergeIntegratedToEvent } from '../src/merge.ts'
import type { MergeBlockedPayload, MergeIntegratedPayload } from '../src/merge.ts'
import SelfDevelopmentEvents from '../src/index.ts'
import type { SelfDevelopmentEvent } from '../src/types.ts'

/** Host-clock stub: every event observes the same fixed instant. */
const now = (): number => 1_700_000_000_000

describe('mapMergeIntegratedToEvent', () => {
  it('produces the fixed title under kind awaiting-trial, carrying the given task id and revision', () => {
    const payload: MergeIntegratedPayload = { taskId: 'task-1', revision: 9 }
    expect(mapMergeIntegratedToEvent(payload, now)).toEqual({
      taskId: 'task-1',
      kind: 'awaiting-trial',
      origin: 'merge',
      sessionId: undefined,
      title: 'Task integrated into stable',
      occurredAt: now(),
      revision: 9,
    } satisfies SelfDevelopmentEvent)
  })
})

describe('mapMergeBlockedToEvent', () => {
  it.each([
    'conflict',
    'verification-failed',
    'failed',
    'not-awaiting-trial',
  ])('maps status %s to kind failed and interpolates only the closed-vocabulary status into the title', (status) => {
    const payload: MergeBlockedPayload = { taskId: 'task-2', status, revision: 4 }
    expect(mapMergeBlockedToEvent(payload, now)).toEqual({
      taskId: 'task-2',
      kind: 'failed',
      origin: 'merge',
      sessionId: undefined,
      title: `Merge blocked: ${status}`,
      occurredAt: now(),
      revision: 4,
    } satisfies SelfDevelopmentEvent)
  })

  it('never carries a free-text reason into the title, only the closed status vocabulary', () => {
    const statuses: readonly string[] = ['conflict', 'verification-failed', 'failed']
    for (const status of statuses) {
      const event = mapMergeBlockedToEvent({ taskId: 'task-3', status, revision: 1 }, now)
      expect(event.title).toBe(`Merge blocked: ${status}`)
      expect(event.title).not.toContain('reason')
    }
  })
})

describe('service wiring for the raw merge events', () => {
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
    const control = await mkdtemp(join(tmpdir(), 'self-dev-events-merge-'))
    root = control
    context = new Context()
    new SelfDevelopmentTasks(context, {
      controlDirectory: join(control, 'control'),
      maxRecordsPerSegment: 64,
      checkpointInterval: 4,
    })
    return new SelfDevelopmentEvents(context, { recentLimit: 200 }, { now })
  }

  it('folds an emitted merge-integrated event into the recent buffer and subscribers', async () => {
    const events = await makeHarness()
    const seen: SelfDevelopmentEvent[] = []
    events.subscribe((event) => { seen.push(event) })
    context!.emit('self-development/merge-integrated', { taskId: 'task-a', revision: 3 })
    expect(events.recent()).toEqual([
      {
        taskId: 'task-a',
        kind: 'awaiting-trial',
        origin: 'merge',
        sessionId: undefined,
        title: 'Task integrated into stable',
        occurredAt: now(),
        revision: 3,
      },
    ])
    expect(seen).toHaveLength(1)
  })

  it('folds an emitted merge-blocked event into the recent buffer and subscribers', async () => {
    const events = await makeHarness()
    context!.emit('self-development/merge-blocked', { taskId: 'task-b', status: 'conflict', revision: 6 })
    expect(events.recent()).toEqual([
      { taskId: 'task-b', kind: 'failed', origin: 'merge', sessionId: undefined, title: 'Merge blocked: conflict', occurredAt: now(), revision: 6 },
    ])
  })

  it('keeps merge events and committed events in one chronological buffer', async () => {
    const events = await makeHarness()
    context!.emit('self-development/merge-integrated', { taskId: 'task-c', revision: 1 })
    context!.emit('self-development/merge-blocked', { taskId: 'task-d', status: 'verification-failed', revision: 2 })
    expect(events.recent().map(event => event.title)).toEqual([
      'Task integrated into stable',
      'Merge blocked: verification-failed',
    ])
  })
})
