import type { Game, GameMetadata } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { achievementsStat } from './achievements-stat'

const RECOMP = 'github:someone/game-recomp'

function game(over: Partial<Game> & { metadata?: GameMetadata } = {}): Game {
  return {
    id: 'rom:xbox360:abc',
    source: 'rom',
    platformId: 'xbox360',
    title: 'Some Game',
    installed: true,
    romPath: 'C:\\Roms\\xbox360\\Some Game.iso',
    metadata: {},
    ...over
  } as Game
}

const withRecomp = (achievements?: string[], over: Partial<Game> = {}): Game =>
  game({
    metadata: {
      recomp: {
        titleKey: 'xbox360:some game',
        count: 1,
        installed: [RECOMP],
        preferred: RECOMP,
        ...(achievements ? { achievements } : {}),
        updatedAt: ''
      }
    },
    ...over
  })

describe('achievementsStat', () => {
  it('shows an Xbox 360 card whose recompilation has achievements, as Achievements', () => {
    expect(achievementsStat(withRecomp([RECOMP]))).toEqual({ show: true, label: 'achievements' })
  })

  it('shows a recompilation-only card the same way', () => {
    const card = withRecomp([RECOMP], {
      installed: false,
      romPath: undefined,
      extra: { recompOnly: 'k' }
    })
    expect(achievementsStat(card)).toEqual({ show: true, label: 'achievements' })
  })

  it('leaves out an Xbox 360 card whose recompilation PlayOut cannot read achievements of', () => {
    expect(achievementsStat(withRecomp()).show).toBe(false)
    expect(achievementsStat(game()).show).toBe(false)
  })

  it('keeps RetroAchievements on a ROM whose recompilation has none PlayOut reads', () => {
    const n64 = withRecomp(undefined, { platformId: 'n64' })
    expect(achievementsStat(n64)).toEqual({ show: true, label: 'retro' })
  })

  it("names a paired host's counts that came from its recompilation Achievements", () => {
    const card = game({
      remote: { hostId: 'h' } as never,
      metadata: {
        achievements: { unlocked: 2, total: 10, updatedAt: '' },
        sources: { 'recomp-achievements': RECOMP }
      }
    })
    expect(achievementsStat(card)).toEqual({ show: true, label: 'achievements' })
  })

  it('does not take stale counts of a recompilation no longer installed for its own', () => {
    // Main clears them; until it has, the card is a ROM again (RetroAchievements).
    const card = game({
      platformId: 'n64',
      metadata: {
        achievements: { unlocked: 2, total: 10, updatedAt: '' },
        sources: { 'recomp-achievements': RECOMP }
      }
    })
    expect(achievementsStat(card)).toEqual({ show: true, label: 'retro' })
  })

  it('leaves a Steam card with an installed recompilation to Steam', () => {
    const steam = withRecomp([RECOMP], { source: 'steam', platformId: 'steam' })
    expect(achievementsStat(steam)).toEqual({ show: true, label: 'achievements' })
  })

  it("leaves a paired host's game to its host's counts", () => {
    const remote = withRecomp([RECOMP], { remote: { hostId: 'h' } as never })
    expect(achievementsStat(remote).show).toBe(false)
  })

  it('keeps Steam games as before', () => {
    expect(achievementsStat(game({ source: 'steam', platformId: 'steam' }))).toEqual({
      show: true,
      label: 'achievements'
    })
  })

  it('leaves out a Steam game Steam says has no achievements (Call of Duty: United Offensive)', () => {
    const none = game({
      source: 'steam',
      platformId: 'steam',
      metadata: { sources: { 'steam-achievements': 'none' } }
    })
    expect(achievementsStat(none).show).toBe(false)
  })

  it('keeps the stat of a Steam game not read yet, or read while signed out (no mark), and counts beat a mark', () => {
    expect(
      achievementsStat(game({ source: 'steam', platformId: 'steam', metadata: {} })).show
    ).toBe(true)
    const counted = game({
      source: 'steam',
      platformId: 'steam',
      metadata: {
        achievements: { unlocked: 1, total: 5, updatedAt: '' },
        sources: { 'steam-achievements': 'none' }
      }
    })
    expect(achievementsStat(counted).show).toBe(true)
  })
})
