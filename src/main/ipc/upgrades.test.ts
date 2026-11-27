import { describe, expect, it, vi } from 'vitest'
import { upgradeRunningMessage } from '../../shared/upgrades'
import { tMain } from '../i18n'
import { createHandlers, type AppServices } from './handlers'

function services(busy: string | null = null): {
  upgrades: Record<
    'upgradeStatus' | 'runUpgrade' | 'cancelUpgrade' | 'busyFor',
    ReturnType<typeof vi.fn>
  >
  coop: { play: ReturnType<typeof vi.fn> }
  handlers: ReturnType<typeof createHandlers>
} {
  const upgrades = {
    upgradeStatus: vi.fn(async () => ({})),
    runUpgrade: vi.fn(async () => ({})),
    cancelUpgrade: vi.fn(async () => undefined),
    busyFor: vi.fn(() => busy)
  }
  const coop = { play: vi.fn(async () => undefined) }
  const handlers = createHandlers({
    upgrades,
    coop,
    log: { error: vi.fn(), warn: vi.fn() },
    window: { get: () => null }
  } as unknown as AppServices)
  return { upgrades, coop, handlers }
}

describe('Upgrade menu handlers', () => {
  it('pass a game id and a valid action to the upgrades service', async () => {
    const { upgrades, handlers } = services()
    await handlers.upgradeStatus('steam:620')
    await handlers.runUpgrade('steam:620', { kind: 'compress', algorithm: 'lzx' })
    await handlers.runUpgrade('steam:620', { kind: 'dlls-update' })
    await handlers.cancelUpgrade('steam:620')
    expect(upgrades.upgradeStatus).toHaveBeenCalledWith('steam:620')
    expect(upgrades.runUpgrade.mock.calls).toEqual([
      ['steam:620', { kind: 'compress', algorithm: 'lzx' }],
      ['steam:620', { kind: 'dlls-update' }]
    ])
    expect(upgrades.cancelUpgrade).toHaveBeenCalledWith('steam:620')
  })

  it('refuses unknown actions, algorithms and bad ids', async () => {
    const { upgrades, handlers } = services()
    const bad = [
      ['steam:620', { kind: 'format-drive' }],
      ['steam:620', { kind: 'compress', algorithm: 'lznt1' }],
      ['steam:620', { kind: 'compress' }],
      ['', { kind: 'dlls-update' }]
    ] as const
    for (const [id, action] of bad)
      await expect(handlers.runUpgrade(id, action as never)).rejects.toThrow()
    await expect(handlers.upgradeStatus(42 as never)).rejects.toThrow()
    expect(upgrades.runUpgrade).not.toHaveBeenCalled()
  })

  it('refuses Co-Op while an upgrade is changing the game, and starts it otherwise', async () => {
    const busy = services('compress')
    await expect(busy.handlers.playCoop('steam:620')).rejects.toThrow(upgradeRunningMessage(tMain))
    expect(busy.coop.play).not.toHaveBeenCalled()
    const idle = services()
    await idle.handlers.playCoop('steam:620')
    expect(idle.coop.play).toHaveBeenCalledWith('steam:620')
  })
})
