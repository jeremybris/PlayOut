// @vitest-environment jsdom
import { act, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Filters > Clear filters' sub-menu (a developer, publisher or genre on): its rows remove one choice each, focus
 * moving to the next row (Clear filters, else Genre, once the last goes), and All turns every filter off.
 */

vi.mock('../../api/client', () => ({
  api: { on: () => () => undefined },
  isMock: false
}))

const { doesFocusableExist, getCurrentFocusKey, initFocus } = await import('../../input/focus')
const { FiltersPill } = await import('./FiltersPill')
const { CATEGORY_KEY } = await import('./keys')
const { useSettingsStore } = await import('../../state/settings')
const { useUiStore } = await import('../../state/ui')
const { defaultSettings } = await import('@shared/defaults')
type StoreFilter = import('../../lib/storeFilters').StoreFilter
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MENU = `${CATEGORY_KEY}:menu`
const SUB = `${CATEGORY_KEY}:clear-filters`

interface Start {
  developers?: string[]
  publishers?: string[]
  tags?: string[]
  favorites?: boolean
  difficulty?: string[]
  reviews?: string[]
  controls?: string[]
  controlsOptions?: string[]
  platforms?: string[]
  platformOptions?: { id: string; label: string }[]
  stores?: string[]
  storeOptions?: { id: StoreFilter['id']; label: string }[]
  custom?: string[]
  customCounts?: Map<string, number>
}

const onPlatformsSpy = vi.fn()
const onStoresSpy = vi.fn()
const onCustomSpy = vi.fn()

const onClearFilters = vi.fn()

/** The pill with its filters kept in state, as the Library keeps them in the tab. */
function Harness({ start }: { start: Start }): ReactElement {
  const [developers, setDevelopers] = useState(start.developers ?? [])
  const [publishers, setPublishers] = useState(start.publishers ?? [])
  const [tags, setTags] = useState(start.tags ?? [])
  const [favorites, setFavorites] = useState(start.favorites ?? false)
  const [difficulty, setDifficulty] = useState(start.difficulty ?? [])
  const [reviews, setReviews] = useState(start.reviews ?? [])
  const [controls, setControls] = useState(start.controls ?? [])
  const [platforms, setPlatforms] = useState(start.platforms ?? [])
  const [stores, setStores] = useState(start.stores ?? [])
  const [custom, setCustom] = useState(start.custom ?? [])
  const none = (): void => undefined
  return (
    <FiltersPill
      platforms={platforms}
      platformOptions={start.platformOptions ?? []}
      onPlatforms={(next) => {
        onPlatformsSpy(next)
        setPlatforms(next)
      }}
      eras={[]}
      eraOptions={[]}
      controlsOptions={start.controlsOptions ?? []}
      onEras={none}
      tags={tags}
      tagOptions={[]}
      onTags={setTags}
      stores={stores}
      storeOptions={start.storeOptions ?? []}
      onStores={(next) => {
        onStoresSpy(next)
        setStores(next)
      }}
      sizes={[]}
      onSizes={none}
      hltb={[]}
      onHltb={none}
      difficulty={difficulty}
      onDifficulty={setDifficulty}
      reviews={reviews}
      onReviews={setReviews}
      controls={controls}
      onControls={setControls}
      players={[]}
      onPlayers={none}
      online={[]}
      onOnline={none}
      hidden={false}
      onHidden={none}
      hiddenCount={0}
      favorites={favorites}
      onFavorites={setFavorites}
      favoriteCount={0}
      coop={false}
      onCoop={none}
      recomp={false}
      onRecomp={none}
      recompCount={0}
      developers={developers}
      onDevelopers={setDevelopers}
      publishers={publishers}
      onPublishers={setPublishers}
      custom={custom}
      onCustom={(next) => {
        onCustomSpy(next)
        setCustom(next)
      }}
      customCounts={start.customCounts}
      onClearFilters={() => {
        onClearFilters()
        setDevelopers([])
        setPublishers([])
        setTags([])
        setFavorites(false)
        setDifficulty([])
        setReviews([])
        setCustom([])
      }}
    />
  )
}

let host: HTMLDivElement
let root: Root

beforeAll(() => {
  // jsdom has no layout: a focused row scrolls itself into view.
  Element.prototype.scrollIntoView = () => undefined
  initFocus()
})

beforeEach(() => {
  vi.useFakeTimers()
  onClearFilters.mockClear()
  onPlatformsSpy.mockClear()
  onStoresSpy.mockClear()
  onCustomSpy.mockClear()
  useSettingsStore.setState({ settings: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

/** Let the menus' deferred focus moves and closes run (each a setTimeout 0, some nested). */
async function settle(): Promise<void> {
  // Norigin's setFocus is async (it awaits the next focus key): microtasks are flushed after each round of timers.
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

const pill = (): HTMLElement => host.querySelector('[aria-label="Filters"][role="group"]')!
const subMenu = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="menu"][aria-label="Clear filters"]')
const rowsOf = (menu: HTMLElement | null): HTMLElement[] =>
  menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')] : []
const row = (menu: HTMLElement | null, label: string): HTMLElement | undefined =>
  rowsOf(menu).find((r) => r.textContent?.startsWith(label))
const filtersMenu = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="menu"][aria-label="Filters"]')

/** Open the Filters menu, then Clear filters' sub-menu. */
async function openClearSubMenu(start: Start): Promise<void> {
  act(() => root.render(<Harness start={start} />))
  await click(pill())
  expect(filtersMenu()).not.toBeNull()
  await click(row(filtersMenu(), 'Clear filters'))
  expect(subMenu()).not.toBeNull()
}

describe('Filters menu with developers and publishers', () => {
  it('counts them in the pill and shows Clear filters, but they never fill the menu', async () => {
    act(() =>
      root.render(
        <Harness start={{ developers: ['Atlus', 'Sega', 'Capcom'], publishers: ['Sega'] }} />
      )
    )
    expect(pill().textContent).toContain('Filters (4)')
    await click(pill())
    expect(row(filtersMenu(), 'Clear filters')).toBeDefined()
    expect(filtersMenu()!.textContent).not.toContain('filters at once')
    expect(row(filtersMenu(), 'Favorites')!.getAttribute('aria-disabled')).toBeNull()
  })
})

describe('Filters > Clear filters sub-menu', () => {
  it('lists All, then each developer, publisher and genre', async () => {
    await openClearSubMenu({ developers: ['Atlus', 'Sega'], publishers: ['Sega'] })
    expect(rowsOf(subMenu()).map((r) => r.textContent)).toEqual([
      'All',
      'AtlusDeveloper',
      'SegaDeveloper',
      'SegaPublisher'
    ])
  })

  it('removes a middle row, focus on the next row', async () => {
    await openClearSubMenu({ developers: ['Atlus', 'Sega'], publishers: ['Sega'] })
    await click(rowsOf(subMenu())[2]) // Sega, developer
    expect(rowsOf(subMenu()).map((r) => r.textContent)).toEqual([
      'All',
      'AtlusDeveloper',
      'SegaPublisher'
    ])
    expect(getCurrentFocusKey()).toBe(`${SUB}:publisher:sega`)
    expect(onClearFilters).not.toHaveBeenCalled()
  })

  it('removes the last row: the sub-menu closes, focus on Clear filters while a filter is left', async () => {
    await openClearSubMenu({ developers: ['Atlus'], favorites: true })
    await click(row(subMenu(), 'Atlus'))
    expect(subMenu()).toBeNull()
    // Favorites is still on: Clear filters stays, now a plain row.
    expect(row(filtersMenu(), 'Clear filters')).toBeDefined()
    expect(getCurrentFocusKey()).toBe(`${MENU}:clear`)
  })

  it('removes the last row of a tab with nothing else on: focus on the first row (Controls), as Clear filters goes', async () => {
    await openClearSubMenu({ developers: ['Atlus'] })
    await click(row(subMenu(), 'Atlus'))
    expect(subMenu()).toBeNull()
    expect(row(filtersMenu(), 'Clear filters')).toBeUndefined()
    expect(getCurrentFocusKey()).toBe(`${MENU}:controls`)
  })

  it('All turns every filter off once and closes the sub-menu', async () => {
    await openClearSubMenu({ developers: ['Atlus'], publishers: ['Sega'], favorites: true })
    await click(row(subMenu(), 'All'))
    expect(onClearFilters).toHaveBeenCalledTimes(1)
    expect(subMenu()).toBeNull()
    expect(row(filtersMenu(), 'Clear filters')).toBeUndefined()
    expect(getCurrentFocusKey()).toBe(`${MENU}:controls`)
  })
})

describe('Filters > Favorites', () => {
  it('has a heart where the other rows have their arrow, filled while it is on', async () => {
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    const heart = (): SVGElement | null | undefined =>
      row(filtersMenu(), 'Favorites')?.querySelector<SVGElement>('svg.lucide-heart')
    expect(heart()).toBeTruthy()
    expect(heart()!.getAttribute('fill')).toBe('none')
    expect(row(filtersMenu(), 'Hidden')?.querySelector('svg.lucide-heart')).toBeNull()
    expect(row(filtersMenu(), 'Hidden')?.querySelector('svg.lucide-eye-closed')).toBeTruthy()
    await click(row(filtersMenu(), 'Favorites'))
    expect(heart()!.getAttribute('fill')).toBe('currentColor')
  })
})

describe('Filters > Difficulty', () => {
  const difficultyMenu = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[role="listbox"][aria-label="Difficulty"]')

  it('sits in the alphabetical list of rows, after Controls and before Genre', async () => {
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    const labels = rowsOf(filtersMenu()).map((r) => r.textContent ?? '')
    expect(labels.indexOf('Difficulty')).toBe(labels.indexOf('Controls') + 1)
    expect(labels[labels.indexOf('Difficulty') + 1]).toBe('Genre')
  })

  it('opens a sub-menu: All Difficulties, then the five levels, each with its picture', async () => {
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    await click(row(filtersMenu(), 'Difficulty'))
    const rows = rowsOf(difficultyMenu())
    expect(rows.map((r) => r.textContent)).toEqual([
      'All Difficulties',
      'Story',
      'Easy',
      'Medium',
      'Hard',
      'Impossible'
    ])
    expect(rows[0]!.querySelector('img.console-icon__img')).toBeNull()
    const icons = rows
      .slice(1)
      .map((r) => r.querySelector('span.console-icon > img.console-icon__img'))
    expect(icons.every((img) => img !== null)).toBe(true)
    expect(new Set(icons.map((img) => img!.getAttribute('src'))).size).toBe(5)
    // N/A (Tools), the label of a game Steam tags Utilities, is not a level to filter by.
    expect(rows.some((r) => /N\/A|Tools/.test(r.textContent ?? ''))).toBe(false)
  })

  it('picks a level: the row shows it and the pill counts it', async () => {
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    await click(row(filtersMenu(), 'Difficulty'))
    await click(row(difficultyMenu(), 'Hard'))
    expect(pill().textContent).toContain('Filters (1)')
    expect(row(filtersMenu(), 'Difficulty')!.textContent).toBe('DifficultyHard')
    await click(row(difficultyMenu(), 'Story'))
    expect(row(filtersMenu(), 'Difficulty')!.textContent).toBe('DifficultyHard +1')
    // All Difficulties clears the list.
    await click(row(difficultyMenu(), 'All Difficulties'))
    expect(pill().textContent).not.toContain('(')
  })

  it('counts toward the filters at once, and Clear filters turns it off', async () => {
    act(() => root.render(<Harness start={{ difficulty: ['story', 'easy', 'hard'] }} />))
    expect(pill().textContent).toContain('Filters (3)')
    await click(pill())
    expect(filtersMenu()!.textContent).toContain('filters at once')
    await click(row(filtersMenu(), 'Clear filters'))
    expect(onClearFilters).toHaveBeenCalledTimes(1)
    expect(pill().textContent).not.toContain('(')
  })
})

describe('Filters > Reviews', () => {
  const reviewsMenu = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[role="listbox"][aria-label="Reviews"]')

  it('sits in the alphabetical list of rows, after Release and before Size', async () => {
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    const labels = rowsOf(filtersMenu()).map((r) => r.textContent ?? '')
    const reviews = labels.indexOf('Reviews')
    expect(reviews).toBeGreaterThan(0)
    expect(labels[reviews + 1]?.startsWith('Size')).toBe(true)
  })

  it('opens a sub-menu: All Reviews, then the nine bands best first, each with a star', async () => {
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    await click(row(filtersMenu(), 'Reviews'))
    const rows = rowsOf(reviewsMenu())
    expect(rows.map((r) => r.textContent)).toEqual([
      'All Reviews',
      '95-100',
      '90-95',
      '85-90',
      '80-85',
      '75-80',
      '70-75',
      '60-70',
      '40-60',
      '0-40'
    ])
    expect(rows[0]!.querySelector('svg.review-star')).toBeNull()
    const stars = rows
      .slice(1)
      .map((r) =>
        r.querySelector<SVGElement>('span.console-icon[aria-hidden="true"] > svg.review-star')
      )
    expect(stars.every((s) => s !== null)).toBe(true)
    // Full for 95-100, one ninth less for each band below, a sliver for 0-40.
    expect(stars.map((s) => s!.getAttribute('data-fill'))).toEqual(
      [9, 8, 7, 6, 5, 4, 3, 2, 1].map((k) => (k / 9).toFixed(3))
    )
    // Each star's fill has a clip of its own.
    const clipIds = stars.map((s) => s!.querySelector('clipPath')!.id)
    expect(new Set(clipIds).size).toBe(9)
    for (const [i, s] of stars.entries())
      expect(s!.querySelector('path[clip-path]')!.getAttribute('clip-path')).toBe(
        `url(#${clipIds[i]})`
      )
    // The icon sits before the band's text.
    const first = rows[1]!
    const icon = first.querySelector('svg.review-star')!
    const text = [...first.querySelectorAll('*')].find(
      (el) => el.textContent === '95-100' && el.children.length === 0
    )!
    expect(icon.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('picks bands: the row shows them and the pill counts them; All Reviews clears them', async () => {
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    await click(row(filtersMenu(), 'Reviews'))
    await click(row(reviewsMenu(), '90-95'))
    expect(pill().textContent).toContain('Filters (1)')
    expect(row(filtersMenu(), 'Reviews')!.textContent).toBe('Reviews90-95')
    await click(row(reviewsMenu(), '0-40'))
    expect(row(filtersMenu(), 'Reviews')!.textContent).toBe('Reviews90-95 +1')
    await click(row(reviewsMenu(), 'All Reviews'))
    expect(pill().textContent).not.toContain('(')
  })

  it('Clear filters turns it off', async () => {
    act(() => root.render(<Harness start={{ reviews: ['r95', 'r40'] }} />))
    expect(pill().textContent).toContain('Filters (2)')
    await click(pill())
    await click(row(filtersMenu(), 'Clear filters'))
    expect(onClearFilters).toHaveBeenCalledTimes(1)
    expect(pill().textContent).not.toContain('(')
  })
})

describe('Filters > Recompilations', () => {
  it('has the recompilation up arrow where the other rows have their arrow, filled while it is on', async () => {
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    const arrow = (): SVGElement | null | undefined =>
      row(filtersMenu(), 'Recompilations')?.querySelector<SVGElement>('svg.lucide-arrow-big-up')
    expect(arrow()).toBeTruthy()
    expect(arrow()!.getAttribute('fill')).toBe('none')
  })
})

describe('Filters > Local Multiplayer', () => {
  it('gives each choice but All Local Multiplayer an icon; the player counts keep their picture beside their words', async () => {
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    await click(row(filtersMenu(), 'Multiplayer - Local'))
    const menu = document.querySelector<HTMLElement>(
      '[role="listbox"][aria-label="Multiplayer - Local"]'
    )
    const rows = rowsOf(menu)
    const icon = (label: string): string | undefined =>
      rows
        .find(
          (r) =>
            (r.textContent || r.querySelector('[aria-label]')?.getAttribute('aria-label')) === label
        )
        ?.querySelector('span.console-icon > svg')
        ?.getAttribute('class') ?? undefined
    expect(rows[0]!.querySelector('span.console-icon')).toBeNull()
    expect(icon('Party Games')).toContain('lucide-party-popper')
    expect(icon('S.O. Games')).toContain('lucide-heart-handshake')
    expect(icon('L.A.N. Party')).toContain('lucide-network')
    expect(icon('Nucleus Co-Op')).toContain('lucide-users')
    for (const label of ['2 Players', '2-4 Players', '4+ Players']) {
      const r = rows.find((x) => x.textContent?.endsWith(label))
      expect(r?.querySelector('span.console-icon .players-art'), label).not.toBeNull()
    }
  })
})

describe('Filters > Online Multiplayer', () => {
  it('gives each choice but All Online Multiplayer an icon', async () => {
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    await click(row(filtersMenu(), 'Multiplayer - Online'))
    const rows = rowsOf(
      document.querySelector<HTMLElement>('[role="listbox"][aria-label="Multiplayer - Online"]')
    )
    const icon = (label: string): string | null | undefined =>
      rows
        .find((r) => r.textContent === label)
        ?.querySelector('span.console-icon > svg')
        ?.getAttribute('class')
    expect(rows[0]!.textContent).toBe('All Online Multiplayer')
    expect(rows[0]!.querySelector('span.console-icon')).toBeNull()
    expect(icon('All Competitive')).toContain('lucide-swords')
    expect(icon('All Cooperative')).toContain('lucide-handshake')
    expect(icon('eSports')).toContain('lucide-trophy')
    expect(icon('Massively Multiplayer')).toContain('lucide-globe')
    expect(icon('PvP')).toContain('lucide-sword')
    expect(icon('Team Based')).toContain('lucide-users')
  })
})

describe('Filters > Controls', () => {
  const controlsMenu = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[role="listbox"][aria-label="Controls"]')
  const open = async (start: Start): Promise<string[]> => {
    act(() => root.render(<Harness start={start} />))
    await click(pill())
    await click(row(filtersMenu(), 'Controls'))
    // Each row's words (the VR picture has the letters VR in it).
    return rowsOf(controlsMenu()).map((r) =>
      (r.textContent ?? '').slice((r.querySelector('svg')?.textContent ?? '').length)
    )
  }

  it('offers only the choices with games, after All Controls', async () => {
    expect(await open({ controlsOptions: ['controller', 'keyboard'] })).toEqual([
      'All Controls',
      'Controller',
      'Mouse and Keyboard'
    ])
  })

  it('shows only All Controls when no choice has games', async () => {
    expect(await open({ controlsOptions: [] })).toEqual(['All Controls'])
  })

  it('keeps a picked choice without games, so it can be un-picked', async () => {
    expect(await open({ controlsOptions: ['controller'], controls: ['vr'] })).toEqual([
      'All Controls',
      'VR',
      'Controller'
    ])
  })

  it('shows Touch, with its picture, once a game has touch support', async () => {
    const labels = await open({ controlsOptions: ['vr', 'controller', 'keyboard', 'touch'] })
    expect(labels).toEqual(['All Controls', 'VR', 'Controller', 'Mouse and Keyboard', 'Touch'])
    expect(
      row(controlsMenu(), 'Touch')?.querySelector('svg.controls-icon[data-controls="touch"]')
    ).not.toBeNull()
  })
})

describe('Filters > Platform (the stores, a line, then the systems)', () => {
  const platformMenu = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[role="listbox"][aria-label="Platform"]')
  const both: Start = {
    platformOptions: [
      { id: 'ps2', label: 'PS2' },
      { id: 'xbox', label: 'Xbox (console)' }
    ],
    storeOptions: [
      { id: 'steam', label: 'Steam' },
      { id: 'xbox', label: 'Xbox' }
    ]
  }
  const open = async (start: Start): Promise<HTMLElement> => {
    act(() => root.render(<Harness start={start} />))
    await click(pill())
    await click(row(filtersMenu(), 'Platform'))
    expect(platformMenu()).not.toBeNull()
    return platformMenu()!
  }
  /** The sub-menu's rows and its line, top to bottom. */
  const layout = (menu: HTMLElement): string[] =>
    [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="separator"]')].map((el) =>
      el.getAttribute('role') === 'separator' ? '---' : (el.textContent ?? '')
    )

  it('has no PC row any more', async () => {
    act(() => root.render(<Harness start={both} />))
    await click(pill())
    const labels = rowsOf(filtersMenu()).map((r) => r.textContent ?? '')
    expect(labels.some((l) => l === 'PC' || l.startsWith('PC'))).toBe(false)
    expect(labels.some((l) => l.startsWith('Platform'))).toBe(true)
  })

  it('lists All Stores and the stores, a line, then All Platforms and the systems', async () => {
    const menu = await open(both)
    expect(layout(menu)).toEqual([
      'All Stores',
      'Steam',
      'Xbox',
      '---',
      'All Platforms',
      'PS2',
      'Xbox (console)'
    ])
    // The line is not a choice (nothing to focus); the Xbox system and the Xbox store each keep their own focus key.
    const sep = menu.querySelector('[role="separator"]')!
    expect(sep.getAttribute('tabindex')).toBeNull()
    expect(sep.querySelector('[role="menuitem"]')).toBeNull()
    const sub = `${CATEGORY_KEY}:platforms`
    for (const key of ['*roms', 'ps2', 'xbox', 'store:*stores', 'store:steam', 'store:xbox'])
      expect(doesFocusableExist(`${sub}:${key}`)).toBe(true)
    expect(doesFocusableExist(`${sub}:--separator`)).toBe(false)
  })

  it('leaves out the line and the stores when there are none', async () => {
    const menu = await open({ platformOptions: both.platformOptions })
    expect(menu.querySelector('[role="separator"]')).toBeNull()
    expect(layout(menu)).toEqual(['All Platforms', 'PS2', 'Xbox (console)'])
  })

  it('a store picks the stores only, a system the systems only', async () => {
    const menu = await open(both)
    await click(rowsOf(menu).find((r) => r.textContent === 'Xbox'))
    expect(onStoresSpy).toHaveBeenLastCalledWith(['xbox'])
    expect(onPlatformsSpy).not.toHaveBeenCalled()
    await click(row(platformMenu(), 'PS2'))
    expect(onPlatformsSpy).toHaveBeenLastCalledWith(['ps2'])
    expect(onStoresSpy).toHaveBeenCalledTimes(1)
    // The Xbox store is ticked, the Xbox system is not.
    expect(
      rowsOf(platformMenu())
        .find((r) => r.textContent === 'Xbox (console)')
        ?.getAttribute('aria-selected')
    ).not.toBe('true')
    // Both parts in the row's summary.
    expect(row(filtersMenu(), 'Platform')!.textContent).toBe('PlatformXbox, PS2')
  })

  it('All Platforms and All Stores each change only their own part', async () => {
    await open({ ...both, platforms: ['ps2'], stores: ['steam'] })
    await click(row(platformMenu(), 'All Stores'))
    expect(onStoresSpy).toHaveBeenLastCalledWith(['*stores'])
    expect(onPlatformsSpy).not.toHaveBeenCalled()
    await click(row(platformMenu(), 'All Stores'))
    expect(onStoresSpy).toHaveBeenLastCalledWith([])
    await click(row(platformMenu(), 'All Platforms'))
    expect(onPlatformsSpy).toHaveBeenLastCalledWith(['*roms'])
    expect(onStoresSpy).toHaveBeenCalledTimes(2)
    expect(row(filtersMenu(), 'Platform')!.textContent).toBe('PlatformAll Platforms')
  })

  it('shows no summary with nothing picked', async () => {
    act(() => root.render(<Harness start={both} />))
    await click(pill())
    expect(row(filtersMenu(), 'Platform')!.textContent).toBe('Platform')
  })
})

describe('Filters > Custom', () => {
  const customMenu = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[role="listbox"][aria-label="Custom"]')
  const actionsMenu = (name: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[role="menu"][aria-label="${name}"]`)
  const withFilters = (): void => {
    const settings = defaultSettings()
    settings.library.customFilters = [
      { id: 'cf1', name: 'Couch', icon: 'users', gameIds: ['a', 'b'] },
      { id: 'cf2', name: 'Hard', icon: 'skull', gameIds: ['c'] }
    ]
    useSettingsStore.setState({ settings })
  }

  it('is not offered while the user has no filter', async () => {
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    expect(row(filtersMenu(), 'Custom')).toBeUndefined()
  })

  it('lists All Custom, then each filter with its icon in its colour and its count', async () => {
    withFilters()
    act(() => root.render(<Harness start={{ customCounts: new Map([['cf1', 7]]) }} />))
    await click(pill())
    const labels = rowsOf(filtersMenu()).map((r) => r.textContent ?? '')
    // In alphabetical order: after Controls, before Difficulty.
    expect(labels.indexOf('Custom')).toBe(labels.indexOf('Controls') + 1)
    expect(labels[labels.indexOf('Custom') + 1]).toBe('Difficulty')
    await click(row(filtersMenu(), 'Custom'))
    const rows = rowsOf(customMenu())
    expect(rows.map((r) => r.textContent)).toEqual(['All Custom', 'Couch7', 'Hard1'])
    const icon = rows[1]!.querySelector<SVGElement>('svg.lucide-users')
    expect(icon).toBeTruthy()
    expect(icon!.style.color).not.toBe('')
    expect(rows[2]!.querySelector('svg.lucide-skull')).toBeTruthy()
  })

  it('picks filters like the other sub-menus: row text, pill count, All Custom clears', async () => {
    withFilters()
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    await click(row(filtersMenu(), 'Custom'))
    await click(row(customMenu(), 'Couch'))
    expect(onCustomSpy).toHaveBeenLastCalledWith(['cf1'])
    expect(pill().textContent).toContain('Filters (1)')
    expect(row(filtersMenu(), 'Custom')!.textContent).toBe('CustomCouch')
    await click(row(customMenu(), 'Hard'))
    expect(onCustomSpy).toHaveBeenLastCalledWith(['cf1', 'cf2'])
    expect(row(filtersMenu(), 'Custom')!.textContent).toBe('CustomCouch +1')
    await click(row(customMenu(), 'Couch'))
    expect(onCustomSpy).toHaveBeenLastCalledWith(['cf2'])
    await click(row(customMenu(), 'All Custom'))
    expect(onCustomSpy).toHaveBeenLastCalledWith([])
    expect(pill().textContent).not.toContain('(')
  })

  it('ignores a picked id with no filter here (another PC’s tab)', async () => {
    withFilters()
    act(() => root.render(<Harness start={{ custom: ['elsewhere'] }} />))
    expect(pill().textContent).not.toContain('(')
  })

  it('Clear filters turns it off', async () => {
    withFilters()
    act(() => root.render(<Harness start={{ custom: ['cf1', 'cf2'] }} />))
    expect(pill().textContent).toContain('Filters (2)')
    await click(pill())
    await click(row(filtersMenu(), 'Clear filters'))
    expect(onClearFilters).toHaveBeenCalledTimes(1)
    expect(pill().textContent).not.toContain('(')
  })

  it('a right click on a filter shows Rename, Change icon and Delete; Delete asks first', async () => {
    withFilters()
    const openModal = vi.spyOn(useUiStore.getState(), 'openModal')
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    await click(row(filtersMenu(), 'Custom'))
    act(() => {
      row(customMenu(), 'Hard')!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      )
    })
    await settle()
    expect(rowsOf(actionsMenu('Hard')).map((r) => r.textContent)).toEqual([
      'Rename',
      'Change icon',
      'Delete'
    ])
    await click(row(actionsMenu('Hard'), 'Delete'))
    // The Filters menu closes and the question opens.
    expect(filtersMenu()).toBeNull()
    expect(openModal).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'confirm', title: 'Delete Hard?', danger: true })
    )
    openModal.mockRestore()
  })

  it('Rename and Change icon open the filter’s dialog', async () => {
    withFilters()
    const openModal = vi.spyOn(useUiStore.getState(), 'openModal')
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    await click(row(filtersMenu(), 'Custom'))
    act(() => {
      row(customMenu(), 'Couch')!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      )
    })
    await settle()
    await click(row(actionsMenu('Couch'), 'Change icon'))
    expect(openModal).toHaveBeenCalledWith({
      type: 'custom-filter',
      filterId: 'cf1',
      focus: 'icon'
    })
    openModal.mockRestore()
  })
})

describe('Filters menu order', () => {
  it('lists Clear filters first, the sub-menu rows A to Z, then Hidden, Favorites and Recompilations', async () => {
    act(() => root.render(<Harness start={{}} />))
    await click(pill())
    const labels = rowsOf(filtersMenu()).map((r) => r.textContent ?? '')
    const bottom = ['Hidden', 'Favorites', 'Recompilations']
    const tail = labels.slice(-3).map((l) => bottom.find((b) => l.startsWith(b)))
    expect(tail).toEqual(bottom)
    const rows = labels.slice(0, -3).filter((l) => !l.startsWith('Clear'))
    const names = rows.map((l) =>
      l.replace(/(Multiplayer - (Local|Online)|H\.L\.T\.B\.|[A-Z][a-z]+).*/, '$1')
    )
    const plain = (s: string): string => s.replace(/[^A-Za-z0-9\s-]/g, '')
    expect(names).toEqual(
      [...names].sort((a, b) => plain(a).localeCompare(plain(b), 'en', { sensitivity: 'base' }))
    )
    expect(names).toContain('Multiplayer - Local')
    expect(names).toContain('Multiplayer - Online')
  })
})
