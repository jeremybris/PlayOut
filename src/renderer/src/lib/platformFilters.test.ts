import type { Game, Platform } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  ALL_ROM_PLATFORMS,
  libraryPlatformFilters,
  matchesPlatformFilter,
  pickPlatform
} from './platformFilters'
import type { PlatformKindOf } from './storeFilters'

type G = Pick<Game, 'source' | 'platformId'>
const kindOf: PlatformKindOf = (id) =>
  id === 'pc' ? 'pc' : ['snes', 'nes', 'psx'].includes(id) ? 'system' : 'store'
const rom: G = { source: 'rom', platformId: 'snes' }
const steam: G = { source: 'steam', platformId: 'steam' }
const exe: G = { source: 'manual', platformId: 'pc' }

describe('libraryPlatformFilters', () => {
  it('offers the emulated systems with games, never stores or plain PC games', () => {
    const platforms = [
      { id: 'steam', kind: 'store' },
      { id: 'pc', kind: 'pc' },
      { id: 'snes', kind: 'system' },
      { id: 'psx', kind: 'system' }
    ] as Platform[]
    const games = [rom, steam, exe] as Game[]
    expect(libraryPlatformFilters(games, platforms, (id) => id.toUpperCase())).toEqual([
      { id: 'snes', label: 'SNES' }
    ])
  })
})

describe('matchesPlatformFilter', () => {
  it('keeps every game when nothing is picked', () => {
    for (const g of [rom, steam, exe])
      expect(matchesPlatformFilter(g, new Set(), kindOf)).toBe(true)
  })

  it('keeps every emulation game, and no store or other PC game, for All Platforms', () => {
    const all = new Set([ALL_ROM_PLATFORMS])
    expect(matchesPlatformFilter(rom, all, kindOf)).toBe(true)
    expect(matchesPlatformFilter({ source: 'manual', platformId: 'psx' }, all, kindOf)).toBe(true)
    expect(matchesPlatformFilter(steam, all, kindOf)).toBe(false)
    expect(matchesPlatformFilter(exe, all, kindOf)).toBe(false)
  })

  it('keeps the games of the picked platforms', () => {
    expect(matchesPlatformFilter(rom, new Set(['snes']), kindOf)).toBe(true)
    expect(matchesPlatformFilter(rom, new Set(['nes']), kindOf)).toBe(false)
  })
})

describe('pickPlatform', () => {
  it('turns All Platforms on alone, and off when pressed again', () => {
    expect(pickPlatform([], ALL_ROM_PLATFORMS)).toEqual([ALL_ROM_PLATFORMS])
    expect(pickPlatform(['snes', 'nes'], ALL_ROM_PLATFORMS)).toEqual([ALL_ROM_PLATFORMS])
    expect(pickPlatform([ALL_ROM_PLATFORMS], ALL_ROM_PLATFORMS)).toEqual([])
  })

  it('replaces All Platforms with a platform, and toggles platforms', () => {
    expect(pickPlatform([ALL_ROM_PLATFORMS], 'snes')).toEqual(['snes'])
    expect(pickPlatform(['snes'], 'nes')).toEqual(['snes', 'nes'])
    expect(pickPlatform(['snes', 'nes'], 'snes')).toEqual(['nes'])
  })
})
