import type {
  CoopDevice,
  CoopHandlerEntry,
  CoopPlan,
  CoopScreen,
  CoopStatus,
  Game
} from '@shared/types'
import { existsSync, promises as fs } from 'fs'
import { dirname, join, parse } from 'path'
import type { EventBus } from '../events'
import type { LauncherService } from '../launcher/types'
import type { Logger } from '../logger'
import type { LibraryService } from '../services/library-service'
import type { SettingsStore } from '../store/settings-store'
import { resolveCoopExe } from './exe'
import { createHandlerPack, extractedPaths } from './handler-pack'
import { createCoopHelper, HELPER_EXE, jobDevice, type HelperSession } from './helper'
import { buildCoopLookup, coopRecord, matchCoopHandler, sameCoopRecord } from './match'
import { planSession } from './plan'
import { ensureTools, syncHelper, toolsReady } from './tools'
import { tMain } from '../i18n'

/**
 * Co-Op (Nucleus Co-op split-screen, ARCHITECTURE.md §4.12): the handler pack, which games have a handler
 * (Game.metadata.coop, the detail page's Co-Op badge and button), the automatic setup, and Co-Op sessions run by the
 * separate Co-Op helper. One Co-Op session at a time; it is tracked like any game session (the helper process lives
 * as long as the session).
 */

export interface CoopServiceDeps {
  library: LibraryService
  settings: SettingsStore
  events: EventBus
  launcher: LauncherService
  userData: string
  /** The helper build shipped with PlayOut (resources\coop). */
  helperDir: string
  log: Logger
}

/** Thrown by play when the handler uses DRM-removal or anti-cheat tools the user has not accepted for the game. */
export const RISK_NOT_ACCEPTED = 'Co-Op: risk not accepted'

export interface CoopService {
  /** Match the downloaded handlers to the library (after a library change). */
  kick(): void
  /**
   * Keep the handler pack here without the user asking: download it shortly after start when this PC has none (the
   * Nucleus Co-Op filter, badges and buttons need it), then fetch new handlers about once a week.
   */
  startAutoDownload(options?: {
    firstDelayMs?: number
    checkEveryMs?: number
    refreshAfterMs?: number
  }): void
  status(): Promise<CoopStatus>
  downloadHandlers(): Promise<CoopStatus>
  plan(gameId: string): Promise<CoopPlan>
  play(gameId: string): Promise<void>
  stop(gameId: string): void
  removeHandler(gameId: string): Promise<void>
  handlerExtracted(gameId: string): Promise<boolean>
  dispose(): void
}

/**
 * The instance folders' root for a game: the engine root when the game is on the same drive, else
 * "<drive>:\\PlayOut Co-Op" on the game's drive (hard links cannot cross drives). Not when the game is installed in
 * the drive's root itself (the instance folders would be inside the game's folder): the engine root then.
 */
export function contentRootFor(
  exePath: string,
  engineRoot: string,
  installDir?: string
): string | undefined {
  const drive = (p: string): string => parse(p).root.toLowerCase()
  if (!drive(exePath) || drive(exePath) === drive(engineRoot)) return undefined
  const gameRoot = installDir ?? dirname(exePath)
  if (parse(gameRoot).root.toLowerCase() === gameRoot.toLowerCase().replace(/[\\/]?$/, '\\'))
    return undefined
  return join(parse(exePath).root, 'PlayOut Co-Op')
}

export function createCoopService(deps: CoopServiceDeps): CoopService {
  const { library, settings, events, launcher, log } = deps
  const coopDir = join(deps.userData, 'coop')
  const root = join(coopDir, 'engine')
  const handlersDir = join(root, 'handlers')
  const pack = createHandlerPack({
    coopDir,
    log,
    onProgress: (p) => events.emit('coop:progress', p)
  })
  const helper = createCoopHelper({ root, log })
  let session: { gameId: string; helper: HelperSession } | null = null
  let matching: Promise<void> | null = null
  let again = false
  let disposed = false
  let toolsOk = false
  const autoTimers: ReturnType<typeof setTimeout>[] = []
  /** The game whose Co-Op session is being prepared (the slot is taken before the first wait). */
  let starting: string | null = null
  let toolsJob: Promise<void> | null = null
  /**
   * ExecutableContext checks that passed, by exe and handler (no disk access on every library change). A check that
   * failed is not kept: the files may appear later (the game installed, updated or moved in), and it is made again at
   * the next matching.
   */
  const contextCache = new Set<string>()

  const helperShipped = (): boolean => existsSync(join(deps.helperDir, HELPER_EXE))

  async function entryFor(game: Game): Promise<CoopHandlerEntry> {
    const info = game.metadata.coop
    if (!info) throw new Error(tMain('mainCoop.noHandler', { title: game.title }))
    const entry = (await pack.index()).find((h) => h.archive === info.archive)
    if (!entry) throw new Error(tMain('mainCoop.handlerMissing', { title: game.title }))
    return entry
  }

  function gameOf(gameId: string): Game {
    const game = library.getGame(gameId)
    if (!game) throw new Error('Unknown game')
    return game
  }

  async function matchAll(): Promise<void> {
    const handlers = await pack.index()
    if (handlers.length === 0) return
    const lookup = buildCoopLookup(handlers)
    const nowIso = new Date().toISOString()
    const changed: string[] = []
    const contextOk = (entry: CoopHandlerEntry, exePath: string): boolean => {
      if (!entry.exeContext.length) return true
      const key = `${exePath}|${entry.archive}`
      if (contextCache.has(key)) return true
      const ok = entry.exeContext.every((rel) => existsSync(join(dirname(exePath), rel)))
      if (ok) contextCache.add(key)
      return ok
    }
    for (const game of library.games()) {
      if (disposed) return
      const match = matchCoopHandler(game, lookup, contextOk)
      const current = game.metadata.coop
      if (!match) {
        if (current && library.clearMetadataField(game.id, 'coop', { quiet: true }))
          changed.push(game.id)
        continue
      }
      const record = coopRecord(match, nowIso)
      if (sameCoopRecord(current, record)) continue
      library.applyMetadata(
        game.id,
        { metadata: { coop: record } },
        { overwrite: true, quiet: true }
      )
      changed.push(game.id)
    }
    if (changed.length) {
      events.emit('library:changed', { reason: 'metadata', gameIds: changed })
      log.info(`Co-Op: handlers matched to ${changed.length} game(s) changed`)
    }
  }

  async function prepareHelper(): Promise<void> {
    if (!helperShipped()) throw new Error(tMain('mainCoop.noHelper'))
    await syncHelper(deps.helperDir, root, log)
  }

  /** One download of the tools at a time, shared by whoever asks. */
  function prepareTools(): Promise<void> {
    toolsJob ??= downloadTools().finally(() => {
      toolsJob = null
    })
    return toolsJob
  }

  async function downloadTools(): Promise<void> {
    if (toolsOk || (await toolsReady(root))) {
      toolsOk = true
      return
    }
    let last = 0
    try {
      events.emit('coop:progress', { stage: 'tools', done: 0, total: 1 })
      await ensureTools({
        root,
        workDir: coopDir,
        log,
        onBytes: (done, total) => {
          const t = Date.now()
          if (t - last < 400) return
          last = t
          events.emit('coop:progress', { stage: 'tools', done, total: total || done })
        }
      })
      toolsOk = true
    } finally {
      events.emit('coop:progress', { stage: 'tools', done: 0, total: 0 })
    }
    // The tools may overwrite managed files the helper ships: the helper's copy goes on top again.
    await fs.rm(join(root, 'playout-coop-version.txt'), { force: true })
    await prepareHelper()
  }

  async function devicesAndScreens(): Promise<{ devices: CoopDevice[]; screens: CoopScreen[] }> {
    await prepareHelper()
    return helper.devices()
  }

  async function plan(gameId: string): Promise<CoopPlan> {
    const game = gameOf(gameId)
    const entry = await entryFor(game)
    const setup = game.user.coop
    const exe = await resolveCoopExe(game, entry, setup?.exePath)
    let devices: CoopDevice[] = []
    let screens: CoopScreen[] = []
    let deviceError: string | null = null
    try {
      ;({ devices, screens } = await devicesAndScreens())
    } catch (err) {
      deviceError = err instanceof Error ? err.message : String(err)
      log.warn(`Co-Op: devices not listed (${deviceError})`)
    }
    const planned = planSession({
      handler: entry,
      devices,
      screens,
      keyboardAllowed: settings.get().library.coopKeyboardMouse,
      twoPlayerLayout: settings.get().library.coopTwoPlayerLayout,
      setup
    })
    const problem = deviceError
      ? tMain('mainCoop.devicesFailed', { error: deviceError })
      : !exe.exePath
        ? tMain('mainCoop.exeMissing', {
            exe: entry.exeName ?? tMain('mainCoop.theGameExe'),
            title: game.title
          })
        : planned.problem
    return {
      gameId,
      exePath: exe.exePath,
      exeChoices: exe.choices,
      players: planned.players.length,
      maxPlayers: planned.maxPlayers,
      layout: planned.layout,
      devices: planned.available,
      assigned: planned.players.map((p) => p.device.id),
      screens,
      monitors: planned.screens.map((s) => ({
        ...s,
        players: planned.players.filter((p) => p.screen === s.index).length
      })),
      problem,
      risks: entry.risks
    }
  }

  async function play(gameId: string): Promise<void> {
    if (session || starting)
      throw new Error(
        session ? tMain('mainCoop.sessionRunning') : tMain('mainCoop.alreadyStarting')
      )
    starting = gameId
    try {
      await start(gameId)
    } finally {
      starting = null
    }
  }

  async function start(gameId: string): Promise<void> {
    const game = gameOf(gameId)
    const entry = await entryFor(game)
    if (entry.risks.length && !game.user.coop?.risksAccepted) throw new Error(RISK_NOT_ACCEPTED)
    const emit = (
      state: 'preparing' | 'starting' | 'running' | 'ended' | 'error',
      message?: string
    ): void => events.emit('coop:session', { gameId, state, message })
    emit('preparing', tMain('mainCoop.preparing'))
    try {
      // What is missing (a controller, the exe) is said before anything is downloaded or extracted.
      await prepareHelper()
      const setup = game.user.coop
      const exe = await resolveCoopExe(game, entry, setup?.exePath)
      if (!exe.exePath)
        throw new Error(
          tMain('mainCoop.exeMissing', {
            exe: entry.exeName ?? tMain('mainCoop.theGameExe'),
            title: game.title
          })
        )
      const { devices, screens } = await helper.devices()
      const planned = planSession({
        handler: entry,
        devices,
        screens,
        keyboardAllowed: settings.get().library.coopKeyboardMouse,
        twoPlayerLayout: settings.get().library.coopTwoPlayerLayout,
        setup
      })
      if (planned.problem) throw new Error(planned.problem)
      await prepareTools()
      const script = await pack.extract(entry, handlersDir)
      emit('starting', `Starting ${planned.players.length} players…`)
      const started = await helper.play(
        {
          handler: script,
          exePath: exe.exePath,
          screens: planned.screens,
          players: planned.players.map((p) => ({
            nickname: p.nickname,
            screen: p.screen,
            slot: p.slot,
            device: jobDevice(p.device)
          })),
          options: {},
          contentRoot: contentRootFor(exe.exePath, root, game.installDir)
        },
        (event) => {
          if (event.type === 'status' && typeof event.message === 'string')
            emit('starting', event.message)
          else if (event.type === 'started') emit('running')
          else if (event.type === 'error' && typeof event.message === 'string') {
            log.warn(`Co-Op: ${event.message}`)
            if (event.fatal) emit('error', event.message)
          }
        }
      )
      session = { gameId, helper: started }
      launcher.track(game, started.child)
      log.info(
        `Co-Op: ${game.title} with ${planned.players.length} players (${planned.screens.map((s) => s.layout).join(', ')})`
      )
      void started.done.then((reason) => {
        if (session?.helper === started) session = null
        log.info(`Co-Op: ${game.title} ended (${reason})`)
        emit('ended', reason)
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit('error', message)
      throw err
    }
  }

  async function status(): Promise<CoopStatus> {
    return {
      handlers: (await pack.index()).length,
      games: library.games().filter((g) => g.metadata.coop).length,
      busy: pack.busy(),
      toolsReady: await toolsReady(root),
      helperReady: helperShipped()
    }
  }

  return {
    kick(): void {
      if (disposed) return
      if (matching) {
        again = true
        return
      }
      matching = (async () => {
        do {
          again = false
          try {
            await matchAll()
          } catch (err) {
            log.error('Co-Op matching failed', err)
          }
        } while (again && !disposed)
        matching = null
      })()
    },
    status,
    async downloadHandlers(): Promise<CoopStatus> {
      const result = await pack.downloadAll()
      if (result.failed && result.downloaded === 0 && (await pack.index()).length === 0)
        throw new Error(tMain('mainCoop.handlersFailed'))
      await matchAll()
      return status()
    },
    plan,
    play,
    stop(gameId: string): void {
      if (session && session.gameId === gameId) session.helper.stop()
    },
    async removeHandler(gameId: string): Promise<void> {
      const game = gameOf(gameId)
      const info = game.metadata.coop
      if (!info) return
      const paths = extractedPaths(info.gameName, handlersDir)
      await fs.rm(paths.script, { force: true })
      await fs.rm(paths.folder, { recursive: true, force: true })
      await fs.rm(paths.stamp, { force: true })
      log.info(`Co-Op: the extracted handler of ${game.title} was removed`)
    },
    async handlerExtracted(gameId: string): Promise<boolean> {
      const info = library.getGame(gameId)?.metadata.coop
      return !!info && existsSync(extractedPaths(info.gameName, handlersDir).script)
    },
    startAutoDownload(options = {}): void {
      const firstDelayMs = options.firstDelayMs ?? 30_000
      const checkEveryMs = options.checkEveryMs ?? 6 * 60 * 60 * 1000
      const refreshAfterMs = options.refreshAfterMs ?? 7 * 24 * 60 * 60 * 1000
      const check = async (): Promise<void> => {
        if (disposed || pack.busy()) return
        try {
          const handlers = (await pack.index()).length
          const builtAt = Date.parse(await pack.builtAt())
          const stale = !(Date.now() - builtAt < refreshAfterMs)
          if (handlers > 0 && !stale) return
          log.info(
            handlers === 0
              ? 'Co-Op: no handlers on this PC yet; downloading the handler pack'
              : 'Co-Op: looking for new handlers (weekly)'
          )
          const result = await pack.downloadAll()
          log.info(
            `Co-Op: ${result.downloaded} handler(s) downloaded, ${result.failed} failed (automatic)`
          )
          if (!disposed) {
            await matchAll()
            // The matched games are in: the end report again, so Settings › Library re-reads its counts.
            events.emit('coop:progress', { stage: 'download', done: 0, total: 0 })
          }
        } catch (err) {
          // Offline or the folder unreachable: tried again at the next check.
          log.warn(
            `Co-Op: automatic handler download failed: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
      autoTimers.push(setTimeout(() => void check(), firstDelayMs))
      autoTimers.push(setInterval(() => void check(), checkEveryMs))
    },
    dispose(): void {
      disposed = true
      for (const t of autoTimers) clearTimeout(t)
      session?.helper.stop()
    }
  }
}
