import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { defaultSettings } from '../../shared/defaults'
import {
  createSteamAccount,
  mapSteamOwned,
  ownedGamesUrl,
  parseAcquiredTimes,
  parseApplicationConfig,
  sharedLibraryUrl,
  parseOwnedApps,
  steamKeyTokens,
  type SteamWebTokens
} from './steam'
import { context, scriptedWindow, stubFetch } from './test-helpers'
import { SessionExpiredError, StoreUnavailableError } from './types'

const OWNED_RESPONSE = {
  response: {
    game_count: 4,
    games: [
      {
        appid: 620,
        name: 'Portal 2',
        playtime_forever: 1108,
        rtime_last_played: 1777548408,
        img_icon_url: 'abc'
      },
      { appid: 228980, name: 'Steamworks Common Redistributables', playtime_forever: 0 },
      {
        appid: 1030840,
        name: 'Mafia: Definitive Edition™',
        playtime_forever: 0,
        rtime_last_played: 0
      },
      { appid: 440, name: '', playtime_forever: 5 }
    ]
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('steam owned-games parsing', () => {
  it('maps GetOwnedGames, drops tools and blank names, and builds CDN art', () => {
    const owned = mapSteamOwned(OWNED_RESPONSE)
    expect(owned.map((g) => g.externalId)).toEqual(['620', '1030840'])
    expect(owned[0]).toMatchObject({
      title: 'Portal 2',
      storePlaytimeMinutes: 1108,
      lastPlayedAt: '2026-04-30T11:26:48.000Z',
      coverUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900_2x.jpg',
      iconUrl:
        'https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/620/abc.jpg',
      extra: { steamAppId: 620 }
    })
    expect(owned[1].title).toBe('Mafia: Definitive Edition')
    expect(owned[1].lastPlayedAt).toBeUndefined()
    expect(owned[1].storePlaytimeMinutes).toBeUndefined()
  })

  it('reads the logged-in application_config and rejects the anonymous one', () => {
    expect(
      parseApplicationConfig({
        u: '{"logged_in":true,"steamid":"76561198000000101","account_name":"example_user"}',
        c: '{"webapi_token":"eyJ.token"}'
      })
    ).toEqual({
      steamId64: '76561198000000101',
      accountName: 'example_user',
      webapiToken: 'eyJ.token'
    })
    expect(
      parseApplicationConfig({
        u: '{"logged_in":false,"country_code":"US"}',
        c: '{"webapi_token":""}'
      })
    ).toBeNull()
    expect(parseApplicationConfig(null)).toBeNull()
    expect(parseApplicationConfig({ u: 'not json', c: '' })).toBeNull()
  })

  it('uses access_token for the web credential and key for the API key', () => {
    const web = new URL(
      ownedGamesUrl({
        kind: 'web',
        steamId64: '1',
        accountName: 'a',
        webapiToken: 'T',
        capturedAt: ''
      })
    )
    expect(web.searchParams.get('access_token')).toBe('T')
    expect(web.searchParams.get('include_appinfo')).toBe('true')
    const key = new URL(ownedGamesUrl({ kind: 'apikey', steamId64: '1', apiKey: 'K' }))
    expect(key.searchParams.get('key')).toBe('K')
    expect(key.searchParams.has('access_token')).toBe(false)
  })

  it('derives the API-key credential from settings only when both values are set', () => {
    const settings = defaultSettings()
    expect(steamKeyTokens(settings)).toBeNull()
    settings.scrapers.steam = { apiKey: 'K', steamId64: '76561198000000101' }
    expect(steamKeyTokens(settings)).toEqual({
      kind: 'apikey',
      steamId64: '76561198000000101',
      apiKey: 'K'
    })
  })
})

describe('steam account', () => {
  const account = createSteamAccount({ personaLookup: async () => 'persona' })

  it('captures the web identity from the first store page after login', async () => {
    const win = scriptedWindow([
      {
        url: 'https://store.steampowered.com/login/?redir=explore',
        js: { u: '{"logged_in":false}', c: '{"webapi_token":""}' }
      },
      {
        url: 'https://store.steampowered.com/explore/',
        js: {
          u: '{"logged_in":true,"steamid":"76561198000000101","account_name":"example_user"}',
          c: '{"webapi_token":"tok"}'
        }
      }
    ])
    const tokens = (await account.signIn(win, context())) as SteamWebTokens
    expect(tokens).toMatchObject({
      kind: 'web',
      steamId64: '76561198000000101',
      accountName: 'example_user',
      webapiToken: 'tok'
    })
  })

  it('resolves null when the window closes without a capture', async () => {
    expect(await account.signIn(scriptedWindow([]), context())).toBeNull()
  })

  it('ignores an application_config on any host but the store (login CSRF)', async () => {
    const forged = {
      u: '{"logged_in":true,"steamid":"76561198000000001","account_name":"attacker"}',
      c: '{"webapi_token":"ATTACKER_TOKEN"}'
    }
    expect(
      await account.signIn(
        scriptedWindow([{ url: 'https://evil.example/anything', js: forged }]),
        context()
      )
    ).toBeNull()
    expect(
      await account.signIn(
        scriptedWindow([
          { url: 'https://store.steampowered.com.evil.example/explore/', js: forged }
        ]),
        context()
      )
    ).toBeNull()
    // A `/login` path elsewhere is not Steam's login page either.
    const tokens: SteamWebTokens = {
      kind: 'web',
      steamId64: '1',
      accountName: 'a',
      webapiToken: 'old',
      capturedAt: ''
    }
    await expect(
      account.refresh(tokens, context(scriptedWindow([{ url: 'https://evil.example/login' }])))
    ).rejects.toBeInstanceOf(StoreUnavailableError)
  })

  it('re-mints the web token from a hidden load and reports a dead session on the login page', async () => {
    const tokens: SteamWebTokens = {
      kind: 'web',
      steamId64: '76561198000000101',
      accountName: 'example_user',
      webapiToken: 'old',
      capturedAt: ''
    }
    const fresh = await account.refresh(
      tokens,
      context(
        scriptedWindow([
          {
            url: 'https://store.steampowered.com/explore/',
            js: {
              u: '{"logged_in":true,"steamid":"76561198000000101","account_name":"example_user"}',
              c: '{"webapi_token":"new"}'
            }
          }
        ])
      )
    )
    expect(fresh?.webapiToken).toBe('new')
    const dead = await account.refresh(
      tokens,
      context(scriptedWindow([{ url: 'https://store.steampowered.com/login/?redir=explore%2F' }]))
    )
    expect(dead).toBeNull()
    // No store page at all (offline, timeout): unknown, so the credential is kept.
    await expect(account.refresh(tokens, context(scriptedWindow([])))).rejects.toBeInstanceOf(
      StoreUnavailableError
    )
    // The API-key credential has nothing to refresh.
    const key = { kind: 'apikey', steamId64: '1', apiKey: 'K' }
    expect(await account.refresh(key, context())).toBe(key)
  })

  it('treats an answer without a games list as no information, not an empty library', async () => {
    stubFetch(() => ({ body: { response: {} } }))
    await expect(
      account.fetchOwned({ kind: 'apikey', steamId64: '1', apiKey: 'K' }, context())
    ).rejects.toThrow(/without a games list/)
  })

  it('fetches the owned list and turns a 401 into SessionExpiredError', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.pathname.includes('GetOwnedGames'))
        return url.searchParams.get('key') === 'K'
          ? { body: OWNED_RESPONSE }
          : { status: 401, body: 'Access is denied' }
      return undefined
    })
    const owned = await account.fetchOwned(
      { kind: 'apikey', steamId64: '1', apiKey: 'K' },
      context()
    )
    expect(owned).toHaveLength(2)
    expect(String(fetchMock.mock.calls[0][0])).toContain('steamid=1')
    await expect(
      account.fetchOwned(
        { kind: 'web', steamId64: '1', accountName: '', webapiToken: 'bad', capturedAt: '' },
        context()
      )
    ).rejects.toBeInstanceOf(SessionExpiredError)
  })

  describe('date added to the library', () => {
    const web: SteamWebTokens = {
      kind: 'web',
      steamId64: '76561198000000001',
      accountName: 'me',
      webapiToken: 'tok',
      capturedAt: ''
    }
    // Shape of IFamilyGroupsService/GetSharedLibraryApps (SteamDatabase's protobufs): rt_time_acquired in Unix seconds.
    const SHARED = {
      response: {
        apps: [
          { appid: 620, owner_steamids: ['76561198000000001'], rt_time_acquired: 1303862400 },
          {
            appid: 1030840,
            owner_steamids: ['76561198000000002', '76561198000000001'],
            rt_time_acquired: 1700000000
          },
          // A family member's game, a placeholder time and a time far in the future are not this account's dates.
          { appid: 730, owner_steamids: ['76561198000000002'], rt_time_acquired: 1650000000 },
          { appid: 10, owner_steamids: ['76561198000000001'], rt_time_acquired: 0 },
          { appid: 20, owner_steamids: ['76561198000000001'], rt_time_acquired: 4102444800 },
          { appid: 30, rt_time_acquired: 1600000000 }
        ]
      }
    }

    it("reads the account's own acquired times", () => {
      const times = parseAcquiredTimes(SHARED, web.steamId64)
      expect([...times.keys()].sort((a, b) => a - b)).toEqual([30, 620, 1030840])
      expect(times.get(620)).toBe('2011-04-27T00:00:00.000Z')
      expect(parseAcquiredTimes({ response: {} }, web.steamId64).size).toBe(0)
      expect(parseAcquiredTimes({}, web.steamId64).size).toBe(0)
      // The account the answer names is the owner, whatever id the sign-in recorded.
      const other = parseAcquiredTimes(
        { response: { ...SHARED.response, owner_steamid: '76561198000000002' } },
        '76561198000000009'
      )
      expect([...other.keys()].sort((a, b) => a - b)).toEqual([30, 730, 1030840])
      // A nonsense time (not a date at all) drops that app only.
      const odd = parseAcquiredTimes(
        {
          response: {
            apps: [
              { appid: 1, rt_time_acquired: 9e15 },
              { appid: 2, rt_time_acquired: Number.NaN },
              { appid: 620, rt_time_acquired: 1303862400 }
            ]
          }
        },
        web.steamId64
      )
      expect([...odd.keys()]).toEqual([620])
    })

    it('asks for the whole own library, in a Steam Family or not', () => {
      const url = new URL(sharedLibraryUrl(web))
      expect(url.pathname).toBe('/IFamilyGroupsService/GetSharedLibraryApps/v1/')
      expect(Object.fromEntries(url.searchParams)).toEqual({
        access_token: 'tok',
        family_groupid: '0',
        include_own: 'true',
        include_excluded: 'true',
        include_free: 'true',
        include_non_games: 'true',
        format: 'json'
      })
    })

    it('puts the date on each owned game of a web sign-in, with one extra request', async () => {
      const fetchMock = stubFetch((url) => {
        if (url.pathname.includes('GetOwnedGames')) return { body: OWNED_RESPONSE }
        if (url.pathname.includes('GetSharedLibraryApps')) return { body: SHARED }
        return undefined
      })
      const owned = await account.fetchOwned(web, context())
      expect(owned.map((g) => [g.externalId, g.acquiredAt])).toEqual([
        ['620', '2011-04-27T00:00:00.000Z'],
        ['1030840', new Date(1700000000 * 1000).toISOString()]
      ])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('keeps the import and the session when Steam refuses the dates', async () => {
      stubFetch((url) => {
        if (url.pathname.includes('GetOwnedGames')) return { body: OWNED_RESPONSE }
        // A refusal of this side call is not an expired session: the owned list just answered.
        if (url.pathname.includes('GetSharedLibraryApps')) return { status: 401, body: 'no' }
        return undefined
      })
      const owned = await account.fetchOwned(web, context())
      expect(owned).toHaveLength(2)
      expect(owned.every((g) => g.acquiredAt === undefined)).toBe(true)
    })

    it('does not ask for the dates with an API key (Steam refuses a key there)', async () => {
      const fetchMock = stubFetch((url) =>
        url.pathname.includes('GetOwnedGames') ? { body: OWNED_RESPONSE } : undefined
      )
      await account.fetchOwned({ kind: 'apikey', steamId64: '1', apiKey: 'K' }, context())
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  it('names the API-key account from GetPlayerSummaries, then the local persona', async () => {
    stubFetch((url) =>
      url.pathname.includes('GetPlayerSummaries')
        ? { body: { response: { players: [{ steamid: '1', personaname: 'Jeremy' }] } } }
        : undefined
    )
    expect(
      await account.displayName({ kind: 'apikey', steamId64: '1', apiKey: 'K' }, context())
    ).toBe('Jeremy (API key)')
    stubFetch(() => ({ status: 401, body: 'denied' }))
    expect(
      await account.displayName({ kind: 'apikey', steamId64: '1', apiKey: 'K' }, context())
    ).toBe('persona (API key)')
  })

  it('builds the install URI from the app id', () => {
    const game = { externalId: '620', extra: { steamAppId: 620 } } as never
    expect(account.installSpec(game, { installed: true })).toEqual({
      kind: 'uri',
      uri: 'steam://install/620'
    })
    // Without the client the URI would open Windows' app picker: no spec, the missing-client message instead.
    expect(account.installSpec(game, { installed: false })).toBeNull()
    expect(account.installError!(game, { installed: false })).toMatch(/Steam is not installed/)
  })
})

describe('parseOwnedApps', () => {
  it('reads the owned app ids of the store userdata answer', () => {
    expect(parseOwnedApps({ rgOwnedApps: [620, '337840', 0, -1, 'x'], rgWishlist: [1] })).toEqual(
      new Set([620, 337840])
    )
  })

  it('is null for a signed-out answer or anything else', () => {
    expect(parseOwnedApps({ rgOwnedApps: [] })).toBeNull()
    expect(parseOwnedApps({})).toBeNull()
    expect(parseOwnedApps(null)).toBeNull()
    expect(parseOwnedApps('<html>')).toBeNull()
  })
})
