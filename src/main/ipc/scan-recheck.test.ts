import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  dialog: {},
  shell: {}
}))

import { createHandlers, type AppServices } from './handlers'

function services(order: string[], result: unknown): AppServices {
  return {
    scan: {
      run: vi.fn(async () => {
        order.push('scan')
        return result
      })
    },
    metadata: {
      recheckNameMatches: vi.fn(async () => {
        order.push('recheck')
      })
    },
    streaming: {
      scanHosts: vi.fn(async () => {
        order.push('hosts')
      })
    },
    log: { error: vi.fn(), warn: vi.fn() },
    window: { get: () => null }
  } as unknown as AppServices
}

describe('scanSources', () => {
  it("never re-checks the games matched by name (only Refresh metadata changes them); one source's scan stays on this PC", async () => {
    const order: string[] = []
    const result = { added: 1 }
    await expect(createHandlers(services(order, result)).scanSources(['steam'])).resolves.toBe(
      result
    )
    expect(order).toEqual(['scan'])
  })

  it('has the hosts rescan too on a full Scan, without waiting for them', async () => {
    const order: string[] = []
    const s = services(order, { added: 0 })
    let release: () => void = () => {}
    ;(s.streaming.scanHosts as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push('hosts')
          release = resolve
        })
    )
    await createHandlers(s).scanSources()
    expect(order).toEqual(['hosts', 'scan'])
    release()
  })
})
