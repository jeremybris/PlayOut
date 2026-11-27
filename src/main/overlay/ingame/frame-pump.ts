import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron'
import type { Logger } from '../../logger'
import { isAppUrl } from '../../util/app-origin'
import { overlayWindowOptions } from '../overlay-window'
import { encodeFrame, type FrameRect, FRAME_HEADER_BYTES, MAX_PAYLOAD_BYTES } from './protocol'
import type { IngamePump } from './session'

/**
 * The in-game overlay's frames (docs/home-overlay.md, "In-game overlay"): a hidden offscreen BrowserWindow renders
 * the overlay page (index.html?overlay=1&ingame=1) at the game's back-buffer size, and every paint goes down the pipe
 * as a FRAME holding the part that changed. It is created on the first in-game open and kept, so the next open is
 * quick; it receives the app's events like the overlay window (suite.ingameWindow).
 */

export const FRAME_RATE = 60

/** Electron's paint rectangle. */
export interface PaintRect {
  x: number
  y: number
  width: number
  height: number
}

/** The part of a NativeImage the pump reads. */
export interface PumpImage {
  getSize(): { width: number; height: number }
  toBitmap(): Buffer
}

/** The part of an offscreen BrowserWindow the pump drives (a fake in tests). */
export interface PumpWin {
  isDestroyed(): boolean
  destroy(): void
  setSize(width: number, height: number): void
  getSize(): number[]
  on(event: 'closed', listener: () => void): unknown
  webContents: {
    setFrameRate(fps: number): void
    startPainting(): void
    stopPainting(): void
    invalidate(): void
    on(
      event: 'paint',
      listener: (event: unknown, dirty: PaintRect, image: PumpImage) => void
    ): unknown
    on(
      event: 'will-navigate' | 'will-redirect',
      listener: (event: { preventDefault(): void }, url: string) => void
    ): unknown
    on(
      event: 'render-process-gone',
      listener: (event: unknown, details: { reason: string }) => void
    ): unknown
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  }
}

export interface FramePumpDeps {
  log: Logger
  preload: string
  /** Load index.html?overlay=1&ingame=1 into the window. */
  load: (win: BrowserWindow) => Promise<void>
  /** The display scale factor the page renders with (the game's monitor). */
  scaleFactor: () => number
  /** Window factory (tests pass a fake). Defaults to `new BrowserWindow(options)`. */
  createWindow?: (options: BrowserWindowConstructorOptions) => PumpWin
}

export interface FramePump extends IngamePump {
  /** The offscreen window, for the event broadcast (null before the first in-game open). */
  window(): BrowserWindow | null
  dispose(): void
}

/** The offscreen window: the overlay window's options, offscreen at `scale`, never shown. */
export function framePumpOptions(preload: string, scale: number): BrowserWindowConstructorOptions {
  const base = overlayWindowOptions(preload)
  return {
    ...base,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    focusable: false,
    title: 'PlayOut in-game overlay',
    webPreferences: {
      ...base.webPreferences,
      offscreen: { useSharedTexture: false, deviceScaleFactor: scale }
    }
  }
}

/**
 * Electron's paint rectangle may be in DIP or in pixels: the rectangle sent covers both readings (the second one
 * scaled by `ratio`, pixels per DIP), so no change is ever missed.
 */
export function dirtyPixels(dirty: FrameRect, ratio: number): FrameRect {
  if (!(ratio > 0) || Math.abs(ratio - 1) < 1e-6) return dirty
  const x = Math.min(dirty.x, dirty.x * ratio)
  const y = Math.min(dirty.y, dirty.y * ratio)
  const right = Math.max(dirty.x + dirty.w, (dirty.x + dirty.w) * ratio)
  const bottom = Math.max(dirty.y + dirty.h, (dirty.y + dirty.h) * ratio)
  return { x, y, w: right - x, h: bottom - y }
}

export function createFramePump(deps: FramePumpDeps): FramePump {
  const { log } = deps
  const makeWindow =
    deps.createWindow ?? ((options) => new BrowserWindow(options) as unknown as PumpWin)
  let win: PumpWin | null = null
  let winScale = 1
  let loaded: Promise<boolean> = Promise.resolve(false)
  let sink: { sendFrame(message: Buffer): boolean } | null = null
  let needFull = true
  /** The page's size in DIP. */
  let dip = { width: 0, height: 0 }
  let disposed = false

  const alive = (): PumpWin | null => (win && !win.isDestroyed() ? win : null)

  const onPaint = (dirty: PaintRect, image: PumpImage): void => {
    if (!sink) return
    const size = image.getSize()
    if (!size.width || !size.height) return
    const rect: FrameRect = { x: dirty.x, y: dirty.y, w: dirty.width, h: dirty.height }
    const full = needFull || !rect.w || !rect.h
    const area = full
      ? { x: 0, y: 0, w: size.width, h: size.height }
      : dirtyPixels(rect, dip.width ? size.width / dip.width : 1)
    let message: Buffer | null
    try {
      message = encodeFrame(image.toBitmap(), size.width, size.height, area)
    } catch (err) {
      log.warn('ingame: frame could not be encoded', err)
      needFull = true
      return
    }
    if (!message) return
    // A frame the pipe could not take is lost: the next one goes whole.
    needFull = !sink.sendFrame(message)
  }

  function create(scale: number): PumpWin {
    const w = makeWindow(framePumpOptions(deps.preload, scale))
    win = w
    winScale = scale
    // A new window has Electron's default size: prepare() sizes it whatever the last window's size was.
    dip = { width: 0, height: 0 }
    needFull = true
    w.on('closed', () => {
      if (win === w) {
        win = null
        sink = null
        dip = { width: 0, height: 0 }
      }
    })
    // A page that crashed paints nothing: the window is dropped, so the next prepare() makes a new one (and the open
    // in progress, if any, falls back to the window overlay rather than showing nothing over a blocked game).
    w.webContents.on('render-process-gone', (_event, details) => {
      log.warn(
        `ingame: overlay page gone (${details?.reason ?? 'unknown'}); it is made again next time`
      )
      if (win === w) {
        win = null
        sink = null
        dip = { width: 0, height: 0 }
      }
      if (!w.isDestroyed()) w.destroy()
    })
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    const guard = (event: { preventDefault(): void }, url: string): void => {
      if (isAppUrl(url)) return
      event.preventDefault()
      log.warn(`ingame: blocked navigation to ${url}`)
    }
    w.webContents.on('will-navigate', guard)
    w.webContents.on('will-redirect', guard)
    w.webContents.on('paint', (_event, dirty, image) => {
      if (win === w) onPaint(dirty, image)
    })
    w.webContents.setFrameRate(FRAME_RATE)
    // Nothing is painted until the overlay is shown in a game.
    w.webContents.stopPainting()
    loaded = deps.load(w as unknown as BrowserWindow).then(
      () => true,
      (err) => {
        log.error('ingame: overlay page load failed', err)
        return false
      }
    )
    log.info(`ingame: offscreen overlay window created (scale ${scale})`)
    return w
  }

  return {
    async prepare({ width, height }) {
      if (disposed || width <= 0 || height <= 0) return false
      // A whole frame must fit one message (8K back buffers do not): the window overlay is used then.
      if (width * height * 4 + FRAME_HEADER_BYTES > MAX_PAYLOAD_BYTES) {
        log.info(`ingame: a ${width}x${height} back buffer is too large for the overlay's frames`)
        return false
      }
      let scale = 1
      try {
        const s = deps.scaleFactor()
        if (Number.isFinite(s) && s > 0) scale = s
      } catch {
        /* 1 */
      }
      let w = alive()
      // The scale is fixed when the window is made: a different one needs a new window.
      if (w && Math.abs(winScale - scale) > 1e-3) {
        sink = null
        w.destroy()
        win = null
        w = null
      }
      if (!w) w = create(scale)
      if (!(await loaded)) return false
      if (alive() !== w) return false
      const next = {
        width: Math.max(1, Math.round(width / scale)),
        height: Math.max(1, Math.round(height / scale))
      }
      if (next.width !== dip.width || next.height !== dip.height) {
        w.setSize(next.width, next.height)
        dip = next
        needFull = true
        log.info(
          `ingame: overlay page at ${next.width}x${next.height} DIP (scale ${scale}) for a ${width}x${height} back buffer`
        )
      }
      if (sink) w.webContents.invalidate()
      return true
    },
    show(next) {
      const w = alive()
      if (!w) return
      sink = next
      needFull = true
      w.webContents.setFrameRate(FRAME_RATE)
      w.webContents.startPainting()
      w.webContents.invalidate()
    },
    hide() {
      sink = null
      const w = alive()
      if (w) w.webContents.stopPainting()
    },
    window: () => alive() as unknown as BrowserWindow | null,
    dispose() {
      disposed = true
      sink = null
      const w = alive()
      win = null
      if (w) w.destroy()
    }
  }
}
