/** Connection-owned session-lifecycle routes, logout, pairing mint, and mux-handshake revocation. */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  API_PATH,
  apply,
  inject,
  CERTIFICATES_REVOKE_ROUTE_PATH,
  LOGOUT_ROUTE_PATH,
  PAIRING_MINT_ROUTE_PATH,
  SESSIONS_REVOKE_ROUTE_PATH,
  SESSIONS_ROUTE_PATH,
  type ConnectionConfig,
  type HostConnectionHandle,
} from '../src/index.ts'
import { provideBrowserCredentials, RecordCredentials } from './browser-credentials.ts'

/** Structural webServer fake recording both route registries. */
function fakeHttpServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[],
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

/** Bodyless request carrying the given headers (enough for the trust fence + bridge). */
function fakeRequest(
  headers: Record<string, string>,
  url = `${API_PATH}/x`,
  remoteAddress?: string,
): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, {
    url,
    method: 'GET',
    headers,
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
  })
  return request
}

/** JSON POST carrying the given headers and body. */
function fakePost(headers: Record<string, string>, url: string, body: unknown): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers: { 'content-type': 'application/json', ...headers } })
  return request
}

/** Raw POST for malformed-body cases. */
function fakeRawPost(headers: Record<string, string>, url: string, body: string): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers })
  return request
}

/** Response recorder compatible with both the fence's short-circuit and the bridge. */
function fakeResponse(): {
  response: ServerResponse
  state: { status?: number; headers?: Record<string, string>; body?: unknown }
} {
  const state: { status?: number; headers?: Record<string, string>; body?: unknown } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number, headers?: Record<string, string>) {
      state.status = value
      if (headers !== undefined) state.headers = headers
      return this
    },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      else if (value !== undefined) throw new TypeError('fake response only accepts string or Uint8Array bodies')
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

async function mounted(config?: ConnectionConfig): Promise<{
  routes: WebRoute[]
  connection: HostConnectionHandle
  store: RecordCredentials
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const store = provideBrowserCredentials(ctx)
  ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return {
    routes,
    connection: ctx.get('connection') as HostConnectionHandle,
    store,
    dispose: () => fiber.dispose(),
  }
}

/** Exchange a service's process token for one authority-bound Cookie header. */
function browserCookie(
  connection: HostConnectionHandle,
  authority: string,
  init?: { serial?: string; remoteAddress?: string },
): string {
  const url = new URL(connection.authenticatedUrl(`http://${authority}`))
  const exchanged = fakeResponse()
  connection.authorizeIndex(
    fakeRequest({
      host: authority,
      ...init?.serial === undefined ? {} : { 'x-dsh-client-serial': init.serial },
    }, `${url.pathname}${url.search}`, init?.remoteAddress),
    exchanged.response,
  )
  const setCookie = exchanged.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('browser token exchange did not set a cookie')
  return setCookie.split(';', 1)[0]!
}

/** Run the mounted /api prefix route once and return its recorded state. */
async function serve(
  routes: WebRoute[],
  request: IncomingMessage,
): Promise<{ status?: number; headers?: Record<string, string>; body?: unknown }> {
  const { response, state } = fakeResponse()
  await routes[0]!.handler(request, response)
  return state
}

describe('connection session routes', () => {
  it('lists and revokes registered sessions and logs the caller out', async () => {
    const { routes, connection, dispose } = await mounted()
    try {
      const cookie = browserCookie(connection, 'localhost')
      const headers = { host: 'localhost', cookie }

      const listed = await serve(routes, fakeRequest(headers, SESSIONS_ROUTE_PATH))
      expect(listed.status).toBe(200)
      const sessions = (JSON.parse(listed.body as string) as { sessions: Array<Record<string, unknown>> }).sessions
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({ deviceLabel: 'launch-token' })
      expect(sessions[0]!.revokedAt).toBeUndefined()
      expect(JSON.stringify(sessions)).not.toContain('cookie')

      const sessionId = sessions[0]!.sessionId as string
      const revoked = await serve(routes, fakePost(headers, SESSIONS_REVOKE_ROUTE_PATH, { sessionId }))
      expect(revoked.status).toBe(200)
      expect(JSON.parse(revoked.body as string)).toEqual({ revoked: true })
      // Revoked cookie stops authenticating the shared channel, mux handshakes included.
      const rejected = await serve(routes, fakeRequest(headers, SESSIONS_ROUTE_PATH))
      expect(rejected.status).toBe(401)

      const secondCookie = browserCookie(connection, 'localhost')
      const logout = await serve(routes, fakePost({ host: 'localhost', cookie: secondCookie }, LOGOUT_ROUTE_PATH, {}))
      expect(logout.status).toBe(200)
      expect(logout.headers?.['set-cookie']).toMatch(/; Max-Age=0; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict$/u)
      expect(connection.requestRejection({ headers: { host: 'localhost', cookie: secondCookie } })).toBe(401)
    } finally { await dispose() }
  })

  it('rejects malformed revoke and mint requests without leaking token material', async () => {
    const { routes, connection, dispose } = await mounted()
    try {
      const cookie = browserCookie(connection, 'localhost')
      const headers = { host: 'localhost', cookie }

      const noSessionId = await serve(routes, fakePost(headers, SESSIONS_REVOKE_ROUTE_PATH, {}))
      expect(noSessionId.status).toBe(400)
      const badJson = await serve(routes, fakeRawPost(headers, SESSIONS_REVOKE_ROUTE_PATH, 'not json'))
      expect(badJson.status).toBe(400)

      const mint = async (body: unknown): Promise<{ status?: number; body?: unknown }> =>
        serve(routes, fakePost(headers, PAIRING_MINT_ROUTE_PATH, body))
      expect((await mint({ ttlMs: 0, deviceLabel: 'phone' })).status).toBe(400)
      expect((await mint({ deviceLabel: 42 })).status).toBe(400)
      expect((await serve(routes, fakeRawPost(headers, PAIRING_MINT_ROUTE_PATH, 'not json'))).status).toBe(400)

      for (let index = 0; index < 5; index += 1) {
        expect((await mint({ ttlMs: 1000, deviceLabel: `device-${String(index)}` })).status).toBe(200)
      }
      const blocked = await mint({ ttlMs: 1000, deviceLabel: 'overflow' })
      expect(blocked.status).toBe(400)
      const message = String(blocked.body)
      expect(message).toMatch(/at most 5 unconsumed pairing tokens/u)
      expect(message).not.toContain('token=')
      void connection
    } finally { await dispose() }
  })

  it('mints and consumes one-shot pairing URLs through the /api route', async () => {
    const { routes, connection, dispose } = await mounted()
    try {
      const headers = { host: 'localhost', cookie: browserCookie(connection, 'localhost') }
      const minted = await serve(routes, fakePost(headers, PAIRING_MINT_ROUTE_PATH, { deviceLabel: 'phone' }))
      expect(minted.status).toBe(200)
      const body = JSON.parse(minted.body as string) as { authenticatedUrl: string; expiresAt: number }
      expect(body.authenticatedUrl).toMatch(/^http:\/\/localhost\/\?token=/u)
      expect(body.expiresAt).toBeGreaterThan(Date.now())

      const url = new URL(body.authenticatedUrl)
      const exchanged = fakeResponse()
      expect(connection.authorizeIndex(
        fakeRequest({ host: 'localhost' }, `${url.pathname}${url.search}`),
        exchanged.response,
      )).toBe(false)
      const setCookie = exchanged.state.headers?.['set-cookie']
      if (setCookie === undefined) throw new Error('pairing exchange did not set a cookie')
      const cookie = setCookie.split(';', 1)[0]!

      const listed = await serve(routes, fakeRequest({ host: 'localhost', cookie }, SESSIONS_ROUTE_PATH))
      const sessions = (JSON.parse(listed.body as string) as { sessions: Array<Record<string, unknown>> }).sessions
      expect(sessions.some(session => session.deviceLabel === 'phone')).toBe(true)

      // The minted URL is single use: replaying it fails authentication.
      const replay = fakeResponse()
      expect(connection.authorizeIndex(
        fakeRequest({ host: 'localhost' }, `${url.pathname}${url.search}`),
        replay.response,
      )).toBe(false)
      expect(replay.state.status).toBe(401)
    } finally { await dispose() }
  })

  it('applies the revocation check to /api/remote.mux upgrade handshakes through the shared fence', async () => {
    const { routes, connection, dispose } = await mounted()
    try {
      const cookie = browserCookie(connection, 'localhost')
      const headers = { host: 'localhost', cookie }
      // The Gateway's upgrade handler calls exactly this check before accepting a socket.
      expect(connection.requestRejection({ headers })).toBeUndefined()

      const listed = await serve(routes, fakeRequest(headers, SESSIONS_ROUTE_PATH))
      const sessionId = (JSON.parse(listed.body as string) as { sessions: Array<{ sessionId: string }> }).sessions[0]!.sessionId
      await serve(routes, fakePost(headers, SESSIONS_REVOKE_ROUTE_PATH, { sessionId }))

      expect(connection.requestRejection({ headers })).toBe(401)
    } finally { await dispose() }
  })

  it('records that established connections are not torn down by revocation', async () => {
    const { routes, connection, dispose } = await mounted()
    try {
      const cookie = browserCookie(connection, 'localhost')
      // This package owns no live-connection table: an already-accepted
      // WebSocket mux keeps serving until it disconnects. Only new handshakes
      // are refused. The absence of any teardown surface is the recorded
      // limitation, asserted here so the contract cannot drift silently.
      expect((connection as unknown as Record<string, unknown>).closeRevokedConnections).toBeUndefined()

      const listed = await serve(routes, fakeRequest({ host: 'localhost', cookie }, SESSIONS_ROUTE_PATH))
      const sessionId = (JSON.parse(listed.body as string) as { sessions: Array<{ sessionId: string }> }).sessions[0]!.sessionId
      await serve(routes, fakePost({ host: 'localhost', cookie }, SESSIONS_REVOKE_ROUTE_PATH, { sessionId }))
      expect(connection.requestRejection({ headers: { host: 'localhost', cookie } })).toBe(401)
    } finally { await dispose() }
  })

  it('marks cookies and pairing URLs Secure when the deployment config enables them', async () => {
    const { routes, connection, dispose } = await mounted({ cookieSecure: true })
    try {
      const headers = { host: 'localhost', cookie: browserCookie(connection, 'localhost') }
      expect(connection.requestRejection({ headers })).toBeUndefined()

      const minted = await serve(routes, fakePost(headers, PAIRING_MINT_ROUTE_PATH, { deviceLabel: 'phone' }))
      expect((JSON.parse(minted.body as string) as { authenticatedUrl: string }).authenticatedUrl)
        .toMatch(/^https:\/\/localhost\//u)

      const url = new URL((JSON.parse(minted.body as string) as { authenticatedUrl: string }).authenticatedUrl)
      const exchanged = fakeResponse()
      connection.authorizeIndex(fakeRequest({ host: 'localhost' }, `${url.pathname}${url.search}`), exchanged.response)
      expect(exchanged.state.headers?.['set-cookie']).toMatch(/; Secure$/u)
    } finally { await dispose() }
  })

  it('rejects a mint request without a usable Host header', async () => {
    const { connection, dispose } = await mounted()
    try {
      const handler = connection.createSharedFetchHandler(API_PATH)
      const response = await handler.fetch(new Request('http://dsh.internal/api/connection.pairing.mint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceLabel: 'phone' }),
      }))
      expect(response.status).toBe(400)
    } finally { await dispose() }
  })

  it('keeps every session route authenticated by the shared fence', async () => {
    const { routes, dispose } = await mounted()
    try {
      for (const [path, request] of [
        [SESSIONS_ROUTE_PATH, fakeRequest({ host: 'localhost' }, SESSIONS_ROUTE_PATH)],
        [SESSIONS_REVOKE_ROUTE_PATH, fakePost({ host: 'localhost' }, SESSIONS_REVOKE_ROUTE_PATH, { sessionId: 's' })],
        [PAIRING_MINT_ROUTE_PATH, fakePost({ host: 'localhost' }, PAIRING_MINT_ROUTE_PATH, { deviceLabel: 'x' })],
        [LOGOUT_ROUTE_PATH, fakePost({ host: 'localhost' }, LOGOUT_ROUTE_PATH, {})],
        [CERTIFICATES_REVOKE_ROUTE_PATH, fakePost({ host: 'localhost' }, CERTIFICATES_REVOKE_ROUTE_PATH, { serial: '1a2b' })],
      ] as const) {
        const state = await serve(routes, request)
        expect(`${path}: ${String(state.status)}`).toBe(`${path}: 401`)
      }
    } finally { await dispose() }
  })

  it('binds the trusted certificate serial to sessions and revokes one device across sessions', async () => {
    const { routes, connection, dispose } = await mounted({
      mtlsClientSerialHeader: 'X-DSH-Client-Serial',
      mtlsTrustedProxies: ['127.0.0.1'],
    })
    try {
      const cookie = browserCookie(connection, 'localhost', {
        serial: '1a2b3c4d',
        remoteAddress: '127.0.0.1',
      })
      const deviceHeaders = { host: 'localhost', cookie, 'x-dsh-client-serial': '1a2b3c4d' }

      // The listing reports the bound serial and never any cookie material.
      const listed = await serve(routes, fakeRequest(deviceHeaders, SESSIONS_ROUTE_PATH, '127.0.0.1'))
      expect(listed.status).toBe(200)
      const sessions = (JSON.parse(listed.body as string) as { sessions: Array<Record<string, unknown>> }).sessions
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({ deviceLabel: 'launch-token', certificateSerial: '1a2b3c4d' })

      // A second session of the same device (same serial) plus its cookie.
      const secondCookie = browserCookie(connection, 'localhost', {
        serial: '1a2b3c4d',
        remoteAddress: '127.0.0.1',
      })
      expect(await serve(routes, fakeRequest({
        host: 'localhost', cookie: secondCookie, 'x-dsh-client-serial': '1a2b3c4d',
      }, SESSIONS_ROUTE_PATH, '127.0.0.1'))).toMatchObject({ status: 200 })

      // A mismatching serial from the trusted proxy is refused at the fence.
      expect(await serve(routes, fakeRequest({
        host: 'localhost', cookie, 'x-dsh-client-serial': 'ff',
      }, SESSIONS_ROUTE_PATH, '127.0.0.1'))).toMatchObject({ status: 401 })
      // The header from a non-trusted peer is ignored, so the bound session fails closed.
      expect(await serve(routes, fakeRequest(deviceHeaders, SESSIONS_ROUTE_PATH, '192.168.1.9')))
        .toMatchObject({ status: 401 })

      // One certificate revocation retires every session of the device at
      // once; the serial may arrive in Caddy's decimal rendering. The call
      // runs from an unbound console session (a browser without a client
      // certificate), which keeps the cookie-only behavior.
      const consoleCookie = browserCookie(connection, 'localhost')
      const revoked = await serve(routes, fakePost(
        { host: 'localhost', cookie: consoleCookie },
        CERTIFICATES_REVOKE_ROUTE_PATH,
        { serial: '439041101' },
      ))
      expect(revoked.status).toBe(200)
      expect(JSON.parse(revoked.body as string)).toEqual({ revoked: 2 })
      for (const candidate of [cookie, secondCookie]) {
        expect(await serve(routes, fakeRequest({
          host: 'localhost', cookie: candidate, 'x-dsh-client-serial': '1a2b3c4d',
        }, SESSIONS_ROUTE_PATH, '127.0.0.1'))).toMatchObject({ status: 401 })
      }
    } finally { await dispose() }
  })

  it('rejects malformed certificate-revoke bodies and unknown serials', async () => {
    const { routes, connection, dispose } = await mounted({
      mtlsClientSerialHeader: 'X-DSH-Client-Serial',
      mtlsTrustedProxies: ['127.0.0.1'],
    })
    try {
      const cookie = browserCookie(connection, 'localhost')
      const revoke = async (body: unknown): Promise<{ status?: number; body?: unknown }> =>
        serve(routes, fakePost({ host: 'localhost', cookie }, CERTIFICATES_REVOKE_ROUTE_PATH, body))
      expect((await revoke({})).status).toBe(400)
      expect((await revoke({ serial: 'not a serial' })).status).toBe(400)
      expect((await revoke({ serial: 42 })).status).toBe(400)
      expect((await revoke({ serial: 'f'.repeat(65) })).status).toBe(400)
      expect((await revoke({ serial: '1a2b3c4d' })).status).toBe(200)
      expect(JSON.parse(String((await revoke({ serial: '1a2b3c4d' })).body))).toEqual({ revoked: 0 })
      const badJson = await serve(routes, fakeRawPost(
        { host: 'localhost', cookie }, CERTIFICATES_REVOKE_ROUTE_PATH, 'not json'))
      expect(badJson.status).toBe(400)
    } finally { await dispose() }
  })

  it('fails the plugin load on a malformed serial-header policy', async () => {
    await expect(mounted({ mtlsClientSerialHeader: 'X-DSH-Client-Serial' }))
      .rejects.toThrow(/requires at least one mtlsTrustedProxies entry/u)
    await expect(mounted({
      mtlsClientSerialHeader: 'X-DSH Client-Serial',
      mtlsTrustedProxies: ['127.0.0.1'],
    })).rejects.toThrow(/not a valid HTTP header name/u)
    await expect(mounted({
      mtlsClientSerialHeader: 'X-DSH-Client-Serial',
      mtlsTrustedProxies: ['localhost'],
    })).rejects.toThrow(/is not an IP literal/u)
  })
})
