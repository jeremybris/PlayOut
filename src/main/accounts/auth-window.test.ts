import { describe, expect, it } from 'vitest'
import { allowPopup, isAllowedNavigation, siteOf } from './auth-window'

describe('auth window navigation guard', () => {
  it('reduces hosts to their registrable site', () => {
    expect(siteOf('https://store.steampowered.com/explore/')).toBe('steampowered.com')
    expect(siteOf('https://login.live.com/oauth20_desktop.srf')).toBe('live.com')
    expect(siteOf('https://shop.example.co.uk/x')).toBe('example.co.uk')
    expect(siteOf('not a url')).toBeNull()
  })

  it('allows main-frame navigations on the store sites only', () => {
    const steam = ['steampowered.com', 'steamcommunity.com']
    expect(isAllowedNavigation('https://store.steampowered.com/login/', steam)).toBe(true)
    expect(isAllowedNavigation('https://steamcommunity.com/openid/', steam)).toBe(true)
    expect(isAllowedNavigation('about:blank', steam)).toBe(true)
    // A footer link, a look-alike host and a plain-http page are all blocked.
    expect(isAllowedNavigation('https://evil.example/anything', steam)).toBe(false)
    expect(isAllowedNavigation('https://store.steampowered.com.evil.example/', steam)).toBe(false)
    expect(isAllowedNavigation('http://store.steampowered.com/', steam)).toBe(false)
    // Without an allow-list (hidden single-URL reads, tests) any https site passes.
    expect(isAllowedNavigation('https://anything.example/', undefined)).toBe(true)
    expect(isAllowedNavigation('javascript:alert(1)', undefined)).toBe(false)
  })

  it('judges popups by the allow-list when there is one, else by the opener site', () => {
    const epic = ['epicgames.com']
    expect(
      allowPopup(
        'https://www.epicgames.com/id/mfa',
        'https://www.epicgames.com/id/login',
        'https://www.epicgames.com/id/login',
        epic
      )
    ).toBe(true)
    // The page itself cannot widen the allow-list by being somewhere else.
    expect(
      allowPopup(
        'https://evil.example/popup',
        'https://evil.example/page',
        'https://www.epicgames.com/id/login',
        epic
      )
    ).toBe(false)
    expect(
      allowPopup('https://evil.example/popup', 'https://evil.example/page', 'https://a.example/')
    ).toBe(true)
    expect(
      allowPopup('http://evil.example/popup', 'https://evil.example/page', 'https://a.example/')
    ).toBe(false)
  })
})
