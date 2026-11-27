import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
// Rate limiting is covered by http.test.ts; here it would only slow the suite down.
vi.mock('./http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http')>()
  return {
    ...actual,
    RateLimiter: class {
      take(): Promise<void> {
        return Promise.resolve()
      }
    }
  }
})

import type { Game } from '../../shared/types'
import {
  clearSteamCaches,
  decodeHtmlEntities,
  htmlToText,
  mapSteamAppDetails,
  parseSteamReleaseDate,
  redactSecrets,
  steamAchievements,
  steamAppIdOf,
  steamCurrentPlayers,
  steamScreenshotsOf,
  steamStoreScraper,
  type SteamAppDetails
} from './steam-store'

// Trimmed from the live appdetails response for app 620 (docs/research/metadata-apis.md §5.1).
const PORTAL_2: SteamAppDetails = {
  type: 'game',
  name: 'Portal 2',
  steam_appid: 620,
  required_age: 0,
  is_free: false,
  short_description:
    'The &quot;Perpetual Testing Initiative&quot; has been expanded to allow you to design co-op puzzles for you and your friends!',
  about_the_game:
    'Portal 2 draws from the award-winning formula of innovative gameplay, story, and music that earned the original Portal over 70 industry accolades and created a cult following.<br><br>\t\t\t\t\t\t\t\t\t\tThe single-player portion of Portal 2 introduces a cast of dynamic new characters, a host of fresh puzzle elements, and a much larger set of devious test chambers.<br>\t\t\t\t\t\t\t\t\t\t<br>\t\t\t\t\t\t\t\t\t\tThe game’s two-player cooperative mode features its own entirely separate campaign.<h2 class="bb_tag">Key Features</h2><ul class="bb_ul"><li>Extensive single player<br></li><li>Complete two-person co-op</li></ul>',
  detailed_description: '<strong>Fallback</strong> text',
  header_image:
    'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/faffc0f560786e2f05104a8d2fac837c6969bf13/header.jpg?t=1790187113',
  website: 'http://www.thinkwithportals.com/',
  developers: ['Valve'],
  publishers: ['Valve'],
  metacritic: { score: 95, url: 'https://www.metacritic.com/game/pc/portal-2?ftag=MCD-06-10aaa1f' },
  categories: [
    { id: 2, description: 'Single-player' },
    { id: 1, description: 'Multi-player' },
    { id: 9, description: 'Co-op' },
    { id: 22, description: 'Steam Achievements' },
    { id: 51, description: 'Steam Workshop' },
    { id: 30, description: 'Steam Workshop' }
  ],
  genres: [
    { id: '1', description: 'Action' },
    { id: '25', description: 'Adventure' }
  ],
  screenshots: [
    {
      id: 0,
      path_thumbnail:
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/ss_f3f6787d74739d3b2ec8a484b5c994b3d31ef325.600x338.jpg?t=1790187113',
      path_full:
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/ss_f3f6787d74739d3b2ec8a484b5c994b3d31ef325.1920x1080.jpg?t=1790187113'
    },
    {
      id: 1,
      path_thumbnail:
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/ss_6a4f5afdaa98402de9cf0b59fed27bab3256a6f4.600x338.jpg?t=1790187113',
      path_full:
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620/ss_6a4f5afdaa98402de9cf0b59fed27bab3256a6f4.1920x1080.jpg?t=1790187113'
    }
  ],
  movies: [
    {
      id: 5787,
      name: 'Portal 2 E3 Demo (Excursion Funnels)',
      mp4: {
        '480': 'https://video.akamai.steamstatic.com/store_trailers/620/movie480.mp4',
        max: 'https://video.akamai.steamstatic.com/store_trailers/620/movie_max.mp4'
      },
      webm: {
        '480': 'https://video.akamai.steamstatic.com/store_trailers/620/movie480.webm',
        max: 'https://video.akamai.steamstatic.com/store_trailers/620/movie_max.webm'
      }
    }
  ],
  achievements: { total: 51 },
  release_date: { coming_soon: false, date: 'Apr 18, 2011' },
  background: 'https://store.akamai.steamstatic.com/images/storepagebackground/app/620?t=1790187113'
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
    tracking: { mode: 'installDir', installDir: 'C:\\Steam\\steamapps\\common\\Portal 2' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-10-29T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {},
    extra: { steamAppId: 620 },
    ...overrides
  }
}

interface Route {
  status: number
  body?: unknown
}

/** fetch stub keyed by URL prefix (+ method for HEAD checks); records every request. */
function stubFetch(routes: Record<string, Route | ((init: RequestInit) => Route)>): {
  calls: { url: string; method: string; headers: Headers }[]
} {
  const calls: { url: string; method: string; headers: Headers }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input)
      const method = (init.method ?? 'GET').toUpperCase()
      calls.push({ url, method, headers: new Headers(init.headers) })
      const key = Object.keys(routes).find((k) =>
        k.startsWith('HEAD ')
          ? method === 'HEAD' && url.startsWith(k.slice(5))
          : method !== 'HEAD' && url.startsWith(k)
      )
      if (!key) return new Response('not found', { status: 404 })
      const route = routes[key]
      const r = typeof route === 'function' ? route(init) : route
      return new Response(
        r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
        {
          status: r.status,
          headers: { 'content-type': 'application/json' }
        }
      )
    })
  )
  return { calls }
}

const APPDETAILS = 'https://store.steampowered.com/api/appdetails?appids=620'
const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps/620/'

beforeEach(() => {
  clearSteamCaches()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('text helpers', () => {
  it('decodes entities and flattens store HTML into paragraphs', () => {
    expect(decodeHtmlEntities('&quot;a&quot; &amp; &#39;b&#39; &#x41; &eacute; &unknown;')).toBe(
      '"a" & \'b\' A é &unknown;'
    )
    const text = htmlToText(PORTAL_2.about_the_game)!
    expect(text).not.toMatch(/<[^>]+>/)
    expect(text).not.toContain('\t')
    expect(text.startsWith('Portal 2 draws from the award-winning formula')).toBe(true)
    expect(text).toContain('\n\nThe single-player portion of Portal 2')
    expect(text).toContain('Key Features\n')
    expect(text).toContain('\u2022 Extensive single player')
    expect(text).toContain('\u2022 Complete two-person co-op')
    expect(text).not.toMatch(/\n{3,}/)
    expect(htmlToText('')).toBeUndefined()
    expect(htmlToText('<p>&nbsp;</p>')).toBeUndefined()
  })

  it('masks credentials in URLs and messages', () => {
    expect(redactSecrets('https://api.steampowered.com/x/?key=ABC123&steamid=7656&appid=620')).toBe(
      'https://api.steampowered.com/x/?key=***&steamid=***&appid=620'
    )
    expect(redactSecrets('Authorization: Bearer abc.def-ghi failed')).toBe(
      'Authorization: Bearer *** failed'
    )
    expect(redactSecrets('devpassword=pw&ssid=me&sspassword=secret')).toBe(
      'devpassword=***&ssid=***&sspassword=***'
    )
    expect(redactSecrets('monkey=1 donkey=2')).toBe('monkey=1 donkey=2')
  })

  it('parses the release date strings Steam uses', () => {
    expect(parseSteamReleaseDate('Apr 18, 2011')).toBe('2011-04-18')
    expect(parseSteamReleaseDate('Dec 9, 2020')).toBe('2020-12-09')
    expect(parseSteamReleaseDate('18 Apr, 2011')).toBe('2011-04-18')
    expect(parseSteamReleaseDate('September 3, 2019')).toBe('2019-09-03')
    expect(parseSteamReleaseDate('Apr 2011')).toBe('2011-04')
    expect(parseSteamReleaseDate('2011')).toBe('2011')
    expect(parseSteamReleaseDate('Q4 2026')).toBe('2026')
    expect(parseSteamReleaseDate('Coming soon')).toBeUndefined()
    expect(parseSteamReleaseDate('')).toBeUndefined()
    expect(parseSteamReleaseDate(undefined)).toBeUndefined()
  })

  it('finds the Steam app id of a game', () => {
    expect(steamAppIdOf(game())).toBe(620)
    expect(steamAppIdOf(game({ extra: { steamAppId: '440' } }))).toBe(440)
    expect(steamAppIdOf(game({ extra: undefined }))).toBe(620)
    expect(steamAppIdOf(game({ source: 'epic', externalId: 'abc', extra: undefined }))).toBeNull()
    expect(
      steamAppIdOf(game({ source: 'epic', externalId: 'abc', extra: { steamAppId: 1091500 } }))
    ).toBe(1091500)
    expect(
      steamAppIdOf(game({ extra: { steamAppId: 'nope' }, source: 'manual', externalId: 'x' }))
    ).toBeNull()
  })
})

describe('mapSteamAppDetails', () => {
  it('maps the appdetails block to metadata and CDN art', () => {
    const result = mapSteamAppDetails(620, PORTAL_2)
    expect(result.title).toBe('Portal 2')
    expect(result.metadata.shortDescription).toBe(
      'The "Perpetual Testing Initiative" has been expanded to allow you to design co-op puzzles for you and your friends!'
    )
    expect(result.metadata.description!.startsWith('Portal 2 draws from')).toBe(true)
    expect(result.metadata.releaseDate).toBe('2011-04-18')
    expect(result.metadata.developers).toEqual(['Valve'])
    expect(result.metadata.publishers).toEqual(['Valve'])
    expect(result.metadata.genres).toEqual(['Action', 'Adventure'])
    expect(result.metadata.tags).toEqual([
      'Single-player',
      'Multi-player',
      'Co-op',
      'Steam Achievements',
      'Steam Workshop'
    ])
    expect(result.metadata.rating).toBe(95)
    expect(result.metadata.links).toEqual({
      store: 'https://store.steampowered.com/app/620',
      website: 'http://www.thinkwithportals.com/'
    })
    expect(result.metadata.sources).toEqual({ steam: '620' })
    expect(result.media.cover).toBe(`${CDN}library_600x900_2x.jpg`)
    expect(result.media.hero).toBe(`${CDN}library_hero.jpg`)
    expect(result.media.logo).toBe(`${CDN}logo.png`)
    expect(result.media.screenshots).toHaveLength(2)
    expect(result.media.screenshots![0]).toMatch(/1920x1080\.jpg/)
    expect(result.media.video).toBe(
      'https://video.akamai.steamstatic.com/store_trailers/620/movie_max.mp4'
    )
  })

  it('falls back to detailed_description and tolerates missing blocks', () => {
    const result = mapSteamAppDetails(1, {
      name: 'Bare',
      about_the_game: '',
      detailed_description: '<strong>Fallback</strong> text',
      metacritic: {}
    })
    expect(result.metadata.description).toBe('Fallback text')
    expect(result.metadata.rating).toBeUndefined()
    expect(result.metadata.releaseDate).toBeUndefined()
    expect(result.metadata.developers).toEqual([])
    expect(result.metadata.links).toEqual({ store: 'https://store.steampowered.com/app/1' })
    expect(result.media.screenshots).toEqual([])
    expect(result.media.video).toBeUndefined()
  })
})

describe('steamStoreScraper', () => {
  it('returns one candidate for Steam games and nothing otherwise', async () => {
    const stub = stubFetch({
      [APPDETAILS]: { status: 200, body: { '620': { success: true, data: PORTAL_2 } } }
    })
    const candidates = await steamStoreScraper.search(game(), {} as never)
    expect(candidates).toEqual([
      {
        scraper: 'steam',
        byId: true,
        externalId: '620',
        title: 'Portal 2',
        releaseDate: '2011-04-18',
        platform: 'PC',
        cover: `${CDN}library_600x900.jpg`
      }
    ])
    expect(
      await steamStoreScraper.search(
        game({ source: 'epic', externalId: 'x', extra: undefined }),
        {} as never
      )
    ).toEqual([])
    // Query-based search is impossible without a key; the app id stays authoritative.
    expect(await steamStoreScraper.search(game(), {} as never, 'something else')).toHaveLength(1)
    expect(stub.calls.filter((c) => c.url.startsWith(APPDETAILS))).toHaveLength(1)
  })

  it('returns no candidate when Steam has no store page', async () => {
    stubFetch({ [APPDETAILS]: { status: 200, body: { '620': { success: false } } } })
    expect(await steamStoreScraper.search(game(), {} as never)).toEqual([])
    await expect(
      steamStoreScraper.fetch(
        game(),
        { scraper: 'steam', externalId: '620', title: 'Portal 2' },
        {} as never
      )
    ).rejects.toThrow(/no store page/)
  })

  it('verifies the CDN art with HEAD requests and falls back to the smaller files', async () => {
    const stub = stubFetch({
      [APPDETAILS]: { status: 200, body: { '620': { success: true, data: PORTAL_2 } } },
      [`HEAD ${CDN}library_600x900_2x.jpg`]: { status: 404 },
      [`HEAD ${CDN}library_600x900.jpg`]: { status: 200 },
      [`HEAD ${CDN}library_hero.jpg`]: { status: 404 },
      [`HEAD ${CDN}header.jpg`]: { status: 200 },
      [`HEAD ${CDN}logo.png`]: { status: 404 }
    })
    const result = await steamStoreScraper.fetch(
      game(),
      { scraper: 'steam', externalId: '620', title: 'Portal 2' },
      {} as never
    )
    expect(result.media.cover).toBe(`${CDN}library_600x900.jpg`)
    expect(result.media.hero).toBe(`${CDN}header.jpg`)
    expect(result.media.logo).toBeUndefined()
    expect(result.metadata.description).toContain('Portal 2 draws')
    const heads = stub.calls.filter((c) => c.method === 'HEAD').map((c) => c.url.slice(CDN.length))
    expect(heads.sort()).toEqual([
      'header.jpg',
      'library_600x900.jpg',
      'library_600x900_2x.jpg',
      'library_hero.jpg',
      'logo.png'
    ])
  })

  it('keeps the full-size art when the CDN serves it and caches appdetails', async () => {
    const stub = stubFetch({
      [APPDETAILS]: { status: 200, body: { '620': { success: true, data: PORTAL_2 } } },
      [`HEAD ${CDN}`]: { status: 200 }
    })
    await steamStoreScraper.search(game(), {} as never)
    const result = await steamStoreScraper.fetch(
      game(),
      { scraper: 'steam', externalId: '620', title: 'Portal 2' },
      {} as never
    )
    expect(result.media.cover).toBe(`${CDN}library_600x900_2x.jpg`)
    expect(result.media.hero).toBe(`${CDN}library_hero.jpg`)
    expect(result.media.logo).toBe(`${CDN}logo.png`)
    expect(stub.calls.filter((c) => c.url.startsWith(APPDETAILS))).toHaveLength(1)
    expect(stub.calls.filter((c) => c.method === 'HEAD')).toHaveLength(3)
  })
})

describe('Steam Web API helpers', () => {
  it('reads the current player count and returns null for unknown apps', async () => {
    stubFetch({
      'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=620': {
        status: 200,
        body: { response: { player_count: 1796, result: 1 } }
      },
      'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=999999999':
        { status: 404, body: { response: { result: 42 } } }
    })
    expect(await steamCurrentPlayers(620)).toBe(1796)
    expect(await steamCurrentPlayers(999999999)).toBeNull()
    expect(await steamCurrentPlayers(0)).toBeNull()
  })

  it('merges the achievement schema with the player progress', async () => {
    const stub = stubFetch({
      'https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/': {
        status: 200,
        body: {
          game: {
            gameName: 'Portal 2',
            availableGameStats: {
              achievements: [
                {
                  name: 'ACH.SURVIVE_CONTAINER_RIDE',
                  defaultvalue: 0,
                  displayName: 'Wake Up Call',
                  hidden: 0,
                  description: 'Survive the manual override',
                  icon: 'https://cdn/a.jpg',
                  icongray: 'https://cdn/a_gray.jpg'
                },
                {
                  name: 'ACH.LASER',
                  defaultvalue: 0,
                  displayName: 'Undiscouraged',
                  hidden: 1,
                  icon: 'https://cdn/b.jpg',
                  icongray: 'https://cdn/b_gray.jpg'
                }
              ]
            }
          }
        }
      },
      'https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/': {
        status: 200,
        body: {
          playerstats: {
            steamID: '76561198000000101',
            gameName: 'Portal 2',
            achievements: [
              {
                apiname: 'ACH.SURVIVE_CONTAINER_RIDE',
                achieved: 1,
                unlocktime: 1303084800,
                name: 'Wake Up Call'
              },
              { apiname: 'ACH.LASER', achieved: 0, unlocktime: 0, name: 'Undiscouraged' }
            ],
            success: true
          }
        }
      }
    })
    const info = await steamAchievements(620, 'KEY123', '76561198000000101')
    expect(info).toEqual({
      total: 2,
      unlocked: 1,
      list: [
        {
          id: 'ACH.SURVIVE_CONTAINER_RIDE',
          name: 'Wake Up Call',
          description: 'Survive the manual override',
          unlocked: true,
          unlockedAt: '2011-04-18T00:00:00.000Z',
          icon: 'https://cdn/a.jpg',
          hidden: false
        },
        {
          id: 'ACH.LASER',
          name: 'Undiscouraged',
          description: undefined,
          unlocked: false,
          unlockedAt: undefined,
          icon: 'https://cdn/b_gray.jpg',
          hidden: true
        }
      ]
    })
    expect(stub.calls.map((c) => c.url)).toEqual([
      'https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=KEY123&appid=620&l=english',
      'https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=KEY123&steamid=76561198000000101&appid=620&l=english'
    ])
  })

  it('returns null without keys, without achievements, or for a private profile', async () => {
    expect(await steamAchievements(620, '', '7656')).toBeNull()
    expect(await steamAchievements(620, 'k', '  ')).toBeNull()
    const stub = stubFetch({
      'https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/': {
        status: 200,
        body: { game: { gameName: 'No stats' } }
      }
    })
    expect(await steamAchievements(620, 'k', '7656')).toBeNull()
    expect(stub.calls).toHaveLength(1)

    stubFetch({
      'https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/': {
        status: 200,
        body: { game: { availableGameStats: { achievements: [{ name: 'A', displayName: 'A' }] } } }
      },
      'https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/': {
        status: 403,
        body: { playerstats: { error: 'Profile is not public', success: false } }
      }
    })
    expect(await steamAchievements(620, 'k', '7656')).toBeNull()
  })
})

describe('steamScreenshotsOf', () => {
  it('lists every store screenshot in order, the thumbnail and the full size', () => {
    expect(
      steamScreenshotsOf({
        screenshots: [
          {
            id: 0,
            path_thumbnail: 'https://cdn/a.600x338.jpg',
            path_full: 'https://cdn/a.1920x1080.jpg'
          },
          { id: 1, path_full: 'https://cdn/b.1920x1080.jpg' },
          { id: 2, path_thumbnail: 'https://cdn/c.600x338.jpg' },
          { id: 3 }
        ]
      })
    ).toEqual([
      { thumbnail: 'https://cdn/a.600x338.jpg', full: 'https://cdn/a.1920x1080.jpg' },
      { thumbnail: 'https://cdn/b.1920x1080.jpg', full: 'https://cdn/b.1920x1080.jpg' },
      { thumbnail: 'https://cdn/c.600x338.jpg', full: 'https://cdn/c.600x338.jpg' }
    ])
    expect(steamScreenshotsOf({})).toEqual([])
  })
})
