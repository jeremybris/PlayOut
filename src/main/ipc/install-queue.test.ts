import { describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  dialog: {},
  shell: {}
}))

import { createHandlers, type AppServices } from './handlers'

interface Fixture {
  installs: { pauseInstall: Mock; resumeInstall: Mock }
  handlers: ReturnType<typeof createHandlers>
}

function services(): Fixture {
  const installs = { pauseInstall: vi.fn(), resumeInstall: vi.fn() }
  return {
    installs,
    handlers: createHandlers({
      installs,
      log: { error: vi.fn(), warn: vi.fn() },
      window: { get: () => null }
    } as unknown as AppServices)
  }
}

describe('pauseInstall / resumeInstall', () => {
  it('pass a game id (a store id or a remote: id) or null for every game', async () => {
    const { installs, handlers } = services()
    await handlers.pauseInstall('steam:620')
    await handlers.pauseInstall(null)
    await handlers.resumeInstall('remote:host-1:rom:snes:mmx')
    await handlers.resumeInstall(null)
    expect(installs.pauseInstall.mock.calls).toEqual([['steam:620'], [null]])
    expect(installs.resumeInstall.mock.calls).toEqual([['remote:host-1:rom:snes:mmx'], [null]])
  })

  it('refuses anything else', async () => {
    const { installs, handlers } = services()
    for (const bad of ['', 'x'.repeat(601), 42, undefined, { gameId: 'steam:1' }]) {
      await expect(handlers.pauseInstall(bad as never)).rejects.toThrow()
      await expect(handlers.resumeInstall(bad as never)).rejects.toThrow()
    }
    expect(installs.pauseInstall).not.toHaveBeenCalled()
    expect(installs.resumeInstall).not.toHaveBeenCalled()
  })
})
