import type { Game, PlayOutEvents, SteamDlcInfo, SteamDlcItem } from '@shared/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The module subscribes at import time: capture its listeners so the tests can play main's events.
const { listeners, api } = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => void>()
  const api = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    }),
    installGame: vi.fn(),
    setSteamDlc: vi.fn()
  }
  return { listeners, api }
})
vi.mock('../api/client', () => ({ api }))

const {
  canManageSteamDlc,
  choiceChanged,
  disabledFrom,
  dlcDescription,
  initialChoice,
  installSteamGame,
  picksSteamDlc
} = await import('./steamDlc')
const { useUiStore } = await import('./ui')

function emit<E extends keyof PlayOutEvents>(event: E, payload: PlayOutEvents[E]): void {
  listeners.get(event)!(payload)
}

const toasts = (): string[] => useUiStore.getState().toasts.map((t) => `${t.kind}:${t.text}`)

const item = (appId: number, over: Partial<SteamDlcItem> = {}): SteamDlcItem => ({
  appId,
  name: `DLC ${appId}`,
  sizeBytes: 2 * 1024 ** 3,
  owned: true,
  enabled: true,
  installed: false,
  pending: false,
  steamOnly: false,
  ...over
})

const info = (dlc: SteamDlcItem[], over: Partial<SteamDlcInfo> = {}): SteamDlcInfo => ({
  gameId: 'steam:10',
  appId: 10,
  installed: true,
  dlc,
  notOwnedCount: 0,
  steamRunning: true,
  blocked: null,
  plannedDisabled: null,
  ...over
})

const game = (over: Partial<Game> = {}): Game =>
  ({
    id: 'steam:10',
    title: 'Cyberpunk 2077',
    source: 'steam',
    installed: false,
    user: {},
    ...over
  }) as unknown as Game

beforeEach(() => {
  vi.clearAllMocks()
  useUiStore.setState({ toasts: [] })
})

describe('steam DLC choice helpers', () => {
  it('starts install picks from the planned choice (else all on) and Manage DLC from Steam', () => {
    const list = [
      item(1, { enabled: false }),
      item(2),
      item(3, { steamOnly: true, enabled: false })
    ]
    expect(initialChoice(info(list), 'manage')).toEqual({ 1: false, 2: true, 3: false })
    expect(initialChoice(info(list, { installed: false }), 'install')).toEqual({
      1: true,
      2: true,
      3: false
    })
    expect(initialChoice(info(list, { plannedDisabled: [2] }), 'install')).toMatchObject({
      1: true,
      2: false
    })
  })

  it('turns off the switched-off DLC and keeps what Steam has for Steam-only ones', () => {
    const list = [item(1), item(2), item(3, { steamOnly: true, enabled: false })]
    expect(disabledFrom(info(list), { 1: false, 2: true, 3: true })).toEqual([1, 3])
  })

  it('sees a change only when a switchable DLC differs from Steam', () => {
    const list = [item(1), item(2, { enabled: false })]
    expect(choiceChanged(info(list), { 1: true, 2: false })).toBe(false)
    expect(choiceChanged(info(list), { 1: false, 2: false })).toBe(true)
  })

  it('describes size, no download, Steam-only and the Manage DLC badges', () => {
    expect(dlcDescription(item(1), 'install')).toBe('2.0 GB')
    expect(dlcDescription(item(1, { sizeBytes: null }), 'install')).toBe(
      'No download (turns its content on or off)'
    )
    expect(dlcDescription(item(1, { steamOnly: true }), 'install')).toBe(
      '2.0 GB · Change it in Steam'
    )
    expect(dlcDescription(item(1, { installed: true }), 'manage')).toBe('2.0 GB · Installed')
    expect(dlcDescription(item(1, { installed: true, pending: true }), 'manage')).toBe(
      '2.0 GB · Change waiting for Steam'
    )
    expect(dlcDescription(item(1, { installed: true }), 'install')).toBe('2.0 GB')
  })

  it('offers the picker for a local Steam game to install and Manage DLC once installed', () => {
    expect(picksSteamDlc(game())).toBe(true)
    expect(picksSteamDlc(game({ installed: true }))).toBe(false)
    expect(picksSteamDlc(game({ source: 'epic' }))).toBe(false)
    expect(canManageSteamDlc(game({ installed: true }))).toBe(true)
    expect(canManageSteamDlc(game({ installed: true, remote: {} as Game['remote'] }))).toBe(false)
    expect(canManageSteamDlc(game())).toBe(false)
  })
})

describe('installSteamGame', () => {
  it('installs, then saves the DLC turned off', async () => {
    api.installGame.mockResolvedValue({ ok: true })
    api.setSteamDlc.mockResolvedValue({ ok: true, planned: true })
    await installSteamGame(game(), [5, 6])
    expect(api.installGame).toHaveBeenCalledWith('steam:10')
    expect(api.setSteamDlc).toHaveBeenCalledWith('steam:10', [5, 6])
    expect(toasts()).toEqual(['info:Installing Cyberpunk 2077 through Steam…'])
  })

  it('sends every-DLC-on too (it replaces an older choice), and nothing when the install was refused', async () => {
    api.installGame.mockResolvedValue({ ok: true })
    api.setSteamDlc.mockResolvedValue({ ok: true, planned: true })
    await installSteamGame(game(), [])
    expect(api.setSteamDlc).toHaveBeenCalledWith('steam:10', [])
    api.setSteamDlc.mockClear()
    api.installGame.mockResolvedValue({ ok: false, error: 'Steam is not installed.' })
    await installSteamGame(game(), [5])
    expect(api.setSteamDlc).not.toHaveBeenCalled()
    expect(toasts()).toContain('error:Steam is not installed.')
  })

  it('toasts a DLC choice that could not be saved', async () => {
    api.installGame.mockResolvedValue({ ok: true })
    api.setSteamDlc.mockResolvedValue({ ok: false, error: 'No appmanifest yet' })
    await installSteamGame(game(), [5])
    expect(toasts()).toContain('error:No appmanifest yet')
  })
})

describe("'steam-dlc:applied'", () => {
  it('toasts the applied choice or the error', () => {
    emit('steam-dlc:applied', { gameId: 'steam:10', title: 'Cyberpunk 2077', ok: true })
    emit('steam-dlc:applied', {
      gameId: 'steam:10',
      title: 'Cyberpunk 2077',
      ok: false,
      error: 'Steam did not close'
    })
    expect(toasts()).toEqual([
      'success:Cyberpunk 2077: DLC choices applied',
      'error:Steam did not close'
    ])
  })
})
