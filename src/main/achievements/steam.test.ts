import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
// Rate limiting is covered by http.test.ts; here it would only slow the suite down.
vi.mock('../scrapers/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scrapers/http')>()
  return {
    ...actual,
    RateLimiter: class {
      take(): Promise<void> {
        return Promise.resolve()
      }
    }
  }
})

import {
  PROGRESS_BATCH,
  SteamAuthError,
  steamAchievementCount,
  steamAchievementsProgress,
  steamAchievementsWithToken,
  steamGameAchievements
} from './steam'

interface Route {
  status: number
  body?: unknown
  contentType?: string
}

interface Call {
  url: string
  method: string
  headers: Headers
  body?: string
}

/** fetch stub keyed by URL prefix; records every request with its body. */
function stubFetch(routes: Record<string, Route | ((call: Call) => Route)>): { calls: Call[] } {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const call: Call = {
        url: String(input),
        method: (init.method ?? 'GET').toUpperCase(),
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? init.body : undefined
      }
      calls.push(call)
      const key = Object.keys(routes).find((k) => call.url.startsWith(k))
      if (!key) return new Response('not found', { status: 404 })
      const route = routes[key]
      const r = typeof route === 'function' ? route(call) : route
      return new Response(
        r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
        { status: r.status, headers: { 'content-type': r.contentType ?? 'application/json' } }
      )
    })
  )
  return { calls }
}

const STEAM_ID = '76561198000000101'
const TOKEN = { steamId64: STEAM_ID, accessToken: 'TOKEN123' }
const PROGRESS = 'https://api.steampowered.com/IPlayerService/GetAchievementsProgress/v1/'
const GAME_ACHIEVEMENTS = 'https://api.steampowered.com/IPlayerService/GetGameAchievements/v1/'
const TOP_ACHIEVEMENTS =
  'https://api.steampowered.com/IPlayerService/GetTopAchievementsForGames/v1/'
const STORE_DETAILS = 'https://store.steampowered.com/api/appdetails'
const COMMUNITY = `https://steamcommunity.com/profiles/${STEAM_ID}/stats/620/achievements/`
const ICONS = 'https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/620'

function progressBody(rows: { appid: number; unlocked: number; total: number }[]): Route {
  return { status: 200, body: { response: { achievement_progress: rows } } }
}

/** Three live achievements plus an archived one, shaped like GetGameAchievements for app 620. */
const DEFS: Route = {
  status: 200,
  body: {
    response: {
      achievements: [
        {
          internal_name: 'ACH.WAKE_UP',
          localized_name: 'Wake Up Call',
          localized_desc: 'Survive the manual override',
          icon: 'aaa111.jpg',
          icon_gray: 'aaa111_gray.jpg',
          hidden: false
        },
        {
          internal_name: 'ACH.LASER',
          localized_name: ' Undiscouraged ',
          localized_desc: '',
          icon: 'bbb222.jpg',
          icon_gray: 'bbb222_gray.jpg',
          hidden: true
        },
        {
          internal_name: 'ACH.BRIDGE',
          localized_name: 'Bridge Over Troubling Water',
          icon: 'ccc333.jpg',
          icon_gray: 'ccc333_gray.jpg'
        },
        {
          internal_name: 'ACH.OLD',
          localized_name: 'Retired',
          icon: 'ddd444.jpg',
          archived: true
        },
        { localized_name: 'No internal name', icon: 'eee555.jpg' }
      ]
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('steamAchievementsProgress', () => {
  it('POSTs a form with the access token, steam id and indexed app ids, and maps the rows', async () => {
    const stub = stubFetch({
      [PROGRESS]: progressBody([
        { appid: 620, unlocked: 3, total: 51 },
        { appid: 400, unlocked: 0, total: 15 },
        { appid: 0, unlocked: 1, total: 1 }
      ])
    })
    const out = await steamAchievementsProgress([620, 400], TOKEN)
    expect([...out]).toEqual([
      [620, { unlocked: 3, total: 51 }],
      [400, { unlocked: 0, total: 15 }]
    ])
    expect(stub.calls).toHaveLength(1)
    const call = stub.calls[0]
    expect(call.url).toBe(PROGRESS)
    expect(call.method).toBe('POST')
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(call.body)
    expect(form.get('access_token')).toBe('TOKEN123')
    expect(form.has('key')).toBe(false)
    expect(form.get('steamid')).toBe(STEAM_ID)
    expect(form.get('appids[0]')).toBe('620')
    expect(form.get('appids[1]')).toBe('400')
    // The credential never travels in the URL.
    expect(call.url).not.toContain('TOKEN123')
  })

  it('sends the Web API key instead of a token when given one', async () => {
    const stub = stubFetch({ [PROGRESS]: progressBody([]) })
    await steamAchievementsProgress([10], { steamId64: STEAM_ID, key: 'KEY123' })
    const form = new URLSearchParams(stub.calls[0].body)
    expect(form.get('key')).toBe('KEY123')
    expect(form.has('access_token')).toBe(false)
    expect(form.get('steamid')).toBe(STEAM_ID)
  })

  it('splits the app ids into batches of PROGRESS_BATCH, indexing each batch from 0', async () => {
    const ids = Array.from({ length: PROGRESS_BATCH * 2 + 5 }, (_, i) => i + 1)
    const stub = stubFetch({
      [PROGRESS]: (call) => {
        const form = new URLSearchParams(call.body)
        const rows = [...form.entries()]
          .filter(([k]) => k.startsWith('appids['))
          .map(([, v]) => ({ appid: Number(v), unlocked: 1, total: 2 }))
        return progressBody(rows)
      }
    })
    const out = await steamAchievementsProgress(ids, TOKEN)
    expect(stub.calls).toHaveLength(3)
    const batches = stub.calls.map((c) =>
      [...new URLSearchParams(c.body).entries()].filter(([k]) => k.startsWith('appids['))
    )
    expect(batches.map((b) => b.length)).toEqual([PROGRESS_BATCH, PROGRESS_BATCH, 5])
    expect(batches[1][0]).toEqual(['appids[0]', String(PROGRESS_BATCH + 1)])
    expect(batches[2][4]).toEqual(['appids[4]', String(ids.length)])
    expect(out.size).toBe(ids.length)
  })

  it('makes no request for an empty list', async () => {
    const stub = stubFetch({})
    expect((await steamAchievementsProgress([], TOKEN)).size).toBe(0)
    expect(stub.calls).toHaveLength(0)
  })

  it.each([401, 403])('throws SteamAuthError when Steam answers %i', async (status) => {
    stubFetch({ [PROGRESS]: { status, body: 'Unauthorized' } })
    await expect(steamAchievementsProgress([620], TOKEN)).rejects.toBeInstanceOf(SteamAuthError)
  })

  it('rethrows other HTTP failures unchanged', async () => {
    stubFetch({ [PROGRESS]: { status: 404, body: 'gone' } })
    const err = await steamAchievementsProgress([620], TOKEN).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(SteamAuthError)
    expect((err as { status?: number }).status).toBe(404)
  })
})

describe('steamAchievementsWithToken', () => {
  it('merges the definitions with the top-achievements unlocks, by icon file then by name', async () => {
    const stub = stubFetch({
      [GAME_ACHIEVEMENTS]: DEFS,
      [PROGRESS]: progressBody([{ appid: 620, unlocked: 2, total: 3 }]),
      [TOP_ACHIEVEMENTS]: {
        status: 200,
        body: {
          response: {
            games: [
              {
                appid: 620,
                total_achievements: 3,
                achievements: [
                  // Matched by icon file name though the name differs.
                  { name: 'Renamed', icon: `${ICONS}/AAA111.jpg` },
                  // No icon match: matched by trimmed, case-folded name.
                  { name: 'undiscouraged', icon: 'unknown.jpg' }
                ]
              }
            ]
          }
        }
      }
    })
    const info = await steamAchievementsWithToken(620, TOKEN)
    expect(info).toEqual({
      provider: 'steam',
      total: 3,
      unlocked: 2,
      list: [
        {
          id: 'ACH.WAKE_UP',
          name: 'Wake Up Call',
          description: 'Survive the manual override',
          unlocked: true,
          unlockedAt: undefined,
          icon: `${ICONS}/aaa111.jpg`,
          hidden: false
        },
        {
          id: 'ACH.LASER',
          name: 'Undiscouraged',
          description: undefined,
          unlocked: true,
          unlockedAt: undefined,
          icon: `${ICONS}/bbb222.jpg`,
          hidden: true
        },
        {
          id: 'ACH.BRIDGE',
          name: 'Bridge Over Troubling Water',
          description: undefined,
          unlocked: false,
          unlockedAt: undefined,
          icon: `${ICONS}/ccc333_gray.jpg`,
          hidden: false
        }
      ]
    })
    const defsUrl = new URL(stub.calls[0].url)
    expect(defsUrl.searchParams.get('appid')).toBe('620')
    expect(defsUrl.searchParams.has('access_token')).toBe(false)
    const top = stub.calls.find((c) => c.url.startsWith(TOP_ACHIEVEMENTS))!
    const topUrl = new URL(top.url)
    expect(topUrl.searchParams.get('access_token')).toBe('TOKEN123')
    expect(topUrl.searchParams.get('steamid')).toBe(STEAM_ID)
    expect(topUrl.searchParams.get('appids[0]')).toBe('620')
    expect(topUrl.searchParams.get('max_achievements')).toBe('3')
    // The full list matched the progress count: no community fallback.
    expect(stub.calls.some((c) => c.url.startsWith('https://steamcommunity.com'))).toBe(false)
  })

  it('skips the unlock lookups when the player has none', async () => {
    const stub = stubFetch({
      [GAME_ACHIEVEMENTS]: DEFS,
      [PROGRESS]: progressBody([{ appid: 620, unlocked: 0, total: 3 }])
    })
    const info = await steamAchievementsWithToken(620, TOKEN)
    expect(info?.unlocked).toBe(0)
    expect(info?.list.every((a) => !a.unlocked)).toBe(true)
    expect(stub.calls.map((c) => c.url.split('?')[0])).toEqual([GAME_ACHIEVEMENTS, PROGRESS])
  })

  it('reads the public stats page, with unlock times, when the top list is short of the count', async () => {
    const stub = stubFetch({
      [GAME_ACHIEVEMENTS]: DEFS,
      [PROGRESS]: progressBody([{ appid: 620, unlocked: 3, total: 3 }]),
      [TOP_ACHIEVEMENTS]: {
        status: 200,
        body: {
          response: { games: [{ appid: 620, achievements: [{ name: 'x', icon: 'aaa111.jpg' }] }] }
        }
      },
      [COMMUNITY]: {
        status: 200,
        contentType: 'text/xml',
        body: `<?xml version="1.0" encoding="UTF-8"?>
<playerstats>
  <achievements>
    <achievement closed="1"><apiname>ach.wake_up</apiname><unlockTimestamp>1303084800</unlockTimestamp></achievement>
    <achievement closed="1"><apiname>ACH.LASER</apiname><unlockTimestamp>1303171200</unlockTimestamp></achievement>
    <achievement closed="1"><apiname>ACH.BRIDGE</apiname></achievement>
    <achievement closed="0"><apiname>ACH.OLD</apiname></achievement>
  </achievements>
</playerstats>`
      }
    })
    const info = await steamAchievementsWithToken(620, TOKEN)
    expect(info?.unlocked).toBe(3)
    expect(info?.list.map((a) => [a.id, a.unlocked, a.unlockedAt])).toEqual([
      ['ACH.WAKE_UP', true, '2011-04-18T00:00:00.000Z'],
      ['ACH.LASER', true, '2011-04-19T00:00:00.000Z'],
      ['ACH.BRIDGE', true, undefined]
    ])
    const community = stub.calls.find((c) => c.url.startsWith(COMMUNITY))!
    expect(new URL(community.url).searchParams.get('xml')).toBe('1')
    expect(community.url).not.toContain('TOKEN123')
  })

  it('keeps the unlocked count from progress when the list stays short (private profile)', async () => {
    stubFetch({
      [GAME_ACHIEVEMENTS]: DEFS,
      [PROGRESS]: progressBody([{ appid: 620, unlocked: 2, total: 3 }]),
      [TOP_ACHIEVEMENTS]: {
        status: 200,
        body: {
          response: { games: [{ appid: 620, achievements: [{ name: 'x', icon: 'aaa111.jpg' }] }] }
        }
      },
      [COMMUNITY]: {
        status: 200,
        contentType: 'text/xml',
        body: '<?xml version="1.0"?><response><error>This profile is private.</error></response>'
      }
    })
    const info = await steamAchievementsWithToken(620, TOKEN)
    expect(info?.total).toBe(3)
    expect(info?.list.filter((a) => a.unlocked).map((a) => a.id)).toEqual(['ACH.WAKE_UP'])
    expect(info?.unlocked).toBe(2)
  })

  it('survives a failing stats page and never counts more unlocks than the list has', async () => {
    stubFetch({
      [GAME_ACHIEVEMENTS]: DEFS,
      // Archived achievements count in progress but not in the list.
      [PROGRESS]: progressBody([{ appid: 620, unlocked: 4, total: 4 }]),
      [TOP_ACHIEVEMENTS]: { status: 200, body: { response: { games: [] } } },
      [COMMUNITY]: { status: 500, body: 'oops' }
    })
    const info = await steamAchievementsWithToken(620, TOKEN)
    expect(info?.unlocked).toBe(3)
    expect(info?.list.some((a) => a.unlocked)).toBe(false)
  })

  it('returns null when the game has no (live) achievement definitions', async () => {
    const stub = stubFetch({
      [GAME_ACHIEVEMENTS]: {
        status: 200,
        body: { response: { achievements: [{ internal_name: 'A', archived: true }] } }
      }
    })
    expect(await steamAchievementsWithToken(620, TOKEN)).toBeNull()
    stubFetch({ [GAME_ACHIEVEMENTS]: { status: 200, body: { response: {} } } })
    expect(await steamAchievementsWithToken(620, TOKEN)).toBeNull()
    // No progress request once the definitions are empty.
    expect(stub.calls.map((c) => c.url.split('?')[0])).toEqual([GAME_ACHIEVEMENTS])
  })

  it('throws SteamAuthError when the top-achievements call is refused', async () => {
    stubFetch({
      [GAME_ACHIEVEMENTS]: DEFS,
      [PROGRESS]: progressBody([{ appid: 620, unlocked: 1, total: 3 }]),
      [TOP_ACHIEVEMENTS]: { status: 401, body: 'Unauthorized' }
    })
    await expect(steamAchievementsWithToken(620, TOKEN)).rejects.toBeInstanceOf(SteamAuthError)
  })
})

describe('steamGameAchievements', () => {
  it('uses the ISteamUserStats key path when given a Web API key', async () => {
    const stub = stubFetch({
      'https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/': {
        status: 200,
        body: {
          game: {
            availableGameStats: {
              achievements: [
                {
                  name: 'ACH.WAKE_UP',
                  displayName: 'Wake Up Call',
                  hidden: 0,
                  icon: 'https://cdn/a.jpg',
                  icongray: 'https://cdn/a_gray.jpg'
                }
              ]
            }
          }
        }
      },
      'https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/': {
        status: 200,
        body: {
          playerstats: {
            achievements: [{ apiname: 'ACH.WAKE_UP', achieved: 1, unlocktime: 1303084800 }],
            success: true
          }
        }
      }
    })
    const info = await steamGameAchievements(620, { steamId64: STEAM_ID, key: 'KEY123' })
    expect(info).toMatchObject({
      provider: 'steam',
      total: 1,
      unlocked: 1,
      list: [{ id: 'ACH.WAKE_UP', unlocked: true, unlockedAt: '2011-04-18T00:00:00.000Z' }]
    })
    expect(stub.calls.every((c) => c.url.includes('/ISteamUserStats/'))).toBe(true)
    expect(stub.calls.every((c) => c.url.includes('key=KEY123'))).toBe(true)
  })

  it('returns null on the key path when the game has no achievements', async () => {
    stubFetch({
      'https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/': {
        status: 200,
        body: { game: { gameName: 'No stats' } }
      }
    })
    expect(await steamGameAchievements(620, { steamId64: STEAM_ID, key: 'KEY123' })).toBeNull()
  })

  it('uses the IPlayerService token path when given an access token', async () => {
    const stub = stubFetch({
      [GAME_ACHIEVEMENTS]: DEFS,
      [PROGRESS]: progressBody([{ appid: 620, unlocked: 0, total: 3 }])
    })
    const info = await steamGameAchievements(620, TOKEN)
    expect(info).toMatchObject({ provider: 'steam', total: 3, unlocked: 0 })
    expect(stub.calls.some((c) => c.url.includes('/ISteamUserStats/'))).toBe(false)
  })
})

describe('steamAchievementCount', () => {
  it("counts the live achievements without any credential, and 0 is Steam's answer for a game without any", async () => {
    const stub = stubFetch({ [GAME_ACHIEVEMENTS]: DEFS })
    expect(await steamAchievementCount(620)).toBe(3)
    expect(stub.calls[0].url).not.toMatch(/key=|access_token=/)
    // Call of Duty: United Offensive (2640): an empty response, and the store page lists none either.
    const cod = stubFetch({
      [GAME_ACHIEVEMENTS]: { status: 200, body: { response: {} } },
      [STORE_DETAILS]: { status: 200, body: { '2640': { success: true, data: [] } } }
    })
    expect(await steamAchievementCount(2640)).toBe(0)
    expect(cod.calls[1].url).toContain('filters=achievements')
    expect(cod.calls[1].url).not.toMatch(/key=|access_token=/)
  })

  it('does not take one empty answer for "none": the store page has the last word', async () => {
    // GetGameAchievements answers empty for an app it cannot resolve right now; the store lists 51.
    stubFetch({
      [GAME_ACHIEVEMENTS]: { status: 200, body: { response: {} } },
      [STORE_DETAILS]: {
        status: 200,
        body: { '620': { success: true, data: { achievements: { total: 51 } } } }
      }
    })
    expect(await steamAchievementCount(620)).toBe(51)
    // An app the store does not know: nothing can be said.
    stubFetch({
      [GAME_ACHIEVEMENTS]: { status: 200, body: { response: {} } },
      [STORE_DETAILS]: { status: 200, body: { '9999999': { success: false } } }
    })
    expect(await steamAchievementCount(9999999)).toBeNull()
    // The store could not be asked: a failure, not "none".
    stubFetch({
      [GAME_ACHIEVEMENTS]: { status: 200, body: { response: {} } },
      [STORE_DETAILS]: { status: 503 }
    })
    await expect(steamAchievementCount(2640)).rejects.toThrow()
  })

  it('throws when Steam could not be asked, which says nothing about the game', async () => {
    stubFetch({ [GAME_ACHIEVEMENTS]: { status: 429 } })
    await expect(steamAchievementCount(2640)).rejects.toThrow()
    stubFetch({ [GAME_ACHIEVEMENTS]: { status: 200, body: {} } })
    await expect(steamAchievementCount(2640)).rejects.toThrow()
  })
})
