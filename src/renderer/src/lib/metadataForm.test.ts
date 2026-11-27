import type { MetadataLayers } from '@shared/metadata-edit'
import { describe, expect, it } from 'vitest'
import {
  fallbackForm,
  fieldChanged,
  fieldEdit,
  fieldOrigin,
  formSave,
  layersAfterSave,
  shownForm
} from './metadataForm'

const layers: MetadataLayers = {
  key: 'steam-620',
  scraped: {
    title: 'Portal 2',
    description: 'Scraped',
    developers: ['Valve'],
    hltb: { main: 8, extra: 13 },
    reviewScore: { score: 98, source: 'steam' },
    controls: { controller: 'full', vr: 'none' }
  },
  cloud: { description: 'Cloud', genres: ['Puzzle'] },
  local: { developers: ['Valve Corporation'], localPlayers: 2 }
}

describe('metadata form', () => {
  it('shows the local edit over the cloud over the scraped values', () => {
    const form = shownForm(layers)
    expect(form.description).toBe('Cloud')
    expect(form.developers).toBe('Valve Corporation')
    expect(form.genres).toBe('Puzzle')
    expect(form.localPlayers).toBe('2')
    expect(form.hltbMain).toBe('8')
    expect(form.hltbCompletionist).toBe('')
    expect(form.score).toBe('98')
    expect(fallbackForm(layers).developers).toBe('Valve')
    expect(fieldOrigin(layers, 'developers')).toBe('local')
    expect(fieldOrigin(layers, 'genres')).toBe('cloud')
    expect(fieldOrigin(layers, 'title')).toBe('scraped')
  })

  it('saves only the changed fields', () => {
    const form = {
      ...shownForm(layers),
      genres: 'Puzzle,  Co-op',
      hltbExtra: '14.5',
      title: 'Portal 2'
    }
    expect(fieldChanged(form, layers, 'genres')).toBe(true)
    // Spacing in a list is not a change.
    expect(
      fieldChanged({ ...form, developers: ' Valve Corporation ,' }, layers, 'developers')
    ).toBe(false)
    expect(formSave(form, layers, new Set())).toEqual({
      edit: { genres: ['Puzzle', 'Co-op'], hltb: { main: 8, extra: 14.5 } },
      clear: []
    })
  })

  it('clears a reset field and saves a reset field changed again', () => {
    const reset = { ...shownForm(layers), developers: 'Valve', localPlayers: '2' }
    expect(formSave(reset, layers, new Set(['developers']))).toEqual({
      edit: {},
      clear: ['developers']
    })
    const typedAgain = { ...reset, developers: 'Valve, Hidden Path' }
    expect(formSave(typedAgain, layers, new Set(['developers']))).toEqual({
      edit: { developers: ['Valve', 'Hidden Path'] },
      clear: []
    })
  })

  it('checks dates and numbers', () => {
    const form = shownForm(layers)
    expect(() => fieldEdit({ ...form, releaseDate: '1/2/2011' }, 'releaseDate')).toThrow(
      /YYYY-MM-DD/
    )
    expect(() => fieldEdit({ ...form, releaseDate: '2011-13' }, 'releaseDate')).toThrow(
      /month 01-12/
    )
    expect(() => fieldEdit({ ...form, releaseDate: '2011-04-00' }, 'releaseDate')).toThrow(
      /day 01-31/
    )
    expect(fieldEdit({ ...form, releaseDate: '2011-04' }, 'releaseDate')).toEqual({
      releaseDate: '2011-04'
    })
    expect(() => fieldEdit({ ...form, hltbMain: 'ten' }, 'hltb')).toThrow(/hours/)
    expect(() => fieldEdit({ ...form, score: '120' }, 'reviewScore')).toThrow(/0 to 100/)
    expect(fieldEdit({ ...form, score: '' }, 'reviewScore')).toEqual({
      reviewScore: { source: 'steam' }
    })
    expect(fieldEdit({ ...form, controller: 'partial', vr: 'only' }, 'controls')).toEqual({
      controls: { controller: 'partial', vr: 'only' }
    })
  })

  it('treats an emptied title as removing the own title, never as an empty title', () => {
    const own: MetadataLayers = { ...layers, local: { ...layers.local, title: 'My Portal' } }
    expect(formSave({ ...shownForm(own), title: '  ' }, own, new Set())).toEqual({
      edit: {},
      clear: ['title']
    })
    // No own title: nothing to remove and nothing sent.
    expect(formSave({ ...shownForm(layers), title: '' }, layers, new Set())).toEqual({
      edit: {},
      clear: []
    })
    expect(() => fieldEdit({ ...shownForm(layers), title: ' ' }, 'title')).toThrow(/title/)
  })

  it('sends nothing again after a saved plan (a retry after a later step failed)', () => {
    const form = { ...shownForm(layers), genres: 'Puzzle, Co-op', developers: 'Valve' }
    const plan = formSave(form, layers, new Set(['developers']))
    expect(plan).toEqual({ edit: { genres: ['Puzzle', 'Co-op'] }, clear: ['developers'] })
    const after = layersAfterSave(layers, plan)
    expect(after.local).toEqual({ genres: ['Puzzle', 'Co-op'], localPlayers: 2 })
    expect(formSave(shownForm(after), after, new Set())).toEqual({ edit: {}, clear: [] })
    expect(formSave(form, after, new Set(['developers']))).toEqual({ edit: {}, clear: [] })
  })
})

describe('metadata form: difficulty', () => {
  it('is Default (Medium) without a pick, and saves a level or Default like any field', () => {
    const plain: MetadataLayers = { key: 'steam-268910', scraped: {}, cloud: null, local: {} }
    expect(shownForm(plain).difficulty).toBe('')
    expect(formSave(shownForm(plain), plain, new Set()).edit).toEqual({})
    expect(formSave({ ...shownForm(plain), difficulty: 'hard' }, plain, new Set()).edit).toEqual({
      difficulty: 'hard'
    })
    // Over a cloud pick: Default is an edit of its own (''), which hides the cloud's pick.
    const cloud: MetadataLayers = { ...plain, cloud: { difficulty: 'impossible' } }
    expect(shownForm(cloud).difficulty).toBe('impossible')
    expect(fieldOrigin(cloud, 'difficulty')).toBe('cloud')
    expect(formSave({ ...shownForm(cloud), difficulty: '' }, cloud, new Set()).edit).toEqual({
      difficulty: ''
    })
    // The user's own pick: reset goes back to the cloud's.
    const local: MetadataLayers = { ...cloud, local: { difficulty: 'easy' } }
    expect(shownForm(local).difficulty).toBe('easy')
    expect(
      formSave({ ...shownForm(local), difficulty: 'impossible' }, local, new Set(['difficulty']))
    ).toEqual({ edit: {}, clear: ['difficulty'] })
  })

  it('refuses a level that is not one', () => {
    const form = shownForm({ key: null, scraped: {}, cloud: null, local: {} })
    expect(() => fieldEdit({ ...form, difficulty: 'nightmare' as never }, 'difficulty')).toThrow(
      /difficulty/
    )
    expect(fieldEdit({ ...form, difficulty: 'story' }, 'difficulty')).toEqual({
      difficulty: 'story'
    })
  })

  it('never saves (or sends to the cloud) the N/A (Tools) label of a Utilities game', () => {
    const tool: MetadataLayers = {
      key: 'steam-431960',
      scraped: { title: 'Wallpaper Engine', genres: ['Casual'] },
      cloud: null,
      local: {}
    }
    // Default: no pick, so nothing to save; the label stays a label.
    expect(shownForm(tool).difficulty).toBe('')
    expect(formSave(shownForm(tool), tool, new Set()).edit).toEqual({})
    expect(() =>
      fieldEdit({ ...shownForm(tool), difficulty: 'tools' as never }, 'difficulty')
    ).toThrow(/difficulty/)
  })
})
