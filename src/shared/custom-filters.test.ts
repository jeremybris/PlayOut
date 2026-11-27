import { describe, expect, it } from 'vitest'
import {
  CUSTOM_FILTER_ICONS,
  cleanFilterName,
  customFilterIcon,
  filterNameProblem,
  MAX_CUSTOM_FILTER_GAMES,
  MAX_CUSTOM_FILTERS,
  newCustomFilterId,
  normalizeCustomFilters
} from './custom-filters'

describe('custom filter names', () => {
  const filters = [{ id: 'a', name: 'Couch Co-op' }]

  it('are trimmed, with inner runs of spaces made one', () => {
    expect(cleanFilterName('  To   finish ')).toBe('To finish')
  })

  it('must not be empty, longer than 40 characters or another filter’s (any case)', () => {
    expect(filterNameProblem('   ', filters)).toBe('empty')
    expect(filterNameProblem('x'.repeat(41), filters)).toBe('tooLong')
    expect(filterNameProblem('x'.repeat(40), filters)).toBeNull()
    expect(filterNameProblem(' couch  co-op ', filters)).toBe('taken')
    // Renaming the filter itself to another case of its name is fine.
    expect(filterNameProblem('COUCH CO-OP', filters, 'a')).toBeNull()
  })
})

describe('custom filter icons', () => {
  it('are forty curated ones, each once; an unknown one becomes the default', () => {
    expect(CUSTOM_FILTER_ICONS).toHaveLength(40)
    expect(new Set(CUSTOM_FILTER_ICONS).size).toBe(40)
    expect(customFilterIcon('skull')).toBe('skull')
    expect(customFilterIcon('nope')).toBe('star')
    expect(customFilterIcon(5)).toBe('star')
  })
})

describe('newCustomFilterId', () => {
  it('is fresh every time and never one taken', () => {
    const a = newCustomFilterId([], 1000)
    const b = newCustomFilterId([{ id: a }], 1000)
    expect(a).not.toBe(b)
    expect(a.startsWith('cf')).toBe(true)
  })
})

describe('normalizeCustomFilters', () => {
  it('keeps good filters and repairs or drops bad ones entry by entry', () => {
    expect(normalizeCustomFilters('x')).toEqual([])
    expect(
      normalizeCustomFilters([
        { id: 'a', name: ' Hard ', icon: 'skull', gameIds: ['g1', 'g1', 5, ''] },
        { id: 'a', name: 'Repeated id', icon: 'star', gameIds: [] },
        { id: 'b', name: '', icon: 'star', gameIds: [] },
        null,
        { id: 'c', name: 'hard', icon: 'unknown', gameIds: 'x' }
      ])
    ).toEqual([
      { id: 'a', name: 'Hard', icon: 'skull', gameIds: ['g1'] },
      // A second filter of the same name gets a number; an unknown icon the default.
      { id: 'c', name: 'hard 2', icon: 'star', gameIds: [] }
    ])
  })

  it('keeps at most 100 filters of at most 10,000 games', () => {
    const many = Array.from({ length: MAX_CUSTOM_FILTERS + 5 }, (_, i) => ({
      id: `f${i}`,
      name: `F${i}`,
      icon: 'star',
      gameIds: i === 0 ? Array.from({ length: MAX_CUSTOM_FILTER_GAMES + 3 }, (_, j) => `g${j}`) : []
    }))
    const out = normalizeCustomFilters(many)
    expect(out).toHaveLength(MAX_CUSTOM_FILTERS)
    expect(out[0]!.gameIds).toHaveLength(MAX_CUSTOM_FILTER_GAMES)
  })
})

describe('custom filter words', () => {
  it('name every icon and every name problem in English and Spanish', async () => {
    for (const lang of ['en', 'es']) {
      const words = (await import(`./i18n/locales/${lang}/customFilter.json`)).default as {
        icons: Record<string, string>
        problem: Record<string, string>
      }
      expect(Object.keys(words.icons).sort(), lang).toEqual([...CUSTOM_FILTER_ICONS].sort())
      expect(Object.keys(words.problem).sort(), lang).toEqual(['empty', 'taken', 'tooLong'])
    }
  })
})
