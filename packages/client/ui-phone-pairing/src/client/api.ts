/**
 * The three Connection session routes the pairing section drives, as plain
 * same-origin `fetch` calls. Connection owns the routes, their
 * authentication (the browser session cookie the desktop already holds),
 * and the host-only rule on minting; this module only shapes requests and
 * turns a non-2xx reply into an `Error` carrying the server's text.
 */

/** One registered browser session as `GET /api/connection.sessions` lists it. */
export interface PairedSession {
  readonly sessionId: string
  readonly deviceLabel: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly revokedAt?: number
  readonly certificateSerial?: string
}

/** What `POST /api/connection.pairing.mint` returns. */
export interface MintedPairing {
  /** The one-time pairing URL, token included; never logged by this UI. */
  readonly authenticatedUrl: string
  /** Host-clock milliseconds when the token expires unused. */
  readonly expiresAt: number
}

/** The pairing section's port onto Connection's routes. */
export interface PairingApi {
  /**
   * Mint one single-use pairing URL for a device label, valid `ttlMs`
   * milliseconds. `origin` picks which route the link points at and must be
   * one {@link PairingApi.origins} returned; omitted, the deployment's own
   * first choice is used.
   */
  mint(input: {
    readonly deviceLabel: string
    readonly ttlMs: number
    readonly origin?: string
  }): Promise<MintedPairing>
  /** The origins this deployment can mint a link from, most-preferred first. */
  origins(): Promise<readonly string[]>
  /** List every registered browser session, revoked ones included. */
  sessions(): Promise<readonly PairedSession[]>
  /** Revoke one session by id; its cookies and mux connections stop working at once. */
  revoke(sessionId: string): Promise<void>
}

/** Same-origin path of the mint route (Connection's `PAIRING_MINT_ROUTE_PATH`). */
export const MINT_PATH = '/api/connection.pairing.mint'
/** Same-origin path of the mintable-origin list (Connection's `PAIRING_ORIGINS_ROUTE_PATH`). */
export const ORIGINS_PATH = '/api/connection.pairing.origins'
/** Same-origin path of the session list route. */
export const SESSIONS_PATH = '/api/connection.sessions'
/** Same-origin path of the session revoke route. */
export const REVOKE_PATH = '/api/connection.sessions.revoke'

/**
 * Turn a non-2xx reply into an error carrying the server's own text, which
 * Connection writes as a plain sentence (`connection: pairing links are
 * minted from the stable host only`).
 * @param response - the fetch response.
 * @returns the response when it is 2xx.
 * @throws Error with the response text, or the status when the body is empty.
 */
async function okOrThrow(response: Response): Promise<Response> {
  if (response.ok) return response
  const text = (await response.text()).trim()
  throw new Error(text === '' ? `HTTP ${String(response.status)}` : text)
}

/**
 * Build the port over a `fetch` function.
 * @param fetchImpl - the fetch to use; tests pass a recorder, production the window's.
 * @returns the port.
 */
export function fetchPairingApi(fetchImpl: typeof fetch): PairingApi {
  const json = { 'content-type': 'application/json' }
  return {
    async mint(input) {
      const response = await okOrThrow(await fetchImpl(MINT_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: json,
        // `origin` is left out rather than sent as undefined: the route
        // distinguishes "no preference" from a named origin it must check.
        body: JSON.stringify(input.origin === undefined
          ? { ttlMs: input.ttlMs, deviceLabel: input.deviceLabel }
          : { ttlMs: input.ttlMs, deviceLabel: input.deviceLabel, origin: input.origin }),
      }))
      return await response.json() as MintedPairing
    },
    async origins() {
      const response = await okOrThrow(await fetchImpl(ORIGINS_PATH, { credentials: 'same-origin' }))
      const body = await response.json() as { origins: readonly string[] }
      return body.origins
    },
    async sessions() {
      const response = await okOrThrow(await fetchImpl(SESSIONS_PATH, { credentials: 'same-origin' }))
      const body = await response.json() as { sessions: readonly PairedSession[] }
      return body.sessions
    },
    async revoke(sessionId) {
      await okOrThrow(await fetchImpl(REVOKE_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: json,
        body: JSON.stringify({ sessionId }),
      }))
    },
  }
}
