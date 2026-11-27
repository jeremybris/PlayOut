// Synthetic Xbox 360 data for the achievement readers' tests (no game files): an XDBF block, an LZX stream, an XEX2
// executable around a tiny image, and an XDVDFS disc image. Only the tests use it.
import { createCipheriv } from 'node:crypto'
import { XEX_HEADER, XEX_RETAIL_KEY } from './xex'

const be32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
const be16 = (n: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}
const magic = (s: string): Buffer => Buffer.from(s, 'latin1')

export interface FakeAchievement {
  id: number
  name: string
  description: string
  unachieved?: string
  gamerscore: number
  flags?: number
}

/** An XDBF block with an XACH table and string tables (English unless left out, plus `other` languages by id). */
export function buildXdbf(
  achievements: FakeAchievement[],
  options: {
    defaultLanguage?: number
    other?: Record<number, (s: string) => string>
    /** Leave out the English table. */
    noEnglish?: boolean
  } = {}
): Buffer {
  const texts: string[] = []
  const idOf = (s: string): number => {
    const i = texts.indexOf(s)
    if (i >= 0) return i + 1
    texts.push(s)
    return texts.length
  }
  const entries = achievements.map((a) =>
    Buffer.concat([
      be16(a.id),
      be16(idOf(a.name)),
      be16(idOf(a.description)),
      be16(idOf(a.unachieved ?? '')),
      be32(0x1000 + a.id),
      be16(a.gamerscore),
      be16(0),
      be32(a.flags ?? 0x8),
      Buffer.alloc(16)
    ])
  )
  const section = (tag: string, body: Buffer): Buffer =>
    Buffer.concat([magic(tag), be32(1), be32(body.length), body])
  const xach = section('XACH', Buffer.concat([be16(achievements.length), ...entries]))
  const xstr = (map: (s: string) => string): Buffer =>
    section(
      'XSTR',
      Buffer.concat([
        be16(texts.length),
        ...texts.map((t, i) => {
          const s = Buffer.from(map(t), 'utf8')
          return Buffer.concat([be16(i + 1), be16(s.length), s])
        })
      ])
    )
  const sections: { ns: number; id: bigint; data: Buffer }[] = [
    { ns: 1, id: 0x58414348n, data: xach },
    { ns: 1, id: 0x58535443n, data: section('XSTC', be32(options.defaultLanguage ?? 1)) },
    ...Object.entries(options.other ?? {}).map(([lang, map]) => ({
      ns: 3,
      id: BigInt(lang),
      data: xstr(map)
    }))
  ]
  if (!options.noEnglish && !(options.other && 1 in options.other))
    sections.push({ ns: 3, id: 1n, data: xstr((s) => s) })
  const tableLength = sections.length + 2
  const freeLength = 1
  let offset = 0
  const table = Buffer.alloc(tableLength * 18)
  sections.forEach((s, i) => {
    table.writeUInt16BE(s.ns, i * 18)
    table.writeBigUInt64BE(s.id, i * 18 + 2)
    table.writeUInt32BE(offset, i * 18 + 10)
    table.writeUInt32BE(s.data.length, i * 18 + 14)
    offset += s.data.length
  })
  return Buffer.concat([
    magic('XDBF'),
    be32(0x10000),
    be32(tableLength),
    be32(sections.length),
    be32(freeLength),
    be32(1),
    table,
    Buffer.alloc(freeLength * 8),
    ...sections.map((s) => s.data)
  ])
}

/** Bits written most significant first into 16-bit little-endian words, as an LZX decoder reads them. */
export class LzxBits {
  private words: number[] = []
  private cur = 0
  private n = 0
  private raw: Buffer[] = []

  bits(value: number, count: number): this {
    for (let i = count - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | (Math.floor(value / 2 ** i) & 1)
      if (++this.n === 16) {
        this.words.push(this.cur)
        this.cur = 0
        this.n = 0
      }
    }
    return this
  }

  /** Pad to the next word. */
  flush(): this {
    if (this.n) this.bits(0, 16 - this.n)
    return this
  }

  /** Before an uncompressed block's bytes: the decoder skips to the next word, a whole one when already aligned. */
  alignForRaw(): this {
    if (this.n === 0) this.bits(0, 16)
    else this.flush()
    this.raw.push(this.take())
    return this
  }

  /** Raw bytes (an uncompressed block). */
  bytes(b: Buffer): this {
    this.raw.push(b)
    return this
  }

  private take(): Buffer {
    const out = Buffer.alloc(this.words.length * 2)
    this.words.forEach((w, i) => out.writeUInt16LE(w, i * 2))
    this.words = []
    return out
  }

  done(): Buffer {
    this.flush()
    this.raw.push(this.take())
    return Buffer.concat(this.raw)
  }
}

/** Canonical Huffman codes for code lengths (as LZX assigns them). */
export function canonicalCodes(
  lens: ArrayLike<number>
): Map<number, { code: number; len: number }> {
  const out = new Map<number, { code: number; len: number }>()
  let code = 0
  for (let bits = 1; bits <= 16; bits++) {
    for (let s = 0; s < lens.length; s++) {
      if (lens[s] !== bits) continue
      out.set(s, { code, len: bits })
      code++
    }
    code <<= 1
  }
  return out
}

/** Write one pretree and the deltas from `prev` to `next` over [first, last) (then copy next into prev). */
export function writeLens(
  w: LzxBits,
  prev: number[],
  next: number[],
  first: number,
  last: number
): void {
  const syms: number[] = []
  for (let x = first; x < last; x++) syms.push(((prev[x] ?? 0) - (next[x] ?? 0) + 17) % 17)
  const used = [...new Set(syms)].sort((a, b) => a - b)
  if (used.length === 1) used.push(used[0] === 18 ? 17 : 18)
  const shapes: Record<number, number[]> = { 2: [1, 1], 3: [1, 2, 2], 4: [2, 2, 2, 2] }
  const shape = shapes[used.length]
  if (!shape) throw new Error('too many pretree symbols for the test writer')
  const pre = new Array<number>(20).fill(0)
  used.forEach((s, i) => (pre[s] = shape[i]!))
  for (const l of pre) w.bits(l, 4)
  const codes = canonicalCodes(pre)
  for (const s of syms) {
    const c = codes.get(s)!
    w.bits(c.code, c.len)
  }
  for (let x = first; x < last; x++) prev[x] = next[x] ?? 0
}

/** An LZX stream (no x86 translation) holding `data` in one uncompressed block. */
export function lzxStored(data: Buffer): Buffer {
  const w = new LzxBits()
  w.bits(0, 1)
  w.bits(3, 3)
    .bits(data.length >>> 8, 16)
    .bits(data.length & 0xff, 8)
  w.alignForRaw()
  const r = Buffer.alloc(12)
  r.writeUInt32LE(1, 0)
  r.writeUInt32LE(1, 4)
  r.writeUInt32LE(1, 8)
  w.bytes(r).bytes(data)
  if (data.length & 1) w.bytes(Buffer.alloc(1))
  return w.done()
}

/** AES-128-CBC encryption with a zero IV (whole blocks). */
function encrypt(key: Buffer, data: Buffer): Buffer {
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16))
  c.setAutoPadding(false)
  return Buffer.concat([c.update(data), c.final()])
}

const pad16 = (b: Buffer): Buffer =>
  b.length % 16 ? Buffer.concat([b, Buffer.alloc(16 - (b.length % 16))]) : b

export const IMAGE_BASE = 0x82000000

/** A small PE-like image ("MZ") with `xdbf` at offset 0x400. */
export function fakeImage(xdbf: Buffer): Buffer {
  const image = Buffer.alloc(0x400 + xdbf.length + 0x100)
  image.write('MZ', 0, 'latin1')
  image.write('not a real program', 0x10, 'latin1')
  xdbf.copy(image, 0x400)
  return image
}

/**
 * An XEX2 file around `image`: `compression` 0 none, 1 basic (the zero run after the header written as a zero
 * run), 2 LZX (two blocks, the stream split in chunks); encrypted with the retail key (or the devkit key) unless
 * `encrypt` is false. Its resource `titleId` points at offset 0x400 of the image.
 */
export function buildXex(options: {
  image: Buffer
  titleId: string
  compression: 0 | 1 | 2
  encrypt?: boolean
  devkit?: boolean
  resourceSize?: number
}): Buffer {
  const { image, titleId, compression } = options
  const encrypted = options.encrypt ?? true
  const DATA = 0x1000
  const FORMAT = 0x100
  const EXEC = 0x180
  const RES = 0x200
  const SEC = 0x300
  let format: Buffer
  let data: Buffer
  if (compression === 0) {
    format = Buffer.concat([be32(8), be16(encrypted ? 1 : 0), be16(0)])
    data = image
  } else if (compression === 1) {
    // [0, 0x40) data, [0x40, 0x400) zeros, the rest data.
    const blocks = [
      { data: 0x40, zero: 0x400 - 0x40 },
      { data: image.length - 0x400, zero: 0 }
    ]
    format = Buffer.concat([
      be32(8 + blocks.length * 8),
      be16(encrypted ? 1 : 0),
      be16(1),
      ...blocks.flatMap((b) => [be32(b.data), be32(b.zero)])
    ])
    data = Buffer.concat([image.subarray(0, 0x40), image.subarray(0x400)])
  } else {
    const stream = lzxStored(image)
    const half = Math.floor(stream.length / 2)
    const chunk = (b: Buffer): Buffer => Buffer.concat([be16(b.length), b])
    // Block 2 first (block 1 names its size), each: next size, 20-byte hash, chunks, a zero length.
    const block2 = Buffer.concat([be32(0), Buffer.alloc(20), chunk(stream.subarray(half)), be16(0)])
    const block1 = Buffer.concat([
      be32(block2.length),
      Buffer.alloc(20),
      chunk(stream.subarray(0, 10)),
      chunk(stream.subarray(10, half)),
      be16(0)
    ])
    format = Buffer.concat([
      be32(36),
      be16(encrypted ? 1 : 0),
      be16(2),
      be32(0x8000),
      be32(block1.length),
      Buffer.alloc(20)
    ])
    data = Buffer.concat([block1, block2])
  }
  const session = Buffer.from('00112233445566778899AABBCCDDEEFF', 'hex')
  const key = options.devkit ? Buffer.alloc(16) : XEX_RETAIL_KEY
  const fileKey = encrypt(key, session)
  const payload = encrypted ? encrypt(session, pad16(data)) : data

  const headers: [number, number][] = [
    [XEX_HEADER.fileFormat, FORMAT],
    [XEX_HEADER.executionInfo, EXEC],
    [XEX_HEADER.resourceInfo, RES],
    [XEX_HEADER.imageBase, IMAGE_BASE]
  ]
  const head = Buffer.alloc(DATA)
  head.write('XEX2', 0, 'latin1')
  head.writeUInt32BE(DATA, 0x08)
  head.writeUInt32BE(SEC, 0x10)
  head.writeUInt32BE(headers.length, 0x14)
  headers.forEach(([k, v], i) => {
    head.writeUInt32BE(k, 0x18 + i * 8)
    head.writeUInt32BE(v >>> 0, 0x18 + i * 8 + 4)
  })
  format.copy(head, FORMAT)
  head.writeUInt32BE(parseInt(titleId, 16) >>> 0, EXEC + 0x0c)
  head.writeUInt32BE(4 + 16, RES)
  head.write(titleId, RES + 4, 'latin1')
  head.writeUInt32BE((IMAGE_BASE + 0x400) >>> 0, RES + 12)
  head.writeUInt32BE(options.resourceSize ?? image.length - 0x400 - 0x100, RES + 16)
  head.writeUInt32BE(image.length, SEC + 0x04)
  head.writeUInt32BE(IMAGE_BASE >>> 0, SEC + 0x110)
  fileKey.copy(head, SEC + 0x150)
  return Buffer.concat([head, payload])
}

/** An XISO (partition at 0) with files in its root folder. */
export function buildXiso(files: Record<string, Buffer>): Buffer {
  const SECTOR = 2048
  const names = Object.keys(files).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  const rootSector = 33
  const dir = Buffer.alloc(SECTOR, 0xff)
  let at = 0
  let sector = 34
  const sectors: number[] = []
  names.forEach((name, i) => {
    const size = files[name]!.length
    sectors.push(sector)
    const entryLength = 14 + name.length
    const next = i + 1 < names.length ? (at + entryLength + 3) & ~3 : 0
    dir.writeUInt16LE(0, at)
    dir.writeUInt16LE(next / 4, at + 2)
    dir.writeUInt32LE(sector, at + 4)
    dir.writeUInt32LE(size, at + 8)
    dir[at + 12] = 0x20
    dir[at + 13] = name.length
    dir.write(name, at + 14, 'latin1')
    sector += Math.ceil(size / SECTOR) || 1
    at = next
  })
  const image = Buffer.alloc(sector * SECTOR)
  image.write('MICROSOFT*XBOX*MEDIA', 32 * SECTOR, 'latin1')
  image.writeUInt32LE(rootSector, 32 * SECTOR + 20)
  image.writeUInt32LE(SECTOR, 32 * SECTOR + 24)
  dir.copy(image, rootSector * SECTOR)
  names.forEach((name, i) => files[name]!.copy(image, sectors[i]! * SECTOR))
  return image
}
