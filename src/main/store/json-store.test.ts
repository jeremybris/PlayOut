import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { JsonStore } from './json-store'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-store-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('JsonStore', () => {
  it('starts from defaults and persists atomically', async () => {
    const file = join(dir, 'a.json')
    const store = new JsonStore<{ n: number }>({ file, defaults: () => ({ n: 1 }), debounceMs: 1 })
    expect(await store.load()).toEqual({ n: 1 })
    store.set((d) => {
      d.n = 5
    })
    await store.flush()
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ n: 5 })
    const again = new JsonStore<{ n: number }>({ file, defaults: () => ({ n: 1 }) })
    expect(await again.load()).toEqual({ n: 5 })
    expect(await fs.readdir(dir)).toEqual(['a.json'])
  })

  it('still writes every maxWaitMs while sets keep arriving faster than the debounce', async () => {
    const file = join(dir, 'd.json')
    const store = new JsonStore<{ n: number }>({
      file,
      defaults: () => ({ n: 0 }),
      debounceMs: 40,
      maxWaitMs: 120
    })
    await store.load()
    const writes: number[] = []
    const started = Date.now()
    // A set every 10 ms for 300 ms: a plain trailing debounce of 40 ms would not write before the end.
    for (let i = 1; i <= 30; i++) {
      store.set((d) => {
        d.n = i
      })
      await new Promise((r) => setTimeout(r, 10))
      try {
        const n = (JSON.parse(await fs.readFile(file, 'utf8')) as { n: number }).n
        if (!writes.includes(n)) writes.push(n)
      } catch {
        /* not written yet */
      }
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    expect(writes.length).toBeGreaterThanOrEqual(2)
    expect(writes[0]).toBeLessThan(30)
    await store.flush()
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ n: 30 })
  })

  it('keeps a .bak of a corrupt file and falls back to defaults', async () => {
    const file = join(dir, 'b.json')
    await fs.writeFile(file, '{not json')
    const store = new JsonStore<{ n: number }>({ file, defaults: () => ({ n: 7 }) })
    expect(await store.load()).toEqual({ n: 7 })
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe('{not json')
  })

  it('never overwrites an earlier backup of a corrupt file', async () => {
    const file = join(dir, 'g.json')
    const loadCorrupt = async (text: string): Promise<void> => {
      await fs.writeFile(file, text)
      await new JsonStore<{ n: number }>({ file, defaults: () => ({ n: 7 }) }).load()
    }
    await loadCorrupt('{first')
    await loadCorrupt('{second')
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe('{first')
    expect(await fs.readFile(file + '.bak.1', 'utf8')).toBe('{second')
    // The same corrupt file seen again (nothing was written in between) takes no further slot.
    await loadCorrupt('{second')
    await loadCorrupt('{first')
    expect((await fs.readdir(dir)).sort()).toEqual(['g.json', 'g.json.bak', 'g.json.bak.1'])
  })

  it('keeps a capped number of backups: the oldest stay, the last slot holds the newest', async () => {
    const file = join(dir, 'h.json')
    for (let i = 0; i < 8; i++) {
      await fs.writeFile(file, `{corrupt ${i}`)
      await new JsonStore<{ n: number }>({ file, defaults: () => ({ n: 7 }) }).load()
    }
    expect((await fs.readdir(dir)).sort()).toEqual([
      'h.json',
      'h.json.bak',
      'h.json.bak.1',
      'h.json.bak.2',
      'h.json.bak.3',
      'h.json.bak.4'
    ])
    expect(await fs.readFile(file + '.bak', 'utf8')).toBe('{corrupt 0')
    expect(await fs.readFile(file + '.bak.3', 'utf8')).toBe('{corrupt 3')
    expect(await fs.readFile(file + '.bak.4', 'utf8')).toBe('{corrupt 7')
  })

  it('tells the caller whether a flush reached the disk, without rejecting', async () => {
    const good = new JsonStore<{ n: number }>({
      file: join(dir, 'i.json'),
      defaults: () => ({ n: 1 })
    })
    expect(await good.tryFlush()).toBe(true)
    // A path under a file cannot be written.
    await fs.writeFile(join(dir, 'blocker'), 'x')
    const bad = new JsonStore<{ n: number }>({
      file: join(dir, 'blocker', 'bad.json'),
      defaults: () => ({ n: 1 })
    })
    expect(await bad.tryFlush()).toBe(false)
    await expect(bad.flush()).resolves.toBeUndefined()
    // A failed write does not taint the next store's (or the next write's) result.
    expect(await good.tryFlush()).toBe(true)
  })

  it('retries a file that is temporarily locked instead of treating it as missing', async () => {
    const file = join(dir, 'e.json')
    await fs.writeFile(file, JSON.stringify({ n: 9 }))
    const read = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }))
    const store = new JsonStore<{ n: number }>({ file, defaults: () => ({ n: 1 }) })
    expect(await store.load()).toEqual({ n: 9 })
    expect(read).toHaveBeenCalledTimes(2)
    read.mockRestore()
  })

  it('rejects a file that stays unreadable, and can load it once it is readable', async () => {
    const file = join(dir, 'f.json')
    await fs.writeFile(file, JSON.stringify({ n: 9 }))
    const read = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    const store = new JsonStore<{ n: number }>({ file, defaults: () => ({ n: 1 }) })
    await expect(store.load()).rejects.toThrow(/Could not read .*denied/)
    read.mockRestore()
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ n: 9 })
    expect(await store.load()).toEqual({ n: 9 })
  })

  it('normalizes loaded data', async () => {
    const file = join(dir, 'c.json')
    await fs.writeFile(file, JSON.stringify({ n: 'x' }))
    const store = new JsonStore<{ n: number }>({
      file,
      defaults: () => ({ n: 0 }),
      normalize: (raw) => ({
        n: typeof (raw as { n: unknown }).n === 'number' ? ((raw as { n: number }).n as number) : 42
      })
    })
    expect(await store.load()).toEqual({ n: 42 })
  })
})

describe('onStoreWriteError', () => {
  it('reports a write that fails, and writes a BigInt as its decimal string', async () => {
    const { JsonStore, onStoreWriteError } = await import('./json-store')
    const { promises: fsp } = await import('fs')
    const { tmpdir: tmp } = await import('os')
    const { join: j } = await import('path')
    const root = await fsp.mkdtemp(j(tmp(), 'playout-store-sink-'))
    const errors: string[] = []
    onStoreWriteError((file) => errors.push(file))
    try {
      const ok = new JsonStore<{ id?: unknown }>({ file: j(root, 'ok.json'), defaults: () => ({}) })
      ok.set((d) => {
        d.id = BigInt('76561197960287930')
      })
      await ok.flush()
      expect(JSON.parse(await fsp.readFile(j(root, 'ok.json'), 'utf8'))).toEqual({
        id: '76561197960287930'
      })
      // A path under a file cannot be written.
      await fsp.writeFile(j(root, 'blocker'), 'x')
      const bad = new JsonStore({ file: j(root, 'blocker', 'bad.json'), defaults: () => ({}) })
      bad.set(() => undefined)
      await bad.flush()
      expect(errors).toEqual([j(root, 'blocker', 'bad.json')])
    } finally {
      onStoreWriteError(null)
      await fsp.rm(root, { recursive: true, force: true })
    }
  })
})
