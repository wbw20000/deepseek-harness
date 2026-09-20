/**
 * A small QR Code encoder for the pairing link: byte mode, error correction
 * level M, versions 1–10 (up to 213 bytes), automatic mask selection. It
 * exists because the pairing settings section must render a scannable code
 * without a network dependency; the output is a module matrix, rendered by
 * the caller as SVG. The construction follows ISO/IEC 18004: mode and count
 * indicators, terminator and pad bytes, Reed–Solomon blocks interleaved,
 * function patterns, format and version information, and the eight masks
 * scored by the four penalty rules.
 */

/** Per-version byte-mode capacity and block structure at level M. */
interface VersionSpec {
  /** Total codewords in the symbol. */
  readonly totalCodewords: number
  /** Error-correction codewords per block. */
  readonly ecPerBlock: number
  /** Data codewords of each block, in interleaving order (shorter blocks first). */
  readonly blocks: readonly number[]
  /** Alignment pattern centre coordinates (both axes), excluding finder overlaps handled at placement. */
  readonly alignment: readonly number[]
}

/** Versions 1–10 at error-correction level M (ISO/IEC 18004 table 9). */
const VERSIONS: readonly VersionSpec[] = [
  { totalCodewords: 26, ecPerBlock: 10, blocks: [16], alignment: [] },
  { totalCodewords: 44, ecPerBlock: 16, blocks: [28], alignment: [6, 18] },
  { totalCodewords: 70, ecPerBlock: 26, blocks: [44], alignment: [6, 22] },
  { totalCodewords: 100, ecPerBlock: 18, blocks: [32, 32], alignment: [6, 26] },
  { totalCodewords: 134, ecPerBlock: 24, blocks: [43, 43], alignment: [6, 30] },
  { totalCodewords: 172, ecPerBlock: 16, blocks: [27, 27, 27, 27], alignment: [6, 34] },
  { totalCodewords: 196, ecPerBlock: 18, blocks: [31, 31, 31, 31], alignment: [6, 22, 38] },
  { totalCodewords: 242, ecPerBlock: 22, blocks: [38, 38, 39, 39], alignment: [6, 24, 42] },
  { totalCodewords: 292, ecPerBlock: 22, blocks: [36, 36, 36, 37, 37], alignment: [6, 26, 46] },
  { totalCodewords: 346, ecPerBlock: 26, blocks: [43, 43, 43, 43, 44], alignment: [6, 28, 50] },
]

/** Largest byte payload this encoder accepts (version 10, level M). */
export const QR_MAX_BYTES = 213

/** One encoded symbol: `modules[y][x]` is `true` for a dark module. */
export interface QrMatrix {
  readonly size: number
  readonly version: number
  readonly modules: readonly (readonly boolean[])[]
}

/**
 * Read one entry the construction guarantees to exist: every table is built
 * in full before any lookup and every index below is derived from the table
 * sizes, so the optional index type never materialises.
 * @param table - the table.
 * @param index - the index.
 * @returns the entry.
 */
function entry<T>(table: ArrayLike<T>, index: number): T {
  const value = table[index]
  /* v8 ignore next -- indices are derived from the tables' own sizes; the guard only answers the optional index type. */
  if (value === undefined) throw new RangeError(`qr: index ${String(index)} out of range`)
  return value
}

// ---- GF(256) arithmetic for Reed–Solomon (primitive polynomial 0x11d) ----

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let value = 1
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value
    LOG[value] = index
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = entry(EXP, index - 255)
}

/**
 * Multiply two field elements.
 * @param left - first factor.
 * @param right - second factor.
 * @returns the product in GF(256).
 */
function multiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0
  return entry(EXP, entry(LOG, left) + entry(LOG, right))
}

/**
 * The Reed–Solomon generator polynomial coefficients for `degree` EC codewords.
 * @param degree - number of error-correction codewords.
 * @returns coefficients, highest degree first, leading 1 included.
 */
function generatorPolynomial(degree: number): number[] {
  let poly = [1]
  for (let index = 0; index < degree; index += 1) {
    const next = new Array<number>(poly.length + 1).fill(0)
    poly.forEach((coefficient, at) => {
      next[at] = entry(next, at) ^ coefficient
      next[at + 1] = entry(next, at + 1) ^ multiply(coefficient, entry(EXP, index))
    })
    poly = next
  }
  return poly
}

/**
 * Compute the error-correction codewords of one data block.
 * @param data - the block's data codewords.
 * @param degree - number of EC codewords to produce.
 * @returns the EC codewords.
 */
function errorCorrection(data: readonly number[], degree: number): number[] {
  const generator = generatorPolynomial(degree)
  const remainder = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ entry(remainder, 0)
    remainder.shift()
    remainder.push(0)
    for (let index = 0; index < degree; index += 1) {
      remainder[index] = entry(remainder, index) ^ multiply(entry(generator, index + 1), factor)
    }
  }
  return remainder
}

// ---- bit assembly ----

/**
 * Encode the payload as the version's full codeword sequence: mode, count,
 * data, terminator, pad bytes, then the interleaved EC blocks.
 * @param bytes - the payload.
 * @param version - the chosen symbol version (1-based).
 * @returns the codewords in placement order.
 */
function codewords(bytes: Uint8Array, version: number): number[] {
  const spec = entry(VERSIONS, version - 1)
  const dataCodewords = spec.blocks.reduce((sum, count) => sum + count, 0)
  const bits: number[] = []
  const push = (value: number, width: number): void => {
    for (let shift = width - 1; shift >= 0; shift -= 1) bits.push((value >> shift) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, version >= 10 ? 16 : 8)
  for (const byte of bytes) push(byte, 8)
  // Mode (4) + count (8 or 16) + 8 bits per byte leaves exactly four bits
  // below the capacity at the largest payload each version accepts, so the
  // full four-bit terminator always fits and the stream ends byte-aligned.
  push(0, 4)
  const data: number[] = []
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0
    for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | entry(bits, index + bit)
    data.push(byte)
  }
  for (let pad = 0xec; data.length < dataCodewords; pad ^= 0xec ^ 0x11) data.push(pad)
  const dataBlocks: number[][] = []
  const ecBlocks: number[][] = []
  let offset = 0
  for (const count of spec.blocks) {
    const block = data.slice(offset, offset + count)
    offset += count
    dataBlocks.push(block)
    ecBlocks.push(errorCorrection(block, spec.ecPerBlock))
  }
  const out: number[] = []
  const longest = Math.max(...spec.blocks)
  for (let index = 0; index < longest; index += 1) {
    for (const block of dataBlocks) if (index < block.length) out.push(entry(block, index))
  }
  for (let index = 0; index < spec.ecPerBlock; index += 1) {
    for (const block of ecBlocks) out.push(entry(block, index))
  }
  return out
}

// ---- matrix construction ----

/** Mutable symbol under construction: module colour plus a "function pattern" mask. */
interface Canvas {
  readonly size: number
  readonly modules: boolean[][]
  readonly reserved: boolean[][]
}

/**
 * Paint one module and mark it as a function pattern.
 * @param canvas - the symbol.
 * @param x - column.
 * @param y - row.
 * @param dark - module colour.
 */
function setFunction(canvas: Canvas, x: number, y: number, dark: boolean): void {
  entry(canvas.modules, y)[x] = dark
  entry(canvas.reserved, y)[x] = true
}

/**
 * Draw the finder pattern with its separator whose top-left corner is at (x, y).
 * @param canvas - the symbol.
 * @param x - column of the pattern's top-left module.
 * @param y - row of the pattern's top-left module.
 */
function drawFinder(canvas: Canvas, x: number, y: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const px = x + dx
      const py = y + dy
      if (px < 0 || py < 0 || px >= canvas.size || py >= canvas.size) continue
      const distance = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
      setFunction(canvas, px, py, distance !== 2 && distance !== 4)
    }
  }
}

/**
 * Draw one alignment pattern centred at (cx, cy).
 * @param canvas - the symbol.
 * @param cx - centre column.
 * @param cy - centre row.
 */
function drawAlignment(canvas: Canvas, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setFunction(canvas, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
}

/**
 * The 15-bit format information for level M and a mask: BCH(15,5) code XOR 0x5412.
 * @param mask - mask pattern number 0–7.
 * @returns the 15 format bits as an integer, bit 14 first.
 */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask
  let remainder = data << 10
  for (let shift = 14; shift >= 10; shift -= 1) {
    if (remainder & (1 << shift)) remainder ^= 0x537 << (shift - 10)
  }
  return ((data << 10) | remainder) ^ 0x5412
}

/**
 * The 18-bit version information for versions 7 and up: BCH(18,6).
 * @param version - symbol version.
 * @returns the 18 version bits as an integer, bit 17 first.
 */
function versionBits(version: number): number {
  let remainder = version << 12
  for (let shift = 17; shift >= 12; shift -= 1) {
    if (remainder & (1 << shift)) remainder ^= 0x1f25 << (shift - 12)
  }
  return (version << 12) | remainder
}

/**
 * Whether the mask pattern inverts the module at (x, y).
 * @param mask - mask pattern number 0–7.
 * @param x - column.
 * @param y - row.
 * @returns `true` when the module is inverted by this mask.
 */
function masked(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

/**
 * Write the format information into both of its reserved areas.
 * @param canvas - the symbol.
 * @param mask - the applied mask pattern number.
 */
function drawFormat(canvas: Canvas, mask: number): void {
  const bits = formatBits(mask)
  const size = canvas.size
  const bit = (index: number): boolean => ((bits >> index) & 1) === 1
  // Around the top-left finder: bits 14..0 along the top row / left column.
  for (let index = 0; index <= 5; index += 1) setFunction(canvas, 8, index, bit(index))
  setFunction(canvas, 8, 7, bit(6))
  setFunction(canvas, 8, 8, bit(7))
  setFunction(canvas, 7, 8, bit(8))
  for (let index = 9; index < 15; index += 1) setFunction(canvas, 14 - index, 8, bit(index))
  // Second copy: bottom-left column and top-right row.
  for (let index = 0; index < 8; index += 1) setFunction(canvas, size - 1 - index, 8, bit(index))
  for (let index = 8; index < 15; index += 1) setFunction(canvas, 8, size - 15 + index, bit(index))
  // The dark module.
  setFunction(canvas, 8, size - 8, true)
}

/**
 * Write the version information blocks for versions 7 and up.
 * @param canvas - the symbol.
 * @param version - symbol version.
 */
function drawVersion(canvas: Canvas, version: number): void {
  const bits = versionBits(version)
  const size = canvas.size
  for (let index = 0; index < 18; index += 1) {
    const dark = ((bits >> index) & 1) === 1
    const major = Math.floor(index / 3)
    const minor = index % 3
    setFunction(canvas, major, size - 11 + minor, dark)
    setFunction(canvas, size - 11 + minor, major, dark)
  }
}

/**
 * Lay out the function patterns of a blank symbol: finders, separators,
 * timing patterns, alignment patterns, the dark module, and placeholders for
 * the format and version areas so data placement skips them.
 * @param version - symbol version.
 * @returns the prepared canvas.
 */
function prepareCanvas(version: number): Canvas {
  const size = version * 4 + 17
  const canvas: Canvas = {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  }
  drawFinder(canvas, 0, 0)
  drawFinder(canvas, size - 7, 0)
  drawFinder(canvas, 0, size - 7)
  for (let index = 8; index < size - 8; index += 1) {
    setFunction(canvas, index, 6, index % 2 === 0)
    setFunction(canvas, 6, index, index % 2 === 0)
  }
  const centres = entry(VERSIONS, version - 1).alignment
  for (const cy of centres) {
    for (const cx of centres) {
      const onFinder = (cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9)
      if (!onFinder) drawAlignment(canvas, cx, cy)
    }
  }
  drawFormat(canvas, 0)
  if (version >= 7) drawVersion(canvas, version)
  return canvas
}

/**
 * Place the codewords in the zigzag order, applying the mask to data modules.
 * @param canvas - a prepared canvas.
 * @param data - the codewords in placement order.
 * @param mask - mask pattern number 0–7.
 * @returns the module matrix.
 */
function placeData(canvas: Canvas, data: readonly number[], mask: number): boolean[][] {
  const size = canvas.size
  const modules = canvas.modules.map(row => [...row])
  let bitIndex = 0
  const totalBits = data.length * 8
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vertical : vertical
        if (entry(entry(canvas.reserved, y), x)) continue
        let dark = false
        if (bitIndex < totalBits) {
          dark = ((entry(data, bitIndex >> 3) >> (7 - (bitIndex & 7))) & 1) === 1
          bitIndex += 1
        }
        if (masked(mask, x, y)) dark = !dark
        entry(modules, y)[x] = dark
      }
    }
  }
  return modules
}

/**
 * Score a finished symbol by the four penalty rules; lower is better.
 * @param modules - the module matrix.
 * @returns the penalty score.
 */
function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length
  let score = 0
  const runPenalty = (line: readonly boolean[]): number => {
    let total = 0
    let run = 1
    for (let index = 1; index <= line.length; index += 1) {
      if (index < line.length && line[index] === line[index - 1]) {
        run += 1
        continue
      }
      if (run >= 5) total += run - 2
      run = 1
    }
    return total
  }
  const finderLike = (line: readonly boolean[]): number => {
    let total = 0
    const pattern = [true, false, true, true, true, false, true]
    for (let start = 0; start + 7 <= line.length; start += 1) {
      let matches = true
      for (let index = 0; index < 7; index += 1) {
        if (line[start + index] !== pattern[index]) { matches = false; break }
      }
      if (!matches) continue
      const lightBefore = start >= 4 && line.slice(start - 4, start).every(module => !module)
      const lightAfter = start + 11 <= line.length && line.slice(start + 7, start + 11).every(module => !module)
      if (lightBefore || lightAfter) total += 40
    }
    return total
  }
  const columns = Array.from({ length: size }, (_, x) => modules.map(row => entry(row, x)))
  for (let index = 0; index < size; index += 1) {
    score += runPenalty(entry(modules, index)) + runPenalty(entry(columns, index))
    score += finderLike(entry(modules, index)) + finderLike(entry(columns, index))
  }
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const row = entry(modules, y)
      const below = entry(modules, y + 1)
      const value = entry(row, x)
      if (entry(row, x + 1) === value && entry(below, x) === value && entry(below, x + 1) === value) score += 3
    }
  }
  let darkCount = 0
  for (const row of modules) for (const module of row) if (module) darkCount += 1
  const ratio = (darkCount * 100) / (size * size)
  const deviation = Math.floor(Math.abs(ratio - 50) / 5)
  score += deviation * 10
  return score
}

/**
 * Encode a string (UTF-8) as a QR Code at level M, choosing the smallest
 * version that fits and the mask with the lowest penalty.
 * @param text - the payload; at most {@link QR_MAX_BYTES} UTF-8 bytes.
 * @returns the module matrix.
 * @throws Error when the payload does not fit version 10.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  let version = 0
  for (let candidate = 1; candidate <= VERSIONS.length; candidate += 1) {
    const dataCodewords = entry(VERSIONS, candidate - 1).blocks.reduce((sum, count) => sum + count, 0)
    const capacity = dataCodewords - (candidate >= 10 ? 3 : 2)
    if (bytes.length <= capacity) {
      version = candidate
      break
    }
  }
  if (version === 0) throw new Error(`qr: payload of ${String(bytes.length)} bytes exceeds ${String(QR_MAX_BYTES)} bytes`)
  const data = codewords(bytes, version)
  const candidates = Array.from({ length: 8 }, (_, mask) => {
    const canvas = prepareCanvas(version)
    drawFormat(canvas, mask)
    const modules = placeData(canvas, data, mask)
    return { modules, score: penalty(modules) }
  })
  // The first lowest score wins, as the specification's mask evaluation orders them.
  const best = candidates.reduce((lowest, candidate) => (candidate.score < lowest.score ? candidate : lowest))
  return { size: best.modules.length, version, modules: best.modules }
}

/**
 * Render a module matrix as an SVG string: one `rect` per dark module on a
 * white background with a four-module quiet zone, `shape-rendering` crisp.
 * @param matrix - the encoded symbol.
 * @param moduleSize - pixels per module.
 * @returns the SVG markup.
 */
export function qrToSvg(matrix: QrMatrix, moduleSize = 4): string {
  const quiet = 4
  const total = (matrix.size + quiet * 2) * moduleSize
  const rects: string[] = []
  matrix.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (!dark) return
      const px = (x + quiet) * moduleSize
      const py = (y + quiet) * moduleSize
      rects.push(`<rect x="${String(px)}" y="${String(py)}" width="${String(moduleSize)}" height="${String(moduleSize)}"/>`)
    })
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(total)} ${String(total)}" width="${String(total)}" height="${String(total)}" shape-rendering="crispEdges">`
    + `<rect width="${String(total)}" height="${String(total)}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`
}
