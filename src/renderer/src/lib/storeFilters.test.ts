import type { Game } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  ALL_STORES,
  gameFamily,
  isStoreFilter,
  libraryStoreFilters,
  matchesStoreFilter,
  OTHER_PC,
  pickStore,
  STORE_FILTERS,
  storeFilterLabel,
  type PlatformKindOf
} from './storeFilters'

type G = Pick<Game, 'source' | 'platformId'>
const kindOf: PlatformKindOf = (id) =>
  id === 'pc' ? 'pc' : ['snes', 'psx'].includes(id) ? 'system' : 'store'
const steam: G = { source: 'steam', platformId: 'steam' }
const rom: G = { source: 'rom', platformId: 'snes' }
const exe: G = { source: 'manual', platformId: 'pc' }

describe('Filters > PC', () => {
  it("names the stores the user's way, in the user's order, then Other", () => {
    expect(STORE_FILTERS.map((s) => s.label)).toEqual([
      'Steam',
      'Epic',
      'G.O.G',
      'Xbox',
      'Ubisoft Connect',
      'EA App',
      'Battle.Net'
    ])
    expect(storeFilterLabel('battlenet')).toBe('Battle.Net')
    expect(storeFilterLabel(OTHER_PC)).toBe('Other')
  })

  it('offers the stores with games, and Other when there is a PC game from outside them', () => {
    const games: G[] = [{ source: 'gog', platformId: 'gog' }, steam, rom]
    expect(libraryStoreFilters(games, kindOf).map((s) => s.id)).toEqual(['steam', 'gog'])
    expect(libraryStoreFilters([...games, exe], kindOf).map((s) => s.id)).toEqual([
      'steam',
      'gog',
      OTHER_PC
    ])
    expect(libraryStoreFilters([], kindOf)).toEqual([])
    expect(isStoreFilter('ubisoft')).toBe(true)
    expect(isStoreFilter('rom')).toBe(false)
  })

  it('keeps the picked stores, and for Other the PC games from outside the stores', () => {
    expect(matchesStoreFilter(rom, new Set(), kindOf)).toBe(true)
    expect(matchesStoreFilter(steam, new Set(['steam']), kindOf)).toBe(true)
    expect(matchesStoreFilter(exe, new Set(['steam']), kindOf)).toBe(false)
    const other = new Set([OTHER_PC])
    expect(matchesStoreFilter(exe, other, kindOf)).toBe(true)
    expect(matchesStoreFilter(steam, other, kindOf)).toBe(false)
    expect(matchesStoreFilter(rom, other, kindOf)).toBe(false)
  })
})

describe('All Stores', () => {
  it("keeps every PC game, the stores' and Other's, and no emulation game", () => {
    const all = new Set([ALL_STORES])
    expect(matchesStoreFilter(steam, all, kindOf)).toBe(true)
    expect(matchesStoreFilter(exe, all, kindOf)).toBe(true)
    expect(matchesStoreFilter(rom, all, kindOf)).toBe(false)
    expect(storeFilterLabel(ALL_STORES)).toBe('All Stores')
  })

  it('is on alone, off when pressed again, and replaced by a store or Other', () => {
    expect(pickStore(['steam', OTHER_PC], ALL_STORES)).toEqual([ALL_STORES])
    expect(pickStore([ALL_STORES], ALL_STORES)).toEqual([])
    expect(pickStore([ALL_STORES], 'epic')).toEqual(['epic'])
    expect(pickStore(['epic'], OTHER_PC)).toEqual(['epic', OTHER_PC])
    expect(pickStore(['epic', OTHER_PC], 'epic')).toEqual([OTHER_PC])
  })
})

describe('gameFamily', () => {
  it('splits games into store, emulation and other PC games', () => {
    expect(gameFamily(steam, kindOf)).toBe('store')
    expect(gameFamily(rom, kindOf)).toBe('emulation')
    expect(gameFamily(exe, kindOf)).toBe('other-pc')
    // A game added by hand on an emulated system's platform is an emulation game.
    expect(gameFamily({ source: 'manual', platformId: 'psx' }, kindOf)).toBe('emulation')
  })
})
