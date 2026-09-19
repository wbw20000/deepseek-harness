/**
 * Stage one of this package's registration: what the self-development tab type
 * IS. One page per kind, opened from its guide entry, recognizing no address —
 * the panel is not session content, so it claims no `dsh-resource://` address.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SelfDevelopmentKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
export const NS = 'selfDevelopment'

/** The tab system identity: the key the pane body registers under. */
export const SELF_DEVELOPMENT_ID = '@deepseek-ai/dsh-client-ui-self-development'

/** The page type's kind: what `openTab` names. */
export const SELF_DEVELOPMENT_KIND = 'selfDevelopment'

/**
 * The page-type tab definition.
 * @param t - the bound dictionary seat.
 * @returns the definition to register.
 */
export function selfDevelopmentDefinition(t: (key: SelfDevelopmentKey) => string): SidebarRightTabDefinition {
  return {
    id: SELF_DEVELOPMENT_ID,
    kind: SELF_DEVELOPMENT_KIND,
    priority: 'builtin',
    title: () => t('title'),
    guide: [{ id: 'self-development', order: 60, title: () => t('title'), description: () => t('guideDescription') }],
  }
}
