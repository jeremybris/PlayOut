import { describe, expect, it, vi } from 'vitest'
import { broadcastWindows, EventBus, type BroadcastTarget } from './events'

function win(destroyed = false): BroadcastTarget & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  return { send, webContents: { send }, isDestroyed: () => destroyed }
}

describe('broadcastWindows', () => {
  const main = win()
  const overlay = win()
  const signIn = win()
  const all = (): BroadcastTarget[] => [main, overlay, signIn]

  it('sends to the one named window', () => {
    expect(broadcastWindows(main, all)).toEqual([main])
  })
  it('sends to every named window, once each', () => {
    expect(broadcastWindows([main, null, overlay, main], all)).toEqual([main, overlay])
  })
  it('falls back to every window when none is named', () => {
    expect(broadcastWindows(null, all)).toEqual(all())
    expect(broadcastWindows(undefined, all)).toEqual(all())
    expect(broadcastWindows([null, undefined], all)).toEqual(all())
  })
  it('skips a destroyed named window without falling back', () => {
    const gone = win(true)
    expect(broadcastWindows(gone, all)).toEqual([])
    expect(broadcastWindows([gone, overlay], all)).toEqual([overlay])
  })
})

describe('EventBus', () => {
  it('broadcasts and calls listeners', () => {
    const broadcast = vi.fn()
    const bus = new EventBus(broadcast)
    const listener = vi.fn()
    const off = bus.on('overlay:state', listener)
    bus.emit('overlay:state', { open: true })
    expect(broadcast).toHaveBeenCalledWith(expect.any(String), {
      event: 'overlay:state',
      payload: { open: true }
    })
    expect(listener).toHaveBeenCalledWith({ open: true })
    off()
    bus.emit('overlay:state', { open: false })
    expect(listener).toHaveBeenCalledTimes(1)
  })
  it('survives a throwing broadcast', () => {
    const bus = new EventBus(() => {
      throw new Error('gone')
    })
    const listener = vi.fn()
    bus.on('overlay:state', listener)
    bus.emit('overlay:state', { open: true })
    expect(listener).toHaveBeenCalled()
  })
})
