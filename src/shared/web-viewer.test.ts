import { describe, expect, it } from 'vitest'
import type { Game } from './types'
import {
  isSteamLinkKind,
  STEAM_LINK_KINDS,
  steamLinksAppId,
  steamLinkUrl,
  steamWorkshopShown
} from './web-viewer'

const game = (over: Partial<Game>): Game =>
  ({ source: 'steam', externalId: '1794680', metadata: {}, ...over }) as Game

describe('steamLinkUrl', () => {
  it('builds each link for a Steam app', () => {
    expect(steamLinkUrl('store', 620)).toBe('https://store.steampowered.com/app/620/')
    expect(steamLinkUrl('workshop', 620)).toBe('https://steamcommunity.com/app/620/workshop/')
    expect(steamLinkUrl('guides', 620)).toBe('https://steamcommunity.com/app/620/guides/')
    expect(steamLinkUrl('pcgamingwiki', 620)).toBe(
      'https://www.pcgamingwiki.com/api/appid.php?appid=620'
    )
  })

  it('refuses anything that is not an app id', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 40])
      expect(() => steamLinkUrl('store', bad)).toThrow()
  })

  it('keeps the grid order and knows its kinds', () => {
    expect(STEAM_LINK_KINDS).toEqual(['store', 'workshop', 'pcgamingwiki', 'guides'])
    expect(isSteamLinkKind('guides')).toBe(true)
    expect(isSteamLinkKind('evil')).toBe(false)
  })
})

describe('steamLinksAppId', () => {
  it('takes Steam games only, by their app id', () => {
    expect(steamLinksAppId(game({}))).toBe(1794680)
    expect(steamLinksAppId(game({ extra: { steamAppId: 620 } }))).toBe(620)
    expect(steamLinksAppId(game({ source: 'gog', extra: { steamAppId: 620 } }))).toBeNull()
    expect(steamLinksAppId(game({ source: 'rom', externalId: '123' }))).toBeNull()
    expect(steamLinksAppId(game({ externalId: 'not-a-number' }))).toBeNull()
    expect(steamLinksAppId(game({ externalId: '12abc' }))).toBeNull()
  })

  it('falls back to the external id when extra.steamAppId is not usable', () => {
    const odd = (steamAppId: unknown): Game['extra'] => ({ steamAppId }) as unknown as Game['extra']
    expect(steamLinksAppId(game({ externalId: '620', extra: odd('') }))).toBe(620)
    expect(steamLinksAppId(game({ externalId: '620', extra: odd('abc') }))).toBe(620)
    expect(steamLinksAppId(game({ externalId: '620', extra: odd(0) }))).toBe(620)
    expect(steamLinksAppId(game({ externalId: '', extra: odd('') }))).toBeNull()
  })
})

describe('steamWorkshopShown', () => {
  it('hides the Workshop only when Steam said there is none', () => {
    expect(steamWorkshopShown(game({}))).toBe(true)
    expect(
      steamWorkshopShown(game({ metadata: { steamTags: { tags: [], workshop: true } } }))
    ).toBe(true)
    expect(
      steamWorkshopShown(game({ metadata: { steamTags: { tags: [], workshop: false } } }))
    ).toBe(false)
  })
})
