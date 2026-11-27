import { describe, expect, it } from 'vitest'
import type { Game } from '../../shared/types'
import { buildTitleIndex, matchGameToTitle } from '../recomp/match'
import { titleKeyOf } from '../recomp/titles'
import {
  buildRemoteLibrary,
  isRecompCard,
  localMatches,
  hostOffer,
  isMediaRevision,
  lastPlayedHere,
  parseRemoteGameId,
  remoteMediaUrl,
  sanitizeHostGame,
  titleKey,
  offeredId,
  romStem,
  withRemoteRetro,
  type HostGame,
  type HostOfferInput
} from './remote-library'

function game(partial: Partial<Game> & Pick<Game, 'id' | 'source' | 'title'>): Game {
  return {
    externalId: partial.id.split(':').slice(1).join(':'),
    platformId: partial.source === 'rom' ? 'snes' : partial.source,
    sortTitle: partial.title.toLowerCase(),
    installed: true,
    launch: { kind: 'uri', uri: 'steam://rungameid/1' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'done',
    user: {},
    ...partial
  }
}

const now = new Date('2026-11-07T12:00:00.000Z')

function offerOf(games: Game[]): HostGame[] {
  // What crosses the wire: JSON in, JSON out.
  return JSON.parse(JSON.stringify(hostOffer(games))) as HostGame[]
}

describe('titleKey', () => {
  it('ignores case, punctuation, articles, tags and trademark signs', () => {
    expect(titleKey('The Witcher® 3: Wild Hunt')).toBe(titleKey('Witcher 3 - Wild Hunt'))
    expect(titleKey('Legend of Zelda, The - A Link to the Past (USA)')).toBe(
      titleKey('The Legend of Zelda: A Link to the Past')
    )
    expect(titleKey('Spider-Man')).toBe(titleKey('Spiderman'))
  })

  it('reads & as and, and roman numerals II-XX as numbers', () => {
    expect(titleKey('Ratchet & Clank')).toBe(titleKey('Ratchet and Clank'))
    expect(titleKey('Final Fantasy VII')).toBe(titleKey('Final Fantasy 7'))
    expect(titleKey('Grand Theft Auto V')).toBe(titleKey('Grand Theft Auto 5'))
  })

  it('keeps X a letter so Mega Man X is not Mega Man 10', () => {
    expect(titleKey('Mega Man X')).not.toBe(titleKey('Mega Man 10'))
  })

  it('is empty for a title of only punctuation', () => {
    expect(titleKey('!!! ()')).toBe('')
  })
})

describe('hostOffer', () => {
  const steam = game({
    id: 'steam:620',
    source: 'steam',
    title: 'Portal 2',
    installDir: 'C:\\Steam\\Portal 2',
    exePath: 'C:\\Steam\\Portal 2\\portal2.exe',
    tracking: { mode: 'installDir', installDir: 'C:\\Steam\\Portal 2' },
    extra: { steamAppId: 620, sizeOnDisk: 1 },
    media: {
      cover: 'media://cache/steam%3A620/cover.jpg',
      screenshots: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']
    },
    installSize: { bytes: 12_000_000_000, how: 'store', measuredAt: '2026-01-01' },
    user: {
      titleOverride: ' Portal Two ',
      notes: 'secret',
      extraArgs: '-novid',
      customMedia: { hero: 'D:\\h.png' }
    }
  })
  const rom = game({
    id: 'rom:snes:abc',
    source: 'rom',
    title: 'Super Metroid',
    externalId: 'snes/Super Metroid (USA).sfc',
    romPath: 'D:\\ROMs\\snes\\Super Metroid (USA).sfc',
    launch: {
      kind: 'emulator',
      systemId: 'snes',
      romPath: 'D:\\ROMs\\snes\\Super Metroid (USA).sfc'
    },
    tracking: { mode: 'spawned' },
    extra: { fileSize: 3_145_728 }
  })

  it('offers every installed, shown game: store games, games added by their .exe and ROMs', () => {
    const offer = hostOffer([
      steam,
      rom,
      game({ id: 'gog:1', source: 'gog', title: 'Owned only', installed: false, owned: true }),
      game({ id: 'epic:x', source: 'epic', title: 'Hidden', hidden: true }),
      game({ id: 'manual:c:/a.exe', source: 'manual', title: 'Manual' }),
      game({ id: 'rom:snes:zzz', source: 'rom', title: 'Gone ROM', installed: false }),
      // Its disc image went to the Recycle Bin for its recompilation: still offered (it syncs), with no file.
      game({
        id: 'rom:ps2:okami',
        source: 'rom',
        title: 'Okami',
        romRemoved: { at: '', recompId: 'github:a/b', romPath: 'D:\\ROMs\\ps2\\Okami.iso' }
      })
    ])
    expect(offer.map((g) => g.id)).toEqual([
      'steam:620',
      'rom:snes:abc',
      offeredId({ id: 'manual:c:/a.exe', source: 'manual' }),
      'rom:ps2:okami'
    ])
    const kept = offer.at(-1)!
    expect(kept).toMatchObject({ noRomFile: true, systemId: 'ps2' })
    // Its old path never leaves this PC, and it has no download size.
    expect(kept).not.toHaveProperty('romRemoved')
    expect(kept).not.toHaveProperty('sizeBytes')
    expect(offer.find((g) => g.id === 'rom:snes:abc')).not.toHaveProperty('noRomFile')
    // A client shows it (paired with its own copy, or as a host-only card) that streams and never downloads.
    const remote = buildRemoteLibrary(
      [],
      [{ hostId: 'h', hostName: 'Host', games: JSON.parse(JSON.stringify(offer)) }]
    )
    const card = remote.games.find((g) => g.remote?.hostGameId === 'rom:ps2:okami')
    expect(card?.remote).toMatchObject({ streamable: true, downloadable: false })
    expect(
      remote.games.find((g) => g.remote?.hostGameId === 'rom:snes:abc')?.remote?.downloadable
    ).toBe(true)
  })

  it('strips everything local to the host and keeps the user title', () => {
    const [offered] = hostOffer([steam])
    for (const key of [
      'installDir',
      'exePath',
      'romPath',
      'launch',
      'tracking',
      'extra',
      'media',
      'installSize'
    ]) {
      expect(offered).not.toHaveProperty(key)
    }
    expect(offered.user).toEqual({ titleOverride: 'Portal Two' })
    expect(offered.mediaKinds).toEqual([
      'cover',
      'hero',
      ...Array.from({ length: 10 }, (_, i) => `screenshot${i}`)
    ])
    expect(offered.sizeBytes).toBe(12_000_000_000)
    expect(offered.systemId).toBeUndefined()
  })

  it('gives ROMs their system and prefers the measured ROM set size', () => {
    expect(hostOffer([rom])[0]).toMatchObject({ systemId: 'snes', sizeBytes: 3_145_728 })
    expect(hostOffer([rom], { romSetSize: () => 700_000_000 })[0].sizeBytes).toBe(700_000_000)
    const noLaunch = { ...rom, launch: { kind: 'uri' as const, uri: '' }, id: 'rom:psx:q' }
    expect(hostOffer([noLaunch])[0].systemId).toBe('psx')
  })

  it("offers a dumped PS4 game's folder size, never its eboot.bin's", () => {
    const folder = 'D:\\ROMs\\ps4\\GRAVITY RUSH 2 - [EU]'
    const ps4 = game({
      id: 'rom:ps4:gr2',
      source: 'rom',
      platformId: 'ps4',
      title: 'Gravity Rush 2',
      externalId: 'ps4/GRAVITY RUSH 2 - [EU]/eboot.bin',
      romPath: `${folder}\\eboot.bin`,
      launch: { kind: 'emulator', systemId: 'ps4', romPath: `${folder}\\eboot.bin` },
      tracking: { mode: 'spawned' },
      extra: { fileSize: 27_777_640, gameFolder: folder }
    })
    // Not measured yet: no size rather than the eboot.bin's 26 MB.
    expect(hostOffer([ps4])[0].sizeBytes).toBeUndefined()
    const measured = {
      ...ps4,
      installSize: {
        bytes: 12_000_000_000,
        how: 'folder' as const,
        path: folder,
        measuredAt: '2026-11-16T00:00:00.000Z'
      }
    }
    expect(hostOffer([measured])[0].sizeBytes).toBe(12_000_000_000)
    // The same folder written another way still counts.
    expect(
      hostOffer([
        { ...measured, installSize: { ...measured.installSize, path: `${folder.toLowerCase()}\\` } }
      ])[0].sizeBytes
    ).toBe(12_000_000_000)
    // A measurement of its eboot.bin from before the folder was measured is no size of the game.
    const stale = {
      ...ps4,
      installSize: {
        bytes: 27_777_640,
        how: 'file' as const,
        path: `${folder}\\eboot.bin`,
        measuredAt: '2026-11-01T00:00:00.000Z'
      }
    }
    expect(hostOffer([stale])[0].sizeBytes).toBeUndefined()
    // The user's own size still goes first.
    expect(
      hostOffer([{ ...stale, user: { ...stale.user, installSize: 9_000_000_000 } }])[0].sizeBytes
    ).toBe(9_000_000_000)
    // An unmeasurable folder offers no size either.
    expect(
      hostOffer([
        { ...measured, installSize: { ...measured.installSize, bytes: 0, unmeasurable: true } }
      ])[0].sizeBytes
    ).toBeUndefined()
    // Other ROMs keep their file size.
    expect(hostOffer([rom])[0].sizeBytes).toBe(3_145_728)
  })

  it('does not share objects with the library records', () => {
    const [offered] = hostOffer([steam])
    offered.metadata.genres = ['changed']
    expect(steam.metadata.genres).toBeUndefined()
  })
})

describe('sanitizeHostGame', () => {
  it('drops entries without an id, title or known source', () => {
    expect(sanitizeHostGame(null)).toBeNull()
    expect(
      sanitizeHostGame({ id: 'a', title: 'A', platformId: 'pc', externalId: 'a', source: 'itch' })
    ).toBeNull()
    expect(
      sanitizeHostGame({ id: 'a', platformId: 'pc', externalId: 'a', source: 'steam' })
    ).toBeNull()
  })

  it('drops ids with control characters or an absurd length', () => {
    const base = { title: 'A', platformId: 'pc', externalId: 'a', source: 'steam' }
    expect(sanitizeHostGame({ ...base, id: 'steam:1\n2' })).toBeNull()
    expect(sanitizeHostGame({ ...base, id: 'steam:\u007f' })).toBeNull()
    expect(sanitizeHostGame({ ...base, id: `steam:${'9'.repeat(600)}` })).toBeNull()
    expect(sanitizeHostGame({ ...base, id: 'steam:1' })?.id).toBe('steam:1')
  })

  it('keeps only well-typed metadata and known media kinds', () => {
    const g = sanitizeHostGame({
      id: 'steam:1',
      source: 'steam',
      externalId: '1',
      platformId: 'steam',
      title: 'One',
      metadata: {
        genres: 'Action',
        tags: ['a', 3],
        rating: 'high',
        links: { store: 'javascript:x' }
      },
      mediaKinds: ['cover', 'cover', '../etc', 'video', 'screenshot3']
    })
    expect(g?.metadata).toEqual({ tags: ['a'] })
    expect(g?.mediaKinds).toEqual(['cover', 'screenshot3'])
  })

  it("titles an older host's trimmed Xbox image by the game, so recompilations match it here", () => {
    const g = sanitizeHostGame({
      id: 'rom:xbox:1',
      source: 'rom',
      externalId: 'xbox/007 - From Russia with Love (USA).xiso.iso',
      platformId: 'xbox',
      title: '007 - From Russia with Love.xiso',
      sortTitle: '007 from russia with love xiso'
    })!
    expect(g).toMatchObject({
      title: '007 - From Russia with Love',
      sortTitle: '007 from russia with love'
    })
    const catalog = {
      titles: new Map([
        [
          titleKeyOf('xbox', '007: From Russia with Love'),
          {
            key: titleKeyOf('xbox', '007: From Russia with Love'),
            game: '007: From Russia with Love',
            systemId: 'xbox',
            console: 'xbox',
            entries: ['id:bond']
          }
        ]
      ])
    }
    expect(matchGameToTitle(g, catalog, buildTitleIndex(catalog))?.game).toBe(
      '007: From Russia with Love'
    )
    // A clean title keeps the host's sort title; a PC game's name is never touched.
    const clean = {
      id: 'rom:xbox:2',
      source: 'rom',
      externalId: 'xbox/Halo.iso',
      platformId: 'xbox'
    }
    expect(sanitizeHostGame({ ...clean, title: 'Halo', sortTitle: 'halo 1' })?.sortTitle).toBe(
      'halo 1'
    )
    expect(
      sanitizeHostGame({
        id: 'steam:1',
        source: 'steam',
        externalId: '1',
        platformId: 'steam',
        title: 'Tool.xiso'
      })?.title
    ).toBe('Tool.xiso')
  })
})

describe('buildRemoteLibrary', () => {
  it('turns host-only games into remote games with remote media', () => {
    const host = game({
      id: 'steam:620',
      source: 'steam',
      title: 'Portal 2',
      media: { cover: 'x', logo: 'y', screenshots: ['s'] },
      favorite: true,
      playtimeMinutes: 600
    })
    const lib = buildRemoteLibrary(
      [],
      [{ hostId: 'h1', hostName: 'Living Room PC', games: offerOf([host]) }],
      now
    )
    expect(lib.updatedAt).toBe(now.toISOString())
    expect(lib.alsoOnHost).toEqual({})
    expect(lib.games).toHaveLength(1)
    const [remote] = lib.games
    expect(remote).toMatchObject({
      id: 'remote:h1:steam:620',
      source: 'steam',
      platformId: 'steam',
      installed: false,
      owned: false,
      // The host's favourite (the favourites sync); its play time stays the host's.
      favorite: true,
      playtimeMinutes: 0,
      launch: { kind: 'uri', uri: '' },
      tracking: { mode: 'none' },
      user: {},
      remote: {
        hostId: 'h1',
        hostName: 'Living Room PC',
        hostGameId: 'steam:620',
        streamable: true,
        downloadable: false
      }
    })
    expect(remote.media).toEqual({
      cover: 'media://remote/h1/steam%3A620/cover',
      logo: 'media://remote/h1/steam%3A620/logo',
      screenshots: ['media://remote/h1/steam%3A620/screenshot0']
    })
  })

  it('keeps the client copy of a game with the same id', () => {
    const mine = game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })
    const lib = buildRemoteLibrary(
      [mine],
      [{ hostId: 'h1', hostName: 'Den', games: offerOf([mine]) }],
      now
    )
    expect(lib.games).toEqual([])
    expect(lib.alsoOnHost['steam:620']).toEqual([
      {
        hostId: 'h1',
        hostName: 'Den',
        hostGameId: 'steam:620',
        streamable: true,
        downloadable: false
      }
    ])
  })

  it('matches PC games across stores by title when release years agree', () => {
    const mine = [
      game({
        id: 'gog:1',
        source: 'gog',
        title: 'The Witcher 3: Wild Hunt',
        metadata: { releaseDate: '2015-05-19' }
      }),
      game({ id: 'epic:w3', source: 'epic', title: 'Witcher 3 Wild Hunt' })
    ]
    const hostGames = [
      game({
        id: 'steam:292030',
        source: 'steam',
        title: 'The Witcher® 3: Wild Hunt',
        metadata: { releaseDate: '2016' }
      }),
      game({ id: 'steam:2', source: 'steam', title: 'Doom', metadata: { releaseDate: '2016' } })
    ]
    const client = [
      ...mine,
      game({ id: 'gog:doom', source: 'gog', title: 'DOOM', metadata: { releaseDate: '1993' } })
    ]
    const lib = buildRemoteLibrary(
      client,
      [{ hostId: 'h', hostName: 'H', games: offerOf(hostGames) }],
      now
    )
    expect(lib.alsoOnHost['gog:1']?.[0].hostGameId).toBe('steam:292030')
    expect(lib.alsoOnHost['epic:w3']?.[0].hostGameId).toBe('steam:292030')
    // Doom (1993) and Doom (2016) are different games.
    expect(lib.games.map((g) => g.id)).toEqual(['remote:h:steam:2'])
  })

  it('never matches two products from one store by title, even without years', () => {
    const mine = game({ id: 'steam:379720', source: 'steam', title: 'DOOM' })
    const hostGames = [
      game({ id: 'steam:2280', source: 'steam', title: 'Doom' }),
      game({ id: 'steam:9', source: 'steam', title: 'Doom' })
    ]
    const lib = buildRemoteLibrary(
      [mine],
      [{ hostId: 'h', hostName: 'H', games: offerOf(hostGames) }],
      now
    )
    expect(lib.alsoOnHost).toEqual({})
    // Nor do two such products on one host fold into one card.
    expect(lib.games.map((g) => g.id)).toEqual(['remote:h:steam:2280', 'remote:h:steam:9'])
  })

  it('skips hosts whose id would not parse back out of a remote id', () => {
    const offer = offerOf([game({ id: 'steam:1', source: 'steam', title: 'One' })])
    const lib = buildRemoteLibrary(
      [],
      [
        { hostId: 'a:b', hostName: 'A', games: offer },
        { hostId: '', hostName: 'B', games: offer },
        { hostId: 'ok-1.x_y', hostName: 'C', games: offer }
      ],
      now
    )
    expect(lib.games.map((g) => g.id)).toEqual(['remote:ok-1.x_y:steam:1'])
  })

  it('matches by the user title too', () => {
    const mine = game({
      id: 'xbox:abc',
      source: 'xbox',
      title: 'HaloMCC',
      user: { titleOverride: 'Halo MCC' }
    })
    const host = game({ id: 'steam:976730', source: 'steam', title: 'Halo MCC' })
    const lib = buildRemoteLibrary(
      [mine],
      [{ hostId: 'h', hostName: 'H', games: offerOf([host]) }],
      now
    )
    expect(lib.games).toEqual([])
    expect(Object.keys(lib.alsoOnHost)).toEqual(['xbox:abc'])
  })

  it('never matches a PC game with a ROM of the same title', () => {
    const mine = game({ id: 'rom:snes:1', source: 'rom', title: 'Doom' })
    const host = game({ id: 'steam:2280', source: 'steam', title: 'Doom' })
    const lib = buildRemoteLibrary(
      [mine],
      [{ hostId: 'h', hostName: 'H', games: offerOf([host]) }],
      now
    )
    expect(lib.games).toHaveLength(1)
  })

  it('matches ROMs on the same system by path or file name, and offers the rest for download', () => {
    const mine = [
      game({
        id: 'rom:snes:aaa',
        source: 'rom',
        title: 'Super Metroid',
        externalId: 'SNES/super metroid (usa).sfc'
      }),
      game({
        id: 'rom:snes:bbb',
        source: 'rom',
        title: 'Chrono Trigger',
        externalId: 'snes/CT.sfc'
      }),
      game({
        id: 'rom:genesis:c',
        source: 'rom',
        title: 'Sonic',
        platformId: 'genesis',
        externalId: 'genesis/s.md'
      })
    ]
    const hostGames = [
      game({
        id: 'rom:snes:h1',
        source: 'rom',
        title: 'Super Metroid (Japan)',
        externalId: 'snes/Super Metroid (USA).sfc'
      }),
      game({
        id: 'rom:snes:h2',
        source: 'rom',
        title: 'Chrono Trigger',
        externalId: 'snes/Chrono Trigger (USA).sfc'
      }),
      game({ id: 'rom:snes:h3', source: 'rom', title: 'Sonic', externalId: 'snes/Sonic.sfc' })
    ]
    const offer = JSON.parse(JSON.stringify(hostOffer(hostGames, { romSetSize: () => 4_000_000 })))
    const lib = buildRemoteLibrary(mine, [{ hostId: 'h', hostName: 'H', games: offer }], now)
    expect(lib.alsoOnHost['rom:snes:aaa']?.[0].hostGameId).toBe('rom:snes:h1')
    // The same title in another file ("CT.sfc" here, "Chrono Trigger (USA).sfc" there) is not taken for this PC's.
    expect(lib.alsoOnHost['rom:snes:bbb']).toBeUndefined()
    expect(lib.alsoOnHost['rom:genesis:c']).toBeUndefined()
    expect(lib.games.map((g) => g.id)).toEqual(['remote:h:rom:snes:h2', 'remote:h:rom:snes:h3'])
    expect(lib.games[1]).toMatchObject({
      id: 'remote:h:rom:snes:h3',
      platformId: 'snes',
      externalId: 'snes/Sonic.sfc',
      remote: { downloadable: true, streamable: true, sizeBytes: 4_000_000 }
    })
  })

  it('offers a game added by its .exe without its path', () => {
    const exe = game({
      id: 'manual:c:/users/jeremy/games/foo/foo.exe',
      source: 'manual',
      title: 'Foo',
      externalId: ['c:', 'users', 'jeremy', 'games', 'foo', 'foo.exe'].join(String.fromCharCode(92))
    })
    const [offered] = hostOffer([exe])
    expect(JSON.stringify(offered)).not.toMatch(/users|jeremy|foo[.]exe/i)
    expect(offered!.id).toBe(offeredId(exe))
    expect(offered!.id).toMatch(/^manual:/)
  })

  it('names a game folder by its folder (every PS4 dump is eboot.bin) and a disc set by its game', () => {
    expect(romStem('ps4/Bloodborne [CUSA00900]/eboot.bin')).toBe('bloodborne [cusa00900]')
    expect(romStem('ps4/Days Gone [CUSA08966]/eboot.bin')).toBe('days gone [cusa08966]')
    expect(romStem('psx/Final Fantasy VII (USA) (Disc 1).cue')).toBe('final fantasy vii (usa)')
    expect(romStem('psx/Final Fantasy VII (USA).m3u')).toBe('final fantasy vii (usa)')
    expect(romStem('snes/Chrono Trigger (USA).sfc')).toBe('chrono trigger (usa)')
    // A ROM sorted into a sub-folder keeps its own name, even a generic one; a dump's eboot.bin still takes its folder's.
    expect(romStem('ps2/Favorites 1/Game.iso')).toBe('game')
    expect(romStem('ps2/Favorites 1/Main.iso')).toBe('main')
    expect(romStem('ps4/Favorites/Bloodborne/EBOOT.BIN')).toBe('bloodborne')
    // Folder-per-game launchers are still named by their folder.
    expect(romStem('dos/Doom/GAME.BAT')).toBe('doom')
    expect(romStem('pc/Favorites/Half-Life/start.lnk')).toBe('half-life')
    expect(romStem('xbox/Halo/default.xbe')).toBe('halo')
    // A trimmed Xbox image is its full dump's game.
    expect(romStem('xbox/Halo (USA).xiso.iso')).toBe(romStem('xbox/Halo (USA).iso'))
  })

  it("shows each of a host's regional releases of a ROM, and one ROM in two formats once", () => {
    const rom = (id: string, externalId: string): Game =>
      game({ id, source: 'rom', title: 'Chrono Trigger', externalId })
    const offer = JSON.parse(
      JSON.stringify(
        hostOffer([
          rom('rom:snes:us', 'snes/Chrono Trigger (USA).sfc'),
          rom('rom:snes:jp', 'snes/Chrono Trigger (Japan).sfc'),
          rom('rom:snes:us2', 'snes/Chrono Trigger (USA).smc')
        ])
      )
    )
    const lib = buildRemoteLibrary([], [{ hostId: 'h', hostName: 'H', games: offer }], now)
    expect(lib.games.map((g) => g.id)).toEqual(['remote:h:rom:snes:us', 'remote:h:rom:snes:jp'])
  })

  it('shows a game two hosts have once, from the first host by name, and lists both hosts', () => {
    const portal = game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })
    const portalGog = game({ id: 'gog:p2', source: 'gog', title: 'Portal 2' })
    const lib = buildRemoteLibrary(
      [],
      [
        { hostId: 'z', hostName: 'Office', games: offerOf([portalGog]) },
        { hostId: 'a', hostName: 'den', games: offerOf([portal, portalGog]) }
      ],
      now
    )
    expect(lib.games.map((g) => g.id)).toEqual(['remote:a:steam:620'])
    // The den lists two copies: the host is listed once.
    expect(lib.alsoOnHost['remote:a:steam:620']?.map((i) => [i.hostId, i.hostGameId])).toEqual([
      ['a', 'steam:620'],
      ['z', 'gog:p2']
    ])
  })

  it('lists a host once for a local game it has twice, and skips repeated entries and hosts', () => {
    const mine = game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })
    const offer = offerOf([mine, game({ id: 'gog:p2', source: 'gog', title: 'Portal 2' }), mine])
    const host = { hostId: 'h', hostName: 'H', games: offer }
    const lib = buildRemoteLibrary([mine], [host, host], now)
    expect(lib.alsoOnHost['steam:620']).toHaveLength(1)
  })

  it('ignores broken host entries', () => {
    const lib = buildRemoteLibrary(
      [],
      [
        {
          hostId: 'h',
          hostName: 'H',
          games: [
            null,
            42,
            { id: 'x' },
            { ...offerOf([game({ id: 'steam:1', source: 'steam', title: 'One' })])[0] }
          ]
        }
      ],
      now
    )
    expect(lib.games.map((g) => g.id)).toEqual(['remote:h:steam:1'])
  })
})

describe('ids and urls', () => {
  it('round-trips remote ids whose host game id has colons', () => {
    expect(parseRemoteGameId('remote:h1:rom:snes:abc')).toEqual({
      hostId: 'h1',
      hostGameId: 'rom:snes:abc'
    })
    expect(parseRemoteGameId('steam:620')).toBeNull()
    expect(parseRemoteGameId('remote:h1:a\nb')).toEqual({ hostId: 'h1', hostGameId: 'a\nb' })
  })

  it('encodes the host game id in media urls', () => {
    expect(remoteMediaUrl('h1', 'rom:snes:a/b', 'cover')).toBe(
      'media://remote/h1/rom%3Asnes%3Aa%2Fb/cover'
    )
  })

  it("carries the revision of the host's images, so an image the host replaced has another url here", () => {
    // The host's SSX on the PlayStation 3: first with the cover of the game of 2000, then matched again.
    const ssx = (coverWrittenAt: number): Game =>
      game({
        id: 'rom:ps3:ssx',
        source: 'rom',
        title: 'SSX',
        platformId: 'ps3',
        media: {
          cover: `media://cache/rom_ps3_ssx/cover.png?v=${coverWrittenAt}`,
          hero: 'media://cache/rom_ps3_ssx/hero.jpg',
          screenshots: ['media://cache/rom_ps3_ssx/screenshot-0.jpg?v=1700000000001']
        },
        user: { customMedia: { logo: 'media://cache/rom_ps3_ssx/custom-logo.png?v=5' } }
      })
    const [before] = offerOf([ssx(1700000000000)])
    expect(before.mediaRevs).toEqual({
      cover: '1700000000000',
      logo: '5',
      screenshot0: '1700000000001'
    })
    const card = (offer: HostGame[]): Game =>
      buildRemoteLibrary([], [{ hostId: 'h1', hostName: 'Host', games: offer }]).games[0]!
    expect(card([before]).media).toEqual({
      cover: 'media://remote/h1/rom%3Aps3%3Assx/cover?v=1700000000000',
      hero: 'media://remote/h1/rom%3Aps3%3Assx/hero',
      logo: 'media://remote/h1/rom%3Aps3%3Assx/logo?v=5',
      screenshots: ['media://remote/h1/rom%3Aps3%3Assx/screenshot0?v=1700000000001']
    })
    const [after] = offerOf([ssx(1800000000000)])
    expect(card([after]).media.cover).toBe(
      'media://remote/h1/rom%3Aps3%3Assx/cover?v=1800000000000'
    )
    // An older host sends none: the urls are as they were.
    const older: HostGame = { ...before, mediaRevs: undefined }
    expect(card([older]).media.cover).toBe('media://remote/h1/rom%3Aps3%3Assx/cover')
    // Only a plain revision of a kind the host offers is taken from the network.
    const hostile = sanitizeHostGame({
      ...before,
      mediaRevs: { cover: '1&x=../..', hero: 12, logo: '7', icon: '9', screenshot0: 'a'.repeat(25) }
    })
    expect(hostile?.mediaRevs).toEqual({ logo: '7' })
  })

  it('tells a cached file of the revision asked for from an earlier one served in its place', () => {
    const dir = 'C:\\data\\media-cache\\h1\\'
    expect(isMediaRevision(`${dir}abc-cover.v1800000000000.png`, '1800000000000')).toBe(true)
    expect(isMediaRevision('/data/media-cache/h1/abc-cover.v18.jpg', '18')).toBe(true)
    // An earlier revision's file, or the unversioned one of an older host, standing in for the new one.
    expect(isMediaRevision(`${dir}abc-cover.v1700000000000.png`, '1800000000000')).toBe(false)
    expect(isMediaRevision(`${dir}abc-cover.png`, '1800000000000')).toBe(false)
    expect(isMediaRevision('/data/h1/abc-cover.v180.png', '18')).toBe(false)
    // No revision asked for (an older host), or not a usable one: the file there is the one.
    expect(isMediaRevision(`${dir}abc-cover.png`, undefined)).toBe(true)
    expect(isMediaRevision(`${dir}abc-cover.png`, '../x')).toBe(true)
  })
})

describe('metadata shared with clients', () => {
  it('shares what describes the game, never what is about the host', () => {
    const [offered] = hostOffer([
      game({
        id: 'steam:620',
        source: 'steam',
        title: 'Portal 2',
        metadata: {
          description: 'Portals.',
          hltb: { main: 8, extra: 14, completionist: 22 },
          localPlayers: { max: 2, coop: true },
          reviewScore: { source: 'steam', score: 98, label: 'Overwhelmingly Positive' },
          steamTags: { tags: ['Puzzle', 'Co-op'] },
          achievements: { unlocked: 50, total: 51, updatedAt: 'x' },
          currentPlayers: { count: 3000, updatedAt: 'x' },
          nameMatchRules: 2,
          rematch: 'igdb',
          rematchTried: { at: 'x', count: 1 },
          steamScreenshots: {
            items: [
              {
                thumbnail: 'https://shared.steamstatic.com/a.jpg',
                full: 'https://shared.steamstatic.com/b.jpg',
                local: 'media://cache/x/y.jpg'
              }
            ],
            updatedAt: 'x'
          }
        }
      })
    ])
    const sent = JSON.parse(JSON.stringify(offered)) as HostGame
    expect(sent.metadata).not.toHaveProperty('achievements')
    expect(sent.metadata).not.toHaveProperty('currentPlayers')
    expect(sent.metadata).not.toHaveProperty('nameMatchRules')
    // This PC's pending re-match is not the client's: there it would force a scrape of the client's own copy.
    expect(sent.metadata).not.toHaveProperty('rematch')
    expect(sent.metadata).not.toHaveProperty('rematchTried')
    expect(sent.metadata.steamScreenshots?.items[0]).toEqual({
      thumbnail: 'https://shared.steamstatic.com/a.jpg',
      full: 'https://shared.steamstatic.com/b.jpg'
    })
    // The client keeps it all, checked field by field.
    const kept = sanitizeHostGame(sent)!.metadata
    expect(kept).toMatchObject({
      description: 'Portals.',
      hltb: { main: 8, extra: 14, completionist: 22 },
      localPlayers: { max: 2, coop: true },
      reviewScore: { source: 'steam', score: 98, label: 'Overwhelmingly Positive' },
      steamTags: { tags: ['Puzzle', 'Co-op'] }
    })
    expect(kept.steamScreenshots?.items).toHaveLength(1)
  })

  it('drops what a broken or hostile host sends in the wrong shape', () => {
    const kept = sanitizeHostGame({
      id: 'steam:1',
      source: 'steam',
      title: 'X',
      platformId: 'steam',
      externalId: '1',
      metadata: {
        hltb: { main: 'eight', extra: -3 },
        reviewScore: { score: 'great' },
        steamScreenshots: { items: [{ thumbnail: 'javascript:alert(1)', full: 'https://a' }] },
        steamTags: { tags: 'Puzzle' }
      }
    })!.metadata
    expect(kept.hltb).toBeUndefined()
    expect(kept.reviewScore).toBeUndefined()
    expect(kept.steamScreenshots).toBeUndefined()
    expect(kept.steamTags).toBeUndefined()
  })
})

describe("the host's controls", () => {
  const withControls = (controls: unknown): unknown =>
    sanitizeHostGame({
      id: 'steam:1',
      source: 'steam',
      title: 'X',
      platformId: 'steam',
      externalId: '1',
      metadata: { steamTags: { tags: ['A'], controls } }
    })!.metadata.steamTags?.controls

  it('keeps touch when the host says it is supported', () => {
    expect(withControls({ controller: 'full', vr: null, touch: 'supported' })).toEqual({
      controller: 'full',
      vr: null,
      touch: 'supported'
    })
  })

  it('drops an unknown or missing touch value', () => {
    const bogus = withControls({ controller: 'full', vr: null, touch: 'bogus' })
    expect(bogus).toEqual({ controller: 'full', vr: null })
    expect(bogus).not.toHaveProperty('touch')
    const missing = withControls({ controller: 'full', vr: null })
    expect(missing).toEqual({ controller: 'full', vr: null })
    expect(missing).not.toHaveProperty('touch')
  })

  it('keeps full mouse and keyboard support, and drops an unknown keyboard value', () => {
    expect(withControls({ controller: 'full', vr: 'supported', keyboard: 'full' })).toEqual({
      controller: 'full',
      vr: 'supported',
      keyboard: 'full'
    })
    expect(withControls({ controller: 'full', vr: null, keyboard: true })).toEqual({
      controller: 'full',
      vr: null
    })
  })
})

describe("the host's achievement counts", () => {
  const counted = game({
    id: 'steam:620',
    source: 'steam',
    title: 'Portal 2',
    metadata: {
      releaseDate: '2011-04-19',
      achievements: { unlocked: 12, total: 51, updatedAt: '2026-11-01T00:00:00.000Z' }
    }
  })

  it('are offered beside the metadata, never in it', () => {
    const [entry] = offerOf([counted])
    expect(entry.achievements).toEqual({ unlocked: 12, total: 51 })
    expect(entry.metadata.achievements).toBeUndefined()
    // A game without achievements (or none counted yet) offers none.
    const [plain] = offerOf([game({ id: 'steam:1', source: 'steam', title: 'Plain' })])
    expect(plain.achievements).toBeUndefined()
  })

  it('are checked when received', () => {
    const [entry] = offerOf([counted])
    const bad = (achievements: unknown): unknown =>
      sanitizeHostGame({ ...entry, achievements })?.achievements
    expect(bad({ unlocked: 12, total: 51 })).toEqual({ unlocked: 12, total: 51 })
    expect(bad({ unlocked: 52, total: 51 })).toBeUndefined()
    expect(bad({ unlocked: 0, total: 0 })).toBeUndefined()
    expect(bad({ unlocked: -1, total: 5 })).toBeUndefined()
    expect(bad({ unlocked: 1.5, total: 5 })).toBeUndefined()
    expect(bad({ unlocked: '1', total: 5 })).toBeUndefined()
    expect(bad({ unlocked: 1, total: 1e9 })).toBeUndefined()
    expect(bad('12/51')).toBeUndefined()
  })

  it("show on a host-only game's card as its own counts", () => {
    const lib = buildRemoteLibrary(
      [],
      [{ hostId: 'h1', hostName: 'Living Room PC', games: offerOf([counted]) }],
      now
    )
    expect(lib.games[0].metadata.achievements).toEqual({
      unlocked: 12,
      total: 51,
      updatedAt: now.toISOString()
    })
  })

  it("never reach this PC's own copy of the game", () => {
    const mine = game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })
    const lib = buildRemoteLibrary(
      [mine],
      [{ hostId: 'h1', hostName: 'Living Room PC', games: offerOf([counted]) }],
      now
    )
    expect(lib.games).toEqual([])
    expect(lib.alsoOnHost['steam:620']).toHaveLength(1)
    expect(JSON.stringify(lib)).not.toContain('"achievements"')
  })
})

describe("a recompilation's own card", () => {
  it('is offered (it streams its recompilation) with no file, though it is not installed', () => {
    const offer = hostOffer([
      game({
        id: 'rom:n64:own',
        source: 'rom',
        title: "Majora's Mask",
        platformId: 'n64',
        installed: false,
        launch: { kind: 'emulator', systemId: 'n64', romPath: '' },
        extra: { recompOnly: 'n64:majoras mask' }
      })
    ])
    expect(offer).toHaveLength(1)
    expect(offer[0]).toMatchObject({ id: 'rom:n64:own', noRomFile: true })
    expect(offer[0]).not.toHaveProperty('extra')
    expect(offer[0]).not.toHaveProperty('sizeBytes')
  })
})

describe('a recompilation card and a ROM of the same game', () => {
  const card = game({
    id: 'rom:n64:own',
    source: 'rom',
    title: "Majora's Mask",
    platformId: 'n64',
    externalId: 'Recompilations/n64:majoras mask',
    installed: false
  })
  const romOf = game({
    id: 'rom:n64:abc',
    source: 'rom',
    title: "Majora's Mask",
    platformId: 'n64',
    externalId: "n64/Majora's Mask (USA).z64"
  })
  it('fold together by system and title, either way round', () => {
    expect(isRecompCard(card)).toBe(true)
    expect(isRecompCard(romOf)).toBe(false)
    expect(
      localMatches([romOf], [card as unknown as HostGame])
        .get(card.id)
        ?.map((g) => g.id)
    ).toEqual([romOf.id])
    expect(
      localMatches([card], [romOf as unknown as HostGame])
        .get(romOf.id)
        ?.map((g) => g.id)
    ).toEqual([card.id])
    // Another system's game of that title is another game.
    const other = { ...romOf, id: 'rom:snes:x', platformId: 'snes' }
    expect(localMatches([other], [card as unknown as HostGame]).get(card.id)).toBeUndefined()
  })
})

describe("when a host's game was last played", () => {
  const played = '2026-11-06T20:00:00.000Z'
  const hades = (over: Partial<Game> = {}): Game =>
    game({ id: 'steam:1145360', source: 'steam', title: 'Hades', lastPlayed: played, ...over })
  /** A host that sent its clock with its offer (an updated PlayOut), the two clocks agreeing. */
  const hostOf = (games: unknown[], over: Partial<HostOfferInput> = {}): HostOfferInput => ({
    hostId: 'host-1',
    hostName: 'Living Room',
    games,
    skewMs: 0,
    ...over
  })

  it("shows on the host-only game's card; its play time and play count stay the host's", () => {
    const offer = offerOf([hades({ playtimeMinutes: 90, playCount: 4 })])
    expect(offer[0].lastPlayed).toBe(played)
    const card = buildRemoteLibrary([], [hostOf(offer)], now).games[0]
    expect(card).toMatchObject({ lastPlayed: played, playtimeMinutes: 0, playCount: 0 })
  })

  it('stays empty for a game the host never played, and for an older or switched-off host that sends none', () => {
    const never = offerOf([hades({ lastPlayed: undefined })])
    expect(buildRemoteLibrary([], [hostOf(never)], now).games[0]).not.toHaveProperty('lastPlayed')
    // The offer then has no such field at all, as one from an older or switched-off host.
    expect(never[0]).not.toHaveProperty('lastPlayed')
    expect(sanitizeHostGame(never[0])).not.toHaveProperty('lastPlayed')
  })

  it('is checked when received: no date, an absurd length or the wrong type is dropped', () => {
    const base = offerOf([hades()])[0]
    expect(sanitizeHostGame(base)?.lastPlayed).toBe(played)
    for (const bad of ['soon', '', 12345, null, { at: played }, `${played}${' '.repeat(40)}`])
      expect(sanitizeHostGame({ ...base, lastPlayed: bad })).not.toHaveProperty('lastPlayed')
  })

  it("is put on this PC's clock, and dropped when more than a day ahead of it", () => {
    const nowMs = now.getTime()
    // The host's clock runs an hour ahead: what it calls 20:00 was 19:00 here.
    expect(lastPlayedHere(played, nowMs, 3_600_000)).toBe('2026-11-06T19:00:00.000Z')
    // Below a second the difference is the request's own timing.
    expect(lastPlayedHere(played, nowMs, 400)).toBe(played)
    expect(lastPlayedHere(played, nowMs, Number.NaN)).toBe(played)
    expect(lastPlayedHere(undefined, nowMs)).toBeUndefined()
    expect(lastPlayedHere('2026-11-09T12:00:00.000Z', nowMs)).toBeUndefined()
    // Ahead of this PC's clock by less than that day (a wrong time zone, a date that was never on the host's clock):
    // taken as now, so it never outranks a game played on this PC after it.
    const soon = new Date(nowMs + 3 * 3_600_000).toISOString()
    expect(lastPlayedHere(soon, nowMs)).toBe(now.toISOString())
    expect(lastPlayedHere(soon, nowMs, -3_600_000)).toBe(now.toISOString())
    expect(lastPlayedHere(now.toISOString(), nowMs)).toBe(now.toISOString())
    const aheadCard = buildRemoteLibrary([], [hostOf(offerOf([hades({ lastPlayed: soon })]))], now)
      .games[0]
    expect(aheadCard.lastPlayed).toBe(now.toISOString())
    // A day ahead on the host's clock, but that clock is two days ahead: yesterday here.
    expect(lastPlayedHere('2026-11-08T12:00:00.000Z', nowMs, 2 * 86_400_000)).toBe(
      '2026-11-06T12:00:00.000Z'
    )
    const offer = offerOf([hades()])
    expect(
      buildRemoteLibrary([], [hostOf(offer, { skewMs: 3_600_000 })], now).games[0].lastPlayed
    ).toBe('2026-11-06T19:00:00.000Z')
    const ahead = offerOf([hades({ lastPlayed: '2027-01-01T00:00:00.000Z' })])
    expect(buildRemoteLibrary([], [hostOf(ahead)], now).games[0]).not.toHaveProperty('lastPlayed')
  })

  it('is not shown from a host that sent no clock (an older PlayOut cannot withhold its dates)', () => {
    const offer = offerOf([hades()])
    const older = hostOf(offer, { skewMs: undefined })
    expect(buildRemoteLibrary([], [older], now).games[0]).not.toHaveProperty('lastPlayed')
    // One card for two hosts: only the updated host's date counts, whichever comes first.
    const earlier = '2026-11-01T08:00:00.000Z'
    const updated = hostOf(offerOf([hades({ lastPlayed: earlier })]), {
      hostId: 'host-2',
      hostName: 'Office'
    })
    for (const hosts of [
      [older, updated],
      [updated, older]
    ])
      expect(buildRemoteLibrary([], hosts, now).games).toMatchObject([{ lastPlayed: earlier }])
  })

  it('is the latest of every host that has the game (one card)', () => {
    const later = '2026-11-07T08:00:00.000Z'
    const lib = buildRemoteLibrary(
      [],
      [
        hostOf(offerOf([hades()])),
        hostOf(offerOf([hades({ lastPlayed: later })]), { hostId: 'host-2', hostName: 'Office' }),
        hostOf(offerOf([hades({ lastPlayed: undefined })]), { hostId: 'host-3', hostName: 'Zed' })
      ],
      now
    )
    expect(lib.games).toHaveLength(1)
    expect(lib.games[0]).toMatchObject({ id: 'remote:host-1:steam:1145360', lastPlayed: later })
  })

  it("never changes this PC's own copy of the game (the play time sync brings its sessions)", () => {
    const mine = hades({ lastPlayed: undefined, installed: false, owned: true })
    const lib = buildRemoteLibrary([mine], [hostOf(offerOf([hades()]))], now)
    expect(lib.games).toEqual([])
    expect(lib.alsoOnHost[mine.id]).toHaveLength(1)
    expect(mine.lastPlayed).toBeUndefined()
  })
})

describe("the host's RetroAchievements hashes", () => {
  const HASH = '0123456789abcdef0123456789abcdef'
  const rom = game({
    id: 'rom:snes:smw',
    source: 'rom',
    title: 'Super Mario World',
    externalId: 'snes/Super Mario World (USA).sfc',
    romPath: 'D:\\ROMs\\snes\\Super Mario World (USA).sfc'
  })
  const wire = (games: Game[], raHash: (g: Game) => string | undefined): HostGame[] =>
    JSON.parse(JSON.stringify(hostOffer(games, { raHash }))) as HostGame[]

  it("are offered for ROM files the host hashed, and reach the client's host-only game", () => {
    const [entry] = wire([rom], () => HASH.toUpperCase())
    expect(entry.raHash).toBe(HASH)
    const lib = buildRemoteLibrary([], [{ hostId: 'h1', hostName: 'Den', games: [entry] }], now)
    expect(lib.games[0].remote?.raHash).toBe(HASH)
    // Nothing known (or no callback): none offered.
    expect(wire([rom], () => undefined)[0].raHash).toBeUndefined()
    expect(offerOf([rom])[0].raHash).toBeUndefined()
  })

  it('are checked when received', () => {
    const [entry] = wire([rom], () => HASH)
    const received = (raHash: unknown): unknown => sanitizeHostGame({ ...entry, raHash })?.raHash
    expect(received(HASH)).toBe(HASH)
    expect(received('not-a-hash')).toBeUndefined()
    expect(received(`${HASH}0`)).toBeUndefined()
    expect(received(42)).toBeUndefined()
    // Only ROMs carry one.
    const steam = offerOf([game({ id: 'steam:620', source: 'steam', title: 'Portal 2' })])[0]
    expect(sanitizeHostGame({ ...steam, raHash: HASH })?.raHash).toBeUndefined()
  })
})

describe("this PC's RetroAchievements answer for a host's ROM", () => {
  const hostRom = (metadata: Game['metadata'] = {}): Game =>
    game({
      id: 'remote:h1:rom:snes:smw',
      source: 'rom',
      title: 'Super Mario World',
      metadata: {
        achievements: { unlocked: 1, total: 96, updatedAt: '' },
        sources: { igdb: '1' },
        ...metadata
      },
      remote: {
        hostId: 'h1',
        hostName: 'Den',
        hostGameId: 'rom:snes:smw',
        streamable: true,
        downloadable: true
      }
    })

  it("replaces the host's counts, or takes them off for a ROM without achievements", () => {
    const mine = withRemoteRetro(hostRom(), {
      raId: 228,
      unlocked: 40,
      total: 96,
      updatedAt: 'x'
    })
    expect(mine.metadata.achievements).toEqual({ unlocked: 40, total: 96, updatedAt: 'x' })
    expect(mine.metadata.sources).toEqual({ igdb: '1', retroachievements: '228' })
    const none = withRemoteRetro(hostRom(), { none: true })
    expect(none.metadata.achievements).toBeUndefined()
    expect(none.metadata.sources?.retroachievements).toBe('none')
  })

  it("leaves the host's counts without an answer, and on its recompilation's counts", () => {
    const plain = hostRom()
    expect(withRemoteRetro(plain, undefined)).toBe(plain)
    const recomp = hostRom({ sources: { 'recomp-achievements': 'github:x/y' } })
    expect(withRemoteRetro(recomp, { none: true })).toBe(recomp)
  })
})
