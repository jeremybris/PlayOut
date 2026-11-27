// "Refresh missing" fills missing art; cover-less runs are remembered (coverMissing) and retried after a back-off;
// a newly saved art key runs the same pass; a quit keeps the queue; TheGamesDB pauses after a 429. Fake library
// stores in a temp folder, fake scrapers / image cache, fake keys: no network.
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import {
  artSourcesConfigured,
  configuredArtSources,
  missingArtKinds
} from '../../shared/art-sources'
import { defaultSettings } from '../../shared/defaults'
import type {
  ArtKind,
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
import { HttpError, RateLimiter } from './http'
import { safeGameId } from './image-cache'
import { coverMissingRecently, createMetadataService, failedRetryDelayMs } from './metadata-service'
import {
  artSourceConfigured,
  checkArtSourcesSinceLastRun,
  coverlessCounts,
  missingTargets,
  queueMissing,
  readSavedArtSources,
  saveArtSources,
  watchArtKeys
} from './missing-art'
import { createTheGamesDbScraper, TGDB_RATE_LIMIT_PAUSE_MS } from './thegamesdb'
import type {
  ArtCandidates,
  DirectArtSource,
  ImageCache,
  MetadataService,
  ScrapedResult,
  Scraper
} from './types'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeScraper extends Scraper {
  calls: { search: number; fetch: number; kinds: (ArtKind[] | undefined)[] }
}

function fakeScraper(
  id: ScraperId,
  opts: {
    configured?: () => boolean
    result?: (game: Game, candidate: MetadataCandidate) => ScrapedResult
    searchError?: () => Error | null
    available?: () => boolean
  } = {}
): FakeScraper {
  const calls = { search: 0, fetch: 0, kinds: [] as (ArtKind[] | undefined)[] }
  return {
    id,
    calls,
    artKinds: id === 'steamgriddb' ? ['cover', 'hero', 'logo', 'icon'] : undefined,
    isConfigured: () => opts.configured?.() ?? true,
    ...(opts.available ? { available: opts.available } : {}),
    async search(game) {
      calls.search++
      const err = opts.searchError?.()
      if (err) throw err
      return [{ scraper: id, externalId: `${id}-1`, title: game.title }]
    },
    async fetch(game, candidate, _settings, kinds) {
      calls.fetch++
      calls.kinds.push(kinds)
      return opts.result ? opts.result(game, candidate) : { metadata: {}, media: {} }
    }
  }
}

function fakeImageCache(): ImageCache & {
  imports: { gameId: string; kind: string; url: string }[]
} {
  const imports: { gameId: string; kind: string; url: string }[] = []
  return {
    dir: 'C:\\fake\\media',
    imports,
    async importSteamThumbnail() {
      return null
    },
    async moveGame() {
      return (url: string) => url
    },
    async pruneSteamThumbnails() {
      return undefined
    },
    async importRemote(gameId, kind, url) {
      imports.push({ gameId, kind, url })
      if (url.includes('/gone/')) return null
      return `media://cache/${safeGameId(gameId)}/${kind}.jpg?v=1`
    },
    async importLocal() {
      return null
    },
    async importHostCopy() {
      return null
    },
    async importCustom() {
      return null
    },
    async remove() {
      return undefined
    },
    resolve() {
      return null
    }
  }
}

function fakeDirect(
  urls: Record<string, Partial<Record<ArtKind, string[]>>>
): DirectArtSource & { asked: number } {
  const out = {
    id: 'steam-cdn' as const,
    asked: 0,
    batchSize: 1,
    isConfigured: () => true,
    async candidates(games: { game: Game }[], kinds: ArtKind[]) {
      out.asked++
      const map = new Map<string, ArtCandidates>()
      for (const { game } of games) {
        const row = urls[game.id]
        if (!row) continue
        const c: ArtCandidates = {}
        for (const kind of kinds)
          if (row[kind])
            c[kind] = row[kind]!.map((url) => ({ kind, source: 'steam-cdn' as const, url }))
        map.set(game.id, c)
      }
      return map
    }
  }
  return out as unknown as DirectArtSource & { asked: number }
}

const ROM: ScannedGame = {
  source: 'rom',
  externalId: 'ps2/007 Nightfire (USA).chd',
  platformId: 'ps2',
  title: '007 - Nightfire',
  launch: { kind: 'emulator', systemId: 'ps2', romPath: 'D:\\roms\\ps2\\007 Nightfire (USA).chd' },
  tracking: { mode: 'spawned' }
}

function steamGame(appId: number, title: string): ScannedGame {
  return {
    source: 'steam',
    externalId: String(appId),
    platformId: 'steam',
    title,
    launch: { kind: 'uri', uri: `steam://rungameid/${appId}` },
    tracking: { mode: 'installDir', installDir: `C:\\Steam\\steamapps\\common\\${title}` },
    extra: { steamAppId: appId }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir: string
let library: LibraryService
let settings: SettingsStore
let events: EventBus
let progress: MetadataProgress[]
let service: MetadataService | null

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${JSON.stringify(progress)}`)
    await sleep(5)
  }
}
const untilDrained = (): Promise<void> => until(() => progress.some((p) => p.queued === 0))

function createService(
  scrapers: Scraper[],
  extras: {
    hltb?: () => Promise<{ main?: number } | null>
    directSources?: DirectArtSource[]
    imageCache?: ImageCache
    resumeDelayMs?: number
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
      steamCurrentPlayers: async () => null,
      steamPeakPlayers: async () => null,
      resumePending: extras.resumeDelayMs !== undefined,
      resumeDelayMs: extras.resumeDelayMs,
      localArt: { lookup: async () => ({}), reset: () => undefined },
      directSources: extras.directSources ?? [],
      batch: { intervalMs: 10 },
      changedIntervalMs: 10
    }
  )
  return service
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-missing-art-'))
  events = new EventBus()
  progress = []
  events.on('metadata:progress', (p) => progress.push(p))
  const libStore = new LibraryStore(join(dir, 'library.json'))
  const sessions = new SessionsStore(join(dir, 'sessions.json'))
  settings = new SettingsStore(join(dir, 'settings.json'))
  await Promise.all([libStore.load(), sessions.load(), settings.load()])
  library = new LibraryService(libStore, sessions, events)
  service = null
  log.info.mockClear()
})
afterEach(async () => {
  service?.dispose()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

/** "Refresh missing" as the IPC handler runs it (handlers.ts refreshMetadata without ids or force). */
function refreshMissing(): number {
  return queueMissing(library, service!, log, 'refresh missing')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Refresh missing fills missing art', () => {
  it('finds the cover of a matched ROM once a SteamGridDB key is saved; text and edits stay', async () => {
    let sgdbKey = ''
    const sgdb = fakeScraper('steamgriddb', {
      configured: () => sgdbKey.length > 0,
      result: () => ({
        metadata: { sources: { steamgriddb: '77' }, description: 'not wanted' },
        media: { cover: 'https://sgdb/cover.png', hero: 'https://sgdb/hero.png' }
      })
    })
    settings.mutate((s) => {
      s.scrapers.artPriority = ['steamgriddb']
    })
    library.mergeScan('rom', [ROM])
    const id = library.games()[0].id
    createService([sgdb], { hltb: async () => ({ main: 10 }) }).enqueue([id])
    await untilDrained()
    let game = library.getGame(id)!
    // HLTB alone is a find: 'done', but without a cover, which is remembered.
    expect(game.metadataStatus).toBe('done')
    expect(game.media.cover).toBeUndefined()
    expect(game.metadata.coverMissing?.count).toBe(1)
    expect(sgdb.calls.search).toBe(0)
    library.setMetadataEdit(id, { description: 'My own words' })
    library.applyMetadata(id, { metadata: { description: 'scraped text' } })

    // The user saves a (fake) key and presses Refresh missing.
    sgdbKey = 'fake-key'
    settings.mutate((s) => {
      s.scrapers.steamgriddb.apiKey = 'fake-key'
    })
    progress = []
    expect(refreshMissing()).toBe(1)
    await untilDrained()
    game = library.getGame(id)!
    expect(sgdb.calls.search).toBe(1)
    expect(game.media.cover).toBe(`media://cache/${safeGameId(id)}/cover.jpg?v=1`)
    expect(game.media.hero).toBe(`media://cache/${safeGameId(id)}/hero.jpg?v=1`)
    expect(game.metadata.sources?.['art:cover']).toBe('steamgriddb')
    expect(game.metadata.sources?.steamgriddb).toBe('77')
    // Text, HLTB and the user's edit are as they were; the status stays 'done'.
    expect(game.metadata.description).toBe('scraped text')
    expect(game.user.metadataEdits?.description).toBe('My own words')
    expect(game.metadata.hltb?.main).toBe(10)
    expect(game.metadataStatus).toBe('done')
    expect(game.metadata.coverMissing).toBeUndefined()
    // No screenshots were asked for: only the missing cover, hero, logo and icon.
    expect(sgdb.calls.kinds.every((k) => !k?.includes('screenshot'))).toBe(true)
  })

  it('skips games with all their art, with custom art, and remote games', () => {
    const base = {
      metadataStatus: 'done',
      metadata: {},
      user: {}
    } as unknown as Game
    const all = { ...base, id: 'a', media: { cover: 'c', hero: 'h', logo: 'l', icon: 'i' } }
    const custom = {
      ...base,
      id: 'b',
      media: { hero: 'h', logo: 'l', icon: 'i' },
      user: { customMedia: { cover: 'C:\\mine.png' } }
    }
    const remote = {
      ...base,
      id: 'c',
      media: {},
      remote: { hostId: 'h', hostName: 'Host' }
    } as unknown as Game
    const noLogo = { ...base, id: 'd', media: { cover: 'c', hero: 'h', icon: 'i' } }
    const pending = { ...all, id: 'e', metadataStatus: 'pending' }
    const games = [all, custom, remote, noLogo, pending] as Game[]
    expect(missingTargets(games)).toEqual(['d', 'e'])
    expect(missingArtKinds(noLogo as Game)).toEqual(['logo'])
    expect(missingArtKinds(remote)).toEqual([])
  })

  it('the start-up pass skips games whose cover look already ran since the process start', () => {
    const start = Date.parse('2026-11-26T10:00:00Z')
    const base = { metadataStatus: 'done', metadata: {}, user: {}, media: {} } as unknown as Game
    const legacy = { ...base, id: 'a' }
    const before = {
      ...base,
      id: 'b',
      metadata: { coverMissing: { at: '2026-11-26T09:00:00Z', count: 1 } }
    }
    const justTried = {
      ...base,
      id: 'c',
      metadata: { coverMissing: { at: '2026-11-26T10:00:11Z', count: 1 } }
    }
    const pending = { ...justTried, id: 'd', metadataStatus: 'pending' }
    const games = [legacy, before, justTried, pending] as Game[]
    expect(missingTargets(games)).toEqual(['a', 'b', 'c', 'd'])
    expect(missingTargets(games, start)).toEqual(['a', 'b', 'd'])
    const enqueue = vi.fn((ids: string[]) => ids.length)
    queueMissing({ games: () => games }, { enqueue }, log, 'art source set up since last run', {
      skipTriedSince: start
    })
    expect(enqueue).toHaveBeenCalledWith(['a', 'b', 'd'], { retryFailed: true, missingArt: true })
  })

  it('returns 0 and logs a line when nothing is missing', () => {
    library.mergeScan('steam', [steamGame(620, 'Portal 2')])
    library.applyMetadata('steam:620', {
      status: 'done',
      media: { cover: 'c', hero: 'h', logo: 'l', icon: 'i' }
    })
    createService([])
    expect(refreshMissing()).toBe(0)
    expect(log.info).toHaveBeenCalledWith(
      'refresh missing: 0 of 0 game(s) without finished metadata or with missing art queued'
    )
  })

  it('does not ask again for a URL recorded as missing (Refresh all does)', async () => {
    library.mergeScan('steam', [steamGame(620, 'Portal 2')])
    library.applyMetadata('steam:620', {
      status: 'done',
      metadata: { sources: { 'art:cover:missing': 'https://cdn/gone/620.jpg' } }
    })
    const cache = fakeImageCache()
    const cdn = fakeDirect({ 'steam:620': { cover: ['https://cdn/gone/620.jpg'] } })
    settings.mutate((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    createService([], { directSources: [cdn], imageCache: cache })
    expect(refreshMissing()).toBe(1)
    await untilDrained()
    expect(cdn.asked).toBeGreaterThan(0)
    expect(cache.imports.filter((i) => i.url === 'https://cdn/gone/620.jpg')).toHaveLength(0)
    expect(library.getGame('steam:620')?.metadataStatus).toBe('done')

    progress = []
    service!.enqueue(['steam:620'], { force: true })
    await untilDrained()
    expect(cache.imports.some((i) => i.url === 'https://cdn/gone/620.jpg')).toBe(true)
  })

  it('fills only the kinds a game lacks: a small cover it has is not replaced', async () => {
    library.mergeScan('steam', [steamGame(620, 'Portal 2')])
    library.applyMetadata('steam:620', {
      status: 'done',
      media: { cover: 'media://old-cover.jpg', hero: 'media://h.jpg', icon: 'media://i.jpg' },
      metadata: { sources: { 'art:cover': 'steam', 'art:cover:quality': 'small' } }
    })
    const sgdb = fakeScraper('steamgriddb', {
      result: () => ({
        metadata: {},
        media: { cover: 'https://sgdb/c.png', logo: 'https://sgdb/l.png' }
      })
    })
    settings.mutate((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.steamgriddb.apiKey = 'fake'
      s.scrapers.artPriority = ['steamgriddb']
    })
    createService([sgdb])
    expect(refreshMissing()).toBe(1)
    await untilDrained()
    const game = library.getGame('steam:620')!
    expect(game.media.logo).toBe(`media://cache/${safeGameId('steam:620')}/logo.jpg?v=1`)
    expect(game.media.cover).toBe('media://old-cover.jpg')
    expect(game.metadata.sources?.['art:cover']).toBe('steam')
  })

  it('ignores the back-offs without erasing them; a landed cover clears them', async () => {
    library.mergeScan('steam', [steamGame(620, 'Portal 2')])
    const at = new Date().toISOString()
    library.applyMetadata('steam:620', {
      status: 'done',
      metadata: { coverMissing: { at, count: 2 }, scrapeMissed: { at, count: 1 } }
    })
    const sgdb = fakeScraper('steamgriddb', {
      result: () => ({ metadata: {}, media: { cover: 'https://sgdb/c.png' } })
    })
    settings.mutate((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.steamgriddb.apiKey = 'fake'
      s.scrapers.artPriority = ['steamgriddb']
    })
    const svc = createService([sgdb])
    // An automatic enqueue waits the back-off out.
    expect(svc.enqueue(['steam:620'])).toBe(0)
    expect(refreshMissing()).toBe(1)
    await untilDrained()
    const game = library.getGame('steam:620')!
    expect(game.media.cover).toBeTruthy()
    expect(game.metadata.coverMissing).toBeUndefined()
    expect(game.metadata.scrapeMissed).toBeUndefined()
  })
})

describe('coverMissing', () => {
  it('is recorded for a cover-less run, counted up, and cleared by a cover', async () => {
    const art: { cover?: string } = {}
    const igdb = fakeScraper('igdb', {
      result: () => ({
        metadata: { description: 'text' },
        media: art.cover ? { cover: art.cover } : {}
      })
    })
    settings.mutate((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = ['igdb']
    })
    library.mergeScan('rom', [ROM])
    const id = library.games()[0].id
    const svc = createService([igdb])
    svc.enqueue([id])
    await untilDrained()
    expect(library.getGame(id)?.metadataStatus).toBe('done')
    expect(library.getGame(id)?.metadata.coverMissing?.count).toBe(1)
    progress = []
    svc.enqueue([id], { force: true })
    await untilDrained()
    expect(library.getGame(id)?.metadata.coverMissing?.count).toBe(2)
    art.cover = 'https://igdb/c.jpg'
    progress = []
    svc.enqueue([id], { force: true })
    await untilDrained()
    expect(library.getGame(id)?.media.cover).toBeTruthy()
    expect(library.getGame(id)?.metadata.coverMissing).toBeUndefined()
  })

  it('backs automatic retries off (1 h doubling), art only, no text re-scrape', async () => {
    const now = Date.parse('2026-11-26T12:00:00Z')
    const game = (count: number, ageMs: number): Pick<Game, 'metadata'> => ({
      metadata: { coverMissing: { at: new Date(now - ageMs).toISOString(), count } }
    })
    expect(failedRetryDelayMs(1)).toBe(60 * 60 * 1000)
    expect(coverMissingRecently(game(1, 30 * 60 * 1000), now)).toBe(true)
    expect(coverMissingRecently(game(1, 61 * 60 * 1000), now)).toBe(false)
    expect(coverMissingRecently(game(2, 61 * 60 * 1000), now)).toBe(true)
    expect(coverMissingRecently({ metadata: {} }, now)).toBe(false)

    library.mergeScan('steam', [steamGame(620, 'Portal 2')])
    const steam = fakeScraper('steam', {
      result: () => ({ metadata: { description: 'new text' }, media: {} })
    })
    const sgdb = fakeScraper('steamgriddb', {
      result: () => ({ metadata: {}, media: { cover: 'https://sgdb/c.png' } })
    })
    settings.mutate((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.steamgriddb.apiKey = 'fake'
      s.scrapers.artPriority = ['steamgriddb']
    })
    library.applyMetadata('steam:620', {
      status: 'done',
      metadata: {
        description: 'old text',
        coverMissing: { at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), count: 1 }
      }
    })
    // The start-up resume pass picks up the cover-less game whose back-off ran out.
    createService([steam, sgdb], { resumeDelayMs: 10 })
    await until(() => !!library.getGame('steam:620')?.media.cover)
    await untilDrained()
    expect(steam.calls.search).toBe(0)
    expect(library.getGame('steam:620')?.metadata.description).toBe('old text')
    expect(library.getGame('steam:620')?.metadataStatus).toBe('done')
  })
})

describe('games scraped before 0.9.82 (no coverMissing marker)', () => {
  function legacyCoverless(): { steam: FakeScraper; sgdb: FakeScraper } {
    library.mergeScan('steam', [steamGame(620, 'Portal 2')])
    // 'done' without a cover and without the marker: as an older version left it.
    library.applyMetadata('steam:620', { status: 'done', metadata: { description: 'old text' } })
    expect(library.getGame('steam:620')?.metadata.coverMissing).toBeUndefined()
    const steam = fakeScraper('steam', {
      result: () => ({ metadata: { description: 'new text' }, media: {} })
    })
    const sgdb = fakeScraper('steamgriddb', { result: () => ({ metadata: {}, media: {} }) })
    settings.mutate((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.steamgriddb.apiKey = 'fake'
      s.scrapers.artPriority = ['steamgriddb']
    })
    return { steam, sgdb }
  }

  it('are picked by the start-up retry, art only; the run records the marker', async () => {
    const { steam, sgdb } = legacyCoverless()
    expect(coverlessCounts(library.games())).toEqual({ due: 1, waiting: 0 })
    const svc = createService([steam, sgdb], { resumeDelayMs: 10 })
    await until(() => sgdb.calls.fetch > 0)
    await until(() => !!library.getGame('steam:620')?.metadata.coverMissing)
    await untilDrained()
    expect(steam.calls.search).toBe(0)
    const game = library.getGame('steam:620')!
    expect(game.metadata.description).toBe('old text')
    expect(game.metadataStatus).toBe('done')
    expect(game.metadata.coverMissing?.count).toBe(1)
    expect(coverlessCounts(library.games())).toEqual({ due: 0, waiting: 1 })
    // Within the back-off an automatic enqueue leaves it alone.
    expect(svc.enqueue(['steam:620'])).toBe(0)
  })

  it('are picked by an automatic enqueue as art only, then wait out the back-off', async () => {
    const { steam, sgdb } = legacyCoverless()
    const svc = createService([steam, sgdb])
    expect(svc.enqueue(['steam:620'])).toBe(1)
    await untilDrained()
    expect(steam.calls.search).toBe(0)
    expect(sgdb.calls.fetch).toBe(1)
    expect(library.getGame('steam:620')?.metadata.description).toBe('old text')
    expect(library.getGame('steam:620')?.metadata.coverMissing?.count).toBe(1)
    expect(svc.enqueue(['steam:620'])).toBe(0)
    expect(sgdb.calls.fetch).toBe(1)
  })

  it('do not ask the art chain when a store seed brings the cover', async () => {
    const { steam, sgdb } = legacyCoverless()
    const svc = createService([steam, sgdb])
    svc.enqueue([], { seeds: [{ gameId: 'steam:620', kind: 'cover', url: 'https://cdn/620.jpg' }] })
    await untilDrained()
    expect(library.getGame('steam:620')?.media.cover).toBeTruthy()
    expect(sgdb.calls.fetch).toBe(0)
    expect(steam.calls.search).toBe(0)
    expect(library.getGame('steam:620')?.metadata.coverMissing).toBeUndefined()
  })

  it('are not picked at start-up when auto-scrape is off', async () => {
    const { steam, sgdb } = legacyCoverless()
    settings.mutate((s) => {
      s.scrapers.autoScrape = false
    })
    createService([steam, sgdb], { resumeDelayMs: 10 })
    await sleep(100)
    expect(sgdb.calls.fetch).toBe(0)
    expect(library.getGame('steam:620')?.metadata.coverMissing).toBeUndefined()
  })
})

describe('quit keeps the queue', () => {
  it('leaves unfinished games pending for the resume pass, finished-before ones done', async () => {
    library.mergeScan('steam', [steamGame(620, 'Portal 2'), steamGame(440, 'TF2')])
    library.applyMetadata('steam:440', { status: 'done' })
    const steam = fakeScraper('steam', {
      result: () => ({ metadata: { description: 'd' }, media: {} })
    })
    settings.mutate((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    const svc = createMetadataService(
      {
        settings,
        library,
        imageCache: fakeImageCache(),
        events,
        resourcesDir: join(dir, 'resources'),
        log
      },
      {
        scrapers: [steam],
        hltbLookup: async () => null,
        steamCurrentPlayers: async () => null,
        steamPeakPlayers: async () => null,
        resumePending: false,
        localArt: {
          lookup: () => sleep(40).then(() => ({})),
          reset: () => undefined
        },
        directSources: [],
        batch: { intervalMs: 10 },
        changedIntervalMs: 10
      }
    )
    svc.enqueue(['steam:620'])
    svc.enqueue(['steam:440'], { force: true })
    svc.dispose()
    expect(library.getGame('steam:620')?.metadataStatus).toBe('pending')
    expect(library.getGame('steam:440')?.metadataStatus).toBe('done')

    // The next start resumes the pending game.
    createService([steam], { resumeDelayMs: 10 })
    await until(() => library.getGame('steam:620')?.metadataStatus === 'done')
    expect(library.getGame('steam:620')?.metadata.description).toBe('d')
  })
})

describe('TheGamesDB HTTP 429', () => {
  it('pauses the source for an hour and logs it once', async () => {
    let clock = 1_000_000
    const warn = vi.fn()
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 429 }), {
          status: 429,
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const tgdb = createTheGamesDbScraper({
        now: () => clock,
        http: { retries: 0 },
        log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }
      })
      const s = defaultSettings()
      s.scrapers.thegamesdb.apiKey = 'fake-key'
      const game = { id: 'rom:snes:1', title: 'X', platformId: 'snes', source: 'rom' } as Game
      await expect(tgdb.search(game, s)).rejects.toBeInstanceOf(HttpError)
      expect(tgdb.available?.()).toBe(false)
      await expect(tgdb.search(game, s)).rejects.toBeInstanceOf(HttpError)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledTimes(1)
      // Still configured: a pause is not a removed key.
      expect(tgdb.isConfigured(s)).toBe(true)
      clock += TGDB_RATE_LIMIT_PAUSE_MS
      expect(tgdb.available?.()).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not count a paused source as a per-game error', async () => {
    let paused = false
    const tgdb = fakeScraper('thegamesdb', {
      available: () => !paused,
      searchError: () => {
        paused = true
        return new HttpError('TheGamesDB: rate limit', { status: 429, url: 'https://x' })
      }
    })
    settings.mutate((s) => {
      s.scrapers.hltb.enabled = false
      s.scrapers.artPriority = []
    })
    library.mergeScan('rom', [ROM, { ...ROM, externalId: 'ps2/b.chd', title: 'B' }])
    const ids = library.games().map((g) => g.id)
    createService([tgdb]).enqueue(ids)
    await untilDrained()
    // The first game's request hit the 429; the source then left the chain: one request in all.
    expect(tgdb.calls.search).toBe(1)
    for (const id of ids) {
      const game = library.getGame(id)!
      // Neither an error nor a real miss: the source was not asked (or refused to answer).
      expect(game.metadata.scrapeMissed?.errors).toBeUndefined()
      expect(game.metadata.scrapeMissed?.count ?? 0).toBe(0)
      expect(game.metadata.coverMissing?.count ?? 0).toBe(0)
    }
  })

  it('sends a 429 once (no retries) and drops requests that waited in the rate limiter', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 429 }), {
          status: 429,
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      // The production retry count (3) with no waits; a limiter that holds the second request ~100 ms.
      const tgdb = createTheGamesDbScraper({
        http: { delaysMs: [0] },
        limiter: new RateLimiter(10, 1),
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      })
      const s = defaultSettings()
      s.scrapers.thegamesdb.apiKey = 'fake-key'
      const game = { id: 'rom:snes:1', title: 'X', platformId: 'snes', source: 'rom' } as Game
      const results = await Promise.allSettled([tgdb.search(game, s), tgdb.search(game, s)])
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('a newly saved art key', () => {
  function settingsSource(initial: Settings): {
    get(): Settings
    onChange(l: (s: Settings) => void): void
    set(patch: (s: Settings) => void): void
  } {
    let current = initial
    const listeners: ((s: Settings) => void)[] = []
    return {
      get: () => current,
      onChange: (l) => void listeners.push(l),
      set(patch) {
        current = structuredClone(current)
        patch(current)
        for (const l of listeners) l(current)
      }
    }
  }
  const sgdb = {
    id: 'steamgriddb',
    isConfigured: (s: Settings) => !!s.scrapers.steamgriddb.apiKey.trim()
  } as Scraper

  it('runs the missing-art pass once, debounced, not for other changes nor at start-up', async () => {
    vi.useFakeTimers()
    try {
      const src = settingsSource(defaultSettings())
      const run = vi.fn()
      const watch = watchArtKeys({ settings: src, scrapers: [sgdb], run, log, delayMs: 3000 })
      vi.advanceTimersByTime(10_000)
      expect(run).not.toHaveBeenCalled()
      src.set((s) => {
        s.ui.animations = !s.ui.animations
      })
      vi.advanceTimersByTime(10_000)
      expect(run).not.toHaveBeenCalled()
      // Typing the key: every keystroke saves.
      for (const key of ['a', 'ab', 'abc']) {
        src.set((s) => {
          s.scrapers.steamgriddb.apiKey = key
        })
        vi.advanceTimersByTime(1000)
      }
      expect(run).not.toHaveBeenCalled()
      vi.advanceTimersByTime(3000)
      expect(run).toHaveBeenCalledTimes(1)
      // Already set up: further edits do not run it again.
      src.set((s) => {
        s.scrapers.steamgriddb.apiKey = 'abcd'
      })
      vi.advanceTimersByTime(10_000)
      expect(run).toHaveBeenCalledTimes(1)
      // Cleared before the delay is over: nothing runs.
      src.set((s) => {
        s.scrapers.steamgriddb.apiKey = ''
      })
      src.set((s) => {
        s.scrapers.steamgriddb.apiKey = 'new'
      })
      src.set((s) => {
        s.scrapers.steamgriddb.apiKey = ''
      })
      vi.advanceTimersByTime(10_000)
      expect(run).toHaveBeenCalledTimes(1)
      watch.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs again when another source is set up beside one that already was', () => {
    vi.useFakeTimers()
    try {
      const initial = defaultSettings()
      initial.scrapers.steamgriddb.apiKey = 'fake'
      const src = settingsSource(initial)
      const run = vi.fn()
      const screenscraper = {
        id: 'screenscraper',
        isConfigured: (s: Settings) =>
          !!s.scrapers.screenscraper.devId.trim() && !!s.scrapers.screenscraper.devPassword.trim()
      } as Scraper
      watchArtKeys({ settings: src, scrapers: [sgdb, screenscraper], run, log, delayMs: 3000 })
      src.set((s) => {
        s.scrapers.screenscraper.devId = 'dev'
      })
      vi.advanceTimersByTime(10_000)
      expect(run).not.toHaveBeenCalled()
      src.set((s) => {
        s.scrapers.screenscraper.devPassword = 'pw'
      })
      vi.advanceTimersByTime(1000)
      expect(run).not.toHaveBeenCalled()
      vi.advanceTimersByTime(3000)
      expect(run).toHaveBeenCalledTimes(1)
      src.set((s) => {
        s.scrapers.screenscraper.devPassword = 'pw2'
      })
      vi.advanceTimersByTime(10_000)
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not run when a key was already there at start-up', () => {
    vi.useFakeTimers()
    try {
      const initial = defaultSettings()
      initial.scrapers.steamgriddb.apiKey = 'fake'
      const src = settingsSource(initial)
      const run = vi.fn()
      watchArtKeys({ settings: src, scrapers: [sgdb], run, log })
      src.set((s) => {
        s.scrapers.region = 'eu'
      })
      vi.advanceTimersByTime(10_000)
      expect(run).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells the save hook the set-up sources, a pending one only after its pass', () => {
    vi.useFakeTimers()
    try {
      const src = settingsSource(defaultSettings())
      const run = vi.fn()
      const save = vi.fn()
      watchArtKeys({ settings: src, scrapers: [sgdb], run, log, delayMs: 3000, save })
      src.set((s) => {
        s.scrapers.steamgriddb.apiKey = 'k'
      })
      // Waiting for its pass: not remembered yet (a quit now runs it at the next start).
      expect(save).toHaveBeenLastCalledWith([])
      vi.advanceTimersByTime(3000)
      expect(run).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenLastCalledWith(['steamgriddb'])
      const calls = save.mock.calls.length
      src.set((s) => {
        s.ui.animations = !s.ui.animations
      })
      expect(save).toHaveBeenCalledTimes(calls)
      src.set((s) => {
        s.scrapers.steamgriddb.apiKey = ''
      })
      expect(save).toHaveBeenLastCalledWith([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('the shared rule agrees with the scrapers', () => {
    const s = defaultSettings()
    expect(artSourcesConfigured(s)).toBe(false)
    expect(artSourceConfigured([sgdb], s)).toBe(false)
    s.scrapers.screenscraper.devId = 'dev'
    expect(artSourcesConfigured(s)).toBe(false)
    s.scrapers.screenscraper.devPassword = 'pw'
    expect(configuredArtSources(s.scrapers)).toEqual(['screenscraper'])
    s.scrapers.igdb = { clientId: 'id', clientSecret: 'secret' }
    s.scrapers.thegamesdb.apiKey = 'k'
    s.scrapers.steamgriddb.apiKey = ' '
    expect(configuredArtSources(s.scrapers)).toEqual(['screenscraper', 'igdb', 'thegamesdb'])
  })
})

describe('art sources remembered across runs', () => {
  const sgdb = {
    id: 'steamgriddb',
    isConfigured: (s: Settings) => !!s.scrapers.steamgriddb.apiKey.trim()
  } as Scraper
  const igdb = {
    id: 'igdb',
    isConfigured: (s: Settings) =>
      !!s.scrapers.igdb.clientId.trim() && !!s.scrapers.igdb.clientSecret.trim()
  } as Scraper
  const file = (): string => join(dir, 'missing-art.json')

  function check(s: Settings, run: () => void): Promise<boolean> {
    return checkArtSourcesSinceLastRun({
      file: file(),
      settings: { get: () => s },
      scrapers: [sgdb, igdb],
      library,
      run,
      log
    })
  }

  it('runs once for a source set up since the last run, not when nothing changed', async () => {
    const s = defaultSettings()
    s.scrapers.steamgriddb.apiKey = 'fake-secret-key'
    const run = vi.fn()
    // No file yet (first start of this version) and a source set up: the pass runs.
    expect(await check(s, run)).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    const raw = await fs.readFile(file(), 'utf8')
    expect(JSON.parse(raw)).toEqual({ sources: ['steamgriddb'] })
    // Ids only, never a key.
    expect(raw).not.toContain('fake-secret-key')
    // The next starts: unchanged, nothing runs.
    expect(await check(s, run)).toBe(false)
    expect(await check(s, run)).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
    // IGDB signed in while PlayOut was closed: one more pass.
    s.scrapers.igdb = { clientId: 'id', clientSecret: 'secret' }
    expect(await check(s, run)).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
    expect(await readSavedArtSources(file())).toEqual(['igdb', 'steamgriddb'])
    // A source removed: remembered as gone, nothing runs.
    s.scrapers.steamgriddb.apiKey = ''
    expect(await check(s, run)).toBe(false)
    expect(await readSavedArtSources(file())).toEqual(['igdb'])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('without any source: nothing runs, the empty list is written', async () => {
    const run = vi.fn()
    expect(await check(defaultSettings(), run)).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(await readSavedArtSources(file())).toEqual([])
  })

  it('treats a missing or corrupt file as empty and rewrites it', async () => {
    expect(await readSavedArtSources(file())).toBeNull()
    await fs.writeFile(file(), '{not json', 'utf8')
    expect(await readSavedArtSources(file())).toBeNull()
    const s = defaultSettings()
    s.scrapers.steamgriddb.apiKey = 'fake'
    const run = vi.fn()
    expect(await check(s, run)).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(await readSavedArtSources(file())).toEqual(['steamgriddb'])
    await fs.writeFile(file(), JSON.stringify({ sources: 'x' }), 'utf8')
    expect(await readSavedArtSources(file())).toBeNull()
  })

  it('writes the list atomically through one fixed temporary sibling, which never stays behind', async () => {
    await saveArtSources(file(), ['steamgriddb'])
    await saveArtSources(file(), ['igdb', 'steamgriddb'])
    expect(await readSavedArtSources(file())).toEqual(['igdb', 'steamgriddb'])
    expect((await fs.readdir(dir)).filter((n) => n.startsWith('missing-art'))).toEqual([
      'missing-art.json'
    ])
  })

  it('logs the set-up sources and the cover-less games due vs waiting', async () => {
    library.mergeScan('steam', [steamGame(620, 'Portal 2'), steamGame(440, 'TF2')])
    library.applyMetadata('steam:620', { status: 'done' })
    library.applyMetadata('steam:440', {
      status: 'done',
      metadata: { coverMissing: { at: new Date().toISOString(), count: 1 } }
    })
    const s = defaultSettings()
    s.scrapers.steamgriddb.apiKey = 'fake'
    await check(s, vi.fn())
    expect(log.info).toHaveBeenCalledWith(
      'art sources set up: steamgriddb; games without a cover: 1 due, 1 waiting on their back-off'
    )
  })
})
