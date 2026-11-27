import { defaultSettings } from '@shared/defaults'
import type { CustomFilter, Game, Settings, SettingsPatch } from '@shared/types'
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

const { newTabDef } = await import('../lib/libraryTabs')
const { mergeSettings, useSettingsStore } = await import('./settings')
const { useUiStore } = await import('./ui')
const { useLibraryStore } = await import('./library')
const tabs = await import('./libraryTabs')
const cf = await import('./customFilters')
const { libraryShowsGame } = await import('./libraryShown')

function game(id: string, title: string): Game {
  return {
    id,
    source: 'steam',
    externalId: id,
    platformId: 'steam',
    title,
    sortTitle: title.toLowerCase(),
    installed: true,
    launch: { kind: 'uri', uri: '' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'done',
    user: {}
  }
}

function setUp(customFilters: CustomFilter[] = []): void {
  const base = defaultSettings()
  saved = {
    ...base,
    library: { ...base.library, customFilters },
    ui: {
      ...base.ui,
      libraryTabs: [newTabDef({}, 'a'), newTabDef({ filters: { custom: ['cf2'] } }, 'b')],
      libraryTab: 'a'
    }
  }
  useSettingsStore.setState({ settings: saved, loaded: true })
  const games = [game('steam:1', 'Hades'), game('steam:2', 'Celeste')]
  useLibraryStore.setState({ games, byId: new Map(games.map((g) => [g.id, g])) })
  tabs.restoreLibraryTabs([])
}

const filtersNow = (): CustomFilter[] => useSettingsStore.getState().settings!.library.customFilters
const lastToast = (): string | undefined => useUiStore.getState().toasts.at(-1)?.text

beforeEach(() => {
  vi.useFakeTimers()
  updateSettings.mockClear()
  tabs.resetLibraryTabsForTests()
  useUiStore.setState({ toasts: [], modals: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createCustomFilter', () => {
  it('saves the filter with the game in it and confirms with a toast', async () => {
    setUp()
    const made = await cf.createCustomFilter('  Couch   co-op ', 'users', 'steam:1')
    expect(made).toMatchObject({ name: 'Couch co-op', icon: 'users', gameIds: ['steam:1'] })
    expect(saved.library.customFilters).toEqual([made])
    expect(lastToast()).toBe('Created the filter Couch co-op with Hades in it')
  })

  it('refuses an empty name or one another filter has (any case)', async () => {
    setUp([{ id: 'x', name: 'Couch', icon: 'star', gameIds: [] }])
    expect(await cf.createCustomFilter('   ', 'star', 'steam:1')).toBeNull()
    expect(lastToast()).toBe('Give the filter a name.')
    expect(await cf.createCustomFilter('COUCH', 'star', 'steam:1')).toBeNull()
    expect(lastToast()).toBe('You already have a filter with this name.')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('gives an unknown icon the default one', async () => {
    setUp()
    const made = await cf.createCustomFilter('Mine', 'not-an-icon')
    expect(made!.icon).toBe('star')
  })
})

describe('toggleGameInFilter (the options menu)', () => {
  it('adds the game, then removes it', async () => {
    setUp([{ id: 'cf1', name: 'Hard', icon: 'skull', gameIds: ['steam:2'] }])
    expect(cf.gameInFilter(filtersNow()[0]!, 'steam:1')).toBe(false)
    await cf.toggleGameInFilter('cf1', 'steam:1')
    expect(saved.library.customFilters[0]!.gameIds).toEqual(['steam:2', 'steam:1'])
    expect(lastToast()).toBe('Added Hades to Hard')
    expect(cf.gameInFilter(filtersNow()[0]!, 'steam:1')).toBe(true)
    await cf.toggleGameInFilter('cf1', 'steam:1')
    expect(saved.library.customFilters[0]!.gameIds).toEqual(['steam:2'])
    expect(lastToast()).toBe('Removed Hades from Hard')
  })
})

describe('editCustomFilter', () => {
  it('renames and changes the icon; a taken name is refused', async () => {
    setUp([
      { id: 'cf1', name: 'Hard', icon: 'skull', gameIds: [] },
      { id: 'cf2', name: 'Cozy', icon: 'leaf', gameIds: [] }
    ])
    expect(await cf.editCustomFilter('cf1', { name: 'cozy' })).toBe(false)
    expect(await cf.editCustomFilter('cf1', { name: 'Brutal', icon: 'flame' })).toBe(true)
    expect(saved.library.customFilters[0]).toMatchObject({ name: 'Brutal', icon: 'flame' })
    // Its own name again (another case) is fine.
    expect(await cf.editCustomFilter('cf1', { name: 'BRUTAL' })).toBe(true)
    expect(saved.library.customFilters[0]!.name).toBe('BRUTAL')
  })
})

describe('deleteCustomFilter', () => {
  it('removes it from settings and from every tab that had it picked, the shown one too', async () => {
    setUp([
      { id: 'cf1', name: 'Hard', icon: 'skull', gameIds: [] },
      { id: 'cf2', name: 'Cozy', icon: 'leaf', gameIds: ['steam:1'] }
    ])
    tabs.activateTab('b')
    expect(useUiStore.getState().library.custom).toEqual(['cf2'])
    expect(await cf.deleteCustomFilter('cf2')).toBe(true)
    await vi.runAllTimersAsync()
    expect(saved.library.customFilters.map((f) => f.id)).toEqual(['cf1'])
    expect(useUiStore.getState().library.custom).toEqual([])
    // An emptied list is left out of the saved tab.
    expect(saved.ui.libraryTabs!.find((d) => d.id === 'b')!.filters).not.toHaveProperty('custom')
    expect(lastToast()).toBe('Deleted the filter Cozy')
  })

  it('saves the filter and the tabs that picked it in one settings write', async () => {
    setUp([
      { id: 'cf1', name: 'Hard', icon: 'skull', gameIds: [] },
      { id: 'cf2', name: 'Cozy', icon: 'leaf', gameIds: ['steam:1'] }
    ])
    // A filter pick still waiting for its pause is folded into the same write.
    tabs.updateActiveTab({ custom: ['cf2', 'cf1'] })
    updateSettings.mockClear()
    expect(await cf.deleteCustomFilter('cf2')).toBe(true)
    await vi.runAllTimersAsync()
    expect(updateSettings).toHaveBeenCalledTimes(1)
    const patch = updateSettings.mock.calls[0]![0]
    expect(patch.library!.customFilters!.map((f) => f.id)).toEqual(['cf1'])
    expect(patch.ui!.libraryTabs!.map((d) => d.filters.custom)).toEqual([['cf1'], undefined])
    expect(useUiStore.getState().library.custom).toEqual(['cf1'])
  })

  it('asks first, naming the filter', () => {
    setUp([{ id: 'cf1', name: 'Hard', icon: 'skull', gameIds: ['a', 'b'] }])
    cf.confirmDeleteCustomFilter('cf1')
    const modal = useUiStore.getState().modals.at(-1)
    expect(modal).toMatchObject({ type: 'confirm', title: 'Delete Hard?', danger: true })
  })
})

describe('libraryShowsGame with Filters > Custom', () => {
  it("narrows by the picked filters (a game page's buttons ask it before focusing a card)", () => {
    setUp([{ id: 'cf1', name: 'Hard', icon: 'skull', gameIds: ['steam:2'] }])
    const view = { ...useUiStore.getState().library, custom: ['cf1'] }
    expect(libraryShowsGame('steam:1', view)).toBe(false)
    expect(libraryShowsGame('steam:2', view)).toBe(true)
    expect(libraryShowsGame('steam:1', { ...view, custom: [] })).toBe(true)
  })
})

describe('Library tabs with Filters > Custom', () => {
  it('saves the picked filters with the tab and loads them back; an empty list is left out', async () => {
    setUp([{ id: 'cf1', name: 'Hard', icon: 'skull', gameIds: [] }])
    tabs.updateActiveTab({ custom: ['cf1'] })
    await vi.runAllTimersAsync()
    expect(saved.ui.libraryTabs![0]!.filters.custom).toEqual(['cf1'])
    tabs.activateTab('b')
    expect(useUiStore.getState().library.custom).toEqual(['cf2'])
    tabs.activateTab('a')
    expect(useUiStore.getState().library.custom).toEqual(['cf1'])
    tabs.updateActiveTab({ custom: [] })
    await vi.runAllTimersAsync()
    expect(saved.ui.libraryTabs![0]!.filters).not.toHaveProperty('custom')
  })
})
