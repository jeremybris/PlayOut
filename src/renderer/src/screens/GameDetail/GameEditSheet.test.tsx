// @vitest-environment jsdom
import type { MetadataLayers } from '@shared/metadata-edit'
import type { Game } from '@shared/types'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Edit sheet's Genres & Tags dropdown: it lists the Filters › Genre choices ticked as the game has them, a row
 * toggles in the form, B closes the list back to the field, and Save sends the plain 'genres' / 'tags' edits through
 * api.setMetadataEdit (main's metadata cloud then suggests them, as any saved field). Reset puts both back.
 */

const layers: MetadataLayers = {
  key: 'steam-620',
  scraped: {
    title: 'Portal 2',
    genres: ['Role-playing (RPG)', 'Indie'],
    tags: ['Sci-fi', 'RPG', 'Atmospheric']
  },
  cloud: null,
  local: {}
}

const game = {
  id: 'g1',
  title: 'Portal 2',
  source: 'steam',
  hidden: false,
  launch: { kind: 'steam', appId: '620' },
  user: {},
  media: {},
  metadata: {
    genres: ['Role-playing (RPG)', 'Indie'],
    steamTags: { tags: ['Sci-fi', 'RPG', 'Atmospheric'] }
  }
} as unknown as Game

const api = vi.hoisted(() => ({
  on: () => () => undefined,
  getMetadataLayers: vi.fn(),
  setMetadataEdit: vi.fn(),
  updateGame: vi.fn(),
  getSystems: vi.fn(async () => [])
}))

vi.mock('../../api/client', () => ({ api, isMock: false }))

const { getCurrentFocusKey, initFocus, setFocus } = await import('../../input/focus')
const { dispatchAction } = await import('../../input/actions')
const { GameEditSheet } = await import('./GameEditSheet')
const { useUiStore } = await import('../../state/ui')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
  initFocus()
})

beforeEach(() => {
  vi.useFakeTimers()
  api.getMetadataLayers.mockReset().mockResolvedValue(layers)
  api.setMetadataEdit.mockReset().mockResolvedValue(game)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

/** Let the layers' promise and the focus moves (setTimeout 0, Norigin's async setFocus) run. */
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

const field = (): HTMLElement =>
  document.querySelector<HTMLElement>('[aria-haspopup="listbox"][aria-label^="Genres & Tags"]')!
const list = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="listbox"][aria-label="Genres & Tags"]')
const rows = (): HTMLElement[] => [...list()!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
const row = (label: string): HTMLElement | undefined => rows().find((r) => r.textContent === label)
const ticked = (): string[] =>
  rows()
    .filter((r) => r.getAttribute('aria-current') === 'true')
    .map((r) => r.textContent ?? '')
const button = (text: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find(
    (b) => b.textContent === text || b.getAttribute('aria-label') === text
  )

async function openSheet(): Promise<void> {
  act(() => root.render(<GameEditSheet game={game} onClose={() => undefined} />))
  await settle()
  expect(field()).toBeDefined()
}

/** Focus the field (as the controller or the pointer's hover does) and open its list. */
async function openList(): Promise<void> {
  act(() => void setFocus('gedit:genresTags'))
  await settle()
  await click(field())
  expect(list()).not.toBeNull()
}

describe('Edit sheet > Genres & Tags', () => {
  it('replaces the two text fields with one dropdown, ticked as the game has them', async () => {
    await openSheet()
    expect(document.querySelector('[aria-label="Genres"]')).toBeNull()
    expect(document.querySelector('[aria-label="Tags"]')).toBeNull()
    expect(field().textContent).toBe('RPG, Indie +2')
    await openList()
    expect(list()).not.toBeNull()
    expect(list()!.getAttribute('aria-multiselectable')).toBe('true')
    // The choices (alphabetical), then the game's own others after the separator.
    expect(ticked()).toEqual(['RPG', 'Science Fiction', 'Atmospheric', 'Indie'])
    expect(list()!.querySelector('[role="separator"]')).not.toBeNull()
    expect(getCurrentFocusKey()).toBe('gedit:genresTags:menu:rpg')
  })

  it('toggles rows, B closes back to the field, and Save sends the genres and tags edits', async () => {
    await openSheet()
    await openList()
    // A on the focused row (RPG, the first ticked) unticks it; a click ticks Puzzle.
    act(() => void dispatchAction('accept', 'gamepad'))
    await settle()
    await click(row('Puzzle'))
    expect(list()).not.toBeNull()
    expect(ticked()).toEqual(['Puzzle', 'Science Fiction', 'Atmospheric', 'Indie'])
    act(() => void dispatchAction('back', 'keyboard'))
    await settle()
    expect(list()).toBeNull()
    expect(getCurrentFocusKey()).toBe('gedit:genresTags')
    expect(field().textContent).toBe('Indie, Puzzle +2')
    expect(document.querySelector('.gedit__origin--changed')?.textContent).toBe('Changed')
    await click(button('Save'))
    expect(api.setMetadataEdit).toHaveBeenCalledTimes(1)
    expect(api.setMetadataEdit).toHaveBeenCalledWith(
      'g1',
      { genres: ['Indie', 'Puzzle'], tags: ['Sci-fi', 'Atmospheric'] },
      []
    )
  })

  it('saves nothing for a dropdown opened and closed, or a row toggled twice', async () => {
    await openSheet()
    await openList()
    await click(row('Indie'))
    await click(row('Indie'))
    act(() => void dispatchAction('back', 'keyboard'))
    await settle()
    await click(button('Save'))
    expect(api.setMetadataEdit).not.toHaveBeenCalled()
  })

  it('Reset puts back both the genres and the tags', async () => {
    await openSheet()
    await openList()
    await click(row('RPG'))
    await click(row('Action'))
    act(() => void dispatchAction('back', 'keyboard'))
    await settle()
    await click(button('Reset genres & tags'))
    expect(field().textContent).toBe('RPG, Indie +2')
    expect(button('Reset genres & tags')).toBeUndefined()
    await click(button('Save'))
    expect(api.setMetadataEdit).not.toHaveBeenCalled()
  })
})

describe('Edit sheet > Genres & Tags search', () => {
  const box = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('input[aria-label="Search genres & tags"]')!
  const suggestionList = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[role="listbox"][aria-label="Matching genres & tags"]')
  const suggestions = (): string[] =>
    [...(suggestionList()?.querySelectorAll('[role="menuitem"]') ?? [])].map(
      (r) => r.textContent ?? ''
    )

  async function type(text: string): Promise<void> {
    const input = box()
    act(() => {
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle()
  }

  it('shows nothing for an empty box, the matches as one types, and a line when nothing matches', async () => {
    await openSheet()
    expect(box()).not.toBeNull()
    expect(box().placeholder).toBe('Type a genre or tag…')
    expect(suggestionList()).toBeNull()
    await type('pu')
    // Names the game has (RPG, Indie, ...) are left out; starts-with first.
    expect(suggestions()).toEqual(['Puzzle', 'Puzzle Platformer'])
    await type('rpg')
    expect(suggestions()).toEqual(['Action RPG', 'JRPG'])
    await type('zzz')
    expect(suggestions()).toEqual([])
    expect(suggestionList()!.textContent).toBe('No matching genre or tag')
    await type('')
    expect(suggestionList()).toBeNull()
  })

  it('a click adds the one picked as the dropdown would, clears the box and closes the list', async () => {
    await openSheet()
    await type('puz')
    const puzzle = [...suggestionList()!.querySelectorAll('[role="menuitem"]')].find(
      (r) => r.textContent === 'Puzzle'
    )
    await click(puzzle)
    expect(suggestionList()).toBeNull()
    expect(box().value).toBe('')
    expect(field().textContent).toBe('RPG, Indie +3')
    await openList()
    expect(ticked()).toEqual(['Puzzle', 'RPG', 'Science Fiction', 'Atmospheric', 'Indie'])
    act(() => void dispatchAction('back', 'keyboard'))
    await settle()
    await click(button('Save'))
    expect(api.setMetadataEdit).toHaveBeenCalledWith(
      'g1',
      { genres: ['Role-playing (RPG)', 'Indie', 'Puzzle'] },
      []
    )
  })

  it('Enter picks the first suggestion', async () => {
    await openSheet()
    await type('rpg')
    act(() => {
      box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await settle()
    expect(suggestionList()).toBeNull()
    expect(box().value).toBe('')
    await openList()
    expect(ticked()).toContain('Action RPG')
  })

  it('down goes into the list, A picks, and B closes the list first', async () => {
    await openSheet()
    await type('pu')
    act(() => void setFocus('gedit:genresTags:search:box'))
    await settle()
    act(() => void dispatchAction('down', 'gamepad'))
    await settle()
    expect(getCurrentFocusKey()).toBe('gedit:genresTags:search:item:puzzle')
    act(() => void dispatchAction('up', 'gamepad'))
    await settle()
    expect(getCurrentFocusKey()).toBe('gedit:genresTags:search:box')
    act(() => void dispatchAction('back', 'gamepad'))
    await settle()
    expect(suggestionList()).toBeNull()
    expect(getCurrentFocusKey()).toBe('gedit:genresTags:search:box')
    await type('puzzle p')
    act(() => void setFocus('gedit:genresTags:search:box'))
    await settle()
    act(() => void dispatchAction('down', 'gamepad'))
    await settle()
    act(() => void dispatchAction('accept', 'gamepad'))
    await settle()
    expect(suggestionList()).toBeNull()
    expect(field().textContent).toBe('RPG, Indie +3')
  })

  const keydown = (key: string): void =>
    act(() => {
      box().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })

  it('one Escape typed in the box closes the list and leaves the sheet open', async () => {
    await openSheet()
    await type('pu')
    expect(suggestionList()).not.toBeNull()
    keydown('Escape')
    await settle()
    expect(suggestionList()).toBeNull()
    expect(button('Save')).toBeDefined()
  })

  it('Enter with the list closed shows it again instead of adding an unseen match', async () => {
    await openSheet()
    await type('pu')
    keydown('Escape')
    await settle()
    act(() => box().focus())
    keydown('Enter')
    await settle()
    expect(suggestions()).toEqual(['Puzzle', 'Puzzle Platformer'])
    expect(field().textContent).toBe('RPG, Indie +2')
    keydown('Enter')
    await settle()
    expect(suggestionList()).toBeNull()
    expect(field().textContent).toBe('RPG, Indie +3')
  })

  describe('with the controller', () => {
    const oskList = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('.osk .gedit-tags-osk')
    const oskMatches = (): string[] =>
      [...(oskList()?.querySelectorAll('[role="option"]') ?? [])].map((r) => r.textContent ?? '')
    const key = (char: string): HTMLElement | undefined =>
      [...document.querySelectorAll<HTMLElement>('.osk .osk__key')].find(
        (k) => k.getAttribute('aria-label') === char
      )

    beforeEach(() => useUiStore.getState().setInputMethod('gamepad'))
    afterEach(() => useUiStore.getState().setInputMethod('keyboard'))

    async function openKeyboard(): Promise<void> {
      await openSheet()
      act(() => void setFocus('gedit:genresTags:search:box'))
      await settle()
      act(() => void dispatchAction('accept', 'gamepad'))
      await settle()
      expect(document.querySelector('.osk')).not.toBeNull()
    }

    it('the on-screen keyboard shows the matches while typing, before Done', async () => {
      await openKeyboard()
      expect(oskMatches()).toEqual([])
      await click(key('p'))
      await click(key('u'))
      expect(oskMatches()).toEqual(['Puzzle', 'Puzzle Platformer'])
      await click(key('z'))
      await click(key('z'))
      await click(key('z'))
      await click(key('z'))
      expect(oskMatches()).toEqual([])
      expect(oskList()!.textContent).toBe('No matching genre or tag')
    })

    it('A on a match adds it, closes the keyboard and clears the box', async () => {
      await openKeyboard()
      await click(key('p'))
      await click(key('u'))
      act(() => void setFocus('gedit:genresTags:search:osk:puzzle'))
      await settle()
      expect(getCurrentFocusKey()).toBe('gedit:genresTags:search:osk:puzzle')
      await settle()
      act(() => void dispatchAction('accept', 'gamepad'))
      await settle()
      expect(document.querySelector('.osk')).toBeNull()
      expect(box().value).toBe('')
      expect(suggestionList()).toBeNull()
      expect(field().textContent).toBe('RPG, Indie +3')
      expect(getCurrentFocusKey()).toBe('gedit:genresTags:search:box')
    })
  })
})

describe('Edit sheet > Difficulty of a tool (Steam tag Utilities)', () => {
  const tool = {
    ...game,
    id: 'g2',
    title: 'Wallpaper Engine',
    launch: { kind: 'steam', appId: '431960' },
    metadata: { genres: ['Casual'], steamTags: { tags: ['Utilities', 'Casual'] } }
  } as unknown as Game
  const difficulty = (): HTMLElement =>
    document.querySelector<HTMLElement>('[role="group"][aria-label="Filters › Difficulty"]')!
  const shown = (): string => difficulty().querySelector('.select__value')!.textContent ?? ''

  it('describes the N/A (Tools) label as the Default, and offers only the five levels besides', async () => {
    api.getMetadataLayers.mockResolvedValue({
      key: 'steam-431960',
      scraped: { title: 'Wallpaper Engine', genres: ['Casual'] },
      cloud: null,
      local: {}
    })
    act(() => root.render(<GameEditSheet game={tool} onClose={() => undefined} />))
    await settle()
    expect(shown()).toBe('Default (N/A (Tools), from the Utilities tag)')
    const next = difficulty().querySelector<HTMLElement>(
      'button[aria-label="Next option"], button.select__arrow:last-of-type'
    )!
    const seen = [shown()]
    for (let i = 0; i < 6; i++) {
      await click(next)
      seen.push(shown())
    }
    // The choices cycle: Default, then the five levels; N/A (Tools) is not one to pick.
    expect(new Set(seen)).toEqual(
      new Set([
        'Default (N/A (Tools), from the Utilities tag)',
        'Story',
        'Easy',
        'Medium',
        'Hard',
        'Impossible'
      ])
    )
    expect(seen).not.toContain('N/A (Tools)')
  })
})

describe('Edit sheet > Controls', () => {
  const controls = (): HTMLElement =>
    document.querySelector<HTMLElement>('[role="group"][aria-label="Controls"]')!
  const shown = (): string => controls().querySelector('.select__value')!.textContent ?? ''
  const next = (): HTMLElement =>
    controls().querySelector<HTMLElement>(
      'button[aria-label="Next option"], button.select__arrow:last-of-type'
    )!

  it('is one list of the seven choices, and Save sends the picked one as the controls edit', async () => {
    await openSheet()
    // No separate VR or Touch list any more.
    expect(document.querySelector('[role="group"][aria-label="VR"]')).toBeNull()
    expect(document.querySelector('[role="group"][aria-label="Touch"]')).toBeNull()
    expect(document.querySelector('[role="group"][aria-label="Controller"]')).toBeNull()
    // A game without controls data shows Mouse & Keyboard.
    expect(shown()).toBe('Mouse & Keyboard')
    const seen = [shown()]
    for (let i = 0; i < 6; i++) {
      await click(next())
      seen.push(shown())
    }
    // The list's order (VR first) read from Mouse & Keyboard on: it wraps round after All.
    expect(seen).toEqual([
      'Mouse & Keyboard',
      'Mouse & Keyboard + Controller',
      'All',
      'VR',
      'Touch',
      'Full Controller Support',
      'Partial Controller Support'
    ])
    // Round to All and save.
    while (shown() !== 'All') await click(next())
    await click(button('Save'))
    expect(api.setMetadataEdit).toHaveBeenCalledWith(
      'g1',
      { controls: { controller: 'full', vr: 'supported', keyboard: true } },
      []
    )
  })

  it('does not save controls the user left alone', async () => {
    await openSheet()
    // Round the whole list back to where it started.
    for (let i = 0; i < 7; i++) await click(next())
    expect(shown()).toBe('Mouse & Keyboard')
    await click(button('Save'))
    for (const call of api.setMetadataEdit.mock.calls)
      expect((call[1] as Record<string, unknown>).controls).toBeUndefined()
  })
})
