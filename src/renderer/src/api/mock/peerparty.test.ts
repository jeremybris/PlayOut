import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeerPartyProgress } from '@shared/peerparty'
import { createMockApi } from './index'
import { MOCK_PEERPARTY_VERSION } from './peerparty'

function createStorageStub(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => {
      store.delete(key)
    },
    setItem: (key, value) => {
      store.set(key, String(value))
    }
  }
}

describe('mock PeerParty', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageStub())
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function idOf(api: ReturnType<typeof createMockApi>, title: string): Promise<string> {
    const { games } = await api.getLibrary()
    const game = games.find((g) => g.title === title && !g.remote)
    if (!game) throw new Error(`no ${title}`)
    return game.id
  }

  it('offers Portal 2 after its folder check and blocks Helldivers 2 for its anti-cheat', async () => {
    const api = createMockApi({ search: '' })
    const portal = await idOf(api, 'Portal 2')
    const first = await api.peerPartyStatus(portal)
    expect(first.checking).toBe(true)
    expect(first.supported).toBe(false)
    await vi.advanceTimersByTimeAsync(700)
    const status = await api.peerPartyStatus(portal)
    expect(status.supported).toBe(true)
    expect(status.services).toEqual(['steamworks', 'eos'])
    const helldivers = await idOf(api, 'Helldivers 2')
    await api.peerPartyStatus(helldivers)
    const blocked = await api.peerPartyStatus(helldivers)
    expect(blocked.supported).toBe(false)
    expect(blocked.blocked).toBe('anti-cheat')
  })

  it('downloads PeerParty on the first start, then runs the game with a session', async () => {
    const api = createMockApi({ search: '' })
    const portal = await idOf(api, 'Portal 2')
    const phases: PeerPartyProgress['phase'][] = []
    api.on('peerparty:progress', (p) => phases.push(p.phase))
    const sessions: (string | null)[] = []
    api.on('peerparty:session', ({ session }) => sessions.push(session?.gameId ?? null))
    const started = api.playWithPeerParty(portal)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await started).ok).toBe(true)
    expect(phases[0]).toBe('checking')
    expect(phases).toContain('downloading')
    expect(phases.at(-1)).toBe('done')
    expect(sessions).toEqual([portal])
    expect((await api.peerPartySession())?.gameId).toBe(portal)
    expect((await api.peerPartyStatus(portal)).installedVersion).toBe(MOCK_PEERPARTY_VERSION)
  })

  it('shows the overlay PeerParty tab only while a session runs (peerparty=1: on, 2 players)', async () => {
    const none = createMockApi({ search: '' })
    expect(await none.peerPartyOverlay()).toEqual({ active: false, lan: 'off' })
    const invited = none.peerPartyInvite()
    await vi.advanceTimersByTimeAsync(600)
    expect(await invited).toEqual({ result: 'none' })

    const api = createMockApi({ search: '?mock=1&overlay=1&peerparty=1' })
    // The overlay preview runs a game, through PeerParty with peerparty=1.
    const session = await api.peerPartySession()
    expect(session).not.toBeNull()
    expect(await api.peerPartyOverlay()).toEqual({
      active: true,
      gameTitle: session!.title,
      lan: 'on',
      players: 2
    })
    const sent = api.peerPartyInvite()
    await vi.advanceTimersByTimeAsync(600)
    expect(await sent).toEqual({ result: 'sent' })
  })

  it('lists the games L.A.N. Party shows', async () => {
    const api = createMockApi({ search: '' })
    const portal = await idOf(api, 'Portal 2')
    const { ids, scanning } = await api.peerPartyCompatible()
    expect(scanning).toBe(false)
    expect(ids).toContain(portal)
  })
})
