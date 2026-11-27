import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { defaultSettings } from '../../shared/defaults'
import type { Game, Settings } from '../../shared/types'
import { HttpError, RateLimiter } from './http'
import { createSteamGridDbScraper, pickImage } from './steamgriddb'

const BASE = 'https://www.steamgriddb.com/api/v2'

/** Spec examples from docs/research/metadata-apis.md section 1.3. */
const GAME_HL2 = {
  success: true,
  data: {
    id: 2254,
    name: 'Half-Life 2',
    types: ['steam'],
    verified: true,
    release_date: 1101772800
  }
}
const SEARCH_PORTAL = {
  success: true,
  data: [
    { id: 5250, name: 'Portal 2', types: ['steam'], verified: true, release_date: 1303171200 },
    { id: 5251, name: 'Portal 2 - Sixense MotionPack', types: ['steam'], verified: true }
  ]
}
const GRIDS = {
  success: true,
  page: 0,
  total: 2,
  limit: 50,
  data: [
    {
      id: 1,
      score: 9,
      style: 'alternate',
      url: 'https://cdn2.steamgriddb.com/grid/wide.png',
      thumb: 'https://cdn2.steamgriddb.com/thumb/wide.jpg',
      tags: [],
      author: { name: 'a' },
      width: 460,
      height: 215,
      mime: 'image/png'
    },
    {
      id: 2,
      score: 3,
      style: 'alternate',
      url: 'https://cdn2.steamgriddb.com/grid/tall.jpg',
      thumb: 'https://cdn2.steamgriddb.com/thumb/tall.jpg',
      tags: [],
      author: { name: 'b' },
      width: 600,
      height: 900,
      mime: 'image/jpeg'
    }
  ]
}
const HEROES = {
  success: true,
  data: [
    {
      id: 3,
      score: 5,
      url: 'https://cdn2.steamgriddb.com/hero/big.png',
      width: 3840,
      height: 1240,
      mime: 'image/png'
    },
    {
      id: 4,
      score: 4,
      url: 'https://cdn2.steamgriddb.com/hero/std.png',
      width: 1920,
      height: 620,
      mime: 'image/png'
    }
  ]
}
const LOGOS = {
  success: true,
  data: [
    {
      id: 5,
      score: 7,
      style: 'official',
      url: 'https://cdn2.steamgriddb.com/logo/a.webp',
      mime: 'image/webp'
    },
    {
      id: 6,
      score: 6,
      style: 'official',
      url: 'https://cdn2.steamgriddb.com/logo/b.png',
      mime: 'image/png'
    }
  ]
}
const ICONS = {
  success: true,
  data: [
    {
      id: 7,
      score: 9,
      url: 'https://cdn2.steamgriddb.com/icon/a.ico',
      width: 256,
      height: 256,
      mime: 'image/vnd.microsoft.icon'
    },
    {
      id: 8,
      score: 8,
      url: 'https://cdn2.steamgriddb.com/icon/small.png',
      width: 32,
      height: 32,
      mime: 'image/png'
    },
    {
      id: 9,
      score: 2,
      url: 'https://cdn2.steamgriddb.com/icon/b.png',
      width: 256,
      height: 256,
      mime: 'image/png'
    }
  ]
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

interface Call {
  url: URL
  init: RequestInit
}

/** Stub fetch with a path -> response map; unknown paths answer 404 like the real API. */
function stubApi(routes: Record<string, unknown | ((call: Call) => Response)>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input)
      const call = { url, init }
      calls.push(call)
      const route = routes[url.pathname.replace('/api/v2', '')]
      if (route === undefined) return json({ success: false, errors: ['Game not found'] }, 404)
      return typeof route === 'function' ? (route as (c: Call) => Response)(call) : json(route)
    })
  )
  return calls
}

function settings(apiKey = 'key123'): Settings {
  const s = defaultSettings()
  s.scrapers.steamgriddb.apiKey = apiKey
  return s
}

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
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {},
    ...overrides
  }
}

const scraper = createSteamGridDbScraper({ limiter: new RateLimiter(10_000, 100) })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('steamGridDbScraper', () => {
  it('is configured only with an API key', () => {
    expect(scraper.id).toBe('steamgriddb')
    expect(scraper.isConfigured(settings(''))).toBe(false)
    expect(scraper.isConfigured(settings('  '))).toBe(false)
    expect(scraper.isConfigured(settings('abc'))).toBe(true)
  })

  it('resolves Steam games directly by app id with a Bearer header', async () => {
    const calls = stubApi({ '/games/steam/620': GAME_HL2 })
    const candidates = await scraper.search(
      game({ title: 'Half-Life 2', extra: { steamAppId: 620 } }),
      settings()
    )
    expect(candidates).toEqual([
      {
        scraper: 'steamgriddb',
        byId: true,
        externalId: '2254',
        title: 'Half-Life 2',
        releaseDate: '2004-11-30'
      }
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].url.toString()).toBe(`${BASE}/games/steam/620`)
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer key123')
  })

  it('names its game for a Steam app id, null when it has none, undefined without an app id', async () => {
    stubApi({ '/games/steam/620': GAME_HL2 })
    expect(await scraper.idMatchOf!(game({ extra: { steamAppId: 620 } }), settings())).toBe('2254')
    stubApi({})
    expect(
      await scraper.idMatchOf!(game({ extra: { steamAppId: 2523740 } }), settings())
    ).toBeNull()
    expect(
      await scraper.idMatchOf!(
        game({ source: 'epic', externalId: 'x', extra: undefined }),
        settings()
      )
    ).toBeUndefined()
  })

  it('falls back to the Steam external id and then to a name search when the app id is unknown', async () => {
    const calls = stubApi({ '/search/autocomplete/Portal%202': SEARCH_PORTAL })
    const candidates = await scraper.search(game(), settings())
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/api/v2/games/steam/620',
      '/api/v2/search/autocomplete/Portal%202'
    ])
    expect(candidates.map((c) => c.externalId)).toEqual(['5250', '5251'])
    expect(candidates[0]).toEqual({
      scraper: 'steamgriddb',
      externalId: '5250',
      title: 'Portal 2',
      releaseDate: '2011-04-19'
    })
    expect(candidates[1].releaseDate).toBeUndefined()
  })

  it('looks up the release year of games of the same name the search gives none for', async () => {
    const calls = stubApi({
      '/search/autocomplete/SSX': {
        success: true,
        data: [
          { id: 38268, name: 'SSX', types: [], verified: true },
          { id: 5404410, name: 'SSX', types: [], verified: true },
          { id: 999, name: 'SSX Tricky', types: [], verified: true }
        ]
      },
      '/games/id/38268': {
        success: true,
        data: { id: 38268, name: 'SSX', release_date: 972518400 }
      },
      '/games/id/5404410': {
        success: true,
        data: { id: 5404410, name: 'SSX', release_date: 1330387200 }
      }
    })
    const candidates = await scraper.search(
      game({
        id: 'rom:xbox360:x',
        source: 'rom',
        externalId: 'SSX (USA).iso',
        platformId: 'xbox360',
        title: 'SSX',
        extra: undefined
      }),
      settings()
    )
    expect(candidates.map((c) => [c.externalId, c.releaseDate])).toEqual([
      ['38268', '2000-10-26'],
      ['5404410', '2012-02-28'],
      ['999', undefined]
    ])
    // Only the two of the same name were looked up (SSX Tricky's year does not matter).
    expect(calls.map((c) => c.url.pathname).filter((p) => p.includes('/games/id/'))).toEqual([
      '/api/v2/games/id/38268',
      '/api/v2/games/id/5404410'
    ])
  })

  it('takes names that differ only by a mark or punctuation as the same name for the year look-up', async () => {
    const calls = stubApi({
      '/search/autocomplete/SSX': {
        success: true,
        data: [
          { id: 48268, name: 'SSX', types: [], verified: true },
          { id: 6404410, name: 'SSX®', types: [], verified: true }
        ]
      },
      '/games/id/48268': {
        success: true,
        data: { id: 48268, name: 'SSX', release_date: 972518400 }
      },
      '/games/id/6404410': {
        success: true,
        data: { id: 6404410, name: 'SSX®', release_date: 1330387200 }
      }
    })
    const candidates = await scraper.search(
      game({
        id: 'rom:xbox360:x',
        source: 'rom',
        externalId: 'SSX (USA).iso',
        platformId: 'xbox360',
        title: 'SSX',
        extra: undefined
      }),
      settings()
    )
    expect(candidates.map((c) => c.releaseDate)).toEqual(['2000-10-26', '2012-02-28'])
    expect(calls.filter((c) => c.url.pathname.includes('/games/id/'))).toHaveLength(2)
  })

  it('searches ROMs by their cleaned title and lets an explicit query bypass the Steam shortcut', async () => {
    const calls = stubApi({
      '/search/autocomplete/Super%20Mario%20World': SEARCH_PORTAL,
      '/search/autocomplete/zelda': SEARCH_PORTAL
    })
    await scraper.search(
      game({
        id: 'rom:snes:x',
        source: 'rom',
        externalId: 'Super Mario World (USA) [!].sfc',
        platformId: 'snes',
        title: 'Super Mario World (USA) [!]'
      }),
      settings()
    )
    await scraper.search(game({ extra: { steamAppId: 620 } }), settings(), 'zelda')
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/api/v2/search/autocomplete/Super%20Mario%20World',
      '/api/v2/search/autocomplete/zelda'
    ])
  })

  it('fetches grids, heroes, logos and icons with the documented filters and picks the best of each', async () => {
    const calls = stubApi({
      '/grids/game/5250': GRIDS,
      '/heroes/game/5250': HEROES,
      '/logos/game/5250': LOGOS,
      '/icons/game/5250': ICONS
    })
    const result = await scraper.fetch(
      game(),
      { scraper: 'steamgriddb', externalId: '5250', title: 'Portal 2', releaseDate: '2011-04-19' },
      settings()
    )
    expect(result.media).toEqual({
      cover: 'https://cdn2.steamgriddb.com/grid/tall.jpg',
      hero: 'https://cdn2.steamgriddb.com/hero/std.png',
      logo: 'https://cdn2.steamgriddb.com/logo/b.png',
      icon: 'https://cdn2.steamgriddb.com/icon/b.png'
    })
    expect(result.title).toBe('Portal 2')
    expect(result.metadata).toEqual({ sources: { steamgriddb: '5250' }, releaseDate: '2011-04-19' })
    expect(calls).toHaveLength(4)
    const grids = calls.find((c) => c.url.pathname.includes('/grids/'))!.url.searchParams
    expect(grids.get('dimensions')).toBe('600x900,342x482,660x930')
    expect(grids.get('mimes')).toBe('image/png,image/jpeg,image/webp')
    expect(grids.get('types')).toBe('static')
    expect(grids.get('nsfw')).toBe('false')
    expect(grids.get('humor')).toBe('false')
    expect(grids.get('epilepsy')).toBe('false')
    const heroes = calls.find((c) => c.url.pathname.includes('/heroes/'))!.url.searchParams
    expect(heroes.get('dimensions')).toBe('1920x620,3840x1240,1600x650')
    const icons = calls.find((c) => c.url.pathname.includes('/icons/'))!.url.searchParams
    expect(icons.get('mimes')).toBe('image/png,image/vnd.microsoft.icon')
    for (const call of calls)
      expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer key123')
  })

  it('requests only the kinds the caller still needs', async () => {
    const calls = stubApi({
      '/grids/game/5250': GRIDS,
      '/heroes/game/5250': HEROES,
      '/logos/game/5250': LOGOS,
      '/icons/game/5250': ICONS
    })
    const result = await scraper.fetch(
      game(),
      { scraper: 'steamgriddb', externalId: '5250', title: 'Portal 2' },
      settings(),
      ['icon', 'hero']
    )
    expect(result.media).toEqual({
      hero: 'https://cdn2.steamgriddb.com/hero/std.png',
      icon: 'https://cdn2.steamgriddb.com/icon/b.png'
    })
    expect(calls.map((c) => c.url.pathname.split('/')[3]).sort()).toEqual(['heroes', 'icons'])
  })

  it('treats a 404 image list as no images instead of failing', async () => {
    stubApi({ '/grids/game/1': GRIDS })
    const result = await scraper.fetch(
      game(),
      { scraper: 'steamgriddb', externalId: '1', title: 'x' },
      settings()
    )
    expect(result.media).toEqual({ cover: 'https://cdn2.steamgriddb.com/grid/tall.jpg' })
  })

  it('reports an invalid API key with a message the UI can show', async () => {
    stubApi({
      '/search/autocomplete/Portal%202': () =>
        json({ success: false, errors: ['Unauthorized'] }, 401)
    })
    const err = await scraper
      .search(
        game({ source: 'manual', externalId: 'C:\\g\\portal2.exe', platformId: 'pc' }),
        settings()
      )
      .catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).message).toBe('SteamGridDB: invalid API key')
    expect((err as HttpError).status).toBe(401)
  })

  it('refuses to search without a key and surfaces API-level failures', async () => {
    stubApi({ '/search/autocomplete/Portal%202': { success: false, errors: ['Something broke'] } })
    await expect(scraper.search(game(), settings(''))).rejects.toThrow(
      'SteamGridDB: API key not configured'
    )
    await expect(
      scraper.search(game({ source: 'manual', platformId: 'pc' }), settings())
    ).rejects.toThrow('SteamGridDB: Something broke')
  })
})

describe('pickImage', () => {
  it('prefers the documented sizes and formats, then the API order', () => {
    expect(pickImage('grids', GRIDS.data)?.id).toBe(2)
    expect(pickImage('heroes', HEROES.data)?.id).toBe(4)
    expect(pickImage('logos', LOGOS.data)?.id).toBe(6)
    expect(pickImage('icons', ICONS.data)?.id).toBe(9)
    expect(pickImage('grids', [GRIDS.data[0]])?.id).toBe(1)
    expect(pickImage('grids', [])).toBeUndefined()
  })
})
