// @vitest-environment jsdom
/** The deep-link notice surfaces one transient banner, then dismisses itself. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { DeepLinkNotice as DeepLinkNoticeState } from '../src/client/deep-link.ts'
import { DeepLinkNotice } from '../src/client/DeepLinkNotice.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type NoticeProps = Parameters<typeof DeepLinkNotice>[0]
const unusedHook = (): never => { throw new Error('The deep-link notice does not consume global hooks') }
const standard: Omit<NoticeProps, 'useNotice' | 'dismissNotice' | 't'> = {
  useSessions: unusedHook, useSessionStatus: unusedHook, useSessionRetainInfo: unusedHook, usePanelInfo: unusedHook,
  useWorkspaces: unusedHook, useResource: unusedHook,
}

function noticeProps(notice: DeepLinkNoticeState, dismissNotice: NoticeProps['dismissNotice']): NoticeProps {
  return { ...standard, useNotice: selector => selector(notice), dismissNotice, t: makeTranslate(en) }
}

it('renders nothing while no deep link failed', () => {
  const dismissNotice = vi.fn()
  const view = render(<DeepLinkNotice {...noticeProps({}, dismissNotice)} />)
  expect(view.container.childElementCount).toBe(0)
  expect(document.body.querySelector('[role="alert"]')).toBeNull()
})

it('shows the localized banner for the unresolvable id and dismisses after the fade window', () => {
  vi.useFakeTimers()
  const dismissNotice = vi.fn()
  const view = render(<DeepLinkNotice {...noticeProps({ sessionId: 'ghost' as never }, dismissNotice)} />)
  const alert = view.getByRole('alert')
  expect(alert.textContent).toBe(en['deepLink.unavailable'].replace('{id}', 'ghost'))
  // The banner holds and fades before the owner is told to unmount it.
  vi.advanceTimersByTime(3000)
  expect(dismissNotice).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1000)
  expect(dismissNotice).toHaveBeenCalledExactlyOnceWith()
})

it('remounts the banner when a different id fails, and disappears once cleared', () => {
  const dismissNotice = vi.fn()
  let notice: DeepLinkNoticeState = { sessionId: 'ghost' as never }
  const view = render(<DeepLinkNotice {...noticeProps(notice, dismissNotice)} />)
  const first = view.getByRole('alert')
  notice = { sessionId: 'other' as never }
  view.rerender(<DeepLinkNotice {...noticeProps(notice, dismissNotice)} />)
  expect(view.getByRole('alert')).not.toBe(first)
  notice = {}
  view.rerender(<DeepLinkNotice {...noticeProps(notice, dismissNotice)} />)
  expect(view.container.childElementCount).toBe(0)
})
