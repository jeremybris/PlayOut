import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import {
  maskOf,
  type ComboCaptureEvent,
  type HomeButtonStatus,
  type PadButton,
  type PadInfo
} from '../../shared/overlay'
import type { Settings } from '../../shared/types'
import type { ReaderStatus } from '../native-host/pad-reader'
import type { GameBarOverride } from './game-bar'
import {
  createHomeButtonService,
  HOME_DEBOUNCE_MS,
  wantsOf,
  type HomeButtonServiceDeps
} from './service'
import { STEAM_BUSY_MESSAGE, type SteamGuideOverride } from './steam-guide'
import { createFakeWindows, silentLog } from './testing'

function pad(id: string, ...buttons: PadButton[]): PadInfo {
  return { id, name: `Pad ${id}`, buttons: maskOf(buttons) }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test fixture
function createFakes(input: Partial<Settings['input']> = {}) {
  let settings = defaultSettings()
  settings = { ...settings, input: { ...settings.input, ...input } }
  const settingsListeners = new Set<(s: Settings) => void>()
  let pads: PadInfo[] = []
  const padListeners = new Set<(p: PadInfo[]) => void>()
  let reader: ReaderStatus = { state: 'running' }
  const statusListeners = new Set<(s: ReaderStatus) => void>()
  const emitted: { event: string; payload: unknown }[] = []
  const onHome = vi.fn()
  const w = createFakeWindows()
  /** Added to Date.now (works with fake timers too). */
  let clockOffset = 0

  const steamCalls: string[] = []
  const gameBarCalls: string[] = []
  let releaseSteam: (() => void) | null = null
  let holdSteam = false
  let steamBusy = false
  const steam: SteamGuideOverride = {
    async apply(onPending) {
      steamCalls.push('apply')
      if (steamBusy) return { state: 'pending', message: STEAM_BUSY_MESSAGE }
      if (holdSteam) {
        onPending?.()
        await new Promise<void>((r) => (releaseSteam = r))
      }
      return { state: 'applied' }
    },
    async restore() {
      steamCalls.push('restore')
      if (steamBusy) return { state: 'pending', message: STEAM_BUSY_MESSAGE }
      return { state: 'off' }
    },
    async recover() {
      steamCalls.push('recover')
    }
  }
  const gameBar: GameBarOverride = {
    async apply() {
      gameBarCalls.push('apply')
      return { state: 'already' }
    },
    async restore() {
      gameBarCalls.push('restore')
      return { state: 'off' }
    }
  }

  const deps: HomeButtonServiceDeps = {
    settings: {
      get: () => settings,
      onChange(l) {
        settingsListeners.add(l)
        return () => settingsListeners.delete(l)
      }
    },
    padReader: {
      pads: () => pads,
      onPads(l) {
        padListeners.add(l)
        return () => padListeners.delete(l)
      },
      status: () => reader,
      onStatus(l) {
        statusListeners.add(l)
        return () => statusListeners.delete(l)
      }
    },
    events: { emit: (event, payload) => emitted.push({ event, payload }) },
    log: silentLog,
    dataDir: 'C:\\data\\home-button',
    onHome,
    io: w.io,
    steam,
    gameBar,
    winhancedCheckMs: 0,
    now: () => Date.now() + clockOffset
  }

  return {
    deps,
    w,
    onHome,
    emitted,
    steamCalls,
    gameBarCalls,
    advance(ms: number) {
      clockOffset += ms
    },
    steamBusy(on: boolean) {
      steamBusy = on
    },
    holdSteam(on: boolean) {
      holdSteam = on
    },
    releaseSteam() {
      releaseSteam?.()
    },
    setPads(next: PadInfo[]) {
      pads = next
      for (const l of padListeners) l(next)
    },
    setReader(next: ReaderStatus) {
      reader = next
      for (const l of statusListeners) l(next)
    },
    setInput(patch: Partial<Settings['input']>) {
      settings = { ...settings, input: { ...settings.input, ...patch } }
      for (const l of settingsListeners) l(settings)
    },
    statuses: () =>
      emitted.filter((e) => e.event === 'home:status').map((e) => e.payload as HomeButtonStatus),
    captures: () =>
      emitted.filter((e) => e.event === 'home:capture').map((e) => e.payload as ComboCaptureEvent),
    listenerCount: () => padListeners.size + statusListeners.size + settingsListeners.size
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('wantsOf', () => {
  it('wants the Steam override only with a Guide combo, and Game Bar off whenever the home button is on', () => {
    const s = defaultSettings()
    expect(wantsOf(s)).toEqual({ steam: true, gameBar: true })
    expect(wantsOf({ ...s, input: { ...s.input, homeCombo: ['view', 'menu'] } })).toEqual({
      steam: false,
      gameBar: true
    })
    expect(wantsOf({ ...s, input: { ...s.input, homeButtonEnabled: false } })).toEqual({
      steam: false,
      gameBar: false
    })
    expect(wantsOf({ ...s, input: { ...s.input, homeOverrideSteam: false } })).toEqual({
      steam: false,
      gameBar: true
    })
  })
})

describe('home button service', () => {
  it('calls onHome when the combo is pressed', () => {
    const f = createFakes()
    const service = createHomeButtonService(f.deps)
    service.start()
    f.setPads([pad('xinput:0')])
    f.setPads([pad('xinput:0', 'guide')])
    f.setPads([pad('xinput:0', 'guide')])
    expect(f.onHome).toHaveBeenCalledOnce()
    f.advance(HOME_DEBOUNCE_MS)
    f.setPads([pad('xinput:0')])
    f.setPads([pad('xinput:0', 'guide')])
    expect(f.onHome).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('opens the on-screen keyboard on its buttons (none by default), also with the home button off', () => {
    const f = createFakes({ homeButtonEnabled: false })
    const onKeyboard = vi.fn()
    const service = createHomeButtonService({ ...f.deps, onKeyboard })
    service.start()
    // Not set: L3 + R3 does nothing.
    f.setPads([pad('p')])
    f.setPads([pad('p', 'ls', 'rs')])
    expect(onKeyboard).not.toHaveBeenCalled()
    f.setInput({ keyboardCombo: ['ls', 'rs'] })
    f.setPads([pad('p')])
    f.setPads([pad('p', 'ls', 'rs')])
    f.setPads([pad('p', 'ls', 'rs')])
    expect(onKeyboard).toHaveBeenCalledOnce()
    expect(f.onHome).not.toHaveBeenCalled()
    // Cleared: nothing again.
    f.setInput({ keyboardCombo: [] })
    f.advance(HOME_DEBOUNCE_MS)
    f.setPads([pad('p')])
    f.setPads([pad('p', 'ls', 'rs')])
    expect(onKeyboard).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('does nothing while the home button is off, and follows a new combo', () => {
    const f = createFakes({ homeButtonEnabled: false })
    const service = createHomeButtonService(f.deps)
    service.start()
    f.setPads([pad('p')])
    f.setPads([pad('p', 'guide')])
    expect(f.onHome).not.toHaveBeenCalled()
    f.setInput({ homeButtonEnabled: true, homeCombo: ['lb', 'rb'] })
    f.setPads([pad('p')])
    f.setPads([pad('p', 'guide')])
    expect(f.onHome).not.toHaveBeenCalled()
    f.setPads([pad('p', 'lb', 'rb')])
    expect(f.onHome).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('does not fire for buttons already held when the combo changes', () => {
    const f = createFakes()
    const service = createHomeButtonService(f.deps)
    service.start()
    f.setPads([pad('p', 'lb', 'rb')])
    f.setInput({ homeCombo: ['lb', 'rb'] })
    f.setPads([pad('p', 'lb', 'rb', 'a')])
    expect(f.onHome).not.toHaveBeenCalled()
    service.dispose()
  })

  it('waits for the hold time with a timer', () => {
    vi.useFakeTimers({ now: 1000 })
    const f = createFakes({ homeHoldMs: 400 })
    const service = createHomeButtonService(f.deps)
    service.start()
    f.setPads([pad('p')])
    f.setPads([pad('p', 'guide')])
    vi.advanceTimersByTime(399)
    expect(f.onHome).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(f.onHome).toHaveBeenCalledOnce()

    // Released early: no fire.
    f.setPads([pad('p')])
    f.setPads([pad('p', 'guide')])
    vi.advanceTimersByTime(200)
    f.setPads([pad('p')])
    vi.advanceTimersByTime(1000)
    expect(f.onHome).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('records a combo without opening the overlay, then works again', () => {
    const f = createFakes()
    const service = createHomeButtonService(f.deps)
    service.start()
    // The A press that started the capture is still held.
    f.setPads([pad('p', 'a')])
    service.startCapture()
    expect(f.captures()).toEqual([{ held: [] }])
    f.setPads([pad('p')])
    f.setPads([pad('p', 'guide')])
    f.setPads([pad('p', 'guide', 'lb')])
    f.setPads([pad('p')])
    expect(f.captures()).toEqual([
      { held: [] },
      { held: ['guide'] },
      { held: ['lb', 'guide'] },
      { held: ['lb', 'guide'], done: ['lb', 'guide'] }
    ])
    expect(f.onHome).not.toHaveBeenCalled()
    // Capture over: the old combo fires again.
    f.setPads([pad('p', 'guide')])
    expect(f.onHome).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('stopCapture ends a capture early', () => {
    const f = createFakes()
    const service = createHomeButtonService(f.deps)
    service.start()
    f.setPads([pad('p')])
    service.startCapture()
    f.setPads([pad('p', 'x')])
    service.stopCapture()
    f.setPads([pad('p')])
    expect(f.captures().some((c) => c.done)).toBe(false)
    f.setPads([pad('p', 'guide')])
    expect(f.onHome).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('applies both overrides at start, once', async () => {
    const f = createFakes()
    const service = createHomeButtonService(f.deps)
    service.start()
    service.start()
    await service.idle()
    expect(f.steamCalls).toEqual(['recover', 'apply'])
    expect(f.gameBarCalls).toEqual(['apply'])
    expect(service.status()).toMatchObject({
      enabled: true,
      steam: { state: 'applied' },
      gameBar: { state: 'already' }
    })
    // Unrelated settings changes do not run them again.
    f.setInput({ deadzone: 0.3 })
    f.setInput({ homeHoldMs: 200 })
    await service.idle()
    expect(f.steamCalls).toEqual(['recover', 'apply'])
    service.dispose()
  })

  it('restores when the combo stops using Guide or an override is turned off', async () => {
    const f = createFakes()
    const service = createHomeButtonService(f.deps)
    service.start()
    await service.idle()
    f.setInput({ homeOverrideGameBar: false })
    await service.idle()
    expect(f.gameBarCalls).toEqual(['apply', 'restore'])
    expect(f.steamCalls).toEqual(['recover', 'apply'])
    f.setInput({ homeCombo: ['view', 'menu'] })
    await service.idle()
    expect(f.steamCalls).toEqual(['recover', 'apply', 'restore'])
    expect(service.status()).toMatchObject({ steam: { state: 'off' }, gameBar: { state: 'off' } })
    service.dispose()
  })

  it('restores leftovers at start when the overrides are not wanted', async () => {
    const f = createFakes({ homeButtonEnabled: false })
    const service = createHomeButtonService(f.deps)
    service.start()
    await service.idle()
    expect(f.steamCalls).toEqual(['recover', 'restore'])
    expect(f.gameBarCalls).toEqual(['restore'])
    service.dispose()
  })

  it('serializes: shows pending while Steam closes and follows the latest setting', async () => {
    const f = createFakes()
    f.holdSteam(true)
    const service = createHomeButtonService(f.deps)
    service.start()
    await vi.waitFor(() => expect(service.status().steam.state).toBe('pending'))
    expect(service.status().steam.message).toMatch(/Closing Steam/)
    // Turned off and on and off again while Steam closes: one restore after the apply, nothing in parallel.
    f.setInput({ homeOverrideSteam: false })
    f.setInput({ homeOverrideSteam: true })
    f.setInput({ homeOverrideSteam: false })
    expect(f.steamCalls).toEqual(['recover', 'apply'])
    f.releaseSteam()
    await service.idle()
    expect(f.steamCalls).toEqual(['recover', 'apply', 'restore'])
    expect(f.gameBarCalls).toEqual(['apply'])
    expect(f.statuses().map((s) => s.steam.state)).toContain('pending')
    expect(service.status().steam.state).toBe('off')
    service.dispose()
  })

  it('emits status on reader and pad-set changes, not on every button press', () => {
    const f = createFakes()
    const service = createHomeButtonService(f.deps)
    service.start()
    const n0 = f.statuses().length
    f.setPads([pad('xinput:0')])
    expect(f.statuses().length).toBe(n0 + 1)
    f.setPads([pad('xinput:0', 'a')])
    f.setPads([pad('xinput:0')])
    expect(f.statuses().length).toBe(n0 + 1)
    f.setReader({ state: 'unavailable', message: 'no powershell' })
    expect(f.statuses().at(-1)?.reader).toEqual({ state: 'unavailable', message: 'no powershell' })
    service.dispose()
  })

  it('reports a Winhanced clash for a View + Menu combo', async () => {
    const f = createFakes({ homeCombo: ['view', 'menu'] })
    f.w.processes.add('WHService.exe')
    f.w.setText(
      'C:\\Users\\u\\AppData\\Local\\Winhanced\\appsettings.json',
      '{"StartSelectOpensGameBar":true}'
    )
    const service = createHomeButtonService(f.deps)
    service.start()
    await vi.waitFor(() => expect(service.status().clash).toMatch(/View \+ Menu/))
    f.setInput({ homeCombo: ['guide'] })
    expect(service.status().clash).toBeUndefined()
    expect(f.statuses().at(-1)?.clash).toBeUndefined()
    service.dispose()
  })

  it('unsubscribes on dispose', () => {
    const f = createFakes()
    const service = createHomeButtonService(f.deps)
    service.start()
    expect(f.listenerCount()).toBe(3)
    service.dispose()
    expect(f.listenerCount()).toBe(0)
  })

  it('fires once when one controller is seen as both an XInput and an SDL pad', () => {
    const f = createFakes()
    const service = createHomeButtonService(f.deps)
    service.start()
    f.setPads([pad('xinput:0'), pad('sdl:3')])
    // The Guide press reaches XInput first, SDL one poll later.
    f.setPads([pad('xinput:0', 'guide'), pad('sdl:3')])
    f.advance(16)
    f.setPads([pad('xinput:0', 'guide'), pad('sdl:3', 'guide')])
    expect(f.onHome).toHaveBeenCalledOnce()
    // Released on both and pressed again after the window: fires again.
    f.setPads([pad('xinput:0'), pad('sdl:3')])
    f.advance(HOME_DEBOUNCE_MS)
    f.setPads([pad('xinput:0', 'guide'), pad('sdl:3', 'guide')])
    expect(f.onHome).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('a Steam change that waits for a game is tried once per pass and the Game Bar is still applied', async () => {
    vi.useFakeTimers()
    const f = createFakes()
    f.steamBusy(true)
    const service = createHomeButtonService({ ...f.deps, steamRetryMs: 60_000 })
    service.start()
    await vi.advanceTimersByTimeAsync(0)
    await service.idle()
    expect(f.steamCalls).toEqual(['recover', 'apply'])
    expect(f.gameBarCalls).toEqual(['apply'])
    expect(service.status().steam).toEqual({ state: 'pending', message: STEAM_BUSY_MESSAGE })
    // The retry timer runs the next pass: one more apply, then it waits again.
    await vi.advanceTimersByTimeAsync(60_000)
    await service.idle()
    expect(f.steamCalls).toEqual(['recover', 'apply', 'apply'])
    expect(f.gameBarCalls).toEqual(['apply'])
    // The game ended: the next retry applies it.
    f.steamBusy(false)
    await vi.advanceTimersByTimeAsync(60_000)
    await service.idle()
    expect(f.steamCalls).toEqual(['recover', 'apply', 'apply', 'apply'])
    expect(service.status().steam.state).toBe('applied')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.steamCalls).toHaveLength(4)
    service.dispose()
  })

  it('a busy restore (override turned off mid-game) does not spin either', async () => {
    vi.useFakeTimers()
    const f = createFakes()
    const service = createHomeButtonService(f.deps)
    service.start()
    await vi.advanceTimersByTimeAsync(0)
    await service.idle()
    f.steamBusy(true)
    f.setInput({ homeOverrideSteam: false, homeOverrideGameBar: false })
    await vi.advanceTimersByTimeAsync(0)
    await service.idle()
    expect(f.steamCalls).toEqual(['recover', 'apply', 'restore'])
    expect(f.gameBarCalls).toEqual(['apply', 'restore'])
    service.dispose()
  })

  it('checks for a Steam left closed before applying the overrides', async () => {
    const f = createFakes()
    const service = createHomeButtonService(f.deps)
    service.start()
    await service.idle()
    expect(f.steamCalls[0]).toBe('recover')
    service.dispose()
  })
})
