import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Game, GameMetadata, Settings } from '../../shared/types'
import { defaultSettings } from '../../shared/defaults'
import {
  controlsOf,
  vacOf,
  createSteamTags,
  fetchSteamTagIds,
  knownSteamAppId,
  STEAM_TAGS_BATCH,
  STEAM_TAGS_MISS_RETRY_MS,
  STEAM_TAGS_REFRESH_MS,
  sameRelease,
  steamTagsDue,
  type SteamTagItem,
  tagNamesOf,
  type SteamTagsDeps
} from './steam-tags'

const NOW = Date.parse('2026-11-01T00:00:00Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const NAMES = new Map([
  [1, 'Roguelike'],
  [2, 'Action'],
  [3, 'Great Soundtrack'],
  [4, 'Souls-like']
])

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
    metadataStatus: 'done',
    metadata,
    user: {},
    ...over
  } as unknown as Game
}

function setup(games: Game[]): {
  deps: Omit<SteamTagsDeps, 'library'> & {
    library: SteamTagsDeps['library'] & { applyMetadata: ReturnType<typeof vi.fn> }
  }
  value: Settings
} {
  const byId = new Map(games.map((g) => [g.id, g]))
  const value = defaultSettings()
  const library = {
    games: () => [...byId.values()],
    getGame: (id: string) => byId.get(id),
    applyMetadata: vi.fn((id: string, update: { metadata?: Partial<GameMetadata> }) => {
      const g = byId.get(id)!
      g.metadata = { ...g.metadata, ...update.metadata }
    })
  }
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    deps: {
      library,
      settings: { get: () => value },
      log,
      now: () => NOW,
      sleep: vi.fn(async () => {}),
      searchWait: async () => {},
      fetchTagNames: vi.fn(async () => NAMES)
    },
    value
  }
}

describe('knownSteamAppId', () => {
  it("uses the game's own Steam app, then a scraped one, then a size lookup's match", () => {
    expect(knownSteamAppId(makeGame('a'))).toEqual({ appId: 100, matched: false })
    const gog = { source: 'gog', externalId: 'x' } as Partial<Game>
    expect(knownSteamAppId(makeGame('b', gog, { sources: { steam: '200' } }))).toEqual({
      appId: 200,
      matched: false
    })
    expect(
      knownSteamAppId(makeGame('c', gog, { storage: { steamAppId: 300, checkedAt: iso(NOW) } }))
    ).toEqual({ appId: 300, matched: true })
    expect(knownSteamAppId(makeGame('d', gog))).toBeNull()
  })
})

describe('controlsOf', () => {
  it("reads Steam's controller categories and VR support", () => {
    expect(
      controlsOf({ categories: { controller_categoryids: [28] }, platforms: { vr_support: {} } })
    ).toEqual({
      controller: 'full',
      vr: null
    })
    expect(controlsOf({ categories: { controller_categoryids: [18] } })).toEqual({
      controller: 'partial',
      vr: null
    })
    expect(
      controlsOf({
        platforms: { vr_support: { vrhmd: true, vrhmd_only: true, valve_index: true } }
      })
    ).toEqual({ controller: null, vr: 'only' })
    expect(
      controlsOf({
        categories: { controller_categoryids: [28] },
        platforms: { vr_support: { vrhmd: true } }
      })
    ).toEqual({ controller: 'full', vr: 'supported' })
    expect(controlsOf({})).toEqual({ controller: null, vr: null })
  })
})

describe('vacOf', () => {
  it("reads Steam's Valve Anti-Cheat feature category", () => {
    expect(vacOf({ categories: { feature_categoryids: [22, 29, 8, 15] } })).toBe(true)
    expect(vacOf({ categories: { feature_categoryids: [22, 29, 30] } })).toBe(false)
    expect(vacOf({ categories: { controller_categoryids: [28] } })).toBe(false)
    expect(vacOf({})).toBe(false)
  })
})

describe('steamTagsDue', () => {
  it('reads new games, refreshes after 90 days, retries misses after 30, never ROMs', () => {
    expect(steamTagsDue(makeGame('a'), NOW)).toBe(true)
    const controls = { controller: null, vr: null }
    const fresh = {
      steamTags: {
        tags: ['Roguelike'],
        appId: 100,
        updatedAt: iso(NOW - 1000),
        controls,
        vac: false
      }
    }
    expect(steamTagsDue(makeGame('a', {}, fresh), NOW)).toBe(false)
    expect(steamTagsDue(makeGame('a', {}, fresh), NOW + STEAM_TAGS_REFRESH_MS)).toBe(true)
    const miss = { steamTags: { tags: [], appId: 100, missedAt: iso(NOW) } }
    expect(steamTagsDue(makeGame('a', {}, miss), NOW + 1000)).toBe(false)
    expect(steamTagsDue(makeGame('a', {}, miss), NOW + STEAM_TAGS_MISS_RETRY_MS)).toBe(true)
    expect(steamTagsDue(makeGame('r', { source: 'rom' } as Partial<Game>), NOW)).toBe(false)
    // Read before the controls were (0.1.127): read once more.
    const old = { steamTags: { tags: ['Roguelike'], appId: 100, updatedAt: iso(NOW - 1000) } }
    expect(steamTagsDue(makeGame('a', {}, old), NOW)).toBe(true)
    // Read before Valve Anti-Cheat was: read once more.
    const noVac = { steamTags: { ...fresh.steamTags, vac: undefined } }
    expect(steamTagsDue(makeGame('a', {}, noVac), NOW)).toBe(true)
  })

  it('reads again when the game is matched to another app or retitled', () => {
    const controls = { controller: null, vr: null }
    const tagged = {
      steamTags: { tags: ['Roguelike'], appId: 999, updatedAt: iso(NOW), controls, vac: false }
    }
    expect(steamTagsDue(makeGame('a', {}, tagged), NOW)).toBe(true)
    const searched = {
      steamTags: {
        tags: ['Roguelike'],
        appId: 5,
        title: 'Old Name',
        updatedAt: iso(NOW),
        controls,
        vac: false
      }
    }
    const gog = { source: 'gog', externalId: 'x', title: 'New Name' } as Partial<Game>
    expect(steamTagsDue(makeGame('a', gog, searched), NOW)).toBe(true)
    expect(steamTagsDue(makeGame('a', { ...gog, title: 'Old Name' }, searched), NOW)).toBe(false)
  })

  it('reads at once when a game without a Steam app gets one, and drops a match that is gone', () => {
    const gog = { source: 'gog', externalId: 'x', title: 'Hades' } as Partial<Game>
    const missed = { steamTags: { tags: [], title: 'Hades', missedAt: iso(NOW) } }
    expect(steamTagsDue(makeGame('a', gog, missed), NOW + 1000)).toBe(false)
    expect(
      steamTagsDue(makeGame('a', gog, { ...missed, sources: { steam: '1145360' } }), NOW + 1000)
    ).toBe(true)
    // Tagged through a scraped Steam match that a later metadata pick replaced.
    const viaMatch = { steamTags: { tags: ['Roguelike'], appId: 1145360, updatedAt: iso(NOW) } }
    expect(steamTagsDue(makeGame('a', gog, viaMatch), NOW + 1000)).toBe(true)
  })
})

describe('sameRelease', () => {
  it('takes a re-release by its original year, not a newer game of the same name', () => {
    expect(sameRelease(2006, 2017)).toBe(false)
    expect(sameRelease(1997, 1997)).toBe(true)
    expect(sameRelease(2019, 2020)).toBe(true)
    expect(sameRelease(undefined, 2017)).toBe(true)
  })
})

describe('tagNamesOf', () => {
  it('keeps order, skips unknown ids and duplicates', () => {
    expect(tagNamesOf([3, 9, 1, 3], NAMES)).toEqual(['Great Soundtrack', 'Roguelike'])
  })
})

describe('fetchSteamTagIds', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('orders tags by weight and marks apps Steam does not show', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            response: {
              store_items: [
                {
                  id: 10,
                  appid: 10,
                  success: 1,
                  tags: [
                    { tagid: 2, weight: 100 },
                    { tagid: 1, weight: 900 }
                  ],
                  release: { steam_release_date: 1446400800, original_release_date: 875602800 }
                },
                { id: 11, appid: 0, success: 15 }
              ]
            }
          }),
          { status: 200 }
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    const out = await fetchSteamTagIds([10, 11, 12])
    expect(out.get(10)).toEqual({
      tagIds: [1, 2],
      year: 1997,
      controls: { controller: null, vr: null },
      vac: false
    })
    const input0 = JSON.parse(
      new URL(String((fetchMock.mock.calls as unknown[][])[0][0])).searchParams.get('input_json') ??
        '{}'
    )
    expect(input0.data_request).toMatchObject({ include_platforms: true })
    expect(out.get(11)).toEqual({ tagIds: [] })
    expect(out.has(12)).toBe(false)
    const url = new URL(String((fetchMock.mock.calls as unknown[][])[0][0]))
    const input = JSON.parse(url.searchParams.get('input_json') ?? '{}')
    expect(input.ids).toEqual([{ appid: 10 }, { appid: 11 }, { appid: 12 }])
    expect(input.data_request).toEqual({
      include_tag_count: 20,
      include_release: true,
      include_platforms: true
    })
  })
})

describe('createSteamTags', () => {
  it("writes Steam games' tags in batches, and other stores' games by title", async () => {
    const steamGames = Array.from({ length: STEAM_TAGS_BATCH + 5 }, (_, i) =>
      makeGame(`s${i}`, { externalId: String(1000 + i) })
    )
    const gog = makeGame('hades', { source: 'gog', externalId: 'g1', title: 'Hades' })
    const lost = makeGame('lost', { source: 'epic', externalId: 'e1', title: 'Nowhere' })
    const { deps } = setup([...steamGames, gog, lost])
    const fetchTagIds = vi.fn(
      async (ids: readonly number[]) =>
        new Map<number, SteamTagItem>(ids.map((id) => [id, { tagIds: [1, 3], vac: false }]))
    )
    const findAppId = vi.fn(async (title: string) => (title === 'Hades' ? 1145360 : undefined))
    const service = createSteamTags({ ...deps, fetchTagIds, findAppId })
    service.kick()
    await service.idle()
    expect(fetchTagIds).toHaveBeenCalledTimes(3)
    expect(fetchTagIds.mock.calls[0][0]).toHaveLength(STEAM_TAGS_BATCH)
    expect(steamGames[0].metadata.steamTags).toEqual({
      tags: ['Roguelike', 'Great Soundtrack'],
      appId: 1000,
      updatedAt: iso(NOW),
      controls: { controller: null, vr: null },
      vac: false
    })
    expect(gog.metadata.steamTags).toMatchObject({
      appId: 1145360,
      title: 'Hades',
      tags: ['Roguelike', 'Great Soundtrack']
    })
    expect(lost.metadata.steamTags).toEqual({ tags: [], title: 'Nowhere', missedAt: iso(NOW) })
    // Nothing is due any more.
    service.kick()
    await service.idle()
    expect(fetchTagIds).toHaveBeenCalledTimes(3)
    expect(findAppId).toHaveBeenCalledTimes(2)
  })

  it("refuses a title match from another year, and uses the library's own Steam copy", async () => {
    const prey = makeGame(
      'prey',
      { source: 'gog', externalId: 'g', title: 'Prey' },
      { releaseDate: '2006-07-11' }
    )
    const doom = makeGame(
      'doom',
      { source: 'epic', externalId: 'e', title: 'DOOM Eternal' },
      { releaseDate: '2020-03-20' }
    )
    const steamDoom = makeGame('steam-doom', { externalId: '782330', title: 'DOOM Eternal™' })
    const { deps } = setup([prey, doom, steamDoom])
    const fetchTagIds = vi.fn(
      async (ids: readonly number[]) =>
        new Map<number, SteamTagItem>(
          ids.map((id) => [id, { tagIds: [2], year: id === 480490 ? 2017 : 2020, vac: false }])
        )
    )
    const findAppId = vi.fn(async (title: string) => (title === 'Prey' ? 480490 : undefined))
    const service = createSteamTags({ ...deps, fetchTagIds, findAppId })
    service.kick()
    await service.idle()
    expect(prey.metadata.steamTags).toEqual({ tags: [], title: 'Prey', missedAt: iso(NOW) })
    expect(doom.metadata.steamTags).toMatchObject({ appId: 782330, tags: ['Action'] })
    // Only Prey was searched: DOOM Eternal came from the library's Steam copy.
    expect(findAppId).toHaveBeenCalledTimes(1)
  })

  it('reads a title match again at refresh time without searching again', async () => {
    const hades = makeGame(
      'hades',
      { source: 'gog', externalId: 'g', title: 'Hades' },
      {
        steamTags: {
          tags: ['Roguelike'],
          appId: 1145360,
          title: 'Hades',
          updatedAt: iso(NOW - STEAM_TAGS_REFRESH_MS)
        }
      }
    )
    const { deps } = setup([hades])
    const fetchTagIds = vi.fn(
      async (ids: readonly number[]) =>
        new Map<number, SteamTagItem>(ids.map((id) => [id, { tagIds: [4, 1], vac: false }]))
    )
    const findAppId = vi.fn(async () => 1)
    const service = createSteamTags({ ...deps, fetchTagIds, findAppId })
    service.kick()
    await service.idle()
    expect(findAppId).not.toHaveBeenCalled()
    expect(hades.metadata.steamTags).toMatchObject({
      appId: 1145360,
      tags: ['Souls-like', 'Roguelike']
    })
  })

  it('does nothing while switched off', async () => {
    const { deps, value } = setup([makeGame('a')])
    value.scrapers.steamTags.enabled = false
    const fetchTagIds = vi.fn(async () => new Map<number, SteamTagItem>())
    const service = createSteamTags({ ...deps, fetchTagIds })
    service.kick()
    await service.idle()
    expect(fetchTagIds).not.toHaveBeenCalled()
  })

  it('pauses when Steam stops answering and gives up after two pauses, writing nothing', async () => {
    const { deps } = setup([makeGame('a')])
    const fetchTagIds = vi.fn(async () => {
      throw new Error('offline')
    })
    const service = createSteamTags({ ...deps, fetchTagIds })
    service.kick()
    await service.idle()
    expect(fetchTagIds).toHaveBeenCalledTimes(6)
    expect(deps.sleep).toHaveBeenCalledTimes(2)
    expect(deps.library.applyMetadata).not.toHaveBeenCalled()
  })
})
