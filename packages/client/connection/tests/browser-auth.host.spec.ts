/** Browser launch-token, pairing-token, and registered-session cookie behavior. */

import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { BrowserAuth } from '../src/browser-auth.ts'
import { resolveMtlsClientCertificatePolicy, type MtlsClientCertificatePolicy } from '../src/client-certificate.ts'
import type { RegisteredSession } from '../src/session-registry.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import {
  BROWSER_SESSIONS_RECORD_KEY,
  RecordCredentials,
} from './browser-credentials.ts'

/** Credentials double whose registry snapshot is unreadable, as a damaged store would be. */
class UnreadableSessionsCredentials extends RecordCredentials {
  override readRecord(key?: unknown): Promise<CredentialRecord | undefined> {
    if (typeof key === 'string' && key === BROWSER_SESSIONS_RECORD_KEY) {
      return Promise.reject(new Error('credentials file is unreadable'))
    }
    return super.readRecord(key)
  }
}

function signedCookie(store: RecordCredentials, name: string, payload: unknown): string {
  const body = typeof payload === 'string'
    ? Buffer.from(payload, 'utf8').toString('base64url')
    : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return signedBodyCookie(store, name, body)
}

function signedBodyCookie(store: RecordCredentials, name: string, body: string): string {
  const record = store.record
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('test credential store has no signing secret')
  }
  const secret: unknown = Reflect.get(record.payload, 'secret')
  if (typeof secret !== 'string') throw new Error('test credential record has no string secret')
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')
  return `${name}=v1.${body}.${signature}`
}

/** Decode the signed payload body of one generated cookie. */
function cookiePayload(cookie: string): Record<string, unknown> {
  const body = cookie.split('.')[1]
  if (body === undefined) throw new Error('cookie has no payload body')
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
}

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
  body?: string
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

function credentials(store: RecordCredentials): CredentialProvider {
  return store as unknown as CredentialProvider
}

function createAuth(
  store: RecordCredentials,
  maxAgeDays = 30,
  processOwner: object = {},
  cookieSecure = false,
  mtlsPolicy?: MtlsClientCertificatePolicy,
): Promise<BrowserAuth> {
  return mtlsPolicy === undefined
    ? BrowserAuth.create(processOwner, credentials(store), maxAgeDays, cookieSecure)
    : BrowserAuth.create(processOwner, credentials(store), maxAgeDays, cookieSecure, mtlsPolicy)
}

/** Serial-header policy trusting Caddy on the loopback, the shipped VPS deployment shape. */
const MTLS_POLICY = resolveMtlsClientCertificatePolicy({
  mtlsClientSerialHeader: 'X-DSH-Client-Serial',
  mtlsTrustedProxies: ['127.0.0.1'],
})

function request(url: string, authority = '127.0.0.1:3080', init?: {
  cookie?: string
  method?: string
  serial?: string
  remoteAddress?: string
}): ConnectionIndexRequest {
  return {
    method: init?.method ?? 'GET',
    url,
    headers: {
      host: authority,
      ...init?.cookie === undefined ? {} : { cookie: init.cookie },
      ...init?.serial === undefined ? {} : { 'x-dsh-client-serial': init.serial },
    },
    remoteAddress: init?.remoteAddress,
  }
}

function exchange(
  auth: BrowserAuth,
  authority = '127.0.0.1:3080',
  init?: {
    serial?: string
    remoteAddress?: string
  },
): { cookie: string; launchUrl: string; state: ResponseState } {
  const launchUrl = auth.authenticatedUrl(`http://${authority}`)
  const target = new URL(launchUrl)
  const res = response()
  expect(auth.authorizeIndex(
    request(`${target.pathname}${target.search}`, authority, init),
    res.value,
  )).toBe(false)
  const setCookie = res.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('token exchange did not set a cookie')
  return { cookie: setCookie.split(';', 1)[0]!, launchUrl, state: res.state }
}

/** First registered session of one authentication owner. */
async function firstSession(auth: BrowserAuth): Promise<RegisteredSession> {
  const sessions = await auth.listSessions()
  const session = sessions[sessions.length - 1]
  if (session === undefined) throw new Error('no session was registered')
  return session
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserAuth', () => {
  it('mints one process token and a persistent authority-bound cookie naming a registered session', async () => {
    const store = new RecordCredentials()
    const processOwner = {}
    const first = await createAuth(store, 30, processOwner)
    const login = exchange(first)

    expect(login.state).toMatchObject({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': '/',
        'referrer-policy': 'no-referrer',
      },
    })
    expect(login.state.headers?.['set-cookie']).toMatch(/; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u)
    expect(login.state.headers?.['set-cookie']).not.toContain('Secure')
    const payload = cookiePayload(login.cookie)
    expect(payload.version).toBe(2)
    expect(typeof payload.sessionId).toBe('string')
    expect((payload.sessionId as string).length).toBeGreaterThan(0)
    await store.settle()
    const session = await firstSession(first)
    expect(session.sessionId).toBe(payload.sessionId)
    expect(session.deviceLabel).toBe('launch-token')
    expect(session.revokedAt).toBeUndefined()
    expect(first.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    expect(first.isAuthenticated({
      headers: new Headers({ host: '127.0.0.1:3080', cookie: login.cookie }),
    })).toBe(true)
    expect(first.isAuthenticated({ headers: new Headers() })).toBe(false)
    expect(first.isAuthenticated(request('/', 'localhost:3080', { cookie: login.cookie }))).toBe(false)
    expect(first.isAuthenticated(request('/', '127.0.0.1:3081', { cookie: login.cookie }))).toBe(false)

    const reloaded = await createAuth(store, 30, processOwner)
    expect(reloaded.authenticatedUrl('http://127.0.0.1:3080')).toBe(login.launchUrl)
    expect(reloaded.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)

    const restarted = await createAuth(store)
    expect(new URL(restarted.authenticatedUrl('http://127.0.0.1:3080')).searchParams.get('token'))
      .not.toBe(new URL(login.launchUrl).searchParams.get('token'))
    expect(restarted.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    const staleUrl = new URL(login.launchUrl)
    const redirected = response()
    expect(restarted.authorizeIndex(request(
      `${staleUrl.pathname}${staleUrl.search}`,
      '127.0.0.1:3080',
      { cookie: login.cookie },
    ), redirected.value)).toBe(false)
    expect(redirected.state).toEqual({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': '/',
        'referrer-policy': 'no-referrer',
      },
    })
    expect(store.reads).toBe(3)
    // One signing-secret write per activation plus one registry write per exchange.
    expect(store.modifies).toBe(4)
  })

  it('accepts the cookie for index serving and gives every unauthenticated request one response', async () => {
    const auth = await createAuth(new RecordCredentials())
    const { cookie } = exchange(auth)
    const allowed = response()
    expect(auth.authorizeIndex(request('/index.html', '127.0.0.1:3080', { cookie }), allowed.value)).toBe(true)
    expect(allowed.state).toEqual({})

    for (const candidate of [
      request('/'),
      request('/?token=wrong'),
      request('/?token=wrong&token=again'),
      request('/index.html?token=wrong'),
      request(auth.authenticatedUrl('http://127.0.0.1:3080'), '127.0.0.1:3080', { method: 'HEAD' }),
    ]) {
      const denied = response()
      expect(auth.authorizeIndex(candidate, denied.value)).toBe(false)
      expect(denied.state.status).toBe(401)
      expect(denied.state.headers).toEqual({
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      })
      expect(denied.state.body).toBe(candidate.method === 'HEAD'
        ? undefined
        : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
    }
  })

  it('rejects tampering, expiry, future issuance, a longer lifetime than configured, and unknown sessions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { cookie } = exchange(auth)
    const [name, value] = cookie.split('=') as [string, string]

    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=broken` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=${value.slice(0, -1)}x` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=%` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie: signedBodyCookie(store, name, 'a'),
    }))).toBe(false)
    expect(auth.isAuthenticated({ headers: {} })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: 'bad host', cookie } })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: '127.0.0.1:3080' } })).toBe(false)

    const now = Date.now()
    const validSession = { sessionId: 'registered-session', deviceLabel: 'launch-token' }
    const invalidPayloads: unknown[] = [
      'not json',
      null,
      { version: 3, authority: '127.0.0.1:3080', sessionId: 's', issuedAt: now, expiresAt: now + 1000 },
      { version: 2, authority: 42, sessionId: 's', issuedAt: now, expiresAt: now + 1000 },
      { version: 2, authority: '127.0.0.1:3080', issuedAt: now, expiresAt: now + 1000 },
      { version: 2, authority: '127.0.0.1:3080', sessionId: '', issuedAt: now, expiresAt: now + 1000 },
      { version: 2, authority: '127.0.0.1:3080', sessionId: 's', issuedAt: 'now', expiresAt: now + 1000 },
      { version: 2, authority: '127.0.0.1:3080', sessionId: 's', issuedAt: now, expiresAt: 'later' },
    ]
    for (const payload of invalidPayloads) {
      expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
        cookie: signedCookie(store, name, payload),
      }))).toBe(false)
    }

    // A correctly signed cookie naming a session the registry never issued is unauthenticated.
    const unknownSession = { ...validSession, sessionId: 'never-registered' }
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie: signedCookie(store, name, {
        version: 2, authority: '127.0.0.1:3080', ...unknownSession, issuedAt: now, expiresAt: now + 1000,
      }),
    }))).toBe(false)

    const shorter = await createAuth(store, 1)
    expect(shorter.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-08-23T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
  })

  it('keeps the registry synchronous across activations and preserves revocations', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { cookie } = exchange(auth)
    const session = await firstSession(auth)

    expect(await auth.revokeSession(session.sessionId)).toBe(true)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    expect(await auth.revokeSession(session.sessionId)).toBe(false)
    expect(await auth.revokeSession('never-registered')).toBe(false)

    const reactivated = await createAuth(store)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    expect((await reactivated.listSessions()).map(entry => entry.revokedAt !== undefined)).toEqual([true])
    expect((await reactivated.listSessions())[0]).toMatchObject({
      sessionId: session.sessionId,
      deviceLabel: 'launch-token',
    })
  })

  it('rejects every cookie when the persisted snapshot is corrupt and rewrites it empty', async () => {
    for (const corruptPayload of [
      { version: 1, sessions: 'not-a-list' },
      { version: 2, sessions: [] },
      {
        version: 1,
        sessions: [{ sessionId: '', deviceLabel: 'x', issuedAt: 1, expiresAt: 2, revokedAt: undefined }],
      },
      {
        version: 1,
        sessions: [{ sessionId: 's', deviceLabel: '', issuedAt: 1, expiresAt: 2, revokedAt: undefined }],
      },
      {
        version: 1,
        sessions: [{ sessionId: 's', deviceLabel: 'x', issuedAt: 'now', expiresAt: 2, revokedAt: undefined }],
      },
      {
        version: 1,
        sessions: [{ sessionId: 's', deviceLabel: 'x', issuedAt: 1, expiresAt: 2, revokedAt: 'soon' }],
      },
    ]) {
      const store = new RecordCredentials()
      const auth = await createAuth(store)
      const { cookie } = exchange(auth)
      store.records.set(BROWSER_SESSIONS_RECORD_KEY, { kind: 'grant', payload: corruptPayload })
      const restarted = await createAuth(store)
      expect(restarted.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
      await store.settle()
      // The corrupt snapshot was rewritten as a valid empty registry.
      expect(store.records.get(BROWSER_SESSIONS_RECORD_KEY)).toMatchObject({
        kind: 'grant',
        payload: { version: 1, sessions: [] },
      })
    }
  })

  it('fails closed when the persisted snapshot cannot be read', async () => {
    const store = new UnreadableSessionsCredentials()
    const auth = await createAuth(store)
    const { cookie } = exchange(auth)
    const restarted = await createAuth(store)
    expect(restarted.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    await store.settle()
    expect(store.records.get(BROWSER_SESSIONS_RECORD_KEY)).toMatchObject({
      payload: { version: 1, sessions: [] },
    })
  })

  it('rejects a registry record of the wrong kind at load and starts empty', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { cookie } = exchange(auth)
    store.records.set(BROWSER_SESSIONS_RECORD_KEY, { kind: 'api-key', key: 'not-a-registry' })
    const restarted = await createAuth(store)
    expect(restarted.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    await store.settle()
    expect(store.records.get(BROWSER_SESSIONS_RECORD_KEY)).toMatchObject({
      payload: { version: 1, sessions: [] },
    })
  })

  it('surfaces a failed snapshot write at the next exchange instead of issuing unverifiable cookies', async () => {
    for (const writeError of [
      new Error('credentials file is not writable'),
      'credentials file is not writable',
    ]) {
      const store = new RecordCredentials()
      const auth = await createAuth(store)
      const { cookie } = exchange(auth)
      expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(true)
      store.writeError = writeError
      await store.settle()

      const failed = response()
      const failedUrl = new URL(auth.authenticatedUrl('http://127.0.0.1:3080'))
      expect(auth.authorizeIndex(request(`${failedUrl.pathname}${failedUrl.search}`), failed.value)).toBe(false)
      expect(failed.state.status).toBe(500)
      expect(failed.state.body).toContain('credentials file is not writable')
      expect(failed.state.headers?.['set-cookie']).toBeUndefined()
      // The first session still authenticates from memory; it is the durable write that failed.
      expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(true)
    }
  })

  it('marks the cookie Secure only behind an HTTPS-terminating deployment', async () => {
    const plain = await createAuth(new RecordCredentials())
    expect(exchange(plain).state.headers?.['set-cookie']).not.toContain('Secure')

    const secureStore = new RecordCredentials()
    const secure = await createAuth(secureStore, 30, {}, true)
    const setCookie = exchange(secure).state.headers?.['set-cookie']
    expect(setCookie).toMatch(/; HttpOnly; SameSite=Strict; Secure$/u)
    expect((await secure.logout({
      headers: { host: '127.0.0.1:3080', cookie: exchange(secure).cookie },
    })).clearCookie).toMatch(/; Secure$/u)
    void secureStore
  })

  it('logs out by revoking the presented session and expiring the cookie', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { cookie } = exchange(auth)
    const cleared = await auth.logout({ headers: { host: '127.0.0.1:3080', cookie } })
    expect(cleared.clearCookie).toMatch(
      /^dsh-auth-[^=]+=; Max-Age=0; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict$/u,
    )
    expect(cleared.revoked).toBe(true)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    expect(typeof (await firstSession(auth)).revokedAt).toBe('number')

    // A cookie signed for another authority is not this cookie's session.
    const [name] = cookie.split('=') as [string, string]
    expect(await auth.logout({ headers: { host: '127.0.0.1:3080', cookie: signedCookie(store, name, {
      version: 2, authority: 'localhost:1', sessionId: 's', issuedAt: Date.now(), expiresAt: Date.now() + 1000,
    }) } })).toEqual({ sessionId: undefined, revoked: false, clearCookie: undefined })

    // A second logout for the same cookie still returns the clearing header.
    expect(await auth.logout({ headers: { host: '127.0.0.1:3080', cookie } }))
      .toEqual({ sessionId: cleared.sessionId, revoked: false, clearCookie: cleared.clearCookie })
    expect(await auth.logout({ headers: { host: '127.0.0.1:3080' } }))
      .toEqual({ sessionId: undefined, revoked: false, clearCookie: undefined })
    expect(await auth.logout({ headers: { cookie } }))
      .toEqual({ sessionId: undefined, revoked: false, clearCookie: undefined })
    expect(await auth.logout({ headers: { host: '127.0.0.1:3080', cookie: 'other=1' } }))
      .toEqual({ sessionId: undefined, revoked: false, clearCookie: undefined })
    expect(await auth.logout({ headers: { host: '127.0.0.1:3080', cookie: `${cookie.split('=')[0]}=broken` } }))
      .toEqual({ sessionId: undefined, revoked: false, clearCookie: undefined })
  })

  it('exchanges a one-shot pairing token once with the minted device label', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const minted = auth.pairingUrl('http://127.0.0.1:3080', 60_000, 'phone')
    expect(minted.expiresAt).toBe(Date.now() + 60_000)
    const target = new URL(minted.authenticatedUrl)
    expect(target.pathname).toBe('/')

    const login = response()
    expect(auth.authorizeIndex(request(`${target.pathname}${target.search}`), login.value)).toBe(false)
    expect(login.state.status).toBe(303)
    const setCookie = login.state.headers?.['set-cookie']
    if (setCookie === undefined) throw new Error('pairing exchange did not set a cookie')
    const cookie = setCookie.split(';', 1)[0]!
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(true)
    expect(await firstSession(auth)).toMatchObject({ deviceLabel: 'phone' })

    // The pairing token is single use.
    const replay = response()
    expect(auth.authorizeIndex(request(`${target.pathname}${target.search}`), replay.value)).toBe(false)
    expect(replay.state.status).toBe(401)

    // Malformed shapes never consume a pending token.
    const second = auth.pairingUrl('http://127.0.0.1:3080', 60_000, 'tablet')
    const secondTarget = new URL(second.authenticatedUrl)
    const held = response()
    expect(auth.authorizeIndex(request(`${secondTarget.pathname}${secondTarget.search}`, '127.0.0.1:3080', {
      method: 'POST',
    }), held.value)).toBe(false)
    expect(held.state.status).toBe(401)
    expect(auth.authorizeIndex(request(`${secondTarget.pathname}?token=a&token=b`), held.value)).toBe(false)

    const consumed = response()
    expect(auth.authorizeIndex(request(`${secondTarget.pathname}${secondTarget.search}`), consumed.value)).toBe(false)
    expect(consumed.state.status).toBe(303)
    expect(await firstSession(auth)).toMatchObject({ deviceLabel: 'tablet' })

    // Expired pairing tokens are refused.
    const expiring = auth.pairingUrl('http://127.0.0.1:3080', 1_000, 'late')
    vi.setSystemTime(new Date(Date.now() + 2_000))
    const expired = response()
    const expiredTarget = new URL(expiring.authenticatedUrl)
    expect(auth.authorizeIndex(request(`${expiredTarget.pathname}${expiredTarget.search}`), expired.value)).toBe(false)
    expect(expired.state.status).toBe(401)
  })

  it('loads one secret per activation and replaces it after deletion on the next activation', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const first = exchange(auth)
    await store.settle()
    expect(store).toMatchObject({ reads: 1, modifies: 2 })

    await store.deleteRecord()
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(true)
    const sameActivation = exchange(auth)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: sameActivation.cookie }))).toBe(true)
    await store.settle()
    expect(store).toMatchObject({ reads: 1, modifies: 3 })

    const reactivated = await createAuth(store)
    const second = exchange(reactivated)
    expect(second.cookie).not.toBe(first.cookie)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(false)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: second.cookie }))).toBe(true)
    await store.settle()
    expect(store).toMatchObject({ reads: 2, modifies: 5 })
  })

  it('fails loud on an invalid owner record instead of replacing it', async () => {
    const unsupported = new RecordCredentials()
    unsupported.record = { kind: 'api-key', key: 'not-a-cookie-secret' }
    await expect(createAuth(unsupported)).rejects.toThrow(/unsupported format/u)

    const malformed = new RecordCredentials()
    malformed.record = { kind: 'grant', payload: { version: 1, secret: 'short' } }
    await expect(createAuth(malformed)).rejects.toThrow(/invalid secret/u)

    const nonString = new RecordCredentials()
    nonString.record = { kind: 'grant', payload: { version: 1, secret: 42 } }
    await expect(createAuth(nonString)).rejects.toThrow(/invalid secret/u)

    const discarded = new RecordCredentials()
    discarded.discardWrites = true
    await expect(createAuth(discarded)).rejects.toThrow(/was not created/u)

    await expect(createAuth(new RecordCredentials(), Number.MAX_SAFE_INTEGER))
      .rejects.toThrow(/safe timestamp range/u)
  })

  it('binds the trusted certificate serial at exchange and requires it on every later request', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store, 30, {}, false, MTLS_POLICY)
    const { cookie } = exchange(auth, '127.0.0.1:3080', {
      serial: '1A2B3C4D',
      remoteAddress: '127.0.0.1',
    })
    expect(await firstSession(auth)).toMatchObject({ certificateSerial: '1a2b3c4d' })
    const boundSessionId = (await firstSession(auth)).sessionId

    // The same device (same serial, via the trusted proxy) authenticates.
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie, serial: '1a2b3c4d', remoteAddress: '127.0.0.1',
    }))).toBe(true)
    // Caddy's decimal rendering of the same serial is accepted.
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie, serial: '439041101', remoteAddress: '127.0.0.1',
    }))).toBe(true)
    // A copied cookie pair on a device with another certificate is refused.
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie, serial: 'ffffffffffffffff', remoteAddress: '127.0.0.1',
    }))).toBe(false)
    // A trusted proxy that forwards no serial is equally refused.
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    // A serial header from any other peer is ignored, so the bound session fails closed.
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie, serial: '1a2b3c4d', remoteAddress: '192.168.1.9',
    }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie, serial: '1a2b3c4d',
    }))).toBe(false)

    // A session issued without a bound serial keeps the cookie-only behavior.
    const unbound = exchange(auth)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: unbound.cookie }))).toBe(true)

    // Revoking the certificate invalidates every session bound to its serial
    // at once and leaves the unbound session alone.
    expect(await auth.revokeCertificate('1a2b3c4d')).toEqual([boundSessionId])
    expect(await auth.revokeCertificate('1a2b3c4d')).toEqual([])
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie, serial: '1a2b3c4d', remoteAddress: '127.0.0.1',
    }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: unbound.cookie }))).toBe(true)
    await expect(auth.revokeCertificate('NOT-HEX')).rejects.toThrow(/certificateSerial/u)
  })

  it('binds the serial to pairing-token sessions as well', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store, 30, {}, false, MTLS_POLICY)
    const minted = auth.pairingUrl('http://127.0.0.1:3080', 60_000, 'phone')
    const target = new URL(minted.authenticatedUrl)
    const login = response()
    expect(auth.authorizeIndex(request(`${target.pathname}${target.search}`, '127.0.0.1:3080', {
      serial: '1a2b3c4d',
      remoteAddress: '127.0.0.1',
    }), login.value)).toBe(false)
    const setCookie = login.state.headers?.['set-cookie']
    if (setCookie === undefined) throw new Error('pairing exchange did not set a cookie')
    const cookie = setCookie.split(';', 1)[0]!
    expect(await firstSession(auth)).toMatchObject({ deviceLabel: 'phone', certificateSerial: '1a2b3c4d' })
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie, serial: '1a2b3c4d', remoteAddress: '127.0.0.1',
    }))).toBe(true)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
  })

  it('keeps cookie-only behavior when no serial header is configured', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { cookie } = exchange(auth, '127.0.0.1:3080', {
      serial: '1a2b3c4d',
      remoteAddress: '127.0.0.1',
    })
    // The header is never read, and the session registers unbound.
    expect(await firstSession(auth)).toMatchObject({ certificateSerial: undefined })
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(true)
  })
})
