import { describe, expect, it, vi } from 'vitest'
import type { OverlayExtrasStatus } from '@shared/overlay-extras'

// The store subscribes at import time: capture its listeners so the tests can play main's events.
const { listeners, api } = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => void>()
  const api = {
    getOverlayExtras: vi.fn(),
    getLiveStats: vi.fn(),
    setFrameLimit: vi.fn(),
    setCpuBoost: vi.fn(),
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    })
  }
  return { listeners, api }
})
vi.mock('../api/client', () => ({ api }))

const { LIVE_STATS_TIMEOUT_MS, OVERLAY_TABS, railTabs, tabForRail, useOverlayStore } =
  await import('./overlayStore')
const { useUiStore } = await import('../state/ui')

function confirm(title: string): void {
  useUiStore.getState().openModal({
    type: 'confirm',
    title,
    message: '',
    confirmLabel: 'OK',
    onConfirm: () => undefined
  })
}

describe('overlay store: PeerParty in the place of Friends', () => {
  it('shows PeerParty where Friends is while a PeerParty game runs, and Friends again after', () => {
    expect(railTabs(false)).toEqual(OVERLAY_TABS)
    expect(railTabs(true)).toEqual([
      'performance',
      'music',
      'display',
      'downloads',
      'peerparty',
      'settings',
      'power'
    ])
    expect(railTabs(true).indexOf('peerparty')).toBe(OVERLAY_TABS.indexOf('friends'))
    expect(tabForRail('friends', true)).toBe('peerparty')
    expect(tabForRail('peerparty', false)).toBe('friends')
    expect(tabForRail('music', true)).toBe('music')
  })

  it('moves the user on Friends to PeerParty when a session starts, and back when it ends', () => {
    const store = (): ReturnType<typeof useOverlayStore.getState> => useOverlayStore.getState()
    store().setPeerParty(false)
    store().setTab('friends')
    store().setPeerParty(true)
    expect(store()).toMatchObject({ peerParty: true, tab: 'peerparty' })
    // Friends asked for while PeerParty stands in its place shows PeerParty.
    store().setTab('friends')
    expect(store().tab).toBe('peerparty')
    store().setPeerParty(false)
    expect(store()).toMatchObject({ peerParty: false, tab: 'friends' })
    // Another tab stays as it is.
    store().setTab('display')
    store().setPeerParty(true)
    expect(store().tab).toBe('display')
    store().setPeerParty(false)
    store().setTab('performance')
  })
})

describe('overlay store', () => {
  it('closes every dialog when the overlay closes, so none comes back at the next open', () => {
    listeners.get('overlay:state')!({ open: true, gameId: 'x' })
    confirm('Close X?')
    confirm('Shut down?')
    expect(useUiStore.getState().modals).toHaveLength(2)

    listeners.get('overlay:state')!({ open: false })
    expect(useUiStore.getState().modals).toEqual([])
    expect(useOverlayStore.getState().open).toBe(false)

    listeners.get('overlay:state')!({ open: true, gameId: 'y' })
    expect(useUiStore.getState().modals).toEqual([])
    expect(useOverlayStore.getState().gameId).toBe('y')
  })

  it('stays closed in the window overlay page while the overlay is drawn inside a game', () => {
    listeners.get('overlay:state')!({ open: false })
    listeners.get('overlay:state')!({ open: true, program: 'Spel2.exe', ingame: true })
    expect(useOverlayStore.getState().open).toBe(false)
    listeners.get('overlay:state')!({ open: true, program: 'Spel2.exe' })
    expect(useOverlayStore.getState().open).toBe(true)
    listeners.get('overlay:state')!({ open: false })
  })

  it('keeps a dialog opened while the overlay stays open', () => {
    listeners.get('overlay:state')!({ open: true })
    confirm('Restart?')
    listeners.get('overlay:state')!({ open: true, gameId: 'z' })
    expect(useUiStore.getState().modals).toHaveLength(1)
    useUiStore.getState().closeAll()
  })
})

const extras = (fps: number): OverlayExtrasStatus => ({
  rtss: { state: 'running', version: '7.3.7' },
  rtssTiles: true,
  osdTile: true,
  frameLimit: { available: true, fps, chosen: fps, options: [0, 60], exe: 'Game.exe' },
  sync: { enabled: false, available: true, hz: 60 },
  perfOverlay: { level: 0, available: true, drawing: false },
  autoHdr: { enabled: true, hdrOn: true, available: true, note: 'Applies to games started next' },
  cpuBoost: { enabled: true, available: true, profile: 'balanced', overridden: false }
})

describe('overlay store: extras', () => {
  it('reads the extras at each open and follows overlay:extras', async () => {
    listeners.get('overlay:state')!({ open: false })
    api.getOverlayExtras.mockResolvedValueOnce(extras(30))
    listeners.get('overlay:state')!({ open: true })
    await vi.waitFor(() => expect(useOverlayStore.getState().extras?.frameLimit.fps).toBe(30))
    // Staying open (a new game under it) does not read again.
    listeners.get('overlay:state')!({ open: true, gameId: 'g' })
    expect(api.getOverlayExtras).toHaveBeenCalledTimes(1)

    listeners.get('overlay:extras')!(extras(45))
    expect(useOverlayStore.getState().extras?.frameLimit.fps).toBe(45)
  })

  it('keeps a change’s answer and toasts the main process’s sentence on failure', async () => {
    api.setFrameLimit.mockResolvedValueOnce(extras(60))
    await useOverlayStore.getState().setFrameLimit(60)
    expect(useOverlayStore.getState().extras?.frameLimit.fps).toBe(60)

    const toast = vi.spyOn(useUiStore.getState(), 'toast')
    api.setFrameLimit.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'setFrameLimit': Error: Needs RivaTuner Statistics Server"
      )
    )
    await useOverlayStore.getState().setFrameLimit(30)
    expect(toast).toHaveBeenLastCalledWith('Needs RivaTuner Statistics Server', 'error')

    api.setCpuBoost.mockRejectedValueOnce(new TypeError('x is not a function'))
    await useOverlayStore.getState().setCpuBoost(false)
    expect(toast).toHaveBeenLastCalledWith('Could not change CPU boost', 'error')
    expect(useOverlayStore.getState().extras?.frameLimit.fps).toBe(60)
    toast.mockRestore()
  })

  it('clears the live reading when it fails and when the overlay closes', async () => {
    api.getLiveStats.mockResolvedValueOnce({ fps: 90, fpsSource: 'rtss', watts: 12 })
    await useOverlayStore.getState().refreshLive()
    expect(useOverlayStore.getState().live?.fps).toBe(90)
    api.getLiveStats.mockRejectedValueOnce(new Error('gone'))
    await useOverlayStore.getState().refreshLive()
    expect(useOverlayStore.getState().live).toBeNull()

    api.getLiveStats.mockResolvedValueOnce({ fps: 90, fpsSource: 'rtss', watts: 12 })
    await useOverlayStore.getState().refreshLive()
    listeners.get('overlay:state')!({ open: false })
    expect(useOverlayStore.getState().live).toBeNull()
  })

  it('drops a live reading that answers after the overlay closed', async () => {
    listeners.get('overlay:state')!({ open: true })
    let answer: (v: unknown) => void = () => undefined
    api.getLiveStats.mockReturnValueOnce(new Promise((r) => (answer = r)))
    const pending = useOverlayStore.getState().refreshLive()
    // A second tick while the first is in flight is skipped (readings never land out of order).
    await useOverlayStore.getState().refreshLive()
    expect(api.getLiveStats).toHaveBeenCalledTimes(1)
    listeners.get('overlay:state')!({ open: false })
    answer({ fps: 144, fpsSource: 'rtss', watts: 20 })
    await pending
    expect(useOverlayStore.getState().live).toBeNull()
    listeners.get('overlay:state')!({ open: true })
    expect(useOverlayStore.getState().live).toBeNull()
    listeners.get('overlay:state')!({ open: false })
  })

  it('polls again when a live reading never answers, and drops its late answer', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      listeners.get('overlay:state')!({ open: true })
      api.getLiveStats.mockClear()
      let answer: (v: unknown) => void = () => undefined
      api.getLiveStats.mockReturnValueOnce(new Promise((r) => (answer = r)))
      const hung = useOverlayStore.getState().refreshLive()

      // Still inside the bound: the tick is skipped.
      vi.setSystemTime(1_000_000 + LIVE_STATS_TIMEOUT_MS - 1)
      await useOverlayStore.getState().refreshLive()
      expect(api.getLiveStats).toHaveBeenCalledTimes(1)

      // Past it: the hung call is given up and the next tick asks again.
      vi.setSystemTime(1_000_000 + LIVE_STATS_TIMEOUT_MS)
      api.getLiveStats.mockResolvedValueOnce({ fps: 60, fpsSource: 'rtss', watts: 10 })
      await useOverlayStore.getState().refreshLive()
      expect(api.getLiveStats).toHaveBeenCalledTimes(2)
      expect(useOverlayStore.getState().live?.fps).toBe(60)

      // The hung call answers at last: its stale reading is not shown and it does not disturb the polling.
      answer({ fps: 144, fpsSource: 'rtss', watts: 20 })
      await hung
      expect(useOverlayStore.getState().live?.fps).toBe(60)
      api.getLiveStats.mockResolvedValueOnce({ fps: 61, fpsSource: 'rtss', watts: 10 })
      await useOverlayStore.getState().refreshLive()
      expect(api.getLiveStats).toHaveBeenCalledTimes(3)
      expect(useOverlayStore.getState().live?.fps).toBe(61)
    } finally {
      listeners.get('overlay:state')!({ open: false })
      vi.useRealTimers()
    }
  })

  it('a late failure of a given-up live call does not clear the newer reading', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(2_000_000)
      listeners.get('overlay:state')!({ open: true })
      let fail: (e: unknown) => void = () => undefined
      api.getLiveStats.mockReturnValueOnce(new Promise((_r, reject) => (fail = reject)))
      const hung = useOverlayStore.getState().refreshLive()
      vi.setSystemTime(2_000_000 + LIVE_STATS_TIMEOUT_MS)
      api.getLiveStats.mockResolvedValueOnce({ fps: 60, fpsSource: 'rtss', watts: 10 })
      await useOverlayStore.getState().refreshLive()
      fail(new Error('gone'))
      await hung
      expect(useOverlayStore.getState().live?.fps).toBe(60)
    } finally {
      listeners.get('overlay:state')!({ open: false })
      vi.useRealTimers()
    }
  })

  it('says when the extras could not be read, until a reading comes', async () => {
    useOverlayStore.setState({ extras: null, extrasUnavailable: false })
    api.getOverlayExtras.mockRejectedValueOnce(new Error('not ready'))
    await useOverlayStore.getState().refreshExtras()
    expect(useOverlayStore.getState().extrasUnavailable).toBe(true)
    expect(useOverlayStore.getState().extras).toBeNull()
    api.getOverlayExtras.mockResolvedValueOnce(extras(30))
    await useOverlayStore.getState().refreshExtras()
    expect(useOverlayStore.getState().extrasUnavailable).toBe(false)
    useOverlayStore.setState({ extrasUnavailable: true })
    listeners.get('overlay:extras')!(extras(45))
    expect(useOverlayStore.getState().extrasUnavailable).toBe(false)
  })
})
