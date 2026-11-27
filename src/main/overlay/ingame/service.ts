import type { BrowserWindow } from 'electron'
import type { PadInfo } from '../../../shared/overlay'
import type { Game, Settings, SettingsPatch } from '../../../shared/types'
import type { Logger } from '../../logger'
import type { ForegroundWindow, OverlayTarget } from '../overlay-logic'
import { createFramePump, type FramePump } from './frame-pump'
import { createIngameGate, type IngameGate } from './gate'
import { createIngameHelper, type IngameHelper } from './helper'
import { createPipeServer } from './pipe-server'
import { createIngameSession, type IngameSession } from './session'

/**
 * The in-game overlay put together (docs/home-overlay.md, "In-game overlay"): the helper, the gate, the frame pump and
 * the session. The overlay suite creates it and hands it to the overlay window, which tries it first over a game in
 * true exclusive full screen.
 */

export interface IngameOverlayDeps {
  log: (name: string) => Logger
  settings: { get(): Settings; update(patch: SettingsPatch): unknown }
  running: () => { gameId: string } | null
  game: (id: string) => Game | undefined
  games: () => Game[]
  runningImages: () => Promise<Set<string> | null>
  /** resources\ingame (unpacked): PlayOutIngame64.exe and PlayOutOverlay64.dll. */
  helperDir: string
  preload: string
  /** Load index.html?overlay=1&ingame=1 into the offscreen window. */
  load: (win: BrowserWindow) => Promise<void>
  /** The display scale factor of the monitor a window is on. */
  scaleFactor: (fg: ForegroundWindow) => number
  pads: { pads(): PadInfo[] }
  /** Tell the user (a toast in the main window). */
  notify: (game: { id: string; title: string }, message: string) => void
}

export interface IngameOverlay {
  tryOpen(target: OverlayTarget, fg: ForegroundWindow, options: { hold: boolean }): Promise<boolean>
  close(): Promise<void>
  active(): boolean
  activePid(): number | null
  onEnded(listener: (why: string) => void): () => void
  /** Scan a game's folder for anti-cheat ahead of the first press. */
  prewarm(gameId: string): void
  /** The offscreen window, for the event broadcast. */
  window(): BrowserWindow | null
  dispose(): void
}

export function createIngameOverlay(deps: IngameOverlayDeps): IngameOverlay {
  const log = deps.log('ingame')
  let lastFg: ForegroundWindow | null = null
  const helper: IngameHelper = createIngameHelper({ log, dir: deps.helperDir })
  const gate: IngameGate = createIngameGate({
    log,
    settings: () => deps.settings.get(),
    running: deps.running,
    game: deps.game,
    games: deps.games,
    runningImages: deps.runningImages,
    helper
  })
  const pump: FramePump = createFramePump({
    log,
    preload: deps.preload,
    load: deps.load,
    scaleFactor: () => (lastFg ? deps.scaleFactor(lastFg) : 1)
  })
  const session: IngameSession = createIngameSession({
    log,
    gate,
    helper,
    createPipe: (gamePid) => createPipeServer({ log, gamePid }),
    pump,
    pads: deps.pads,
    settings: deps.settings,
    notify: deps.notify
  })
  return {
    tryOpen(target, fg, options) {
      lastFg = fg
      return session.tryOpen(target, fg, options)
    },
    close: () => session.close(),
    active: () => session.active(),
    activePid: () => session.activePid(),
    onEnded: (listener) => session.onEnded(listener),
    prewarm: (gameId) => gate.prewarm(gameId),
    window: () => pump.window(),
    dispose() {
      session.dispose()
      pump.dispose()
      helper.dispose()
    }
  }
}
