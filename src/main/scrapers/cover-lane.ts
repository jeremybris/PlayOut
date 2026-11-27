// The cover lane (docs/ARCHITECTURE.md §4.6 "Art pipeline"): lands one cover per game as cheaply as possible, in
// order seeds -> local caches -> direct URLs -> SteamGridDB, and stops at the first that works. Nothing here searches
// by title except the last step; everything is keyed by the ids `art-ids.ts` collected. The same machinery fills the
// other kinds (hero, logo, icon, screenshots) for the full lane through `fillKinds`, so the cache and direct sources
// are consulted before any `artPriority` scraper. Downloads share one gate of `COVER_DOWNLOADS` slots with a
// no-retry, short-timeout policy and a per-host failure budget, so a dead CDN cannot hold the slots; batch sources
// (SteamGridDB, IGDB, Xbox) fill their batches from the queue behind the game in hand (`lookahead`) and memoise
// the answers, so a 3,000-game run costs ~60 SteamGridDB requests instead of one per game.
import type { ArtKind, Game, Settings } from '../../shared/types'
import type { Logger } from '../logger'
import { missingArtUrls, type LibraryService } from '../services/library-service'
import type { SettingsStore } from '../store/settings-store'
import { Gate, redactUrl } from './http'
import { acceptsKind, sniffImage } from './image-sniff'
import { isSteamDrawnCover } from './local-art/steam-cache'
import type { MediaBatcher } from './media-batch'
import { describeError } from './steam-store'
import type {
  ArtCandidate,
  ArtCandidates,
  ArtIds,
  ArtSeed,
  ArtSourceId,
  DirectArtSource,
  ImageCache,
  MediaPolicy,
  ScrapedResult
} from './types'

// Games in flight in this lane are bounded by the caller (`COVER_CONCURRENCY`, metadata-service.ts).
/** Image downloads in flight across the whole lane (CDN hosts; API-hosted URLs also pass their own policy). */
export const COVER_DOWNLOADS = 8
/** Direct URLs tried per game and kind before the lane gives up on the direct sources. */
const MAX_DIRECT_URLS = 4
/** A batch source's request goes out when its batch is full or this long after the first game joined it. */
const BATCH_WAIT_MS = 100
/** Covers below this height are 'small' (Steam's local / fallback 300x450) and get upgraded by the full lane. */
const SMALL_COVER_HEIGHT = 600
/** Consecutive network-level failures (no HTTP status) after which a host's URLs are skipped for the run. */
export const HOST_FAILURE_BUDGET = 8
/** Direct and seed URLs: a miss is a miss (the full lane's `artPriority` chain is the retry), and a stalled CDN
 * connection gives its download slot back after this long instead of 4 x 45 s. */
export const DIRECT_DOWNLOAD_POLICY: Readonly<Pick<MediaPolicy, 'retries' | 'timeoutMs'>> = {
  retries: 0,
  timeoutMs: 10_000
}

const SEED_ORDER: ArtKind[] = ['cover', 'hero', 'logo', 'icon', 'screenshot']
const STEAM_2X_RE = /\/steam\/apps\/(\d+)\/library_600x900_2x\.jpg(\?.*)?$/i
const STEAM_SMALL_RE = /\/library_600x900\.jpg(\?.*)?$/i

type LandableKind = Exclude<ArtKind, 'screenshot'>

/** The local registry as the lane uses it (`createLocalArtRegistry` in `local-art/index.ts`). */
export interface LocalArtLookup {
  lookup(game: Game, ids: ArtIds, kinds: ArtKind[]): Promise<ArtCandidates>
  /** Drop the memoised indexes so the next run re-reads the disk. */
  reset(): void
}

/**
 * The next games of the caller's queue a batch source may ask for in the same request as the game in hand: up to
 * `limit` games for which `usable(ids)` holds, in queue order. Their answers are memoised, so they skip the
 * collector when their turn comes.
 */
export type Lookahead = (
  limit: number,
  usable: (game: Game, ids: ArtIds) => boolean
) => { game: Game; ids: ArtIds }[]

export interface CoverLaneDeps {
  library: LibraryService
  imageCache: ImageCache
  settings: SettingsStore
  localArt: LocalArtLookup
  directSources: DirectArtSource[]
  batcher: MediaBatcher
  log: Logger
  /**
   * SteamGridDB search + one grids request for one game (the service's memoised `scrapeWith` with `['cover']`),
   * used only for games no platform id reached; absent when no SteamGridDB key is set.
   */
  steamGridDb?: (game: Game, settings: Settings) => Promise<ScrapedResult | null>
}

/**
 * The lane runs every game through the zero-network `local` stage (path seeds, local caches) before any game enters
 * the `network` stage (URL seeds, direct URLs, SteamGridDB), so the covers already on this PC never wait behind
 * downloads.
 */
export type CoverLaneStage = 'local' | 'network'

export interface CoverLaneOptions {
  stage: CoverLaneStage
  seeds: ArtSeed[]
  /** Seeds + local caches only: no direct URLs, no SteamGridDB (autoScrape off). */
  coverOnly: boolean
  /** No network at all (the --art-bench probe): path seeds and local caches only. */
  offline: boolean
  /** A 'done' game named by a seed: the seed step only. */
  seedOnly: boolean
  /** Re-land the cover even when the game already has one (Refresh, custom art cleared). */
  force: boolean
  /**
   * The full lane follows: hero / logo / icon URL seeds are left to it (`fillKinds` with the same seeds), so the
   * download slots serve covers first. Path seeds (zero network) still land here.
   */
  deferExtras?: boolean
  lookahead?: Lookahead
}

export interface CoverLaneOutcome {
  /** Whether the game has a cover now (landed by this run or already there). */
  covered: boolean
  /** The source that landed it in this run, when one did. */
  source?: ArtSourceId | 'steamgriddb'
}

export interface FillKindsOptions {
  offline?: boolean
  /** Replace a cover marked 'small' with a full-size one; only candidates known to be larger are tried. */
  upgradeCover?: boolean
  /** The job's seeds: the kinds the cover lane deferred land here first, before any lookup. */
  seeds?: ArtSeed[]
  /** Retry URLs recorded as missing (Refresh). */
  force?: boolean
  lookahead?: Lookahead
}

export interface CoverLane {
  runCoverLane(game: Game, ids: ArtIds, options: CoverLaneOptions): Promise<CoverLaneOutcome>
  /** Seeds, local caches, then direct sources, for the given kinds the game is missing; returns the kinds landed. */
  fillKinds(
    game: Game,
    ids: ArtIds,
    kinds: ArtKind[],
    options?: FillKindsOptions
  ): Promise<Set<ArtKind>>
  /** Drop the local indexes (a new batch starts while the full lane still runs: new files must be seen). */
  resetLocal(): void
  /** Both lanes drained: drop the local indexes, the batch memo, the host budgets and any batch collector. */
  reset(): void
}

/** Kinds landed by one step, with the source that supplied each. */
type Landed = Map<ArtKind, ArtSourceId>

interface BatchWaiter {
  game: Game
  ids: ArtIds
  resolve(candidates: ArtCandidates): void
}

interface BatchCollector {
  waiters: BatchWaiter[]
  timer: NodeJS.Timeout | null
  lookahead?: Lookahead
}

/** Direct sources key on these; a game with none of them is one only a title search can help. */
export function hasPlatformId(ids: ArtIds): boolean {
  return Boolean(
    ids.steamAppId ||
    ids.gogProductId ||
    ids.epicAppName ||
    ids.epicCatalogItemId ||
    ids.eaOfferId ||
    ids.xboxStoreId ||
    ids.battlenetCode ||
    ids.ubisoftId ||
    ids.igdbId ||
    ids.steamGridDbId
  )
}

function coverQuality(kind: ArtKind, height: number | undefined): 'small' | undefined {
  return kind === 'cover' && height !== undefined && height > 0 && height < SMALL_COVER_HEIGHT
    ? 'small'
    : undefined
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return url
  }
}

export function createCoverLane(deps: CoverLaneDeps): CoverLane {
  const { library, imageCache, batcher, log } = deps
  const downloads = new Gate(COVER_DOWNLOADS)
  const collectors = new Map<string, BatchCollector>()
  /** `<source>|<kind>` -> game id -> candidates a batch source answered (empty = asked, nothing). */
  const answers = new Map<string, Map<string, ArtCandidate[]>>()
  /** Consecutive network-level failures per host; a host over `HOST_FAILURE_BUDGET` is skipped for the run. */
  const hostFailures = new Map<string, number>()

  function configuredSources(settings: Settings): DirectArtSource[] {
    return deps.directSources.filter((s) => {
      try {
        return s.isConfigured(settings)
      } catch (err) {
        log.warn(`${s.id}: isConfigured failed: ${describeError(err)}`)
        return false
      }
    })
  }

  /** True when the kind needs no work: user art, already there (unless `force`), or landed and waiting for a flush. */
  function settled(gameId: string, kind: ArtKind, force: boolean): boolean {
    const game = library.getGame(gameId)
    if (!game) return true
    if (kind === 'screenshot') return (game.media.screenshots?.length ?? 0) > 0 && !force
    if (game.user.customMedia?.[kind]) return true
    if (batcher.has(gameId, kind)) return true
    return Boolean(game.media[kind]) && !force
  }

  /** A seed or direct URL that answered 404 in an earlier run (`art:<kind>:missing`), unless the caller forces. */
  function knownMissing(gameId: string, kind: ArtKind, url: string, force: boolean): boolean {
    if (force) return false
    const game = library.getGame(gameId)
    return !!game && missingArtUrls(game, kind).includes(url)
  }

  function land(
    gameId: string,
    kind: LandableKind,
    url: string,
    source: string | undefined,
    quality: 'small' | 'full' | undefined
  ): boolean {
    const game = library.getGame(gameId)
    if (!game) return false
    // The user may have chosen a file while this download was in flight: their choice stands.
    if (game.user.customMedia?.[kind]) return false
    batcher.add({ gameId, kind, url, source, quality })
    return true
  }

  async function copyLocal(
    gameId: string,
    kind: LandableKind,
    path: string,
    source: string | undefined,
    height: number | undefined
  ): Promise<boolean> {
    const url = await imageCache.importLocal(gameId, kind, path)
    if (!url) return false
    return land(gameId, kind, url, source, coverQuality(kind, height))
  }

  function hostBudgetExceeded(url: string): boolean {
    return (hostFailures.get(hostOf(url)) ?? 0) >= HOST_FAILURE_BUDGET
  }

  function noteNetworkError(url: string): void {
    const host = hostOf(url)
    const failures = (hostFailures.get(host) ?? 0) + 1
    hostFailures.set(host, failures)
    if (failures === HOST_FAILURE_BUDGET)
      log.warn(
        `${host}: ${failures} network failures in a row; skipping its URLs for the rest of this run`
      )
  }

  /**
   * One download through the lane's gate. A URL that answers 400, 404, 410 (or an unusable body) is recorded as
   * missing for the game and kind; a network-level failure or any other status (429, 5xx) counts against the host
   * and records nothing. A 403 records nothing and is not counted: a block looks the same as an absent file on some
   * CDNs (cdn1.epicgames.com), and a run of those must not cost the host's healthy URLs.
   */
  async function download(
    gameId: string,
    kind: LandableKind,
    candidate: Pick<ArtCandidate, 'url' | 'policy' | 'height'>,
    source: string | undefined,
    quality: 'small' | 'full' | undefined
  ): Promise<boolean> {
    const target = candidate.url
    if (!target) return false
    let networkError = false
    let forbidden = false
    const policy: MediaPolicy = {
      ...(candidate.policy ?? DIRECT_DOWNLOAD_POLICY),
      onNetworkError: (_url, status) => {
        networkError = true
        forbidden = status === 403
      }
    }
    // The budget is read once the slot is held: the failures of the downloads ahead in the gate count.
    const url = await downloads.run(() =>
      hostBudgetExceeded(target)
        ? Promise.resolve(null)
        : imageCache.importRemote(gameId, kind, target, undefined, policy)
    )
    if (!url) {
      if (hostBudgetExceeded(target) && !networkError) {
        log.debug(`${kind} skipped (host over budget) ${redactUrl(target)}`)
        return false
      }
      if (networkError) {
        if (!forbidden) noteNetworkError(target)
      } else {
        log.debug(`${kind} miss ${redactUrl(target)}`)
        if (library.getGame(gameId)) batcher.add({ gameId, kind, missing: target })
      }
      return false
    }
    hostFailures.delete(hostOf(target))
    return land(gameId, kind, url, source, quality ?? coverQuality(kind, candidate.height))
  }

  // --- step 1: seeds ----------------------------------------------------------

  /** Steam's `_2x` cover falls back to the 300x450 `library_600x900.jpg` (accepted as 'small') before giving up. */
  function seedUrls(seed: ArtSeed): { url: string; quality?: 'small' }[] {
    const url = seed.url!
    const out: { url: string; quality?: 'small' }[] = [{ url }]
    if (seed.kind === 'cover' && STEAM_2X_RE.test(url))
      out.push({
        url: url.replace(/library_600x900_2x\.jpg/i, 'library_600x900.jpg'),
        quality: 'small'
      })
    return out
  }

  async function landSeed(
    seed: ArtSeed,
    settings: Settings,
    options: { force: boolean; offline: boolean }
  ): Promise<boolean> {
    if (seed.kind === 'screenshot') return false
    const kind = seed.kind
    if (settled(seed.gameId, kind, options.force)) return false
    if (seed.path) {
      // The provider's librarycache files are store-client art too: with the toggle off they stay unused.
      const fromSteamCache = /librarycache/i.test(seed.path)
      if (fromSteamCache && !settings.scrapers.localArt) return false
      const info = await sniffImage(seed.path)
      // Steam's drawn stand-in for a game with no portrait art is no cover (the lane goes on to the real sources).
      if (!info || !acceptsKind(kind, info) || (fromSteamCache && isSteamDrawnCover(kind, info))) {
        log.debug(`seed rejected for ${seed.gameId} ${kind}: ${seed.path}`)
        return false
      }
      return copyLocal(
        seed.gameId,
        kind,
        seed.path,
        fromSteamCache ? 'steam-cache' : undefined,
        info.height
      )
    }
    if (!seed.url || options.offline) return false
    for (const attempt of seedUrls(seed)) {
      if (knownMissing(seed.gameId, kind, attempt.url, options.force)) continue
      if (await download(seed.gameId, kind, { url: attempt.url }, 'store-import', attempt.quality))
        return true
    }
    return false
  }

  /**
   * Path seeds in the local stage, URL seeds in the network stage; cover first. With `deferExtras` the other
   * kinds' URL seeds wait for the full lane, so a 3,000-game import's download slots serve covers only.
   */
  async function landSeeds(
    gameId: string,
    settings: Settings,
    options: CoverLaneOptions
  ): Promise<boolean> {
    const seeds = options.seeds.filter(
      (s) => s.gameId === gameId && (options.stage === 'local' ? !!s.path : !!s.url)
    )
    if (!seeds.length) return false
    const deferExtras = options.deferExtras === true && options.stage === 'network'
    let coverLanded = false
    for (const kind of SEED_ORDER) {
      if (deferExtras && kind !== 'cover') break
      for (const seed of seeds) {
        if (seed.kind !== kind) continue
        const landed = await landSeed(seed, settings, options)
        if (landed && kind === 'cover') coverLanded = true
        if (landed) break
      }
    }
    return coverLanded
  }

  // --- step 2: local caches ---------------------------------------------------

  async function fromLocal(
    game: Game,
    ids: ArtIds,
    kinds: LandableKind[],
    settings: Settings
  ): Promise<Landed> {
    const landed: Landed = new Map()
    if (!settings.scrapers.localArt || !kinds.length) return landed
    let found: ArtCandidates
    try {
      found = await deps.localArt.lookup(game, ids, kinds)
    } catch (err) {
      log.warn(`local art lookup failed for "${game.title}": ${describeError(err)}`)
      return landed
    }
    for (const kind of kinds) {
      for (const candidate of found[kind] ?? []) {
        if (!candidate.path) continue
        if (await copyLocal(game.id, kind, candidate.path, candidate.source, candidate.height)) {
          landed.set(kind, candidate.source)
          break
        }
      }
    }
    return landed
  }

  // --- step 3: direct URLs ----------------------------------------------------

  const answerKey = (source: DirectArtSource, kind: ArtKind): string => `${source.id}|${kind}`

  function memoised(
    source: DirectArtSource,
    gameId: string,
    kinds: ArtKind[]
  ): ArtCandidates | null {
    const out: ArtCandidates = {}
    for (const kind of kinds) {
      const list = answers.get(answerKey(source, kind))?.get(gameId)
      if (!list) return null
      if (list.length) out[kind] = list
    }
    return out
  }

  function memoise(
    source: DirectArtSource,
    gameIds: string[],
    kinds: ArtKind[],
    found: Map<string, ArtCandidates>
  ): void {
    for (const kind of kinds) {
      const key = answerKey(source, kind)
      let map = answers.get(key)
      if (!map) {
        map = new Map()
        answers.set(key, map)
      }
      for (const gameId of gameIds) map.set(gameId, found.get(gameId)?.[kind] ?? [])
    }
  }

  const usableFor =
    (source: DirectArtSource): ((ids: ArtIds) => boolean) =>
    (ids) =>
      !source.hasIdFor || source.hasIdFor(ids)

  /**
   * Candidates of one source for one game. Template sources answer at once. Batch sources collect the games that
   * reach them within `BATCH_WAIT_MS` (the lane's in-flight set) and fill the rest of the batch from the queue
   * behind them through `lookahead`; every game of the request is memoised, so the looked-ahead ones answer from
   * memory when their turn comes and a 3,000-game run makes ~60 SteamGridDB requests, not 3,000.
   */
  function collect(
    source: DirectArtSource,
    game: Game,
    ids: ArtIds,
    kinds: ArtKind[],
    settings: Settings,
    lookahead: Lookahead | undefined
  ): Promise<ArtCandidates> {
    if (source.batchSize <= 1) {
      return source
        .candidates([{ game, ids }], kinds, settings)
        .then((map) => map.get(game.id) ?? {})
    }
    const known = memoised(source, game.id, kinds)
    if (known) return Promise.resolve(known)
    const key = `${source.id}|${kinds.join(',')}`
    let collector = collectors.get(key)
    if (!collector) {
      collector = { waiters: [], timer: null }
      collectors.set(key, collector)
    }
    const current = collector
    if (lookahead) current.lookahead = lookahead
    const flush = (): void => {
      if (current.timer) clearTimeout(current.timer)
      current.timer = null
      const waiters = current.waiters.splice(0, source.batchSize)
      if (!waiters.length) return
      const request = waiters.map((w) => ({ game: w.game, ids: w.ids }))
      const inRequest = new Set(request.map((r) => r.game.id))
      const room = source.batchSize - request.length
      if (room > 0 && current.lookahead) {
        const hasId = usableFor(source)
        const next = current.lookahead(
          room,
          (g, ids) => !inRequest.has(g.id) && hasId(ids) && !memoised(source, g.id, kinds)
        )
        for (const entry of next) {
          if (request.length >= source.batchSize || inRequest.has(entry.game.id)) continue
          inRequest.add(entry.game.id)
          request.push(entry)
        }
      }
      void source.candidates(request, kinds, settings).then(
        (map) => {
          memoise(source, [...inRequest], kinds, map)
          for (const w of waiters) w.resolve(map.get(w.game.id) ?? {})
        },
        (err) => {
          log.warn(`${source.id}: batch of ${request.length} failed: ${describeError(err)}`)
          for (const w of waiters) w.resolve({})
        }
      )
      if (current.waiters.length) flush()
    }
    return new Promise<ArtCandidates>((resolve) => {
      current.waiters.push({ game, ids, resolve })
      if (current.waiters.length >= source.batchSize) flush()
      else if (!current.timer) {
        current.timer = setTimeout(flush, BATCH_WAIT_MS)
        current.timer.unref?.()
      }
    })
  }

  function usableForUpgrade(candidate: ArtCandidate): boolean {
    if (candidate.height !== undefined && candidate.height < SMALL_COVER_HEIGHT) return false
    return !(candidate.url && STEAM_SMALL_RE.test(candidate.url))
  }

  async function fromDirect(
    game: Game,
    ids: ArtIds,
    kinds: LandableKind[],
    settings: Settings,
    options: { upgrade: boolean; force: boolean; lookahead?: Lookahead }
  ): Promise<Landed> {
    const landed: Landed = new Map()
    if (!kinds.length) return landed
    const { upgrade } = options
    const tried: Partial<Record<ArtKind, number>> = {}
    const missing = (): LandableKind[] =>
      kinds.filter((k) => !landed.has(k) && (tried[k] ?? 0) < MAX_DIRECT_URLS)
    for (const source of configuredSources(settings)) {
      const wanted = missing()
      if (!wanted.length) break
      // A source with no id for this game is skipped outright: no request, no wait in its collector.
      if (!usableFor(source)(ids)) continue
      let found: ArtCandidates
      try {
        found = await collect(source, game, ids, wanted, settings, options.lookahead)
      } catch (err) {
        log.warn(`${source.id}: candidates failed for "${game.title}": ${describeError(err)}`)
        continue
      }
      for (const kind of wanted) {
        for (const candidate of found[kind] ?? []) {
          if ((tried[kind] ?? 0) >= MAX_DIRECT_URLS || landed.has(kind)) break
          if (!candidate.url) continue
          if (upgrade && kind === 'cover' && !usableForUpgrade(candidate)) continue
          if (knownMissing(game.id, kind, candidate.url, options.force)) continue
          tried[kind] = (tried[kind] ?? 0) + 1
          if (settled(game.id, kind, upgrade)) {
            landed.set(kind, candidate.source)
            break
          }
          const quality = upgrade && kind === 'cover' ? 'full' : undefined
          if (await download(game.id, kind, candidate, candidate.source, quality)) {
            landed.set(kind, candidate.source)
            break
          }
        }
      }
    }
    return landed
  }

  // --- step 4: SteamGridDB search ----------------------------------------------

  async function fromSteamGridDb(game: Game, settings: Settings): Promise<boolean> {
    if (!deps.steamGridDb) return false
    const result = await deps.steamGridDb(game, settings)
    if (!result?.media.cover) return false
    if (settled(game.id, 'cover', false)) return true
    return download(game.id, 'cover', { url: result.media.cover }, 'steamgriddb', undefined)
  }

  return {
    async runCoverLane(game, ids, options) {
      const settings = deps.settings.get()
      if (options.stage === 'network' && options.offline) return { covered: false }
      if (await landSeeds(game.id, settings, options)) {
        const source = options.stage === 'local' ? 'steam-cache' : 'store-import'
        return { covered: true, source }
      }
      if (options.seedOnly || settled(game.id, 'cover', options.force))
        return { covered: settled(game.id, 'cover', false) }
      const fresh = library.getGame(game.id) ?? game
      if (options.stage === 'local') {
        const local = (await fromLocal(fresh, ids, ['cover'], settings)).get('cover')
        return local ? { covered: true, source: local } : { covered: false }
      }
      if (options.coverOnly) return { covered: false }
      const direct = (
        await fromDirect(fresh, ids, ['cover'], settings, {
          upgrade: false,
          force: options.force,
          lookahead: options.lookahead
        })
      ).get('cover')
      if (direct) return { covered: true, source: direct }
      if (!hasPlatformId(ids) && (await fromSteamGridDb(fresh, settings)))
        return { covered: true, source: 'steamgriddb' }
      return { covered: settled(game.id, 'cover', false) }
    },

    async fillKinds(game, ids, kinds, options = {}) {
      const settings = deps.settings.get()
      const force = options.force === true
      const wanted = kinds.filter(
        (k): k is LandableKind =>
          k !== 'screenshot' && !settled(game.id, k, options.upgradeCover === true && k === 'cover')
      )
      if (!wanted.length) return new Set()
      const landed = new Map<ArtKind, ArtSourceId>()
      // The seeds the cover lane deferred (store hero / logo / icon URLs, a provider's files) cost no lookup.
      if (!options.upgradeCover && options.seeds?.length) {
        for (const kind of wanted) {
          for (const seed of options.seeds) {
            if (seed.gameId !== game.id || seed.kind !== kind) continue
            if (options.offline && !seed.path) continue
            if (await landSeed(seed, settings, { force, offline: options.offline === true })) {
              landed.set(kind, seed.path ? 'steam-cache' : 'store-import')
              break
            }
          }
        }
      }
      if (!options.upgradeCover) {
        const rest = wanted.filter((k) => !landed.has(k))
        for (const [kind, source] of await fromLocal(game, ids, rest, settings))
          landed.set(kind, source)
      }
      if (options.offline) return new Set(landed.keys())
      const rest = wanted.filter((k) => !landed.has(k))
      const direct = await fromDirect(game, ids, rest, settings, {
        upgrade: options.upgradeCover === true,
        force,
        lookahead: options.lookahead
      })
      for (const [kind, source] of direct) landed.set(kind, source)
      return new Set(landed.keys())
    },

    resetLocal() {
      deps.localArt.reset()
    },

    reset() {
      deps.localArt.reset()
      answers.clear()
      hostFailures.clear()
      for (const collector of collectors.values()) {
        if (collector.timer) clearTimeout(collector.timer)
        for (const w of collector.waiters) w.resolve({})
      }
      collectors.clear()
    }
  }
}
