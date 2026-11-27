import { describe, expect, it } from 'vitest'
import { cardWindow, gridRowLayout, mergeSegments, sameSegments } from './windowing'

// 1080p reference: 240u card + 30u gap = 270 px stride, 88 px page inset, 1920 px wide track.
const base = {
  count: 500,
  scrollLeft: 0,
  clientWidth: 1920,
  paddingLeft: 88,
  stride: 270,
  overscan: 6,
  pinned: [] as number[]
}

describe('cardWindow', () => {
  it('mounts the visible cards plus the overscan on both sides', () => {
    // 1920 px of track shows cards 0..7 (card 7 starts at 88 + 7*270 = 1978 > 1920, so index 6 is the last
    // one fully or partly visible after the padding is removed: (1920)/270 = 7.1 -> 7).
    expect(cardWindow(base)).toEqual([{ start: 0, end: 14 }])
    // Scrolled to card 100: visible 100..107, mounted 94..113.
    expect(cardWindow({ ...base, scrollLeft: 88 + 100 * 270 })).toEqual([{ start: 94, end: 114 }])
  })

  it('clamps at the end of the row', () => {
    expect(cardWindow({ ...base, scrollLeft: 88 + 496 * 270 })).toEqual([{ start: 490, end: 500 }])
    expect(cardWindow({ ...base, count: 5 })).toEqual([{ start: 0, end: 5 }])
    expect(cardWindow({ ...base, count: 0 })).toEqual([])
  })

  it('keeps pinned cards mounted with their neighbours, as a separate island when far away', () => {
    expect(cardWindow({ ...base, pinned: [300] })).toEqual([
      { start: 0, end: 14 },
      { start: 294, end: 307 }
    ])
    // A pinned card near the window merges into it.
    expect(cardWindow({ ...base, pinned: [16] })).toEqual([{ start: 0, end: 23 }])
    // Out-of-range or stale pins are ignored.
    expect(cardWindow({ ...base, pinned: [-1, 500, 2.5] })).toEqual([{ start: 0, end: 14 }])
  })

  it('falls back to the start of the row before anything could be measured', () => {
    expect(cardWindow({ ...base, stride: 0, clientWidth: 0 })).toEqual([{ start: 0, end: 13 }])
  })
})

describe('mergeSegments / sameSegments', () => {
  it('merges overlapping and touching runs in order', () => {
    expect(
      mergeSegments([
        { start: 10, end: 20 },
        { start: 0, end: 5 },
        { start: 5, end: 8 },
        { start: 18, end: 25 }
      ])
    ).toEqual([
      { start: 0, end: 8 },
      { start: 10, end: 25 }
    ])
  })

  it('compares runs by value', () => {
    expect(sameSegments([{ start: 0, end: 3 }], [{ start: 0, end: 3 }])).toBe(true)
    expect(sameSegments([{ start: 0, end: 3 }], [{ start: 0, end: 4 }])).toBe(false)
    expect(sameSegments([], [{ start: 0, end: 1 }])).toBe(false)
  })
})

describe('gridRowLayout', () => {
  // The Library grid's tracks: a spacer spans `rows` implicit card-height tracks, so with the row gap
  // between tracks every entry's offset is its row times the stride (card height + gap).
  const CARD_H = 360
  const GAP = 36
  const offsets = (entries: ReturnType<typeof gridRowLayout>): Map<number, number> => {
    const out = new Map<number, number>()
    let y = 0
    for (const entry of entries) {
      out.set(entry.row, y)
      const tracks = entry.kind === 'spacer' ? entry.rows : 1
      y += tracks * CARD_H + tracks * GAP
    }
    return out
  }

  it('accounts for every row with spacers before, between and after the mounted segments', () => {
    const entries = gridRowLayout(
      [
        { start: 0, end: 4 },
        { start: 500, end: 503 }
      ],
      1000
    )
    expect(entries.filter((e) => e.kind === 'spacer')).toEqual([
      { kind: 'spacer', row: 4, rows: 496 },
      { kind: 'spacer', row: 503, rows: 497 }
    ])
    expect(entries.filter((e) => e.kind === 'row').map((e) => e.row)).toEqual([
      0, 1, 2, 3, 500, 501, 502
    ])
    const total = entries.reduce((n, e) => n + (e.kind === 'spacer' ? e.rows : 1), 0)
    expect(total).toBe(1000)
    // The pinned row far down the grid sits exactly where a fully mounted grid would put it.
    expect(offsets(entries).get(500)).toBe(500 * (CARD_H + GAP))
  })

  it('clamps segments to the row count and needs no spacer when everything is mounted', () => {
    expect(gridRowLayout([{ start: 0, end: 10 }], 4)).toEqual([
      { kind: 'row', row: 0 },
      { kind: 'row', row: 1 },
      { kind: 'row', row: 2 },
      { kind: 'row', row: 3 }
    ])
    expect(gridRowLayout([], 0)).toEqual([])
    expect(gridRowLayout([], 3)).toEqual([{ kind: 'spacer', row: 0, rows: 3 }])
  })
})
