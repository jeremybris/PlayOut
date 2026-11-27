import { describe, expect, it, vi, type Mock } from 'vitest'
import type { Game, GameMetadata, RatingsProgress, Settings } from '../../shared/types'
import { defaultSettings } from '../../shared/defaults'
import { HttpError } from './http'
import {
  bestOfLinked,
  createReviewScores,
  igdbScoreRecord,
  linksByApp,
  parseSteamItems,
  pickIgdbMatch,
  RATING_REFRESH_MS,
  ratingDue,
  ratingLookupKey,
  steamAppFor,
  steamItemsUrl,
  steamLinksQuery,
  steamScoreRecord,
  type IgdbRatedGame,
  type ReviewScoresDeps,
  type SteamReviewSummary
} from './review-scores'

const NOW = Date.parse('2026-11-01T00:00:00Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const unix = (year: number): number => Date.UTC(year, 5, 1) / 1000

function makeGame(
  id: string,
  over: Partial<Game> = {},
  metadata: Partial<GameMetadata> = {}
): Game {
  return {
    id,
    title: id,
    source: 'steam',
    externalId: '100',
    platformId: 'steam',
    metadataStatus: 'done',
    installed: false,
    metadata,
    user: {},
    ...over
  } as unknown as Game
}

function setup(games: Game[]): {
  deps: Omit<ReviewScoresDeps, 'library'> & {
    library: ReviewScoresDeps['library'] & { applyMetadata: ReturnType<typeof vi.fn> }
  }
  value: Settings
} {
  const byId = new Map(games.map((g) => [g.id, g]))
  const value = defaultSettings()
  value.scrapers.igdb = { clientId: 'fake-client-id', clientSecret: 'fake-client-secret' }
  return {
    deps: {
      library: {
        games: () => [...byId.values()],
        getGame: (id: string) => byId.get(id),
        applyMetadata: vi.fn((id: string, update: { metadata?: Partial<GameMetadata> }) => {
          const g = byId.get(id)!
          g.metadata = { ...g.metadata, ...update.metadata }
        })
      },
      settings: { get: () => value },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      isConfigured: (s) => !!s.scrapers.igdb.clientId && !!s.scrapers.igdb.clientSecret,
      now: () => NOW,
      sleep: vi.fn(async () => {})
    },
    value
  }
}

const steamSummary = (
  percent: number,
  count: number,
  label = 'Very Positive'
): SteamReviewSummary => ({
  percent,
  count,
  score: count >= 10 ? 8 : 0,
  label
})

/** A fake Steam GetItems: summaries by app id. */
function fakeSteam(
  summaries: Record<number, SteamReviewSummary>
): Mock<(appIds: readonly number[]) => Promise<Map<number, SteamReviewSummary>>> {
  return vi.fn(async (appIds: readonly number[]) => {
    const out = new Map<number, SteamReviewSummary>()
    for (const id of appIds) if (summaries[id]) out.set(id, summaries[id])
    return out
  })
}

/** A fake IGDB: Steam links, games by id, and title searches. */
function fakeIgdb(opts: {
  links?: { uid: string; game: number }[]
  games?: IgdbRatedGame[]
  search?: Record<string, IgdbRatedGame[]>
}): Mock<(s: Settings, endpoint: string, body: string) => Promise<unknown>> {
  return vi.fn(async (_s: Settings, endpoint: string, body: string): Promise<unknown> => {
    if (endpoint === 'external_games') {
      const uids = [...body.matchAll(/"(\d+)"/g)].map((m) => m[1])
      return (opts.links ?? []).filter((l) => uids.includes(l.uid))
    }
    const search = body.match(/search "([^"]*)"/)
    if (search) return opts.search?.[search[1]!] ?? []
    const ids = (body.match(/where id = \(([^)]*)\)/)?.[1] ?? '').split(',').map(Number)
    return (opts.games ?? []).filter((g) => ids.includes(g.id))
  })
}

function service(
  deps: ReturnType<typeof setup>['deps'],
  steam: ReturnType<typeof fakeSteam>,
  query: ReturnType<typeof fakeIgdb> = fakeIgdb({}),
  extra: Partial<ReviewScoresDeps> = {}
): ReturnType<typeof createReviewScores> {
  return createReviewScores({
    ...deps,
    steamReviews: steam,
    query: query as ReviewScoresDeps['query'],
    ...extra
  })
}

describe('Steam review summaries', () => {
  it('asks GetItems for the review summaries of up to 100 apps', () => {
    const url = new URL(steamItemsUrl([620, 1245620]))
    expect(url.origin + url.pathname).toBe(
      'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/'
    )
    expect(JSON.parse(url.searchParams.get('input_json')!)).toEqual({
      ids: [{ appid: 620 }, { appid: 1245620 }],
      context: { language: 'english', country_code: 'US' },
      data_request: { include_reviews: true }
    })
  })

  it("reads the store page's All Reviews line, skipping apps without reviews or not on the store", () => {
    // Shape of a real answer (Portal 2, 2026-11-05), trimmed.
    const map = parseSteamItems({
      response: {
        store_items: [
          {
            id: 620,
            appid: 620,
            success: 1,
            reviews: {
              summary_filtered: {
                review_count: 392746,
                percent_positive: 98,
                review_score: 9,
                review_score_label: 'Overwhelmingly Positive'
              }
            }
          },
          { appid: 5, success: 1, reviews: { summary_filtered: { review_count: 0 } } },
          { appid: 6, success: 2 },
          { appid: 7, success: 1 }
        ]
      }
    })
    expect(map.get(620)).toEqual({
      percent: 98,
      count: 392746,
      score: 9,
      label: 'Overwhelmingly Positive'
    })
    expect(map.size).toBe(1)
  })

  it('takes the English summary the store page shows first, else all languages', () => {
    // Monster Hunter Wilds, 2026-11-05: all languages 53% Mixed, English 71% Mostly Positive (the store page's).
    const map = parseSteamItems({
      response: {
        store_items: [
          {
            appid: 2246340,
            success: 1,
            reviews: {
              summary_filtered: {
                review_count: 203985,
                percent_positive: 53,
                review_score: 5,
                review_score_label: 'Mixed'
              },
              summary_language_specific: {
                review_count: 86472,
                percent_positive: 71,
                review_score: 6,
                review_score_label: 'Mostly Positive'
              }
            }
          },
          {
            appid: 9,
            success: 1,
            reviews: {
              summary_filtered: {
                review_count: 40,
                percent_positive: 80,
                review_score: 6,
                review_score_label: 'Mostly Positive'
              },
              summary_language_specific: { review_count: 0 }
            }
          }
        ]
      }
    })
    expect(map.get(2246340)).toEqual({
      percent: 71,
      count: 86472,
      score: 6,
      label: 'Mostly Positive'
    })
    expect(map.get(9)?.percent).toBe(80)
  })

  it('records a Steam score with its count, label and app', () => {
    expect(steamScoreRecord(620, steamSummary(97.6, 1000), 'T', 'k')).toEqual({
      source: 'steam',
      score: 98,
      count: 1000,
      label: 'Very Positive',
      steamAppId: 620,
      via: 'k',
      updatedAt: 'T'
    })
  })
})

describe('igdbScoreRecord', () => {
  it('keeps the IGDB rating rounded with its count, and records the rest as misses', () => {
    expect(igdbScoreRecord({ id: 7, rating: 84.4, rating_count: 120 }, 'T', 'k')).toEqual({
      source: 'igdb',
      score: 84,
      count: 120,
      igdbId: 7,
      via: 'k',
      updatedAt: 'T'
    })
    expect(igdbScoreRecord({ id: 7 }, 'T', 'k', 9)).toEqual({
      igdbId: 7,
      steamAppId: 9,
      via: 'k',
      missedAt: 'T'
    })
    expect(igdbScoreRecord(null, 'T', 'k')).toEqual({ via: 'k', missedAt: 'T' })
  })
})

describe('steamAppFor and ratingDue', () => {
  it("uses another store's game's Steam app found by the Steam tags or the size lookup", () => {
    const gog = makeGame('g', { source: 'gog', externalId: 'x', platformId: 'gog' })
    expect(steamAppFor(gog)).toBeUndefined()
    gog.metadata = { steamTags: { tags: [], appId: 22380 } }
    expect(steamAppFor(gog)).toBe(22380)
    const epic = makeGame('e', { source: 'epic', externalId: 'y', platformId: 'epic' })
    epic.metadata = { storage: { how: 'steam-match', steamAppId: 400, checkedAt: 'T' } }
    expect(steamAppFor(epic)).toBe(400)
  })

  it('reads new games, refreshes after a month, and reads a game again once IGDB is set up', () => {
    const game = makeGame('a', { externalId: '620' })
    expect(ratingDue(game, NOW, true)).toBe(true)
    game.metadata = {
      reviewScore: {
        source: 'steam',
        score: 98,
        via: ratingLookupKey(game, true),
        updatedAt: iso(NOW)
      }
    }
    expect(ratingDue(game, NOW + 1000, true)).toBe(false)
    expect(ratingDue(game, NOW + RATING_REFRESH_MS, true)).toBe(true)
    const miss = makeGame('m', { source: 'gog', externalId: 'm', platformId: 'gog' })
    miss.metadata = { reviewScore: { via: ratingLookupKey(miss, false), missedAt: iso(NOW) } }
    expect(ratingDue(miss, NOW, false)).toBe(false)
    expect(ratingDue(miss, NOW, true)).toBe(true)
  })

  it('reads again at once when the match changes or a searched game is retitled', () => {
    const gog = makeGame('g', { source: 'gog', externalId: 'x', platformId: 'gog', title: 'Old' })
    gog.metadata = { sources: { igdb: '1' } }
    gog.metadata.reviewScore = {
      source: 'igdb',
      score: 80,
      via: ratingLookupKey(gog, true),
      updatedAt: iso(NOW)
    }
    expect(ratingDue(gog, NOW, true)).toBe(false)
    gog.metadata = { ...gog.metadata, sources: { igdb: '2' } }
    expect(ratingDue(gog, NOW, true)).toBe(true)
    gog.metadata = { ...gog.metadata, steamTags: { tags: [], appId: 5 } }
    gog.metadata.reviewScore = { via: ratingLookupKey(gog, true), missedAt: iso(NOW) }
    expect(ratingDue(gog, NOW, true)).toBe(false)
    gog.user = { titleOverride: 'New' }
    expect(ratingDue(gog, NOW, true)).toBe(false)
    expect(ratingDue(makeGame('p', { metadataStatus: 'pending' }), NOW, true)).toBe(true)
  })
})

describe('IGDB matching', () => {
  const game = (id: number, name: string, year: number, game_type = 0): IgdbRatedGame => ({
    id,
    name,
    first_release_date: unix(year),
    game_type
  })

  it('takes the game of that name and year, not a remake or a sequel', () => {
    const results = [
      game(2, 'Dead Space', 2023, 8),
      game(1, 'Dead Space', 2008),
      game(3, 'Dead Space 2', 2011)
    ]
    expect(pickIgdbMatch('Dead Space', 2008, results)?.id).toBe(1)
    expect(pickIgdbMatch('Dead Space', 2023, results)?.id).toBe(2)
    expect(pickIgdbMatch('Celeste', 2018, [game(9, 'Hollow Knight', 2017)])).toBeNull()
  })

  it('asks external_games one row per Steam link, and picks the main game with a rating', () => {
    expect(steamLinksQuery([620, 440])).toBe(
      'fields uid,game; where uid = ("620","440") & external_game_source = 1; limit 500;'
    )
    expect(
      linksByApp([
        { uid: '620', game: 72 },
        { uid: '620', game: 99 },
        { uid: 'x', game: 1 }
      ]).get(620)
    ).toEqual([72, 99])
    const bundle: IgdbRatedGame = { id: 1, game_type: 3, rating: 90, rating_count: 900 }
    const edition: IgdbRatedGame = { id: 2, game_type: 0 }
    const main: IgdbRatedGame = { id: 3, game_type: 0, rating: 88, rating_count: 500 }
    expect(bestOfLinked([bundle, edition, main])?.id).toBe(3)
    expect(bestOfLinked([])).toBeNull()
  })
})

describe('createReviewScores', () => {
  it('scores games from Steam first, and from IGDB the ones Steam has no score for', async () => {
    const portal = makeGame('portal', { externalId: '620' })
    const tiny = makeGame('tiny', { externalId: '700' })
    const epicOnSteam = makeGame(
      'epic-hades',
      { source: 'epic', externalId: 'e1', platformId: 'epic', title: 'Hades' },
      { steamTags: { tags: [], appId: 1145360 } }
    )
    const gogOnly = makeGame(
      'gog-only',
      { source: 'gog', externalId: 'g1', platformId: 'gog', title: 'Exclusive' },
      { releaseDate: '2020-01-01' }
    )
    const { deps } = setup([portal, tiny, epicOnSteam, gogOnly])
    const steam = fakeSteam({
      620: steamSummary(98, 392746, 'Overwhelmingly Positive'),
      700: steamSummary(100, 3, '3 user reviews'),
      1145360: steamSummary(98, 280000, 'Overwhelmingly Positive')
    })
    const query = fakeIgdb({
      links: [{ uid: '700', game: 70 }],
      games: [{ id: 70, rating: 72, rating_count: 40, game_type: 0 }],
      search: {
        Exclusive: [
          {
            id: 5,
            name: 'Exclusive',
            rating: 81.2,
            rating_count: 15,
            first_release_date: unix(2020),
            game_type: 0
          }
        ]
      }
    })
    const s = service(deps, steam, query)
    s.kick()
    await s.idle()
    expect(steam).toHaveBeenCalledTimes(1)
    expect(portal.metadata.reviewScore).toMatchObject({ source: 'steam', score: 98, count: 392746 })
    expect(epicOnSteam.metadata.reviewScore).toMatchObject({
      source: 'steam',
      score: 98,
      steamAppId: 1145360
    })
    // Three Steam reviews make no Steam score: IGDB's rating instead.
    expect(tiny.metadata.reviewScore).toMatchObject({
      source: 'igdb',
      score: 72,
      igdbId: 70,
      steamAppId: 700
    })
    expect(gogOnly.metadata.reviewScore).toMatchObject({ source: 'igdb', score: 81, igdbId: 5 })
    const calls = steam.mock.calls.length + query.mock.calls.length
    s.kick()
    await s.idle()
    expect(steam.mock.calls.length + query.mock.calls.length).toBe(calls)
  })

  it('asks Steam 100 apps at a time', async () => {
    const games = Array.from({ length: 250 }, (_, i) =>
      makeGame(`s${i}`, { externalId: String(1000 + i) })
    )
    const { deps } = setup(games)
    const steam = fakeSteam(
      Object.fromEntries(games.map((_, i) => [1000 + i, steamSummary(90, 50)]))
    )
    const s = service(deps, steam)
    s.kick()
    await s.idle()
    expect(steam.mock.calls.map(([ids]) => ids.length)).toEqual([100, 100, 50])
    expect(games.every((g) => g.metadata.reviewScore?.score === 90)).toBe(true)
  })

  it('still scores from Steam without IGDB, and reads the rest once IGDB is set up', async () => {
    const portal = makeGame('portal', { externalId: '620' })
    const gog = makeGame('gog', {
      source: 'gog',
      externalId: 'g',
      platformId: 'gog',
      title: 'Exclusive'
    })
    const { deps, value } = setup([portal, gog])
    value.scrapers.igdb = { clientId: 'fake-client-id', clientSecret: '' }
    const steam = fakeSteam({ 620: steamSummary(98, 1000) })
    const query = fakeIgdb({
      search: { Exclusive: [{ id: 5, name: 'Exclusive', rating: 80, rating_count: 9 }] }
    })
    const s = service(deps, steam, query)
    s.kick()
    await s.idle()
    expect(portal.metadata.reviewScore?.score).toBe(98)
    expect(gog.metadata.reviewScore).toMatchObject({ missedAt: iso(NOW) })
    expect(query).not.toHaveBeenCalled()
    const off = (deps.log.info as Mock).mock.calls.filter(([m]) => /are off/.test(String(m)))
    expect(off).toHaveLength(1)
    value.scrapers.igdb = { clientId: 'fake-client-id', clientSecret: 'fake-client-secret' }
    s.kick()
    await s.idle()
    expect(gog.metadata.reviewScore).toMatchObject({ source: 'igdb', score: 80 })
    // A Steam score does not depend on IGDB: Portal is not read again.
    expect(steam).toHaveBeenCalledTimes(1)
  })

  it('reads installed games first in the IGDB searches, and reports its progress', async () => {
    const a = makeGame('a', { source: 'gog', externalId: 'a', platformId: 'gog', title: 'Alpha' })
    const b = makeGame('b', {
      source: 'gog',
      externalId: 'b',
      platformId: 'gog',
      title: 'Beta',
      installed: true
    })
    const { deps } = setup([a, b])
    const query = fakeIgdb({
      search: {
        Alpha: [{ id: 1, name: 'Alpha', rating: 70, rating_count: 5 }],
        Beta: [{ id: 2, name: 'Beta', rating: 75, rating_count: 5 }]
      }
    })
    const reports: RatingsProgress[] = []
    const s = service(deps, fakeSteam({}), query, { onProgress: (p) => reports.push(p) })
    s.kick()
    await s.idle()
    const searches = query.mock.calls.map(([, , body]) => body.match(/search "([^"]*)"/)?.[1])
    expect(searches).toEqual(['Beta', 'Alpha'])
    expect(reports[0]).toEqual({ done: 0, total: 2, stage: 'steam' })
    expect(reports).toContainEqual({ done: 0, total: 2, stage: 'igdb' })
    expect(reports.at(-1)).toEqual({ done: 0, total: 0, stage: 'steam' })
    const lines = (deps.log.info as Mock).mock.calls.map(([m]) => String(m))
    expect(lines.at(-1)).toBe(
      'review scores: 2 of 2 game(s) have one now (0 from Steam, 2 from IGDB)'
    )
  })

  it('drops an answer when the game is matched to IGDB while its title search is in flight', async () => {
    const epic = makeGame('prey', {
      source: 'epic',
      externalId: 'e1',
      platformId: 'epic',
      title: 'Prey'
    })
    const { deps } = setup([epic])
    const inner = fakeIgdb({
      games: [{ id: 2017, rating: 84, rating_count: 300, game_type: 0 }],
      search: { Prey: [{ id: 2006, name: 'Prey', rating: 70, rating_count: 50, game_type: 0 }] }
    })
    const query = vi.fn(async (s: Settings, endpoint: string, body: string) => {
      const out = await inner(s, endpoint, body)
      if (/search "/.test(body)) epic.metadata = { ...epic.metadata, sources: { igdb: '2017' } }
      return out
    })
    const s = service(deps, fakeSteam({}), query as ReturnType<typeof fakeIgdb>)
    s.kick()
    await s.idle()
    expect(epic.metadata.reviewScore).toBeUndefined()
    s.kick()
    await s.idle()
    expect(epic.metadata.reviewScore).toMatchObject({ score: 84, igdbId: 2017 })
  })

  it('stops IGDB for refused credentials, keeping the Steam scores', async () => {
    const portal = makeGame('portal', { externalId: '620' })
    const gog = makeGame('gog', { source: 'gog', externalId: 'g', platformId: 'gog', title: 'X' })
    const { deps } = setup([portal, gog])
    const query = vi.fn(async () => {
      throw new HttpError('IGDB: invalid client id or secret', {
        status: 400,
        url: 'https://id.twitch.tv/oauth2/token'
      })
    })
    const s = service(
      deps,
      fakeSteam({ 620: steamSummary(90, 100) }),
      query as ReturnType<typeof fakeIgdb>
    )
    s.kick()
    await s.idle()
    expect(portal.metadata.reviewScore?.score).toBe(90)
    expect(gog.metadata.reviewScore).toBeUndefined()
    s.kick()
    await s.idle()
    expect(query).toHaveBeenCalledTimes(1)
    // Refused: the game is recorded as having no score until the credentials change.
    expect(gog.metadata.reviewScore).toMatchObject({ missedAt: iso(NOW) })
  })

  it('goes on with IGDB when Steam refuses the request, leaving the Steam games for next time', async () => {
    const portal = makeGame('portal', { externalId: '620' })
    const gog = makeGame('gog', {
      source: 'gog',
      externalId: 'g',
      platformId: 'gog',
      title: 'Exclusive'
    })
    const { deps } = setup([portal, gog])
    const steam = vi.fn(async (): Promise<Map<number, SteamReviewSummary>> => {
      throw new HttpError('HTTP 400', { status: 400, url: 'https://api.steampowered.com/' })
    })
    const query = fakeIgdb({
      search: { Exclusive: [{ id: 5, name: 'Exclusive', rating: 80, rating_count: 9 }] }
    })
    const s = service(deps, steam as ReturnType<typeof fakeSteam>, query)
    s.kick()
    await s.idle()
    expect(steam).toHaveBeenCalledTimes(1)
    expect(deps.sleep).not.toHaveBeenCalled()
    expect(gog.metadata.reviewScore).toMatchObject({ source: 'igdb', score: 80 })
    expect(portal.metadata.reviewScore).toBeUndefined()
    expect(ratingDue(portal, NOW, true)).toBe(true)
  })

  it('counts its progress forward only, from Steam into IGDB', async () => {
    const games = [
      makeGame('a', { externalId: '1' }),
      makeGame('b', { externalId: '2' }),
      makeGame('c', { externalId: '3' }),
      makeGame('d', { source: 'gog', externalId: 'd', platformId: 'gog', title: 'Delta' })
    ]
    const { deps } = setup(games)
    const reports: RatingsProgress[] = []
    const s = service(
      deps,
      fakeSteam({ 1: steamSummary(90, 100), 2: steamSummary(100, 2) }),
      fakeIgdb({ search: { Delta: [{ id: 4, name: 'Delta', rating: 70, rating_count: 3 }] } }),
      { onProgress: (p) => reports.push(p) }
    )
    s.kick()
    await s.idle()
    const dones = reports.filter((r) => r.total > 0).map((r) => r.done)
    expect(dones).toEqual([...dones].sort((x, y) => x - y))
  })

  it('pauses while Steam does not answer and gives up after two pauses, writing nothing', async () => {
    const { deps } = setup([makeGame('a', { externalId: '620' })])
    const steam = vi.fn(async (): Promise<Map<number, SteamReviewSummary>> => {
      throw new HttpError('HTTP 503', { status: 503, url: 'https://api.steampowered.com/' })
    })
    const reports: RatingsProgress[] = []
    const s = service(deps, steam as ReturnType<typeof fakeSteam>, fakeIgdb({}), {
      onProgress: (p) => reports.push(p)
    })
    s.kick()
    await s.idle()
    expect(steam).toHaveBeenCalledTimes(9)
    expect(deps.sleep).toHaveBeenCalledTimes(2)
    expect(deps.library.applyMetadata).not.toHaveBeenCalled()
    expect(reports.some((r) => r.paused)).toBe(true)
    expect(reports.at(-1)?.total).toBe(0)
  })

  it('records a title IGDB cannot search for as not found and carries on', async () => {
    const odd = makeGame('odd', { source: 'gog', externalId: 'g', platformId: 'gog', title: 'Odd' })
    const fine = makeGame('fine', {
      source: 'gog',
      externalId: 'h',
      platformId: 'gog',
      title: 'Hades'
    })
    const { deps } = setup([odd, fine])
    const query = vi.fn(async (_s: Settings, _e: string, body: string): Promise<unknown> => {
      if (body.includes('search "Odd"'))
        throw new HttpError('IGDB: unexpected response (HTTP 400)', {
          status: 400,
          url: 'https://api.igdb.com/v4/games'
        })
      return [{ id: 1, name: 'Hades', rating: 90, rating_count: 5, game_type: 0 }]
    })
    const s = service(deps, fakeSteam({}), query as ReturnType<typeof fakeIgdb>)
    s.kick()
    await s.idle()
    expect(odd.metadata.reviewScore).toEqual({ via: 'title:Odd', missedAt: iso(NOW) })
    expect(fine.metadata.reviewScore).toMatchObject({ source: 'igdb', score: 90, igdbId: 1 })
  })
})
