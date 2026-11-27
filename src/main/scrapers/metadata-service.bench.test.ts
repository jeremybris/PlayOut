// Simulated-time benchmark of the art pipeline (docs/ARCHITECTURE.md §4.6 "Art pipeline", §7 `npm run bench:art`):
// how long a library of N games takes to show its first cover, 90 % of its covers, every locally available cover,
// every cover and the final "done", with stub scrapers, local caches and direct sources whose per-request cost
// mimics the real rate limits. Skipped unless PLAYOUT_BENCH=1:
//
//   PLAYOUT_BENCH=1 npx vitest run src/main/scrapers/metadata-service.bench.test.ts
//   PLAYOUT_BENCH=1 PLAYOUT_BENCH_GAMES=3000 npx vitest run src/main/scrapers/metadata-service.bench.test.ts
//
// The clock is vitest's fake timer: every stub awaits setTimeout for its cost, and the test advances time in steps
// until the queue drains, so a 3,000-game library "runs" in seconds of real time and the numbers are the simulated
// wall-clock, not this machine's speed. The "before" column is a recorded profile, not a re-run: the single FIFO
// queue the service had until the cover lane (CONCURRENCY = 2, text chain first, art per kind through
// `artPriority`; owned imports downloaded store art with 4 workers first) no longer exists, so those figures are
// the ones ARCHITECTURE.md §4.6 was written against and are not tied to today's cost model. "After" is measured
// here, with the cover lane + full lane of today's service.
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import type {
  ArtKind,
  Game,
  MetadataCandidate,
  MetadataProgress,
  OwnedGame,
  ScannedGame,
  ScraperId,
  StoreSourceId
} from '../../shared/types'
import { EventBus } from '../events'
import { LibraryService, type RemoteMediaImport } from '../services/library-service'
import { LibraryStore } from '../store/library-store'
import { SessionsStore } from '../store/sessions-store'
import { SettingsStore } from '../store/settings-store'
import type { LocalArtLookup } from './cover-lane'
import { gogProductIdOf } from './gog-api'
import { safeGameId } from './image-cache'
import { createMetadataService } from './metadata-service'
import { steamAppIdOf } from './steam-store'
import type { ArtCandidates, DirectArtSource, ImageCache, MetadataService, Scraper } from './types'

const BENCH = process.env.PLAYOUT_BENCH === '1'
const GAMES = Math.max(1, Number.parseInt(process.env.PLAYOUT_BENCH_GAMES ?? '300', 10) || 300)
/** Simulated time advanced per step; small enough that a 150 ms download is not rounded away. */
const STEP_MS = 50
/** Give up (and fail) when a scenario has not drained after this much simulated time. */
const CAP_MS = 12 * 60 * 60 * 1000

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

// ---------------------------------------------------------------------------
// Cost model (per request, ms). The real limiters are token buckets; a long queue through one behaves like a
// serial slot every 1/perSecond s, which is what `Slot` reproduces.
// ---------------------------------------------------------------------------

const COST = {
  /** store.steampowered.com appdetails: RateLimiter(1, 2) → 1 request / 2 s, shared by every Steam game. */
  steamStore: 2000,
  /** CDN GET (a hit or a 404): no limiter, plain network latency. */
  cdn: 150,
  /** IGDB RateLimiter(4, 1). */
  igdb: 250,
  /** SteamGridDB RateLimiter(3, 3). */
  sgdb: 333,
  /** TheGamesDB RateLimiter(2, 2). */
  tgdb: 500,
  /** GOG api RateLimiter(2, 2). */
  gog: 500,
  /** HowLongToBeat RateLimiter(1, 1). */
  hltb: 1000,
  /** One image download (image-cache importRemote): CDN hosts, no gate. */
  download: 150,
  /**
   * One local copy (image-cache importLocal): the cold probe of §4.6 landed 5,200 covers in 10.8 s with 16 in
   * flight after a 1.06 s index, i.e. ~1.9 ms per cover effective = ~15 ms per copy at 16 in flight (warm: 5.2 s).
   */
  copy: 15,
  /**
   * Building the local indexes on the first lookup, cold (the 2026-11-02 16:05 probe: assetcache.vdf, 9,790
   * folders and the Galaxy webcache read from disk in 1,060 ms; warm runs do it in ~43 ms). The cold number is
   * used so the first-cover bound below is one the model can actually miss.
   */
  index: 1060,
  /** One index lookup. */
  lookup: 1
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Serial slot limiter: callers are served in order, one every `intervalMs` of simulated time. */
class Slot {
  private next = 0
  requests = 0
  busyMs = 0
  constructor(private readonly intervalMs: number) {}
  async take(): Promise<void> {
    const at = Math.max(Date.now(), this.next)
    this.next = at + this.intervalMs
    this.requests++
    this.busyMs += this.intervalMs
    await sleep(at + this.intervalMs - Date.now())
  }
}

interface Services {
  steamStore: Slot
  igdb: Slot
  sgdb: Slot
  tgdb: Slot
  gog: Slot
  hltb: Slot
  downloads: { count: number; misses: number; inFlight: number; peak: number; urls: string[] }
  copies: { count: number }
}

function newServices(): Services {
  return {
    steamStore: new Slot(COST.steamStore),
    igdb: new Slot(COST.igdb),
    sgdb: new Slot(COST.sgdb),
    tgdb: new Slot(COST.tgdb),
    gog: new Slot(COST.gog),
    hltb: new Slot(COST.hltb),
    downloads: { count: 0, misses: 0, inFlight: 0, peak: 0, urls: [] },
    copies: { count: 0 }
  }
}

const TEXT = {
  description: 'A game.',
  genres: ['Action'],
  developers: ['Studio'],
  releaseDate: '2015-01-01'
}

function candidate(id: ScraperId, game: Game): MetadataCandidate {
  return { scraper: id, externalId: `${id}-${game.externalId}`, title: game.title }
}

/**
 * Stub scrapers with the request pattern of the real ones (number of API calls per search / fetch, which calls run
 * in parallel, what each returns) and the per-request cost above.
 */
function stubScrapers(svc: Services): Scraper[] {
  const steam: Scraper = {
    id: 'steam',
    isConfigured: () => true,
    async search(game) {
      if (!steamAppIdOf(game)) return []
      await svc.steamStore.take() // appdetails (cached for the fetch)
      return [candidate('steam', game)]
    },
    async fetch(game) {
      // fetch: appdetails from the cache, then three HEADs on the CDN in parallel (cover, hero, logo).
      await Promise.all([sleep(COST.cdn), sleep(COST.cdn), sleep(COST.cdn)])
      const appId = steamAppIdOf(game)
      const cdn = (file: string): string => `https://cdn.example/steam/apps/${appId}/${file}`
      return {
        title: game.title,
        metadata: { ...TEXT, sources: { steam: String(appId) } },
        media: {
          cover: cdn('library_600x900_2x.jpg'),
          hero: cdn('library_hero.jpg'),
          logo: cdn('logo.png'),
          screenshots: [1, 2, 3, 4].map((i) => cdn(`ss_${i}.jpg`))
        }
      }
    }
  }
  const gog: Scraper = {
    id: 'gog',
    isConfigured: () => true,
    async search(game) {
      if (!gogProductIdOf(game)) return []
      await svc.gog.take() // products/<id> (cached for the fetch)
      return [candidate('gog', game)]
    },
    async fetch(game) {
      await svc.gog.take() // gamesdb release
      const id = gogProductIdOf(game)
      return {
        title: game.title,
        metadata: { ...TEXT, sources: { gog: String(id) } },
        media: {
          cover: `https://images.example/gog/${id}/cover.jpg`,
          hero: `https://images.example/gog/${id}/hero.jpg`,
          screenshots: [1, 2].map((i) => `https://images.example/gog/${id}/ss_${i}.jpg`)
        }
      }
    }
  }
  const igdb: Scraper = {
    id: 'igdb',
    isConfigured: () => true,
    async search(game) {
      await svc.igdb.take() // games search
      return [candidate('igdb', game)]
    },
    async fetch(game, c) {
      await svc.igdb.take() // games by id
      await svc.igdb.take() // logos
      return {
        title: game.title,
        metadata: { ...TEXT, sources: { igdb: c.externalId } },
        media: {
          cover: `https://images.example/igdb/${c.externalId}/cover.jpg`,
          screenshots: [1, 2, 3].map(
            (i) => `https://images.example/igdb/${c.externalId}/ss_${i}.jpg`
          )
        }
      }
    }
  }
  const tgdb: Scraper = {
    id: 'thegamesdb',
    isConfigured: () => true,
    async search(game) {
      await svc.tgdb.take() // Games/ByGameName (entry cached for the fetch)
      return [candidate('thegamesdb', game)]
    },
    async fetch(game, c) {
      await svc.tgdb.take() // Games/Images (developer/publisher/genre tables are cached after the first game)
      return {
        title: game.title,
        metadata: { ...TEXT, sources: { thegamesdb: c.externalId } },
        media: { cover: `https://images.example/tgdb/${c.externalId}/boxart.jpg` }
      }
    }
  }
  const sgdb: Scraper = {
    id: 'steamgriddb',
    artKinds: ['cover', 'hero', 'logo', 'icon'],
    isConfigured: () => true,
    async search(game) {
      await svc.sgdb.take() // games/steam/<appid> or search/autocomplete
      return [candidate('steamgriddb', game)]
    },
    async fetch(game, c, _settings, kinds) {
      // One request per kind asked for (grids, heroes, logos, icons; all four when none is named), in parallel,
      // all through the same limiter: the cover lane asks for the grid only.
      const wanted = kinds?.length
        ? kinds.filter((k) => k !== 'screenshot')
        : ['cover', 'hero', 'logo', 'icon']
      await Promise.all(wanted.map(() => svc.sgdb.take()))
      const base = `https://cdn.example/sgdb/${c.externalId}`
      return {
        title: game.title,
        metadata: { sources: { steamgriddb: c.externalId } },
        media: {
          cover: `${base}/grid.png`,
          hero: `${base}/hero.png`,
          logo: `${base}/logo.png`,
          icon: `${base}/icon.png`
        }
      }
    }
  }
  return [steam, gog, igdb, tgdb, sgdb]
}

function stubImageCache(
  svc: Services,
  failing: (url: string) => boolean = () => false
): ImageCache {
  return {
    dir: 'C:\\bench\\media',
    async importSteamThumbnail() {
      return null
    },
    async moveGame() {
      return (url: string) => url
    },
    async pruneSteamThumbnails() {
      return undefined
    },
    async importRemote(gameId, kind, url, index) {
      svc.downloads.count++
      svc.downloads.urls.push(url)
      svc.downloads.inFlight++
      svc.downloads.peak = Math.max(svc.downloads.peak, svc.downloads.inFlight)
      await sleep(COST.download)
      svc.downloads.inFlight--
      if (failing(url)) {
        svc.downloads.misses++
        return null
      }
      return `media://cache/${safeGameId(gameId)}/${kind}${index === undefined ? '' : `-${index}`}.jpg?v=1`
    },
    async importLocal(gameId, kind) {
      svc.copies.count++
      await sleep(COST.copy)
      return `media://cache/${safeGameId(gameId)}/${kind}.jpg?v=local`
    },
    async importHostCopy(gameId, kind) {
      return `media://cache/${safeGameId(gameId)}/${kind}-host.jpg?v=local`
    },
    async importCustom(gameId, kind) {
      return `media://cache/${safeGameId(gameId)}/custom-${kind}.jpg?v=local`
    },
    async remove() {
      return undefined
    },
    resolve() {
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Synthetic library: 60% Steam, 20% Epic, 20% GOG, interleaved the way a multi-store scan or import lands them.
// Of the Steam games, 44 % have a cover in the local librarycache (the measured share of this PC, research §13.2),
// 92 % of the rest are on the Steam CDN, the remaining ~4.5 % only on SteamGridDB. Epic and GOG covers come from
// the stores' own image servers (Galaxy's webcache is left out so the Steam numbers stay the pessimistic case).
// ---------------------------------------------------------------------------

type Mix = { source: StoreSourceId; weight: number }
const MIX: Mix[] = [
  { source: 'steam', weight: 3 },
  { source: 'epic', weight: 1 },
  { source: 'gog', weight: 1 }
]
const LOCAL_SHARE = 44
const CDN_SHARE = LOCAL_SHARE + Math.round(0.92 * (100 - LOCAL_SHARE)) // 96

function sourceAt(i: number): StoreSourceId {
  const total = MIX.reduce((n, m) => n + m.weight, 0)
  let slot = i % total
  for (const m of MIX) {
    if (slot < m.weight) return m.source
    slot -= m.weight
  }
  return MIX[0].source
}

const bucket = (appId: number): number => (appId * 7919) % 100
const hasLocalCover = (appId: number): boolean => bucket(appId) < LOCAL_SHARE
const onCdn = (appId: number): boolean => bucket(appId) < CDN_SHARE

function syntheticScanned(i: number): ScannedGame {
  const source = sourceAt(i)
  const externalId =
    source === 'steam' ? String(10000 + i) : source === 'gog' ? String(1200000000 + i) : `app-${i}`
  return {
    source,
    externalId,
    platformId: source,
    title: `Game ${i}`,
    launch: { kind: 'uri', uri: `${source}://run/${externalId}` },
    tracking: { mode: 'installDir', installDir: `C:\\Games\\${source}\\${i}` },
    extra:
      source === 'steam'
        ? { steamAppId: Number(externalId) }
        : source === 'gog'
          ? { gogProductId: externalId }
          : { epicAppName: externalId }
  }
}

function syntheticOwned(i: number): { source: StoreSourceId; game: OwnedGame } {
  const scanned = syntheticScanned(i)
  // Steam seeds have the shape `accounts/steam.ts` builds (`/steam/apps/<appid>/library_600x900_2x.jpg`), which is
  // what the cover lane's `_2x` -> `library_600x900.jpg` fallback keys on.
  const base =
    scanned.source === 'steam'
      ? `https://cdn.example/steam/apps/${scanned.externalId}`
      : `https://cdn.example/${scanned.source}/${scanned.externalId}`
  return {
    source: sourceAt(i),
    game: {
      externalId: scanned.externalId,
      title: scanned.title,
      coverUrl: scanned.source === 'steam' ? `${base}/library_600x900_2x.jpg` : `${base}/cover.jpg`,
      heroUrl: `${base}/library_hero.jpg`,
      logoUrl: `${base}/logo.png`,
      extra: scanned.extra
    }
  }
}

const steamAppOfUrl = (url: string): number | null => {
  const m = /steam\/apps\/(\d+)\//.exec(url)
  return m ? Number(m[1]) : null
}

/** Store CDN seeds: 15 % of Steam `_2x` covers 404 (older apps); the fallback `library_600x900.jpg` always exists. */
const missingSeed = (url: string): boolean => {
  const appId = steamAppOfUrl(url)
  return appId !== null && appId % 20 < 3 && url.endsWith('library_600x900_2x.jpg')
}

/** Direct Steam CDN: both the `_2x` and the plain cover 404 for the ~4.5 % of apps that are only on SteamGridDB. */
const missingDirect = (url: string): boolean => {
  const appId = steamAppOfUrl(url)
  return appId !== null && !onCdn(appId) && url.includes('cdn.direct')
}

/** Stub of the local registry: one index build on the first lookup, then a 1 ms lookup per game. */
function stubLocalArt(): LocalArtLookup & { lookups: number; indexed: number } {
  let index: Promise<void> | null = null
  const out = {
    lookups: 0,
    indexed: 0,
    async lookup(game: Game): Promise<ArtCandidates> {
      if (!index) {
        out.indexed++
        index = sleep(COST.index)
      }
      await index
      out.lookups++
      await sleep(COST.lookup)
      const appId = steamAppIdOf(game)
      if (!appId || !hasLocalCover(appId)) return {}
      return {
        cover: [
          {
            kind: 'cover',
            source: 'steam-cache',
            path: `C:\\Steam\\appcache\\librarycache\\${appId}\\library_600x900.jpg`,
            width: 300,
            height: 450
          }
        ]
      }
    },
    reset() {
      index = null
    }
  }
  return out
}

/** Stubs of the direct sources: Steam CDN / GOG / Epic templates (no request) and SteamGridDB's batched grids. */
function stubDirectSources(svc: Services): DirectArtSource[] {
  const template = (
    id: DirectArtSource['id'],
    urls: (game: Game, kind: ArtKind) => string[] | null
  ): DirectArtSource => ({
    id,
    batchSize: 1,
    isConfigured: () => true,
    async candidates(games, kinds) {
      const out = new Map<string, ArtCandidates>()
      for (const { game } of games) {
        const c: ArtCandidates = {}
        for (const kind of kinds) {
          const list = urls(game, kind)
          if (list) c[kind] = list.map((url) => ({ kind, source: id, url }))
        }
        if (Object.keys(c).length) out.set(game.id, c)
      }
      return out
    }
  })
  const steamCdn = template('steam-cdn', (game, kind) => {
    const appId = steamAppIdOf(game)
    if (!appId) return null
    const base = `https://cdn.direct/steam/apps/${appId}`
    if (kind === 'cover') return [`${base}/library_600x900_2x.jpg`, `${base}/library_600x900.jpg`]
    if (kind === 'hero') return [`${base}/library_hero.jpg`]
    if (kind === 'logo') return [`${base}/logo.png`]
    return null
  })
  const gogImages = template('gog-images', (game, kind) => {
    const id = gogProductIdOf(game)
    if (!id || (kind !== 'cover' && kind !== 'hero')) return null
    return [`https://images.direct/gog/${id}/${kind}.jpg`]
  })
  const epicCatalog = template('epic-catalog', (game, kind) => {
    if (game.source !== 'epic' || kind === 'icon' || kind === 'screenshot') return null
    return [`https://cdn.direct/epic/${game.externalId}/${kind}.jpg`]
  })
  const sgdbPlatform: DirectArtSource = {
    id: 'steamgriddb-platform',
    batchSize: 50,
    isConfigured: () => true,
    async candidates(games, kinds) {
      // One request per kind per batch of up to 50 appids, through SteamGridDB's limiter.
      const out = new Map<string, ArtCandidates>()
      for (const kind of kinds) {
        await svc.sgdb.take()
        for (const { game } of games) {
          const appId = steamAppIdOf(game)
          if (!appId) continue
          const c = out.get(game.id) ?? {}
          c[kind] = [
            {
              kind,
              source: 'steamgriddb-platform',
              url: `https://cdn.direct/sgdb/${appId}/${kind}.png`
            }
          ]
          out.set(game.id, c)
        }
      }
      return out
    }
  }
  return [steamCdn, gogImages, epicCatalog, sgdbPlatform]
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir: string
let library: LibraryService
let settings: SettingsStore
let stores: { flush(): Promise<void> }[]
let events: EventBus
let service: MetadataService | null

interface Timeline {
  t0: number
  firstCoverMs: number | null
  covers90Ms: number | null
  localCoversMs: number | null
  allCoversMs: number | null
  /** The first full-lane game reported done (text + art + HLTB): the covers must all be in before this. */
  firstDoneMs: number | null
  allDoneMs: number | null
  changedEvents: number
  /** Busiest simulated second: how many library:changed events the renderer would debounce there. */
  peakEventsPerSecond: number
  covered: Set<string>
  /** When each downloaded cover (store seed, CDN, SteamGridDB: anything that is not a local copy) landed. */
  cdnCoverTimes: number[]
}

function watch(ids: string[], localIds: Set<string>): Timeline {
  const want = new Set(ids)
  const perSecond = new Map<number, number>()
  const tl: Timeline = {
    t0: Date.now(),
    firstCoverMs: null,
    covers90Ms: null,
    localCoversMs: null,
    allCoversMs: null,
    firstDoneMs: null,
    allDoneMs: null,
    changedEvents: 0,
    peakEventsPerSecond: 0,
    covered: new Set(),
    cdnCoverTimes: []
  }
  let localCovered = 0
  events.on('library:changed', (payload) => {
    tl.changedEvents++
    const sec = Math.floor((Date.now() - tl.t0) / 1000)
    const n = (perSecond.get(sec) ?? 0) + 1
    perSecond.set(sec, n)
    tl.peakEventsPerSecond = Math.max(tl.peakEventsPerSecond, n)
    for (const id of payload.gameIds ?? []) {
      if (!want.has(id) || tl.covered.has(id)) continue
      const game = library.getGame(id)
      if (!game?.media.cover) continue
      tl.covered.add(id)
      const at = Date.now() - tl.t0
      if (!/-cache$|-files$|-media$/.test(game.metadata.sources?.['art:cover'] ?? ''))
        tl.cdnCoverTimes.push(at)
      if (tl.firstCoverMs === null) tl.firstCoverMs = at
      if (tl.covers90Ms === null && tl.covered.size >= Math.ceil(0.9 * want.size))
        tl.covers90Ms = at
      if (localIds.has(id) && ++localCovered === localIds.size) tl.localCoversMs = at
      if (tl.covered.size === want.size) tl.allCoversMs = at
    }
  })
  events.on('metadata:progress', (p: MetadataProgress) => {
    if (p.lane === 'full' && p.status !== 'pending' && tl.firstDoneMs === null)
      tl.firstDoneMs = Date.now() - tl.t0
    if (p.queued === 0 && tl.allDoneMs === null) tl.allDoneMs = Date.now() - tl.t0
  })
  return tl
}

async function drain(tl: Timeline): Promise<void> {
  while (tl.allDoneMs === null && Date.now() - tl.t0 < CAP_MS)
    await vi.advanceTimersByTimeAsync(STEP_MS)
}

function createService(
  scrapers: Scraper[],
  imageCache: ImageCache,
  svc: Services,
  localArt: LocalArtLookup,
  directSources: DirectArtSource[]
): MetadataService {
  service = createMetadataService(
    { settings, library, imageCache, events, resourcesDir: join(dir, 'resources'), log },
    {
      scrapers,
      hltbLookup: async () => {
        await svc.hltb.take()
        return { main: 10 }
      },
      steamCurrentPlayers: async () => null,
      resumePending: false,
      localArt,
      directSources
    }
  )
  return service
}

const fmt = (ms: number | null): string =>
  ms === null
    ? 'never'
    : ms >= 60_000
      ? `${(ms / 60_000).toFixed(1)} min`
      : `${(ms / 1000).toFixed(1)} s`

function cdnRate(tl: Timeline): number | null {
  if (tl.cdnCoverTimes.length < 2) return null
  const span = tl.cdnCoverTimes[tl.cdnCoverTimes.length - 1] - tl.cdnCoverTimes[0]
  return span > 0 ? (1000 * (tl.cdnCoverTimes.length - 1)) / span : null
}

/**
 * The "before" column: the single FIFO queue, from the profile the contract was written against (§4.6). A recorded
 * profile, not re-run here (that code path is gone), so it is not tied to `COST`.
 */
const BEFORE: Record<number, { scan: Record<string, string>; owned: Record<string, string> }> = {
  300: {
    scan: {
      'first cover visible': '6.9 s',
      'all covers visible': '17.9 min',
      'all games done (text + art + HLTB)': '18.0 min'
    },
    owned: {
      'first cover visible': '0.2 s',
      'all covers visible': '3.4 min (store art phase) + queue',
      'all games done (text + art + HLTB)': '20.7 min'
    }
  },
  3000: {
    scan: {
      'first cover visible': '6.9 s',
      'all covers visible': '2.9 h',
      'all games done (text + art + HLTB)': '2.9 h'
    },
    owned: {
      'first cover visible': '0.2 s',
      'all covers visible': '34 min (store art phase) + queue',
      'all games done (text + art + HLTB)': '3.4 h'
    }
  }
}

function report(
  title: string,
  n: number,
  tl: Timeline,
  svc: Services,
  before: Record<string, string> | undefined,
  extra: string[] = []
): void {
  const wall = tl.allDoneMs ?? CAP_MS
  const util = (s: Slot): string =>
    `${s.requests} req, limiter busy ${fmt(s.busyMs)} (${((100 * s.busyMs) / wall).toFixed(0)}% of wall)`
  const rate = cdnRate(tl)
  const row = (label: string, after: string): string =>
    `| ${label} | ${before?.[label] ?? '-'} | ${after} |`
  const lines = [
    '',
    `### ${title} (${n} games: ${MIX.map((m) => `${m.source} ${Math.round((100 * m.weight) / MIX.reduce((a, b) => a + b.weight, 0))}%`).join(', ')})`,
    '',
    '| metric | before (single queue; recorded profile, not re-run) | after (cover lane + full lane) |',
    '| --- | --- | --- |',
    row('first cover visible', fmt(tl.firstCoverMs)),
    row('90 % of covers visible', fmt(tl.covers90Ms)),
    row('every locally available cover visible', fmt(tl.localCoversMs)),
    row('all covers visible', fmt(tl.allCoversMs)),
    row('first game fully done (text + art + HLTB)', fmt(tl.firstDoneMs)),
    row('all games done (text + art + HLTB)', fmt(tl.allDoneMs)),
    row('downloaded covers per second', rate === null ? '-' : `${rate.toFixed(1)} / s`),
    row('image downloads in flight (peak)', String(svc.downloads.peak)),
    row('library:changed events', `${tl.changedEvents} (peak ${tl.peakEventsPerSecond}/s)`),
    ...extra.map((e) => `| ${e} |`),
    '',
    '| service | load |',
    '| --- | --- |',
    `| Steam store appdetails (1 req / 2 s) | ${util(svc.steamStore)} |`,
    `| SteamGridDB (3 req / s) | ${util(svc.sgdb)} |`,
    `| TheGamesDB (2 req / s) | ${util(svc.tgdb)} |`,
    `| IGDB (4 req / s) | ${util(svc.igdb)} |`,
    `| GOG api (2 req / s) | ${util(svc.gog)} |`,
    `| HowLongToBeat (1 req / s) | ${util(svc.hltb)} |`,
    `| image downloads (150 ms each) | ${svc.downloads.count} downloads (${svc.downloads.misses} misses) |`,
    `| local copies (${COST.copy} ms each, 16 in flight) | ${svc.copies.count} |`,
    ''
  ]
  console.log(lines.join('\n'))
}

/** The acceptance table of §4.6 "Art pipeline" (first cover < 2 s: the cold index alone is ~1.1 s). */
function assertAcceptance(tl: Timeline, n: number): void {
  expect(tl.firstCoverMs).not.toBeNull()
  expect(tl.firstCoverMs!).toBeLessThan(2000)
  expect(tl.localCoversMs).not.toBeNull()
  expect(tl.localCoversMs!).toBeLessThan(n >= 3000 ? 10_000 : 2000)
  const rate = cdnRate(tl)
  if (rate !== null) expect(rate).toBeGreaterThanOrEqual(6)
  expect(tl.allCoversMs).not.toBeNull()
  expect(tl.allCoversMs!).toBeLessThan(n >= 3000 ? 10 * 60_000 : 60_000)
  expect(tl.firstDoneMs).not.toBeNull()
  expect(tl.allCoversMs!).toBeLessThanOrEqual(tl.firstDoneMs!)
  expect(tl.allDoneMs).not.toBeNull()
}

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-bench-'))
  events = new EventBus()
  const libStore = new LibraryStore(join(dir, 'library.json'))
  const sessions = new SessionsStore(join(dir, 'sessions.json'))
  settings = new SettingsStore(join(dir, 'settings.json'))
  stores = [libStore, sessions, settings]
  await Promise.all([libStore.load(), sessions.load(), settings.load()])
  library = new LibraryService(libStore, sessions, events)
  settings.mutate((s) => {
    s.scrapers.steamgriddb.apiKey = 'bench'
    s.scrapers.igdb.clientId = 'bench'
    s.scrapers.igdb.clientSecret = 'bench'
    s.scrapers.thegamesdb.apiKey = 'bench'
    s.scrapers.localArt = true
  })
  service = null
})
afterEach(async () => {
  service?.dispose()
  vi.useRealTimers()
  // The debounced store writes are still in flight on the real event loop; let them land before the folder goes.
  await Promise.all(stores.map((s) => s.flush()))
  await fs.rm(dir, { recursive: true, force: true })
}, 600_000)

describe.skipIf(!BENCH)('art pipeline benchmark (PLAYOUT_BENCH=1)', () => {
  it(`scan of ${GAMES} games with no seeds: local caches, then direct URLs, then SteamGridDB`, async () => {
    const svc = newServices()
    const bySource = new Map<StoreSourceId, ScannedGame[]>()
    for (let i = 0; i < GAMES; i++) {
      const source = sourceAt(i)
      bySource.set(source, [...(bySource.get(source) ?? []), syntheticScanned(i)])
    }
    const ids: string[] = []
    for (const [source, games] of bySource) ids.push(...library.mergeScan(source, games).newGameIds)
    const localIds = new Set(
      ids.filter((id) => {
        const appId = steamAppIdOf(library.getGame(id)!)
        return typeof appId === 'number' && hasLocalCover(appId)
      })
    )
    const tl = watch(ids, localIds)
    const localArt = stubLocalArt()
    createService(
      stubScrapers(svc),
      stubImageCache(svc, missingDirect),
      svc,
      localArt,
      stubDirectSources(svc)
    ).enqueue(ids)
    await drain(tl)
    report('Scan, no seeds', GAMES, tl, svc, BEFORE[GAMES]?.scan, [
      `games with a cover in the local Steam cache | ${localIds.size}`,
      `local index builds / lookups | ${localArt.indexed} / ${localArt.lookups}`
    ])
    assertAcceptance(tl, GAMES)
    expect(tl.covered.size).toBe(GAMES)
  }, 600_000)

  it(`owned import of ${GAMES} games: store CDN seeds first, local caches and direct URLs for the misses`, async () => {
    const svc = newServices()
    const bySource = new Map<StoreSourceId, OwnedGame[]>()
    for (let i = 0; i < GAMES; i++) {
      const { source, game } = syntheticOwned(i)
      bySource.set(source, [...(bySource.get(source) ?? []), game])
    }
    const ids: string[] = []
    const remote: RemoteMediaImport[] = []
    for (const [source, games] of bySource) {
      const merge = library.mergeOwned(source, games)
      ids.push(...merge.newGameIds)
      remote.push(...merge.remoteMedia)
    }
    const localIds = new Set(
      ids.filter((id) => {
        const appId = steamAppIdOf(library.getGame(id)!)
        return typeof appId === 'number' && hasLocalCover(appId)
      })
    )
    const tl = watch(ids, localIds)
    const localArt = stubLocalArt()
    // accounts/index.ts: one enqueue with the store URLs as seeds (ARCHITECTURE.md §4.8).
    createService(
      stubScrapers(svc),
      stubImageCache(svc, (url) => missingSeed(url) || missingDirect(url)),
      svc,
      localArt,
      stubDirectSources(svc)
    ).enqueue([...ids, ...remote.map((m) => m.gameId)], { seeds: remote })
    await drain(tl)
    // Seeds of games with a local cover never reach the network stage; the rest of the 404ing _2x seeds do.
    const fallbacks = remote.filter((m) => missingSeed(m.url) && !localIds.has(m.gameId))
    const fallbackDownloads = svc.downloads.urls.filter((u) =>
      /cdn\.example\/steam\/apps\/\d+\/library_600x900\.jpg$/.test(u)
    )
    report('Owned import, store CDN seeds', GAMES, tl, svc, BEFORE[GAMES]?.owned, [
      `seeds (cover + hero + logo URLs) | ${remote.length}`,
      `Steam _2x seeds that 404 and fall back to library_600x900.jpg | ${fallbacks.length} (fallback downloads ${fallbackDownloads.length})`
    ])
    // The fallback path really ran: one library_600x900.jpg download per 404ed _2x seed, and no other.
    expect(fallbackDownloads).toHaveLength(fallbacks.length)
    // The owned import is the primary case of the acceptance table: held to every bound of it.
    assertAcceptance(tl, GAMES)
    expect(tl.covered.size).toBe(GAMES)
  }, 600_000)
})
