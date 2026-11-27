import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RA_CONSOLE, canHash, hashBuffer, matchTitle, raConsoleFor, raHashRom } from './ra-hash'

const md5 = (...parts: (Buffer | string)[]): string => {
  const hash = createHash('md5')
  for (const p of parts) hash.update(p)
  return hash.digest('hex')
}

/** `size` bytes of a deterministic, non-repeating-looking pattern. */
function bytes(size: number, seed = 1): Buffer {
  const out = Buffer.alloc(size)
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 17 + (i >> 8)) & 0xff
  return out
}

interface ZipEntry {
  name: string
  data: Buffer
  method?: 0 | 8
}

/** A minimal zip: a local header per entry, a central directory and an end-of-central-directory record. */
function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const method = entry.method ?? 8
    const name = Buffer.from(entry.name, 'utf8')
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14) // crc32: not checked by the reader
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += 30 + name.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(dir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, eocd])
}

const nesRom = (body: Buffer): Buffer =>
  Buffer.concat([Buffer.from('NES\x1a', 'latin1'), Buffer.alloc(12, 0xaa), body])

describe('hashBuffer', () => {
  it('strips the iNES and FDS headers', () => {
    const body = bytes(0x4000)
    expect(hashBuffer(nesRom(body), RA_CONSOLE.nes)).toBe(md5(body))
    const fds = Buffer.concat([Buffer.from('FDS\x1a', 'latin1'), Buffer.alloc(12, 1), body])
    expect(hashBuffer(fds, RA_CONSOLE.fds)).toBe(md5(body))
    expect(hashBuffer(fds, RA_CONSOLE.nes)).toBe(md5(body))
  })

  it('hashes a headerless NES ROM whole', () => {
    const body = bytes(0x4000)
    expect(hashBuffer(body, RA_CONSOLE.nes)).toBe(md5(body))
    // A bare 16-byte header has nothing after it: hashed as is.
    const header = Buffer.concat([Buffer.from('NES\x1a', 'latin1'), Buffer.alloc(12)])
    expect(hashBuffer(header, RA_CONSOLE.nes)).toBe(md5(header))
  })

  it('strips a 512-byte SNES copier header', () => {
    const body = bytes(0x8000)
    const headered = Buffer.concat([Buffer.alloc(512, 0xff), body])
    expect(hashBuffer(headered, RA_CONSOLE.snes)).toBe(md5(body))
    expect(hashBuffer(body, RA_CONSOLE.snes)).toBe(md5(body))
    const odd = bytes(1000)
    expect(hashBuffer(odd, RA_CONSOLE.snes)).toBe(md5(odd))
  })

  it('strips the Lynx header', () => {
    const body = bytes(0x2000)
    const header = Buffer.alloc(64, 3)
    header.write('LYNX\0', 0, 'latin1')
    expect(hashBuffer(Buffer.concat([header, body]), RA_CONSOLE.lynx)).toBe(md5(body))
    expect(hashBuffer(body, RA_CONSOLE.lynx)).toBe(md5(body))
  })

  it('strips the Atari 7800 header', () => {
    const body = bytes(0x4000)
    const header = Buffer.alloc(128, 0)
    header[0] = 1
    header.write('ATARI7800', 1, 'latin1')
    expect(hashBuffer(Buffer.concat([header, body]), RA_CONSOLE.atari7800)).toBe(md5(body))
    expect(hashBuffer(body, RA_CONSOLE.atari7800)).toBe(md5(body))
  })

  it('strips the PC Engine header only when the size is a multiple of 128 KiB plus 512 (rcheevos)', () => {
    const body = bytes(0x20000)
    const headered = Buffer.concat([Buffer.alloc(512, 9), body])
    expect(hashBuffer(headered, RA_CONSOLE.pcengine)).toBe(md5(body))
    expect(hashBuffer(body, RA_CONSOLE.pcengine)).toBe(md5(body))
    // A 32 KiB HuCard with a header: 512 bit set, but not 128 KiB-aligned, so it is hashed whole.
    const small = Buffer.concat([Buffer.alloc(512, 9), bytes(0x8000)])
    expect(hashBuffer(small, RA_CONSOLE.pcengine)).toBe(md5(small))
  })

  it('gives the same N64 hash for .z64, .v64 and .n64 byte orders', () => {
    const z64 = bytes(0x1000)
    z64.set([0x80, 0x37, 0x12, 0x40], 0)
    const v64 = Buffer.alloc(z64.length)
    for (let i = 0; i < z64.length; i += 2) {
      v64[i] = z64[i + 1]
      v64[i + 1] = z64[i]
    }
    const n64 = Buffer.alloc(z64.length)
    for (let i = 0; i < z64.length; i += 4) {
      n64[i] = z64[i + 3]
      n64[i + 1] = z64[i + 2]
      n64[i + 2] = z64[i + 1]
      n64[i + 3] = z64[i]
    }
    expect(v64[0]).toBe(0x37)
    expect(n64[0]).toBe(0x40)
    const expected = md5(z64)
    expect(hashBuffer(z64, RA_CONSOLE.n64)).toBe(expected)
    expect(hashBuffer(v64, RA_CONSOLE.n64)).toBe(expected)
    expect(hashBuffer(n64, RA_CONSOLE.n64)).toBe(expected)
    // The input buffer is not swapped in place.
    expect(v64[0]).toBe(0x37)
  })

  it('returns null for an N64 file in no known byte order', () => {
    expect(hashBuffer(Buffer.from([0x12, 0x34, 0x56, 0x78]), RA_CONSOLE.n64)).toBeNull()
  })

  describe('Nintendo DS', () => {
    function ndsRom(size: number, iconOffset: number): Buffer {
      const rom = bytes(size, 5)
      rom.writeUInt32LE(0x4000, 0x20) // arm9 offset
      rom.writeUInt32LE(0x800, 0x2c) // arm9 size
      rom.writeUInt32LE(0x5000, 0x30) // arm7 offset
      rom.writeUInt32LE(0x400, 0x3c) // arm7 size
      rom.writeUInt32LE(iconOffset, 0x68)
      return rom
    }

    it('hashes the header, the ARM9 and ARM7 code and the icon block', () => {
      const rom = ndsRom(0x8000, 0x6000)
      const expected = md5(
        rom.subarray(0, 0x160),
        rom.subarray(0x4000, 0x4800),
        rom.subarray(0x5000, 0x5400),
        rom.subarray(0x6000, 0x6a00)
      )
      expect(hashBuffer(rom, RA_CONSOLE.nds)).toBe(expected)
    })

    it('pads a block that runs past the end of the file with zeros', () => {
      const rom = ndsRom(0x6400, 0x6000)
      const icon = Buffer.alloc(0xa00)
      rom.copy(icon, 0, 0x6000)
      const expected = md5(
        rom.subarray(0, 0x160),
        rom.subarray(0x4000, 0x4800),
        rom.subarray(0x5000, 0x5400),
        icon
      )
      expect(hashBuffer(rom, RA_CONSOLE.nds)).toBe(expected)
    })

    it('skips a SuperCard loader in front of the ROM', () => {
      const rom = ndsRom(0x8000, 0x6000)
      const loader = Buffer.alloc(0x200)
      loader.writeUInt32BE(0x2e0000ea, 0)
      loader.writeUInt32BE(0x44469600, 0xb0)
      expect(hashBuffer(Buffer.concat([loader, rom]), RA_CONSOLE.nds)).toBe(
        hashBuffer(rom, RA_CONSOLE.nds)
      )
    })

    it('returns null for a file shorter than the header', () => {
      expect(hashBuffer(Buffer.alloc(0x100), RA_CONSOLE.nds)).toBeNull()
    })
  })

  it('hashes the whole file for other consoles', () => {
    const data = bytes(0x3000)
    for (const id of [RA_CONSOLE.gb, RA_CONSOLE.gba, RA_CONSOLE.megadrive, RA_CONSOLE.atari2600])
      expect(hashBuffer(data, id)).toBe(md5(data))
  })
})

describe('raHashRom', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-rahash-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('hashes a plain ROM file with the console rules', async () => {
    const body = bytes(0x4000)
    const nes = join(dir, 'game.nes')
    await fs.writeFile(nes, nesRom(body))
    expect(await raHashRom(nes, RA_CONSOLE.nes)).toBe(md5(body))
    const gb = join(dir, 'game.gb')
    await fs.writeFile(gb, body)
    expect(await raHashRom(gb, RA_CONSOLE.gb)).toBe(md5(body))
  })

  it('hashes the ROM inside a deflated zip', async () => {
    const body = bytes(0x4000)
    const zip = join(dir, 'game.zip')
    await fs.writeFile(zip, buildZip([{ name: 'Game (USA).nes', data: nesRom(body) }]))
    expect(await raHashRom(zip, RA_CONSOLE.nes)).toBe(md5(body))
  })

  it('hashes the ROM inside a stored zip', async () => {
    const body = bytes(0x2000, 3)
    const zip = join(dir, 'game.zip')
    await fs.writeFile(zip, buildZip([{ name: 'game.gba', data: body, method: 0 }]))
    expect(await raHashRom(zip, RA_CONSOLE.gba)).toBe(md5(body))
  })

  it('skips text files and folders in a zip', async () => {
    const body = bytes(0x2000, 4)
    const zip = join(dir, 'game.zip')
    await fs.writeFile(
      zip,
      buildZip([
        { name: 'readme.txt', data: Buffer.from('not the rom') },
        { name: 'roms/', data: Buffer.alloc(0), method: 0 },
        { name: 'roms/game.gb', data: body }
      ])
    )
    expect(await raHashRom(zip, RA_CONSOLE.gb)).toBe(md5(body))
  })

  it('returns null for a zip with no ROM in it', async () => {
    const zip = join(dir, 'game.zip')
    await fs.writeFile(zip, buildZip([{ name: 'info.nfo', data: Buffer.from('nothing') }]))
    expect(await raHashRom(zip, RA_CONSOLE.gb)).toBeNull()
  })

  it('returns null for a directory, a 7z, an empty file and a disc console', async () => {
    expect(await raHashRom(dir, RA_CONSOLE.gb)).toBeNull()
    const sevenZip = join(dir, 'game.7z')
    await fs.writeFile(sevenZip, bytes(100))
    expect(await raHashRom(sevenZip, RA_CONSOLE.gb)).toBeNull()
    const empty = join(dir, 'empty.gb')
    await fs.writeFile(empty, Buffer.alloc(0))
    expect(await raHashRom(empty, RA_CONSOLE.gb)).toBeNull()
    const bin = join(dir, 'game.bin')
    await fs.writeFile(bin, bytes(2048))
    expect(await raHashRom(bin, RA_CONSOLE.psx)).toBeNull()
    expect(await raHashRom(join(dir, 'missing.iso'), RA_CONSOLE.saturn)).toBeNull()
  })

  it('hashes an arcade set by its name', async () => {
    expect(await raHashRom(join(dir, 'galaga.zip'), RA_CONSOLE.arcade)).toBe(md5('galaga'))
    expect(await raHashRom(join(dir, 'mame', 'sf2.7z'), RA_CONSOLE.arcade)).toBe(md5('sf2'))
  })

  it('prefixes an FBNeo console set with its folder', async () => {
    expect(await raHashRom(join(dir, 'nes', 'smb.zip'), RA_CONSOLE.arcade)).toBe(md5('nes_smb'))
    expect(await raHashRom(join(dir, 'MegaDrive', 'sonic.zip'), RA_CONSOLE.arcade)).toBe(
      md5('megadrive_sonic')
    )
  })
})

describe('raConsoleFor', () => {
  it('maps PlayOut systems and their aliases', () => {
    expect(raConsoleFor('nes')).toBe(RA_CONSOLE.nes)
    expect(raConsoleFor('famicom')).toBe(RA_CONSOLE.nes)
    expect(raConsoleFor('sfc')).toBe(RA_CONSOLE.snes)
    expect(raConsoleFor('genesis')).toBe(RA_CONSOLE.megadrive)
    expect(raConsoleFor('megadrive')).toBe(RA_CONSOLE.megadrive)
    expect(raConsoleFor('tg16')).toBe(RA_CONSOLE.pcengine)
    expect(raConsoleFor('tg-cd')).toBe(RA_CONSOLE.pcenginecd)
    expect(raConsoleFor('atarilynx')).toBe(RA_CONSOLE.lynx)
    expect(raConsoleFor('fbneo')).toBe(RA_CONSOLE.arcade)
    expect(raConsoleFor('gc')).toBe(RA_CONSOLE.gamecube)
  })

  it('ignores case and returns null for unknown systems', () => {
    expect(raConsoleFor('SNES')).toBe(RA_CONSOLE.snes)
    expect(raConsoleFor('switch')).toBeNull()
    expect(raConsoleFor('')).toBeNull()
  })
})

describe('canHash', () => {
  it('is false for disc consoles only', () => {
    for (const id of [RA_CONSOLE.psx, RA_CONSOLE.ps2, RA_CONSOLE.saturn, RA_CONSOLE.dreamcast])
      expect(canHash(id)).toBe(false)
    for (const id of [RA_CONSOLE.nes, RA_CONSOLE.snes, RA_CONSOLE.n64, RA_CONSOLE.arcade])
      expect(canHash(id)).toBe(true)
  })
})

describe('matchTitle', () => {
  it('drops region and revision tags', () => {
    expect(matchTitle('Super Mario World (USA)')).toBe('super mario world')
    expect(matchTitle('Super Mario Bros. 3 (USA) (Rev 1) [!]')).toBe('super mario bros 3')
  })

  it('moves a trailing ", The" out of the way', () => {
    expect(matchTitle('Legend of Zelda, The - A Link to the Past (USA)')).toBe(
      'legend of zelda a link to the past'
    )
    expect(matchTitle('The Legend of Zelda: A Link to the Past')).toBe(
      'legend of zelda a link to the past'
    )
  })

  it('drops leading articles', () => {
    expect(matchTitle('A Boy and His Blob')).toBe('boy and his blob')
    expect(matchTitle('An American Tail')).toBe('american tail')
    // Only whole words: "Theme Park" keeps its first word.
    expect(matchTitle('Theme Park')).toBe('theme park')
  })

  it('removes punctuation and spells out "&"', () => {
    expect(matchTitle('Sonic & Knuckles')).toBe('sonic and knuckles')
    expect(matchTitle("Kirby's Dream Land 2")).toBe('kirby s dream land 2')
    expect(matchTitle('Mega Man X3!!')).toBe('mega man x3')
  })

  it('strips accents and hack tags', () => {
    expect(matchTitle('Pokémon Stadium (Europe)')).toBe('pokemon stadium')
    expect(matchTitle('~Hack~ Super Metroid Redesign')).toBe('super metroid redesign')
  })
})
