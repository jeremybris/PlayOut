import { defaultSettings } from '@shared/defaults'
import type { Game, GameMetadata, RemoteLibrary } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  developerKey,
  platformGroupOf,
  similarGames,
  similarPool,
  titleWords
} from './similarGames'

function game(id: string, meta: Partial<GameMetadata> = {}, patch: Partial<Game> = {}): Game {
  const title = patch.title ?? id
  return {
    id,
    source: 'steam',
    externalId: id,
    platformId: 'steam',
    title,
    sortTitle: title.toLowerCase(),
    installed: true,
    launch: { kind: 'uri', uri: '' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: meta,
    media: {},
    metadataStatus: 'none',
    user: {},
    ...patch
  }
}

const score = (n: number): GameMetadata['reviewScore'] => ({ source: 'steam', score: n })

const factorio = game('Factorio', {
  genres: ['Simulation', 'Strategy'],
  developers: ['Wube Software LTD.'],
  reviewScore: score(98),
  hltb: { main: 53.3 }
})

describe('similarGames', () => {
  it('ranks by Genres & Tags, developer, title, review score and How Long To Beat, most similar first', () => {
    const twin = game(
      'Twin',
      {
        genres: ['Strategy', 'Simulation'],
        developers: ['Wube Software'],
        reviewScore: score(98),
        hltb: { main: 53.3 }
      },
      { title: 'Factorio 2' }
    )
    const close = game('Close', {
      genres: ['Simulation', 'Strategy'],
      developers: ['Other'],
      reviewScore: score(90),
      hltb: { main: 40 }
    })
    const far = game('Far', {
      genres: ['Strategy', 'Shooter', 'Action'],
      developers: ['Other'],
      reviewScore: score(60),
      hltb: { main: 10 }
    })
    const unrelated = game('Unrelated', {
      genres: ['Racing'],
      developers: ['Someone'],
      reviewScore: score(98),
      hltb: { main: 53.3 }
    })
    const list = similarGames(factorio, [far, unrelated, close, twin, factorio])
    expect(list.map((s) => s.game.id)).toEqual(['Twin', 'Close', 'Far'])
    expect(list[0]!.percent).toBe(100)
    // Genres alike (0.25), another developer (0 of 0.2), no title word shared (0 of 0.25), 8 points apart
    // (0.05 x 0.84), 40 of 53.3 hours (0.1 x 0.75), both PC games (0.1); no publisher known: out of 0.95.
    expect(list[1]!.percent).toBe(Math.round(((0.25 + 0.042 + 0.075 + 0.1) / 0.95) * 100))
    expect(list[2]!.percent).toBeLessThan(list[1]!.percent)
  })

  it('counts only what both games know, and the same developer alone makes a candidate', () => {
    const sameDev = game('Space Age', { developers: ['Wube Software, Ltd.'] })
    const list = similarGames(factorio, [sameDev])
    // Genres (only Factorio has some: 0 of 0.25), the developer (0.2), the title (0 of 0.25), the platform (0.1):
    // 0.3 / 0.8.
    expect(list).toEqual([{ game: sameDev, percent: 38 }])
  })

  it('leaves out copies of the game itself and keeps at most ten', () => {
    const copy = game(
      'epic:factorio',
      { genres: ['Simulation', 'Strategy'] },
      { title: 'Factorio' }
    )
    const many = Array.from({ length: 15 }, (_, i) =>
      game(`g${i}`, { genres: ['Strategy'], hltb: { main: 10 + i } })
    )
    const list = similarGames(factorio, [copy, ...many])
    expect(list).toHaveLength(10)
    expect(list.some((s) => s.game.id === 'epic:factorio')).toBe(false)
    // The longest (closest to 53 hours) first.
    expect(list[0]!.game.id).toBe('g14')
  })

  it('finds none in a library without a game that shares anything', () => {
    expect(similarGames(factorio, [game('Racer', { genres: ['Racing'] })])).toEqual([])
    expect(similarGames(game('Bare'), [factorio])).toEqual([])
    expect(similarGames(factorio, [])).toEqual([])
  })

  it('shows 100% only for games alike in everything compared', () => {
    const near = game(
      'Near',
      {
        genres: ['Simulation', 'Strategy'],
        developers: ['Wube Software'],
        reviewScore: score(97),
        hltb: { main: 53.3 }
      },
      { title: 'Factorio 2' }
    )
    expect(similarGames(factorio, [near])[0]!.percent).toBe(99)
  })

  it('counts Genres & Tags as the tags in common out of all the tags of both: 3 of 5 is 3/5 of their 25%', () => {
    const a = game(
      'alpha',
      { genres: ['RTS', 'Base Building', 'Strategy', '3D'] },
      { title: 'Alpha' }
    )
    const b = game(
      'beta',
      { genres: ['RTS', 'Base Building', 'Strategy', 'Shooter'] },
      { title: 'Beta' }
    )
    // RTS, Base Building and Strategy in common, 3D and Shooter not: 0.25 x 3/5 = 0.15; with the title (0 of 0.25)
    // and the platform (both PC, 0.1): 0.25 of the 0.6 compared.
    expect(similarGames(a, [b])).toEqual([{ game: b, percent: 42 }])
    // On different platforms the Genres & Tags share stays 3/5: 0.15 of 0.6.
    const onPs2 = { ...b, source: 'rom' as const, platformId: 'ps2' }
    expect(similarGames(a, [onPs2])).toEqual([{ game: onPs2, percent: 25 }])
  })

  it('compares genres the Library filter does not list by name', () => {
    const sf2 = game('sf2', { genres: ['Fighting'], developers: ['Capcom'] }, { source: 'rom' })
    const tekken = game(
      'tekken',
      { genres: ['Fighting'], developers: ['Namco'] },
      { source: 'rom' }
    )
    const list = similarGames(sf2, [tekken])
    expect(list.map((x) => x.game.id)).toEqual(['tekken'])
    // Genres alike (0.25), another developer (0 of 0.2), no title word shared (0 of 0.25), both in the steam ROM
    // folder (PC, 0.1): 0.35 / 0.8.
    expect(list[0]!.percent).toBe(44)
  })

  it('tells copies of a non-Latin title by their letters', () => {
    const a = game('a', { genres: ['Action'] }, { title: '大神' })
    const b = game('b', { genres: ['Action'] }, { title: 'ゼルダの伝説' })
    expect(similarGames(a, [b]).map((x) => x.game.id)).toEqual(['b'])
  })

  it('counts the publisher, and a shared publisher alone makes a candidate', () => {
    const ea = (id: string, genres: string[]): Game =>
      game(id, { genres, publishers: ['Electronic Arts Inc.'], developers: [id] })
    const fifa = ea('fifa', ['Sports'])
    const madden = ea('madden', ['Sports'])
    const mass = ea('mass', ['RPG'])
    const list = similarGames(fifa, [mass, madden])
    expect(list.map((x) => x.game.id)).toEqual(['madden', 'mass'])
    // Mass Effect: other genres (0 of 0.25), developer (0 of 0.2), publisher (0.05), title (0 of 0.25), platform
    // (0.1): 0.15 / 0.85.
    expect(list[1]!.percent).toBe(18)
  })

  it('counts a series by its title words, sequels and editions alike', () => {
    const ds = game(
      'ds',
      { genres: ['RPG'], developers: ['FromSoftware'] },
      { title: 'Dark Souls' }
    )
    const ds3 = game(
      'ds3',
      { genres: ['Action'], developers: ['Other'] },
      {
        title: 'DARK SOULS III: Deluxe Edition'
      }
    )
    const other = game('other', { genres: ['Action'], developers: ['Other'] }, { title: 'Sekiro' })
    // Nothing else shared: the title alone makes Dark Souls III a candidate, Sekiro is not one.
    const list = similarGames(ds, [other, ds3])
    expect(list.map((x) => x.game.id)).toEqual(['ds3'])
    // Title (0.25) and platform (0.1) out of genres 0.25, developer 0.2, title 0.25 and platform 0.1: 0.35 / 0.8.
    expect(list[0]!.percent).toBe(44)
  })

  it('takes a title as a series only when the whole shorter title is shared, and no 100% from a title alone', () => {
    const portal = game('portal', {}, { title: 'Portal' })
    const knights = game('knights', {}, { title: 'Portal Knights' })
    const sequel = game('sequel', {}, { title: 'Portal 2' })
    const list = similarGames(portal, [knights, sequel])
    // Portal 2: the same words and platform, but compared on those only (0.35 of the weight): 99% at most. Portal
    // Knights, only the same first word: title 0.25 + ((1 + 1/2) / 2) / 2 = 0.625, platform 1: (0.156 + 0.1) / 0.35.
    expect(list).toEqual([
      { game: sequel, percent: 99 },
      { game: knights, percent: 73 }
    ])
    // Everyday words make no series.
    const takes = game('takes', {}, { title: 'It Takes Two' })
    expect(similarGames(takes, [game('lurks', {}, { title: 'It Lurks Below' })])).toEqual([])
    expect(similarGames(takes, [game('two', {}, { title: 'Two Point Hospital' })])).toEqual([])
  })

  it('matches sequels by their title: SSX (2012) and SSX 3, and sequels with their own subtitles', () => {
    const t = (id: string, title: string): Game => game(id, { genres: ['Sports'] }, { title })
    const ssx = t('ssx', 'SSX (2012)')
    // The year and the number are left out: the same title words (100%). SSX Tricky, the same first word: genres
    // (0.25), title 0.25 x (0.25 + ((1 + 1/2) / 2) / 2) and platform (0.1), out of 0.6.
    const list = similarGames(ssx, [t('tricky', 'SSX Tricky'), t('ssx3', 'SSX 3')])
    expect(list.map((x) => [x.game.id, x.percent])).toEqual([
      ['ssx3', 100],
      ['tricky', 84]
    ])
    // A shared series name of two words or more counts more than a first word alone.
    const gta3 = game('gta3', {}, { title: 'Grand Theft Auto III' })
    const vice = game('vice', {}, { title: 'Grand Theft Auto: Vice City' })
    const grandia = game('grandia', {}, { title: 'Grandia' })
    const grandOld = game('grandold', {}, { title: 'Grand Ages: Rome' })
    expect(similarGames(gta3, [grandOld, grandia, vice]).map((x) => x.game.id)).toEqual([
      'vice',
      'grandold'
    ])
    // Sequels with different subtitles, and series with two-letter names, are one series.
    const ds2 = game('ds2', {}, { title: 'Dark Souls II: Scholar of the First Sin' })
    const ds3 = game('ds3', {}, { title: 'DARK SOULS III: Ashes of Ariandel' })
    expect(similarGames(ds2, [ds3]).map((x) => x.game.id)).toEqual(['ds3'])
    const mcc = game('mcc', {}, { title: 'Halo: The Master Chief Collection' })
    expect(similarGames(mcc, [game('inf', {}, { title: 'Halo Infinite' })])).toHaveLength(1)
    expect(
      similarGames(game('ys1', {}, { title: 'Ys I' }), [game('ys8', {}, { title: 'Ys VIII' })])
    ).toHaveLength(1)
    // Different series: no match by title.
    expect(similarGames(ds2, [game('sekiro', {}, { title: 'Sekiro: Shadows Die Twice' })])).toEqual(
      []
    )
  })

  it('ranks games that share every genre above a game that only starts with the same everyday word', () => {
    const horror = ['Action', 'Horror', 'Shooter']
    const deadSpace = game(
      'ds',
      { genres: horror, reviewScore: score(89), hltb: { main: 12 } },
      {
        title: 'Dead Space'
      }
    )
    const deadCells = game(
      'cells',
      { genres: ['Action', 'Indie', 'Platformer'], reviewScore: score(96), hltb: { main: 18 } },
      { title: 'Dead Cells' }
    )
    const callisto = game(
      'callisto',
      { genres: horror, reviewScore: score(70), hltb: { main: 12 } },
      {
        title: 'The Callisto Protocol'
      }
    )
    const list = similarGames(deadSpace, [deadCells, callisto])
    expect(list.map((x) => x.game.id)).toEqual(['callisto', 'cells'])
    // A word inside another title is no series: only the share of their words in common, and no candidate by it.
    expect(
      similarGames(game('control', {}, { title: 'Control' }), [
        game('mind', {}, { title: 'Mind Control' })
      ])
    ).toEqual([])
  })

  it('reads the words that name a game from its title', () => {
    expect([...titleWords('DARK SOULS™ III: The Fire Fades Edition')]).toEqual([
      'dark',
      'souls',
      'fire',
      'fades'
    ])
    expect([...titleWords('Final Fantasy VII Remake')]).toEqual(['final', 'fantasy'])
    expect([...titleWords('Pokémon Crystal')]).toEqual(['pokemon', 'crystal'])
    expect([...titleWords('2048')]).toEqual([])
    // Kana and Indic letters keep their marks (one word each, not fragments).
    expect([...titleWords('ドラゴンクエスト')]).toEqual(['ドラゴンクエスト'])
    expect([...titleWords('तेरा नाम')]).toEqual(['तेरा', 'नाम'])
  })

  it('groups platforms: alike machines match, the rest are left out', () => {
    const on = (
      source: Game['source'],
      platformId: string
    ): Pick<Game, 'source' | 'platformId'> => ({
      source,
      platformId
    })
    // Every store's game is PC, and so are the Windows ROM folders.
    expect(platformGroupOf(on('steam', 'steam'))).toBe('pc')
    expect(platformGroupOf(on('gog', 'gog'))).toBe('pc')
    expect(platformGroupOf(on('xbox', 'xbox-pc'))).toBe('pc')
    expect(platformGroupOf(on('manual', 'pc'))).toBe('pc')
    expect(platformGroupOf(on('rom', 'windows'))).toBe('pc')
    // A recompilation of a Windows game (platform 'pc') is a PC game, not a DOS one.
    expect(platformGroupOf(on('rom', 'pc'))).toBe('pc')
    const same = (x: string, y: string): boolean =>
      platformGroupOf(on('rom', x)) !== null &&
      platformGroupOf(on('rom', x)) === platformGroupOf(on('rom', y))
    expect(same('ps2', 'gc')).toBe(true)
    expect(same('xbox', 'psp')).toBe(true)
    expect(same('gba', 'n3ds')).toBe(true)
    expect(same('ps3', 'switch')).toBe(true)
    expect(same('switch2', 'ps5')).toBe(true)
    expect(same('psx', 'dreamcast')).toBe(true)
    expect(same('snes', 'genesis')).toBe(true)
    expect(same('megadrivejp', 'nes')).toBe(true)
    expect(same('neogeocd', 'amigacd32')).toBe(true)
    expect(same('pcengine', 'dos')).toBe(true)
    expect(same('ps2', 'ps3')).toBe(false)
    // The original Xbox (a ROM) is not the Xbox app's PC games; DOS is not PC.
    expect(platformGroupOf(on('rom', 'xbox'))).not.toBe('pc')
    expect(platformGroupOf(on('rom', 'dos'))).not.toBe('pc')
    // Systems no group lists: no platform, left out of the comparison.
    expect(platformGroupOf(on('rom', 'atari2600'))).toBeNull()
    expect(platformGroupOf(on('rom', 'psvita'))).toBeNull()
  })

  it('compares developers without punctuation and company suffixes', () => {
    expect(developerKey('Wube Software LTD.')).toBe(developerKey('Wube Software'))
    expect(developerKey('Valve Corporation')).toBe('valve')
    expect(developerKey('FromSoftware, Inc.')).toBe('fromsoftware')
  })
})

describe('similarPool', () => {
  it("takes a paired host's games too, so each of two games finds the other (SSX (2012) here, SSX 3 on the host)", () => {
    const meta = (review: number, hltb: number): Partial<GameMetadata> => ({
      genres: ['Racing', 'Sport'],
      developers: ['EA Canada'],
      publishers: ['EA Sports'],
      reviewScore: { source: 'igdb', score: review },
      hltb: { main: hltb }
    })
    const ssx2012 = game('rom:xbox360:ssx', meta(80, 8), {
      title: 'SSX',
      source: 'rom',
      platformId: 'xbox360'
    })
    const ssx3 = game('remote:h1:rom:ps2/ssx3', meta(92, 10), {
      title: 'SSX 3',
      source: 'rom',
      platformId: 'ps2',
      installed: false,
      remote: {
        hostId: 'h1',
        hostName: 'Living Room PC',
        hostGameId: 'rom:ps2/ssx3',
        streamable: false,
        downloadable: true
      }
    })
    const remote: RemoteLibrary = {
      games: [ssx3],
      alsoOnHost: {},
      updatedAt: '2026-11-24T00:00:00.000Z'
    }
    const pool = similarPool([ssx2012], defaultSettings(), remote)
    const there = similarGames(ssx2012, pool)
    const back = similarGames(ssx3, pool)
    expect(there.map((x) => x.game.id)).toEqual([ssx3.id])
    expect(back.map((x) => x.game.id)).toEqual([ssx2012.id])
    // The same score both ways.
    expect(there[0]!.percent).toBe(back[0]!.percent)
    // The host's copies of one game on other systems are one row (the best-scoring one).
    const ssx3Xbox = {
      ...ssx3,
      id: 'remote:h1:rom:xbox/ssx3',
      platformId: 'xbox',
      metadata: { ...ssx3.metadata, reviewScore: { source: 'igdb' as const, score: 60 } }
    }
    const both: RemoteLibrary = { ...remote, games: [ssx3Xbox, ssx3] }
    expect(
      similarGames(ssx2012, similarPool([ssx2012], defaultSettings(), both)).map((x) => x.game.id)
    ).toEqual([ssx3.id])
    // Hidden by Settings > Streaming: the host's games are not in the pool.
    const off = defaultSettings()
    off.streaming.showHostGames = false
    expect(similarPool([ssx2012], off, remote).map((g) => g.id)).toEqual([ssx2012.id])
  })
})
