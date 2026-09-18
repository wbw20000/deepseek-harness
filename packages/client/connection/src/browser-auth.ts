/** Browser-session authentication for the Host Connection carrier. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { PairingTokens } from './pairing.ts'
import { SessionRegistry, credentialSessionRegistryStore, type RegisteredSession } from './session-registry.ts'
import { decodeBase64Url, encodeBase64Url, tokenMatches } from './token-encoding.ts'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'

const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const TOKEN_QUERY = 'token'
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 2
const STORED_SECRET_VERSION = 1
/** deviceLabel recorded for sessions minted through the process launch token. */
const LAUNCH_DEVICE_LABEL = 'launch-token'
const PROCESS_LAUNCH_TOKENS = new WeakMap<object, string>()

interface StoredSecretPayload {
  readonly version: typeof STORED_SECRET_VERSION
  readonly secret: string
}

interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  /** Registered session this cookie names; the registry decides revocation. */
  readonly sessionId: string
  readonly issuedAt: number
  readonly expiresAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function processLaunchToken(owner: object): string {
  const existing = PROCESS_LAUNCH_TOKENS.get(owner)
  if (existing !== undefined) return existing
  const created = encodeBase64Url(randomBytes(SECRET_BYTES))
  PROCESS_LAUNCH_TOKENS.set(owner, created)
  return created
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Canonical request authority used as the cookie name and signed audience. */
function requestAuthority(headers: ConnectionTrustRequest['headers']): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) return undefined
  return decoded
}

function storedSecret(record: CredentialRecord | undefined): Buffer | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)
    || record.payload.version !== STORED_SECRET_VERSION) {
    throw new Error('client-connection: browser-session credential record has an unsupported format')
  }
  const secret = canonicalSecret(record.payload.secret)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record has an invalid secret')
  }
  return secret
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(
  name: string,
  value: string,
  expiresAt: number,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
}

/** Expire one browser-session cookie; the value is irrelevant to the browser. */
function clearSessionCookie(name: string, secure: boolean): string {
  return `${name}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function encodeCookie(payload: BrowserCookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): BrowserCookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || decoded.version !== COOKIE_PAYLOAD_VERSION
    || typeof decoded.authority !== 'string'
    || typeof decoded.sessionId !== 'string'
    || decoded.sessionId === ''
    || !Number.isSafeInteger(decoded.issuedAt)
    || !Number.isSafeInteger(decoded.expiresAt)) return undefined
  return decoded as unknown as BrowserCookiePayload
}

async function initializeSecret(credentials: CredentialProvider): Promise<Buffer> {
  const generated: StoredSecretPayload = {
    version: STORED_SECRET_VERSION,
    secret: encodeBase64Url(randomBytes(SECRET_BYTES)),
  }
  const record = await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
    if (current !== undefined) {
      storedSecret(current)
      return Promise.resolve(undefined)
    }
    return Promise.resolve({ kind: 'grant', payload: generated })
  })
  const secret = storedSecret(record)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record was not created')
  }
  return secret
}

/**
 * Process launch-token and one-shot pairing-token exchange, persistent
 * signed-cookie verification, and server-side session revocation. Connection
 * loads the credential provider's signing secret and the registered-session
 * table during activation and retains both for synchronous request
 * authentication.
 */
export class BrowserAuth {
  private readonly launchToken: string
  private readonly maxAgeMilliseconds: number
  private readonly pairing = new PairingTokens()

  private constructor(
    processOwner: object,
    private readonly secret: Buffer,
    maxAgeDays: number,
    private readonly cookieSecure: boolean,
    private readonly registry: SessionRegistry,
  ) {
    this.launchToken = processLaunchToken(processOwner)
    this.maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS
    if (!Number.isSafeInteger(this.maxAgeMilliseconds)
      || !Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)) {
      throw new Error('client-connection: cookieMaxAgeDays exceeds the safe timestamp range')
    }
  }

  /**
   * Initialize browser authentication, create its durable signing secret when
   * this Harness home has none, and load the registered-session table.
   * @param processOwner - root application context retaining one token across Connection reloads.
   * @param credentials - persistent credential provider for the Web profile.
   * @param maxAgeDays - positive absolute browser-cookie lifetime in days.
   * @param cookieSecure - add the `Secure` cookie attribute; enable only behind an HTTPS-terminating reverse proxy.
   * @returns initialized authentication owner with the process owner's launch token.
   */
  static async create(
    processOwner: object,
    credentials: CredentialProvider,
    maxAgeDays: number,
    cookieSecure = false,
  ): Promise<BrowserAuth> {
    const registry = new SessionRegistry(credentialSessionRegistryStore(credentials))
    await registry.loaded
    return new BrowserAuth(
      processOwner,
      await initializeSecret(credentials),
      maxAgeDays,
      cookieSecure,
      registry,
    )
  }

  /**
   * Add this process's launch token to the ordinary application root URL.
   * @param baseUrl - canonical browser origin without credentials.
   * @returns root URL carrying the process token as its sole authentication input.
   */
  authenticatedUrl(baseUrl: string): string {
    return this.withToken(baseUrl, this.launchToken)
  }

  /**
   * Mint one single-use pairing token and add it to an application root URL.
   * @param baseUrl - canonical browser origin without credentials.
   * @param ttlMs - pairing-token time to live between 1 ms and ten minutes.
   * @param deviceLabel - label recorded for the session issued at consumption.
   * @returns the one-shot login URL and the token's absolute expiry.
   */
  pairingUrl(
    baseUrl: string,
    ttlMs: number,
    deviceLabel: string,
  ): { readonly authenticatedUrl: string; readonly expiresAt: number } {
    const minted = this.pairing.mint(ttlMs, deviceLabel)
    return { authenticatedUrl: this.withToken(baseUrl, minted.token), expiresAt: minted.expiresAt }
  }

  private withToken(baseUrl: string, token: string): string {
    const url = new URL(baseUrl)
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    url.searchParams.set(TOKEN_QUERY, token)
    return url.href
  }

  /** Launch token or pending pairing token behind one `?token=` value, or undefined. */
  private exchangeToken(candidate: string): string | undefined {
    if (tokenMatches(candidate, this.launchToken)) return LAUNCH_DEVICE_LABEL
    return this.pairing.consume(candidate)?.deviceLabel
  }

  /**
   * Authenticate an index request. A valid root query token (the process
   * launch token or a one-shot pairing token) registers a session, mints the
   * cookie, and redirects to clean `/`; a valid cookie lets the caller serve
   * the index; every other request receives the same minimal 401 response.
   * @param req - incoming root or configured-index request.
   * @param res - response owned when this method returns false.
   * @returns true only when the caller may serve index.html.
   */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse): boolean {
    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    if (tokens.length > 0) {
      const singleToken = tokens.length === 1 ? tokens[0] : undefined
      if (req.method === 'GET' && url.pathname === '/' && singleToken !== undefined) {
        const deviceLabel = this.exchangeToken(singleToken)
        const authority = requestAuthority(req.headers)
        if (deviceLabel !== undefined && authority !== undefined) {
          this.writeSessionCookie(res, authority, deviceLabel)
          return false
        }
      }
      if (req.method === 'GET' && url.pathname === '/' && this.isAuthenticated(req)) {
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': '/',
          'referrer-policy': 'no-referrer',
        })
        res.end()
        return false
      }
      this.writeUnauthorized(req, res)
      return false
    }
    if (this.isAuthenticated(req)) return true
    this.writeUnauthorized(req, res)
    return false
  }

  /** Register the exchanged session and set its cookie; the exchange cannot await the durable write. */
  private writeSessionCookie(
    res: ConnectionIndexResponse,
    authority: string,
    deviceLabel: string,
  ): void {
    try {
      const session = this.registry.issueSync(deviceLabel, Date.now() + this.maxAgeMilliseconds)
      const value = encodeCookie({
        version: COOKIE_PAYLOAD_VERSION,
        authority,
        sessionId: session.sessionId,
        issuedAt: session.issuedAt,
        expiresAt: session.expiresAt,
      }, this.secret)
      res.writeHead(303, {
        'cache-control': 'no-store',
        'location': '/',
        'referrer-policy': 'no-referrer',
        'set-cookie': sessionCookie(
          cookieName(authority), value, session.expiresAt,
          Math.floor(this.maxAgeMilliseconds / 1000), this.cookieSecure,
        ),
      })
      res.end()
    } catch (error) {
      // Fail loud: the session table refused the registration, so no cookie
      // may be issued; the response carries no token material.
      res.writeHead(500, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      })
      res.end(`dsh web session registration failed; ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  /**
   * Verify the authority-bound browser cookie on a Host request against the
   * signing secret, the cookie interval, and the session registry: an unknown
   * or revoked session never authenticates.
   * @param request - request headers carrying Host and Cookie.
   * @returns true only for an unexpired cookie naming an unrevoked registered session.
   */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    const authority = requestAuthority(request.headers)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return false
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return false
    const payload = decodeCookie(value, this.secret)
    if (payload === undefined || payload.authority !== authority) return false
    const session = this.registry.lookup(payload.sessionId)
    if (session === undefined || session.revokedAt !== undefined) return false
    const now = Date.now()
    return session.expiresAt > now
      && payload.issuedAt <= now
      && payload.expiresAt > now
      && payload.expiresAt > payload.issuedAt
      && payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds
  }

  /**
   * Revoke the session presented by this request's cookie.
   * @param request - request headers carrying Host and Cookie.
   * @returns the cookie-clearing `Set-Cookie` value, or undefined when the
   * request carries no cookie signed for this authority.
   */
  async logout(request: ConnectionTrustRequest): Promise<string | undefined> {
    const authority = requestAuthority(request.headers)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return undefined
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return undefined
    const payload = decodeCookie(value, this.secret)
    if (payload === undefined || payload.authority !== authority) return undefined
    await this.registry.revoke(payload.sessionId)
    return clearSessionCookie(cookieName(authority), this.cookieSecure)
  }

  /**
   * List registered browser sessions.
   * @returns the registrations; no cookie value is part of a registration.
   */
  listSessions(): Promise<readonly RegisteredSession[]> {
    return this.registry.list()
  }

  /**
   * Revoke one registered browser session.
   * @param sessionId - registration to revoke.
   * @returns false when it was unknown or already revoked, otherwise true.
   */
  revokeSession(sessionId: string): Promise<boolean> {
    return this.registry.revoke(sessionId)
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
  }
}
