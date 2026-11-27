import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { defaultSettings } from '../../shared/defaults'
import {
  encodeGameDbCsv,
  GAME_DB_MAX_ROWS_PER_REQUEST,
  gameDbShardPath,
  type GameDbRow
} from '../../shared/game-database'
import type { Game, Settings } from '../../shared/types'
import {
  FLUSH_RETRY_MS,
  GameDatabaseService,
  SHARD_MAX_AGE_MS,
  SHARD_RETRY_MS,
  contributable,
  steamAliasOf
} from './service'

const BASE = 'https://raw.test/db/'
const RELAY = 'https://relay.test'

function row(key: string, overrides: Partial<GameDbRow> = {}): GameDbRow {
  return {
    key,
    title: 'Portal 2',
    platform: 'pc',
    releaseDate: '2011-04-18',
    genres: ['Puzzle'],
    tags: ['Co-op'],
    developers: ['Valve'],
    publishers: ['Valve'],
    localPlayers: 2,
    steamAppId: null,
    ...overrides
  }
}

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 'steam:620',
    source: 'steam',
    externalId: '620',
    platformId: 'steam',
    title: 'Portal 2',
    sortTitle: 'portal 2',
    installed: true,
    launch: { kind: 'uri', uri: 'steam://rungameid/620' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: { releaseDate: '2011-04-18', developers: ['Valve'], genres: ['Puzzle'] },
    media: {},
    metadataStatus: 'done',
    user: {},
    ...overrides
  } as Game
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

type Handler = (call: Call) => Response | Promise<Response>

let dir: string
let settings: Settings
let games: Map<string, Game>
let calls: Call[]
let handler: Handler
let now: number
let relayUrl: string
let service: GameDatabaseService | null

function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
}

function create(): GameDatabaseService {
  service = new GameDatabaseService({
    dir,
    library: { games: () => [...games.values()], getGame: (id) => games.get(id) },
    settings: { get: () => settings },
    relay: { relayEndpoint: () => relayUrl, installId: () => 'client1234' },
    appVersion: '1.2.3',
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    fetch: fakeFetch(),
    now: () => now,
    rawBase: BASE,
    debounceMs: 0,
    lookupTimeoutMs: 2000
  })
  return service
}

/** A raw CDN serving these shards (path -> rows), with ETags. */
function cdn(shards: Record<string, GameDbRow[]>): Handler {
  return (call) => {
    const path = call.url.slice(BASE.length)
    const rows = shards[path]
    if (!rows) return new Response('404: Not Found', { status: 404 })
    const etag = `"${path}-${rows.length}"`
    if (call.headers['If-None-Match'] === etag) return new Response(null, { status: 304 })
    return new Response(encodeGameDbCsv(rows), { status: 200, headers: { etag } })
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-gamedb-'))
  settings = defaultSettings()
  games = new Map()
  calls = []
  handler = cdn({})
  now = Date.parse('2026-11-24T12:00:00.000Z')
  relayUrl = RELAY
  service = null
})

afterEach(async () => {
  await service?.dispose()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

describe('steamAliasOf and contributable', () => {
  it('finds a non-Steam PC game by the Steam app its tags or a scraper matched', () => {
    expect(steamAliasOf(game())).toBeNull()
    const gog = game({ id: 'gog:1', source: 'gog', externalId: '1', metadata: {} })
    expect(steamAliasOf(gog)).toBeNull()
    expect(steamAliasOf({ ...gog, metadata: { steamTags: { tags: [], appId: 620 } } })).toBe(620)
    expect(steamAliasOf({ ...gog, metadata: { sources: { steam: '400' } } })).toBe(400)
    expect(
      steamAliasOf(
        game({ source: 'rom', externalId: 'snes/x.sfc', metadata: { sources: { steam: '1' } } })
      )
    ).toBeNull()
  })

  it('takes only this PC own, scraped games with facts', () => {
    expect(contributable(game())).toBe(true)
    expect(contributable(game({ remote: { hostId: 'h' } as unknown as Game['remote'] }))).toBe(
      false
    )
    expect(
      contributable(game({ source: 'manual', externalId: 'c:\\x\\x.exe', exePath: 'C:\\X\\x.exe' }))
    ).toBe(false)
    const rom = { source: 'rom' as const, platformId: 'n64', externalId: 'Recompilations/n64:mm' }
    expect(contributable(game(rom))).toBe(false)
    expect(contributable(game({ extra: { recompAdded: 'mm' } }))).toBe(false)
    expect(contributable(game({ metadata: {} }))).toBe(false)
  })
})

describe('reading the database', () => {
  it('treats a missing repository as an empty database', async () => {
    games.set('steam:620', game())
    const db = create()
    await db.start()
    await db.prefetch()
    expect(await db.lookup(game())).toBeNull()
    expect(calls.map((c) => c.url)).toContain(`${BASE}${gameDbShardPath('steam-620')}`)
  })

  it('finds a game by its key, then asks again only when the shard is older than 6 hours', async () => {
    const path = gameDbShardPath('steam-620')
    handler = cdn({ [path]: [row('steam-620')] })
    const db = create()
    await db.load()
    const match = await db.lookup(game())
    expect(match).toMatchObject({ key: 'steam-620', alias: false, row: { developers: ['Valve'] } })
    expect(db.lookupCached(game())?.key).toBe('steam-620')
    expect(calls).toHaveLength(1)
    await db.lookup(game())
    expect(calls).toHaveLength(1)
    now += SHARD_MAX_AGE_MS + 1
    await db.lookup(game())
    expect(calls).toHaveLength(2)
    // Asked with the cached ETag: the 304 keeps the cached rows.
    expect(calls[1]!.headers['If-None-Match']).toBe(`"${path}-1"`)
    expect(db.lookupCached(game())?.key).toBe('steam-620')
  })

  it('keeps the cached shard when a download fails, and reads it back after a restart', async () => {
    const path = gameDbShardPath('steam-620')
    handler = cdn({ [path]: [row('steam-620')] })
    const first = create()
    await first.lookup(game())
    await first.dispose()
    handler = () => new Response('oops', { status: 500 })
    now += SHARD_MAX_AGE_MS + 1
    const second = create()
    await second.load()
    // From the copy on disk at once, before anything is downloaded.
    expect(second.lookupCached(game())?.key).toBe('steam-620')
    expect(await second.lookup(game())).not.toBeNull()
    expect(calls.at(-1)!.url).toBe(`${BASE}${path}`)
    // A failed shard is not asked again right away.
    const count = calls.length
    await second.lookup(game())
    expect(calls).toHaveLength(count)
    now += SHARD_RETRY_MS + 1
    await second.lookup(game())
    expect(calls.length).toBe(count + 1)
  })

  it('finds a GOG copy through its Steam app row', async () => {
    handler = cdn({ [gameDbShardPath('steam-620')]: [row('steam-620')] })
    const gog = game({
      id: 'gog:1',
      source: 'gog',
      externalId: '1',
      metadata: { sources: { steam: '620' } }
    })
    const db = create()
    expect(await db.lookup(gog)).toMatchObject({ key: 'steam-620', alias: true })
    expect(await db.lookup({ ...gog, remote: {} as Game['remote'] })).toBeNull()
  })

  it('refuses a shard that is too large', async () => {
    handler = () =>
      new Response('key\n', { status: 200, headers: { 'content-length': String(9 * 1024 * 1024) } })
    const db = create()
    expect(await db.lookup(game())).toBeNull()
  })

  it('downloads nothing while the database is switched off', async () => {
    settings.scrapers.gameDatabase.enabled = false
    games.set('steam:620', game())
    const db = create()
    await db.prefetch()
    expect(calls).toHaveLength(0)
  })
})

describe('contributing', () => {
  const contributeAnswer =
    (answer: (keys: string[]) => unknown, status = 200): Handler =>
    (call) => {
      if (!call.url.startsWith(RELAY)) return cdn({})(call)
      const keys = (call.body as { rows: GameDbRow[] }).rows.map((r) => r.key)
      return new Response(JSON.stringify(answer(keys)), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    }

  it('sends a game the database lacks once, built from the stored record, and finds it locally after', async () => {
    games.set('steam:620', game())
    handler = contributeAnswer((keys) => ({ ok: true, added: keys, present: [], refused: [] }))
    const db = create()
    await db.load()
    await db.lookup(game())
    db.noteScraped('steam:620')
    expect(db.queued()).toEqual(['steam-620'])
    await db.flush()
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe(`${RELAY}/contribute`)
    expect(post.body).toMatchObject({
      clientId: 'client1234',
      appVersion: '1.2.3',
      rows: [{ key: 'steam-620', title: 'Portal 2', developers: ['Valve'], steamAppId: 620 }]
    })
    expect(db.sentResult('steam-620')).toBe('added')
    expect(db.queued()).toEqual([])
    expect(db.lookupCached(game())?.key).toBe('steam-620')
    // Never twice.
    db.noteScraped('steam:620')
    expect(db.queued()).toEqual([])
  })

  it('never sends the user edits: the row is the scraped record', async () => {
    games.set(
      'steam:620',
      game({ user: { metadataEdits: { developers: ['Someone Else'] }, titleOverride: 'Mine' } })
    )
    handler = contributeAnswer((keys) => ({ ok: true, added: keys }))
    const db = create()
    await db.load()
    db.noteScraped('steam:620')
    await db.flush()
    const sent = (calls.find((c) => c.method === 'POST')!.body as { rows: GameDbRow[] }).rows[0]!
    expect(sent.developers).toEqual(['Valve'])
    expect(sent.title).toBe('Portal 2')
  })

  it('queues nothing when contributing is off, or the database is off, or the game is in it', async () => {
    games.set('steam:620', game())
    handler = cdn({ [gameDbShardPath('steam-620')]: [row('steam-620')] })
    const db = create()
    await db.load()
    settings.scrapers.gameDatabase.contribute = false
    db.noteScraped('steam:620')
    settings.scrapers.gameDatabase = { enabled: false, contribute: true }
    db.noteScraped('steam:620')
    expect(db.queued()).toEqual([])
    settings.scrapers.gameDatabase = { enabled: true, contribute: true }
    await db.lookup(game())
    db.noteScraped('steam:620')
    expect(db.queued()).toEqual([])
  })

  it('marks what the relay found present or refused, and sends in batches', async () => {
    for (let i = 1; i <= GAME_DB_MAX_ROWS_PER_REQUEST + 2; i++)
      games.set(`steam:${i}`, game({ id: `steam:${i}`, externalId: String(i) }))
    handler = contributeAnswer((keys) => ({
      ok: true,
      added: keys.slice(2),
      present: keys.slice(0, 1),
      refused: [{ key: keys[1], error: 'no' }]
    }))
    const db = create()
    await db.load()
    for (const id of games.keys()) db.noteScraped(id)
    await db.flush()
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts.map((p) => (p.body as { rows: unknown[] }).rows.length)).toEqual([
      GAME_DB_MAX_ROWS_PER_REQUEST,
      2
    ])
    expect(db.sentResult('steam-1')).toBe('present')
    expect(db.sentResult('steam-2')).toBe('refused')
    expect(db.sentResult('steam-3')).toBe('added')
    expect(db.queued()).toEqual([])
  })

  it('keeps the games the relay left for later and sends them again', async () => {
    for (let i = 1; i <= 3; i++)
      games.set(`steam:${i}`, game({ id: `steam:${i}`, externalId: String(i) }))
    handler = contributeAnswer((keys) => ({
      ok: true,
      added: keys.slice(0, 1),
      present: [],
      refused: [],
      later: keys.slice(1)
    }))
    const db = create()
    await db.load()
    for (const id of games.keys()) db.noteScraped(id)
    await db.flush()
    expect(db.sentResult('steam-1')).toBe('added')
    expect(db.queued()).toEqual(['steam-2', 'steam-3'])
    handler = contributeAnswer((keys) => ({ ok: true, added: keys, later: [] }))
    await db.flush()
    const posts = calls.filter((c) => c.method === 'POST')
    expect((posts[1].body as { rows: GameDbRow[] }).rows.map((r) => r.key)).toEqual([
      'steam-2',
      'steam-3'
    ])
    expect(db.queued()).toEqual([])
    expect(db.sentResult('steam-3')).toBe('added')
  })

  it('waits for the relay Retry-After on 429 and keeps the games', async () => {
    games.set('steam:620', game())
    handler = contributeAnswer(() => ({ ok: false, error: 'slow down' }), 429)
    const db = create()
    await db.load()
    db.noteScraped('steam:620')
    await db.flush()
    expect(db.queued()).toEqual(['steam-620'])
    const posts = (): number => calls.filter((c) => c.method === 'POST').length
    expect(posts()).toBe(1)
    await db.flush()
    expect(posts()).toBe(1)
    now += FLUSH_RETRY_MS + 60_000
    handler = contributeAnswer((keys) => ({ ok: true, added: keys }))
    await db.flush()
    expect(posts()).toBe(2)
    expect(db.queued()).toEqual([])
  })

  it('drops a batch the relay refuses as a whole (400) and retries other errors later', async () => {
    games.set('steam:620', game())
    handler = contributeAnswer(() => ({ ok: false, error: 'bad' }), 503)
    const db = create()
    await db.load()
    db.noteScraped('steam:620')
    await db.flush()
    expect(db.queued()).toEqual(['steam-620'])
    now += FLUSH_RETRY_MS + 1
    handler = contributeAnswer(() => ({ ok: false, error: 'bad' }), 400)
    await db.flush()
    expect(db.queued()).toEqual([])
    expect(db.sentResult('steam-620')).toBe('refused')
  })

  it('waits without a relay, and skips games gone or found in the database meanwhile', async () => {
    games.set('steam:620', game())
    games.set('steam:400', game({ id: 'steam:400', externalId: '400' }))
    relayUrl = ''
    const db = create()
    await db.load()
    db.noteScraped('steam:620')
    db.noteScraped('steam:400')
    await db.flush()
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
    expect(db.queued()).toEqual(['steam-620', 'steam-400'])
    games.delete('steam:400')
    relayUrl = `${RELAY}/`
    handler = contributeAnswer((keys) => ({ ok: true, added: keys }))
    await db.flush()
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe(`${RELAY}/contribute`)
    expect((post.body as { rows: GameDbRow[] }).rows.map((r) => r.key)).toEqual(['steam-620'])
  })

  it('keeps the queue and the sent keys across a restart', async () => {
    games.set('steam:620', game())
    relayUrl = ''
    const first = create()
    await first.load()
    first.noteScraped('steam:620')
    await first.dispose()
    const second = create()
    await second.load()
    expect(second.queued()).toEqual(['steam-620'])
  })
})
