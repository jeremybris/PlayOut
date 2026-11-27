import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import {
  parseStorageRequirement,
  steamStorageRequirement,
  type SteamAppDetails
} from './steam-store'

const KB = 1024
const MB = 1024 ** 2
const GB = 1024 ** 3
const TB = 1024 ** 4

/** A requirements block shaped like Steam's appdetails pc_requirements HTML. */
function steamList(heading: string, lines: [string, string][]): string {
  const items = lines.map(([k, v]) => `<li><strong>${k}:</strong> ${v}<br></li>`).join('')
  return `<strong>${heading}:</strong><br><ul class="bb_ul">${items}</ul>`
}

const BASE_LINES: [string, string][] = [
  ['OS', 'Windows 10 64-bit'],
  ['Processor', 'Intel Core i5-4460'],
  ['Memory', '8 GB RAM'],
  ['Graphics', 'NVIDIA GeForce GTX 960 4GB'],
  ['DirectX', 'Version 11']
]

function details(pc_requirements: SteamAppDetails['pc_requirements']): SteamAppDetails {
  return { pc_requirements } as SteamAppDetails
}

describe('parseStorageRequirement', () => {
  it('reads the storage line of a Steam requirements list', () => {
    const html = steamList('Minimum', [...BASE_LINES, ['Storage', '8 GB available space']])
    expect(parseStorageRequirement(html)).toBe(8 * GB)
  })

  it('understands the label variants stores use', () => {
    expect(parseStorageRequirement(steamList('Minimum', [['Hard Drive', '500 MB']]))).toBe(500 * MB)
    expect(parseStorageRequirement(steamList('Minimum', [['Hard Disk Space', '1,5 GB']]))).toBe(
      1.5 * GB
    )
    expect(parseStorageRequirement(steamList('Minimum', [['HDD', '40GB']]))).toBe(40 * GB)
    expect(parseStorageRequirement(steamList('Minimum', [['Disk Space', '700 KB']]))).toBe(700 * KB)
    expect(parseStorageRequirement('<li><strong>Free Space:</strong> 2 GB</li>')).toBe(2 * GB)
  })

  it('reads terabytes and fractional sizes', () => {
    expect(parseStorageRequirement(steamList('Minimum', [['Storage', '1.2 TB']]))).toBe(
      Math.round(1.2 * TB)
    )
    expect(parseStorageRequirement(steamList('Minimum', [['Storage', '2.5 GB']]))).toBe(2.5 * GB)
  })

  it('treats GiB and MiB as the same binary units', () => {
    expect(parseStorageRequirement(steamList('Minimum', [['Storage', '10 GiB available']]))).toBe(
      10 * GB
    )
    expect(parseStorageRequirement(steamList('Minimum', [['Storage', '300 MiB']]))).toBe(300 * MB)
  })

  it('ignores other lines that mention a size (RAM, VRAM)', () => {
    const html = steamList('Minimum', BASE_LINES)
    expect(parseStorageRequirement(html)).toBeUndefined()
    expect(parseStorageRequirement('Memory: 8 GB RAM<br>Graphics: 2 GB VRAM<br>')).toBeUndefined()
  })

  it('picks the storage line even when RAM comes first on plain <br> lines', () => {
    expect(
      parseStorageRequirement(
        'OS: Windows 7<br>Memory: 16 GB RAM<br>Hard Drive: 20 GB available space<br>'
      )
    ).toBe(20 * GB)
  })

  it('handles &nbsp; between number and unit', () => {
    expect(parseStorageRequirement('<li><strong>Storage:</strong> 12&nbsp;GB</li>')).toBe(12 * GB)
  })

  it('skips a storage line without a size', () => {
    expect(
      parseStorageRequirement(steamList('Minimum', [...BASE_LINES, ['Storage', 'SSD required']]))
    ).toBeUndefined()
    // ...and keeps looking at later lines that have one.
    expect(
      parseStorageRequirement(
        '<li>Storage: SSD recommended</li><li>Hard Drive: 30 GB available space</li>'
      )
    ).toBe(30 * GB)
  })

  it('returns undefined for empty input', () => {
    expect(parseStorageRequirement(undefined)).toBeUndefined()
    expect(parseStorageRequirement('')).toBeUndefined()
    expect(parseStorageRequirement('<ul></ul>')).toBeUndefined()
  })

  // Steam lists do use this form (e.g. "Storage: 1,000 MB available space").
  it('reads a thousands separator in a megabyte figure', () => {
    expect(parseStorageRequirement(steamList('Minimum', [['Storage', '1,000 MB']]))).toBe(1000 * MB)
    expect(
      parseStorageRequirement(steamList('Minimum', [['Storage', '1,200 MB available space']]))
    ).toBe(1200 * MB)
    expect(parseStorageRequirement(steamList('Minimum', [['Storage', '12,500 MB']]))).toBe(
      12500 * MB
    )
    expect(parseStorageRequirement(steamList('Minimum', [['Storage', '1,234,567 KB']]))).toBe(
      1234567 * KB
    )
    expect(parseStorageRequirement(steamList('Minimum', [['Storage', '1,024.5 MB']]))).toBe(
      Math.round(1024.5 * MB)
    )
  })

  it('still reads a comma before one, two or four digits as a decimal comma', () => {
    expect(parseStorageRequirement(steamList('Minimum', [['Storage', '1,5 GB']]))).toBe(1.5 * GB)
    expect(parseStorageRequirement(steamList('Minimum', [['Storage', '2,25 GB']]))).toBe(2.25 * GB)
    expect(parseStorageRequirement(steamList('Minimum', [['Storage', '1,2500 GB']]))).toBe(
      1.25 * GB
    )
  })
})

describe('steamStorageRequirement', () => {
  const minimum = steamList('Minimum', [...BASE_LINES, ['Storage', '50 GB available space']])
  const recommended = steamList('Recommended', [
    ...BASE_LINES,
    ['Storage', '70 GB available space (SSD)']
  ])

  it('prefers the recommended list', () => {
    expect(steamStorageRequirement(details({ minimum, recommended }))).toBe(70 * GB)
  })

  it('falls back to the minimum list', () => {
    expect(steamStorageRequirement(details({ minimum }))).toBe(50 * GB)
    expect(
      steamStorageRequirement(
        details({ minimum, recommended: steamList('Recommended', BASE_LINES) })
      )
    ).toBe(50 * GB)
  })

  it('is undefined when Steam has no requirements', () => {
    expect(steamStorageRequirement(details([]))).toBeUndefined()
    expect(steamStorageRequirement(details(undefined))).toBeUndefined()
    expect(steamStorageRequirement(details({}))).toBeUndefined()
    expect(
      steamStorageRequirement(details({ minimum: steamList('Minimum', BASE_LINES) }))
    ).toBeUndefined()
  })
})
