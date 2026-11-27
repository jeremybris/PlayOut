import type { Game } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { focusTargetAfterScroll, scrollAnchor, scrollTopFor, visibleRows } from './libraryScroll'

const games = Array.from({ length: 30 }, (_, i) => ({ id: `g${i}` }) as Game)
const indexOf = new Map(games.map((g, i) => [g.id, i]))
const geometry = { rowStride: 300, paddingTop: 20 }

describe('library scroll', () => {
  it('saves the top row as its first game and the offset past it', () => {
    expect(scrollAnchor(games, 6, geometry, 0)).toBeNull()
    // Row 2 starts at 20 + 600 = 620; 700 is 80 px past it.
    expect(scrollAnchor(games, 6, geometry, 700)).toEqual({ gameId: 'g12', offset: 80 })
    expect(scrollAnchor([], 6, geometry, 700)).toBeNull()
  })

  it('puts the same games back at the top with other columns', () => {
    const saved = scrollAnchor(games, 6, geometry, 700)!
    // Six columns: back to 700.
    expect(scrollTopFor(saved, indexOf, 6, geometry)).toBe(700)
    // Four columns (a narrower window): g12 is in row 3.
    expect(scrollTopFor(saved, indexOf, 4, geometry)).toBe(20 + 900 + 80)
    expect(scrollTopFor({ gameId: 'gone', offset: 0 }, indexOf, 6, geometry)).toBeNull()
    // An offset larger than a row (smaller cards now) is capped at one row.
    expect(scrollTopFor({ gameId: 'g0', offset: 5000 }, indexOf, 6, geometry)).toBe(320)
  })

  it('leaves out a row inside the scroll padding (focusing it would move the view)', () => {
    // Saved offset 0: row 2's top is at the viewport's top edge, inside a 48 px scroll padding.
    const top = 620
    expect(visibleRows(top, 800, geometry, 5).first).toBe(2)
    expect(visibleRows(top + 48, 800 - 96, geometry, 5).first).toBe(3)
  })

  it('focuses the remembered card when it is on screen, else the top row', () => {
    const rows = visibleRows(700, 800, geometry, 5)
    expect(rows).toEqual({ first: 3, last: 3 })
    expect(focusTargetAfterScroll(games, 6, 'g20', indexOf, rows)).toBe('g20')
    expect(focusTargetAfterScroll(games, 6, 'g2', indexOf, rows)).toBe('g18')
    expect(focusTargetAfterScroll(games, 6, null, indexOf, { first: 0, last: 1 })).toBe('g0')
  })
})
