import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { oldPs3HddDir, ps3Dev0Dir, updatesDlcDir } from './ps3-hdd'
import {
  gameWords,
  hasUpdatesDlc,
  switchGameKey,
  updatesDlcEntriesFor,
  updatesDlcFiles,
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

  describe('similar names (a host download sends these with the game)', () => {
    const TOTK_ROM =
      'The Legend of Zelda Tears of the Kingdom [0100F2C0115B6000]+[v1.2.1][US](nsw2u.com).xci'
    const TOTK_TITLE = 'The Legend of Zelda: Tears of the Kingdom'
    async function totk(name = TOTK_ROM, titles = [TOTK_TITLE]): Promise<UpdatesDlcGame> {
      return { ...(await rom('switch', name)), titles }
    }

    it("matches Tears of the Kingdom's update by id or by its title, whichever of the game's names", async () => {
      await put(join(switchDir(), 'The Legend of Zelda Tears of the Kingdom [Update] v1.2.1.nsp'))
      await put(join(switchDir(), '[0100F2C0115B6800][v1.2.1].nsp'))
      await put(join(switchDir(), 'Tears of the Kingdom Update v1.2.1.nsp'))
      await put(join(switchDir(), 'Zelda - Tears of the Kingdom (US) NSP DLC.nsp'))
      await put(join(switchDir(), 'The Legend of Zelda Tears of the Kingdom US NSP Update.nsp'))
      // An abbreviation is not the game's name.
      await put(join(switchDir(), 'Zelda TotK Update.nsp'))
      const want = [
        'The Legend of Zelda Tears of the Kingdom US NSP Update.nsp',
        'The Legend of Zelda Tears of the Kingdom [Update] v1.2.1.nsp',
        'Zelda - Tears of the Kingdom (US) NSP DLC.nsp',
        '[0100F2C0115B6800][v1.2.1].nsp',
        'Tears of the Kingdom Update v1.2.1.nsp'
      ].sort()
      expect(sorted(await updatesDlcEntriesFor(await totk(), emu, []))).toEqual(want)
      // Without the card's subtitle, the shortened names are not the game's (a series name in front is not known).
      expect(sorted(await updatesDlcEntriesFor(await totk(TOTK_ROM, []), emu, []))).toEqual(
        want.filter((n) => !n.startsWith('Tears') && !n.startsWith('Zelda -'))
      )
      // "Delete from this PC" takes the exact matches only.
      expect(sorted(await updatesDlcOf(await totk(), emu, []))).toEqual(
        want.filter((n) => !n.startsWith('Tears') && !n.startsWith('Zelda -'))
      )
      // A ROM named only by its id gets them through its card title.
      const byTitle = await totk('0100F2C0115B6000.xci', [
        'The Legend of Zelda Tears of the Kingdom+',
        'The Legend of Zelda: Tears of the Kingdom'
      ])
      expect(sorted(await updatesDlcEntriesFor(byTitle, emu, []))).toEqual(want)
      const short = await totk('TotK.xci', ['The Legend of Zelda: Tears of the Kingdom'])
      expect(sorted(await updatesDlcEntriesFor(short, emu, []))).toEqual(
        want.filter((n) => n !== '[0100F2C0115B6800][v1.2.1].nsp')
      )
    })

    it('lets the title id decide over the name', async () => {
      // The same name with another game's id (another region's) is not this game's.
      await put(
        join(switchDir(), 'The Legend of Zelda Tears of the Kingdom [0100AAAA00000800].nsp')
      )
      // An id of the game under any name is.
      await put(join(switchDir(), 'Something else [0100F2C0115B6800].nsp'))
      expect(sorted(await updatesDlcEntriesFor(await totk(), emu, []))).toEqual([
        'Something else [0100F2C0115B6800].nsp'
      ])
    })

    it('never mixes Breath of the Wild and Tears of the Kingdom', async () => {
      await put(join(switchDir(), 'Zelda Breath of the Wild [Update v1.6.0].nsp'))
      await put(join(switchDir(), 'Breath of the Wild DLC.nsp'))
      await put(join(switchDir(), 'Tears of the Kingdom Update.nsp'))
      const t = {
        ...(await rom('switch', 'The Legend of Zelda Tears of the Kingdom.xci')),
        titles: ['The Legend of Zelda: Tears of the Kingdom']
      }
      const b = {
        ...(await rom('switch', 'The Legend of Zelda Breath of the Wild.xci')),
        titles: ['The Legend of Zelda: Breath of the Wild']
      }
      expect(sorted(await updatesDlcEntriesFor(t, emu, [b]))).toEqual([
        'Tears of the Kingdom Update.nsp'
      ])
      expect(sorted(await updatesDlcEntriesFor(t, emu, []))).toEqual([
        'Tears of the Kingdom Update.nsp'
      ])
      expect(sorted(await updatesDlcEntriesFor(b, emu, [t]))).toEqual([
        'Breath of the Wild DLC.nsp',
        'Zelda Breath of the Wild [Update v1.6.0].nsp'
      ])
    })

    it('keeps sequels, spin-offs and editions apart', async () => {
      await put(join(switchDir(), 'Halo 3 ODST Update.nsp'))
      await put(join(switchDir(), 'DOOM Eternal Update.nsp'))
      await put(join(switchDir(), 'Mario Kart 8 Deluxe US Update.nsp'))
      await put(join(switchDir(), 'Super Mario Party Update.nsp'))
      for (const name of ['Halo 3.xci', 'Doom.xci', 'Mario Kart 8.xci', 'Mario Party.xci'])
        expect(await updatesDlcEntriesFor(await rom('switch', name), emu, [])).toEqual([])
      // ...and the shorter name never claims the longer game's own update the other way round either.
      await fs.rm(switchDir(), { recursive: true })
      await put(join(switchDir(), 'Halo 3 Update.nsp'))
      await put(join(switchDir(), 'Mario Party Update.nsp'))
      expect(await updatesDlcEntriesFor(await rom('switch', 'Halo 3 ODST.xci'), emu, [])).toEqual(
        []
      )
      expect(
        await updatesDlcEntriesFor(await rom('switch', 'Super Mario Party.xci'), emu, [])
      ).toEqual([])
    })

    it('gives a shortened name to the closest game of the library', async () => {
      await put(join(switchDir(), 'Tears of the Kingdom Update.nsp'))
      const full = await rom('switch', 'The Legend of Zelda Tears of the Kingdom.xci')
      const exact = await rom('switch', 'Tears of the Kingdom.nsp')
      expect(await updatesDlcEntriesFor(full, emu, [exact])).toEqual([])
      expect(sorted(await updatesDlcEntriesFor(exact, emu, [full]))).toEqual([
        'Tears of the Kingdom Update.nsp'
      ])
    })

    it('never matches a bare "DLC" or "Update" name', async () => {
      await put(join(switchDir(), 'DLC.nsp'))
      await put(join(switchDir(), 'Update v1.2.1.nsp'))
      await put(join(switchDir(), 'US NSP.nsp'))
      expect(await updatesDlcEntriesFor(await totk(), emu, [])).toEqual([])
    })

    it('matches Xbox 360 folders by title id and by name, and lists nothing for PS3', async () => {
      await put(join(xboxDir(), '4D5307E6', '000B0000', 'TU.bin'))
      await put(join(xboxDir(), 'Halo 3 ODST', 'TU.bin'))
      const halo = await rom('xbox360', 'Halo 3 [4D5307E6].iso')
      const entries = await updatesDlcEntriesFor(halo, emu, [])
      expect(entries).toEqual([
        { path: join(xboxDir(), '4D5307E6'), name: '4D5307E6', isFile: false }
      ])
      expect(
        await updatesDlcEntriesFor({ id: 'p', systemId: 'ps3', romPath: join(roms, 'x') }, emu, [])
      ).toEqual([])
    })

    it('never claims a game whose name has other words in front', async () => {
      await put(join(xboxDir(), 'Super Street Fighter IV [TU1].bin'))
      await put(join(xboxDir(), 'Ultra Street Fighter IV TU'))
      await put(join(xboxDir(), 'Lightning Returns Final Fantasy XIII [TU1]'))
      await put(join(xboxDir(), 'Ultimate Marvel vs. Capcom 3 [TU2]'))
      for (const name of [
        'Street Fighter IV (USA).iso',
        'Final Fantasy XIII (USA).iso',
        'Marvel vs. Capcom 3 (USA).iso'
      ])
        expect(await updatesDlcEntriesFor(await rom('xbox360', name), emu, [])).toEqual([])
    })

    it('sends a subtitle match but never deletes it', async () => {
      await put(join(xboxDir(), 'Final Fantasy XIII [TU1]'))
      const lr = await rom('xbox360', 'Lightning Returns - Final Fantasy XIII (USA).iso')
      expect(sorted(await updatesDlcEntriesFor(lr, emu, []))).toEqual(['Final Fantasy XIII [TU1]'])
      expect(await updatesDlcOf(lr, emu, [])).toEqual([])
      // With Final Fantasy XIII in the library, it is that game's.
      const ff = await rom('xbox360', 'Final Fantasy XIII (USA).iso')
      expect(await updatesDlcEntriesFor(lr, emu, [ff])).toEqual([])
      expect(sorted(await updatesDlcOf(ff, emu, [lr]))).toEqual(['Final Fantasy XIII [TU1]'])
    })

    it('reads the Xbox 360 title update spellings', async () => {
      for (const n of [
        'Street Fighter IV TU2',
        'Street Fighter IV TU 2',
        'Street Fighter IV - Title Update 2',
        'Street Fighter IV [TU2]'
      ])
        await put(join(xboxDir(), n, 'tu.bin'))
      const sf = await rom('xbox360', 'Street Fighter IV (USA).iso')
      expect(sorted(await updatesDlcEntriesFor(sf, emu, []))).toEqual(
        [
          'Street Fighter IV - Title Update 2',
          'Street Fighter IV TU 2',
          'Street Fighter IV TU2',
          'Street Fighter IV [TU2]'
        ].sort()
      )
      expect(gameWords('Dead Rising 2 TU3', false)).toEqual(['dead', 'rising', '2'])
      expect(gameWords('Halo 3 Update 2.nsp', true)).toEqual(['halo', '3'])
    })

    it("lets the names decide when an Xbox 360 ROM's 8-digit tag is not the update's id", async () => {
      await put(join(xboxDir(), 'Dead Rising 2 [TU3] [434307DE]', 'tu.bin'))
      await put(join(xboxDir(), 'Dead Rising [TU1] [434307DE]', 'tu.bin'))
      // A CRC tag on the ROM looks like a title id.
      const dr2 = await rom('xbox360', 'Dead Rising 2 (USA) [AB12CD34].iso')
      expect(sorted(await updatesDlcEntriesFor(dr2, emu, []))).toEqual([
        'Dead Rising 2 [TU3] [434307DE]'
      ])
      // A bare title id folder goes with a game whose id is known (read from its image, or its folder's name).
      await put(join(xboxDir(), '4D5307E6', '000B0000', 'TU.bin'))
      const halo = { ...(await rom('xbox360', 'Halo 3 (USA).iso')), ids: ['4d5307e6'] }
      expect(sorted(await updatesDlcEntriesFor(halo, emu, []))).toEqual(['4D5307E6'])
      const inFolder = await rom('xbox360', join('4D5307E6', 'default.xex'))
      expect(sorted(await updatesDlcEntriesFor(inFolder, emu, []))).toEqual(['4D5307E6'])
    })

    it("takes a Switch title id from the ROM's folder name", async () => {
      await put(join(switchDir(), '0100F2C0115B6800.nsp'))
      const g = await rom('switch', join('TotK [0100F2C0115B6000]', 'game.xci'))
      expect(sorted(await updatesDlcEntriesFor(g, emu, []))).toEqual(['0100F2C0115B6800.nsp'])
      const known = { ...(await rom('switch', 'TotK.xci')), ids: ['0100F2C0115B6000'] }
      expect(sorted(await updatesDlcEntriesFor(known, emu, []))).toEqual(['0100F2C0115B6800.nsp'])
    })

    it('sends a DLC named after the game with its own name after it', async () => {
      await put(join(switchDir(), 'Xenoblade Chronicles 3 Future Redeemed DLC.nsp'))
      await put(join(switchDir(), 'Mario Kart 8 Deluxe Booster Course Pass.nsp'))
      const xc3 = await rom('switch', 'Xenoblade Chronicles 3.xci')
      expect(sorted(await updatesDlcEntriesFor(xc3, emu, []))).toEqual([
        'Xenoblade Chronicles 3 Future Redeemed DLC.nsp'
      ])
      expect(await updatesDlcOf(xc3, emu, [])).toEqual([])
      // The standalone game in the library keeps it.
      const fr = await rom('switch', 'Xenoblade Chronicles 3 Future Redeemed.xci')
      expect(await updatesDlcEntriesFor(xc3, emu, [fr])).toEqual([])
      // Without "DLC" the words after the name are another game's.
      expect(
        await updatesDlcEntriesFor(await rom('switch', 'Mario Kart 8 Deluxe.xci'), emu, [])
      ).toEqual([])
    })

    it('gives an update to every copy of one game (same title id) to send, and to none to delete', async () => {
      await put(join(switchDir(), 'TotK [0100F2C0115B6800][v1.2.1].nsp'))
      const a = await rom('switch', 'Zelda [0100F2C0115B6000].xci')
      const b = await rom('switch', join('Super XCI', 'Zelda [0100F2C0115B6000][v1.2.1].xci'))
      expect(sorted(await updatesDlcEntriesFor(a, emu, [b]))).toEqual([
        'TotK [0100F2C0115B6800][v1.2.1].nsp'
      ])
      expect(sorted(await updatesDlcEntriesFor(b, emu, [a]))).toEqual([
        'TotK [0100F2C0115B6800][v1.2.1].nsp'
      ])
      expect(await updatesDlcOf(a, emu, [b])).toEqual([])
      expect(sorted(await updatesDlcOf(a, emu, []))).toEqual([
        'TotK [0100F2C0115B6800][v1.2.1].nsp'
      ])
    })

    it("looks into organizing subfolders, never into another game's folder", async () => {
      await put(join(switchDir(), 'Updates', 'Zelda [0100F2C0115B6800].nsp'))
      await put(join(switchDir(), 'Non Super XCI Switch', 'Part 1', 'TotK [0100F2C0115B6800].nsp'))
      await put(join(switchDir(), 'DLC', 'Metroid Dread', 'Zelda [0100F2C0115B6800].nsp'))
      await put(join(switchDir(), 'a', 'b', 'c', 'd', 'Zelda [0100F2C0115B6800].nsp'))
      const z = await rom('switch', 'Zelda [0100F2C0115B6000].xci')
      const metroid = await rom('switch', 'Metroid Dread.xci')
      const entries = await updatesDlcEntriesFor(z, emu, [metroid])
      expect(entries.map((e) => e.name).sort()).toEqual([
        'Non Super XCI Switch/Part 1/TotK [0100F2C0115B6800].nsp',
        'Updates/Zelda [0100F2C0115B6800].nsp'
      ])
      expect(entries[0]!.path).toBe(join(switchDir(), ...entries[0]!.name.split('/')))
      const files = await updatesDlcFiles(z, emu, [metroid])
      expect(files.map((f) => f.path).sort()).toEqual([
        'Switch/Non Super XCI Switch/Part 1/TotK [0100F2C0115B6800].nsp',
        'Switch/Updates/Zelda [0100F2C0115B6800].nsp'
      ])
    })

    it('leaves out a whole entry that has too many files, and says so', async () => {
      await put(join(switchDir(), 'Zelda [0100F2C0115B6800].nsp'))
      for (const n of ['1', '2', '3']) await put(join(switchDir(), 'Zelda DLC', `${n}.bin`))
      const z = await rom('switch', 'Zelda.xci')
      const warnings: string[] = []
      const files = await updatesDlcFiles(z, emu, [], (m) => warnings.push(m), 2)
      expect(files.map((f) => f.path)).toEqual(['Switch/Zelda [0100F2C0115B6800].nsp'])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('Switch/Zelda DLC')
    })
  })

  it('lists nothing for other systems or a missing folder', async () => {
    expect(await updatesDlcOf(await rom('switch', 'Metroid Dread.nsp'), emu, [])).toEqual([])
    expect(await updatesDlcOf(await rom('psx', 'Metroid Dread.cue'), emu, [])).toEqual([])
  })
})
