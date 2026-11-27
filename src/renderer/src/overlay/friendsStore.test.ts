import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SteamFriendsStatus } from '@shared/friends'

const { api } = vi.hoisted(() => ({
  api: {
    getSteamFriends: vi.fn(),
    on: vi.fn(() => () => undefined)
  }
}))
vi.mock('../api/client', () => ({ api }))

const { FRIENDS_POLL_MS, useFriendsStore } = await import('./friendsStore')

const answer = (fetchedAt: number): SteamFriendsStatus => ({
  friends: [{ steamId: '76561198000000001', name: 'Kestrel', presence: 'online' }],
  fetchedAt
})

describe('friends store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    api.getSteamFriends.mockReset()
    useFriendsStore.setState({ status: null, busy: false })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads on open and every 60 s while the tab is open, and never after', async () => {
    api.getSteamFriends.mockImplementation(async () => answer(Date.now()))
    const stop = useFriendsStore.getState().watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.getSteamFriends).toHaveBeenCalledTimes(1)
    expect(useFriendsStore.getState().status?.friends).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(FRIENDS_POLL_MS - 1)
    expect(api.getSteamFriends).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.getSteamFriends).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(FRIENDS_POLL_MS)
    expect(api.getSteamFriends).toHaveBeenCalledTimes(3)
    // The tab closed (or the overlay did): nothing reads Steam any more.
    stop()
    await vi.advanceTimersByTimeAsync(FRIENDS_POLL_MS * 10)
    expect(api.getSteamFriends).toHaveBeenCalledTimes(3)
    // The last answer stays for the next open.
    expect(useFriendsStore.getState().status).not.toBeNull()
  })

  it('asks past the cache only on Refresh', async () => {
    api.getSteamFriends.mockResolvedValue(answer(1))
    await useFriendsStore.getState().refresh()
    await useFriendsStore.getState().refresh(true)
    expect(api.getSteamFriends.mock.calls).toEqual([[undefined], [{ refresh: true }]])
  })

  it('keeps the newest answer when an older one comes back last', async () => {
    let resolveFirst: (s: SteamFriendsStatus) => void = () => undefined
    api.getSteamFriends
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce(answer(2))
    const first = useFriendsStore.getState().refresh()
    await useFriendsStore.getState().refresh(true)
    resolveFirst(answer(1))
    await first
    expect(useFriendsStore.getState().status?.fetchedAt).toBe(2)
    expect(useFriendsStore.getState().busy).toBe(false)
  })

  it('keeps the friends shown when the call itself fails', async () => {
    api.getSteamFriends.mockResolvedValueOnce(answer(5)).mockRejectedValueOnce(new Error('ipc'))
    await useFriendsStore.getState().refresh()
    await useFriendsStore.getState().refresh()
    const status = useFriendsStore.getState().status
    expect(status?.friends).toHaveLength(1)
    expect(status?.error?.code).toBe('network')
  })
})
