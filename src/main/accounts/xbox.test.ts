import { afterEach, describe, expect, it, vi } from 'vitest'
import { context, requestBody, scriptedWindow, stubFetch } from './test-helpers'
import { SessionExpiredError } from './types'
import {
  cleanXboxTitle,
  codeFromRedirect,
  createXboxAccount,
  mapTitleHistory,
  parseUserStats,
  type XboxTokens
} from './xbox'

const TITLES = {
  xuid: '2535',
  titles: [
    {
      titleId: '1234567890',
      pfn: 'Microsoft.Conker_8wekyb3d8bbwe',
      productId: '9NBLGGH4R2R6',
      type: 'Game',
      name: 'Conker: Live and Reloaded for Windows 10',
      devices: ['PC', 'XboxOne'],
      images: [
        { type: 'Poster', url: 'https://img/poster.jpg' },
        { type: 'SuperHeroArt', url: 'https://img/hero.jpg' }
      ],
      detail: {
        developerName: 'Rare',
        publisherName: 'Xbox Game Studios',
        releaseDate: '2005-06-21T00:00:00.000Z'
      },
      titleHistory: { lastTimePlayed: '2026-10-01T10:00:00.000Z' }
    },
    { titleId: '2', pfn: 'Some.App_abc', type: 'App', name: 'An app', devices: ['PC'] },
    {
      titleId: '3',
      pfn: 'Console.Only_abc',
      type: 'Game',
      name: 'Console only',
      devices: ['XboxOne']
    },
    { titleId: '4', pfn: '', type: 'Game', name: 'No pfn', devices: ['PC'] }
  ]
}

afterEach(() => vi.unstubAllGlobals())

describe('xbox parsing', () => {
  it('reads the code from the desktop redirect only', () => {
    expect(
      codeFromRedirect('https://login.live.com/oauth20_desktop.srf?code=M.C123456789&lc=1033')
    ).toBe('M.C123456789')
    expect(codeFromRedirect('https://login.live.com/oauth20_authorize.srf?client_id=x')).toBeNull()
  })

  it('cleans Windows suffixes from titles', () => {
    expect(cleanXboxTitle('Conker: Live and Reloaded for Windows 10')).toBe(
      'Conker: Live and Reloaded'
    )
    expect(cleanXboxTitle('Forza Horizon 5 (PC)')).toBe('Forza Horizon 5')
    expect(cleanXboxTitle('Halo Infinite - Windows 10')).toBe('Halo Infinite')
    expect(cleanXboxTitle('Sea of Thieves™')).toBe('Sea of Thieves')
  })

  it('keeps PC games with a package family name and maps ids, art and dates', () => {
    const owned = mapTitleHistory(TITLES, new Map([['1234567890', 95]]))
    expect(owned).toHaveLength(1)
    expect(owned[0]).toMatchObject({
      externalId: 'Microsoft.Conker_8wekyb3d8bbwe',
      title: 'Conker: Live and Reloaded',
      coverUrl: 'https://img/poster.jpg',
      heroUrl: 'https://img/hero.jpg',
      developer: 'Rare',
      publisher: 'Xbox Game Studios',
      releaseDate: '2005-06-21',
      lastPlayedAt: '2026-10-01T10:00:00.000Z',
      storePlaytimeMinutes: 95,
      extra: { titleId: '1234567890', storeId: '9NBLGGH4R2R6' }
    })
    expect(
      parseUserStats({
        statlistscollection: [
          {
            stats: [
              { titleid: '1', value: '42' },
              { titleid: '2', value: '0' }
            ]
          }
        ]
      })
    ).toEqual(new Map([['1', 42]]))
  })
})

describe('xbox account', () => {
  const account = createXboxAccount()
  const tokens: XboxTokens = {
    kind: 'msa',
    accessToken: 'msa',
    refreshToken: 'ref',
    msaExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    xstsToken: 'xsts',
    uhs: 'uhs1',
    xid: '2535',
    gamertag: 'JeremyB',
    xstsNotAfter: new Date(Date.now() + 3600_000).toISOString()
  }

  function liveRoutes(url: URL): { body: unknown } | undefined {
    if (url.hostname === 'user.auth.xboxlive.com') return { body: { Token: 'user' } }
    if (url.hostname === 'xsts.auth.xboxlive.com')
      return {
        body: {
          Token: 'xsts2',
          NotAfter: '2026-11-02T00:00:00.000Z',
          DisplayClaims: { xui: [{ uhs: 'uhs2', xid: '2535', gtg: 'JeremyB' }] }
        }
      }
    return undefined
  }

  it('exchanges the code and chains the XBL and XSTS tokens', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.pathname === '/oauth20_token.srf')
        return { body: { access_token: 'msa', refresh_token: 'ref', expires_in: 3600 } }
      return liveRoutes(url)
    })
    const result = (await account.signIn(
      scriptedWindow([
        {
          url: 'https://login.live.com/oauth20_desktop.srf?code=M.C987654321&lc=1033',
          loaded: false
        }
      ]),
      context()
    )) as XboxTokens
    expect(result).toMatchObject({
      kind: 'msa',
      xstsToken: 'xsts2',
      uhs: 'uhs2',
      xid: '2535',
      gamertag: 'JeremyB'
    })
    expect(requestBody(fetchMock.mock.calls[0][1] as RequestInit)).toContain(
      'grant_type=authorization_code&code=M.C987654321'
    )
    expect(await account.displayName(result, context())).toBe('JeremyB')
  })

  it('refreshes: XSTS only while the MSA token lives, the whole chain afterwards', async () => {
    expect(await account.refresh(tokens, context())).toBe(tokens)
    const staleXsts = { ...tokens, xstsNotAfter: new Date(Date.now() - 1).toISOString() }
    const fetchMock = stubFetch((url) =>
      url.pathname === '/oauth20_token.srf'
        ? { status: 400, body: { error: 'invalid_grant' } }
        : liveRoutes(url)
    )
    expect((await account.refresh(staleXsts, context()))?.xstsToken).toBe('xsts2')
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('oauth20_token'))).toBe(false)

    const staleAll = { ...staleXsts, msaExpiresAt: new Date(Date.now() - 1).toISOString() }
    stubFetch((url, init) =>
      url.pathname === '/oauth20_token.srf'
        ? requestBody(init).includes('grant_type=refresh_token&refresh_token=ref')
          ? { body: { access_token: 'msa2', refresh_token: 'ref2', expires_in: 3600 } }
          : { status: 400, body: { error: 'invalid_grant' } }
        : liveRoutes(url)
    )
    const fresh = await account.refresh(staleAll, context())
    expect(fresh).toMatchObject({ accessToken: 'msa2', refreshToken: 'ref2', xstsToken: 'xsts2' })
    stubFetch(() => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'expired' }
    }))
    expect(await account.refresh(staleAll, context())).toBeNull()
    // A 5xx from the token endpoint is not a rejected credential: rethrown, tokens kept.
    stubFetch(() => ({ status: 503, body: 'down' }))
    await expect(account.refresh(staleAll, context())).rejects.toThrow(/503/)
  })

  it('fetches the title history with the XBL3.0 header and merges minutes played', async () => {
    const fetchMock = stubFetch((url, init) => {
      const auth = new Headers(init.headers).get('authorization')
      if (auth !== 'XBL3.0 x=uhs1;xsts') return { status: 401, body: '' }
      if (url.hostname === 'titlehub.xboxlive.com') return { body: TITLES }
      if (url.hostname === 'userstats.xboxlive.com')
        return {
          body: { statlistscollection: [{ stats: [{ titleid: '1234567890', value: '123' }] }] }
        }
      return undefined
    })
    const owned = await account.fetchOwned(tokens, context())
    expect(owned).toHaveLength(1)
    expect(owned[0].storePlaytimeMinutes).toBe(123)
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/users/xuid(2535)/titles/titlehistory/decoration/detail,image,gamepass,productId'
    )
    stubFetch(() => ({ status: 401, body: '' }))
    await expect(account.fetchOwned(tokens, context())).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('prefers the Xbox app URI and falls back to the Store page', () => {
    const game = {
      externalId: 'Microsoft.Conker_8wekyb3d8bbwe',
      extra: { storeId: '9NBLGGH4R2R6' }
    } as never
    expect(account.installSpec(game, { installed: true })).toEqual({
      kind: 'uri',
      uri: 'msxbox://game/?productId=9NBLGGH4R2R6'
    })
    expect(account.installSpec(game, { installed: false })).toEqual({
      kind: 'uri',
      uri: 'ms-windows-store://pdp/?ProductId=9NBLGGH4R2R6'
    })
    expect(
      account.installSpec({ externalId: 'x', extra: {} } as never, { installed: true })
    ).toBeNull()
  })
})
