import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { Settings } from '../../shared/types'
import { loginsToFill, loginsToShare, SHARED_LOGINS } from './host-logins'

/** The logins a host shares with its paired computers, and what a client takes from them. */

type Scrapers = Settings['scrapers']

/** Default (empty) scrapers with some services' fields set. */
function scrapers(set: Record<string, Record<string, unknown>> = {}): Scrapers {
  const s = defaultSettings().scrapers as unknown as Record<string, Record<string, unknown>>
  for (const [service, fields] of Object.entries(set)) s[service] = { ...s[service], ...fields }
  return s as unknown as Scrapers
}

describe('loginsToShare', () => {
  it('shares nothing when no login is set', () => {
    expect(loginsToShare(scrapers())).toEqual({})
  })

  it('shares only the services with a field set, each with all its fields', () => {
    const shared = loginsToShare(
      scrapers({
        steamgriddb: { apiKey: 'fake-key-1' },
        screenscraper: { user: 'fake-user' },
        retroachievements: { username: 'fake-ra', apiKey: 'fake-key-2' }
      })
    )
    expect(Object.keys(shared).sort()).toEqual([
      'retroachievements',
      'screenscraper',
      'steamgriddb'
    ])
    expect(shared.steamgriddb).toEqual({ apiKey: 'fake-key-1' })
    expect(shared.screenscraper).toEqual({
      devId: '',
      devPassword: '',
      user: 'fake-user',
      password: ''
    })
    expect(shared.retroachievements).toEqual({ username: 'fake-ra', apiKey: 'fake-key-2' })
  })

  it('sends only the shared fields, trimmed; blank-only values count as unset', () => {
    const shared = loginsToShare(
      scrapers({
        igdb: { clientId: '  fake-id  ', clientSecret: 'fake-secret', enabled: true },
        thegamesdb: { apiKey: '   ' }
      })
    )
    expect(shared).toEqual({ igdb: { clientId: 'fake-id', clientSecret: 'fake-secret' } })
  })
})

describe('loginsToFill', () => {
  it('fills only the services this PC has no login for', () => {
    const { patch, filled } = loginsToFill(scrapers({ steamgriddb: { apiKey: 'my-fake-key' } }), {
      steamgriddb: { apiKey: 'fake-key-1' },
      thegamesdb: { apiKey: 'fake-key-2' }
    })
    expect(filled).toEqual(['thegamesdb'])
    expect(patch).toEqual({ thegamesdb: { apiKey: 'fake-key-2' } })
  })

  it('never overwrites a partly set service', () => {
    const { patch, filled } = loginsToFill(
      scrapers({ screenscraper: { user: 'my-user' }, igdb: { clientSecret: 'mine' } }),
      {
        screenscraper: { devId: 'd', devPassword: 'p', user: 'their-user', password: 'pw' },
        igdb: { clientId: 'fake-id', clientSecret: 'fake-secret' }
      }
    )
    expect(filled).toEqual([])
    expect(patch).toEqual({})
  })

  it('fills missing fields of a taken service with empty strings (the whole service as a unit)', () => {
    const { patch } = loginsToFill(scrapers(), { screenscraper: { user: 'fake-user' } })
    expect(patch).toEqual({
      screenscraper: { devId: '', devPassword: '', user: 'fake-user', password: '' }
    })
  })

  it('copies Steam as a unit: both the API key and the SteamID64', () => {
    const { patch, filled } = loginsToFill(scrapers(), {
      steam: { apiKey: 'fake-key-1', steamId64: '76561190000000000' }
    })
    expect(filled).toEqual(['steam'])
    expect(patch).toEqual({ steam: { apiKey: 'fake-key-1', steamId64: '76561190000000000' } })
    // A PC with only its own SteamID64 keeps its Steam login whole: the host's key is not mixed in.
    expect(
      loginsToFill(scrapers({ steam: { steamId64: '76561190000000001' } }), {
        steam: { apiKey: 'fake-key-1', steamId64: '76561190000000000' }
      })
    ).toEqual({ patch: {}, filled: [] })
  })

  it('trims what it takes', () => {
    const { patch } = loginsToFill(scrapers(), {
      retroachievements: { username: '  fake-ra ', apiKey: '\tfake-key-1\n' }
    })
    expect(patch).toEqual({ retroachievements: { username: 'fake-ra', apiKey: 'fake-key-1' } })
  })

  it('rejects an answer that is not an object', () => {
    for (const bad of [null, undefined, 'fake-key-1', 42, true, [], [{ steamgriddb: {} }]]) {
      expect(loginsToFill(scrapers(), bad)).toEqual({ patch: {}, filled: [] })
    }
  })

  it('rejects a service that is not an object or has a field of the wrong type', () => {
    const { patch, filled } = loginsToFill(scrapers(), {
      steamgriddb: 'fake-key-1',
      thegamesdb: ['fake-key-2'],
      igdb: { clientId: 123, clientSecret: 'fake-secret' },
      steam: { apiKey: 'fake-key-3', steamId64: 76561190000000000 },
      retroachievements: { username: 'fake-ra', apiKey: { nested: 'x' } },
      screenscraper: { user: 'fake-user' }
    })
    expect(filled).toEqual(['screenscraper'])
    expect(Object.keys(patch)).toEqual(['screenscraper'])
  })

  it('rejects over-long values (more than 500 characters) and takes 500', () => {
    const { filled } = loginsToFill(scrapers(), {
      steamgriddb: { apiKey: 'k'.repeat(501) },
      thegamesdb: { apiKey: 'k'.repeat(500) }
    })
    expect(filled).toEqual(['thegamesdb'])
  })

  it("skips a service the Settings schema would refuse (Steam's SteamID64, the RA username)", () => {
    const { patch, filled } = loginsToFill(scrapers(), {
      steam: { apiKey: 'fake-key-1', steamId64: '7'.repeat(33) },
      retroachievements: { username: 'u'.repeat(101), apiKey: 'fake-key-2' },
      thegamesdb: { apiKey: 'fake-key-3' }
    })
    expect(filled).toEqual(['thegamesdb'])
    expect(patch).toEqual({ thegamesdb: { apiKey: 'fake-key-3' } })
    // At the limits they are taken.
    expect(
      loginsToFill(scrapers(), {
        steam: { apiKey: 'fake-key-1', steamId64: '7'.repeat(32) },
        retroachievements: { username: 'u'.repeat(100), apiKey: 'fake-key-2' }
      }).filled
    ).toEqual(['steam', 'retroachievements'])
  })

  it('ignores unknown services and unknown extra fields', () => {
    const { patch, filled } = loginsToFill(scrapers(), {
      mobygames: { apiKey: 'fake-key-1' },
      steamgriddb: { apiKey: 'fake-key-3', extra: 'x'.repeat(1000), enabled: 5 }
    })
    expect(filled).toEqual(['steamgriddb'])
    expect(patch).toEqual({ steamgriddb: { apiKey: 'fake-key-3' } })
    expect(patch).not.toHaveProperty('mobygames')
  })

  it('takes nothing from a service whose fields are all blank', () => {
    expect(loginsToFill(scrapers(), { steamgriddb: { apiKey: '   ' }, thegamesdb: {} })).toEqual({
      patch: {},
      filled: []
    })
  })

  it('round-trips: a client takes everything a host shares when it has nothing', () => {
    const host = scrapers({
      steamgriddb: { apiKey: 'fake-key-1' },
      igdb: { clientId: 'fake-id', clientSecret: 'fake-secret' },
      steam: { apiKey: 'fake-key-2', steamId64: '76561190000000000' }
    })
    const { patch, filled } = loginsToFill(
      scrapers(),
      JSON.parse(JSON.stringify(loginsToShare(host)))
    )
    expect(filled.sort()).toEqual(['igdb', 'steam', 'steamgriddb'])
    expect(patch).toEqual(loginsToShare(host))
    expect(Object.keys(SHARED_LOGINS)).toHaveLength(6)
  })
})
