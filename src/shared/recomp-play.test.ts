import { describe, expect, it } from 'vitest'
import {
  playableHere,
  recompAchievementsFor,
  recompInPlaceOf,
  recompOnlyKey,
  recompToPlay,
  staleStandIns
} from './recomp-play'
import { recompAchievementsSupported } from './recomp'
import type { Game, GameRecompInfo } from './types'

type RomLike = Pick<Game, 'source' | 'installed' | 'romRemoved' | 'metadata'> & { remote?: unknown }

const recomp = (installed: string[], preferred = 'b'): GameRecompInfo => ({
  titleKey: 'ps4:gravityrush2',
  count: 2,
  installed,
  preferred,
  updatedAt: ''
})
const rom = (patch: Partial<Game> & { remote?: unknown } = {}): RomLike =>
  ({
    source: 'rom',
    installed: true,
    metadata: { recomp: recomp(['a', 'b']) },
    ...patch
  }) as RomLike

describe('playableHere', () => {
  it('is installed, or a recompilation stands in for it', () => {
    expect(playableHere(rom())).toBe(true)
    expect(playableHere(rom({ installed: false }))).toBe(true)
    expect(playableHere(rom({ installed: false, metadata: {} as never }))).toBe(false)
  })
})

describe('recompInPlaceOf', () => {
  it('is the recompilation its deleted disc image was kept for', () => {
    expect(
      recompInPlaceOf(rom({ romRemoved: { at: '', recompId: 'x', romPath: 'C:\\g.iso' } }))
    ).toBe('x')
  })
  it('is the installed recompilation (the chosen one first) when the game file is gone', () => {
    expect(recompInPlaceOf(rom({ installed: false }))).toBe('b')
    expect(
      recompInPlaceOf(rom({ installed: false, metadata: { recomp: recomp(['a'], 'b') } as never }))
    ).toBe('a')
  })
  it('is null while the game file is there, without an installed recompilation, or for a host’s game', () => {
    expect(recompInPlaceOf(rom())).toBeNull()
    expect(
      recompInPlaceOf(rom({ installed: false, metadata: { recomp: recomp([]) } as never }))
    ).toBeNull()
    expect(recompInPlaceOf(rom({ installed: false, metadata: {} as never }))).toBeNull()
    expect(recompInPlaceOf(rom({ installed: false, remote: { hostId: 'h' } as never }))).toBeNull()
    expect(recompInPlaceOf(rom({ installed: false, source: 'steam' }))).toBeNull()
  })
})

describe('recompToPlay', () => {
  it('is any installed recompilation, the chosen one first, even with the game file still there', () => {
    // The game file is there and a recompilation is installed: Play starts the recompilation.
    expect(recompToPlay(rom())).toBe('b')
    expect(recompToPlay(rom({ metadata: { recomp: recomp(['a'], 'b') } as never }))).toBe('a')
    // The one standing in for a deleted image wins.
    expect(
      recompToPlay(
        rom({
          romRemoved: { at: '', recompId: 'a', romPath: 'x.iso' },
          metadata: { recomp: recomp(['a', 'b']) } as never
        })
      )
    ).toBe('a')
  })

  it('is nothing with no installed recompilation, or for a host’s game', () => {
    expect(recompToPlay(rom({ metadata: { recomp: recomp([]) } as never }))).toBeNull()
    expect(recompToPlay(rom({ metadata: {} as never }))).toBeNull()
    expect(recompToPlay(rom({ remote: { hostId: 'h' } as never }))).toBeNull()
  })
})

describe('staleStandIns', () => {
  const card = (id: string, patch: Partial<Game> = {}): Game =>
    ({ id, platformId: 'xbox360', ...rom(patch) }) as Game

  it("leaves out an old record standing in through its recompilation beside the game's copy on this PC", () => {
    // SSX: the old extracted-folder record (file gone, recompilations installed) and the disc image found by the scan.
    const old = card('old', { installed: false })
    const now = card('now')
    expect([...staleStandIns([old, now])]).toEqual(['old'])
  })

  it('keeps it when it is the only copy, when the image was deleted for the recompilation, or on another system', () => {
    expect([...staleStandIns([card('only', { installed: false })])]).toEqual([])
    const deleted = card('gone', {
      installed: false,
      romRemoved: { at: '', recompId: 'b', romPath: 'x.iso' }
    })
    expect([...staleStandIns([deleted, card('now')])]).toEqual([])
    const ps3 = { ...card('ps3', { installed: false }), platformId: 'ps3' } as Game
    expect([...staleStandIns([ps3, card('now')])]).toEqual([])
  })
})

describe('recompOnlyKey', () => {
  it("names a recompilation's own card, never a host's game or another card", () => {
    expect(recompOnlyKey({ extra: { recompOnly: 'n64:mm' } })).toBe('n64:mm')
    expect(recompOnlyKey({ extra: { recompOnly: 'n64:mm' }, remote: {} })).toBeNull()
    expect(recompOnlyKey({ extra: {} })).toBeNull()
    expect(recompOnlyKey({})).toBeNull()
  })
})

describe('recompAchievementsFor', () => {
  it('is the recompilation Play starts when PlayOut reads its achievements', () => {
    const withAch = (achievements: string[]): RomLike =>
      rom({ metadata: { recomp: { ...recomp(['a', 'b']), achievements } } as never })
    expect(recompAchievementsFor(withAch(['b']))).toBe('b')
    // Another installed version has them, but Play starts 'b'.
    expect(recompAchievementsFor(withAch(['a']))).toBeNull()
    expect(recompAchievementsFor(rom())).toBeNull()
    expect(recompAchievementsFor({ ...withAch(['b']), remote: { hostId: 'h' } })).toBeNull()
  })
})

describe('recompAchievementsSupported', () => {
  it('is an Xbox 360 recompilation the catalog gives a title id or user data folder for', () => {
    expect(
      recompAchievementsSupported({ systemId: 'xbox360', rl: { id: 'x', titleId: '4D5307E6' } })
    ).toBe(true)
    expect(
      recompAchievementsSupported({
        systemId: 'xbox360',
        rl: { id: 'x', achievementsFolder: '{game}' }
      })
    ).toBe(true)
    expect(recompAchievementsSupported({ systemId: 'xbox360', rl: { id: 'x' } })).toBe(false)
    expect(recompAchievementsSupported({ systemId: 'xbox360' })).toBe(false)
    // The PlayStation and Game Boy Advance recompilations report unlocks another way: not read.
    expect(
      recompAchievementsSupported({ systemId: 'psx', rl: { id: 'x', titleId: '4D5307E6' } })
    ).toBe(false)
    expect(recompAchievementsSupported(null)).toBe(false)
  })
})
