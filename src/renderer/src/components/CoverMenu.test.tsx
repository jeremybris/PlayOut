// @vitest-environment jsdom
import { defaultSettings } from '@shared/defaults'
import type { CustomFilter, Game, Settings, SettingsPatch } from '@shared/types'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The options menu Y (or a right click) opens over a cover: Create a filter, and (once the user has filters) Custom
 * filters, whose list adds the game to a filter or removes it.
 */

let saved: Settings
const updateSettings = vi.fn(async (patch: SettingsPatch): Promise<Settings> => {
  saved = mergeSettings(saved, patch)
  return saved
})
vi.mock('../api/client', () => ({
  api: {
    on: () => () => undefined,
    getSettings: async () => saved,
    updateSettings: (patch: SettingsPatch) => updateSettings(patch)
  },
  isMock: false
}))

const { initFocus } = await import('../input/focus')
const { CoverMenuHost } = await import('./CoverMenu')
const { mergeSettings, useSettingsStore } = await import('../state/settings')
const { useLibraryStore } = await import('../state/library')
const { useUiStore } = await import('../state/ui')
const { useStreamingStore } = await import('../state/streaming')
const { registerCardFocuser } = await import('../lib/popupOpeners')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hades = {
  id: 'steam:1',
  title: 'Hades',
  sortTitle: 'hades',
  source: 'steam',
  platformId: 'steam',
  installed: true,
  hidden: false,
  favorite: false,
  launch: { kind: 'uri', uri: '' },
  user: {},
  media: {},
  metadata: {}
} as unknown as Game

let host: HTMLDivElement
let root: Root

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
  initFocus()
})

function setUp(customFilters: CustomFilter[]): void {
  const base = defaultSettings()
  saved = { ...base, library: { ...base.library, customFilters } }
  useSettingsStore.setState({ settings: saved, loaded: true })
  useLibraryStore.setState({ games: [hades], byId: new Map([[hades.id, hades]]) })
  useUiStore.setState({ toasts: [], modals: [] })
  useUiStore.getState().setCoverMenu({ gameId: hades.id, focusKey: 'card:library:steam:1' })
}

beforeEach(() => {
  vi.useFakeTimers()
  updateSettings.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useUiStore.getState().setCoverMenu(null)
  vi.useRealTimers()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
      for (let j = 0; j < 10; j++) await Promise.resolve()
    })
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('no such element')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}

const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('.cover-menu [role="menuitem"]')
]
const row = (text: string): HTMLElement | undefined =>
  rows().find((r) => r.textContent?.startsWith(text))

describe('the options menu and the user’s filters', () => {
  it('offers Create a filter, which opens its dialog for this game', async () => {
    setUp([])
    act(() => root.render(<CoverMenuHost />))
    await settle()
    expect(row('Create a filter…')).toBeDefined()
    // No list without a filter.
    expect(row('Custom filters')).toBeUndefined()
    await click(row('Create a filter…'))
    expect(useUiStore.getState().coverMenu).toBeNull()
    expect(useUiStore.getState().modals.at(-1)).toMatchObject({
      type: 'custom-filter',
      gameId: 'steam:1'
    })
  })

  it('adds the game to a filter and removes it again from the Custom filters list', async () => {
    setUp([
      { id: 'cf1', name: 'Hard', icon: 'skull', gameIds: [] },
      { id: 'cf2', name: 'Cozy', icon: 'leaf', gameIds: ['steam:1'] }
    ])
    act(() => root.render(<CoverMenuHost />))
    await settle()
    expect(row('Custom filters')!.textContent).toContain('In 1')
    await click(row('Custom filters'))
    expect(rows().map((r) => r.textContent)).toEqual(['Add to Hard', 'Remove from Cozy'])
    expect(rows()[0]!.querySelector('svg.lucide-skull')).toBeTruthy()
    await click(row('Add to Hard'))
    expect(saved.library.customFilters[0]!.gameIds).toEqual(['steam:1'])
    // The list stays open, the row now the other way round.
    expect(row('Remove from Hard')).toBeDefined()
    await click(row('Remove from Cozy'))
    expect(saved.library.customFilters[1]!.gameIds).toEqual([])
    expect(row('Add to Cozy')).toBeDefined()
  })

  it("offers Create a filter and Custom filters on a paired host's game too", async () => {
    const hosted = {
      ...hades,
      id: 'remote:h1:9',
      title: 'Celeste',
      sortTitle: 'celeste',
      installed: false,
      remote: {
        hostId: 'h1',
        hostName: 'Den',
        hostGameId: '9',
        streamable: true,
        downloadable: false
      }
    } as unknown as Game
    setUp([{ id: 'cf1', name: 'Hard', icon: 'skull', gameIds: [] }])
    useStreamingStore.setState({
      remote: { games: [hosted], alsoOnHost: {}, updatedAt: '2026-11-01T00:00:00.000Z' }
    })
    useUiStore.getState().setCoverMenu({ gameId: hosted.id, focusKey: 'card:library:remote:h1:9' })
    act(() => root.render(<CoverMenuHost />))
    await settle()
    expect(row('Details')).toBeDefined()
    expect(row('Create a filter…')).toBeDefined()
    await click(row('Custom filters'))
    await click(row('Add to Hard'))
    expect(saved.library.customFilters[0]!.gameIds).toEqual(['remote:h1:9'])
    expect(useUiStore.getState().toasts.at(-1)?.text).toBe('Added Celeste to Hard')
    useStreamingStore.setState({ remote: null })
  })

  it('closes and focuses the next card when the game leaves the Library view it is narrowed by', async () => {
    setUp([
      { id: 'cf1', name: 'Hard', icon: 'skull', gameIds: ['steam:1', 'steam:2'] },
      { id: 'cf2', name: 'Cozy', icon: 'leaf', gameIds: [] }
    ])
    useUiStore.getState().setLibraryFilters({ custom: ['cf1'] })
    // Two cards of the grid: this game's and the one after it.
    const grid = document.createElement('div')
    for (const id of ['steam:1', 'steam:2']) {
      const card = document.createElement('div')
      card.dataset.cardKey = `card:library:${id}`
      grid.appendChild(card)
    }
    document.body.appendChild(grid)
    // The grid's card focuser (LibraryGrid registers it): the card focus goes to.
    const focused: string[] = []
    const unregister = registerCardFocuser('library', (id) => {
      focused.push(id)
      return true
    })
    act(() => root.render(<CoverMenuHost />))
    await settle()
    await click(row('Custom filters'))
    // Adding it to Cozy (not picked) keeps the menu open.
    await click(row('Add to Cozy'))
    expect(useUiStore.getState().coverMenu).not.toBeNull()
    await click(row('Remove from Hard'))
    expect(saved.library.customFilters[0]!.gameIds).toEqual(['steam:2'])
    // Still in Cozy, but Cozy is not picked: the card leaves, the menu goes, focus to its neighbour.
    expect(useUiStore.getState().coverMenu).toBeNull()
    expect(focused).toEqual(['steam:2'])
    unregister()
    grid.remove()
    useUiStore.getState().setLibraryFilters({ custom: [] })
  })
})
