import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codeFromRedirect,
  createGogAccount,
  gogImageUrl,
  mapGogProducts,
  mapTokenResponse,
  type GogTokens
} from './gog'
import { HttpError } from './api'
import { context, requestBody, scriptedWindow, silentLog, stubFetch } from './test-helpers'
import { SessionExpiredError } from './types'

const PAGE = (page: number, totalPages: number, products: unknown[]): unknown => ({
  page,
  totalPages,
  totalProducts: 3,
  products
})

afterEach(() => vi.unstubAllGlobals())

describe('gog parsing', () => {
  it('reads the code from the client redirect, including odd hosts', () => {
    expect(
      codeFromRedirect('https://embed.gog.com/on_login_success?origin=client&code=abc_DEF-1')
    ).toBe('abc_DEF-1')
    expect(codeFromRedirect('https://gog.com:80/on_login_success?code=xyz')).toBe('xyz')
    expect(codeFromRedirect('https://login.gog.com/auth?client_id=1')).toBeNull()
    expect(codeFromRedirect('not a url')).toBeNull()
  })

  it('maps the token response', () => {
    const tokens = mapTokenResponse({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600,
      user_id: 'u1'
    })
    expect(tokens).toMatchObject({
      kind: 'oauth',
      accessToken: 'a',
      refreshToken: 'r',
      userId: 'u1'
    })
    expect(Date.parse(tokens.expiresAt)).toBeGreaterThan(Date.now())
    expect(() =>
      mapTokenResponse({ error: 'invalid_grant', error_description: 'bad code' })
    ).toThrow('bad code')
  })

  it('keeps base games only, hidden ones included, and formats the statics image', () => {
    const owned = mapGogProducts([
      {
        id: 1207658924,
        title: 'Cyberpunk 2077®',
        image: '//images-2.gog-statics.com/abc',
        isGame: true,
        releaseDate: { date: '2020-12-10 00:00:00' }
      },
      {
        id: 2,
        title: 'A movie',
        image: '//images-2.gog-statics.com/m',
        isGame: false,
        isMovie: true
      },
      { id: 3, title: 'Hidden', isGame: true, isHidden: true },
      { id: 1207658924, title: 'Duplicate', isGame: true }
    ])
    expect(owned).toHaveLength(2)
    expect(owned[0]).toMatchObject({
      externalId: '1207658924',
      title: 'Cyberpunk 2077',
      coverUrl: 'https://images-2.gog-statics.com/abc_glx_vertical_cover.jpg',
      releaseDate: '2020-12-10',
      extra: { gogProductId: '1207658924', gogHidden: false }
    })
    // A game hidden on gog.com is imported, flagged for the hidden sync.
    expect(owned[1]).toMatchObject({
      externalId: '3',
      title: 'Hidden',
      extra: { gogProductId: '3', gogHidden: true }
    })
    expect(gogImageUrl(undefined, '_x')).toBeUndefined()
  })
})

describe('gog account', () => {
  const account = createGogAccount({ pageDelayMs: 0 })
  const tokens: GogTokens = {
    kind: 'oauth',
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    userId: 'u1'
  }

  it('exchanges the code with the client pair', async () => {
    const fetchMock = stubFetch((url) =>
      url.hostname === 'auth.gog.com' && url.pathname === '/token'
        ? { body: { access_token: 'a', refresh_token: 'r', expires_in: 3600, user_id: 'u1' } }
        : undefined
    )
    const result = await account.signIn(
      scriptedWindow([
        { url: 'https://embed.gog.com/on_login_success?origin=client&code=c0de', loaded: false }
      ]),
      context()
    )
    expect(result).toMatchObject({ kind: 'oauth', userId: 'u1' })
    // The code and the client pair travel in the POST body: the URL (which an HttpError would log) carries nothing.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe('https://auth.gog.com/token')
    const body = new URLSearchParams(requestBody(init))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('c0de')
    expect(body.get('client_id')).toBe('46899977096215655')
  })

  it('refreshes an expired token and returns null when GOG rejects the refresh', async () => {
    const expired = { ...tokens, expiresAt: new Date(Date.now() - 1).toISOString() }
    stubFetch((_url, init) => {
      const body = new URLSearchParams(requestBody(init))
      return body.get('grant_type') === 'refresh_token' && body.get('refresh_token') === 'r'
        ? { body: { access_token: 'a2', refresh_token: 'r2', expires_in: 3600, user_id: 'u1' } }
        : { status: 400, body: { error: 'invalid_grant' } }
    })
    expect((await account.refresh(expired, context()))?.accessToken).toBe('a2')
    stubFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }))
    expect(await account.refresh(expired, context())).toBeNull()
    expect(await account.refresh(tokens, context())).toBe(tokens)
  })

  it('keeps the credential when the token endpoint is down, and never logs the refresh token', async () => {
    const expired = { ...tokens, expiresAt: new Date(Date.now() - 1).toISOString() }
    stubFetch(() => ({ status: 503, body: 'down' }))
    const lines: string[] = []
    const ctx = context()
    ctx.log = { ...silentLog, warn: (m) => lines.push(String(m)) }
    await expect(account.refresh(expired, ctx)).rejects.toBeInstanceOf(HttpError)
    expect(lines.join('\n')).not.toContain('refresh_token=r')
    expect(lines.join('\n')).not.toMatch(/[?&]refresh_token=/)
  })

  it('walks every page of getFilteredProducts with the bearer token', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.pathname !== '/account/getFilteredProducts') return undefined
      if (new Headers(init.headers).get('authorization') !== 'Bearer a')
        return { status: 302, body: '' }
      const page = Number(url.searchParams.get('page'))
      return {
        body: PAGE(
          page,
          2,
          page === 1
            ? [
                { id: 1, title: 'One', isGame: true },
                { id: 2, title: 'Two', isGame: true }
              ]
            : [{ id: 3, title: 'Three', isGame: true }]
        )
      }
    })
    const owned = await account.fetchOwned(tokens, context())
    expect(owned.map((g) => g.externalId)).toEqual(['1', '2', '3'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats the login redirect as an expired session', async () => {
    stubFetch(() => ({
      status: 302,
      body: '',
      headers: { location: 'https://www.gog.com/en##openlogin' }
    }))
    await expect(account.fetchOwned(tokens, context())).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('installs through the client command with the game view as follow-up', () => {
    const game = { externalId: '1207658924', extra: { gogProductId: '1207658924' } } as never
    expect(
      account.installSpec(game, { installed: true, path: 'C:\\GOG\\GalaxyClient.exe' })
    ).toEqual({
      kind: 'exec',
      file: 'C:\\GOG\\GalaxyClient.exe',
      args: ['/gameId=1207658924', '/command=installGame'],
      requiresProcess: 'GalaxyClient',
      followUpUri: 'goggalaxy://openGameView/1207658924',
      followUpDelayMs: 2500
    })
    expect(account.installSpec(game, { installed: false })).toBeNull()
    expect(account.installError!(game, { installed: false })).toMatch(/offline installer/)
  })
})
