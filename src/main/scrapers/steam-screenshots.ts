import type { Game, GameMetadata, ScreenshotsProgress, SteamScreenshot } from '../../shared/types'
import type { Logger } from '../logger'
import {
  describeError,
  loadSteamAppDetails,
  steamAppIdOf,
  steamScreenshotsOf,
  type SteamAppDetails
} from './steam-store'
import { hashShort } from '../util/ids'
import type { ImageCache } from './types'
import type { MirrorEntry, ScreenshotMirror } from './screenshot-mirror'

/** A Steam game's screenshot list is read from the store again after this long. */
export const STEAM_SCREENSHOTS_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Steam (or its CDN) failing this many games in a row ends the pass; the rest are downloaded next run. */
const FAILURES_BEFORE_STOP = 5
/** A thumbnail failing this many passes is given up until the list is refreshed. */
const THUMBNAIL_ATTEMPTS = 3
/** 'screenshots:progress' at most this often (plus the first and last report of a pass). */
const PROGRESS_INTERVAL_MS = 500
/** Thumbnails downloaded at once from the Drive mirror (Steam's CDN stays one at a time). */
const MIRROR_PARALLEL = 6
/** The mirror failing this many thumbnails in a row is left alone for the rest of the pass (Steam takes over). */
const MIRROR_FAILURES_BEFORE_STOP = 10

type Record_ = NonNullable<GameMetadata['steamScreenshots']>

/** A URL without its query (Steam adds `?t=<timestamp>`), to know a screenshot again after a refresh. */
function urlKey(url: string): string {
  return url.split('?')[0]!.toLowerCase()
}

/** The name a screenshot's saved thumbnail goes by: the screenshot itself, never its place in the list. */
export function screenshotKey(shot: Pick<SteamScreenshot, 'thumbnail'>): string {
  return hashShort(urlKey(shot.thumbnail))
}

/** The game's Steam app id when it is a Steam game whose store screenshots belong on its page; else null. */
export function steamScreenshotsAppId(game: Game): number | null {
  return game.source === 'steam' && !game.remote ? steamAppIdOf(game) : null
}

/** Whether a Steam game's store screenshots are due: never read, a month old, or a thumbnail not saved yet. */
export function steamScreenshotsDue(game: Game, now: number): boolean {
  if (steamScreenshotsAppId(game) === null) return false
  const record = game.metadata.steamScreenshots
  if (!record) return true
  if (listStale(record, now)) return true
  return record.items.some((item) => !item.local && !item.missing)
}

function listStale(record: Record_, now: number): boolean {
  const at = Date.parse(record.updatedAt)
  return !Number.isFinite(at) || now - at >= STEAM_SCREENSHOTS_TTL_MS
}

/** A fresh list, keeping the saved thumbnails of the screenshots it still has. */
export function mergeScreenshotList(
  fresh: readonly SteamScreenshot[],
  saved: readonly SteamScreenshot[] | undefined
): SteamScreenshot[] {
  const byKey = new Map((saved ?? []).map((s) => [urlKey(s.thumbnail), s]))
  return fresh.map((s) => {
    const before = byKey.get(urlKey(s.thumbnail))
    return before?.local ? { ...s, local: before.local } : s
  })
}

export interface SteamScreenshotsDeps {
  library: {
    games(): Game[]
    getGame(id: string): Game | undefined
    applyMetadata(
      id: string,
      update: { metadata?: Partial<GameMetadata> },
      options?: { overwrite?: boolean; quiet?: boolean }
    ): unknown
  }
  imageCache: Pick<ImageCache, 'importSteamThumbnail' | 'pruneSteamThumbnails' | 'remove'>
  emit: (progress: ScreenshotsProgress) => void
  /** A game's list or thumbnails were saved (the open game page updates from it). */
  onSaved?: (gameId: string, items: SteamScreenshot[]) => void
  log: Logger
  /**
   * The Drive mirror of screenshot lists and thumbnails: the main source on a first-time setup (a pass with a game
   * never read), Steam the backup for whatever it lacks or fails to give.
   */
  mirror?: ScreenshotMirror
  /** Tests. */
  loadDetails?: (appId: number) => Promise<Pick<SteamAppDetails, 'screenshots'> | null>
  now?: () => number
}

export interface SteamScreenshotsService {
  /**
   * Download what is due for every Steam game (its screenshot list, then each thumbnail); a call while a pass runs
   * makes it look again when it ends, so a pass never runs twice at once.
   */
  kick(): void
  /** A Steam game's screenshots for its page: the saved list, else (or when a month old) read from Steam now. */
  forGame(gameId: string): Promise<SteamScreenshot[] | null>
  /** Resolves once no pass is running (tests). */
  idle(): Promise<void>
  dispose(): void
}

export function createSteamScreenshots(deps: SteamScreenshotsDeps): SteamScreenshotsService {
  const { library, imageCache, log } = deps
  const loadDetails = deps.loadDetails ?? loadSteamAppDetails
  const now = deps.now ?? Date.now
  let running: Promise<void> | null = null
  let again = false
  let disposed = false
  /** One store read per game at a time (the page and the pass may ask together). */
  const reading = new Map<string, Promise<SteamScreenshot[]>>()
  /** The current pass's mirror (null: not a first-time setup, or the mirror failed too often). */
  let mirror: ScreenshotMirror | null = null
  let mirrorFailedInRow = 0

  async function mirrored(appId: number): Promise<MirrorEntry | null> {
    if (!mirror) return null
    try {
      return await mirror.forApp(appId)
    } catch (err) {
      log.debug(`screenshot mirror failed for ${appId}: ${describeError(err)}`)
      return null
    }
  }

  function save(gameId: string, items: SteamScreenshot[], updatedAt: string): void {
    if (!library.getGame(gameId)) return
    // Quiet: one game page at a time cares, told through onSaved; a library-wide change per game would not do.
    library.applyMetadata(
      gameId,
      { metadata: { steamScreenshots: { items, updatedAt } } },
      { overwrite: true, quiet: true }
    )
    deps.onSaved?.(gameId, items)
  }

  /** Read the game's list from Steam's store and save it (keeping thumbnails already saved). Throws when Steam fails. */
  function readList(game: Game, appId: number): Promise<SteamScreenshot[]> {
    const pending = reading.get(game.id)
    if (pending) return pending
    const task = (async () => {
      const data = await loadDetails(appId)
      const latest = library.getGame(game.id) ?? game
      const items = mergeScreenshotList(
        data ? steamScreenshotsOf(data) : [],
        latest.metadata.steamScreenshots?.items
      )
      save(game.id, items, new Date(now()).toISOString())
      return items
    })().finally(() => reading.delete(game.id))
    reading.set(game.id, task)
    return task
  }

  /**
   * One game: its list when due, then every thumbnail not saved yet, each under its screenshot's own name. The first
   * network failure ends the game's turn (the rest wait for the next pass); a thumbnail failing THUMBNAIL_ATTEMPTS
   * passes is given up. False when Steam or its CDN did not answer.
   */
  async function download(game: Game, appId: number): Promise<boolean> {
    const record = game.metadata.steamScreenshots
    const fromMirror = await mirrored(appId)
    let refreshed: boolean
    let items: SteamScreenshot[]
    const mirroredList = fromMirror?.list
    if (!record && mirroredList?.length) {
      // Never read: the mirror's list stands in for the store read (Steam refreshes it once a month as usual).
      const latest = library.getGame(game.id) ?? game
      items = mergeScreenshotList(
        mirroredList.map(({ thumbnail, full }) => ({ thumbnail, full })),
        latest.metadata.steamScreenshots?.items
      )
      save(game.id, items, new Date(now()).toISOString())
      refreshed = true
    } else {
      refreshed = !record || listStale(record, now())
      items = refreshed || !record ? await readList(game, appId) : record.items
    }
    // The mirrored thumbnails: the manifest's, else the game folder's own files (named by key).
    const driveByKey = new Map<string, string>(fromMirror?.files)
    for (const s of mirroredList ?? []) if (s.drive) driveByKey.set(screenshotKey(s), s.drive)
    let networkFailed = false
    let changed = false
    const out = items.map((s) => ({ ...s }))

    /** From the mirror when it has the thumbnail; true when saved. */
    async function fromDrive(item: SteamScreenshot, key: string): Promise<boolean> {
      const driveId = driveByKey.get(key)
      if (!driveId || !mirror) return false
      const local = await imageCache.importSteamThumbnail(game.id, key, mirror.fileUrl(driveId), {
        imageOnly: true,
        retries: 1
      })
      if (!local) {
        if (mirror && ++mirrorFailedInRow >= MIRROR_FAILURES_BEFORE_STOP) {
          log.info('Steam screenshots: the Drive mirror is failing; Steam takes over for this pass')
          mirror = null
        }
        return false
      }
      mirrorFailedInRow = 0
      changed = true
      item.local = local
      delete item.failures
      return true
    }

    async function fromSteam(item: SteamScreenshot, key: string): Promise<void> {
      let failedHere = false
      const local = await imageCache.importSteamThumbnail(game.id, key, item.thumbnail, {
        onNetworkError: () => {
          failedHere = true
        }
      })
      changed = true
      if (local) {
        item.local = local
        delete item.failures
      } else if (failedHere) {
        networkFailed = true
        item.failures = (item.failures ?? 0) + 1
        if (item.failures >= THUMBNAIL_ATTEMPTS) item.missing = true
      } else {
        // The CDN answered: there is no such file.
        item.missing = true
      }
    }

    // The mirror first, several at once; then Steam's CDN one at a time for whatever is left.
    const queue = out.filter(
      (item) => !item.local && !item.missing && driveByKey.has(screenshotKey(item))
    )
    await Promise.all(
      Array.from({ length: Math.min(MIRROR_PARALLEL, queue.length) }, async () => {
        for (let item = queue.shift(); item && !disposed; item = queue.shift())
          await fromDrive(item, screenshotKey(item))
      })
    )
    for (const item of out) {
      if (disposed || networkFailed) break
      if (item.local || item.missing) continue
      await fromSteam(item, screenshotKey(item))
    }
    if (!library.getGame(game.id)) {
      // Removed while its thumbnails were downloading: nothing may stay behind.
      await imageCache.remove(game.id)
      return true
    }
    if (changed) {
      const updatedAt =
        library.getGame(game.id)?.metadata.steamScreenshots?.updatedAt ??
        new Date(now()).toISOString()
      save(game.id, out, updatedAt)
    }
    // A refreshed list: the thumbnails of screenshots Steam no longer shows go.
    if (refreshed)
      await imageCache.pruneSteamThumbnails(
        game.id,
        new Set(out.filter((s) => s.local).map(screenshotKey))
      )
    return !networkFailed
  }

  async function pass(): Promise<void> {
    const at = now()
    const due = library.games().filter((g) => steamScreenshotsDue(g, at))
    if (!due.length || disposed) return
    log.info(`Steam screenshots: downloading for ${due.length} game(s)`)
    let lastReport = 0
    const report = (done: number, current?: string, force = false): void => {
      const t = Date.now()
      if (!force && t - lastReport < PROGRESS_INTERVAL_MS) return
      lastReport = t
      if (!disposed)
        deps.emit({
          done: Math.min(done, due.length),
          total: due.length,
          ...(current ? { current } : {})
        })
    }
    let failedInRow = 0
    let downloaded = 0
    // A first-time setup (a game never read) takes what it can from the Drive mirror.
    mirror = deps.mirror && due.some((g) => !g.metadata.steamScreenshots) ? deps.mirror : null
    mirrorFailedInRow = 0
    if (mirror) log.info('Steam screenshots: first-time setup, using the Drive mirror')
    try {
      for (const [index, stale] of due.entries()) {
        if (disposed) break
        const game = library.getGame(stale.id)
        report(index, game?.user.titleOverride?.trim() || game?.title, index === 0)
        if (!game || !steamScreenshotsDue(game, now())) continue
        const appId = steamScreenshotsAppId(game)
        if (appId === null) continue
        let ok: boolean
        try {
          ok = await download(game, appId)
        } catch (err) {
          log.debug(`screenshots of ${game.title} failed: ${describeError(err)}`)
          ok = false
        }
        if (ok) {
          failedInRow = 0
          downloaded++
        } else if (++failedInRow >= FAILURES_BEFORE_STOP) {
          log.info('Steam screenshots: Steam is not answering; the rest are downloaded next run')
          break
        }
      }
    } finally {
      mirror = null
      if (!disposed) deps.emit({ done: 0, total: 0 })
    }
    log.info(`Steam screenshots: ${downloaded} of ${due.length} game(s) done`)
  }

  function start(): void {
    running = (async () => {
      do {
        again = false
        try {
          await pass()
        } catch (err) {
          log.error('Steam screenshots pass failed', err)
        }
      } while (again && !disposed)
      running = null
    })()
  }

  return {
    kick() {
      if (disposed) return
      if (running) {
        again = true
        return
      }
      start()
    },
    async forGame(gameId) {
      const game = library.getGame(gameId)
      const appId = game ? steamScreenshotsAppId(game) : null
      if (!game || appId === null) return null
      const record = game.metadata.steamScreenshots
      if (record && !listStale(record, now())) return record.items
      try {
        return await readList(game, appId)
      } catch (err) {
        log.debug(`screenshots of ${game.title} failed: ${describeError(err)}`)
        return record?.items ?? null
      }
    },
    async idle() {
      while (running) await running
    },
    dispose() {
      disposed = true
    }
  }
}
