import { beforeEach, describe, expect, it, vi } from 'vitest'

// pointer.ts imports the action bus, which imports the focus engine (needs a window): stub it.
vi.mock('./actions', () => ({ dispatchAction: vi.fn() }))

import {
  isStationaryMove,
  isSyntheticMouseEnter,
  noteMousePosition,
  resetPointerState
} from './pointer'

describe('isSyntheticMouseEnter', () => {
  beforeEach(() => resetPointerState())

  it('treats the first enter (window shown under a parked cursor) as synthetic and records the spot', () => {
    expect(isSyntheticMouseEnter({ clientX: 100, clientY: 50 })).toBe(true)
    // The same position again: a card slid under the parked cursor (scroll / translate), not a hover.
    expect(isSyntheticMouseEnter({ clientX: 100, clientY: 50 })).toBe(true)
    // Elsewhere: the cursor must have moved.
    expect(isSyntheticMouseEnter({ clientX: 140, clientY: 50 })).toBe(false)
  })

  it('accepts an enter at a position the cursor has not been seen at (pointerenter precedes pointermove)', () => {
    noteMousePosition({ clientX: 10, clientY: 10 })
    expect(isSyntheticMouseEnter({ clientX: 120, clientY: 60 })).toBe(false)
  })

  it('ignores enters at the last real cursor position after a move or press', () => {
    noteMousePosition({ clientX: 300, clientY: 200 })
    expect(isSyntheticMouseEnter({ clientX: 300, clientY: 200 })).toBe(true)
    noteMousePosition({ clientX: 301, clientY: 200 })
    expect(isSyntheticMouseEnter({ clientX: 301, clientY: 200 })).toBe(true)
    expect(isSyntheticMouseEnter({ clientX: 340, clientY: 200 })).toBe(false)
  })

  it('forgets the position on reset so the next enter is the first one again', () => {
    noteMousePosition({ clientX: 5, clientY: 5 })
    resetPointerState()
    expect(isSyntheticMouseEnter({ clientX: 5, clientY: 5 })).toBe(true)
    expect(isSyntheticMouseEnter({ clientX: 6, clientY: 5 })).toBe(false)
  })
})

describe('isStationaryMove', () => {
  it('is true only when both movement deltas are zero', () => {
    expect(isStationaryMove({ movementX: 0, movementY: 0 })).toBe(true)
    expect(isStationaryMove({ movementX: 1, movementY: 0 })).toBe(false)
    expect(isStationaryMove({ movementX: 0, movementY: -2 })).toBe(false)
  })
})
