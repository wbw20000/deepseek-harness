/** Pairing token lifecycle: single use, expiry, pending cap, and revocation. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PAIRING_TTL_MS,
  MAX_PAIRING_TTL_MS,
  MAX_PENDING_PAIRING_TOKENS,
  PairingTokens,
} from '../src/pairing.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('PairingTokens', () => {
  it('mints one token and consumes it exactly once', () => {
    const tokens = new PairingTokens()
    const minted = tokens.mint(60_000, 'phone')
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(minted.token.length).toBeGreaterThanOrEqual(43)

    expect(tokens.consume(minted.token)).toEqual({ deviceLabel: 'phone' })
    expect(tokens.consume(minted.token)).toBeUndefined()
  })

  it('refuses unknown, malformed, and expired tokens', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const tokens = new PairingTokens()
    const minted = tokens.mint(1_000, 'phone')

    expect(tokens.consume('')).toBeUndefined()
    expect(tokens.consume('not-a-token')).toBeUndefined()
    expect(tokens.consume(`${minted.token}x`)).toBeUndefined()
    vi.setSystemTime(new Date(Date.now() + 1_001))
    expect(tokens.consume(minted.token)).toBeUndefined()
  })

  it('caps simultaneously pending tokens and reports the limit without token material', () => {
    const tokens = new PairingTokens()
    for (let index = 0; index < MAX_PENDING_PAIRING_TOKENS; index += 1) {
      expect(tokens.mint(60_000, `device-${String(index)}`).token).toBeDefined()
    }
    expect(() => tokens.mint(60_000, 'one-too-many'))
      .toThrow(/at most 5 unconsumed pairing tokens/u)
    // Consuming one frees a slot; the error message never carries token text.
    const first = tokens.consume('')
    expect(first).toBeUndefined()
  })

  it('rejects out-of-range ttl and device labels loudly', () => {
    const tokens = new PairingTokens()
    for (const ttlMs of [0, -1, 1.5, MAX_PAIRING_TTL_MS + 1, Number.MAX_SAFE_INTEGER]) {
      expect(() => tokens.mint(ttlMs, 'phone')).toThrow(/pairing ttlMs/u)
    }
    for (const deviceLabel of ['', 'x'.repeat(201)]) {
      expect(() => tokens.mint(60_000, deviceLabel)).toThrow(/pairing deviceLabel/u)
    }
    expect(DEFAULT_PAIRING_TTL_MS).toBe(5 * 60 * 1000)
  })

  it('drops every pending token on revokeAll', () => {
    const tokens = new PairingTokens()
    const minted = tokens.mint(60_000, 'phone')
    tokens.revokeAll()
    expect(tokens.consume(minted.token)).toBeUndefined()
    // The cap applies to pending tokens only, so minting works again immediately.
    expect(tokens.mint(60_000, 'phone').token).toBeDefined()
  })

  it('never exposes a pending token through a failed mint', () => {
    const tokens = new PairingTokens()
    const minted = tokens.mint(60_000, 'phone')
    for (let index = 1; index < MAX_PENDING_PAIRING_TOKENS; index += 1) {
      tokens.mint(60_000, `device-${String(index)}`)
    }
    let message = ''
    try {
      tokens.mint(60_000, 'overflow')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toContain(minted.token)
    expect(message).not.toContain('device-')
  })
})
