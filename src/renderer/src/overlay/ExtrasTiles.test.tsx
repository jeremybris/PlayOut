import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OverlayExtrasStatus } from '@shared/overlay-extras'

// The store as a plain object (a server render reads a zustand store's initial state only).
const { state } = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('./overlayStore', () => ({
  useOverlayStore: (select: (s: Record<string, unknown>) => unknown) => select(state)
}))

const { ExtrasTiles } = await import('./ExtrasTiles')

const status = (rtssTiles: boolean, osdTile = rtssTiles): OverlayExtrasStatus => ({
  rtss: { state: 'running', version: '7.3.7' },
  rtssTiles,
  osdTile,
  frameLimit: { available: true, fps: 60, chosen: 60, options: [0, 60], exe: 'Game.exe' },
  sync: { enabled: false, available: true, hz: 60 },
  perfOverlay: { level: 0, available: true, drawing: false },
  autoHdr: { enabled: true, hdrOn: true, available: true, note: 'Applies to games started next' },
  cpuBoost: { enabled: true, available: true, profile: 'balanced', overridden: false }
})

function html(over: Record<string, unknown>): string {
  for (const k of Object.keys(state)) delete state[k]
  Object.assign(state, { open: false, intel: null, refreshExtras: async () => undefined }, over)
  return renderToStaticMarkup(<ExtrasTiles />)
}

describe('ExtrasTiles', () => {
  it('says the settings could not be read instead of checking forever', () => {
    expect(html({ extras: null, extrasUnavailable: false })).toContain('Checking the game settings')
    expect(html({ extras: null, extrasUnavailable: true })).toContain(
      'Could not read the game settings'
    )
  })

  it('hides the RivaTuner tiles until the in-game check passed', () => {
    let out = html({ extras: status(false), extrasUnavailable: false })
    expect(out).not.toContain('Frame rate limit')
    expect(out).not.toContain('Sync FPS')
    expect(out).not.toContain('Performance overlay')
    expect(out).toContain('Auto HDR')
    expect(out).toContain('CPU boost')
    // The performance overlay passed its check first: it shows alone.
    out = html({ extras: status(false, true), extrasUnavailable: false })
    expect(out).not.toContain('Frame rate limit')
    expect(out).not.toContain('Sync FPS')
    expect(out).toContain('Performance overlay')
    out = html({ extras: status(true), extrasUnavailable: false })
    expect(out).toContain('Frame rate limit')
    expect(out).toContain('Performance overlay')
  })
})
