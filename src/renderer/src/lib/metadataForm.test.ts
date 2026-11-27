import {
  CONTROLS_OPTIONS,
  CONTROLS_ROWS,
  applyEditToMetadata,
  controlsFromPicks,
  editableValues,
  type ControlsOption,
  type MetadataLayers
} from '@shared/metadata-edit'
import type { Game } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  controlsAllNoneKeeps,
  controlsRows,
  fallbackForm,
  fieldChanged,
  fieldEdit,
  fieldOrigin,
  formSave,
  layersAfterSave,
  noControlsPicked,
  shownForm,
  withConsoleControls
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
    expect(fieldEdit({ ...form, controls: ['partial', 'none', 'none'] }, 'controls')).toEqual({
      controls: { controller: 'partial', vr: 'none' }
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

describe('metadata form: controls', () => {
  const plain = (
    scraped: MetadataLayers['scraped'],
    local: MetadataLayers['local'] = {}
  ): MetadataLayers => ({
    key: 'steam-620',
    scraped,
    cloud: null,
    local
  })
  const rows = (...picks: ControlsOption[]): ControlsOption[] => picks

  it('has three rows, Mouse & Keyboard alone for a game without controls', () => {
    expect(CONTROLS_ROWS).toBe(3)
    expect(shownForm(plain({})).controls).toEqual(['keyboard', 'none', 'none'])
    expect(controlsRows(['vr', 'full'])).toEqual(['full', 'vr', 'none'])
  })

  it.each([0, 1, 2])('saves each of the 7 options picked in row %i', (row) => {
    const base = shownForm(plain({}))
    const saved = CONTROLS_OPTIONS.map((option) => {
      const controls = rows('none', 'none', 'none')
      controls[row] = option
      return formSave({ ...base, controls }, plain({}), new Set()).edit
    })
    expect(saved).toEqual([
      // None in all three rows: nothing to save (and no own edit to remove).
      {},
      { controls: { controller: 'full', vr: 'none' } },
      { controls: { controller: 'partial', vr: 'none' } },
      // Mouse & Keyboard is what the game shows already.
      {},
      { controls: { controller: 'none', vr: 'only' } },
      { controls: { controller: 'none', vr: 'none', touch: true } },
      { controls: { controller: 'none', vr: 'none', lightgun: true } }
    ])
  })

  it.each([
    [rows('full', 'keyboard', 'vr')],
    [rows('vr', 'none', 'none')],
    [rows('touch', 'keyboard', 'none')],
    [rows('lightgun', 'none', 'none')],
    [rows('lightgun', 'keyboard', 'full')],
    [rows('partial', 'touch', 'lightgun')],
    [rows('vr', 'touch', 'lightgun')],
    [rows('keyboard', 'vr', 'none')],
    [rows('full', 'vr', 'none')]
  ])('round-trips %j: form, edit, applied metadata, form again', (picked) => {
    // From a game whose metadata is something else, so the pick is always a change.
    const layers = plain({ controls: { controller: 'partial', vr: 'only', keyboard: true } })
    const plan = formSave({ ...shownForm(layers), controls: picked }, layers, new Set())
    expect(plan).toEqual({ edit: { controls: controlsFromPicks(picked) }, clear: [] })
    const game = {
      source: 'steam',
      title: 'Portal 2',
      metadata: applyEditToMetadata({}, plan.edit)
    } as unknown as Game
    const back = shownForm(plain(editableValues(game)))
    expect(back.controls).toEqual(controlsRows(picked.filter((p) => p !== 'none')))
    // Saved again unchanged: nothing is sent.
    const after = layersAfterSave(layers, plan)
    expect(formSave(shownForm(after), after, new Set())).toEqual({ edit: {}, clear: [] })
  })

  it('compares the rows as a set: order and repeats change nothing', () => {
    const scraped = plain({ controls: { controller: 'full', vr: 'supported' } })
    expect(shownForm(scraped).controls).toEqual(['full', 'vr', 'none'])
    expect(fieldChanged(shownForm(scraped), scraped, 'controls')).toBe(false)
    expect(formSave(shownForm(scraped), scraped, new Set()).edit).toEqual({})
    for (const controls of [
      rows('vr', 'full', 'none'),
      rows('none', 'vr', 'full'),
      rows('full', 'full', 'vr'),
      rows('vr', 'vr', 'full')
    ]) {
      expect(fieldChanged({ ...shownForm(scraped), controls }, scraped, 'controls')).toBe(false)
      expect(formSave({ ...shownForm(scraped), controls }, scraped, new Set()).edit).toEqual({})
    }
    expect(
      formSave(
        { ...shownForm(scraped), controls: rows('full', 'vr', 'keyboard') },
        scraped,
        new Set()
      ).edit
    ).toEqual({ controls: { controller: 'full', vr: 'supported', keyboard: true } })
    // A repeat is one pick: two Lightgun rows are a light-gun game.
    expect(
      fieldEdit(
        { ...shownForm(scraped), controls: rows('lightgun', 'lightgun', 'none') },
        'controls'
      )
    ).toEqual({ controls: { controller: 'none', vr: 'none', lightgun: true } })
  })

  it('takes three None rows as Reset: an own edit goes, nothing else is saved', () => {
    const own = plain(
      { controls: { controller: 'full', vr: 'none' } },
      { controls: { controller: 'none', vr: 'none', lightgun: true } }
    )
    expect(shownForm(own).controls).toEqual(['lightgun', 'none', 'none'])
    const none = rows('none', 'none', 'none')
    expect(formSave({ ...shownForm(own), controls: none }, own, new Set())).toEqual({
      edit: {},
      clear: ['controls']
    })
    const scraped = plain({ controls: { controller: 'full', vr: 'none' } })
    expect(formSave({ ...shownForm(scraped), controls: none }, scraped, new Set())).toEqual({
      edit: {},
      clear: []
    })
    expect(noControlsPicked(none)).toBe(true)
    expect(() => fieldEdit({ ...shownForm(scraped), controls: none }, 'controls')).toThrow(
      'Pick at least one control'
    )
  })

  it('reads each kind of existing controls as its rows', () => {
    const shown = (c: NonNullable<MetadataLayers['scraped']['controls']>): ControlsOption[] =>
      shownForm(plain({ controls: c })).controls
    expect(shown({ controller: 'none', vr: 'none', touch: true })).toEqual([
      'touch',
      'none',
      'none'
    ])
    expect(shown({ controller: 'full', vr: 'none', keyboard: true })).toEqual([
      'full',
      'keyboard',
      'none'
    ])
    expect(shown({ controller: 'full', vr: 'supported', keyboard: true })).toEqual([
      'full',
      'keyboard',
      'vr'
    ])
    expect(shown({ controller: 'none', vr: 'only' })).toEqual(['vr', 'none', 'none'])
    expect(shown({ controller: 'partial', vr: 'none' })).toEqual(['partial', 'none', 'none'])
    expect(shown({ controller: 'none', vr: 'supported' })).toEqual(['keyboard', 'vr', 'none'])
    expect(shown({ controller: 'none', vr: 'none' })).toEqual(['keyboard', 'none', 'none'])
    // More picks than rows (only a hand-written cloud entry has them): a row each, none hidden.
    expect(
      shown({ controller: 'full', vr: 'supported', keyboard: true, touch: true, lightgun: true })
    ).toEqual(['full', 'keyboard', 'vr', 'touch', 'lightgun'])
  })
})

describe('metadata form: console controls and three None rows', () => {
  const romLayers: MetadataLayers = {
    key: 'rom-x',
    scraped: { title: 'X' },
    cloud: null,
    local: {}
  }

  it("starts a console game's rows on Full Controller Support when nothing was scraped", () => {
    const l = withConsoleControls(romLayers)
    expect(shownForm(l).controls).toEqual(controlsRows(['full']))
    // Left alone: nothing is saved.
    expect(formSave(shownForm(l), l, new Set()).edit).toEqual({})
    // Lightgun added beside it: saved with the controller kept.
    const form = { ...shownForm(l), controls: controlsRows(['full', 'lightgun']) }
    expect(formSave(form, l, new Set()).edit).toEqual({
      controls: { controller: 'full', vr: 'none', lightgun: true }
    })
  })

  it("keeps a console game's scraped or edited controls as they are", () => {
    const scraped = { ...romLayers, scraped: { controls: controlsFromPicks(['lightgun']) } }
    expect(withConsoleControls(scraped)).toBe(scraped)
    const local = { ...romLayers, local: { controls: controlsFromPicks(['lightgun']) } }
    expect(shownForm(withConsoleControls(local)).controls).toEqual(controlsRows(['lightgun']))
  })

  it('says three None rows keep the shown controls only when there is no own edit', () => {
    const none = { ...shownForm(romLayers), controls: controlsRows([]) }
    expect(controlsAllNoneKeeps(none, romLayers)).toBe(true)
    expect(formSave(none, romLayers, new Set())).toEqual({ edit: {}, clear: [] })
    const own = { ...romLayers, local: { controls: controlsFromPicks(['touch']) } }
    expect(controlsAllNoneKeeps(none, own)).toBe(false)
    expect(formSave(none, own, new Set()).clear).toEqual(['controls'])
    expect(controlsAllNoneKeeps(shownForm(romLayers), romLayers)).toBe(false)
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
