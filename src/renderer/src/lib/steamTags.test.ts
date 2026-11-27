import { describe, expect, it } from 'vitest'
import {
  detailChips,
  detailTags,
  genreFilterFor,
  genreFilterIdsOf,
  hasTagFilter,
  libraryTagFilters,
  steamTagsOf,
  tagFilterFor,
  tagFilterKey,
  tagFilterLabel,
  TAG_FILTERS
} from './steamTags'

describe('detailTags', () => {
  it('shows the strongest tags without the genre already on the page', () => {
    const meta = {
      genres: ['Action'],
      steamTags: { tags: ['action', 'Roguelike', 'Indie', 'Hack and Slash', 'Mythology', 'RPG'] }
    }
    expect(detailTags(meta)).toEqual(['Roguelike', 'Indie', 'Hack and Slash', 'Mythology'])
    expect(detailTags(meta, 2)).toEqual(['Roguelike', 'Indie'])
  })

  it('shows nothing before the tags are read or after a miss', () => {
    expect(detailTags({ genres: ['Action'] })).toEqual([])
    expect(steamTagsOf({ steamTags: { tags: [], missedAt: 'x' } })).toEqual([])
  })
})

describe('detailChips', () => {
  const labels = (game: Parameters<typeof detailChips>[0], tagCount?: number): string[] =>
    detailChips(game, tagCount).map((c) => `${c.kind}:${c.label}`)

  it('shows every genre of a game without Steam tags (a ROM found by Filters > Genre > Puzzle)', () => {
    // The user's record: "Professor Layton and the Last Specter" (nds).
    const layton = {
      source: 'rom' as const,
      metadata: {
        genres: ['Point-and-click', 'Puzzle', 'Visual Novel'],
        launchboxGenres: { genres: ['Adventure', 'Puzzle'], launchboxId: 10664, updatedAt: 'x' }
      }
    }
    expect(labels(layton)).toEqual(['genre:Adventure', 'genre:Puzzle'])
    // Every chip shown is a way the game is found, and Puzzle is one of them.
    expect(hasTagFilter(layton, ['puzzle'])).toBe(true)
    // Before LaunchBox has answered: the scraped genres.
    expect(labels({ source: 'rom', metadata: { genres: layton.metadata.genres } })).toEqual([
      'genre:Point-and-click',
      'genre:Puzzle',
      'genre:Visual Novel'
    ])
  })

  it('keeps one line, and puts what Filters > Genre finds the game by first', () => {
    const hades = {
      source: 'steam' as const,
      metadata: {
        genres: ['Action', 'Indie', 'RPG'],
        steamTags: { tags: ['action', 'Roguelike', 'Indie', 'Hack and Slash', 'Mythology', 'RPG'] }
      }
    }
    // Its second Filters > Genre genre (RPG) and its strongest tags; "Indie" the genre is no choice.
    expect(labels(hades)).toEqual([
      'genre:Action',
      'genre:RPG',
      'tag:Roguelike',
      'tag:Indie',
      'tag:Hack and Slash'
    ])
    // Narrower canvases: fewer chips, a tag always among them.
    expect(labels(hades, 2)).toEqual(['genre:Action', 'genre:RPG', 'tag:Roguelike'])
    expect(labels(hades, 0)).toEqual(['genre:Action'])
    // A Steam game found by Filters > Genre > Puzzle through its genre alone says so.
    const walking = {
      source: 'steam' as const,
      metadata: {
        genres: ['Adventure', 'Indie', 'Puzzle'],
        steamTags: {
          tags: ['Atmospheric', 'Story Rich', 'Walking Simulator', 'Exploration', 'Mystery']
        }
      }
    }
    expect(labels(walking)).toEqual([
      'genre:Adventure',
      'genre:Puzzle',
      'tag:Atmospheric',
      'tag:Story Rich',
      'tag:Walking Simulator'
    ])
    // Many genres and many tags: genres do not take every place.
    const many = {
      source: 'steam' as const,
      metadata: {
        genres: ['Action', 'Adventure', 'RPG', 'Simulation', 'Strategy', 'Indie'],
        steamTags: { tags: ['Open World', 'Survival', 'Crafting', 'Sandbox', 'Building'] }
      }
    }
    expect(labels(many)).toEqual([
      'genre:Action',
      'genre:Adventure',
      'genre:RPG',
      'tag:Open World',
      'tag:Survival'
    ])
    // Few tags: the other genres take the room, in the game's own order, nothing twice.
    const few = {
      source: 'steam' as const,
      metadata: {
        genres: ['Adventure', 'Puzzle', 'Strategy', 'Simulation', 'Casual', 'Racing'],
        steamTags: { tags: ['Puzzle', 'Cozy'] }
      }
    }
    expect(labels(few)).toEqual([
      'genre:Adventure',
      'genre:Puzzle',
      'genre:Strategy',
      'genre:Simulation',
      'tag:Cozy'
    ])
  })

  it('drops genres that are no Filters > Genre choice before ones that are, when not all fit', () => {
    // LaunchBox lists genres alphabetically: Puzzle and Shooter must not be the ones lost.
    const rom = {
      source: 'rom' as const,
      metadata: {
        launchboxGenres: {
          genres: [
            'Action',
            'Adventure',
            "Beat 'em Up",
            'Fighting',
            'Platform',
            'Puzzle',
            'Shooter'
          ],
          launchboxId: 1,
          updatedAt: 'x'
        }
      }
    }
    const shown = detailChips(rom).map((c) => c.label)
    expect(shown).toHaveLength(5)
    expect(shown).toEqual(expect.arrayContaining(['Action', 'Adventure', 'Puzzle', 'Shooter']))
    // In the game's own order.
    expect(shown).toEqual([...shown].sort((a, b) => a.localeCompare(b)))
    // Room kept for tags that then only repeat genres goes to a genre that is a choice first ("Simulation", not "Indie").
    const repeats = {
      source: 'steam' as const,
      metadata: {
        genres: ['Action', 'Adventure', 'Indie', 'RPG', 'Strategy', 'Simulation'],
        steamTags: { tags: ['Action', 'Adventure'] }
      }
    }
    expect(labels(repeats)).toEqual([
      'genre:Action',
      'genre:Adventure',
      'genre:RPG',
      'genre:Strategy',
      'genre:Simulation'
    ])
    // With room to spare, the genres that are no choice show too.
    const small = { source: 'rom' as const, metadata: { genres: ['Indie', 'Puzzle', 'Strategy'] } }
    expect(labels(small)).toEqual(['genre:Indie', 'genre:Puzzle', 'genre:Strategy'])
  })

  it('does not show one Filters > Genre choice under two names', () => {
    const game = {
      source: 'gog' as const,
      metadata: {
        genres: ['Role-playing (RPG)', 'RPG', ' ', 'role-playing (rpg)', 'Adventure'],
        steamTags: { tags: ['RPG', 'Story Rich'] }
      }
    }
    expect(labels(game)).toEqual(['genre:Role-playing (RPG)', 'genre:Adventure', 'tag:Story Rich'])
  })

  it('shows tags alone for a game without a genre, and nothing for one with neither', () => {
    expect(
      labels({ source: 'steam', metadata: { steamTags: { tags: ['Roguelike', 'Indie'] } } })
    ).toEqual(['tag:Roguelike', 'tag:Indie'])
    expect(labels({ source: 'rom', metadata: {} })).toEqual([])
  })
})

describe('Filters > Tags', () => {
  it("offers only the chosen tags, in Steam's spelling, once each", () => {
    const labels = TAG_FILTERS.map((t) => t.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels).toContain('Choose Your Own Adventure')
    expect(labels).not.toContain('Indie')
    expect(TAG_FILTERS.find((t) => t.label === 'Science Fiction')?.steamTags).toEqual(['Sci-fi'])
  })

  it('matches a game with any picked tag, case-insensitively', () => {
    const game = {
      source: 'steam' as const,
      metadata: { steamTags: { tags: ['Roguelike', 'sci-fi'] } }
    }
    expect(hasTagFilter(game, ['science fiction'])).toBe(true)
    expect(hasTagFilter(game, ['horror', 'roguelike'])).toBe(true)
    expect(hasTagFilter(game, ['horror'])).toBe(false)
    expect(hasTagFilter({ source: 'steam', metadata: {} }, ['roguelike'])).toBe(false)
  })

  it('lists the choices some game has', () => {
    const games = [
      { source: 'steam' as const, metadata: { steamTags: { tags: ['Horror', 'Indie'] } } },
      { source: 'steam' as const, metadata: { steamTags: { tags: ['Sci-fi'] } } },
      { source: 'steam' as const, metadata: {} }
    ]
    expect(libraryTagFilters(games).map((t) => t.label)).toEqual(['Horror', 'Science Fiction'])
    expect(tagFilterLabel('science fiction')).toBe('Science Fiction')
  })

  // tagFilterLabel builds its keys (lib.tags.<name in camelCase>), which the locales test cannot see: every choice
  // needs its English label, and English reads as the name the choice is matched by.
  it('has an English label for every choice, the same as its name', () => {
    // Four choices show a longer name than the tag they cover (the owner's names); the rest read as their name.
    const renamed: Record<string, string> = {
      FPS: '1st-Person Shooter',
      JRPG: 'Japan Role Playing Game',
      RPG: 'Role Playing Game (RPG)',
      RTS: 'Real Time Strategy (RTS)'
    }
    for (const filter of TAG_FILTERS) expect(filter.label).toBe(renamed[filter.name] ?? filter.name)
    expect(tagFilterKey('Point & Click')).toBe('pointClick')
    expect(tagFilterKey('2D')).toBe('2d')
  })
})

describe('tagFilterFor', () => {
  it("finds the Filters > Tags choice of a game page's tag, or none", () => {
    expect(tagFilterFor('sci-fi')?.id).toBe('science fiction')
    expect(tagFilterFor('Psychological Horror')?.label).toBe('Psychological Horror')
    expect(tagFilterFor('Survival Horror')).toBeUndefined()
  })

  it("counts a game's genres as the choice of the same name or one of its other spellings (Filters > Genre)", () => {
    const rpg = { source: 'gog' as const, metadata: { genres: ['Role-playing (RPG)', 'Indie'] } }
    expect(hasTagFilter(rpg, ['rpg'])).toBe(true)
    expect([...genreFilterIdsOf(rpg)]).toEqual(['rpg'])
    expect(genreFilterFor('Free To Play')?.label).toBe('Free to Play')
    expect(genreFilterFor('Sport')?.label).toBe('Sports')
    expect(genreFilterFor('Simulator')?.label).toBe('Simulation')
    expect(genreFilterFor('Flight Simulator')?.label).toBe('Flight')
    expect(genreFilterFor('Platform')?.label).toBe('Platformer')
    expect(genreFilterFor('Vehicle Simulation')?.label).toBe('Driving')
    expect(genreFilterFor('Real Time Strategy (RTS)')?.label).toBe('Real Time Strategy (RTS)')
    expect(genreFilterFor('Massively Multiplayer')?.label).toBe('Massively Multiplayer')
    for (const gone of [
      'Indie',
      'Early Access',
      'Arcade',
      'Fighting',
      "Beat 'em Up",
      'Violent',
      'Nudity',
      'Education'
    ])
      expect(genreFilterFor(gone)).toBeUndefined()
    // A ROM game goes by its LaunchBox genres.
    const rom = {
      source: 'rom' as const,
      metadata: { genres: ['Action'], launchboxGenres: { genres: ['Sports'] } }
    }
    expect([...genreFilterIdsOf(rom as never)]).toEqual(['sports'])
    expect(libraryTagFilters([rpg]).map((f) => f.label)).toEqual(['Role Playing Game (RPG)'])
  })
})
