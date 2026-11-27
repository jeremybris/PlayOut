import { describe, expect, it } from 'vitest'
import type { Game } from '@shared/types'
import {
  libraryReleaseEras,
  currentEraIds,
  RELEASE_ERAS,
  releaseEraLabel,
  releaseEraOf,
  releaseYear
} from './releaseEras'

const game = (releaseDate?: string): Pick<Game, 'metadata'> =>
  ({ metadata: releaseDate ? { releaseDate } : {} }) as Pick<Game, 'metadata'>

describe('release eras', () => {
  it('offers the ranges newest first, ending with Before 1990, so no year is left out', () => {
    expect(RELEASE_ERAS.map((e) => e.label)).toEqual([
      '2025-Present',
      '2020-2025',
      '2015-2020',
      '2010-2015',
      '2005-2010',
      '2000-2005',
      '1990-2000',
      'Before 1990'
    ])
    // Back to back: each range ends where the one before it (newer) starts.
    for (let i = 1; i < RELEASE_ERAS.length; i++)
      expect(RELEASE_ERAS[i]!.to).toBe(RELEASE_ERAS[i - 1]!.from)
  })

  it('reads tabs saved with the old pre-1990 ranges as Before 1990', () => {
    expect(currentEraIds(['y-1950-1980', 'y-1980-1990', 'y-2025'])).toEqual([
      'y-before-1990',
      'y-2025'
    ])
  })

  it('puts a year in the range that starts with it, never in two', () => {
    expect(releaseEraOf(1950)).toBe('y-before-1990')
    expect(releaseEraOf(1979)).toBe('y-before-1990')
    expect(releaseEraOf(1985)).toBe('y-before-1990')
    expect(releaseEraOf(1989)).toBe('y-before-1990')
    expect(releaseEraOf(1990)).toBe('y-1990-2000')
    expect(releaseEraOf(1972)).toBe('y-before-1990')
    expect(releaseEraOf(2000)).toBe('y-2000-2005')
    expect(releaseEraOf(2007)).toBe('y-2005-2010')
    expect(releaseEraOf(2024)).toBe('y-2020-2025')
    expect(releaseEraOf(2025)).toBe('y-2025')
    expect(releaseEraOf(2031)).toBe('y-2025')
    // Before 1990 has no start: an early arcade or computer game (1949) is in it too.
    expect(releaseEraOf(1949)).toBe('y-before-1990')
    expect(releaseEraOf(undefined)).toBeUndefined()
    expect(releaseEraLabel('y-2025')).toBe('2025-Present')
  })

  it('reads the year from a full date or a year alone', () => {
    expect(releaseYear(game('2020-09-17'))).toBe(2020)
    expect(releaseYear(game('1998'))).toBe(1998)
    expect(releaseYear(game('soon'))).toBeUndefined()
    expect(releaseYear(game())).toBeUndefined()
  })

  it('offers only the ranges some game was released in, newest first', () => {
    const eras = libraryReleaseEras([
      game('2020-09-17'),
      game('1998-03-31'),
      game(),
      game('2021'),
      game('1987')
    ])
    expect(eras.map((e) => e.label)).toEqual(['2020-2025', '1990-2000', 'Before 1990'])
    expect(libraryReleaseEras([game()])).toEqual([])
    // Before 1990 is always at the bottom once some year is known.
    expect(libraryReleaseEras([game('2021')]).map((e) => e.label)).toEqual([
      '2020-2025',
      'Before 1990'
    ])
  })
})
