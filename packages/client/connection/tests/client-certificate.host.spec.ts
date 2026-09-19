/** Client-certificate serial policy: header parsing, proxy trust, and config validation. */

import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import type { ConnectionTrustRequest } from '../src/rpc.ts'
import {
  MAX_CERTIFICATE_SERIAL_HEX_LENGTH,
  normalizeRemoteAddress,
  parseCertificateSerial,
  resolveMtlsClientCertificatePolicy,
  trustedClientCertificateSerial,
} from '../src/client-certificate.ts'

describe('parseCertificateSerial', () => {
  it('normalizes hexadecimal serials to lowercase', () => {
    expect(parseCertificateSerial('1A2B3C')).toBe('1a2b3c')
    expect(parseCertificateSerial(' 0xABCDEF ')).toBe('abcdef')
    expect(parseCertificateSerial('0')).toBe('0')
  })

  it('reads a digit-only serial as the decimal form Caddy forwards', () => {
    expect(parseCertificateSerial('123')).toBe('7b')
    expect(parseCertificateSerial('0123')).toBe('7b')
    expect(parseCertificateSerial('439897037')).toBe('1a384bcd')
  })

  it('rejects non-strings, empty, and malformed values', () => {
    for (const invalid of [undefined, null, 42, '', '0x', 'g0', '12 34', '-5', '0xg1']) {
      expect(parseCertificateSerial(invalid)).toBeUndefined()
    }
  })

  it('enforces the hexadecimal length bound in both notations', () => {
    const widest = 'f'.repeat(MAX_CERTIFICATE_SERIAL_HEX_LENGTH)
    expect(parseCertificateSerial(widest)).toBe(widest)
    expect(parseCertificateSerial(`1${widest}`)).toBeUndefined()
    // 2^256-1 has 78 decimal digits; one more decimal digit overflows the bound.
    expect(parseCertificateSerial(BigInt(`0x${widest}`).toString())).toBe(widest)
    // A 78-digit decimal above 2^256 converts to 65 hexadecimal characters.
    expect(parseCertificateSerial('9'.repeat(78))).toBeUndefined()
    expect(parseCertificateSerial('9'.repeat(79))).toBeUndefined()
  })
})

describe('resolveMtlsClientCertificatePolicy', () => {
  it('disables the feature when no header is configured', () => {
    expect(resolveMtlsClientCertificatePolicy({})).toEqual({
      serialHeader: undefined,
      trustedProxies: [],
    })
    expect(resolveMtlsClientCertificatePolicy({ mtlsTrustedProxies: ['127.0.0.1'] })).toEqual({
      serialHeader: undefined,
      trustedProxies: [],
    })
  })

  it('lowercases and trims the header name and normalizes proxy addresses', () => {
    expect(resolveMtlsClientCertificatePolicy({
      mtlsClientSerialHeader: ' X-DSH-Client-Serial ',
      mtlsTrustedProxies: ['127.0.0.1', '::FFFF:127.0.0.2'],
    })).toEqual({
      serialHeader: 'x-dsh-client-serial',
      trustedProxies: ['127.0.0.1', '127.0.0.2'],
    })
  })

  it('fails the load loudly on a malformed header name, proxy address, or a header without proxies', () => {
    expect(() => resolveMtlsClientCertificatePolicy({
      mtlsClientSerialHeader: 'two headers',
      mtlsTrustedProxies: ['127.0.0.1'],
    })).toThrow(/not a valid HTTP header name/u)
    expect(() => resolveMtlsClientCertificatePolicy({
      mtlsClientSerialHeader: 'x-dsh-client-serial',
    })).toThrow(/requires at least one mtlsTrustedProxies entry/u)
    expect(() => resolveMtlsClientCertificatePolicy({
      mtlsClientSerialHeader: 'x-dsh-client-serial',
      mtlsTrustedProxies: ['localhost'],
    })).toThrow(/is not an IP literal/u)
  })

  it('rejects a non-string header value from raw YAML with a clean error', () => {
    for (const raw of [42, true, ['X-DSH-Client-Serial']]) {
      expect(() => resolveMtlsClientCertificatePolicy({
        // cordis.yml delivers the declared-string field verbatim; the resolver
        // must fail loudly instead of throwing a bare TypeError on `.trim()`.
        mtlsClientSerialHeader: raw as unknown as string,
        mtlsTrustedProxies: ['127.0.0.1'],
      })).toThrow(/is not a string/u)
    }
  })
})

describe('Config schema passthrough', () => {
  it('keeps the runtime-only mtlsClientSerialHeader after schema resolution', () => {
    // The field is deliberately absent from the exported Config schema (the
    // vendored schema language has no optional-string node), so it must
    // survive resolution as an unknown key for resolve-apply to read.
    const resolved = Config({
      mtlsClientSerialHeader: 'X-DSH-Client-Serial',
      mtlsTrustedProxies: ['127.0.0.1'],
    })
    expect(resolved.mtlsClientSerialHeader).toBe('X-DSH-Client-Serial')
    expect(resolved.mtlsTrustedProxies).toEqual(['127.0.0.1'])
  })
})

describe('trustedClientCertificateSerial', () => {
  const policy = resolveMtlsClientCertificatePolicy({
    mtlsClientSerialHeader: 'x-dsh-client-serial',
    mtlsTrustedProxies: ['127.0.0.1'],
  })

  it('reads the declared remote address and the node:http socket fallback', () => {
    expect(trustedClientCertificateSerial({
      headers: { 'x-dsh-client-serial': '439897037' },
      remoteAddress: '127.0.0.1',
    }, policy)).toBe('1a384bcd')
    // A node:http IncomingMessage passed directly by existing callers exposes
    // the peer address on its socket; the cast mirrors that structural carrier.
    const socketRequest = (remoteAddress: string): ConnectionTrustRequest =>
      ({ headers: { 'x-dsh-client-serial': '439897037' }, socket: { remoteAddress } }) as ConnectionTrustRequest
    expect(trustedClientCertificateSerial(socketRequest('127.0.0.1'), policy)).toBe('1a384bcd')
    // An IPv4-mapped IPv6 peer is the same physical proxy as its IPv4 literal.
    expect(trustedClientCertificateSerial(socketRequest('::ffff:127.0.0.1'), policy)).toBe('1a384bcd')
  })

  it('ignores the header from any untrusted or unknown peer', () => {
    for (const request of [
      { headers: { 'x-dsh-client-serial': '439897037' }, remoteAddress: '192.168.1.5' },
      { headers: { 'x-dsh-client-serial': '439897037' }, socket: { remoteAddress: '::1' } },
      { headers: { 'x-dsh-client-serial': '439897037' } },
    ] as unknown as ConnectionTrustRequest[]) {
      expect(trustedClientCertificateSerial(request, policy)).toBeUndefined()
    }
  })

  it('treats an absent or malformed serial from a trusted proxy as none presented', () => {
    expect(trustedClientCertificateSerial({
      headers: {},
      remoteAddress: '127.0.0.1',
    }, policy)).toBeUndefined()
    expect(trustedClientCertificateSerial({
      headers: { 'x-dsh-client-serial': 'not-a-serial' },
      remoteAddress: '127.0.0.1',
    }, policy)).toBeUndefined()
  })

  it('never reads the header while the policy is disabled', () => {
    expect(trustedClientCertificateSerial({
      headers: { 'x-dsh-client-serial': '439897037' },
      remoteAddress: '127.0.0.1',
    }, resolveMtlsClientCertificatePolicy({}))).toBeUndefined()
  })

  it('reads Fetch-style Headers instances and rejects unusable remote addresses', () => {
    expect(trustedClientCertificateSerial({
      headers: new Headers({ 'x-dsh-client-serial': '1a2b3c4d' }),
      remoteAddress: '127.0.0.1',
    }, policy)).toBe('1a2b3c4d')
    // A trusted proxy presenting no serial header at all.
    expect(trustedClientCertificateSerial({
      headers: new Headers({ host: 'localhost' }),
      remoteAddress: '127.0.0.1',
    }, policy)).toBeUndefined()
    for (const unusable of [undefined, '', 'node-1', '::ffff:not-an-ip']) {
      expect(normalizeRemoteAddress(unusable)).toBeUndefined()
    }
  })
})
