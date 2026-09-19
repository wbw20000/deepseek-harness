/**
 * Self-development task plugin, browser half. Two registrations: the page-type
 * right-Sidebar tab (type definition plus the keyed `sidebar.right.pane.tab`
 * body under the definition's id) and one `settings.section` entry — both
 * render the same panel component with the same injected face. The generated
 * `selfDevelopmentRemote` namespace is resolved optionally through `ctx.get`,
 * and its readiness fiber flips the panel's availability fact only when a
 * composition actually mounts it, so an ordinary chat composition renders the
 * not-enabled view instead of failing. The per-round evidence timeline reads
 * the same namespace's `recentEvents`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls the api-remotes Context merge (ctx.remote and its $host facts).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the SidebarRightTabRegistry service merge (ctx.sidebarRightTabs).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { NS, SELF_DEVELOPMENT_ID, selfDevelopmentDefinition } from './definition.ts'
import { SelfDevelopmentPanel } from './SelfDevelopmentPanel.tsx'
import type { SelfDevelopmentApi, SelfDevelopmentAvailability, SelfDevelopmentInjected } from './face.ts'
import { en, zh, type SelfDevelopmentKey } from './locales.ts'

export type {
  SelfDevelopmentApi,
  SelfDevelopmentAvailability,
  SelfDevelopmentInjected,
} from './face.ts'
export type { SelfDevelopmentPanelProps } from './SelfDevelopmentPanel.tsx'
export type { SelfDevelopmentKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Self-development task panel copy. */
    selfDevelopment: SelfDevelopmentKey
  }
}

/**
 * Required client services: slots, copy, the tab registry, and the Remote
 * service whose `$host` facts separate stable-side from phone clients. The
 * generated namespace is deliberately absent from this list: requiring it
 * would park the plugin's fiber in every composition that has not enabled
 * self-development.
 */
export const inject = ['slots', 'locale', 'remote', 'sidebarRightTabs']

/**
 * Client plugin body: register the dictionaries, the availability fact, the
 * tab type, and the two seats.
 * @param ctx - client root context carrying slots, copy, remote facts, and the tab registry.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-self-development: dictionaries')

  /** Registrant-private availability fact, flipped by the readiness fiber. */
  const availability = createSnapshotStore<SelfDevelopmentAvailability>({ remote: false })
  ctx.effect(() => () => { availability.set({ remote: false }) }, 'ui-self-development: availability reset')

  // Readiness fiber: waits on the mounted namespace and stays pending while the
  // composition does not provide it. It dies with this plugin's fiber.
  ctx.inject(['remote.selfDevelopmentRemote'], () => { availability.set({ ...availability.getSnapshot(), remote: true }) })

  const injected = (): SelfDevelopmentInjected => ({
    remote: ctx.get('remote.selfDevelopmentRemote') as SelfDevelopmentApi | undefined,
    phone: !ctx.remote.$host.isLoopback,
    hooks: { availability },
  })

  ctx.effect(() => ctx.sidebarRightTabs.register(selfDevelopmentDefinition(t)), 'ui-self-development: tab type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: SELF_DEVELOPMENT_ID, locale: NS, inject: injected },
    SelfDevelopmentPanel,
  )), 'ui-self-development: pane body')
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'self-development',
    order: 45,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, SelfDevelopmentPanel)), 'ui-self-development: settings section')
}
