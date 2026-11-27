import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtProgress, ArtProgressStage } from '../../shared/types'
import { createArtProgress } from './art-progress'

let left: Record<ArtProgressStage, number>
let sent: ArtProgress[]

function tracker(): ReturnType<typeof createArtProgress> {
  return createArtProgress({
    remaining: (stage) => left[stage],
    emit: (p) => sent.push(p),
    intervalMs: 250
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  left = { cover: 0, art: 0 }
  sent = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe('art progress', () => {
  it('reports a run starting at once, then at most every interval, and idle at once', () => {
    const t = tracker()
    left = { cover: 4, art: 4 }
    t.changed()
    expect(sent).toEqual([{ stage: 'cover', done: 0, total: 4 }])
    left.cover = 3
    t.finished('cover')
    left.cover = 2
    t.finished('cover')
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(250)
    expect(sent.at(-1)).toEqual({ stage: 'cover', done: 2, total: 4 })
    left.cover = 0
    for (let i = 0; i < 2; i++) t.finished('cover')
    vi.advanceTimersByTime(250)
    // The covers are in: the bar moves on to the remaining art, counted from zero.
    expect(sent.at(-1)).toEqual({ stage: 'art', done: 0, total: 4 })
    left.art = 0
    for (let i = 0; i < 4; i++) t.finished('art')
    expect(sent.at(-1)).toEqual({ stage: 'cover', done: 0, total: 0 })
    t.dispose()
  })

  it('grows the total when games are queued mid-run, and starts the next run from zero', () => {
    const t = tracker()
    left.cover = 2
    t.changed()
    left.cover = 1
    t.finished('cover')
    left.cover = 4
    t.changed()
    vi.advanceTimersByTime(250)
    expect(sent.at(-1)).toEqual({ stage: 'cover', done: 1, total: 5 })
    left.cover = 0
    t.finished('cover')
    expect(sent.at(-1)?.total).toBe(0)
    left.cover = 2
    t.changed()
    expect(sent.at(-1)).toEqual({ stage: 'cover', done: 0, total: 2 })
    t.dispose()
  })

  it('sends nothing after dispose', () => {
    const t = tracker()
    left.cover = 3
    t.changed()
    left.cover = 2
    t.finished('cover')
    t.dispose()
    vi.advanceTimersByTime(1000)
    left.cover = 0
    t.finished('cover')
    expect(sent).toEqual([{ stage: 'cover', done: 0, total: 3 }])
  })
})
