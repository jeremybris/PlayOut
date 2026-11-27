import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { createSizeCache, SIZE_CACHE_TTL_MS } from './size-cache'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

let dir: string
let file: string

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-size-cache-'))
  file = join(dir, 'sub', 'install-sizes.json')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

const readFile = async (): Promise<Record<string, { value: number | null; at: number }>> =>
  JSON.parse(await fs.readFile(file, 'utf8')) as Record<
    string,
    { value: number | null; at: number }
  >

describe('createSizeCache', () => {
  it('answers a fresh key from the cache without fetching again', async () => {
    const cache = createSizeCache(file, log)
    const fetch = vi.fn(async () => 42)
    expect(await cache.get('steam:620', fetch)).toBe(42)
    expect(await cache.get('steam:620', fetch)).toBe(42)
    expect(fetch).toHaveBeenCalledTimes(1)
    // Another key is its own answer.
    const other = vi.fn(async () => 7)
    expect(await cache.get('steam:621', other)).toBe(7)
    expect(other).toHaveBeenCalledTimes(1)
    await cache.flush()
  })

  it('fetches again once the answer is older than the TTL', async () => {
    const start = 1_700_000_000_000
    const now = vi.spyOn(Date, 'now').mockReturnValue(start)
    const cache = createSizeCache(file, log)
    const fetch = vi.fn<() => Promise<number | undefined>>().mockResolvedValueOnce(1)
    fetch.mockResolvedValueOnce(2)
    expect(await cache.get('gog:1', fetch)).toBe(1)
    now.mockReturnValue(start + SIZE_CACHE_TTL_MS - 1)
    expect(await cache.get('gog:1', fetch)).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    now.mockReturnValue(start + SIZE_CACHE_TTL_MS)
    expect(await cache.get('gog:1', fetch)).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(2)
    // The new answer is fresh from its own time.
    now.mockReturnValue(start + SIZE_CACHE_TTL_MS + 1000)
    expect(await cache.get('gog:1', fetch)).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(2)
    await cache.flush()
  })

  it('keeps an answer of "none" (undefined) and does not ask again', async () => {
    const cache = createSizeCache(file, log)
    const fetch = vi.fn(async () => undefined)
    expect(await cache.get('search:hades', fetch)).toBeUndefined()
    expect(await cache.get('search:hades', fetch)).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    await cache.flush()
    expect((await readFile())['search:hades']).toMatchObject({ value: null })
  })

  it('does not store a failure: the next ask fetches again', async () => {
    const cache = createSizeCache(file, log)
    const fetch = vi
      .fn<() => Promise<number | undefined>>()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce(9)
    await expect(cache.get('req:620', fetch)).rejects.toThrow('503')
    expect(await cache.get('req:620', fetch)).toBe(9)
    expect(fetch).toHaveBeenCalledTimes(2)
    await cache.flush()
    expect(Object.keys(await readFile())).toEqual(['req:620'])
  })

  it('shares one fetch between concurrent asks for a key', async () => {
    const cache = createSizeCache(file, log)
    const gate = deferred<number | undefined>()
    const fetch = vi.fn(() => gate.promise)
    const a = cache.get('steam:1', fetch)
    const b = cache.get('steam:1', fetch)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    gate.resolve(5)
    expect(await a).toBe(5)
    expect(await b).toBe(5)
    expect(fetch).toHaveBeenCalledTimes(1)
    await cache.flush()
  })

  it('shares a failing fetch too, and a later ask starts a new one', async () => {
    const cache = createSizeCache(file, log)
    let fail!: (err: Error) => void
    const fetch = vi
      .fn<() => Promise<number | undefined>>()
      .mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
      .mockResolvedValueOnce(3)
    const a = cache.get('steam:1', fetch)
    const b = cache.get('steam:1', fetch)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    fail(new Error('offline'))
    await expect(a).rejects.toThrow('offline')
    await expect(b).rejects.toThrow('offline')
    expect(await cache.get('steam:1', fetch)).toBe(3)
    expect(fetch).toHaveBeenCalledTimes(2)
    await cache.flush()
  })

  it('writes the answers to its file on flush (creating the folder)', async () => {
    const cache = createSizeCache(file, log)
    await cache.get('steam:620', async () => 11)
    await cache.get('gog:7', async () => undefined)
    await cache.flush()
    const saved = await readFile()
    expect(saved['steam:620']).toEqual({ value: 11, at: expect.any(Number) })
    expect(saved['gog:7']).toEqual({ value: null, at: expect.any(Number) })
    // No temp file left behind.
    expect(await fs.readdir(join(dir, 'sub'))).toEqual(['install-sizes.json'])
  })

  it('flush without a pending change and without a file is harmless', async () => {
    await createSizeCache(null, log).flush()
    const memory = createSizeCache(null, log)
    const fetch = vi.fn(async () => 4)
    expect(await memory.get('k', fetch)).toBe(4)
    expect(await memory.get('k', fetch)).toBe(4)
    expect(fetch).toHaveBeenCalledTimes(1)
    await memory.flush()
    await expect(fs.stat(file)).rejects.toThrow()
  })

  it('ignores a corrupt file and starts empty', async () => {
    await fs.mkdir(join(dir, 'sub'), { recursive: true })
    await fs.writeFile(file, '{ not json', 'utf8')
    const cache = createSizeCache(file, log)
    const fetch = vi.fn(async () => 8)
    expect(await cache.get('steam:1', fetch)).toBe(8)
    expect(fetch).toHaveBeenCalledTimes(1)
    await cache.flush()
    expect((await readFile())['steam:1']).toMatchObject({ value: 8 })
  })

  it('skips malformed entries of an otherwise valid file', async () => {
    await fs.mkdir(join(dir, 'sub'), { recursive: true })
    const at = Date.now()
    await fs.writeFile(
      file,
      JSON.stringify({
        good: { value: 1, at },
        none: { value: null, at },
        noTime: { value: 2 },
        badValue: { value: 'x', at },
        nothing: null
      }),
      'utf8'
    )
    const cache = createSizeCache(file, log)
    const fetch = vi.fn(async () => 99)
    expect(await cache.get('good', fetch)).toBe(1)
    expect(await cache.get('none', fetch)).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    for (const key of ['noTime', 'badValue', 'nothing'])
      expect(await cache.get(key, fetch)).toBe(99)
    expect(fetch).toHaveBeenCalledTimes(3)
    await cache.flush()
  })

  it('ignores a file that holds an array', async () => {
    await fs.mkdir(join(dir, 'sub'), { recursive: true })
    await fs.writeFile(file, JSON.stringify([{ value: 1, at: Date.now() }]), 'utf8')
    const fetch = vi.fn(async () => 6)
    expect(await createSizeCache(file, log).get('0', fetch)).toBe(6)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reloads the answers a previous cache wrote', async () => {
    const first = createSizeCache(file, log)
    await first.get('steam:620', async () => 11)
    await first.get('search:portal', async () => undefined)
    await first.flush()

    const second = createSizeCache(file, log)
    const fetch = vi.fn(async () => 1)
    expect(await second.get('steam:620', fetch)).toBe(11)
    expect(await second.get('search:portal', fetch)).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refetches a reloaded answer that has gone stale', async () => {
    await fs.mkdir(join(dir, 'sub'), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({ 'steam:1': { value: 1, at: Date.now() - SIZE_CACHE_TTL_MS - 1 } }),
      'utf8'
    )
    const fetch = vi.fn(async () => 2)
    expect(await createSizeCache(file, log).get('steam:1', fetch)).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('coalesces writes: nothing is written before the delay, then once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const cache = createSizeCache(file, log)
      await cache.get('a', async () => 1)
      await cache.get('b', async () => 2)
      await expect(fs.stat(file)).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(2000)
      await vi.waitFor(async () => expect(Object.keys(await readFile()).sort()).toEqual(['a', 'b']))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('refresh', () => {
  it('asks again once per run even while the answer is fresh', async () => {
    const cache = createSizeCache(null, log)
    const fetch = vi.fn(async () => 1)
    await cache.get('steam:1', fetch)
    await cache.get('steam:1', fetch, { refresh: true })
    await cache.get('steam:1', fetch, { refresh: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('refresh at the start of a run', () => {
  it('keeps the old answer when asking again fails', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const first = createSizeCache(file, log)
    await first.get('steam:1', async () => 5)
    await first.flush()
    // The next run, 13 hours later: the refresh fails, the known size stands.
    clock.mockReturnValue(now + 13 * 60 * 60 * 1000)
    const next = createSizeCache(file, log)
    const failing = vi.fn(async () => {
      throw new Error('429')
    })
    await expect(next.get('steam:1', failing, { refresh: true })).resolves.toBe(5)
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it('does not ask again an answer younger than 12 hours', async () => {
    const cache = createSizeCache(null, log)
    await cache.get('steam:2', async () => 5)
    const next = createSizeCache(null, log)
    const fetch = vi.fn(async () => 6)
    // A new run (a new cache object) with a recent answer: no request.
    await next.get('steam:3', async () => 1)
    await expect(next.get('steam:3', fetch, { refresh: true })).resolves.toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })
})
