// Compress games automatically (Settings › Convert, `library.autoCompressGames`, off by default): a PC game that has
// just finished installing is compressed with the game page's Upgrade › Compress game (the upgrades service's
// 'compress' action: Windows compact.exe, XPRESS8K), one game at a time.
//
// What counts as "just finished installing":
// - the install tracker's end ('install:progress' done: the same signal as the "installed" toast);
// - a game of the library going from not installed to installed, in a store already scanned in this run (installed
//   straight in its store), when its install folder was made after PlayOut last saw the game installed (or after this
//   run started): a reinstall, not a store that briefly lost sight of an old install;
// - a game new to the library, already installed, found by a later scan of a store that was scanned before in this run,
//   when its install folder was made after that first scan (not a drive with old games plugged in later).
// A store's first scan of the run is not an install: a new store account, or the start of PlayOut, brings games that
// were installed long ago. Games installed while PlayOut was closed are therefore left as they are.
// A snapshot of every PC game's installed state is kept from the start, whether the setting is on or off, so switching
// it on never sweeps the games installed before.
// ROM and emulated games (Trim Games covers them), games of another PC, and what the Compress action itself refuses (a
// drive or folder it cannot compress, already compressed or partly so) are left as they are, and so are games with
// anti-cheat (the Upgrade menu warns of a ban risk before compressing those; nothing does it unasked).
//
// A game waits (checked again every minute, for at most a day; then it is left as it is) while a game is running, while
// its store still installs, downloads or updates it, while the Emulation folder moves, while a Convert run or another
// upgrade runs, and until its folder has stopped changing for a few minutes (stores other than Steam give no reliable
// "still writing" signal; this also leaves the player time to start the game first). While its compress runs, a game
// started from PlayOut or Steam writing into the folder stops it; it is tried again later. Games started outside
// PlayOut are not seen. The queue lives in memory: a game PlayOut closed on before its turn is not compressed later.
import type { Game, SourceId } from '../../shared/types'
import { DEFAULT_COMPRESS_ALGORITHM } from './compress'
import type { Logger } from '../logger'
import { tMain } from '../i18n'
import type { UpgradesService } from './service'

/** How often a waiting game is looked at again. */
const RETRY_MS = 60_000
/** A game that has waited this long is given up (it stays uncompressed; Upgrade › Compress game is still there). */
const MAX_WAIT_MS = 24 * 60 * 60_000
/** How often the running compress is checked. */
const POLL_MS = 2_000
/** How long a game's folder must stay the same (and its newest file this old) before it is compressed. */
const SETTLE_MS = 5 * 60_000

/** A folder's files at one moment (auto-compress-checks folderActivity). */
export interface FolderActivity {
  files: number
  bytes: number
  /** The newest file change (ms since 1970). */
  newest: number
}

export interface AutoCompressDeps {
  /** Settings › Convert › Compress games automatically. */
  enabled(): boolean
  library: { getGame(id: string): Game | undefined; games(): Game[] }
  upgrades: Pick<UpgradesService, 'upgradeStatus' | 'runUpgrade' | 'busyFor' | 'cancelUpgrade'>
  /** Why no game can be compressed now (a game running, the Emulation folder moving, a Convert run or upgrade), else null. */
  busyReason(): Promise<string | null>
  /** Why this game cannot be compressed yet (its store still installs or updates it), else null. */
  gameWaitReason(game: Game): Promise<string | null>
  /** While the game is compressed: why to stop and try later (a game started, its store writes into it), else null. */
  stopReason(game: Game): Promise<string | null>
  /** The folder's files now; null when it cannot be read. */
  folderActivity(dir: string): Promise<FolderActivity | null>
  /** When the folder was made (ms since 1970); null when unknown. */
  folderCreatedAt(dir: string): Promise<number | null>
  log: Logger
  now?: () => number
  /** Tests: the timings. */
  retryMs?: number
  maxWaitMs?: number
  pollMs?: number
  settleMs?: number
}

export interface AutoCompressService {
  /** The install tracker says the game finished installing ('install:progress' done). */
  installFinished(gameId: string): void
  /** The library changed: games that went from not installed to installed are queued. */
  libraryChanged(): void
  /** A scan added games the library did not have (scan-service onNewGames). */
  newGames(source: SourceId, gameIds: string[]): void
  /** A full scan of the source ended (scan-service onSourceScanned): its later new games are new installs. */
  sourceScanned(source: SourceId): void
  /** Whether the game's running upgrade is a compress started here (Play's refusal says so). */
  compressing(gameId: string): boolean
  /** Game ids waiting their turn, the running one first (tests, logs). */
  pending(): string[]
  dispose(): void
}

/** A PC game of this PC: the kind the Upgrade menu (and its Compress game) is offered for. */
function pcGame(game: Game): boolean {
  return game.source !== 'rom' && !game.remote
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface Entry {
  queuedAt: number
  /** The install folder must have been made at or after this time (ms since 1970); null: no such check. */
  madeAfter: number | null
}

/** What one game's turn came to. */
type Turn = { done: true } | { done: false; reason: string }

export function createAutoCompressService(deps: AutoCompressDeps): AutoCompressService {
  const { log } = deps
  const now = deps.now ?? Date.now
  const retryMs = deps.retryMs ?? RETRY_MS
  const maxWaitMs = deps.maxWaitMs ?? MAX_WAIT_MS
  const pollMs = deps.pollMs ?? POLL_MS
  const settleMs = deps.settleMs ?? SETTLE_MS
  const startedAt = now()

  /** Every PC game's installed state when last looked at (kept whether the setting is on or off). */
  const installed = new Map<string, boolean>()
  /** When each game was last seen installed in this run. */
  const seenInstalledAt = new Map<string, number>()
  const snapshot = (): Game[] => {
    const turned: Game[] = []
    const t = now()
    for (const game of deps.library.games()) {
      if (!pcGame(game)) continue
      const before = installed.get(game.id)
      const isInstalled = !!game.installed
      if (before === false && isInstalled) turned.push(game)
      installed.set(game.id, isInstalled)
      // A game just turned installed keeps the time it was seen installed before (the folder must be newer than it).
      if (isInstalled && before !== false) seenInstalledAt.set(game.id, t)
    }
    return turned
  }
  snapshot()

  /** Sources fully scanned at least once in this run, with when that first scan ended. */
  const scanned = new Map<SourceId, number>()
  /** Waiting games. */
  const queue = new Map<string, Entry>()
  /** Each queued game's folder as last looked at, and since when it is like that. */
  const settle = new Map<string, { activity: FolderActivity; since: number }>()
  /** Games whose compress was stopped here (a game started...): their 'partial' state is this run's, so it goes on. */
  const resumable = new Set<string>()
  /** The game being looked at or compressed now. */
  let current: string | null = null
  /** A compress started here runs for `current`. */
  let compressRunning = false
  let pumping = false
  /** A game was queued while a pump ran: the next pump comes right after it. */
  let dirty = false
  let timer: NodeJS.Timeout | undefined
  let disposed = false

  const schedule = (ms: number): void => {
    if (disposed) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void pump()
    }, ms)
  }

  const add = (gameId: string, why: string, madeAfter: number | null): void => {
    if (disposed || !deps.enabled()) return
    if (queue.has(gameId)) return
    const game = deps.library.getGame(gameId)
    if (!game || !pcGame(game)) return
    queue.set(gameId, { queuedAt: now(), madeAfter })
    settle.delete(gameId)
    log.info(`${game.title}: installed (${why}); queued to be compressed`)
    if (pumping) dirty = true
    else schedule(0)
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /**
   * Waits for the game's running compress to end. Stops it when `stopReason` gives one (the reason is returned: the
   * game is tried again later); null when it ended by itself or the player stopped it.
   */
  const waitForEnd = async (game: Game): Promise<string | null> => {
    for (;;) {
      await sleep(pollMs)
      if (disposed || deps.upgrades.busyFor(game.id) === null) return null
      const stop = await deps.stopReason(game).catch(() => null)
      if (!stop) continue
      log.info(`${game.title}: automatic compress stopped (${stop}); it is tried again later`)
      await deps.upgrades.cancelUpgrade(game.id)
      while (!disposed && deps.upgrades.busyFor(game.id) !== null) await sleep(pollMs)
      return stop
    }
  }

  /** Whether the folder has stayed the same for settleMs, its newest file at least that old. */
  const settled = async (game: Game): Promise<string | null> => {
    const activity = await deps.folderActivity(game.installDir!)
    if (!activity) return tMain('mainApp.autoCompressWait.folderMissing')
    const t = now()
    const before = settle.get(game.id)
    const same =
      before &&
      before.activity.files === activity.files &&
      before.activity.bytes === activity.bytes &&
      before.activity.newest === activity.newest
    if (!same) settle.set(game.id, { activity, since: t })
    const since = same ? before.since : t
    if (t - since < settleMs || t - activity.newest < settleMs)
      return tMain('mainApp.autoCompressWait.filesChanging')
    return null
  }

  /** Blocked reasons of the Upgrade menu that pass (the game closes, its folder comes back): the game waits. */
  const passing = (): string[] => [
    tMain('mainUpgrades.blocked.closeGame'),
    tMain('mainUpgrades.blocked.folderMissing'),
    tMain('mainUpgrades.alreadyRunning')
  ]

  const skip = (game: Game | undefined, gameId: string, why: string): Turn => {
    log.info(`${game?.title ?? gameId}: not compressed automatically (${why})`)
    return { done: true }
  }

  /** One game's turn. */
  const tryOne = async (gameId: string, entry: Entry): Promise<Turn> => {
    const game = deps.library.getGame(gameId)
    if (!game || !pcGame(game) || !game.installed || !game.installDir)
      return skip(game, gameId, 'no longer installed')
    const wait = await deps.gameWaitReason(game)
    if (wait) return { done: false, reason: wait }
    if (entry.madeAfter !== null) {
      const made = await deps.folderCreatedAt(game.installDir)
      // A folder older than that is an install from before (a store that lost sight of it, a drive plugged in).
      if (made !== null && made < entry.madeAfter)
        return skip(game, gameId, 'installed before, not a new install')
    }
    const unsettled = await settled(game)
    if (unsettled) return { done: false, reason: unsettled }
    const status = await deps.upgrades.upgradeStatus(gameId, { freshMeasure: true })
    if (status.busy)
      return { done: false, reason: tMain('mainApp.autoCompressWait.upgradeRunning') }
    if (status.blocked) {
      if (passing().includes(status.blocked)) return { done: false, reason: status.blocked }
      return skip(game, gameId, status.blocked)
    }
    if (status.risk.antiCheat.length || status.risk.tags.length)
      return skip(
        game,
        gameId,
        `anti-cheat: ${[...status.risk.antiCheat, ...status.risk.tags].join(', ')}; compress it from the Upgrade menu`
      )
    if (status.compress.unavailable) return skip(game, gameId, status.compress.unavailable)
    const state = status.compress.state
    if (state !== 'none' && !(state === 'partial' && resumable.has(gameId)))
      return skip(game, gameId, `already ${state}`)
    log.info(`${game.title}: compressing automatically after its install`)
    try {
      await deps.upgrades.runUpgrade(gameId, {
        kind: 'compress',
        algorithm: DEFAULT_COMPRESS_ALGORITHM
      })
    } catch (err) {
      const message = errorText(err)
      if (passing().includes(message)) return { done: false, reason: message }
      throw err
    }
    compressRunning = true
    let stopped: string | null
    try {
      stopped = await waitForEnd(game)
    } finally {
      compressRunning = false
    }
    resumable.delete(gameId)
    if (stopped) {
      resumable.add(gameId)
      settle.delete(gameId)
      return { done: false, reason: stopped }
    }
    return { done: true }
  }

  const pump = async (): Promise<void> => {
    if (disposed || pumping) return
    if (!deps.enabled()) {
      if (queue.size) log.info(`Compress games automatically is off: ${queue.size} game(s) left`)
      queue.clear()
      settle.clear()
      return
    }
    if (!queue.size) return
    pumping = true
    dirty = false
    let next = retryMs
    try {
      /** A game that has waited too long is given up. */
      const waited = (gameId: string, entry: Entry, reason: string): void => {
        const title = deps.library.getGame(gameId)?.title ?? gameId
        if (now() - entry.queuedAt >= maxWaitMs) {
          log.info(`${title}: not compressed automatically (waited too long: ${reason})`)
          queue.delete(gameId)
          settle.delete(gameId)
          resumable.delete(gameId)
        } else log.debug(`${title}: compress waits (${reason})`)
      }
      // What holds every game back is asked once.
      const busy = await deps.busyReason()
      if (busy) {
        for (const [gameId, entry] of [...queue]) waited(gameId, entry, busy)
        return
      }
      // The first game ready goes; the others keep their place and wait.
      for (const [gameId, entry] of [...queue]) {
        if (disposed) return
        current = gameId
        let turn: Turn
        try {
          turn = await tryOne(gameId, entry)
        } catch (err) {
          log.warn(
            `${deps.library.getGame(gameId)?.title ?? gameId}: automatic compress failed: ${errorText(err)}`
          )
          turn = { done: true }
        }
        current = null
        if (disposed) return
        if (turn.done) {
          queue.delete(gameId)
          settle.delete(gameId)
          resumable.delete(gameId)
          // The next game right away (one at a time).
          next = 0
          return
        }
        waited(gameId, entry, turn.reason)
      }
    } finally {
      current = null
      pumping = false
      if (!disposed && queue.size) schedule(dirty ? 0 : next)
      dirty = false
    }
  }

  return {
    installFinished(gameId) {
      add(gameId, 'install finished', null)
    },
    libraryChanged() {
      const turned = snapshot()
      for (const game of turned) {
        // A store's first scan of the run is not an install (games installed long ago, or while PlayOut was closed).
        if (!scanned.has(game.source)) continue
        add(game.id, 'now installed', seenInstalledAt.get(game.id) ?? startedAt)
      }
    },
    newGames(source, gameIds) {
      // Recorded either way, so the snapshot knows them.
      snapshot()
      const firstScan = scanned.get(source)
      if (source === 'rom' || firstScan === undefined) return
      for (const id of gameIds) {
        const game = deps.library.getGame(id)
        if (game?.installed) add(id, 'new installed game', firstScan)
      }
    },
    sourceScanned(source) {
      if (!scanned.has(source)) scanned.set(source, now())
    },
    compressing(gameId) {
      return compressRunning && current === gameId
    },
    pending() {
      return [...(current ? [current] : []), ...[...queue.keys()].filter((id) => id !== current)]
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
      queue.clear()
      settle.clear()
    }
  }
}
