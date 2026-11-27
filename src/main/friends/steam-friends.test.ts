import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { friendsErrorText } from '../../shared/friends'
import { tMain } from '../i18n'
import type { Settings } from '../../shared/types'
import { HttpError } from '../scrapers/http'
import {
  createFriendsService,
  fetchSteamFriends,
  FRIENDS_CACHE_MS,
  friendsErrorCode,
  parseFriendList,
  parsePlayerSummaries,
  presenceOf,
  safeAvatar,
  steamKeyOf,
  SUMMARY_BATCH,
  type GetJson
} from './steam-friends'

const ME = '76561197960287930'
const KEY = 'ABCDEF0123456789ABCDEF0123456789'
const id = (n: number): string => `765611980${String(n).padStart(8, '0')}`

/** GetFriendList's answer (a trimmed real response). */
const FRIEND_LIST = {
  friendslist: {
    friends: [
      { steamid: id(1), relationship: 'friend', friend_since: 1500000000 },
      { steamid: id(2), relationship: 'friend', friend_since: 1500000001 },
      { steamid: id(3), relationship: 'friend', friend_since: 1500000002 },
      { steamid: id(4), relationship: 'friend', friend_since: 1500000003 }
    ]
  }
}

/** GetPlayerSummaries' answer for those four (a trimmed real response). */
const SUMMARIES = {
  response: {
    players: [
      {
        steamid: id(1),
        communityvisibilitystate: 3,
        personaname: 'Kestrel',
        avatar: 'https://avatars.steamstatic.com/abc.jpg',
        avatarmedium: 'https://avatars.steamstatic.com/abc_medium.jpg',
        avatarfull: 'https://avatars.steamstatic.com/abc_full.jpg',
        personastate: 1,
        gameid: '553850',
        gameextrainfo: 'HELLDIVERS™ 2',
        lastlogoff: 1764000000
      },
      {
        steamid: id(2),
        personaname: 'Aurora',
        avatarmedium: 'http://avatars.steamstatic.com/plain_http.jpg',
        personastate: 3
      },
      {
        steamid: id(3),
        personaname: 'Quinn',
        avatarmedium: 'https://evil.example.com/a.jpg',
        personastate: 0,
        // Steam shows no game for an offline friend; one that slips through is ignored.
        gameextrainfo: 'Old Game',
        lastlogoff: 1763990000
      },
      { steamid: id(4), personaname: '', personastate: 6 }
    ]
  }
}

function settingsWith(apiKey: string, steamId64: string): Settings {
  return { scrapers: { steam: { apiKey, steamId64 } } } as unknown as Settings
}

/** A fake Steam Web API: answers by method, records each URL. */
function fakeSteam(
  routes: { list?: unknown; summaries?: (ids: string[]) => unknown; error?: unknown } = {}
): { getJson: GetJson; urls: string[] } {
  const urls: string[] = []
  const getJson: GetJson = async (url) => {
    urls.push(url)
    if (routes.error) throw routes.error
    const u = new URL(url)
    if (u.pathname.includes('GetFriendList')) return routes.list ?? FRIEND_LIST
    if (u.pathname.includes('GetPlayerSummaries')) {
      const ids = (u.searchParams.get('steamids') ?? '').split(',')
      return routes.summaries ? routes.summaries(ids) : SUMMARIES
    }
    throw new Error(`unexpected ${u.pathname}`)
  }
  return { getJson, urls }
}

describe('Steam friends parsing', () => {
  it('reads the friend ids, each once, friends only', () => {
    expect(parseFriendList(FRIEND_LIST)).toEqual([id(1), id(2), id(3), id(4)])
    expect(
      parseFriendList({
        friendslist: {
          friends: [
            { steamid: id(1), relationship: 'friend' },
            { steamid: id(1), relationship: 'friend' },
            { steamid: '123', relationship: 'friend' },
            { steamid: id(9), relationship: 'requestrecipient' }
          ]
        }
      })
    ).toEqual([id(1)])
    // Steam answers an empty object for an account without friends.
    expect(parseFriendList({})).toEqual([])
    expect(parseFriendList(null)).toEqual([])
  })

  it('maps every personastate, unknown values as offline', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(presenceOf)).toEqual([
      'offline',
      'online',
      'busy',
      'away',
      'snooze',
      'trade',
      'play'
    ])
    expect(presenceOf(7)).toBe('offline')
    expect(presenceOf(undefined)).toBe('offline')
    expect(presenceOf('1')).toBe('online')
  })

  it('keeps only https pictures from Steam', () => {
    expect(safeAvatar('https://avatars.steamstatic.com/a.jpg')).toBe(
      'https://avatars.steamstatic.com/a.jpg'
    )
    expect(safeAvatar('https://steamcdn-a.akamaihd.net/a.jpg')).toBeDefined()
    expect(safeAvatar('http://avatars.steamstatic.com/a.jpg')).toBeUndefined()
    expect(safeAvatar('https://evil.example.com/a.jpg')).toBeUndefined()
    expect(safeAvatar('https://steamstatic.com.evil.example/a.jpg')).toBeUndefined()
    expect(safeAvatar('https://evil.akamaihd.net/x.jpg')).toBeUndefined()
    expect(safeAvatar('https://akamaihd.net/x.jpg')).toBeUndefined()
    expect(safeAvatar('https://x.steamcdn-a.akamaihd.net/a.jpg')).toBeUndefined()
    expect(safeAvatar('https://avatars.akamai.steamstatic.com/a.jpg')).toBeDefined()
    expect(safeAvatar('https://steamstatic.com/a.jpg')).toBeDefined()
    expect(safeAvatar('javascript:alert(1)')).toBeUndefined()
    expect(safeAvatar(42)).toBeUndefined()
  })

  it('reads names, pictures, status, game and last online', () => {
    const friends = parsePlayerSummaries(SUMMARIES)
    expect(friends).toEqual([
      {
        steamId: id(1),
        name: 'Kestrel',
        presence: 'online',
        avatarUrl: 'https://avatars.steamstatic.com/abc_medium.jpg',
        game: 'HELLDIVERS™ 2',
        gameId: '553850',
        lastOnlineAt: 1764000000 * 1000
      },
      { steamId: id(2), name: 'Aurora', presence: 'away' },
      { steamId: id(3), name: 'Quinn', presence: 'offline', lastOnlineAt: 1763990000 * 1000 },
      // No name: the id stands in.
      { steamId: id(4), name: id(4), presence: 'play' }
    ])
    expect(parsePlayerSummaries({ response: {} })).toEqual([])
  })

  it('reads the key and SteamID64 from Settings, both or nothing', () => {
    expect(steamKeyOf(settingsWith(` ${KEY} `, ` ${ME} `))).toEqual({ key: KEY, steamId64: ME })
    expect(steamKeyOf(settingsWith('', ME))).toBeNull()
    expect(steamKeyOf(settingsWith(KEY, ''))).toBeNull()
    expect(steamKeyOf(settingsWith(KEY, '12345'))).toBeNull()
  })
})

describe('fetchSteamFriends', () => {
  it('asks for the friends, then their summaries', async () => {
    const steam = fakeSteam()
    const friends = await fetchSteamFriends({ key: KEY, steamId64: ME }, steam.getJson)
    expect(friends.map((f) => f.name)).toEqual(['Kestrel', 'Aurora', 'Quinn', id(4)])
    const [list, summaries] = steam.urls.map((u) => new URL(u))
    expect(list!.pathname).toBe('/ISteamUser/GetFriendList/v1/')
    expect(list!.searchParams.get('steamid')).toBe(ME)
    expect(list!.searchParams.get('relationship')).toBe('friend')
    expect(summaries!.pathname).toBe('/ISteamUser/GetPlayerSummaries/v2/')
    expect(summaries!.searchParams.get('steamids')).toBe([1, 2, 3, 4].map(id).join(','))
  })

  it(`asks for the summaries ${SUMMARY_BATCH} friends at a time`, async () => {
    const ids = Array.from({ length: 250 }, (_, i) => id(i + 1))
    const steam = fakeSteam({
      list: {
        friendslist: { friends: ids.map((steamid) => ({ steamid, relationship: 'friend' })) }
      },
      summaries: (batch) => ({
        response: {
          players: batch.map((steamid) => ({
            steamid,
            personaname: `p${steamid}`,
            personastate: 1
          }))
        }
      })
    })
    const friends = await fetchSteamFriends({ key: KEY, steamId64: ME }, steam.getJson)
    expect(friends).toHaveLength(250)
    const batches = steam.urls
      .slice(1)
      .map((u) => new URL(u).searchParams.get('steamids')!.split(','))
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50])
    expect(batches.flat()).toEqual(ids)
  })

  it('makes no summary call without friends', async () => {
    const steam = fakeSteam({ list: {} })
    expect(await fetchSteamFriends({ key: KEY, steamId64: ME }, steam.getJson)).toEqual([])
    expect(steam.urls).toHaveLength(1)
  })
})

describe('friends errors', () => {
  it('maps 401 to a private list, 403 to a refused key, the rest to the network', () => {
    expect(friendsErrorCode(new HttpError('HTTP 401', { status: 401, url: 'u' }))).toBe('private')
    expect(friendsErrorCode(new HttpError('HTTP 403', { status: 403, url: 'u' }))).toBe(
      'key-refused'
    )
    expect(friendsErrorCode(new HttpError('HTTP 500', { status: 500, url: 'u' }))).toBe('network')
    expect(friendsErrorCode(new HttpError('timeout', { status: 0, url: 'u' }))).toBe('network')
    expect(friendsErrorCode(new TypeError('fetch failed'))).toBe('network')
  })
})

function service(options: { settings?: Settings; steam?: ReturnType<typeof fakeSteam> } = {}): {
  friends: ReturnType<typeof createFriendsService>
  steam: ReturnType<typeof fakeSteam>
  clock: { now: number }
  log: {
    debug: ReturnType<typeof vi.fn>
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
  calls: string[]
} {
  const steam = options.steam ?? fakeSteam()
  const clock = { now: 1_000_000 }
  const calls: string[] = []
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const current = options.settings ?? settingsWith(KEY, ME)
  const friends = createFriendsService({
    settings: () => current,
    log,
    getJson: steam.getJson,
    now: () => clock.now,
    closeOverlay: async () => void calls.push('close'),
    openExternal: async (uri) => void calls.push(`open ${uri}`)
  })
  return { friends, steam, clock, log, calls }
}

describe('friends service', () => {
  it('says what to set up without a key or SteamID64, asking nothing', async () => {
    const { friends, steam } = service({ settings: settingsWith('', '') })
    const status = await friends.list()
    expect(status.friends).toEqual([])
    expect(status.error).toEqual({
      code: 'no-credentials',
      message: friendsErrorText('no-credentials', tMain)
    })
    expect(steam.urls).toEqual([])
  })

  it('serves an answer under 30 s old again, and asks again after', async () => {
    const { friends, steam, clock } = service()
    const first = await friends.list()
    expect(first.friends).toHaveLength(4)
    expect(steam.urls).toHaveLength(2)
    clock.now += FRIENDS_CACHE_MS - 1
    expect(await friends.list()).toBe(first)
    expect(steam.urls).toHaveLength(2)
    clock.now += 1
    const second = await friends.list()
    expect(second).not.toBe(first)
    expect(second.fetchedAt).toBe(clock.now)
    expect(steam.urls).toHaveLength(4)
  })

  it('asks again on Refresh, cache or not', async () => {
    const { friends, steam } = service()
    await friends.list()
    await friends.list({ refresh: true })
    expect(steam.urls).toHaveLength(4)
  })

  it('shares one request between calls made while it runs', async () => {
    const { friends, steam } = service()
    const [a, b] = await Promise.all([friends.list(), friends.list({ refresh: true })])
    expect(a).toBe(b)
    expect(steam.urls).toHaveLength(2)
  })

  it('answers a private list plainly and never logs the key', async () => {
    const err = new HttpError('HTTP 401 from https://api.steampowered.com/?key=***', {
      status: 401,
      url: `https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${KEY}`
    })
    const { friends, log } = service({ steam: fakeSteam({ error: err }) })
    const status = await friends.list()
    expect(status.error).toEqual({ code: 'private', message: friendsErrorText('private', tMain) })
    expect(status.friends).toEqual([])
    const logged = JSON.stringify([log.warn.mock.calls, log.error.mock.calls, log.info.mock.calls])
    expect(logged).toContain('HTTP 401')
    expect(logged).not.toContain(KEY)
    expect(logged).not.toContain('api.steampowered.com')
  })

  it('keeps the friends already read when Steam cannot be reached', async () => {
    let fail = false
    const steam = fakeSteam()
    const flaky: GetJson = async (url) => {
      if (fail) throw new TypeError('fetch failed')
      return steam.getJson(url)
    }
    const { friends, clock } = service({ steam: { getJson: flaky, urls: steam.urls } })
    const good = await friends.list()
    fail = true
    clock.now += FRIENDS_CACHE_MS
    const status = await friends.list()
    expect(status.error).toEqual({ code: 'network', message: friendsErrorText('network', tMain) })
    expect(status.friends).toEqual(good.friends)
    expect(status.fetchedAt).toBe(good.fetchedAt)
  })

  it('still serves the cache for 30 s after a network error keeps the older list', async () => {
    let fail = false
    let asked = 0
    const steam = fakeSteam()
    const flaky: GetJson = async (url) => {
      asked++
      if (fail) throw new TypeError('fetch failed')
      return steam.getJson(url)
    }
    const { friends, clock } = service({ steam: { getJson: flaky, urls: steam.urls } })
    const good = await friends.list()
    expect(asked).toBe(2)
    fail = true
    clock.now += FRIENDS_CACHE_MS
    const failed = await friends.list()
    expect(asked).toBe(3)
    expect(failed.fetchedAt).toBe(good.fetchedAt)
    clock.now += FRIENDS_CACHE_MS - 1
    expect(await friends.list()).toBe(failed)
    expect(asked).toBe(3)
    clock.now += 1
    await friends.list()
    expect(asked).toBe(4)
  })

  it('opens Steam chat for a SteamID64 only, after closing the overlay', async () => {
    const { friends, calls } = service()
    await friends.message(id(1))
    expect(calls).toEqual(['close', `open steam://friends/message/${id(1)}`])
    for (const bad of ['', '123', `${id(1)}0`, 'steam://run/1', `${id(1)}/../x`, 42]) {
      await expect(friends.message(bad as string)).rejects.toThrow('Not a SteamID64')
    }
    expect(calls).toHaveLength(2)
  })
})
