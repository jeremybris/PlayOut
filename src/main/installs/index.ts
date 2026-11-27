// InstallService (docs/ARCHITECTURE.md §4.8): hands an owned, not installed game to its store client's install flow
// (allow-listed protocol URI or the client exe with an argv array) and starts the background tracker for it. The
// tracker's confirming scan is what flips the record to installed; `cancelInstallTracking` only stops watching.
// Installs go through the install queue (queue.ts): while another game downloads, the game waits its turn and is
// only handed to its store once the one before it ended.
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { dirname, join } from 'path'
import type {
  ClientInfo,
  Game,
  InstallProgress,
  InstallQueueEntry,
  InstallResult,
  StoreSourceId
} from '../../shared/types'
import type { InstallSpec, StoreAccount } from '../accounts/types'
import type { EventBus } from '../events'
import { findByNames, parseTasklistCsv, runTasklist } from '../launcher/process-monitor'
import type { Logger } from '../logger'
import { productDbPath } from '../providers/battlenet'
import { defaultEpicPaths } from '../providers/epic'
import { detectSteam, parseLibraryFolders } from '../providers/steam'
import type { LibraryService } from '../services/library-service'
import type { ScanService } from '../services/scan-service'
import { isDirectory, isFile, readTextIfExists } from '../util/fs'
import { displayTitle } from '../util/game-title'
import { knownFolders } from '../util/paths'
import { createBattlenetProbe } from './battlenet-progress'
import { createEaProbe } from './ea-progress'
import { createEpicProbe } from './epic-progress'
import { createGogProbe } from './gog-progress'
import { isAllowedInstallUri, storeDownloadsPage } from './install-uri'
import { createLogTail, type LogTail } from './log-tail'
import type { InstallQueue, InstallQueueStart } from './queue'
import { createSteamProbe } from './steam-progress'
import {
  createInstallTracker,
  type InstallProbe,
  type InstallTracker,
  type TrackerTiming
} from './tracker'
import { createUbisoftProbe } from './ubisoft-progress'
import { createXboxProbe } from './xbox-progress'
import { tMain } from '../i18n'

/** The side effects of an install, injectable for tests. */
export interface InstallIo {
  openExternal(uri: string): Promise<void>
  spawn(file: string, args: string[], options: SpawnOptions): ChildProcess
  /** Whether a process with this image name (without .exe) runs. */
  isProcessRunning(name: string): Promise<boolean>
  sleep(ms: number): Promise<void>
}

export interface InstallDeps {
  library: LibraryService
  accounts: {
    account(source: StoreSourceId): StoreAccount
    installSpec(game: Game, client: ClientInfo): InstallSpec | null
    installError(game: Game, client: ClientInfo): string
  }
  scan: Pick<ScanService, 'run' | 'client'>
  events: EventBus
  log: Logger
  /** Shared with the streaming service's ROM downloads: one download at a time. */
  queue: InstallQueue
  io?: Partial<InstallIo>
  /** Per-store probe factory; defaults to the readers in this folder. */
  probeFor?: (game: Game, source: StoreSourceId, client: ClientInfo) => Promise<InstallProbe | null>
  timing?: Partial<TrackerTiming>
}

export interface InstallService {
  installGame(id: string): Promise<InstallResult>
  /** Out of the install queue: a waiting game leaves it, the installing one stops being tracked. */
  cancelInstallTracking(id: string): void
  getInstalls(): InstallProgress[]
  /** Game ids with an active watch or waiting in the install queue (the owned import must not delete their records). */
  trackedGameIds(): string[]
  getInstallQueue(): InstallQueueEntry[]
  removeFromInstallQueue(id: string): void
  moveInInstallQueue(id: string, delta: -1 | 1): void
  /** Pause one game of the install queue (null: every game); see InstallQueue.pause. */
  pauseInstall(id: string | null): void
  /** Resume one paused game (null: every one). */
  resumeInstall(id: string | null): void
  /** powerMonitor suspend / resume. */
  pause(): void
  resume(): void
  dispose(): void
}

/** Stores whose probe gives numbers (2 s cadence); the others are state-only (10 s). */
export const MEASURED_SOURCES: readonly StoreSourceId[] = ['steam', 'gog', 'battlenet', 'ea']
/**
 * Confirming-scan interval for stores whose installed scan is a PowerShell run (Xbox: Get-AppxPackage; Ubisoft:
 * registry reads); the default 10 s would spawn powershell.exe several times a minute for the whole install.
 */
export const POWERSHELL_SCAN_MS = 45_000
const POWERSHELL_SOURCES: readonly StoreSourceId[] = ['xbox', 'ubisoft']
/**
 * Stores whose probe reliably sees a fresh install of the game start, so a fresh hand-off the store never shows
 * within the tracker's `unconfirmedMs` (10 min) was not confirmed there and the queue moves on: Steam (the
 * appmanifest_<appid>.acf appears, queued or downloading), GOG (the `ProductInstall (<id>)` job in a log tail anchored
 * at the hand-off), Battle.net (the uid's product.db entry or `active_installs` handshake) and Epic (the AppName's
 * .item manifest). Not EA (log lines matched on loosely related offer ids and slugs, the service may rename the job),
 * Xbox (an XboxGames folder matched on the display title) or Ubisoft (the Installs registry key, whose id may not be
 * the library's id): their watches, like every resumed one or one without a probe, are only ended by the confirming
 * scan, the store's cancel or the user.
 */
export const STORE_START_VISIBLE_SOURCES: readonly StoreSourceId[] = [
  'steam',
  'gog',
  'battlenet',
  'epic'
]
const notFromAStore = (): string => tMain('mainInstalls.notFromStore')

const defaultIo: InstallIo = {
  async openExternal(uri) {
    const { shell } = await import('electron')
    await shell.openExternal(uri)
  },
  spawn,
  async isProcessRunning(name) {
    try {
      return findByNames(parseTasklistCsv(await runTasklist()), [name]).length > 0
    } catch {
      return false
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

function extraString(game: Game, key: string): string | undefined {
  const value = game.extra?.[key]
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text || undefined
}

/**
 * A client-log tail positioned at the file's current end, so the probe only ever sees lines written after the
 * hand-off: the last 64 KB of GalaxyClient.log / EADesktopVerbose.log hold the previous install or uninstall of the
 * same product, which would complete or cancel the new watch at its first probe.
 */
async function anchoredTail(file: string): Promise<LogTail> {
  const tail = createLogTail(file, { lookbackBytes: 0 })
  await tail.readNew()
  return tail
}

/** The default progress reader of each store, built from the client detection and the game's ids. */
export async function defaultProbeFor(
  game: Game,
  source: StoreSourceId,
  _client: ClientInfo,
  log: Logger
): Promise<InstallProbe | null> {
  const folders = knownFolders()
  switch (source) {
    case 'steam': {
      const appId = Number(extraString(game, 'steamAppId') ?? game.externalId)
      if (!Number.isInteger(appId) || appId <= 0) return null
      const detection = await detectSteam(log)
      const root = detection.root
      if (!root) return null
      return createSteamProbe({
        appId,
        async libraries() {
          const text = await readTextIfExists(join(root, 'steamapps', 'libraryfolders.vdf'))
          let libraries = [root]
          if (text !== null) {
            try {
              libraries = parseLibraryFolders(text, root)
            } catch {
              /* the Steam folder alone */
            }
          }
          const existing: string[] = []
          for (const library of libraries)
            if (await isDirectory(join(library, 'steamapps'))) existing.push(library)
          return existing
        }
      })
    }
    case 'epic': {
      const appName = extraString(game, 'epicAppName') ?? game.externalId
      return createEpicProbe({ appName, manifestsDir: defaultEpicPaths().manifestsDir })
    }
    case 'gog': {
      const productId = extraString(game, 'gogProductId') ?? game.externalId
      const logFile = join(folders.programData, 'GOG.com', 'Galaxy', 'logs', 'GalaxyClient.log')
      return createGogProbe({ productId, logFile, tail: await anchoredTail(logFile) })
    }
    case 'battlenet': {
      const uid = extraString(game, 'uid')
      return uid ? createBattlenetProbe({ uid, dbPath: productDbPath() }) : null
    }
    case 'ea': {
      const logFile = join(
        folders.localAppData,
        'Electronic Arts',
        'EA Desktop',
        'Logs',
        'EADesktopVerbose.log'
      )
      return createEaProbe({
        ids: {
          offerId: extraString(game, 'eaOfferId'),
          slug: extraString(game, 'eaSlug'),
          softwareId: extraString(game, 'eaSoftwareId'),
          contentId: extraString(game, 'contentId')
        },
        logFile,
        tail: await anchoredTail(logFile)
      })
    }
    case 'xbox':
      return createXboxProbe({ title: game.title })
    case 'ubisoft': {
      const id = extraString(game, 'ubisoftId') ?? game.externalId
      return /^\d+$/.test(id) ? createUbisoftProbe({ id }) : null
    }
  }
}

export function createInstallService(deps: InstallDeps): InstallService {
  const io: InstallIo = { ...defaultIo, ...deps.io }
  const { log } = deps
  const tracker: InstallTracker = createInstallTracker({
    library: deps.library,
    scan: deps.scan,
    events: deps.events,
    log,
    timing: deps.timing
  })
  const probeFor =
    deps.probeFor ?? ((game, source, client) => defaultProbeFor(game, source, client, log))

  /** Run the spec: the allow-listed URI, or the client command (with its follow-up URI) for GOG and Battle.net. */
  async function execute(game: Game, spec: InstallSpec): Promise<string | null> {
    if (spec.kind === 'uri') {
      if (!isAllowedInstallUri(spec.uri))
        return tMain('mainDialogs.refusedScheme', { scheme: spec.uri.split(':')[0] })
      log.info(`${game.title}: opening ${spec.uri}`)
      await io.openExternal(spec.uri)
      return null
    }
    if (!(await isFile(spec.file))) return tMain('mainInstalls.clientNotFound', { file: spec.file })
    if (spec.requiresProcess && !(await io.isProcessRunning(spec.requiresProcess))) {
      if (!spec.followUpUri)
        return tMain('mainInstalls.clientNotRunning', { program: spec.requiresProcess })
      if (!isAllowedInstallUri(spec.followUpUri)) return tMain('mainDialogs.refusedUrl')
      log.info(`${game.title}: ${spec.requiresProcess} is not running; opening ${spec.followUpUri}`)
      await io.openExternal(spec.followUpUri)
      return null
    }
    log.info(`${game.title}: running ${spec.file} ${spec.args.join(' ')}`)
    await new Promise<void>((resolve, reject) => {
      try {
        const child = io.spawn(spec.file, spec.args, {
          cwd: dirname(spec.file),
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        })
        child.once('spawn', () => resolve())
        child.on('error', (err) => reject(err))
        child.unref()
      } catch (err) {
        reject(err)
      }
    })
    if (spec.followUpUri && isAllowedInstallUri(spec.followUpUri)) {
      const uri = spec.followUpUri
      void io
        .sleep(spec.followUpDelayMs ?? 0)
        .then(() => io.openExternal(uri))
        .catch((err) =>
          log.warn(`${game.title}: follow-up ${uri} failed: ${(err as Error).message}`)
        )
    } else if (spec.followUpUri) {
      // The client was started, so the hand-off stands; only the page it should have shown is missing.
      log.warn(
        `${game.title}: follow-up ${spec.followUpUri.split(':')[0]}: URL is not on the install allow-list; not opened`
      )
    }
    return null
  }

  /** Why this game cannot be installed now (installed, not from a store, no install form), or null. */
  async function refusal(game: Game): Promise<string | null> {
    if (game.installed) return tMain('mainInstalls.alreadyInstalled', { title: game.title })
    if (game.source === 'manual' || game.source === 'rom') return notFromAStore()
    const client = await deps.scan.client(game.source)
    if (!deps.accounts.installSpec(game, client)) return deps.accounts.installError(game, client)
    return null
  }

  async function buildProbe(
    game: Game,
    source: StoreSourceId,
    client: ClientInfo
  ): Promise<InstallProbe | null> {
    try {
      return await probeFor(game, source, client)
    } catch (err) {
      log.warn(
        `${game.title}: no progress reader (${(err as Error).message}); the scan will confirm`
      )
      return null
    }
  }

  /**
   * Start the watch: `done` settles when it ends (done, failed or cancelled), so the queue moves on; `stop` cancels
   * exactly this watch (nothing when the game was watched already, so the watch is not this start's to stop). The
   * queue holds the watch: no timer ends it once the store was asked (it may download where PlayOut cannot see it),
   * except a fresh hand-off to a store in STORE_START_VISIBLE_SOURCES that never shows the install (tracker
   * `expectStoreStart`: the user did not confirm it there, the queue moves on).
   */
  function watch(
    game: Game,
    source: StoreSourceId,
    probe: InstallProbe | null,
    resumed = false
  ): Required<Pick<InstallQueueStart, 'done' | 'stop'>> {
    const account = deps.accounts.account(source)
    let cancel: () => boolean = () => false
    const done = new Promise<void>((resolve) => {
      cancel = tracker.start({
        game,
        source,
        storeName: account.storeName,
        confirmMessage: resumed
          ? tMain('mainInstalls.installingThrough', { store: account.storeName })
          : account.confirmMessage,
        probe,
        measured: MEASURED_SOURCES.includes(source),
        scanMs: POWERSHELL_SOURCES.includes(source) ? POWERSHELL_SCAN_MS : undefined,
        holdWhenStalled: true,
        expectStoreStart: !resumed && !!probe && STORE_START_VISIBLE_SOURCES.includes(source),
        onEnd: resolve
      }).cancel
    })
    return { done, stop: () => void cancel() }
  }

  /**
   * The queue's start: hand the game to its store and start the watch (`done`, `stop`). A watch of the game found
   * already is joined (the run ends when it ends). `signal` (the queue's run): once aborted, nothing more is done
   * after the await that noticed it, and no watch is made. `handedOff` is called once the store was asked (the queue
   * saves it, so a restart from here on only resumes the watch).
   */
  async function handOff(
    game: Game,
    source: StoreSourceId,
    signal: AbortSignal,
    handedOff: () => void
  ): Promise<InstallQueueStart> {
    const client = await deps.scan.client(source)
    if (signal.aborted) return {}
    const spec = deps.accounts.installSpec(game, client)
    if (!spec) return { error: deps.accounts.installError(game, client) }
    // The probe is built before the hand-off so a log tail is anchored at the client's current output: nothing
    // the client wrote earlier about this product can end the new watch.
    const tracked = tracker.has(game.id)
    const probe = tracked ? null : await buildProbe(game, source, client)
    if (signal.aborted) return {}
    try {
      const error = await execute(game, spec)
      if (error) return { error }
      handedOff()
    } catch (err) {
      const message = (err as Error).message || String(err)
      log.error(`${game.title}: install hand-off failed: ${message}`)
      return { error: tMain('mainInstalls.couldNotStart', { error: message }) }
    }
    // Removed during the hand-off: the store has it (nothing to take back), but it is not watched.
    if (signal.aborted) return {}
    return watch(game, source, probe)
  }

  /** The queue's active entry is this game and its run's watch is tracked. */
  function owning(gameId: string): boolean {
    return deps.queue.activeId() === gameId && tracker.has(gameId)
  }

  /**
   * A second Install of the game installing now: the hand-off is sent to the store again and the queue run's watch
   * is kept. Never makes a watch: 'queue' when, after an await, the game is no longer the active, watched one (its
   * watch ended or it was removed meanwhile), so the caller goes through the queue like any other Install.
   */
  async function resend(game: Game, source: StoreSourceId): Promise<InstallResult | 'queue'> {
    const client = await deps.scan.client(source)
    if (!owning(game.id)) return 'queue'
    const spec = deps.accounts.installSpec(game, client)
    if (!spec) return { ok: false, error: deps.accounts.installError(game, client) }
    try {
      const error = await execute(game, spec)
      if (error) return { ok: false, error }
    } catch (err) {
      const message = (err as Error).message || String(err)
      log.error(`${game.title}: install hand-off failed: ${message}`)
      return { ok: false, error: tMain('mainInstalls.couldNotStart', { error: message }) }
    }
    // The store was asked again; when the watch ended meanwhile, the queue takes the game (a repeated hand-off of
    // a game the store already has is harmless, an unwatched one would download next to the queue's next game).
    return owning(game.id) ? { ok: true } : 'queue'
  }

  /**
   * Waiting store games that became installed (installed straight in the store, or by another PC) leave the queue
   * at once; the active one is left to its watch, whose confirming scan ends it.
   */
  const offLibrary = deps.events.on('library:changed', () => {
    const activeId = deps.queue.activeId()
    for (const entry of deps.queue.list()) {
      if (entry.kind !== 'store' || entry.state !== 'waiting' || entry.gameId === activeId) continue
      if (!deps.library.getGame(entry.gameId)?.installed) continue
      log.info(`${entry.title}: installed outside the install queue; removed from it`)
      deps.queue.remove(entry.gameId)
    }
  })

  deps.queue.register('store', {
    async start(entry, { resumed, handedOff, markHandedOff, signal }) {
      const game = deps.library.getGame(entry.gameId)
      if (!game) return { error: tMain('mainInstalls.notInLibrary', { title: entry.title }) }
      if (game.source === 'manual' || game.source === 'rom') return { error: notFromAStore() }
      // A watch of this game already running (started outside the queue) is joined, not replaced: `done` follows it
      // and `stop` leaves it alone, since it is not this start's. A resumed entry whose hand-off was not saved as
      // done (PlayOut closed before or during it) gets the full hand-off: the store may never have been asked.
      if (!resumed || !handedOff) return handOff(game, game.source, signal, markHandedOff)
      // PlayOut closed during the install: the store still has it, so only the watch starts again.
      const client = await deps.scan.client(game.source)
      if (signal.aborted) return {}
      const probe = await buildProbe(game, game.source, client)
      if (signal.aborted) return {}
      return watch(game, game.source, probe, true)
    },
    reportError(entry, message) {
      if (entry.source === 'host') return
      const at = new Date().toISOString()
      deps.events.emit('install:progress', {
        gameId: entry.gameId,
        source: entry.source,
        state: 'failed',
        message,
        startedAt: at,
        updatedAt: at
      })
    },
    skip(entry) {
      const game = deps.library.getGame(entry.gameId)
      return !game || game.installed
    },
    // PlayOut cannot pause a store's download: it stays the active one (one download at a time) and the store's
    // downloads page opens so the user pauses it there. Nothing opens again for an entry resumed after a restart.
    pauseActive(entry, { resumed }) {
      if (!resumed && entry.source !== 'host') {
        const uri = storeDownloadsPage(entry.source)
        if (isAllowedInstallUri(uri)) {
          log.info(`${entry.title}: paused; opening ${uri} to pause it in ${entry.from}`)
          void io
            .openExternal(uri)
            .catch((err) =>
              log.warn(`${entry.title}: could not open ${uri}: ${(err as Error).message}`)
            )
        }
      }
      return 'hold'
    }
  })

  return {
    async installGame(id): Promise<InstallResult> {
      const game = deps.library.requireGame(id)
      const error = await refusal(game)
      if (error || game.source === 'manual' || game.source === 'rom')
        return { ok: false, error: error ?? notFromAStore() }
      // A second Install of the game installing now re-sends the hand-off; it never makes a watch of its own (only
      // the queue's run does), so when the game stopped being the active, watched one meanwhile it is queued instead.
      if (owning(game.id)) {
        const result = await resend(game, game.source)
        if (result !== 'queue') return result
        const now = deps.library.getGame(game.id)
        if (!now)
          return { ok: false, error: tMain('mainInstalls.notInLibraryGame', { title: game.title }) }
        if (now.installed)
          return { ok: false, error: tMain('mainInstalls.alreadyInstalled', { title: game.title }) }
      }
      const added = await deps.queue.add({
        gameId: game.id,
        title: displayTitle(game),
        kind: 'store',
        source: game.source,
        from: deps.accounts.account(game.source).storeName
      })
      if (added.error) return { ok: false, error: added.error }
      return added.position > 0 ? { ok: true, queued: added.position } : { ok: true }
    },

    cancelInstallTracking(id) {
      deps.queue.remove(id)
    },

    getInstalls: () => tracker.list(),
    trackedGameIds: () => [
      ...new Set([
        ...tracker.list().map((p) => p.gameId),
        ...deps.queue
          .list()
          .filter((e) => e.kind === 'store')
          .map((e) => e.gameId)
      ])
    ],
    getInstallQueue: () => deps.queue.list(),
    removeFromInstallQueue: (id) => deps.queue.remove(id),
    moveInInstallQueue: (id, delta) => deps.queue.move(id, delta),
    pauseInstall: (id) => deps.queue.pause(id),
    resumeInstall: (id) => deps.queue.resume(id),
    pause: () => tracker.pause(),
    resume: () => tracker.resume(),
    dispose: () => {
      offLibrary()
      tracker.dispose()
    }
  }
}

export type { InstallProbe, InstallTracker, ProbeResult, TrackerTiming } from './tracker'
