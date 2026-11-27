// The store sign-in window (docs/ARCHITECTURE.md §4.8 "Auth window"): a modal child BrowserWindow of the main window
// on the store's own `persist:account-<source>` partition, with no preload (so `window.playout` does not exist
// there), its own window-open handler (same-site popups for 2FA only) and capture through navigation events,
// `session.webRequest` and read-only `executeJavaScript` of documents the store rendered. Main-frame navigations and
// popups are limited to the page's `allowedSites` (the store's own domains), in the window and in every popup it
// allowed; popups close with the window. The same code drives the hidden loader the importers use to re-mint
// cookie-session credentials. Electron is imported lazily so the module's pure helpers and the importers' tests
// run outside Electron.
import type { BrowserWindow as BrowserWindowType } from 'electron'
import type { StoreSourceId } from '../../shared/types'
import type { Logger } from '../logger'
import { redactUrl } from '../scrapers/http'
import { describeError, type AuthPage, type AuthWindow } from './types'
import { tMain } from '../i18n'

export const AUTH_WINDOW_SIZE = { width: 600, height: 760 }
export const VISIBLE_TIMEOUT_MS = 10 * 60_000
export const HIDDEN_TIMEOUT_MS = 20_000

export function partitionFor(source: StoreSourceId): string {
  return `persist:account-${source}`
}

/** The registrable part of a host, roughly (last two labels; three for `co.uk`-style suffixes). */
export function siteOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase()
    const labels = host.split('.')
    if (labels.length <= 2) return host
    const secondLevel = labels[labels.length - 2]
    const keep = /^(co|com|org|net|gov|ac)$/.test(secondLevel) && labels.length > 2 ? 3 : 2
    return labels.slice(-keep).join('.')
  } catch {
    return null
  }
}

/**
 * Whether the window may show `url`: https on one of the page's allowed sites (the store's own domains), or, without
 * an allow-list, any https site. `about:blank` is what a popup starts as and is always fine.
 */
export function isAllowedNavigation(url: string, allowedSites: string[] | undefined): boolean {
  if (url === 'about:blank') return true
  if (!/^https:/i.test(url)) return false
  if (!allowedSites?.length) return true
  const site = siteOf(url)
  return site !== null && allowedSites.some((s) => s.toLowerCase() === site)
}

/**
 * Popups are allowed only on the store's own sites (2FA / consent flows): the page's allow-list when it has one,
 * else the site of the page that opened it or of the start URL; everything else is denied.
 */
export function allowPopup(
  popupUrl: string,
  pageUrl: string,
  startUrl: string,
  allowedSites?: string[]
): boolean {
  if (allowedSites?.length) return isAllowedNavigation(popupUrl, allowedSites)
  const target = siteOf(popupUrl)
  if (!target || !/^https:/i.test(popupUrl)) return false
  return target === siteOf(pageUrl) || target === siteOf(startUrl)
}

export interface AuthWindowDeps {
  /** The main window: parent of the modal sign-in window; re-focused when the sign-in window closes. */
  parent: () => BrowserWindowType | null
  log: Logger
}

export interface AuthWindows {
  /** The visible sign-in window; `run` rejects when another sign-in window is open. */
  visible(source: StoreSourceId, storeName: string): AuthWindow
  /** A hidden loader on the same partition (token re-mints, cookie-session reads). */
  hidden(source: StoreSourceId): AuthWindow
  isOpen(): boolean
  /** Close the open sign-in window (its `run` resolves null) and every hidden loader. */
  closeAll(): void
  /** Close the hidden loaders of one store (sign-out: nothing may keep reading that partition). */
  closeHidden(source: StoreSourceId): void
}

interface Live {
  source: StoreSourceId
  win: BrowserWindowType
  close(): void
}

export function createAuthWindows(deps: AuthWindowDeps): AuthWindows {
  const { log } = deps
  let visibleOpen: Live | null = null
  const hiddenOpen = new Set<Live>()

  async function run<T>(
    source: StoreSourceId,
    page: AuthPage<T>,
    options: { visible: boolean; title?: string }
  ): Promise<T | null> {
    const { BrowserWindow, session } = await import('electron')
    const partition = partitionFor(source)
    const ses = session.fromPartition(partition)
    const parent = options.visible ? deps.parent() : null
    const win = new BrowserWindow({
      ...AUTH_WINDOW_SIZE,
      show: false,
      parent: parent ?? undefined,
      modal: !!parent,
      alwaysOnTop: !!parent?.isFullScreen(),
      autoHideMenuBar: true,
      title: options.title ?? 'PlayOut',
      backgroundColor: '#1f1f1f',
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })
    const wc = win.webContents
    if (page.userAgent) wc.setUserAgent(page.userAgent)
    // The store sets its own title; the user should still see which account the window is for.
    win.on('page-title-updated', (event) => event.preventDefault())

    return new Promise<T | null>((resolve) => {
      let settled = false
      const timeoutMs = page.timeoutMs ?? (options.visible ? VISIBLE_TIMEOUT_MS : HIDDEN_TIMEOUT_MS)
      const timer = setTimeout(() => finish(null, 'timed out'), timeoutMs)

      const live: Live = { source, win, close: () => finish(null, 'closed by PlayOut') }
      // Popups the window-open handler allowed (2FA): guarded like the window and closed with it.
      const children = new Set<BrowserWindowType>()

      const cleanup = (): void => {
        clearTimeout(timer)
        if (page.requestFilter?.length) {
          try {
            ses.webRequest.onBeforeRequest(null)
            ses.webRequest.onBeforeSendHeaders(null)
          } catch {
            /* session gone */
          }
        }
        if (options.visible && visibleOpen === live) visibleOpen = null
        hiddenOpen.delete(live)
        for (const child of children) if (!child.isDestroyed()) child.destroy()
        children.clear()
        if (!win.isDestroyed()) win.destroy()
        if (options.visible) {
          const main = deps.parent()
          if (main && !main.isDestroyed()) main.focus()
        }
      }

      const finish = (value: T | null, why: string): void => {
        if (settled) return
        settled = true
        log.info(`${source}: auth window ${value === null ? why : 'captured a credential'}`)
        cleanup()
        resolve(value)
      }

      const consider = (value: T | null | undefined): void => {
        if (value !== null && value !== undefined) finish(value, 'captured')
      }

      const navigated = (url: string, loaded: boolean): void => {
        if (settled || !page.onNavigate) return
        log.debug(`${source}: ${loaded ? 'loaded' : 'navigating'} ${redactUrl(url)}`)
        Promise.resolve(
          page.onNavigate({
            url,
            loaded,
            executeJavaScript: async <R>(script: string): Promise<R> => {
              if (win.isDestroyed()) throw new Error('window closed')
              return (await wc.executeJavaScript(script, true)) as R
            }
          })
        )
          .then(consider)
          .catch((err) => log.warn(`${source}: auth page callback failed: ${describeError(err)}`))
      }

      // will-navigate too: a page that signs in by script (location.href = …) reaches its target this way, and the
      // capture must see the address even when the guard below blocks it (Epic's localhost/launcher/authorized).
      wc.on('will-navigate', (_e, url) => navigated(url, false))
      wc.on('will-redirect', (_e, url) => navigated(url, false))
      wc.on('did-redirect-navigation', (_e, url) => navigated(url, false))
      wc.on('did-navigate', (_e, url) => navigated(url, false))
      wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
        if (isMainFrame) navigated(url, true)
      })
      wc.on('did-finish-load', () => navigated(wc.getURL(), true))
      wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
        // -3 is ABORTED: the page itself navigated away before the previous load finished.
        if (isMainFrame && code !== -3)
          log.warn(`${source}: ${redactUrl(url)} failed to load (${code} ${description})`)
      })

      if (page.requestFilter?.length) {
        const filter = { urls: page.requestFilter }
        ses.webRequest.onBeforeRequest(filter, (details, callback) => {
          if (!settled && page.onRequest) consider(page.onRequest({ url: details.url }))
          callback({})
        })
        ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
          if (!settled && page.onRequest) {
            const headers: Record<string, string> = {}
            for (const [k, v] of Object.entries(details.requestHeaders ?? {}))
              headers[k.toLowerCase()] = String(v)
            consider(page.onRequest({ url: details.url, requestHeaders: headers }))
          }
          callback({ requestHeaders: details.requestHeaders })
        })
      }

      // Main-frame navigations stay on the store's sites: a footer link or a redirect chain leaving them is
      // blocked, so the capture callbacks only ever see documents the store rendered (login CSRF guard).
      const guard = (contents: Electron.WebContents, label: string): void => {
        const block = (event: Electron.Event, url: string): void => {
          if (isAllowedNavigation(url, page.allowedSites)) return
          event.preventDefault()
          log.warn(`${source}: ${label} navigation to ${redactUrl(url)} blocked`)
        }
        contents.on('will-navigate', block)
        contents.on('will-redirect', block)
        contents.setWindowOpenHandler(({ url }) => {
          if (allowPopup(url, contents.getURL(), page.url, page.allowedSites)) {
            return {
              action: 'allow',
              overrideBrowserWindowOptions: {
                parent: win,
                autoHideMenuBar: true,
                webPreferences: {
                  partition,
                  sandbox: true,
                  contextIsolation: true,
                  nodeIntegration: false
                }
              }
            }
          }
          log.warn(`${source}: popup to ${redactUrl(url)} denied`)
          return { action: 'deny' }
        })
        contents.on('did-create-window', (child) => {
          children.add(child)
          child.on('closed', () => children.delete(child))
          guard(child.webContents, 'popup')
        })
      }
      guard(wc, 'main-frame')

      win.on('closed', () => finish(null, 'closed by the user'))

      if (options.visible) {
        visibleOpen = live
        win.once('ready-to-show', () => {
          if (!win.isDestroyed()) {
            win.show()
            win.focus()
          }
        })
      } else {
        hiddenOpen.add(live)
      }

      win.loadURL(page.url).catch((err) => {
        // loadURL rejects for a failed main-frame load; the did-fail-load log above already said why.
        log.debug(`${source}: loadURL rejected: ${describeError(err)}`)
      })
    })
  }

  return {
    visible(source, storeName) {
      return {
        run: (page) => {
          if (visibleOpen) return Promise.reject(new Error(tMain('mainAccounts.signIn.windowOpen')))
          return run(source, page, {
            visible: true,
            title: tMain('mainAccounts.signIn.title', { store: storeName })
          })
        }
      }
    },
    hidden(source) {
      return { run: (page) => run(source, page, { visible: false }) }
    },
    isOpen: () => visibleOpen !== null,
    closeAll() {
      visibleOpen?.close()
      for (const live of [...hiddenOpen]) live.close()
    },
    closeHidden(source) {
      for (const live of [...hiddenOpen]) if (live.source === source) live.close()
    }
  }
}
