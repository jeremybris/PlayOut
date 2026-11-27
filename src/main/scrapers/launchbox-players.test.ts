import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { deflateRawSync } from 'zlib'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Game, GameMetadata } from '../../shared/types'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import {
  buildIndexFromZip,
  createLocalPlayers,
  createLookup,
  createMetadataXmlReader,
  findZipEntry,
  LAUNCHBOX_INDEX_FILE,
  LAUNCHBOX_INDEX_TTL_MS,
  launchBoxPlatforms,
  localPlayersRecord,
  matchLaunchBox,
  parseGenres,
  WITH_GENRES,
  WITH_PLAYERS,
  type LaunchBoxGame
} from './launchbox-players'

const NOW = Date.parse('2026-11-06T00:00:00Z')

/** A Metadata.xml in LaunchBox's layout. */
function metadataXml(games: string[], alternates: string[] = []): string {
  return `<?xml version="1.0" standalone="yes"?>\n<LaunchBox>\n${games.join('\n')}\n${alternates.join('\n')}\n</LaunchBox>\n`
}

function gameXml(fields: Record<string, string | number | boolean>): string {
  return `  <Game>\n${Object.entries(fields)
    .map(([k, v]) => `    <${k}>${v}</${k}>`)
    .join('\n')}\n    <Genres />\n  </Game>`
}

const PORTAL_2 = gameXml({
  Name: 'Portal 2',
  ReleaseYear: 2011,
  MaxPlayers: 2,
  Cooperative: true,
  DatabaseID: 914,
  SteamAppId: 620,
  Platform: 'Windows'
})
const PORTAL_2_X360 = gameXml({
  Name: 'Portal 2',
  MaxPlayers: 2,
  Cooperative: false,
  DatabaseID: 6270,
  Platform: 'Microsoft Xbox 360'
})
const KH3 = gameXml({
  Name: 'Kingdom Hearts III',
  MaxPlayers: 1,
  Cooperative: false,
  DatabaseID: 199529,
  Platform: 'Windows'
})
const NO_COUNT = gameXml({
  Name: 'Mystery',
  Cooperative: false,
  DatabaseID: 1,
  Platform: 'Windows'
})
const AMP = gameXml({
  Name: 'Ratchet &amp; Clank',
  MaxPlayers: 1,
  Cooperative: false,
  DatabaseID: 7,
  Platform: 'Sony Playstation 2'
})

/** A zip holding `files` (deflated), as Metadata.zip is. */
function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8')
    const data = deflateRawSync(raw)
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(8, 10)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(raw.length, 24)
    dir.writeUInt16LE(nameBytes.length, 28)
    dir.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    central.push(dir, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const dirBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(dirBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dirBytes, end])
}

function makeGame(
  id: string,
  over: Partial<Game> = {},
  metadata: Partial<GameMetadata> = {}
): Game {
  return {
    id,
    title: id,
    source: 'steam',
    externalId: '1',
    platformId: 'steam',
    metadataStatus: 'done',
    installed: false,
    metadata,
    user: {},
    ...over
  } as unknown as Game
}

describe('Metadata.xml reading', () => {
  it('keeps the games with a player count, across chunk boundaries, with their alternate names', () => {
    const xml = metadataXml(
      [PORTAL_2, NO_COUNT, KH3, AMP],
      [
        '  <GameAlternateName>\n    <AlternateName>KH3</AlternateName>\n    <DatabaseID>199529</DatabaseID>\n    <Region>North America</Region>\n  </GameAlternateName>'
      ]
    )
    const reader = createMetadataXmlReader()
    // Seven-character chunks: every block is split somewhere.
    for (let i = 0; i < xml.length; i += 7) reader.push(xml.slice(i, i + 7))
    expect([...reader.games.keys()].sort((a, b) => a - b)).toEqual([7, 914, 199529])
    expect(reader.games.get(914)).toEqual({
      id: 914,
      name: 'Portal 2',
      platform: 'Windows',
      max: 2,
      coop: true,
      steam: 620,
      year: 2011
    })
    expect(reader.games.get(7)?.name).toBe('Ratchet & Clank')
    expect(reader.alternates.get(199529)).toEqual(['KH3'])
  })

  it("streams Metadata.xml out of LaunchBox's zip into an index", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'playout-lb-'))
    try {
      const zip = join(dir, 'Metadata.zip')
      await writeFile(
        zip,
        zipOf({ 'Metadata.xml': metadataXml([PORTAL_2, KH3]), 'Mame.xml': '<Mame />' })
      )
      expect((await findZipEntry(zip, 'Metadata.xml')).method).toBe(8)
      await expect(findZipEntry(zip, 'Nope.xml')).rejects.toThrow(/not in the zip/)
      const index = await buildIndexFromZip(zip)
      expect(index.games.map((g) => g.name).sort()).toEqual(['Kingdom Hearts III', 'Portal 2'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('matchLaunchBox', () => {
  const games: LaunchBoxGame[] = [
    { id: 914, name: 'Portal 2', platform: 'Windows', max: 2, coop: true, steam: 620, year: 2011 },
    { id: 6270, name: 'Portal 2', platform: 'Microsoft Xbox 360', max: 2 },
    { id: 199529, name: 'Kingdom Hearts III', platform: 'Windows', max: 1 },
    { id: 1, name: 'Hades', platform: 'Commodore 64', max: 1, year: 1985 },
    { id: 2, name: 'Hades', platform: 'Windows', max: 1, steam: 1145360, year: 2020 },
    { id: 3, name: 'Doom', platform: 'MS-DOS', max: 4, year: 1993 },
    { id: 4, name: 'Doom', platform: 'Windows', max: 16, year: 2016 },
    { id: 5, name: 'Chrono Trigger', platform: 'Super Nintendo Entertainment System', max: 1 },
    {
      id: 6,
      name: 'Bomberman',
      platform: 'Nintendo Entertainment System',
      max: 2,
      alt: ['Dynablaster']
    }
  ]
  const lookup = createLookup(games)

  it('matches a Steam game by its Steam app', () => {
    expect(
      matchLaunchBox(makeGame('x', { title: 'Anything', externalId: '620' }), lookup)?.id
    ).toBe(914)
  })

  it("matches by name on the game's own platform, the closest year among several", () => {
    const epic = makeGame('e', {
      source: 'epic',
      externalId: 'h',
      platformId: 'epic',
      title: 'Hades'
    })
    expect(matchLaunchBox(epic, lookup)?.id).toBe(2)
    const doom2016 = makeGame(
      'd',
      { source: 'gog', externalId: 'd', platformId: 'gog', title: 'DOOM' },
      { releaseDate: '2016-05-13' }
    )
    expect(matchLaunchBox(doom2016, lookup)?.id).toBe(4)
    const doom1993 = makeGame(
      'd2',
      { source: 'gog', externalId: 'd2', platformId: 'gog', title: 'DOOM' },
      { releaseDate: '1993-12-10' }
    )
    expect(matchLaunchBox(doom1993, lookup)?.id).toBe(3)
  })

  it('matches the game of a "Game + Add-on" title, a ROM on its console, and an alternate name', () => {
    const kh3 = makeGame('k', {
      source: 'epic',
      externalId: 'k',
      platformId: 'epic',
      title: 'KINGDOM HEARTS III + Re Mind'
    })
    expect(matchLaunchBox(kh3, lookup)?.id).toBe(199529)
    const rom = makeGame('r', {
      source: 'rom',
      externalId: 'r',
      platformId: 'snes',
      title: 'Chrono Trigger'
    })
    expect(matchLaunchBox(rom, lookup)?.id).toBe(5)
    const alt = makeGame('a', {
      source: 'rom',
      externalId: 'a',
      platformId: 'nes',
      title: 'Dynablaster'
    })
    expect(matchLaunchBox(alt, lookup)?.id).toBe(6)
  })

  it('takes no name match more than two years from the game (Prey 2006 is not Prey 2017)', () => {
    const prey = createLookup([{ id: 9, name: 'Prey', platform: 'Windows', max: 8, year: 2017 }])
    const old = makeGame(
      'p',
      { source: 'gog', externalId: 'p', platformId: 'gog', title: 'Prey' },
      { releaseDate: '2006-07-11' }
    )
    expect(matchLaunchBox(old, prey)).toBeNull()
    const remake = makeGame(
      'p2',
      { source: 'gog', externalId: 'p2', platformId: 'gog', title: 'Prey' },
      { releaseDate: '2017-05-05' }
    )
    expect(matchLaunchBox(remake, prey)?.id).toBe(9)
    // A store copy years after LaunchBox's entry is a re-release of that game.
    const classic = createLookup([
      { id: 10, name: 'Fallout 2', platform: 'Windows', max: 1, year: 1998 }
    ])
    const gog = makeGame(
      'f',
      { source: 'gog', externalId: 'f', platformId: 'gog', title: 'Fallout 2' },
      { releaseDate: '2012-03-01' }
    )
    expect(matchLaunchBox(gog, classic)?.id).toBe(10)
  })

  it('never matches a game on another platform than its own', () => {
    const wiiu = makeGame('w', {
      source: 'rom',
      externalId: 'w',
      platformId: 'snes',
      title: 'Portal 2'
    })
    expect(matchLaunchBox(wiiu, lookup)).toBeNull()
  })

  it('names the LaunchBox platforms of PlayOut keys', () => {
    expect(launchBoxPlatforms('pc')).toEqual(['Windows', 'MS-DOS', 'Windows 3.X'])
    expect(launchBoxPlatforms('psx')).toEqual(['Sony Playstation'])
    expect(launchBoxPlatforms('megadrive')).toEqual(['Sega Genesis'])
  })

  it('records the count, or a miss', () => {
    expect(localPlayersRecord(games[0]!, 'T')).toEqual({
      max: 2,
      coop: true,
      launchboxId: 914,
      updatedAt: 'T'
    })
    expect(localPlayersRecord(null, 'T')).toEqual({ missedAt: 'T' })
  })
})

describe('createLocalPlayers', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'playout-lb-svc-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function library(games: Game[]): {
    games: () => Game[]
    getGame: (id: string) => Game | undefined
    applyMetadata: Mock<(id: string, update: { metadata?: Partial<GameMetadata> }) => void>
  } {
    const byId = new Map(games.map((g) => [g.id, g]))
    return {
      games: () => [...byId.values()],
      getGame: (id: string) => byId.get(id),
      applyMetadata: vi.fn((id: string, update: { metadata?: Partial<GameMetadata> }) => {
        const g = byId.get(id)!
        g.metadata = { ...g.metadata, ...update.metadata }
      })
    }
  }
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  it('downloads the database once, keeps a small index, matches every game and deletes the zip', async () => {
    const portal = makeGame('portal', { title: 'Portal 2', externalId: '620' })
    const unknown = makeGame('u', { title: 'Nothing Like It', externalId: '999' })
    const lib = library([portal, unknown])
    const download = vi.fn(
      async (_url: string, target: string, onBytes: (a: number, b: number) => void) => {
        const bytes = zipOf({ 'Metadata.xml': metadataXml([PORTAL_2, PORTAL_2_X360, KH3]) })
        onBytes(bytes.length, bytes.length)
        await writeFile(target, bytes)
      }
    )
    const progress: { stage: string; total: number }[] = []
    const svc = createLocalPlayers({
      library: lib,
      dataDir: dir,
      log,
      download,
      now: () => NOW,
      onProgress: (p) => progress.push(p)
    })
    svc.kick()
    await svc.idle()
    expect(download).toHaveBeenCalledTimes(1)
    expect(portal.metadata.localPlayers).toMatchObject({ max: 2, coop: true, launchboxId: 914 })
    expect(unknown.metadata.localPlayers).toBeUndefined()
    const index = JSON.parse(await readFile(join(dir, LAUNCHBOX_INDEX_FILE), 'utf8'))
    expect(index.games).toHaveLength(3)
    await expect(stat(join(dir, 'launchbox-metadata.zip.part'))).rejects.toThrow()
    // The bar shows while the index is read (download updates are throttled to two a second), then clears.
    expect(progress.some((p) => p.stage === 'reading' && p.total > 0)).toBe(true)
    expect(progress.at(-1)?.total).toBe(0)

    // A new start reads the index from disk: no download within the month, nothing rewritten.
    lib.applyMetadata.mockClear()
    const next = createLocalPlayers({
      library: lib,
      dataDir: dir,
      log,
      download,
      now: () => NOW + 1000
    })
    next.kick()
    await next.idle()
    expect(download).toHaveBeenCalledTimes(1)
    expect(lib.applyMetadata).not.toHaveBeenCalled()

    // A month later, a fresh download.
    const later = createLocalPlayers({
      library: lib,
      dataDir: dir,
      log,
      download,
      now: () => NOW + LAUNCHBOX_INDEX_TTL_MS
    })
    later.kick()
    await later.idle()
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('writes quietly and tells the library once for the whole pass', async () => {
    const games = Array.from({ length: 3 }, (_, i) =>
      makeGame(`g${i}`, { title: 'Portal 2', externalId: '620' })
    )
    const lib = library(games)
    await writeFile(
      join(dir, LAUNCHBOX_INDEX_FILE),
      JSON.stringify({
        version: 1,
        builtAt: new Date(NOW).toISOString(),
        games: [{ id: 914, name: 'Portal 2', platform: 'Windows', max: 2, steam: 620 }]
      })
    )
    const onChanged = vi.fn()
    const svc = createLocalPlayers({
      library: lib,
      dataDir: dir,
      log,
      now: () => NOW,
      download: vi.fn(),
      onChanged
    })
    svc.kick()
    await svc.idle()
    expect(lib.applyMetadata).toHaveBeenCalledTimes(3)
    for (const call of lib.applyMetadata.mock.calls)
      expect((call as unknown[])[2]).toMatchObject({ quiet: true })
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledWith(['g0', 'g1', 'g2'])
  })

  it('remembers a failed download across starts, so a restart does not download again', async () => {
    const lib = library([makeGame('portal', { title: 'Portal 2', externalId: '620' })])
    const download = vi.fn(async () => {
      throw new Error('offline')
    })
    const first = createLocalPlayers({ library: lib, dataDir: dir, log, download, now: () => NOW })
    first.kick()
    await first.idle()
    const restarted = createLocalPlayers({
      library: lib,
      dataDir: dir,
      log,
      download,
      now: () => NOW + 60_000
    })
    restarted.kick()
    await restarted.idle()
    expect(download).toHaveBeenCalledTimes(1)
    const later = createLocalPlayers({
      library: lib,
      dataDir: dir,
      log,
      download,
      now: () => NOW + 7 * 3600_000
    })
    later.kick()
    await later.idle()
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('keeps going without counts when the download fails, and does not retry at once', async () => {
    const portal = makeGame('portal', { title: 'Portal 2', externalId: '620' })
    const lib = library([portal])
    const download = vi.fn(async () => {
      throw new Error('offline')
    })
    const svc = createLocalPlayers({ library: lib, dataDir: dir, log, download, now: () => NOW })
    svc.kick()
    await svc.idle()
    svc.kick()
    await svc.idle()
    expect(download).toHaveBeenCalledTimes(1)
    expect(portal.metadata.localPlayers).toBeUndefined()
    await expect(stat(join(dir, 'launchbox-metadata.zip.part'))).rejects.toThrow()
  })

  it('clears a count a game no longer matches', async () => {
    const renamed = makeGame(
      'g',
      { source: 'gog', externalId: 'g', platformId: 'gog', title: 'Not Portal' },
      { localPlayers: { max: 2, launchboxId: 914, updatedAt: 'T' } }
    )
    const lib = library([renamed])
    await writeFile(
      join(dir, LAUNCHBOX_INDEX_FILE),
      JSON.stringify({
        version: 1,
        builtAt: new Date(NOW).toISOString(),
        games: [{ id: 914, name: 'Portal 2', platform: 'Windows', max: 2, steam: 620 }]
      })
    )
    const svc = createLocalPlayers({
      library: lib,
      dataDir: dir,
      log,
      now: () => NOW,
      download: vi.fn()
    })
    svc.kick()
    await svc.idle()
    expect(renamed.metadata.localPlayers).toEqual({ missedAt: new Date(NOW).toISOString() })
  })
})

function makeGameForGenres(
  title: string,
  over: Partial<Game> = {},
  metadata: Partial<GameMetadata> = {}
): Game {
  return {
    id: title,
    title,
    source: 'steam',
    externalId: '1',
    platformId: 'steam',
    metadataStatus: 'done',
    installed: false,
    metadata,
    user: {},
    ...over
  } as unknown as Game
}

describe('LaunchBox genres', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'playout-lb-genres-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const MYST = gameXml({
    Name: 'Myst',
    ReleaseYear: 1993,
    Genres: 'Adventure; Puzzle',
    DatabaseID: 50,
    Platform: 'Windows'
  })

  function libraryOf(games: Game[]): {
    games: () => Game[]
    getGame: (id: string) => Game | undefined
    applyMetadata: Mock<(id: string, update: { metadata?: Partial<GameMetadata> }) => void>
  } {
    const byId = new Map(games.map((g) => [g.id, g]))
    return {
      games: () => [...byId.values()],
      getGame: (id: string) => byId.get(id),
      applyMetadata: vi.fn((id: string, update: { metadata?: Partial<GameMetadata> }) => {
        const g = byId.get(id)!
        g.metadata = { ...g.metadata, ...update.metadata }
      })
    }
  }

  it('splits the Genres field of LaunchBox', () => {
    expect(parseGenres('Action; Adventure; Horror')).toEqual(['Action', 'Adventure', 'Horror'])
    expect(parseGenres(' Puzzle ;; puzzle; ')).toEqual(['Puzzle'])
    expect(parseGenres(undefined)).toEqual([])
    expect(parseGenres('')).toEqual([])
  })

  it('keeps games with genres but no player count, and matches each want on its own', () => {
    const reader = createMetadataXmlReader()
    reader.push(metadataXml([MYST, NO_COUNT]))
    expect([...reader.games.values()]).toEqual([
      { id: 50, name: 'Myst', platform: 'Windows', genres: ['Adventure', 'Puzzle'], year: 1993 }
    ])
    const lookup = createLookup([...reader.games.values()])
    const myst = makeGameForGenres('Myst', { source: 'gog', platformId: 'pc' })
    expect(matchLaunchBox(myst, lookup, WITH_GENRES)?.id).toBe(50)
    // No player count: not a player-count match.
    expect(matchLaunchBox(myst, lookup, WITH_PLAYERS)).toBeNull()
    expect(matchLaunchBox(myst, lookup)).toBeNull()
  })

  it('records LaunchBox genres for ROM games only, and a miss only over earlier genres', async () => {
    const xml = metadataXml([
      MYST,
      gameXml({
        Name: 'Chrono Trigger',
        ReleaseYear: 1995,
        Genres: 'Role-Playing',
        DatabaseID: 60,
        Platform: 'Super Nintendo Entertainment System'
      }),
      gameXml({
        Name: 'Portal 2',
        ReleaseYear: 2011,
        MaxPlayers: 2,
        Genres: 'Puzzle; Platform',
        DatabaseID: 914,
        SteamAppId: 620,
        Platform: 'Windows'
      })
    ])
    const myst = makeGameForGenres(
      'Myst',
      { source: 'gog', platformId: 'pc' },
      { genres: ['Puzzle'] }
    )
    const steamPortal = makeGameForGenres(
      'Portal 2',
      { source: 'steam', externalId: '620' },
      { genres: ['Action'] }
    )
    const chrono = makeGameForGenres(
      'Chrono Trigger',
      { source: 'rom', platformId: 'snes' },
      { genres: ['RPG'] }
    )
    const gone = makeGameForGenres(
      'Unknown Game',
      { source: 'rom', platformId: 'snes' },
      { genres: ['RPG'], launchboxGenres: { genres: ['Old'], launchboxId: 3 } }
    )
    const never = makeGameForGenres('Never Heard Of', { source: 'rom', platformId: 'snes' })
    const lib = libraryOf([myst, steamPortal, chrono, gone, never])
    const svc = createLocalPlayers({
      library: lib,
      dataDir: dir,
      log,
      download: async (_url, target) => {
        await writeFile(target, zipOf({ 'Metadata.xml': xml }))
      },
      now: () => NOW
    })
    svc.kick()
    await svc.idle()
    expect(chrono.metadata.launchboxGenres).toMatchObject({
      genres: ['Role-Playing'],
      launchboxId: 60
    })
    // The scraped genres stay, as the fallback.
    expect(chrono.metadata.genres).toEqual(['RPG'])
    // Store games (GOG here, though LaunchBox has it; Steam) keep their scraped genres.
    expect(myst.metadata.launchboxGenres).toBeUndefined()
    expect(steamPortal.metadata.launchboxGenres).toBeUndefined()
    expect(steamPortal.metadata.localPlayers).toMatchObject({ max: 2 })
    // Genres it no longer matches: a miss, so the scraped ones show again.
    expect(gone.metadata.launchboxGenres).toEqual({ missedAt: new Date(NOW).toISOString() })
    // Never matched: nothing written.
    expect(never.metadata.launchboxGenres).toBeUndefined()
    expect(lib.applyMetadata.mock.calls.map((c) => c[0]).sort()).toEqual(
      ['Chrono Trigger', 'Portal 2', 'Unknown Game'].sort()
    )
    // A second pass changes nothing.
    lib.applyMetadata.mockClear()
    svc.kick()
    await svc.idle()
    expect(lib.applyMetadata).not.toHaveBeenCalled()
  })

  it('keeps serving player counts from an older index (no genres) while LaunchBox cannot be reached', async () => {
    await writeFile(
      join(dir, LAUNCHBOX_INDEX_FILE),
      JSON.stringify({
        version: 1,
        builtAt: new Date(NOW).toISOString(),
        games: [{ id: 914, name: 'Portal 2', platform: 'Windows', max: 2, steam: 620 }]
      })
    )
    const portal = makeGameForGenres('Portal 2', { source: 'steam', externalId: '620' })
    const myst = makeGameForGenres(
      'Myst',
      { source: 'gog', platformId: 'pc' },
      { genres: ['Puzzle'] }
    )
    const lib = libraryOf([portal, myst])
    const download = vi.fn(async () => {
      throw new Error('offline')
    })
    const svc = createLocalPlayers({ library: lib, dataDir: dir, log, download, now: () => NOW })
    svc.kick()
    await svc.idle()
    // The new index was due at once; LaunchBox could not be reached.
    expect(download).toHaveBeenCalledTimes(1)
    expect(portal.metadata.localPlayers).toMatchObject({ max: 2 })
    // Nothing about genres: the scraped ones stay in use.
    expect(myst.metadata.launchboxGenres).toBeUndefined()
    expect(myst.metadata.genres).toEqual(['Puzzle'])
  })
})
