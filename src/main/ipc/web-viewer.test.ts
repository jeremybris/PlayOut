import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  dialog: {},
  shell: {}
}))

import { createHandlers, type AppServices } from './handlers'

function services(): {
  webViewer: Record<
    'open' | 'close' | 'action' | 'scroll' | 'setBounds' | 'setVisible',
    ReturnType<typeof vi.fn>
  >
  steamTags: { refreshed: ReturnType<typeof vi.fn>; checkWorkshop: ReturnType<typeof vi.fn> }
  metadata: { enqueue: ReturnType<typeof vi.fn> }
  handlers: ReturnType<typeof createHandlers>
} {
  const webViewer = {
    open: vi.fn(async () => ({ open: true, canGoBack: false, canGoForward: false, loading: true })),
    close: vi.fn(),
    action: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    setBounds: vi.fn(),
    setVisible: vi.fn()
  }
  const steamTags = { refreshed: vi.fn(), checkWorkshop: vi.fn(async () => true) }
  const metadata = { enqueue: vi.fn(() => 1) }
  return {
    webViewer,
    steamTags,
    metadata,
    handlers: createHandlers({
      webViewer,
      steamTags,
      metadata,
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      window: { get: () => null }
    } as unknown as AppServices)
  }
}

describe('web viewer handlers', () => {
  it('open a known link of a valid Steam app id only', async () => {
    const { webViewer, handlers } = services()
    await handlers.openWebViewer('guides', 620)
    expect(webViewer.open).toHaveBeenCalledWith('guides', 620)
    await expect(handlers.openWebViewer('https://evil.com' as never, 620)).rejects.toThrow()
    await expect(handlers.openWebViewer('store', 0)).rejects.toThrow()
    await expect(handlers.openWebViewer('store', 1.5)).rejects.toThrow()
    await expect(handlers.openWebViewer('store', '620' as never)).rejects.toThrow()
    expect(webViewer.open).toHaveBeenCalledTimes(1)
  })

  it('validate actions, scroll steps and bounds', async () => {
    const { webViewer, handlers } = services()
    await handlers.webViewerAction('reload')
    await expect(handlers.webViewerAction('eval' as never)).rejects.toThrow()
    await handlers.scrollWebViewer(120)
    await expect(handlers.scrollWebViewer(Number.NaN)).rejects.toThrow()
    await expect(handlers.scrollWebViewer('1;alert(1)' as never)).rejects.toThrow()
    await handlers.setWebViewerBounds({ x: 1, y: 2, width: 300, height: 200 })
    await expect(
      handlers.setWebViewerBounds({ x: -1, y: 0, width: 1, height: 1 })
    ).rejects.toThrow()
    await expect(
      handlers.setWebViewerBounds({ x: 0, y: 0, width: 1, height: 1, extra: 1 } as never)
    ).rejects.toThrow()
    await handlers.webViewerAction('open-link')
    await handlers.setWebViewerVisible(false)
    await expect(handlers.setWebViewerVisible('no' as never)).rejects.toThrow()
    expect(webViewer.setVisible.mock.calls).toEqual([[false]])
    await handlers.closeWebViewer()
    expect(webViewer.action.mock.calls).toEqual([['reload'], ['open-link']])
    expect(webViewer.scroll.mock.calls).toEqual([[120]])
    expect(webViewer.setBounds.mock.calls).toEqual([[{ x: 1, y: 2, width: 300, height: 200 }]])
    expect(webViewer.close).toHaveBeenCalledTimes(1)
  })

  it("asks the Steam tags for refreshed games' Workshop answer", async () => {
    const { steamTags, metadata, handlers } = services()
    await handlers.refreshMetadata(['g1', 'g2'])
    expect(metadata.enqueue).toHaveBeenCalled()
    expect(steamTags.refreshed).toHaveBeenCalledWith(['g1', 'g2'])
  })

  it("asks the Steam tags about a game page's Workshop, for a valid game id only", async () => {
    const { steamTags, handlers } = services()
    await expect(handlers.steamWorkshopCheck('steam:620')).resolves.toBe(true)
    expect(steamTags.checkWorkshop).toHaveBeenCalledWith('steam:620')
    await expect(handlers.steamWorkshopCheck('' as never)).rejects.toThrow()
    await expect(handlers.steamWorkshopCheck(620 as never)).rejects.toThrow()
    expect(steamTags.checkWorkshop).toHaveBeenCalledTimes(1)
    steamTags.checkWorkshop.mockResolvedValueOnce(null)
    await expect(handlers.steamWorkshopCheck('steam:1')).resolves.toBeNull()
  })

  it('answers null without the Steam tags service', async () => {
    const handlers = createHandlers({
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      window: { get: () => null }
    } as unknown as AppServices)
    await expect(handlers.steamWorkshopCheck('steam:620')).resolves.toBeNull()
  })
})
