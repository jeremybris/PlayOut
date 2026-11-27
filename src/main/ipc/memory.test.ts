import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  dialog: {},
  shell: {}
}))

import type { MemoryStatus } from '../../shared/memory'
import { API_METHODS } from '../../shared/api'
import { createHandlers, type AppServices } from './handlers'

const STATUS: MemoryStatus = {
  enabled: true,
  running: false,
  systemWide: 'missing',
  last: {
    at: '2026-11-22T10:00:00.000Z',
    reason: 'manual',
    tier: 'user',
    beforeAvailableMb: 2140,
    afterAvailableMb: 2780,
    freedMb: 640,
    trimmed: 41,
    skipped: 118,
    denied: 62,
    steps: { workingSets: { state: 'done' } }
  }
}

function handlers(memory: { status: () => MemoryStatus; freeNow: () => Promise<MemoryStatus> }): {
  h: ReturnType<typeof createHandlers>
} {
  return {
    h: createHandlers({
      overlay: { memory },
      log: { error: vi.fn(), warn: vi.fn() },
      window: { get: () => null }
    } as unknown as AppServices)
  }
}

describe('memory cleanup handlers', () => {
  it('are part of the bridge', () => {
    expect(API_METHODS).toContain('getMemoryStatus')
    expect(API_METHODS).toContain('freeMemoryNow')
  })

  it('answer with the service status and run a pass from the button', async () => {
    const memory = {
      status: vi.fn(() => ({ ...STATUS, last: null })),
      freeNow: vi.fn(async () => STATUS)
    }
    const { h } = handlers(memory)
    expect(await h.getMemoryStatus()).toEqual({ ...STATUS, last: null })
    expect(await h.freeMemoryNow()).toBe(STATUS)
    expect(memory.freeNow).toHaveBeenCalledTimes(1)
  })

  it('takes nothing from the caller: what is trimmed is decided in main', async () => {
    const memory = { status: vi.fn(() => STATUS), freeNow: vi.fn(async () => STATUS) }
    const { h } = handlers(memory)
    const call = h.freeMemoryNow as unknown as (...args: unknown[]) => Promise<MemoryStatus>
    await call({ pids: [4], aggressive: true }, 'explorer.exe')
    expect(memory.freeNow).toHaveBeenCalledWith()
  })

  it('passes on why a pass cannot run', async () => {
    const { h } = handlers({
      status: () => STATUS,
      freeNow: async () => {
        throw new Error('Memory cleanup is not available right now.')
      }
    })
    await expect(h.freeMemoryNow()).rejects.toThrow('Memory cleanup is not available right now.')
  })
})
