import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeGame, stubFetch, testLog, testSettings } from '../test-helpers'
import { RateLimiter } from '../http'
import { createXboxCatalogSource, xboxCandidates } from './xbox-catalog'

const BASE = 'https://catalog.test/v7.0'

afterEach(() => {
  vi.unstubAllGlobals()
})

const PRODUCT = {
  ProductId: '9NBLGGH4R315',
  LocalizedProperties: [
    {
      Images: [
        {
          ImagePurpose: 'Poster',
          Uri: '//store-images.s-microsoft.com/poster.jpg',
          Width: 1080,
          Height: 1620
        },
        { ImagePurpose: 'SuperHeroArt', Uri: 'https://store-images.s-microsoft.com/hero.jpg' },
        {
          ImagePurpose: 'Logo',
          Uri: 'https://store-images.s-microsoft.com/logo.png',
          Width: 300,
          Height: 300
        },
        { ImagePurpose: 'Tile', Uri: 'https://store-images.s-microsoft.com/tile.png' }
      ]
    }
  ]
}

describe('xboxCandidates', () => {
  it('picks the poster at 600x900 and the hero / logo / tile', () => {
    const art = xboxCandidates(PRODUCT, ['cover', 'hero', 'logo', 'icon'])
    expect(art.cover?.[0]).toMatchObject({
      url: 'https://store-images.s-microsoft.com/poster.jpg?w=600&h=900&mode=scale&q=90',
      width: 600,
      height: 900,
      source: 'xbox-catalog'
    })
    expect(art.hero?.[0].url).toContain('hero.jpg?w=1920')
    expect(art.logo?.[0]).toMatchObject({
      url: 'https://store-images.s-microsoft.com/logo.png',
      width: 300
    })
    expect(art.icon?.[0].url).toContain('tile.png?w=256')
  })
})

describe('xbox-catalog source', () => {
  it('asks the display catalog once per batch and maps products back to games', async () => {
    const calls = stubFetch({ [`${BASE}/products`]: { Products: [PRODUCT] } })
    const s = createXboxCatalogSource({
      baseUrl: BASE,
      limiter: new RateLimiter(1000, 1000),
      log: testLog
    })
    expect(s.batchSize).toBe(20)
    const found = await s.candidates(
      [
        { game: fakeGame('xbox', 'a'), ids: { xboxStoreId: '9nblggh4r315' } },
        { game: fakeGame('xbox', 'b'), ids: { xboxStoreId: '9PGZ8XXXXXXX' } },
        { game: fakeGame('xbox', 'c'), ids: { xboxTitleId: '123' } },
        { game: fakeGame('xbox', 'd'), ids: { xboxStoreId: 'bad id!' } }
      ],
      ['cover'],
      testSettings()
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('bigIds=9NBLGGH4R315,9PGZ8XXXXXXX&market=US&languages=en-US')
    expect([...found.keys()]).toEqual(['xbox:a'])
    expect(found.get('xbox:a')?.cover?.[0].width).toBe(600)
  })

  it('makes no request without store ids and survives an error response', async () => {
    const calls = stubFetch({ [`${BASE}/products`]: () => new Response('nope', { status: 400 }) })
    const s = createXboxCatalogSource({
      baseUrl: BASE,
      limiter: new RateLimiter(1000, 1000),
      log: testLog
    })
    expect(
      await s.candidates(
        [{ game: fakeGame('steam', '1'), ids: { steamAppId: 1 } }],
        ['cover'],
        testSettings()
      )
    ).toEqual(new Map())
    expect(calls).toHaveLength(0)
    expect(
      await s.candidates(
        [{ game: fakeGame('xbox', 'a'), ids: { xboxStoreId: '9NBLGGH4R315' } }],
        ['cover'],
        testSettings()
      )
    ).toEqual(new Map())
  })
})
