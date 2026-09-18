/** Cookie- and URL-safe base64url text and constant-time token comparison. */

import { timingSafeEqual } from 'node:crypto'

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

/**
 * Encode bytes as unpadded base64url, the cookie- and URL-safe text form used
 * for tokens, cookie payloads, and signatures.
 * @param value - raw bytes.
 * @returns the unpadded base64url text.
 */
export function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

/**
 * Decode unpadded base64url text, refusing padding, foreign characters, and
 * non-canonical re-encodings.
 * @param value - candidate base64url text.
 * @returns the decoded bytes, or undefined when the text is malformed.
 */
export function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

/**
 * Compare two token strings without leaking the length of their common prefix.
 * @param actual - the presented value.
 * @param expected - the known value.
 * @returns true only for byte-identical strings.
 */
export function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}
