// `--art-bench` (docs/ARCHITECTURE.md §7, `npm run scan-art-bench`): the real, local-only probe of the cover lane.
// In a throw-away user-data folder it reads the Steam client's `librarycache` on this PC, builds owned-not-installed
// records for every appid there that no `appmanifest_*.acf` lists (plus the installed ones, reported separately),
// runs `enqueue(ids, { coverOnly: true, offline: true })` and reports covers found, time to first cover and total
// time per local source. No window, no network, no sign-in; the real `library.json` and `settings.json` are never
// opened because `--user-data-dir` points elsewhere.
import { promises as fs } from 'fs'
import { join } from 'path'
import type { ArtKind, Game, MetadataProgress, OwnedGame } from '../../shared/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import { detectSteam, parseLibraryFolders } from '../providers/steam'
import type { LibraryService } from '../services/library-service'
import type { SettingsStore } from '../store/settings-store'
import { listDir, readJson, readTextIfExists } from '../util/fs'
import {
  createEsdeMediaSource,
  createGalaxyCacheSource,
  createLocalArtRegistry,
  createPlayniteFilesSource,
  createSteamCacheSource
} from './local-art'
import { createMetadataService } from './metadata-service'
import type { ArtIds, ImageCache } from './types'

export interface ArtBenchDeps {
  settings: SettingsStore
  library: LibraryService
  imageCache: ImageCache
  events: EventBus
  resourcesDir: string
  /** The throw-away user-data folder; `art-bench.json` is written there. */
  userData: string
  log: Logger
}

export interface ArtBenchGroup {
  appIds: number
  covers: number
  /** Covers per local source (`metadata.sources['art:cover']`). */
  bySource: Record<string, number>
}

export interface ArtBenchReport {
  steamRoot: string | null
  notInstalled: ArtBenchGroup
  installed: ArtBenchGroup
  /** Wall-clock from `enqueue` to the drain event. */
  totalMs: number
  /** Wall-clock from `enqueue` to the first cover written. */
  firstCoverMs: number | null
  /** Time the first local lookup took (the registry's index build is memoised behind it). */
  indexMs: number | null
  startedAt: string
  /**
   * When the previous probe in this user-data folder ran, and whether that was recent enough (`WARM_WINDOW_MS`)
   * for the OS file cache to still hold the librarycache (or the index build was fast enough to prove it did): a
   * warm run reads ~10,000 headers from memory and is about twice as fast as a cold one, so a cited number must
   * say which it is (ARCHITECTURE.md §4.6 acceptance).
   */
  previousRunAt: string | null
  warm: boolean
}

/** A probe this soon after the previous one is counted as warm (the file cache is unlikely to have been evicted). */
export const WARM_WINDOW_MS = 60 * 60_000
/** An index build under this is one served from the file cache (cold: ~1,060 ms on this PC, warm: ~45 ms). */
export const WARM_INDEX_MS = 300

const MANIFEST_RE = /^appmanifest_(\d+)\.acf$/i

/** Appids with an `appmanifest_<appid>.acf` in any Steam library: the installed set of the report. */
async function installedAppIds(root: string): Promise<Set<number>> {
  const text = await readTextIfExists(join(root, 'steamapps', 'libraryfolders.vdf'))
  const libraries = text === null ? [root] : parseLibraryFolders(text, root)
  const out = new Set<number>()
  for (const library of libraries) {
    for (const entry of await listDir(join(library, 'steamapps'))) {
      const m = MANIFEST_RE.exec(entry.name)
      if (m && entry.isFile()) out.add(Number(m[1]))
    }
  }
  return out
}

/** Appids with a folder (or an old flat `<appid>_*` file) in `librarycache`. */
async function cachedAppIds(root: string): Promise<number[]> {
  const out = new Set<number>()
  for (const entry of await listDir(join(root, 'appcache', 'librarycache'))) {
    if (entry.isDirectory() && /^\d+$/.test(entry.name)) out.add(Number(entry.name))
    else if (entry.isFile()) {
      const m = /^(\d+)_/.exec(entry.name)
      if (m) out.add(Number(m[1]))
    }
  }
  return [...out].sort((a, b) => a - b)
}

/** `startedAt` of the report a previous probe left in the user-data folder, or null. */
async function previousStartedAt(file: string): Promise<string | null> {
  const previous = await readJson<Partial<ArtBenchReport>>(file)
  const at = previous?.startedAt
  return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null
}

export async function runArtBench(deps: ArtBenchDeps): Promise<ArtBenchReport> {
  const { log, library, settings } = deps
  const startedAt = new Date().toISOString()
  const { root } = await detectSteam(log)
  const previousRunAt = await previousStartedAt(join(deps.userData, 'art-bench.json'))
  const report: ArtBenchReport = {
    steamRoot: root,
    notInstalled: { appIds: 0, covers: 0, bySource: {} },
    installed: { appIds: 0, covers: 0, bySource: {} },
    totalMs: 0,
    firstCoverMs: null,
    indexMs: null,
    startedAt,
    previousRunAt,
    warm:
      previousRunAt !== null && Date.parse(startedAt) - Date.parse(previousRunAt) < WARM_WINDOW_MS
  }
  if (!root) {
    log.warn('art-bench: Steam is not installed on this PC; nothing to probe')
    return finish(deps, report)
  }
  const installed = await installedAppIds(root)
  const appIds = await cachedAppIds(root)
  const notInstalled = appIds.filter((id) => !installed.has(id))
  const installedCached = appIds.filter((id) => installed.has(id))
  report.notInstalled.appIds = notInstalled.length
  report.installed.appIds = installedCached.length
  log.info(
    `art-bench: ${appIds.length} appids in librarycache (${notInstalled.length} not installed, ${installedCached.length} installed)`
  )

  // A previous probe left its records and media in this throw-away folder: they go first, so this run measures the
  // lookups and the copies again instead of finding every cover already in place (and `mergeOwned` would queue
  // nothing, since none of the records would be new).
  const stale = library.games().filter((g) => g.source === 'steam')
  if (stale.length) {
    const t = Date.now()
    for (const game of stale) {
      library.removeGame(game.id)
      try {
        await deps.imageCache.remove(game.id)
      } catch (err) {
        log.debug(`art-bench: could not remove media of ${game.id}: ${(err as Error).message}`)
      }
    }
    log.info(
      `art-bench: dropped ${stale.length} record(s) of the previous probe in ${Date.now() - t} ms`
    )
  }

  // Owned-not-installed records, the way a Steam import would create them (owned: true, installed: false). The
  // installed ones are owned records too: this probe never scans, so nothing is launched or marked installed.
  const owned: OwnedGame[] = appIds.map((id) => ({
    externalId: String(id),
    title: `App ${id}`,
    extra: { steamAppId: id }
  }))
  const tMerge = Date.now()
  const merge = library.mergeOwned('steam', owned)
  const ids = merge.newGameIds
  log.info(`art-bench: merged ${ids.length} owned record(s) in ${Date.now() - tMerge} ms`)
  settings.mutate((s) => {
    s.scrapers.localArt = true
  })
  if (!ids.length) {
    log.warn('art-bench: nothing to queue')
    return finish(deps, report)
  }

  // The registry is wrapped so the first lookup (which builds every source's index) can be timed. The Steam root
  // detected above is handed to the Steam source, as the app's own detection is memoised across scans too.
  const registry = createLocalArtRegistry({
    settings,
    log,
    sources: [
      createSteamCacheSource({ log, steamRoot: async () => root }),
      createGalaxyCacheSource({ log }),
      createEsdeMediaSource({ log }),
      createPlayniteFilesSource({ log })
    ]
  })
  let firstLookup: Promise<void> | null = null
  const localArt = {
    async lookup(game: Game, ids: ArtIds, kinds: ArtKind[]) {
      if (!firstLookup) {
        const t = Date.now()
        firstLookup = registry.lookup(game, ids, kinds).then(() => {
          report.indexMs = Date.now() - t
        })
        await firstLookup
      }
      return registry.lookup(game, ids, kinds)
    },
    reset: () => registry.reset()
  }

  const metadata = createMetadataService(
    { ...deps, log },
    { localArt, directSources: [], resumePending: false }
  )
  const t0 = Date.now()
  const drained = new Promise<void>((resolve) => {
    const off = deps.events.on('metadata:progress', (p: MetadataProgress) => {
      if (p.queued === 0) {
        off()
        resolve()
      }
    })
  })
  const offChanged = deps.events.on('library:changed', (payload) => {
    if (report.firstCoverMs !== null) return
    for (const id of payload.gameIds ?? [])
      if (library.getGame(id)?.media.cover) {
        report.firstCoverMs = Date.now() - t0
        break
      }
  })
  metadata.enqueue(ids, { coverOnly: true, offline: true })
  await drained
  report.totalMs = Date.now() - t0
  // The file cache outlives the hour window at times (a 47 ms index an hour after the previous probe): an index
  // far below the measured cold figure (1,060 ms) is read from memory, whatever the clock says.
  if (report.indexMs !== null && report.indexMs < WARM_INDEX_MS) report.warm = true
  offChanged()
  metadata.dispose()

  for (const game of library.games()) {
    const appId = Number(game.externalId)
    const group = installed.has(appId) ? report.installed : report.notInstalled
    if (!game.media.cover) continue
    group.covers++
    const source = game.metadata.sources?.['art:cover'] ?? 'unknown'
    group.bySource[source] = (group.bySource[source] ?? 0) + 1
  }
  return finish(deps, report)
}

async function finish(deps: ArtBenchDeps, report: ArtBenchReport): Promise<ArtBenchReport> {
  const pct = (n: number, of: number): string => (of ? `${((100 * n) / of).toFixed(1)} %` : '-')
  const sources = (g: ArtBenchGroup): string =>
    Object.entries(g.bySource)
      .map(([s, n]) => `${s} ${n}`)
      .join(', ') || 'none'
  deps.log.info(
    `art-bench (${report.warm ? 'warm' : 'cold'}${report.previousRunAt ? `, previous run ${report.previousRunAt}` : ''}): ` +
      `not-installed ${report.notInstalled.appIds} appids, covers ${report.notInstalled.covers} ` +
      `(${pct(report.notInstalled.covers, report.notInstalled.appIds)}) in ${report.totalMs} ms ` +
      `(first ${report.firstCoverMs ?? '-'} ms), index ${report.indexMs ?? '-'} ms [${sources(report.notInstalled)}]; ` +
      `installed ${report.installed.appIds}, covers ${report.installed.covers} [${sources(report.installed)}]`
  )
  const file = join(deps.userData, 'art-bench.json')
  await fs.writeFile(file, JSON.stringify(report, null, 2))
  deps.log.info(`art-bench: report written to ${file}`)
  return report
}
