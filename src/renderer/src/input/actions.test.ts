import { beforeEach, describe, expect, it, vi } from 'vitest'

// The action bus imports the focus engine, which needs a window; stub the few calls dispatchAction makes.
vi.mock('./focus', () => ({
  navigateByDirection: vi.fn(() => Promise.resolve()),
  pressArrow: vi.fn(() => false),
  pressEnter: vi.fn()
}))

import { navigateByDirection, pressArrow, pressEnter } from './focus'
import {
  ROOT_LAYER,
  addActionListener,
  dispatchAction,
  isInputFrozen,
  layerOrder,
  popLayer,
  pushLayer,
  registerActionHandlers,
  resetActionBus,
  setInputFrozen,
  topLayer,
  topLayerFocusKey
} from './actions'

describe('action bus', () => {
  beforeEach(() => {
    resetActionBus()
    vi.clearAllMocks()
  })

  it('routes directions to the focused element first, then to the focus engine', () => {
    expect(dispatchAction('left', 'keyboard')).toBe(true)
    expect(pressArrow).toHaveBeenCalledWith('left')
    expect(navigateByDirection).toHaveBeenCalledWith('left', { source: 'keyboard' })

    vi.mocked(pressArrow).mockReturnValueOnce(true)
    dispatchAction('right', 'gamepad')
    expect(navigateByDirection).toHaveBeenCalledTimes(1)
  })

  it('routes accept to the focused element', () => {
    expect(dispatchAction('accept', 'gamepad')).toBe(true)
    expect(pressEnter).toHaveBeenCalledTimes(1)
  })

  it('delivers button actions to the top layer only, newest registration first', () => {
    const root = vi.fn()
    const modal = vi.fn()
    registerActionHandlers(ROOT_LAYER, { back: root })
    expect(dispatchAction('back', 'gamepad')).toBe(true)
    expect(root).toHaveBeenCalledTimes(1)

    pushLayer('modal')
    expect(topLayer()).toBe('modal')
    expect(dispatchAction('back', 'gamepad')).toBe(false)
    registerActionHandlers('modal', { back: modal })
    dispatchAction('back', 'gamepad')
    expect(modal).toHaveBeenCalledTimes(1)
    expect(root).toHaveBeenCalledTimes(1)

    popLayer('modal')
    dispatchAction('back', 'gamepad')
    expect(root).toHaveBeenCalledTimes(2)
  })

  it('lets a handler decline so an earlier registration gets the action', () => {
    const first = vi.fn()
    const second = vi.fn(() => false)
    registerActionHandlers(ROOT_LAYER, { x: first })
    const off = registerActionHandlers(ROOT_LAYER, { x: second })
    dispatchAction('x', 'keyboard')
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
    off()
    dispatchAction('x', 'keyboard')
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(2)
  })

  it('never removes the root layer', () => {
    popLayer(ROOT_LAYER)
    expect(topLayer()).toBe(ROOT_LAYER)
  })

  it('remembers the container focus key of each layer for the top layer only', () => {
    expect(topLayerFocusKey()).toBeNull()
    pushLayer('search', 'search')
    pushLayer('detail', 'detail')
    expect(topLayerFocusKey()).toBe('detail')
    // The detail panel closes: the sheet underneath is the fallback for a vanished restore target.
    popLayer('detail')
    expect(topLayer()).toBe('search')
    expect(topLayerFocusKey()).toBe('search')
    popLayer('search')
    expect(topLayerFocusKey()).toBeNull()
    // A layer pushed without a key has none, and the key goes away with the layer.
    pushLayer('osk')
    expect(topLayerFocusKey()).toBeNull()
    pushLayer('detail', 'detail')
    resetActionBus()
    expect(topLayerFocusKey()).toBeNull()
  })
})

describe('action bus: frozen input and layer order', () => {
  beforeEach(() => {
    resetActionBus()
    vi.clearAllMocks()
  })

  it('drops directions and accept while frozen and lets buttons through', () => {
    const back = vi.fn()
    registerActionHandlers(ROOT_LAYER, { back })
    setInputFrozen(true)
    expect(isInputFrozen()).toBe(true)
    expect(dispatchAction('accept', 'gamepad')).toBe(false)
    expect(pressEnter).not.toHaveBeenCalled()
    expect(dispatchAction('down', 'gamepad')).toBe(false)
    expect(pressArrow).not.toHaveBeenCalled()
    expect(navigateByDirection).not.toHaveBeenCalled()
    expect(dispatchAction('back', 'gamepad')).toBe(true)
    expect(back).toHaveBeenCalledTimes(1)

    setInputFrozen(false)
    expect(dispatchAction('accept', 'gamepad')).toBe(true)
    expect(pressEnter).toHaveBeenCalledTimes(1)
    expect(dispatchAction('down', 'gamepad')).toBe(true)
    expect(navigateByDirection).toHaveBeenCalledTimes(1)
  })

  it('tells listeners about dropped actions and resets the freeze with the bus', () => {
    const seen = vi.fn()
    addActionListener(seen)
    setInputFrozen(true)
    dispatchAction('left', 'keyboard')
    expect(seen).toHaveBeenCalledWith('left', 'keyboard', false)
    resetActionBus()
    expect(isInputFrozen()).toBe(false)
  })

  it('orders layers by their push, with the root and unknown layers at 0', () => {
    expect(layerOrder(ROOT_LAYER)).toBe(0)
    expect(layerOrder('nope')).toBe(0)
    pushLayer('a')
    pushLayer('b')
    expect(layerOrder('b')).toBeGreaterThan(layerOrder('a'))
    expect(layerOrder('a')).toBeGreaterThan(0)
    // Re-pushing moves a layer to the top and makes it the newest.
    pushLayer('a')
    expect(topLayer()).toBe('a')
    expect(layerOrder('a')).toBeGreaterThan(layerOrder('b'))
    popLayer('a')
    expect(layerOrder('a')).toBe(0)
  })
})
