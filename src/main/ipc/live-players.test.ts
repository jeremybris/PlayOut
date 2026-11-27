import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  dialog: {},
  shell: {}
}))

import { createHandlers, type AppServices } from './handlers'

describe('refreshLivePlayers', () => {
  it("reads a game's player numbers, then answers with the game", async () => {
    const order: string[] = []
    const game = { id: 'steam:620', source: 'steam' }
    const metadata = {
      refreshLive: vi.fn(async (id: string) => {
        order.push(`refresh ${id}`)
      })
    }
    // getGameView: the game as shown (metadata edits laid over; LibraryService.view).
    const library = {
      getGameView: vi.fn((id: string) => {
        order.push(`get ${id}`)
        return id === 'steam:620' ? game : undefined
      })
    }
    const handlers = createHandlers({
      metadata,
      library,
      log: { error: vi.fn(), warn: vi.fn() },
      window: { get: () => null }
    } as unknown as AppServices)
    expect(await handlers.refreshLivePlayers('steam:620')).toBe(game)
    expect(order).toEqual(['refresh steam:620', 'get steam:620'])
    expect(await handlers.refreshLivePlayers('steam:1')).toBeNull()
    for (const bad of ['', 'x'.repeat(501), 42, null]) {
      await expect(handlers.refreshLivePlayers(bad as never)).rejects.toThrow()
    }
    expect(metadata.refreshLive).toHaveBeenCalledTimes(2)
  })
})

describe('refreshActivePlayers', () => {
  it('runs the Active Players read and resolves when it is through', async () => {
    let done = false
    const metadata = {
      refreshActivePlayers: vi.fn(async () => {
        await Promise.resolve()
        done = true
      })
    }
    const handlers = createHandlers({
      metadata,
      log: { error: vi.fn(), warn: vi.fn() },
      window: { get: () => null }
    } as unknown as AppServices)
    expect(await handlers.refreshActivePlayers()).toBeUndefined()
    expect(done).toBe(true)
    expect(metadata.refreshActivePlayers).toHaveBeenCalledTimes(1)
  })
})

describe('refreshHltbTimes', () => {
  it('runs the H.L.T.B. sort lookups and resolves when they are through', async () => {
    let done = false
    const metadata = {
      refreshHltbTimes: vi.fn(async () => {
        await Promise.resolve()
        done = true
      })
    }
    const handlers = createHandlers({
      metadata,
      log: { error: vi.fn(), warn: vi.fn() },
      window: { get: () => null }
    } as unknown as AppServices)
    expect(await handlers.refreshHltbTimes()).toBeUndefined()
    expect(done).toBe(true)
    expect(metadata.refreshHltbTimes).toHaveBeenCalledTimes(1)
  })
})

describe('stopHltbTimes', () => {
  it('stops the H.L.T.B. sort lookups', async () => {
    const metadata = { stopHltbTimes: vi.fn() }
    const handlers = createHandlers({
      metadata,
      log: { error: vi.fn(), warn: vi.fn() },
      window: { get: () => null }
    } as unknown as AppServices)
    expect(await handlers.stopHltbTimes()).toBeUndefined()
    expect(metadata.stopHltbTimes).toHaveBeenCalledTimes(1)
  })
})
