// Pure DER-to-raw conversion for ES256 JWT signatures, importable so the
// conversion can be pinned by fixed-vector unit tests (der-to-raw.test.mjs).

/** Byte length of one raw ECDSA P-256 signature half. */
const RAW_INTEGER_BYTES = 32

/**
 * Read one DER TLV starting at `offset`.
 * @param {Buffer} der - buffer holding the DER structure.
 * @param {number} offset - offset of the tag byte.
 * @returns {{ tag: number, value: Buffer, end: number }} tag, value bytes, and
 *   the offset just past the value.
 */
function readDerValue(der, offset) {
  const tag = der[offset]
  if (tag === undefined) throw new Error(`der signature: no tag at offset ${offset}`)
  let length = der[offset + 1]
  if (length === undefined) throw new Error('der signature: truncated length')
  let headerBytes = 2
  if (length & 0x80) {
    const lengthBytes = length & 0x7f
    if (lengthBytes === 0) throw new Error('der signature: reserved indefinite length')
    length = 0
    for (let i = 0; i < lengthBytes; i++) length = length * 0x100 + der[offset + 2 + i]
    headerBytes = 2 + lengthBytes
  }
  const end = offset + headerBytes + length
  if (der.length < end) throw new Error('der signature: truncated value')
  return { tag, value: der.subarray(offset + headerBytes, end), end }
}

/**
 * Convert an ASN.1 DER ECDSA signature to the 64-byte raw `r || s` form the
 * ES256 JWT signature uses. DER INTEGER values carry a leading `0x00` when the
 * top bit is set and strip leading zeros otherwise, so each half is taken as
 * the last 32 bytes of its value and left-padded when shorter.
 * @param {Buffer} der - DER signature: `SEQUENCE { INTEGER r, INTEGER s }`.
 * @returns {Buffer} the 64-byte `r || s` signature.
 */
export function derSignatureToRaw(der) {
  const sequence = readDerValue(der, 0)
  if (sequence.tag !== 0x30) throw new Error(`der signature: expected SEQUENCE, got 0x${sequence.tag.toString(16)}`)
  const r = readInteger(sequence.value, 0)
  const s = readInteger(sequence.value, r.end)
  if (s.end !== sequence.value.length) throw new Error('der signature: trailing bytes after s')
  return Buffer.concat([rawInteger(r.value), rawInteger(s.value)])
}

/** Read one INTEGER TLV and return its value bytes plus end offset. */
function readInteger(value, offset) {
  const tlv = readDerValue(value, offset)
  if (tlv.tag !== 0x02) throw new Error(`der signature: expected INTEGER, got 0x${tlv.tag.toString(16)}`)
  return { value: tlv.value, end: tlv.end }
}

/** Reduce one INTEGER value to exactly 32 bytes: last 32, left-padded. */
function rawInteger(value) {
  const trimmed = value.length > RAW_INTEGER_BYTES ? value.subarray(value.length - RAW_INTEGER_BYTES) : value
  if (trimmed.length === RAW_INTEGER_BYTES) return Buffer.from(trimmed)
  return Buffer.concat([Buffer.alloc(RAW_INTEGER_BYTES - trimmed.length, 0), trimmed])
}
