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
import {
  parseCertificateSerial,
  resolveMtlsClientCertificatePolicy,
  type MtlsClientCertificatePolicy,
} from './client-certificate.ts'
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
  SessionsRevokedListener,
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
export { ConnectionCallerContext } from './caller-context.ts'
export type { ConnectionCaller } from './caller-context.ts'
export type { AuthenticatedSession, SessionLogout } from './browser-auth.ts'
export type { RegisteredSession, SessionRegistryStore } from './session-registry.ts'
export {
  MAX_CERTIFICATE_SERIAL_HEX_LENGTH,
  parseCertificateSerial,
  type MtlsClientCertificatePolicy,
} from './client-certificate.ts'
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
/** Exact Fetch route revoking every session bound to one client-certificate serial. */
export const CERTIFICATES_REVOKE_ROUTE_PATH = '/api/connection.certificates.revoke'

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
  /**
   * The origin a paired device reaches this deployment through — scheme and
   * authority only, such as `https://dsh.example:8443` — used as the base of
   * every minted pairing URL instead of the minting request's own origin.
   * Default: unset, and a pairing URL takes the origin the desktop browser
   * used, which behind a relay is the loopback address no phone can open.
   * Must carry `https` when `cookieSecure` is on, no path, query, or
   * fragment, and an authority listed in `trustedHosts`; anything else
   * fails plugin load.
   */
  publicOrigin?: string
  /**
   * HTTP header carrying the client certificate's serial number, as forwarded
   * by the mTLS-terminating reverse proxy (Caddy:
   * `header_up X-DSH-Client-Serial {http.request.tls.client.serial}`). Default:
   * undefined — no serial header is trusted and sessions stay cookie-only. A
   * header without any `mtlsTrustedProxies` entry fails plugin load. When
   * configured, every token exchange binds the trusted serial to the new
   * session, and a bound session authenticates only from requests whose
   * trusted proxy forwards the same serial, so a copied cookie pair is inert
   * on another device.
   */
  mtlsClientSerialHeader?: string
  /**
   * Remote socket addresses (IP literals) of the proxies allowed to forward
   * the `mtlsClientSerialHeader` — for Caddy on the same host, `127.0.0.1`
   * (frp terminates locally, Caddy proxies over the loopback). Default: empty.
   * A trusted proxy that forwards no serial, or a malformed serial, never
   * authenticates a certificate-bound session.
   */
  mtlsTrustedProxies?: string[]
}

export const Config: z<ConnectionConfig> = z.object({
  recovery: ConnectionRecoveryConfigSchema.default({}),
  trustedHosts: z.array(String).default([]),
  cookieMaxAgeDays: z.natural().min(1).default(30),
  cookieSecure: z.boolean().default(false),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
  // publicOrigin stays a runtime-only declared field for the same reason as
  // mtlsClientSerialHeader below: unset must stay distinguishable from empty.
  // mtlsClientSerialHeader stays a runtime-only declared field: the vendored
  // schema language has no optional-string node, and an unset header (the
  // default) must stay distinguishable from an empty one. resolve-apply reads
  // it straight from the config object.
  mtlsTrustedProxies: z.array(String).default([]),
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
  const publicOrigin = resolvePublicOrigin(config?.publicOrigin, cookieSecure, trustedHosts)
  // Config boundary: a malformed serial-header policy fails the load loudly
  // instead of trusting a header from the wrong peer or trusting nothing.
  const mtlsPolicy: MtlsClientCertificatePolicy = resolveMtlsClientCertificatePolicy(config ?? {})
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  const connection = new HostConnectionService(
    ctx,
    trustedHosts,
    await BrowserAuth.create(ctx.root, ctx.credentials, cookieMaxAgeDays, cookieSecure, mtlsPolicy),
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
    registerConnectionRoutes(webCtx, connection, cookieSecure, publicOrigin)
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
 * Validate the configured public origin at load: an absolute `http`/`https`
 * URL with nothing beyond its authority, `https` whenever cookies are
 * `Secure` (a phone could not store the cookie otherwise), and an authority
 * the trust fence admits — port-exact or port-less, as `trustedHosts`
 * entries are matched — so every pairing URL minted from it leads to a page
 * that actually loads.
 * @param configured - the raw `publicOrigin` config value, or undefined.
 * @param cookieSecure - the deployment's cookie `Secure` setting.
 * @param trustedHosts - the deployment's trusted authorities.
 * @returns the normalized origin (no trailing slash), or undefined when unset.
 * @throws Error naming the offending value when it is not usable.
 */
export function resolvePublicOrigin(
  configured: string | undefined,
  cookieSecure: boolean,
  trustedHosts: readonly string[],
): string | undefined {
  if (configured === undefined) return undefined
  let url: URL
  try {
    url = new URL(configured)
  } catch {
    throw new Error(`client-connection: publicOrigin ${JSON.stringify(configured)} is not an absolute URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`client-connection: publicOrigin ${JSON.stringify(configured)} must use http or https`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error(`client-connection: publicOrigin ${JSON.stringify(configured)} must be a bare origin (scheme and authority only)`)
  }
  if (cookieSecure && url.protocol !== 'https:') {
    throw new Error(`client-connection: publicOrigin ${JSON.stringify(configured)} must use https while cookieSecure is on`)
  }
  const authority = url.host.toLowerCase()
  const hostname = url.hostname.toLowerCase()
  const trusted = trustedHosts.some((entry) => {
    const normalized = entry.toLowerCase()
    return normalized === authority || normalized === hostname
  })
  if (!trusted) {
    throw new Error(`client-connection: publicOrigin authority ${JSON.stringify(url.host)} is not listed in trustedHosts, so its pages would be refused`)
  }
  return url.origin
}

/**
 * Register the session-lifecycle Fetch routes Connection owns itself. Every
 * route runs after the `/api` trust fence and browser authentication, so all
 * of them are authenticated operations.
 * @param owner - context owning the route effects.
 * @param connection - Host Connection service carrying the session registry.
 * @param cookieSecure - cookie `Secure` setting; also selects the pairing URL scheme.
 * @param publicOrigin - the configured origin paired devices use, which every pairing URL is minted from when set.
 */
function registerConnectionRoutes(
  owner: Context,
  connection: HostConnectionService,
  cookieSecure: boolean,
  publicOrigin: string | undefined,
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
      // The configured public origin wins: behind a relay the desktop's own
      // origin is a loopback address no phone can open.
      const origin = publicOrigin ?? requestOrigin(request, cookieSecure)
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
  owner.effect(() => connection.fetch.register({
    path: CERTIFICATES_REVOKE_ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = await readJsonObject(request)
      // Both notations are accepted: the proxy forwards the serial as a
      // decimal integer (Caddy), while the CA index lists hexadecimal.
      const serial = parseCertificateSerial(body?.serial)
      if (serial === undefined) {
        return plainResponse(400, 'connection: serial must be a hexadecimal or decimal certificate serial')
      }
      return Response.json(
        { revoked: await connection.revokeCertificate(serial) },
        { headers: { 'cache-control': 'no-store' } },
      )
    },
  }), 'client-connection: /api/connection.certificates.revoke route')
}
