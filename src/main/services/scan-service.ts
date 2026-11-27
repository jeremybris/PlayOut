import { isAbsolute, parse, relative } from 'path'
import type {
  ClientInfo,
  Game,
  ScanResult,
  Settings,
  SourceId,
  SourceStatus
} from '../../shared/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import type { GameProvider, ProviderRegistry } from '../providers/types'
import type { MetadataService } from '../scrapers/types'
import type { SettingsStore } from '../store/settings-store'
import { isDirectory, pathExists } from '../util/fs'
import { isInside } from '../util/paths'
import type { LibraryService } from './library-service'

export interface ScanDeps {
  providers: ProviderRegistry
  library: LibraryService
  settings: SettingsStore
  events: EventBus
  metadata: MetadataService
  resourcesDir: string
  log: Logger
  /** Whether a folder is there (tests replace it); used for the volume check of `gamesOnMissingVolumes`. */
  isDirectory?: (path: string) => Promise<boolean>
}

export interface ScanRunOptions {
  /**
   * `confirm`: the install tracker's periodic check of one source. It reuses the cached client detection, emits no
   * `scan:progress` and does not run the scanned listeners (no owned-library import every 10 s); `user` (default)
   * is a full scan.
   */
  reason?: 'user' | 'confirm'
}

export interface ScanService {
  /**
   * Scan the given sources (all enabled ones when omitted). Concurrent calls for the same source are coalesced: a
   * call that finds a scan of the source running joins it and reports that scan's counts as its own. The one
   * exception is a full (`user`) call that finds a `confirm` scan running: a confirming scan emits no
   * `scan:progress` and runs no scanned listeners, so the full scan runs right after it instead of joining it.
   */
  run(ids?: SourceId[], options?: ScanRunOptions): Promise<ScanResult>
  sourceStatuses(): Promise<SourceStatus[]>
  isRunning(): boolean
  /** Client detection with the 60 s cache (the install service needs the client exe for its command lines). */
  client(id: SourceId): Promise<ClientInfo>
  /**
   * Called after every successful installed scan of a source (ARCHITECTURE.md §4.3: the accounts service imports
   * the owned list of signed-in stores there), never after a `confirm` scan. Returns the unsubscribe function.
   */
  onSourceScanned(listener: (id: SourceId) => void): () => void
  /**
   * Called when a scan of a source (any scan, a confirming one too) added games the library did not have, with their
   * ids (Trim Games converts the new ROMs: main/convert/auto-trim.ts). Returns the unsubscribe function.
   */
  onNewGames(listener: (id: SourceId, gameIds: string[]) => void): () => void
}

const CLIENT_CACHE_MS = 60_000

/**
 * The sources the deferred start-up rescan covers (ARCHITECTURE.md §4.3): every source that already has games, and
 * the ROM source whenever a ROM folder is set, even with no ROM in the library yet. ROMs copied into or deleted from
 * the folder while PlayOut was closed are found only by a scan; store games have their clients' manifests and
 * owned-list imports instead. Disabled sources are filtered later by `run`.
 */
export function startupScanSources(
  games: readonly Pick<Game, 'source'>[],
  settings: Pick<Settings, 'library'>
): Set<SourceId> {
  const ids = new Set(games.map((g) => g.source))
  if (settings.library.romsRoot) ids.add('rom')
  return ids
}

/** Whether `path` is `root` or inside it (Windows paths compare without case). */
function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The installed ROM games whose file is outside the ROM folder and still there: a ROM folder from before the ROM folder
 * followed the Emulation folder, or an Emulation folder changed while the old one still holds ROMs. A ROM scan does not
 * look there, so these are not missing; their cards stay until the file goes (or is moved into the ROM folder, where
 * the scan finds it as a new game).
 */
export async function romsKeptOutsideRoot(
  games: readonly Pick<Game, 'id' | 'source' | 'installed' | 'romPath'>[],
  romsRoot: string
): Promise<Set<string>> {
  const kept = new Set<string>()
  await Promise.all(
    games.map(async (g) => {
      if (g.source !== 'rom' || !g.installed || !g.romPath || isUnder(romsRoot, g.romPath)) return
      if (await pathExists(g.romPath)) kept.add(g.id)
    })
  )
  return kept
}

/**
 * The installed games of a source under one of the folders its scan could not reach (GameProvider.unreachableRoots:
 * a Steam library on an unplugged drive). The scan did not look for them, so they are not missing.
 */
export function gamesUnderUnreachableRoots(
  games: readonly Pick<Game, 'id' | 'source' | 'installed' | 'installDir'>[],
  source: SourceId,
  roots: readonly string[]
): Set<string> {
  const kept = new Set<string>()
  if (!roots.length) return kept
  for (const g of games) {
    if (g.source !== source || !g.installed || !g.installDir) continue
    const dir = g.installDir
    if (roots.some((root) => isInside(root, dir))) kept.add(g.id)
  }
  return kept
}

/**
 * The installed games of a source whose drive (the volume root of the install folder: `E:\`, `\\server\share\`) is
 * not there. Nothing can be said about a game on a volume that is away, whatever the store client's files list:
 * Steam's libraryfolders.vdf may no longer name the library of an unplugged drive, so `unreachableRoots` alone
 * does not cover it. A game whose drive is there is never kept by this.
 */
export async function gamesOnMissingVolumes(
  games: readonly Pick<Game, 'id' | 'source' | 'installed' | 'installDir'>[],
  source: SourceId,
  folderExists: (path: string) => Promise<boolean> = isDirectory
): Promise<Set<string>> {
  const byVolume = new Map<string, string[]>()
  for (const g of games) {
    if (g.source !== source || !g.installed || !g.installDir) continue
    const volume = parse(g.installDir).root
    // No volume in the path (a relative one): nothing to check, the scan decides.
    if (!volume) continue
    const key = volume.toLowerCase()
    byVolume.set(key, [...(byVolume.get(key) ?? []), g.id])
  }
  const kept = new Set<string>()
  await Promise.all(
    [...byVolume].map(async ([volume, ids]) => {
      if (await folderExists(volume)) return
      for (const id of ids) kept.add(id)
    })
  )
  return kept
}

/** What one scan of one source changed: every caller of that scan (the one that started it, the ones that joined) counts it. */
interface SourceOutcome {
  added: number
  updated: number
  removed: number
  unknownFolders?: string[]
}

export function createScanService(deps: ScanDeps): ScanService {
  const clientCache = new Map<SourceId, { info: ClientInfo; at: number }>()
  const inflight = new Map<SourceId, { task: Promise<SourceOutcome>; confirm: boolean }>()
  const scannedListeners = new Set<(id: SourceId) => void>()
  const newGamesListeners = new Set<(id: SourceId, gameIds: string[]) => void>()

  async function detect(provider: GameProvider, force = false): Promise<ClientInfo> {
    const cached = clientCache.get(provider.id)
    if (!force && cached && Date.now() - cached.at < CLIENT_CACHE_MS) return cached.info
    let info: ClientInfo
    try {
      info = await provider.detectClient()
    } catch (err) {
      deps.log.warn(`${provider.id}: detectClient failed: ${(err as Error).message}`)
      info = { installed: false }
    }
    clientCache.set(provider.id, { info, at: Date.now() })
    return info
  }

  async function scanOne(provider: GameProvider, options: ScanRunOptions): Promise<SourceOutcome> {
    const outcome: SourceOutcome = { added: 0, updated: 0, removed: 0 }
    const id = provider.id
    const confirm = options.reason === 'confirm'
    const emit = (
      phase: 'detecting' | 'scanning' | 'done' | 'error',
      found: number,
      message?: string
    ): void => {
      if (!confirm) deps.events.emit('scan:progress', { sourceId: id, phase, found, message })
    }

    emit('detecting', 0)
    // A confirming scan keeps the cached detection: for Xbox and Ubisoft a fresh one is a PowerShell run.
    const client = await detect(provider, !confirm)
    if (!client.installed && !provider.scansWithoutClient) {
      emit('done', 0, `${provider.name} is not installed`)
      deps.library.setSourceState(id, { lastScanAt: new Date().toISOString(), error: undefined })
      return outcome
    }
    emit('scanning', 0)
    try {
      const scanned = await provider.scanInstalled({
        settings: deps.settings.get(),
        log: deps.log,
        resourcesDir: deps.resourcesDir,
        progress: (found, message) => emit('scanning', found, message)
      })
      const romsRoot = deps.settings.get().library.romsRoot
      const unreachable = provider.unreachableRoots?.() ?? []
      let keep: Set<string>
      let awayVolumes = 0
      if (id === 'rom') {
        keep = romsRoot ? await romsKeptOutsideRoot(deps.library.games(), romsRoot) : new Set()
      } else {
        keep = gamesUnderUnreachableRoots(deps.library.games(), id, unreachable)
        const listed = keep.size
        const away = await gamesOnMissingVolumes(deps.library.games(), id, deps.isDirectory)
        for (const gameId of away) keep.add(gameId)
        awayVolumes = keep.size - listed
      }
      const merge = deps.library.mergeScan(id, scanned, { keep })
      if (id !== 'rom' && (unreachable.length || awayVolumes) && !confirm)
        deps.log.warn(
          `${id}: could not reach ${unreachable.join(', ') || 'a drive'}; the ${keep.size} game(s) installed there stay as they are` +
            (awayVolumes ? ` (${awayVolumes} on a drive that is not connected)` : '')
        )
      if (id === 'rom' && keep.size && !confirm)
        deps.log.warn(
          `rom: ${keep.size} ROM game(s) are outside the ROM folder ${romsRoot}; their cards stay while the files are there`
        )
      deps.library.registerPlatforms(provider.platforms())
      outcome.added = merge.added
      outcome.updated = merge.updated
      outcome.removed = merge.removed
      if (id === 'rom') outcome.unknownFolders = deps.providers.rom.lastUnknownFolders()
      deps.library.setSourceState(id, { lastScanAt: new Date().toISOString(), error: undefined })
      emit(
        'done',
        scanned.length,
        id === 'rom' && keep.size
          ? `${keep.size} ROM game(s) are outside the ROM folder (${romsRoot}). Move them into it, or choose the Emulation folder whose roms folder holds them in Settings › Library.`
          : undefined
      )
      // The provider's local art goes to the metadata service as seeds, in the same call that queues the new
      // games (ARCHITECTURE.md §4.3): the cover lane copies it, batches the library writes and, with
      // `scrapers.localArt`, asks the local caches for the games the provider found no art for. With auto-scrape
      // off only the seeds and the local caches are used, nothing is downloaded. `mergeScan` only reports art
      // for kinds the game still lacks, and a confirming scan (every 10 s while an install is tracked) queues
      // nothing unless it found a new game: the metadata queues are not reset by a scan that changed nothing.
      const seedIds = merge.localMedia.map((m) => m.gameId)
      if (merge.newGameIds.length || (seedIds.length && !confirm))
        deps.metadata.enqueue([...merge.newGameIds, ...seedIds], {
          seeds: merge.localMedia,
          coverOnly: !deps.settings.get().scrapers.autoScrape
        })
      if (merge.newGameIds.length)
        for (const listener of newGamesListeners) {
          try {
            listener(id, [...merge.newGameIds])
          } catch (listenerErr) {
            deps.log.warn(`${id}: new games listener failed: ${(listenerErr as Error).message}`)
          }
        }
      if (confirm) return outcome
      for (const listener of scannedListeners) {
        try {
          listener(id)
        } catch (listenerErr) {
          deps.log.warn(`${id}: scan listener failed: ${(listenerErr as Error).message}`)
        }
      }
    } catch (err) {
      const message = (err as Error).message
      deps.log.error(`${id}: scan failed`, err)
      deps.library.setSourceState(id, { error: message })
      emit('error', 0, message)
    }
    return outcome
  }

  /**
   * The scan of one source this call counts: the one running (joined), or a new one. A full scan does not join a
   * confirming one (no progress events, no scanned listeners): it runs once that one ended.
   */
  function scanOrJoin(provider: GameProvider, options: ScanRunOptions): Promise<SourceOutcome> {
    const id = provider.id
    const confirm = options.reason === 'confirm'
    const running = inflight.get(id)
    if (running && (confirm || !running.confirm)) return running.task
    const start = (): Promise<SourceOutcome> => scanOne(provider, options)
    const task: Promise<SourceOutcome> = (
      running ? running.task.then(start, start) : start()
    ).finally(() => {
      // Only its own entry: a full scan queued behind this one has replaced it.
      if (inflight.get(id)?.task === task) inflight.delete(id)
    })
    inflight.set(id, { task, confirm })
    return task
  }

  return {
    async run(ids, options = {}) {
      const settings = deps.settings.get()
      const providers = deps.providers
        .all()
        .filter((p) => (ids ? ids.includes(p.id) : true))
        .filter((p) => settings.library.sources[p.id]?.enabled !== false)
      const totals: ScanResult = { sources: [], added: 0, updated: 0, removed: 0 }
      const outcomes = await Promise.all(providers.map((p) => scanOrJoin(p, options)))
      for (const outcome of outcomes) {
        totals.added += outcome.added
        totals.updated += outcome.updated
        totals.removed += outcome.removed
        if (outcome.unknownFolders) totals.unknownFolders = outcome.unknownFolders
      }
      totals.sources = await this.sourceStatuses()
      return totals
    },

    async sourceStatuses() {
      const settings = deps.settings.get()
      const counts: Record<string, number> = {}
      for (const g of deps.library.games())
        if (g.installed) counts[g.source] = (counts[g.source] ?? 0) + 1
      const statuses: SourceStatus[] = []
      for (const p of deps.providers.all()) {
        const state = deps.library.sourceState(p.id)
        statuses.push({
          id: p.id,
          name: p.name,
          enabled: settings.library.sources[p.id]?.enabled !== false,
          client: await detect(p),
          lastScanAt: state.lastScanAt,
          gameCount: counts[p.id] ?? 0,
          error: state.error
        })
      }
      return statuses
    },

    isRunning: () => inflight.size > 0,

    async client(id) {
      const provider = deps.providers.get(id)
      return provider ? detect(provider) : { installed: false }
    },

    onSourceScanned(listener) {
      scannedListeners.add(listener)
      return () => {
        scannedListeners.delete(listener)
      }
    },

    onNewGames(listener) {
      newGamesListeners.add(listener)
      return () => {
        newGamesListeners.delete(listener)
      }
    }
  }
}
