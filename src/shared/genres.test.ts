import { describe, expect, it } from 'vitest'
import { gameGenres } from './genres'
import type { Game } from './types'

const g = (source: string, metadata: Game['metadata']): Pick<Game, 'source' | 'metadata'> =>
  ({ source, metadata }) as Pick<Game, 'source' | 'metadata'>

describe('gameGenres', () => {
  it('shows the LaunchBox genres for ROM games only, the scraped ones otherwise', () => {
    const lb = { genres: ['Adventure', 'Puzzle'], launchboxId: 50 }
    expect(gameGenres(g('rom', { genres: ['Puzzle'], launchboxGenres: lb }))).toEqual([
      'Adventure',
      'Puzzle'
    ])
    // GOG, Epic and other stores keep their scraped genres.
    expect(gameGenres(g('gog', { genres: ['Puzzle'], launchboxGenres: lb }))).toEqual(['Puzzle'])
    expect(gameGenres(g('epic', { genres: ['RPG'], launchboxGenres: lb }))).toEqual(['RPG'])
    expect(gameGenres(g('rom', { launchboxGenres: lb }))).toEqual(['Adventure', 'Puzzle'])
    expect(gameGenres(g('steam', { genres: ['Action'], launchboxGenres: lb }))).toEqual(['Action'])
    // No LaunchBox genres (a miss, or LaunchBox not reached yet): the scraped ones.
    expect(gameGenres(g('rom', { genres: ['RPG'], launchboxGenres: { missedAt: 'x' } }))).toEqual([
      'RPG'
    ])
    expect(gameGenres(g('rom', { genres: ['RPG'] }))).toEqual(['RPG'])
    expect(gameGenres(g('rom', { genres: ['RPG'], launchboxGenres: { genres: ['  '] } }))).toEqual([
      'RPG'
    ])
    expect(gameGenres(g('xbox', {}))).toEqual([])
  })
})
