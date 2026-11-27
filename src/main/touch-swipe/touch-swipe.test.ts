import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PadProcess, PadSpawn } from '../native-host/pad-reader'
import { createSwipeRecognizer, parseTouchLine, type TouchLine } from './gesture'
import { TOUCH_SWIPE_CS, touchSwipeScript } from './script'
import { createTouchSwipeWatcher } from './watcher'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this
  }
}

class FakeProc extends EventEmitter implements PadProcess {
  stdout = new FakeStream()
  stderr = new FakeStream()
  written = ''
  stdinEnded = false
  killed = false
  stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      this.written += chunk
      return true
    },
    end: () => {
      this.stdinEnded = true
    }
  })
  kill(): boolean {
    this.killed = true
    return true
  }
  out(text: string): void {
    this.stdout.emit('data', text)
  }
}

function fakeSpawn(): { spawn: PadSpawn; procs: FakeProc[] } {
  const procs: FakeProc[] = []
  return {
    procs,
    spawn: () => {
      const p = new FakeProc()
      procs.push(p)
      return p
    }
  }
}

/** Feeds lines to a recognizer and counts the swipes. */
function swipes(lines: string[]): number {
  let n = 0
  const r = createSwipeRecognizer(() => n++)
  for (const l of lines) r.feed(parseTouchLine(l) as TouchLine)
  return n
}

describe('parseTouchLine', () => {
  it('reads every kind of line and nothing else', () => {
    expect(parseTouchLine('{"ready":true,"touch":true}\r')).toEqual({ kind: 'ready', touch: true })
    expect(parseTouchLine('{"ready":true,"touch":false}')).toEqual({ kind: 'ready', touch: false })
    expect(parseTouchLine('d 40 600 1920 1200 1234')).toEqual({
      kind: 'down',
      x: 40,
      y: 600,
      width: 1920,
      height: 1200,
      ms: 1234
    })
    expect(parseTouchLine('m 300 610 1300\r')).toEqual({ kind: 'move', x: 300, y: 610, ms: 1300 })
    expect(parseTouchLine('u 1400')).toEqual({ kind: 'up', ms: 1400 })
    for (const bad of ['', 'd 1 2 0 0 5', 'm 1 x 3', 'u', 'q 1', '{"ready":false}', '{oops', 'Add-Type : error'])
      expect(parseTouchLine(bad)).toBeNull()
  })
})

describe('swipe from the left', () => {
  it('fires once when a touch near the left edge moves right far enough', () => {
    expect(swipes(['d 40 600 1920 1200 0', 'm 120 602 50', 'm 240 605 100', 'm 400 610 150', 'u 200'])).toBe(1)
  })

  it('fires before the finger lifts, and only once per touch', () => {
    let n = 0
    const r = createSwipeRecognizer(() => n++)
    for (const l of ['d 40 600 1920 1200 0', 'm 300 600 80']) r.feed(parseTouchLine(l) as TouchLine)
    expect(n).toBe(1)
    r.feed(parseTouchLine('m 900 600 120') as TouchLine)
    expect(n).toBe(1)
  })

  it('ignores touches that start too far in, go too short, too slowly or too steeply', () => {
    // 8% of 1920 = 153.6 px
    expect(swipes(['d 160 600 1920 1200 0', 'm 600 600 100', 'u 150'])).toBe(0)
    // 10% of 1920 = 192 px
    expect(swipes(['d 40 600 1920 1200 0', 'm 220 600 100', 'u 150'])).toBe(0)
    expect(swipes(['d 40 600 1920 1200 0', 'm 600 600 1000', 'u 1050'])).toBe(0)
    expect(swipes(['d 40 600 1920 1200 0', 'm 300 900 100', 'u 150'])).toBe(0)
    // a leftward move
    expect(swipes(['d 100 600 1920 1200 0', 'm 0 600 100', 'u 150'])).toBe(0)
  })

  it('scales with the monitor and needs a new touch after a lift', () => {
    expect(swipes(['d 20 300 800 1280 0', 'm 110 300 60', 'u 90'])).toBe(1)
    expect(swipes(['d 40 600 1920 1200 0', 'u 50', 'm 600 600 60'])).toBe(0)
    expect(swipes(['d 40 600 1920 1200 0', '{"ready":true,"touch":true}', 'm 600 600 60'])).toBe(0)
  })
})

describe('the script', () => {
  it('only looks at touch, never swallows input, and ends with its parent', () => {
    expect(TOUCH_SWIPE_CS).toContain('0xFF515780UL')
    expect(TOUCH_SWIPE_CS).toContain('return CallNextHookEx(')
    expect(TOUCH_SWIPE_CS).toContain('Environment.Exit(0)')
    // The here-string is followed by a blank line, or powershell -Command - never runs the Run line.
    expect(touchSwipeScript()).toContain("\n'@\n\n[PlayOutTouchSwipe]::Run()")
  })
})

describe('the watcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs only while wanted and opens the overlay on a swipe', () => {
    const { spawn, procs } = fakeSpawn()
    const onSwipe = vi.fn()
    const w = createTouchSwipeWatcher({ log, onSwipe, spawn })
    expect(procs).toHaveLength(0)
    w.set(true)
    w.set(true)
    expect(procs).toHaveLength(1)
    expect(procs[0].written).toContain('[PlayOutTouchSwipe]::Run()')
    procs[0].out('{"ready":true,"touch":true}\r\nd 40 600 1920 1200 0\r\nm 3')
    procs[0].out('00 600 80\r\n')
    expect(onSwipe).toHaveBeenCalledTimes(1)
    w.set(false)
    expect(procs[0].stdinEnded).toBe(true)
    expect(w.running()).toBe(false)
    vi.advanceTimersByTime(2000)
    expect(procs[0].killed).toBe(true)
  })

  it('restarts a watcher that dies, then gives up', () => {
    const { spawn, procs } = fakeSpawn()
    const w = createTouchSwipeWatcher({ log, onSwipe: vi.fn(), spawn })
    w.set(true)
    for (let i = 0; i < 3; i++) {
      procs[procs.length - 1].emit('exit', 1, null)
      vi.advanceTimersByTime(60_000)
    }
    expect(procs).toHaveLength(4)
    procs[3].emit('exit', 1, null)
    vi.advanceTimersByTime(60_000)
    expect(procs).toHaveLength(4)
    expect(log.error).toHaveBeenCalled()
    // A new start (the next game) tries again.
    w.set(false)
    w.set(true)
    expect(procs).toHaveLength(5)
    w.dispose()
  })
})
