import { describe, expect, it } from 'vitest'
import {
  GAME_DB_COLUMNS,
  GAME_DB_RAW_BASE,
  GAME_DB_REPO,
  GAME_DB_REPO_URL,
  encodeGameDbCsv,
  fnv1a,
  gameDbMetadataOf,
  gameDbRowOf,
  gameDbRowProblem,
  gameDbShardPath,
  parseGameDbCsv,
  type GameDbRow
} from './game-database'
import type { Game } from './types'

const row = (patch: Partial<GameDbRow> = {}): GameDbRow => ({
  key: 'steam-427520',
  title: 'Factorio',
  platform: 'pc',
  releaseDate: '2020-08-14',
  genres: ['Simulation', 'Strategy'],
  tags: ['Automation', 'Base Building'],
  developers: ['Wube Software LTD.'],
  publishers: ['Wube Software LTD.'],
  localPlayers: null,
  steamAppId: 427520,
  ...patch
})

describe('where the game database lives', () => {
  it('is the database branch of the metadata repository, never its main', () => {
    expect(GAME_DB_REPO).toEqual({
      owner: 'jeremybris',
      repo: 'PlayOut-metadata',
      branch: 'database'
    })
    expect(GAME_DB_RAW_BASE).toBe(
      'https://raw.githubusercontent.com/jeremybris/PlayOut-metadata/database/'
    )
    expect(GAME_DB_REPO_URL).toBe('https://github.com/jeremybris/PlayOut-metadata/tree/database')
  })
})

describe('game database CSV', () => {
  it('writes the header and rows sorted by key, and reads them back unchanged', () => {
    const rows = [
      row({ key: 'steam-620', title: 'Portal 2', localPlayers: 2, steamAppId: 620 }),
      row(),
      // Commas, quotes and accents survive.
      row({
        key: 'gog-1207658924',
        title: 'Heroes of Might & Magic 3: "Complete", HD',
        steamAppId: null
      })
    ]
    const csv = encodeGameDbCsv(rows)
    const lines = csv.split('\n')
    expect(lines[0]).toBe(GAME_DB_COLUMNS.join(','))
    expect(
      lines[1]!.startsWith('gog-1207658924,"Heroes of Might & Magic 3: ""Complete"", HD",pc')
    ).toBe(true)
    expect(lines[2]).toBe(
      'steam-427520,Factorio,pc,2020-08-14,Simulation|Strategy,Automation|Base Building,Wube Software LTD.,Wube Software LTD.,,427520'
    )
    const back = parseGameDbCsv(csv)
    expect([...back.keys()]).toEqual(['gog-1207658924', 'steam-427520', 'steam-620'])
    for (const r of rows) expect(back.get(r.key)).toEqual(r)
  })

  it('reads columns by the header and skips rows it cannot use', () => {
    const text =
      '\uFEFFtitle,key,platform,release_date,genres\r\n' +
      'SSX 3,ps2-slus20772,ps2,2003-10-20,Sports\r\n' +
      // Invalid: no facts, a formula, a bad date, a bad key.
      'Empty,ps2-empty,ps2,,\r\n' +
      '=HYPERLINK("x"),ps2-bad,ps2,2003,Sports\r\n' +
      'Bad date,ps2-date,ps2,2003-13,Sports\r\n' +
      'Bad key,PS2 SLUS,ps2,2003,Sports\r\n'
    const rows = parseGameDbCsv(text)
    expect([...rows.keys()]).toEqual(['ps2-slus20772'])
    expect(rows.get('ps2-slus20772')).toMatchObject({
      title: 'SSX 3',
      genres: ['Sports'],
      tags: [],
      localPlayers: null,
      steamAppId: null
    })
  })

  it('refuses text that would run as a spreadsheet formula, control characters and the list separator', () => {
    expect(gameDbRowProblem(row())).toBeNull()
    expect(gameDbRowProblem(row({ title: '=cmd("/c calc")' }))).toMatch(/formula/)
    expect(gameDbRowProblem(row({ title: '+1' }))).toMatch(/formula/)
    expect(gameDbRowProblem(row({ title: '@SUM(A1)' }))).toMatch(/formula/)
    expect(gameDbRowProblem(row({ title: '-1+1' }))).toMatch(/formula/)
    expect(gameDbRowProblem(row({ title: '-ERROR-' }))).toBeNull()
    expect(gameDbRowProblem(row({ developers: ['A\nB'] }))).toMatch(/control/)
    expect(gameDbRowProblem(row({ genres: ['Action|RPG'] }))).toMatch(/contains/)
    expect(gameDbRowProblem(row({ genres: ['Action', 'action'] }))).toMatch(/twice/)
    expect(gameDbRowProblem(row({ localPlayers: 0 }))).toMatch(/local players/)
    expect(gameDbRowProblem(row({ localPlayers: 65 }))).toMatch(/local players/)
    expect(
      gameDbRowProblem(
        row({ releaseDate: '', genres: [], tags: [], developers: [], publishers: [] })
      )
    ).toMatch(/no facts/)
  })

  it('puts a key in a fixed shard under its prefix', () => {
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c)
    expect(gameDbShardPath('steam-427520')).toMatch(/^data\/steam\/(0\d|1[0-5])\.csv$/)
    expect(gameDbShardPath('steam-427520')).toBe(gameDbShardPath('steam-427520'))
    expect(gameDbShardPath('ps2-slus20772')).toMatch(/^data\/ps2\//)
    expect(gameDbShardPath('rom-xbox-halo')).toMatch(/^data\/rom\//)
  })
})

describe('games and rows', () => {
  const game = (patch: Partial<Game> = {}): Game => ({
    id: 'steam:427520',
    source: 'steam',
    externalId: '427520',
    platformId: 'steam',
    title: 'Factorio',
    sortTitle: 'factorio',
    installed: true,
    launch: { kind: 'uri', uri: '' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {
      releaseDate: '2020-08-14',
      genres: ['Simulation', 'Strategy', 'simulation'],
      developers: ['Wube Software LTD.'],
      publishers: ['Wube Software LTD.'],
      steamTags: { tags: ['Automation', 'Base Building'], appId: 427520 },
      // Not facts of the database: never in a row.
      reviewScore: { source: 'steam', score: 98 },
      hltb: { main: 53.3 }
    },
    media: {},
    metadataStatus: 'done',
    user: {},
    ...patch
  })

  it("makes a game's row from its stored facts only", () => {
    expect(gameDbRowOf(game())).toEqual(row())
    // A ROM: its system is the platform, its LaunchBox genres the genres.
    const rom = gameDbRowOf(
      game({
        id: 'rom:ps2:x',
        source: 'rom',
        externalId: 'PS2/SSX 3 (USA).iso',
        romPath: 'C:/Roms/ps2/SSX 3 (USA).iso',
        platformId: 'ps2',
        title: 'SSX 3',
        metadata: {
          genres: ['Racing'],
          launchboxGenres: { genres: ['Sports'] },
          localPlayers: { max: 2 }
        }
      })
    )
    expect(rom).toMatchObject({
      key: 'ps2-ssx-3',
      platform: 'ps2',
      genres: ['Sports'],
      localPlayers: 2
    })
    // Nothing worth a row.
    expect(gameDbRowOf(game({ metadata: {} }))).toBeNull()
  })

  it('gives a row back as metadata, a ROM its genres as its LaunchBox genres', () => {
    const now = '2026-11-24T00:00:00.000Z'
    expect(gameDbMetadataOf(row({ localPlayers: 4 }), false, now)).toEqual({
      sources: { database: 'steam-427520' },
      releaseDate: '2020-08-14',
      developers: ['Wube Software LTD.'],
      publishers: ['Wube Software LTD.'],
      genres: ['Simulation', 'Strategy'],
      steamTags: { tags: ['Automation', 'Base Building'], appId: 427520, updatedAt: now },
      localPlayers: { max: 4, updatedAt: now }
    })
    expect(
      gameDbMetadataOf(row({ key: 'ps2-ssx-3', platform: 'ps2', tags: [] }), true, now)
    ).toMatchObject({
      genres: ['Simulation', 'Strategy'],
      launchboxGenres: { genres: ['Simulation', 'Strategy'] }
    })
  })
})
