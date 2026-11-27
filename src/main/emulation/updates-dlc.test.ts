import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { oldPs3HddDir, ps3Dev0Dir, updatesDlcDir } from './ps3-hdd'
import {
  gameWords,
  hasUpdatesDlc,
  switchGameKey,
  updatesDlcOf,
  type UpdatesDlcGame
} from './updates-dlc'

/** A PARAM.SFO with these string entries (format 0x0204, utf8 with a trailing null). */
function sfo(entries: Record<string, string>): Buffer {
  const keys = Object.keys(entries)
  const keyTable = Buffer.from(keys.map((k) => `${k}\0`).join(''), 'latin1')
  const values = keys.map((k) => Buffer.from(`${entries[k]}\0`, 'latin1'))
  const indexSize = 16 * keys.length
  const keyStart = 20 + indexSize
  const dataStart = keyStart + keyTable.length
  const header = Buffer.alloc(20)
  header.writeUInt32BE(0x00505346, 0)
  header.writeUInt32LE(0x0101, 4)
  header.writeUInt32LE(keyStart, 8)
  header.writeUInt32LE(dataStart, 12)
  header.writeUInt32LE(keys.length, 16)
  const index = Buffer.alloc(indexSize)
  let keyOffset = 0
  let dataOffset = 0
  keys.forEach((k, i) => {
    index.writeUInt16LE(keyOffset, i * 16)
    index.writeUInt16LE(0x0204, i * 16 + 2)
    index.writeUInt32LE(values[i].length, i * 16 + 4)
    index.writeUInt32LE(values[i].length, i * 16 + 8)
    index.writeUInt32LE(dataOffset, i * 16 + 12)
    keyOffset += k.length + 1
    dataOffset += values[i].length
  })
  return Buffer.concat([header, index, keyTable, ...values])
}

let dir: string
let emu: string
let roms: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-updates-dlc-'))
  emu = join(dir, 'Emulation')
  roms = join(dir, 'roms')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function put(path: string, data: string | Buffer = 'x'): Promise<string> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, data)
  return path
}

const sorted = (items: { path: string }[]): string[] =>
  items.map((i) => i.path.split(/[\\/]/).pop()!).sort()

describe('gameWords', () => {
  it('keeps the words naming the game', () => {
    expect(gameWords('Zelda BOTW [Update v1.6.0].nsp', true)).toEqual(['zelda', 'botw'])
    expect(gameWords('Zelda BOTW.xci', true)).toEqual(['zelda', 'botw'])
    expect(gameWords('Halo 3 (USA) {DLC}.iso', true)).toEqual(['halo', '3'])
    expect(gameWords('Game v65536.nsp', true)).toEqual(['game'])
    expect(gameWords('Game 1.0.2 Update.nsp', true)).toEqual(['game'])
    expect(gameWords('Pokémon_Sword.Patch', false)).toEqual(['pokemon', 'sword'])
    expect(gameWords('The Witcher 3 - Base', false)).toEqual(['witcher', '3'])
    // A folder keeps what looks like an extension.
    expect(gameWords('Some.Game', false)).toEqual(['some', 'game'])
    expect(gameWords('Some.Game', true)).toEqual(['some'])
  })
})

describe('hasUpdatesDlc', () => {
  it('is true for Switch, PS3 and Xbox 360 only', () => {
    expect(['switch', 'ps3', 'xbox360'].every(hasUpdatesDlc)).toBe(true)
    expect(hasUpdatesDlc('psx')).toBe(false)
  })
})

describe('switchGameKey', () => {
  it("clears the low 13 bits: a game's update and DLC share its key, the next game does not", () => {
    expect(switchGameKey('0100A96014FD0000')).toBe('0100A96014FD0000')
    expect(switchGameKey('0100A96014FD0800')).toBe('0100A96014FD0000')
    expect(switchGameKey('0100A96014FD1001')).toBe('0100A96014FD0000')
    expect(switchGameKey('0100A96014FD1FFF')).toBe('0100A96014FD0000')
    // A base id with bit 13 set, and its DLC above it.
    expect(switchGameKey('01007EF00011E000')).toBe('01007EF00011E000')
    expect(switchGameKey('01007EF00011E800')).toBe('01007EF00011E000')
    expect(switchGameKey('01007EF00011F001')).toBe('01007EF00011E000')
    // The game 0x2000 above is another game.
    expect(switchGameKey('0100ABCD12342800')).toBe('0100ABCD12342000')
    expect(switchGameKey('0100ABCD12342800')).not.toBe(switchGameKey('0100ABCD12340000'))
  })
})

describe('updatesDlcOf: PS3', () => {
  async function ps3Folder(name: string, serial: string): Promise<UpdatesDlcGame> {
    const romPath = join(roms, 'ps3', name)
    await put(join(romPath, 'PS3_GAME', 'PARAM.SFO'), sfo({ TITLE_ID: serial, APP_VER: '01.00' }))
    return { id: `rom:${name}`, systemId: 'ps3', romPath }
  }

  async function ps3SerialFile(name: string, serial: string): Promise<UpdatesDlcGame> {
    const romPath = await put(join(roms, 'ps3', name), `${serial}\n`)
    return { id: `rom:${name}`, systemId: 'ps3', romPath }
  }

  async function hdd(dev0: string): Promise<void> {
    for (const f of [
      'BLUS30443',
      'BLUS30443DATA',
      'blus30443GAMEDATA',
      'BLUS30444',
      'BLUS304431',
      'BLUS30443.playout-old',
      'BLUS30443.playout-new'
    ])
      await put(join(dev0, 'game', f, 'PARAM.SFO'), '12345')
    await put(join(dev0, 'game', 'BLUS30443', 'USRDIR', 'EBOOT.BIN'), '1234567890')
    // A file named after the serial is not a game folder.
    await put(join(dev0, 'game', 'BLUS30443.txt'), 'x')
    await put(join(dev0, 'exdata', 'UP9000-BLUS30443_00-LICENSE00000000.rap'), 'license')
    await put(join(dev0, 'home', '00000001', 'exdata', 'UP9000-BLUS30443_00-X.edat'), 'license')
  }

  it("lists the serial's folders in dev_hdd0\\game, with their size", async () => {
    await hdd(ps3Dev0Dir(emu))
    const game = await ps3Folder('Game', 'BLUS30443')
    const items = await updatesDlcOf(game, emu, [])
    expect(sorted(items)).toEqual(['BLUS30443', 'BLUS30443DATA', 'blus30443GAMEDATA'])
    const main = items.find((i) => i.path.endsWith('BLUS30443'))!
    expect(main.path).toBe(join(ps3Dev0Dir(emu), 'game', 'BLUS30443'))
    expect(main.bytes).toBe(15)
    // Never the licenses in exdata.
    expect(items.some((i) => /exdata/i.test(i.path))).toBe(false)
  })

  it('takes the serial of a .ps3 serial file', async () => {
    await hdd(ps3Dev0Dir(emu))
    const game = await ps3SerialFile('Serial.ps3', 'BLUS30444')
    expect(sorted(await updatesDlcOf(game, emu, []))).toEqual(['BLUS30444'])
  })

  it('leaves a serial another PS3 game of the library has', async () => {
    await hdd(ps3Dev0Dir(emu))
    const game = await ps3Folder('Game', 'BLUS30443')
    const copy = await ps3SerialFile('Copy.ps3', 'BLUS30443')
    expect(await updatesDlcOf(game, emu, [game, copy])).toEqual([])
    // Another system's game with the same serial in its name does not count.
    expect(
      sorted(
        await updatesDlcOf(game, emu, [
          { ...copy, systemId: 'psx' },
          await ps3SerialFile('Other.ps3', 'BLUS30444')
        ])
      )
    ).toEqual(['BLUS30443', 'BLUS30443DATA', 'blus30443GAMEDATA'])
  })

  it('reads the PS3 HDD that is in use (the old place while RPCS3 still uses it)', async () => {
    await hdd(join(oldPs3HddDir(emu), 'dev_hdd0'))
    const game = await ps3Folder('Game', 'BLUS30443')
    const items = await updatesDlcOf(game, emu, [])
    expect(sorted(items)).toEqual(['BLUS30443', 'BLUS30443DATA', 'blus30443GAMEDATA'])
    expect(items.every((i) => i.path.startsWith(oldPs3HddDir(emu)))).toBe(true)
  })

  it('lists nothing without a serial or a PS3 HDD', async () => {
    const game = await ps3Folder('Game', 'BLUS30443')
    expect(await updatesDlcOf(game, emu, [])).toEqual([])
    await hdd(ps3Dev0Dir(emu))
    const none = {
      id: 'rom:n',
      systemId: 'ps3',
      romPath: await put(join(roms, 'ps3', 'NoSerial.iso'))
    }
    expect(await updatesDlcOf(none, emu, [])).toEqual([])
  })
})

describe('updatesDlcOf: Switch and Xbox 360', () => {
  async function rom(systemId: string, name: string): Promise<UpdatesDlcGame> {
    const romPath = await put(join(roms, systemId, name))
    return { id: `rom:${name}`, systemId, romPath }
  }
  const switchDir = (): string => join(updatesDlcDir(emu), 'Switch')
  const xboxDir = (): string => join(updatesDlcDir(emu), 'Xbox360')

  it('matches Switch updates and DLC by title id', async () => {
    await put(join(switchDir(), 'Update [0100A96014FD0800][v65536].nsp'), '123')
    await put(join(switchDir(), 'Some DLC [0100A96014FD1001].nsp'))
    await put(join(switchDir(), 'Other Update [0100B12345670800].nsp'))
    // A similar name with another title id is another game's.
    await put(join(switchDir(), 'Game [0100C00000000800].nsp'))
    const game = await rom('switch', 'Game [0100A96014FD0000].nsp')
    const other = await rom('switch', 'Other [0100B12345670000].xci')
    const items = await updatesDlcOf(game, emu, [other])
    expect(sorted(items)).toEqual([
      'Some DLC [0100A96014FD1001].nsp',
      'Update [0100A96014FD0800][v65536].nsp'
    ])
    expect(items.find((i) => i.path.endsWith('[v65536].nsp'))!.bytes).toBe(3)
    expect(sorted(await updatesDlcOf(other, emu, [game]))).toEqual([
      'Other Update [0100B12345670800].nsp'
    ])
  })

  it('matches Switch entries by name', async () => {
    await put(join(switchDir(), 'Metroid Dread [Update v2.1.0].nsp'))
    await put(join(switchDir(), 'Metroid Prime Remastered [Update v1.0.1].nsp'))
    // PlayOut's own copies in progress or set aside are never listed.
    await put(join(switchDir(), 'Metroid Dread [Update v2.0.0].nsp.playout-old'))
    const game = await rom('switch', 'Metroid Dread.nsp')
    expect(sorted(await updatesDlcOf(game, emu, []))).toEqual(['Metroid Dread [Update v2.1.0].nsp'])
  })

  it('gives an entry to the closest name only', async () => {
    await put(join(switchDir(), 'Mario Kart 8 Deluxe Update.nsp'))
    const mk8 = await rom('switch', 'Mario Kart 8.xci')
    const deluxe = await rom('switch', 'Mario Kart 8 Deluxe.xci')
    expect(await updatesDlcOf(mk8, emu, [deluxe])).toEqual([])
    expect(sorted(await updatesDlcOf(deluxe, emu, [mk8]))).toEqual([
      'Mario Kart 8 Deluxe Update.nsp'
    ])
    // Without Deluxe in the library it is still not Mario Kart 8's: names must match, not just begin alike.
    expect(await updatesDlcOf(mk8, emu, [])).toEqual([])
  })

  it('never claims a sequel or spin-off that is not in the library', async () => {
    await put(join(switchDir(), 'DOOM Eternal [01001E400D9F8800][v2.0].nsp'))
    await put(join(switchDir(), 'Halo 3 ODST [TU2].zip'))
    expect(await updatesDlcOf(await rom('switch', 'Doom.nsp'), emu, [])).toEqual([])
    expect(await updatesDlcOf(await rom('switch', 'Halo 3.xci'), emu, [])).toEqual([])
  })

  it('keeps Switch games whose ids share their first 12 digits apart', async () => {
    await put(join(switchDir(), 'Other [0100ABCD12342800].nsp'))
    await put(join(switchDir(), 'Mine [0100ABCD12341001].nsp'))
    const game = await rom('switch', 'Mine [0100ABCD12340000].xci')
    expect(sorted(await updatesDlcOf(game, emu, []))).toEqual(['Mine [0100ABCD12341001].nsp'])
  })

  it('keeps numbered games apart', async () => {
    await put(join(switchDir(), 'Halo 3 [Update v2].nsp'))
    await put(join(switchDir(), 'Halo 4 DLC.nsp'))
    const halo3 = await rom('switch', 'Halo 3.xci')
    const halo4 = await rom('switch', 'Halo 4.xci')
    expect(sorted(await updatesDlcOf(halo3, emu, [halo4]))).toEqual(['Halo 3 [Update v2].nsp'])
    expect(sorted(await updatesDlcOf(halo4, emu, [halo3]))).toEqual(['Halo 4 DLC.nsp'])
  })

  it('gives a tied entry to nobody', async () => {
    await put(join(switchDir(), 'Zelda [Update v1.6.0].nsp'))
    const a = await rom('switch', 'Zelda.xci')
    const b = { ...(await rom('switch', 'Zelda.nsp')), id: 'rom:zelda-2' }
    expect(await updatesDlcOf(a, emu, [b])).toEqual([])
    expect(await updatesDlcOf(b, emu, [a])).toEqual([])
    // Another system's game is no rival.
    expect(sorted(await updatesDlcOf(a, emu, [{ ...b, systemId: 'xbox360' }]))).toEqual([
      'Zelda [Update v1.6.0].nsp'
    ])
  })

  it('matches Xbox 360 content by title id, and by name', async () => {
    await put(join(xboxDir(), '4D5307E6', '000B0000', 'TU.bin'), '1234')
    await put(join(xboxDir(), '4D530877', '00000002', 'DLC.bin'))
    await put(join(xboxDir(), 'Gears of War DLC', 'map.bin'))
    // A bare number is not a title id: it is compared by name, and does not match.
    await put(join(xboxDir(), '20240101', 'x.bin'))
    const halo = await rom('xbox360', 'Halo 3 [4D5307E6].iso')
    const gears = await rom('xbox360', 'Gears of War.iso')
    const items = await updatesDlcOf(halo, emu, [gears])
    expect(sorted(items)).toEqual(['4D5307E6'])
    expect(items[0]!.bytes).toBe(4)
    expect(sorted(await updatesDlcOf(gears, emu, [halo]))).toEqual(['Gears of War DLC'])
  })

  it('matches nothing for a name too short to tell games apart', async () => {
    await put(join(switchDir(), 'AB Update.nsp'))
    await put(join(switchDir(), 'DLC.nsp'))
    expect(await updatesDlcOf(await rom('switch', 'AB.nsp'), emu, [])).toEqual([])
    expect(await updatesDlcOf(await rom('switch', 'DLC.nsp'), emu, [])).toEqual([])
  })

  it('lists nothing for other systems or a missing folder', async () => {
    expect(await updatesDlcOf(await rom('switch', 'Metroid Dread.nsp'), emu, [])).toEqual([])
    expect(await updatesDlcOf(await rom('psx', 'Metroid Dread.cue'), emu, [])).toEqual([])
  })
})
