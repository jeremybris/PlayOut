import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { api } = vi.hoisted(() => ({
  api: {
    peerPartyOverlay: vi.fn(),
    peerPartyInvite: vi.fn(),
    on: vi.fn(() => () => undefined)
  }
}))
vi.mock('../api/client', () => ({ api }))

const { PEERPARTY_POLL_MS, usePeerPartyOverlayStore } = await import('./peerPartyStore')

describe('PeerParty tab store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    api.peerPartyOverlay.mockReset()
    api.peerPartyInvite.mockReset()
    usePeerPartyOverlayStore.setState({ status: null, inviting: false, invite: null })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads on open and every 5 s while the tab is open, and never after', async () => {
    api.peerPartyOverlay.mockResolvedValue({ active: true, lan: 'on', players: 2 })
    const stop = usePeerPartyOverlayStore.getState().watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.peerPartyOverlay).toHaveBeenCalledTimes(1)
    expect(usePeerPartyOverlayStore.getState().status).toEqual({
      active: true,
      lan: 'on',
      players: 2
    })
    await vi.advanceTimersByTimeAsync(PEERPARTY_POLL_MS)
    expect(api.peerPartyOverlay).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(PEERPARTY_POLL_MS * 10)
    expect(api.peerPartyOverlay).toHaveBeenCalledTimes(2)
  })

  it('never shows the last open status when the tab opens again, nor a late answer after it closed', async () => {
    api.peerPartyOverlay.mockResolvedValue({
      active: true,
      gameTitle: 'Game A',
      lan: 'on',
      players: 3
    })
    const stopA = usePeerPartyOverlayStore.getState().watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(usePeerPartyOverlayStore.getState().status?.gameTitle).toBe('Game A')
    // A read still in flight when the tab closes is dropped.
    let late: (v: unknown) => void = () => {}
    api.peerPartyOverlay.mockImplementationOnce(() => new Promise((r) => (late = r)))
    await vi.advanceTimersByTimeAsync(PEERPARTY_POLL_MS)
    stopA()
    expect(usePeerPartyOverlayStore.getState().status).toBeNull()
    late({ active: true, gameTitle: 'Game A', lan: 'on', players: 3 })
    await vi.advanceTimersByTimeAsync(0)
    expect(usePeerPartyOverlayStore.getState().status).toBeNull()
    // Opening again (even if the store was left with something) starts at "Checking PeerParty…".
    usePeerPartyOverlayStore.setState({ status: { active: false, lan: 'off' } })
    api.peerPartyOverlay.mockImplementationOnce(() => new Promise(() => {}))
    const stopB = usePeerPartyOverlayStore.getState().watch()
    expect(usePeerPartyOverlayStore.getState().status).toBeNull()
    stopB()
  })

  it('keeps the invite answer, one invite at a time, and an IPC failure as an error', async () => {
    let answer: (v: unknown) => void = () => {}
    api.peerPartyInvite.mockImplementation(() => new Promise((r) => (answer = r)))
    const first = usePeerPartyOverlayStore.getState().sendInvite()
    void usePeerPartyOverlayStore.getState().sendInvite()
    expect(usePeerPartyOverlayStore.getState().inviting).toBe(true)
    expect(api.peerPartyInvite).toHaveBeenCalledTimes(1)
    answer({ result: 'sent' })
    await first
    expect(usePeerPartyOverlayStore.getState()).toMatchObject({
      inviting: false,
      invite: { result: 'sent' }
    })
    api.peerPartyInvite.mockRejectedValueOnce(new Error('ipc'))
    await usePeerPartyOverlayStore.getState().sendInvite()
    expect(usePeerPartyOverlayStore.getState().invite).toEqual({
      result: 'error',
      message: 'The invite could not be sent'
    })
    // Opening the tab again starts without the old answer.
    api.peerPartyOverlay.mockResolvedValue({ active: false, lan: 'off' })
    usePeerPartyOverlayStore.getState().watch()()
    expect(usePeerPartyOverlayStore.getState().invite).toBeNull()
  })
})
