import type { HomeButtonStatus, OverrideStatus, PadButton, PadInfo } from '../../shared/overlay'
import type { PlayOutEventName, PlayOutEvents, Settings } from '../../shared/types'
import type { Logger } from '../logger'
import type { PadReader } from '../native-host/pad-reader'
import {
  createComboCapture,
  createComboMatcher,
  type ComboCapture,
  type ComboMatcher
} from './combo'
import { createGameBarOverride, type GameBarOverride } from './game-bar'
import { createRealIo, type HomeButtonIo } from './io'
import { createOverridesStore } from './overrides-store'
import {
  createSteamGuideOverride,
  STEAM_BUSY_MESSAGE,
  type SteamGuideOverride
} from './steam-guide'
import { detectWinhanced, winhancedClash, type WinhancedSettings } from './winhanced'
import { tMain } from '../i18n'

/**
 * The home button (docs/home-overlay.md): matches the controller reader's pads against the combo and calls onHome,
 * runs Settings' combo capture, keeps the Steam and Game Bar overrides in line with the settings, and checks for a
 * clash with Winhanced.
 *
 * Overrides are wanted while the home button is on, its combo uses Guide and the override's setting is on. Changes
 * run one at a time (a Steam restart takes up to 30 s and must not interleave with another), and each override is
 * only re-run when whether it is wanted changes, so an unrelated settings change never restarts Steam.
 */
export interface HomeButtonServiceDeps {
  settings: {
    get(): Settings
    onChange(listener: (settings: Settings) => void): () => void
  }
  padReader: Pick<PadReader, 'pads' | 'onPads' | 'status' | 'onStatus'>
  events: { emit<E extends PlayOutEventName>(event: E, payload: PlayOutEvents[E]): void }
  log: Logger
  /** userData\home-button: overrides.json and the Steam file backups. */
  dataDir: string
  /** The combo was pressed: open (or close) the overlay. */
  onHome: () => void
  /** The on-screen keyboard's buttons (Settings › Controls) were pressed: open the keyboard. */
  onKeyboard?: () => void
  /** Replaces parts of the real Windows access (tests). */
  io?: Partial<HomeButtonIo>
  now?: () => number
  /** How often to look for Winhanced (default 60 s; it may start after PlayOut). */
  winhancedCheckMs?: number
  /** A PlayOut game is running (Steam is not restarted then). */
  gameRunning?: () => boolean
  /** How soon a Steam change that waited for a game is tried again (default 60 s). */
  steamRetryMs?: number
  /** Replace the overrides (tests); built from io otherwise. */
  steam?: SteamGuideOverride
  gameBar?: GameBarOverride
}

export interface HomeButtonService {
  /** Subscribe and bring the overrides in line with the settings. Once; later calls do nothing. */
  start(): void
  status(): HomeButtonStatus
  /** Record a new combo: 'home:capture' events until every button is released. The combo does not fire meanwhile. */
  startCapture(): void
  stopCapture(): void
  /** Resolves when the override changes queued so far are done (tests; quitting). */
  idle(): Promise<void>
  dispose(): void
}

interface Wants {
  steam: boolean
  gameBar: boolean
}

/** A second fire within this long of the last one is the same press seen through another pad (ms). */
export const HOME_DEBOUNCE_MS = 500

function inputOf(settings: Settings): Settings['input'] {
  return settings.input
}

export function wantsOf(settings: Settings): Wants {
  const input = inputOf(settings)
  const guide = input.homeButtonEnabled && input.homeCombo.includes('guide')
  // Game Bar goes off whenever the home button is on: another launcher reading the Guide button (or View + Menu)
  // may open it, whatever PlayOut's own combo is.
  return {
    steam: guide && input.homeOverrideSteam,
    gameBar: input.homeButtonEnabled && input.homeOverrideGameBar
  }
}

/** What a status event carries apart from button presses (pads are reported on connect and disconnect only). */
function statusKey(s: HomeButtonStatus): string {
  return JSON.stringify({ ...s, pads: s.pads.map((p) => [p.id, p.name]) })
}

export function createHomeButtonService(deps: HomeButtonServiceDeps): HomeButtonService {
  const { settings, padReader, events, log } = deps
  const now = deps.now ?? Date.now
  const io: HomeButtonIo = { ...createRealIo(), ...deps.io }
  const store = createOverridesStore(io, deps.dataDir)
  const steam =
    deps.steam ??
    createSteamGuideOverride({
      io,
      store,
      dataDir: deps.dataDir,
      log,
      ...(deps.gameRunning ? { gameRunning: deps.gameRunning } : {})
    })
  let steamRetry: ReturnType<typeof setTimeout> | null = null
  const gameBar = deps.gameBar ?? createGameBarOverride({ run: io.run, store, log })

  let started = false
  let disposed = false
  const unsubscribers: (() => void)[] = []
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  let winhancedTimer: ReturnType<typeof setInterval> | null = null

  let matcher: ComboMatcher = newMatcher()
  let keyboardMatcher: ComboMatcher | null = newKeyboardMatcher()
  let comboKey = matcherKey()
  /** When the keyboard's buttons last fired (null: never). */
  let lastKeyboard: number | null = null
  let capture: ComboCapture | null = null
  /** When the combo last fired (null: never). */
  let lastFire: number | null = null

  let steamStatus: OverrideStatus = { state: 'off' }
  let gameBarStatus: OverrideStatus = { state: 'off' }
  let winhanced: WinhancedSettings | null = null
  let lastEmitted = ''

  /** What each override was last brought in line with (null: not yet). */
  const settled: { steam: boolean | null; gameBar: boolean | null } = { steam: null, gameBar: null }
  let queue: Promise<void> = Promise.resolve()
  let reconciling = false

  function combo(): PadButton[] {
    return inputOf(settings.get()).homeCombo
  }

  function matcherKey(): string {
    const input = inputOf(settings.get())
    return JSON.stringify([input.homeCombo, input.homeHoldMs, input.keyboardCombo ?? []])
  }

  /** The on-screen keyboard's buttons, at once (no hold time); null while none are set. */
  function newKeyboardMatcher(): ComboMatcher | null {
    const buttons = inputOf(settings.get()).keyboardCombo ?? []
    if (!buttons.length) return null
    const m = createComboMatcher({ combo: buttons, holdMs: 0, now })
    m.update(padReader.pads(), now())
    return m
  }

  function newMatcher(): ComboMatcher {
    const input = inputOf(settings.get())
    const m = createComboMatcher({ combo: input.homeCombo, holdMs: input.homeHoldMs, now })
    // Seed with the pads as they are, so buttons already held are not taken as a press.
    m.update(padReader.pads(), now())
    return m
  }

  function status(): HomeButtonStatus {
    const enabled = inputOf(settings.get()).homeButtonEnabled
    const clash = enabled && winhanced ? winhancedClash(combo(), winhanced) : undefined
    const reader = padReader.status()
    return {
      enabled,
      reader: reader.message
        ? { state: reader.state, message: reader.message }
        : { state: reader.state },
      pads: padReader.pads(),
      steam: steamStatus,
      gameBar: gameBarStatus,
      ...(clash ? { clash } : {})
    }
  }

  function emitStatus(): void {
    if (disposed) return
    const s = status()
    const key = statusKey(s)
    if (key === lastEmitted) return
    lastEmitted = key
    events.emit('home:status', s)
  }

  // --- the combo ---------------------------------------------------------------------------------------------------

  function feed(pads: PadInfo[]): void {
    const t = now()
    const fired = matcher.update(pads, t)
    const keyboard = keyboardMatcher?.update(pads, t) ?? false
    scheduleHold()
    if (keyboard && !capture && deps.onKeyboard) {
      // One controller seen as two pads fires twice: once is enough.
      if (lastKeyboard === null || t - lastKeyboard >= HOME_DEBOUNCE_MS) {
        lastKeyboard = t
        try {
          deps.onKeyboard()
        } catch (err) {
          log.error('on-screen keyboard handler failed', err)
        }
      }
    }
    if (fired && !capture && inputOf(settings.get()).homeButtonEnabled) {
      // One controller seen as both an XInput and an SDL pad fires twice, a poll or two apart: once is enough.
      if (lastFire !== null && t - lastFire < HOME_DEBOUNCE_MS) return
      lastFire = t
      try {
        deps.onHome()
      } catch (err) {
        log.error('home button handler failed', err)
      }
    }
  }

  /** With a hold time nothing new arrives while the combo is held, so a timer checks again when it is due. */
  function scheduleHold(): void {
    if (holdTimer) clearTimeout(holdTimer)
    holdTimer = null
    const due = matcher.pendingUntil()
    if (due === null || disposed) return
    holdTimer = setTimeout(
      () => {
        holdTimer = null
        feed(padReader.pads())
      },
      Math.max(0, due - now())
    )
  }

  function onPads(pads: PadInfo[]): void {
    if (capture) {
      const event = capture.feed(pads)
      if (event) events.emit('home:capture', event)
      if (capture.finished) {
        if (capture.rejected) log.info(`home combo capture rejected: ${capture.rejected}`)
        capture = null
      }
    }
    feed(pads)
    emitStatus()
  }

  // --- overrides ---------------------------------------------------------------------------------------------------

  function reconcile(): Promise<void> {
    if (reconciling) return queue
    reconciling = true
    queue = queue.then(async () => {
      try {
        // A Steam change that waited for a game is not tried again in this pass (the retry timer runs it later);
        // without this the loop would re-run it back to back for the whole game.
        let steamBusy = false
        // Loop: settings may change again while Steam closes.
        for (;;) {
          if (disposed) return
          const want = wantsOf(settings.get())
          if (want.steam !== settled.steam && !steamBusy) {
            settled.steam = want.steam
            const pending = (message: string) => () => {
              steamStatus = { state: 'pending', message }
              emitStatus()
            }
            steamStatus = want.steam
              ? await steam.apply(pending(tMain('mainApp.steamGuide.closingOff')))
              : await steam.restore(pending(tMain('mainApp.steamGuide.closingRestore')))
            if (steamStatus.state === 'pending' && steamStatus.message === STEAM_BUSY_MESSAGE) {
              // A game was running: nothing changed; try again in a while.
              settled.steam = null
              steamBusy = true
              if (steamRetry) clearTimeout(steamRetry)
              steamRetry = setTimeout(() => {
                steamRetry = null
                void reconcile()
              }, deps.steamRetryMs ?? 60_000)
            }
            emitStatus()
          } else if (want.gameBar !== settled.gameBar) {
            settled.gameBar = want.gameBar
            gameBarStatus = want.gameBar ? await gameBar.apply() : await gameBar.restore()
            emitStatus()
          } else {
            return
          }
        }
      } catch (err) {
        log.error('home button overrides failed', err)
      } finally {
        reconciling = false
      }
    })
    return queue
  }

  async function checkWinhanced(): Promise<void> {
    try {
      winhanced = await detectWinhanced(io)
    } catch (err) {
      log.warn('Winhanced check failed', err)
      winhanced = null
    }
    emitStatus()
  }

  function onSettings(): void {
    const key = matcherKey()
    if (key !== comboKey) {
      comboKey = key
      matcher = newMatcher()
      keyboardMatcher = newKeyboardMatcher()
      scheduleHold()
    }
    const want = wantsOf(settings.get())
    if (want.steam !== settled.steam || want.gameBar !== settled.gameBar) void reconcile()
    emitStatus()
  }

  return {
    start() {
      if (started || disposed) return
      started = true
      unsubscribers.push(padReader.onPads(onPads))
      unsubscribers.push(padReader.onStatus(() => emitStatus()))
      unsubscribers.push(settings.onChange(onSettings))
      matcher = newMatcher()
      keyboardMatcher = newKeyboardMatcher()
      comboKey = matcherKey()
      emitStatus()
      // Steam left closed by a PlayOut that quit or crashed mid-change is started first (before apply sees its files
      // already changed and returns without starting it).
      queue = queue
        .then(() => steam.recover())
        .catch((err: unknown) => log.warn('Steam restart check failed', err))
      void reconcile()
      void checkWinhanced()
      const every = deps.winhancedCheckMs ?? 60_000
      if (every > 0) {
        winhancedTimer = setInterval(() => void checkWinhanced(), every)
        ;(winhancedTimer as { unref?: () => void }).unref?.()
      }
    },
    status,
    startCapture() {
      capture = createComboCapture()
      // Pads holding buttons now are ignored until released (the press that started the capture).
      capture.feed(padReader.pads())
      events.emit('home:capture', { held: [] })
    },
    stopCapture() {
      capture = null
    },
    idle() {
      return queue
    },
    dispose() {
      disposed = true
      for (const off of unsubscribers.splice(0)) off()
      if (holdTimer) clearTimeout(holdTimer)
      if (winhancedTimer) clearInterval(winhancedTimer)
      if (steamRetry) clearTimeout(steamRetry)
      steamRetry = null
      holdTimer = null
      winhancedTimer = null
      capture = null
    }
  }
}
