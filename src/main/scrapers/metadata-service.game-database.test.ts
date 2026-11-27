import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import type { GameDbRow } from '../../shared/game-database'
import type { Game, MetadataProgress, ScannedGame } from '../../shared/types'
import { EventBus } from '../events'
import type { GameDatabaseLookup, GameDbMatch } from '../game-database/service'
import { LibraryService } from '../services/library-service'
import { LibraryStore } from '../store/library-store'
import { SessionsStore } from '../store/sessions-store'
import { SettingsStore } from '../store/settings-store'
import { createMetadataService } from './metadata-service'
import type { ImageCache, MetadataService, Scraper } from './types'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const ROW: GameDbRow = {
  key: 'steam-620',
  title: 'Portal 2',
  platform: 'pc',
  releaseDate: '2011-04-19',
  genres: ['Puzzle'],
  tags: ['Co-op', 'Puzzle'],
  developers: ['Valve'],
  publishers: ['Valve'],
  localPlayers: 2,
  steamAppId: 620
}

function scanned(overrides: Partial<ScannedGame> = {}): ScannedGame {
  return {
    source: 'steam',
    externalId: '620',
    platformId: 'steam',
    title: 'Portal 2',
    launch: { kind: 'uri', uri: 'steam://rungameid/620' },
    tracking: { mode: 'none' },
    extra: { steamAppId: 620 },
    ...overrides
  }
}

/** A scraper that is down: it never answers. */
function downScraper(): Scraper {
  return {
    id: 'igdb',
    isConfigured: () => true,
    async search() {
      throw new Error('down')
    },
    async fetch() {
      throw new Error('down')
    }
  }
}

/** A scraper that finds every game, with a description and its own (different) facts. */
function textScraper(title?: string): Scraper {
  return {
    id: 'igdb',
    isConfigured: () => true,
    async search(game) {
      return [{ scraper: 'igdb', externalId: '1', title: game.title }]
    },
    async fetch() {
      return {
        ...(title ? { title } : {}),
        metadata: {
          description: 'from igdb',
          releaseDate: '2011-01-01',
          developers: ['Someone'],
          sources: { igdb: '1' }
        },
        media: {}
      }
    }
  }
}

interface FakeDatabase extends GameDatabaseLookup {
  rows: Map<string, GameDbRow>
  /** Rows lookupCached sees only once prefetchGames ran. */
  later: Map<string, GameDbRow>
  lookups: number
  noted: string[]
}

function fakeDatabase(): FakeDatabase {
  const match = (db: FakeDatabase, game: Game): GameDbMatch | null => {
    const key = game.source === 'steam' ? `steam-${game.externalId}` : null
    const row = key ? db.rows.get(key) : undefined
    return row && key ? { row, key, alias: false } : null
  }
  const db: FakeDatabase = {
    rows: new Map(),
    later: new Map(),
    lookups: 0,
    noted: [],
    async lookup(game) {
      db.lookups++
      return match(db, game)
    },
    lookupCached: (game) => match(db, game),
    async prefetchGames() {
      for (const [k, v] of db.later) db.rows.set(k, v)
    },
    noteScraped: (id) => void db.noted.push(id)
  }
  return db
}

function imageCache(): ImageCache {
  return {
    async importFromUrl() {
      return null
    },
    async importFromPath() {
      return null
    },
    async remove() {
      return undefined
    },
    resolve() {
      return null
    }
  } as unknown as ImageCache
}

let dir: string
let library: LibraryService
let settings: SettingsStore
let events: EventBus
let progress: MetadataProgress[]
let service: MetadataService | null

function create(
  db: FakeDatabase | undefined,
  scrapers: Scraper[] = [textScraper()]
): MetadataService {
  service = createMetadataService(
    {
      settings,
      library,
      imageCache: imageCache(),
      events,
      resourcesDir: join(dir, 'resources'),
      log,
      gameDatabase: db
    },
    {
      scrapers,
      hltbLookup: async () => null,
      steamCurrentPlayers: async () => null,
      steamPeakPlayers: async () => null,
      resumePending: false,
      localArt: { lookup: async () => ({}), reset: () => undefined },
      directSources: [],
      batch: { intervalMs: 10 }
    }
  )
  return service
}

async function untilDone(id: string): Promise<void> {
  const start = Date.now()
  while (
    !progress.some((p) => p.gameId === id && p.status !== 'pending') ||
    library.getGame(id)?.metadataStatus === 'pending'
  ) {
    if (Date.now() - start > 5000) throw new Error('timed out')
    await sleep(5)
  }
  await sleep(20)
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-meta-db-'))
  events = new EventBus()
  progress = []
  events.on('metadata:progress', (p) => progress.push(p))
  const libStore = new LibraryStore(join(dir, 'library.json'))
  const sessions = new SessionsStore(join(dir, 'sessions.json'))
  settings = new SettingsStore(join(dir, 'settings.json'))
  await Promise.all([libStore.load(), sessions.load(), settings.load()])
  settings.mutate((s) => {
    s.scrapers.hltb.enabled = false
    s.scrapers.artPriority = []
  })
  library = new LibraryService(libStore, sessions, events)
  service = null
})

afterEach(async () => {
  service?.dispose()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

describe('the PlayOut database in the metadata pipeline', () => {
  it('fills a new game facts first, the scrapers adding the description', async () => {
    library.mergeScan('steam', [scanned()])
    const db = fakeDatabase()
    db.rows.set('steam-620', ROW)
    create(db).enqueue(['steam:620'])
    await untilDone('steam:620')
    const game = library.getGame('steam:620')!
    expect(game.metadataStatus).toBe('done')
    expect(game.metadata).toMatchObject({
      description: 'from igdb',
      releaseDate: '2011-04-19',
      developers: ['Valve'],
      publishers: ['Valve'],
      genres: ['Puzzle'],
      steamTags: { tags: ['Co-op', 'Puzzle'], appId: 620 },
      localPlayers: { max: 2 },
      sources: { database: 'steam-620', igdb: '1' }
    })
    expect(db.noted).toEqual([])
  })

  it('gives new games the facts at once, before their run', async () => {
    library.mergeScan('steam', [scanned()])
    const db = fakeDatabase()
    db.rows.set('steam-620', ROW)
    create(db).enqueue(['steam:620'])
    expect(library.getGame('steam:620')!.metadata.developers).toEqual(['Valve'])
    await untilDone('steam:620')
  })

  it('fills new games once their shards are downloaded', async () => {
    library.mergeScan('steam', [
      scanned(),
      scanned({ externalId: '400', extra: { steamAppId: 400 } })
    ])
    const db = fakeDatabase()
    db.later.set('steam-400', { ...ROW, key: 'steam-400', developers: ['Later'] })
    const lookup = db.lookup
    // The runs wait, so the download's fill comes first.
    db.lookup = async (game) => {
      await sleep(100)
      return lookup(game)
    }
    create(db).enqueue(['steam:620', 'steam:400'])
    await sleep(30)
    expect(library.getGame('steam:400')!.metadata.developers).toEqual(['Later'])
    await untilDone('steam:620')
    await untilDone('steam:400')
  })

  it('lets the database win on a Refresh and keeps the controls badge', async () => {
    library.mergeScan('steam', [scanned()])
    library.applyMetadata(
      'steam:620',
      {
        metadata: {
          developers: ['Old'],
          steamTags: { tags: ['Old'], controls: { controller: 'full', vr: null } }
        },
        status: 'done'
      },
      { overwrite: true }
    )
    const db = fakeDatabase()
    db.rows.set('steam-620', ROW)
    create(db).enqueue(['steam:620'], { force: true })
    await untilDone('steam:620')
    const game = library.getGame('steam:620')!
    expect(game.metadata.developers).toEqual(['Valve'])
    expect(game.metadata.releaseDate).toBe('2011-04-19')
    expect(game.metadata.steamTags).toMatchObject({
      tags: ['Co-op', 'Puzzle'],
      controls: { controller: 'full', vr: null }
    })
  })

  it('keeps the Workshop and VAC answers the Steam tags pass wrote while the Refresh ran', async () => {
    library.mergeScan('steam', [scanned()])
    library.applyMetadata(
      'steam:620',
      { metadata: { steamTags: { tags: ['Old'], appId: 620 } }, status: 'done' },
      { overwrite: true }
    )
    const db = fakeDatabase()
    db.rows.set('steam-620', ROW)
    const scraper = textScraper()
    const fetch = scraper.fetch.bind(scraper)
    // The Steam tags pass (kicked by the same Refresh) writes its answer after the database row was taken.
    scraper.fetch = async (...args) => {
      const game = library.getGame('steam:620')!
      library.applyMetadata(
        'steam:620',
        { metadata: { steamTags: { ...game.metadata.steamTags!, workshop: true, vac: false } } },
        { overwrite: true }
      )
      return fetch(...args)
    }
    create(db, [scraper]).enqueue(['steam:620'], { force: true })
    await untilDone('steam:620')
    expect(library.getGame('steam:620')!.metadata.steamTags).toMatchObject({
      tags: ['Co-op', 'Puzzle'],
      workshop: true,
      vac: false
    })
  })

  it('offers a game the database lacked once it is matched', async () => {
    library.mergeScan('steam', [scanned()])
    const db = fakeDatabase()
    create(db).enqueue(['steam:620'])
    await untilDone('steam:620')
    expect(library.getGame('steam:620')!.metadata.developers).toEqual(['Someone'])
    expect(db.noted).toEqual(['steam:620'])
  })

  it('does nothing with the database switched off', async () => {
    settings.mutate((s) => (s.scrapers.gameDatabase = { enabled: false, contribute: true }))
    library.mergeScan('steam', [scanned()])
    const db = fakeDatabase()
    db.rows.set('steam-620', ROW)
    create(db).enqueue(['steam:620'])
    await untilDone('steam:620')
    expect(db.lookups).toBe(0)
    expect(db.noted).toEqual([])
    expect(library.getGame('steam:620')!.metadata.developers).toEqual(['Someone'])
  })

  it('never re-queues a done game for the database', async () => {
    library.mergeScan('steam', [scanned()])
    library.applyMetadata('steam:620', { status: 'done' })
    const db = fakeDatabase()
    db.rows.set('steam-620', ROW)
    create(db).enqueue(['steam:620'])
    await sleep(50)
    expect(db.lookups).toBe(0)
    expect(library.getGame('steam:620')!.metadata.developers).toBeUndefined()
  })

  it('still takes the first scraper title on a Refresh the database answers', async () => {
    library.mergeScan('steam', [scanned({ title: 'Portal Two' })])
    library.applyMetadata('steam:620', { status: 'done' })
    const db = fakeDatabase()
    db.rows.set('steam-620', ROW)
    create(db, [textScraper('Portal 2')]).enqueue(['steam:620'], { force: true })
    await untilDone('steam:620')
    const game = library.getGame('steam:620')!
    expect(game.title).toBe('Portal 2')
    expect(game.metadata.developers).toEqual(['Valve'])
  })

  it('keeps the facts of the database but not a find when every scraper failed', async () => {
    library.mergeScan('steam', [scanned()])
    const db = fakeDatabase()
    db.rows.set('steam-620', ROW)
    create(db, [downScraper()]).enqueue(['steam:620'])
    await untilDone('steam:620')
    const game = library.getGame('steam:620')!
    expect(game.metadataStatus).toBe('failed')
    expect(game.metadata).toMatchObject({ developers: ['Valve'], releaseDate: '2011-04-19' })
    expect(db.noted).toEqual([])
  })
})
