// The in-app web viewer in the mock (main web-viewer/viewer.ts): no web page is loaded in the preview. Opening a link
// reports the address it would show, with a made-up history so Back / Forward can be tried; the renderer's viewer
// draws a placeholder panel where the page would be.
import type { PlayOutApi } from '@shared/api'
import {
  CLOSED_WEB_VIEWER,
  steamLinkUrl,
  type SteamLinkKind,
  type WebViewerState
} from '@shared/web-viewer'
import type { MockEmitter } from './emitter'

export type WebViewerApi = Pick<
  PlayOutApi,
  | 'openWebViewer'
  | 'closeWebViewer'
  | 'webViewerAction'
  | 'scrollWebViewer'
  | 'setWebViewerBounds'
  | 'setWebViewerVisible'
>

const TITLES: Record<SteamLinkKind, string> = {
  store: 'Steam Store',
  workshop: 'Steam Workshop',
  pcgamingwiki: 'PCGamingWiki',
  guides: 'Steam Guides'
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export function createWebViewerMock(
  emitter: MockEmitter,
  log: (...args: unknown[]) => void = () => undefined
): { api: WebViewerApi; state: () => WebViewerState } {
  let history: string[] = []
  let at = -1
  let kind: SteamLinkKind | undefined
  let state: WebViewerState = CLOSED_WEB_VIEWER

  const publish = (): WebViewerState => {
    const url = history[at]
    state = url
      ? {
          open: true,
          ...(kind ? { kind, title: TITLES[kind] } : {}),
          url,
          host: hostOf(url),
          canGoBack: at > 0,
          canGoForward: at < history.length - 1,
          loading: false
        }
      : CLOSED_WEB_VIEWER
    emitter.emit('web-viewer:state', state)
    return state
  }

  return {
    state: () => state,
    api: {
      async openWebViewer(linkKind, appId) {
        const url = steamLinkUrl(linkKind, appId)
        kind = linkKind
        // A second page in the history, so Back can be tried in the preview.
        history = [url, `${url}#more`]
        at = 0
        log(`openWebViewer(${linkKind}, ${appId}) -> ${url}`)
        return publish()
      },
      async closeWebViewer() {
        if (at < 0) return
        history = []
        at = -1
        kind = undefined
        publish()
      },
      async webViewerAction(action) {
        if (at < 0) return
        if (action === 'back' && at > 0) at--
        else if (action === 'forward' && at < history.length - 1) at++
        else if (action === 'external') log(`webViewer: open ${history[at]} in the browser`)
        publish()
      },
      async scrollWebViewer(deltaY) {
        log(`scrollWebViewer(${deltaY})`)
      },
      async setWebViewerBounds() {
        /* nothing to place in the preview */
      },
      async setWebViewerVisible(visible) {
        log(`setWebViewerVisible(${visible})`)
      }
    }
  }
}
