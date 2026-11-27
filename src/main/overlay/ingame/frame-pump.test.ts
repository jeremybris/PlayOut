import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, shell: { openExternal: vi.fn() } }))
vi.mock('../../util/app-origin', () => ({
  isAppUrl: (url: string) => url.startsWith('file:///app/')
}))

import type { BrowserWindowConstructorOptions } from 'electron'
import {
  createFramePump,
  dirtyPixels,
  framePumpOptions,
  type PaintRect,
  type PumpImage,
  type PumpWin
} from './frame-pump'
import { HEADER_BYTES, ToDll } from './protocol'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

interface FakePumpWin extends PumpWin {
  options: BrowserWindowConstructorOptions
  size: [number, number]
  painting: boolean
  calls: string[]
  destroyed: boolean
  paint(dirty: PaintRect, image: PumpImage): void
  navigate(event: string, url: string): boolean
  fire(event: string, ...args: unknown[]): void
}

function fakeWin(options: BrowserWindowConstructorOptions): FakePumpWin {
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
  const add = (e: string, l: (...a: unknown[]) => void): void => {
    listeners.set(e, [...(listeners.get(e) ?? []), l])
  }
  const w: FakePumpWin = {
    options,
    size: [800, 600],
    painting: true,
    calls: [],
    destroyed: false,
    isDestroyed: () => w.destroyed,
    destroy: () => {
      w.destroyed = true
      for (const l of listeners.get('closed') ?? []) l()
    },
    setSize: (width, height) => {
      w.size = [width, height]
      w.calls.push(`size ${width}x${height}`)
    },
    getSize: () => w.size,
    on: (e: string, l: () => void) => add(e, l),
    webContents: {
      setFrameRate: (fps) => w.calls.push(`fps ${fps}`),
      startPainting: () => {
        w.painting = true
        w.calls.push('start')
      },
      stopPainting: () => {
        w.painting = false
        w.calls.push('stop')
      },
      invalidate: () => w.calls.push('invalidate'),
      on: (e: string, l: (...a: never[]) => void) => add(e, l as (...a: unknown[]) => void),
      setWindowOpenHandler: () => {}
    },
    paint: (dirty, image) => {
      for (const l of listeners.get('paint') ?? []) l({}, dirty, image)
    },
    navigate: (e, url) => {
      let prevented = false
      for (const l of listeners.get(e) ?? []) l({ preventDefault: () => (prevented = true) }, url)
      return prevented
    },
    fire: (e, ...args) => {
      for (const l of listeners.get(e) ?? []) l(...args)
    }
  }
  return w
}

function image(width: number, height: number): PumpImage {
  const bitmap = Buffer.alloc(width * height * 4)
  for (let i = 0; i < bitmap.length; i++) bitmap[i] = i & 0xff
  return { getSize: () => ({ width, height }), toBitmap: () => bitmap }
}

/** The FRAME's x, y, w, h, fullWidth, fullHeight. */
const frameFields = (m: Buffer): number[] => {
  expect(m.readUInt32LE(0)).toBe(ToDll.FRAME)
  return [0, 4, 8, 12, 16, 20].map((o) => m.readUInt32LE(HEADER_BYTES + o))
}

function setup(scale = 1): {
  pump: ReturnType<typeof createFramePump>
  wins: FakePumpWin[]
  load: ReturnType<typeof vi.fn>
  scale: { value: number }
} {
  const wins: FakePumpWin[] = []
  const s = { value: scale }
  const load = vi.fn(async () => {})
  const pump = createFramePump({
    log,
    preload: 'preload.js',
    load,
    scaleFactor: () => s.value,
    createWindow: (options) => {
      const w = fakeWin(options)
      wins.push(w)
      return w
    }
  })
  return { pump, wins, load, scale: s }
}

describe('framePumpOptions', () => {
  it('is the overlay window offscreen, transparent, hidden, at the scale, without a shared texture', () => {
    const o = framePumpOptions('p.js', 1.5)
    expect(o).toMatchObject({
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false
    })
    expect(o.webPreferences).toMatchObject({
      preload: 'p.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: { useSharedTexture: false, deviceScaleFactor: 1.5 }
    })
  })
})

describe('dirtyPixels', () => {
  it('covers the rectangle read both in DIP and in pixels', () => {
    expect(dirtyPixels({ x: 10, y: 10, w: 5, h: 5 }, 1)).toEqual({ x: 10, y: 10, w: 5, h: 5 })
    expect(dirtyPixels({ x: 10, y: 20, w: 10, h: 10 }, 2)).toEqual({ x: 10, y: 20, w: 30, h: 40 })
  })
})

describe('createFramePump', () => {
  it('creates the window once, loads it and sizes the page to the back buffer', async () => {
    const s = setup()
    expect(await s.pump.prepare({ width: 1920, height: 1080 })).toBe(true)
    expect(await s.pump.prepare({ width: 1920, height: 1080 })).toBe(true)
    expect(s.wins).toHaveLength(1)
    expect(s.load).toHaveBeenCalledTimes(1)
    expect(s.wins[0]!.size).toEqual([1920, 1080])
    expect(s.wins[0]!.calls.filter((c) => c.startsWith('size'))).toHaveLength(1)
    // Nothing is painted before show.
    expect(s.wins[0]!.painting).toBe(false)
    expect(s.pump.window()).toBe(s.wins[0])
  })

  it('renders at the display scale: DIP size = back buffer / scale', async () => {
    const s = setup(1.5)
    await s.pump.prepare({ width: 2560, height: 1440 })
    expect(s.wins[0]!.size).toEqual([1707, 960])
    // A different scale needs a new window.
    s.scale.value = 1
    await s.pump.prepare({ width: 2560, height: 1440 })
    expect(s.wins).toHaveLength(2)
    expect(s.wins[0]!.destroyed).toBe(true)
    expect(s.wins[1]!.size).toEqual([2560, 1440])
  })

  it('sends a whole frame first, then the changed rectangles, while shown', async () => {
    const s = setup()
    await s.pump.prepare({ width: 4, height: 3 })
    const frames: Buffer[] = []
    s.pump.show({ sendFrame: (m) => (frames.push(m), true) })
    const w = s.wins[0]!
    expect(w.calls.slice(-3)).toEqual(['fps 60', 'start', 'invalidate'])
    w.paint({ x: 1, y: 1, width: 1, height: 1 }, image(4, 3))
    w.paint({ x: 1, y: 1, width: 2, height: 1 }, image(4, 3))
    expect(frameFields(frames[0]!)).toEqual([0, 0, 4, 3, 4, 3])
    expect(frameFields(frames[1]!)).toEqual([1, 1, 2, 1, 4, 3])
    // The pixels are the bitmap's rows.
    expect(frames[1]!.subarray(HEADER_BYTES + 24)).toEqual(image(4, 3).toBitmap().subarray(20, 28))

    s.pump.hide()
    expect(w.painting).toBe(false)
    w.paint({ x: 0, y: 0, width: 1, height: 1 }, image(4, 3))
    expect(frames).toHaveLength(2)
  })

  it('sends the whole image again after the pipe dropped a frame', async () => {
    const s = setup()
    await s.pump.prepare({ width: 4, height: 3 })
    const frames: Buffer[] = []
    let accept = false
    s.pump.show({ sendFrame: (m) => (frames.push(m), accept) })
    const w = s.wins[0]!
    w.paint({ x: 0, y: 0, width: 4, height: 3 }, image(4, 3))
    accept = true
    w.paint({ x: 1, y: 1, width: 1, height: 1 }, image(4, 3))
    w.paint({ x: 1, y: 1, width: 1, height: 1 }, image(4, 3))
    expect(frames.map(frameFields).map((f) => f.slice(0, 4))).toEqual([
      [0, 0, 4, 3],
      [0, 0, 4, 3],
      [1, 1, 1, 1]
    ])
  })

  it('uses the painted image size, so a rounded page size still fills the back buffer', async () => {
    const s = setup(1.5)
    await s.pump.prepare({ width: 5, height: 5 })
    const frames: Buffer[] = []
    s.pump.show({ sendFrame: (m) => (frames.push(m), true) })
    s.wins[0]!.paint({ x: 0, y: 0, width: 3, height: 3 }, image(5, 5))
    expect(frameFields(frames[0]!)).toEqual([0, 0, 5, 5, 5, 5])
  })

  it('fails to prepare when the page does not load, and blocks navigation away from the app', async () => {
    const s = setup()
    s.load.mockRejectedValueOnce(new Error('nope'))
    expect(await s.pump.prepare({ width: 10, height: 10 })).toBe(false)
    expect(s.wins[0]!.navigate('will-navigate', 'https://evil.example')).toBe(true)
    expect(s.wins[0]!.navigate('will-navigate', 'file:///app/index.html')).toBe(false)
    expect(await s.pump.prepare({ width: 0, height: 10 })).toBe(false)
  })

  it('sizes a new window even when its DIP size equals the last window size', async () => {
    const s = setup(1)
    await s.pump.prepare({ width: 1920, height: 1080 })
    // A 4K game on a 200% monitor: the same 1920x1080 DIP, in a new window (Electron's default size).
    s.scale.value = 2
    await s.pump.prepare({ width: 3840, height: 2160 })
    expect(s.wins).toHaveLength(2)
    expect(s.wins[1]!.size).toEqual([1920, 1080])
    expect(s.wins[1]!.calls).toContain('size 1920x1080')
  })

  it('makes the page again after its renderer crashed', async () => {
    const s = setup()
    await s.pump.prepare({ width: 1920, height: 1080 })
    s.wins[0]!.fire('render-process-gone', {}, { reason: 'crashed' })
    expect(s.wins[0]!.destroyed).toBe(true)
    expect(s.pump.window()).toBeNull()
    expect(await s.pump.prepare({ width: 1920, height: 1080 })).toBe(true)
    expect(s.wins).toHaveLength(2)
    expect(s.wins[1]!.size).toEqual([1920, 1080])
  })

  it('refuses a back buffer whose whole frame would not fit one message (8K)', async () => {
    const s = setup()
    expect(await s.pump.prepare({ width: 7680, height: 4320 })).toBe(false)
    expect(s.wins).toHaveLength(0)
    expect(await s.pump.prepare({ width: 3840, height: 2160 })).toBe(true)
  })

  it('destroys the window on dispose', async () => {
    const s = setup()
    await s.pump.prepare({ width: 10, height: 10 })
    s.pump.dispose()
    expect(s.wins[0]!.destroyed).toBe(true)
    expect(s.pump.window()).toBeNull()
    expect(await s.pump.prepare({ width: 10, height: 10 })).toBe(false)
  })
})
