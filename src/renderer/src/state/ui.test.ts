import { beforeEach, describe, expect, it } from 'vitest'
import { LIBRARY_ALL_TAB, LIBRARY_SETTINGS_TAB } from '../lib/libraryView'
import { SETTINGS_SECTIONS, useUiStore } from './ui'

describe('openModal: Settings while the Library shows its Settings tab', () => {
  beforeEach(() => {
    const s = useUiStore.getState()
    s.closeAll()
    s.clearSettingsTabRequest()
    s.setScreen('home')
    s.setLibraryFilters({ tab: LIBRARY_ALL_TAB })
  })

  it('goes to the tab (its section) instead of opening a second Settings menu', () => {
    const s = useUiStore.getState()
    s.setScreen('library')
    s.setLibraryFilters({ tab: LIBRARY_SETTINGS_TAB })
    expect(s.openModal({ type: 'settings', section: 'metadata' })).toBe(0)
    expect(useUiStore.getState().modals).toHaveLength(0)
    expect(useUiStore.getState().settingsTabRequest).toMatchObject({ section: 'metadata' })
    // A second ask is a new request (the same section asked again still moves focus there).
    const first = useUiStore.getState().settingsTabRequest!.n
    s.openModal({ type: 'settings', section: 'metadata' })
    expect(useUiStore.getState().settingsTabRequest!.n).not.toBe(first)
    s.clearSettingsTabRequest()
    expect(useUiStore.getState().settingsTabRequest).toBeNull()
  })

  it('opens the Settings modal anywhere else', () => {
    const s = useUiStore.getState()
    s.setScreen('library')
    expect(s.openModal({ type: 'settings' })).toBeGreaterThan(0)
    expect(useUiStore.getState().modals.map((m) => m.type)).toEqual(['settings'])
    s.closeAll()
    s.setScreen('home')
    s.setLibraryFilters({ tab: LIBRARY_SETTINGS_TAB })
    expect(s.openModal({ type: 'settings' })).toBeGreaterThan(0)
    expect(useUiStore.getState().settingsTabRequest).toBeNull()
  })

  it('leaves other modals alone on the Settings tab', () => {
    const s = useUiStore.getState()
    s.setScreen('library')
    s.setLibraryFilters({ tab: LIBRARY_SETTINGS_TAB })
    expect(s.openModal({ type: 'addgames' })).toBeGreaterThan(0)
    expect(useUiStore.getState().modals.map((m) => m.type)).toEqual(['addgames'])
  })
})

describe('showInLibrary: a chip on a game page', () => {
  it("opens All Games with just that filter, on the game's card, closing every modal", () => {
    const s = useUiStore.getState()
    s.setScreen('home')
    s.setHomeFocusKey('home:recent:old')
    s.setLibraryFilters({
      tab: 'steam',
      query: 'zelda',
      genres: ['RPG'],
      sizes: ['gb-1-5'],
      favorites: true,
      sort: 'title-asc',
      sortReversed: true
    })
    s.openModal({ type: 'detail', gameId: 'hades' })
    s.showInLibrary(
      { tags: ['roguelike'], sort: 'title-asc', sortReversed: true },
      'hades',
      LIBRARY_ALL_TAB
    )
    const after = useUiStore.getState()
    expect(after.screen).toBe('library')
    expect(after.modals).toEqual([])
    expect(after.library).toMatchObject({
      tab: LIBRARY_ALL_TAB,
      query: '',
      genres: [],
      tags: ['roguelike'],
      stores: [],
      eras: [],
      sizes: [],
      hltb: [],
      hidden: false,
      favorites: false,
      sort: 'title-asc',
      sortReversed: true
    })
    expect(after.libraryFocus[LIBRARY_ALL_TAB]).toBe('hades')
    expect(after.libraryFocusRequest).toMatchObject({ gameId: 'hades' })
    expect(after.homeFocusKey).toBeNull()
    after.clearLibraryFocusRequest()
    expect(useUiStore.getState().libraryFocusRequest).toBeNull()
  })
})

describe('SETTINGS_SECTIONS', () => {
  it('lists Recompilations between Emulators and VR', () => {
    const at = SETTINGS_SECTIONS.indexOf('recompilations')
    expect(SETTINGS_SECTIONS[at - 1]).toBe('emulators')
    expect(SETTINGS_SECTIONS[at + 1]).toBe('vr')
  })

  it('lists VR directly beneath Recompilations, before Convert', () => {
    const at = SETTINGS_SECTIONS.indexOf('vr')
    expect(SETTINGS_SECTIONS[at - 1]).toBe('recompilations')
    expect(SETTINGS_SECTIONS[at + 1]).toBe('convert')
  })

  it('opens one Recompilation page per game', () => {
    const s = useUiStore.getState()
    s.closeAll()
    s.setScreen('home')
    const first = s.openModal({ type: 'recomp', gameId: 'rom:mk64' })
    expect(s.openModal({ type: 'recomp', gameId: 'rom:mk64', focus: 'files' })).toBe(first)
    expect(s.openModal({ type: 'recomp', gameId: 'rom:sm64' })).not.toBe(first)
    s.closeAll()
  })

  it('lists Convert between VR and Streaming, and Streaming before Metadata', () => {
    const at = SETTINGS_SECTIONS.indexOf('convert')
    expect(SETTINGS_SECTIONS[at - 1]).toBe('vr')
    expect(SETTINGS_SECTIONS[at + 1]).toBe('streaming')
    expect(SETTINGS_SECTIONS[at + 2]).toBe('metadata')
  })

  it('opens the Streaming section from a settings modal request', () => {
    const s = useUiStore.getState()
    s.closeAll()
    s.setScreen('library')
    s.setLibraryFilters({ tab: LIBRARY_SETTINGS_TAB })
    s.openModal({ type: 'settings', section: 'streaming' })
    expect(useUiStore.getState().settingsTabRequest).toMatchObject({ section: 'streaming' })
    s.clearSettingsTabRequest()
    s.setLibraryFilters({ tab: LIBRARY_ALL_TAB })
  })
})
