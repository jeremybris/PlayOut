import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { defaultSettings } from '../../shared/defaults'
import type { Game, Settings } from '../../shared/types'
import { pickCandidate } from './candidate-match'
import { HttpError, RateLimiter } from './http'
import { apicalypseString, createIgdbScraper, igdbImageUrl, mapIgdbGame } from './igdb'

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const GAMES_URL = 'https://api.igdb.com/v4/games'
const LOGOS_URL = 'https://api.igdb.com/v4/logos'

/** Shapes follow the field lists in docs/research/metadata-apis.md section 2.4. */
const SEARCH_RESULT = [
  { id: 99, name: 'Super Mario World Bundle', game_type: 3 },
  {
    id: 1070,
    name: 'Super Mario World',
    slug: 'super-mario-world',
    first_release_date: 659577600,
    platforms: [{ id: 19, name: 'Super Nintendo Entertainment System' }],
    cover: { id: 1, image_id: 'co1xyz' },
    game_type: 0
  },
  { id: 1071, name: 'Super Mario World', version_title: 'Game Boy Advance version', game_type: 11 }
]

const FULL_GAME = [
  {
    id: 1070,
    name: 'Super Mario World',
    summary: "Mario's quest to save Princess Toadstool across Dinosaur Land.",
    storyline: 'Bowser kidnaps the princess again.',
    first_release_date: 659577600,
    total_rating: 92.4,
    aggregated_rating: 90,
    rating: 93.1,
    url: 'https://www.igdb.com/games/super-mario-world',
    genres: [{ id: 8, name: 'Platform' }],
    themes: [{ id: 1, name: 'Action' }],
    game_modes: [
      { id: 1, name: 'Single player' },
      { id: 2, name: 'Multiplayer' }
    ],
    player_perspectives: [{ id: 4, name: 'Side view' }],
    multiplayer_modes: [{ offlinemax: 2, offlinecoopmax: 0 }],
    cover: { id: 1, image_id: 'co1xyz', width: 528, height: 748 },
    artworks: [
      { id: 2, image_id: 'ar_tall', width: 600, height: 900 },
      { id: 3, image_id: 'ar_wide', width: 1920, height: 1080 }
    ],
    screenshots: [
      { id: 4, image_id: 'sc1' },
      { id: 5, image_id: 'sc2' }
    ],
    involved_companies: [
      { company: { id: 70, name: 'Nintendo' }, developer: true, publisher: true },
      { company: { id: 71, name: 'Nintendo EAD' }, developer: true, publisher: false }
    ],
    release_dates: [{ date: 659577600 }],
    platforms: [{ id: 19, name: 'Super Nintendo Entertainment System' }]
  }
]

const LOGO = [{ id: 9, image_id: 'lg1', width: 800, height: 300 }]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

interface Call {
  url: string
  init: RequestInit
  body: string
}

type Handler = (call: Call) => Response

/** Stub fetch with per-URL handlers; a handler may be a queue that is consumed call by call. */
function stubApi(routes: Record<string, Handler | Handler[]>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = { url, init, body: typeof init.body === 'string' ? init.body : '' }
      calls.push(call)
      const route = routes[url]
      if (!route) return json([{ title: 'Not Found' }], 404)
      const handler = Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]) : route
      return handler(call)
    })
  )
  return calls
}

const token =
  (value: string, expiresIn = 5587808): Handler =>
  () =>
    json({ access_token: value, expires_in: expiresIn, token_type: 'bearer' })

function settings(clientId = 'cid', clientSecret = 'csecret'): Settings {
  const s = defaultSettings()
  s.scrapers.igdb = { clientId, clientSecret }
  return s
}

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 'rom:snes:abc',
    source: 'rom',
    externalId: 'Super Mario World (USA).sfc',
    platformId: 'snes',
    title: 'Super Mario World (USA)',
    sortTitle: 'super mario world',
    installed: true,
    romPath: 'D:\\roms\\snes\\Super Mario World (USA).sfc',
    launch: {
      kind: 'emulator',
      systemId: 'snes',
      romPath: 'D:\\roms\\snes\\Super Mario World (USA).sfc'
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

function newScraper(): ReturnType<typeof createIgdbScraper> {
  return createIgdbScraper({ limiter: new RateLimiter(10_000, 100) })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('igdbScraper', () => {
  it('needs both a client id and a secret', () => {
    const scraper = newScraper()
    expect(scraper.id).toBe('igdb')
    expect(scraper.isConfigured(settings('', ''))).toBe(false)
    expect(scraper.isConfigured(settings('cid', ''))).toBe(false)
    expect(scraper.isConfigured(settings())).toBe(true)
  })

  it('fetches one client-credentials token, caches it and sends Apicalypse queries with the IGDB headers', async () => {
    const calls = stubApi({ [TOKEN_URL]: token('tok1'), [GAMES_URL]: () => json(SEARCH_RESULT) })
    const scraper = newScraper()
    const first = await scraper.search(game(), settings())
    await scraper.search(game(), settings())
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1)
    const tokenCall = calls[0]
    expect(tokenCall.init.method).toBe('POST')
    expect(new URLSearchParams(tokenCall.body).get('client_id')).toBe('cid')
    expect(new URLSearchParams(tokenCall.body).get('client_secret')).toBe('csecret')
    expect(new URLSearchParams(tokenCall.body).get('grant_type')).toBe('client_credentials')
    expect(tokenCall.url).not.toContain('csecret')

    const search = calls[1]
    expect(search.url).toBe(GAMES_URL)
    expect(search.init.method).toBe('POST')
    const headers = new Headers(search.init.headers)
    expect(headers.get('client-id')).toBe('cid')
    expect(headers.get('authorization')).toBe('Bearer tok1')
    expect(headers.get('content-type')).toBe('text/plain')
    expect(search.body).toContain('search "Super Mario World";')
    expect(search.body).toContain('where platforms = (19);')
    expect(search.body).toMatch(
      /^fields name,slug,first_release_date,platforms\.name,cover\.image_id,game_type,version_title,version_parent,alternative_names\.name; /
    )
    expect(search.body).toMatch(/limit 15;$/)

    expect(first.map((c) => c.externalId)).toEqual(['1070', '1071', '99'])
    expect(first[0]).toEqual({
      scraper: 'igdb',
      externalId: '1070',
      title: 'Super Mario World',
      releaseDate: '1990-11-26',
      platform: 'Super Nintendo Entertainment System',
      platformIds: [19],
      cover: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co1xyz.jpg'
    })
    expect(first[1].title).toBe('Super Mario World (Game Boy Advance version)')
  })

  it('uses the PC platform for store games, no platform filter for unknown systems, and the explicit query', async () => {
    const calls = stubApi({ [TOKEN_URL]: token('tok1'), [GAMES_URL]: () => json([]) })
    const scraper = newScraper()
    await scraper.search(
      game({
        id: 'steam:620',
        source: 'steam',
        externalId: '620',
        platformId: 'steam',
        title: 'Portal 2'
      }),
      settings()
    )
    await scraper.search(game({ platformId: 'unknownsys' }), settings(), 'Zelda "Link"')
    expect(calls[1].body).toContain('search "Portal 2"; where platforms = (6);')
    expect(calls[2].body).toContain('search "Zelda Link"; limit 15;')
    expect(calls[2].body).not.toContain('where')
  })

  it('maps a full game record to metadata and media URLs', async () => {
    const calls = stubApi({
      [TOKEN_URL]: token('tok1'),
      [GAMES_URL]: () => json(FULL_GAME),
      [LOGOS_URL]: () => json(LOGO)
    })
    const scraper = newScraper()
    const result = await scraper.fetch(
      game(),
      { scraper: 'igdb', externalId: '1070', title: 'Super Mario World' },
      settings()
    )
    expect(calls[1].body).toContain('where id = 1070;')
    expect(calls[1].body).toContain('involved_companies.company.name')
    expect(calls[2].url).toBe(LOGOS_URL)
    expect(calls[2].body).toBe('fields image_id,width,height; where game = 1070; limit 1;')
    expect(result.title).toBe('Super Mario World')
    expect(result.metadata).toEqual({
      sources: { igdb: '1070' },
      description: "Mario's quest to save Princess Toadstool across Dinosaur Land.",
      releaseDate: '1990-11-26',
      developers: ['Nintendo', 'Nintendo EAD'],
      publishers: ['Nintendo'],
      genres: ['Platform'],
      tags: ['Action', 'Single player', 'Multiplayer', 'Side view'],
      rating: 92,
      players: '1-2',
      links: { website: 'https://www.igdb.com/games/super-mario-world' }
    })
    expect(result.media).toEqual({
      cover: 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1xyz.jpg',
      hero: 'https://images.igdb.com/igdb/image/upload/t_1080p/ar_wide.jpg',
      screenshots: [
        'https://images.igdb.com/igdb/image/upload/t_screenshot_huge/sc1.jpg',
        'https://images.igdb.com/igdb/image/upload/t_screenshot_huge/sc2.jpg'
      ],
      logo: 'https://images.igdb.com/igdb/image/upload/t_1080p/lg1.png'
    })
  })

  it('maps sparse records without inventing fields', () => {
    const result = mapIgdbGame({
      id: 5,
      name: 'Mystery',
      storyline: 'Only a storyline.',
      game_modes: [{ name: 'Single player' }],
      screenshots: [{ image_id: 'sc9' }]
    })
    expect(result.metadata).toEqual({
      sources: { igdb: '5' },
      description: 'Only a storyline.',
      tags: ['Single player'],
      players: '1'
    })
    expect(result.media).toEqual({
      hero: igdbImageUrl('sc9', 't_1080p'),
      screenshots: [igdbImageUrl('sc9', 't_screenshot_huge')]
    })
  })

  it('stops asking for logos once the endpoint answers 4xx', async () => {
    const calls = stubApi({
      [TOKEN_URL]: token('tok1'),
      [GAMES_URL]: () => json(FULL_GAME),
      [LOGOS_URL]: () => json([{ title: 'Not Found' }], 404)
    })
    const scraper = newScraper()
    const candidate = { scraper: 'igdb' as const, externalId: '1070', title: 'Super Mario World' }
    const result = await scraper.fetch(game(), candidate, settings())
    expect(result.media.logo).toBeUndefined()
    expect(result.media.cover).toBeDefined()
    await scraper.fetch(game(), candidate, settings())
    expect(calls.filter((c) => c.url === LOGOS_URL)).toHaveLength(1)
  })

  it('refreshes the token once when the API answers 401', async () => {
    const calls = stubApi({
      [TOKEN_URL]: [token('tok1'), token('tok2')],
      [GAMES_URL]: [
        () => json({ message: 'Authorization Failure' }, 401),
        () => json(SEARCH_RESULT)
      ]
    })
    const scraper = newScraper()
    const candidates = await scraper.search(game(), settings())
    expect(candidates).toHaveLength(3)
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL, GAMES_URL, TOKEN_URL, GAMES_URL])
    expect(new Headers(calls[3].init.headers).get('authorization')).toBe('Bearer tok2')
  })

  it('reports bad credentials from the token endpoint and from the API', async () => {
    stubApi({ [TOKEN_URL]: () => json({ status: 403, message: 'invalid client secret' }, 403) })
    const scraper = newScraper()
    const err = await scraper.search(game(), settings()).catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).message).toBe('IGDB: invalid client id or secret')
    expect((err as HttpError).url).not.toContain('csecret')

    vi.unstubAllGlobals()
    stubApi({
      [TOKEN_URL]: token('tok1'),
      [GAMES_URL]: () => json({ message: 'Authorization Failure' }, 401)
    })
    const again = await newScraper()
      .search(game(), settings())
      .catch((e) => e)
    expect((again as HttpError).message).toBe('IGDB: invalid client id or secret')
  })

  it('re-requests the token when the credentials change or it expires', async () => {
    const calls = stubApi({
      [TOKEN_URL]: [token('tok1', 30), token('tok2'), token('tok3')],
      [GAMES_URL]: () => json([])
    })
    const scraper = newScraper()
    await scraper.search(game(), settings())
    // expires_in 30 s is inside the safety margin, so the next call needs a new token
    await scraper.search(game(), settings())
    await scraper.search(game(), settings('other', 'secret2'))
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(3)
  })

  it('rejects a non-numeric id without calling the API', async () => {
    const calls = stubApi({})
    await expect(
      newScraper().fetch(
        game(),
        { scraper: 'igdb', externalId: 'abc; fields *', title: 'x' },
        settings()
      )
    ).rejects.toThrow('invalid game id')
    expect(calls).toHaveLength(0)
  })
})

describe('igdbScraper: a game and the records of its editions', () => {
  // The Switch game and its editions as IGDB lists them: each edition a main game (type 0) with `version_parent`.
  const ZELDA = [
    {
      id: 134231,
      name: "The Legend of Zelda: Link's Awakening - Limited Edition",
      first_release_date: 1568937600,
      platforms: [{ id: 130, name: 'Nintendo Switch' }],
      game_type: 0,
      version_parent: 113113,
      version_title: 'Limited Edition'
    },
    {
      id: 134232,
      name: "The Legend of Zelda: Link's Awakening",
      first_release_date: 1568937600,
      platforms: [{ id: 130, name: 'Nintendo Switch' }],
      game_type: 0,
      version_parent: 113113,
      version_title: 'Dreamer Edition'
    },
    {
      id: 113113,
      name: "The Legend of Zelda: Link's Awakening",
      first_release_date: 1568937600,
      platforms: [{ id: 130, name: 'Nintendo Switch' }],
      game_type: 8
    }
  ]
  const zeldaRom = (): Game =>
    game({
      id: 'rom:switch:zelda',
      externalId:
        "switch/Super XCI/Other/The Legend of Zelda Link's Awakening [01006BB00C6F0000] [v131072] (1G+1U).xci",
      platformId: 'switch',
      title: "The Legend of Zelda Link's Awakening"
    })

  it('lists the game before its editions, names an edition once, and gives the platform ids', async () => {
    const calls = stubApi({ [TOKEN_URL]: token('tok1'), [GAMES_URL]: () => json(ZELDA) })
    const candidates = await newScraper().search(zeldaRom(), settings())
    expect(calls[1].body).toContain('where platforms = (130);')
    expect(candidates.map((c) => c.externalId)).toEqual(['113113', '134231', '134232'])
    expect(candidates.map((c) => c.title)).toEqual([
      "The Legend of Zelda: Link's Awakening",
      "The Legend of Zelda: Link's Awakening - Limited Edition",
      "The Legend of Zelda: Link's Awakening (Dreamer Edition)"
    ])
    expect(candidates[0].platformIds).toEqual([130])
  })

  it('is matched to the game itself, also when IGDB gives no version parent and lists the edition first', async () => {
    const plain = ZELDA.map((g) => ({ ...g, version_parent: undefined }))
    stubApi({ [TOKEN_URL]: token('tok1'), [GAMES_URL]: () => json(plain) })
    const rom = zeldaRom()
    const candidates = await newScraper().search(rom, settings())
    expect(candidates[0].externalId).toBe('134231')
    for (const year of [undefined, 2019])
      expect(pickCandidate(candidates, rom.title, year, { platformId: 130 })?.externalId).toBe(
        '113113'
      )
  })

  it('gives the titles of recorded ids as a search would, 500 ids a request', async () => {
    const calls = stubApi({
      [TOKEN_URL]: token('tok1'),
      [GAMES_URL]: (call) =>
        json(
          call.body.includes('134231')
            ? [
                ZELDA[0],
                ZELDA[2],
                { id: 99, name: 'Super Mario World Bundle', game_type: 3 },
                { id: 1071, name: 'Super Mario World', version_title: 'GBA version', game_type: 11 }
              ]
            : []
        )
    })
    const ids = ['134231', '113113', '99', '1071', 'x; drop', '134231']
    for (let i = 0; i < 500; i++) ids.push(String(900000 + i))
    const records = await newScraper().recordsOf!(ids, settings())
    expect(calls.slice(1).map((c) => c.body.match(/^fields ([^;]+);/)?.[1])).toEqual([
      'name,version_title',
      'name,version_title'
    ])
    expect(calls[1].body).toContain('where id = (134231,113113,99,1071,900000,')
    expect(calls[1].body).toMatch(/limit 500;$/)
    expect(calls[1].body).not.toContain('drop')
    expect(Object.fromEntries(records)).toEqual({
      '134231': { title: "The Legend of Zelda: Link's Awakening - Limited Edition" },
      '113113': { title: "The Legend of Zelda: Link's Awakening" },
      '99': { title: 'Super Mario World Bundle' },
      '1071': { title: 'Super Mario World (GBA version)' }
    })
  })
})

describe('apicalypseString', () => {
  it('removes quotes, backslashes and control characters', () => {
    expect(apicalypseString('Portal "2" \\ test\n')).toBe('Portal 2 test')
    expect(apicalypseString('  Half-Life:  Alyx ')).toBe('Half-Life: Alyx')
  })
})
