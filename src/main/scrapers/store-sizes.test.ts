import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
// Rate limiting is covered by http.test.ts; here it would only slow the suite down.
vi.mock('./http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http')>()
  return {
    ...actual,
    RateLimiter: class {
      take(): Promise<void> {
        return Promise.resolve()
      }
    }
  }
})

import { HttpError } from './http'
import {
  gogInstallerBytes,
  gogInstallSize,
  sameGameKey,
  steamAppIdByTitle,
  steamcmdInstallSize,
  steamInstallBytes
} from './store-sizes'

type Depots = Parameters<typeof steamInstallBytes>[0]

/** A depot as api.steamcmd.net lists it: a public manifest with its installed size as a string. */
function depot(size: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifests: {
      public: { gid: '7146186447519000000', size: String(size), download: String(size / 2) }
    },
    ...fields
  }
}

// Shaped like api.steamcmd.net/v1/info/620 (Portal 2): the content depot, a Windows binaries depot, Mac and Linux
// binaries, per-language voice depots, the DLC depot, an optional depot and the shared redistributables.
const PORTAL_2_DEPOTS: Depots = {
  '621': depot(11_200_000_000),
  '622': depot(320_000_000, { config: { oslist: 'windows' } }),
  '623': depot(330_000_000, { config: { oslist: 'macos' } }),
  '624': depot(310_000_000, { config: { oslist: 'linux' } }),
  '625': depot(450_000_000, { config: { language: 'french' } }),
  '626': depot(460_000_000, { config: { language: 'german' } }),
  '627': depot(5_000_000, { config: { language: 'english' } }),
  '629': depot(900_000_000, { dlcappid: '644' }),
  '630': depot(1_000_000_000, { optional: '1' }),
  '228988': { depotfromapp: '228980', sharedinstall: '1', config: { oslist: 'windows' } },
  '228990': depot(102_000_000, { depotfromapp: '228980', sharedinstall: '1' }),
  branches: { public: { buildid: '18452730', timeupdated: '1790187113' } },
  baselanguages: 'english',
  workshopdepot: '620',
  privatebranches: '1'
}
const PORTAL_2_BYTES = 11_200_000_000 + 320_000_000 + 5_000_000

function stubFetch(routes: Record<string, { status: number; body?: unknown }>): { urls: string[] } {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input)
      urls.push(url)
      const key = Object.keys(routes).find((k) => url.startsWith(k))
      if (!key) return new Response('not found', { status: 404 })
      const { status, body } = routes[key]
      return new Response(
        body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
        { status, headers: { 'content-type': 'application/json' } }
      )
    })
  )
  return { urls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('steamInstallBytes', () => {
  it('adds up the Windows English base-game depots of a Portal 2-like app', () => {
    expect(steamInstallBytes(PORTAL_2_DEPOTS)).toBe(PORTAL_2_BYTES)
  })

  it('counts a depot without oslist or language for every system', () => {
    expect(steamInstallBytes({ '1': depot(100) })).toBe(100)
    expect(steamInstallBytes({ '1': depot(100, { config: {} }) })).toBe(100)
    expect(steamInstallBytes({ '1': depot(100, { config: { oslist: '', language: '' } }) })).toBe(
      100
    )
  })

  it('keeps depots that list Windows among other systems', () => {
    expect(
      steamInstallBytes({
        '1': depot(100, { config: { oslist: 'windows,macos,linux' } }),
        '2': depot(50, { config: { oslist: 'macos,linux' } })
      })
    ).toBe(100)
  })

  it('leaves out DLC, optional, shared and low-violence depots', () => {
    expect(
      steamInstallBytes({
        '1': depot(1000),
        '2': depot(10, { dlcappid: '12345' }),
        '3': depot(20, { optional: '1' }),
        '4': depot(30, { sharedinstall: '1' }),
        '5': depot(40, { depotfromapp: '228980', sharedinstall: '1' }),
        '6': depot(50, { config: { lowviolence: '1' } })
      })
    ).toBe(1000)
  })

  it("leaves out the Steam Deck's own build", () => {
    // INDIKA (1373960), 2026-11-05: the game and its Deck build, about the same size.
    expect(
      steamInstallBytes({
        '1373961': depot(52_160_000_000),
        '1373962': depot(52_130_000_000, { config: { steamdeck: '1' } })
      })
    ).toBe(52_160_000_000)
  })

  it('counts only the Windows depot when unmarked depots of about its size are other copies of the game', () => {
    // Black Desert (582660), 2026-11-05: Steam installs 582661 (88.14 GiB); the eight unmarked depots are other
    // versions of the client, 62-97 GB each.
    const gb = 1e9
    expect(
      steamInstallBytes({
        '582661': depot(94.64 * gb, { config: { oslist: 'windows' } }),
        '582662': depot(85.51 * gb),
        '582663': depot(62.23 * gb),
        '582664': depot(62.19 * gb),
        '582665': depot(87.06 * gb),
        '582666': depot(92.48 * gb),
        '582667': depot(96.77 * gb),
        '582668': depot(86.39 * gb),
        '582669': depot(94.89 * gb),
        '228985': depot(1, { config: { oslist: 'windows' }, sharedinstall: '1' })
      })
    ).toBe(94.64 * gb)
  })

  it('keeps unmarked content depots much larger than a small Windows program depot', () => {
    // Call of Duty: Modern Warfare Remastered - Multiplayer (393100), 2026-11-05.
    const gb = 2 ** 30
    expect(
      steamInstallBytes({
        '393101': depot(0.03 * gb, { config: { oslist: 'windows' } }),
        '393102': depot(19.6 * gb),
        '393103': depot(4.6 * gb),
        '393104': depot(1.73 * gb, { config: { language: 'english' } }),
        '393105': depot(1.74 * gb, { config: { language: 'french' } }),
        '393117': depot(34.93 * gb)
      })
    ).toBe((0.03 + 19.6 + 4.6 + 1.73 + 34.93) * gb)
  })

  it('keeps a single unmarked content depot, and unmarked parts of mixed sizes', () => {
    expect(
      steamInstallBytes({
        '1': depot(80, { config: { oslist: 'windows' } }),
        '2': depot(90)
      })
    ).toBe(170)
    expect(
      steamInstallBytes({
        '1': depot(80, { config: { oslist: 'windows' } }),
        '2': depot(90),
        '3': depot(5)
      })
    ).toBe(175)
  })

  it('is undefined when a Windows English depot is borrowed from another app', () => {
    // The borrowed content lists no size here: the sum would be a fraction of the install.
    expect(
      steamInstallBytes({ '1': depot(1000), '2': depot(40, { depotfromapp: '228980' }) })
    ).toBeUndefined()
    expect(
      steamInstallBytes({
        '1': depot(1000),
        '2': { depotfromapp: '228980', config: { oslist: 'windows', language: 'english' } }
      })
    ).toBeUndefined()
  })

  it('still counts a game whose only borrowed depots are shared redistributables', () => {
    expect(
      steamInstallBytes({
        '1': depot(1000),
        '2': { depotfromapp: '228980', sharedinstall: '1', config: { oslist: 'windows' } }
      })
    ).toBe(1000)
  })

  it('ignores a borrowed depot that a Windows English install would not get anyway', () => {
    expect(
      steamInstallBytes({
        '1': depot(1000),
        '2': depot(10, { depotfromapp: '9', config: { oslist: 'linux' } }),
        '3': depot(10, { depotfromapp: '9', config: { language: 'german' } }),
        '4': depot(10, { depotfromapp: '9', dlcappid: '12' }),
        '5': depot(10, { depotfromapp: '9', optional: '1' }),
        '6': depot(10, { depotfromapp: '9', config: { lowviolence: '1' } })
      })
    ).toBe(1000)
  })

  it('keeps depots whose flags are explicitly off', () => {
    expect(
      steamInstallBytes({
        '1': depot(1000, { optional: '0', sharedinstall: '0', config: { lowviolence: '0' } })
      })
    ).toBe(1000)
  })

  it('takes only English among language depots', () => {
    expect(
      steamInstallBytes({
        '1': depot(1000),
        '2': depot(200, { config: { language: 'english' } }),
        '3': depot(300, { config: { language: 'japanese' } }),
        '4': depot(400, { config: { language: 'schinese' } })
      })
    ).toBe(1200)
  })

  it('prefers the 64-bit depots over the 32-bit ones when a game ships both', () => {
    expect(
      steamInstallBytes({
        '1': depot(5000),
        '2': depot(300, { config: { oslist: 'windows', osarch: '32' } }),
        '3': depot(400, { config: { oslist: 'windows', osarch: '64' } })
      })
    ).toBe(5400)
  })

  it('keeps a 32-bit depot when there is no 64-bit one', () => {
    expect(
      steamInstallBytes({
        '1': depot(5000),
        '2': depot(300, { config: { oslist: 'windows', osarch: '32' } })
      })
    ).toBe(5300)
  })

  it('does not let a Mac 64-bit depot drop the Windows 32-bit one', () => {
    expect(
      steamInstallBytes({
        '1': depot(300, { config: { oslist: 'windows', osarch: '32' } }),
        '2': depot(400, { config: { oslist: 'macos', osarch: '64' } })
      })
    ).toBe(300)
  })

  it('skips depots without a usable public manifest size', () => {
    expect(
      steamInstallBytes({
        '1': depot(1000),
        '2': { manifests: { public: '7146186447519000000' } },
        '3': { manifests: {} },
        '4': {},
        '5': depot(0),
        '6': { manifests: { public: { gid: '1', size: 'lots' } } },
        '7': 'not a depot',
        '8': null
      })
    ).toBe(1000)
    // A number instead of a string is read too.
    expect(steamInstallBytes({ '1': { manifests: { public: { size: 2048 } } } })).toBe(2048)
  })

  it('ignores keys that are not depot ids', () => {
    expect(steamInstallBytes({ branches: depot(1000), '12a': depot(5), '1': depot(7) })).toBe(7)
  })

  it('is undefined when no depot qualifies', () => {
    expect(steamInstallBytes(undefined)).toBeUndefined()
    expect(steamInstallBytes({})).toBeUndefined()
    expect(
      steamInstallBytes({
        '1': depot(100, { config: { oslist: 'linux' } }),
        '2': depot(100, { dlcappid: '9' }),
        branches: {}
      })
    ).toBeUndefined()
  })
})

describe('steamcmdInstallSize', () => {
  const INFO = 'https://api.steamcmd.net/v1/info/620'

  it('reads the depots of the requested app', async () => {
    const { urls } = stubFetch({
      [INFO]: {
        status: 200,
        body: {
          status: 'success',
          data: {
            '620': { _change_number: 1, common: { name: 'Portal 2' }, depots: PORTAL_2_DEPOTS }
          }
        }
      }
    })
    expect(await steamcmdInstallSize(620)).toBe(PORTAL_2_BYTES)
    expect(urls).toEqual([INFO])
  })

  it('is undefined when the service has no such app or no depots', async () => {
    stubFetch({ [INFO]: { status: 200, body: { status: 'success', data: { '620': {} } } } })
    expect(await steamcmdInstallSize(620)).toBeUndefined()
    stubFetch({ [INFO]: { status: 200, body: { status: 'success', data: {} } } })
    expect(await steamcmdInstallSize(620)).toBeUndefined()
    // Another app's depots are not this app's.
    stubFetch({
      [INFO]: {
        status: 200,
        body: { status: 'success', data: { '440': { depots: PORTAL_2_DEPOTS } } }
      }
    })
    expect(await steamcmdInstallSize(620)).toBeUndefined()
  })

  it('throws when the service fails', async () => {
    stubFetch({ [INFO]: { status: 403, body: 'forbidden' } })
    await expect(steamcmdInstallSize(620)).rejects.toBeInstanceOf(HttpError)
    stubFetch({ [INFO]: { status: 200, body: '<html>not json</html>' } })
    await expect(steamcmdInstallSize(620)).rejects.toBeInstanceOf(HttpError)
  })

  it("throws when the service answers with its 'failed' envelope or no status", async () => {
    stubFetch({ [INFO]: { status: 200, body: { status: 'failed', data: {} } } })
    await expect(steamcmdInstallSize(620)).rejects.toThrow(/failed/)
    // Depots alongside a non-success status are not trusted either.
    stubFetch({
      [INFO]: {
        status: 200,
        body: { status: 'failed', data: { '620': { depots: PORTAL_2_DEPOTS } } }
      }
    })
    await expect(steamcmdInstallSize(620)).rejects.toThrow(/failed/)
    stubFetch({ [INFO]: { status: 200, body: { data: { '620': { depots: PORTAL_2_DEPOTS } } } } })
    await expect(steamcmdInstallSize(620)).rejects.toThrow(/no answer/)
  })
})

/** An installer entry as api.gog.com/products/{id}?expand=downloads lists it. */
function installer(os: string, language: string, total_size: unknown): Record<string, unknown> {
  return {
    id: `installer_${os}_${language}`,
    name: 'The Witcher 3: Wild Hunt - Game of the Year Edition',
    os,
    language,
    language_full: language,
    version: '4.04',
    total_size,
    files: [{ id: `${os}_${language}_1`, size: total_size, downlink: 'https://api.gog.com/x' }]
  }
}

describe('gogInstallerBytes', () => {
  it('takes the English Windows installer when there is a choice', () => {
    expect(
      gogInstallerBytes({
        downloads: {
          installers: [
            installer('windows', 'fr', 51_000_000_000),
            installer('mac', 'en', 40_000_000_000),
            installer('windows', 'en', 50_000_000_000),
            installer('linux', 'en', 39_000_000_000)
          ]
        }
      } as Parameters<typeof gogInstallerBytes>[0])
    ).toBe(50_000_000_000)
  })

  it('falls back to the first Windows installer without an English one', () => {
    expect(
      gogInstallerBytes({
        downloads: {
          installers: [
            installer('mac', 'en', 3),
            installer('windows', 'de', 20),
            installer('windows', 'fr', 30)
          ]
        }
      } as Parameters<typeof gogInstallerBytes>[0])
    ).toBe(20)
  })

  it('ignores installers without a positive numeric size', () => {
    expect(
      gogInstallerBytes({
        downloads: {
          installers: [
            installer('windows', 'en', 0),
            installer('windows', 'en', '123'),
            installer('windows', 'de', 77)
          ]
        }
      } as Parameters<typeof gogInstallerBytes>[0])
    ).toBe(77)
  })

  it('is undefined when GOG lists no Windows installer', () => {
    expect(gogInstallerBytes(undefined)).toBeUndefined()
    expect(gogInstallerBytes(null)).toBeUndefined()
    expect(gogInstallerBytes({})).toBeUndefined()
    expect(gogInstallerBytes({ downloads: {} })).toBeUndefined()
    expect(gogInstallerBytes({ downloads: { installers: [] } })).toBeUndefined()
    expect(
      gogInstallerBytes({
        downloads: { installers: [installer('mac', 'en', 5)] }
      } as Parameters<typeof gogInstallerBytes>[0])
    ).toBeUndefined()
  })
})

describe('gogInstallSize', () => {
  const PRODUCT = 'https://api.gog.com/products/1207664663'

  it('asks for the product with its downloads and returns the installer size', async () => {
    const { urls } = stubFetch({
      [PRODUCT]: {
        status: 200,
        body: {
          id: 1207664663,
          title: 'The Witcher 3: Wild Hunt - Game of the Year Edition',
          downloads: {
            installers: [installer('windows', 'pl', 52_000), installer('windows', 'en', 50_000)]
          }
        }
      }
    })
    expect(await gogInstallSize('1207664663')).toBe(50_000)
    expect(urls).toHaveLength(1)
    const url = new URL(urls[0])
    expect(url.origin + url.pathname).toBe(PRODUCT)
    expect(url.searchParams.get('expand')).toBe('downloads')
  })

  it('is undefined for a product GOG no longer has (404), without throwing', async () => {
    stubFetch({ [PRODUCT]: { status: 404, body: { error: 'not_found' } } })
    expect(await gogInstallSize('1207664663')).toBeUndefined()
  })

  it('is undefined when the product lists no installer', async () => {
    stubFetch({
      [PRODUCT]: { status: 200, body: { id: 1207664663, downloads: { installers: [] } } }
    })
    expect(await gogInstallSize('1207664663')).toBeUndefined()
  })

  it('does not ask GOG about an id that is not a product number', async () => {
    const { urls } = stubFetch({})
    expect(await gogInstallSize('')).toBeUndefined()
    expect(await gogInstallSize('witcher3')).toBeUndefined()
    expect(await gogInstallSize('12/../34')).toBeUndefined()
    expect(urls).toEqual([])
  })

  it('throws on other failures so the caller can retry later', async () => {
    stubFetch({ [PRODUCT]: { status: 403, body: 'forbidden' } })
    const err = await gogInstallSize('1207664663').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(403)
  })
})

describe('sameGameKey', () => {
  it('drops the ™ sign', () => {
    expect(sameGameKey('DOOM Eternal™')).toBe(sameGameKey('Doom Eternal'))
    expect(sameGameKey('DOOM Eternal™')).toBe('doom eternal')
    expect(sameGameKey('Halo™®© Infinite')).toBe('halo infinite')
    expect(sameGameKey('Assassin’s Creed™ Odyssey')).toBe(sameGameKey('Assassin’s Creed Odyssey'))
  })

  it('ignores ® and © signs, case, accents and punctuation', () => {
    expect(sameGameKey('DOOM Eternal')).toBe(sameGameKey('Doom Eternal'))
    expect(sameGameKey('The Witcher® 3: Wild Hunt')).toBe('the witcher 3 wild hunt')
    expect(sameGameKey('Pokémon Café')).toBe('pokemon cafe')
    expect(sameGameKey('Half-Life: Alyx')).toBe(sameGameKey('Half Life Alyx'))
    expect(sameGameKey('  S.T.A.L.K.E.R.  ')).toBe('s t a l k e r')
    expect(sameGameKey('Tom Clancy’s The Division©')).toBe(sameGameKey("Tom Clancy's The Division"))
  })

  it('reads & as "and"', () => {
    expect(sameGameKey('Ratchet & Clank')).toBe(sameGameKey('Ratchet and Clank'))
    expect(sameGameKey('Ratchet&Clank')).toBe('ratchet and clank')
  })

  it('keeps sequels and longer names apart', () => {
    expect(sameGameKey('Hades')).not.toBe(sameGameKey('Hades II'))
    expect(sameGameKey('Portal')).not.toBe(sameGameKey('Portal 2'))
    expect(sameGameKey('Celeste')).not.toBe(sameGameKey('Celeste Soundtrack'))
  })

  it('keeps letters of other scripts', () => {
    expect(sameGameKey('ファイナルファンタジー')).not.toBe('')
  })

  it('is empty for a title of only symbols', () => {
    expect(sameGameKey('®©')).toBe('')
    expect(sameGameKey(' - : ')).toBe('')
    expect(sameGameKey('   ')).toBe('')
  })

  it('is empty for a lone ™ sign', () => {
    expect(sameGameKey('™')).toBe('')
  })
})

describe('steamAppIdByTitle', () => {
  const SEARCH = 'https://store.steampowered.com/api/storesearch/'
  const HADES_RESULTS = {
    total: 3,
    items: [
      { type: 'app', name: 'Hades II', id: 1145350 },
      { type: 'app', name: 'Hades', id: 1145360 },
      { type: 'app', name: 'Hades Original Soundtrack', id: 1306880 }
    ]
  }

  it('searches the store in English and returns the app with exactly that title', async () => {
    const { urls } = stubFetch({ [SEARCH]: { status: 200, body: HADES_RESULTS } })
    expect(await steamAppIdByTitle('Hades')).toBe(1145360)
    expect(urls).toHaveLength(1)
    const url = new URL(urls[0])
    expect(url.origin + url.pathname).toBe(SEARCH)
    expect(url.searchParams.get('term')).toBe('Hades')
    expect(url.searchParams.get('l')).toBe('english')
    expect(url.searchParams.get('cc')).toBe('US')
  })

  it('does not take a sequel or a longer name for the game', async () => {
    stubFetch({ [SEARCH]: { status: 200, body: HADES_RESULTS } })
    expect(await steamAppIdByTitle('Hades II')).toBe(1145350)
    stubFetch({
      [SEARCH]: { status: 200, body: { items: [{ type: 'app', name: 'Hades II', id: 1145350 }] } }
    })
    expect(await steamAppIdByTitle('Hades')).toBeUndefined()
    stubFetch({ [SEARCH]: { status: 200, body: HADES_RESULTS } })
    expect(await steamAppIdByTitle('Hades: Battle Out of Hell')).toBeUndefined()
  })

  it('matches across ® signs and case', async () => {
    stubFetch({
      [SEARCH]: {
        status: 200,
        body: { items: [{ type: 'app', name: 'The Witcher 3: Wild Hunt', id: 292030 }] }
      }
    })
    expect(await steamAppIdByTitle('THE WITCHER® 3: WILD HUNT')).toBe(292030)
  })

  it('matches across the ™ sign', async () => {
    stubFetch({
      [SEARCH]: {
        status: 200,
        body: { items: [{ type: 'app', name: 'DOOM Eternal', id: 782330 }] }
      }
    })
    expect(await steamAppIdByTitle('Doom Eternal™')).toBe(782330)
  })

  it('is undefined when two apps have exactly that title (a remake and its original)', async () => {
    stubFetch({
      [SEARCH]: {
        status: 200,
        body: {
          items: [
            { type: 'app', name: 'Dead Space', id: 17470 },
            { type: 'app', name: 'Dead Space™', id: 1693980 },
            { type: 'app', name: 'Dead Space 2', id: 47780 }
          ]
        }
      }
    })
    expect(await steamAppIdByTitle('Dead Space')).toBeUndefined()
    // A bundle of the same name does not make it ambiguous.
    stubFetch({
      [SEARCH]: {
        status: 200,
        body: {
          items: [
            { type: 'bundle', name: 'Dead Space', id: 1 },
            { type: 'app', name: 'Dead Space', id: 17470 }
          ]
        }
      }
    })
    expect(await steamAppIdByTitle('Dead Space')).toBe(17470)
  })

  it('only counts apps, not bundles or packages', async () => {
    stubFetch({
      [SEARCH]: {
        status: 200,
        body: {
          items: [
            { type: 'sub', name: 'Hades', id: 1 },
            { type: 'bundle', name: 'Hades', id: 2 },
            { type: 'app', name: 'Hades' },
            { type: 'app', name: 'Hades', id: 1145360 }
          ]
        }
      }
    })
    expect(await steamAppIdByTitle('Hades')).toBe(1145360)
  })

  it('is undefined when Steam finds nothing', async () => {
    stubFetch({ [SEARCH]: { status: 200, body: { total: 0, items: [] } } })
    expect(await steamAppIdByTitle('Some Epic Exclusive')).toBeUndefined()
    stubFetch({ [SEARCH]: { status: 200, body: {} } })
    expect(await steamAppIdByTitle('Some Epic Exclusive')).toBeUndefined()
  })

  it('does not search for a title that reduces to nothing', async () => {
    const { urls } = stubFetch({})
    expect(await steamAppIdByTitle('®')).toBeUndefined()
    expect(await steamAppIdByTitle(' : ')).toBeUndefined()
    expect(await steamAppIdByTitle('')).toBeUndefined()
    expect(urls).toEqual([])
  })

  it('throws when the store fails', async () => {
    stubFetch({ [SEARCH]: { status: 403, body: 'forbidden' } })
    await expect(steamAppIdByTitle('Hades')).rejects.toBeInstanceOf(HttpError)
  })
})
