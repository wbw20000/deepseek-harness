/**
 * The per-round evidence timeline. One row per unified self-development event,
 * oldest first: the event's fixed-template title verbatim, its kind, the task
 * revision after the commit, and the observation time. Events arrive from the
 * facade's `recentEvents` read, re-read on every list refresh; the panel never
 * fabricates a row.
 */
import type { ReactNode } from 'react'
import type { RecentEvent } from '@deepseek-ai/dsh-workflow-self-development-remote'
import { eventKindKey } from './status.ts'
import type { Translate } from './status.ts'
import css from './SelfDevelopmentPanel.module.css'

/** Props of the evidence timeline. */
export interface RoundTimelineProps {
  /** The dictionary seat. */
  readonly t: Translate
  /** The events in chronological order, oldest first. */
  readonly events: readonly RecentEvent[]
}

/**
 * Render the timeline.
 * @param props - the dictionary seat and the events to render.
 * @returns the timeline element tree.
 */
export function RoundTimeline({ t, events }: RoundTimelineProps): ReactNode {
  return (
    <section className={css.timeline} aria-label={t('timelineTitle')}>
      <h3 className={css.cardHeading}>{t('timelineTitle')}</h3>
      {events.length === 0 ? <p className={css.statusLine}>{t('timelineEmpty')}</p> : null}
      <ol className={css.timelineList}>
        {events.map((event, index) => (
          <li key={`${event.occurredAt}-${event.taskId}-${index}`} className={css.timelineRow}>
            <span className={css.timelineKind}>{t(eventKindKey(event.kind))}</span>
            <span className={css.timelineTitle}>{event.title}</span>
            <span className={css.timelineMeta}>
              {`${event.taskId} · ${t('projectionRevision')} ${event.revision} · ${new Date(event.occurredAt).toISOString()}`}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
