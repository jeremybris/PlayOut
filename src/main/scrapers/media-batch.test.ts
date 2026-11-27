import { describe, expect, it, vi } from 'vitest'
import type { MediaBatchItem } from '../services/library-service'
import { createMediaBatcher } from './media-batch'

function harness(intervalMs = 250): {
  batcher: ReturnType<typeof createMediaBatcher>
  batches: MediaBatchItem[][]
} {
  const batches: MediaBatchItem[][] = []
  const batcher = createMediaBatcher(
    { setMediaBatch: (items) => batches.push(items) },
    { intervalMs }
  )
  return { batcher, batches }
}

const item = (gameId: string, kind: MediaBatchItem['kind'] = 'cover'): MediaBatchItem => ({
  gameId,
  kind,
  url: `media://cache/${gameId}/${kind}.jpg`
})

describe('media batcher', () => {
  it('writes the first item of a quiet period at once and the rest of the burst once per interval', () => {
    vi.useFakeTimers()
    const { batcher, batches } = harness()
    batcher.add(item('a'))
    expect(batches).toHaveLength(1)
    // 1,000 covers a second for the next second: no item cap, so exactly one flush per interval.
    for (let i = 0; i < 1000; i++) {
      batcher.add(item(`g${i}`))
      vi.advanceTimersByTime(1)
    }
    vi.advanceTimersByTime(250)
    expect(batches.length).toBeLessThanOrEqual(6)
    expect(batches.flat()).toHaveLength(1001)
    expect(batcher.pending).toBe(0)
    vi.useRealTimers()
  })

  it('keeps the latest item per game and kind, and answers has() only for landed files', () => {
    vi.useFakeTimers()
    const { batcher, batches } = harness()
    batcher.add(item('a'))
    batcher.add({ ...item('b'), url: 'media://cache/b/cover.jpg?v=1' })
    batcher.add({ ...item('b'), url: 'media://cache/b/cover.jpg?v=2' })
    batcher.add({ gameId: 'c', kind: 'cover', missing: 'https://cdn/c.jpg' })
    expect(batcher.has('b', 'cover')).toBe(true)
    expect(batcher.has('b', 'hero')).toBe(false)
    expect(batcher.has('c', 'cover')).toBe(false)
    vi.advanceTimersByTime(250)
    expect(batches[1]).toEqual([
      { gameId: 'b', kind: 'cover', url: 'media://cache/b/cover.jpg?v=2' },
      { gameId: 'c', kind: 'cover', missing: 'https://cdn/c.jpg' }
    ])
    expect(batcher.has('b', 'cover')).toBe(false)
    vi.useRealTimers()
  })

  it('writes immediately after dispose', () => {
    const { batcher, batches } = harness()
    batcher.dispose()
    batcher.add(item('a'))
    expect(batches).toEqual([[item('a')]])
  })
})
