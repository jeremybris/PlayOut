import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import type { PlaySession } from '../../shared/types'
import { SessionsStore } from './sessions-store'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-sessions-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const synced = (id: string): PlaySession => ({
  id,
  gameId: 'g',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T01:00:00.000Z',
  minutes: 60,
  from: 'pc-b'
})

describe('SessionsStore', () => {
  it('adds sessions from another PC once, by id', () => {
    const store = new SessionsStore(join(dir, 'sessions.json'))
    const own = store.start('g', '2026-01-02T00:00:00.000Z')
    expect(
      store.add([synced('s_1'), synced('s_1'), { ...synced('s_2') }]).map((s) => s.id)
    ).toEqual(['s_1', 's_2'])
    expect(store.add([synced('s_1'), { ...synced(own.id) }])).toEqual([])
    expect(store.all()).toHaveLength(3)
  })

  it('still knows the sessions dropped by its limit, after a restart too', async () => {
    const file = join(dir, 'sessions.json')
    const store = new SessionsStore(file)
    await store.load()
    store.add([synced('s_old')])
    store.add(Array.from({ length: 10_000 }, (_, i) => synced(`s_${i}`)))
    expect(store.all()).toHaveLength(10_000)
    expect(store.all().some((s) => s.id === 's_old')).toBe(false)
    expect(store.has('s_old')).toBe(true)
    expect(store.add([synced('s_old')])).toEqual([])
    await store.flush()
    const again = new SessionsStore(file)
    await again.load()
    expect(again.has('s_old')).toBe(true)
    expect(again.has('s_9999')).toBe(true)
    expect(again.has('s_new')).toBe(false)
  })

  it("drops sessions taken from other PCs before this PC's own", () => {
    const store = new SessionsStore(join(dir, 'sessions.json'))
    const own = store.start('g', '2025-01-01T00:00:00.000Z')
    store.end(own.id, '2025-01-01T01:00:00.000Z', 60)
    store.add([synced('s_first')])
    store.add(Array.from({ length: 10_000 }, (_, i) => synced(`s_${i}`)))
    expect(store.all()).toHaveLength(10_000)
    // The oldest is this PC's own: kept; the oldest taken ones went instead.
    expect(store.all()[0].id).toBe(own.id)
    expect(store.all().some((s) => s.id === 's_first' || s.id === 's_0')).toBe(false)
    expect(store.has('s_first') && store.has('s_0')).toBe(true)
  })
})
