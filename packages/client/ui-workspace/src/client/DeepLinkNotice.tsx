/** A failed session deep link stays briefly visible without blocking the app. */
import type { ReactNode } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { DeepLinkNotice } from './deep-link.ts'

/** Overlay hooks and actions for the deep-link notice. */
export interface DeepLinkNoticeInjected {
  readonly hooks: { readonly notice: HostObservable<DeepLinkNotice> }
  /** Clears the notice once its banner has faded. */
  readonly dismissNotice: () => void
}

/**
 * Render one transient banner for an unresolvable session deep link.
 * @param props - root overlay hooks, dismiss action and localized copy.
 * @returns the floating banner, or nothing while no deep link failed.
 */
export function DeepLinkNotice({ useNotice, dismissNotice, t }: PropsRuntime<'shell.overlay'> & PropsLocale<'workspace'> & InjectFace<DeepLinkNoticeInjected>): ReactNode {
  const sessionId = useNotice(value => value.sessionId)
  if (sessionId === undefined) return null
  return <Toast key={sessionId} text={t('deepLink.unavailable', { id: sessionId })} onDone={dismissNotice} />
}
