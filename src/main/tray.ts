/**
 * Settings > System > "Minimize to tray": while it is on, closing the main window (X, Alt+F4, the app's own Exit)
 * hides it and leaves PlayOut running behind a system tray icon. A real quit (the tray's Quit, an update install,
 * Windows shutting down or signing out) always goes through. While it is off nothing here changes how PlayOut closes.
 *
 * Electron is injected (window and tray factory) so the decisions can be unit-tested; index.ts wires the real ones.
 */

/** The parts of BrowserWindow this module uses. */
export interface TrayWindow {
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
  on(event: 'query-session-end' | 'session-end' | 'show', listener: () => void): unknown
  hide(): void
  show(): void
  focus(): void
  restore(): void
  isMinimized(): boolean
  isDestroyed(): boolean
}

/** The parts of Electron's Tray this module uses. */
export interface TrayIcon {
  destroy(): void
}

export interface TrayActions {
  /** Bring the window back (tray click, "Open PlayOut"). */
  open(): void
  /** Quit for real ("Quit"). */
  quit(): void
}

export interface CloseToTrayOptions {
  /** Current value of settings.system.minimizeToTray. */
  enabled(): boolean
  /** Creates the tray icon with its menu; called only while the setting is on. */
  createTray(actions: TrayActions): TrayIcon
  /** app.quit(). */
  quit(): void
  log?: { info(message: string): void; warn(message: string): void }
}

export interface CloseToTray {
  /** Hook the main window's close and session-end events. */
  attach(window: TrayWindow): void
  /** A real quit is under way (before-quit): windows close normally from now on. */
  markQuitting(): void
  /** The app's own Exit: hides to the tray while the setting is on, quits otherwise. */
  exit(): void
  /** Show, restore and focus the window (also used for a second instance). */
  show(): void
  /** Re-read the setting: create or remove the tray icon, and bring a hidden window back when it was turned off. */
  sync(): void
  /** Whether the window is currently hidden to the tray. */
  isHidden(): boolean
  dispose(): void
}

export function createCloseToTray(options: CloseToTrayOptions): CloseToTray {
  let win: TrayWindow | null = null
  let tray: TrayIcon | null = null
  let quitting = false
  let hidden = false

  const alive = (): TrayWindow | null => (win && !win.isDestroyed() ? win : null)

  const removeTray = (): void => {
    if (!tray) return
    try {
      tray.destroy()
    } catch (err) {
      options.log?.warn(`tray destroy failed: ${(err as Error).message}`)
    }
    tray = null
  }

  const ensureTray = (): boolean => {
    if (tray) return true
    try {
      tray = options.createTray({ open: () => controller.show(), quit: () => controller.quitNow() })
      options.log?.info('tray icon shown')
      return true
    } catch (err) {
      // No tray icon means no way back to a hidden window: callers fall back to quitting.
      options.log?.warn(`tray icon could not be created: ${(err as Error).message}`)
      return false
    }
  }

  /** Hide to the tray; false when that is not possible (setting off, quitting, no tray). */
  const hideToTray = (): boolean => {
    const w = alive()
    if (!w || quitting || !options.enabled() || !ensureTray()) return false
    w.hide()
    hidden = true
    options.log?.info('window hidden to the tray')
    return true
  }

  const controller = {
    attach(window: TrayWindow) {
      win = window
      window.on('close', (event) => {
        if (hideToTray()) event.preventDefault()
      })
      // Shown by anything else (a game exiting restores the window, for one): no longer hidden.
      window.on('show', () => {
        hidden = false
      })
      // Windows is shutting down or signing out: never hold the window open.
      const sessionEnding = (): void => controller.markQuitting()
      window.on('query-session-end', sessionEnding)
      window.on('session-end', sessionEnding)
      controller.sync()
    },
    markQuitting() {
      quitting = true
    },
    quitNow() {
      quitting = true
      options.quit()
    },
    exit() {
      if (!hideToTray()) options.quit()
    },
    show() {
      const w = alive()
      hidden = false
      if (!w) return
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    },
    sync() {
      if (quitting) return
      if (options.enabled()) {
        ensureTray()
        return
      }
      if (tray) options.log?.info('tray icon removed')
      removeTray()
      // Turned off while hidden: the window must not stay invisible with no tray icon to bring it back.
      if (hidden) controller.show()
    },
    isHidden: () => hidden,
    dispose() {
      if (tray) options.log?.info('tray icon removed')
      removeTray()
    }
  }
  return controller
}
