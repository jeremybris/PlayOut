import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A fake handler pack: how many handlers it holds and when its index was built.
const pack = {
  handlers: [] as unknown[],
  builtAt: '',
  busy: false,
  downloads: 0,
  fail: false
}
vi.mock('./handler-pack', () => ({
  createHandlerPack: () => ({
    downloadAll: vi.fn(async () => {
      pack.downloads++
      if (pack.fail) throw new Error('offline')
      pack.handlers = [{}]
      pack.builtAt = new Date().toISOString()
      return { downloaded: 1, total: 1, failed: 0 }
    }),
    index: async () => pack.handlers,
    builtAt: async () => pack.builtAt,
    busy: () => pack.busy,
    extract: vi.fn()
  }),
  extractedPaths: () => ({ script: '', folder: '', stamp: '' })
}))

const { createCoopService } = await import('./coop-service')

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

function service(): ReturnType<typeof createCoopService> {
  return createCoopService({
    library: { games: () => [], getGame: () => undefined } as never,
    settings: { get: () => ({}) } as never,
    events: { emit: vi.fn(), on: vi.fn() } as never,
    launcher: {} as never,
    userData: 'C:/nowhere',
    helperDir: 'C:/nowhere/coop',
    log: log as never
  })
}

const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(pack, { handlers: [], builtAt: '', busy: false, downloads: 0, fail: false })
})
afterEach(() => vi.useRealTimers())

describe('Co-Op handler pack: automatic download', () => {
  it('downloads the pack shortly after start when this PC has none', async () => {
    const s = service()
    s.startAutoDownload({ firstDelayMs: 1000, checkEveryMs: DAY })
    await vi.advanceTimersByTimeAsync(999)
    expect(pack.downloads).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(pack.downloads).toBe(1)
    s.dispose()
  })

  it('leaves a recent pack alone and looks for new handlers once it is a week old', async () => {
    pack.handlers = [{}]
    pack.builtAt = new Date().toISOString()
    const s = service()
    s.startAutoDownload({ firstDelayMs: 1000, checkEveryMs: DAY, refreshAfterMs: 7 * DAY })
    await vi.advanceTimersByTimeAsync(1000 + 6 * DAY)
    expect(pack.downloads).toBe(0)
    await vi.advanceTimersByTimeAsync(2 * DAY)
    expect(pack.downloads).toBe(1)
    s.dispose()
  })

  it('tries again at the next check after a failed download (offline)', async () => {
    pack.fail = true
    const s = service()
    s.startAutoDownload({ firstDelayMs: 1000, checkEveryMs: 60_000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(pack.downloads).toBe(1)
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('automatic handler download failed')
    )
    pack.fail = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pack.downloads).toBe(2)
    expect(pack.handlers).toHaveLength(1)
    s.dispose()
  })

  it('does not start a second download while one runs, and stops after dispose', async () => {
    pack.busy = true
    const s = service()
    s.startAutoDownload({ firstDelayMs: 1000, checkEveryMs: 60_000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(pack.downloads).toBe(0)
    pack.busy = false
    s.dispose()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(pack.downloads).toBe(0)
  })
})
