import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  dialog: {},
  shell: {}
}))

import { createHandlers, type AppServices } from './handlers'

function services(): {
  steamDlc: {
    steamDlc: ReturnType<typeof vi.fn>
    setSteamDlc: ReturnType<typeof vi.fn>
    openSteamDlcPage: ReturnType<typeof vi.fn>
  }
  handlers: ReturnType<typeof createHandlers>
} {
  const steamDlc = {
    steamDlc: vi.fn(async () => ({})),
    setSteamDlc: vi.fn(async () => ({ ok: true })),
    openSteamDlcPage: vi.fn(async () => undefined)
  }
  return {
    steamDlc,
    handlers: createHandlers({
      steamDlc,
      log: { error: vi.fn(), warn: vi.fn() },
      window: { get: () => null }
    } as unknown as AppServices)
  }
}

describe('Steam DLC handlers', () => {
  it('pass a game id and the DLC to turn off', async () => {
    const { steamDlc, handlers } = services()
    await handlers.steamDlc('steam:251470')
    await handlers.setSteamDlc('steam:251470', [337840, 337850])
    await handlers.setSteamDlc('steam:251470', [])
    await handlers.openSteamDlcPage('steam:251470')
    expect(steamDlc.steamDlc.mock.calls).toEqual([['steam:251470']])
    expect(steamDlc.setSteamDlc.mock.calls).toEqual([
      ['steam:251470', [337840, 337850]],
      ['steam:251470', []]
    ])
    expect(steamDlc.openSteamDlcPage.mock.calls).toEqual([['steam:251470']])
  })

  it('refuses bad ids and DLC lists', async () => {
    const { steamDlc, handlers } = services()
    for (const bad of ['', 'x'.repeat(501), 42, null]) {
      await expect(handlers.steamDlc(bad as never)).rejects.toThrow()
      await expect(handlers.openSteamDlcPage(bad as never)).rejects.toThrow()
      await expect(handlers.setSteamDlc(bad as never, [])).rejects.toThrow()
    }
    for (const bad of [[0], [-1], [1.5], ['1'], 'x', null, new Array(2001).fill(1)]) {
      await expect(handlers.setSteamDlc('steam:1', bad as never)).rejects.toThrow()
    }
    expect(steamDlc.steamDlc).not.toHaveBeenCalled()
    expect(steamDlc.setSteamDlc).not.toHaveBeenCalled()
    expect(steamDlc.openSteamDlcPage).not.toHaveBeenCalled()
  })
})
