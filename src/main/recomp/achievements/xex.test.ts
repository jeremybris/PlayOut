import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LzxError, lzxDecompress, lzxDecompressAsync, positionSlots } from './lzx'
import {
  buildXdbf,
  buildXex,
  buildXiso,
  canonicalCodes,
  fakeImage,
  LzxBits,
  lzxStored,
  writeLens
} from './testing'
import { parseXdbf } from './xdbf'
import { readXdvdfsRootFile } from './xdvdfs'
import { readXexHeaders, readXexTitleData, readXexTitleDataAsync, xexImage, XexError } from './xex'

const ACHIEVEMENTS = [
  { id: 1, name: 'First Blood', description: 'Win a race.', gamerscore: 10 },
  {
    id: 7,
    name: 'Secret Road',
    description: 'Find the hidden road.',
    unachieved: 'Keep exploring.',
    gamerscore: 25,
    flags: 0x2
  },
  { id: 12, name: 'Champion', description: 'Win every cup.', gamerscore: 50 }
]

describe('lzxDecompress', () => {
  it('unpacks an uncompressed block (odd-sized, with its padding byte)', () => {
    const data = Buffer.from('Hello, recompiled world!') // 24 bytes
    expect(lzxDecompress(lzxStored(data), data.length, 15).toString()).toBe(data.toString())
    const odd = Buffer.from('odd')
    expect(lzxDecompress(lzxStored(odd), 3, 16).toString()).toBe('odd')
  })

  it('unpacks uncompressed, verbatim and aligned blocks in one stream', () => {
    const w = new LzxBits()
    w.bits(0, 1) // no x86 translation
    // Block 1: uncompressed, 14 bytes.
    const first = Buffer.from('Hello, world!!')
    w.bits(3, 3).bits(0, 16).bits(first.length, 8).alignForRaw()
    const r = Buffer.alloc(12)
    r.writeUInt32LE(1, 0)
    r.writeUInt32LE(1, 4)
    r.writeUInt32LE(1, 8)
    w.bytes(r).bytes(first)

    const mainCount = 256 + positionSlots(15) * 8
    const mainPrev = new Array<number>(mainCount).fill(0)
    const lengthPrev = new Array<number>(249).fill(0)
    const noLengths = new Array<number>(249).fill(0)

    // Block 2: verbatim, 7 bytes: A B A, a match (slot 4, one extra bit = offset 3, length 3), B.
    const MATCH_A = 256 + (4 << 3) + 1
    const main2 = new Array<number>(mainCount).fill(0)
    main2[0x41] = 2
    main2[0x42] = 2
    main2[MATCH_A] = 1
    w.bits(1, 3).bits(0, 16).bits(7, 8)
    writeLens(w, mainPrev, main2, 0, 256)
    writeLens(w, mainPrev, main2, 256, mainCount)
    writeLens(w, lengthPrev, noLengths, 0, 249)
    const c2 = canonicalCodes(main2)
    const sym = (codes: typeof c2, s: number): void => {
      const c = codes.get(s)!
      w.bits(c.code, c.len)
    }
    sym(c2, 0x41)
    sym(c2, 0x42)
    sym(c2, 0x41)
    sym(c2, MATCH_A)
    w.bits(1, 1) // extra bit: offset 4 - 2 + 1 = 3
    sym(c2, 0x42)

    // Block 3: aligned, 5 bytes: Z, a match (slot 8, 3 extra bits from the aligned tree: offset 14 + 5, length 4).
    const MATCH_B = 256 + (8 << 3) + 2
    const main3 = new Array<number>(mainCount).fill(0)
    main3[0x5a] = 1
    main3[MATCH_B] = 1
    w.bits(2, 3).bits(0, 16).bits(5, 8)
    for (let i = 0; i < 8; i++) w.bits(3, 3)
    writeLens(w, mainPrev, main3, 0, 256)
    writeLens(w, mainPrev, main3, 256, mainCount)
    writeLens(w, lengthPrev, noLengths, 0, 249)
    const c3 = canonicalCodes(main3)
    sym(c3, 0x5a)
    sym(c3, MATCH_B)
    w.bits(5, 3) // aligned symbol 5 (all eight aligned codes are 3 bits: the symbol itself)

    const out = lzxDecompress(w.done(), 26, 15)
    expect(out.toString('latin1')).toBe('Hello, world!!ABAABABZlo, ')
  })

  it('refuses a corrupt stream', () => {
    const w = new LzxBits()
    w.bits(0, 1).bits(5, 3).bits(0, 16).bits(4, 8) // block type 5
    expect(() => lzxDecompress(w.done(), 4, 15)).toThrow(LzxError)
    expect(() => lzxDecompress(lzxStored(Buffer.from('abcd')), 4, 9)).toThrow(LzxError)
    // A stored block shorter than the output it claims.
    const stored = lzxStored(Buffer.from('abcdefgh'))
    expect(() => lzxDecompress(stored.subarray(0, 10), 8, 15)).toThrow(LzxError)
  })
})

describe('lzxDecompress on hostile input', () => {
  /** A verbatim block claiming `length` bytes of two literals (1-bit codes), with no symbols written after its trees. */
  function truncatedVerbatim(length: number): Buffer {
    const w = new LzxBits()
    w.bits(0, 1)
    const mainCount = 256 + positionSlots(15) * 8
    const main = new Array<number>(mainCount).fill(0)
    main[0x41] = 1
    main[0x42] = 1
    w.bits(1, 3)
      .bits(length >>> 8, 16)
      .bits(length & 0xff, 8)
    writeLens(w, new Array<number>(mainCount).fill(0), main, 0, 256)
    writeLens(w, new Array<number>(mainCount).fill(0), main, 256, mainCount)
    writeLens(w, new Array<number>(249).fill(0), new Array<number>(249).fill(0), 0, 249)
    return w.done()
  }

  it('refuses a truncated stream instead of decoding made-up bits', () => {
    // Before: the missing input read as zeros, and this tiny stream decoded to 96 KB of "A".
    const stream = truncatedVerbatim(3 * 32768)
    expect(stream.length).toBeLessThan(200)
    expect(() => lzxDecompress(stream, 3 * 32768, 15)).toThrow(LzxError)
    // A stored block cut short is refused too.
    expect(() =>
      lzxDecompress(lzxStored(Buffer.alloc(40_000)).subarray(0, 1000), 40_000, 15)
    ).toThrow(LzxError)
  })

  it('gives the event loop turns while it decodes a big stream', async () => {
    const data = Buffer.alloc(1024 * 1024, 7)
    let turn = false
    setImmediate(() => (turn = true))
    const out = await lzxDecompressAsync(lzxStored(data), data.length, 17)
    expect(out.equals(data)).toBe(true)
    expect(turn).toBe(true)
  })
})

describe('parseXdbf', () => {
  it('reads the achievement table with its English texts', () => {
    const info = parseXdbf(buildXdbf(ACHIEVEMENTS))!
    expect(info.achievements).toEqual([
      {
        id: 1,
        name: 'First Blood',
        description: 'Win a race.',
        unachieved: '',
        gamerscore: 10,
        flags: 8
      },
      {
        id: 7,
        name: 'Secret Road',
        description: 'Find the hidden road.',
        unachieved: 'Keep exploring.',
        gamerscore: 25,
        flags: 2
      },
      {
        id: 12,
        name: 'Champion',
        description: 'Win every cup.',
        unachieved: '',
        gamerscore: 50,
        flags: 8
      }
    ])
  })

  it("uses the game's default language when it has no English texts", () => {
    const other = { 3: (s: string) => `FR ${s}`, 5: (s: string) => `DE ${s}` }
    const french = buildXdbf(ACHIEVEMENTS, { defaultLanguage: 3, other, noEnglish: true })
    expect(parseXdbf(french)!.achievements[0]!.name).toBe('FR First Blood')
    // English wins over the default language when the game has it.
    const withEnglish = buildXdbf(ACHIEVEMENTS, { defaultLanguage: 3, other })
    expect(parseXdbf(withEnglish)!.achievements[0]!.name).toBe('First Blood')
  })

  it('refuses what is not an XDBF block with achievements', () => {
    expect(parseXdbf(Buffer.from('not xdbf at all, nothing here'))).toBeNull()
    expect(parseXdbf(Buffer.alloc(10))).toBeNull()
  })
})

describe('XEX2', () => {
  const image = fakeImage(buildXdbf(ACHIEVEMENTS))

  it('reads the headers: title id, image base and size, resources', () => {
    const h = readXexHeaders(buildXex({ image, titleId: '4D5307E6', compression: 1 }))
    expect(h).toMatchObject({
      titleId: '4D5307E6',
      imageBase: 0x82000000,
      imageSize: image.length,
      encryption: 1,
      compression: 1
    })
    expect(h.resources).toEqual([
      { name: '4D5307E6', address: 0x82000400, size: image.length - 0x500 }
    ])
  })

  it.each([
    ['uncompressed', 0],
    ['basic', 1],
    ['LZX', 2]
  ] as const)('decrypts and unpacks a %s image', (_name, compression) => {
    const xex = buildXex({ image, titleId: '4D5307E6', compression })
    expect(xexImage(xex).equals(image)).toBe(true)
    const plain = buildXex({ image, titleId: '4D5307E6', compression, encrypt: false })
    expect(xexImage(plain).equals(image)).toBe(true)
  })

  it('opens a development kit executable too', () => {
    const xex = buildXex({ image, titleId: '4D5307E6', compression: 1, devkit: true })
    expect(xexImage(xex).equals(image)).toBe(true)
  })

  it("finds the game's achievement table in its resources", () => {
    const { titleId, xdbf } = readXexTitleData(
      buildXex({ image, titleId: '4D5307E6', compression: 2 })
    )
    expect(titleId).toBe('4D5307E6')
    expect(parseXdbf(xdbf!)!.achievements.map((a) => a.name)).toEqual([
      'First Blood',
      'Secret Road',
      'Champion'
    ])
  })

  it('refuses a file that is not an XEX2 executable, or that cannot be decrypted', () => {
    expect(() => readXexHeaders(Buffer.from('MZ not an xex'))).toThrow(XexError)
    const xex = buildXex({ image, titleId: '4D5307E6', compression: 1 })
    xex.fill(0x55, 0x300 + 0x150, 0x300 + 0x160) // a wrong file key
    expect(() => xexImage(xex)).toThrow(XexError)
  })
  it('refuses an LZX image far bigger than its compressed data (a decompression bomb)', async () => {
    const xex = buildXex({ image, titleId: '4D5307E6', compression: 2, encrypt: false })
    // Claim 100 MB from a stream of a few kilobytes.
    xex.writeUInt32BE(100 * 1024 * 1024, 0x300 + 0x04)
    expect(() => xexImage(xex)).toThrow(/too big/)
    // And anything over 128 MB, whatever the compression.
    const basic = buildXex({ image, titleId: '4D5307E6', compression: 1, encrypt: false })
    basic.writeUInt32BE(200 * 1024 * 1024, 0x300 + 0x04)
    expect(() => xexImage(basic)).toThrow(/bad image size/)
    await expect(readXexTitleDataAsync(xex)).rejects.toThrow(XexError)
  })

  it('reads the title data in steps for the main process, with the same answer', async () => {
    const xex = buildXex({ image, titleId: '4D5307E6', compression: 2 })
    const steps = await readXexTitleDataAsync(xex)
    const once = readXexTitleData(xex)
    expect(steps.titleId).toBe(once.titleId)
    expect(steps.xdbf?.equals(once.xdbf!)).toBe(true)
  })
})

describe('readXdvdfsRootFile', () => {
  it('takes default.xex out of a disc image, any case', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'playout-xiso-'))
    try {
      const xex = Buffer.from('pretend executable bytes')
      const iso = join(dir, 'game.iso')
      await fs.writeFile(
        iso,
        buildXiso({ 'a.txt': Buffer.from('readme'), 'Default.xex': xex, 'z.bin': Buffer.alloc(5) })
      )
      expect((await readXdvdfsRootFile(iso, 'default.xex'))?.equals(xex)).toBe(true)
      expect(await readXdvdfsRootFile(iso, 'missing.xex')).toBeNull()
      const plain = join(dir, 'plain.bin')
      await fs.writeFile(plain, Buffer.alloc(100_000))
      expect(await readXdvdfsRootFile(plain, 'default.xex')).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
