import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  catalogSkipReason,
  createEpicAccount,
  filterLibraryRecords,
  mapCatalogItem,
  mapTokenResponse,
  EPIC_LOGIN_URL,
  isRedirectPage,
  launcherRedirectCode,
  parseRedirectDocument,
  type EpicCatalogItem,
  type EpicTokens
} from './epic'
import { context, requestBody, scriptedWindow, stubFetch } from './test-helpers'
import { SessionExpiredError } from './types'

const TOKEN_BODY = {
  access_token: 'acc',
  expires_in: 28800,
  expires_at: '2026-11-02T00:00:00.000Z',
  refresh_token: 'ref',
  refresh_expires: 2592000,
  account_id: 'acct1',
  displayName: 'Jeremy'
}

const FORTNITE: EpicCatalogItem = {
  id: 'cat1',
  title: 'Alan Wake™',
  developer: 'Remedy',
  keyImages: [
    { type: 'DieselGameBoxTall', url: 'https://cdn1.epicgames.com/tall.jpg' },
    { type: 'DieselGameBoxLogo', url: 'https://cdn1.epicgames.com/logo.png' }
  ],
  categories: [{ path: 'games' }, { path: 'applications' }],
  releaseInfo: [{ appId: 'AlanWake', dateAdded: '2021-10-05T12:00:00.000Z' }]
}

afterEach(() => vi.unstubAllGlobals())

describe('epic parsing', () => {
  it('reads the authorization code from the redirect JSON or the legacy URL', () => {
    expect(
      parseRedirectDocument(
        '{"redirectUrl":"https://localhost/launcher/authorized?code=abc123","authorizationCode":"abc123","sid":"x"}'
      )
    ).toBe('abc123')
    expect(
      parseRedirectDocument('<html>https://localhost/launcher/authorized?code=XYZ9</html>')
    ).toBe('XYZ9')
    expect(
      parseRedirectDocument(
        '{"authorizationCode":null,"redirectUrl":"https://localhost/launcher/authorized"}'
      )
    ).toBeNull()
  })

  it('maps the token response and keeps the previous refresh token when none is returned', () => {
    const tokens = mapTokenResponse(TOKEN_BODY)
    expect(tokens).toMatchObject({
      kind: 'oauth',
      accessToken: 'acc',
      refreshToken: 'ref',
      accountId: 'acct1',
      displayName: 'Jeremy'
    })
    const again = mapTokenResponse(
      { access_token: 'acc2', account_id: 'acct1', expires_in: 100 },
      tokens
    )
    expect(again.refreshToken).toBe('ref')
    expect(() =>
      mapTokenResponse({
        errorCode: 'errors.com.epicgames.oauth.corrective_action_required',
        errorMessage: 'nope'
      })
    ).toThrow('nope')
  })

  it('pre-filters library records and skips non-game catalog items', () => {
    expect(
      filterLibraryRecords([
        { appName: 'A', namespace: 'ue', catalogItemId: '1' },
        { appName: 'B', namespace: 'ns', catalogItemId: '2', sandboxType: 'PRIVATE' },
        { appName: 'C', namespace: 'ns', catalogItemId: '3' }
      ]).map((r) => r.appName)
    ).toEqual(['C'])
    expect(catalogSkipReason(FORTNITE)).toBeNull()
    expect(
      catalogSkipReason({ ...FORTNITE, categories: [{ path: 'applications' }, { path: 'mods' }] })
    ).toBe('mods')
    expect(catalogSkipReason({ ...FORTNITE, mainGameItem: { id: 'x' } })).toBe(
      'add-on of another game'
    )
    expect(
      catalogSkipReason({
        ...FORTNITE,
        mainGameItem: { id: 'x' },
        categories: [{ path: 'applications' }, { path: 'addons/launchable' }]
      })
    ).toBeNull()
    expect(
      catalogSkipReason({
        ...FORTNITE,
        customAttributes: { ThirdPartyManagedApp: { value: 'The EA App' } }
      })
    ).toBe('managed by the EA app')
    expect(
      catalogSkipReason({
        ...FORTNITE,
        customAttributes: { partnerLinkType: { value: 'ubisoft' } }
      })
    ).toBe('managed by Ubisoft Connect')
    expect(catalogSkipReason({ ...FORTNITE, categories: [{ path: 'assets' }] })).toBe(
      'not an application'
    )
  })

  it('maps a catalog item to the provider ids, trimmed title, resized cover and release date', () => {
    const game = mapCatalogItem(
      { appName: 'AlanWake', namespace: 'ns', catalogItemId: 'cat1' },
      FORTNITE
    )
    expect(game).toMatchObject({
      externalId: 'AlanWake',
      title: 'Alan Wake',
      developer: 'Remedy',
      coverUrl: 'https://cdn1.epicgames.com/tall.jpg?w=600&h=900&resize=1',
      logoUrl: 'https://cdn1.epicgames.com/logo.png',
      releaseDate: '2021-10-05',
      extra: { epicAppName: 'AlanWake', epicNamespace: 'ns', epicCatalogItemId: 'cat1' }
    })
  })
})

describe('epic account', () => {
  const account = createEpicAccount()
  const tokens: EpicTokens = {
    kind: 'oauth',
    accessToken: 'acc',
    refreshToken: 'ref',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: 'acct1'
  }

  it('exchanges the captured code for tokens', async () => {
    const fetchMock = stubFetch((url) =>
      url.pathname.endsWith('/oauth/token') ? { body: TOKEN_BODY } : undefined
    )
    const win = scriptedWindow([
      { url: 'https://www.epicgames.com/id/login', js: '' },
      {
        url: 'https://www.epicgames.com/id/api/redirect?clientId=x&responseType=code',
        js: '{"authorizationCode":"code77","redirectUrl":"https://localhost/launcher/authorized?code=code77"}'
      }
    ])
    const result = await account.signIn(win, context())
    expect(result).toMatchObject({ kind: 'oauth', accessToken: 'acc', accountId: 'acct1' })
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(requestBody(init)).toBe('grant_type=authorization_code&code=code77&token_type=eg1')
    expect(new Headers(init.headers).get('authorization')).toMatch(/^basic /)
  })

  it('refreshes only an expiring token and returns null when the refresh is rejected', async () => {
    expect(await account.refresh(tokens, context())).toBe(tokens)
    const expired = { ...tokens, expiresAt: new Date(Date.now() - 1000).toISOString() }
    const fetchMock = stubFetch((_url, init) =>
      requestBody(init).includes('grant_type=refresh_token')
        ? { body: { ...TOKEN_BODY, access_token: 'acc2' } }
        : { status: 400, body: { errorCode: 'bad' } }
    )
    const fresh = await account.refresh(expired, context())
    expect(fresh?.accessToken).toBe('acc2')
    expect(requestBody(fetchMock.mock.calls[0][1] as RequestInit)).toContain('refresh_token=ref')
    stubFetch(() => ({
      status: 400,
      body: { errorCode: 'errors.com.epicgames.account.auth_token.invalid_refresh_token' }
    }))
    expect(await account.refresh(expired, context())).toBeNull()
    // A 5xx / network failure keeps the credential (rethrown) instead of signing the user out.
    stubFetch(() => ({ status: 503, body: 'down' }))
    await expect(account.refresh(expired, context())).rejects.toThrow(/503/)
  })

  it("reads the code only from Epic's own redirect document", async () => {
    stubFetch(() => ({ body: TOKEN_BODY }))
    const forged = scriptedWindow([
      {
        url: 'https://evil.example/id/api/redirect?x=1',
        js: '{"authorizationCode":"ATTACKERCODE"}'
      }
    ])
    expect(await account.signIn(forged, context())).toBeNull()
    expect(
      isRedirectPage('https://www.epicgames.com/id/api/redirect?clientId=x&responseType=code')
    ).toBe(true)
    expect(isRedirectPage('https://evil.example/id/api/redirect')).toBe(false)
    expect(isRedirectPage('https://www.epicgames.com/id/login')).toBe(false)
  })

  it('fails the whole import when a catalog batch fails, instead of dropping its games', async () => {
    stubFetch((url) => {
      if (url.pathname === '/library/api/public/items')
        return {
          body: {
            responseMetadata: { nextCursor: null },
            records: [{ appName: 'AlanWake', namespace: 'ns', catalogItemId: 'cat1' }]
          }
        }
      if (url.pathname.includes('/bulk/items')) return { status: 502, body: 'bad gateway' }
      return undefined
    })
    await expect(account.fetchOwned(tokens, context())).rejects.toThrow(/catalog lookup failed/)
  })

  it('pages the library, looks the catalog up per namespace and adds play time', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.pathname === '/library/api/public/items') {
        return url.searchParams.get('cursor') === 'c2'
          ? {
              body: {
                responseMetadata: { nextCursor: null },
                records: [{ appName: 'Second', namespace: 'ns', catalogItemId: 'cat2' }]
              }
            }
          : {
              body: {
                responseMetadata: { nextCursor: 'c2' },
                records: [
                  { appName: 'AlanWake', namespace: 'ns', catalogItemId: 'cat1' },
                  { appName: 'Engine', namespace: 'ue', catalogItemId: 'u' }
                ]
              }
            }
      }
      if (url.pathname.includes('/bulk/items'))
        return {
          body: {
            cat1: FORTNITE,
            cat2: {
              ...FORTNITE,
              id: 'cat2',
              title: 'Second',
              categories: [{ path: 'applications' }, { path: 'digitalextras' }]
            }
          }
        }
      if (url.pathname.includes('/playtime/'))
        return { body: [{ artifactId: 'AlanWake', totalTime: 5400 }] }
      return undefined
    })
    const owned = await account.fetchOwned(tokens, context())
    expect(owned).toHaveLength(1)
    expect(owned[0]).toMatchObject({ externalId: 'AlanWake', storePlaytimeMinutes: 90 })
    const bulk = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes('/bulk/items'))!
    expect(bulk).toContain('/namespace/ns/bulk/items?id=cat1&id=cat2')
  })

  it('reports an expired session on 401', async () => {
    stubFetch(() => ({
      status: 401,
      body: { errorCode: 'errors.com.epicgames.common.authentication.authentication_failed' }
    }))
    await expect(account.fetchOwned(tokens, context())).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('builds the install URI only when the launcher is installed', () => {
    const game = { externalId: 'AlanWake', extra: { epicAppName: 'AlanWake' } } as never
    expect(
      account.installSpec(game, { installed: true, path: 'C:\\E\\EpicGamesLauncher.exe' })
    ).toEqual({
      kind: 'uri',
      uri: 'com.epicgames.launcher://apps/AlanWake?action=install'
    })
    expect(account.installSpec(game, { installed: false })).toBeNull()
  })
})

describe('the Launcher sign-in flow', () => {
  it('opens the sign-in page without a redirectUrl (Epic rejects it as "Redirect URL is not known")', () => {
    expect(EPIC_LOGIN_URL).toBe('https://www.epicgames.com/id/login?responseType=code')
    expect(EPIC_LOGIN_URL).not.toContain('redirectUrl')
  })

  it('reads the code from the Launcher redirect address only', () => {
    expect(launcherRedirectCode('http://localhost/launcher/authorized?code=abc123DEF')).toBe(
      'abc123DEF'
    )
    expect(launcherRedirectCode('https://localhost/launcher/authorized/?code=XYZ9')).toBe('XYZ9')
    expect(launcherRedirectCode('http://127.0.0.1/launcher/authorized?code=Q1')).toBe('Q1')
    // Look-alikes and bad codes are not trusted.
    expect(launcherRedirectCode('https://evil.example/launcher/authorized?code=abc')).toBeNull()
    expect(
      launcherRedirectCode('http://localhost.evil.example/launcher/authorized?code=abc')
    ).toBeNull()
    expect(launcherRedirectCode('http://localhost/launcher/other?code=abc')).toBeNull()
    expect(launcherRedirectCode('http://localhost/launcher/authorized?code=a%20b')).toBeNull()
    expect(launcherRedirectCode('http://localhost/launcher/authorized')).toBeNull()
    expect(launcherRedirectCode('not a url')).toBeNull()
  })
})
