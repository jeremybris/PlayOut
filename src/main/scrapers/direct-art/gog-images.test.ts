import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeGame, stubFetch, testLog, testSettings } from '../test-helpers'
import { RateLimiter } from '../http'
import type { DirectArtSource } from '../types'
import { createGogImagesSource, gamesDbKeysOf, gogFormattedUrl } from './gog-images'

const GAMESDB = 'https://gamesdb.test'
const GOGAPI = 'https://api.test'
const HASH = 'https://images.gog.com/abc123def'

afterEach(() => {
  vi.unstubAllGlobals()
})

function source(): DirectArtSource {
  return createGogImagesSource({
    gamesDbBaseUrl: GAMESDB,
    gogApiBaseUrl: GOGAPI,
    limiter: new RateLimiter(1000, 1000),
    log: testLog
  })
}

describe('gogFormattedUrl / gamesDbKeysOf', () => {
  it('applies a formatter to a stored hash and to a url_format template', () => {
    expect(gogFormattedUrl('//images-4.gog-statics.com/abc', 'glx_vertical_cover', 'jpg')).toBe(
      'https://images-4.gog-statics.com/abc_glx_vertical_cover.jpg'
    )
    expect(gogFormattedUrl(`${HASH}_{formatter}.{ext}`, '1600', 'jpg')).toBe(`${HASH}_1600.jpg`)
    // The form gamesdb really answers with: the formatter supplies the underscore.
    expect(gogFormattedUrl(`${HASH}{formatter}.{ext}?namespace=gamesdb`, '1600', 'jpg')).toBe(
      `${HASH}_1600.jpg?namespace=gamesdb`
    )
    expect(gogFormattedUrl('not a url', 'x', 'jpg')).toBeUndefined()
  })

  it('orders the gamesdb keys gog, origin, uplay and includes steam only on request', () => {
    const ids = { gogProductId: '1', eaOfferId: 'OFB', ubisoftId: '77', steamAppId: 620 }
    expect(gamesDbKeysOf(ids).map((k) => k.platform)).toEqual(['gog', 'origin', 'uplay'])
    expect(gamesDbKeysOf(ids, true).map((k) => k.platform)).toEqual([
      'gog',
      'origin',
      'uplay',
      'steam'
    ])
  })
})

describe('gog-images source', () => {
  it('uses the stored image hash without any request', async () => {
    const calls = stubFetch({})
    const found = await source().candidates(
      [
        {
          game: fakeGame('gog', '1', {
            gogProductId: '1',
            gogImage: '//images-4.gog-statics.com/abc'
          }),
          ids: { gogProductId: '1' }
        }
      ],
      ['cover', 'hero', 'icon', 'logo'],
      testSettings()
    )
    const art = found.get('gog:1')!
    expect(art.cover?.[0]).toMatchObject({
      url: 'https://images-4.gog-statics.com/abc_glx_vertical_cover.jpg',
      width: 342,
      height: 482,
      source: 'gog-images'
    })
    expect(art.hero?.[0].url).toBe('https://images-4.gog-statics.com/abc_1600.jpg')
    expect(art.icon?.[0].url).toBe('https://images-4.gog-statics.com/abc_glx_square_icon_v2.jpg')
    expect(art.logo).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('resolves a GOG product through one gamesdb JSON and skips plain Steam ids', async () => {
    const calls = stubFetch({
      [`${GAMESDB}/platforms/gog/external_releases/1207658924`]: {
        game: {
          vertical_cover: { url_format: `${HASH}_{formatter}.{ext}` },
          background: { url_format: `${HASH}_{formatter}.{ext}` }
        }
      }
    })
    const found = await source().candidates(
      [
        { game: fakeGame('gog', '1207658924'), ids: { gogProductId: '1207658924' } },
        { game: fakeGame('steam', '620'), ids: { steamAppId: 620 } }
      ],
      ['cover', 'hero'],
      testSettings()
    )
    expect([...found.keys()]).toEqual(['gog:1207658924'])
    expect(found.get('gog:1207658924')?.cover?.[0].url).toBe(`${HASH}_glx_vertical_cover.jpg`)
    expect(found.get('gog:1207658924')?.hero?.[0].url).toBe(`${HASH}_1600.jpg`)
    expect(calls).toHaveLength(1)
  })

  it('resolves EA offers through the origin platform and falls back to boxArtImage for gog ids', async () => {
    const calls = stubFetch({
      [`${GAMESDB}/platforms/origin/external_releases/OFB-EAST1000011`]: {
        game: { vertical_cover: { url_format: `${HASH}_{formatter}.{ext}` } }
      },
      [`${GOGAPI}/v2/games/42`]: {
        _links: { boxArtImage: { href: 'https://images.gog.com/box.jpg' } }
      }
    })
    const found = await source().candidates(
      [
        { game: fakeGame('ea', 'OFB-EAST1000011'), ids: { eaOfferId: 'OFB-EAST1000011' } },
        { game: fakeGame('gog', '42'), ids: { gogProductId: '42' } }
      ],
      ['cover'],
      testSettings()
    )
    expect(found.get('ea:OFB-EAST1000011')?.cover?.[0].url).toBe(`${HASH}_glx_vertical_cover.jpg`)
    expect(found.get('gog:42')?.cover?.[0]).toMatchObject({
      url: 'https://images.gog.com/box.jpg',
      width: 171
    })
    // origin: 1 request; gog 42: gamesdb 404 + v2 = 2 requests
    expect(calls).toHaveLength(3)
  })
})
