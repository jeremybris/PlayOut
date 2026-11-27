import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import {
  configurePlatformIds,
  knownPlatformKeys,
  platformIdFor,
  platformKeyForGame,
  platformNameFor,
  platformYearsFor,
  searchNameFor
} from './platform-ids'

const RESEARCH_TABLE = resolve(__dirname, '../../../docs/research/platform-ids.json')

afterEach(() => {
  configurePlatformIds(resolve(__dirname, '../../../resources/systems'))
})

describe('platformIdFor', () => {
  it('finds the bundled data file relative to the module', () => {
    expect(platformIdFor('igdb', 'snes')).toBe(19)
    expect(platformIdFor('screenscraper', 'snes')).toBe(4)
    expect(platformIdFor('thegamesdb', 'snes')).toBe(6)
    expect(platformIdFor('igdb', 'pc')).toBe(6)
    expect(platformIdFor('screenscraper', 'pc')).toBe(138)
    expect(platformIdFor('thegamesdb', 'pc')).toBe(1)
  })

  it('agrees with the research table for every key it lists', async () => {
    const research = JSON.parse(await fs.readFile(RESEARCH_TABLE, 'utf8')) as Record<
      string,
      { igdb: number; screenscraper: number; thegamesdb: number }
    >
    expect(Object.keys(research).length).toBeGreaterThanOrEqual(42)
    for (const [key, ids] of Object.entries(research)) {
      expect({ key, igdb: platformIdFor('igdb', key) }).toEqual({ key, igdb: ids.igdb })
      expect({ key, ss: platformIdFor('screenscraper', key) }).toEqual({
        key,
        ss: ids.screenscraper
      })
      expect({ key, tgdb: platformIdFor('thegamesdb', key) }).toEqual({ key, tgdb: ids.thegamesdb })
    }
  })

  it('covers every ES-DE scraper platform and resolves ES-DE folder aliases', async () => {
    const esde = JSON.parse(
      await fs.readFile(
        resolve(__dirname, '../../../docs/research/esde-scraper-platforms.json'),
        'utf8'
      )
    ) as Record<
      string,
      { screenscraperId: number | null; thegamesdbId: number | null; systems: string[] }
    >
    const keys = new Set(knownPlatformKeys())
    for (const [key, entry] of Object.entries(esde)) {
      expect(keys.has(key), `missing key ${key}`).toBe(true)
      // 'pc' is PlayOut's Windows platform (138), not ES-DE's DOS-era "IBM PC" folder (135).
      if (entry.screenscraperId && key !== 'pc')
        expect(platformIdFor('screenscraper', key)).toBe(entry.screenscraperId)
      if (entry.thegamesdbId) expect(platformIdFor('thegamesdb', key)).toBe(entry.thegamesdbId)
      for (const system of entry.systems)
        expect(keys.has(system), `missing system alias ${system}`).toBe(true)
    }
    expect(platformIdFor('igdb', 'sfc')).toBe(19)
    expect(platformIdFor('screenscraper', 'megadrivejp')).toBe(1)
    expect(platformIdFor('thegamesdb', 'mame')).toBe(23)
    expect(platformIdFor('igdb', '3ds')).toBe(37)
    expect(platformNameFor('n64')).toBe('Nintendo 64')
  })

  it('is case-insensitive and returns undefined for unknown or unmapped keys', () => {
    expect(platformIdFor('igdb', ' SNES ')).toBe(19)
    expect(platformIdFor('igdb', 'not-a-platform')).toBeUndefined()
    expect(platformIdFor('thegamesdb', 'adam')).toBeUndefined()
    expect(platformIdFor('screenscraper', 'flash')).toBeUndefined()
  })

  it('reads a configured directory and falls back to the bundled table when it has no file', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'playout-platform-ids-'))
    try {
      await fs.writeFile(
        join(dir, 'platform-ids.json'),
        JSON.stringify({ Custom: { igdb: 1234, screenscraper: null, thegamesdb: 'x' } })
      )
      configurePlatformIds(dir)
      expect(platformIdFor('igdb', 'custom')).toBe(1234)
      expect(platformIdFor('screenscraper', 'custom')).toBeUndefined()
      expect(platformIdFor('thegamesdb', 'custom')).toBeUndefined()
      expect(platformIdFor('igdb', 'snes')).toBeUndefined()
      configurePlatformIds(join(dir, 'missing'))
      expect(platformIdFor('igdb', 'custom')).toBeUndefined()
      expect(platformIdFor('igdb', 'snes')).toBe(19)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('platformKeyForGame', () => {
  it('uses pc for store and manual games, the recorded platform key or the system id for ROMs', () => {
    expect(platformKeyForGame({ source: 'steam', platformId: 'steam' })).toBe('pc')
    expect(platformKeyForGame({ source: 'manual', platformId: 'pc' })).toBe('pc')
    expect(platformKeyForGame({ source: 'rom', platformId: 'sfc' })).toBe('sfc')
    expect(
      platformKeyForGame({ source: 'rom', platformId: 'sfc', extra: { platformKey: 'SNES' } })
    ).toBe('snes')
    expect(platformKeyForGame({ source: 'rom', platformId: '', extra: {} })).toBe('pc')
  })
})

describe('searchNameFor', () => {
  it('prefers an explicit query, then the title override, and strips ROM tags', () => {
    expect(searchNameFor({ title: 'Super Mario World (USA) [!]' }, '  zelda ')).toBe('zelda')
    expect(searchNameFor({ title: 'Super Mario World (USA) [!]' })).toBe('Super Mario World')
    expect(searchNameFor({ title: 'Legend of Zelda, The (Europe)' })).toBe('The Legend of Zelda')
    expect(searchNameFor({ title: 'Portal 2', user: { titleOverride: 'Portal II' } })).toBe(
      'Portal II'
    )
    expect(searchNameFor({ title: 'Half-Life™ 2' })).toBe('Half-Life 2')
    expect(searchNameFor({ title: '(USA)' })).toBe('(USA)')
  })
})

describe('platformYearsFor', () => {
  it('gives the years of a console, open-ended for one that still has new games, none for a computer', () => {
    expect(platformYearsFor('ps2')).toEqual({ from: 2000, to: 2013 })
    expect(platformYearsFor('PS3')).toEqual({ from: 2006, to: 2017 })
    expect(platformYearsFor('xbox360')).toEqual({ from: 2005, to: 2018 })
    expect(platformYearsFor('switch')).toEqual({ from: 2017 })
    expect(platformYearsFor('gb')).toEqual({ from: 1989, to: 2001 })
    expect(platformYearsFor('megadrivejp')).toEqual(platformYearsFor('genesis'))
    expect(platformYearsFor('pc')).toBeUndefined()
    expect(platformYearsFor('dos')).toBeUndefined()
    expect(platformYearsFor('arcade')).toBeUndefined()
    expect(platformYearsFor('unknownsys')).toBeUndefined()
  })
})
