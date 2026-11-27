// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Game } from '@shared/types'
import type { WebViewerState } from '@shared/web-viewer'

/**
 * The Steam links grid right of the feature grid: Store, Workshop, PCGamingWiki and Guides in that order, Steam games
 * only, an empty Workshop square unless Steam said the game has one (not known: the page asks main), and the in-app
 * web viewer a square opens.
 */

const listeners = new Map<string, Set<(payload: unknown) => void>>()
const api = {
  on: vi.fn((event: string, listener: (payload: unknown) => void) => {
    const set = listeners.get(event) ?? new Set()
    set.add(listener)
    listeners.set(event, set)
    return () => set.delete(listener)
  }),
  openWebViewer: vi.fn(async (kind: string): Promise<WebViewerState> => ({
    open: true,
    kind: kind as WebViewerState['kind'],
    canGoBack: false,
    canGoForward: false,
    loading: false
  })),
  closeWebViewer: vi.fn(async () => undefined),
  webViewerAction: vi.fn<(action: string) => Promise<void>>(async () => undefined),
  scrollWebViewer: vi.fn<(deltaY: number) => Promise<void>>(async () => undefined),
  setWebViewerBounds: vi.fn(async () => undefined),
  setWebViewerVisible: vi.fn<(visible: boolean) => Promise<void>>(async () => undefined),
  steamWorkshopCheck: vi.fn<(gameId: string) => Promise<boolean | null>>(async () => null)
}
const emit = (event: string, payload: unknown): void => {
  for (const l of listeners.get(event) ?? []) l(payload)
}

vi.mock('../../api/client', () => ({ api, isMock: false }))

const { dispatchAction, getCurrentFocusKey, initFocus, popLayer, pushLayer, setFocus } =
  await import('../../input')
const { SteamLinksGrid } = await import('./SteamLinksGrid')
const { STEAM_LINK_FOCUS, presentSteamLinks, steamLinksOf } = await import('./steamLinks')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined
  initFocus()
})

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  listeners.clear()
  for (const fn of Object.values(api)) fn.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const steamGame = (over: Partial<Game> = {}): Game =>
  ({
    id: 'steam:620',
    source: 'steam',
    externalId: '620',
    title: 'Portal 2',
    // Steam said the app has a Workshop: all four squares.
    metadata: { steamTags: { tags: [], workshop: true } },
    ...over
  }) as Game

function render(game: Game): HTMLElement | null {
  act(() => root.render(<SteamLinksGrid game={game} />))
  return host.querySelector<HTMLElement>('.gdetail__steam-links')
}

function cells(grid: HTMLElement): string[] {
  return [...grid.children].map((el) =>
    el.classList.contains('gdetail__features-empty')
      ? 'empty'
      : (el.className.match(/gdetail__steam-link--(\w+)/)?.[1] ?? el.className)
  )
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('steamLinksOf', () => {
  it('is for Steam games only, Workshop only when Steam says there is one', () => {
    expect(steamLinksOf(steamGame())).toEqual({
      appId: 620,
      kinds: ['store', 'workshop', 'pcgamingwiki', 'guides']
    })
    expect(
      steamLinksOf(steamGame({ metadata: { steamTags: { tags: [], workshop: false } } }))?.kinds
    ).toEqual(['store', 'pcgamingwiki', 'guides'])
    // Not known yet: left out too.
    expect(steamLinksOf(steamGame({ metadata: {} }))?.kinds).toEqual([
      'store',
      'pcgamingwiki',
      'guides'
    ])
    expect(presentSteamLinks(steamGame({ metadata: { steamTags: { tags: ['Action'] } } }))).toBe(
      'store|pcgamingwiki|guides'
    )
    expect(steamLinksOf(steamGame({ source: 'gog', extra: { steamAppId: 620 } }))).toBeNull()
    expect(presentSteamLinks(steamGame({ source: 'rom', externalId: 'x.sfc' }))).toBe('')
  })
})

describe('SteamLinksGrid', () => {
  it('shows Store, Workshop, PCGamingWiki and Guides in that order, with names', () => {
    const grid = render(steamGame())!
    expect(cells(grid)).toEqual(['store', 'workshop', 'pcgamingwiki', 'guides'])
    expect(grid.classList.contains('gdetail__features')).toBe(true)
    for (const button of grid.querySelectorAll('button')) {
      expect(button.getAttribute('aria-label')).toBeTruthy()
      expect(button.getAttribute('title')).toBeTruthy()
    }
  })

  it('leaves the Workshop square empty when the game has none, and asks nothing', () => {
    const grid = render(steamGame({ metadata: { steamTags: { tags: [], workshop: false } } }))!
    expect(cells(grid)).toEqual(['store', 'empty', 'pcgamingwiki', 'guides'])
    expect(grid.querySelector('.gdetail__features-empty')?.getAttribute('aria-hidden')).toBe('true')
    expect(api.steamWorkshopCheck).not.toHaveBeenCalled()
  })

  it('asks nothing when the game has a Workshop', () => {
    render(steamGame())
    expect(api.steamWorkshopCheck).not.toHaveBeenCalled()
  })

  it('leaves the square empty while not known, asks main once, and shows it when Steam says yes', async () => {
    const unknown = steamGame({ metadata: { steamTags: { tags: ['Action'] } } })
    const grid = render(unknown)!
    expect(cells(grid)).toEqual(['store', 'empty', 'pcgamingwiki', 'guides'])
    await flush()
    expect(api.steamWorkshopCheck.mock.calls).toEqual([['steam:620']])
    // The same game again (another update of it): not asked again.
    render({ ...unknown, title: 'Portal 2 (again)' })
    await flush()
    expect(api.steamWorkshopCheck).toHaveBeenCalledTimes(1)
    // The answer arrives as the game's own update.
    render(steamGame({ metadata: { steamTags: { tags: ['Action'], workshop: true } } }))
    expect(cells(grid)).toEqual(['store', 'workshop', 'pcgamingwiki', 'guides'])
    expect(api.steamWorkshopCheck).toHaveBeenCalledTimes(1)
  })

  it('stays empty when main has no answer (the request failed)', async () => {
    api.steamWorkshopCheck.mockRejectedValueOnce(new Error('offline'))
    const grid = render(steamGame({ metadata: {} }))!
    await flush()
    expect(api.steamWorkshopCheck).toHaveBeenCalledTimes(1)
    expect(cells(grid)).toEqual(['store', 'empty', 'pcgamingwiki', 'guides'])
  })

  it('asks nothing for a game that is not a Steam game', async () => {
    render(steamGame({ source: 'epic', externalId: 'abc', metadata: {} }))
    await flush()
    expect(api.steamWorkshopCheck).not.toHaveBeenCalled()
  })

  it('shows nothing for a game that is not a Steam game', () => {
    expect(render(steamGame({ source: 'epic', externalId: 'abc' }))).toBeNull()
    expect(host.innerHTML).toBe('')
  })

  it('enters the grid on its first square', async () => {
    render(steamGame())
    await act(async () => {
      setFocus(STEAM_LINK_FOCUS.links)
      await Promise.resolve()
    })
    expect(getCurrentFocusKey()).toBe(STEAM_LINK_FOCUS.store)
  })

  it('opens the link in the viewer, drives it with the controller and closes it', async () => {
    const grid = render(steamGame())!
    act(() => grid.querySelector<HTMLButtonElement>('.gdetail__steam-link--guides')!.click())
    await flush()
    expect(api.openWebViewer).toHaveBeenCalledWith('guides', 620)
    expect(document.querySelector('.web-viewer')).not.toBeNull()
    expect(api.setWebViewerBounds).toHaveBeenCalled()

    act(() => {
      dispatchAction('lb', 'gamepad')
      dispatchAction('rb', 'gamepad')
      dispatchAction('section-next', 'gamepad')
      dispatchAction('rs-up', 'gamepad')
    })
    expect(api.webViewerAction.mock.calls).toEqual([['back'], ['forward']])
    expect(api.scrollWebViewer.mock.calls[0][0]).toBeGreaterThan(0)
    expect(api.scrollWebViewer.mock.calls[1][0]).toBeLessThan(0)

    // B on a page with history goes back; on the first page it closes the viewer.
    act(() =>
      emit('web-viewer:state', {
        open: true,
        kind: 'guides',
        canGoBack: true,
        canGoForward: false,
        loading: false
      })
    )
    act(() => {
      dispatchAction('back', 'gamepad')
    })
    expect(api.webViewerAction.mock.calls.at(-1)).toEqual(['back'])
    expect(document.querySelector('.web-viewer')).not.toBeNull()
    act(() =>
      emit('web-viewer:state', {
        open: true,
        kind: 'guides',
        canGoBack: false,
        canGoForward: true,
        loading: false
      })
    )
    act(() => {
      dispatchAction('back', 'gamepad')
    })
    await flush()
    expect(api.closeWebViewer).toHaveBeenCalled()
  })

  it('closes when main closes the page (a game started)', async () => {
    const grid = render(steamGame())!
    act(() => grid.querySelector<HTMLButtonElement>('.gdetail__steam-link--store')!.click())
    await flush()
    expect(document.querySelector('.web-viewer')).not.toBeNull()
    act(() =>
      emit('web-viewer:state', {
        open: false,
        canGoBack: false,
        canGoForward: false,
        loading: false
      })
    )
    await flush()
    expect(api.closeWebViewer).toHaveBeenCalled()
    expect(grid.querySelector('.gdetail__feature--open')).toBeNull()
  })

  it('hides the page while something else is on top of the viewer, and shows it again', async () => {
    const grid = render(steamGame())!
    act(() => grid.querySelector<HTMLButtonElement>('.gdetail__steam-link--store')!.click())
    await flush()
    expect(api.setWebViewerVisible.mock.calls.at(-1)).toEqual([true])
    // The system bar's Quick panel (or a dialog that opened by itself) pushes its own layer.
    act(() => pushLayer('quick-panel'))
    expect(api.setWebViewerVisible.mock.calls.at(-1)).toEqual([false])
    act(() => popLayer('quick-panel'))
    expect(api.setWebViewerVisible.mock.calls.at(-1)).toEqual([true])
  })

  it("shows its own button hints instead of the game page's", async () => {
    const grid = render(steamGame())!
    act(() => grid.querySelector<HTMLButtonElement>('.gdetail__steam-link--store')!.click())
    await flush()
    const hints = document.querySelector('.hints--web-viewer')
    expect(hints?.textContent).toContain('Reload')
    expect(hints?.textContent).toContain('Open in browser')
    expect(document.querySelector('.web-viewer__hints')).toBeNull()
  })

  it('offers a link the page asked for without a click, opened only on request', async () => {
    const grid = render(steamGame())!
    act(() => grid.querySelector<HTMLButtonElement>('.gdetail__steam-link--store')!.click())
    await flush()
    expect(document.querySelector('.web-viewer__held')).toBeNull()
    act(() =>
      emit('web-viewer:state', {
        open: true,
        kind: 'store',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        held: { url: 'https://example.com/', host: 'example.com' }
      })
    )
    const held = document.querySelector('.web-viewer__held')
    expect(held?.textContent).toContain('example.com')
    expect(api.webViewerAction).not.toHaveBeenCalled()
    const [open, dismiss] = held!.querySelectorAll('button')
    act(() => open.click())
    act(() => dismiss.click())
    expect(api.webViewerAction.mock.calls).toEqual([['open-link'], ['dismiss-link']])
  })
})
