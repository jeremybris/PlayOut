import { describe, expect, it } from 'vitest'
import type { WebViewerState } from '@shared/web-viewer'
import { createEmitter } from './emitter'
import { createWebViewerMock } from './webViewer'

describe('web viewer mock', () => {
  it('reports the address it would show, a history to try, and closing', async () => {
    const emitter = createEmitter()
    const seen: WebViewerState[] = []
    emitter.on('web-viewer:state', (s) => seen.push(s))
    const { api, state } = createWebViewerMock(emitter)
    const opened = await api.openWebViewer('pcgamingwiki', 620)
    expect(opened).toMatchObject({
      open: true,
      kind: 'pcgamingwiki',
      url: 'https://www.pcgamingwiki.com/api/appid.php?appid=620',
      host: 'www.pcgamingwiki.com',
      canGoBack: false,
      canGoForward: true
    })
    await api.webViewerAction('forward')
    expect(state()).toMatchObject({ canGoBack: true, canGoForward: false })
    await api.closeWebViewer()
    expect(state().open).toBe(false)
    expect(seen.map((s) => s.open)).toEqual([true, true, false])
  })
})
