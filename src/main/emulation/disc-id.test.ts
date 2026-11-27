import { existsSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { deflateRawSync } from 'zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chdRead, type HelperRun } from '../convert/xbox-helper'
import {
  createGameIdReader,
  dreamcastIpBinId,
  gameCubeHeaderId,
  idsFromName,
  imageIds,
  imageIdsChecked,
  n3dsHeaderId,
  normalizeGameId,
  serialFromSystemCnf,
  type ChdReader
} from './disc-id'
import { gameCubeHeader, rawCdImage, syntheticIso, syntheticSfo } from './disc-test-helpers'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'playout-discid-'))
  dirs.push(dir)
  return dir
}
async function put(path: string, data: Buffer | string): Promise<string> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, data)
  return path
}

const BS = String.fromCharCode(92)
const PS2_CNF = `BOOT2 = cdrom0:${BS}SLUS_209.99;1\r\nVER = 1.00\r\nVMODE = NTSC\r\n`
const PSX_CNF = `BOOT = cdrom:${BS}SCUS_999.98;1\r\nTCB = 4\r\nEVENT = 10\r\n`

/** A ChdReader over an in-memory image (what the helper's `read` returns). */
function fakeChd(image: Buffer, classification: string): ChdReader & { calls: number } {
  const reader = Object.assign(
    async (_path: string, offset: number, length: number) => {
      reader.calls++
      return {
        classification,
        imageBytes: image.length,
        data: image.subarray(offset, offset + length)
      }
    },
    { calls: 0 }
  )
  return reader
}

describe('ids in names', () => {
  it('normalizes ids for matching', () => {
    expect(normalizeGameId('slus_207.77')).toBe('SLUS20777')
    expect(normalizeGameId('SLUS-20777 HD')).toBe('SLUS20777HD')
  })

  it('finds PlayStation-family serials however they are written', () => {
    expect(idsFromName('God of War (USA) [SLUS-20777].iso', 'serial')).toEqual(['SLUS-20777'])
    expect(idsFromName('SLUS_207.77', 'serial')).toEqual(['SLUS-20777'])
    expect(idsFromName('ULUS10336.iso', 'serial')).toEqual(['ULUS-10336'])
    expect(idsFromName('NPUH-10001 Game', 'serial')).toEqual(['NPUH-10001'])
    expect(idsFromName('SCES_504.90', 'serial')).toEqual(['SCES-50490'])
    // Too few or too many digits, or letters before: not a serial.
    expect(idsFromName('SLUS-2077', 'serial')).toEqual([])
    expect(idsFromName('SLUS-207770', 'serial')).toEqual([])
    expect(idsFromName('XSLUS-20777', 'serial')).toEqual([])
    expect(idsFromName('Game (USA).iso', 'serial')).toEqual([])
  })

  it('finds GameCube / Wii GameIDs in brackets or as the whole name', () => {
    expect(idsFromName('Zelda [GALE01].rvz', 'gamecube')).toEqual(['GALE01'])
    expect(idsFromName('Mario Galaxy (RMGE01).iso', 'gamecube')).toEqual(['RMGE01'])
    expect(idsFromName('GALE01.iso', 'gamecube')).toEqual(['GALE01'])
    expect(idsFromName('Game (Europe).iso', 'gamecube')).toEqual([])
    expect(idsFromName('Game (EUROPE).iso', 'gamecube')).toEqual(['EUROPE'])
    expect(idsFromName('Game.iso', 'gamecube')).toEqual([])
  })

  it('finds 3DS and Switch title ids, and Dreamcast product numbers', () => {
    expect(idsFromName('Game [00040000000ee000].3ds', '3ds')).toEqual(['00040000000EE000'])
    expect(idsFromName('Game [0100000000010000][v0].nsp', 'switch')).toEqual(['0100000000010000'])
    expect(idsFromName('Game [00040000000EE000].nsp', 'switch')).toEqual([])
    expect(idsFromName('Shenmue (MK-51059).gdi', 'dreamcast')).toEqual(['MK-51059'])
    expect(idsFromName('Game T-8101N.cdi', 'dreamcast')).toEqual(['T-8101N'])
  })

  it('reads the serial a SYSTEM.CNF boots', () => {
    expect(serialFromSystemCnf(PS2_CNF)).toBe('SLUS-20999')
    expect(serialFromSystemCnf(PSX_CNF)).toBe('SCUS-99998')
    expect(serialFromSystemCnf(`BOOT2=cdrom0:${BS}DATA${BS}SLES_123.45;1`)).toBe('SLES-12345')
    expect(serialFromSystemCnf('BOOT = cdrom:PSX.EXE;1')).toBeNull()
    expect(serialFromSystemCnf('nothing')).toBeNull()
  })

  it('reads disc and cartridge headers', () => {
    expect(gameCubeHeaderId(gameCubeHeader('GALE01'))).toBe('GALE01')
    expect(gameCubeHeaderId(gameCubeHeader('RMGE01', true))).toBe('RMGE01')
    expect(gameCubeHeaderId(Buffer.alloc(0x40))).toBeNull()
    const ip = Buffer.alloc(0x100, 0x20)
    ip.write('SEGA SEGAKATANA', 0, 'latin1')
    ip.write('MK-51059  ', 0x40, 'latin1')
    expect(dreamcastIpBinId(ip)).toBe('MK-51059')
    const ncsd = Buffer.alloc(0x200)
    ncsd.write('NCSD', 0x100, 'latin1')
    ncsd.writeBigUInt64LE(0x00040000000ee000n, 0x108)
    expect(n3dsHeaderId(ncsd)).toBe('00040000000EE000')
  })
})

describe('ids in images', () => {
  it('reads a PS2 ISO and a PlayStation raw BIN (through its .cue) by their SYSTEM.CNF', async () => {
    const dir = await tempDir()
    const ps2 = await put(join(dir, 'ps2.iso'), syntheticIso({ 'SYSTEM.CNF': PS2_CNF }))
    expect(await imageIds(ps2, 'serial')).toEqual(['SLUS-20999'])
    const iso = syntheticIso({ 'SYSTEM.CNF': PSX_CNF })
    await put(join(dir, 'Game (Track 1).bin'), rawCdImage(iso, 2))
    const cue = await put(
      join(dir, 'Game.cue'),
      'FILE "Game (Track 1).bin" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n'
    )
    expect(await imageIds(cue, 'serial')).toEqual(['SCUS-99998'])
    // A Mode 1 raw image, and a raw image named .iso.
    const mode1 = await put(join(dir, 'mode1.iso'), rawCdImage(iso, 1))
    expect(await imageIds(mode1, 'serial')).toEqual(['SCUS-99998'])
    // An .m3u's first disc.
    const m3u = await put(join(dir, 'Game.m3u'), 'Game.cue\n')
    expect(await imageIds(m3u, 'serial')).toEqual(['SCUS-99998'])
  })

  it('reads a PSP ISO by UMD_DATA.BIN, else its PARAM.SFO', async () => {
    const dir = await tempDir()
    const umd = await put(
      join(dir, 'a.iso'),
      syntheticIso({
        'UMD_DATA.BIN': 'ULUS-10336|0000000000000001|0001|G',
        'PSP_GAME/PARAM.SFO': 'x'
      })
    )
    expect(await imageIds(umd, 'serial')).toEqual(['ULUS-10336'])
    const sfo = await put(
      join(dir, 'b.iso'),
      syntheticIso({ 'PSP_GAME/PARAM.SFO': syntheticSfo({ DISC_ID: 'ULES00151', TITLE: 'Game' }) })
    )
    expect(await imageIds(sfo, 'serial')).toEqual(['ULES-00151'])
  })

  it('reads a CSO (zlib blocks) and an EBOOT.PBP', async () => {
    const dir = await tempDir()
    const iso = syntheticIso({ 'UMD_DATA.BIN': 'ULJM-05500|x' }, 40)
    const blockSize = 2048
    const blocks = iso.length / blockSize
    const parts: Buffer[] = []
    const index: number[] = []
    let at = 0x18 + (blocks + 1) * 4
    for (let i = 0; i < blocks; i++) {
      const raw = iso.subarray(i * blockSize, (i + 1) * blockSize)
      // Every other block stored plain (the high bit), the rest deflated.
      const plain = i % 2 === 1
      const data = plain ? raw : deflateRawSync(raw)
      index.push(plain ? (at | 0x80000000) >>> 0 : at)
      parts.push(data)
      at += data.length
    }
    index.push(at)
    const head = Buffer.alloc(0x18 + index.length * 4)
    head.write('CISO', 0, 'latin1')
    head.writeUInt32LE(0x18, 4)
    head.writeBigUInt64LE(BigInt(iso.length), 8)
    head.writeUInt32LE(blockSize, 16)
    head[20] = 1
    index.forEach((v, i) => head.writeUInt32LE(v, 0x18 + i * 4))
    const cso = await put(join(dir, 'game.cso'), Buffer.concat([head, ...parts]))
    expect(await imageIds(cso, 'serial')).toEqual(['ULJM-05500'])

    const sfo = syntheticSfo({ DISC_ID: 'SLUS00594', TITLE: 'Game' })
    const pbpHead = Buffer.alloc(0x28)
    pbpHead.write('\0PBP', 0, 'latin1')
    pbpHead.writeUInt32LE(0x28, 8)
    pbpHead.writeUInt32LE(0x28 + sfo.length, 12)
    const pbp = await put(join(dir, 'EBOOT.PBP'), Buffer.concat([pbpHead, sfo, Buffer.alloc(64)]))
    expect(await imageIds(pbp, 'serial')).toEqual(['SLUS-00594'])
  })

  it('reads GameCube / Wii images: plain, RVZ / WIA, WBFS and CISO', async () => {
    const dir = await tempDir()
    expect(
      await imageIds(await put(join(dir, 'a.iso'), gameCubeHeader('GALE01')), 'gamecube')
    ).toEqual(['GALE01'])
    const rvz = Buffer.alloc(0x200)
    rvz.write('RVZ\u0001', 0, 'latin1')
    gameCubeHeader('RMGE01', true).copy(rvz, 0x58, 0, 0x80)
    expect(await imageIds(await put(join(dir, 'b.rvz'), rvz), 'gamecube')).toEqual(['RMGE01'])
    const wbfs = Buffer.alloc(0x400)
    wbfs.write('WBFS', 0, 'latin1')
    wbfs[8] = 9
    gameCubeHeader('RSBE01', true).copy(wbfs, 0x200, 0, 0x100)
    expect(await imageIds(await put(join(dir, 'c.wbfs'), wbfs), 'gamecube')).toEqual(['RSBE01'])
    const ciso = Buffer.alloc(0x8000 + 0x100)
    ciso.write('CISO', 0, 'latin1')
    ciso.writeUInt32LE(0x200000, 4)
    ciso[8] = 1
    gameCubeHeader('GZ2E01').copy(ciso, 0x8000, 0, 0x100)
    expect(await imageIds(await put(join(dir, 'd.ciso'), ciso), 'gamecube')).toEqual(['GZ2E01'])
    expect(await imageIds(await put(join(dir, 'e.iso'), Buffer.alloc(0x100)), 'gamecube')).toEqual(
      []
    )
  })

  it("reads a 3DS cartridge and a Dreamcast .gdi's IP.BIN", async () => {
    const dir = await tempDir()
    const ncsd = Buffer.alloc(0x200)
    ncsd.write('NCSD', 0x100, 'latin1')
    ncsd.writeBigUInt64LE(0x00040000000ee000n, 0x108)
    expect(await imageIds(await put(join(dir, 'g.3ds'), ncsd), '3ds')).toEqual(['00040000000EE000'])
    const track3 = Buffer.alloc(2352 * 2)
    track3.fill(255, 1, 11)
    track3[15] = 1
    track3.write('SEGA SEGAKATANA', 16, 'latin1')
    track3.write('T-8101N   ', 16 + 0x40, 'latin1')
    await put(join(dir, 'track01.bin'), Buffer.alloc(2352))
    await put(join(dir, 'track03.bin'), track3)
    const gdi = await put(
      join(dir, 'game.gdi'),
      '3\n1 0 4 2352 track01.bin 0\n2 600 0 2352 track02.raw 0\n3 45000 4 2352 track03.bin 0\n'
    )
    expect(await imageIds(gdi, 'dreamcast')).toEqual(['T-8101N'])
  })

  it('reads a CHD through the reader: a DVD (2048-byte sectors) and a CD (2448-byte frames)', async () => {
    const dir = await tempDir()
    const chd = await put(join(dir, 'game.chd'), 'not read directly')
    const dvd = fakeChd(syntheticIso({ 'SYSTEM.CNF': PS2_CNF }, 300), 'dvd')
    expect(await imageIds(chd, 'serial', dvd)).toEqual(['SLUS-20999'])
    // One 256 KB slice covers the descriptor, the root and SYSTEM.CNF.
    expect(dvd.calls).toBe(1)
    const cd = fakeChd(rawCdImage(syntheticIso({ 'SYSTEM.CNF': PSX_CNF }), 2, 2448), 'cd')
    expect(await imageIds(chd, 'serial', cd)).toEqual(['SCUS-99998'])
    const gc = fakeChd(gameCubeHeader('GALE01'), 'dvd')
    expect(await imageIds(chd, 'gamecube', gc)).toEqual(['GALE01'])
    // No reader (no helper): nothing from the image.
    expect(await imageIds(chd, 'serial')).toEqual([])
    const broken: ChdReader = async () => null
    expect(await imageIds(chd, 'serial', broken)).toEqual([])
  })

  it('a game id reader adds the names, and reads an unchanged file once', async () => {
    const dir = await tempDir()
    const chd = await put(join(dir, 'SLUS-20777', 'God of War [SLUS-20778].chd'), 'x')
    const dvd = fakeChd(syntheticIso({ 'SYSTEM.CNF': PS2_CNF }, 300), 'dvd')
    const reader = createGameIdReader(dvd)
    expect(await reader.ids(chd, 'serial')).toEqual(['SLUS-20999', 'SLUS-20778', 'SLUS-20777'])
    expect(await reader.ids(chd, 'serial')).toEqual(['SLUS-20999', 'SLUS-20778', 'SLUS-20777'])
    expect(dvd.calls).toBe(1)
    // Changed (another size): read again.
    await fs.writeFile(chd, 'xy')
    await reader.ids(chd, 'serial')
    expect(dvd.calls).toBe(2)
    // A folder game: its name only; a missing path: nothing.
    expect(await reader.ids(join(dir, 'SLUS-20777'), 'serial')).toEqual(['SLUS-20777'])
    expect(await reader.ids(join(dir, 'gone.iso'), 'serial')).toEqual([])
  })
})

/** A v1 CSO of `iso` (2048-byte blocks, all deflated). */
function buildCso(iso: Buffer): Buffer {
  const blockSize = 2048
  const blocks = iso.length / blockSize
  const parts: Buffer[] = []
  const index: number[] = []
  let at = 0x18 + (blocks + 1) * 4
  for (let i = 0; i < blocks; i++) {
    const data = deflateRawSync(iso.subarray(i * blockSize, (i + 1) * blockSize))
    index.push(at)
    parts.push(data)
    at += data.length
  }
  index.push(at)
  const head = Buffer.alloc(0x18 + index.length * 4)
  head.write('CISO', 0, 'latin1')
  head.writeUInt32LE(0x18, 4)
  head.writeBigUInt64LE(BigInt(iso.length), 8)
  head.writeUInt32LE(blockSize, 16)
  head[20] = 1
  index.forEach((v, i) => head.writeUInt32LE(v, 0x18 + i * 4))
  return Buffer.concat([head, ...parts])
}

describe('ids in images: sheets, CSO names, CHD reads', () => {
  it("an .m3u gives every disc's ids; a .cue keeps its first track's", async () => {
    const dir = await tempDir()
    const cnf = (serial: string): string => `BOOT2 = cdrom0:${BS}${serial};1\r\n`
    await put(join(dir, 'Disc 1.iso'), syntheticIso({ 'SYSTEM.CNF': cnf('SLUS_201.01') }))
    await put(join(dir, 'Disc 2.iso'), syntheticIso({ 'SYSTEM.CNF': cnf('SLUS_201.02') }))
    const m3u = await put(join(dir, 'Game.m3u'), 'Disc 1.iso\nDisc 2.iso\nDisc 1.iso\n')
    expect(await imageIds(m3u, 'serial')).toEqual(['SLUS-20101', 'SLUS-20102'])
    const cue = await put(
      join(dir, 'Two.cue'),
      'FILE "Disc 1.iso" BINARY\r\n  TRACK 01 MODE1/2048\r\nFILE "Disc 2.iso" BINARY\r\n  TRACK 02 MODE1/2048\r\n'
    )
    expect(await imageIds(cue, 'serial')).toEqual(['SLUS-20101'])
  })

  it('reads a PSP CSO named .ciso', async () => {
    const dir = await tempDir()
    const iso = syntheticIso({ 'UMD_DATA.BIN': 'ULUS-10041|x' }, 40)
    expect(await imageIds(await put(join(dir, 'game.ciso'), buildCso(iso)), 'serial')).toEqual([
      'ULUS-10041'
    ])
    // A plain ISO named .ciso still reads as one.
    expect(await imageIds(await put(join(dir, 'plain.ciso'), iso), 'serial')).toEqual([
      'ULUS-10041'
    ])
  })

  it('tries both sector layouts on a CHD classified neither CD nor DVD, and the GameCube header on any but a CD', async () => {
    const dir = await tempDir()
    const chd = await put(join(dir, 'game.chd'), 'not read directly')
    const iso = syntheticIso({ 'SYSTEM.CNF': PS2_CNF }, 300)
    expect(await imageIds(chd, 'serial', fakeChd(iso, 'unknown'))).toEqual(['SLUS-20999'])
    const raw = rawCdImage(syntheticIso({ 'SYSTEM.CNF': PSX_CNF }), 2, 2448)
    expect(await imageIds(chd, 'serial', fakeChd(raw, 'hdd'))).toEqual(['SCUS-99998'])
    expect(await imageIds(chd, 'gamecube', fakeChd(gameCubeHeader('GALE01'), 'unknown'))).toEqual([
      'GALE01'
    ])
    expect(await imageIds(chd, 'gamecube', fakeChd(gameCubeHeader('GALE01'), 'hdd'))).toEqual([
      'GALE01'
    ])
    expect(await imageIds(chd, 'gamecube', fakeChd(gameCubeHeader('GALE01'), 'cd'))).toEqual([])
    // Not a disc header: nothing.
    expect(await imageIds(chd, 'gamecube', fakeChd(Buffer.alloc(0x100), 'hdd'))).toEqual([])
  })

  it('does not keep a result whose CHD read went unanswered past a minute', async () => {
    const dir = await tempDir()
    const chd = await put(join(dir, 'Game [SLUS-20778].chd'), 'x')
    const good = fakeChd(syntheticIso({ 'SYSTEM.CNF': PS2_CNF }, 300), 'dvd')
    let answer = false
    let calls = 0
    const flaky: ChdReader = async (path, offset, length) => {
      calls++
      return answer ? good(path, offset, length) : null
    }
    let t = 1_000_000
    const reader = createGameIdReader(flaky, () => t)
    expect((await imageIdsChecked(chd, 'serial', flaky)).complete).toBe(false)
    calls = 0
    expect(await reader.ids(chd, 'serial')).toEqual(['SLUS-20778'])
    answer = true
    // Within the minute: kept.
    t += 30_000
    expect(await reader.ids(chd, 'serial')).toEqual(['SLUS-20778'])
    expect(calls).toBe(1)
    // After it: read again, and the full result is kept for good.
    t += 31_000
    expect(await reader.ids(chd, 'serial')).toEqual(['SLUS-20999', 'SLUS-20778'])
    const after = calls
    t += 10 * 60_000
    expect(await reader.ids(chd, 'serial')).toEqual(['SLUS-20999', 'SLUS-20778'])
    expect(calls).toBe(after)
    // A throwing reader counts as unanswered too.
    const throwing: ChdReader = async () => {
      throw new Error('helper missing')
    }
    expect(await imageIdsChecked(chd, 'serial', throwing)).toEqual({ ids: [], complete: false })
    expect(await imageIdsChecked(chd, 'serial', good)).toEqual({
      ids: ['SLUS-20999'],
      complete: true
    })
  })

  it('stops reading at its deadline, keeping the ids in the name, marked incomplete', async () => {
    const dir = await tempDir()
    const chd = await put(join(dir, 'Game [SLUS-20778].chd'), 'x')
    let calls = 0
    const stuck: ChdReader = () => {
      calls++
      return new Promise(() => {})
    }
    const deadline = new AbortController()
    setTimeout(() => deadline.abort(), 20)
    const reader = createGameIdReader(stuck)
    expect(await reader.idsChecked(chd, 'serial', deadline.signal)).toEqual({
      ids: ['SLUS-20778'],
      complete: false
    })
    expect(calls).toBe(1)
    // Already past it: no read is made at all.
    expect(await imageIdsChecked(chd, 'serial', stuck, deadline.signal)).toEqual({
      ids: [],
      complete: false
    })
    expect(calls).toBe(1)
  })
})

describe('chdRead', () => {
  it('kills a helper that does not finish in time and answers null', async () => {
    let killed = false
    const stuck: HelperRun = (_exe, _args, _onLine, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          killed = true
          resolve(1)
        })
      })
    expect(await chdRead('helper.exe', 'game.chd', 0, 16, stuck, 50)).toBeNull()
    expect(killed).toBe(true)
    const ok: HelperRun = async (_exe, _args, onLine) => {
      onLine(
        JSON.stringify({
          type: 'done',
          classification: 'dvd',
          imageBytes: 4,
          data: Buffer.from('abcd').toString('base64')
        })
      )
      return 0
    }
    expect(await chdRead('helper.exe', 'game.chd', 0, 16, ok, 50)).toEqual({
      classification: 'dvd',
      imageBytes: 4,
      data: Buffer.from('abcd')
    })
  })
})

// The real helper (resources\xbox) on synthetic CHDs (fixtures/: a PS2 DVD and a PlayStation CD made from synthetic
// ISO 9660 images holding only a SYSTEM.CNF, encoded with CHDSharp).
const REAL_HELPER = resolve(__dirname, '..', '..', '..', 'resources', 'xbox', 'PlayOutXbox.exe')
const FIXTURES = join(__dirname, 'fixtures')

describe.runIf(process.platform === 'win32' && existsSync(REAL_HELPER))(
  "the real Xbox helper's read command",
  () => {
    it('reads the serial of a PS2 DVD CHD and a PlayStation CD CHD', async () => {
      const read: ChdReader = (path, offset, length) => chdRead(REAL_HELPER, path, offset, length)
      const spy = vi.fn(read)
      expect(await imageIds(join(FIXTURES, 'synthetic-ps2-dvd.chd'), 'serial', spy)).toEqual([
        'SLUS-20999'
      ])
      expect(await imageIds(join(FIXTURES, 'synthetic-psx-cd.chd'), 'serial', spy)).toEqual([
        'SCUS-99998'
      ])
      const slice = await chdRead(REAL_HELPER, join(FIXTURES, 'synthetic-psx-cd.chd'), 0, 16)
      expect(slice).toMatchObject({ classification: 'cd' })
      expect(slice!.data.subarray(0, 12).toString('hex')).toBe('00ffffffffffffffffffff00')
      // Past the end: nothing; not a CHD: null.
      expect(
        (await chdRead(REAL_HELPER, join(FIXTURES, 'synthetic-ps2-dvd.chd'), 10 ** 9, 16))?.data
          .length
      ).toBe(0)
      expect(await chdRead(REAL_HELPER, __filename, 0, 16)).toBeNull()
    }, 60_000)
  }
)
