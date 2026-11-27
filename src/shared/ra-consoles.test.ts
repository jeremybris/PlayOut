import { describe, expect, it } from 'vitest'
import { knownWithoutRetroAchievements, RA_NONE, raConsoleFor, raHashTrusted } from './ra-consoles'

type Counts = { unlocked: number; total: number }
const rom = (
  platformId: string,
  over: { achievements?: Counts; ra?: string } = {}
): {
  platformId: string
  metadata: { achievements?: Counts; sources?: Record<string, string> }
} => ({
  platformId,
  metadata: {
    ...(over.achievements ? { achievements: over.achievements } : {}),
    ...(over.ra ? { sources: { retroachievements: over.ra } } : {})
  }
})

describe('knownWithoutRetroAchievements', () => {
  it('a system RetroAchievements has none for (a recompilation’s PS3 / Xbox 360 game): known, signed in or not', () => {
    expect(raConsoleFor('ps3')).toBeNull()
    expect(knownWithoutRetroAchievements(rom('ps3'))).toBe(true)
    expect(knownWithoutRetroAchievements(rom('xbox360'))).toBe(true)
    expect(knownWithoutRetroAchievements(rom('switch'))).toBe(true)
  })

  it('a covered system: known only once the sync marked the game as without achievements', () => {
    expect(knownWithoutRetroAchievements(rom('snes'))).toBe(false)
    expect(knownWithoutRetroAchievements(rom('snes', { ra: '1234' }))).toBe(false)
    expect(knownWithoutRetroAchievements(rom('snes', { ra: RA_NONE }))).toBe(true)
    expect(
      knownWithoutRetroAchievements(rom('n64', { achievements: { unlocked: 0, total: 40 } }))
    ).toBe(false)
    // Regional folders and variants count as their console.
    expect(knownWithoutRetroAchievements(rom('megadrivejp'))).toBe(false)
    expect(knownWithoutRetroAchievements(rom('sgb'))).toBe(false)
    expect(knownWithoutRetroAchievements(rom('amstradcpc'))).toBe(false)
  })

  it('a recompilation standing in for its deleted disc image: the port is played, RetroAchievements cannot track it', () => {
    expect(
      knownWithoutRetroAchievements({ ...rom('n64'), romRemoved: { recompId: 'zelda64' } })
    ).toBe(true)
  })

  it('counts always win (a host’s game)', () => {
    expect(
      knownWithoutRetroAchievements(rom('ps3', { achievements: { unlocked: 1, total: 2 } }))
    ).toBe(false)
  })
})

describe('raHashTrusted', () => {
  it('trusts the hashing of the systems ra-hash knows, not of the ones added without rules', () => {
    expect(raHashTrusted('snes')).toBe(true)
    expect(raHashTrusted('n64')).toBe(true)
    expect(raHashTrusted('apple2')).toBe(false)
    expect(raHashTrusted('n64dd')).toBe(false)
    expect(raHashTrusted('arduboy')).toBe(false)
    expect(raHashTrusted('ps3')).toBe(false)
  })
})
