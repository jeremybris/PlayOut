import { defaultSettings } from '@shared/defaults'
import type { LibraryTabDef, Settings, SettingsPatch } from '@shared/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The settings API answers with the patch merged into what it last saved (the main process's role).
let saved: Settings
const updateSettings = vi.fn(async (patch: SettingsPatch): Promise<Settings> => {
  saved = mergeSettings(saved, patch)
  return saved
})
vi.mock('../api/client', () => ({
  api: {
    getSettings: async () => saved,
    updateSettings: (patch: SettingsPatch) => updateSettings(patch),
    on: () => () => undefined
  }
}))

const { hasTabChoice, newTabDef } = await import('../lib/libraryTabs')
const { LIBRARY_ALL_TAB, LIBRARY_SETTINGS_TAB } = await import('../lib/libraryView')
const { mergeSettings, receiveSettings, useSettingsStore } = await import('./settings')
const { useUiStore } = await import('./ui')
const tabs = await import('./libraryTabs')

function setSettings(ui: Partial<Settings['ui']>): void {
  const base = defaultSettings()
  saved = { ...base, ui: { ...base.ui, ...ui } }
  useSettingsStore.setState({ settings: saved, loaded: true })
}

const settingsUi = (): Settings['ui'] => useSettingsStore.getState().settings!.ui

beforeEach(() => {
  vi.useFakeTimers()
  updateSettings.mockClear()
  tabs.resetLibraryTabsForTests()
  useUiStore.setState({ libraryFocus: {} })
  useUiStore.getState().setLibraryFilters({ tab: LIBRARY_ALL_TAB })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('restoreLibraryTabs', () => {
  it('makes the tabs from the old platform tabs on the first run, and shows the first', () => {
    setSettings({ libraryTabs: null, libraryTab: '' })
    tabs.restoreLibraryTabs([
      { id: LIBRARY_SETTINGS_TAB, label: 'Settings' },
      { id: LIBRARY_ALL_TAB, label: 'All Games' },
      { id: 'snes', label: 'SNES' }
    ])
    expect(settingsUi().libraryTabs!.map((d) => d.id)).toEqual([LIBRARY_ALL_TAB, 'snes'])
    expect(useUiStore.getState().library.tab).toBe(LIBRARY_ALL_TAB)
  })

  it('shows the tab of the last session with its filters, sort, search and card', () => {
    const def = {
      ...newTabDef({ filters: { tags: ['rpg'] }, sort: 'recent' }, 'rpg'),
      query: 'zelda'
    }
    setSettings({
      libraryTabs: [newTabDef({}, LIBRARY_ALL_TAB), def],
      libraryTab: 'rpg',
      libraryPositions: { rpg: 'game-1' }
    })
    tabs.restoreLibraryTabs([])
    const view = useUiStore.getState().library
    expect(view.tab).toBe('rpg')
    expect(view.tags).toEqual(['rpg'])
    expect(view.sort).toBe('recent')
    expect(view.query).toBe('zelda')
    expect(useUiStore.getState().libraryFocus.rpg).toBe('game-1')
  })

  it('turns tabs saved on Playable First into Recently played with playable first, and saves them', async () => {
    const old = { ...newTabDef({}, 'a'), sort: 'playable' } as unknown as LibraryTabDef
    const { playableFirst: _gone, ...before } = newTabDef({ sort: 'size' }, 'b')
    void _gone
    setSettings({ libraryTabs: [old, before as LibraryTabDef], libraryTab: 'a' })
    tabs.restoreLibraryTabs([])
    expect(useUiStore.getState().library).toMatchObject({ sort: 'recent', playableFirst: true })
    await vi.runAllTimersAsync()
    expect(saved.ui.libraryTabs!.map((d) => [d.sort, d.playableFirst])).toEqual([
      ['recent', true],
      ['size', true]
    ])
  })

  it('falls back to the first tab when the saved one is gone', () => {
    setSettings({ libraryTabs: [newTabDef({}, 'a')], libraryTab: 'gone' })
    tabs.restoreLibraryTabs([])
    expect(useUiStore.getState().library.tab).toBe('a')
  })
})

describe('changing the shown tab', () => {
  beforeEach(() => {
    setSettings({ libraryTabs: [newTabDef({}, 'a'), newTabDef({}, 'b')], libraryTab: 'a' })
    tabs.restoreLibraryTabs([])
  })

  it('keeps its filters, sort and search, saved once after a burst', async () => {
    tabs.updateActiveTab({ tags: ['rpg'] })
    tabs.updateActiveTab({ sort: 'title-asc' })
    tabs.updateActiveTab({ query: 'mario' })
    expect(settingsUi().libraryTabs![0]!.filters.tags).toEqual(['rpg'])
    expect(updateSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ ui: expect.objectContaining({ libraryTabs: expect.anything() }) })
    )
    await vi.runAllTimersAsync()
    const a = saved.ui.libraryTabs![0]!
    expect(a.filters.tags).toEqual(['rpg'])
    expect(a.sort).toBe('title-asc')
    expect(a.query).toBe('mario')
    // The other tab is untouched; switching shows its own view.
    tabs.activateTab('b')
    expect(useUiStore.getState().library.genres).toEqual([])
    expect(useUiStore.getState().library.query).toBe('')
    tabs.activateTab('a')
    expect(useUiStore.getState().library.query).toBe('mario')
  })

  it('does not lose a pending change to a save already on its way', async () => {
    tabs.updateActiveTab({ tags: ['rpg'] })
    // Another write (the shown tab) answers with the tabs as saved before the change.
    tabs.activateTab('b')
    tabs.activateTab('a')
    await Promise.resolve()
    await Promise.resolve()
    expect(settingsUi().libraryTabs![0]!.filters.tags).toEqual(['rpg'])
    await vi.runAllTimersAsync()
    expect(saved.ui.libraryTabs![0]!.filters.tags).toEqual(['rpg'])
  })

  it('keeps the playable-first button with the tab, the sort and filters as they are', async () => {
    tabs.updateActiveTab({ sort: 'size', tags: ['rpg'] })
    tabs.updateActiveTab({ playableFirst: false })
    expect(useUiStore.getState().library).toMatchObject({
      playableFirst: false,
      sort: 'size',
      tags: ['rpg']
    })
    await vi.runAllTimersAsync()
    expect(saved.ui.libraryTabs![0]).toMatchObject({ playableFirst: false, sort: 'size' })
    tabs.activateTab('b')
    expect(useUiStore.getState().library.playableFirst).toBe(true)
    tabs.activateTab('a')
    expect(useUiStore.getState().library.playableFirst).toBe(false)
  })

  it('remembers the shown tab for the next session', async () => {
    tabs.activateTab('b')
    await vi.runAllTimersAsync()
    expect(saved.ui.libraryTab).toBe('b')
  })

  it('saves each tab position once the focus rests', async () => {
    tabs.rememberPosition('a', 'g1')
    tabs.rememberPosition('a', 'g2')
    expect(saved.ui.libraryPositions).toEqual({})
    await vi.runAllTimersAsync()
    expect(saved.ui.libraryPositions).toEqual({ a: 'g2' })
  })
})

describe('adding and deleting tabs', () => {
  beforeEach(() => {
    setSettings({ libraryTabs: [newTabDef({}, 'a'), newTabDef({}, 'b')], libraryTab: 'a' })
    tabs.restoreLibraryTabs([])
  })

  it('adds All Games on Title A–Z with playable first at the end and shows it', () => {
    const def = tabs.addTab()!
    const defs = settingsUi().libraryTabs!
    expect(defs.at(-1)!.id).toBe(def.id)
    expect(def.sort).toBe('title-asc')
    expect(def.playableFirst).toBe(true)
    expect(useUiStore.getState().library.tab).toBe(def.id)
    expect(useUiStore.getState().library.playableFirst).toBe(true)
  })

  it('deletes the shown tab and shows its neighbour; the last tab stays', () => {
    expect(tabs.deleteTab('a')).toBe(true)
    expect(settingsUi().libraryTabs!.map((d) => d.id)).toEqual(['b'])
    expect(useUiStore.getState().library.tab).toBe('b')
    expect(tabs.deleteTab('b')).toBe(false)
    expect(settingsUi().libraryTabs!.map((d) => d.id)).toEqual(['b'])
  })

  it('reloads the shown tab when Settings changes its filters', () => {
    const defs = settingsUi().libraryTabs!
    tabs.setTabs([{ ...defs[0]!, filters: { ...defs[0]!.filters, stores: ['epic'] } }, defs[1]!])
    expect(useUiStore.getState().library.stores).toEqual(['epic'])
  })
})

describe('showChoiceInLibrary', () => {
  it('reuses a tab with exactly those filters, else adds one, and clears its search', () => {
    const rpg = { ...newTabDef({ filters: { tags: ['rpg'] } }, 'rpg'), query: 'old' }
    setSettings({ libraryTabs: [newTabDef({}, 'a'), rpg], libraryTab: 'a' })
    tabs.restoreLibraryTabs([])
    tabs.showChoiceInLibrary({ tags: ['rpg'] }, 'g1')
    expect(useUiStore.getState().library.tab).toBe('rpg')
    expect(useUiStore.getState().library.query).toBe('')
    expect(settingsUi().libraryTabs!).toHaveLength(2)
    tabs.showChoiceInLibrary({ tags: ['roguelike'] }, 'g2')
    expect(settingsUi().libraryTabs!).toHaveLength(3)
    expect(useUiStore.getState().library.tags).toEqual(['roguelike'])
  })
})

describe('review fixes', () => {
  beforeEach(() => {
    setSettings({ libraryTabs: [newTabDef({}, 'a'), newTabDef({}, 'b')], libraryTab: 'a' })
    tabs.restoreLibraryTabs([])
  })

  it('adds a tab from Settings without leaving the shown tab', () => {
    tabs.activateTab(LIBRARY_SETTINGS_TAB)
    const def = tabs.addTab(undefined, { show: false })!
    expect(settingsUi().libraryTabs!.at(-1)!.id).toBe(def.id)
    expect(useUiStore.getState().library.tab).toBe(LIBRARY_SETTINGS_TAB)
  })

  it('never overwrites a tab when a chip is pressed with every tab slot used', () => {
    const full = Array.from({ length: 40 }, (_, i) =>
      newTabDef({ filters: { genres: ['G' + i] } }, 'tab' + i)
    )
    setSettings({ libraryTabs: full, libraryTab: 'tab0' })
    tabs.showChoiceInLibrary({ tags: ['rpg'] }, 'g1')
    expect(settingsUi().libraryTabs).toEqual(full)
    expect(useUiStore.getState().toasts.at(-1)?.text).toMatch(/Up to 40 tabs/)
  })

  it('writes a pending change at once when flushed (the window closing)', async () => {
    tabs.updateActiveTab({ tags: ['rpg'] })
    tabs.rememberPosition('a', 'g9')
    tabs.flushLibraryTabs()
    await Promise.resolve()
    await Promise.resolve()
    expect(saved.ui.libraryTabs![0]!.filters.tags).toEqual(['rpg'])
    expect(saved.ui.libraryPositions).toEqual({ a: 'g9' })
  })

  it("keeps each tab's scroll in the view at once and saves it once scrolling rests", async () => {
    tabs.rememberScroll('a', { gameId: 'g12', offset: 80.4 })
    tabs.rememberScroll('b', { gameId: 'g3', offset: 10 })
    expect(useUiStore.getState().libraryScroll.a).toEqual({ gameId: 'g12', offset: 80.4 })
    await vi.runAllTimersAsync()
    expect(saved.ui.libraryScroll).toEqual({
      a: { gameId: 'g12', offset: 80 },
      b: { gameId: 'g3', offset: 10 }
    })
    // Back at the top: nothing to remember for that tab.
    tabs.rememberScroll('a', null)
    tabs.flushLibraryTabs()
    await Promise.resolve()
    await Promise.resolve()
    expect(saved.ui.libraryScroll).toEqual({ b: { gameId: 'g3', offset: 10 } })
  })

  it('leaves out a position whose game id is too long to save', async () => {
    tabs.rememberPosition('b', 'manual:' + 'x'.repeat(400))
    tabs.rememberPosition('a', 'g1')
    await vi.runAllTimersAsync()
    expect(saved.ui.libraryPositions).toEqual({ a: 'g1' })
  })
})

describe('before and without saving', () => {
  it('changes no tab before the tabs were restored', () => {
    setSettings({ libraryTabs: [newTabDef({}, 'a')], libraryTab: 'a' })
    expect(tabs.addTab()).toBeNull()
    tabs.setTabs([])
    tabs.showChoiceInLibrary({ tags: ['rpg'] }, 'g1')
    expect(settingsUi().libraryTabs!.map((d) => d.id)).toEqual(['a'])
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('keeps the tabs in memory only when settings failed to load', async () => {
    setSettings({ libraryTabs: null })
    tabs.restoreLibraryTabs([{ id: LIBRARY_ALL_TAB, label: 'All Games' }], { save: false })
    tabs.addTab()
    tabs.updateActiveTab({ tags: ['rpg'] })
    tabs.rememberPosition(LIBRARY_ALL_TAB, 'g1')
    tabs.flushLibraryTabs()
    await vi.runAllTimersAsync()
    expect(settingsUi().libraryTabs).toHaveLength(2)
    expect(updateSettings).not.toHaveBeenCalled()
  })
})

describe('toggleTabChoice (a game page developer / publisher button, genre / tag chip)', () => {
  beforeEach(() => {
    setSettings({
      libraryTabs: [
        newTabDef({ filters: { tags: ['rpg'], stores: ['steam'] } }, 'a'),
        newTabDef({}, 'b')
      ],
      libraryTab: 'b'
    })
    tabs.restoreLibraryTabs([])
  })

  const current = (): ReturnType<typeof tabs.currentTabFilters> =>
    tabs.currentTabFilters(useUiStore.getState().library, settingsUi().libraryTabs!)

  it('adds the developer to the shown tab, keeps its other filters, and saves it with the tab', () => {
    tabs.activateTab('a')
    tabs.toggleTabChoice({ kind: 'developer', name: 'FromSoftware' }, 'g1')
    const view = useUiStore.getState().library
    expect(view.tab).toBe('a')
    expect(view.developers).toEqual(['FromSoftware'])
    expect(view.tags).toEqual(['rpg'])
    expect(view.stores).toEqual(['steam'])
    expect(useUiStore.getState().libraryFocusRequest?.gameId).toBe('g1')
    vi.runAllTimers()
    const def = settingsUi().libraryTabs!.find((d) => d.id === 'a')!
    expect(def.filters.developers).toEqual(['FromSoftware'])
    expect(def.filters.tags).toEqual(['rpg'])
    // A tab without a developer has none saved (the key left out, as an older PlayOut has it).
    expect(settingsUi().libraryTabs!.find((d) => d.id === 'b')!.filters).not.toHaveProperty(
      'developers'
    )
    // Another tab shown: the view has none, not the developer of the tab shown before.
    tabs.activateTab('b')
    expect(useUiStore.getState().library.developers).toEqual([])
    // Taken off again: the saved tab has no empty list.
    tabs.toggleTabChoice({ kind: 'developer', name: 'FromSoftware' }, 'g1')
    tabs.toggleTabChoice({ kind: 'developer', name: 'FromSoftware' }, 'g1')
    vi.runAllTimers()
    expect(settingsUi().libraryTabs!.find((d) => d.id === 'b')!.filters).not.toHaveProperty(
      'developers'
    )
  })

  it("asks for the game's card only when the tab now shows it; otherwise the Library keeps its own focus", () => {
    tabs.activateTab('a')
    useUiStore.setState({ libraryFocusRequest: null, libraryFocus: { a: 'g0' } })
    const seen: string[][] = []
    // Not shown there (a hidden game with Show hidden off, a PC game's developer on a PS2 tab).
    tabs.toggleTabChoice({ kind: 'developer', name: 'Valve' }, 'g1', (view) => {
      seen.push([...view.developers])
      return false
    })
    const state = useUiStore.getState()
    // The shows check got the tab as it now stands.
    expect(seen).toEqual([['Valve']])
    expect(state.screen).toBe('library')
    expect(state.library.tab).toBe('a')
    expect(state.library.developers).toEqual(['Valve'])
    expect(state.libraryFocusRequest).toBeNull()
    expect(state.libraryFocus.a).toBe('g0')
    // Shown: the card is asked for.
    tabs.toggleTabChoice({ kind: 'publisher', name: 'Valve' }, 'g1', () => true)
    expect(useUiStore.getState().libraryFocusRequest?.gameId).toBe('g1')
    expect(useUiStore.getState().libraryFocus.a).toBe('g1')
  })

  it('combines several developers, publishers and genres on one tab', () => {
    tabs.activateTab('a')
    tabs.toggleTabChoice({ kind: 'developer', name: 'Atlus' }, 'g1')
    tabs.toggleTabChoice({ kind: 'developer', name: 'Ryu Ga Gotoku Studio' }, 'g2')
    tabs.toggleTabChoice({ kind: 'publisher', name: 'Sega' }, 'g2')
    tabs.toggleTabChoice({ kind: 'genre', id: 'action' }, 'g2')
    const view = useUiStore.getState().library
    expect(view.developers).toEqual(['Atlus', 'Ryu Ga Gotoku Studio'])
    expect(view.publishers).toEqual(['Sega'])
    expect(view.tags).toEqual(['rpg', 'action'])
    expect(view.stores).toEqual(['steam'])
    vi.runAllTimers()
    const def = settingsUi().libraryTabs!.find((d) => d.id === 'a')!
    expect(def.filters).toMatchObject({
      developers: ['Atlus', 'Ryu Ga Gotoku Studio'],
      publishers: ['Sega'],
      tags: ['rpg', 'action'],
      stores: ['steam']
    })
  })

  it('removes only that choice when it is pressed again (names in any case)', () => {
    tabs.toggleTabChoice({ kind: 'publisher', name: 'Bandai Namco' }, 'g1')
    tabs.toggleTabChoice({ kind: 'publisher', name: 'Sega' }, 'g1')
    expect(useUiStore.getState().library.publishers).toEqual(['Bandai Namco', 'Sega'])
    expect(hasTabChoice(current(), { kind: 'publisher', name: 'bandai namco' })).toBe(true)
    tabs.toggleTabChoice({ kind: 'publisher', name: 'bandai namco' }, 'g1')
    expect(useUiStore.getState().library.publishers).toEqual(['Sega'])
    expect(hasTabChoice(current(), { kind: 'publisher', name: 'Bandai Namco' })).toBe(false)
    vi.runAllTimers()
    expect(settingsUi().libraryTabs!.find((d) => d.id === 'b')!.filters.publishers).toEqual([
      'Sega'
    ])
  })

  it('adds and removes a genre chip on the current tab, its other genres kept', () => {
    tabs.activateTab('a')
    tabs.toggleTabChoice({ kind: 'genre', id: 'strategy' }, 'g1')
    expect(useUiStore.getState().library.tags).toEqual(['rpg', 'strategy'])
    expect(hasTabChoice(current(), { kind: 'genre', id: 'strategy' })).toBe(true)
    tabs.toggleTabChoice({ kind: 'genre', id: 'rpg' }, 'g1')
    expect(useUiStore.getState().library.tags).toEqual(['strategy'])
    // No new tab: the shown one changed.
    expect(settingsUi().libraryTabs!.map((d) => d.id)).toEqual(['a', 'b'])
  })

  it('keeps the filters when the tab is shown again later', () => {
    tabs.toggleTabChoice({ kind: 'developer', name: 'Atlus' }, 'g1')
    tabs.activateTab('a')
    expect(useUiStore.getState().library.developers).toEqual([])
    tabs.activateTab('b')
    expect(useUiStore.getState().library.developers).toEqual(['Atlus'])
  })

  it('uses the first tab while the Settings tab is shown, and reads its choices there', () => {
    tabs.activateTab(LIBRARY_SETTINGS_TAB)
    expect(hasTabChoice(current(), { kind: 'genre', id: 'rpg' })).toBe(true)
    tabs.toggleTabChoice({ kind: 'developer', name: 'Atlus' }, 'g1')
    expect(useUiStore.getState().library.tab).toBe('a')
    expect(useUiStore.getState().library.developers).toEqual(['Atlus'])
    expect(useUiStore.getState().library.tags).toEqual(['rpg'])
  })

  it('does nothing before the tabs were restored', () => {
    tabs.resetLibraryTabsForTests()
    tabs.toggleTabChoice({ kind: 'developer', name: 'Atlus' }, 'g1')
    expect(useUiStore.getState().library.developers).toEqual([])
  })
})

describe('tabs saved with one developer / publisher (before 0.9.42)', () => {
  it('loads them as lists of one, shows them and saves them migrated', async () => {
    const old = {
      ...newTabDef({}, 'ea'),
      filters: {
        ...newTabDef({}, 'x').filters,
        developers: undefined,
        publishers: undefined,
        developer: 'EA Redwood Shores',
        publisher: ''
      }
    } as unknown as LibraryTabDef
    setSettings({ libraryTabs: [old], libraryTab: 'ea' })
    tabs.restoreLibraryTabs([])
    expect(useUiStore.getState().library.developers).toEqual(['EA Redwood Shores'])
    expect(useUiStore.getState().library.publishers).toEqual([])
    await vi.runAllTimersAsync()
    const filters = saved.ui.libraryTabs![0]!.filters as unknown as Record<string, unknown>
    expect(filters.developers).toEqual(['EA Redwood Shores'])
    expect(filters).not.toHaveProperty('developer')
    expect(filters).not.toHaveProperty('publisher')
  })
})

describe("another PC's tabs (the Library tabs sync)", () => {
  /** The main process's settings event with these tabs (another PC's copy taken). */
  const arrive = (libraryTabs: LibraryTabDef[]): void => {
    saved = { ...saved, ui: { ...saved.ui, libraryTabs } }
    receiveSettings(saved)
  }
  const tabWrites = (): number =>
    updateSettings.mock.calls.filter(([p]) => p.ui?.libraryTabs !== undefined).length

  beforeEach(() => {
    setSettings({
      libraryTabs: [newTabDef({}, 'a'), { ...newTabDef({}, 'b'), query: 'mario' }],
      libraryTab: 'b'
    })
    tabs.restoreLibraryTabs([])
    updateSettings.mockClear()
  })

  it('keeps the shown tab and shows its new filters and sort, keeping its search, without saving', async () => {
    arrive([
      newTabDef({}, 'c'),
      newTabDef({}, 'a'),
      {
        ...newTabDef({ filters: { platforms: ['only-on-the-other-pc'] }, sort: 'recent' }, 'b'),
        query: 'mario'
      }
    ])
    const view = useUiStore.getState().library
    expect(view.tab).toBe('b')
    expect(view.platforms).toEqual(['only-on-the-other-pc'])
    expect(view.sort).toBe('recent')
    expect(view.query).toBe('mario')
    await vi.runAllTimersAsync()
    expect(tabWrites()).toBe(0)
  })

  it('shows the neighbour when the shown tab was deleted there, else the first', () => {
    arrive([newTabDef({}, 'a'), newTabDef({ sort: 'size' }, 'z')])
    expect(useUiStore.getState().library.tab).toBe('a')
    tabs.activateTab('z')
    arrive([newTabDef({ sort: 'added' }, 'q')])
    expect(useUiStore.getState().library.tab).toBe('q')
    expect(useUiStore.getState().library.sort).toBe('added')
  })

  it('leaves the view alone for its own tabs coming back, and while its own change waits', async () => {
    tabs.updateActiveTab({ tags: ['rpg'] })
    arrive([newTabDef({}, 'a'), newTabDef({ sort: 'size' }, 'b')])
    // The pending change is newer: it stays shown and is saved.
    expect(useUiStore.getState().library.tags).toEqual(['rpg'])
    await vi.runAllTimersAsync()
    expect(saved.ui.libraryTabs![1]!.filters.tags).toEqual(['rpg'])
    // Its own save coming back changes nothing shown.
    arrive(saved.ui.libraryTabs!.map((d) => ({ ...d })))
    expect(useUiStore.getState().library.tags).toEqual(['rpg'])
  })
})
