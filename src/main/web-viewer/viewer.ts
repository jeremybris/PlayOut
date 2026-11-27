// The in-app web viewer (docs/ARCHITECTURE.md "Web viewer"): the game page's Steam links (Store, Workshop,
// PCGamingWiki, Guides) shown inside PlayOut's main window, so the user does not leave PlayOut. The page is a
// WebContentsView laid over the area the renderer's viewer leaves for it (setBounds), under the renderer's own top
// bar (title, Back, Forward, Reload, Open in browser, Close).
//
// Security: its own in-memory partition (`web-viewer`, apart from PlayOut's and the store sign-in windows'; nothing
// the sites or their trackers store outlives PlayOut, and nobody signs in there), sandboxed, context-isolated, no
// Node, no preload (so no `window.playout` and no PlayOut IPC; the IPC layer also refuses every frame but the app's
// own document), web security on. Main-frame navigations stay on the Steam store, the Steam community and
// PCGamingWiki (allow.ts); sub-frames load as in a browser (like images and scripts, they are not host-filtered and
// never leave the page). Any other http(s) link, a new window to one, and a download go to the user's default
// browser only right after the user clicked or typed in the page (once per click, at most one every few seconds);
// otherwise the bar offers it (`held`) and nothing opens by itself. Everything else is blocked. Permission and device
// requests (camera, notifications, HID, USB, serial, Bluetooth, screen capture) are denied. Electron is imported
// lazily so the module is tested outside Electron.
import type { BrowserWindow, Event as ElectronEvent, Input, MouseInputEvent } from 'electron'
import {
  CLOSED_WEB_VIEWER,
  steamLinkUrl,
  type SteamLinkKind,
  type WebViewerAction,
  type WebViewerBounds,
  type WebViewerState
} from '../../shared/web-viewer'
import type { Logger } from '../logger'
import { redactUrl } from '../scrapers/http'
import { clampScroll, externalHref, hostOf, webViewerDecision } from './allow'

/** In memory (no `persist:`): cookies, storage and cache go with PlayOut. */
export const WEB_VIEWER_PARTITION = 'web-viewer'

/** How long after a click or key press in the page a link elsewhere counts as the user's (ms). */
export const GESTURE_WINDOW_MS = 1500
/** At most one default-browser launch the page asked for in this long (ms). */
export const OUTSIDE_THROTTLE_MS = 3000

/** The parts of a WebContents the viewer uses (a fake in tests). */
export interface ViewerContents {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  reload(): void
  focus(): void
  close(): void
  isDestroyed(): boolean
  navigationHistory: {
    canGoBack(): boolean
    canGoForward(): boolean
    goBack(): void
    goForward(): void
  }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  executeJavaScriptInIsolatedWorld(
    worldId: number,
    scripts: { code: string }[],
    userGesture?: boolean
  ): Promise<unknown>
  on(event: string, listener: (...args: never[]) => void): unknown
}

export interface ViewerView {
  webContents: ViewerContents
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
  setBackgroundColor(color: string): void
  setVisible(visible: boolean): void
}

/** The Electron pieces the viewer needs (tests: fakes). */
export interface ViewerElectron {
  createView(partition: string): ViewerView
  /** Configure the partition once: deny permissions and devices, hand downloads to `onDownload`. */
  prepareSession(partition: string, onDownload: (url: string) => void): void
  attach(win: BrowserWindow, view: ViewerView): void
  detach(win: BrowserWindow, view: ViewerView): void
  openExternal(url: string): Promise<void>
}

export interface WebViewerDeps {
  /** PlayOut's main window (the viewer lives inside it). */
  window: () => BrowserWindow | null
  /** Sends every state change to the renderer (event 'web-viewer:state'). */
  emit: (state: WebViewerState) => void
  log: Logger
  /** Tests. */
  electron?: () => Promise<ViewerElectron>
  now?: () => number
}

export interface WebViewer {
  /** Show one of a Steam app's links (a link already shown is replaced). */
  open(kind: SteamLinkKind, appId: number): Promise<WebViewerState>
  close(): void
  action(action: WebViewerAction): Promise<void>
  /** Scroll the page by `deltaY` CSS pixels (down positive): the controller's D-pad and right stick. */
  scroll(deltaY: number): Promise<void>
  /** Where the page sits, in the renderer's CSS pixels (scaled by the renderer's zoom factor here). */
  setBounds(bounds: WebViewerBounds): void
  /**
   * Show or hide the page: the renderer hides it while something of PlayOut's sits over the viewer (the Quick panel, a
   * dialog), since nothing PlayOut draws can cover the native view. Hiding gives PlayOut's window the keyboard back.
   */
  setVisible(visible: boolean): void
  state(): WebViewerState
}

/** The isolated world the scroll script runs in (the page's own scripts cannot see or replace it). */
const SCROLL_WORLD = 1077

async function realElectron(): Promise<ViewerElectron> {
  const { WebContentsView, session, shell } = await import('electron')
  const prepared = new Set<string>()
  return {
    createView(partition) {
      return new WebContentsView({
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          safeDialogs: true,
          spellcheck: false,
          devTools: false
        }
      }) as unknown as ViewerView
    },
    prepareSession(partition, onDownload) {
      if (prepared.has(partition)) return
      prepared.add(partition)
      const ses = session.fromPartition(partition)
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
      ses.setPermissionCheckHandler(() => false)
      // No devices and no screen capture: every chooser is cancelled, every device check refused.
      ses.setDevicePermissionHandler(() => false)
      ses.on('select-hid-device', (event, _details, callback) => {
        event.preventDefault()
        callback()
      })
      ses.on('select-usb-device', (event, _details, callback) => {
        event.preventDefault()
        callback()
      })
      ses.on('select-serial-port', (event, _ports, _wc, callback) => {
        event.preventDefault()
        callback('')
      })
      ses.setDisplayMediaRequestHandler((_request, callback) => {
        try {
          callback(null)
        } catch {
          /* the frame is gone: nothing was granted */
        }
      })
      ses.on('will-download', (event, item) => {
        event.preventDefault()
        onDownload(item.getURL())
      })
    },
    attach(win, view) {
      win.contentView.addChildView(view as unknown as Electron.View)
    },
    detach(win, view) {
      if (!win.isDestroyed()) win.contentView.removeChildView(view as unknown as Electron.View)
    },
    openExternal: (url) => shell.openExternal(url)
  }
}

export function createWebViewer(deps: WebViewerDeps): WebViewer {
  const { log } = deps
  const loadElectron = deps.electron ?? realElectron
  const now = deps.now ?? Date.now
  let electron: ViewerElectron | null = null
  let view: ViewerView | null = null
  let host: BrowserWindow | null = null
  let kind: SteamLinkKind | undefined
  let failed = false
  let bounds: WebViewerBounds | null = null
  let visible = true
  let current: WebViewerState = CLOSED_WEB_VIEWER
  // The user's last click or key press in the page, and the last default-browser launch the page asked for.
  let gestureAt = Number.NEGATIVE_INFINITY
  let outsideAt = Number.NEGATIVE_INFINITY
  // A link elsewhere the page asked for without the user: offered in the bar, never opened by itself.
  let held: { url: string; host: string } | undefined
  // Each open counts up: events of a view closed meanwhile are ignored.
  let generation = 0

  function snapshot(): WebViewerState {
    const wc = view?.webContents
    if (!view || !wc || wc.isDestroyed()) return CLOSED_WEB_VIEWER
    const url = wc.getURL()
    return {
      open: true,
      ...(kind ? { kind } : {}),
      ...(url ? { url, host: hostOf(url) } : {}),
      ...(wc.getTitle() ? { title: wc.getTitle() } : {}),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
      ...(failed ? { failed: true } : {}),
      ...(held ? { held } : {})
    }
  }

  function publish(): void {
    current = snapshot()
    deps.emit(current)
  }

  function launch(href: string): void {
    electron?.openExternal(href).catch((err) => log.warn('web viewer: openExternal failed', err))
  }

  /**
   * A link the page wants elsewhere (a navigation, a new window, a download): the default browser gets the canonical
   * http(s) address (externalHref), and only right after the user clicked or typed in the page, once per gesture and
   * at most one every OUTSIDE_THROTTLE_MS. Anything else is held for the bar's "Open in browser".
   */
  function openOutside(url: string, why: string): void {
    const href = externalHref(url)
    if (!href) {
      log.warn(`web viewer: ${why} to ${redactUrl(url)} blocked`)
      return
    }
    const at = now()
    if (at - gestureAt > GESTURE_WINDOW_MS || at - outsideAt < OUTSIDE_THROTTLE_MS) {
      log.info(`web viewer: ${why} to ${redactUrl(href)} held (not the user's click)`)
      if (!view) return
      held = { url: href, host: hostOf(href) }
      publish()
      return
    }
    // One click opens one page.
    gestureAt = Number.NEGATIVE_INFINITY
    outsideAt = at
    log.info(`web viewer: ${why} to ${redactUrl(href)} opens in the default browser`)
    launch(href)
  }

  /** The user pressed PlayOut's own "Open in browser" (the page, or a held link). */
  function openAsked(url: string, why: string): void {
    const href = externalHref(url)
    if (!href) {
      log.warn(`web viewer: ${why} to ${redactUrl(url)} blocked`)
      return
    }
    log.info(`web viewer: ${why} to ${redactUrl(href)} opens in the default browser`)
    launch(href)
  }

  function placeView(): void {
    if (!view || !host || host.isDestroyed() || !bounds) return
    let zoom = 1
    try {
      zoom = host.webContents.getZoomFactor() || 1
    } catch {
      /* window gone */
    }
    view.setBounds({
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.max(0, Math.round(bounds.width * zoom)),
      height: Math.max(0, Math.round(bounds.height * zoom))
    })
  }

  /** Take the page away; `notify`: tell the renderer (not when another link replaces it at once). */
  function closeView(notify: boolean): void {
    if (!view) return
    generation++
    const closing = view
    view = null
    kind = undefined
    failed = false
    held = undefined
    gestureAt = Number.NEGATIVE_INFINITY
    if (host && electron) {
      try {
        electron.detach(host, closing)
      } catch (err) {
        log.warn('web viewer: detach failed', err)
      }
    }
    try {
      if (!closing.webContents.isDestroyed()) closing.webContents.close()
    } catch {
      /* already gone */
    }
    host = null
    if (!notify) return
    // The main window gets the keyboard back (the page had it).
    const win = deps.window()
    if (win && !win.isDestroyed()) win.webContents.focus()
    publish()
  }

  const close = (): void => closeView(true)

  /** B / Escape in the page: back when it can, else close. */
  function backOrClose(): void {
    const wc = view?.webContents
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else close()
  }

  function wire(wc: ViewerContents, gen: number): void {
    const live = (): boolean => gen === generation && view?.webContents === wc
    // Main-frame navigations only: will-redirect also fires for an iframe's redirects (ads, embeds), which load as in
    // a browser and never reach the default browser. The details object says which frame (the positional argument is
    // the older form of the same flag).
    const guard = (
      event: ElectronEvent & { isMainFrame?: boolean },
      url: string,
      _isInPlace?: boolean,
      isMainFrame?: boolean
    ): void => {
      if ((event.isMainFrame ?? isMainFrame ?? true) === false) return
      const decision = webViewerDecision(url)
      if (decision === 'allow') return
      event.preventDefault()
      if (decision === 'external' && live()) openOutside(url, 'navigation')
      else log.warn(`web viewer: navigation to ${redactUrl(url)} blocked`)
    }
    wc.on('will-navigate', guard as (...args: never[]) => void)
    wc.on('will-redirect', guard as (...args: never[]) => void)
    // The user's own clicks and key presses in the page (a link elsewhere then opens in the default browser).
    wc.on('before-mouse-event', ((_event: ElectronEvent, mouse: MouseInputEvent) => {
      if (live() && (mouse.type === 'mouseDown' || mouse.type === 'mouseUp')) gestureAt = now()
    }) as (...args: never[]) => void)
    // Web Bluetooth: Electron would pick the first device unless this is prevented.
    wc.on('select-bluetooth-device', ((
      event: ElectronEvent,
      _devices: unknown,
      callback: (id: string) => void
    ) => {
      event.preventDefault()
      callback('')
    }) as (...args: never[]) => void)
    // No pop-up windows: a link on an allowed site opens in the viewer itself, any other in the default browser.
    wc.setWindowOpenHandler(({ url }) => {
      if (live() && webViewerDecision(url) === 'allow') {
        wc.loadURL(url).catch(() => undefined)
      } else openOutside(url, 'new window')
      return { action: 'deny' }
    })
    const changed = (): void => {
      if (live()) publish()
    }
    wc.on('did-start-loading', (() => {
      failed = false
      changed()
    }) as (...args: never[]) => void)
    wc.on('did-stop-loading', changed as (...args: never[]) => void)
    wc.on('did-navigate', changed as (...args: never[]) => void)
    wc.on('did-navigate-in-page', changed as (...args: never[]) => void)
    wc.on('page-title-updated', changed as (...args: never[]) => void)
    wc.on('did-fail-load', ((
      _e: unknown,
      code: number,
      description: string,
      url: string,
      isMainFrame: boolean
    ) => {
      // -3 is ABORTED: the page navigated away (or a guard above stopped it).
      if (!isMainFrame || code === -3 || !live()) return
      log.warn(`web viewer: ${redactUrl(url)} failed to load (${code} ${description})`)
      failed = true
      publish()
    }) as (...args: never[]) => void)
    // Keys the page has (once clicked): Escape goes back or closes, Alt+Left / Alt+Right go back / forward.
    wc.on('before-input-event', ((event: ElectronEvent, input: Input) => {
      if (input.type !== 'keyDown' || !live()) return
      gestureAt = now()
      if (input.key === 'Escape') {
        event.preventDefault()
        backOrClose()
      } else if (input.alt && input.key === 'ArrowLeft') {
        event.preventDefault()
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
      } else if (input.alt && input.key === 'ArrowRight') {
        event.preventDefault()
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
      }
    }) as (...args: never[]) => void)
    wc.on('render-process-gone', (() => {
      if (!live()) return
      failed = true
      publish()
    }) as (...args: never[]) => void)
  }

  return {
    async open(linkKind, appId) {
      const url = steamLinkUrl(linkKind, appId)
      const win = deps.window()
      if (!win || win.isDestroyed()) throw new Error('PlayOut has no window')
      electron ??= await loadElectron()
      electron.prepareSession(WEB_VIEWER_PARTITION, (download) => openOutside(download, 'download'))
      closeView(false)
      const gen = ++generation
      const next = electron.createView(WEB_VIEWER_PARTITION)
      next.setBackgroundColor('#1f1f1f')
      next.setVisible(visible)
      view = next
      host = win
      kind = linkKind
      failed = false
      wire(next.webContents, gen)
      electron.attach(win, next)
      placeView()
      log.info(`web viewer: ${linkKind} of Steam app ${appId}`)
      next.webContents.loadURL(url).catch((err) => {
        // loadURL rejects for a failed main-frame load; did-fail-load above already said why.
        log.debug(
          `web viewer: loadURL rejected: ${err instanceof Error ? err.message : String(err)}`
        )
      })
      publish()
      return current
    },
    close,
    async action(action) {
      const wc = view?.webContents
      if (!wc || wc.isDestroyed()) return
      switch (action) {
        case 'back':
          if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
          break
        case 'forward':
          if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
          break
        case 'reload':
          failed = false
          wc.reload()
          break
        case 'external': {
          const url = wc.getURL()
          if (url) openAsked(url, 'open in browser')
          break
        }
        case 'open-link':
          if (held) {
            const url = held.url
            held = undefined
            openAsked(url, 'held link')
            publish()
          }
          break
        case 'dismiss-link':
          if (held) {
            held = undefined
            publish()
          }
          break
      }
    },
    async scroll(deltaY) {
      const wc = view?.webContents
      const dy = clampScroll(deltaY)
      if (!wc || wc.isDestroyed() || dy === 0) return
      // A number only (clampScroll), run where the page's scripts cannot reach it.
      await wc
        .executeJavaScriptInIsolatedWorld(SCROLL_WORLD, [
          { code: `window.scrollBy({ top: ${dy}, left: 0, behavior: 'smooth' })` }
        ])
        .catch(() => undefined)
    },
    setBounds(next) {
      bounds = next
      placeView()
    },
    setVisible(next) {
      if (next === visible) return
      visible = next
      if (!view) return
      view.setVisible(visible)
      if (!visible) {
        // The keyboard goes back to PlayOut's window (the hidden page must not keep it).
        const win = deps.window()
        if (win && !win.isDestroyed()) win.webContents.focus()
      }
    },
    state: () => current
  }
}
