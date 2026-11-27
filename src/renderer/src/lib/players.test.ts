import { describe, expect, it } from 'vitest'
import { currentShare, playersOf } from './players'

const at = '2026-11-15T00:00:00.000Z'

describe('playersOf', () => {
  it('is null when neither number is known', () => {
    expect(playersOf({})).toBeNull()
    // 0: SteamCharts does not track the game.
    expect(playersOf({ peakPlayers: { count: 0, updatedAt: at } })).toBeNull()
  })

  it('gives both numbers, the peak never below the number online now', () => {
    expect(
      playersOf({
        currentPlayers: { count: 6731, updatedAt: at },
        peakPlayers: { count: 25642, updatedAt: at }
      })
    ).toEqual({ current: 6731, peak: 25642 })
    expect(
      playersOf({
        currentPlayers: { count: 30000, updatedAt: at },
        peakPlayers: { count: 25642, updatedAt: at }
      })
    ).toEqual({ current: 30000, peak: 30000 })
  })

  it('shows one number when the other is unknown', () => {
    expect(playersOf({ currentPlayers: { count: 40, updatedAt: at } })).toEqual({
      current: 40,
      peak: null
    })
    expect(playersOf({ peakPlayers: { count: 900, updatedAt: at } })).toEqual({
      current: null,
      peak: 900
    })
  })
})

describe('currentShare', () => {
  it('is the number online now as a share of the peak, with a visible sliver', () => {
    expect(currentShare(136228, 472962)).toBeCloseTo(28.8, 1)
    expect(currentShare(20841, 953426)).toBe(4)
    expect(currentShare(5, 5)).toBe(100)
  })

  it('is empty with nobody online, full without a peak', () => {
    expect(currentShare(0, 1000)).toBe(0)
    expect(currentShare(null, 1000)).toBe(0)
    expect(currentShare(50, null)).toBe(100)
  })
})
