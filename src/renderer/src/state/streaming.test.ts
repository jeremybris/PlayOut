import type {
  Game,
  PlayOutEvents,
  RemoteGameInfo,
  RemoteLibrary,
  StreamingStatus
} from '@shared/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store subscribes at import time: capture its listeners so the tests can play main's events.
const { listeners, api } = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => void>()
  const api = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    }),
    getStreamingStatus: vi.fn(),
    getRemoteLibrary: vi.fn(),
    refreshRemoteLibrary: vi.fn(),
    streamGame: vi.fn(),
    stopStream: vi.fn(),
    downloadRemoteRom: vi.fn(),
    cancelRemoteRomDownload: vi.fn()
  }
  return { listeners, api }
})
vi.mock('../api/client', () => ({ api }))

const { remoteFor, useStreamingStore } = await import('./streaming')
const { useUiStore } = await import('./ui')

function emit<E extends keyof PlayOutEvents>(event: E, payload: PlayOutEvents[E]): void {
  listeners.get(event)!(payload)
}

const info = (hostId: string, hostGameId: string): RemoteGameInfo => ({
  hostId,
  hostName: hostId === 'h1' ? 'Living Room PC' : 'Office PC',
  hostGameId,
  streamable: true,
  downloadable: false
})

const game = (id: string, remote?: RemoteGameInfo): Game =>
  ({ id, title: id, user: {}, remote }) as unknown as Game

const library = (): RemoteLibrary => ({
  games: [game('remote:h1:steam:2', info('h1', 'steam:2'))],
  alsoOnHost: { 'steam:1': [info('h1', 'steam:1'), info('h2', 'steam:1')] },
  updatedAt: '2026-11-07T00:00:00.000Z'
})

const toasts = (): string[] => useUiStore.getState().toasts.map((t) => `${t.kind}:${t.text}`)

beforeEach(() => {
  vi.clearAllMocks()
  useStreamingStore.setState({ status: null, remote: null, session: null, downloads: {} })
  useUiStore.setState({ toasts: [] })
})

describe('remoteFor', () => {
  it('gives the hosts that also have a local game, or a host-only game its own host', () => {
    const remote = library()
    expect(remoteFor(remote, 'steam:1').map((r) => r.hostId)).toEqual(['h1', 'h2'])
    expect(remoteFor(remote, 'remote:h1:steam:2')).toEqual([info('h1', 'steam:2')])
    expect(remoteFor(remote, 'steam:3')).toEqual([])
    expect(remoteFor(null, 'steam:1')).toEqual([])
    // The same empty array every time, so a selector does not re-render forever.
    expect(remoteFor(null, 'a')).toBe(remoteFor(remote, 'b'))
  })
})

describe('useStreamingStore', () => {
  it('subscribes to the six streaming events at import', () => {
    expect([...listeners.keys()].filter((e) => e.startsWith('streaming:')).sort()).toEqual([
      'streaming:download',
      'streaming:library',
      'streaming:logins',
      'streaming:session',
      'streaming:status',
      'streaming:updates'
    ])
  })

  it('toasts the updates and DLC a host sent for a game already here, and a failure', () => {
    emit('streaming:updates', { title: 'TotK', hostName: 'Den', files: 2, bytes: 1.5 * 1024 ** 3 })
    emit('streaming:updates', {
      title: 'TotK',
      hostName: 'Den',
      files: 0,
      bytes: 0,
      error: 'Not enough space'
    })
    expect(toasts()).toEqual([
      'success:TotK: 2 update and DLC file(s) (1.5 GB) downloaded from Den',
      'error:TotK: its updates and DLC could not be downloaded from Den: Not enough space'
    ])
  })

  it("toasts the services a paired host's logins filled", () => {
    emit('streaming:logins', { hostName: 'Living Room PC', services: ['SteamGridDB', 'Steam'] })
    expect(toasts()).toEqual(["success:Using Living Room PC's logins for SteamGridDB, Steam"])
  })

  it('load reads the status and the remote library, and keeps either when the other fails', async () => {
    api.getStreamingStatus.mockRejectedValue(new Error('no'))
    api.getRemoteLibrary.mockResolvedValue(library())
    await useStreamingStore.getState().load()
    expect(useStreamingStore.getState().status).toBeNull()
    expect(useStreamingStore.getState().remote?.games).toHaveLength(1)
  })

  it('follows the library and session events, and toasts a failed stream once', async () => {
    emit('streaming:library', library())
    expect(useStreamingStore.getState().remote?.alsoOnHost['steam:1']).toHaveLength(2)

    api.streamGame.mockImplementation(async () => {
      emit('streaming:session', {
        gameId: 'steam:1',
        hostId: 'h2',
        hostName: 'Office PC',
        state: 'error',
        message: 'Office PC is busy'
      })
      throw new Error("Error invoking remote method 'playout:streamGame': Error: busy")
    })
    await useStreamingStore.getState().streamGame(game('steam:1'), 'h2')
    expect(api.streamGame).toHaveBeenCalledWith('steam:1', 'h2')
    expect(toasts().filter((t) => t.startsWith('error:'))).toEqual(['error:Office PC is busy'])
    expect(useStreamingStore.getState().session?.state).toBe('error')
  })

  it('toasts a stream failure that came without a session event, without the IPC prefix', async () => {
    api.streamGame.mockRejectedValue(
      new Error("Error invoking remote method 'playout:streamGame': Error: No paired computer")
    )
    await useStreamingStore.getState().streamGame(game('steam:9'))
    expect(toasts()).toContain('error:Could not stream steam:9: No paired computer')
  })

  it('tracks ROM downloads; a cancelled one disappears', () => {
    const base = { gameId: 'remote:h1:rom:snes:x', hostId: 'h1', bytesTotal: 100 }
    emit('streaming:download', { ...base, state: 'downloading', bytesDone: 40, percent: 40 })
    expect(useStreamingStore.getState().downloads[base.gameId]?.percent).toBe(40)
    emit('streaming:download', { ...base, state: 'cancelled', bytesDone: 40, percent: 40 })
    expect(useStreamingStore.getState().downloads).toEqual({})
    emit('streaming:download', {
      ...base,
      state: 'done',
      bytesDone: 100,
      percent: 100,
      installedGameId: 'rom:snes:x'
    })
    expect(useStreamingStore.getState().downloads[base.gameId]?.state).toBe('done')
    expect(toasts().some((t) => t.startsWith('success:'))).toBe(true)
  })

  it('keeps a paused download quietly while its game is queued, and drops it once the game left the queue', () => {
    const paused = {
      gameId: 'remote:h:paused',
      hostId: 'h',
      state: 'paused' as const,
      bytesDone: 40,
      bytesTotal: 100,
      percent: 40
    }
    emit('streaming:download', paused)
    expect(useStreamingStore.getState().downloads[paused.gameId]?.percent).toBe(40)
    expect(toasts()).toEqual([])
    const queued = {
      gameId: paused.gameId,
      title: 'Paused',
      kind: 'host-rom' as const,
      source: 'host' as const,
      from: 'Living Room PC',
      state: 'waiting' as const,
      paused: true,
      addedAt: '2026-11-13T00:00:00.000Z'
    }
    emit('installs:queue', [queued])
    expect(useStreamingStore.getState().downloads[paused.gameId]).toBeDefined()
    emit('installs:queue', [])
    expect(useStreamingStore.getState().downloads[paused.gameId]).toBeUndefined()
  })

  it('says a host that went offline mid-download is waited for, not that the download failed', () => {
    const base = { gameId: 'remote:h:x', hostId: 'h', bytesDone: 0, bytesTotal: 100, percent: 0 }
    emit('streaming:download', {
      ...base,
      state: 'failed',
      message: 'Waiting for Living Room PC to come back',
      hostOffline: true
    })
    expect(toasts()).toContain('info:Waiting for Living Room PC to come back')
    expect(toasts().some((t) => t.startsWith('error:'))).toBe(false)
  })

  it('drops a host-offline wait once its host is back or its game left the queue, and keeps real failures', () => {
    const base = { hostId: 'h', bytesDone: 0, bytesTotal: 100, percent: 0 }
    const waiting = {
      ...base,
      gameId: 'remote:h:wait',
      state: 'failed' as const,
      message: 'Waiting for Living Room PC to come back online',
      hostOffline: true
    }
    const broken = {
      ...base,
      gameId: 'remote:h:bad',
      state: 'failed' as const,
      message: 'Disk full'
    }
    emit('streaming:download', waiting)
    emit('streaming:download', broken)
    const queued = {
      gameId: waiting.gameId,
      title: 'Wait',
      kind: 'host-rom' as const,
      source: 'host' as const,
      from: 'Living Room PC',
      state: 'waiting' as const,
      addedAt: '2026-11-13T00:00:00.000Z'
    }
    // Still queued and held back for its host: the wait stays (the queue row and game page show it).
    emit('installs:queue', [{ ...queued, waitingFor: waiting.message }])
    expect(useStreamingStore.getState().downloads[waiting.gameId]).toBeDefined()
    // The host answered again (no waitingFor) while another game downloads: the old wait goes.
    emit('installs:queue', [queued])
    expect(useStreamingStore.getState().downloads[waiting.gameId]).toBeUndefined()
    emit('streaming:download', waiting)
    // Removed from the queue: no stale "Waiting for…" + Retry; the real failure keeps its message.
    emit('installs:queue', [])
    expect(useStreamingStore.getState().downloads[waiting.gameId]).toBeUndefined()
    expect(useStreamingStore.getState().downloads[broken.gameId]?.message).toBe('Disk full')
  })

  it('passes downloads, cancels and stops through to the API', async () => {
    api.downloadRemoteRom.mockResolvedValue(undefined)
    api.cancelRemoteRomDownload.mockResolvedValue(undefined)
    api.stopStream.mockResolvedValue(undefined)
    const s = useStreamingStore.getState()
    await s.downloadRom(game('remote:h1:rom:snes:x'))
    await s.cancelDownload('remote:h1:rom:snes:x')
    await s.stopStream()
    expect(api.downloadRemoteRom).toHaveBeenCalledWith('remote:h1:rom:snes:x')
    expect(api.cancelRemoteRomDownload).toHaveBeenCalledWith('remote:h1:rom:snes:x')
    expect(api.stopStream).toHaveBeenCalled()
    // Started from a cover the menu closes: a toast says the download began.
    expect(toasts()).toContain('info:Downloading remote:h1:rom:snes:x…')
  })

  it('says a download waits in the install queue while another game downloads', async () => {
    const { useInstallQueueStore } = await import('./installQueue')
    api.downloadRemoteRom.mockResolvedValue(undefined)
    useInstallQueueStore.setState({
      entries: [
        {
          gameId: 'steam:9',
          title: 'Hades',
          kind: 'store',
          source: 'steam',
          from: 'Steam',
          state: 'active',
          addedAt: '2026-11-13T00:00:00.000Z'
        }
      ]
    })
    try {
      await useStreamingStore.getState().downloadRom(game('remote:h1:rom:snes:x'))
      expect(api.downloadRemoteRom).toHaveBeenCalledWith('remote:h1:rom:snes:x')
      expect(toasts()).toEqual(['info:remote:h1:rom:snes:x is queued; it starts after Hades'])
    } finally {
      useInstallQueueStore.setState({ entries: [] })
    }
  })

  it('says a download waits for its offline host, from the queue the call left', async () => {
    const { useInstallQueueStore } = await import('./installQueue')
    const waitingFor = 'Waiting for Living Room PC to come back online'
    api.downloadRemoteRom.mockImplementation(async () => {
      useInstallQueueStore.setState({
        entries: [
          {
            gameId: 'remote:h1:rom:snes:x',
            title: 'X',
            kind: 'host-rom',
            source: 'host',
            from: 'Living Room PC',
            state: 'waiting',
            addedAt: '2026-11-13T00:00:00.000Z',
            waitingFor
          }
        ]
      })
    })
    try {
      await useStreamingStore.getState().downloadRom(game('remote:h1:rom:snes:x'))
      expect(toasts()).toEqual([`info:${waitingFor}`])
      // Said once: the download's own 'failed' event already toasted it.
      await useStreamingStore.getState().downloadRom(game('remote:h1:rom:snes:x'))
      expect(toasts()).toEqual([`info:${waitingFor}`])
    } finally {
      useInstallQueueStore.setState({ entries: [] })
      api.downloadRemoteRom.mockReset()
    }
  })

  it('opens Settings > Library instead of downloading while no ROM folder is set', async () => {
    const { defaultSettings } = await import('@shared/defaults')
    const { useSettingsStore } = await import('./settings')
    const settings = defaultSettings()
    settings.library.romsRoot = null
    useSettingsStore.setState({ settings })
    try {
      await useStreamingStore.getState().downloadRom(game('remote:h1:rom:snes:x'))
      expect(api.downloadRemoteRom).not.toHaveBeenCalled()
      expect(toasts()).toEqual([
        'error:Choose an Emulation folder in Settings > Library to download ROMs'
      ])
      expect(useUiStore.getState().modals.at(-1)).toMatchObject({
        type: 'settings',
        section: 'library'
      })
    } finally {
      useSettingsStore.setState({ settings: null })
      useUiStore.setState({ modals: [] })
    }
  })

  it('says on the host when another PC has just paired, not for the ones it already knew', () => {
    const status = (clients: { id: string; name: string }[]): StreamingStatus =>
      ({
        host: { clients: clients.map((c) => ({ ...c, pairedAt: '2026-11-07T00:00:00.000Z' })) },
        client: { hosts: [] }
      }) as unknown as StreamingStatus
    emit('streaming:status', status([{ id: 'c1', name: 'Attic PC' }]))
    expect(toasts()).toEqual([])
    emit(
      'streaming:status',
      status([
        { id: 'c1', name: 'Attic PC' },
        { id: 'c2', name: 'Den' }
      ])
    )
    expect(toasts()).toEqual(['success:Den is now paired'])
  })
})
