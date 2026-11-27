import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { closeSync, mkdirSync, openSync, promises as fs, writeFileSync } from 'fs'
import { join } from 'path'
import {
  PEERPARTY_FOLDER,
  type PeerPartyCompatible,
  type PeerPartyProgress,
  type PeerPartyService as PeerPartyServiceId,
  type PeerPartySession,
  type PeerPartyStatus
} from '../../shared/peerparty'
import type { Game, LaunchResult } from '../../shared/types'
import type { EventBus } from '../events'
import { safeHandoffDir } from '../launcher/launcher'
import type { ProcessInfo } from '../launcher/process-monitor'
import type { LauncherService } from '../launcher/types'
import type { Logger } from '../logger'
import { AntiCheatScanError, nodeFsIo, scanAntiCheat, type FsIo } from '../upgrades/anticheat'
import { peerPartyEligibility, type PeerPartyProbe, type PeerPartyVerdict } from './eligibility'
import { nodeExeIo, resolvePeerPartyExe, type ExeIo } from './exe'
import { buildPeerPartyCommand, peerPartyFailure } from './launch'
import { DATA_DIR_NAME, ensurePortablePrefs } from './prefs'
import { EXE_NAME, ensurePeerParty, readInstallRecord } from './release'
import { scanNetworkServices } from './scan'
import { tMain } from '../i18n'

/**
 * PeerParty (LAN play for games without it): which installed games may be started through it, starting one (PeerParty
 * is downloaded or updated first) and the session while it runs.
 */

export interface PeerPartyService {
  status(gameId: string): Promise<PeerPartyStatus>
  play(gameId: string): Promise<LaunchResult>
  /** Filters > L.A.N. Party: the games offered PeerParty now; starts a background check of unscanned folders. */
  compatible(): Promise<PeerPartyCompatible>
  session(): PeerPartySession | null
  dispose(): void
}

export interface PeerPartyServiceDeps {
  library: {
    getGame(id: string): Game | undefined
    getGameView?(id: string): Game | undefined
    /** Every game of the library (Filters > L.A.N. Party). */
    games?(): Game[]
  }
  launcher: Pick<LauncherService, 'running' | 'track'>
  events: EventBus
  log: Logger
  userData: string
  /** Every running process (busy check, Steam check). */
  processes(): Promise<ProcessInfo[]>
  /** Why the game must not start now (an Upgrade menu action), else null. */
  launchBlocked?(game: Game): string | null
  /** Opens a URL with the shell (steam://open/main). */
  openExternal(url: string): Promise<void>
  fetch?: typeof fetch
  io?: { fs?: FsIo; exe?: ExeIo }
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess
  sleep?: (ms: number) => Promise<void>
  /** Tests: replace the folder scan. */
  probe?: (game: Game) => Promise<PeerPartyProbe>
  /** Tests: replace the anti-cheat scan made again before every start. */
  probeAntiCheat?: (game: Game) => Promise<AntiCheatProbe>
}

/** The anti-cheat part of a folder scan. */
export type AntiCheatProbe = Pick<
  PeerPartyProbe,
  'antiCheat' | 'antiCheatComplete' | 'antiCheatError'
>

/** Bumped when the scan's rules change, so older cached answers are scanned again. */
export const SCAN_VERSION = 1
/** A scan taking longer than this is noted in the log. */
const SCAN_SLOW_MS = 30_000
const STEAM_WAIT_MS = 60_000
/** A PeerParty that exits this soon with an error failed to start the game. */
const EARLY_EXIT_MS = 20_000

interface CacheEntry {
  key: string
  services: PeerPartyServiceId[]
  antiCheat: string[]
  acComplete: boolean
  acError?: boolean
  exe: string | null
  sdkComplete: boolean
  at: string
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createPeerPartyService(deps: PeerPartyServiceDeps): PeerPartyService {
  const { log, events } = deps
  const root = join(deps.userData, PEERPARTY_FOLDER)
  const exePath = join(root, EXE_NAME)
  const dataDir = join(root, DATA_DIR_NAME)
  const logsDir = join(root, 'logs')
  const cacheFile = join(root, 'scan-cache.json')
  const fsIo = deps.io?.fs ?? nodeFsIo
  const exeIo = deps.io?.exe ?? nodeExeIo
  const spawn = deps.spawn ?? nodeSpawn
  const sleep = deps.sleep ?? defaultSleep

  let current: { session: PeerPartySession; game: Game; child: ChildProcess } | null = null
  const progress = new Map<string, PeerPartyProgress>()
  let installedVersion: string | null = null
  let disposed = false
  /** The game being started through PeerParty now: one start at a time, for every game. */
  let starting: Game | null = null

  const cache = new Map<string, CacheEntry>()
  let cacheLoaded: Promise<void> | null = null
  const loadCache = (): Promise<void> =>
    (cacheLoaded ??= (async () => {
      try {
        const value = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as {
          v?: unknown
          entries?: Record<string, CacheEntry>
        }
        if (value?.v === SCAN_VERSION && value.entries && typeof value.entries === 'object')
          for (const [id, e] of Object.entries(value.entries)) cache.set(id, e)
      } catch {
        /* no cache yet */
      }
      installedVersion = (await readInstallRecord(root))?.tag ?? null
    })())
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const saveCache = (): void => {
    if (saveTimer || disposed) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void fs
        .mkdir(root, { recursive: true })
        .then(() => fs.writeFile(cacheFile, cacheText()))
        .catch((err) => log.warn(`PeerParty: scan cache not saved: ${errorText(err)}`))
    }, 1000)
  }
  const cacheText = (): string =>
    JSON.stringify({ v: SCAN_VERSION, entries: Object.fromEntries(cache) })

  const view = (id: string): Game | undefined =>
    deps.library.getGameView?.(id) ?? deps.library.getGame(id)

  /** What identifies a scanned folder: its path and change time, and the program's size and change time. */
  async function cacheKey(installDir: string, exe: string | null): Promise<string> {
    const dir = await fs.stat(installDir).catch(() => null)
    const file = exe ? await fs.stat(exe).catch(() => null) : null
    return [installDir, dir?.mtimeMs ?? 0, exe ?? '', file?.size ?? 0, file?.mtimeMs ?? 0].join('|')
  }

  async function realAntiCheatProbe(game: Game): Promise<AntiCheatProbe> {
    const installDir = game.installDir!
    try {
      const scan = await scanAntiCheat(installDir, fsIo)
      return { antiCheat: scan.names, antiCheatComplete: scan.complete }
    } catch (err) {
      if (!(err instanceof AntiCheatScanError))
        log.warn(`PeerParty: anti-cheat scan of ${installDir}: ${errorText(err)}`)
      return { antiCheat: [], antiCheatComplete: false, antiCheatError: true }
    }
  }
  const antiCheatProbe =
    deps.probeAntiCheat ?? (deps.probe ? (g: Game) => deps.probe!(g) : realAntiCheatProbe)

  async function realProbe(game: Game): Promise<PeerPartyProbe> {
    const installDir = game.installDir!
    const exe = await resolvePeerPartyExe(game, exeIo).catch(() => null)
    const ac = await antiCheatProbe(game)
    const net = await scanNetworkServices({ installDir, exe, source: game.source }, fsIo, log)
    return { ...ac, exe, services: net.services, sdkComplete: net.complete }
  }

  const probeOf = (e: CacheEntry): PeerPartyProbe => ({
    antiCheat: e.antiCheat,
    antiCheatComplete: e.acComplete,
    ...(e.acError ? { antiCheatError: true } : {}),
    exe: e.exe,
    services: e.services
  })

  // One scan at a time; a game asked for again while queued shares the queued scan.
  let queue: Promise<unknown> = Promise.resolve()
  const scanning = new Map<string, Promise<CacheEntry>>()
  function scan(game: Game): Promise<CacheEntry> {
    const running = scanning.get(game.id)
    if (running) return running
    const work = queue.then(async () => {
      // A long scan is only logged: the game page shows "checking" until the real answer is sent.
      const timer = setTimeout(
        () => log.info(`PeerParty: scanning ${game.installDir} takes long`),
        SCAN_SLOW_MS
      )
      try {
        const p = await (deps.probe ?? realProbe)(game)
        const entry: CacheEntry = {
          key: await cacheKey(game.installDir!, p.exe),
          services: p.services,
          antiCheat: p.antiCheat,
          acComplete: p.antiCheatComplete,
          ...(p.antiCheatError ? { acError: true } : {}),
          exe: p.exe,
          sdkComplete: p.sdkComplete ?? true,
          at: new Date().toISOString()
        }
        cache.set(game.id, entry)
        saveCache()
        return entry
      } finally {
        clearTimeout(timer)
      }
    })
    const done = work.finally(() => scanning.delete(game.id))
    queue = done.catch(() => {})
    scanning.set(game.id, done)
    return done
  }

  function busyProgress(gameId: string): PeerPartyProgress | null {
    const mine = progress.get(gameId)
    if (mine && mine.phase !== 'done' && mine.phase !== 'failed') return mine
    for (const p of progress.values())
      if (p.gameId === null && p.phase !== 'done' && p.phase !== 'failed') return p
    return null
  }

  function toStatus(gameId: string, verdict: PeerPartyVerdict, checking: boolean): PeerPartyStatus {
    return {
      gameId,
      supported: !checking && verdict.blocked === null && !verdict.needsScan,
      checking,
      services: verdict.services,
      blocked: verdict.blocked,
      reason: verdict.reason,
      antiCheat: verdict.antiCheat,
      exe: verdict.exe,
      installedVersion,
      busy: busyProgress(gameId),
      running: current?.session.gameId === gameId
    }
  }

  async function emitStatus(gameId: string): Promise<void> {
    if (disposed) return
    try {
      events.emit('peerparty:status', await status(gameId, false))
    } catch (err) {
      log.warn(`PeerParty: status of ${gameId}: ${errorText(err)}`)
    }
  }

  /** The cached verdict when its key still holds, else null. */
  async function cachedVerdict(game: Game): Promise<PeerPartyVerdict | null> {
    const entry = cache.get(game.id)
    if (!entry || !entry.key) return null
    if ((await cacheKey(game.installDir!, entry.exe)) !== entry.key) return null
    return peerPartyEligibility(game, probeOf(entry))
  }

  async function status(gameId: string, startScan = true): Promise<PeerPartyStatus> {
    await loadCache()
    const game = view(gameId)
    if (!game)
      return toStatus(
        gameId,
        {
          blocked: 'not-installed',
          reason: tMain('mainPeerParty.notInLibrary'),
          services: [],
          antiCheat: [],
          exe: null,
          needsScan: false
        },
        false
      )
    const first = peerPartyEligibility(game)
    if (!first.needsScan) return toStatus(gameId, first, false)
    const cached = await cachedVerdict(game)
    if (cached) return toStatus(gameId, cached, false)
    if (startScan)
      void scan(game)
        .then(() => emitStatus(gameId))
        .catch((err) => log.warn(`PeerParty: scan of ${game.title}: ${errorText(err)}`))
    return toStatus(gameId, first, true)
  }

  /**
   * The verdict for a start: scans the folder now when no valid answer is cached. With a cached answer the folder is
   * still checked for anti-cheat again, since an update can add anti-cheat in a subfolder without changing the key.
   */
  async function verdictForPlay(game: Game): Promise<PeerPartyVerdict> {
    await loadCache()
    const first = peerPartyEligibility(game)
    if (!first.needsScan) return first
    const entry = cache.get(game.id)
    if (!(await cachedVerdict(game)) || !entry)
      return peerPartyEligibility(game, probeOf(await scan(game)))
    const ac = await antiCheatProbe(game)
    const fresh: CacheEntry = {
      ...entry,
      antiCheat: ac.antiCheat,
      acComplete: ac.antiCheatComplete,
      at: new Date().toISOString()
    }
    delete fresh.acError
    if (ac.antiCheatError) fresh.acError = true
    if (cache.get(game.id) === entry) {
      cache.set(game.id, fresh)
      saveCache()
    }
    return peerPartyEligibility(game, probeOf(fresh))
  }

  /** The verdict known without a new scan (the quick checks, else a cached scan), or null when a scan is needed. */
  async function knownVerdict(game: Game): Promise<PeerPartyVerdict | null> {
    const first = peerPartyEligibility(game)
    if (!first.needsScan) return first
    return cachedVerdict(game)
  }

  const offered = (v: PeerPartyVerdict): boolean => v.blocked === null && !v.needsScan

  /** The background check of unscanned folders, while it runs. */
  let sweep: Promise<void> | null = null
  /** The list was asked for again while a sweep ran (a game installed meanwhile): look again when it ends. */
  let sweepAgain = false

  async function compatibleNow(): Promise<{ ids: string[]; unscanned: Game[] }> {
    await loadCache()
    const ids: string[] = []
    const unscanned: Game[] = []
    for (const raw of deps.library.games?.() ?? []) {
      const game = view(raw.id) ?? raw
      const verdict = await knownVerdict(game).catch(() => null)
      if (!verdict) unscanned.push(game)
      else if (offered(verdict)) ids.push(game.id)
    }
    return { ids, unscanned }
  }

  /**
   * Scans the folders never scanned (or changed since), one game at a time: each scan waits for the one before it, so
   * a start pressed meanwhile (verdictForPlay) waits for one scan at most, never the whole sweep.
   */
  function startSweep(games: Game[]): void {
    if (disposed) return
    if (sweep) {
      sweepAgain = true
      return
    }
    sweep = (async () => {
      for (const game of games) {
        if (disposed) return
        // Asked again: the game may have been uninstalled or rescanned (a game page opened) meanwhile.
        const now = view(game.id)
        if (!now || (await knownVerdict(now).catch(() => null))) continue
        try {
          await scan(now)
        } catch (err) {
          log.warn(`PeerParty: scan of ${now.title}: ${errorText(err)}`)
          continue
        }
        await emitStatus(now.id)
      }
    })().finally(() => {
      sweep = null
      if (disposed) return
      // Asked again during the sweep (a game installed meanwhile): games still unscanned get a sweep of their own,
      // which reports when it ends; otherwise the list is sent now.
      const again = sweepAgain
      sweepAgain = false
      void (again ? compatible() : compatibleNow().then(({ ids }) => ({ ids, scanning: false })))
        .then(({ ids, scanning }) => {
          if (!scanning && !disposed) events.emit('peerparty:compatible', { ids, scanning: false })
        })
        .catch((err) => log.warn(`PeerParty: compatible games: ${errorText(err)}`))
    })
  }

  async function compatible(): Promise<PeerPartyCompatible> {
    const { ids, unscanned } = await compatibleNow()
    if (unscanned.length) startSweep(unscanned)
    return { ids, scanning: !!sweep }
  }

  function setProgress(p: PeerPartyProgress): void {
    progress.set(p.gameId ?? '', p)
    if (!disposed) events.emit('peerparty:progress', p)
  }

  /**
   * Whether a PeerParty of ours runs that this PlayOut did not start (one left running when PlayOut was restarted);
   * null when the process list could not be read. A peerparty.exe whose path the list does not give counts as ours.
   */
  async function strayPeerParty(): Promise<boolean | null> {
    try {
      const list = await deps.processes()
      const ours = exePath.toLowerCase()
      const found = list.some((p) =>
        p.path
          ? p.path.toLowerCase() === ours && p.pid !== current?.child.pid
          : p.name.toLowerCase() === EXE_NAME && p.pid !== current?.child.pid
      )
      return found
    } catch {
      return null
    }
  }

  async function busy(): Promise<boolean> {
    if (current) return true
    // Unknown: assume one runs, so neither the exe nor its settings are replaced under it.
    return (await strayPeerParty()) ?? true
  }

  async function ensureSteam(game: Game): Promise<void> {
    if (game.source !== 'steam') return
    const steamRuns = async (): Promise<boolean> =>
      (await deps.processes().catch(() => [] as ProcessInfo[])).some(
        (p) => p.name.toLowerCase() === 'steam.exe'
      )
    if (await steamRuns()) return
    log.info(`PeerParty: starting Steam before ${game.title}`)
    await deps
      .openExternal('steam://open/main')
      .catch((err) => log.warn(`Steam: ${errorText(err)}`))
    const deadline = Date.now() + STEAM_WAIT_MS
    while (Date.now() < deadline) {
      await sleep(1000)
      if (await steamRuns()) {
        await sleep(3000)
        return
      }
    }
    log.warn('PeerParty: Steam did not start in time; starting the game anyway')
  }

  const failed = (message: string): LaunchResult => ({
    ok: false,
    error: { kind: 'failed', message }
  })

  async function play(gameId: string): Promise<LaunchResult> {
    const game = view(gameId)
    if (!game) return failed(tMain('mainPeerParty.notInLibrary'))
    if (current)
      return failed(tMain('mainPeerParty.alreadyRunning', { title: current.session.title }))
    // One start at a time for every game: two would download PeerParty at once and both start a game.
    if (starting) return failed(tMain('mainPeerParty.alreadyStarting', { title: starting.title }))
    if (busyProgress(gameId)?.gameId === gameId)
      return failed(tMain('mainPeerParty.alreadyStartingThis', { title: game.title }))
    starting = game
    try {
      return await start(game)
    } finally {
      starting = null
    }
  }

  async function start(game: Game): Promise<LaunchResult> {
    const gameId = game.id
    setProgress({ gameId, phase: 'checking', message: tMain('mainPeerParty.checking') })
    try {
      if (await strayPeerParty()) throw new Error(tMain('mainPeerParty.busy'))
      const verdict = await verdictForPlay(game)
      if (verdict.blocked || !verdict.exe)
        throw new Error(
          tMain('mainPeerParty.notOffered', {
            title: game.title,
            reason: verdict.reason ?? 'unknown'
          })
        )
      const gameExe = verdict.exe
      const { tag } = await ensurePeerParty(
        {
          dir: root,
          log,
          busy,
          onProgress: setProgress,
          ...(deps.fetch ? { fetch: deps.fetch } : {})
        },
        { gameId }
      )
      installedVersion = tag
      if (!(await busy())) await ensurePortablePrefs(dataDir, log)
      else await fs.mkdir(dataDir, { recursive: true })
      const blocked = deps.launchBlocked?.(game) ?? null
      if (blocked) throw new Error(blocked)
      await ensureSteam(game)
      setProgress({ gameId, phase: 'starting', message: tMain('mainPeerParty.starting') })
      await fs.mkdir(logsDir, { recursive: true })
      const cmd = buildPeerPartyCommand({
        peerPartyExe: exePath,
        logsDir,
        gameExe,
        game,
        env: process.env,
        handoffDir: safeHandoffDir
      })
      const launchLog = join(logsDir, `launch-${Date.now()}.txt`)
      // A file, not a pipe, takes PeerParty's error line: a pipe broken when PlayOut quits could end it.
      const fd = openSync(launchLog, 'w')
      let child: ChildProcess
      try {
        child = spawn(cmd.file, cmd.args, {
          cwd: cmd.cwd,
          env: cmd.env,
          detached: true,
          windowsHide: false,
          stdio: ['ignore', 'ignore', fd]
        })
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', () => resolve())
          child.once('error', reject)
        })
      } finally {
        closeSync(fd)
      }
      child.on('error', (err) => log.warn(`PeerParty: ${errorText(err)}`))
      child.unref()
      log.info(`PeerParty ${tag}: started ${game.title} (${gameExe}), pid ${child.pid}`)
      deps.launcher.track(game, child, {
        ...(game.installDir ? { handoffDir: game.installDir } : {}),
        reason: 'PeerParty'
      })
      const startedAt = new Date().toISOString()
      const session: PeerPartySession = {
        gameId,
        title: game.title,
        startedAt,
        exe: gameExe,
        ...(child.pid !== undefined ? { pid: child.pid } : {})
      }
      current = { session, game, child }
      events.emit('peerparty:session', { session })
      const spawnedAt = Date.now()
      child.once('exit', (code) => {
        if (current?.child === child) {
          current = null
          if (!disposed) events.emit('peerparty:session', { session: null })
        }
        void onExit(game, launchLog, code, Date.now() - spawnedAt)
      })
      setProgress({ gameId, phase: 'done' })
      return { ok: true, startedAt }
    } catch (err) {
      const message = errorText(err)
      const code = (err as NodeJS.ErrnoException | null)?.code
      const shown =
        code === 'EPERM' || code === 'EACCES' || code === 'ENOENT'
          ? tMain('mainPeerParty.blockedByWindows', { code })
          : message
      log.warn(`PeerParty: ${game.title}: ${message}`)
      setProgress({ gameId, phase: 'failed', message: shown })
      return failed(shown)
    }
  }

  async function onExit(
    game: Game,
    launchLog: string,
    code: number | null,
    ranMs: number
  ): Promise<void> {
    if (code === 0 || code === null || ranMs > EARLY_EXIT_MS) {
      log.info(`PeerParty: ${game.title} ended (exit code ${code})`)
      return
    }
    const text = await fs.readFile(launchLog, 'utf8').catch(() => '')
    const said = peerPartyFailure(text)
    if (!said) {
      log.info(`PeerParty: ${game.title} ended early (exit code ${code})`)
      return
    }
    const message = tMain('mainPeerParty.couldNotStart', { title: game.title, error: said })
    log.warn(message)
    if (!disposed)
      events.emit('launch:error', { gameId: game.id, error: { kind: 'failed', message } })
  }

  return {
    status: (gameId) => status(gameId),
    play,
    compatible,
    session: () => current?.session ?? null,
    dispose() {
      disposed = true
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
        try {
          mkdirSync(root, { recursive: true })
          writeFileSync(cacheFile, cacheText())
        } catch (err) {
          log.warn(`PeerParty: scan cache not saved: ${errorText(err)}`)
        }
      }
    }
  }
}
