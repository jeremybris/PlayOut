import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Game, SystemDefinition } from '../../shared/types'
import type { Logger } from '../logger'
import {
  ESDE_MEDIA_TYPES,
  esdeDate,
  emulatorIdForLabel,
  esdeTimestamp,
  importFromEsde,
  metadataFromEntry,
  parseEsdeSettings,
  parseGamelist,
  relativeRomPath
} from './esde-import'

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

const GAMELIST = `<?xml version="1.0"?>
<alternativeEmulator>
\t<label>Snes9x 2010</label>
</alternativeEmulator>
<gameList>
\t<game>
\t\t<path>./Super Mario World (USA).sfc</path>
\t\t<name>Super Mario World</name>
\t\t<sortname>Super Mario World 1</sortname>
\t\t<desc>Mario's quest to save Princess Toadstool &amp; Dinosaur Land.
Second paragraph.</desc>
\t\t<rating>0.9</rating>
\t\t<releasedate>19901121T000000</releasedate>
\t\t<developer>Nintendo EAD</developer>
\t\t<publisher>Nintendo</publisher>
\t\t<genre>Platform / Action</genre>
\t\t<players>1-2</players>
\t\t<favorite>true</favorite>
\t\t<playcount>7</playcount>
\t\t<playtime>3600</playtime>
\t\t<lastplayed>20260115T213045</lastplayed>
\t\t<altemulator>Mesen-S</altemulator>
\t</game>
\t<game>
\t\t<path>./Hacks/Kaizo Mario (Hack).sfc</path>
\t\t<name>Kaizo Mario World</name>
\t\t<hidden>true</hidden>
\t\t<releasedate>19700101T000000</releasedate>
\t\t<developer>unknown</developer>
\t\t<rating>0</rating>
\t</game>
\t<game>
\t\t<path>D:\\Other ROMs\\snes\\Elsewhere.sfc</path>
\t\t<name>Elsewhere</name>
\t</game>
\t<game>
\t\t<name>No path, ignored</name>
\t</game>
\t<folder>
\t\t<path>./Hacks</path>
\t\t<name>ROM Hacks</name>
\t\t<desc>Fan-made levels.</desc>
\t</folder>
</gameList>
`

function romGame(
  id: string,
  externalId: string,
  romPath: string,
  extra?: Record<string, string | number | boolean>
): Game {
  const systemId = externalId.split('/')[0]
  const game: Game = {
    id,
    source: 'rom',
    externalId,
    platformId: systemId,
    title: 'x',
    sortTitle: 'x',
    installed: true,
    romPath,
    launch: { kind: 'emulator', systemId, romPath },
    tracking: { mode: 'spawned' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {}
  }
  if (extra) game.extra = extra
  return game
}

describe('parseGamelist', () => {
  it('reads games, folders and the non-standard alternativeEmulator root', () => {
    const list = parseGamelist(GAMELIST)
    expect(list.alternativeEmulator).toBe('Snes9x 2010')
    expect(list.games.length).toBe(3)
    expect(list.folders).toEqual([{ path: './Hacks', name: 'ROM Hacks', desc: 'Fan-made levels.' }])
    expect(list.games[0]).toEqual({
      path: './Super Mario World (USA).sfc',
      name: 'Super Mario World',
      sortname: 'Super Mario World 1',
      desc: "Mario's quest to save Princess Toadstool & Dinosaur Land.\nSecond paragraph.",
      rating: 0.9,
      releasedate: '19901121T000000',
      developer: 'Nintendo EAD',
      publisher: 'Nintendo',
      genre: 'Platform / Action',
      players: '1-2',
      favorite: true,
      playcount: 7,
      playtime: 3600,
      lastplayed: '20260115T213045',
      altemulator: 'Mesen-S'
    })
    expect(list.games[1]).toMatchObject({
      path: './Hacks/Kaizo Mario (Hack).sfc',
      hidden: true,
      rating: 0,
      developer: 'unknown'
    })
    expect(list.games[2].path).toBe('D:\\Other ROMs\\snes\\Elsewhere.sfc')
  })

  it('tolerates a single game, a BOM and an empty list', () => {
    const one = parseGamelist(
      '\uFEFF<?xml version="1.0"?><gameList><game><path>./a.sfc</path><name>A</name></game></gameList>'
    )
    expect(one.games).toEqual([{ path: './a.sfc', name: 'A' }])
    expect(one.alternativeEmulator).toBeUndefined()
    expect(parseGamelist('<gameList></gameList>')).toEqual({ games: [], folders: [] })
    expect(
      parseGamelist(
        '<gameList><alternativeEmulator><label>X</label></alternativeEmulator></gameList>'
      ).alternativeEmulator
    ).toBe('X')
  })
})

describe('value conversions', () => {
  it('converts ES-DE dates and timestamps', () => {
    expect(esdeDate('19901121T000000')).toBe('1990-11-21')
    expect(esdeDate('20011118')).toBe('2001-11-18')
    expect(esdeDate('19700101T000000')).toBeUndefined()
    expect(esdeDate('not a date')).toBeUndefined()
    expect(esdeDate(undefined)).toBeUndefined()
    expect(esdeTimestamp('20260115T213045')).toBe(new Date(2026, 0, 15, 21, 30, 45).toISOString())
    expect(esdeTimestamp('0')).toBeUndefined()
    expect(esdeTimestamp('19700101T000000')).toBeUndefined()
  })

  it('maps gamelist fields to GameMetadata (rating 0-1 -> 0-100, lists split, unknown dropped)', () => {
    const metadata = metadataFromEntry(parseGamelist(GAMELIST).games[0], 'snes')
    expect(metadata).toEqual({
      description: "Mario's quest to save Princess Toadstool & Dinosaur Land.\nSecond paragraph.",
      releaseDate: '1990-11-21',
      developers: ['Nintendo EAD'],
      publishers: ['Nintendo'],
      genres: ['Platform', 'Action'],
      players: '1-2',
      rating: 90,
      sources: { esde: 'snes:./Super Mario World (USA).sfc' }
    })
    expect(metadataFromEntry(parseGamelist(GAMELIST).games[1], 'snes')).toEqual({})
    expect(metadataFromEntry({ path: './x', rating: 0.05 }, 'snes').rating).toBe(5)
    expect(metadataFromEntry({ path: './x', rating: 1 }, 'snes').rating).toBe(100)
  })

  it('reads es_settings.xml strings and ROM paths', () => {
    expect(
      parseEsdeSettings(
        '<?xml version="1.0"?>\n<string name="ROMDirectory" value="D:\\Games &amp; ROMs" />\n<bool name="ShowHiddenGames" value="true" />\n<string name="MediaDirectory" value="" />'
      )
    ).toEqual({ romDirectory: 'D:\\Games & ROMs' })
    expect(relativeRomPath(romGame('a', 'snes/Sub/Game.sfc', 'C:\\r\\snes\\Sub\\Game.sfc'))).toBe(
      'Sub/Game.sfc'
    )
  })

  it('looks media up in the documented ES-DE folders, in order', () => {
    expect(ESDE_MEDIA_TYPES).toEqual({
      cover: ['covers', '3dboxes'],
      logo: ['marquees'],
      hero: ['fanart', 'screenshots', 'titlescreens'],
      video: ['videos']
    })
  })
})

describe('importFromEsde', () => {
  let dir: string
  let esdeHome: string
  let romsRoot: string

  async function write(file: string, content = 'x'): Promise<string> {
    await fs.mkdir(dirname(file), { recursive: true })
    await fs.writeFile(file, content)
    return file
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-esde-'))
    esdeHome = join(dir, 'ES-DE')
    romsRoot = join(dir, 'ROMs')
    await write(join(esdeHome, 'gamelists', 'snes', 'gamelist.xml'), GAMELIST)
    await write(
      join(esdeHome, 'gamelists', 'psx', 'gamelist.xml'),
      '<?xml version="1.0"?><gameList><game><path>./Final Fantasy VII (USA).m3u</path><name>Final Fantasy VII</name><rating>1</rating></game></gameList>'
    )
    await write(
      join(esdeHome, 'gamelists', 'broken', 'gamelist.xml'),
      '<gameList><game><path>./x.bin</path></game'
    )
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns nothing when no ES-DE installation exists at the configured home', async () => {
    const result = await importFromEsde({
      games: [],
      esdeHome: join(dir, 'nowhere'),
      romsRoot,
      log: silent
    })
    expect(result).toEqual({ updates: [], esdeHome: null, preferredEmulators: {} })
  })

  it('imports the system-wide alternative emulator as the preferred command, skipping unknown labels', async () => {
    const snes: SystemDefinition = {
      id: 'snes',
      name: 'Nintendo SNES',
      extensions: ['.sfc'],
      platformKey: 'snes',
      emulators: [
        { id: 'snes9x-current', label: 'Snes9x - Current', command: 'x %ROM%' },
        { id: 'snes9x-2010', label: 'Snes9x 2010', command: 'y %ROM%' },
        { id: 'mesen-s', label: 'Mesen-S', command: 'z %ROM%' }
      ]
    }
    const psx: SystemDefinition = {
      ...snes,
      id: 'psx',
      name: 'Sony PlayStation',
      platformKey: 'psx'
    }
    const nes: SystemDefinition = { ...snes, id: 'nes', name: 'Nintendo NES', platformKey: 'nes' }
    await write(
      join(esdeHome, 'gamelists', 'nes', 'gamelist.xml'),
      '<?xml version="1.0"?><alternativeEmulator><label>Not A Real Emulator</label></alternativeEmulator><gameList><game><path>./Mario.nes</path></game></gameList>'
    )
    await write(
      join(esdeHome, 'gamelists', 'gb', 'gamelist.xml'),
      '<?xml version="1.0"?><alternativeEmulator><label>&lt;INVALID&gt;Snes9x 2010</label></alternativeEmulator><gameList><game><path>./Tetris.gb</path></game></gameList>'
    )
    const gb: SystemDefinition = { ...snes, id: 'gb', name: 'Game Boy', platformKey: 'gb' }
    const games = [
      romGame(
        'rom:snes:1',
        'snes/Super Mario World (USA).sfc',
        join(romsRoot, 'snes', 'Super Mario World (USA).sfc')
      ),
      romGame('rom:psx:1', 'psx/Final Fantasy VII (USA).m3u', join(romsRoot, 'psx', 'FF7.m3u')),
      romGame('rom:nes:1', 'nes/Mario.nes', join(romsRoot, 'nes', 'Mario.nes')),
      romGame('rom:gb:1', 'gb/Tetris.gb', join(romsRoot, 'gb', 'Tetris.gb'))
    ]
    const warnings: string[] = []
    const result = await importFromEsde({
      games,
      systems: [snes, psx, nes, gb],
      esdeHome,
      romsRoot,
      log: { ...silent, warn: (...a) => warnings.push(a.join(' ')) }
    })
    // snes: label matches a command; psx: no <alternativeEmulator>; nes: unknown label; gb: <INVALID> marker.
    expect(result.preferredEmulators).toEqual({ snes: 'snes9x-2010' })
    expect(warnings.some((w) => w.startsWith('nes:') && w.includes('Not A Real Emulator'))).toBe(
      true
    )
    expect(warnings.some((w) => w.startsWith('gb:') && w.includes('<INVALID>'))).toBe(true)
    // The per-game <altemulator> still wins for its own entry.
    expect(result.updates.find((u) => u.gameId === 'rom:snes:1')?.emulatorId).toBe('mesen-s')
  })

  it('matches games by relative path and collects media per type with fallbacks', async () => {
    const media = join(esdeHome, 'downloaded_media')
    const cover = await write(join(media, 'snes', 'covers', 'Super Mario World (USA).png'))
    const logo = await write(join(media, 'snes', 'marquees', 'Super Mario World (USA).png'))
    const screenshot = await write(
      join(media, 'snes', 'screenshots', 'Super Mario World (USA).jpg')
    )
    await write(join(media, 'snes', 'titlescreens', 'Super Mario World (USA).png'))
    const video = await write(join(media, 'snes', 'videos', 'Super Mario World (USA).mp4'))
    const box3d = await write(join(media, 'snes', '3dboxes', 'Hacks', 'Kaizo Mario (Hack).png'))
    const fanart = await write(join(media, 'snes', 'fanart', 'Hacks', 'Kaizo Mario (Hack).webp'))
    const ff7Cover = await write(join(media, 'psx', 'covers', 'Final Fantasy VII (USA).png'))
    const sotcCover = await write(join(media, 'ps3', 'covers', 'Shadow of the Colossus.ps3.png'))

    const games = [
      romGame(
        'rom:snes:1',
        'snes/Super Mario World (USA).sfc',
        join(romsRoot, 'snes', 'Super Mario World (USA).sfc')
      ),
      romGame(
        'rom:snes:2',
        'snes/Hacks/Kaizo Mario (Hack).sfc',
        join(romsRoot, 'snes', 'Hacks', 'Kaizo Mario (Hack).sfc')
      ),
      romGame('rom:snes:3', 'snes/Unknown Game.sfc', join(romsRoot, 'snes', 'Unknown Game.sfc')),
      romGame(
        'rom:psx:1',
        'psx/Final Fantasy VII (USA).m3u',
        join(romsRoot, 'psx', 'Final Fantasy VII (USA).m3u')
      ),
      romGame(
        'rom:ps3:1',
        'ps3/Shadow of the Colossus.ps3',
        join(romsRoot, 'ps3', 'Shadow of the Colossus.ps3'),
        { directory: true }
      ),
      romGame('rom:broken:1', 'broken/x.bin', join(romsRoot, 'broken', 'x.bin')),
      { ...romGame('steam:1', '1', 'C:\\x'), source: 'steam' as const, platformId: 'steam' }
    ]
    const warnings: string[] = []
    const result = await importFromEsde({
      games,
      esdeHome,
      romsRoot,
      log: { ...silent, warn: (...a) => warnings.push(a.join(' ')) }
    })
    expect(result.esdeHome).toBe(esdeHome)
    expect(result.updates.map((u) => u.gameId).sort()).toEqual([
      'rom:ps3:1',
      'rom:psx:1',
      'rom:snes:1',
      'rom:snes:2'
    ])

    const mario = result.updates.find((u) => u.gameId === 'rom:snes:1')!
    expect(mario.title).toBe('Super Mario World')
    expect(mario.metadata.rating).toBe(90)
    expect(mario.metadata.genres).toEqual(['Platform', 'Action'])
    expect(mario.localMedia).toEqual({ cover, logo, hero: screenshot, video })

    const kaizo = result.updates.find((u) => u.gameId === 'rom:snes:2')!
    expect(kaizo.title).toBe('Kaizo Mario World')
    expect(kaizo.metadata).toEqual({})
    expect(kaizo.localMedia).toEqual({ cover: box3d, hero: fanart })

    const ff7 = result.updates.find((u) => u.gameId === 'rom:psx:1')!
    expect(ff7).toEqual({
      gameId: 'rom:psx:1',
      title: 'Final Fantasy VII',
      metadata: { rating: 100, sources: { esde: 'psx:./Final Fantasy VII (USA).m3u' } },
      localMedia: { cover: ff7Cover }
    })

    // Directory games keep their pseudo-extension in the media stem, as ES-DE does.
    expect(result.updates.find((u) => u.gameId === 'rom:ps3:1')).toEqual({
      gameId: 'rom:ps3:1',
      metadata: {},
      localMedia: { cover: sotcCover }
    })
    expect(warnings.some((w) => w.includes('broken') && w.includes('could not parse'))).toBe(true)
  })

  it('honours MediaDirectory from es_settings.xml and accepts the parent of the ES-DE folder as home', async () => {
    const customMedia = join(dir, 'Custom Media')
    const cover = await write(join(customMedia, 'snes', 'covers', 'Super Mario World (USA).png'))
    await write(
      join(esdeHome, 'settings', 'es_settings.xml'),
      `<?xml version="1.0"?>\n<string name="MediaDirectory" value="${customMedia}" />\n`
    )
    const games = [
      romGame(
        'rom:snes:1',
        'snes/Super Mario World (USA).sfc',
        join(romsRoot, 'snes', 'Super Mario World (USA).sfc')
      )
    ]
    const result = await importFromEsde({ games, esdeHome: dir, romsRoot, log: silent })
    expect(result.esdeHome).toBe(esdeHome)
    expect(result.updates[0]?.localMedia).toEqual({ cover })
  })
})

describe('emulatorIdForLabel', () => {
  it("gives PlayOut's merged RPCS3 command for each ES-DE RPCS3 label it replaced", async () => {
    const all = JSON.parse(
      await fs.readFile(
        join(__dirname, '..', '..', '..', 'resources', 'systems', 'systems.json'),
        'utf8'
      )
    ) as SystemDefinition[] | { systems: SystemDefinition[] }
    const list = Array.isArray(all) ? all : all.systems
    const ps3 = list.find((x) => x.id === 'ps3')!
    expect(ps3.emulators.map((e) => e.label)).toEqual(['RPCS3 (Standalone)'])
    for (const label of [
      'RPCS3 Directory (Standalone)',
      'RPCS3 Game Serial (Standalone)',
      'RPCS3 ISO (Standalone)',
      'rpcs3-iso-standalone',
      'RPCS3 (Standalone)'
    ])
      expect(emulatorIdForLabel(ps3, label)).toBe('rpcs3-standalone')
    expect(emulatorIdForLabel(ps3, 'RPCS3 Shortcut (Standalone)')).toBeUndefined()

    const arcade = list.find((x) => x.id === 'consolearcade')!
    const ids = arcade.emulators.map((e) => e.id)
    expect(ids.filter((id) => id.startsWith('rpcs3'))).toEqual(['rpcs3-standalone'])
    expect(ids.indexOf('rpcs3-standalone')).toBe(ids.indexOf('play-disc-standalone') + 1)
    expect(emulatorIdForLabel(arcade, 'RPCS3 Game Serial (Standalone)')).toBe('rpcs3-standalone')
    // Other systems keep ES-DE's commands as they were.
    expect(emulatorIdForLabel(arcade, 'Flycast (Standalone)')).toBe('flycast-standalone')
  })
})
