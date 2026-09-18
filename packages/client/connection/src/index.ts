/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
// Activates the webServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority } from './api-request-trust.ts'
import { BrowserAuth } from './browser-auth.ts'
import { DEFAULT_PAIRING_TTL_MS } from './pairing.ts'
import { HostConnectionService } from './rpc-host.ts'
import { ConnectionRecoveryConfigSchema, resolveConnectionConfig, type ConnectionRecoveryConfig } from './recovery-config.ts'

export type {
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRequestRejection,
  ConnectionRpcResult,
  ConnectionRequestBodyMode,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from './rpc.ts'
export { RpcId, transportError } from './rpc.ts'
export {
  clientRequestSchema,
  rpcErrorSchema,
  rpcIdSchema,
  rpcMessageSchema,
  rpcResultSchema,
  serverResponseSchema,
} from './rpc-schema.ts'
export { HostConnectionService } from './rpc-host.ts'
export type { RegisteredSession, SessionRegistryStore } from './session-registry.ts'
export {
  MAX_PAIRING_DEVICE_LABEL_LENGTH,
  MAX_PAIRING_TTL_MS,
  MAX_PENDING_PAIRING_TOKENS,
} from './pairing.ts'
export { SessionRegistry, credentialSessionRegistryStore } from './session-registry.ts'

export { API_PATH } from './api-path.ts'

/** Exact Fetch route listing registered browser sessions. */
export const SESSIONS_ROUTE_PATH = '/api/connection.sessions'
/** Exact Fetch route revoking one registered browser session. */
export const SESSIONS_REVOKE_ROUTE_PATH = '/api/connection.sessions.revoke'
/** Exact Fetch route minting one single-use pairing login URL. */
export const PAIRING_MINT_ROUTE_PATH = '/api/connection.pairing.mint'
/** Exact Fetch route revoking the caller's own browser session. */
export const LOGOUT_ROUTE_PATH = '/api/connection.logout'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Admit or wrap an authenticated shared API request, including body transfer.
     * Existing requests continue when a listener refuses subsequent requests.
     * @param request - Authenticated incoming HTTP request.
     * @param response - Response owned until the delegated bridge settles.
     * @param next - Delegate to the next listener or the shared API bridge.
     * @mode waterfall
     */
    'connection/request'(request: IncomingMessage, response: ServerResponse, next: () => Promise<void>): Promise<void>
  }
}

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection. */
export const inject = ['credentials']

/** Browser authentication, request limits, and connection recovery configuration. */
export interface ConnectionConfig {
  /** Browser recovery timing, injected into each served page. */
  recovery?: ConnectionRecoveryConfig
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by; the Web runtime derives LAN IP literals from an active all-interface
   * bind. An entry that is not a bare, canonical authority fails plugin load.
   */
  trustedHosts?: string[]
  /** Absolute browser-session lifetime in days. Default: 30. */
  cookieMaxAgeDays?: number
  /**
   * Add the `Secure` attribute to every browser-session cookie. Default:
   * false. Enable only when the deployment serves the browser origin through
   * an HTTPS-terminating reverse proxy; on plain HTTP the browser would
   * refuse to store or send the cookie.
   */
  cookieSecure?: boolean
  /** Maximum buffered JSON body for every `/api` request. Default: 300 MiB. */
  maxRequestBodyBytes?: number
}

export const Config: z<ConnectionConfig> = z.object({
  recovery: ConnectionRecoveryConfigSchema.default({}),
  trustedHosts: z.array(String).default([]),
  cookieMaxAgeDays: z.natural().min(1).default(30),
  cookieSecure: z.boolean().default(false),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

/**
 * Provides carrier-neutral RPC and Fetch registries. When `webServer` is
 * present, the plugin also mounts the `/api` browser transport with Host/Origin
 * checks and persistent browser authentication.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config?: ConnectionConfig): Promise<void> {
  const recovery = resolveConnectionConfig(config?.recovery)
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const cookieMaxAgeDays = config?.cookieMaxAgeDays ?? 30
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const cookieSecure = config?.cookieSecure ?? false
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  const connection = new HostConnectionService(
    ctx,
    trustedHosts,
    await BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays, cookieSecure),
  )
  ctx.inject(['webServer'], (webCtx) => {
    assertImageBodyCapacity(webCtx, maxRequestBodyBytes)
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: recovery })
    })
    const fetchHandler = connection.createSharedFetchHandler(API_PATH)
    const route: WebRoute = {
      kind: 'prefix',
      path: API_PATH,
      handler: async (req, res) => {
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await webCtx.waterfall('connection/request', req, res, () => bridge(req, res, fetchHandler, maxRequestBodyBytes))
      },
    }
    webCtx.effect(() => webCtx.webServer.register(route), 'client-connection: /api route')
    registerConnectionRoutes(webCtx, connection, cookieSecure)
  })
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
}

/** Parse one buffered JSON-object request body, or undefined when it is not a JSON object. */
async function readJsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return undefined
  }
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : undefined
}

function plainResponse(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
  })
}

/** Session-management origin derived from the trust-fenced Host header and the cookie security setting. */
function requestOrigin(request: Request, cookieSecure: boolean): string | undefined {
  const host = request.headers.get('host')
  return host === null ? undefined : `${cookieSecure ? 'https' : 'http'}://${host}`
}

/**
 * Register the session-lifecycle Fetch routes Connection owns itself. Every
 * route runs after the `/api` trust fence and browser authentication, so all
 * of them are authenticated operations.
 * @param owner - context owning the route effects.
 * @param connection - Host Connection service carrying the session registry.
 * @param cookieSecure - cookie `Secure` setting; also selects the pairing URL scheme.
 */
function registerConnectionRoutes(
  owner: Context,
  connection: HostConnectionService,
  cookieSecure: boolean,
): void {
  owner.effect(() => connection.fetch.register({
    path: SESSIONS_ROUTE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => Response.json(
      { sessions: await connection.listSessions() },
      { headers: { 'cache-control': 'no-store' } },
    ),
  }), 'client-connection: /api/connection.sessions route')
  owner.effect(() => connection.fetch.register({
    path: SESSIONS_REVOKE_ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJsonObject(request)
      const sessionId = body?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        return plainResponse(400, 'connection: sessionId must be a non-empty string')
      }
      return Response.json(
        { revoked: await connection.revokeSession(sessionId) },
        { headers: { 'cache-control': 'no-store' } },
      )
    },
  }), 'client-connection: /api/connection.sessions.revoke route')
  owner.effect(() => connection.fetch.register({
    path: PAIRING_MINT_ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const origin = requestOrigin(request, cookieSecure)
      if (origin === undefined) return plainResponse(400, 'connection: request carries no Host header')
      const body = (await readJsonObject(request)) ?? {}
      const ttlMs = body.ttlMs === undefined ? DEFAULT_PAIRING_TTL_MS : body.ttlMs
      const deviceLabel = body.deviceLabel
      if (typeof ttlMs !== 'number' || typeof deviceLabel !== 'string') {
        return plainResponse(400, 'connection: ttlMs must be a number and deviceLabel must be a string')
      }
      try {
        const minted = connection.mintPairingUrl(origin, ttlMs, deviceLabel)
        return Response.json(
          { authenticatedUrl: minted.authenticatedUrl, expiresAt: minted.expiresAt },
          { headers: { 'cache-control': 'no-store' } },
        )
      } catch (error) {
        return plainResponse(400, error instanceof Error ? error.message : String(error))
      }
    },
  }), 'client-connection: /api/connection.pairing.mint route')
  owner.effect(() => connection.fetch.register({
    path: LOGOUT_ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const clearCookie = await connection.logoutSession(request)
      return Response.json(
        { ok: true },
        {
          headers: {
            'cache-control': 'no-store',
            ...(clearCookie === undefined ? {} : { 'set-cookie': clearCookie }),
          },
        },
      )
    },
  }), 'client-connection: /api/connection.logout route')
}
