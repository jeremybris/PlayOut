/**
 * Recognises a swipe from the left edge in the touch watcher's lines (script.ts): a touch that goes down near the
 * left edge of its monitor and moves right far enough, quickly and mostly sideways. One swipe fires once, when it has
 * gone far enough (the finger need not lift first).
 */

export type TouchLine =
  | { kind: 'ready'; touch: boolean }
  | { kind: 'down'; x: number; y: number; width: number; height: number; ms: number }
  | { kind: 'move'; x: number; y: number; ms: number }
  | { kind: 'up'; ms: number }

const num = (s: string | undefined): number | null => {
  if (s === undefined || !/^-?\d+$/.test(s)) return null
  return Number(s)
}

/** One stdout line of the watcher, or null for anything else (PowerShell noise). */
export function parseTouchLine(line: string): TouchLine | null {
  const text = line.trim()
  if (text.startsWith('{')) {
    try {
      const v = JSON.parse(text) as { ready?: unknown; touch?: unknown }
      return v.ready === true ? { kind: 'ready', touch: v.touch === true } : null
    } catch {
      return null
    }
  }
  const [k, ...rest] = text.split(' ')
  const n = rest.map(num)
  if (n.some((v) => v === null)) return null
  const [a, b, c, d, e] = n as number[]
  if (k === 'd' && n.length === 5 && c > 0 && d > 0)
    return { kind: 'down', x: a, y: b, width: c, height: d, ms: e }
  if (k === 'm' && n.length === 3) return { kind: 'move', x: a, y: b, ms: c }
  if (k === 'u' && n.length === 1) return { kind: 'up', ms: a }
  return null
}

/** How far in a swipe may start: this share of the monitor's width. */
export const SWIPE_EDGE = 0.08
/** How far right it must go: this share of the monitor's width. */
export const SWIPE_DISTANCE = 0.1
/** Within this long of going down (ms). */
export const SWIPE_MAX_MS = 900
/** Sideways enough: the vertical drift may be at most this share of the distance moved right. */
export const SWIPE_MAX_SLOPE = 0.7

export interface SwipeRecognizer {
  feed(line: TouchLine): void
}

export function createSwipeRecognizer(onSwipe: () => void): SwipeRecognizer {
  let stroke: { x: number; y: number; width: number; ms: number } | null = null

  function check(x: number, y: number, ms: number): void {
    if (!stroke) return
    if (ms - stroke.ms > SWIPE_MAX_MS) {
      stroke = null
      return
    }
    const dx = x - stroke.x
    if (dx >= stroke.width * SWIPE_DISTANCE && Math.abs(y - stroke.y) <= dx * SWIPE_MAX_SLOPE) {
      stroke = null
      onSwipe()
    }
  }

  return {
    feed(line) {
      switch (line.kind) {
        case 'down':
          stroke =
            line.x <= line.width * SWIPE_EDGE
              ? { x: line.x, y: line.y, width: line.width, ms: line.ms }
              : null
          return
        case 'move':
          check(line.x, line.y, line.ms)
          return
        case 'up':
          stroke = null
          return
        default:
          stroke = null
      }
    }
  }
}
