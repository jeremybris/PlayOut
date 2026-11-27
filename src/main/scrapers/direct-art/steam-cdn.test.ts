import { describe, expect, it } from 'vitest'
import { fakeGame, testSettings } from '../test-helpers'
import { createSteamCdnSource, steamCoverFallbacks } from './steam-cdn'

describe('steam-cdn source', () => {
  it('builds the 2x -> 1x cover chain, hero and logo URLs without a request', async () => {
    const s = createSteamCdnSource()
    expect(s.batchSize).toBe(1)
    expect(s.isConfigured(testSettings())).toBe(true)
    const found = await s.candidates(
      [
        { game: fakeGame('steam', '620'), ids: { steamAppId: 620 } },
        { game: fakeGame('gog', '1'), ids: { gogProductId: '1' } }
      ],
      ['cover', 'hero', 'logo', 'icon'],
      testSettings()
    )
    expect([...found.keys()]).toEqual(['steam:620'])
    const art = found.get('steam:620')!
    expect(art.cover?.map((c) => c.url)).toEqual([
      'https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900_2x.jpg',
      'https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900.jpg'
    ])
    expect(art.cover?.[1]).toMatchObject({ width: 300, height: 450, source: 'steam-cdn' })
    expect(art.hero?.[0].url).toBe(
      'https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_hero.jpg'
    )
    expect(art.logo?.[0].url).toBe('https://cdn.cloudflare.steamstatic.com/steam/apps/620/logo.png')
    expect(art.icon).toBeUndefined()
  })

  it('derives the small-cover fallback from a seed URL', () => {
    expect(
      steamCoverFallbacks(
        'https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900_2x.jpg'
      )
    ).toEqual(['https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900.jpg'])
    expect(steamCoverFallbacks('https://example.com/cover.jpg')).toEqual([])
  })
})
