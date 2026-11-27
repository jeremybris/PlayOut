import { describe, expect, it } from 'vitest'
import { openWindowsSettings, SETTINGS_URIS, settingsUri } from './windows-settings'

describe('windows settings links', () => {
  it('maps every page to an ms-settings URI', () => {
    for (const [page, uri] of Object.entries(SETTINGS_URIS)) {
      expect(uri).toMatch(/^ms-settings:[a-z-]+$/)
      expect(settingsUri(page as keyof typeof SETTINGS_URIS)).toBe(uri)
    }
    expect(settingsUri('bluetooth')).toBe('ms-settings:bluetooth')
    expect(settingsUri('wifi')).toBe('ms-settings:network-wifi')
    expect(() => settingsUri('nope' as never)).toThrow(/Unknown Windows Settings page/)
  })

  it('opens the page through the injected opener', async () => {
    const opened: string[] = []
    await openWindowsSettings('sound', async (uri) => {
      opened.push(uri)
    })
    expect(opened).toEqual(['ms-settings:sound'])
  })
})
