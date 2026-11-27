import { is } from '@electron-toolkit/utils'
import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { createLogger } from './logger'
import { hwndOf } from './native-host/native-ops'
import { isAppUrl } from './util/app-origin'

const log = createLogger('window')

export interface MainWindowOptions {
  startFullscreen: boolean
  /** Query parameters for the renderer URL (mock=1 selects the in-memory API, screen=<name> the initial screen). */
  query: Record<string, string>
  /** Fixed window size (used by --screenshot). */
  fixedSize?: { width: number; height: number }
  onFocusChange?: (focused: boolean) => void
  /**
   * Bring a window to the foreground past Windows' foreground lock (the native host's focus helper). restore() uses
   * it when the plain focus did not take: the controller only drives PlayOut while it is the active window.
   */
  forceForeground?: (hwnd: string) => Promise<boolean>
}

export interface MainWindowHandle {
  get(): BrowserWindow | null
  setFullscreen(fullscreen: boolean): void
  isFullscreen(): boolean
  minimize(): void
  restore(): void
  focus(): void
  isMinimized(): boolean
  /** Has the keyboard focus (PlayOut is the foreground window). */
  isFocused(): boolean
  /** Shown (also when minimized); false when closed to the tray. */
  isVisible(): boolean
  /** Resolves once the renderer finished loading. */
  whenLoaded(): Promise<void>
}

export function createMainWindow(options: MainWindowOptions): MainWindowHandle {
  const work = screen.getPrimaryDisplay().workAreaSize
  const width = options.fixedSize?.width ?? Math.min(1600, work.width)
  const height = options.fixedSize?.height ?? Math.min(900, work.height)

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 960,
    minHeight: 540,
    useContentSize: !!options.fixedSize,
    show: false,
    frame: false,
    fullscreen: options.startFullscreen && !options.fixedSize,
    backgroundColor: '#1f1f1f',
    autoHideMenuBar: true,
    title: 'PlayOut',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  const loaded = new Promise<void>((resolve) => {
    win.webContents.once('did-finish-load', () => resolve())
  })

  win.on('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })
  win.on('focus', () => options.onFocusChange?.(true))
  win.on('blur', () => options.onFocusChange?.(false))

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The document never navigates away from the app entry (a dropped link or HTML file must not replace the
  // renderer); the IPC layer's sender check is the matching suspenders to this belt.
  const guardNavigation = (event: { preventDefault(): void }, url: string): void => {
    if (isAppUrl(url)) return
    event.preventDefault()
    log.warn(`blocked navigation to ${url}`)
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  }
  win.webContents.on('will-navigate', guardNavigation)
  win.webContents.on('will-redirect', guardNavigation)

  // F11 toggles fullscreen regardless of what the renderer does; Alt+F4 still closes.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen())
      event.preventDefault()
    }
  })

  const query = Object.keys(options.query).length ? options.query : undefined
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    for (const [k, v] of Object.entries(options.query)) url.searchParams.set(k, v)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }

  log.info(`window created ${width}x${height} fullscreen=${options.startFullscreen}`)

  const alive = (): BrowserWindow | null => (win.isDestroyed() ? null : win)

  return {
    get: alive,
    setFullscreen(fullscreen) {
      alive()?.setFullScreen(fullscreen)
    },
    isFullscreen() {
      return alive()?.isFullScreen() ?? false
    },
    minimize() {
      alive()?.minimize()
    },
    isFocused() {
      return alive()?.isFocused() ?? false
    },
    restore() {
      const w = alive()
      if (!w) return
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
      // Briefly force on top so Windows actually brings us in front of the game that just exited.
      w.setAlwaysOnTop(true)
      setTimeout(() => alive()?.setAlwaysOnTop(false), 800)
      if (!w.isFocused() && options.forceForeground) {
        try {
          void options
            .forceForeground(hwndOf(w.getNativeWindowHandle()))
            .catch((err) => log.warn('could not take the foreground', err))
        } catch (err) {
          log.warn('could not take the foreground', err)
        }
      }
    },
    focus() {
      const w = alive()
      if (!w) return
      if (w.isMinimized()) w.restore()
      w.focus()
    },
    isMinimized() {
      return alive()?.isMinimized() ?? false
    },
    isVisible() {
      return alive()?.isVisible() ?? false
    },
    whenLoaded: () => loaded
  }
}
