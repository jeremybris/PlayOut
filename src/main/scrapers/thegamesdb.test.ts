import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { defaultSettings } from '../../shared/defaults'
import type { Game, Settings } from '../../shared/types'
import { HttpError, RateLimiter } from './http'
import { createTheGamesDbScraper } from './thegamesdb'

const CDN = 'https://cdn.thegamesdb.net/images/'
const BASE_URLS = {
  original: `${CDN}original/`,
  small: `${CDN}small/`,
  thumb: `${CDN}thumb/`,
  cropped_center_thumb: `${CDN}cropped_center_thumb/`,
  medium: `${CDN}medium/`,
  large: `${CDN}large/`
}

/** Spec example from docs/research/metadata-apis.md section 4.3. */
const SONIC = {
  id: 53,
  game_title: 'Sonic the Hedgehog',
  release_date: '1991-06-23',
  platform: 18,
  players: 1,
  overview: 'Join Sonic in his quest to stop Dr. Robotnik.',
  last_updated: '2022-03-15 10:22:45',
  rating: 'E - Everyone',
  coop: 'No',
  youtube: 'E8VPmADC4aA',
  developers: [1296],
  genres: [1],
  publishers: [1]
}

function gamesResponse(games: (typeof SONIC)[], v11 = true): unknown {
  const boxart: Record<string, unknown[]> = {}
  for (const g of games)
    boxart[String(g.id)] = [
      {
        id: 17438,
        type: 'boxart',
        side: 'front',
        filename: `boxart/front/${g.id}-1.jpg`,
        resolution: '1521x2156'
      }
    ]
  const platforms = { '18': { id: 18, name: 'Sega Genesis', alias: 'sega-genesis' } }
  return {
    code: 200,
    status: 'Success',
    remaining_monthly_allowance: 249,
    extra_allowance: 0,
    allowance_refresh_timer: 2592000,
    data: { count: games.length, games },
    include: {
      boxart: { base_url: BASE_URLS, data: boxart },
      platform: v11 ? { data: platforms } : platforms
    },
    pages: { previous: null, current: 'x', next: null }
  }
}

const IMAGES = {
  code: 200,
  status: 'Success',
  remaining_monthly_allowance: 248,
  data: {
    count: 6,
    base_url: BASE_URLS,
    images: {
      '53': [
        {
          id: 17438,
          type: 'boxart',
          side: 'front',
          filename: 'boxart/front/53-1.jpg',
          resolution: '1521x2156'
        },
        { id: 2, type: 'boxart', side: 'back', filename: 'boxart/back/53-1.jpg' },
        { id: 3, type: 'fanart', filename: 'fanart/53-1.jpg' },
        { id: 4, type: 'clearlogo', filename: 'clearlogo/53-1.png' },
        { id: 5, type: 'screenshot', filename: 'screenshots/53-1.jpg' },
        { id: 6, type: 'titlescreen', filename: 'titlescreen/53-1.jpg' }
      ]
    }
  }
}

const TABLES: Record<string, unknown> = {
  '/v1/Genres': { code: 200, data: { count: 1, genres: { '1': { id: 1, name: 'Action' } } } },
  '/v1/Developers': {
    code: 200,
    data: { count: 1, developers: { '1296': { id: 1296, name: 'Sonic Team' } } }
  },
  '/v1/Publishers': { code: 200, data: { count: 1, publishers: { '1': { id: 1, name: 'SEGA' } } } }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

interface Call {
  url: URL
  params: URLSearchParams
}

type Handler = (call: Call) => Response

function stubApi(routes: Record<string, unknown | Handler>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input)
      const call = { url, params: url.searchParams }
      calls.push(call)
      const route = routes[url.pathname]
      if (route === undefined) return json({ code: 404, status: 'Not Found' }, 404)
      return typeof route === 'function' ? (route as Handler)(call) : json(route)
    })
  )
  return calls
}

function settings(apiKey = 'tgdbkey'): Settings {
  const s = defaultSettings()
  s.scrapers.thegamesdb.apiKey = apiKey
  return s
}

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 'rom:genesis:abc',
    source: 'rom',
    externalId: 'Sonic the Hedgehog (USA, Europe).md',
    platformId: 'genesis',
    title: 'Sonic the Hedgehog (USA, Europe)',
    sortTitle: 'sonic the hedgehog',
    installed: true,
    romPath: 'D:\\roms\\genesis\\Sonic the Hedgehog (USA, Europe).md',
    launch: {
      kind: 'emulator',
      systemId: 'genesis',
      romPath: 'D:\\roms\\genesis\\Sonic the Hedgehog (USA, Europe).md'
    },
    tracking: { mode: 'spawned' },
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

function newScraper(): ReturnType<typeof createTheGamesDbScraper> {
  return createTheGamesDbScraper({ limiter: new RateLimiter(10_000, 100) })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('theGamesDbScraper', () => {
  it('is configured only with an API key', () => {
    const scraper = newScraper()
    expect(scraper.id).toBe('thegamesdb')
    expect(scraper.isConfigured(settings(''))).toBe(false)
    expect(scraper.isConfigured(settings())).toBe(true)
  })

  it('searches by cleaned name with the platform filter and maps candidates with boxart thumbnails', async () => {
    const calls = stubApi({ '/v1.1/Games/ByGameName': gamesResponse([SONIC]) })
    const candidates = await newScraper().search(game(), settings())
    expect(calls).toHaveLength(1)
    const p = calls[0].params
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(
      'https://api.thegamesdb.net/v1.1/Games/ByGameName'
    )
    expect(p.get('apikey')).toBe('tgdbkey')
    expect(p.get('name')).toBe('Sonic the Hedgehog')
    expect(p.get('filter[platform]')).toBe('18')
    expect(p.get('include')).toBe('boxart,platform')
    expect(p.get('fields')).toContain('overview')
    expect(candidates).toEqual([
      {
        scraper: 'thegamesdb',
        externalId: '53',
        title: 'Sonic the Hedgehog',
        releaseDate: '1991-06-23',
        platform: 'Sega Genesis',
        platformIds: [18],
        cover: `${CDN}small/boxart/front/53-1.jpg`
      }
    ])
  })

  it('uses the PC platform for store games, no filter for unknown systems, and reads the v1 platform shape', async () => {
    const calls = stubApi({ '/v1.1/Games/ByGameName': gamesResponse([SONIC], false) })
    const scraper = newScraper()
    const [candidate] = await scraper.search(
      game({
        id: 'steam:620',
        source: 'steam',
        externalId: '620',
        platformId: 'steam',
        title: 'Portal 2'
      }),
      settings()
    )
    await scraper.search(game({ platformId: 'unknownsys' }), settings(), 'Sonic')
    expect(calls[0].params.get('filter[platform]')).toBe('1')
    expect(calls[0].params.get('name')).toBe('Portal 2')
    expect(calls[1].params.has('filter[platform]')).toBe(false)
    expect(calls[1].params.get('name')).toBe('Sonic')
    expect(candidate.platform).toBe('Sega Genesis')
  })

  it('fetches images and resolves genre, developer and publisher ids from the cached tables', async () => {
    const calls = stubApi({
      '/v1.1/Games/ByGameName': gamesResponse([SONIC]),
      '/v1/Games/Images': IMAGES,
      ...TABLES
    })
    const scraper = newScraper()
    const [candidate] = await scraper.search(game(), settings())
    const result = await scraper.fetch(game(), candidate, settings())
    const paths = calls.map((c) => c.url.pathname)
    expect(paths).not.toContain('/v1/Games/ByGameID')
    expect(paths.filter((p) => p === '/v1/Games/Images')).toHaveLength(1)
    const images = calls.find((c) => c.url.pathname === '/v1/Games/Images')!.params
    expect(images.get('games_id')).toBe('53')
    expect(images.get('filter[type]')).toBe('boxart,fanart,clearlogo,screenshot,titlescreen')
    expect(result.title).toBe('Sonic the Hedgehog')
    expect(result.metadata).toEqual({
      sources: { thegamesdb: '53' },
      description: 'Join Sonic in his quest to stop Dr. Robotnik.',
      releaseDate: '1991-06-23',
      developers: ['Sonic Team'],
      publishers: ['SEGA'],
      genres: ['Action'],
      players: '1',
      tags: ['E - Everyone']
    })
    expect(result.media).toEqual({
      cover: `${CDN}large/boxart/front/53-1.jpg`,
      hero: `${CDN}large/fanart/53-1.jpg`,
      logo: `${CDN}large/clearlogo/53-1.png`,
      screenshots: [`${CDN}large/screenshots/53-1.jpg`, `${CDN}large/titlescreen/53-1.jpg`]
    })

    // A second fetch reuses the tables (one call each) and only asks for the images again.
    await scraper.fetch(game(), candidate, settings())
    const again = calls.map((c) => c.url.pathname)
    expect(again.filter((p) => p === '/v1/Genres')).toHaveLength(1)
    expect(again.filter((p) => p === '/v1/Developers')).toHaveLength(1)
    expect(again.filter((p) => p === '/v1/Publishers')).toHaveLength(1)
    expect(again.filter((p) => p === '/v1/Games/Images')).toHaveLength(2)
  })

  it('fetches an uncached id with ByGameID and survives a failing lookup table or image list', async () => {
    const calls = stubApi({
      '/v1/Games/ByGameID': gamesResponse([{ ...SONIC, coop: 'Yes', players: 2 }]),
      '/v1/Genres': TABLES['/v1/Genres'],
      '/v1/Developers': () => json({ code: 403, status: 'Forbidden' }, 403),
      '/v1/Publishers': TABLES['/v1/Publishers']
    })
    const result = await newScraper().fetch(
      game(),
      { scraper: 'thegamesdb', externalId: '53', title: 'Sonic' },
      settings()
    )
    expect(calls[0].url.pathname).toBe('/v1/Games/ByGameID')
    expect(calls[0].params.get('id')).toBe('53')
    expect(result.metadata.developers).toBeUndefined()
    expect(result.metadata.publishers).toEqual(['SEGA'])
    expect(result.metadata.genres).toEqual(['Action'])
    expect(result.metadata.players).toBe('2')
    expect(result.metadata.tags).toEqual(['E - Everyone', 'Co-op'])
    // Images answered 404: the boxart from the game record is still used.
    expect(result.media).toEqual({ cover: `${CDN}large/boxart/front/53-1.jpg` })
  })

  it('reports a rejected key with a message the UI can show', async () => {
    stubApi({
      '/v1.1/Games/ByGameName': () => json({ code: 418, status: 'Unknown Error Code' }, 418)
    })
    const err = await newScraper()
      .search(game(), settings())
      .catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).message).toBe(
      'TheGamesDB: invalid API key or monthly allowance exhausted'
    )
    expect((err as HttpError).url).toContain('apikey=***')
    expect((err as HttpError).url).not.toContain('tgdbkey')
  })

  it('refuses to run without a key and rejects malformed ids', async () => {
    const calls = stubApi({})
    await expect(newScraper().search(game(), settings(''))).rejects.toThrow(
      'TheGamesDB: API key not configured'
    )
    await expect(
      newScraper().fetch(
        game(),
        { scraper: 'thegamesdb', externalId: '53;x', title: 'x' },
        settings()
      )
    ).rejects.toThrow('invalid game id')
    expect(calls).toHaveLength(0)
  })
})
