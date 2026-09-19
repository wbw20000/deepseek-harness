/**
 * Per-device client-certificate binding. When the deployment terminates mTLS
 * in a reverse proxy (Caddy) in front of DSH, the proxy forwards the verified
 * client certificate's serial number as an HTTP header. Connection binds that
 * serial to the registered session at token exchange and requires every later
 * request to present the same serial, so a copied cookie pair is useless on a
 * device whose certificate carries a different serial. Trusting the header at
 * all requires the request's remote socket address to be one of the
 * configured trusted proxies; absent configuration never reads the header.
 * @module
 */

import { isIP } from 'node:net'
import type { ConnectionTrustRequest } from './rpc.ts'

/** Upper bound of a certificate serial in lowercase hexadecimal characters; wider than any RFC 5280 serial (20 octets). */
export const MAX_CERTIFICATE_SERIAL_HEX_LENGTH = 64

/** HTTP field-name characters (RFC 9110 `token`); the configured header name must be one token. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** Policy naming the trusted serial header and the proxies allowed to send it. */
export interface MtlsClientCertificatePolicy {
  /** Lowercased HTTP header carrying the client certificate serial, or undefined when the deployment serves no client certificates. */
  readonly serialHeader: string | undefined
  /** Exact remote socket addresses (IP literals) whose serial header is trusted; empty disables the feature entirely. */
  readonly trustedProxies: readonly string[]
}

/** Raw `mtls*` Connection configuration fields before validation. */
export interface MtlsClientCertificateConfig {
  /** Header name carrying the client certificate serial as forwarded by the mTLS-terminating proxy; absent means no header is trusted. */
  readonly mtlsClientSerialHeader?: string | undefined
  /** Remote socket addresses of the proxies allowed to send the serial header. */
  readonly mtlsTrustedProxies?: readonly string[] | undefined
}

/**
 * Read one request header from either the Fetch or the node:http
 * representation, matching the lowercase form node:http stores.
 * @param headers - request headers.
 * @param name - lowercase header name.
 * @returns the first header value, or undefined when absent.
 */
function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Normalize one socket address for trusted-proxy comparison: lowercase, with
 * an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`, the form a dual-stack
 * listener reports for an IPv4 peer) reduced to the IPv4 literal.
 * @param address - remote socket address as the carrier reports it.
 * @returns the comparison form, or undefined for a non-string value.
 */
export function normalizeRemoteAddress(address: unknown): string | undefined {
  if (typeof address !== 'string' || address === '') return undefined
  const lowered = address.toLowerCase()
  const mapped = lowered.startsWith('::ffff:') ? lowered.slice('::ffff:'.length) : lowered
  return isIP(mapped) > 0 ? mapped : undefined
}

/**
 * Normalize a certificate serial to its lowercase hexadecimal form. Caddy's
 * `{http.request.tls.client.serial}` placeholder renders the serial as a
 * decimal integer, so a digit-only value is read as decimal and converted;
 * any value containing a hexadecimal letter is already hexadecimal. An
 * `0x` prefix forces the hexadecimal reading either way.
 * @param value - raw header or request-body serial.
 * @returns the lowercase hexadecimal serial, bounded by {@link MAX_CERTIFICATE_SERIAL_HEX_LENGTH} characters, or
 *   undefined for a malformed or oversized value.
 */
export function parseCertificateSerial(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '') return undefined
  const prefixed = trimmed.startsWith('0x')
  const digits = prefixed ? trimmed.slice(2) : trimmed
  if (digits === '' || !/^[0-9a-f]+$/.test(digits)) return undefined
  // A digit-only string is Caddy's decimal rendering; a value containing a
  // hexadecimal letter cannot collide with it, and per-device CA issuance
  // keeps every issued serial non-decimal so the two readings never meet.
  if (!prefixed && !/[a-f]/.test(digits)) {
    // 2^256-1, the largest value the hex bound accepts, has 78 decimal digits.
    if (digits.length > 78) return undefined
    const hex = BigInt(digits).toString(16)
    return hex.length <= MAX_CERTIFICATE_SERIAL_HEX_LENGTH ? hex : undefined
  }
  return digits.length <= MAX_CERTIFICATE_SERIAL_HEX_LENGTH ? digits : undefined
}

/**
 * Resolve and validate the mTLS serial-header policy at the config boundary:
 * a malformed header name or proxy address fails the plugin load loudly
 * instead of silently trusting nothing (or, worse, the wrong thing).
 * @param config - raw `mtls*` configuration fields.
 * @returns the policy with a lowercased header name and normalized proxy addresses.
 * @throws when the header name is not a bare HTTP token, a proxy entry is not an IP literal, or a header is configured
 *   without any trusted proxy.
 */
export function resolveMtlsClientCertificatePolicy(
  config: MtlsClientCertificateConfig,
): MtlsClientCertificatePolicy {
  // cordis.yml delivers this field as raw YAML: a non-string value (number,
  // boolean, list) must fail the load with its own error instead of a bare
  // TypeError from `.trim()`.
  const rawHeader = config.mtlsClientSerialHeader
  if (rawHeader !== undefined && typeof rawHeader !== 'string') {
    throw new Error(`client-connection: mtlsClientSerialHeader ${JSON.stringify(rawHeader)} is not a string`)
  }
  const serialHeader = rawHeader?.trim().toLowerCase()
  if (serialHeader === undefined || serialHeader === '') {
    return { serialHeader: undefined, trustedProxies: [] }
  }
  if (!HEADER_NAME_PATTERN.test(serialHeader)) {
    throw new Error(`client-connection: mtlsClientSerialHeader ${JSON.stringify(config.mtlsClientSerialHeader)} is not a valid HTTP header name`)
  }
  const trustedProxies = (config.mtlsTrustedProxies ?? []).map((entry) => {
    const normalized = normalizeRemoteAddress(entry)
    if (normalized === undefined) {
      throw new Error(`client-connection: mtlsTrustedProxies entry ${JSON.stringify(entry)} is not an IP literal`)
    }
    return normalized
  })
  if (trustedProxies.length === 0) {
    throw new Error(`client-connection: mtlsClientSerialHeader ${JSON.stringify(serialHeader)} requires at least one mtlsTrustedProxies entry`)
  }
  return { serialHeader, trustedProxies }
}

/**
 * Read the remote socket address of a request. Carriers declare it as
 * `remoteAddress`; a node:http `IncomingMessage` passed directly by foreign
 * callers exposes it on its socket instead, and that adapter read keeps the
 * serial check working at every existing call site.
 * @param request - request facts carrying headers and, when available, the remote address.
 * @returns the normalized remote address, or undefined when the carrier reports none.
 */
function requestRemoteAddress(request: ConnectionTrustRequest): string | undefined {
  const declared = normalizeRemoteAddress(
    (request as { remoteAddress?: unknown }).remoteAddress,
  )
  if (declared !== undefined) return declared
  return normalizeRemoteAddress(
    (request as { socket?: { remoteAddress?: unknown } }).socket?.remoteAddress,
  )
}

/**
 * The trusted client-certificate serial of one request, or undefined when the
 * policy is off, the peer is not a configured trusted proxy, or the header is
 * absent or malformed. Only an undefined-from-trusted-path value and a
 * genuinely absent header are indistinguishable here, and both mean "no
 * certificate serial presented", which never authenticates a bound session.
 * @param request - request headers and remote address.
 * @param policy - resolved serial-header policy.
 * @returns the lowercase hexadecimal serial, or undefined.
 */
export function trustedClientCertificateSerial(
  request: ConnectionTrustRequest,
  policy: MtlsClientCertificatePolicy,
): string | undefined {
  if (policy.serialHeader === undefined) return undefined
  if (!policy.trustedProxies.includes(requestRemoteAddress(request) ?? '')) return undefined
  return parseCertificateSerial(header(request.headers, policy.serialHeader))
}
