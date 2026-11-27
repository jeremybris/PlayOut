import { jpegBytes } from './test-helpers'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import type {
  ArtKind,
  ArtProgress,
  Game,
  MetadataCandidate,
  MetadataProgress,
  ScannedGame,
  ScraperId,
  Settings
} from '../../shared/types'
import { EventBus } from '../events'
import { LibraryService } from '../services/library-service'
import { LibraryStore } from '../store/library-store'
import { SessionsStore } from '../store/sessions-store'
import { SettingsStore } from '../store/settings-store'
import { safeGameId } from './image-cache'
import {
  createMetadataService,
  erroredRetryDelayMs,
  FAILED_RETRY_BASE_MS,
  FAILED_RETRY_ERROR_MAX_MS,
  FAILED_RETRY_ERROR_MS,
  FAILED_RETRY_MAX_MS,
  failedRecently,
  failedRetryDelayMs,
  HLTB_MATCH_RULES,
  NAME_MATCH_RULES,
  rematchHeld,
  USER_MATCH_SOURCE
} from './metadata-service'
import type { LocalArtLookup } from './cover-lane'
import type {
  ArtCandidates,
  DirectArtSource,
  ImageCache,
  MediaPolicy,
  MetadataService,
  ScrapedResult,
  Scraper
} from './types'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeScraperOptions {
  configured?: boolean
  /** Candidates per search; receives the query so tests can assert on it. */
  candidates?: (game: Game, query?: string) => MetadataCandidate[]
  result?: (game: Game, candidate: MetadataCandidate) => ScrapedResult
  delayMs?: number
  searchError?: string
  fetchError?: string
  /** titleOf: the names per recorded id (absent id: the source has no such game); a string throws it. */
  titles?: Record<string, string[]> | string
  /** idMatchOf: the source's game for the game's store id. */
  idMatch?: string | null
}

interface FakeScraper extends Scraper {
  calls: {
    search: number
    fetch: number
    queries: (string | undefined)[]
    fetched: MetadataCandidate[]
    /** The `kinds` each fetch was asked for. */
    kinds: (ArtKind[] | undefined)[]
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let concurrent = 0
let maxConcurrent = 0

function fakeScraper(id: ScraperId, opts: FakeScraperOptions = {}): FakeScraper {
  const calls = {
    search: 0,
    fetch: 0,
    queries: [] as (string | undefined)[],
    fetched: [] as MetadataCandidate[],
    kinds: [] as (ArtKind[] | undefined)[]
  }
  return {
    id,
    calls,
    // The real SteamGridDB scraper declares the kinds it can supply; the fake does the same.
    artKinds: id === 'steamgriddb' ? ['cover', 'hero', 'logo', 'icon'] : undefined,
    isConfigured: () => opts.configured !== false,
    ...(opts.titles !== undefined
      ? {
          async titleOf(externalId: string) {
            if (typeof opts.titles === 'string') throw new Error(opts.titles)
            return opts.titles?.[externalId] ?? null
          }
        }
      : {}),
    ...(opts.idMatch !== undefined ? { idMatchOf: async () => opts.idMatch } : {}),
    async search(game, _settings, query) {
      calls.search++
      calls.queries.push(query)
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      try {
        if (opts.delayMs) await sleep(opts.delayMs)
        if (opts.searchError) throw new Error(opts.searchError)
        return opts.candidates
          ? opts.candidates(game, query)
          : [{ scraper: id, externalId: `${id}-1`, title: game.title }]
      } finally {
        concurrent--
      }
    },
    async fetch(game, candidate, _settings, kinds) {
      calls.fetch++
      calls.fetched.push(candidate)
      calls.kinds.push(kinds)
      if (opts.fetchError) throw new Error(opts.fetchError)
      return opts.result ? opts.result(game, candidate) : { metadata: {}, media: {} }
    }
  }
}

interface FakeImageCache extends ImageCache {
  imports: { gameId: string; kind: string; url: string; index?: number; policy?: MediaPolicy }[]
  copies: { gameId: string; kind: string; path: string }[]
  removed: { gameId: string; kind?: string }[]
}

function fakeImageCache(
  failing: (url: string) => boolean = () => false,
  /** Runs inside every download, before it answers (tests that need to act while one is in flight). */
  during?: (url: string, policy?: MediaPolicy) => Promise<void> | void
): FakeImageCache {
  const imports: FakeImageCache['imports'] = []
  const copies: FakeImageCache['copies'] = []
  const removed: FakeImageCache['removed'] = []
  return {
    dir: 'C:\\fake\\media',
    imports,
    copies,
    removed,
    async importSteamThumbnail() {
      return null
    },
    async moveGame() {
      return (url: string) => url
    },
    async pruneSteamThumbnails() {
      return undefined
    },
    async importRemote(gameId, kind, url, index, policy) {
      imports.push({ gameId, kind, url, index, policy })
      await during?.(url, policy)
      if (failing(url)) return null
      return `media://cache/${safeGameId(gameId)}/${kind}${index === undefined ? '' : `-${index}`}.jpg?v=1`
    },
    async importLocal(gameId, kind, path) {
      copies.push({ gameId, kind, path })
      return `media://cache/${safeGameId(gameId)}/${kind}.png?v=local`
    },
    async importHostCopy(gameId, kind, path) {
      copies.push({ gameId, kind: `host-${kind}`, path })
      return `media://cache/${safeGameId(gameId)}/${kind}-host.png?v=local`
    },
    async importCustom(gameId, kind, path) {
      copies.push({ gameId, kind: `custom-${kind}`, path })
      return `media://cache/${safeGameId(gameId)}/custom-${kind}.png?v=local`
    },
    async remove(gameId, kind) {
      removed.push({ gameId, kind })
    },
    resolve() {
      return null
    }
  }
}

function scanned(overrides: Partial<ScannedGame> = {}): ScannedGame {
  return {
    source: 'steam',
    externalId: '620',
    platformId: 'steam',
    title: 'Portal 2',
    launch: { kind: 'uri', uri: 'steam://rungameid/620' },
    tracking: { mode: 'installDir', installDir: 'C:\\Steam\\steamapps\\common\\Portal 2' },
    extra: { steamAppId: 620 },
    ...overrides
  }
}

const EPIC_GAME = scanned({
  source: 'epic',
  externalId: 'hades',
  platformId: 'epic',
  title: 'Hades',
  extra: undefined,
  launch: { kind: 'uri', uri: 'com.epicgames.launcher://apps/hades' }
})
const ROM_GAME = scanned({
  source: 'rom',
  externalId: 'snes/Super Mario World (USA).sfc',
  platformId: 'snes',
  title: 'Super Mario World',
  extra: undefined,
  launch: {
    kind: 'emulator',
    systemId: 'snes',
    romPath: 'D:\\ROMs\\snes\\Super Mario World (USA).sfc'
  },
  tracking: { mode: 'spawned' }
})

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir: string
let library: LibraryService
let settings: SettingsStore
let events: EventBus
let progress: MetadataProgress[]
let service: MetadataService | null

async function untilProgress(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out; progress so far: ${JSON.stringify(progress)}`)
    await sleep(5)
  }
}

const finished = (): MetadataProgress[] => progress.filter((p) => p.status !== 'pending')

function createService(
  scrapers: Scraper[],
  extras: {
    imageCache?: ImageCache
    hltb?: (
      title: string,
      year?: number,
      consoles?: string[]
    ) => Promise<{ main?: number; solo?: number; combined?: boolean } | null>
    /** The background re-check's lookup (failure vs "no match"); derived from `hltb` when absent. */
    hltbOutcome?: (
      title: string,
      year?: number,
      consoles?: string[]
    ) => Promise<{
      times: { main?: number; solo?: number; combined?: boolean } | null
      failed: boolean
    }>
    players?: (appId: number) => Promise<number | null>
    peak?: (appId: number) => Promise<number | null>
    /** Turn the resume pass on with this delay (off by default in tests). */
    resumeDelayMs?: number
    /** Local caches (none by default: the real registry would read this PC's Steam folder). */
    localArt?: LocalArtLookup
    /** Direct URL sources (none by default). */
    directSources?: DirectArtSource[]
    fullLaneWaitMaxMs?: number
    artProgressIntervalMs?: number
    changedIntervalMs?: number
  } = {}
): MetadataService {
  service = createMetadataService(
    {
      settings,
      library,
      imageCache: extras.imageCache ?? fakeImageCache(),
      events,
      resourcesDir: join(dir, 'resources'),
      log
    },
    {
      scrapers,
      hltbLookup: extras.hltb ?? (async () => null),
      hltbLookupOutcome: extras.hltbOutcome,
      steamCurrentPlayers: extras.players ?? (async () => null),
      steamPeakPlayers: extras.peak ?? (async () => null),
      resumePending: extras.resumeDelayMs !== undefined,
      resumeDelayMs: extras.resumeDelayMs,
      localArt: extras.localArt ?? noLocalArt(),
      directSources: extras.directSources ?? [],
      batch: { intervalMs: 10 },
      fullLaneWaitMaxMs: extras.fullLaneWaitMaxMs,
      artProgressIntervalMs: extras.artProgressIntervalMs,
      changedIntervalMs: extras.changedIntervalMs ?? 10
    }
  )
  return service
}

const noLocalArt = (): LocalArtLookup => ({ lookup: async () => ({}), reset: () => undefined })

/** A local registry answering from a fixed table (gameId -> candidates); counts lookups and resets. */
function fakeLocalArt(table: Record<string, ArtCandidates>): LocalArtLookup & {
  lookups: string[]
  resets: number
} {
  const out = {
    lookups: [] as string[],
    resets: 0,
    async lookup(game: Game) {
      out.lookups.push(game.id)
      return table[game.id] ?? {}
    },
    reset() {
      out.resets++
    }
  }
  return out
}

/** A direct source answering from a table of URLs per game id; records every `candidates` batch. */
function fakeDirect(
  id: DirectArtSource['id'],
  urls: Record<string, Partial<Record<ArtKind, string[]>>>,
  batchSize = 1
): DirectArtSource & { batches: string[][] } {
  const batches: string[][] = []
  return {
    id,
    batches,
    batchSize,
    isConfigured: () => true,
    async candidates(games, kinds) {
      batches.push(games.map((g) => g.game.id))
      const out = new Map<string, ArtCandidates>()
      for (const { game } of games) {
        const row = urls[game.id]
        if (!row) continue
        const c: ArtCandidates = {}
        for (const kind of kinds)
          if (row[kind]) c[kind] = row[kind]!.map((url) => ({ kind, source: id, url }))
        out.set(game.id, c)
      }
      return out
    }
  }
}

/** A minimal PNG header (signature + IHDR) the sniffer reads as w x h RGBA; padded past the 64-byte floor. */
async function writePng(path: string, width: number, height: number): Promise<string> {
  const buf = Buffer.alloc(96)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(buf, 0)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf[24] = 8
  buf[25] = 6
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, buf)
  return path
}

/** Resolves once both lanes drained (the `queued: 0` event). */
const untilDrained = (): Promise<void> => untilProgress(() => progress.some((p) => p.queued === 0))

function patchSettings(patch: (s: Settings) => void): void {
  settings.mutate(patch)
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-meta-'))
  events = new EventBus()
  progress = []
  events.on('metadata:progress', (p) => progress.push(p))
  const libStore = new LibraryStore(join(dir, 'library.json'))
  const sessions = new SessionsStore(join(dir, 'sessions.json'))
  settings = new SettingsStore(join(dir, 'settings.json'))
  await Promise.all([libStore.load(), sessions.load(), settings.load()])
  library = new LibraryService(libStore, sessions, events)
  concurrent = 0
  maxConcurrent = 0
  service = null
})
afterEach(async () => {
  service?.dispose()
  // A store's last debounced save can still land in `dir` while it is removed on a busy PC (ENOTEMPTY).
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enqueue: text merge priority', () => {
  it('lets the store scraper win and later scrapers fill the gaps', async () => {
    library.mergeScan('steam', [scanned()])
    const steam = fakeScraper('steam', {
      result: () => ({
        title: 'Portal 2',
        metadata: {
          description: 'from steam',
          releaseDate: '2011-04-18',
          developers: [],
          sources: { steam: '620' }
        },
        media: {}
      })
    })
    const igdb = fakeScraper('igdb', {
      result: () => ({
        metadata: {
          description: 'from igdb',
          developers: ['Valve'],
          genres: ['Puzzle'],
          sources: { igdb: '1020' }
        },
        media: {}
      })
    })
    const tgdb = fakeScraper('thegamesdb', { candidates: () => [] })
    const sgdb = fakeScraper('steamgriddb', { candidates: () => [] })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = ['steamgriddb']
    })
    createService([steam, igdb, tgdb, sgdb]).enqueue(['steam:620'])
    expect(library.getGame('steam:620')?.metadataStatus).toBe('pending')
    expect(progress[0]).toMatchObject({ gameId: 'steam:620', status: 'pending', remaining: 1 })

    await untilProgress(() => finished().length === 1)
    const game = library.getGame('steam:620')!
    expect(game.metadataStatus).toBe('done')
    expect(game.metadata).toMatchObject({
      description: 'from steam',
      releaseDate: '2011-04-18',
      developers: ['Valve'],
      genres: ['Puzzle'],
      sources: { steam: '620', igdb: '1020' }
    })
    expect(finished()[0]).toMatchObject({
      gameId: 'steam:620',
      status: 'done',
      remaining: 0,
      message: 'Portal 2'
    })
    expect(steam.calls).toMatchObject({ search: 1, fetch: 1 })
    expect(igdb.calls).toMatchObject({ search: 1, fetch: 1 })
    expect(tgdb.calls).toMatchObject({ search: 1, fetch: 0 })
  })

  it('uses the store scraper only for its own games and ScreenScraper only for ROMs', async () => {
    library.mergeScan('steam', [scanned()])
    library.mergeScan('epic', [EPIC_GAME])
    const romId = library.mergeScan('rom', [ROM_GAME]).newGameIds[0]
    const seen: Record<string, string[]> = {}
    const record = (id: ScraperId): FakeScraper =>
      fakeScraper(id, {
        candidates: (game) => {
          ;(seen[id] ??= []).push(game.id)
          return [{ scraper: id, externalId: 'x', title: game.title }]
        },
        result: () => ({ metadata: { description: `from ${id}` }, media: {} })
      })
    const steam = record('steam')
    const gog = record('gog')
    const ss = record('screenscraper')
    const igdb = record('igdb')
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    createService([steam, gog, ss, igdb]).enqueue(['steam:620', 'epic:hades', romId])
    await untilProgress(() => finished().length === 3)
    expect(seen.steam).toEqual(['steam:620'])
    expect(seen.gog).toBeUndefined()
    expect(seen.screenscraper).toEqual([romId])
    expect(seen.igdb!.sort()).toEqual(['epic:hades', romId, 'steam:620'].sort())
    expect(library.getGame('steam:620')?.metadata.description).toBe('from steam')
    expect(library.getGame('epic:hades')?.metadata.description).toBe('from igdb')
    expect(library.getGame(romId)?.metadata.description).toBe('from screenscraper')
    expect(
      finished()
        .map((p) => p.remaining)
        .sort()
    ).toEqual([0, 1, 2])
  })

  it('skips unconfigured scrapers, logs failing ones and marks games with nothing found as failed', async () => {
    library.mergeScan('steam', [scanned()])
    library.mergeScan('epic', [EPIC_GAME])
    const steam = fakeScraper('steam', {
      result: () => ({ metadata: { description: 'from steam' }, media: {} })
    })
    const igdb = fakeScraper('igdb', { configured: false })
    const tgdb = fakeScraper('thegamesdb', {
      searchError: 'TheGamesDB: monthly allowance exhausted'
    })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = ['igdb', 'thegamesdb']
    })
    createService([steam, igdb, tgdb]).enqueue(['steam:620', 'epic:hades'])
    await untilProgress(() => finished().length === 2)
    expect(igdb.calls.search).toBe(0)
    expect(library.getGame('steam:620')?.metadataStatus).toBe('done')
    expect(library.getGame('epic:hades')?.metadataStatus).toBe('failed')
    // Nothing but the record of the run (the automatic enqueues' backoff reads it): TheGamesDB did not answer, so
    // it is not counted as a miss.
    expect(library.getGame('epic:hades')?.metadata).toEqual({
      scrapeMissed: { at: expect.any(String), count: 0, errors: 1 },
      // The run ended without a cover: remembered for the art retries' back-off.
      coverMissing: { at: expect.any(String), count: 1 },
      updatedAt: expect.any(String)
    })
    expect(finished().find((p) => p.gameId === 'epic:hades')?.status).toBe('failed')
  })
})

describe('enqueue: failed games', () => {
  it('doubles the retry delay per consecutive miss up to the cap', () => {
    expect(failedRetryDelayMs(1)).toBe(FAILED_RETRY_BASE_MS)
    expect(failedRetryDelayMs(2)).toBe(2 * FAILED_RETRY_BASE_MS)
    expect(failedRetryDelayMs(4)).toBe(8 * FAILED_RETRY_BASE_MS)
    expect(failedRetryDelayMs(0)).toBe(FAILED_RETRY_BASE_MS)
    expect(failedRetryDelayMs(5000)).toBe(FAILED_RETRY_MAX_MS)
  })

  it('reads a miss as recent only for a failed game inside its delay', () => {
    const now = Date.parse('2026-01-02T00:00:00Z')
    const at = (msAgo: number): string => new Date(now - msAgo).toISOString()
    const game = (
      metadataStatus: Game['metadataStatus'],
      scrapeMissed?: { at: string; count: number; errors?: number }
    ): Pick<Game, 'metadataStatus' | 'metadata'> => ({ metadataStatus, metadata: { scrapeMissed } })
    // A run with a scraper that did not answer holds the game back briefly, whatever the misses before it.
    expect(erroredRetryDelayMs(1)).toBe(FAILED_RETRY_ERROR_MS)
    expect(erroredRetryDelayMs(2)).toBe(2 * FAILED_RETRY_ERROR_MS)
    expect(erroredRetryDelayMs(5000)).toBe(FAILED_RETRY_ERROR_MAX_MS)
    expect(failedRecently(game('failed', { at: at(60_000), count: 6, errors: 1 }), now)).toBe(true)
    expect(
      failedRecently(game('failed', { at: at(FAILED_RETRY_ERROR_MS), count: 6, errors: 1 }), now)
    ).toBe(false)
    expect(
      failedRecently(game('failed', { at: at(FAILED_RETRY_ERROR_MS), count: 0, errors: 2 }), now)
    ).toBe(true)
    expect(failedRecently(game('failed', { at: at(60_000), count: 1 }), now)).toBe(true)
    expect(failedRecently(game('failed', { at: at(FAILED_RETRY_BASE_MS), count: 1 }), now)).toBe(
      false
    )
    expect(failedRecently(game('failed', { at: at(FAILED_RETRY_BASE_MS), count: 2 }), now)).toBe(
      true
    )
    // No record (failed before this was tracked), another status, a clock set back, a broken timestamp.
    expect(failedRecently(game('failed'), now)).toBe(false)
    expect(failedRecently(game('none', { at: at(60_000), count: 1 }), now)).toBe(false)
    expect(failedRecently(game('failed', { at: at(-60_000), count: 1 }), now)).toBe(false)
    expect(failedRecently(game('failed', { at: 'soon', count: 1 }), now)).toBe(false)
  })

  it('an automatic enqueue leaves a recently failed game alone; a user request and an elapsed delay run it', async () => {
    library.mergeScan('epic', [EPIC_GAME])
    let match = false
    const igdb = fakeScraper('igdb', {
      candidates: (game) =>
        match ? [{ scraper: 'igdb', externalId: 'igdb-1', title: game.title }] : [],
      result: () => ({ metadata: { description: 'found at last' }, media: {} })
    })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    const cache = fakeImageCache((url) => url.includes('gone'))
    const svc = createService([igdb], { imageCache: cache })
    svc.enqueue(['epic:hades'])
    await untilProgress(() => finished().length === 1)
    expect(library.getGame('epic:hades')?.metadataStatus).toBe('failed')
    expect(library.getGame('epic:hades')?.metadata.scrapeMissed).toEqual({
      at: expect.any(String),
      count: 1
    })
    const searches = igdb.calls.search
    expect(searches).toBeGreaterThan(0)

    // What a scan or an import does on every launch: the same id again, nothing forced.
    const events = progress.length
    svc.enqueue(['epic:hades'])
    svc.enqueue(['epic:hades'], { seeds: [] })
    await sleep(60)
    expect(igdb.calls.search).toBe(searches)
    expect(progress).toHaveLength(events)
    expect(library.getGame('epic:hades')?.metadataStatus).toBe('failed')

    // The user's "refresh missing" runs it at once; a second miss in a row is counted.
    svc.enqueue(['epic:hades'], { retryFailed: true })
    await untilProgress(() => finished().length === 2)
    expect(igdb.calls.search).toBeGreaterThan(searches)
    expect(library.getGame('epic:hades')?.metadata.scrapeMissed?.count).toBe(2)

    // A seed for it is still consumed inside the delay, without asking the scrapers when it lands nothing.
    const again = igdb.calls.search
    svc.enqueue(['epic:hades'], {
      seeds: [{ gameId: 'epic:hades', kind: 'cover', url: 'https://cdn.example/gone.jpg' }]
    })
    await untilProgress(() => finished().length === 3)
    expect(cache.imports.map((i) => i.url)).toEqual(['https://cdn.example/gone.jpg'])
    expect(igdb.calls.search).toBe(again)
    expect(library.getGame('epic:hades')?.metadataStatus).toBe('failed')
    expect(library.getGame('epic:hades')?.metadata.scrapeMissed?.count).toBe(2)

    // Once the delay is over the automatic enqueue tries again, and a find forgets the misses.
    library.applyMetadata(
      'epic:hades',
      {
        metadata: {
          scrapeMissed: {
            at: new Date(Date.now() - failedRetryDelayMs(2) - 1000).toISOString(),
            count: 2
          }
        }
      },
      { overwrite: true }
    )
    match = true
    svc.enqueue(['epic:hades'])
    await untilProgress(() => finished().length === 4)
    expect(igdb.calls.search).toBeGreaterThan(again)
    expect(library.getGame('epic:hades')?.metadataStatus).toBe('done')
    expect(library.getGame('epic:hades')?.metadata.scrapeMissed).toBeUndefined()
  })

  it('a seed that lands art on a recently failed game sends it through the full lane once: it ends done', async () => {
    library.mergeScan('epic', [EPIC_GAME])
    const igdb = fakeScraper('igdb', { candidates: () => [] })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    const cache = fakeImageCache()
    const svc = createService([igdb], { imageCache: cache })
    svc.enqueue(['epic:hades'])
    await untilProgress(() => finished().length === 1)
    expect(library.getGame('epic:hades')?.metadataStatus).toBe('failed')
    const searches = igdb.calls.search

    // The next import brings a cover for it: no automatic enqueue would name the game again once it has one.
    svc.enqueue(['epic:hades'], {
      seeds: [{ gameId: 'epic:hades', kind: 'cover', url: 'https://cdn.example/hades.jpg' }]
    })
    await untilProgress(() => finished().length === 2)
    const game = library.getGame('epic:hades')
    expect(game?.media.cover).toBeTruthy()
    expect(game?.metadataStatus).toBe('done')
    expect(game?.metadata.scrapeMissed).toBeUndefined()
    expect(finished()[1]).toMatchObject({ gameId: 'epic:hades', status: 'done', lane: 'full' })
    // The text sources were asked once more (the full lane ran), and only once: the game is settled now.
    const after = igdb.calls.search
    expect(after).toBeGreaterThan(searches)
    svc.enqueue(['epic:hades'])
    await sleep(60)
    expect(igdb.calls.search).toBe(after)
  })

  it('a run in which a scraper did not answer is not counted as a miss and is retried after a short delay', async () => {
    library.mergeScan('epic', [EPIC_GAME])
    // The PC is offline (or the source is down) during the scan, then back.
    const opts: FakeScraperOptions = {
      searchError: 'getaddrinfo ENOTFOUND api.igdb.com',
      result: () => ({ metadata: { description: 'found once online' }, media: {} })
    }
    const igdb = fakeScraper('igdb', opts)
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    const svc = createService([igdb])
    svc.enqueue(['epic:hades'])
    await untilProgress(() => finished().length === 1)
    expect(library.getGame('epic:hades')?.metadataStatus).toBe('failed')
    expect(library.getGame('epic:hades')?.metadata.scrapeMissed).toEqual({
      at: expect.any(String),
      count: 0,
      errors: 1
    })

    // Bounded all the same: the very next scan does not run the chain again.
    const searches = igdb.calls.search
    svc.enqueue(['epic:hades'])
    await sleep(60)
    expect(igdb.calls.search).toBe(searches)

    // Long before a real miss's hour is over, an automatic enqueue tries again.
    library.applyMetadata(
      'epic:hades',
      {
        metadata: {
          scrapeMissed: {
            at: new Date(Date.now() - FAILED_RETRY_ERROR_MS - 1000).toISOString(),
            count: 0,
            errors: 1
          }
        }
      },
      { overwrite: true }
    )
    opts.searchError = undefined
    svc.enqueue(['epic:hades'])
    await untilProgress(() => finished().length === 2)
    expect(library.getGame('epic:hades')?.metadataStatus).toBe('done')
    expect(library.getGame('epic:hades')?.metadata.description).toBe('found once online')
    expect(library.getGame('epic:hades')?.metadata.scrapeMissed).toBeUndefined()
  })
})

describe('enqueue: artwork', () => {
  it('takes each kind from the first scraper in artPriority that has it and falls through on download failures', async () => {
    library.mergeScan('steam', [scanned()])
    const sgdb = fakeScraper('steamgriddb', {
      result: () => ({
        metadata: { sources: { steamgriddb: '5250' } },
        media: {
          cover: 'https://sgdb/cover.png',
          logo: 'https://sgdb/logo.png',
          icon: 'https://sgdb/icon.png'
        }
      })
    })
    const policy: MediaPolicy = {}
    sgdb.mediaPolicy = policy
    const steam = fakeScraper('steam', {
      result: () => ({
        metadata: { description: 'd' },
        media: {
          cover: 'https://steam/cover.jpg',
          hero: 'https://steam/hero.jpg',
          logo: 'https://steam/logo.png',
          screenshots: [
            'https://steam/s1.jpg',
            'https://steam/s2.jpg',
            'https://steam/s3.jpg',
            'https://steam/s4.jpg',
            'https://steam/s5.jpg'
          ]
        }
      })
    })
    const igdb = fakeScraper('igdb', {
      result: () => ({
        metadata: {},
        media: { hero: 'https://igdb/hero.jpg', screenshots: ['https://igdb/s1.jpg'] }
      })
    })
    const cache = fakeImageCache((url) => url === 'https://sgdb/logo.png')
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = ['steamgriddb', 'steam', 'igdb']
    })
    createService([steam, igdb, sgdb], { imageCache: cache }).enqueue(['steam:620'])
    await untilProgress(() => finished().length === 1)
    const game = library.getGame('steam:620')!
    expect(game.media).toEqual({
      cover: 'media://cache/steam_620/cover.jpg?v=1',
      hero: 'media://cache/steam_620/hero.jpg?v=1',
      logo: 'media://cache/steam_620/logo.jpg?v=1',
      icon: 'media://cache/steam_620/icon.jpg?v=1',
      screenshots: [
        'media://cache/steam_620/screenshot-0.jpg?v=1',
        'media://cache/steam_620/screenshot-1.jpg?v=1',
        'media://cache/steam_620/screenshot-2.jpg?v=1',
        'media://cache/steam_620/screenshot-3.jpg?v=1'
      ]
    })
    expect(cache.imports.map((i) => i.url)).toEqual([
      'https://sgdb/cover.png',
      'https://steam/hero.jpg',
      'https://sgdb/logo.png',
      'https://steam/logo.png',
      'https://sgdb/icon.png',
      'https://steam/s1.jpg',
      'https://steam/s2.jpg',
      'https://steam/s3.jpg',
      'https://steam/s4.jpg'
    ])
    expect(game.metadata.sources).toEqual({
      steamgriddb: '5250',
      'art:cover': 'steamgriddb',
      'art:hero': 'steam',
      'art:logo': 'steam',
      'art:icon': 'steamgriddb'
    })
    // A scraper's media policy (ScreenScraper's thread gate) travels with each of its downloads, and only those.
    for (const imported of cache.imports)
      expect(imported.policy).toBe(imported.url.startsWith('https://sgdb/') ? policy : undefined)
    // Each scraper is searched/fetched at most once per game even though it serves several kinds; IGDB was
    // consulted once by the text pass and the art pass reused that result instead of reaching it again.
    expect(sgdb.calls).toMatchObject({ search: 1, fetch: 1 })
    expect(steam.calls).toMatchObject({ search: 1, fetch: 1 })
    expect(igdb.calls).toMatchObject({ search: 1, fetch: 1 })
  })

  it('keeps existing and custom art unless forced', async () => {
    library.mergeScan('steam', [scanned()])
    library.updateGame('steam:620', { user: { customMedia: { cover: 'C:\\art\\cover.png' } } })
    library.setMedia('steam:620', 'cover', 'media://cache/steam_620/cover.png?v=custom')
    library.setMedia('steam:620', 'hero', 'media://cache/steam_620/hero.jpg?v=old')
    const steam = fakeScraper('steam', {
      result: () => ({
        metadata: { description: 'd' },
        media: {
          cover: 'https://steam/cover.jpg',
          hero: 'https://steam/hero.jpg',
          logo: 'https://steam/logo.png'
        }
      })
    })
    const cache = fakeImageCache()
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = ['steam']
    })
    const svc = createService([steam], { imageCache: cache })
    svc.enqueue(['steam:620'])
    await untilProgress(() => finished().length === 1)
    expect(cache.imports.map((i) => i.url)).toEqual(['https://steam/logo.png'])
    expect(library.getGame('steam:620')?.media).toEqual({
      cover: 'media://cache/steam_620/cover.png?v=custom',
      hero: 'media://cache/steam_620/hero.jpg?v=old',
      logo: 'media://cache/steam_620/logo.jpg?v=1'
    })

    svc.enqueue(['steam:620'], { force: true })
    await untilProgress(() => finished().length === 2)
    expect(cache.imports.map((i) => i.url)).toEqual([
      'https://steam/logo.png',
      'https://steam/hero.jpg',
      'https://steam/logo.png'
    ])
    expect(library.getGame('steam:620')?.media.cover).toBe(
      'media://cache/steam_620/cover.png?v=custom'
    )
    expect(library.getGame('steam:620')?.media.hero).toBe('media://cache/steam_620/hero.jpg?v=1')
  })
})

describe('enqueue: queue behaviour', () => {
  it('dedupes ids, skips done games unless forced, and runs at most three games at a time', async () => {
    library.mergeScan('steam', [
      scanned(),
      scanned({ externalId: '440', title: 'Team Fortress 2', extra: { steamAppId: 440 } }),
      scanned({ externalId: '570', title: 'Dota 2', extra: { steamAppId: 570 } })
    ])
    library.mergeScan('epic', [EPIC_GAME])
    const steam = fakeScraper('steam', {
      delayMs: 40,
      result: () => ({ metadata: { description: 'v1' }, media: {} })
    })
    const igdb = fakeScraper('igdb', {
      delayMs: 40,
      result: () => ({ metadata: { description: 'igdb', developers: ['Supergiant'] }, media: {} })
    })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    const svc = createService([steam, igdb])
    svc.enqueue(['steam:620', 'steam:440', 'steam:620', 'nope:1'])
    expect(progress.at(-1)).toMatchObject({
      status: 'pending',
      remaining: 2,
      coverLane: 2,
      fullLane: 2
    })
    svc.enqueue(['steam:440', 'steam:570', 'epic:hades'])
    expect(progress.at(-1)).toMatchObject({ status: 'pending', remaining: 4, queued: 4 })
    await untilProgress(() => finished().length === 4)
    expect(maxConcurrent).toBe(3)
    expect(steam.calls.search).toBe(3)
    expect(igdb.calls.search).toBe(4)
    expect(
      finished()
        .map((p) => p.gameId)
        .sort()
    ).toEqual(['epic:hades', 'steam:440', 'steam:570', 'steam:620'])

    steam.calls.search = 0
    const events = progress.length
    svc.enqueue(['steam:620'])
    await sleep(60)
    expect(steam.calls.search).toBe(0)
    expect(progress).toHaveLength(events)

    // A forced run lets the first text scraper overwrite what the previous run stored.
    library.applyMetadata('steam:620', { metadata: { description: 'stale' } }, { overwrite: true })
    svc.enqueue(['steam:620'], { force: true })
    expect(library.getGame('steam:620')?.metadataStatus).toBe('pending')
    await untilProgress(() => finished().length === 5)
    expect(library.getGame('steam:620')?.metadata.description).toBe('v1')
    expect(library.getGame('steam:620')?.metadata.developers).toEqual(['Supergiant'])
  })

  it('stops after dispose', async () => {
    library.mergeScan('steam', [
      scanned(),
      scanned({ externalId: '440', title: 'TF2', extra: { steamAppId: 440 } }),
      scanned({ externalId: '570', title: 'Dota', extra: { steamAppId: 570 } })
    ])
    library.mergeScan('epic', [EPIC_GAME])
    const steam = fakeScraper('steam', {
      delayMs: 30,
      result: () => ({ metadata: { description: 'd' }, media: {} })
    })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    const svc = createService([steam], {
      localArt: { lookup: async () => sleep(40).then(() => ({})), reset: () => undefined }
    })
    svc.enqueue(['steam:620', 'steam:440', 'steam:570'])
    // Disposed while the cover lane still runs: nothing reached the full lane, so every game stays 'pending' (the
    // next start's resume pass finishes the import) and no job starts afterwards.
    svc.dispose()
    for (const id of ['steam:620', 'steam:440', 'steam:570'])
      expect(library.getGame(id)?.metadataStatus).toBe('pending')
    await sleep(100)
    expect(steam.calls.search).toBe(0)
    expect(finished()).toHaveLength(0)

    // Disposed while the full lane runs: the games in flight keep 'pending' (a quit kills them mid-way; the resume
    // pass handles that); the one that never started stays 'pending' too.
    const steam2 = fakeScraper('steam', {
      delayMs: 30,
      result: () => ({ metadata: { description: 'd' }, media: {} })
    })
    const svc2 = createService([steam2])
    svc2.enqueue(['steam:620', 'steam:440', 'steam:570', 'epic:hades'])
    await untilProgress(() => steam2.calls.search === 3)
    svc2.dispose()
    expect(library.getGame('steam:620')?.metadataStatus).toBe('pending')
    expect(library.getGame('steam:440')?.metadataStatus).toBe('pending')
    expect(library.getGame('steam:570')?.metadataStatus).toBe('pending')
    expect(library.getGame('epic:hades')?.metadataStatus).toBe('pending')
    await sleep(150)
    expect(finished()).toHaveLength(3)
    svc2.enqueue(['epic:hades'])
    await sleep(60)
    expect(finished()).toHaveLength(3)
  })

  it('re-runs a game whose forced refresh arrived while it was being processed', async () => {
    library.mergeScan('steam', [scanned()])
    let version = 'v1'
    const steam = fakeScraper('steam', {
      delayMs: 30,
      result: () => ({ metadata: { description: version }, media: {} })
    })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    const svc = createService([steam])
    svc.enqueue(['steam:620'])
    // The game is in the full lane now (clearing custom art and the detail page's Refresh button both do this).
    await untilProgress(() => steam.calls.search === 1)
    svc.enqueue(['steam:620'], { force: true })
    svc.enqueue(['steam:620'])
    // Something changes while the first run is still going; the re-run must see it.
    events.on('metadata:progress', (p) => {
      if (p.status === 'done' && version === 'v1') version = 'v2'
    })
    await untilProgress(() => finished().length === 2)
    expect(steam.calls.search).toBe(2)
    expect(finished().map((p) => p.remaining)).toEqual([1, 0])
    expect(library.getGame('steam:620')?.metadata.description).toBe('v2')
    expect(library.getGame('steam:620')?.metadataStatus).toBe('done')
    await sleep(60)
    expect(steam.calls.search).toBe(2)
  })

  it('resumes games left pending by a previous run, resetting them when auto-scrape is off', async () => {
    library.mergeScan('steam', [
      scanned(),
      scanned({ externalId: '440', title: 'TF2', extra: { steamAppId: 440 } })
    ])
    library.applyMetadata('steam:620', { status: 'pending' })
    // With its cover: a cover-less done game would also be retried (art only) by the resume pass.
    library.applyMetadata('steam:440', { status: 'done', media: { cover: 'media://440.jpg' } })
    const steam = fakeScraper('steam', {
      result: () => ({ metadata: { description: 'd' }, media: {} })
    })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
      s.scrapers.autoScrape = false
    })
    const first = createService([steam], { resumeDelayMs: 20 })
    await untilProgress(() => library.getGame('steam:620')?.metadataStatus === 'none')
    expect(steam.calls.search).toBe(0)
    expect(library.getGame('steam:440')?.metadataStatus).toBe('done')
    first.dispose()

    library.applyMetadata('steam:620', { status: 'pending' })
    patchSettings((s) => {
      s.scrapers.autoScrape = true
    })
    createService([steam], { resumeDelayMs: 20 })
    await untilProgress(() => finished().length === 1)
    expect(steam.calls.search).toBe(1)
    expect(library.getGame('steam:620')?.metadataStatus).toBe('done')
    expect(library.getGame('steam:440')?.metadataStatus).toBe('done')
  })
})

describe('HowLongToBeat', () => {
  it('fills hltb with the scraped title and year when enabled', async () => {
    library.mergeScan('steam', [scanned()])
    const lookups: [string, number | undefined][] = []
    const steam = fakeScraper('steam', {
      result: () => ({ title: 'Portal 2', metadata: { releaseDate: '2011-04-18' }, media: {} })
    })
    patchSettings((s) => {
      s.scrapers.artPriority = []
    })
    const svc = createService([steam], {
      hltb: async (title, year) => {
        lookups.push([title, year])
        return { main: 8.6, extra: 13.8 }
      }
    })
    svc.enqueue(['steam:620'])
    await untilProgress(() => finished().length === 1)
    expect(lookups).toEqual([['Portal 2', 2011]])
    expect(library.getGame('steam:620')?.metadata.hltb).toMatchObject({ main: 8.6, extra: 13.8 })
    expect(library.getGame('steam:620')?.metadata.hltb?.updatedAt).toBeTruthy()

    // Not repeated unless forced; the user's title override is what gets looked up.
    library.updateGame('steam:620', { user: { titleOverride: 'Portal Two' } })
    svc.enqueue(['steam:620'], { force: true })
    await untilProgress(() => finished().length === 2)
    expect(lookups).toEqual([
      ['Portal 2', 2011],
      ['Portal Two', 2011]
    ])
  })

  it('is skipped when disabled and counts as a find on its own', async () => {
    library.mergeScan('epic', [EPIC_GAME])
    const igdb = fakeScraper('igdb', { candidates: () => [] })
    let calls = 0
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    const svc = createService([igdb], {
      hltb: async () => {
        calls++
        return { main: 20 }
      }
    })
    svc.enqueue(['epic:hades'])
    await untilProgress(() => finished().length === 1)
    expect(calls).toBe(0)
    expect(library.getGame('epic:hades')?.metadataStatus).toBe('failed')

    patchSettings((s) => {
      s.scrapers.hltb.enabled = true
    })
    // Failed a moment ago: only a request by the user runs it again this soon.
    svc.enqueue(['epic:hades'], { retryFailed: true })
    await untilProgress(() => finished().length === 2)
    expect(calls).toBe(1)
    expect(library.getGame('epic:hades')?.metadataStatus).toBe('done')
    expect(library.getGame('epic:hades')?.metadata.hltb?.main).toBe(20)
  })
})

describe('search and apply', () => {
  it('merges up to eight candidates per configured scraper and tags them', async () => {
    library.mergeScan('steam', [scanned()])
    const many = (id: ScraperId): MetadataCandidate[] =>
      Array.from({ length: 10 }, (_, i) => ({
        scraper: 'hltb' as ScraperId,
        externalId: `${id}-${i}`,
        title: `${id} ${i}`
      }))
    const steam = fakeScraper('steam', {
      candidates: (_g, q) => (q ? [] : [{ scraper: 'steam', externalId: '620', title: 'Portal 2' }])
    })
    const igdb = fakeScraper('igdb', { candidates: () => many('igdb') })
    const sgdb = fakeScraper('steamgriddb', { candidates: () => many('steamgriddb') })
    const tgdb = fakeScraper('thegamesdb', { searchError: 'TheGamesDB: invalid API key' })
    const ss = fakeScraper('screenscraper', { configured: false })
    const svc = createService([steam, igdb, sgdb, tgdb, ss])
    const candidates = await svc.search('steam:620', 'portal 2')
    expect(candidates).toHaveLength(16)
    expect(candidates.map((c) => c.scraper)).toEqual([
      ...Array(8).fill('igdb'),
      ...Array(8).fill('steamgriddb')
    ])
    expect(candidates[0]).toEqual({ scraper: 'igdb', externalId: 'igdb-0', title: 'igdb 0' })
    expect(igdb.calls.queries).toEqual(['portal 2'])
    expect(ss.calls.search).toBe(0)
    await expect(svc.search('missing:1', 'x')).rejects.toThrow(/Unknown game/)
  })

  it('applies a chosen candidate with overwrite, drops the previous art, then completes it from the chain', async () => {
    library.mergeScan('steam', [scanned()])
    // A previous automatic match (wrong game) supplied cover, icon and screenshots; the logo is the user's own.
    library.updateGame('steam:620', { user: { customMedia: { logo: 'C:\\art\\logo.png' } } })
    library.setMedia('steam:620', 'logo', 'media://cache/steam_620/logo.png?v=custom')
    library.applyMetadata('steam:620', {
      metadata: { description: 'old', developers: ['Old Dev'], sources: { steamgriddb: 'WRONG' } },
      media: {
        cover: 'media://cache/steam_620/cover.jpg?v=old',
        icon: 'media://cache/steam_620/icon.png?v=old',
        screenshots: ['media://cache/steam_620/screenshot-0.jpg?v=old']
      },
      status: 'done'
    })
    const igdb = fakeScraper('igdb', {
      result: (_g, c) => ({
        title: `Portal 2 (${c.externalId})`,
        metadata: { description: 'new', genres: ['Puzzle'], sources: { igdb: c.externalId } },
        media: { cover: 'https://igdb/cover.jpg' }
      })
    })
    const steam = fakeScraper('steam', {
      result: () => ({
        metadata: { description: 'steam' },
        media: { hero: 'https://steam/hero.jpg', cover: 'https://steam/cover.jpg' }
      })
    })
    const cache = fakeImageCache()
    const lookups: string[] = []
    patchSettings((s) => {
      s.scrapers.artPriority = ['steam', 'igdb']
    })
    const svc = createService([steam, igdb], {
      imageCache: cache,
      hltb: async (title) => {
        lookups.push(title)
        return { main: 9 }
      }
    })
    const game = await svc.apply('steam:620', {
      scraper: 'igdb',
      externalId: '1020',
      title: 'Portal 2'
    })
    expect(igdb.calls.fetched).toEqual([{ scraper: 'igdb', externalId: '1020', title: 'Portal 2' }])
    expect(igdb.calls.search).toBe(0)
    expect(game.title).toBe('Portal 2 (1020)')
    // The previous match's steamgriddb id is gone: a user-chosen match replaces `sources` instead of merging.
    expect(game.metadata).toMatchObject({
      description: 'new',
      developers: ['Old Dev'],
      genres: ['Puzzle'],
      hltb: { main: 9 }
    })
    expect(game.metadata.sources).toEqual({
      igdb: '1020',
      // The user's pick: never re-checked.
      [USER_MATCH_SOURCE]: 'igdb',
      'art:cover': 'igdb',
      'art:hero': 'steam'
    })
    // The chosen source's cover replaces the old one, the chain fills the hero for the corrected title, the
    // old match's icon and screenshots are gone (nothing supplies them any more) and custom art is untouched.
    expect(game.media).toEqual({
      cover: 'media://cache/steam_620/cover.jpg?v=1',
      hero: 'media://cache/steam_620/hero.jpg?v=1',
      logo: 'media://cache/steam_620/logo.png?v=custom',
      screenshots: []
    })
    expect(cache.imports.map((i) => i.url)).toEqual([
      'https://igdb/cover.jpg',
      'https://steam/hero.jpg'
    ])
    expect(cache.removed).toEqual([
      { gameId: 'steam:620', kind: 'icon' },
      { gameId: 'steam:620', kind: 'screenshot' }
    ])
    expect(game.metadataStatus).toBe('done')
    expect(lookups).toEqual(['Portal 2 (1020)'])

    await expect(
      svc.apply('steam:620', { scraper: 'hltb', externalId: '7231', title: 'Portal 2' })
    ).rejects.toThrow(/Unknown metadata source/)
    const broken = fakeScraper('thegamesdb', {
      fetchError: 'TheGamesDB: monthly allowance exhausted'
    })
    const svc2 = createService([broken])
    await expect(
      svc2.apply('steam:620', { scraper: 'thegamesdb', externalId: '1', title: 'x' })
    ).rejects.toThrow('thegamesdb: TheGamesDB: monthly allowance exhausted')
  })
})

describe('live Steam data', () => {
  it('refreshes current players at most every ten minutes', async () => {
    library.mergeScan('steam', [scanned()])
    library.mergeScan('epic', [EPIC_GAME])
    let players = 0
    const svc = createService([], {
      players: async () => {
        players++
        return 1796
      }
    })
    await svc.refreshLive('steam:620')
    await svc.refreshLive('steam:620')
    await svc.refreshLive('epic:hades')
    expect(players).toBe(1)
    expect(library.getGame('steam:620')?.metadata.currentPlayers).toMatchObject({ count: 1796 })
    expect(library.getGame('epic:hades')?.metadata.currentPlayers).toBeUndefined()
  })

  it('reads the all-time peak with the current players, at most once a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    library.mergeScan('steam', [scanned()])
    let peaks = 0
    const svc = createService([], {
      players: async () => 1796,
      peak: async () => {
        peaks++
        return 25642
      }
    })
    await svc.refreshLive('steam:620')
    expect(peaks).toBe(1)
    expect(library.getGame('steam:620')?.metadata.peakPlayers).toMatchObject({ count: 25642 })
    // Ten minutes later the current players are read again, the peak (read less than a day ago) is not.
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    await svc.refreshLive('steam:620')
    expect(peaks).toBe(1)
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    await svc.refreshLive('steam:620')
    expect(peaks).toBe(2)
    vi.useRealTimers()
  })

  it('keeps the last peak when SteamCharts cannot be read', async () => {
    library.mergeScan('steam', [scanned()])
    library.applyMetadata(
      'steam:620',
      { metadata: { peakPlayers: { count: 900, updatedAt: '2020-01-01T00:00:00.000Z' } } },
      { overwrite: true }
    )
    const svc = createService([], { players: async () => 12, peak: async () => null })
    await svc.refreshLive('steam:620')
    expect(library.getGame('steam:620')?.metadata.peakPlayers?.count).toBe(900)
    expect(library.getGame('steam:620')?.metadata.currentPlayers?.count).toBe(12)
  })
})

describe('cover lane and full lane', () => {
  it('lands seeds and local-cache covers before the first text scrape, batching the library writes', async () => {
    library.mergeScan('steam', [
      scanned(),
      scanned({ externalId: '440', title: 'Team Fortress 2', extra: { steamAppId: 440 } })
    ])
    library.mergeScan('epic', [EPIC_GAME])
    // Steam's own covers are JPEG (a PNG one in the cache is the client's drawn stand-in).
    const tf2Cover = join(dir, 'librarycache', '440', 'library_600x900.jpg')
    await fs.mkdir(dirname(tf2Cover), { recursive: true })
    await fs.writeFile(tf2Cover, jpegBytes(600, 900))
    const hadesCover = await writePng(
      join(dir, 'galaxy', 'hades_glx_vertical_cover.webp'),
      342,
      482
    )
    const steam = fakeScraper('steam', {
      delayMs: 20,
      result: () => ({
        metadata: { description: 'd' },
        media: { cover: 'https://steam/cover.jpg', hero: 'https://steam/hero.jpg' }
      })
    })
    const igdb = fakeScraper('igdb', {
      result: () => ({ metadata: { description: 'd' }, media: { cover: 'https://igdb/cover.jpg' } })
    })
    const cache = fakeImageCache()
    const localArt = fakeLocalArt({
      'epic:hades': {
        cover: [
          { kind: 'cover', source: 'galaxy-cache', path: hadesCover, width: 342, height: 482 }
        ]
      }
    })
    // library:changed events of the cover-lane phase (before any scraper was asked for text).
    const coverPhaseEvents: string[][] = []
    events.on('library:changed', (p) => {
      if (p.reason === 'metadata' && steam.calls.search + igdb.calls.search === 0)
        coverPhaseEvents.push(p.gameIds ?? [])
    })
    let coversAtFirstSearch: number | null = null
    events.on('metadata:progress', () => {
      if (coversAtFirstSearch === null && steam.calls.search + igdb.calls.search > 0)
        coversAtFirstSearch = library.games().filter((g) => g.media.cover).length
    })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = ['steam', 'igdb']
    })
    const svc = createService([steam, igdb], { imageCache: cache, localArt })
    svc.enqueue(['steam:620', 'steam:440', 'epic:hades'], {
      seeds: [
        { gameId: 'steam:620', kind: 'cover', url: 'https://cdn/620/library_600x900_2x.jpg' },
        { gameId: 'steam:620', kind: 'hero', url: 'https://cdn/620/library_hero.jpg' },
        { gameId: 'steam:440', kind: 'cover', path: tf2Cover }
      ]
    })
    expect(progress[0]).toMatchObject({
      status: 'pending',
      lane: 'cover',
      queued: 3,
      coverLane: 3,
      fullLane: 3,
      done: 0
    })
    for (const id of ['steam:620', 'steam:440', 'epic:hades'])
      expect(library.getGame(id)?.metadataStatus).toBe('pending')
    await untilDrained()

    // Every cover was in the library before any scraper was asked for text.
    expect(coversAtFirstSearch).toBe(3)
    expect(library.getGame('steam:620')?.media).toEqual({
      cover: 'media://cache/steam_620/cover.jpg?v=1',
      hero: 'media://cache/steam_620/hero.jpg?v=1'
    })
    expect(library.getGame('steam:440')?.media.cover).toBe(
      'media://cache/steam_440/cover.png?v=local'
    )
    expect(library.getGame('epic:hades')?.media.cover).toBe(
      'media://cache/epic_hades/cover.png?v=local'
    )
    expect(library.getGame('steam:620')?.metadata.sources).toMatchObject({
      'art:cover': 'store-import',
      'art:hero': 'store-import'
    })
    expect(library.getGame('steam:440')?.metadata.sources?.['art:cover']).toBe('steam-cache')
    expect(library.getGame('epic:hades')?.metadata.sources?.['art:cover']).toBe('galaxy-cache')
    // The local stage asked the registry for the two games without a path seed (Portal 2's URL seed is network
    // work, so the local caches are tried first) and not for TF2; the full lane asks again for the other kinds.
    // The registry was reset once the lanes drained.
    expect(localArt.lookups.slice(0, 2).sort()).toEqual(['epic:hades', 'steam:620'])
    expect(localArt.resets).toBe(1)
    // The full lane never downloaded a cover again: the seed URL is the only cover download.
    expect(cache.imports.map((i) => i.url).filter((u) => /cover|600x900/.test(u))).toEqual([
      'https://cdn/620/library_600x900_2x.jpg'
    ])
    // Batched: the status batch plus at most two flushes carried the three covers and the hero (four images).
    expect(coverPhaseEvents.length).toBeLessThanOrEqual(3)
    expect(coverPhaseEvents.flat()).toContain('epic:hades')
    expect(library.games().every((g) => g.metadataStatus === 'done')).toBe(true)
    expect(progress.at(-1)).toMatchObject({
      queued: 0,
      coverLane: 0,
      fullLane: 0,
      done: 3,
      remaining: 0
    })
  })

  it('runs only the seed step for a done game and, covers-only, neither the network nor the full lane', async () => {
    library.mergeScan('steam', [scanned()])
    library.mergeScan('epic', [EPIC_GAME])
    // Its last cover-less run was a moment ago (a cover-less done game without the marker would get an art-only run).
    library.applyMetadata('steam:620', {
      status: 'done',
      metadata: { coverMissing: { at: new Date().toISOString(), count: 1 } }
    })
    const steam = fakeScraper('steam', {
      result: () => ({
        metadata: { description: 'd' },
        media: { cover: 'https://steam/cover.jpg' }
      })
    })
    const direct = fakeDirect('steam-cdn', { 'epic:hades': { cover: ['https://cdn/hades.jpg'] } })
    const hadesCover = await writePng(join(dir, 'local', 'hades.png'), 600, 900)
    const localArt = fakeLocalArt({
      'epic:hades': { cover: [{ kind: 'cover', source: 'playnite-files', path: hadesCover }] }
    })
    const cache = fakeImageCache()
    const svc = createService([steam], { imageCache: cache, localArt, directSources: [direct] })
    svc.enqueue([], { seeds: [{ gameId: 'steam:620', kind: 'cover', url: 'https://cdn/620.jpg' }] })
    await untilDrained()
    expect(library.getGame('steam:620')?.media.cover).toBe('media://cache/steam_620/cover.jpg?v=1')
    expect(library.getGame('steam:620')?.metadataStatus).toBe('done')
    expect(steam.calls.search).toBe(0)
    expect(localArt.lookups).toEqual([])

    progress.length = 0
    svc.enqueue(['epic:hades'], { coverOnly: true })
    await untilDrained()
    expect(library.getGame('epic:hades')?.media.cover).toBe(
      'media://cache/epic_hades/cover.png?v=local'
    )
    expect(library.getGame('epic:hades')?.metadataStatus).toBe('none')
    expect(direct.batches).toEqual([])
    expect(steam.calls.search).toBe(0)
    expect(progress[0]).toMatchObject({ coverLane: 1, fullLane: 0 })
  })

  it('tries direct URLs best first, falls through a 404 to the next source, and batches batch sources', async () => {
    library.mergeScan('steam', [
      scanned(),
      scanned({ externalId: '440', title: 'TF2', extra: { steamAppId: 440 } }),
      scanned({ externalId: '570', title: 'Dota', extra: { steamAppId: 570 } })
    ])
    const cdn = fakeDirect('steam-cdn', {
      'steam:620': { cover: ['https://cdn/620_2x.jpg', 'https://cdn/620.jpg'] },
      'steam:440': { cover: ['https://cdn/440_2x.jpg'] },
      'steam:570': { cover: ['https://cdn/570_2x.jpg'] }
    })
    const sgdb = fakeDirect(
      'steamgriddb-platform',
      {
        'steam:440': { cover: ['https://sgdb/440.png'] },
        'steam:570': { cover: ['https://sgdb/570.png'] }
      },
      2
    )
    const cache = fakeImageCache((url) => url.endsWith('_2x.jpg'))
    const steam = fakeScraper('steam', {
      result: () => ({
        metadata: { description: 'd' },
        media: { cover: 'https://steam/cover.jpg' }
      })
    })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = ['steam']
    })
    createService([steam], { imageCache: cache, directSources: [cdn, sgdb] }).enqueue([
      'steam:620',
      'steam:440',
      'steam:570'
    ])
    await untilDrained()
    expect(library.getGame('steam:620')?.metadata.sources?.['art:cover']).toBe('steam-cdn')
    expect(library.getGame('steam:440')?.metadata.sources?.['art:cover']).toBe(
      'steamgriddb-platform'
    )
    expect(library.getGame('steam:570')?.metadata.sources?.['art:cover']).toBe(
      'steamgriddb-platform'
    )
    // Template source: one call per game; batch source: the two misses went out in one request. (The later
    // batches are the full lane asking for hero / logo / icon.)
    expect(cdn.batches.slice(0, 3)).toEqual([['steam:620'], ['steam:440'], ['steam:570']])
    expect(sgdb.batches[0]).toEqual(['steam:440', 'steam:570'])
    expect(cache.imports.map((i) => i.url).sort()).toEqual([
      'https://cdn/440_2x.jpg',
      'https://cdn/570_2x.jpg',
      'https://cdn/620.jpg',
      'https://cdn/620_2x.jpg',
      'https://sgdb/440.png',
      'https://sgdb/570.png'
    ])
    expect(library.games().every((g) => g.metadataStatus === 'done')).toBe(true)
  })

  it('searches SteamGridDB in the cover lane only for games without a store id and reuses the result', async () => {
    library.mergeScan('steam', [scanned()])
    library.mergeScan('epic', [EPIC_GAME])
    const sgdb = fakeScraper('steamgriddb', {
      result: () => ({
        metadata: { sources: { steamgriddb: '1' } },
        media: { cover: 'https://sgdb/cover.png', hero: 'https://sgdb/hero.png' }
      })
    })
    const coveredWhenTextStarted: string[] = []
    const steam = fakeScraper('steam', {
      delayMs: 20,
      candidates: (game) => {
        if (!coveredWhenTextStarted.length)
          coveredWhenTextStarted.push(
            ...library
              .games()
              .filter((g) => g.media.cover)
              .map((g) => g.id)
          )
        return [{ scraper: 'steam', externalId: game.externalId, title: game.title }]
      },
      result: () => ({
        metadata: { description: 'd' },
        media: { cover: 'https://steam/cover.jpg' }
      })
    })
    const cache = fakeImageCache()
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.steamgriddb.apiKey = 'k'
      s.scrapers.artPriority = ['steamgriddb', 'steam']
    })
    createService([steam, sgdb], { imageCache: cache }).enqueue(['steam:620', 'epic:hades'])
    await untilDrained()
    // Hades (no store id) got its cover from the cover lane's SteamGridDB search; Portal 2 (a Steam appid, but no
    // direct source in this test) waited for the full lane, where SteamGridDB is first in artPriority.
    expect(library.getGame('epic:hades')?.metadata.sources?.['art:cover']).toBe('steamgriddb')
    expect(coveredWhenTextStarted).toEqual(['epic:hades'])
    expect(sgdb.calls).toMatchObject({ search: 2, fetch: 2 })
    expect(cache.imports.filter((i) => i.gameId === 'epic:hades').map((i) => i.url)).toEqual([
      'https://sgdb/cover.png',
      'https://sgdb/hero.png'
    ])
  })

  it('marks a 300x450 fallback cover as small and lets the full lane upgrade it', async () => {
    library.mergeScan('steam', [scanned()])
    const cdn = fakeDirect('steam-cdn', {
      'steam:620': {
        cover: [
          'https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900_2x.jpg',
          'https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900.jpg'
        ]
      }
    })
    // The seed's _2x 404s (an older app without one); the CDN source's _2x is a different host and works.
    const cache = fakeImageCache(
      (url) => url === 'https://cdn/steam/apps/620/library_600x900_2x.jpg'
    )
    const steam = fakeScraper('steam', {
      result: () => ({ metadata: { description: 'd' }, media: {} })
    })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    createService([steam], { imageCache: cache, directSources: [cdn] }).enqueue(['steam:620'], {
      seeds: [
        {
          gameId: 'steam:620',
          kind: 'cover',
          url: 'https://cdn/steam/apps/620/library_600x900_2x.jpg'
        }
      ]
    })
    await untilDrained()
    const game = library.getGame('steam:620')!
    expect(cache.imports.map((i) => i.url)).toEqual([
      'https://cdn/steam/apps/620/library_600x900_2x.jpg',
      'https://cdn/steam/apps/620/library_600x900.jpg',
      'https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900_2x.jpg'
    ])
    expect(game.metadata.sources?.['art:cover']).toBe('steam-cdn')
    expect(game.metadata.sources?.['art:cover:quality']).toBeUndefined()
    expect(game.metadataStatus).toBe('done')
  })

  it('pauses the full lane while a new enqueue fills the cover lane', async () => {
    library.mergeScan('steam', [
      scanned(),
      scanned({ externalId: '440', title: 'TF2', extra: { steamAppId: 440 } })
    ])
    library.mergeScan('epic', [EPIC_GAME])
    const steam = fakeScraper('steam', {
      delayMs: 30,
      result: () => ({ metadata: { description: 'd' }, media: {} })
    })
    // The order below is held by gates, not by timers: on a busy PC a late poll could otherwise let Portal 2
    // finish before the second enqueue, or Hades's cover land before Portal 2's text chain asked IGDB.
    // Portal 2's Steam search waits until the second batch is queued...
    let portalSearching = false
    let releasePortal!: () => void
    const portalHeld = new Promise<void>((resolve) => (releasePortal = resolve))
    const steamSearch = steam.search.bind(steam)
    steam.search = async (game, settings, query) => {
      if (game.id === 'steam:620') {
        portalSearching = true
        await portalHeld
      }
      return steamSearch(game, settings, query)
    }
    // ...and Hades's local cover waits until Portal 2 (the game already in flight) has asked IGDB.
    let portalAskedIgdb!: () => void
    const igdbAsked = new Promise<void>((resolve) => (portalAskedIgdb = resolve))
    // What the library showed for Hades each time IGDB was asked for text.
    const hadesCoverAtSearch: (string | undefined)[] = []
    const igdb = fakeScraper('igdb', {
      candidates: (game) => {
        hadesCoverAtSearch.push(library.getGame('epic:hades')?.media.cover)
        portalAskedIgdb()
        return [{ scraper: 'igdb', externalId: game.externalId, title: game.title }]
      },
      result: () => ({ metadata: { description: 'i' }, media: {} })
    })
    const hadesCover = await writePng(join(dir, 'local', 'hades.png'), 600, 900)
    let lookups = 0
    const localArt: LocalArtLookup = {
      async lookup(game) {
        lookups++
        if (game.id === 'epic:hades') await igdbAsked
        await sleep(40)
        return game.id === 'epic:hades'
          ? { cover: [{ kind: 'cover', source: 'galaxy-cache', path: hadesCover }] }
          : {}
      },
      reset: () => undefined
    }
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    const svc = createService([steam, igdb], { localArt })
    svc.enqueue(['steam:620'])
    await untilProgress(() => portalSearching)
    svc.enqueue(['steam:440', 'epic:hades'])
    releasePortal()
    await untilDrained()
    // Portal 2's text chain (already in flight) asked IGDB while Hades had no cover; TF2 and Hades reached the
    // text chain only after the second enqueue's cover lane had landed Hades's cover.
    expect(hadesCoverAtSearch).toEqual([
      undefined,
      'media://cache/epic_hades/cover.png?v=local',
      'media://cache/epic_hades/cover.png?v=local'
    ])
    // Three cover-lane lookups and three full-lane ones (hero / logo / icon).
    expect(lookups).toBe(6)
    expect(library.games().every((g) => g.metadataStatus === 'done')).toBe(true)
    expect(progress.at(-1)).toMatchObject({ queued: 0, done: 3 })
  })

  it('reports the art downloads for the bottom bar: the covers, then the remaining art, then idle', async () => {
    library.mergeScan('steam', [
      scanned(),
      scanned({ externalId: '440', title: 'TF2', extra: { steamAppId: 440 } })
    ])
    library.mergeScan('epic', [EPIC_GAME])
    const steam = fakeScraper('steam', {
      delayMs: 20,
      result: () => ({
        metadata: { description: 'd' },
        media: { cover: 'https://steam/cover.jpg', hero: 'https://steam/hero.jpg' }
      })
    })
    const art: ArtProgress[] = []
    events.on('art:progress', (p) => art.push(p))
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = ['steam']
    })
    // Every change reported (no 250 ms window), so the art stage shows however fast the stub scrapers are.
    const svc = createService([steam], { artProgressIntervalMs: 0 })
    svc.enqueue(['steam:620', 'steam:440', 'epic:hades'])
    // The bar appears with the queue, before any game is through.
    expect(art[0]).toEqual({ stage: 'cover', done: 0, total: 3 })
    await untilDrained()
    await untilProgress(() => art.at(-1)?.total === 0)
    expect(art.at(-1)).toEqual({ stage: 'cover', done: 0, total: 0 })
    // Covers first, then the full lane's art; counts never run past their totals.
    const stages = art.filter((p) => p.total > 0).map((p) => p.stage)
    expect(stages.indexOf('art')).toBeGreaterThan(stages.lastIndexOf('cover'))
    expect(art.some((p) => p.stage === 'art')).toBe(true)
    for (const p of art) expect(p.done).toBeLessThanOrEqual(p.total)
    expect(art.filter((p) => p.total > 0).every((p) => p.total === 3)).toBe(true)
  })
})

describe('cover lane: review fixes', () => {
  /** N installed Steam games 10001..1000N. */
  function steamLibrary(n: number): string[] {
    const games = Array.from({ length: n }, (_, i) =>
      scanned({
        externalId: String(10001 + i),
        title: `Game ${i}`,
        extra: { steamAppId: 10001 + i }
      })
    )
    return library.mergeScan('steam', games).newGameIds
  }

  it('asks SteamGridDB for the grid only in the cover lane and completes the memo for the full lane', async () => {
    library.mergeScan('rom', [ROM_GAME])
    const romId = library.games()[0].id
    const sgdb = fakeScraper('steamgriddb', {
      result: () => ({
        metadata: { sources: { steamgriddb: '7' } },
        media: { cover: 'https://sgdb/cover.png', hero: 'https://sgdb/hero.png' }
      })
    })
    const cache = fakeImageCache()
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.steamgriddb.apiKey = 'k'
      s.scrapers.artPriority = ['steamgriddb']
    })
    createService([sgdb], { imageCache: cache }).enqueue([romId])
    await untilDrained()
    // One search; the lane's fetch asked for the cover, the full lane's for what was still missing.
    expect(sgdb.calls.search).toBe(1)
    expect(sgdb.calls.kinds).toEqual([['cover'], ['hero', 'logo', 'icon']])
    expect(sgdb.calls.fetched.map((c) => c.externalId)).toEqual(['steamgriddb-1', 'steamgriddb-1'])
    expect(cache.imports.map((i) => i.url)).toEqual([
      'https://sgdb/cover.png',
      'https://sgdb/hero.png'
    ])
    expect(library.getGame(romId)?.metadata.sources).toMatchObject({
      steamgriddb: '7',
      'art:cover': 'steamgriddb',
      'art:hero': 'steamgriddb'
    })
  })

  it('fills a batch source from the queue behind the game in hand and skips sources with no id for it', async () => {
    const ids = steamLibrary(20)
    const urls: Record<string, Partial<Record<ArtKind, string[]>>> = {}
    for (const id of ids)
      urls[id] = {
        cover: [`https://sgdb/${id}/cover.png`],
        hero: [`https://sgdb/${id}/hero.png`],
        logo: [`https://sgdb/${id}/logo.png`],
        icon: [`https://sgdb/${id}/icon.png`]
      }
    const sgdb = fakeDirect('steamgriddb-platform', urls, 50)
    const xbox = fakeDirect('xbox-catalog', urls, 20)
    xbox.hasIdFor = (artIds) => !!artIds.xboxStoreId
    const steam = fakeScraper('steam', {
      result: () => ({ metadata: { description: 'd' }, media: {} })
    })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    createService([steam], { directSources: [xbox, sgdb] }).enqueue(ids)
    await untilDrained()
    expect(library.games().every((g) => g.media.cover && g.media.hero && g.media.icon)).toBe(true)
    // Cover lane: 16 games in flight joined the collector, the 4 queued behind them came along. Full lane: the
    // first game's hero / logo / icon batch carried the whole queue. No game ever waited in the Xbox collector.
    expect(sgdb.batches.map((b) => b.length)).toEqual([20, 20])
    expect(xbox.batches).toEqual([])
  })

  it('remembers URLs that answered 404 and does not download them again on the next import', async () => {
    library.mergeScan('steam', [scanned()])
    const cache = fakeImageCache((url) => url.includes('library_600x900') || url.includes('logo'))
    const seeds = [
      {
        gameId: 'steam:620',
        kind: 'cover' as const,
        url: 'https://cdn/steam/apps/620/library_600x900_2x.jpg'
      },
      { gameId: 'steam:620', kind: 'hero' as const, url: 'https://cdn/steam/apps/620/hero.jpg' },
      { gameId: 'steam:620', kind: 'logo' as const, url: 'https://cdn/steam/apps/620/logo.png' }
    ]
    const svc = createService([], { imageCache: cache })
    svc.enqueue([], { seeds, coverOnly: true })
    await untilDrained()
    const game = library.getGame('steam:620')!
    expect(game.media).toEqual({ hero: 'media://cache/steam_620/hero.jpg?v=1' })
    expect(game.metadata.sources?.['art:cover:missing']).toBe(
      'https://cdn/steam/apps/620/library_600x900_2x.jpg https://cdn/steam/apps/620/library_600x900.jpg'
    )
    expect(game.metadata.sources?.['art:logo:missing']).toBe('https://cdn/steam/apps/620/logo.png')
    expect(cache.imports).toHaveLength(4)

    // The next launch re-imports the owned list: the same seeds cost no request.
    progress.length = 0
    svc.enqueue([], { seeds, coverOnly: true })
    await sleep(60)
    expect(cache.imports).toHaveLength(4)
    expect(progress).toEqual([])
    // Refresh retries them, and a landed cover clears the memo.
    const cache2 = fakeImageCache()
    const svc2 = createService([], { imageCache: cache2 })
    svc2.enqueue([], { seeds, coverOnly: true, force: true })
    await untilDrained()
    // Refresh re-lands every seed, the remembered misses included.
    expect(cache2.imports.map((i) => i.url)).toEqual([
      'https://cdn/steam/apps/620/library_600x900_2x.jpg',
      'https://cdn/steam/apps/620/hero.jpg',
      'https://cdn/steam/apps/620/logo.png'
    ])
    expect(library.getGame('steam:620')?.metadata.sources?.['art:cover:missing']).toBeUndefined()
    expect(library.getGame('steam:620')?.metadata.sources?.['art:cover']).toBe('store-import')
  })

  it('leaves a custom cover alone when its download was in flight while the user chose the file', async () => {
    library.mergeScan('steam', [scanned()])
    const cache = fakeImageCache(
      () => false,
      async (url) => {
        if (url.includes('620')) {
          library.updateGame('steam:620', { user: { customMedia: { cover: 'C:\\art\\own.png' } } })
          library.setMedia('steam:620', 'cover', 'media://cache/steam_620/custom-cover.png?v=1')
        }
      }
    )
    const svc = createService([], { imageCache: cache })
    svc.enqueue([], {
      seeds: [{ gameId: 'steam:620', kind: 'cover', url: 'https://cdn/620.jpg' }],
      coverOnly: true
    })
    await untilDrained()
    const game = library.getGame('steam:620')!
    expect(game.media.cover).toBe('media://cache/steam_620/custom-cover.png?v=1')
    expect(game.metadata.sources?.['art:cover']).toBeUndefined()
  })

  it('lands cover seeds in the cover lane and leaves hero / logo seeds to the full lane', async () => {
    library.mergeScan('steam', [scanned()])
    const order: string[] = []
    const cache = fakeImageCache(
      () => false,
      (url) => {
        order.push(url)
      }
    )
    const steam = fakeScraper('steam', {
      candidates: (game) => {
        order.push('text')
        return [{ scraper: 'steam', externalId: game.externalId, title: game.title }]
      },
      result: () => ({ metadata: { description: 'd' }, media: {} })
    })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    createService([steam], { imageCache: cache }).enqueue(['steam:620'], {
      seeds: [
        { gameId: 'steam:620', kind: 'hero', url: 'https://cdn/620/hero.jpg' },
        { gameId: 'steam:620', kind: 'cover', url: 'https://cdn/620/cover.jpg' }
      ]
    })
    await untilDrained()
    expect(order).toEqual(['https://cdn/620/cover.jpg', 'text', 'https://cdn/620/hero.jpg'])
    expect(library.getGame('steam:620')?.media).toEqual({
      cover: 'media://cache/steam_620/cover.jpg?v=1',
      hero: 'media://cache/steam_620/hero.jpg?v=1'
    })
    expect(library.getGame('steam:620')?.metadata.sources?.['art:hero']).toBe('store-import')
  })

  it('downloads direct URLs without retries and gives up on a host after repeated network failures', async () => {
    const ids = steamLibrary(24)
    const urls: Record<string, Partial<Record<ArtKind, string[]>>> = {}
    for (const id of ids) urls[id] = { cover: [`https://dead.cdn/${id}.jpg`] }
    const cdn = fakeDirect('steam-cdn', urls)
    const cache = fakeImageCache(
      () => true,
      async (url, policy) => {
        if (!url.startsWith('https://dead.cdn/')) return
        await sleep(5)
        policy?.onNetworkError?.(url)
      }
    )
    const sgdb = fakeScraper('steamgriddb', {
      result: () => ({ metadata: {}, media: { cover: 'https://sgdb/x.png' } })
    })
    sgdb.mediaPolicy = { retries: 1 }
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.steamgriddb.apiKey = 'k'
      s.scrapers.artPriority = ['steamgriddb']
    })
    createService([sgdb], { imageCache: cache, directSources: [cdn] }).enqueue(ids)
    await untilDrained()
    const dead = cache.imports.filter((i) => i.url.startsWith('https://dead.cdn/'))
    // 8 consecutive failures trip the budget; the downloads that already held a slot (at most the 16 cover-lane
    // games in flight) still ran, every later candidate for the host (and the full lane's retry) was skipped.
    expect(dead.length).toBeGreaterThanOrEqual(8)
    expect(dead.length).toBeLessThanOrEqual(16)
    for (const i of dead) expect(i.policy).toMatchObject({ retries: 0, timeoutMs: 10_000 })
    // Scraper media keeps the scraper's own policy.
    const viaScraper = cache.imports.find((i) => i.url === 'https://sgdb/x.png')
    expect(viaScraper?.policy).toBe(sgdb.mediaPolicy)
    // Nothing was recorded as missing: a network failure says nothing about the URL.
    expect(library.games().every((g) => !g.metadata.sources?.['art:cover:missing'])).toBe(true)
  })

  it('neither budgets the host nor records the URL for a 403, which can mean an absent file', async () => {
    const ids = steamLibrary(24)
    const urls: Record<string, Partial<Record<ArtKind, string[]>>> = {}
    for (const id of ids) urls[id] = { cover: [`https://forbidden.cdn/${id}.jpg`] }
    const cache = fakeImageCache(
      () => true,
      async (url, policy) => policy?.onNetworkError?.(url, 403)
    )
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
    })
    createService([], {
      imageCache: cache,
      directSources: [fakeDirect('steam-cdn', urls)]
    }).enqueue(ids)
    await untilDrained()
    const tried = new Set(cache.imports.map((i) => i.url))
    expect(ids.every((id) => tried.has(`https://forbidden.cdn/${id}.jpg`))).toBe(true)
    expect(library.games().every((g) => !g.metadata.sources?.['art:cover:missing'])).toBe(true)
  })

  it('lets the full lane start beside a network stage that runs too long', async () => {
    library.mergeScan('steam', [scanned()])
    library.mergeScan('epic', [EPIC_GAME])
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const cache = fakeImageCache(
      () => false,
      () => held
    )
    const steam = fakeScraper('steam', {
      result: () => ({ metadata: { description: 'd' }, media: {} })
    })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    createService([steam], { imageCache: cache, fullLaneWaitMaxMs: 30 }).enqueue(
      ['steam:620', 'epic:hades'],
      { seeds: [{ gameId: 'epic:hades', kind: 'cover', url: 'https://slow.cdn/hades.jpg' }] }
    )
    // Hades's download never answers; Portal 2 (no seed, no sources) is through the cover lane at once.
    await untilProgress(() => steam.calls.search === 1, 2000)
    expect(library.getGame('epic:hades')?.media.cover).toBeUndefined()
    release()
    await untilDrained()
    expect(library.getGame('epic:hades')?.media.cover).toBe(
      'media://cache/epic_hades/cover.jpg?v=1'
    )
  })

  it('re-reads the local caches for a batch that starts while the full lane is still busy', async () => {
    library.mergeScan('steam', [
      scanned(),
      scanned({ externalId: '440', title: 'TF2', extra: { steamAppId: 440 } })
    ])
    const steam = fakeScraper('steam', {
      delayMs: 40,
      result: () => ({ metadata: { description: 'd' }, media: {} })
    })
    const localArt = fakeLocalArt({})
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    const svc = createService([steam], { localArt })
    svc.enqueue(['steam:620'])
    await untilProgress(() => steam.calls.search === 1)
    expect(localArt.resets).toBe(0)
    svc.enqueue(['steam:440'])
    expect(localArt.resets).toBe(1)
    await untilDrained()
    expect(localArt.resets).toBe(2)
  })

  it("never lands Steam's drawn stand-in cover (PNG under the JPEG name) from a librarycache seed", async () => {
    library.mergeScan('steam', [scanned()])
    const seed = await writePng(
      join(dir, 'appcache', 'librarycache', '620', 'library_600x900.jpg'),
      600,
      900
    )
    const cache = fakeImageCache()
    createService([], { imageCache: cache }).enqueue([], {
      seeds: [{ gameId: 'steam:620', kind: 'cover', path: seed }],
      coverOnly: true
    })
    await untilDrained()
    expect(cache.copies).toEqual([])
    expect(library.getGame('steam:620')?.media.cover).toBeUndefined()
  })

  it("ignores the provider's librarycache seeds when store-client art is turned off", async () => {
    library.mergeScan('steam', [scanned()])
    const seed = await writePng(
      join(dir, 'appcache', 'librarycache', '620', 'library_600x900.jpg'),
      300,
      450
    )
    const cache = fakeImageCache()
    patchSettings((s) => {
      s.scrapers.localArt = false
    })
    createService([], { imageCache: cache }).enqueue([], {
      seeds: [{ gameId: 'steam:620', kind: 'cover', path: seed }],
      coverOnly: true
    })
    await untilDrained()
    expect(cache.copies).toEqual([])
    expect(library.getGame('steam:620')?.media.cover).toBeUndefined()
  })

  it('writes each full-lane game once and announces the batch in one coalesced library:changed', async () => {
    const ids = steamLibrary(5)
    const steam = fakeScraper('steam', {
      result: () => ({ metadata: { description: 'd', releaseDate: '2011-04-18' }, media: {} })
    })
    const igdb = fakeScraper('igdb', {
      result: () => ({ metadata: { genres: ['Puzzle'] }, media: {} })
    })
    const changed: { gameIds?: string[] }[] = []
    events.on('library:changed', (p) => {
      if (p.reason === 'metadata') changed.push(p)
    })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = true
      s.scrapers.artPriority = []
    })
    createService([steam, igdb], {
      hltb: async () => ({ main: 5 }),
      changedIntervalMs: 200
    }).enqueue(ids)
    await untilDrained()
    for (const id of ids)
      expect(library.getGame(id)?.metadata).toMatchObject({
        description: 'd',
        genres: ['Puzzle'],
        hltb: { main: 5 }
      })
    // The status batch, then the first finished game at once and the rest of the window in one event: three
    // scrapers, HLTB and a status per game would have been 25 events before.
    expect(changed.length).toBeLessThanOrEqual(3)
    expect(changed[0].gameIds?.length).toBe(5)
    expect(
      changed
        .slice(1)
        .flatMap((p) => p.gameIds ?? [])
        .sort()
    ).toEqual([...ids].sort())
  })
})

describe('HowLongToBeat: Solo times for games looked up before', () => {
  const old = (main: number): NonNullable<Game['metadata']['hltb']> => ({
    main,
    updatedAt: '2026-01-01T00:00:00.000Z'
  })

  it('looks up again the games whose HLTB times predate Solo times, once', async () => {
    library.mergeScan('steam', [scanned()])
    library.mergeScan('epic', [EPIC_GAME])
    library.applyMetadata('steam:620', { metadata: { hltb: old(8.6) } }, { overwrite: true })
    library.applyMetadata(
      'epic:hades',
      { metadata: { hltb: { main: 20, combined: false, updatedAt: '2026-01-01T00:00:00.000Z' } } },
      { overwrite: true }
    )
    const asked: string[] = []
    const svc = createService([], {
      hltb: async (title) => {
        asked.push(title)
        return { main: 60.4, solo: 67.2, combined: true }
      }
    })
    await svc.backfillHltb()
    // Hades already carries the flag: not asked.
    expect(asked).toEqual(['Portal 2'])
    expect(library.getGame('steam:620')?.metadata.hltb).toMatchObject({
      main: 60.4,
      solo: 67.2,
      combined: true
    })
    expect(library.getGame('epic:hades')?.metadata.hltb?.main).toBe(20)
    // Once per run.
    await svc.backfillHltb()
    expect(asked).toHaveLength(1)
  })

  it('keeps the old times when HLTB does not answer, and stops after five failures in a row', async () => {
    const scans = Array.from({ length: 7 }, (_, i) =>
      scanned({ externalId: String(100 + i), title: `Game ${i}`, extra: { steamAppId: 100 + i } })
    )
    library.mergeScan('steam', scans)
    for (let i = 0; i < 7; i++)
      library.applyMetadata(`steam:${100 + i}`, { metadata: { hltb: old(5) } }, { overwrite: true })
    let calls = 0
    const svc = createService([], {
      hltbOutcome: async () => {
        calls++
        return { times: null, failed: true }
      }
    })
    await svc.backfillHltb()
    expect(calls).toBe(5)
    expect(library.getGame('steam:100')?.metadata.hltb).toEqual(old(5))
  })

  it('looks up again a scraped game that has no times, and records a real "no match" for a month', async () => {
    // Phoenix Wright: Ace Attorney Trilogy before the year fix: scraped, no HLTB times.
    library.mergeScan('steam', [
      scanned({
        externalId: '787480',
        title: 'Phoenix Wright: Ace Attorney Trilogy',
        extra: { steamAppId: 787480 }
      }),
      scanned({ externalId: '999', title: 'Unknown Game', extra: { steamAppId: 999 } })
    ])
    library.applyMetadata('steam:787480', { status: 'done' })
    library.applyMetadata('steam:999', { status: 'done' })
    const asked: string[] = []
    const svc = createService([], {
      hltbOutcome: async (title) => {
        asked.push(title)
        return title.startsWith('Phoenix')
          ? { times: { main: 60.4, solo: 67.2, combined: true }, failed: false }
          : { times: null, failed: false }
      }
    })
    await svc.backfillHltb()
    expect(asked.sort()).toEqual(['Phoenix Wright: Ace Attorney Trilogy', 'Unknown Game'])
    expect(library.getGame('steam:787480')?.metadata.hltb).toMatchObject({
      solo: 67.2,
      combined: true
    })
    expect(library.getGame('steam:999')?.metadata.hltb?.missedAt).toBeTruthy()

    // The next run skips the recorded miss; a month later it is asked again.
    const next = createService([], {
      hltbOutcome: async (title) => {
        asked.push(title)
        return { times: null, failed: false }
      }
    })
    await next.backfillHltb()
    expect(asked).toHaveLength(2)
    library.applyMetadata(
      'steam:999',
      { metadata: { hltb: { missedAt: new Date(Date.now() - 31 * 24 * 3600_000).toISOString() } } },
      { overwrite: true }
    )
    const later = createService([], {
      hltbOutcome: async (title) => {
        asked.push(title)
        return { times: null, failed: false }
      }
    })
    await later.backfillHltb()
    expect(asked).toHaveLength(3)
  })

  it('looks a miss recorded by older matching up again at once; a new miss waits a month', async () => {
    library.mergeScan('steam', [
      scanned({
        externalId: '2552430',
        title: 'KINGDOM HEARTS -HD 1.5+2.5 ReMIX-',
        extra: { steamAppId: 2552430 }
      })
    ])
    library.applyMetadata('steam:2552430', { status: 'done' })
    library.applyMetadata(
      'steam:2552430',
      { metadata: { hltb: { missedAt: new Date().toISOString() } } },
      { overwrite: true }
    )
    const asked: [string, number | undefined][] = []
    const svc = createService([], {
      hltbOutcome: async (title, year) => {
        asked.push([title, year])
        return { times: null, failed: false }
      }
    })
    await svc.backfillHltb()
    expect(asked).toEqual([['KINGDOM HEARTS -HD 1.5+2.5 ReMIX-', undefined]])
    expect(library.getGame('steam:2552430')?.metadata.hltb).toMatchObject({
      rules: HLTB_MATCH_RULES
    })
    const next = createService([], {
      hltbOutcome: async (title, year) => {
        asked.push([title, year])
        return { times: null, failed: false }
      }
    })
    await next.backfillHltb()
    expect(asked).toHaveLength(1)
  })

  it('looks a "Game + Add-on" game up again when its times came from older matching (maybe the add-on times)', async () => {
    library.mergeScan('steam', [
      scanned({
        externalId: '2552450',
        title: 'KINGDOM HEARTS III + Re Mind (DLC)',
        extra: { steamAppId: 2552450 }
      }),
      scanned({ externalId: '620', title: 'Portal 2', extra: { steamAppId: 620 } })
    ])
    for (const id of ['steam:2552450', 'steam:620']) {
      library.applyMetadata(id, { status: 'done' })
      library.applyMetadata(
        id,
        { metadata: { hltb: { main: 4.2, combined: false, updatedAt: new Date().toISOString() } } },
        { overwrite: true }
      )
    }
    const asked: string[] = []
    const svc = createService([], {
      hltbOutcome: async (title) => {
        asked.push(title)
        return {
          times: { main: 28.9, extra: 40.2, completionist: 64.6, combined: false },
          failed: false
        }
      }
    })
    await svc.backfillHltb()
    expect(asked).toEqual(['KINGDOM HEARTS III + Re Mind (DLC)'])
    expect(library.getGame('steam:2552450')?.metadata.hltb).toMatchObject({
      main: 28.9,
      rules: HLTB_MATCH_RULES
    })
    expect(library.getGame('steam:620')?.metadata.hltb?.main).toBe(4.2)
  })

  it('shows its progress on the bottom bar and clears it when done', async () => {
    library.mergeScan('steam', [
      scanned({ externalId: '1', title: 'Alpha', extra: { steamAppId: 1 } }),
      scanned({ externalId: '2', title: 'Beta', extra: { steamAppId: 2 } })
    ])
    library.applyMetadata('steam:1', { status: 'done' })
    library.applyMetadata('steam:2', { status: 'done' })
    const reports: { done: number; total: number; current?: string }[] = []
    events.on('hltb:progress', (p) => reports.push(p))
    const svc = createService([], {
      hltbOutcome: async () => ({ times: { main: 5, combined: false }, failed: false })
    })
    await svc.backfillHltb()
    expect(reports[0]).toEqual({ done: 0, total: 2 })
    expect(reports.some((r) => r.total === 2 && !!r.current)).toBe(true)
    expect(reports.at(-1)).toEqual({ done: 0, total: 0 })
  })

  it('clears its bar when HowLongToBeat stops answering', async () => {
    library.mergeScan(
      'steam',
      Array.from({ length: 6 }, (_, i) =>
        scanned({ externalId: String(i + 1), title: `Game ${i}`, extra: { steamAppId: i + 1 } })
      )
    )
    for (let i = 1; i <= 6; i++) library.applyMetadata(`steam:${i}`, { status: 'done' })
    const reports: { total: number }[] = []
    events.on('hltb:progress', (p) => reports.push(p))
    const svc = createService([], { hltbOutcome: async () => ({ times: null, failed: true }) })
    await svc.backfillHltb()
    expect(reports.at(-1)).toEqual({ done: 0, total: 0 })
  })

  it('does nothing while HowLongToBeat is turned off', async () => {
    library.mergeScan('steam', [scanned()])
    library.applyMetadata('steam:620', { metadata: { hltb: old(8.6) } }, { overwrite: true })
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
    })
    let calls = 0
    const svc = createService([], {
      hltb: async () => {
        calls++
        return null
      }
    })
    await svc.backfillHltb()
    expect(calls).toBe(0)
  })
})

describe('HowLongToBeat: the H.L.T.B. sort looks up games without times', () => {
  it('looks up the games without times, writes them and announces them; never games with times or recent misses', async () => {
    library.mergeScan('steam', [
      scanned({ externalId: '620', title: 'Portal 2', extra: { steamAppId: 620 } }),
      scanned({ externalId: '400', title: 'Portal', extra: { steamAppId: 400 } }),
      scanned({ externalId: '70', title: 'Half-Life', extra: { steamAppId: 70 } }),
      scanned({ externalId: '220', title: 'Half-Life 2', extra: { steamAppId: 220 } })
    ])
    for (const id of ['steam:620', 'steam:400', 'steam:70', 'steam:220'])
      library.applyMetadata(id, { status: 'done' })
    const now = new Date().toISOString()
    library.applyMetadata(
      'steam:400',
      { metadata: { hltb: { main: 3, combined: false, updatedAt: now } } },
      { overwrite: true }
    )
    library.applyMetadata(
      'steam:70',
      { metadata: { hltb: { missedAt: now } } },
      { overwrite: true }
    )
    library.applyMetadata(
      'steam:220',
      { metadata: { hltb: { missedAt: new Date(Date.now() - 31 * 24 * 3600_000).toISOString() } } },
      { overwrite: true }
    )
    const asked: string[] = []
    const changed: string[][] = []
    const progress: { done: number; total: number }[] = []
    events.on('library:changed', (p) => {
      if (p.gameIds) changed.push(p.gameIds)
    })
    events.on('hltb:progress', (p) => progress.push(p))
    const svc = createService([], {
      hltbOutcome: async (title) => {
        asked.push(title)
        return { times: title === 'Portal 2' ? { main: 8.5 } : null, failed: false }
      }
    })
    await svc.refreshHltbTimes()
    expect(asked.sort()).toEqual(['Half-Life 2', 'Portal 2'])
    expect(library.getGame('steam:620')?.metadata.hltb).toMatchObject({
      main: 8.5,
      rules: HLTB_MATCH_RULES
    })
    // A miss is recorded again (not asked for another month).
    expect(library.getGame('steam:220')?.metadata.hltb?.missedAt).toBeDefined()
    expect(library.getGame('steam:400')?.metadata.hltb?.main).toBe(3)
    expect(changed).toContainEqual(['steam:620'])
    expect(progress[0]).toMatchObject({ done: 0, total: 2, source: 'sort' })
    expect(progress.at(-1)).toEqual({ done: 0, total: 0, source: 'sort' })
    // Asked again: nothing is due now.
    await svc.refreshHltbTimes()
    expect(asked).toHaveLength(2)
  })

  it('does nothing with HowLongToBeat turned off', async () => {
    library.mergeScan('steam', [
      scanned({ externalId: '620', title: 'Portal 2', extra: { steamAppId: 620 } })
    ])
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
    })
    const asked: string[] = []
    const svc = createService([], {
      hltbOutcome: async (title) => {
        asked.push(title)
        return { times: { main: 1 }, failed: false }
      }
    })
    await svc.refreshHltbTimes()
    expect(asked).toEqual([])
    expect(library.getGame('steam:620')?.metadata.hltb).toBeUndefined()
  })

  it('waits for the start-up pass and does not look a game up twice', async () => {
    library.mergeScan('steam', [
      scanned({ externalId: '620', title: 'Portal 2', extra: { steamAppId: 620 } })
    ])
    library.applyMetadata('steam:620', { status: 'done' })
    const asked: string[] = []
    const svc = createService([], {
      hltbOutcome: async (title) => {
        asked.push(title)
        await new Promise((r) => setTimeout(r, 5))
        return { times: { main: 8.5 }, failed: false }
      }
    })
    const backfill = svc.backfillHltb()
    const sort = svc.refreshHltbTimes()
    await Promise.all([backfill, sort])
    expect(asked).toEqual(['Portal 2'])
    expect(library.getGame('steam:620')?.metadata.hltb?.main).toBe(8.5)
  })
})

describe('same title, another year (SSX of 2000 for its 2012 reboot)', () => {
  const SSX_2000: MetadataCandidate = {
    scraper: 'steamgriddb',
    externalId: '38268',
    title: 'SSX',
    releaseDate: '2000-10-26'
  }
  const SSX_2012: MetadataCandidate = {
    scraper: 'steamgriddb',
    externalId: '5240',
    title: 'SSX',
    releaseDate: '2012-02-28'
  }
  const sgdbFor = (opts: Partial<Parameters<typeof fakeScraper>[1]> = {}): FakeScraper =>
    fakeScraper('steamgriddb', {
      // The older game first, as SteamGridDB's autocomplete answers.
      candidates: () => [SSX_2000, SSX_2012],
      result: (_game, c) => ({
        metadata: { sources: { steamgriddb: c.externalId } },
        media: { cover: `https://sgdb/${c.externalId}/cover.png` }
      }),
      ...opts
    })
  const igdb2012 = (): FakeScraper =>
    fakeScraper('igdb', {
      candidates: () => [
        { scraper: 'igdb', externalId: '4179', title: 'SSX', releaseDate: '2012-02-28' }
      ],
      result: () => ({ metadata: { releaseDate: '2012-02-28', description: 'reboot' }, media: {} })
    })
  const ssxRom = (platformId = 'xbox360'): string => {
    library.mergeScan('rom', [
      scanned({
        source: 'rom',
        externalId: `${platformId}/SSX (USA) (En,Fr,De,Es,It).xiso.iso`,
        platformId,
        title: 'SSX',
        extra: undefined
      })
    ])
    return library.games().find((g) => g.source === 'rom' && g.platformId === platformId)!.id
  }

  it('takes the SteamGridDB game of the year the text sources gave, even after the cover lane took the older one', async () => {
    // A system whose years say nothing (a computer): the cover lane has only the source's order to go by.
    const id = ssxRom('dos')
    const cache = fakeImageCache()
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.steamgriddb.apiKey = 'k'
      s.scrapers.igdb.clientId = 'c'
      s.scrapers.igdb.clientSecret = 's'
      s.scrapers.artPriority = ['steamgriddb']
    })
    const sgdb = sgdbFor()
    createService([igdb2012(), sgdb], { imageCache: cache }).enqueue([id])
    await untilDrained()
    const game = library.getGame(id)!
    expect(game.metadata.sources?.steamgriddb).toBe('5240')
    expect(game.metadata.releaseDate).toBe('2012-02-28')
    // The cover lane's first pick (no year yet) was replaced by the 2012 game's cover.
    const covers = cache.imports.filter((i) => i.kind === 'cover').map((i) => i.url)
    expect(covers).toEqual(['https://sgdb/38268/cover.png', 'https://sgdb/5240/cover.png'])
  })

  it('takes the game of the console the ROM is on from the start: no older game’s cover first, no year needed', async () => {
    library.mergeScan(
      'rom',
      ['xbox360', 'ps3', 'ps2'].map((platformId) =>
        scanned({
          source: 'rom',
          externalId: `${platformId}/SSX (USA).iso`,
          platformId,
          title: 'SSX',
          extra: undefined
        })
      )
    )
    const [xbox360, ps3, ps2] = ['xbox360', 'ps3', 'ps2'].map(
      (platformId) => library.games().find((g) => g.platformId === platformId)!.id
    )
    const cache = fakeImageCache()
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.steamgriddb.apiKey = 'k'
      s.scrapers.artPriority = ['steamgriddb']
    })
    // No text source at all: nothing ever gives these games a year.
    createService([sgdbFor()], { imageCache: cache }).enqueue([xbox360, ps3, ps2])
    await untilDrained()
    // One cover each, from the game of its console's years.
    const covers = Object.fromEntries(
      cache.imports.filter((i) => i.kind === 'cover').map((i) => [i.gameId, i.url])
    )
    expect(cache.imports.filter((i) => i.kind === 'cover')).toHaveLength(3)
    expect(covers).toEqual({
      [xbox360]: 'https://sgdb/5240/cover.png',
      [ps3]: 'https://sgdb/5240/cover.png',
      [ps2]: 'https://sgdb/38268/cover.png'
    })
  })

  const UNDATED: MetadataCandidate = { scraper: 'steamgriddb', externalId: '38268', title: 'SSX' }
  const sgdbOnly = (): void =>
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.steamgriddb.apiKey = 'k'
      s.scrapers.artPriority = ['steamgriddb']
    })

  it.each([
    ['with a text source', true],
    ['without one', false]
  ])(
    'takes the 2012 game for a ps3 ROM when SteamGridDB’s first same-named game has no date (%s)',
    async (_name, withText) => {
      const id = ssxRom('ps3')
      const cache = fakeImageCache()
      sgdbOnly()
      const sgdb = sgdbFor({ candidates: () => [UNDATED, SSX_2012] })
      createService(withText ? [igdb2012(), sgdb] : [sgdb], { imageCache: cache }).enqueue([id])
      await untilDrained()
      expect(cache.imports.map((i) => i.url)).toEqual(['https://sgdb/5240/cover.png'])
      expect(sgdb.calls.fetched.every((c) => c.externalId === '5240')).toBe(true)
    }
  )

  it('replaces an undated match the year speaks against', async () => {
    sgdbOnly()
    // A system without console years: the cover lane takes the undated first; the text year then says 2012.
    const id = ssxRom('dos')
    const cache = fakeImageCache()
    const sgdb = sgdbFor({ candidates: () => [UNDATED, SSX_2012] })
    createService([igdb2012(), sgdb], { imageCache: cache }).enqueue([id])
    await untilDrained()
    expect(library.getGame(id)?.metadata.sources?.steamgriddb).toBe('5240')
    expect(cache.imports.filter((i) => i.kind === 'cover').map((i) => i.url)).toEqual([
      'https://sgdb/38268/cover.png',
      'https://sgdb/5240/cover.png'
    ])
    expect(sgdb.calls.search).toBe(2)
  })

  it('does not search again for an undated match that had no same-titled rival', async () => {
    sgdbOnly()
    const id = ssxRom('dos')
    const cache = fakeImageCache()
    const sgdb = sgdbFor({
      candidates: () => [UNDATED, { ...SSX_2012, externalId: '7', title: 'SSX Tricky' }]
    })
    createService([igdb2012(), sgdb], { imageCache: cache }).enqueue([id])
    await untilDrained()
    expect(sgdb.calls.search).toBe(1)
    expect(cache.imports.map((i) => i.url)).toEqual(['https://sgdb/38268/cover.png'])
  })

  it('for a ps2 ROM with the newer game listed first and no text source: the source’s first (both are in the console’s years)', async () => {
    sgdbOnly()
    const id = ssxRom('ps2')
    const cache = fakeImageCache()
    createService([sgdbFor({ candidates: () => [SSX_2012, SSX_2000] })], {
      imageCache: cache
    }).enqueue([id])
    await untilDrained()
    // The limit of the console's years: the PlayStation 2 had new games until 2013.
    expect(cache.imports.map((i) => i.url)).toEqual(['https://sgdb/5240/cover.png'])
  })

  it('for a ps2 ROM with the newer game listed first: the game of 2000 once a text source gives the year', async () => {
    const igdb2000 = fakeScraper('igdb', {
      candidates: () => [
        { scraper: 'igdb', externalId: '4175', title: 'SSX', releaseDate: '2000-10-26' }
      ],
      result: () => ({ metadata: { releaseDate: '2000-10-26', description: 'first' }, media: {} })
    })
    sgdbOnly()
    const id = ssxRom('ps2')
    const cache = fakeImageCache()
    createService([igdb2000, sgdbFor({ candidates: () => [SSX_2012, SSX_2000] })], {
      imageCache: cache
    }).enqueue([id])
    await untilDrained()
    expect(library.getGame(id)?.metadata.sources?.steamgriddb).toBe('38268')
    expect(cache.imports.filter((i) => i.kind === 'cover').at(-1)?.url).toBe(
      'https://sgdb/38268/cover.png'
    )
  })

  it('leaves a store game of that name to the source’s order (no console to go by)', async () => {
    library.mergeScan('epic', [scanned({ ...EPIC_GAME, externalId: 'ssx', title: 'SSX' })])
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.steamgriddb.apiKey = 'k'
      s.scrapers.artPriority = ['steamgriddb']
    })
    const cache = fakeImageCache()
    createService([sgdbFor()], { imageCache: cache }).enqueue(['epic:ssx'])
    await untilDrained()
    expect(cache.imports.map((i) => i.url)).toEqual(['https://sgdb/38268/cover.png'])
  })
})

describe('a ROM matched with its console (The Legend of Zelda: Link’s Awakening on the Switch)', () => {
  const LIMITED: MetadataCandidate = {
    scraper: 'igdb',
    externalId: '134231',
    title: "The Legend of Zelda: Link's Awakening - Limited Edition",
    releaseDate: '2019-09-20',
    platformIds: [130]
  }
  const OWN: MetadataCandidate = {
    scraper: 'igdb',
    externalId: '113113',
    title: "The Legend of Zelda: Link's Awakening",
    releaseDate: '2019-09-20',
    platformIds: [130]
  }
  const LIMITED_TEXT =
    "This version contains: - The base game: The Legend of Zelda: Link's Awakening - A steelcase simulating a Game Boy."
  const texts: Record<string, string> = { '134231': LIMITED_TEXT, '113113': 'Koholint Island.' }
  /** IGDB as it answered: the edition's record first. `records`: what it says of recorded ids (the re-check). */
  const igdb = (
    records?: Record<string, { title: string }> | Error
  ): FakeScraper & { asked: string[][] } => {
    const asked: string[][] = []
    return Object.assign(
      fakeScraper('igdb', {
        candidates: (game) =>
          /zelda/i.test(game.title)
            ? [LIMITED, OWN]
            : [{ scraper: 'igdb', externalId: `own-${game.id}`, title: game.title }],
        result: (_game, c) => ({
          metadata: {
            sources: { igdb: c.externalId },
            description: texts[c.externalId] ?? 'A game.',
            releaseDate: '2019-09-20',
            links: { website: `https://www.igdb.com/games/${c.externalId}` }
          },
          media: {}
        })
      }),
      {
        asked,
        ...(records
          ? {
              async recordsOf(ids: string[]) {
                asked.push(ids)
                if (records instanceof Error) throw records
                return new Map(Object.entries(records).filter(([id]) => ids.includes(id)))
              }
            }
          : {})
      }
    )
  }
  const rom = (platformId: string, file: string, title: string): string => {
    library.mergeScan('rom', [
      ...library
        .games()
        .filter((g) => g.source === 'rom')
        .map((g) =>
          scanned({
            source: 'rom',
            externalId: g.externalId,
            platformId: g.platformId,
            title: g.title,
            extra: undefined
          })
        ),
      scanned({
        source: 'rom',
        externalId: `${platformId}/${file}`,
        platformId,
        title,
        extra: undefined
      })
    ])
    return library.games().find((g) => g.externalId === `${platformId}/${file}`)!.id
  }
  const zeldaRom = (): string =>
    rom(
      'switch',
      "Super XCI/Other/The Legend of Zelda Link's Awakening [01006BB00C6F0000] [v131072] (1G+1U).xci",
      "The Legend of Zelda Link's Awakening"
    )
  /** The game as an older version matched it: `metadata` recorded, rule 4, done. */
  const matchedBefore = (id: string, metadata: Partial<Game['metadata']>): void => {
    library.applyMetadata(
      id,
      { metadata: { nameMatchRules: 4, ...metadata }, status: 'done' },
      { overwrite: true }
    )
  }
  const quiet = (): void =>
    patchSettings((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
  /** The marked game's failed forced run was long enough ago to be run again. */
  const backdateRematch = (id: string): void => {
    const tried = library.getGame(id)!.metadata.rematchTried!
    library.applyMetadata(
      id,
      { metadata: { rematchTried: { ...tried, at: '2020-01-01T00:00:00.000Z' } } },
      { overwrite: true }
    )
  }

  it('is matched to the game itself, not to the Limited Edition record IGDB lists first', async () => {
    const id = zeldaRom()
    quiet()
    createService([igdb()]).enqueue([id])
    await untilDrained()
    const game = library.getGame(id)!
    expect(game.metadata.sources?.igdb).toBe('113113')
    expect(game.metadata.description).toBe('Koholint Island.')
    expect(game.metadata.nameMatchRules).toBe(NAME_MATCH_RULES)
  })

  it('gives HowLongToBeat the console of a ROM, and none for a store game', async () => {
    const id = zeldaRom()
    library.mergeScan('steam', [scanned()])
    patchSettings((s) => {
      s.scrapers.artPriority = []
    })
    const asked: [string, number | undefined, string[] | undefined][] = []
    createService([igdb()], {
      hltb: async (title, year, consoles) => {
        asked.push([title, year, consoles])
        return { main: 14.5, combined: false }
      }
    }).enqueue([id, 'steam:620'])
    await untilDrained()
    expect(asked.find((a) => /Zelda/.test(a[0]))).toEqual([
      "The Legend of Zelda Link's Awakening",
      2019,
      ['Nintendo Switch']
    ])
    expect(asked.find((a) => a[0] === 'Portal 2')?.[2]).toBeUndefined()
  })

  describe('recheckConsoleMatches', () => {
    const RECORDS = {
      '134231': { title: LIMITED.title },
      '4179': { title: 'SSX' },
      '777': { title: 'Halo 3 - Limited Edition' },
      // Records under another name than the ROM's (an alternative name, a compilation, a Japanese title): whatever
      // IGDB lists them as, they are not an edition of the ROM's title.
      '888': { title: 'Dragon Quest XI S: Echoes of an Elusive Age - Definitive Edition' },
      '889': { title: 'Resident Evil 4: Wii Edition' },
      '890': { title: 'ゼルダの伝説 夢をみる島' }
    }
    const LIMITED_LINK =
      'https://www.igdb.com/games/the-legend-of-zelda-links-awakening-limited-edition'
    /** The reported game as the host has it. */
    const reported = (id: string): void =>
      matchedBefore(id, {
        sources: { igdb: '134231' },
        description: LIMITED_TEXT,
        releaseDate: '2019-09-20',
        links: { website: LIMITED_LINK }
      })
    const expectFixed = (id: string): void => {
      const game = library.getGame(id)!
      expect(game.metadataStatus).toBe('done')
      expect(game.metadata.sources?.igdb).toBe('113113')
      expect(game.metadata.description).toBe('Koholint Island.')
      expect(game.metadata.links?.website).toBe('https://www.igdb.com/games/113113')
      expect(game.metadata.nameMatchRules).toBe(NAME_MATCH_RULES)
      expect(game.metadata.rematch).toBeUndefined()
    }

    it('leaves alone a ROM on a record under another name, and one whose title has nothing to compare', async () => {
      const dq = rom('switch', 'Dragon Quest XI S (USA).xci', 'Dragon Quest XI S')
      const re4 = rom('wii', 'Resident Evil 4 (USA).wbfs', 'Resident Evil 4')
      const jp = rom('gb', 'ポケットモンスター 赤 (Japan).gb', 'ポケットモンスター 赤')
      matchedBefore(dq, { sources: { igdb: '888' }, description: 'Eleven.' })
      matchedBefore(re4, { sources: { igdb: '889' }, description: 'Leon.' })
      matchedBefore(jp, { sources: { igdb: '890' }, description: 'Red.' })
      quiet()
      const source = igdb(RECORDS)
      await createService([source]).recheckConsoleMatches()
      expect(source.asked).toEqual([['888', '889', '890']])
      expect(source.calls.search).toBe(0)
      for (const [id, description] of [
        [dq, 'Eleven.'],
        [re4, 'Leon.'],
        [jp, 'Red.']
      ] as const)
        expect(library.getGame(id)?.metadata).toMatchObject({
          description,
          nameMatchRules: NAME_MATCH_RULES
        })
    })

    it('still replaces the wrong match when the app quits before the flagged game’s run', async () => {
      const zelda = zeldaRom()
      reported(zelda)
      quiet()
      // Flagged and queued, and the app quits before the run starts: the game is as it was, but marked.
      const first = createService([igdb(RECORDS)])
      await first.recheckConsoleMatches()
      first.dispose()
      expect(library.getGame(zelda)?.metadata).toMatchObject({
        rematch: 'igdb',
        description: LIMITED_TEXT,
        nameMatchRules: 4
      })
      expect(library.getGame(zelda)?.metadataStatus).toBe('done')
      // Next start: nothing is asked of IGDB about it again, it is run forced.
      const next = igdb(RECORDS)
      await createService([next]).recheckConsoleMatches()
      await untilDrained()
      expect(next.asked).toEqual([])
      expectFixed(zelda)
    })

    it('forces the marked game’s run whoever enqueues it first (the resume pass, a scan)', async () => {
      const zelda = zeldaRom()
      reported(zelda)
      // In flight when the app quit: left 'pending', with its mark.
      library.applyMetadata(
        zelda,
        { metadata: { rematch: 'igdb' }, status: 'pending' },
        { overwrite: true }
      )
      quiet()
      createService([igdb(RECORDS)]).enqueue([zelda])
      await untilDrained()
      expectFixed(zelda)
    })

    it('keeps the mark when the source that was wrong does not answer in the forced run', async () => {
      const zelda = zeldaRom()
      reported(zelda)
      library.applyMetadata(zelda, { media: { cover: 'media://cover/zelda.png' } })
      quiet()
      // IGDB answers the batch request, then fails the game's search (HTTP 429, an expired token).
      const failing = Object.assign(fakeScraper('igdb', { searchError: 'IGDB: HTTP 429' }), {
        async recordsOf(ids: string[]) {
          return new Map(Object.entries(RECORDS).filter(([id]) => ids.includes(id)))
        }
      })
      await createService([failing]).recheckConsoleMatches()
      await untilDrained()
      expect(failing.calls.search).toBeGreaterThan(0)
      expect(library.getGame(zelda)?.metadata).toMatchObject({
        rematch: 'igdb',
        rematchTried: { count: 1 },
        sources: { igdb: '134231' },
        nameMatchRules: 4
      })
      service?.dispose()
      progress.length = 0
      // Not on every start while the source keeps failing: a start right after it scrapes nothing, whoever enqueues.
      const soon = igdb(RECORDS)
      const held = createService([soon])
      await held.recheckConsoleMatches()
      held.enqueue([zelda])
      expect(soon.asked).toEqual([])
      expect(soon.calls.search).toBe(0)
      expect(progress).toEqual([])
      expect(rematchHeld(library.getGame(zelda)!)).toBe(true)
      service?.dispose()
      // A start after the wait runs it again, and IGDB answers.
      backdateRematch(zelda)
      const next = igdb(RECORDS)
      await createService([next]).recheckConsoleMatches()
      await untilDrained()
      expectFixed(zelda)
      expect(library.getGame(zelda)?.metadata.rematchTried).toBeUndefined()
      // And it ends there: a third start asks nothing and scrapes nothing.
      service?.dispose()
      const third = igdb(RECORDS)
      await createService([third]).recheckConsoleMatches()
      expect(third.asked).toEqual([])
      expect(third.calls.search).toBe(0)
    })

    it('waits longer after each forced run that did not get through', () => {
      const at = Date.parse('2026-01-01T00:00:00.000Z')
      const tried = (count: number): Pick<Game, 'metadata'> => ({
        metadata: { rematch: 'igdb', rematchTried: { at: new Date(at).toISOString(), count } }
      })
      const hour = 60 * 60 * 1000
      expect(rematchHeld(tried(1), at + hour - 1)).toBe(true)
      expect(rematchHeld(tried(1), at + hour)).toBe(false)
      expect(rematchHeld(tried(3), at + 3 * hour)).toBe(true)
      expect(rematchHeld(tried(3), at + 4 * hour)).toBe(false)
      expect(rematchHeld(tried(50), at + 8 * 24 * hour)).toBe(false)
      // No mark, no failed run, a clock set back: nothing is held.
      expect(rematchHeld({ metadata: { rematchTried: tried(1).metadata.rematchTried } }, at)).toBe(
        false
      )
      expect(rematchHeld({ metadata: { rematch: 'igdb' } }, at)).toBe(false)
      expect(rematchHeld(tried(1), at - 1)).toBe(false)
    })

    it('keeps the mark when SteamGridDB fails in the run IGDB answered in: the other game’s art is not kept for good', async () => {
      const zelda = zeldaRom()
      reported(zelda)
      // The art is the 1993 game's; SteamGridDB has the 2019 game too.
      library.applyMetadata(
        zelda,
        {
          media: { cover: 'media://cover/1993.png' },
          metadata: { sources: { steamgriddb: '5253316', 'art:cover': 'steamgriddb' } }
        },
        { overwrite: true }
      )
      patchSettings((s) => {
        s.scrapers.hltb.enabled = false
        s.scrapers.artPriority = ['steamgriddb']
      })
      const down = fakeScraper('steamgriddb', { searchError: 'SteamGridDB: HTTP 429' })
      await createService([igdb(RECORDS), down]).recheckConsoleMatches()
      await untilDrained()
      // The text is the game's own already; the art waits for SteamGridDB.
      expect(library.getGame(zelda)?.metadata).toMatchObject({
        rematch: 'igdb',
        rematchTried: { count: 1 },
        nameMatchRules: 4,
        description: 'Koholint Island.',
        sources: { igdb: '113113', steamgriddb: '5253316' }
      })
      expect(library.getGame(zelda)?.media.cover).toBe('media://cover/1993.png')
      service?.dispose()
      progress.length = 0
      backdateRematch(zelda)
      const sgdb = fakeScraper('steamgriddb', {
        candidates: () => [
          { scraper: 'steamgriddb', externalId: '5253316', title: OWN.title, releaseDate: '1993' },
          { scraper: 'steamgriddb', externalId: '2019', title: OWN.title, releaseDate: '2019' }
        ],
        result: (_game, c) => ({
          metadata: { sources: { steamgriddb: c.externalId } },
          media: { cover: `https://sgdb/${c.externalId}/cover.png` }
        })
      })
      const cache = fakeImageCache()
      await createService([igdb(RECORDS), sgdb], { imageCache: cache }).recheckConsoleMatches()
      await untilDrained()
      expectFixed(zelda)
      expect(library.getGame(zelda)?.metadata.sources?.steamgriddb).toBe('2019')
      expect(cache.imports.map((i) => i.url)).toEqual(['https://sgdb/2019/cover.png'])
    })

    it('does not let the queued forced run overwrite a match the user picks meanwhile', async () => {
      const zelda = zeldaRom()
      reported(zelda)
      quiet()
      const source = igdb(RECORDS)
      const svc = createService([source])
      // Flagged and queued; the user identifies the game before the run starts.
      await svc.recheckConsoleMatches()
      expect(library.getGame(zelda)?.metadata.rematch).toBe('igdb')
      const picked: MetadataCandidate = { ...OWN, externalId: 'USERPICK', title: 'My pick' }
      texts.USERPICK = 'Picked by hand.'
      await svc.apply(zelda, picked)
      await untilDrained()
      delete texts.USERPICK
      const game = library.getGame(zelda)!
      expect(game.metadata.sources).toMatchObject({ igdb: 'USERPICK', [USER_MATCH_SOURCE]: 'igdb' })
      expect(game.metadata.description).toBe('Picked by hand.')
      expect(game.metadata.rematch).toBeUndefined()
      expect(game.metadataStatus).toBe('done')
      // The background run asked nothing: only the user's fetch reached the source.
      expect(source.calls.search).toBe(0)
      expect(source.calls.fetched.map((c) => c.externalId)).toEqual(['USERPICK'])
      // A refresh the user asks for afterwards runs as usual.
      progress.length = 0
      svc.enqueue([zelda], { force: true })
      await untilDrained()
      expect(source.calls.search).toBeGreaterThan(0)
    })

    it('ends when the forced run finds the same record again (IGDB has no other)', async () => {
      const zelda = zeldaRom()
      reported(zelda)
      quiet()
      const onlyEdition = Object.assign(
        fakeScraper('igdb', {
          candidates: () => [LIMITED],
          result: (_game, c) => ({
            metadata: { sources: { igdb: c.externalId }, description: LIMITED_TEXT },
            media: {}
          })
        }),
        {
          async recordsOf(ids: string[]) {
            return new Map(Object.entries(RECORDS).filter(([id]) => ids.includes(id)))
          }
        }
      )
      await createService([onlyEdition]).recheckConsoleMatches()
      await untilDrained()
      expect(onlyEdition.calls.fetch).toBe(1)
      expect(library.getGame(zelda)?.metadata).toMatchObject({
        sources: { igdb: '134231' },
        nameMatchRules: NAME_MATCH_RULES
      })
      expect(library.getGame(zelda)?.metadata.rematch).toBeUndefined()
    })

    it('replaces the edition record’s text also under a ScreenScraper answer that has none of it', async () => {
      const zelda = zeldaRom()
      reported(zelda)
      quiet()
      // First in a ROM's text chain, with genres only.
      const screenscraper = fakeScraper('screenscraper', {
        result: () => ({
          metadata: { sources: { screenscraper: '5' }, genres: ['Adventure'] },
          media: {}
        })
      })
      await createService([screenscraper, igdb(RECORDS)]).recheckConsoleMatches()
      await untilDrained()
      expectFixed(zelda)
      expect(library.getGame(zelda)?.metadata).toMatchObject({
        genres: ['Adventure'],
        sources: { screenscraper: '5', igdb: '113113' }
      })
    })

    it('scrapes again the ROM recorded on an edition’s record, and only that one', async () => {
      const zelda = zeldaRom()
      const ssx = rom('ps3', 'SSX (USA) (En,Fr,Es).iso', 'SSX')
      // A ROM that names the edition is rightly on the edition's record.
      const halo = rom('xbox360', 'Halo 3 - Limited Edition (USA).iso', 'Halo 3 - Limited Edition')
      // The user's own choice is never looked at.
      const picked = rom('switch', "Link's Awakening (hack).xci", "Link's Awakening")
      matchedBefore(zelda, {
        sources: { igdb: '134231' },
        description: LIMITED_TEXT,
        releaseDate: '2019-09-20'
      })
      matchedBefore(ssx, { sources: { igdb: '4179' }, description: 'The reboot.' })
      matchedBefore(halo, { sources: { igdb: '777' }, description: 'With a helmet.' })
      matchedBefore(picked, {
        sources: { igdb: '134231', [USER_MATCH_SOURCE]: 'igdb' },
        description: LIMITED_TEXT
      })
      library.updateGame(zelda, { user: { notes: 'mine' } })
      quiet()
      const source = igdb(RECORDS)
      await createService([source]).recheckConsoleMatches()
      await untilDrained()
      // One request for all of them, and one game scraped.
      expect(source.asked).toEqual([['134231', '4179', '777']])
      expect(source.calls.fetched.map((c) => c.externalId)).toEqual(['113113'])
      const fixed = library.getGame(zelda)!
      expect(fixed.metadata.sources?.igdb).toBe('113113')
      expect(fixed.metadata.description).toBe('Koholint Island.')
      expect(fixed.metadata.links?.website).toBe('https://www.igdb.com/games/113113')
      expect(fixed.metadata.nameMatchRules).toBe(NAME_MATCH_RULES)
      expect(fixed.user.notes).toBe('mine')
      expect(library.getGame(ssx)?.metadata).toMatchObject({
        description: 'The reboot.',
        nameMatchRules: NAME_MATCH_RULES
      })
      expect(library.getGame(halo)?.metadata).toMatchObject({
        description: 'With a helmet.',
        nameMatchRules: NAME_MATCH_RULES
      })
      expect(library.getGame(picked)?.metadata).toMatchObject({
        description: LIMITED_TEXT,
        nameMatchRules: 4
      })
      // Checked once: the next start asks nothing.
      service?.dispose()
      const next = igdb(RECORDS)
      await createService([next]).recheckConsoleMatches()
      expect(next.asked).toEqual([])
      expect(next.calls.search).toBe(0)
    })

    it('asks again next start when IGDB did not answer or is not set up, and does nothing with auto-scrape off', async () => {
      const zelda = zeldaRom()
      matchedBefore(zelda, { sources: { igdb: '134231' }, description: LIMITED_TEXT })
      quiet()
      const down = igdb(new Error('IGDB: HTTP 503'))
      await createService([down]).recheckConsoleMatches()
      expect(down.asked).toHaveLength(1)
      expect(library.getGame(zelda)?.metadata.nameMatchRules).toBe(4)
      service?.dispose()
      const off = Object.assign(igdb(RECORDS), { isConfigured: () => false })
      await createService([off]).recheckConsoleMatches()
      expect(off.asked).toEqual([])
      expect(library.getGame(zelda)?.metadata.nameMatchRules).toBe(4)
      service?.dispose()
      patchSettings((s) => {
        s.scrapers.autoScrape = false
      })
      const manual = igdb(RECORDS)
      await createService([manual]).recheckConsoleMatches()
      expect(manual.asked).toEqual([])
      expect(library.getGame(zelda)?.metadata.description).toBe(LIMITED_TEXT)
    })

    it('scrapes again the ROM whose SteamGridDB art is a same-titled game’s of another year', async () => {
      const ps3 = rom('ps3', 'SSX (USA) (En,Fr,Es).iso', 'SSX')
      const ps2 = rom('ps2', 'Part 1/Bin Files/SSX (USA).chd', 'SSX')
      const other = rom('ps3', 'Journey (USA).iso', 'Journey')
      const art = { 'art:cover': 'steamgriddb', 'art:hero': 'steamgriddb' }
      // Both on the 2000 game's art: right for the PlayStation 2 game only.
      matchedBefore(ps3, { sources: { steamgriddb: '38268', ...art }, releaseDate: '2012-02-28' })
      matchedBefore(ps2, { sources: { steamgriddb: '38268', ...art }, releaseDate: '2000-10-26' })
      matchedBefore(other, { sources: { steamgriddb: '9', ...art }, releaseDate: '2012-03-13' })
      patchSettings((s) => {
        s.scrapers.hltb.enabled = false
        s.scrapers.artPriority = ['steamgriddb']
      })
      const years: string[] = []
      const sgdb = Object.assign(
        fakeScraper('steamgriddb', {
          candidates: () => [
            {
              scraper: 'steamgriddb',
              externalId: '38268',
              title: 'SSX',
              releaseDate: '2000-10-26'
            },
            {
              scraper: 'steamgriddb',
              externalId: '5404410',
              title: 'SSX',
              releaseDate: '2012-02-28'
            }
          ],
          result: (_game, c) => ({
            metadata: { sources: { steamgriddb: c.externalId } },
            media: { cover: `https://sgdb/${c.externalId}/cover.png` }
          })
        }),
        {
          async yearOf(id: string) {
            years.push(id)
            return id === '38268' ? 2000 : null
          }
        }
      )
      const cache = fakeImageCache()
      await createService([sgdb], { imageCache: cache }).recheckConsoleMatches()
      await untilDrained()
      // One request by the recorded id each; a search only for the game whose year is off.
      expect([...years].sort()).toEqual(['38268', '38268', '9'])
      expect(sgdb.calls.search).toBe(2)
      expect(sgdb.calls.fetch).toBe(1)
      expect(library.getGame(ps3)?.metadata.sources?.steamgriddb).toBe('5404410')
      expect(library.getGame(ps3)?.metadata.rematch).toBeUndefined()
      expect(cache.imports.map((i) => i.url)).toEqual(['https://sgdb/5404410/cover.png'])
      expect(library.getGame(ps2)?.metadata.sources?.steamgriddb).toBe('38268')
      expect(library.getGame(ps2)?.metadata.nameMatchRules).toBe(NAME_MATCH_RULES)
      expect(library.getGame(other)?.metadata.nameMatchRules).toBe(NAME_MATCH_RULES)
    })
  })

  describe('recheckConsoleMatches: SteamGridDB art of another year, no other game of that title in the library', () => {
    const art = { 'art:cover': 'steamgriddb', 'art:hero': 'steamgriddb' }
    /** The game on the 2000 game's art, all four kinds. */
    const onOldArt = (id: string): void => {
      matchedBefore(id, {
        sources: {
          steamgriddb: '38268',
          ...art,
          'art:logo': 'steamgriddb',
          'art:icon': 'steamgriddb'
        },
        releaseDate: '2012-02-28'
      })
      library.applyMetadata(id, {
        media: { cover: 'old-cover', hero: 'old-hero', logo: 'old-logo', icon: 'old-icon' }
      })
    }
    const SSX = (id: string, releaseDate?: string): MetadataCandidate => ({
      scraper: 'steamgriddb',
      externalId: id,
      title: 'SSX',
      ...(releaseDate ? { releaseDate } : {})
    })
    const sgdbWith = (
      candidates: MetadataCandidate[],
      yearsById: Record<string, number | Error>
    ): FakeScraper & { years: string[] } => {
      const years: string[] = []
      return Object.assign(
        fakeScraper('steamgriddb', {
          candidates: () => candidates,
          result: (_game, c) => ({
            metadata: { sources: { steamgriddb: c.externalId } },
            media: { cover: `https://sgdb/${c.externalId}/cover.png` }
          })
        }),
        {
          years,
          async yearOf(id: string) {
            years.push(id)
            const year = yearsById[id]
            if (year instanceof Error) throw year
            return year ?? null
          }
        }
      )
    }
    const settle = (): void =>
      patchSettings((s) => {
        s.scrapers.hltb.enabled = false
        s.scrapers.artPriority = ['steamgriddb']
      })

    it('re-matches a lone ps3 SSX on the 2000 game’s art', async () => {
      const ps3 = rom('ps3', 'SSX (USA) (En,Fr,Es).iso', 'SSX')
      matchedBefore(ps3, { sources: { steamgriddb: '38268', ...art }, releaseDate: '2012-02-28' })
      settle()
      const sgdb = sgdbWith([SSX('38268', '2000-10-26'), SSX('5404410', '2012-02-28')], {
        '38268': 2000
      })
      const cache = fakeImageCache()
      await createService([sgdb], { imageCache: cache }).recheckConsoleMatches()
      await untilDrained()
      expect(sgdb.years).toEqual(['38268'])
      expect(library.getGame(ps3)?.metadata.sources?.steamgriddb).toBe('5404410')
      expect(library.getGame(ps3)?.metadata.nameMatchRules).toBe(NAME_MATCH_RULES)
      expect(cache.imports.map((i) => i.url)).toEqual(['https://sgdb/5404410/cover.png'])
    })

    it('drops the art kinds of the other game that the right game does not have', async () => {
      const ps3 = rom('ps3', 'SSX (USA) (En,Fr,Es).iso', 'SSX')
      onOldArt(ps3)
      settle()
      // The right game has a cover only.
      const sgdb = sgdbWith([SSX('38268', '2000-10-26'), SSX('5404410', '2012-02-28')], {
        '38268': 2000
      })
      const cache = fakeImageCache()
      await createService([sgdb], { imageCache: cache }).recheckConsoleMatches()
      await untilDrained()
      const game = library.getGame(ps3)!
      expect(game.media.cover).toMatch(/^media:\/\/cache\//)
      expect(game.media.hero).toBeUndefined()
      expect(game.media.logo).toBeUndefined()
      expect(game.media.icon).toBeUndefined()
      expect(game.metadata.sources).toMatchObject({ steamgriddb: '5404410' })
      expect(game.metadata.sources).not.toHaveProperty('art:logo')
      expect(game.metadata.sources).not.toHaveProperty('art:icon')
      expect(game.metadata.rematch).toBeUndefined()
      expect(game.metadata.nameMatchRules).toBe(NAME_MATCH_RULES)
    })

    it('keeps the mark while the right game’s images do not download, and tries again later', async () => {
      const ps3 = rom('ps3', 'SSX (USA) (En,Fr,Es).iso', 'SSX')
      onOldArt(ps3)
      settle()
      const candidates = [SSX('38268', '2000-10-26'), SSX('5404410', '2012-02-28')]
      const sgdb = sgdbWith(candidates, { '38268': 2000 })
      await createService([sgdb], {
        imageCache: fakeImageCache(() => true)
      }).recheckConsoleMatches()
      await untilDrained()
      // Missing art, not the other game's; and not settled.
      expect(library.getGame(ps3)?.media.cover).toBeUndefined()
      expect(library.getGame(ps3)?.metadata).toMatchObject({
        rematch: 'steamgriddb',
        rematchTried: { count: 1 },
        nameMatchRules: 4
      })
      service?.dispose()
      progress.length = 0
      backdateRematch(ps3)
      const cache = fakeImageCache()
      await createService([sgdbWith(candidates, {})], { imageCache: cache }).recheckConsoleMatches()
      await untilDrained()
      expect([...new Set(cache.imports.map((i) => i.url))]).toEqual([
        'https://sgdb/5404410/cover.png'
      ])
      expect(library.getGame(ps3)?.media.cover).toContain('media://cache/')
      expect(library.getGame(ps3)?.metadata.sources?.steamgriddb).toBe('5404410')
      expect(library.getGame(ps3)?.metadata.rematch).toBeUndefined()
      expect(library.getGame(ps3)?.metadata.nameMatchRules).toBe(NAME_MATCH_RULES)
    })

    it('takes SteamGridDB’s undated game of that title for one dated years away, in a new scrape and in the re-check', async () => {
      // SteamGridDB has no date for many newer games: the 2000 game dated, the 2012 one not.
      const candidates = [SSX('38268', '2000-10-26'), SSX('5404410')]
      const ps3 = rom('ps3', 'SSX (USA) (En,Fr,Es).iso', 'SSX')
      const old = rom('ps3', 'Part 2/SSX (Europe).iso', 'SSX')
      matchedBefore(old, { sources: { steamgriddb: '38268', ...art }, releaseDate: '2012-02-28' })
      settle()
      const cache = fakeImageCache()
      const svc = createService([sgdbWith(candidates, { '38268': 2000 })], { imageCache: cache })
      // No text source: the console's years speak against the dated one.
      svc.enqueue([ps3])
      await untilDrained()
      expect(cache.imports.map((i) => i.url)).toEqual(['https://sgdb/5404410/cover.png'])
      progress.length = 0
      await svc.recheckConsoleMatches()
      await untilDrained()
      expect(library.getGame(old)?.metadata.sources?.steamgriddb).toBe('5404410')
      expect(cache.imports.length).toBeGreaterThan(1)
      expect(cache.imports.every((i) => i.url === 'https://sgdb/5404410/cover.png')).toBe(true)
    })

    it('stops asking SteamGridDB about the library once it does not answer, and asks the rest next start', async () => {
      const ids = Array.from({ length: 12 }, (_, i) => {
        const id = rom('ps3', `Game ${i} (USA).iso`, `Game ${i}`)
        matchedBefore(id, {
          sources: { steamgriddb: `${100 + i}`, ...art },
          releaseDate: '2012-02-28'
        })
        return id
      })
      settle()
      const refused = Object.fromEntries(
        ids.map((_, i) => [`${100 + i}`, new Error('SteamGridDB: HTTP 401')])
      )
      const sgdb = sgdbWith([], refused)
      await createService([sgdb], { imageCache: fakeImageCache() }).recheckConsoleMatches()
      expect(sgdb.years).toHaveLength(3)
      expect(ids.every((id) => library.getGame(id)?.metadata.nameMatchRules === 4)).toBe(true)
      service?.dispose()
      // The key works again: every game is asked about and settled.
      const next = sgdbWith([], {})
      await createService([next], { imageCache: fakeImageCache() }).recheckConsoleMatches()
      expect(next.years).toHaveLength(12)
      expect(
        ids.every((id) => library.getGame(id)?.metadata.nameMatchRules === NAME_MATCH_RULES)
      ).toBe(true)
    })

    it('does not scrape a port again whose year is far from the only SteamGridDB game of its title', async () => {
      // A re-release dated 2012 by its console's source; SteamGridDB has the one game, of 2000.
      const port = rom('ps3', 'SSX (USA) (En,Fr,Es).iso', 'SSX')
      matchedBefore(port, {
        sources: { steamgriddb: '38268', ...art },
        releaseDate: '2012-02-28',
        description: 'kept'
      })
      settle()
      const sgdb = sgdbWith([SSX('38268', '2000-10-26'), SSX('77', '1995-01-01')], {
        '38268': 2000
      })
      await createService([sgdb], { imageCache: fakeImageCache() }).recheckConsoleMatches()
      expect(sgdb.calls.search).toBe(1)
      expect(sgdb.calls.fetch).toBe(0)
      expect(progress).toEqual([])
      expect(library.getGame(port)?.metadata).toMatchObject({
        description: 'kept',
        nameMatchRules: NAME_MATCH_RULES,
        sources: { steamgriddb: '38268' }
      })
    })

    it('asks again next start about a game SteamGridDB did not answer for, and settles the others at once', async () => {
      const ps3 = rom('ps3', 'SSX (USA) (En,Fr,Es).iso', 'SSX')
      const other = rom('ps3', 'Journey (USA).iso', 'Journey')
      matchedBefore(ps3, { sources: { steamgriddb: '38268', ...art }, releaseDate: '2012-02-28' })
      matchedBefore(other, { sources: { steamgriddb: '9', ...art }, releaseDate: '2012-03-13' })
      settle()
      const sgdb = sgdbWith([], { '38268': new Error('SteamGridDB: HTTP 503'), '9': 2012 })
      await createService([sgdb], { imageCache: fakeImageCache() }).recheckConsoleMatches()
      expect(library.getGame(ps3)?.metadata.nameMatchRules).toBe(4)
      expect(library.getGame(other)?.metadata.nameMatchRules).toBe(NAME_MATCH_RULES)
      service?.dispose()
      const next = sgdbWith([], { '38268': 2012 })
      await createService([next], { imageCache: fakeImageCache() }).recheckConsoleMatches()
      expect(next.years).toEqual(['38268'])
      expect(library.getGame(ps3)?.metadata.nameMatchRules).toBe(NAME_MATCH_RULES)
    })
  })

  it('looks up again the HLTB times of a ROM whose short title HLTB lists with its year, and no other game’s', async () => {
    const ssx = rom('ps3', 'SSX (USA) (En,Fr,Es).iso', 'SSX')
    // Short titles too, but nothing recorded says another game has their name: their times stay.
    const okami = rom('ps2', 'Okami (USA).iso', 'Okami')
    const mario = rom('snes', 'Super Mario World (USA).sfc', 'Super Mario World')
    // Two library games of one title, years apart: the later one may have the older one's times.
    const prince = rom('ps3', 'Prince of Persia (USA).iso', 'Prince of Persia')
    const princeOld = rom('dos', 'Prince of Persia.zip', 'Prince of Persia')
    const zelda = zeldaRom()
    library.mergeScan('epic', [scanned({ ...EPIC_GAME, externalId: 'prey', title: 'Prey' })])
    const times = (rules: number): NonNullable<Game['metadata']['hltb']> => ({
      main: 5,
      combined: false,
      rules,
      updatedAt: '2026-01-01T00:00:00.000Z'
    })
    // IGDB numbers the address of a game that shares its name with an older one.
    matchedBefore(ssx, {
      releaseDate: '2012-02-28',
      hltb: times(4),
      links: { website: 'https://www.igdb.com/games/ssx--1' }
    })
    matchedBefore(okami, {
      releaseDate: '2006-04-20',
      hltb: times(4),
      links: { website: 'https://www.igdb.com/games/okami' }
    })
    matchedBefore(mario, { releaseDate: '1990-11-21', hltb: times(4) })
    matchedBefore(prince, { releaseDate: '2008-12-02', hltb: times(4) })
    matchedBefore(princeOld, { releaseDate: '1989-10-03', hltb: times(5) })
    matchedBefore(zelda, { releaseDate: '2019-09-20', hltb: times(4) })
    library.applyMetadata(
      'epic:prey',
      { metadata: { releaseDate: '2017-05-05', hltb: times(4) }, status: 'done' },
      { overwrite: true }
    )
    const asked: [string, number | undefined, string[] | undefined][] = []
    const svc = createService([], {
      hltbOutcome: async (title, year, consoles) => {
        asked.push([title, year, consoles])
        return { times: { main: 8, combined: false }, failed: false }
      }
    })
    await svc.backfillHltb()
    expect([...asked].sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ['Prince of Persia', 2008, ['Sony PlayStation 3']],
      ['SSX', 2012, ['Sony PlayStation 3']]
    ])
    expect(library.getGame(ssx)?.metadata.hltb).toMatchObject({ main: 8, rules: HLTB_MATCH_RULES })
    expect(library.getGame(okami)?.metadata.hltb).toMatchObject({ main: 5, rules: 4 })
    expect(library.getGame(mario)?.metadata.hltb).toMatchObject({ main: 5, rules: 4 })
    expect(library.getGame(zelda)?.metadata.hltb?.main).toBe(5)
    service?.dispose()
    const next = createService([], {
      hltbOutcome: async (title, year, consoles) => {
        asked.push([title, year, consoles])
        return { times: null, failed: false }
      }
    })
    await next.backfillHltb()
    expect(asked).toHaveLength(2)
  })
})
