import { defaultSettings } from '@shared/defaults'
import type { OverlayState, PadInfo } from '@shared/overlay'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./actions', () => ({ dispatchAction: vi.fn(() => true) }))
vi.mock('./focus', () => ({ releaseEnter: vi.fn() }))
const scrollBox = { scrollTop: 0 } as unknown as HTMLElement
vi.mock('./stickScroll', () => ({
  stickScroll: vi.fn(),
  stickScrollTarget: vi.fn(() => scrollBox)
}))
vi.mock('../state/settings', () => ({ currentSettings: () => defaultSettings() }))
vi.mock('../state/ui', () => ({
  useUiStore: { getState: () => ({ setInputMethod: vi.fn() }) }
}))

import { dispatchAction } from './actions'
import { releaseEnter } from './focus'
import {
  STANDARD_BUTTONS,
  createOverlayPadSource,
  gamepadFromPad,
  isGamepadPaused,
  setGamepadNeedsFocus,
  setGamepadPaused,
  setGamepadSource,
  startGamepadPolling
} from './gamepad'
import { pauseGamepadWhileOverlayOpen } from './overlayPause'
import { stickScroll, stickScrollTarget } from './stickScroll'

/** One fake standard pad; `held` button indices are pressed, `axes` the sticks. */
function makePad(): { pad: Gamepad; held: Set<number>; axes: number[] } {
  const held = new Set<number>()
  const axes = [0, 0, 0, 0]
  const pad = {
    index: 0,
    id: 'Test pad',
    mapping: 'standard',
    connected: true,
    get axes() {
      return axes
    },
    get buttons() {
      return Array.from({ length: 17 }, (_, i) => ({
        pressed: held.has(i),
        touched: held.has(i),
        value: held.has(i) ? 1 : 0
      }))
    }
  } as unknown as Gamepad
  return { pad, held, axes }
}

let frameCallback: ((now: number) => void) | null = null
let focused = true
let visibility: 'visible' | 'hidden' = 'visible'
/** The window and document listeners the poller registered, by event type. */
const listeners = new Map<string, () => void>()
let clock = 0
let fake = makePad()
let stop: () => void = () => undefined

/** Run one animation frame `ms` after the last. */
function frame(ms = 16): void {
  clock += ms
  const callback = frameCallback
  frameCallback = null
  callback?.(clock)
}

const dispatched = (): string[] => vi.mocked(dispatchAction).mock.calls.map(([action]) => action)

describe('gamepad pause (the overlay open over PlayOut)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clock = 0
    fake = makePad()
    vi.stubGlobal('navigator', { getGamepads: () => [fake.pad] })
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      frameCallback = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      frameCallback = null
    })
    listeners.clear()
    const target = {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type)
    }
    vi.stubGlobal('window', target)
    focused = true
    visibility = 'visible'
    vi.stubGlobal('document', {
      ...target,
      get visibilityState() {
        return visibility
      },
      hasFocus: () => focused
    })
    // The animation frame's timestamp and performance.now() share one clock, as in the browser.
    vi.stubGlobal('performance', { now: () => clock })
    setGamepadPaused(false)
    stop = startGamepadPolling()
  })
  afterEach(() => {
    stop()
    setGamepadPaused(false)
    setGamepadNeedsFocus(false)
    vi.unstubAllGlobals()
  })

  it('scrolls the menu while the right stick is held when no screen takes its up / down', () => {
    vi.mocked(dispatchAction).mockImplementation(
      (action) => action !== 'rs-down' && action !== 'rs-up'
    )
    frame()
    fake.axes[3] = 1
    frame()
    frame()
    frame()
    expect(dispatched()).toEqual(['rs-down'])
    expect(stickScrollTarget).toHaveBeenCalledTimes(1)
    expect(vi.mocked(stickScroll).mock.calls.length).toBe(3)
    expect(vi.mocked(stickScroll).mock.calls.every(([el, d]) => el === scrollBox && d > 0)).toBe(
      true
    )
    // Let go: it stops.
    fake.axes[3] = 0
    frame()
    frame()
    expect(vi.mocked(stickScroll).mock.calls.length).toBe(3)
    // Up scrolls up.
    fake.axes[3] = -0.6
    frame()
    expect(vi.mocked(stickScroll).mock.calls.at(-1)![1]).toBeLessThan(0)
  })

  it('leaves the right stick to a screen that takes it (Home, the Library): no scrolling', () => {
    vi.mocked(dispatchAction).mockImplementation(() => true)
    frame()
    fake.axes[3] = 1
    frame()
    frame()
    expect(dispatched()).toEqual(['rs-down'])
    expect(stickScroll).not.toHaveBeenCalled()
  })

  it('ignores the pads while the window is not the active one (a game in front), when asked to', () => {
    setGamepadNeedsFocus(true)
    focused = false
    // The game's menu: A and directions pressed while PlayOut is behind it or on the other screen.
    fake.held.add(STANDARD_BUTTONS.a)
    frame()
    fake.held.add(STANDARD_BUTTONS.down)
    frame()
    frame(1000)
    expect(dispatched()).toEqual([])
    expect(isGamepadPaused()).toBe(false)

    // Back in PlayOut: what is still held from the game does not fire; a new press does.
    focused = true
    frame()
    frame(1000)
    expect(dispatched()).toEqual([])
    fake.held.clear()
    frame()
    fake.held.add(STANDARD_BUTTONS.a)
    frame()
    expect(dispatched()).toEqual(['accept'])
  })

  it('stops a held direction when the window loses the focus', () => {
    setGamepadNeedsFocus(true)
    fake.held.add(STANDARD_BUTTONS.right)
    frame()
    frame(1000)
    vi.mocked(dispatchAction).mockClear()
    focused = false
    for (let i = 0; i < 60; i++) frame()
    expect(dispatched()).toEqual([])
  })

  it('takes the press that first reveals a pad (Chromium shows a pad to a page only with a press)', () => {
    fake.held.add(STANDARD_BUTTONS.a)
    frame()
    expect(dispatched()).toEqual(['accept'])
  })

  it('never takes a button held across a hidden window (A still down from a game Exit) as a press', () => {
    fake.held.add(STANDARD_BUTTONS.down)
    frame()
    vi.mocked(dispatchAction).mockClear()
    visibility = 'hidden'
    listeners.get('visibilitychange')?.()
    // The game's Exit: A goes down while PlayOut is hidden, and is still down when it shows again.
    fake.held.clear()
    fake.held.add(STANDARD_BUTTONS.a)
    visibility = 'visible'
    listeners.get('visibilitychange')?.()
    frame()
    frame(1000)
    expect(dispatched()).toEqual([])
    fake.held.clear()
    frame()
    fake.held.add(STANDARD_BUTTONS.a)
    frame()
    expect(dispatched()).toEqual(['accept'])
  })

  it('settles on the window focus events even when no frame ran while it was away (minimized at once)', () => {
    setGamepadNeedsFocus(true)
    frame()
    // Minimized the moment the game started: no frame runs until PlayOut is back.
    listeners.get('blur')?.()
    fake.held.add(STANDARD_BUTTONS.a)
    clock += 5000
    listeners.get('focus')?.()
    frame()
    frame(100)
    expect(dispatched()).toEqual([])
    fake.held.clear()
    frame(500)
    fake.held.add(STANDARD_BUTTONS.a)
    frame()
    expect(dispatched()).toEqual(['accept'])
  })

  it('only records presses for a moment after the window becomes active again', () => {
    setGamepadNeedsFocus(true)
    focused = false
    frame()
    // Windows hands PlayOut the foreground while the game starts or closes, and A is pressed for the game right then.
    focused = true
    frame()
    fake.held.add(STANDARD_BUTTONS.a)
    frame(100)
    fake.held.clear()
    frame(100)
    expect(dispatched()).toEqual([])
    // Once settled, PlayOut takes presses again.
    frame(400)
    fake.held.add(STANDARD_BUTTONS.a)
    frame()
    expect(dispatched()).toEqual(['accept'])
  })

  it('without the focus requirement (the overlay window), reads the pads whatever has the focus', () => {
    focused = false
    fake.held.add(STANDARD_BUTTONS.a)
    frame()
    expect(dispatched()).toEqual(['accept'])
  })

  it('dispatches presses normally', () => {
    fake.held.add(STANDARD_BUTTONS.a)
    frame()
    expect(dispatched()).toEqual(['accept'])
  })

  it('dispatches nothing while paused, and a button held across the pause does not fire on resume', () => {
    setGamepadPaused(true)
    expect(isGamepadPaused()).toBe(true)
    fake.held.add(STANDARD_BUTTONS.a)
    frame()
    // B pressed in the overlay to close it: still held when the main window resumes.
    fake.held.add(STANDARD_BUTTONS.b)
    fake.held.add(STANDARD_BUTTONS.down)
    frame()
    frame(1000)
    expect(dispatched()).toEqual([])

    setGamepadPaused(false)
    frame()
    frame(1000)
    expect(dispatched()).toEqual([])

    // A new press after the resume counts.
    fake.held.delete(STANDARD_BUTTONS.b)
    frame()
    fake.held.add(STANDARD_BUTTONS.b)
    frame()
    expect(dispatched()).toEqual(['back'])
  })

  it('stops a held direction repeating when it pauses', () => {
    fake.held.add(STANDARD_BUTTONS.right)
    frame()
    frame(1000)
    const before = dispatched().length
    expect(before).toBeGreaterThanOrEqual(2)
    fake.held.add(STANDARD_BUTTONS.a)
    frame()
    vi.mocked(dispatchAction).mockClear()

    setGamepadPaused(true)
    expect(releaseEnter).toHaveBeenCalled()
    for (let i = 0; i < 60; i++) frame()
    expect(dispatched()).toEqual([])
  })

  it('follows overlay:state in the main window, starting from getOverlayState', async () => {
    let listener: ((state: OverlayState) => void) | null = null
    const source = {
      on: vi.fn((_event: string, l: (state: OverlayState) => void) => {
        listener = l
        return () => {
          listener = null
        }
      }),
      getOverlayState: vi.fn(async (): Promise<OverlayState> => ({ open: true }))
    }
    const off = pauseGamepadWhileOverlayOpen(source as never)
    await Promise.resolve()
    await Promise.resolve()
    expect(isGamepadPaused()).toBe(true)
    fake.held.add(STANDARD_BUTTONS.a)
    frame()
    expect(dispatched()).toEqual([])

    listener!({ open: false })
    expect(isGamepadPaused()).toBe(false)
    listener!({ open: true, gameId: 'g1' })
    expect(isGamepadPaused()).toBe(true)

    off()
    expect(isGamepadPaused()).toBe(false)
    expect(listener).toBeNull()
  })

  it('an overlay:state event that arrives before getOverlayState answers wins', async () => {
    let listener: ((state: OverlayState) => void) | null = null
    let answer: (state: OverlayState) => void = () => undefined
    const source = {
      on: (_event: string, l: (state: OverlayState) => void) => {
        listener = l
        return () => undefined
      },
      getOverlayState: () => new Promise<OverlayState>((resolve) => (answer = resolve))
    }
    const off = pauseGamepadWhileOverlayOpen(source as never)
    listener!({ open: false })
    answer({ open: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(isGamepadPaused()).toBe(false)
    off()
  })
})

describe('gamepadFromPad', () => {
  it('maps PadButton bits to the standard buttons, the triggers and the sticks', () => {
    const mask =
      (1 << STANDARD_BUTTONS.a) | (1 << STANDARD_BUTTONS.lt) | (1 << STANDARD_BUTTONS.guide)
    const pad = gamepadFromPad(
      { id: 'xinput:0', name: 'Pad', buttons: mask, axes: [0.5, -1, 0, 0.25], triggers: [0.75, 0] },
      2
    )
    expect(pad.index).toBe(2)
    expect(pad.mapping).toBe('standard')
    expect(pad.connected).toBe(true)
    expect(pad.axes).toEqual([0.5, -1, 0, 0.25])
    expect(pad.buttons).toHaveLength(17)
    expect(pad.buttons.map((b) => b.pressed)).toEqual(
      Array.from({ length: 17 }, (_, i) => i === 0 || i === 6 || i === 16)
    )
    expect(pad.buttons[STANDARD_BUTTONS.lt]!.value).toBe(0.75)
    expect(pad.buttons[STANDARD_BUTTONS.a]!.value).toBe(1)
    expect(pad.buttons[STANDARD_BUTTONS.rt]!.value).toBe(0)
  })

  it('without sticks or triggers sent: centred sticks, triggers from the button bits', () => {
    const pad = gamepadFromPad({ id: 'sdl:1', name: 'Old', buttons: 1 << STANDARD_BUTTONS.rt }, 0)
    expect(pad.axes).toEqual([0, 0, 0, 0])
    expect(pad.buttons[STANDARD_BUTTONS.rt]).toMatchObject({ pressed: true, value: 1 })
  })
})

describe('the in-game overlay pad source (overlay:pad)', () => {
  type Listener = (payload: never) => void
  const handlers = new Map<string, Listener>()
  const events = {
    on: (event: string, listener: Listener) => {
      handlers.set(event, listener)
      return () => handlers.delete(event)
    }
  }
  const emit = (event: string, payload: unknown): void => handlers.get(event)?.(payload as never)
  const sendPads = (pads: PadInfo[]): void => emit('overlay:pad', { pads })
  let tickCallback: (() => void) | null = null
  let source: ReturnType<typeof createOverlayPadSource>

  function tick(ms = 16): void {
    clock += ms
    tickCallback?.()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    clock = 0
    const rafCalls = vi.fn()
    vi.stubGlobal('navigator', { getGamepads: () => [] })
    vi.stubGlobal('requestAnimationFrame', rafCalls)
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    vi.stubGlobal('setInterval', (cb: () => void) => {
      tickCallback = cb
      return 7
    })
    vi.stubGlobal('clearInterval', () => {
      tickCallback = null
    })
    const target = { addEventListener: () => undefined, removeEventListener: () => undefined }
    vi.stubGlobal('window', target)
    vi.stubGlobal('document', { ...target, visibilityState: 'hidden', hasFocus: () => false })
    vi.stubGlobal('performance', { now: () => clock })
    source = createOverlayPadSource(events as never)
    setGamepadSource(source)
    // The overlay page asks for focus like the main window would: a source ignores it (never focused, never visible).
    setGamepadNeedsFocus(true)
    stop = startGamepadPolling()
    emit('overlay:state', { open: true })
  })
  afterEach(() => {
    stop()
    setGamepadSource(null)
    source.dispose()
    setGamepadNeedsFocus(false)
    vi.unstubAllGlobals()
  })

  const pad = (buttons: number, axes?: [number, number, number, number]): PadInfo => ({
    id: 'xinput:0',
    name: 'Controller 1 (XInput)',
    buttons,
    ...(axes ? { axes } : {})
  })
  const bit = (index: number): number => 1 << index

  it('polls on a timer, not animation frames, and ignores the focus and visibility gates', () => {
    expect(tickCallback).not.toBeNull()
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    sendPads([pad(0)])
    tick()
    sendPads([pad(bit(STANDARD_BUTTONS.a))])
    tick()
    expect(dispatched()).toEqual(['accept'])
  })

  it('only records the first reading after the overlay opens (the home combo still held)', () => {
    sendPads([pad(bit(STANDARD_BUTTONS.select) | bit(STANDARD_BUTTONS.start))])
    tick()
    tick(1000)
    expect(dispatched()).toEqual([])
    sendPads([pad(0)])
    tick()
    sendPads([pad(bit(STANDARD_BUTTONS.start))])
    tick()
    expect(dispatched()).toEqual(['start'])
  })

  it('moves with the left stick (up negative) and repeats like a held d-pad', () => {
    sendPads([pad(0)])
    tick()
    sendPads([pad(0, [0, -1, 0, 0])])
    tick()
    expect(dispatched()).toEqual(['up'])
    for (let i = 0; i < 60; i++) tick()
    expect(dispatched().length).toBeGreaterThan(2)
    expect(new Set(dispatched())).toEqual(new Set(['up']))
  })

  it('forgets every pad when the overlay closes and opens again (the B that closed it is not a press)', () => {
    sendPads([pad(0)])
    tick()
    sendPads([pad(bit(STANDARD_BUTTONS.b))])
    tick()
    expect(dispatched()).toEqual(['back'])
    vi.mocked(dispatchAction).mockClear()
    emit('overlay:state', { open: false })
    tick()
    emit('overlay:state', { open: true, ingame: true })
    // Reopened with the combo (A here) held while B is still down from before.
    sendPads([pad(bit(STANDARD_BUTTONS.b) | bit(STANDARD_BUTTONS.a))])
    tick()
    tick(100)
    expect(dispatched()).toEqual([])
    // Another overlay:state while open (the game changed) does not forget the pads.
    emit('overlay:state', { open: true, gameId: 'g1', ingame: true })
    // Nor does the window overlay opening (another page's overlay).
    emit('overlay:state', { open: true })
    sendPads([pad(bit(STANDARD_BUTTONS.b))])
    tick()
    sendPads([pad(0)])
    tick()
    sendPads([pad(bit(STANDARD_BUTTONS.y))])
    tick()
    expect(dispatched()).toEqual(['y'])
  })

  it('keeps each pad id at its index; a pad gone from the list is new when it comes back', () => {
    const second: PadInfo = { id: 'sdl:5', name: 'DualSense', buttons: 0 }
    sendPads([pad(0), second])
    tick()
    expect(source.getGamepads().map((p) => p?.index)).toEqual([0, 1])
    sendPads([{ ...second, buttons: bit(STANDARD_BUTTONS.x) }])
    expect(source.getGamepads()).toHaveLength(2)
    expect(source.getGamepads()[0]).toBeNull()
    tick()
    expect(dispatched()).toEqual(['x'])
    sendPads([])
    tick()
    sendPads([{ ...second, buttons: bit(STANDARD_BUTTONS.x) }])
    tick()
    expect(dispatched()).toEqual(['x'])
  })
})
