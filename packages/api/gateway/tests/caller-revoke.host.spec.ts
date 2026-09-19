/** Revocation disconnects accepted mux connections; handlers read the caller identity. */

import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject, HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { ConnectionCaller } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {
  bindTypertRemote,
  Remote,
  type InvocationDescriptor,
} from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { z } from 'zod'
import { provideBrowserCredentials } from './browser-credentials.ts'

const BOUND_SERIAL = '1a2b3c4d'
const CONNECTION_CONFIG = {
  mtlsClientSerialHeader: 'x-dsh-client-serial',
  mtlsTrustedProxies: ['127.0.0.1'],
}

/** Stream probe whose handler records the ambient Connection caller identity. */
class CallerProbeService extends Service {
  readonly typertRemote = bindTypertRemote(this, 'probe')
  readonly observed: (ConnectionCaller | undefined)[] = []

  constructor(ctx: Context) {
    super(ctx, 'probe')
  }

  @Remote({ mode: 'stream' })
  async *who(signal: AbortSignal): AsyncIterable<string> {
    // ctx.<name> is topology-sensitive; the probe reads the global service store.
    const caller = this.ctx.get('connection')?.caller.current()
    this.observed.push(caller === undefined ? undefined : { ...caller })
    yield caller?.sessionId ?? 'anonymous'
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }
}

function descriptors(): InvocationDescriptor[] {
  return [{
    id: '@fixture/probe#probe/who',
    service: 'probe',
    namespace: 'probe',
    method: 'who',
    mode: 'stream',
    invocation: { kind: 'direct' },
    parameters: [],
    result: { mode: 'strict', typeSymbol: '@fixture/probe#Item', create: () => z.string() },
    cancellation: { parameter: 'signal' },
  }]
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(): Promise<{ readonly ctx: Context; readonly probe: CallerProbeService }> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService)
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection }, CONNECTION_CONFIG)
  await ctx.plugin(CallerProbeService)
  ctx.typert.register({
    package: '@fixture/probe',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: descriptors(),
  })
  const receiver = ctx.get('probe') as unknown as CallerProbeService & { [symbols.original]?: CallerProbeService }
  return { ctx, probe: receiver[symbols.original] ?? receiver }
}

/** Exchange one device's process token for its mux Cookie header; a serial binds the session to that device. */
function deviceCookie(ctx: Context, serial?: string): string {
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const target = new URL(ctx.connection.authenticatedUrl(origin))
  let setCookie: string | undefined
  ctx.connection.authorizeIndex({
    method: 'GET',
    url: `${target.pathname}${target.search}`,
    headers: {
      host: target.host,
      ...(serial === undefined ? {} : { 'x-dsh-client-serial': serial }),
    },
    remoteAddress: '127.0.0.1',
  }, {
    writeHead(_status, headers) { setCookie = headers?.['set-cookie'] },
    end() {},
  })
  if (setCookie === undefined) throw new Error('device fixture did not receive a browser cookie')
  return setCookie.split(';', 1)[0]!
}

/** Open the mux socket as one device; a bound device must present its serial through the trusted proxy (its loopback socket). */
async function openMux(ctx: Context, cookie: string, serial?: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
    headers: {
      cookie,
      ...(serial === undefined ? {} : { 'x-dsh-client-serial': serial }),
    },
  })
  await once(socket, 'open')
  return socket
}

function sendOpen(socket: WebSocket, streamId: string, endpoint: string, args: object): void {
  socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
}

/** Text of one ws message frame, without the protocol's binary variant. */
function frameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function collectFrames(socket: WebSocket): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  socket.on('message', (data: RawData) => {
    frames.push(JSON.parse(frameText(data)) as Record<string, unknown>)
  })
  return frames
}

/** Session id of the certificate-bound device, from the server-side registry. */
/** The mounted Connection service, typed for the revocation and registry operations these specs drive. */
function connectionOf(ctx: Context): HostConnectionService {
  return ctx.connection as HostConnectionService
}

async function boundSessionId(ctx: Context): Promise<string> {
  const session = (await connectionOf(ctx).listSessions())
    .find(entry => entry.certificateSerial === BOUND_SERIAL)
  if (session === undefined) throw new Error('bound device session was not registered')
  return session.sessionId
}

/** Session id of an unbound (cookie-only) device, from the server-side registry. */
async function unboundSessionId(ctx: Context): Promise<string> {
  const session = (await connectionOf(ctx).listSessions())
    .find(entry => entry.certificateSerial === undefined)
  if (session === undefined) throw new Error('unbound device session was not registered')
  return session.sessionId
}

describe('Gateway mux caller identity and revocation disconnect', () => {
  it('exposes the upgrade-derived caller identity to stream handlers', async () => {
    const { ctx, probe } = await setup()
    const socket = await openMux(ctx, deviceCookie(ctx, BOUND_SERIAL), BOUND_SERIAL)
    const frames = collectFrames(socket)
    const sessionId = await boundSessionId(ctx)

    sendOpen(socket, 'who', 'probe/who', {})
    await vi.waitFor(() => {
      expect(frames).toContainEqual({ type: 'item', streamId: 'who', value: sessionId })
    })
    expect(probe.observed).toEqual([{
      host: `127.0.0.1:${String(ctx.webServer.port)}`,
      loopback: true,
      sessionId,
      certificateSerial: BOUND_SERIAL,
    } satisfies ConnectionCaller])
    socket.close()
    await once(socket, 'close')
  })

  it('disconnects the revoked device with 4401, refuses its next handshake, and keeps other devices', async () => {
    const { ctx } = await setup()
    const revokedCookie = deviceCookie(ctx, BOUND_SERIAL)
    const keptCookie = deviceCookie(ctx)
    const revoked = await openMux(ctx, revokedCookie, BOUND_SERIAL)
    const kept = await openMux(ctx, keptCookie)
    const keptFrames = collectFrames(kept)
    const sessionId = await boundSessionId(ctx)
    const keptSessionId = await unboundSessionId(ctx)

    sendOpen(kept, 'before', 'probe/who', {})
    await vi.waitFor(() => {
      expect(keptFrames).toContainEqual({ type: 'item', streamId: 'before', value: keptSessionId })
    })

    const closed = once(revoked, 'close')
    await expect(connectionOf(ctx).revokeSession(sessionId)).resolves.toBe(true)
    const closeEvent = await closed as [number, unknown]
    expect(closeEvent[0]).toBe(4401)
    expect(String(closeEvent[1])).toBe('session revoked')

    // The revoked device's next handshake is refused by authentication.
    const rejected = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
      headers: { cookie: revokedCookie, 'x-dsh-client-serial': BOUND_SERIAL },
    })
    const [, response] = await once(rejected, 'unexpected-response') as [unknown, { statusCode: number }]
    expect(response.statusCode).toBe(401)

    // Another device's accepted connection keeps serving.
    sendOpen(kept, 'after', 'probe/who', {})
    await vi.waitFor(() => {
      expect(keptFrames).toContainEqual({ type: 'item', streamId: 'after', value: keptSessionId })
    })
    kept.close()
    await once(kept, 'close')
  })

  it('disconnects every session of a revoked certificate and leaves unbound devices alone', async () => {
    const { ctx } = await setup()
    const boundCookie = deviceCookie(ctx, BOUND_SERIAL)
    const unboundCookie = deviceCookie(ctx)
    const bound = await openMux(ctx, boundCookie, BOUND_SERIAL)
    const unbound = await openMux(ctx, unboundCookie)
    const unboundFrames = collectFrames(unbound)
    const survivingSessionId = await unboundSessionId(ctx)

    const closed = once(bound, 'close')
    await expect(connectionOf(ctx).revokeCertificate(BOUND_SERIAL)).resolves.toBe(1)
    const closeEvent = await closed as [number, unknown]
    expect(closeEvent[0]).toBe(4401)
    expect(String(closeEvent[1])).toBe('session revoked')

    sendOpen(unbound, 'kept', 'probe/who', {})
    await vi.waitFor(() => {
      expect(unboundFrames).toContainEqual({ type: 'item', streamId: 'kept', value: survivingSessionId })
    })
    unbound.close()
    await once(unbound, 'close')
  })

  it('closes every mux connection and unsubscribes when the Gateway unloads', async () => {
    const { ctx } = await setup()
    const bound = await openMux(ctx, deviceCookie(ctx, BOUND_SERIAL), BOUND_SERIAL)
    const unbound = await openMux(ctx, deviceCookie(ctx))
    const closed = Promise.all([once(bound, 'close'), once(unbound, 'close')])

    await ctx.fiber.dispose()

    await closed
  })
})
