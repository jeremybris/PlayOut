import { describe, expect, it } from 'vitest'
import { clampScroll, EXTERNAL_URL_MAX, externalHref, hostOf, webViewerDecision } from './allow'

describe('webViewerDecision', () => {
  it("shows Steam's store and community and PCGamingWiki over https", () => {
    for (const url of [
      'https://store.steampowered.com/app/620/',
      'https://steamcommunity.com/app/620/workshop/',
      'https://steamcommunity.com/sharedfiles/filedetails/?id=1',
      'https://pcgamingwiki.com/api/appid.php?appid=620',
      'https://www.pcgamingwiki.com/wiki/Portal_2',
      'https://STORE.steampowered.com/app/620/'
    ])
      expect(webViewerDecision(url)).toBe('allow')
  })

  it('sends look-alikes, other sites and plain http to the default browser', () => {
    for (const url of [
      'https://steamcommunity.com.evil.com/app/620/',
      'https://evil-steamcommunity.com/',
      'https://evil.com/?https://steamcommunity.com/',
      'https://help.steampowered.com/',
      'https://www.youtube.com/watch?v=x',
      'http://store.steampowered.com/app/620/',
      'https://user:pass@steamcommunity.com/',
      'https://steamcommunity.com:8443/',
      'https://steamcommunity.com@evil.com/'
    ])
      expect(webViewerDecision(url)).toBe('external')
  })

  it('blocks every other scheme', () => {
    for (const url of [
      'data:text/html,<script>alert(1)</script>',
      'javascript:alert(1)',
      'file:///C:/Windows/win.ini',
      'steam://run/620',
      'blob:https://steamcommunity.com/1234',
      'about:blank',
      'not a url',
      ''
    ])
      expect(webViewerDecision(url)).toBe('block')
  })
})

describe('externalHref', () => {
  it('hands over the canonical http(s) address, never another scheme or a huge one', () => {
    expect(externalHref('HTTPS://Example.COM/a b')).toBe('https://example.com/a%20b')
    expect(externalHref('http://example.com')).toBe('http://example.com/')
    expect(externalHref('javascript:alert(1)')).toBeNull()
    expect(externalHref('file:///C:/x')).toBeNull()
    expect(externalHref(`https://example.com/${'a'.repeat(EXTERNAL_URL_MAX)}`)).toBeNull()
  })
})

describe('helpers', () => {
  it('reads the host and clamps scroll steps', () => {
    expect(hostOf('https://Steamcommunity.com/app/1/')).toBe('steamcommunity.com')
    expect(hostOf('nope')).toBe('')
    expect(clampScroll(120.4)).toBe(120)
    expect(clampScroll(1e9)).toBe(5000)
    expect(clampScroll(-1e9)).toBe(-5000)
    expect(clampScroll(Number.NaN)).toBe(0)
    expect(clampScroll('5')).toBe(0)
  })
})
