import { describe, expect, it } from 'vitest'
import type { Game } from '@shared/types'
import {
  ALL_SIZES,
  SIZE_BUCKETS,
  installSizeBytes,
  installSizeText,
  parseSizeInput,
  sizeBucketOf
} from './installSize'

const KB = 1024
const MB = 1024 ** 2
const GB = 1024 ** 3
const TB = 1024 ** 4
const measuredAt = '2026-11-01T00:00:00.000Z'
const checkedAt = measuredAt

type SizeInput = Parameters<typeof installSizeText>[0]
type Storage = NonNullable<Game['metadata']['storage']>

/** A game for installSizeText: not installed, nothing known, no user size unless overridden. */
function game(over: Partial<SizeInput> = {}): SizeInput {
  return { installed: false, metadata: {}, user: {}, ...over }
}

function storage(bytes: number | undefined, how?: Storage['how']): Game['metadata'] {
  return { storage: { bytes, how, checkedAt } }
}

describe('installSizeText', () => {
  it('shows the measured size of an installed game', () => {
    expect(
      installSizeText(
        game({
          installed: true,
          installSize: { bytes: 42 * GB, how: 'store', path: 'C:\\Games\\X', measuredAt }
        })
      )
    ).toEqual({ label: 'Install size', value: '42 GB', estimate: false })
    expect(
      installSizeText(
        game({
          installed: true,
          installSize: { bytes: 1.5 * GB, how: 'folder', path: 'C:\\Games\\X', measuredAt }
        })
      )?.value
    ).toBe('1.5 GB')
    expect(
      installSizeText(
        game({
          installed: true,
          installSize: { bytes: 300 * MB, how: 'file', path: 'C:\\Roms\\x.sfc', measuredAt }
        })
      )?.value
    ).toBe('300 MB')
  })

  it('shows a dash while an installed game is not measured yet', () => {
    expect(installSizeText(game({ installed: true }))).toEqual({
      label: 'Install size',
      value: '—',
      estimate: false
    })
  })

  it('ignores the store size once the game is installed and measurable', () => {
    expect(
      installSizeText(game({ installed: true, metadata: storage(8 * GB, 'requirement') }))?.value
    ).toBe('—')
    expect(
      installSizeText(
        game({
          installed: true,
          installSize: { bytes: 20 * GB, how: 'folder', path: 'C:\\Games\\X', measuredAt },
          metadata: storage(8 * GB, 'steam')
        })
      )?.value
    ).toBe('20 GB')
  })

  it('falls back to the store size for an installed game whose folder cannot be measured', () => {
    const unmeasurable = {
      bytes: 0,
      how: 'folder' as const,
      path: 'C:\\Program Files',
      measuredAt,
      unmeasurable: true as const
    }
    expect(
      installSizeText(
        game({ installed: true, installSize: unmeasurable, metadata: storage(12 * GB, 'gog') })
      )
    ).toEqual({ label: 'Install size', value: 'About 12 GB', estimate: true })
    expect(
      installSizeText(
        game({ installed: true, installSize: unmeasurable, metadata: storage(12 * GB, 'steam') })
      )
    ).toEqual({ label: 'Install size', value: '12 GB', estimate: false })
    // ...and leaves the stat out rather than showing 0 bytes when no store size is known either.
    expect(installSizeText(game({ installed: true, installSize: unmeasurable }))).toBeNull()
  })

  it('shows what Steam installs for this very game as exact', () => {
    expect(installSizeText(game({ metadata: storage(9.5 * GB, 'steam') }))).toEqual({
      label: 'Install size',
      value: '9.5 GB',
      estimate: false
    })
  })

  it('marks every other store size as an estimate', () => {
    for (const how of ['steam-match', 'gog', 'requirement', undefined] as const) {
      expect(installSizeText(game({ metadata: storage(8 * GB, how) }))).toEqual({
        label: 'Install size',
        value: 'About 8.0 GB',
        estimate: true
      })
    }
    expect(installSizeText(game({ metadata: storage(70 * GB, 'requirement') }))?.value).toBe(
      'About 70 GB'
    )
    expect(
      installSizeText(
        game({
          metadata: { storage: { bytes: 5 * GB, how: 'steam-match', steamAppId: 620, checkedAt } }
        })
      )?.value
    ).toBe('About 5.0 GB')
  })

  it('lets the size the user entered win over everything else', () => {
    const user = { installSize: 45 * GB }
    expect(installSizeText(game({ user }))).toEqual({
      label: 'Install size',
      value: '45 GB',
      estimate: false
    })
    expect(installSizeText(game({ user, metadata: storage(8 * GB, 'steam') }))?.value).toBe('45 GB')
    expect(
      installSizeText(
        game({
          user,
          installed: true,
          installSize: { bytes: 20 * GB, how: 'store', path: 'C:\\Games\\X', measuredAt }
        })
      )
    ).toEqual({ label: 'Install size', value: '45 GB', estimate: false })
    expect(
      installSizeText(
        game({
          user,
          installed: true,
          installSize: { bytes: 0, how: 'folder', measuredAt, unmeasurable: true }
        })
      )?.value
    ).toBe('45 GB')
  })

  it('ignores a cleared user size (0 or absent)', () => {
    expect(
      installSizeText(game({ user: { installSize: 0 }, metadata: storage(8 * GB, 'steam') }))?.value
    ).toBe('8.0 GB')
  })

  it('is null when nothing is known for a game that is not installed', () => {
    expect(installSizeText(game())).toBeNull()
    expect(installSizeText(game({ metadata: { storage: { checkedAt } } }))).toBeNull()
    expect(installSizeText(game({ metadata: storage(0, 'steam') }))).toBeNull()
  })
})

describe('parseSizeInput', () => {
  it('reads a number with a unit', () => {
    expect(parseSizeInput('45 GB')).toBe(45 * GB)
    expect(parseSizeInput('800mb')).toBe(800 * MB)
    expect(parseSizeInput('1.5 TB')).toBe(Math.round(1.5 * TB))
    expect(parseSizeInput('700 KB')).toBe(700 * KB)
    expect(parseSizeInput('  12 Gb  ')).toBe(12 * GB)
  })

  it('takes a plain number as gigabytes', () => {
    expect(parseSizeInput('45')).toBe(45 * GB)
    expect(parseSizeInput('2.5')).toBe(2.5 * GB)
  })

  it('accepts one-letter units and a decimal comma', () => {
    expect(parseSizeInput('500m')).toBe(500 * MB)
    expect(parseSizeInput('3 g')).toBe(3 * GB)
    expect(parseSizeInput('1 t')).toBe(TB)
    expect(parseSizeInput('64k')).toBe(64 * KB)
    expect(parseSizeInput('1,5 GB')).toBe(1.5 * GB)
  })

  it('reads a comma between thousands as grouping, and a comma before 1-2 or 4+ digits as decimal', () => {
    expect(parseSizeInput('1,200 MB')).toBe(1200 * MB)
    expect(parseSizeInput('1,200')).toBe(1200 * GB)
    expect(parseSizeInput('12,345,678 KB')).toBe(12_345_678 * KB)
    expect(parseSizeInput('1,200.5 MB')).toBe(Math.round(1200.5 * MB))
    expect(parseSizeInput('1,5 GB')).toBe(1.5 * GB)
    expect(parseSizeInput('2,25 gb')).toBe(2.25 * GB)
    expect(parseSizeInput('1,2345 GB')).toBe(Math.round(1.2345 * GB))
  })

  it('reads "45g", "45 gb" and "45" alike', () => {
    for (const text of ['45g', '45 gb', '45', '45GB', '45 G'])
      expect(parseSizeInput(text), text).toBe(45 * GB)
  })

  it('does not read a bare "b" as a unit', () => {
    for (const junk of ['b', 'B', '500 B', '500b', '45 bb', '45 gbb']) {
      expect(parseSizeInput(junk), junk).toBeNaN()
    }
  })

  it('is NaN for misplaced commas', () => {
    for (const junk of [',5 GB', '1, 5 GB', '1,,5', '1,5,6 GB', '5, GB', '1,200,5 MB']) {
      expect(parseSizeInput(junk), junk).toBeNaN()
    }
  })

  it('is undefined for an empty field', () => {
    expect(parseSizeInput('')).toBeUndefined()
    expect(parseSizeInput('   ')).toBeUndefined()
  })

  it('is NaN for text that is not a size', () => {
    for (const junk of ['abc', 'GB', '45 GB please', '-5 GB', '0', '0 MB', '1.2.3 GB', '45 PB']) {
      expect(parseSizeInput(junk), junk).toBeNaN()
    }
  })
})

describe('installSizeBytes', () => {
  const measured = (bytes: number): NonNullable<SizeInput['installSize']> => ({
    bytes,
    how: 'folder',
    path: 'C:\\Games\\X',
    measuredAt
  })
  const unmeasurable: NonNullable<SizeInput['installSize']> = {
    bytes: 0,
    how: 'folder',
    measuredAt,
    unmeasurable: true
  }

  it('lets the size the user entered win', () => {
    const user = { installSize: 45 * GB }
    expect(installSizeBytes(game({ user }))).toBe(45 * GB)
    expect(
      installSizeBytes(
        game({ user, installed: true, installSize: measured(20 * GB), metadata: storage(8 * GB) })
      )
    ).toBe(45 * GB)
  })

  it('uses the measured size of an installed game over the store size', () => {
    expect(
      installSizeBytes(
        game({ installed: true, installSize: measured(20 * GB), metadata: storage(8 * GB) })
      )
    ).toBe(20 * GB)
  })

  it('falls back to the store size when unmeasurable, not installed or not measured yet', () => {
    expect(
      installSizeBytes(
        game({ installed: true, installSize: unmeasurable, metadata: storage(12 * GB, 'gog') })
      )
    ).toBe(12 * GB)
    expect(installSizeBytes(game({ metadata: storage(9 * GB, 'steam') }))).toBe(9 * GB)
    expect(installSizeBytes(game({ installed: true, metadata: storage(7 * GB) }))).toBe(7 * GB)
    // A stale measurement of an uninstalled game does not count.
    expect(
      installSizeBytes(game({ installSize: measured(30 * GB), metadata: storage(5 * GB) }))
    ).toBe(5 * GB)
  })

  it('is undefined when nothing is known', () => {
    expect(installSizeBytes(game())).toBeUndefined()
    expect(installSizeBytes(game({ installed: true, installSize: unmeasurable }))).toBeUndefined()
    expect(installSizeBytes(game({ metadata: { storage: { checkedAt } } }))).toBeUndefined()
    expect(installSizeBytes(game({ metadata: storage(0) }))).toBeUndefined()
    expect(installSizeBytes(game({ user: { installSize: 0 } }))).toBeUndefined()
    expect(installSizeBytes(game({ installSize: measured(30 * GB) }))).toBeUndefined()
  })
})

describe('sizeBucketOf', () => {
  it('has the seven Filters > Size bands in order, plus All Sizes', () => {
    expect(ALL_SIZES).toBe('all')
    expect(SIZE_BUCKETS.map((b) => b.label)).toEqual([
      '0-1 GB',
      '1-5 GB',
      '5-15 GB',
      '15-30 GB',
      '30-60 GB',
      '60-99 GB',
      '100+ GB'
    ])
    expect(SIZE_BUCKETS.some((b) => b.id === ALL_SIZES)).toBe(false)
    // Contiguous, no gaps or overlaps.
    for (let i = 1; i < SIZE_BUCKETS.length; i++)
      expect(SIZE_BUCKETS[i]!.min).toBe(SIZE_BUCKETS[i - 1]!.max)
  })

  const label = (bytes: number | undefined): string | undefined =>
    SIZE_BUCKETS.find((b) => b.id === sizeBucketOf(bytes))?.label

  it('puts each size in its band, min inclusive and max exclusive', () => {
    expect(label(1)).toBe('0-1 GB')
    expect(label(500 * MB)).toBe('0-1 GB')
    expect(label(GB - 1)).toBe('0-1 GB')
    expect(label(1 * GB)).toBe('1-5 GB')
    expect(label(4.99 * GB)).toBe('1-5 GB')
    expect(label(5 * GB)).toBe('5-15 GB')
    expect(label(15 * GB)).toBe('15-30 GB')
    expect(label(30 * GB)).toBe('30-60 GB')
    expect(label(60 * GB)).toBe('60-99 GB')
    expect(label(99.9 * GB)).toBe('60-99 GB')
    expect(label(100 * GB - 1)).toBe('60-99 GB')
    expect(label(100 * GB)).toBe('100+ GB')
    expect(label(5 * TB)).toBe('100+ GB')
  })

  it('is undefined for an unknown or empty size', () => {
    expect(sizeBucketOf(undefined)).toBeUndefined()
    expect(sizeBucketOf(0)).toBeUndefined()
    expect(sizeBucketOf(-1)).toBeUndefined()
    expect(sizeBucketOf(Number.NaN)).toBeUndefined()
  })
})

describe('installSizeBytes with a folder measured at 0 bytes', () => {
  it('falls back to the store size, else unknown', () => {
    const base = {
      installed: true,
      installSize: { bytes: 0, how: 'folder' as const, measuredAt: '2026-01-01T00:00:00Z' },
      user: {}
    }
    expect(installSizeBytes({ ...base, metadata: {} })).toBeUndefined()
    expect(
      installSizeBytes({ ...base, metadata: { storage: { bytes: 5, checkedAt: '2026-01-01' } } })
    ).toBe(5)
  })
})

describe('games played from their recompilation', () => {
  const removed = {
    at: measuredAt,
    recompId: 'zelda64',
    romPath: 'D:/roms/n64/Zelda.z64',
    installSize: { bytes: 64 * MB, how: 'file' as const, path: 'D:/roms/n64/Zelda.z64', measuredAt }
  }

  it("shows the recompilation folder's size, else the disc image's last size", () => {
    expect(installSizeText(game({ source: 'rom', romRemoved: removed }))?.value).toBe(
      installSizeText(game({ installed: true, installSize: removed.installSize }))?.value
    )
    const folder = { bytes: 3 * GB, how: 'folder' as const, path: 'D:/Recomp/zelda64', measuredAt }
    const text = installSizeText(game({ source: 'rom', romRemoved: removed, installSize: folder }))
    expect(text).toMatchObject({ estimate: false })
    expect(text?.value).toBe(installSizeText(game({ installed: true, installSize: folder }))?.value)
    expect(
      installSizeBytes(game({ source: 'rom', romRemoved: removed, installSize: folder }))
    ).toBe(3 * GB)
    expect(installSizeBytes(game({ source: 'rom', romRemoved: removed }))).toBe(64 * MB)
  })

  it('still shows nothing for an ordinary game that is not installed', () => {
    expect(installSizeText(game({ source: 'rom' }))).toBeNull()
  })
})
