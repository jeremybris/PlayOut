import { EventEmitter } from 'events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { WebViewerState } from '../../shared/web-viewer'
import {
  createWebViewer,
  GESTURE_WINDOW_MS,
  OUTSIDE_THROTTLE_MS,
  WEB_VIEWER_PARTITION,
  type ViewerContents,
  type ViewerElectron,
  type ViewerView
} from './viewer'

class FakeContents extends EventEmitter {
  url = ''
  title = ''
  loading = false
  closed = false
  history: string[] = []
  at = -1
  openHandler: ((d: { url: string }) => { action: 'deny' }) | null = null
  scripts: string[] = []
  loadURL = vi.fn(async (url: string) => {
    this.history = [...this.history.slice(0, this.at + 1), url]
    this.at = this.history.length - 1
    this.url = url
  })
  getURL = (): string => this.url
  getTitle = (): string => this.title
  isLoading = (): boolean => this.loading
  reload = vi.fn()
  focus = vi.fn()
  close = vi.fn(() => {
    this.closed = true
  })
  isDestroyed = (): boolean => this.closed
  navigationHistory = {
    canGoBack: (): boolean => this.at > 0,
    canGoForward: (): boolean => this.at < this.history.length - 1,
    goBack: vi.fn(() => {
      this.at--
      this.url = this.history[this.at]
    }),
    goForward: vi.fn(() => {
      this.at++
      this.url = this.history[this.at]
    })
  }
  setWindowOpenHandler(handler: (d: { url: string }) => { action: 'deny' }): void {
    this.openHandler = handler
  }
  executeJavaScriptInIsolatedWorld = vi.fn(async (_world: number, scripts: { code: string }[]) => {
    this.scripts.push(...scripts.map((s) => s.code))
  })
}

type FakeView = Omit<ViewerView, 'webContents' | 'setVisible'> & {
  webContents: FakeContents
  bounds?: unknown
  setVisible: ReturnType<typeof vi.fn>
}

interface Fixture {
  viewer: ReturnType<typeof createWebViewer>
  views: FakeView[]
  electron: {
    openExternal: ReturnType<typeof vi.fn>
    attach: ReturnType<typeof vi.fn>
    detach: ReturnType<typeof vi.fn>
  }
  states: WebViewerState[]
  download: () => (url: string) => void
  /** The fake clock (ms). */
  clock: { now: number }
  focusWindow: ReturnType<typeof vi.fn>
}

function setup(): Fixture {
  const views: FakeView[] = []
  let onDownload: (url: string) => void = () => undefined
  const electron = {
    createView: vi.fn((partition: string) => {
      expect(partition).toBe(WEB_VIEWER_PARTITION)
      const view: FakeView = {
        webContents: new FakeContents(),
        setBounds(b: unknown) {
          view.bounds = b
        },
        setBackgroundColor: vi.fn(),
        setVisible: vi.fn()
      }
      views.push(view)
      return view as unknown as ViewerView
    }),
    prepareSession: vi.fn((_p: string, cb: (url: string) => void) => {
      onDownload = cb
    }),
    attach: vi.fn(),
    detach: vi.fn(),
    openExternal: vi.fn(async () => undefined)
  }
  const focusWindow = vi.fn()
  const win = {
    isDestroyed: () => false,
    webContents: { getZoomFactor: () => 1.5, focus: focusWindow }
  } as unknown as BrowserWindow
  const clock = { now: 100_000 }
  const states: WebViewerState[] = []
  const viewer = createWebViewer({
    window: () => win,
    emit: (s) => states.push(s),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    electron: async () => electron as unknown as ViewerElectron,
    now: () => clock.now
  })
  return { viewer, views, electron, states, download: () => onDownload, clock, focusWindow }
}

const navEvent = (
  details: { isMainFrame?: boolean } = {}
): { preventDefault: ReturnType<typeof vi.fn>; isMainFrame?: boolean } => ({
  preventDefault: vi.fn(),
  ...details
})

/** The user clicks in the page (a link elsewhere may then open in the default browser). */
const click = (wc: FakeContents): void => {
  wc.emit('before-mouse-event', navEvent(), { type: 'mouseDown', button: 'left', x: 1, y: 1 })
  wc.emit('before-mouse-event', navEvent(), { type: 'mouseUp', button: 'left', x: 1, y: 1 })
}

describe('createWebViewer', () => {
  it('opens the link in a view on its own partition, placed by the zoom factor', async () => {
    const { viewer, views, electron, states } = setup()
    viewer.setBounds({ x: 10, y: 20, width: 100, height: 50 })
    const state = await viewer.open('workshop', 620)
    expect(views).toHaveLength(1)
    expect(views[0].webContents.loadURL).toHaveBeenCalledWith(
      'https://steamcommunity.com/app/620/workshop/'
    )
    expect(electron.attach).toHaveBeenCalledTimes(1)
    expect(views[0].bounds).toEqual({ x: 15, y: 30, width: 150, height: 75 })
    expect(state).toMatchObject({ open: true, kind: 'workshop', host: 'steamcommunity.com' })
    expect(states.at(-1)?.open).toBe(true)
  })

  it('keeps navigations on the allowed sites and sends others to the default browser', async () => {
    const { viewer, views, electron } = setup()
    await viewer.open('store', 620)
    const wc = views[0].webContents
    const ok = navEvent()
    wc.emit('will-navigate', ok, 'https://steamcommunity.com/app/620/guides/')
    expect(ok.preventDefault).not.toHaveBeenCalled()
    const away = navEvent()
    click(wc)
    wc.emit('will-navigate', away, 'https://steamcommunity.com.evil.com/')
    expect(away.preventDefault).toHaveBeenCalled()
    expect(electron.openExternal).toHaveBeenCalledWith('https://steamcommunity.com.evil.com/')
    const script = navEvent()
    wc.emit('will-redirect', script, 'javascript:alert(1)')
    expect(script.preventDefault).toHaveBeenCalled()
    expect(electron.openExternal).toHaveBeenCalledTimes(1)
  })

  it('never opens a pop-up: allowed links load in the view, others go outside, the rest nowhere', async () => {
    const { viewer, views, electron } = setup()
    await viewer.open('store', 620)
    const wc = views[0].webContents
    expect(wc.openHandler?.({ url: 'https://www.pcgamingwiki.com/wiki/Portal_2' })).toEqual({
      action: 'deny'
    })
    expect(wc.loadURL).toHaveBeenLastCalledWith('https://www.pcgamingwiki.com/wiki/Portal_2')
    click(wc)
    expect(wc.openHandler?.({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    expect(electron.openExternal).toHaveBeenCalledWith('https://example.com/')
    expect(wc.openHandler?.({ url: 'data:text/html,hi' })).toEqual({ action: 'deny' })
    expect(electron.openExternal).toHaveBeenCalledTimes(1)
  })

  it('sends downloads to the default browser (http(s) only)', async () => {
    const { viewer, views, electron, download } = setup()
    await viewer.open('store', 620)
    click(views[0].webContents)
    download()('https://cdn.example.com/file.zip')
    download()('file:///C:/x')
    expect(electron.openExternal.mock.calls).toEqual([['https://cdn.example.com/file.zip']])
  })

  it('goes back, forward, reloads, scrolls and opens the page outside', async () => {
    const { viewer, views, electron } = setup()
    await viewer.open('store', 620)
    const wc = views[0].webContents
    wc.openHandler?.({ url: 'https://store.steampowered.com/news/app/620' })
    await viewer.action('back')
    expect(wc.url).toBe('https://store.steampowered.com/app/620/')
    await viewer.action('forward')
    expect(wc.url).toBe('https://store.steampowered.com/news/app/620')
    await viewer.action('reload')
    expect(wc.reload).toHaveBeenCalled()
    await viewer.action('external')
    expect(electron.openExternal).toHaveBeenCalledWith(
      'https://store.steampowered.com/news/app/620'
    )
    await viewer.scroll(240.6)
    await viewer.scroll(0)
    expect(wc.scripts).toEqual(["window.scrollBy({ top: 241, left: 0, behavior: 'smooth' })"])
  })

  it('Escape in the page goes back, then closes; closing detaches and tells the renderer', async () => {
    const { viewer, views, electron, states } = setup()
    await viewer.open('guides', 620)
    const wc = views[0].webContents
    wc.openHandler?.({ url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=1' })
    const esc = navEvent()
    wc.emit('before-input-event', esc, { type: 'keyDown', key: 'Escape' })
    expect(esc.preventDefault).toHaveBeenCalled()
    expect(wc.url).toBe('https://steamcommunity.com/app/620/guides/')
    wc.emit('before-input-event', navEvent(), { type: 'keyDown', key: 'Escape' })
    expect(wc.close).toHaveBeenCalled()
    expect(electron.detach).toHaveBeenCalled()
    expect(states.at(-1)).toMatchObject({ open: false })
    expect(viewer.state().open).toBe(false)
  })

  it('replaces an open page without reporting it closed', async () => {
    const { viewer, views, states } = setup()
    await viewer.open('store', 620)
    await viewer.open('guides', 620)
    expect(views[0].webContents.close).toHaveBeenCalled()
    expect(states.every((s) => s.open)).toBe(true)
    // Events of the replaced page are ignored.
    const before = states.length
    views[0].webContents.emit('did-stop-loading')
    expect(states).toHaveLength(before)
  })

  it('reports a page that failed to load', async () => {
    const { viewer, views, states } = setup()
    await viewer.open('pcgamingwiki', 620)
    views[0].webContents.emit('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', 'x', true)
    expect(states.at(-1)).toMatchObject({ open: true, failed: true })
  })

  it("lets an iframe's redirects load and never opens them outside", async () => {
    const { viewer, views, electron } = setup()
    await viewer.open('pcgamingwiki', 620)
    const wc = views[0].webContents
    click(wc)
    // The details object (Electron 25+) and the older positional flag both say "not the main frame".
    const ad = navEvent({ isMainFrame: false })
    wc.emit('will-redirect', ad, 'https://ads.example.com/landing', false, false)
    const embed = navEvent()
    wc.emit('will-redirect', embed, 'https://tracker.example.com/', false, false)
    expect(ad.preventDefault).not.toHaveBeenCalled()
    expect(embed.preventDefault).not.toHaveBeenCalled()
    expect(electron.openExternal).not.toHaveBeenCalled()
    // A main-frame redirect elsewhere is still stopped (and opened outside after the click).
    const main = navEvent({ isMainFrame: true })
    wc.emit('will-redirect', main, 'https://example.com/', false, true)
    expect(main.preventDefault).toHaveBeenCalled()
    expect(electron.openExternal.mock.calls).toEqual([['https://example.com/']])
  })

  it("never opens the default browser by itself: a script's pop-up, navigation or download is held", async () => {
    const { viewer, views, electron, states, download } = setup()
    await viewer.open('store', 620)
    const wc = views[0].webContents
    // No click in the page: window.open, location.href = ... and an automatic download.
    expect(wc.openHandler?.({ url: 'https://popup.example.com/' })).toEqual({ action: 'deny' })
    const nav = navEvent({ isMainFrame: true })
    wc.emit('will-navigate', nav, 'https://nav.example.com/')
    expect(nav.preventDefault).toHaveBeenCalled()
    download()('https://cdn.example.com/x.exe')
    expect(electron.openExternal).not.toHaveBeenCalled()
    // The last one is offered in the bar; the user opens it (or drops it) from PlayOut's own buttons.
    expect(states.at(-1)?.held).toEqual({
      url: 'https://cdn.example.com/x.exe',
      host: 'cdn.example.com'
    })
    await viewer.action('open-link')
    expect(electron.openExternal.mock.calls).toEqual([['https://cdn.example.com/x.exe']])
    expect(states.at(-1)?.held).toBeUndefined()
    wc.openHandler?.({ url: 'https://popup.example.com/' })
    expect(states.at(-1)?.held?.host).toBe('popup.example.com')
    await viewer.action('dismiss-link')
    expect(states.at(-1)?.held).toBeUndefined()
    expect(electron.openExternal).toHaveBeenCalledTimes(1)
  })

  it('opens one page per click, at most one every few seconds, and not long after the click', async () => {
    const { viewer, views, electron, clock, states } = setup()
    await viewer.open('store', 620)
    const wc = views[0].webContents
    click(wc)
    wc.openHandler?.({ url: 'https://a.example.com/' })
    // The same click cannot open a second one.
    wc.openHandler?.({ url: 'https://b.example.com/' })
    expect(electron.openExternal.mock.calls).toEqual([['https://a.example.com/']])
    expect(states.at(-1)?.held?.host).toBe('b.example.com')
    // A new click right away: still within the throttle.
    clock.now += 500
    click(wc)
    wc.openHandler?.({ url: 'https://c.example.com/' })
    expect(electron.openExternal).toHaveBeenCalledTimes(1)
    // Later, a click long ago does not count.
    clock.now += OUTSIDE_THROTTLE_MS
    click(wc)
    clock.now += GESTURE_WINDOW_MS + 1
    wc.openHandler?.({ url: 'https://d.example.com/' })
    expect(electron.openExternal).toHaveBeenCalledTimes(1)
    // A key press in the page counts like a click.
    wc.emit('before-input-event', navEvent(), { type: 'keyDown', key: 'Enter' })
    wc.openHandler?.({ url: 'https://e.example.com/' })
    expect(electron.openExternal.mock.calls.at(-1)).toEqual(['https://e.example.com/'])
  })

  it('hands the default browser the checked, canonical address', async () => {
    const { viewer, views, electron } = setup()
    await viewer.open('store', 620)
    const wc = views[0].webContents
    click(wc)
    wc.openHandler?.({ url: 'HTTPS://Example.COM/a b' })
    expect(electron.openExternal.mock.calls).toEqual([['https://example.com/a%20b']])
  })

  it('hides the page while PlayOut shows something over it, and gives the window the keyboard', async () => {
    const { viewer, views, focusWindow } = setup()
    viewer.setVisible(false)
    await viewer.open('store', 620)
    expect(views[0].setVisible).toHaveBeenLastCalledWith(false)
    viewer.setVisible(true)
    expect(views[0].setVisible).toHaveBeenLastCalledWith(true)
    focusWindow.mockClear()
    viewer.setVisible(false)
    expect(views[0].setVisible).toHaveBeenLastCalledWith(false)
    expect(focusWindow).toHaveBeenCalled()
  })

  it('refuses an address it did not build', async () => {
    const { viewer } = setup()
    await expect(viewer.open('store', -1)).rejects.toThrow()
  })
})

// The fake stays a ViewerContents (kept in step with the interface).
const typed: ViewerContents = new FakeContents() as unknown as ViewerContents
void typed
