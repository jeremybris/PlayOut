import type { MetadataLayers } from '@shared/metadata-edit'
import { describe, expect, it } from 'vitest'
import {
  GENRE_TAG_SUGGESTIONS_MAX,
  genreTagRowId,
  genreTagSuggestions,
  genreTagRows,
  genreTagSummary,
  toggleGenreTag,
  type GenreTagRow
} from './genreTagPicker'
import { fallbackForm, formSave, shownForm, type MetadataForm } from './metadataForm'
import { TAG_FILTERS, genreFilterIdsOf } from './steamTags'

type Lists = Pick<MetadataForm, 'genres' | 'tags'>

const checkedIds = (form: Lists, bases: Lists[] = []): string[] => {
  const { choices, others } = genreTagRows(form, bases)
  return [...choices, ...others].filter((r) => r.checked).map((r) => r.id)
}

const rowOf = (form: Lists, id: string, bases: Lists[] = []): GenreTagRow => {
  const { choices, others } = genreTagRows(form, bases)
  const row = [...choices, ...others].find((r) => r.id === id)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

describe('Genres & Tags rows', () => {
  it('lists every Filters › Genre choice alphabetically, ticked by any spelling in either list', () => {
    const form = { genres: 'Role-playing (RPG), Indie', tags: 'Sci-fi, Atmospheric, Action' }
    const { choices, others } = genreTagRows(form)
    expect(choices).toHaveLength(TAG_FILTERS.length)
    const labels = choices.map((c) => c.label)
    expect(labels).toEqual(
      [...labels].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    )
    expect(checkedIds(form)).toEqual(
      expect.arrayContaining([
        'rpg',
        'science fiction',
        'action',
        'other:indie',
        'other:atmospheric'
      ])
    )
    expect(checkedIds(form)).toHaveLength(5)
    // The genres and tags that are no choice come after, alphabetical, by the game's own spelling.
    expect(others.map((o) => o.label)).toEqual(['Atmospheric', 'Indie'])
  })

  it('ticks what Filters › Genre finds the game by', () => {
    const genres = ['Role-Playing', 'Platform', 'Sport']
    const tags = ['Sci-fi', 'Simulation', 'Indie']
    const fromFilters = genreFilterIdsOf({
      source: 'steam',
      metadata: { genres, steamTags: { tags } }
    })
    const form = { genres: genres.join(', '), tags: tags.join(', ') }
    expect(
      checkedIds(form)
        .filter((id) => !id.startsWith('other:'))
        .sort()
    ).toEqual([...fromFilters].sort())
  })

  it('keeps an unticked other genre listed from the values the sheet opened with', () => {
    const base = { genres: 'Indie', tags: '' }
    const { others } = genreTagRows({ genres: '', tags: '' }, [base])
    expect(others).toEqual([{ id: 'other:indie', label: 'Indie', checked: false }])
  })

  it('sums up the ticked rows in the game order', () => {
    expect(genreTagSummary({ genres: '', tags: '' })).toBe('None')
    expect(genreTagSummary({ genres: 'Role-playing (RPG)', tags: '' })).toBe('RPG')
    expect(
      genreTagSummary({ genres: 'Action, RPG', tags: 'RPG, Indie, Sci-fi, Atmospheric' })
    ).toBe('Action, RPG +3')
  })
})

describe('toggling Genres & Tags', () => {
  it('adds a choice not ticked to the genres', () => {
    const form = { genres: 'Action', tags: 'Indie' }
    expect(toggleGenreTag(form, rowOf(form, 'puzzle'))).toEqual({
      genres: 'Action, Puzzle',
      tags: 'Indie'
    })
  })

  it('removes every spelling of a ticked choice from both lists, tags keeping their order', () => {
    const form = {
      genres: 'Role-playing (RPG), Adventure',
      tags: 'Atmospheric, RPG, Story Rich, Role-Playing'
    }
    expect(toggleGenreTag(form, rowOf(form, 'rpg'))).toEqual({
      genres: 'Adventure',
      tags: 'Atmospheric, Story Rich'
    })
    const scifi = { genres: 'Science Fiction', tags: 'Space, Sci-fi' }
    expect(toggleGenreTag(scifi, rowOf(scifi, 'science fiction'))).toEqual({
      genres: '',
      tags: 'Space'
    })
  })

  it('removes an other genre / tag from both lists', () => {
    const form = { genres: 'Indie, Action', tags: 'indie, Atmospheric' }
    expect(toggleGenreTag(form, rowOf(form, 'other:indie'))).toEqual({
      genres: 'Action',
      tags: 'Atmospheric'
    })
  })

  it('ticked again, a choice gets its own strings back in their places: nothing changed', () => {
    const base = { genres: 'Role-playing (RPG), Adventure', tags: 'Atmospheric, RPG, Story Rich' }
    const off = toggleGenreTag(base, rowOf(base, 'rpg', [base]), [base])
    const on = toggleGenreTag(off, rowOf(off, 'rpg', [base]), [base])
    expect(on).toEqual({
      genres: 'Role-playing (RPG), Adventure',
      tags: 'Atmospheric, RPG, Story Rich'
    })
    const indieOff = toggleGenreTag(base, { id: 'other:atmospheric', label: 'Atmospheric' }, [base])
    expect(indieOff.tags).toBe('RPG, Story Rich')
    expect(
      toggleGenreTag(indieOff, rowOf(indieOff, 'other:atmospheric', [base]), [base]).tags
    ).toBe('Atmospheric, RPG, Story Rich')
  })

  it('maps one string to its row', () => {
    expect(genreTagRowId(' role-playing ')).toBe('rpg')
    expect(genreTagRowId('Indie')).toBe('other:indie')
  })
})

describe('Genres & Tags saves', () => {
  const layers: MetadataLayers = {
    key: 'steam-620',
    scraped: { genres: ['Role-playing (RPG)', 'Indie'], tags: ['Sci-fi', 'RPG', 'Atmospheric'] },
    cloud: null,
    local: {}
  }
  const bases = (): Lists[] => [shownForm(layers), fallbackForm(layers)]

  it('saves nothing when the dropdown is left alone, or a row is toggled twice', () => {
    const form = shownForm(layers)
    expect(formSave(form, layers, new Set())).toEqual({ edit: {}, clear: [] })
    const row = rowOf(form, 'rpg', bases())
    const once = { ...form, ...toggleGenreTag(form, row, bases()) }
    const twice = { ...once, ...toggleGenreTag(once, row, bases()) }
    expect(formSave(twice, layers, new Set())).toEqual({ edit: {}, clear: [] })
  })

  it('a ticked choice is a genres edit only', () => {
    const form = shownForm(layers)
    const next = { ...form, ...toggleGenreTag(form, rowOf(form, 'puzzle'), bases()) }
    expect(formSave(next, layers, new Set())).toEqual({
      edit: { genres: ['Role-playing (RPG)', 'Indie', 'Puzzle'] },
      clear: []
    })
  })

  it('an unticked choice edits the genres and the tags that had it', () => {
    const form = shownForm(layers)
    const next = { ...form, ...toggleGenreTag(form, rowOf(form, 'rpg'), bases()) }
    expect(formSave(next, layers, new Set())).toEqual({
      edit: { genres: ['Indie'], tags: ['Sci-fi', 'Atmospheric'] },
      clear: []
    })
  })

  it('reset of both fields clears the own edits', () => {
    const own: MetadataLayers = { ...layers, local: { genres: ['Puzzle'], tags: ['Puzzle'] } }
    const form = { ...shownForm(own), ...fallbackForm(own) }
    expect(formSave(form, own, new Set(['genres', 'tags'] as const))).toEqual({
      edit: {},
      clear: ['genres', 'tags']
    })
  })
})

describe('Genres & Tags search suggestions', () => {
  const none: Lists = { genres: '', tags: '' }
  const labels = (rows: GenreTagRow[]): string[] => rows.map((r) => r.label)

  it('lists names starting with the text, then a word starting with it, then other matches', () => {
    expect(labels(genreTagSuggestions('rpg', none))).toEqual(['RPG', 'Action RPG', 'JRPG'])
    expect(labels(genreTagSuggestions('cl', none))).toEqual(['Classic', 'Point & Click'])
    expect(labels(genreTagSuggestions('puzzle', none))).toEqual(['Puzzle', 'Puzzle Platformer'])
  })

  it('ignores case and accents, in the text and in the names', () => {
    expect(labels(genreTagSuggestions('  ÁCTION', none))).toEqual(['Action', 'Action RPG'])
    const bases = [{ genres: 'Acción', tags: '' }]
    expect(labels(genreTagSuggestions('accion', none, bases))).toEqual(['Acción'])
    expect(labels(genreTagSuggestions('ACCIÓN', none, bases))).toEqual(['Acción'])
  })

  it('leaves out what the game already has, by any spelling', () => {
    const form = { genres: 'Role-playing (RPG), Acción', tags: 'Sci-fi' }
    expect(labels(genreTagSuggestions('rpg', form))).toEqual(['Action RPG', 'JRPG'])
    expect(labels(genreTagSuggestions('science', form))).toEqual([])
    expect(labels(genreTagSuggestions('acc', form, [form]))).toEqual([])
  })

  it('shows at most 8, and nothing for an empty text or no match', () => {
    const many = genreTagSuggestions('a', none)
    expect(GENRE_TAG_SUGGESTIONS_MAX).toBe(8)
    expect(many).toHaveLength(8)
    expect(labels(many).slice(0, 4)).toEqual(['Action', 'Action RPG', 'Adventure', 'Anime'])
    expect(genreTagSuggestions('', none)).toEqual([])
    expect(genreTagSuggestions('   ', none)).toEqual([])
    expect(genreTagSuggestions('zzzz', none)).toEqual([])
  })

  it('gives rows the dropdown toggle adds', () => {
    const [rpg] = genreTagSuggestions('rpg', none)
    expect(toggleGenreTag(none, rpg!)).toEqual({ genres: 'RPG', tags: '' })
  })
})
