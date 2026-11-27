import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { loginItemPath } from './util/paths'
import { readInstallMove, recordInstallMove, rememberInstallDir } from './util/install-move'
import { spawn } from 'child_process'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  screen,
  shell,
  Tray
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, promises as fs } from 'fs'
import { basename, dirname, join } from 'path'
import { createAccountsService } from './accounts'
import { createAchievementsService } from './achievements/achievements-service'
import { configureRetroAchievements } from './achievements/retroachievements'
import { createEmulationService, resolvePaths } from './emulation'
import { launchesWith } from './emulation/launch-command'
import { createEmulatorSetupService } from './emulator-setup/service'
import { createRendererBroadcast, EventBus } from './events'
import { createInstallService } from './installs'
import { createInstallQueue } from './installs/queue'
import { createSteamDlcService } from './steam-dlc/service'
import {
  createUpgradesService,
  spawnCompact,
  upgradesDirBeside,
  verifySigner
} from './upgrades/service'
import { spawnTool } from './upgrades/scskiller'
import { spawnDetached } from './upgrades/aio'
import { UPGRADES_FOLDER, upgradeRunningMessage } from '../shared/upgrades'
import { createPsWorker } from './system/ps-worker'
import { listFixedDrives } from './system/drives'
import { createPsPool } from './system/ps-pool'
import { downloadFile, fetchJson, fetchText } from './emulator-setup/download'
import { extractArchive } from './emulator-setup/archive'
import { ensureSevenZip } from './emulator-setup/sevenzip'
import { createHandlers } from './ipc/handlers'
import { registerIpc } from './ipc/register'
import { createLauncher } from './launcher'
import { createCoopService } from './coop/coop-service'
import { createPeerPartyService } from './peerparty/service'
import { createPeerPartyOverlay } from './peerparty/overlay'
import { DATA_DIR_NAME } from './peerparty/prefs'
import { PEERPARTY_FOLDER } from '../shared/peerparty'
import { createIngameHelper } from './overlay/ingame/helper'
import { createRecompService } from './recomp/service'
import { createVrModsService } from './vr-mods/service'
import { VR_MODS_FOLDER } from '../shared/vr-mods'
import { createPs3UpdateService } from './emulation/ps3-update-service'
import { createDiagLog } from './diag-log'
import { createLogger, initLogger, logFilePath, mirrorLogTo } from './logger'
import { compressedPowerShellArgs, runElevated, runProcess } from './emulator-setup/run'
import { createHostFirewall } from './streaming/firewall'
import { parseTasklist } from './home-button/io'
import { createSleepWakeService } from './sleep/service'
import { onStoreWriteError, onStoreWriteTrace } from './store/json-store'
import { bounded, flushStores, type FlushableStore } from './store/bounded'
import {
  installMediaProtocol,
  registerMediaScheme,
  type RemoteMediaResolver
} from './media-protocol'
import { createProviders } from './providers'
import { gogHiddenIds, readGalaxyHiddenGogIds } from './providers/gog-galaxy-hidden'
import { readSteamHiddenApps } from './providers/steam'
import { createImageCache, createMetadataService } from './scrapers'
import { createLocalPlayers } from './scrapers/launchbox-players'
import { createReviewScores, igdbCredentialsKey } from './scrapers/review-scores'
import { createSteamScreenshots } from './scrapers/steam-screenshots'
import { createScreenshotMirror } from './scrapers/screenshot-mirror'
import { createSteamTags } from './scrapers/steam-tags'
import { runArtBench } from './scrapers/art-bench'
import {
  ART_SOURCES_FILE,
  ART_STARTUP_CHECK_MS,
  checkArtSourcesSinceLastRun,
  queueMissing,
  saveArtSources,
  watchArtKeys
} from './scrapers/missing-art'
import { igdbScraper } from './scrapers/igdb'
import { screenScraperScraper } from './scrapers/screenscraper'
import { steamGridDbScraper } from './scrapers/steamgriddb'
import { theGamesDbScraper } from './scrapers/thegamesdb'
import type { MetadataProgress } from '../shared/types'
import { LibraryService } from './services/library-service'
import { MetadataCloudOverlay } from './metadata-edits/cloud-overlay'
import { RemoteMetadataEdits, remoteEditsJsonStore } from './metadata-edits/remote-edits'
import { GameDatabaseService } from './game-database/service'
import { MetadataCloudService } from './metadata-cloud/service'
import { createInstallSizeService } from './services/install-size'
import { createLocalDeleteService } from './services/local-delete'
import { createScanService, startupScanSources } from './services/scan-service'
import {
  emulationDirOf,
  ensureDefaultEmulationDir,
  keepRomsRootInSync,
  setDocumentsOnFirstStart
} from './emulation/emulation-dir'
import {
  documentsEmulationDir,
  forbiddenRoots,
  isSameOrInside
} from './emulation/emulation-location'
import { createEmulationMoveService } from './emulation/emulation-move-service'
import { generateFoldersAt } from './emulation/generated-folders'
import { rebasePath } from './emulator-setup/service'
import {
  createFavoritesBackup,
  isFavoritesFilePath,
  type FavoritesBackup
} from './favorites/favorites-file'
import { hostname } from 'os'
import { createConvertService } from './convert/convert-service'
import { createAutoTrimService, helperXboxInfo } from './convert/auto-trim'
import { chdRead, HELPER_EXE, sweepPartials } from './convert/xbox-helper'
import { LibraryStore } from './store/library-store'
import { SessionsStore } from './store/sessions-store'
import { SettingsStore } from './store/settings-store'
import { createSystemService } from './system'
import { createStreamingService } from './streaming/streaming-service'
import {
  hasStreamLaunchFlag,
  runStreamLaunchClient,
  STREAM_LAUNCH_FLAG,
  streamLaunchPipeName
} from './streaming/stream-launch'
import { createUpdateService } from './updates'
import { pathExists } from './util/fs'
import { createCloseToTray, type TrayActions, type TrayIcon } from './tray'
import { createMainWindow } from './window'
import { registerMusicProtocol } from './media/music-protocol'
import { hwndOf } from './native-host/native-ops'
import { createOverlaySuite, type OverlaySuite } from './overlay/suite'
import { createFriendsService } from './friends/steam-friends'
import { createControllerWakeService } from './controller-wake/service'
import { readWakeDevices } from './controller-wake/scripts'

import { onMainLanguageChange, setupLanguage, tMain } from './i18n'
interface CliOptions {
  mock: boolean
  windowed: boolean
  screenshot: string | null
  /** Initial screen for the renderer in mock mode (home, library, detail, addgames, settings, settings-metadata, settings-streaming, search, empty, quickpanel). */
  screen: string | null
  /** Diagnostic: scan every enabled source at startup and write a JSON report to this path (then quit unless --screenshot). */
  scanReport: string | null
  autostart: boolean
  /** `--art-bench`: the local-only cover probe of ARCHITECTURE.md §7 (no window; writes art-bench.json and exits). */
  artBench: boolean
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {
    mock: false,
    windowed: false,
    screenshot: null,
    screen: null,
    scanReport: null,
    autostart: false,
    artBench: false
  }
  for (const arg of argv) {
    if (arg === '--mock') opts.mock = true
    else if (arg === '--windowed') opts.windowed = true
    else if (arg === '--autostart') opts.autostart = true
    else if (arg === '--art-bench') opts.artBench = true
    else if (arg.startsWith('--screenshot=')) opts.screenshot = arg.slice('--screenshot='.length)
    else if (arg.startsWith('--screen=')) opts.screen = arg.slice('--screen='.length)
    else if (arg.startsWith('--scan=')) opts.scanReport = arg.slice('--scan='.length)
  }
  return opts
}

/** How long the last-resort handler waits for the stores to be saved before it exits anyway. */
const FATAL_SAVE_TIMEOUT_MS = 3000
/** How long closing waits for one service to stop, and for one store file to be saved. */
const CLOSE_STEP_TIMEOUT_MS = 15_000
const CLOSE_SAVE_TIMEOUT_MS = 10_000

/**
 * The stores `fatal` saves before it exits (settings, library, sessions; set by main() once they are loaded):
 * app.exit runs no before-quit handler, so changes still waiting for their debounced write would be lost.
 */
let fatalSaveStores: Readonly<Record<string, FlushableStore>> | null = null
let fatalStarted = false

/**
 * Last resort for an error nothing caught: log it, save the stores (best effort, a few seconds at most), tell the
 * user when a dialog is possible, exit non-zero.
 */
function fatal(context: string, err: unknown): void {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
  try {
    createLogger('main').error(context, err)
  } catch {
    /* the logger itself may be what failed */
  }
  // A second error while the first is saving or showing its dialog is only logged: the first one exits.
  if (fatalStarted) return
  fatalStarted = true
  const exit = (): void => {
    try {
      if (app.isReady()) dialog.showErrorBox(tMain('mainApp.cannotStart'), `${context}: ${text}`)
      else console.error(`${context}: ${text}`)
    } finally {
      // app.exit, not app.quit: the before-quit flush handler may not be registered yet (or may be what threw).
      app.exit(1)
    }
  }
  if (!fatalSaveStores) {
    exit()
    return
  }
  // Before the dialog, which blocks until it is dismissed. flushStores never rejects and is bounded.
  void flushStores(fatalSaveStores, FATAL_SAVE_TIMEOUT_MS).then(exit, exit)
}
process.on('uncaughtException', (err) => fatal('uncaught exception', err))
process.on('unhandledRejection', (reason) => fatal('unhandled rejection', reason))

registerMediaScheme()

const cli = parseCli(process.argv.slice(1))
// Mock runs (screenshots, UI work) never read or write the user's real library, settings or logs. Electron keys the
// single-instance lock on userData, so this must happen before the lock is requested (ARCHITECTURE.md 4.1).
if (cli.mock && !process.argv.some((a) => a.startsWith('--user-data-dir=')))
  app.setPath('userData', join(app.getPath('temp'), 'playout-mock'))

/** Shared by the app (which creates it) and the `--stream-launch` process (which reads it): both see this userData. */
const streamLaunchTokenFile = join(app.getPath('userData'), 'streaming', 'stream-launch.token')

if (hasStreamLaunchFlag(process.argv)) {
  // Sunshine's app command (Streaming, ARCHITECTURE.md §4.13): no window and no single-instance lock (the running
  // PlayOut holds it). Ask the running PlayOut to start the armed game over the pipe and block until it ends, so
  // Sunshine streams exactly as long as the game runs. After the userData switch above, so both agree on the token.
  void runStreamLaunchClient(process.argv, {
    pipeName: streamLaunchPipeName(),
    tokenFile: streamLaunchTokenFile,
    // In development the exe is electron.exe, which needs the app folder to be PlayOut.
    startApp: app.isPackaged
      ? undefined
      : () => {
          const child = spawn(process.execPath, [app.getAppPath()], {
            detached: true,
            stdio: 'ignore'
          })
          child.on('error', () => undefined)
          child.unref()
        }
  }).then((code) => app.exit(code))
} else {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    main(cli).catch((err) => fatal('startup failed', err))
  }
}

async function main(cli: CliOptions): Promise<void> {
  initLogger()
  const log = createLogger('main')
  log.info(`PlayOut ${app.getVersion()} starting (${app.isPackaged ? 'packaged' : 'dev'})`, cli)
  // Screenshots are captured in device pixels: a 1:1 scale factor makes the 1920x1080 window exactly 1920x1080 px.
  if (cli.screenshot) app.commandLine.appendSwitch('force-device-scale-factor', '1')

  await app.whenReady()
  electronApp.setAppUserModelId('com.playout.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  const userData = app.getPath('userData')
  const resourcesDir = join(app.getAppPath(), 'resources', 'systems')
  // logs/install-size.log: the install-size scan step by step, store files that will not save, and any freeze of
  // this process. Written line by line to disk, so it holds up even when the app has to be killed.
  const diag = createDiagLog(join(userData, 'logs', 'install-size.log'))
  diag.line(
    `--- PlayOut ${app.getVersion()} started; data folder ${userData}; regular log ${logFilePath() ?? 'unavailable'}`
  )
  // Warnings, errors and any trouble writing the regular log also land here (logger.ts).
  mirrorLogTo((text) => diag.line(`log: ${text}`))
  onStoreWriteTrace((text) => diag.line(text))
  // Alive every minute: a log that stops without "closing" means PlayOut froze or was killed there.
  setInterval(() => diag.line('alive'), 60_000).unref()
  app.on('will-quit', () => diag.line('--- closing'))
  onStoreWriteError((file, err) =>
    diag.line(
      `store write failed: ${file}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`
    )
  )
  // A frozen main process stops everything (scans, saves, the window): measured as timer lateness.
  let lastTick = Date.now()
  setInterval(() => {
    const now = Date.now()
    const late = now - lastTick - 1000
    if (late > 2000) diag.line(`main process was frozen for ${(late / 1000).toFixed(1)} s`)
    lastTick = now
  }, 1000).unref()

  // --- stores ---------------------------------------------------------------
  // PlayOut's first start on this PC: no settings file yet (it offers to pair with a host found on the network).
  const firstStart = !(await fs.stat(join(userData, 'settings.json')).catch(() => null))
  const settings = new SettingsStore(join(userData, 'settings.json'))
  const libraryStore = new LibraryStore(join(userData, 'library.json'))
  const sessionsStore = new SessionsStore(join(userData, 'sessions.json'))
  await Promise.all([settings.load(), libraryStore.load(), sessionsStore.load()])
  // Saved at closing, and by the last-resort error handler (only once loaded: never defaults over a real file).
  const savedStores: Record<string, FlushableStore> = {
    settings,
    library: libraryStore,
    sessions: sessionsStore
  }
  fatalSaveStores = savedStores
  // A new install's Emulation folder is Documents\Emulation (made below, with ensureDefaultEmulationDir): outside the
  // install and data folders, so an uninstall never takes it. One already there (a reinstall) is adopted as it is, with
  // the favourites file in it. Existing installs keep theirs (never moved silently).
  const documentsEmulation = documentsEmulationDir(app.getPath('documents'))
  if (!cli.mock)
    setDocumentsOnFirstStart({ firstStart, settings, documentsDefault: documentsEmulation })
  // The ROM folder is always the Emulation folder's roms folder: set now (before any scan reads it) and kept so.
  keepRomsRootInSync({ settings, userData })
  // PlayOut's language (Settings > System > Language): picked from Steam's or Windows' on the first start, before any
  // window or main-side text needs it.
  await setupLanguage(settings)

  // --- services -------------------------------------------------------------
  // Events reach the main window and the overlay only (the account sign-in windows must not receive them); the
  // windows are created further down, so the broadcast looks them up on every emit.
  let mainWindow: ReturnType<typeof createMainWindow> | null = null
  let overlaySuite: OverlaySuite | null = null
  const events = new EventBus(
    await createRendererBroadcast(() => [
      mainWindow?.get() ?? null,
      overlaySuite?.overlayWindow() ?? null,
      // The in-game overlay's offscreen page (index.html?overlay=1&ingame=1) follows the same events.
      overlaySuite?.ingameWindow() ?? null
    ])
  )
  const library = new LibraryService(libraryStore, sessionsStore, events)
  // The metadata cloud's corrections, laid over the scraped metadata of every game shown (shared/metadata-edit.ts).
  // The metadata cloud service (main/metadata-cloud) fills it from all.json and publishes / suggests the user's own
  // edits through library.setMetadataEditedHook.
  const metadataCloud = new MetadataCloudOverlay()
  library.setCloudOverlay(metadataCloud)
  // The user's edits of a paired host's games (they have no record here), laid over the hosts' metadata.
  const remoteEditsStore = remoteEditsJsonStore(join(userData, 'remote-metadata-edits.json'))
  // A file that could not be read is left alone (never written over with an empty one); host games are not editable then.
  const remoteEditsLoaded = await remoteEditsStore.load().then(
    () => true,
    (err: unknown) => {
      log.warn('remote metadata edits: could not read them', err)
      return false
    }
  )
  if (remoteEditsLoaded) library.setRemoteMetadataEdits(new RemoteMetadataEdits(remoteEditsStore))
  if (remoteEditsLoaded) savedStores['remote metadata edits'] = remoteEditsStore
  const metadataCloudService = new MetadataCloudService({
    dir: join(userData, 'metadata-cloud'),
    overlay: metadataCloud,
    library,
    events,
    log: createLogger('metadata-cloud'),
    appVersion: app.getVersion()
  })
  metadataCloudService.start().catch((err) => log.warn('metadata cloud: could not start', err))
  // The PlayOut database (main/game-database): each game's facts, read before the scrapers; the games it lacks are
  // contributed through the metadata cloud's relay with its anonymous install id.
  const gameDatabase = new GameDatabaseService({
    dir: join(userData, 'game-database'),
    library,
    settings,
    relay: metadataCloudService,
    appVersion: app.getVersion(),
    log: createLogger('game-database')
  })
  gameDatabase.start().catch((err) => log.warn('game database: could not start', err))
  const imageCache = createImageCache({
    dir: join(userData, 'media'),
    log: createLogger('image-cache')
  })
  // media://remote/... (a paired host's art) is answered by the streaming service, created further down.
  let remoteMedia: RemoteMediaResolver | null = null
  installMediaProtocol(
    (p) => imageCache.resolve(p),
    (hostId, hostGameId, kind, rev) =>
      remoteMedia ? remoteMedia(hostId, hostGameId, kind, rev) : Promise.resolve(null)
  )
  if (cli.artBench) {
    // The probe refuses the real user-data folder: it merges thousands of owned records into library.json.
    if (!process.argv.some((a) => a.startsWith('--user-data-dir=')))
      throw new Error('--art-bench needs --user-data-dir=<throw-away folder>')
    await runArtBench({
      settings,
      library,
      imageCache,
      events,
      resourcesDir,
      userData,
      log: createLogger('art-bench')
    })
    await Promise.all([settings.flush(), libraryStore.flush(), sessionsStore.flush()])
    app.exit(0)
    return
  }
  // The emulators PlayOut downloads and sets up itself (docs/emulator-setup.md); the resolver finds them first.
  // An installed PlayOut whose folder the user moved since its last start (the folder is portable): the paths saved
  // inside the old folder follow. Dev and portable runs (same userData) are never installs: they record nothing.
  const installed = app.isPackaged && !process.env['PORTABLE_EXECUTABLE_DIR']
  const exeDirNow = resolvePaths().exeDir
  const installMove = installed
    ? readInstallMove(
        exeDirNow,
        userData,
        process.env['LOCALAPPDATA'] ?? join(app.getPath('home'), 'AppData', 'Local')
      )
    : { moved: false, rebaseFrom: [] }
  if (installed) {
    recordInstallMove(exeDirNow, userData)
    // The installer installs updates (and a setup run by hand) into this folder, wherever the user moved it.
    rememberInstallDir(exeDirNow, (msg) => log.warn(msg))
  }
  if (installMove.moved && installMove.rebaseFrom.length) {
    log.info(`PlayOut runs from ${exeDirNow}; before: ${installMove.rebaseFrom.join(', ')}`)
    // Launch at login names PlayOut.exe by its path: the entry is written again for this folder.
    if (settings.get().system.launchAtLogin)
      try {
        app.setLoginItemSettings({
          openAtLogin: true,
          path: loginItemPath(),
          args: ['--autostart']
        })
      } catch (err) {
        log.warn(`setLoginItemSettings after the move failed: ${(err as Error).message}`)
      }
  }
  const previousExeDirs = installMove.rebaseFrom
  const emulatorSetup = createEmulatorSetupService({
    settings,
    userData,
    exeDir: resolvePaths().exeDir,
    previousExeDirs,
    emit: (progress) => events.emit('emulator-setup:progress', progress),
    log: createLogger('emulator-setup'),
    onInstalled: () => emulation.invalidateEmulators(),
    // The PCSX2 game list pre-warm: the library's PS2 games that start in PCSX2 (standalone), never while a game runs.
    isGameRunning: () => launcherRef?.running() != null,
    pcsx2Roms: () => {
      const system = emulation.findSystem('ps2')
      if (!system) return []
      const current = settings.get()
      return library.games().flatMap((g) => {
        if (g.launch.kind !== 'emulator' || g.launch.systemId !== 'ps2') return []
        // The command a launch picks (the game's choice, the scan's, the system's preferred, the default).
        // A card kept for its recompilation (Game.romRemoved) has no ROM file.
        const rom = g.romRemoved ? '' : (g.romPath ?? g.launch.romPath)
        return rom && launchesWith(system, g, current, 'PCSX2') ? [rom] : []
      })
    }
  })
  let launcherRef: { running(): unknown } | null = null
  const emulation = createEmulationService({
    settings,
    resourcesDir,
    log: createLogger('emulation'),
    managed: (id) => emulatorSetup.managedExe(id)
  })
  const providers = createProviders({
    library,
    emulation,
    settings,
    log: createLogger('providers')
  })
  const metadata = createMetadataService({
    settings,
    library,
    imageCache,
    events,
    resourcesDir,
    log: createLogger('metadata'),
    gameDatabase
  })
  // Review scores in the background (Steam's, else IGDB's while its credentials are set): after the startup scan,
  // whenever games arrive or get their titles, and when the IGDB credentials change.
  const ratings = createReviewScores({
    library,
    settings,
    log: createLogger('review-scores'),
    onProgress: (progress) => events.emit('ratings:progress', progress)
  })
  // How many players each game takes, from LaunchBox's public database (downloaded once a month): after the
  // startup scan and whenever games arrive or get their titles.
  const localPlayers = createLocalPlayers({
    library,
    dataDir: userData,
    log: createLogger('launchbox-players'),
    onProgress: (progress) => events.emit('players:progress', progress),
    onChanged: (gameIds) => events.emit('library:changed', { reason: 'metadata', gameIds })
  })
  // Steam user tags in the background, on the same occasions (and when they are switched on).
  const steamTags = createSteamTags({ library, settings, log: createLogger('steam-tags') })
  // Steam games' store screenshots (the game page's row): the list and each thumbnail, downloaded in the background.
  const steamScreenshots = createSteamScreenshots({
    library,
    imageCache,
    emit: (progress) => events.emit('screenshots:progress', progress),
    onSaved: (gameId, items) => events.emit('steam-screenshots:updated', { gameId, items }),
    mirror: createScreenshotMirror({ log: createLogger('screenshot-mirror') }),
    log: createLogger('steam-screenshots')
  })
  let igdbKey = igdbCredentialsKey(settings.get())
  let tagsOn = settings.get().scrapers.steamTags.enabled
  let databaseOn = settings.get().scrapers.gameDatabase.enabled
  settings.onChange((next) => {
    const key = igdbCredentialsKey(next)
    if (key !== igdbKey) {
      igdbKey = key
      ratings.kick()
    }
    if (next.scrapers.steamTags.enabled !== tagsOn) {
      tagsOn = next.scrapers.steamTags.enabled
      if (tagsOn) steamTags.kick()
    }
    if (next.scrapers.gameDatabase.enabled !== databaseOn) {
      databaseOn = next.scrapers.gameDatabase.enabled
      if (databaseOn) void gameDatabase.prefetch()
    }
  })
  // A SteamGridDB / ScreenScraper / IGDB / TheGamesDB key saved where none was: the games without a cover (and the
  // rest of the missing art) are looked at once, as "Refresh missing" would. The set-up sources are remembered in
  // userData/missing-art.json (ids only), so a key saved before an update or just before a quit gets its pass at the
  // next start (a little after the metadata resume pass); nothing runs at a start where nothing changed.
  const artKeys = createLogger('missing-art')
  const artScrapers = [steamGridDbScraper, screenScraperScraper, igdbScraper, theGamesDbScraper]
  const artSourcesFile = join(userData, ART_SOURCES_FILE)
  // The watcher's saves wait for the start-up check, which must compare against the previous run's list.
  let artStartupChecked = false
  const saveArtList = (ids: string[]): void => {
    if (!artStartupChecked) return
    saveArtSources(artSourcesFile, ids).catch((err) =>
      artKeys.warn('saving the art sources failed', err)
    )
  }
  watchArtKeys({
    settings,
    scrapers: artScrapers,
    log: artKeys,
    run: () => queueMissing(library, metadata, artKeys, 'art source added'),
    save: saveArtList
  })
  // The metadata resume pass (10 s) may already have retried some cover-less games; the start-up pass skips those.
  const artStartedAt = Date.now()
  setTimeout(() => {
    checkArtSourcesSinceLastRun({
      file: artSourcesFile,
      settings,
      scrapers: artScrapers,
      library,
      log: artKeys,
      run: () =>
        queueMissing(library, metadata, artKeys, 'art source set up since last run', {
          skipTriedSince: artStartedAt
        })
    })
      .catch((err) => artKeys.warn('the start-up art source check failed', err))
      .finally(() => {
        artStartupChecked = true
      })
  }, ART_STARTUP_CHECK_MS).unref()
  configureRetroAchievements({ userAgent: `PlayOut/${app.getVersion()}` })
  const achievements = createAchievementsService({
    settings,
    library,
    events,
    cacheDir: join(userData, 'retroachievements'),
    log: createLogger('achievements')
  })
  let recompDirOf: (id: string) => Promise<string | null | undefined> = async () => undefined
  const installSizes = createInstallSizeService({
    library,
    cacheFile: join(userData, 'install-sizes.json'),
    events,
    trace: diag,
    log: createLogger('install-size'),
    // Games played from their recompilation are sized by its folder (the recompilation service starts later).
    recompDir: (id) => recompDirOf(id)
  })
  const scan = createScanService({
    providers,
    library,
    settings,
    events,
    metadata,
    resourcesDir,
    log: createLogger('scan')
  })
  const system = createSystemService({ log: createLogger('system') })

  // --- window ---------------------------------------------------------------
  const window = createMainWindow({
    startFullscreen: settings.get().ui.startFullscreen && !cli.windowed && !cli.screenshot,
    query: { ...(cli.mock ? { mock: '1' } : {}), ...(cli.screen ? { screen: cli.screen } : {}) },
    fixedSize: cli.screenshot ? { width: 1920, height: 1080 } : undefined,
    onFocusChange: (focused) => events.emit('window:focus', { focused }),
    forceForeground: (hwnd) => overlaySuite?.forceForeground(hwnd) ?? Promise.resolve(false)
  })
  mainWindow = window

  // Settings > System > Minimize to tray (main/tray.ts). Never during a screenshot run, which must quit by itself.
  const closeToTray = createCloseToTray({
    enabled: () => !cli.screenshot && settings.get().system.minimizeToTray,
    createTray: (actions) => createAppTray(actions),
    quit: () => app.quit(),
    log: createLogger('tray')
  })
  const mainBrowserWindow = window.get()
  if (mainBrowserWindow) closeToTray.attach(mainBrowserWindow)
  settings.onChange(() => closeToTray.sync())

  // Whether an Upgrade menu action runs for a game; set once the upgrades service exists (created further down).
  let upgradeBusy: (gameId: string) => boolean = () => false
  const launcher = createLauncher({
    settings,
    emulation,
    library,
    events,
    window,
    log: createLogger('launcher'),
    // Ryujinx binds pads by device id: the entries PlayOut wrote follow the pads connected now.
    beforeLaunch: (emulatorId, exe, rom, context) =>
      emulatorSetup.beforeLaunch(emulatorId, exe, rom, context),
    // An upgrade rewriting the game's files (the Upgrade menu): every start of it waits until it ends.
    launchBlocked: (game) => (upgradeBusy(game.id) ? upgradeRunningMessage(tMain) : null)
  })
  launcherRef = launcher
  // PCSX2 scans the PS2 games it does not list yet once nothing runs: after a game, and when the library gained games.
  events.on('session:ended', () => emulatorSetup.prewarmPcsx2())

  // The home button and the in-game overlay (docs/home-overlay.md): the controller reader, the overlay window, power
  // profiles, display and media. Started with the deferred start-up work below.
  // The in-game overlay's helper and DLL ship unpacked beside the app (resources\ingame); missing = window overlay.
  const ingameDir = join(
    app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'),
    'resources',
    'ingame'
  )
  const overlay = createOverlaySuite({
    settings,
    // Settings › Controls › On-screen keyboard: Windows' touch keyboard (else osk.exe), over any game.
    showKeyboard: () => void showTouchKeyboard().catch(() => undefined),
    library,
    launcher,
    events,
    log: createLogger,
    userData,
    // PlayStation and Switch controllers are read through SDL2: PlayOut's own Ryujinx ships an x64 SDL2.dll.
    sdlCandidates: () => [
      join(dirname(app.getPath('exe')), 'Emulators', 'Ryujinx'),
      join(userData, 'Emulators', 'Ryujinx')
    ],
    preload: join(__dirname, '../preload/index.js'),
    loadOverlay: async (win, extraQuery) => {
      const query: Record<string, string> = {
        overlay: '1',
        ...extraQuery,
        ...(cli.mock ? { mock: '1' } : {})
      }
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        const url = new URL(process.env['ELECTRON_RENDERER_URL'])
        for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
        await win.loadURL(url.toString())
      } else {
        await win.loadFile(join(__dirname, '../renderer/index.html'), { query })
      }
    },
    ingameDir,
    screen,
    mainWindow: {
      hwnd: () => {
        const w = window.get()
        return w ? hwndOf(w.getNativeWindowHandle()) : null
      },
      show: () => {
        window.restore()
        window.focus()
      },
      outOfSight: () => window.isMinimized() || !window.isVisible()
    },
    setPowerMode: (mode) => system.setPowerMode(mode),
    system,
    // RivaTuner is told not to hook PlayOut's own windows (the overlay); a development run is electron.exe.
    selfExe: app.isPackaged ? basename(app.getPath('exe')) : null,
    // The overlay never pauses a game while an anti-cheat service runs (the same check as Enhanced Sleep/Wake below).
    runningImages: () => runningImageNames()
  })
  overlaySuite = overlay

  // Enhanced Sleep/Wake (Settings > System, docs/sleep-wake.md).
  const runningImageNames = async (): Promise<Set<string> | null> => {
    const r = await runProcess('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeoutMs: 10_000 })
    return r.code === 0 ? parseTasklist(r.stdout) : null
  }
  const sleepWake = createSleepWakeService({
    log: createLogger('sleep'),
    userData,
    enabled: () => settings.get().system.enhancedSleepWake,
    gameRunning: () => launcher.running() !== null,
    native: overlay.native,
    isPlayOutWindow: (hwnd) => overlay.isPlayOutWindow(hwnd),
    runningImages: () => runningImageNames(),
    idleState: () => powerMonitor.getSystemIdleState(60),
    runElevatedScript: (script) =>
      runElevated('powershell.exe', compressedPowerShellArgs(script), undefined, { hidden: true })
  })
  sleepWake.start()
  settings.onChange(() => sleepWake.sync())
  // Wake with the Xbox button (Settings > System; main/controller-wake). Off by default.
  const controllerWake = createControllerWakeService({
    log: createLogger('controller-wake'),
    userData,
    enabled: () => settings.get().system.controllerWake,
    probe: () => readWakeDevices(),
    runElevatedScript: (script) =>
      runElevated('powershell.exe', compressedPowerShellArgs(script), undefined, { hidden: true }),
    events
  })
  controllerWake.start()
  settings.onChange(() => controllerWake.sync())
  // Both windows follow settings changes made in the other one (the overlay's music volume, Settings › Controls), at
  // most once per 100 ms so a slider drag does not flood them.
  let settingsChangedTimer: ReturnType<typeof setTimeout> | null = null
  settings.onChange(() => {
    if (settingsChangedTimer) clearTimeout(settingsChangedTimer)
    settingsChangedTimer = setTimeout(() => {
      settingsChangedTimer = null
      events.emit('settings:changed', settings.get())
    }, 100)
  })
  registerMusicProtocol(protocol, {
    folder: () => settings.get().music.folder,
    log: createLogger('music')
  })

  // Co-Op (Nucleus Co-op split-screen): the helper ships unpacked beside the app (resources\coop).
  const coop = createCoopService({
    library,
    settings,
    events,
    launcher,
    userData,
    helperDir: join(
      app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'),
      'resources',
      'coop'
    ),
    log: createLogger('coop')
  })
  coop.kick()

  // PeerParty (LAN play, main/peerparty): downloaded into userDataPeerParty the first time a game is started with it.
  const peerParty = createPeerPartyService({
    library,
    launcher,
    events,
    log: createLogger('peerparty'),
    userData,
    processes: async () => (await launcher.processes?.()) ?? [],
    launchBlocked: (game) => (upgradeBusy(game.id) ? upgradeRunningMessage(tMain) : null),
    openExternal: (url) => shell.openExternal(url)
  })
  // The overlay's PeerParty tab (docs/home-overlay.md, "PeerParty"): read only while the tab is open; the LAN invite
  // goes through PlayOutIngame64.exe's peerparty-invite.
  const peerPartyOverlay = createPeerPartyOverlay({
    log: createLogger('peerparty'),
    session: () => peerParty.session(),
    overlayState: () => overlay.overlayState(),
    dataDir: join(userData, PEERPARTY_FOLDER, DATA_DIR_NAME),
    helper: createIngameHelper({ log: createLogger('peerparty'), dir: ingameDir }),
    whileGameRuns: (work) => overlay.whileGameRuns(work)
  })
  // The handler pack is needed for the Nucleus Co-Op filter and badges: fetched by itself when missing, then weekly.
  if (!cli.mock) coop.startAutoDownload()

  // Recompilations (ARCHITECTURE.md §4.14): the catalogs load ~20 s after start and then daily; the start-up update
  // check of installed recompilations runs right after, then the ones set to update automatically are updated.
  const recompDialog = async (options: Electron.OpenDialogOptions): Promise<string | null> => {
    const owner = window.get()
    const picked = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    return picked.canceled || !picked.filePaths[0] ? null : picked.filePaths[0]
  }
  // Xbox / Xbox 360 conversions (Convert, Trim Games): PlayOut's own helper, unpacked beside the app (resources\xbox).
  // Streaming also reads CHD games' serials with it (their texture packs go with a download), and recompilation
  // setup programs that take the game unpacked get the player's disc image unpacked with it.
  const xboxHelper = join(
    app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'),
    'resources',
    'xbox',
    HELPER_EXE
  )
  const recomp = createRecompService({
    userData,
    xboxHelper,
    exeDir: resolvePaths().exeDir,
    library,
    launcher,
    events,
    documents: app.getPath('documents'),
    // Save copies go to <Emulation folder>/Recompilations Saves (it follows Settings › Library's Emulation folder).
    emulationDir: () => emulationDirOf(settings.get(), userData),
    // The start-up catalog check (new recompilations) waits until the PC is online.
    isOnline: () => net.isOnline(),
    // An installed recompilation whose game is not in the library becomes a game of its own (and leaves with it).
    recompGames: {
      add: ({ titleKey, title, platformId, recomp: info, art }) => {
        const known = new Set(library.platforms().map((p) => p.id))
        const fresh = emulation.platformsForSystems([platformId]).filter((p) => !known.has(p.id))
        if (fresh.length) library.registerPlatforms(fresh)
        const game = library.addRecompGame({ titleKey, title, platformId, recomp: info })
        if (!game) return null
        // Its art from the recompilation's catalog entries first; the scrapers fill the rest (as a scan's new game).
        const seeds = (['cover', 'hero', 'icon'] as const)
          .filter((kind) => !!art[kind])
          .map((kind) => ({ gameId: game.id, kind, url: art[kind]! }))
        metadata.enqueue([game.id], {
          seeds,
          coverOnly: !settings.get().scrapers.autoScrape
        })
        return game.id
      },
      remove: (gameId) => {
        library.removeGame(gameId)
        void imageCache.remove(gameId).catch(() => undefined)
      },
      absorb: (fromId, intoId) => {
        if (library.absorbGame(fromId, intoId))
          void imageCache.remove(fromId).catch(() => undefined)
      },
      // The browser's Add to library: the recompilation's own card, with the catalog's art.
      addEntry: ({ art, platformId, ...input }) => {
        const known = new Set(library.platforms().map((p) => p.id))
        const fresh = emulation.platformsForSystems([platformId]).filter((p) => !known.has(p.id))
        if (fresh.length) library.registerPlatforms(fresh)
        const game = library.addRecompEntryGame({ ...input, platformId })
        const seeds = (['cover', 'hero', 'icon'] as const)
          .filter((kind) => !!art[kind])
          .map((kind) => ({ gameId: game.id, kind, url: art[kind]! }))
        if (seeds.length) metadata.enqueue([game.id], { seeds, coverOnly: true })
        return game.id
      },
      // A recompilation favourited in the browser: its card follows (as the user's own favourite).
      setFavorite: (gameId, favorite) => {
        library.updateGame(gameId, { favorite }, { byUser: true })
      }
    },
    dialog: {
      chooseFile: ({ title, filters, defaultPath }) =>
        recompDialog({
          title,
          ...(filters ? { filters } : {}),
          ...(defaultPath ? { defaultPath } : {}),
          properties: ['openFile']
        }),
      chooseFolder: (title) => recompDialog({ title, properties: ['openDirectory'] })
    },
    openPath: async (path) => {
      const failure = await shell.openPath(path)
      if (failure) throw new Error(failure)
    },
    // "Delete the original disc image?": the file work and its guards are Delete from this PC's (set up below).
    originalImage: {
      plan: (gameId, options) => localDelete.imagePlan(gameId, options),
      trash: (gameId, recompId, options) => localDelete.trashImage(gameId, recompId, options),
      // The game folder PlayOut unpacked for a setup program ("Delete the unpacked game folder").
      folderPlan: (dir) => localDelete.unpackedFolderPlan(dir),
      trashFolder: (dir) => localDelete.trashUnpackedFolder(dir),
      // Delete moves them aside first while the recompilation is started to check it runs without them.
      hold: (gameId, recompId, holdId, options) =>
        localDelete.holdImage(gameId, recompId, holdId, options),
      holdFolder: (dir, holdId, options) => localDelete.holdUnpackedFolder(dir, holdId, options),
      release: (entries, holdId) => localDelete.releaseHeld(entries, holdId),
      restore: (entries, holdId, card) => localDelete.restoreHeld(entries, holdId, card)
    },
    log: createLogger('recomp')
  })
  recompDirOf = (id) => recomp.installedDir(id)
  recomp.start()
  // A recompilation's own card (the browser's Add to library) favourited or not in the library: the browser follows.
  library.onUserFavorite((id) => recomp.noteLibraryFavorite(id))

  // VR mods (Settings › VR): the bundled VR mod list; downloads go to the "VR Mods" folder beside Recompilations.
  const vrMods = createVrModsService({
    userData,
    root: async () => join(dirname(await recomp.installRoot()), VR_MODS_FOLDER),
    catalogFile: join(
      app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'),
      'resources',
      'vr',
      'vr-mods.json'
    ),
    events,
    openPath: async (path) => {
      const failure = await shell.openPath(path)
      if (failure) throw new Error(failure)
    },
    log: createLogger('vr-mods')
  })

  // PS3 game updates (Sony's update list, installed through RPCS3 into Updates and DLCPS3dev_hdd0).
  const ps3Updates = createPs3UpdateService({
    library,
    romsRoot: () => settings.get().library.romsRoot,
    emulationDir: () => emulationDirOf(settings.get(), userData),
    rpcs3Exe: async () =>
      (await emulation.emulators()).find((e) => e.id === 'RPCS3')?.path ??
      emulatorSetup.managedExe('RPCS3'),
    rpcs3Running: async () => {
      const images = await runningImageNames().catch(() => null)
      // Unknown: treated as running, so nothing is installed under it.
      return images === null || images.has('rpcs3.exe')
    },
    autoUpdate: () => settings.get().emulators.ps3AutoUpdate,
    // No downloads or installs while a game PlayOut started is being played.
    gameRunning: () => launcher.running() !== null,
    isOnline: () => net.isOnline(),
    cacheDir: join(userData, 'cache', 'ps3-updates'),
    events,
    run: runProcess,
    log: createLogger('ps3-updates')
  })
  if (!cli.mock) ps3Updates.start()

  // The install queue (ARCHITECTURE.md §4.8): one download at a time, store installs and ROM downloads from another
  // PC alike. Both register their runner when created; it starts moving after the start-up scan (begin, below).
  const installQueue = createInstallQueue({
    stateFile: join(userData, 'installs', 'queue.json'),
    events,
    log: createLogger('install-queue')
  })

  // Streaming (ARCHITECTURE.md §4.13): this PC as host (Sunshine, port forwarding, pairing) and as client
  // (paired hosts' games, Moonlight, ROM downloads). Started with the deferred start-up work below.
  // Set once the favourites list's service exists (further down); the streaming service only calls it later.
  let favoritesBackupRef: FavoritesBackup | null = null
  const streaming = createStreamingService({
    settings,
    library,
    recompFor: (game) => recomp.recompForGame(game),
    // A client's stream of a card kept for its recompilation (its disc image is in the Recycle Bin) starts the recompilation.
    launchKept: async (game) => {
      const started = await recomp.launchRecomp(game.id, game.romRemoved?.recompId)
      if (started.ok) return { ok: true }
      return {
        ok: false,
        message:
          'message' in started
            ? started.message
            : started.reason === 'needs-files'
              ? tMain('mainApp.recomp.needsFiles')
              : started.reason === 'choose-exe'
                ? tMain('mainApp.recomp.chooseExe')
                : tMain('mainApp.recomp.saveConflict')
      }
    },
    firstStart,
    // A paired host's metadata and RetroAchievements logins fill the ones this PC has none of (streaming/host-logins.ts).
    fillLogins: (patch) => settings.update({ scrapers: patch }),
    // The Library tabs, kept the same on the paired PCs (streaming/library-tabs-sync.ts): the newest change wins.
    libraryTabs: {
      file: join(userData, 'library-tabs-sync.json'),
      apply: (tabs) => settings.update({ ui: { libraryTabs: tabs } })
    },
    // The play time, added up on the paired PCs (streaming/playtime-sync.ts): their sessions of shared games.
    playtime: { file: join(userData, 'playtime-sync.json') },
    // A paired client's host-only game shows this PC's achievements of it (streaming/host-achievements.ts).
    achievements,
    launcher,
    scan,
    emulationDir: () => emulationDirOf(settings.get(), userData),
    // Another PC's favourites list arrived (or went) with the Emulation folder sync: read again now, not at the next scan.
    onEmulationFilesChanged: (paths) => {
      if (paths.some(isFavoritesFilePath)) favoritesBackupRef?.noteLibraryChanged(true)
    },
    // A CHD game's serial (for its texture packs) is read through the Xbox helper's `read`.
    readChd: (path, offset, length) => chdRead(xboxHelper, path, offset, length),
    // A game this PC shares with a host gets what it lacks from the host's copy: no internet lookup for it.
    importFromHost: async (gameId, { metadata, art }) => {
      const media: {
        cover?: string
        hero?: string
        logo?: string
        icon?: string
        screenshots?: string[]
      } = {}
      const shots: { index: number; url: string }[] = []
      for (const a of art) {
        // Looked at again right before each copy: the metadata pipeline (or the user) may have set it meanwhile, and
        // its file must not be written over.
        const now = library.getGame(gameId)
        if (!now) return
        const taken =
          a.kind === 'screenshot'
            ? !!now.media.screenshots?.length
            : !!now.media[a.kind] || !!now.user.customMedia?.[a.kind]
        if (taken) continue
        const url = await imageCache.importHostCopy(gameId, a.kind, a.file, a.index)
        if (!url) continue
        if (a.kind === 'screenshot') shots.push({ index: a.index ?? shots.length, url })
        else media[a.kind] = url
      }
      if (shots.length)
        media.screenshots = shots.sort((x, y) => x.index - y.index).map((s) => s.url)
      const current = library.getGame(gameId)
      if (!current) return
      // The host's match ids only where this PC still has none (its own ids always win).
      const sources = Object.fromEntries(
        Object.entries(metadata.sources ?? {}).filter(([key]) => !current.metadata.sources?.[key])
      )
      library.applyMetadata(
        gameId,
        { metadata: { ...metadata, sources }, media },
        { overwrite: false }
      )
    },
    // Systems only the hosts have ROMs for: registered (as a ROM scan would), so Filters › Platform lists them.
    registerSystemPlatforms: (systemIds) => {
      const known = new Set(library.platforms().map((p) => p.id))
      const fresh = emulation.platformsForSystems(systemIds).filter((p) => !known.has(p.id))
      if (!fresh.length) return
      library.registerPlatforms(fresh)
      events.emit('library:changed', { reason: 'scan' })
    },
    // Diagnostics and tests: never ask the router to forward ports (hosting then works as "same network only").
    io:
      process.env['PLAYOUT_STREAMING_NO_UPNP'] === '1'
        ? { upnp: { discover: async () => null } }
        : undefined,
    events,
    log: createLogger('streaming'),
    dataDir: join(userData, 'streaming'),
    installQueue,
    firewall:
      process.platform === 'win32'
        ? createHostFirewall({
            exe: process.execPath,
            stateFile: join(userData, 'streaming', 'firewall.json'),
            log: createLogger('firewall'),
            runScript: (script) =>
              runProcess('powershell.exe', compressedPowerShellArgs(script), { timeoutMs: 60_000 }),
            runElevatedScript: (script) =>
              runElevated('powershell.exe', compressedPowerShellArgs(script), undefined, {
                hidden: true
              })
          })
        : undefined,
    appVersion: app.getVersion(),
    // The running exe, also for the portable build (its unpacked copy): Sunshine only runs while this PlayOut does, and
    // apps.json is written again at every host start. The portable stub would unpack the whole app per stream and,
    // killed with the stream, leave that copy in %TEMP%. startPlayOut (a fresh PlayOut) still uses the stub.
    // A custom --user-data-dir goes along, so the launch process reads this PlayOut's token file.
    appCommand:
      (app.isPackaged
        ? `"${process.execPath}" ${STREAM_LAUNCH_FLAG}`
        : `"${process.execPath}" "${app.getAppPath()}" ${STREAM_LAUNCH_FLAG}`) +
      (process.argv.some((a) => a.startsWith('--user-data-dir='))
        ? ` "--user-data-dir=${app.getPath('userData')}"`
        : ''),
    pipeName: streamLaunchPipeName(),
    launchTokenFile: streamLaunchTokenFile,
    window,
    screenSize: () => {
      const display = screen.getPrimaryDisplay()
      return {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor)
      }
    },
    mediaFile: (url) => {
      try {
        return imageCache.resolve(new URL(url).pathname)
      } catch {
        return null
      }
    }
  })
  remoteMedia = (hostId, hostGameId, kind, rev) =>
    streaming.remoteMedia(hostId, hostGameId, kind, rev)

  // Store accounts and the install tracker (ARCHITECTURE.md 4.8): after the scan service and the main window.
  // The accounts service asks the install service (created right after it) which games it is tracking.
  let trackedInstalls: () => string[] = () => []
  // Steam's hidden games are matched against the library, so the sync follows anything that can add games.
  const syncSteamHidden = (): Promise<void> =>
    readSteamHiddenApps()
      .then((hidden) => {
        if (!hidden) return
        const changed = library.syncStoreHidden('steam', new Set([...hidden].map(String)))
        if (changed) log.info(`steam: ${changed} game(s) changed hidden state`)
      })
      .catch((err) => log.warn('steam: hidden games sync failed', err))
  // GOG: hidden in Galaxy or in the gog.com library (flagged by the account import). When Galaxy's answer is
  // unknown, gogHiddenIds keeps every store-hidden game hidden and applies the gog.com flags only.
  const syncGogHidden = (): Promise<void> =>
    readGalaxyHiddenGogIds()
      .then((galaxy) => {
        const changed = library.syncStoreHidden('gog', gogHiddenIds(galaxy, library.games()))
        if (changed) log.info(`gog: ${changed} game(s) changed hidden state`)
      })
      .catch((err) => log.warn('gog: hidden games sync failed', err))
  const accounts = await createAccountsService({
    settings,
    library,
    events,
    metadata,
    window,
    userData,
    resourcesDir,
    log: createLogger('accounts'),
    // logs/store-import.log: each HTTP attempt of an owned-library import (no keys or tokens) and its outcome.
    importTrace: createDiagLog(join(userData, 'logs', 'store-import.log')),
    trackedInstalls: () => trackedInstalls(),
    onSignedOut: (source) => {
      if (source === 'steam') achievements.steamSignedOut()
    },
    onOwnedImported: (source) => {
      // Signing in to Steam imports the owned list, so this also fills achievements right after a sign-in.
      // New owned games that are not installed: their sizes, for the Library's size sort and filter.
      void installSizes.fillStoreSizes()
      if (source === 'steam') {
        void syncSteamHidden()
        void achievements.syncSteam()
      }
      if (source === 'gog') void syncGogHidden()
    }
  })
  const installs = createInstallService({
    library,
    accounts,
    scan,
    events,
    log: createLogger('installs'),
    queue: installQueue
  })
  trackedInstalls = () => installs.trackedGameIds()
  // Steam DLC: the install-time picker and Manage DLC (main/steam-dlc). A choice made before the install is applied
  // once the game is installed (Steam closed and opened again).
  const steamDlc = createSteamDlcService({
    library,
    events,
    log: createLogger('steam-dlc'),
    plansFile: join(userData, 'steam-dlc-plans.json'),
    gameRunning: () => launcher.running() !== null,
    openExternal: (uri) => shell.openExternal(uri),
    ownedApps: () => accounts.steamOwnedApps(),
    installActive: () => installs.trackedGameIds()
  })
  steamDlc.start()
  // Upgrades (the game page's Upgrade menu, main/upgrades): tools and files go to the Upgrades folder beside
  // PlayOut.exe (kept by the installer), per-game facts to userData\upgrades.json. PowerShell: a worker for
  // the quick checks (graphics card, drive, signatures) and a small pool for measuring game folders (minutes each).
  const upgradesLog = createLogger('upgrades')
  const upgradesHttp = (
    signal?: AbortSignal
  ): { log: typeof upgradesLog; signal?: AbortSignal } => ({
    log: upgradesLog,
    ...(signal ? { signal } : {})
  })
  const upgradesPs = createPsWorker({ log: upgradesLog })
  // Folder measures each get a PowerShell of their own (up to three at once), so one huge game never makes another
  // game's measure wait behind it.
  const upgradesMeasurePs = createPsPool({
    size: 3,
    create: () => createPsWorker({ log: upgradesLog })
  })
  const upgrades = createUpgradesService({
    library,
    isGameRunning: (gameId) => launcher.running()?.gameId === gameId,
    events,
    log: upgradesLog,
    paths: {
      upgradesDir: upgradesDirBeside(resolvePaths().exeDir),
      fallbackUpgradesDir: join(userData, UPGRADES_FOLDER),
      factsFile: join(userData, 'upgrades.json')
    },
    http: {
      fetchJson: (url) => fetchJson(url, upgradesHttp()),
      fetchText: (url) => fetchText(url, upgradesHttp()),
      download: (d, dir, signal) => downloadFile(d, dir, upgradesHttp(signal))
    },
    powershell: upgradesPs,
    measurePowershell: upgradesMeasurePs,
    archive: {
      extract: (file, destDir, toolsDir) =>
        extractArchive(file, destDir, {
          sevenZip: () => ensureSevenZip(toolsDir, upgradesHttp()),
          run: runProcess,
          log: upgradesLog
        })
    },
    spawnTool,
    spawnDetached,
    spawnCompact,
    verifySigner: (path, signer, company) => verifySigner(upgradesPs, path, signer, company),
    isProcessRunning: async (imageName) => {
      const images = await runningImageNames().catch(() => null)
      // Unknown: treated as running, so the app's library is left alone.
      return images === null || images.has(imageName.toLowerCase())
    }
  })
  upgradeBusy = (gameId) => upgrades.busyFor(gameId) !== null
  // Epic games are sized from Epic's own build manifests while Epic is signed in.
  installSizes.useEpicAccount((refresh) => accounts.epicAccessToken(refresh))
  achievements.useSteamAccount(async (refresh) => {
    const tokens = await accounts.steamCredential(refresh)
    if (!tokens) return null
    return tokens.kind === 'web'
      ? { steamId64: tokens.steamId64, accessToken: tokens.webapiToken }
      : { steamId64: tokens.steamId64, key: tokens.apiKey }
  })
  // The greyed cards follow the account: every user-initiated installed scan of a signed-in store re-imports its
  // owned list (the tracker's confirming scans run as `reason: 'confirm'` and never reach this listener).
  // A game installed (or reinstalled) while PlayOut runs is confirmed by a scan that never reaches onSourceScanned:
  // every scan that changed the library sizes whatever has no current size (the others are skipped at no cost).
  events.on('library:changed', ({ reason }) => {
    if (reason === 'scan') {
      void installSizes.measure()
      emulatorSetup.prewarmPcsx2()
    }
    if (reason !== 'session' && reason !== 'remove') {
      ratings.kick()
      localPlayers.kick()
      steamTags.kick()
      steamScreenshots.kick()
      coop.kick()
      recomp.kick()
      ps3Updates.kick()
    }
  })
  scan.onSourceScanned((id) => {
    // A scan finds new installs and moved folders; only that source's games are measured again.
    void installSizes.measure(
      library
        .games()
        .filter((g) => g.source === id)
        .map((g) => g.id)
    )
    if (id === 'rom') void achievements.syncRetro()
    if (id === 'manual' || id === 'rom') return
    if (id === 'steam') void syncSteamHidden()
    if (id === 'gog') void syncGogHidden()
    accounts.importOwned([id]).catch((err) => log.warn(`${id}: owned import failed`, err))
  })

  const updates = createUpdateService({
    events,
    log: createLogger('updates'),
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    portable: Boolean(process.env['PORTABLE_EXECUTABLE_FILE']),
    updater: () => autoUpdater
  })

  const convert = createConvertService({
    toolRoot: join(userData, 'tools', 'game-format-converter'),
    workDir: join(userData, 'tools', 'convert-work'),
    emulationDir: () => emulationDirOf(settings.get(), userData),
    emulatorPath: async (id) =>
      (await emulation.emulators()).find((e) => e.id === id)?.path ?? null,
    library,
    romExtensions: (systemId) => {
      const system = emulation.findSystem(systemId)
      return system
        ? [...system.extensions, ...(system.dirExtensions ?? [])].map((e) => e.toLowerCase())
        : null
    },
    imageCache,
    trash: (path) => shell.trashItem(path),
    rescanRoms: async () => {
      await scan.run(['rom'])
    },
    emit: (status) => events.emit('convert:progress', status),
    xboxHelper,
    // PS5 packages: PlayOut's PS5 package helper (PS5PKGTool's extraction), unpacked beside the app like the Xbox one.
    ps5Helper: join(
      app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'),
      'resources',
      'ps5pkg',
      'PlayOutPs5Pkg.exe'
    ),
    log: createLogger('convert')
  })

  // Trim Games (Settings › Library): new ROM games go through Convert's runs, one direction at a time.
  const autoTrim = createAutoTrimService({
    enabled: () => settings.get().library.trimGames,
    library,
    convert,
    waitReason: () => {
      if (launcher.running()) return tMain('mainApp.trimWait.gameRunning')
      if (installQueue.list().some((e) => e.kind === 'host-rom' && e.state === 'active'))
        return tMain('mainApp.trimWait.romDownloading')
      return null
    },
    events,
    xboxInfo: helperXboxInfo(xboxHelper),
    stateFile: join(userData, 'trim-games.json'),
    log: createLogger('trim')
  })
  // What an Xbox helper run killed with PlayOut left (`*.playout-partial*` only) in the Xbox and Xbox 360 ROM folders.
  void (async () => {
    const romsRoot = settings.get().library.romsRoot
    if (!romsRoot) return
    const folders = (await fs.readdir(romsRoot, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .filter((e) => {
        const system = emulation.findSystemForFolder(e.name)?.id
        return system === 'xbox' || system === 'xbox360'
      })
      .map((e) => join(romsRoot, e.name))
    for (const path of await sweepPartials(folders))
      log.info(`Removed an unfinished Xbox conversion: ${path}`)
  })().catch((err) => log.warn('Unfinished Xbox conversions not removed', err))
  scan.onNewGames((id, gameIds) => {
    if (id === 'rom') autoTrim.add(gameIds)
  })
  // What every Convert run makes (the user's own runs too, such as an RVZ turned back into an ISO) is never trimmed back.
  events.on('convert:progress', (status) => autoTrim.noteConvertStatus(status))
  // Switched on (not at start-up): the ROM games already in the library are looked at once.
  let trimOn = settings.get().library.trimGames
  settings.onChange((next) => {
    const on = next.library.trimGames
    if (on && !trimOn) autoTrim.checkLibrary()
    trimOn = on
  })
  // A ROM downloaded from a paired PC keeps the host's file: that file name is how the two PCs know it is one game.
  events.on('streaming:download', (p) => {
    if (p.state === 'done' && p.installedGameId) autoTrim.markHostDownload(p.installedGameId)
  })

  // "Delete from this PC": ROM files / a manual game's folder to the Recycle Bin, or the store's own uninstall.
  const localDelete = createLocalDeleteService({
    library,
    imageCache,
    romsRoot: () => settings.get().library.romsRoot,
    // A PS3 / Switch / Xbox 360 game's updates and DLC in its Updates and DLC folder go with it (when asked).
    emulationDir: () => emulationDirOf(settings.get(), userData),
    appFolders: () =>
      [
        dirname(app.getPath('exe')),
        userData,
        settings.get().library.romsRoot ?? '',
        emulationDirOf(settings.get(), userData)
      ].filter(Boolean),
    keepFolders: () => {
      const emu = emulationDirOf(settings.get(), userData)
      return ['saves', 'states', 'storage', 'bios'].map((d) => join(emu, d))
    },
    running: () => launcher.running(),
    busyIds: () => [...installQueue.list().map((e) => e.gameId), ...installs.trackedGameIds()],
    convertRunning: async () => (await convert.status()).running,
    upgradeRunning: (gameId) => upgrades.busyFor(gameId) !== null,
    // A ROM a paired PC is downloading from this one is never moved meanwhile.
    filesBeingSent: () => streaming.filesBeingSent?.() ?? [],
    storeName: (source) => accounts.account(source).storeName,
    client: (source) => scan.client(source),
    rescan: (source) => scan.run([source]),
    log: createLogger('local-delete')
  })

  // Moving the Emulation folder (Settings › Library): never into PlayOut's install folder (this one, the folders it ran
  // from before, the pre-0.9.21 default) or its data folder. The installer records this exeDir as InstallDir.
  const emulationMove = createEmulationMoveService({
    settings,
    userData,
    documents: app.getPath('documents'),
    forbidden: () =>
      forbiddenRoots({
        exeDir: installed ? exeDirNow : null,
        localAppData: process.env['LOCALAPPDATA'] ?? join(app.getPath('home'), 'AppData', 'Local'),
        userData
      }).concat(
        installed ? installMove.rebaseFrom.map((path) => ({ path, kind: 'install' as const })) : []
      ),
    busy: async (from) => {
      if (launcher.running()) return tMain('mainEmulationMove.busy.game')
      if ((await emulatorSetup.status()).progress.total > 0)
        return tMain('mainEmulationMove.busy.setup')
      if ((await convert.status()).running) return tMain('mainEmulationMove.busy.convert')
      if ((streaming.filesBeingSent?.() ?? []).some((p) => isSameOrInside(from, p)))
        return tMain('mainEmulationMove.busy.sending')
      const emulators = (await emulatorSetup.runningEmulators?.()) ?? []
      if (emulators.length)
        return tMain('mainEmulationMove.busy.emulator', { names: emulators.join(', ') })
      return null
    },
    holdSync: () => streaming.holdEmulationSync?.() ?? (() => {}),
    // The saves' last-synced hashes moved with the copies (a folder chosen without moving forgets them).
    beforeSwitch: (from, to) => recomp.noteEmulationFolderMoved(from, to),
    afterSwitch: async (from, to) => {
      // Folders the new place lacks (a folder used as it is); the emulators are pointed at it by the emulator setup's
      // own settings watcher (configs, junctions, BIOS links), the ROM folder by keepRomsRootInSync.
      await generateFoldersAt(
        'emulation',
        to,
        emulation.systems().map((system) => system.id)
      ).catch((err) => log.warn('Emulation folders could not be completed', err))
      // Other paths saved inside the old folder follow, when the moved one exists.
      const s = settings.get()
      const moved = (path: string | null | undefined): string | null => {
        if (!path) return null
        const next = rebasePath(path, from, to)
        return next && existsSync(next) ? next : null
      }
      const overrides: Record<string, string> = {}
      let overridesChanged = false
      for (const [id, path] of Object.entries(s.emulators.overrides)) {
        const next = moved(path)
        overrides[id] = next ?? path
        if (next) overridesChanged = true
      }
      const esdeHome = moved(s.library.esdeHome)
      const coresDir = moved(s.emulators.coresDir)
      const music = moved(s.music.folder)
      if (esdeHome || coresDir || music || overridesChanged)
        settings.update({
          ...(esdeHome ? { library: { esdeHome } } : {}),
          ...(overridesChanged || coresDir
            ? {
                emulators: {
                  ...(overridesChanged ? { overrides } : {}),
                  ...(coresDir ? { coresDir } : {})
                }
              }
            : {}),
          ...(music ? { music: { folder: music } } : {})
        })
    },
    emit: (progress) => events.emit('emulation-move:progress', progress),
    log: createLogger('emulation-move')
  })

  // The favourites list in the Emulation folder (<Emulation>\PlayOut\Favorites\<PC>.json): favourites come back after
  // a reinstall, and ride the Emulation folder sync to paired PCs.
  const favoritesBackup = createFavoritesBackup({
    library,
    emulationDir: () => emulationDirOf(settings.get(), userData),
    pc: hostname(),
    readOthers: () => settings.get().streaming.syncFavorites,
    // Not while the Emulation folder is being moved: written to the new place once it stands there.
    paused: () => emulationMove.moving(),
    log: createLogger('favorites-file')
  })
  favoritesBackupRef = favoritesBackup

  // The overlay's Friends tab (docs/home-overlay.md, "Friends"): read only while the tab is open; Message opens Steam.
  const friends = createFriendsService({
    settings: () => settings.get(),
    log: createLogger('friends'),
    closeOverlay: () => overlay.closeForOutsideWindow(),
    openExternal: (uri) => shell.openExternal(uri)
  })

  // A move of the Emulation folder that PlayOut closed during is finished or undone before anything can start a new one:
  // started before the window can ask (moving() is true meanwhile: a move, the offer and launches wait or refuse).
  const emulationRecovered = cli.mock
    ? Promise.resolve()
    : emulationMove.recover().catch((err) => log.warn('Emulation folder move recovery failed', err))

  registerIpc(
    createHandlers({
      emulationMove,
      controllerWake,
      metadataCloud: metadataCloudService,
      localDelete,
      steamDlc,
      upgrades,
      storageDrives: () => listFixedDrives(upgradesPs),
      ps3Updates,
      convert,
      settings,
      library,
      providers,
      scan,
      emulation,
      emulatorSetup,
      launcher,
      metadata,
      imageCache,
      steamScreenshots,
      system,
      coop,
      peerParty,
      peerPartyOverlay,
      recomp,
      vrMods,
      streaming,
      overlay,
      friends,
      accounts,
      achievements,
      installSizes,
      installs,
      updates,
      events,
      log: createLogger('ipc'),
      window,
      exitApp: () => closeToTray.exit(),
      showTouchKeyboard
    })
  )

  const startSystemPolling = (): void =>
    system.start((status) => events.emit('system:status', status))
  startSystemPolling()
  // No PowerShell probes while the machine sleeps; a fresh status right after it wakes up. Install watches pause
  // too, without the sleep counting towards their timeout.
  // The game freezes first: Windows gives the suspend notification only a moment. On Modern Standby PCs the power
  // button locks the screen before Windows reports sleep, so the lock freezes it too (and the unlock thaws it).
  powerMonitor.on('lock-screen', () => void sleepWake.onSleep())
  powerMonitor.on('unlock-screen', () => void sleepWake.onUnlock())
  powerMonitor.on('suspend', () => {
    void sleepWake.onSleep()
    system.stop()
    installs.pause()
    // Hosting closes its listeners, port forwarding and Sunshine; the network is gone while asleep anyway.
    streaming.suspend()
    overlay.suspend()
  })
  powerMonitor.on('resume', () => {
    void sleepWake.onWake()
    startSystemPolling()
    installs.resume()
    streaming.resume()
    // The controller reader starts again and the power limits are written again (sleep resets them).
    overlay.resume()
  })

  app.on('second-instance', () => closeToTray.show())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) window.focus()
  })
  app.on('window-all-closed', () => app.quit())
  // The hidden overlay window keeps 'window-all-closed' from firing: the main window closing for good is the quit.
  mainBrowserWindow?.on('closed', () => app.quit())
  app.on('will-quit', () => closeToTray.dispose())

  let quitting = false
  app.on('before-quit', (event) => {
    // A real quit (tray Quit, an update install, Exit with Minimize to tray off): the window closes from now on.
    closeToTray.markQuitting()
    if (quitting) return
    quitting = true
    event.preventDefault()
    launcher.dispose()
    // The queue first: the watch and the download ending below must not move it on, so the next run resumes them.
    const queueSaved = installQueue.dispose()
    installs.dispose()
    system.stop()
    metadata.dispose()
    ratings.dispose()
    localPlayers.dispose()
    coop.dispose()
    peerParty.dispose()
    recomp.dispose()
    vrMods.dispose()
    ps3Updates.dispose()
    autoTrim.dispose()
    // A move of the Emulation folder under way stops (a copy is undone; a rename switches or goes back) and is waited
    // for below; one cut short anyway is finished or undone at the next start (its journal).
    emulationMove.cancel()
    // A conversion running stops, and none starts any more (one still being checked never runs): the Xbox helper (or converter) is killed and its unfinished output removed, the
    // original left as it was (bounded, awaited below).
    const convertStopped = convert.close()
    // A background PCSX2 game list scan closes PCSX2 and puts its settings back (bounded, awaited below).
    const emulatorSetupStopped = emulatorSetup.dispose()
    steamTags.dispose()
    steamScreenshots.dispose()
    achievements.dispose()
    // Each save on the way out is traced: a file that is not saved at closing shows here, with how far it got.
    diag.line('closing: saving settings, library, sessions, accounts and sizes')
    // Every step has a time limit and none rejects: one that fails or never settles is traced and logged, and
    // PlayOut still closes.
    const saved = (
      name: string,
      task: Promise<unknown>,
      ms = CLOSE_STEP_TIMEOUT_MS
    ): Promise<void> =>
      bounded(task, ms).then((result) => {
        if (result.outcome === 'done') {
          diag.line(`closing: ${name} saved`)
          return
        }
        const why =
          result.outcome === 'timed out'
            ? `timed out after ${ms / 1000} s`
            : `failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`
        diag.line(`closing: ${name} ${why}`)
        log.error(`closing: ${name} ${why}`)
      })
    // A store file whose write failed is traced as failed, not as saved (tryFlush resolves false, never rejects).
    const saveStores = (pass: string): Promise<void[]> =>
      Promise.all(
        Object.entries(savedStores).map(([name, store]) =>
          saved(
            name + pass,
            store.tryFlush().then((written) => {
              if (!written) throw new Error('the file could not be written')
            }),
            CLOSE_SAVE_TIMEOUT_MS
          )
        )
      )
    void Promise.all([
      // Right away, so a service that is slow to stop below does not hold what is already known back.
      saveStores(''),
      saved('metadata cloud', metadataCloudService.dispose()),
      saved('game database', gameDatabase.dispose()),
      saved('accounts', accounts.dispose()),
      saved('sizes', installSizes.dispose()),
      saved('steam dlc plans', steamDlc.dispose()),
      // The favourites list in the Emulation folder, with the last changes (mock runs never wrote one).
      saved(
        'favourites file',
        cli.mock ? Promise.resolve() : favoritesBackup.flush().then(() => favoritesBackup.dispose())
      ),
      // The PowerShell hosts close after it, also when it ran out of time.
      saved('upgrades', upgrades.dispose()).then(() => {
        upgradesPs.dispose()
        upgradesMeasurePs.dispose()
      }),
      saved('install queue', queueSaved),
      saved('emulator setup', emulatorSetupStopped),
      saved('conversion', convertStopped),
      saved('emulation folder move', emulationMove.idle(), 30000),
      // Stops the controller reader and puts the power settings back as they were before PlayOut changed them.
      // A game frozen for sleep runs again first (through the overlay's native host, closed right after).
      saved(
        'overlay',
        sleepWake
          .dispose()
          .catch(() => undefined)
          .then(() => overlay.dispose())
      ),
      // Closes the host service and Sunshine and removes the router's port forwarding; never holds the exit long.
      saved('streaming', streaming.dispose(), 5000)
    ])
      // Last, and awaited: whatever the services above changed while stopping (a session ended, a setting put back).
      .then(() => saveStores(' (after the services stopped)'))
      .catch((err) => log.error('flush failed', err))
      .finally(() => app.quit())
  })

  await window.whenLoaded()

  // PlayOut's own Emulation folder (keys and BIOS files for Convert, its roms folder the ROM folder), unless one is
  // chosen: made before any ROM scan (--scan-report's too), which would otherwise find no ROM folder on a new install.
  // A move of the Emulation folder that PlayOut closed during is finished or undone first.
  await emulationRecovered
  if (!cli.mock)
    await ensureDefaultEmulationDir({
      settings,
      userData,
      systemIds: emulation.systems().map((system) => system.id),
      log: createLogger('emulation-dir'),
      documentsDefault: documentsEmulation
    })
  // Favourites from the Emulation folder's list (a reinstall: back as the games come back), then the list written.
  if (!cli.mock) {
    void favoritesBackup.start()
    // Only changes that can touch a favourite (a toggle, games added or removed); metadata and play sessions cannot.
    events.on('library:changed', (change) => {
      if (change.reason === 'metadata' || change.reason === 'session') return
      favoritesBackup.noteLibraryChanged(change.reason === 'scan' || change.reason === 'import')
    })
    let lastEmulationDir = emulationDirOf(settings.get(), userData)
    settings.onChange((next) => {
      const dir = emulationDirOf(next, userData)
      if (dir === lastEmulationDir) return
      lastEmulationDir = dir
      favoritesBackup.noteLibraryChanged(true)
    })
  }

  if (cli.scanReport) {
    await writeScanReport(scan, library, events, cli.scanReport, log)
    if (!cli.screenshot) {
      app.quit()
      return
    }
  }

  if (cli.screenshot) {
    await takeScreenshot(window.get(), cli.screenshot)
    app.quit()
    return
  }

  void syncSteamHidden()
  void syncGogHidden()
  // ROM counts from RetroAchievements; Steam's follow the owned import below (or the rescan's).
  void achievements.syncRetro()

  // Refresh installed games in the background for sources that already have games, then the owned lists of the
  // signed-in store accounts the rescan did not cover (the per-source import after each scan handles the rest, so
  // no store is imported twice at startup). The ROM folder is always among them while one is set (startupScanSources).
  // (PlayOut's own Emulation folder, with the roms folder the ROM scan reads, was made above, before --scan-report.)
  // First-time emulator setup (until every emulator is installed), then the folder settings and BIOS links: in the
  // background. A mock run never downloads anything, and a dev run (its root would be node_modules\electron\dist)
  // only with PLAYOUT_EMULATOR_SETUP=1; Settings > Emulators can still install by hand.
  if (!cli.mock && (app.isPackaged || process.env.PLAYOUT_EMULATOR_SETUP === '1'))
    void emulatorSetup.startup()
  const sourcesWithGames = startupScanSources(library.games(), settings.get())
  setTimeout(() => {
    // A mock run shows the renderer's fake Streaming: no host service, port forwarding or discovery of its own
    // (a real PlayOut may be running beside it on the same ports).
    if (!cli.mock) void streaming.start().catch((err) => log.error('streaming start failed', err))
    // A mock run never touches the controllers, Steam, Game Bar or the power settings.
    if (!cli.mock) overlay.start()
    const rescan = sourcesWithGames.size
      ? scan.run([...sourcesWithGames]).catch((err) => log.error('startup scan failed', err))
      : Promise.resolve()
    void rescan.then(async () => {
      // After the rescan: a game the store finished while PlayOut was closed is installed now and leaves the queue.
      void installQueue.begin().catch((err) => log.error('install queue start failed', err))
      // Every game's size, installed or not, once per run (games update, so last run's sizes may be out of date):
      // after the rescan, so games installed since the last run are measured as installed.
      void installSizes.scanAll()
      // HowLongToBeat times found before Solo times were read: looked up once more, in the background.
      void metadata.backfillHltb().catch((err) => log.error('hltb backfill failed', err))
      // Games matched by name are not re-checked in the background (their metadata changes when the user refreshes
      // it), with one exception, once per library: the ROM games matched before a ROM's console counted whose
      // recorded match is an edition's record or another year's same-titled game are scraped again.
      void metadata.recheckConsoleMatches().catch((err) => log.error('match re-check failed', err))
      ratings.kick()
      localPlayers.kick()
      steamTags.kick()
      steamScreenshots.kick()
      const signedIn = (await accounts.getAccounts())
        .filter((a) => a.supported && a.signedIn && !sourcesWithGames.has(a.source))
        .map((a) => a.source)
      if (signedIn.length)
        await accounts
          .importOwned(signedIn)
          .catch((err) => log.error('startup owned import failed', err))
    })
  }, 4000)
}

/** How long `--scan` waits for the cover lane after the scan before writing the report anyway. */
const SCAN_REPORT_COVER_WAIT_MS = 10 * 60 * 1000

/**
 * `--scan=<file>`: a support/diagnostic run that scans every enabled source and records what each one found. The
 * covers the scan queued are part of that: the report waits (at most SCAN_REPORT_COVER_WAIT_MS) until the cover
 * lane drains and records the covers per source (local caches, store CDNs, SteamGridDB), never for the full lane.
 */
async function writeScanReport(
  scan: ReturnType<typeof createScanService>,
  library: LibraryService,
  events: EventBus,
  target: string,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const startedAt = Date.now()
  let latest: MetadataProgress | null = null
  let drained: (() => void) | null = null
  const off = events.on('metadata:progress', (p: MetadataProgress) => {
    latest = p
    if (!(p.coverLane ?? 0) || p.queued === 0) drained?.()
  })
  const result = await scan.run()
  const scanMs = Date.now() - startedAt
  // `enqueue` emits its first progress inside `scan.run`, so `latest` tells whether a cover lane is running.
  const coverStart = Date.now()
  const pending = latest as MetadataProgress | null
  if (pending && (pending.coverLane ?? 0) > 0)
    await Promise.race([
      new Promise<void>((resolve) => {
        drained = resolve
      }),
      new Promise<void>((resolve) => setTimeout(resolve, SCAN_REPORT_COVER_WAIT_MS).unref())
    ])
  off()
  const coverLaneMs = pending ? Date.now() - coverStart : 0
  const games = library.games()
  const bySource: Record<string, { installed: number; total: number; sample: string[] }> = {}
  const covers: { total: number; bySource: Record<string, number> } = { total: 0, bySource: {} }
  for (const game of games) {
    const row = (bySource[game.source] ??= { installed: 0, total: 0, sample: [] })
    row.total++
    if (game.installed) row.installed++
    if (row.sample.length < 5) row.sample.push(`${game.title} [${game.platformId}]`)
    if (game.media.cover) {
      covers.total++
      const source = game.metadata.sources?.['art:cover'] ?? 'unknown'
      covers.bySource[source] = (covers.bySource[source] ?? 0) + 1
    }
  }
  const report = {
    userData: app.getPath('userData'),
    durationMs: Date.now() - startedAt,
    scanMs,
    coverLaneMs,
    covers,
    added: result.added,
    updated: result.updated,
    removed: result.removed,
    unknownFolders: result.unknownFolders ?? [],
    sources: result.sources.map((s) => ({
      id: s.id,
      enabled: s.enabled,
      client: s.client,
      gameCount: s.gameCount,
      error: s.error ?? null
    })),
    games: bySource
  }
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, JSON.stringify(report, null, 2))
  log.info(
    `scan report written to ${target}`,
    report.sources.map((s) => `${s.id}=${s.gameCount}`).join(' '),
    `scan ${scanMs} ms, cover lane ${coverLaneMs} ms, covers ${covers.total} [${
      Object.entries(covers.bySource)
        .map(([s, n]) => `${s} ${n}`)
        .join(', ') || 'none'
    }]`
  )
}

async function takeScreenshot(win: BrowserWindow | null, target: string): Promise<void> {
  if (!win) return
  const log = createLogger('main')
  const wanted = { width: 1920, height: 1080 }
  // Windows clamps a window to the work area; insist on the content size once the window is shown.
  win.setContentSize(wanted.width, wanted.height)
  await new Promise((r) => setTimeout(r, 2500))
  const [w, h] = win.getContentSize()
  if (w !== wanted.width || h !== wanted.height) {
    log.warn(
      `screenshot window is ${w}x${h} instead of ${wanted.width}x${wanted.height} (display too small?)`
    )
  }
  let image = await win.webContents.capturePage()
  const size = image.getSize()
  if (size.width !== wanted.width || size.height !== wanted.height) {
    log.warn(`captured ${size.width}x${size.height}; cropping to ${wanted.width}x${wanted.height}`)
    image = image.crop({
      x: 0,
      y: 0,
      width: Math.min(size.width, wanted.width),
      height: Math.min(size.height, wanted.height)
    })
  }
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(target, image.toPNG())
  log.info(`screenshot written to ${target} (${image.getSize().width}x${image.getSize().height})`)
}

/** Best-effort: show the Windows touch keyboard (TabTip) for text entry on touch devices. */
/** The system tray icon of Minimize to tray: the app icon, a click opens the window, the menu opens or quits. */
function createAppTray(actions: TrayActions): TrayIcon {
  const source = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'icon.png'))
  if (source.isEmpty()) throw new Error('the app icon could not be read')
  // 16 px at 100 % scaling, sharper sizes for 150 % and 200 %.
  const icon = nativeImage.createEmpty()
  for (const [scaleFactor, size] of [
    [1, 16],
    [1.5, 24],
    [2, 32]
  ] as const) {
    icon.addRepresentation({
      scaleFactor,
      buffer: source.resize({ width: size, height: size, quality: 'best' }).toPNG()
    })
  }
  const tray = new Tray(icon)
  tray.setToolTip('PlayOut')
  const menu = (): Menu =>
    Menu.buildFromTemplate([
      { label: tMain('mainApp.tray.open'), click: () => actions.open() },
      { type: 'separator' },
      { label: tMain('mainApp.tray.quit'), click: () => actions.quit() }
    ])
  tray.setContextMenu(menu())
  // The menu is built once: a change of Settings > System > Language builds it again in the new language.
  const stopFollowing = onMainLanguageChange(() => {
    if (!tray.isDestroyed()) tray.setContextMenu(menu())
  })
  tray.on('click', () => actions.open())
  return {
    destroy() {
      stopFollowing()
      tray.destroy()
    }
  }
}

async function showTouchKeyboard(): Promise<void> {
  const candidates = [
    join(
      process.env['ProgramFiles'] ?? 'C:\\Program Files',
      'Common Files',
      'microsoft shared',
      'ink',
      'TabTip.exe'
    ),
    join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'osk.exe')
  ]
  for (const exe of candidates) {
    if (await pathExists(exe)) {
      const started = await new Promise<boolean>((resolve) => {
        try {
          // A failed spawn reports through 'error'; unheard, it would reach the fatal uncaughtException handler.
          const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
          child.on('error', () => resolve(false))
          child.once('spawn', () => {
            child.unref()
            resolve(true)
          })
        } catch {
          resolve(false)
        }
      })
      if (started) return
    }
  }
}
