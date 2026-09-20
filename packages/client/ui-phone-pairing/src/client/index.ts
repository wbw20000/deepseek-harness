/**
 * Phone pairing plugin, browser half. One registration: a `settings.section`
 * entry rendering {@link PhonePairingPanel} with Connection's session routes
 * behind a same-origin fetch port. The Remote service's `$host` facts tell a
 * phone client from the stable host, so the mint form is hidden on phones
 * (Connection refuses the mint there anyway).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the api-remotes Context merge (ctx.remote and its $host facts).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { fetchPairingApi } from './api.ts'
import { PhonePairingPanel } from './PhonePairingPanel.tsx'
import type { PhonePairingInjected } from './PhonePairingPanel.tsx'
import { en, zh, type PhonePairingKey } from './locales.ts'

export type { PairingApi, PairedSession, MintedPairing } from './api.ts'
export { fetchPairingApi, MINT_PATH, REVOKE_PATH, SESSIONS_PATH } from './api.ts'
export type { PhonePairingInjected, PhonePairingPanelProps } from './PhonePairingPanel.tsx'
export type { PhonePairingKey } from './locales.ts'
export { encodeQr, qrToSvg, QR_MAX_BYTES } from './qr.ts'
export type { QrMatrix } from './qr.ts'

/** Locale namespace of the section's copy. */
export const NS = 'phonePairing' as const

/** Settings section id. */
export const PHONE_PAIRING_SECTION_ID = 'phone-pairing'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Phone pairing section copy. */
    phonePairing: PhonePairingKey
  }
}

/** Required client services: slots, copy, and the Remote service whose `$host` facts separate phones from the host. */
export const inject = ['slots', 'locale', 'remote']

/** Test hook over the browser fetch; production leaves it as the window's. */
export const internals: { fetch: typeof fetch } = { fetch: (...args) => globalThis.fetch(...args) }

/**
 * Client plugin body: register the dictionaries and the settings section.
 * @param ctx - client root context carrying slots, copy, and remote facts.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-phone-pairing: dictionaries')
  const api = fetchPairingApi((...args) => internals.fetch(...args))
  const injected = (): PhonePairingInjected => ({
    api,
    phone: !ctx.remote.$host.isLoopback,
    now: () => Date.now(),
  })
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PHONE_PAIRING_SECTION_ID,
    order: 46,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, PhonePairingPanel)), 'ui-phone-pairing: settings section')
}
