// @vitest-environment jsdom
import { defaultSettings } from '@shared/defaults'
import type { CustomFilter, Game, Settings, SettingsPatch } from '@shared/types'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Create a filter (a game's options menu > Create a filter) and its edit form (Filters > Custom > Rename / Change
 * icon): a name and an icon are needed before Create works; the filter is saved with the game in it.
 */

let saved: Settings
const updateSettings = vi.fn(async (patch: SettingsPatch): Promise<Settings> => {
  saved = mergeSettings(saved, patch)
  return saved
})
vi.mock('../../api/client', () => ({
  api: {
    on: () => () => undefined,
    getSettings: async () => saved,
    updateSettings: (patch: SettingsPatch) => updateSettings(patch)
  },
  isMock: false
}))

const { initFocus } = await import('../../input/focus')
const { CustomFilterDialog } = await import('./CustomFilterDialog')
const { mergeSettings, useSettingsStore } = await import('../../state/settings')
const { useLibraryStore } = await import('../../state/library')
const { useUiStore } = await import('../../state/ui')

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
  user: {},
  media: {},
  metadata: {}
} as unknown as Game

let host: HTMLDivElement
let root: Root
const onClose = vi.fn()

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
  initFocus()
})

function setUp(customFilters: CustomFilter[] = []): void {
  const base = defaultSettings()
  saved = { ...base, library: { ...base.library, customFilters } }
  useSettingsStore.setState({ settings: saved, loaded: true })
  useLibraryStore.setState({ games: [hades], byId: new Map([[hades.id, hades]]) })
}

beforeEach(() => {
  vi.useFakeTimers()
  updateSettings.mockClear()
  onClose.mockClear()
  useUiStore.setState({ toasts: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
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

async function typeName(text: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!
  act(() => {
    input.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

const button = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)
const tile = (label: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[role="radio"][aria-label="${label}"]`)!
const createOff = (): boolean => {
  const b = button('Create')!
  return b.disabled || b.getAttribute('aria-disabled') === 'true'
}

describe('Create a filter', () => {
  it('offers the forty icons, each in its own colour', async () => {
    setUp()
    act(() => root.render(<CustomFilterDialog gameId="steam:1" onClose={onClose} />))
    await settle()
    const tiles = [...document.querySelectorAll<HTMLElement>('[role="radio"]')]
    expect(tiles).toHaveLength(40)
    const colours = tiles.map((t) => t.querySelector<SVGElement>('svg')!.style.color)
    expect(new Set(colours).size).toBe(40)
    expect(document.body.textContent).toContain('Hades goes in it')
  })

  it('keeps Create off until it has a name and an icon, then saves the filter with the game', async () => {
    setUp()
    act(() => root.render(<CustomFilterDialog gameId="steam:1" onClose={onClose} />))
    await settle()
    expect(createOff()).toBe(true)
    await typeName('Rogue nights')
    expect(createOff()).toBe(true)
    await click(tile('Skull'))
    expect(tile('Skull').getAttribute('aria-checked')).toBe('true')
    expect(createOff()).toBe(false)
    await click(button('Create'))
    expect(saved.library.customFilters).toEqual([
      expect.objectContaining({ name: 'Rogue nights', icon: 'skull', gameIds: ['steam:1'] })
    ])
    expect(onClose).toHaveBeenCalled()
    expect(useUiStore.getState().toasts.at(-1)?.text).toBe(
      'Created the filter Rogue nights with Hades in it'
    )
  })

  it('says when the name is taken (any case) and keeps Create off', async () => {
    setUp([{ id: 'cf1', name: 'Cozy', icon: 'leaf', gameIds: [] }])
    act(() => root.render(<CustomFilterDialog gameId="steam:1" onClose={onClose} />))
    await settle()
    await typeName('  cozy ')
    await click(tile('Star'))
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      'You already have a filter with this name.'
    )
    expect(createOff()).toBe(true)
  })

  it('cuts a name at 40 characters', async () => {
    setUp()
    act(() => root.render(<CustomFilterDialog gameId="steam:1" onClose={onClose} />))
    await settle()
    await typeName('x'.repeat(60))
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!.value
    ).toHaveLength(40)
  })

  it('does not let leading spaces use up the 40 characters; the counter shows what the field holds', async () => {
    setUp()
    act(() => root.render(<CustomFilterDialog gameId="steam:1" onClose={onClose} />))
    await settle()
    await typeName(`   ${'y'.repeat(45)}`)
    const value = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!.value
    expect(value).toBe('y'.repeat(40))
    expect(document.body.textContent).toContain('40/40')
  })

  it('saves once for a double press, and never calls its own new name taken while saving', async () => {
    setUp()
    let finish: (() => void) | null = null
    updateSettings.mockImplementationOnce(
      (patch) =>
        new Promise<Settings>((resolve) => {
          finish = () => {
            saved = mergeSettings(saved, patch)
            resolve(saved)
          }
        })
    )
    act(() => root.render(<CustomFilterDialog gameId="steam:1" onClose={onClose} />))
    await settle()
    await typeName('Rogue nights')
    await click(tile('Skull'))
    const create = button('Create')!
    act(() => {
      create.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      create.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await settle()
    // Saving: the settings store already holds the new filter.
    expect(document.querySelector('[role="alert"]')).toBeNull()
    act(() => finish!())
    await settle()
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(saved.library.customFilters).toHaveLength(1)
    expect(useUiStore.getState().toasts.map((t) => t.kind)).not.toContain('error')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('Edit a filter', () => {
  it('starts from its name and icon and saves a new icon', async () => {
    setUp([{ id: 'cf1', name: 'Cozy', icon: 'leaf', gameIds: ['steam:1'] }])
    act(() => root.render(<CustomFilterDialog filterId="cf1" focus="icon" onClose={onClose} />))
    await settle()
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!.value).toBe('Cozy')
    expect(tile('Leaf').getAttribute('aria-checked')).toBe('true')
    await click(tile('Coffee'))
    await click(button('Save'))
    expect(saved.library.customFilters[0]).toEqual({
      id: 'cf1',
      name: 'Cozy',
      icon: 'coffee',
      gameIds: ['steam:1']
    })
  })
})
