import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
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
  clearGogCaches,
  gamesDbImageUrl,
  gogDatePart,
  gogProductIdOf,
  gogScraper,
  mapGogProduct,
  type GamesDbRelease,
  type GogProduct,
  type GogV2Game
} from './gog-api'

// Trimmed from the live responses for The Witcher: Enhanced Edition (docs/research/metadata-apis.md §7).
const PRODUCT: GogProduct = {
  id: 1207658924,
  title: 'The Witcher: Enhanced Edition',
  slug: 'the_witcher',
  game_type: 'game',
  release_date: '2011-05-09T23:00:00+0200',
  images: {
    background:
      '//images-2.gog-statics.com/c73009d18e964448b9704ad9d69a7c68bab5f8a10df410254bb511f2f9198a3a.jpg',
    logo: '//images-1.gog-statics.com/37d4a208d1f5bb0e163da540ac894ba46a7d566ede31aaaefc74bbcd46ebd190_glx_logo.jpg',
    logo2x:
      '//images-2.gog-statics.com/37d4a208d1f5bb0e163da540ac894ba46a7d566ede31aaaefc74bbcd46ebd190_glx_logo_2x.jpg',
    sidebarIcon:
      '//images-3.gog-statics.com/82ecfe17e7c3fa7fe3252664927ba9b0014ca17039d8ec1b46275677ab7a7898_sbicon.png',
    icon: '//images-4.gog-statics.com/82ecfe17e7c3fa7fe3252664927ba9b0014ca17039d8ec1b46275677ab7a7898.png'
  },
  links: { product_card: 'https://www.gog.com/game/the_witcher' },
  description: {
    lead: '\n\n<p>\nThe Witcher is a role-playing game set in a dark fantasy world where moral ambiguity reigns. <br>\n<br>\nBecome The Witcher, Geralt of Rivia.',
    full: '\n\n<p>\nThe Witcher is a role-playing game set in a dark fantasy world where moral ambiguity reigns. <br>\n<br>\nBecome The Witcher, Geralt of Rivia. <br>\n<br>\n<video muted loop preload="auto" autoplay="autoplay"><source src="https://items.gog.com/the_witcher/W1_2-2e-gif-bd8f7.mp4" type="video/mp4"></video><br>\n<ul><li>Over 80 hours of gameplay</li></ul>',
    whats_cool_about_it: ''
  },
  screenshots: [
    {
      image_id: '84aa9ca13d2dbbaaf9208d54690b015ec15643c021ada3f3d66f080ab2430047',
      formatter_template_url:
        'https://images-2.gog-statics.com/84aa9ca13d2dbbaaf9208d54690b015ec15643c021ada3f3d66f080ab2430047_{formatter}.png',
      formatted_images: [
        {
          formatter_name: 'ggvgt',
          image_url:
            'https://images-3.gog-statics.com/84aa9ca13d2dbbaaf9208d54690b015ec15643c021ada3f3d66f080ab2430047_ggvgt.jpg'
        },
        {
          formatter_name: 'ggvgl_2x',
          image_url:
            'https://images-3.gog-statics.com/84aa9ca13d2dbbaaf9208d54690b015ec15643c021ada3f3d66f080ab2430047_ggvgl_2x.jpg'
        }
      ]
    },
    {
      image_id: 'second',
      formatter_template_url: 'https://images-2.gog-statics.com/second_{formatter}.png'
    }
  ]
}

const RELEASE: GamesDbRelease = {
  first_release_date: '2007-10-26T00:00:00+0000',
  title: { '*': 'The Witcher: Enhanced Edition', 'en-US': 'The Witcher: Enhanced Edition' },
  summary: { '*': 'Based on the novels by a popular Polish writer Andrzej Sapkowski.' },
  game: {
    first_release_date: '2008-09-16T00:00:00+0000',
    developers: [{ name: 'CD PROJEKT RED' }],
    publishers: [{ name: 'Atari' }, { name: 'CD Projekt' }],
    genres: [{ name: { '*': 'Role-playing (RPG)', 'en-US': 'Role-playing (RPG)' } }],
    aggregated_rating: 85.5,
    vertical_cover: {
      url_format:
        'https://images.gog.com/7fbb815727527616881cb45a56f51a19e90ddf21ba00c9e22b4852d9bec6324a{formatter}.{ext}?namespace=gamesdb'
    },
    background: {
      url_format:
        'https://images.gog.com/fc1c44b2252e3200db66872630f7e21687bba217b6eabb188451556b5941cf63{formatter}.{ext}?namespace=gamesdb'
    },
    logo: {
      url_format:
        'https://images.gog.com/3a4d9190f3c0a0a8d63638193ef8c9af2ba58eb0b250295db2a28bccf852a76d{formatter}.{ext}?namespace=gamesdb'
    },
    square_icon: {
      url_format:
        'https://images.gog.com/1859d9ca7867f954e2629df725155f807810b7c27524b9382b42070b2727c066{formatter}.{ext}?namespace=gamesdb'
    },
    screenshots: [
      {
        url_format:
          'https://images.gog.com/68e29ee730b820f4afc951b2569b6ff83f883ea873cf953f98e8fee89846b4a5{formatter}.{ext}?namespace=gamesdb'
      }
    ]
  }
}

const V2: GogV2Game = {
  _links: {
    boxArtImage: {
      href: 'https://images.gog-statics.com/32385c2c39b8715a9ccfb159ed481b55503b96526b00866f75a4af48461615a5.jpg'
    },
    backgroundImage: {
      href: 'https://images.gog-statics.com/c73009d18e964448b9704ad9d69a7c68bab5f8a10df410254bb511f2f9198a3a.jpg'
    },
    logo: {
      href: 'https://images.gog-statics.com/def9381ff2a8047fc343f023e3f976a65818f81381e616ac04094595cb1893a0.png'
    },
    icon: {
      href: 'https://images.gog-statics.com/82ecfe17e7c3fa7fe3252664927ba9b0014ca17039d8ec1b46275677ab7a7898.png'
    }
  }
}

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 'gog:1207658924',
    source: 'gog',
    externalId: '1207658924',
    platformId: 'gog',
    title: 'The Witcher: Enhanced Edition',
    sortTitle: 'witcher enhanced edition',
    installed: true,
    launch: { kind: 'exec', file: 'C:\\Games\\witcher.exe', args: [] },
    tracking: { mode: 'spawned' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-10-29T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {},
    extra: { gogProductId: '1207658924' },
    ...overrides
  }
}

function stubFetch(routes: Record<string, { status: number; body?: unknown }>): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input)
      urls.push(url)
      const key = Object.keys(routes).find((k) => url.startsWith(k))
      if (!key) return new Response('{"error":"not_found"}', { status: 404 })
      return new Response(JSON.stringify(routes[key].body ?? null), {
        status: routes[key].status,
        headers: { 'content-type': 'application/json' }
      })
    })
  )
  return urls
}

const PRODUCTS_URL = 'https://api.gog.com/products/1207658924?expand=description,screenshots'
const GAMESDB_URL = 'https://gamesdb.gog.com/platforms/gog/external_releases/1207658924'
const V2_URL = 'https://api.gog.com/v2/games/1207658924?locale=en-US'

beforeEach(() => {
  clearGogCaches()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('helpers', () => {
  it('finds the product id and formats dates and image templates', () => {
    expect(gogProductIdOf(game())).toBe('1207658924')
    expect(gogProductIdOf(game({ extra: undefined }))).toBe('1207658924')
    expect(gogProductIdOf(game({ extra: { gogProductId: 1454587428 } }))).toBe('1454587428')
    expect(
      gogProductIdOf(game({ source: 'steam', externalId: '620', extra: undefined }))
    ).toBeNull()
    expect(
      gogProductIdOf(game({ source: 'gog', externalId: 'not-a-number', extra: undefined }))
    ).toBeNull()
    expect(gogDatePart('2011-05-09T23:00:00+0200')).toBe('2011-05-09')
    expect(gogDatePart('2007-10-26T00:00:00+02:00')).toBe('2007-10-26')
    expect(gogDatePart('2014.11.27')).toBe('2014-11-27')
    expect(gogDatePart(null)).toBeUndefined()
    expect(gogDatePart('soon')).toBeUndefined()
    expect(gamesDbImageUrl(RELEASE.game!.logo, '_glx_logo_2x', 'png')).toBe(
      'https://images.gog.com/3a4d9190f3c0a0a8d63638193ef8c9af2ba58eb0b250295db2a28bccf852a76d_glx_logo_2x.png?namespace=gamesdb'
    )
    expect(gamesDbImageUrl({ url_format: 'https://x/y.jpg' }, '', 'jpg')).toBeUndefined()
    expect(gamesDbImageUrl(undefined, '', 'jpg')).toBeUndefined()
  })
})

describe('mapGogProduct', () => {
  it('combines the product record with the gamesdb release', () => {
    const result = mapGogProduct(PRODUCT, RELEASE, null)
    expect(result.title).toBe('The Witcher: Enhanced Edition')
    // Two <br>s in a row are a paragraph break, as in the Steam store text.
    expect(result.metadata.description).toBe(
      'The Witcher is a role-playing game set in a dark fantasy world where moral ambiguity reigns.\n\nBecome The Witcher, Geralt of Rivia.\n\n\u2022 Over 80 hours of gameplay'
    )
    expect(result.metadata.shortDescription).toBe(
      'The Witcher is a role-playing game set in a dark fantasy world where moral ambiguity reigns.\n\nBecome The Witcher, Geralt of Rivia.'
    )
    expect(result.metadata.releaseDate).toBe('2007-10-26')
    expect(result.metadata.developers).toEqual(['CD PROJEKT RED'])
    expect(result.metadata.publishers).toEqual(['Atari', 'CD Projekt'])
    expect(result.metadata.genres).toEqual(['Role-playing (RPG)'])
    expect(result.metadata.rating).toBe(85.5)
    expect(result.metadata.links).toEqual({ store: 'https://www.gog.com/game/the_witcher' })
    expect(result.metadata.sources).toEqual({ gog: '1207658924' })
    expect(result.media).toEqual({
      cover:
        'https://images.gog.com/7fbb815727527616881cb45a56f51a19e90ddf21ba00c9e22b4852d9bec6324a.jpg?namespace=gamesdb',
      hero: 'https://images.gog.com/fc1c44b2252e3200db66872630f7e21687bba217b6eabb188451556b5941cf63_1600.jpg?namespace=gamesdb',
      logo: 'https://images.gog.com/3a4d9190f3c0a0a8d63638193ef8c9af2ba58eb0b250295db2a28bccf852a76d_glx_logo_2x.png?namespace=gamesdb',
      icon: 'https://images.gog.com/1859d9ca7867f954e2629df725155f807810b7c27524b9382b42070b2727c066_glx_square_icon_v2.png?namespace=gamesdb',
      screenshots: [
        'https://images.gog.com/68e29ee730b820f4afc951b2569b6ff83f883ea873cf953f98e8fee89846b4a5_1600.jpg?namespace=gamesdb'
      ]
    })
  })

  it('falls back to the product images and the v2 box art without gamesdb', () => {
    const plain = mapGogProduct(PRODUCT, null, null)
    expect(plain.metadata.releaseDate).toBe('2011-05-09')
    expect(plain.metadata.developers).toEqual([])
    expect(plain.metadata.rating).toBeUndefined()
    expect(plain.media.cover).toBeUndefined()
    expect(plain.media.hero).toBe(
      'https://images-2.gog-statics.com/c73009d18e964448b9704ad9d69a7c68bab5f8a10df410254bb511f2f9198a3a.jpg'
    )
    expect(plain.media.logo).toBe(
      'https://images-2.gog-statics.com/37d4a208d1f5bb0e163da540ac894ba46a7d566ede31aaaefc74bbcd46ebd190_glx_logo_2x.jpg'
    )
    expect(plain.media.icon).toBe(
      'https://images-4.gog-statics.com/82ecfe17e7c3fa7fe3252664927ba9b0014ca17039d8ec1b46275677ab7a7898.png'
    )
    expect(plain.media.screenshots).toEqual([
      'https://images-3.gog-statics.com/84aa9ca13d2dbbaaf9208d54690b015ec15643c021ada3f3d66f080ab2430047_ggvgl_2x.jpg',
      'https://images-2.gog-statics.com/second_ggvgl_2x.png'
    ])

    const withV2 = mapGogProduct(PRODUCT, null, V2)
    expect(withV2.media.cover).toBe(
      'https://images.gog-statics.com/32385c2c39b8715a9ccfb159ed481b55503b96526b00866f75a4af48461615a5.jpg'
    )
    expect(withV2.media.logo).toBe(
      'https://images.gog-statics.com/def9381ff2a8047fc343f023e3f976a65818f81381e616ac04094595cb1893a0.png'
    )

    const bare = mapGogProduct({ id: 1, title: 'Bare', release_date: null }, null, null)
    expect(bare.metadata.description).toBeUndefined()
    expect(bare.metadata.links).toEqual({ store: undefined })
    expect(bare.media.screenshots).toEqual([])
  })
})

describe('gogScraper', () => {
  it('resolves installed GOG games by product id and caches the responses', async () => {
    const urls = stubFetch({
      [PRODUCTS_URL]: { status: 200, body: PRODUCT },
      [GAMESDB_URL]: { status: 200, body: RELEASE }
    })
    const candidates = await gogScraper.search(game(), {} as never)
    expect(candidates).toEqual([
      {
        scraper: 'gog',
        byId: true,
        externalId: '1207658924',
        title: 'The Witcher: Enhanced Edition',
        releaseDate: '2007-10-26',
        platform: 'PC',
        cover:
          'https://images.gog.com/7fbb815727527616881cb45a56f51a19e90ddf21ba00c9e22b4852d9bec6324a_glx_vertical_cover.jpg?namespace=gamesdb'
      }
    ])
    const result = await gogScraper.fetch(game(), candidates[0], {} as never)
    expect(result.metadata.developers).toEqual(['CD PROJEKT RED'])
    expect(result.media.cover).toMatch(/7fbb8157.*\.jpg\?namespace=gamesdb$/)
    expect(urls).toEqual([PRODUCTS_URL, GAMESDB_URL])
    expect(
      await gogScraper.search(
        game({ source: 'epic', externalId: 'x', extra: undefined }),
        {} as never
      )
    ).toEqual([])
  })

  it('uses the v2 record for box art when gamesdb is unavailable', async () => {
    const urls = stubFetch({
      [PRODUCTS_URL]: { status: 200, body: PRODUCT },
      [V2_URL]: { status: 200, body: V2 }
    })
    const result = await gogScraper.fetch(
      game(),
      { scraper: 'gog', externalId: '1207658924', title: 'x' },
      {} as never
    )
    expect(result.media.cover).toBe(
      'https://images.gog-statics.com/32385c2c39b8715a9ccfb159ed481b55503b96526b00866f75a4af48461615a5.jpg'
    )
    expect(result.metadata.releaseDate).toBe('2011-05-09')
    expect(urls).toEqual([PRODUCTS_URL, GAMESDB_URL, V2_URL])
  })

  it('remembers a gamesdb 404 for a day but not a transient failure', async () => {
    const candidate = { scraper: 'gog' as const, externalId: '1207658924', title: 'x' }
    let gamesdbCalls = 0
    const headers = { 'content-type': 'application/json' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input)
        if (url.startsWith(PRODUCTS_URL))
          return new Response(JSON.stringify(PRODUCT), { status: 200, headers })
        if (url.startsWith(GAMESDB_URL)) {
          gamesdbCalls++
          // Down for the first scrape (initial attempt plus its one retry), back for the next one.
          return gamesdbCalls <= 2
            ? new Response('Service Unavailable', { status: 503 })
            : new Response(JSON.stringify(RELEASE), { status: 200, headers })
        }
        return new Response('{"error":"not_found"}', { status: 404 })
      })
    )
    const first = await gogScraper.fetch(game(), candidate, {} as never)
    expect(first.metadata.developers).toEqual([])
    expect(first.media.cover).toBeUndefined()
    expect(gamesdbCalls).toBe(2)
    // The outage must not be cached as "no data": the next scrape (or a forced refresh) asks gamesdb again.
    const second = await gogScraper.fetch(game(), candidate, {} as never)
    expect(second.metadata.developers).toEqual(['CD PROJEKT RED'])
    expect(second.media.cover).toMatch(/namespace=gamesdb$/)
    expect(gamesdbCalls).toBe(3)

    // A genuine 404 is remembered: the second fetch does not ask gamesdb again.
    clearGogCaches()
    const urls = stubFetch({
      [PRODUCTS_URL]: { status: 200, body: PRODUCT },
      [V2_URL]: { status: 200, body: V2 }
    })
    await gogScraper.fetch(game(), candidate, {} as never)
    await gogScraper.fetch(game(), candidate, {} as never)
    expect(urls.filter((u) => u.startsWith(GAMESDB_URL))).toHaveLength(1)
  })

  it('reports unknown products and rejects bad ids', async () => {
    stubFetch({})
    expect(await gogScraper.search(game(), {} as never)).toEqual([])
    await expect(
      gogScraper.fetch(
        game(),
        { scraper: 'gog', externalId: '1207658924', title: 'x' },
        {} as never
      )
    ).rejects.toThrow(/no product 1207658924/)
    await expect(
      gogScraper.fetch(game(), { scraper: 'gog', externalId: 'abc', title: 'x' }, {} as never)
    ).rejects.toThrow(/Invalid GOG product id/)
  })

  it('searches the public catalog for free-text queries', async () => {
    const urls = stubFetch({
      'https://catalog.gog.com/v1/catalog?limit=8&query=like:witcher': {
        status: 200,
        body: {
          products: [
            {
              id: '1207666883',
              title: 'The Witcher Adventure Game',
              releaseDate: '2014.11.27',
              coverVertical: 'https://images.gog-statics.com/28a3e31f.jpg',
              productType: 'game'
            },
            {
              id: '1207658924',
              title: 'The Witcher: Enhanced Edition',
              releaseDate: '2008.09.16',
              coverVertical: 'https://images.gog-statics.com/cover.jpg',
              productType: 'game'
            },
            { id: 'bogus', title: 'skipped' }
          ]
        }
      }
    })
    const candidates = await gogScraper.search(
      game({ source: 'manual', externalId: 'C:\\x.exe', extra: undefined }),
      {} as never,
      'witcher'
    )
    expect(candidates).toEqual([
      {
        scraper: 'gog',
        externalId: '1207666883',
        title: 'The Witcher Adventure Game',
        releaseDate: '2014-11-27',
        platform: 'PC',
        cover: 'https://images.gog-statics.com/28a3e31f.jpg'
      },
      {
        scraper: 'gog',
        externalId: '1207658924',
        title: 'The Witcher: Enhanced Edition',
        releaseDate: '2008-09-16',
        platform: 'PC',
        cover: 'https://images.gog-statics.com/cover.jpg'
      }
    ])
    expect(urls[0]).toBe(
      'https://catalog.gog.com/v1/catalog?limit=8&query=like:witcher&order=desc:score&productType=in:game'
    )
  })
})
