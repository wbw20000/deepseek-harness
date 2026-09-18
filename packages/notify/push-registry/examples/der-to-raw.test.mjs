// Fixed-vector unit tests for the DER-to-raw ES256 signature conversion.
// Run: node --test packages/notify/push-registry/examples/*.test.mjs

import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { derSignatureToRaw } from './der-to-raw.mjs'

/** Encode one hex value as a DER INTEGER with its leading 0x00 when needed. */
function derInteger(hex) {
  const value = Buffer.from(hex, 'hex')
  const content = (value[0] & 0x80) !== 0 ? Buffer.concat([Buffer.from([0x00]), value]) : value
  return Buffer.concat([Buffer.from([0x02, content.length]), content])
}

/** Wrap INTEGER parts into the DER SEQUENCE an ECDSA signature uses. */
function derSignature(...integers) {
  const content = Buffer.concat(integers)
  return Buffer.concat([Buffer.from([0x30, content.length]), content])
}

const R_PADDED = 'ff'.repeat(32) // top bit set -> DER carries the 0x00 pad byte
const S_PADDED = '80'.repeat(32)
const R_UNPADDED = '7f'.repeat(32)
const S_UNPADDED = '01'.repeat(32)

test('converts the four padded/unpadded r and s combinations', () => {
  const vectors = [
    { r: R_PADDED, s: S_PADDED, raw: R_PADDED + S_PADDED },
    { r: R_PADDED, s: S_UNPADDED, raw: R_PADDED + S_UNPADDED },
    { r: R_UNPADDED, s: S_PADDED, raw: R_UNPADDED + S_PADDED },
    { r: R_UNPADDED, s: S_UNPADDED, raw: R_UNPADDED + S_UNPADDED },
  ]
  for (const { r, s, raw } of vectors) {
    assert.ok(derSignatureToRaw(derSignature(derInteger(r), derInteger(s))).equals(Buffer.from(raw, "hex")))
  }
})

test('left-pads a half whose DER value is shorter than 32 bytes', () => {
  const der = derSignature(derInteger('01'), derInteger('00'))
  assert.ok(derSignatureToRaw(der).equals(Buffer.concat([Buffer.alloc(31, 0), Buffer.from([0x01]), Buffer.alloc(32, 0)])))
})

test('rejects a truncated or non-signature DER input', () => {
  assert.throws(() => derSignatureToRaw(Buffer.from([0x30, 0x10, 0x02])), /truncated/)
  assert.throws(() => derSignatureToRaw(Buffer.from([0x31, 0x00])), /SEQUENCE/)
})

test('round-trips a real node:crypto ES256 signature through the raw form', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const der = createSign('sha256').update('round-trip payload').sign(privateKey)
  const raw = derSignatureToRaw(der)
  assert.equal(raw.length, 64)

  // Re-encode each raw half as a minimal DER INTEGER: the crypto-generated
  // signature is minimal, so the reconstruction must equal the input byte for byte.
  const toDerInteger = (half) => {
    let start = 0
    while (start < 31 && half[start] === 0) start++
    const content = (half[start] & 0x80) !== 0
      ? Buffer.concat([Buffer.from([0x00]), half.subarray(start)])
      : half.subarray(start)
    return Buffer.concat([Buffer.from([0x02, content.length]), content])
  }
  const content = Buffer.concat([toDerInteger(raw.subarray(0, 32)), toDerInteger(raw.subarray(32))])
  assert.ok(Buffer.concat([Buffer.from([0x30, content.length]), content]).equals(der))
})
