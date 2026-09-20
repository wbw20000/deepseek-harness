/**
 * The QR encoder: version selection by payload size, the fixed function
 * patterns every symbol carries, mask selection, the version-10 ceiling, and
 * the SVG renderer. Scannability was checked out of band with macOS Vision
 * (see the Phase 2 gate report); these tests pin the structural invariants.
 */
import { describe, expect, it } from 'vitest'
import { encodeQr, qrToSvg, QR_MAX_BYTES } from '../src/client/qr.ts'

/** The finder pattern rows as a 7×7 boolean grid. */
const FINDER = [
  [1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1],
].map(row => row.map(cell => cell === 1))

/** Assert a finder pattern at the given top-left module. */
function expectFinder(modules: readonly (readonly boolean[])[], x: number, y: number): void {
  for (let dy = 0; dy < 7; dy += 1) {
    for (let dx = 0; dx < 7; dx += 1) {
      expect(modules[y + dy]![x + dx]).toBe(FINDER[dy]![dx])
    }
  }
}

describe('encodeQr', () => {
  it('picks the smallest version that fits the payload, from 1 through 10', () => {
    const cases: Array<[number, number]> = [
      [0, 1], [14, 1], [15, 2], [26, 2], [27, 3], [42, 3], [43, 4], [62, 4], [63, 5], [84, 5],
      [85, 6], [106, 6], [107, 7], [122, 7], [123, 8], [152, 8], [153, 9], [180, 9], [181, 10], [213, 10],
    ]
    for (const [bytes, version] of cases) {
      const matrix = encodeQr('a'.repeat(bytes))
      expect(`${String(bytes)}:${String(matrix.version)}`).toBe(`${String(bytes)}:${String(version)}`)
      expect(matrix.size).toBe(version * 4 + 17)
      expect(matrix.modules).toHaveLength(matrix.size)
    }
  })

  it('refuses a payload beyond the version-10 ceiling, counting UTF-8 bytes', () => {
    expect(() => encodeQr('a'.repeat(QR_MAX_BYTES + 1))).toThrow(/exceeds 213 bytes/u)
    // 72 three-byte characters are 216 bytes.
    expect(() => encodeQr('中'.repeat(72))).toThrow(/216 bytes/u)
    expect(encodeQr('中'.repeat(71)).version).toBe(10)
  })

  it('carries the three finder patterns, the timing patterns, and the dark module', () => {
    for (const text of ['x', 'https://phone.localhost:8443/?token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', 'z'.repeat(200)]) {
      const { modules, size } = encodeQr(text)
      expectFinder(modules, 0, 0)
      expectFinder(modules, size - 7, 0)
      expectFinder(modules, 0, size - 7)
      for (let index = 8; index < size - 8; index += 1) {
        expect(modules[6]![index]).toBe(index % 2 === 0)
        expect(modules[index]![6]).toBe(index % 2 === 0)
      }
      expect(modules[size - 8]![8]).toBe(true)
    }
  })

  it('places alignment patterns from version 2 and version information from version 7', () => {
    const v2 = encodeQr('a'.repeat(20))
    expect(v2.version).toBe(2)
    // Alignment centre (18, 18): dark centre, light ring, dark border.
    expect(v2.modules[18]![18]).toBe(true)
    expect(v2.modules[17]![18]).toBe(false)
    expect(v2.modules[16]![18]).toBe(true)
    const v7 = encodeQr('a'.repeat(110))
    expect(v7.version).toBe(7)
    // Version 7's 18-bit version information: 000111110010010100 (bit 17 first),
    // written into the 6×3 block above the bottom-left finder, bit 0 at (0, size-11).
    const bits = 0b000111110010010100
    for (let index = 0; index < 18; index += 1) {
      const dark = ((bits >> index) & 1) === 1
      expect(v7.modules[v7.size - 11 + (index % 3)]![Math.floor(index / 3)]).toBe(dark)
      expect(v7.modules[Math.floor(index / 3)]![v7.size - 11 + (index % 3)]).toBe(dark)
    }
  })

  it('is deterministic and encodes different payloads differently', () => {
    const a = encodeQr('https://dsh.example/?token=one')
    const b = encodeQr('https://dsh.example/?token=one')
    const c = encodeQr('https://dsh.example/?token=two')
    expect(a.modules).toEqual(b.modules)
    expect(a.modules).not.toEqual(c.modules)
  })
})

describe('qrToSvg', () => {
  it('renders one rect per dark module inside a four-module quiet zone', () => {
    const matrix = encodeQr('svg')
    const svg = qrToSvg(matrix, 2)
    const total = (matrix.size + 8) * 2
    expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(total)} ${String(total)}"`)).toBe(true)
    const darkCount = matrix.modules.flat().filter(Boolean).length
    expect(svg.match(/<rect x=/gu)).toHaveLength(darkCount)
    // The first dark module is the finder's top-left corner, offset by the quiet zone.
    expect(svg).toContain('<rect x="8" y="8" width="2" height="2"/>')
    expect(qrToSvg(matrix)).toContain('width="4" height="4"')
  })
})
