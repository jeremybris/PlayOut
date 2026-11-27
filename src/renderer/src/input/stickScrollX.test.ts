import { afterEach, describe, expect, it, vi } from 'vitest'
import { popLayer, pushLayer, resetActionBus, ROOT_LAYER } from './actions'
import { dispatchStickX, registerStickX } from './stickScrollX'

describe('dispatchStickX (the right stick held left / right)', () => {
  const offs: Array<() => void> = []
  afterEach(() => {
    for (const off of offs.splice(0)) off()
    resetActionBus()
  })

  it('reaches the scroller on the top layer only (a modal over the Library takes the stick)', () => {
    const library = vi.fn(() => true)
    offs.push(registerStickX(ROOT_LAYER, library))
    expect(dispatchStickX(0.5, 16)).toBe(true)
    expect(library).toHaveBeenCalledWith(0.5, 16)

    pushLayer('modal')
    expect(dispatchStickX(0.5, 16)).toBe(false)
    expect(library).toHaveBeenCalledTimes(1)
    popLayer('modal')
    expect(dispatchStickX(-1, 16)).toBe(true)
    expect(library).toHaveBeenCalledTimes(2)
  })

  it('asks the latest registration first, and goes on when one passes (nothing to scroll)', () => {
    const older = vi.fn(() => true)
    const newer = vi.fn(() => false)
    offs.push(registerStickX(ROOT_LAYER, older))
    offs.push(registerStickX(ROOT_LAYER, newer))
    expect(dispatchStickX(1, 16)).toBe(true)
    expect(newer).toHaveBeenCalledTimes(1)
    expect(older).toHaveBeenCalledTimes(1)
  })

  it('does nothing once unregistered', () => {
    const handler = vi.fn(() => true)
    const off = registerStickX(ROOT_LAYER, handler)
    off()
    expect(dispatchStickX(1, 16)).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })
})
