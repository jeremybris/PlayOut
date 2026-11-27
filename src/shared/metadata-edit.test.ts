import { describe, expect, it } from 'vitest'
import {
  editableValues,
  effectiveGame,
  gameMetadataKey,
  isMetadataFieldLocked,
  localMetadataEdit,
  lockedMetadataFields,
  metadataLayers,
  metadataOrigins,
  normalizeKeyText,
  withMetadataEdit,
  withoutMetadataEdit
} from './metadata-edit'
import type { Game } from './types'

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 'steam:620',
    source: 'steam',
    externalId: '620',
    platformId: 'steam',
    title: 'Portal 2',
    sortTitle: 'portal 2',
    installed: true,
    launch: { kind: 'uri', uri: 'steam://rungameid/620' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {
      description: 'Scraped description',
      developers: ['Valve'],
      genres: ['Puzzle'],
      steamTags: { tags: ['Co-op', 'Puzzle'], controls: { controller: 'full', vr: null } },
      hltb: { main: 8, extra: 13, completionist: 22 },
      reviewScore: { source: 'steam', score: 98, count: 400000, label: 'Overwhelmingly Positive' },
      localPlayers: { max: 2, launchboxId: 5 }
    },
    media: {},
    metadataStatus: 'done',
    user: {},
    ...overrides
  } as Game
}

describe('gameMetadataKey', () => {
  it('uses the Steam app id when one is known, for any store', () => {
    expect(gameMetadataKey(game())).toBe('steam-620')
    expect(
      gameMetadataKey(game({ source: 'epic', externalId: 'Fn', extra: { steamAppId: 1172470 } }))
    ).toBe('steam-1172470')
  })

  it('uses source and id for other store games, lower-cased and file-name safe', () => {
    expect(gameMetadataKey(game({ source: 'gog', externalId: '1207658924' }))).toBe(
      'gog-1207658924'
    )
    expect(gameMetadataKey(game({ source: 'epic', externalId: 'Sugar:Cane/1' }))).toBe(
      'epic-sugar-cane-1'
    )
    expect(gameMetadataKey(game({ source: 'xbox', externalId: '9NBLGGH4R315' }))).toBe(
      'xbox-9nblggh4r315'
    )
  })

  it('keys a ROM by its disc serial, else by system and title', () => {
    const rom = {
      source: 'rom' as const,
      platformId: 'ps2',
      externalId: 'ps2/Okami (USA) [SLUS-21115].chd',
      romPath: 'D:\\Roms\\ps2\\Okami (USA) [SLUS-21115].chd',
      title: 'Ōkami'
    }
    expect(gameMetadataKey(game(rom))).toBe('ps2-slus21115')
    expect(gameMetadataKey(game({ ...rom, extra: { serial: 'SLUS-21115' } }))).toBe('ps2-slus21115')
    expect(
      gameMetadataKey(
        game({ ...rom, externalId: 'ps2/Okami.chd', romPath: 'D:\\Roms\\ps2\\Okami.chd' })
      )
    ).toBe('ps2-okami')
    expect(
      gameMetadataKey(
        game({
          ...rom,
          platformId: 'gc',
          externalId: 'gc/Wind Waker [GZLE01].iso',
          romPath: undefined
        })
      )
    ).toBe('gc-gzle01')
  })

  it('keys a ROM without a serial by its file name, never by the title scrapers rewrite', () => {
    const rom = game({
      source: 'rom',
      platformId: 'snes',
      externalId: 'snes/Legend of Zelda, The - A Link to the Past (USA) [!].sfc',
      romPath: 'D:\\Roms\\snes\\Legend of Zelda, The - A Link to the Past (USA) [!].sfc',
      title: 'Legend of Zelda, The - A Link to the Past'
    })
    const key = 'snes-legend-of-zelda-the-a-link-to-the-past'
    expect(gameMetadataKey(rom)).toBe(key)
    expect(
      gameMetadataKey(game({ ...rom, title: 'The Legend of Zelda: A Link to the Past' }))
    ).toBe(key)
    expect(gameMetadataKey(game({ ...rom, user: { titleOverride: 'Zelda 3' } }))).toBe(key)
    // The same game from another PC's folder, without romPath.
    expect(gameMetadataKey({ ...rom, romPath: undefined })).toBe(key)
  })

  it('looks for serials only on the systems that have them, in their real shapes', () => {
    const rom = (platformId: string, file: string): Game =>
      game({ source: 'rom', platformId, externalId: `${platformId}/${file}`, title: 'X' })
    expect(gameMetadataKey(rom('psx', 'Final Fantasy VII (GERMAN).bin'))).toBe(
      'psx-final-fantasy-vii'
    )
    expect(gameMetadataKey(rom('psx', 'Tomb Raider (GERMAN).bin'))).toBe('psx-tomb-raider')
    expect(gameMetadataKey(rom('gc', 'Metroid Prime (EUROPE).iso'))).toBe('gc-metroid-prime')
    expect(gameMetadataKey(rom('gc', 'F-Zero GX (SAMPLE).iso'))).toBe('gc-f-zero-gx')
    expect(gameMetadataKey(rom('wii', 'Mario Galaxy [RMGE01].iso'))).toBe('wii-rmge01')
    expect(gameMetadataKey(rom('psx', 'Crash [SCUS_944.26].bin'))).toBe('psx-scus94426')
    expect(gameMetadataKey(rom('ps2', 'SLUS_207.77'))).toBe('ps2-slus20777')
    // A trimmed Xbox image keeps its full dump's key.
    expect(gameMetadataKey(rom('xbox', 'Halo (USA).xiso.iso'))).toBe(
      gameMetadataKey(rom('xbox', 'Halo (USA).iso'))
    )
    expect(gameMetadataKey(rom('xbox', 'Halo (USA).XISO.iso'))).toBe('rom-xbox-halo')
    // A PlayStation serial in another system's file name is just part of the name; a GameID too.
    expect(gameMetadataKey(rom('snes', 'Game SLUS-20777.sfc'))).toBe('snes-game-slus-20777')
    expect(gameMetadataKey(rom('psx', 'Game [GALE01].bin'))).toBe('psx-game')
  })

  it('keys a game folder executable by its folder, not by the file name every such game shares', () => {
    const rom = (platformId: string, externalId: string, romPath?: string): Game =>
      game({ source: 'rom', platformId, externalId, romPath, title: 'X' })
    expect(gameMetadataKey(rom('ps4', 'ps4/Bloodborne/eboot.bin'))).toBe('ps4-bloodborne')
    expect(gameMetadataKey(rom('ps4', 'ps4/DRIVECLUB - [EU]/eboot.bin'))).toBe('ps4-driveclub')
    expect(
      gameMetadataKey(
        rom('ps5', 'ps5/Astro Bot - [US]/eboot.bin', 'E:\\ps5\\Astro Bot - [US]\\eboot.bin')
      )
    ).toBe('ps5-astro-bot')
    expect(gameMetadataKey(rom('xbox', 'xbox/Halo/default.xbe'))).toBe('rom-xbox-halo')
    expect(gameMetadataKey(rom('xbox360', 'xbox360/Gears of War (USA)/default.xex'))).toBe(
      'xbox360-gears-of-war'
    )
    expect(gameMetadataKey(rom('dos', 'dos/Doom/GAME.BAT'))).toBe('dos-doom')
    // Two different games no longer share one key.
    expect(gameMetadataKey(rom('ps4', 'ps4/A/eboot.bin'))).not.toBe(
      gameMetadataKey(rom('ps4', 'ps4/B/eboot.bin'))
    )
    // An executable lying in the system folder itself, and a disc image named like one, keep the file's name.
    expect(gameMetadataKey(rom('ps4', 'ps4/eboot.bin'))).toBe('ps4-eboot')
    expect(gameMetadataKey(rom('ps2', 'ps2/Favorites/Game.iso'))).toBe('ps2-game')
    expect(gameMetadataKey(rom('psx', 'psx/Collection/boot.cue'))).toBe('psx-boot')
  })

  it('keeps ROM keys apart from Steam and store keys', () => {
    const rom = (platformId: string, file: string): Game =>
      game({ source: 'rom', platformId, externalId: `${platformId}/${file}`, title: 'X' })
    expect(gameMetadataKey(rom('steam', 'Portal 2.lnk'))).toBe('rom-steam-portal-2')
    expect(gameMetadataKey(rom('xbox', 'Halo (USA).iso'))).toBe('rom-xbox-halo')
  })

  it('keys a manual game by its install folder and executable, in its own namespace', () => {
    const manual = (exePath: string, title = 'Anything'): Game =>
      game({ source: 'manual', externalId: exePath.toLowerCase(), exePath, title })
    expect(gameMetadataKey(manual('C:\\Games\\Hollow Knight\\hollow_knight.exe'))).toBe(
      'manual-hollow-knight'
    )
    expect(gameMetadataKey(manual('C:\\Games\\To the Moon\\Game.exe'))).toBe('manual-to-the-moon')
    expect(gameMetadataKey(manual('D:\\Indie\\Celeste\\Launcher.exe'))).toBe(
      'manual-celeste-launcher'
    )
    expect(
      gameMetadataKey(manual('E:\\Super_Game [GOG] v1.2.3\\Binaries\\Win64\\SG-Win64-Shipping.exe'))
    ).toBe('manual-super-game-sg-win64-shipping')
    // The title (scraped, rescanned or edited) never changes it, and it cannot look like a Steam key.
    const steamy = manual('C:\\Games\\Steam Prison\\SteamPrison.exe', 'Steam Prison')
    expect(gameMetadataKey(steamy)).toBe('manual-steam-prison')
    expect(gameMetadataKey(game({ ...steamy, title: 'Steam 440' }))).toBe('manual-steam-prison')
    expect(gameMetadataKey(game({ ...steamy, user: { titleOverride: 'Else' } }))).toBe(
      'manual-steam-prison'
    )
    expect(gameMetadataKey(game({ source: 'manual', externalId: '', title: 'X' }))).toBeNull()
  })

  it('has no key for a Steam game without an app id', () => {
    expect(gameMetadataKey(game({ externalId: 'abc', title: 'Portal 2' }))).toBeNull()
  })

  it('normalizes text into dash-separated words', () => {
    expect(normalizeKeyText('  The Legend of Zelda™: Breath of the Wild  ')).toBe(
      'the-legend-of-zelda-breath-of-the-wild'
    )
    expect(normalizeKeyText('x'.repeat(200))).toHaveLength(120)
  })
})

describe('effective metadata: scraped < cloud < local edit', () => {
  it('returns the game itself without a cloud entry or an edit', () => {
    const g = game()
    expect(effectiveGame(g)).toBe(g)
    expect(effectiveGame(g, {})).toBe(g)
  })

  it('lays the cloud over the scraped values and the local edit over both, per field', () => {
    const g = game({
      user: { metadataEdits: { developers: ['Valve Corporation'], localPlayers: 4 } }
    })
    const shown = effectiveGame(g, {
      title: 'Portal 2 (Cloud)',
      developers: ['Cloud Dev'],
      description: 'Cloud description',
      hltb: { main: 9 }
    })
    expect(shown.title).toBe('Portal 2 (Cloud)')
    expect(shown.sortTitle).toBe('portal 2 cloud')
    expect(shown.metadata.description).toBe('Cloud description')
    expect(shown.metadata.developers).toEqual(['Valve Corporation'])
    expect(shown.metadata.localPlayers).toEqual({ max: 4, launchboxId: 5 })
    // The edited HLTB replaces every time: extra and completionist are gone.
    expect(shown.metadata.hltb).toEqual({ main: 9 })
    // Untouched fields stay scraped; the stored game is not changed.
    expect(shown.metadata.genres).toEqual(['Puzzle'])
    expect(g.metadata.description).toBe('Scraped description')
    expect(g.title).toBe('Portal 2')
  })

  it('treats empty values as "none" and maps controls, tags, rating and genres', () => {
    const shown = effectiveGame(
      game({
        source: 'rom',
        metadata: {
          description: 'x',
          genres: ['Action'],
          launchboxGenres: { genres: ['Platform'] },
          steamTags: { tags: ['A'] },
          reviewScore: { source: 'steam', score: 50, count: 3, updatedAt: '2026-01-01' }
        }
      }),
      {
        description: '',
        genres: ['RPG', ' '],
        tags: ['Souls-like'],
        controls: { controller: 'partial', vr: 'none' },
        reviewScore: { score: 77, source: 'igdb' },
        localPlayers: 0
      }
    )
    expect(shown.metadata.description).toBeUndefined()
    expect(shown.metadata.genres).toEqual(['RPG'])
    expect(shown.metadata.launchboxGenres?.genres).toEqual(['RPG'])
    expect(shown.metadata.steamTags).toEqual({
      tags: ['Souls-like'],
      controls: { controller: 'partial', vr: null }
    })
    expect(shown.metadata.reviewScore).toEqual({
      source: 'igdb',
      score: 77,
      updatedAt: '2026-01-01'
    })
    expect(shown.metadata.localPlayers?.max).toBeUndefined()
  })

  it('keeps touch when the controls are edited, and never puts touch in an edit', () => {
    const g = game({
      metadata: {
        steamTags: { tags: ['A'], controls: { controller: 'full', vr: null, touch: 'supported' } }
      }
    })
    const shown = effectiveGame(g, { controls: { controller: 'partial', vr: 'none' } })
    expect(shown.metadata.steamTags?.controls).toEqual({
      controller: 'partial',
      vr: null,
      touch: 'supported'
    })
    // The editable (and cloud) values carry only controller and VR.
    expect(editableValues(g).controls).toEqual({ controller: 'full', vr: 'none' })
  })

  it('keeps showing an edited field whatever the scrapers write later', () => {
    const g = game({ user: { metadataEdits: { genres: ['Mine'] } } })
    g.metadata = { ...g.metadata, genres: ['Overwritten by a scraper'] }
    expect(effectiveGame(g).metadata.genres).toEqual(['Mine'])
  })
})

describe('locks and origins', () => {
  it('locks the fields a cloud entry or a local edit sets', () => {
    const g = game({ user: { titleOverride: 'Mine', metadataEdits: { genres: ['X'] } } })
    expect([...lockedMetadataFields(g, { description: 'c' })].sort()).toEqual([
      'description',
      'genres',
      'title'
    ])
    expect(isMetadataFieldLocked(g, null, 'genres')).toBe(true)
    expect(isMetadataFieldLocked(g, null, 'hltb')).toBe(false)
    const origins = metadataOrigins(g, { genres: ['C'], hltb: {} })
    expect(origins.genres).toBe('local')
    expect(origins.hltb).toBe('cloud')
    expect(origins.description).toBe('scraped')
    expect(origins.title).toBe('local')
  })

  it('reports the three layers for the Edit sheet', () => {
    const g = game({ user: { titleOverride: 'Mine', metadataEdits: { localPlayers: 3 } } })
    const layers = metadataLayers(g, { tags: ['T'] })
    expect(layers.key).toBe('steam-620')
    expect(layers.local).toEqual({ title: 'Mine', localPlayers: 3 })
    expect(layers.cloud).toEqual({ tags: ['T'] })
    expect(layers.scraped).toMatchObject({
      title: 'Portal 2',
      developers: ['Valve'],
      controls: { controller: 'full', vr: 'none' },
      hltb: { main: 8, extra: 13, completionist: 22 },
      reviewScore: { score: 98, source: 'steam' },
      localPlayers: 2
    })
    expect(metadataLayers(g, {}).cloud).toBeNull()
  })

  it("reads a ROM game's LaunchBox genres as its scraped genres", () => {
    const rom = game({
      source: 'rom',
      metadata: { genres: ['Action'], launchboxGenres: { genres: ['Platform'] } }
    })
    expect(editableValues(rom).genres).toEqual(['Platform'])
  })
})

describe('changing the local edit', () => {
  it('merges fields, keeps the title in titleOverride and removes fields', () => {
    let user = withMetadataEdit({}, { title: ' New ', genres: ['A'] })
    expect(user).toEqual({ titleOverride: 'New', metadataEdits: { genres: ['A'] } })
    user = withMetadataEdit(user, { developers: ['D'], genres: ['B'] })
    expect(user.metadataEdits).toEqual({ genres: ['B'], developers: ['D'] })
    expect(localMetadataEdit({ user })).toEqual({
      title: 'New',
      genres: ['B'],
      developers: ['D']
    })
    user = withoutMetadataEdit(user, ['genres', 'title'])
    expect(user).toEqual({ metadataEdits: { developers: ['D'] } })
    expect(withoutMetadataEdit(user)).toEqual({})
    // An empty title removes the override.
    expect(withMetadataEdit({ titleOverride: 'Old' }, { title: '' })).toEqual({})
  })
})
