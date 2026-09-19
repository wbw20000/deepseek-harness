// @vitest-environment jsdom
/** The evidence timeline renders the unified events and appends live ones. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { RoundTimeline } from '../src/client/RoundTimeline.tsx'
import { event } from './fixtures.client.ts'

afterEach(cleanup)

describe('RoundTimeline', () => {
  it('renders one row per event with kind, verbatim title, revision, and time', () => {
    const view = render(<RoundTimeline t={makeTranslate(en)} events={[event(), event({ kind: 'failed', title: '第 2 轮失败', revision: 3, taskId: 'task-1', occurredAt: 1_700_000_060_000 })]} />)
    expect(view.getByRole('region', { name: 'Per-round evidence' })).toBeDefined()
    expect(view.getByText('第 1 轮结束')).toBeDefined()
    expect(view.getByText('第 2 轮失败')).toBeDefined()
    expect(view.getAllByText('Round finished')).toHaveLength(1)
    expect(view.getByText('Failed')).toBeDefined()
    expect(view.getByText('task-1 · Revision 2 · 2023-11-14T22:13:20.000Z')).toBeDefined()
    expect(view.getByText('task-1 · Revision 3 · 2023-11-14T22:14:20.000Z')).toBeDefined()
  })

  it('renders the empty line when no event has been observed', () => {
    const view = render(<RoundTimeline t={makeTranslate(en)} events={[]} />)
    expect(view.getByText('No round events yet')).toBeDefined()
    expect(view.queryAllByRole('listitem')).toHaveLength(0)
  })
})
