/** Caller identity derivation, ambient scoping, and browser-session revocation notification. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserAuth } from '../src/browser-auth.ts'
import { resolveMtlsClientCertificatePolicy } from '../src/client-certificate.ts'
import { HostConnectionService } from '../src/rpc-host.ts'
import type { ConnectionCaller, ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

/** Serial-header policy trusting Caddy on the loopback, the shipped VPS deployment shape. */
const MTLS_POLICY = resolveMtlsClientCertificatePolicy({
  mtlsClientSerialHeader: 'x-dsh-client-serial',
  mtlsTrustedProxies: ['127.0.0.1'],
})

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end() {},
    },
    state,
  }
}

function exchange(
  auth: BrowserAuth,
  authority = '127.0.0.1:3080',
  init?: {
    serial?: string
    remoteAddress?: string
  },
): string {
  const target = new URL(auth.authenticatedUrl(`http://${authority}`))
  const request: ConnectionIndexRequest = {
    method: 'GET',
    url: `${target.pathname}${target.search}`,
    headers: {
      host: authority,
      ...init?.serial === undefined ? {} : { 'x-dsh-client-serial': init.serial },
    },
    remoteAddress: init?.remoteAddress,
  }
  const { value, state } = response()
  expect(auth.authorizeIndex(request, value)).toBe(false)
  const setCookie = state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('token exchange did not set a cookie')
  return setCookie.split(';', 1)[0]!
}

interface Fixture {
  readonly service: HostConnectionService
  readonly auth: BrowserAuth
}

async function setup(trustedHosts: readonly string[] = [], mtls = false): Promise<Fixture> {
  const ctx = new Context()
  provideBrowserCredentials(ctx)
  const auth = mtls
    ? await BrowserAuth.create(ctx.root, ctx.credentials, 30, false, MTLS_POLICY)
    : await BrowserAuth.create(ctx.root, ctx.credentials, 30, false)
  return { service: new HostConnectionService(ctx, trustedHosts, auth), auth }
}

/** Last registered session of one authentication owner. */
async function lastSession(auth: BrowserAuth): Promise<{ readonly sessionId: string; readonly certificateSerial: string | undefined }> {
  const sessions = await auth.listSessions()
  const session = sessions[sessions.length - 1]
  if (session === undefined) throw new Error('no session was registered')
  return { sessionId: session.sessionId, certificateSerial: session.certificateSerial }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Connection caller identity', () => {
  it('derives the caller from the Host header, the verified cookie, and the registry', async () => {
    const loopback = await setup()
    const loopbackCookie = exchange(loopback.auth)
    const loopbackSession = await lastSession(loopback.auth)
    expect(loopback.service.callerOf({ headers: { host: '127.0.0.1:3080', cookie: loopbackCookie } }))
      .toEqual({
        host: '127.0.0.1:3080',
        loopback: true,
        sessionId: loopbackSession.sessionId,
        certificateSerial: undefined,
      } satisfies ConnectionCaller)

    // A declared remote authority stays non-loopback even though a reverse
    // proxy forwards it from a loopback socket, and case normalizes.
    const remote = await setup(['harness.internal:8443'])
    const remoteCookie = exchange(remote.auth, 'harness.internal:8443')
    const remoteSession = await lastSession(remote.auth)
    expect(remote.service.callerOf({ headers: { host: 'HARNESS.internal:8443', cookie: remoteCookie } }))
      .toEqual({
        host: 'harness.internal:8443',
        loopback: false,
        sessionId: remoteSession.sessionId,
        certificateSerial: undefined,
      } satisfies ConnectionCaller)

    // No cookie, no Host header, or an unparsable authority: no identity
    // facts, loopback only from a parsable loopback hostname.
    expect(loopback.service.callerOf({ headers: { host: '127.0.0.1:3080' } })).toEqual({
      host: '127.0.0.1:3080',
      loopback: true,
      sessionId: undefined,
      certificateSerial: undefined,
    } satisfies ConnectionCaller)
    expect(loopback.service.callerOf({ headers: {} })).toEqual({
      host: '',
      loopback: false,
      sessionId: undefined,
      certificateSerial: undefined,
    } satisfies ConnectionCaller)
    expect(loopback.service.callerOf({ headers: { host: 'not an authority' } })).toEqual({
      host: 'not an authority',
      loopback: false,
      sessionId: undefined,
      certificateSerial: undefined,
    } satisfies ConnectionCaller)
  })

  it('carries the bound certificate serial of the presented session', async () => {
    const { service, auth } = await setup([], true)
    const cookie = exchange(auth, '127.0.0.1:3080', { serial: '1a2b3c4d', remoteAddress: '127.0.0.1' })
    const session = await lastSession(auth)
    expect(service.callerOf({
      headers: { host: '127.0.0.1:3080', cookie, 'x-dsh-client-serial': '1a2b3c4d' },
      remoteAddress: '127.0.0.1',
    })).toEqual({
      host: '127.0.0.1:3080',
      loopback: true,
      sessionId: session.sessionId,
      certificateSerial: '1a2b3c4d',
    } satisfies ConnectionCaller)
  })

  it('scopes the ambient caller per async chain across nesting and concurrency', async () => {
    const { service } = await setup()
    const callerA: ConnectionCaller = { host: 'a.internal', loopback: false, sessionId: 'a', certificateSerial: undefined }
    const callerB: ConnectionCaller = { host: '127.0.0.1:1', loopback: true, sessionId: 'b', certificateSerial: undefined }
    const callerNested: ConnectionCaller = { host: 'nested', loopback: false, sessionId: 'n', certificateSerial: undefined }
    const scope = service.caller
    const tick = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve))

    const [fromA, fromB] = await Promise.all([
      scope.run(callerA, async () => {
        await tick()
        expect(scope.current()).toEqual(callerA)
        // A nested run shadows the outer identity only inside its own chain.
        expect(scope.run(callerNested, () => scope.current())).toEqual(callerNested)
        await tick()
        return scope.current()
      }),
      scope.run(callerB, async () => {
        await tick()
        await tick()
        return scope.current()
      }),
    ])
    expect(fromA).toEqual(callerA)
    expect(fromB).toEqual(callerB)
    expect(scope.current()).toBeUndefined()
  })

  it('notifies revocation listeners from all three routes and stops after unsubscribing', async () => {
    const { service, auth } = await setup([], true)
    // Two certificate-bound devices plus one unbound session to log out.
    exchange(auth, '127.0.0.1:3080', { serial: '1a2b3c4d', remoteAddress: '127.0.0.1' })
    exchange(auth, '127.0.0.1:3080', { serial: '1a2b3c4d', remoteAddress: '127.0.0.1' })
    const bound = (await auth.listSessions()).slice(-2)
    const logoutCookie = exchange(auth)
    const logoutSessionId = (await lastSession(auth)).sessionId
    const first = bound[0]
    const second = bound[1]
    if (first === undefined || second === undefined) throw new Error('bound sessions were not registered')
    const observed: (readonly string[])[] = []
    const unsubscribe = service.onSessionsRevoked((sessionIds) => { observed.push(sessionIds) })

    await expect(service.revokeSession(first.sessionId)).resolves.toBe(true)
    expect(observed).toEqual([[first.sessionId]])

    await expect(service.revokeCertificate('1a2b3c4d')).resolves.toBe(1)
    expect(observed).toEqual([[first.sessionId], [second.sessionId]])

    await expect(service.logoutSession({ headers: { host: '127.0.0.1:3080', cookie: logoutCookie } }))
      .resolves.toMatch(/^dsh-auth-/)
    // A repeated logout revokes nothing, and an unknown session id is silent.
    await expect(service.logoutSession({ headers: { host: '127.0.0.1:3080', cookie: logoutCookie } }))
      .resolves.toMatch(/^dsh-auth-/)
    await expect(service.revokeSession('never-registered')).resolves.toBe(false)
    expect(observed).toEqual([[first.sessionId], [second.sessionId], [logoutSessionId]])

    unsubscribe()
    await expect(service.revokeCertificate('1a2b3c4d')).resolves.toBe(0)
    expect(observed).toEqual([[first.sessionId], [second.sessionId], [logoutSessionId]])
  })

  it('contains listener failures so the revocation result stands', async () => {
    const { service, auth } = await setup()
    exchange(auth)
    const revoked = (await lastSession(auth)).sessionId
    const logoutCookie = exchange(auth)
    const loggedOut = (await lastSession(auth)).sessionId
    const observed: (readonly string[])[] = []
    service.onSessionsRevoked(() => { throw new Error('listener rejected the revocation') })
    const unsubscribe = service.onSessionsRevoked((sessionIds) => { observed.push(sessionIds) })

    await expect(service.revokeSession(revoked)).resolves.toBe(true)
    expect(observed).toEqual([[revoked]])
    await expect(service.logoutSession({ headers: { host: '127.0.0.1:3080', cookie: logoutCookie } }))
      .resolves.toMatch(/^dsh-auth-/)
    expect(observed).toEqual([[revoked], [loggedOut]])
    unsubscribe()
  })
})
