/** One-shot pairing tokens for minting device login URLs on demand. */

import { randomBytes } from 'node:crypto'
import { encodeBase64Url, tokenMatches } from './token-encoding.ts'

/** Entropy of one minted pairing token; at least 32 bytes as required for pairing secrets. */
const TOKEN_BYTES = 32

/** Upper bound on simultaneously pending (minted but unconsumed) pairing tokens. */
export const MAX_PENDING_PAIRING_TOKENS = 5

/** Upper bound for one pairing token's time to live. */
export const MAX_PAIRING_TTL_MS = 10 * 60 * 1000

/** Default time to live for `connection.pairing.mint` when no `ttlMs` is sent. */
export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000

/** Upper bound for a caller-supplied device label. */
export const MAX_PAIRING_DEVICE_LABEL_LENGTH = 200

/** One minted, not-yet-consumed pairing token and its absolute expiry. */
export interface MintedPairingToken {
  /** Unpadded base64url secret carried as the root URL's `?token=` value. */
  readonly token: string
  /** Absolute Unix-millisecond expiry, also the token's latest consumption time. */
  readonly expiresAt: number
}

function assertTtlMs(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_PAIRING_TTL_MS) {
    throw new Error(
      `connection: pairing ttlMs must be a safe integer between 1 and ${String(MAX_PAIRING_TTL_MS)}`,
    )
  }
}

function assertDeviceLabel(deviceLabel: string): void {
  if (typeof deviceLabel !== 'string' || deviceLabel.length === 0
    || deviceLabel.length > MAX_PAIRING_DEVICE_LABEL_LENGTH) {
    throw new Error(
      `connection: pairing deviceLabel must be a non-empty string of at most ${String(MAX_PAIRING_DEVICE_LABEL_LENGTH)} characters`,
    )
  }
}

/**
 * Registry of single-use pairing tokens. A minted token is consumed by exactly
 * one token exchange and never leaves the process except inside its login URL;
 * pending tokens stay in memory only and vanish when the process restarts.
 */
export class PairingTokens {
  private readonly pending = new Map<string, { readonly deviceLabel: string; readonly expiresAt: number }>()

  /**
   * Mint one single-use pairing token.
   * @param ttlMs - time to live between 1 ms and {@link MAX_PAIRING_TTL_MS}.
   * @param deviceLabel - label recorded for the session issued at consumption.
   * @returns the token and its absolute expiry.
   * @throws when the arguments are out of range or
   * {@link MAX_PENDING_PAIRING_TOKENS} unconsumed tokens already exist.
   */
  mint(ttlMs: number, deviceLabel: string): MintedPairingToken {
    assertTtlMs(ttlMs)
    assertDeviceLabel(deviceLabel)
    this.prune(Date.now())
    if (this.pending.size >= MAX_PENDING_PAIRING_TOKENS) {
      throw new Error(
        `connection: at most ${String(MAX_PENDING_PAIRING_TOKENS)} unconsumed pairing tokens `
        + 'may exist; consume one or call revokeAll first',
      )
    }
    const token = encodeBase64Url(randomBytes(TOKEN_BYTES))
    const expiresAt = Date.now() + ttlMs
    this.pending.set(token, { deviceLabel, expiresAt })
    return { token, expiresAt }
  }

  /**
   * Consume one pending token. Comparisons run in constant time per pending
   * token, and the pending set is bounded, so a wrong token reveals neither a
   * prefix nor the size of the pending set through timing.
   * @param token - the presented `?token=` value.
   * @returns the mint-time device label, or undefined for an unknown, expired,
   * or already consumed token.
   */
  consume(token: string): { readonly deviceLabel: string } | undefined {
    if (typeof token !== 'string' || token.length === 0) return undefined
    this.prune(Date.now())
    const candidate = Buffer.from(token, 'utf8')
    for (const [known, entry] of this.pending) {
      const knownBytes = Buffer.from(known, 'utf8')
      if (knownBytes.byteLength === candidate.byteLength && tokenMatches(token, known)) {
        this.pending.delete(known)
        return { deviceLabel: entry.deviceLabel }
      }
    }
    return undefined
  }

  /** Discard every pending token; consumption after this call fails. */
  revokeAll(): void {
    this.pending.clear()
  }

  /** Drop tokens whose expiry has passed; expired tokens are never consumable. */
  private prune(now: number): void {
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(token)
    }
  }
}
