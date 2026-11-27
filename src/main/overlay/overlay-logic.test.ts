import { describe, expect, it, vi } from 'vitest'
import {
  CLOSED_STATE,
  exeName,
  openedState,
  overlayBounds,
  overlayTarget,
  sameState,
  type ForegroundWindow,
  type OverlayScreen,
  type OverlayTarget,
  pausable
} from './overlay-logic'

function fg(over: Partial<ForegroundWindow> = {}): ForegroundWindow {
  return {
    hwnd: '1234',
    pid: 99,
    exe: 'C:\\Games\\Hades\\Hades.exe',
    title: 'Hades',
    rect: { x: 2560, y: 0, width: 1920, height: 1080 },
    monitor: {
      device: '\\\\.\\DISPLAY2',
      rect: { x: 2560, y: 0, width: 3840, height: 2160 },
      workArea: { x: 2560, y: 0, width: 3840, height: 2100 }
    },
    fullscreen: true,
    exclusive: false,
    ...over
  }
}

const primary = { x: 0, y: 0, width: 1280, height: 800 }
const second = { x: 1280, y: 0, width: 1920, height: 1080 }

function fakeScreen(withDip = true): OverlayScreen & {
  getDisplayMatching: ReturnType<typeof vi.fn>
} {
  return {
    getPrimaryDisplay: () => ({ bounds: primary }),
    getDisplayMatching: vi.fn((r: { x: number }) => ({ bounds: r.x >= 1280 ? second : primary })),
    ...(withDip
      ? {
          // 200 % on the second monitor: physical 2560 is DIP 1280.
          screenToDipRect: (
            _w: null,
            r: { x: number; y: number; width: number; height: number }
          ) => ({
            x: r.x / 2,
            y: r.y / 2,
            width: r.width / 2,
            height: r.height / 2
          })
        }
      : {})
  }
}

describe('exeName', () => {
  it('drops the folder', () => {
    expect(exeName('C:\\Games\\Hades\\Hades.exe')).toBe('Hades.exe')
    expect(exeName('/x/y/game')).toBe('game')
    expect(exeName('game.exe')).toBe('game.exe')
  })
})

describe('overlayTarget', () => {
  const notOurs = (): boolean => false
  it('keeps the foreground window', () => {
    expect(overlayTarget(fg({ exclusive: true }), '1', notOurs)).toEqual({
      hwnd: '1234',
      pid: 99,
      exclusive: true,
      program: 'Hades.exe'
    })
  })
  it('has no target without a foreground window', () => {
    expect(overlayTarget(null, '1', notOurs)).toBeNull()
    expect(overlayTarget(fg({ hwnd: '' }), '1', notOurs)).toBeNull()
  })
  it('skips the overlay itself and PlayOut windows', () => {
    expect(overlayTarget(fg({ hwnd: '1' }), '1', notOurs)).toBeNull()
    expect(overlayTarget(fg(), '1', (h) => h === '1234')).toBeNull()
  })
})

describe('overlayBounds', () => {
  it('converts the monitor to DIP and snaps to that display', () => {
    const s = fakeScreen()
    expect(overlayBounds(s, fg())).toEqual(second)
    expect(s.getDisplayMatching).toHaveBeenCalledWith({ x: 1280, y: 0, width: 1920, height: 1080 })
  })
  it('uses the physical rect without screenToDipRect', () => {
    const s = fakeScreen(false)
    expect(overlayBounds(s, fg())).toEqual(second)
    expect(s.getDisplayMatching).toHaveBeenCalledWith(fg().monitor!.rect)
  })
  it('falls back to the primary display', () => {
    expect(overlayBounds(fakeScreen(), null)).toEqual(primary)
    const empty = fg({
      monitor: { device: '', rect: { x: 0, y: 0, width: 0, height: 0 }, workArea: primary },
      rect: { x: 0, y: 0, width: 0, height: 0 }
    })
    expect(overlayBounds(fakeScreen(), empty)).toEqual(primary)
  })
  it('uses the window rect when the monitor is unknown', () => {
    const s = fakeScreen(false)
    const rect = { x: 1400, y: 100, width: 800, height: 600 }
    overlayBounds(s, fg({ monitor: null, rect }))
    expect(s.getDisplayMatching).toHaveBeenCalledWith(rect)
  })
  it('survives a throwing screen', () => {
    const s = fakeScreen()
    s.getDisplayMatching.mockImplementation(() => {
      throw new Error('gone')
    })
    expect(overlayBounds(s, fg())).toEqual(primary)
  })
})

describe('pausable', () => {
  const t = (program: string, pid = 10): OverlayTarget => ({
    hwnd: '1',
    pid,
    exclusive: false,
    program
  })
  it('pauses programs, never the shell, Steam, PlayOut itself or an unknown process', () => {
    expect(pausable(t('Hades.exe'), 1)).toBe(true)
    expect(pausable(t('explorer.exe'), 1)).toBe(false)
    expect(pausable(t('Steam.exe'), 1)).toBe(false)
    expect(pausable(t('GameBar.exe'), 1)).toBe(false)
    expect(pausable(t('Hades.exe', 1), 1)).toBe(false)
    expect(pausable(t('Hades.exe', 0), 1)).toBe(false)
    expect(pausable(t(''), 1)).toBe(false)
    expect(pausable(null, 1)).toBe(false)
  })
})

describe('openedState', () => {
  const target = { hwnd: '1', pid: 10, exclusive: false, program: 'Hades.exe' }
  it('names the running game first', () => {
    expect(openedState(target, { gameId: 'g1' })).toEqual({ open: true, gameId: 'g1' })
  })
  it('names the program otherwise', () => {
    expect(openedState(target, null)).toEqual({ open: true, program: 'Hades.exe' })
    expect(openedState(null, null)).toEqual({ open: true })
  })
})

describe('sameState', () => {
  it('compares every field', () => {
    expect(sameState(CLOSED_STATE, { open: false })).toBe(true)
    expect(sameState({ open: true, gameId: 'a' }, { open: true, gameId: 'b' })).toBe(false)
    expect(sameState({ open: true, program: 'a' }, { open: true })).toBe(false)
  })
})
