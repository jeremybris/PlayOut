// An LZX decoder (the LZ77 + Huffman format of Microsoft's CAB files and the Xbox 360's XMemCompress), written for
// PlayOut from the format's public description: enough to unpack the "normal" (LZX) compressed image of an Xbox 360
// executable (xex.ts). One continuous stream, no reset interval, 32 KB output frames, the bit stream re-aligned to 16
// bits after each frame, as CAB decoders do.

/** Output is produced in frames of this many bytes; the bit stream is re-aligned to 16 bits after each one. */
const FRAME = 32768
const NUM_CHARS = 256
const PRETREE_SYMS = 20
const LENGTH_SYMS = 249
const ALIGNED_SYMS = 8
const MIN_MATCH = 2
const BLOCK_VERBATIM = 1
const BLOCK_ALIGNED = 2
const BLOCK_UNCOMPRESSED = 3

/** Extra offset bits and base offset of each position slot. */
const EXTRA_BITS: number[] = []
const POSITION_BASE: number[] = []
{
  let j = 0
  for (let i = 0; i < 52; i += 2) {
    EXTRA_BITS[i] = j
    EXTRA_BITS[i + 1] = j
    if (i !== 0 && j < 17) j++
  }
  let base = 0
  for (let i = 0; i < 52; i++) {
    POSITION_BASE[i] = base
    base += 2 ** EXTRA_BITS[i]!
  }
}

export class LzxError extends Error {}

/** Position slots for a window of 2^bits bytes (15..21). */
export function positionSlots(windowBits: number): number {
  return windowBits === 21 ? 50 : windowBits === 20 ? 42 : windowBits * 2
}

/** A canonical Huffman decoding table indexed by the next `bits` bits of the stream. */
interface Table {
  bits: number
  sym: Uint16Array
  len: Uint8Array
}

/** The table for code lengths `lens` (0 = unused), or null when no symbol is used. Over-full codes are refused. */
function buildTable(lens: Uint8Array, count: number): Table | null {
  let max = 0
  for (let i = 0; i < count; i++) if (lens[i]! > max) max = lens[i]!
  if (max === 0) return null
  if (max > 16) throw new LzxError('code too long')
  const size = 1 << max
  const sym = new Uint16Array(size)
  const len = new Uint8Array(size)
  let code = 0
  for (let bits = 1; bits <= max; bits++) {
    for (let s = 0; s < count; s++) {
      if (lens[s] !== bits) continue
      if (code >= 1 << bits) throw new LzxError('over-subscribed code')
      const shift = max - bits
      const start = code << shift
      const end = start + (1 << shift)
      for (let k = start; k < end; k++) {
        sym[k] = s
        len[k] = bits
      }
      code++
    }
    code <<= 1
  }
  return { bits: max, sym, len }
}

/** Bits past the end of the input the decoder may peek at (a Huffman lookup reads ahead): two 16-bit words. */
const TAIL_WORDS = 2

/**
 * Decompress `input` (one LZX stream) into exactly `outLength` bytes. `windowBits` is log2 of the window size (15..21).
 * Throws LzxError on a corrupt or truncated stream. Runs to the end at once; lzxDecompressAsync gives the event loop a
 * turn every few frames.
 */
export function lzxDecompress(input: Uint8Array, outLength: number, windowBits: number): Buffer {
  return runSync(lzxSteps(input, outLength, windowBits))
}

/** lzxDecompress, giving the event loop a turn every few frames (a big image does not hold up the main process). */
export function lzxDecompressAsync(
  input: Uint8Array,
  outLength: number,
  windowBits: number
): Promise<Buffer> {
  return runAsync(lzxSteps(input, outLength, windowBits))
}

/** Work done in steps: each `yield` is a point where the caller may give the event loop a turn. */
export type Steps<T> = Generator<void, T, void>

/** Run `steps` to the end at once. */
export function runSync<T>(steps: Steps<T>): T {
  for (;;) {
    const r = steps.next()
    if (r.done) return r.value
  }
}

/** Run `steps` to the end, giving the event loop a turn every `every` steps. */
export async function runAsync<T>(steps: Steps<T>, every = 8): Promise<T> {
  for (let n = 1; ; n++) {
    const r = steps.next()
    if (r.done) return r.value
    if (n % every === 0) await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** The decoder, one 32 KB output frame per step. */
export function* lzxSteps(input: Uint8Array, outLength: number, windowBits: number): Steps<Buffer> {
  if (windowBits < 15 || windowBits > 21) throw new LzxError(`bad window size 2^${windowBits}`)
  const out = Buffer.alloc(outLength)
  const mainCount = NUM_CHARS + positionSlots(windowBits) * 8
  const mainLens = new Uint8Array(mainCount)
  const lengthLens = new Uint8Array(LENGTH_SYMS)
  const alignedLens = new Uint8Array(ALIGNED_SYMS)
  let mainTable: Table | null = null
  let lengthTable: Table | null = null
  let alignedTable: Table | null = null

  // The bit stream: 16-bit little-endian words read most significant bit first, kept left-aligned in a 32-bit buffer.
  // Past the input's end only TAIL_WORDS zero words are given (a look-ahead): a stream that needs more is truncated,
  // so made-up bits never produce output.
  let p = 0
  let bitBuf = 0
  let bitsLeft = 0
  const ensure = (n: number): void => {
    while (bitsLeft < n) {
      if (p >= input.length + TAIL_WORDS * 2) throw new LzxError('truncated stream')
      const word =
        p + 1 < input.length ? input[p]! | (input[p + 1]! << 8) : p < input.length ? input[p]! : 0
      p += 2
      bitBuf = (bitBuf | (word << (16 - bitsLeft))) >>> 0
      bitsLeft += 16
    }
  }
  const remove = (n: number): void => {
    bitBuf = n >= 32 ? 0 : (bitBuf << n) >>> 0
    bitsLeft -= n
  }
  const read = (n: number): number => {
    if (n === 0) return 0
    ensure(n)
    const v = bitBuf >>> (32 - n)
    remove(n)
    return v
  }
  const decode = (t: Table | null): number => {
    if (!t) throw new LzxError('empty code used')
    ensure(16)
    const idx = bitBuf >>> (32 - t.bits)
    const l = t.len[idx]!
    if (!l) throw new LzxError('invalid code')
    remove(l)
    return t.sym[idx]!
  }
  const readLens = (lens: Uint8Array, first: number, last: number): void => {
    const pre = new Uint8Array(PRETREE_SYMS)
    for (let i = 0; i < PRETREE_SYMS; i++) pre[i] = read(4)
    const table = buildTable(pre, PRETREE_SYMS)
    const set = (x: number, v: number): void => {
      if (x < lens.length) lens[x] = v
    }
    let x = first
    while (x < last) {
      let z = decode(table)
      if (z === 17) {
        for (let y = read(4) + 4; y > 0; y--) set(x++, 0)
      } else if (z === 18) {
        for (let y = read(5) + 20; y > 0; y--) set(x++, 0)
      } else if (z === 19) {
        let y = read(1) + 4
        z = decode(table)
        let v = (lens[x] ?? 0) - z
        if (v < 0) v += 17
        for (; y > 0; y--) set(x++, v)
      } else {
        let v = (lens[x] ?? 0) - z
        if (v < 0) v += 17
        set(x++, v)
      }
    }
  }

  let r0 = 1
  let r1 = 1
  let r2 = 1
  let blockType = 0
  let blockLength = 0
  let blockRemaining = 0
  let intelStarted = false
  let intelFileSize = 0
  {
    const flag = read(1)
    if (flag) {
      const hi = read(16)
      const lo = read(16)
      intelFileSize = hi * 65536 + lo
    }
  }

  let pos = 0
  for (let frame = 0; frame * FRAME < outLength; frame++) {
    const frameStart = frame * FRAME
    const frameEnd = Math.min(frameStart + FRAME, outLength)
    let todo = frameEnd - pos
    while (todo > 0) {
      if (blockRemaining === 0) {
        // An odd-sized uncompressed block is followed by a padding byte.
        if (blockType === BLOCK_UNCOMPRESSED && blockLength & 1) p++
        blockType = read(3)
        const hi = read(16)
        const lo = read(8)
        blockRemaining = blockLength = hi * 256 + lo
        if (blockType === BLOCK_ALIGNED || blockType === BLOCK_VERBATIM) {
          if (blockType === BLOCK_ALIGNED) {
            for (let i = 0; i < ALIGNED_SYMS; i++) alignedLens[i] = read(3)
            alignedTable = buildTable(alignedLens, ALIGNED_SYMS)
          }
          readLens(mainLens, 0, NUM_CHARS)
          readLens(mainLens, NUM_CHARS, mainCount)
          mainTable = buildTable(mainLens, mainCount)
          if (mainLens[0xe8]) intelStarted = true
          readLens(lengthLens, 0, LENGTH_SYMS)
          lengthTable = buildTable(lengthLens, LENGTH_SYMS)
        } else if (blockType === BLOCK_UNCOMPRESSED) {
          intelStarted = true
          // Align to the next 16-bit word (a whole word when already aligned), then the three repeated offsets.
          if (bitsLeft === 0) ensure(16)
          bitsLeft = 0
          bitBuf = 0
          if (p + 12 > input.length) throw new LzxError('truncated block')
          r0 = u32le(input, p)
          r1 = u32le(input, p + 4)
          r2 = u32le(input, p + 8)
          p += 12
        } else {
          throw new LzxError(`bad block type ${blockType}`)
        }
      }
      let run = Math.min(blockRemaining, todo)
      blockRemaining -= run
      if (blockType === BLOCK_UNCOMPRESSED) {
        if (p + run > input.length) throw new LzxError('truncated block')
        out.set(input.subarray(p, p + run), pos)
        p += run
        pos += run
      } else {
        const aligned = blockType === BLOCK_ALIGNED
        while (run > 0) {
          let sym = decode(mainTable)
          if (sym < NUM_CHARS) {
            out[pos++] = sym
            run--
            continue
          }
          sym -= NUM_CHARS
          let length = sym & 7
          if (length === 7) length += decode(lengthTable)
          length += MIN_MATCH
          const slot = sym >>> 3
          let offset: number
          if (slot > 2) {
            const extra = EXTRA_BITS[slot]!
            if (!aligned) {
              offset = slot === 3 ? 1 : POSITION_BASE[slot]! - 2 + read(extra)
            } else {
              offset = POSITION_BASE[slot]! - 2
              if (extra > 3) {
                offset += read(extra - 3) * 8
                offset += decode(alignedTable)
              } else if (extra === 3) {
                offset += decode(alignedTable)
              } else if (extra > 0) {
                offset += read(extra)
              } else {
                offset = 1
              }
            }
            r2 = r1
            r1 = r0
            r0 = offset
          } else if (slot === 0) {
            offset = r0
          } else if (slot === 1) {
            offset = r1
            r1 = r0
            r0 = offset
          } else {
            offset = r2
            r2 = r0
            r0 = offset
          }
          if (offset > pos || offset <= 0) throw new LzxError('match before the start')
          if (pos + length > outLength) throw new LzxError('match past the end')
          for (let k = 0; k < length; k++, pos++) out[pos] = out[pos - offset]!
          run -= length
        }
        // A match that ran past the block's end takes its bytes from the next block's count.
        if (run < 0) {
          if (-run > blockRemaining) throw new LzxError('match past the block')
          blockRemaining += run
        }
      }
      todo = frameEnd - pos
    }
    if (pos !== frameEnd) throw new LzxError('frame overrun')
    // Re-align the bit stream to 16 bits.
    if (bitsLeft > 0) ensure(16)
    if (bitsLeft & 15) remove(bitsLeft & 15)
    yield
  }
  // The x86 CALL translation is undone on a copy: later matches refer to the bytes as they were decoded.
  if (!intelStarted || !intelFileSize) return out
  const result = Buffer.from(out)
  for (let start = 0, frame = 0; start < outLength && frame < 32768; start += FRAME, frame++) {
    const end = Math.min(start + FRAME, outLength)
    if (end - start > 10) undoE8(result, start, end, intelFileSize)
    if (frame % 32 === 31) yield
  }
  return result
}

/** A little-endian 32-bit unsigned value. */
function u32le(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000
}

/** Undo the x86 CALL (0xE8) translation in one frame. */
function undoE8(out: Buffer, start: number, end: number, fileSize: number): void {
  const last = end - 10
  let i = start
  while (i < last) {
    if (out[i] !== 0xe8) {
      i++
      continue
    }
    const cur = i
    i++
    const abs = out.readInt32LE(i)
    if (abs >= -cur && abs < fileSize) {
      const rel = abs >= 0 ? abs - cur : abs + fileSize
      out.writeInt32LE(rel | 0, i)
    }
    i += 4
  }
}
