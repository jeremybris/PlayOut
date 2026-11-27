import type { Game, RemoteLibrary } from '@shared/types'
import { defaultSettings } from '@shared/defaults'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { api } = vi.hoisted(() => ({
  api: {
    on: vi.fn(() => () => {}),
    updateGame: vi.fn(),
    setRemoteFavorite: vi.fn(async () => {})
  }
}))
vi.mock('../api/client', () => ({ api }))

const { canFavorite, isFavorite, toggleFavorite } = await import('./favorite')
const { useStreamingStore } = await import('./streaming')
const { useSettingsStore } = await import('./settings')
const { useUiStore } = await import('./ui')

function hostGame(favorite: boolean): Game {
  return {
    id: 'remote:host-1:steam:9',
    source: 'steam',
    externalId: '9',
    platformId: 'steam',
    title: 'Celeste',
    sortTitle: 'celeste',
    installed: false,
    launch: { kind: 'uri', uri: '' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'done',
    user: {},
    remote: {
      hostId: 'host-1',
      hostName: 'Living Room',
      hostGameId: 'steam:9',
      streamable: true,
      downloadable: false
    }
  }
}

function showRemote(game: Game): void {
  const remote: RemoteLibrary = { games: [game], alsoOnHost: {}, updatedAt: '' }
  useStreamingStore.setState({ remote })
}

function syncFavorites(on: boolean): void {
  const settings = defaultSettings()
  settings.streaming.syncFavorites = on
  useSettingsStore.setState({ settings })
}

beforeEach(() => {
  api.setRemoteFavorite.mockClear()
  api.updateGame.mockClear()
  useUiStore.setState({ toasts: [] })
  syncFavorites(true)
})

describe("a paired host's game", () => {
  it("is a favourite when its host's is", () => {
    showRemote(hostGame(true))
    expect(isFavorite('remote:host-1:steam:9')).toBe(true)
    showRemote(hostGame(false))
    expect(isFavorite('remote:host-1:steam:9')).toBe(false)
  })

  it('toggles on its host through setRemoteFavorite (never updateGame)', async () => {
    showRemote(hostGame(false))
    toggleFavorite('remote:host-1:steam:9')
    await vi.waitFor(() => expect(useUiStore.getState().toasts).toHaveLength(1))
    expect(api.setRemoteFavorite).toHaveBeenCalledWith('remote:host-1:steam:9', true)
    expect(api.updateGame).not.toHaveBeenCalled()
    expect(useUiStore.getState().toasts[0]?.text).toBe('Added Celeste to favourites')
  })

  it('cannot be a favourite while the favourites sync is off', () => {
    syncFavorites(false)
    showRemote(hostGame(false))
    expect(canFavorite(hostGame(false), useSettingsStore.getState().settings!)).toBe(false)
    expect(canFavorite({}, useSettingsStore.getState().settings!)).toBe(true)
    toggleFavorite('remote:host-1:steam:9')
    expect(api.setRemoteFavorite).not.toHaveBeenCalled()
  })

  it("shows the host's refusal", async () => {
    api.setRemoteFavorite.mockRejectedValueOnce(new Error('Living Room could not be reached'))
    showRemote(hostGame(false))
    toggleFavorite('remote:host-1:steam:9')
    await vi.waitFor(() => expect(useUiStore.getState().toasts).toHaveLength(1))
    expect(useUiStore.getState().toasts[0]).toMatchObject({
      text: 'Living Room could not be reached',
      kind: 'error'
    })
  })
})
