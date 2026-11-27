import { describe, expect, it, vi } from 'vitest'
import { createChangeCoalescer } from './changeCoalescer'

function harness(limit = 50): {
  note(ids?: string[]): void
  games: string[][]
  all: number
} {
  const games: string[][] = []
  const out = { games, all: 0, note: (ids?: string[]) => c.note(ids) }
  const c = createChangeCoalescer({
    minMs: 150,
    maxMs: 500,
    limit,
    onGames: (ids) => games.push(ids),
    onAll: () => out.all++
  })
  return out
}

describe('createChangeCoalescer', () => {
  it('fires once, 150 ms after the last event of a short burst, with the union of ids', () => {
    vi.useFakeTimers()
    const h = harness()
    h.note(['a'])
    vi.advanceTimersByTime(100)
    h.note(['b', 'a'])
    vi.advanceTimersByTime(149)
    expect(h.games).toEqual([])
    vi.advanceTimersByTime(1)
    expect(h.games).toEqual([['a', 'b']])
    vi.useRealTimers()
  })

  it('does not wait for the end of a stream of events: refreshes every 500 ms at the latest', () => {
    vi.useFakeTimers()
    const h = harness()
    // One event every 100 ms for 2 s: a plain trailing debounce would never fire.
    for (let i = 0; i < 20; i++) {
      h.note([`g${i}`])
      vi.advanceTimersByTime(100)
    }
    expect(h.games.length).toBeGreaterThanOrEqual(3)
    expect(h.games.flat()).toEqual(
      Array.from({ length: 20 }, (_, i) => `g${i}`).slice(0, h.games.flat().length)
    )
    vi.advanceTimersByTime(500)
    expect(h.games.flat()).toHaveLength(20)
    vi.useRealTimers()
  })

  it('refreshes everything for an event without ids or for more ids than the limit', () => {
    vi.useFakeTimers()
    const h = harness(3)
    h.note(['a'])
    h.note()
    vi.advanceTimersByTime(150)
    expect(h.all).toBe(1)
    expect(h.games).toEqual([])
    h.note(['a', 'b', 'c', 'd'])
    vi.advanceTimersByTime(150)
    expect(h.all).toBe(2)
    h.note(['a', 'b', 'c'])
    vi.advanceTimersByTime(150)
    expect(h.games).toEqual([['a', 'b', 'c']])
    vi.useRealTimers()
  })
})
