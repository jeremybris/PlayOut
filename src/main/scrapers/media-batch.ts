// Media batcher (docs/ARCHITECTURE.md §4.6 "Art pipeline", "Library writes"): landed art is written through
// `library.setMediaBatch` at most once per `intervalMs`, with the first item of a quiet period written at once
// (so the first cover of a run is visible without waiting for the window to close), so the renderer sees ~4
// `library:changed` a second during a 3,000-game run instead of one per image. There is no item cap: the local
// stage lands ~1,000 covers a second and a cap would flush every few milliseconds, which the renderer's trailing
// debounce never gets to act on. `has` answers "pending but not yet flushed", which is what keeps the full lane
// from downloading a kind the cover lane just landed. Negative items (`missing`) ride the same flushes.
import type { MediaBatchItem } from '../services/library-service'

export interface MediaBatcherOptions {
  intervalMs?: number
  /** Flush when this many items are pending even inside the interval; unbounded by default (tests only). */
  maxItems?: number
  /** Called after every flush that wrote something (the metadata service rides its progress event on it). */
  onFlush?: (items: MediaBatchItem[]) => void
}

export interface MediaBatcher {
  add(item: MediaBatchItem): void
  /** True while a landed file for this game and kind is waiting for the next flush (negative items never count). */
  has(gameId: string, kind: MediaBatchItem['kind']): boolean
  /** Write everything pending now (dispose, the end of a run, a caller about to read the game back). */
  flush(): void
  /** Flush and stop the timer; later `add`s are written immediately. */
  dispose(): void
  readonly pending: number
}

const DEFAULT_INTERVAL_MS = 250

/** What the batcher writes through: `LibraryService.setMediaBatch` or a wrapper around it. */
export type MediaBatchSink = {
  setMediaBatch(items: MediaBatchItem[]): unknown
}

export function createMediaBatcher(
  library: MediaBatchSink,
  options: MediaBatcherOptions = {}
): MediaBatcher {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const maxItems = Math.max(1, options.maxItems ?? Number.POSITIVE_INFINITY)
  let items: MediaBatchItem[] = []
  const keys = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  let disposed = false
  let lastFlushAt = Number.NEGATIVE_INFINITY

  const keyOf = (gameId: string, kind: string): string => `${gameId}|${kind}`

  function flush(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!items.length) return
    lastFlushAt = Date.now()
    const batch = items
    items = []
    keys.clear()
    library.setMediaBatch(batch)
    options.onFlush?.(batch)
  }

  return {
    add(item) {
      if (item.url) {
        // A later item for the same game and kind replaces the earlier one (the fallback chain landed a better file).
        const key = keyOf(item.gameId, item.kind)
        if (keys.has(key)) items = items.filter((i) => !i.url || keyOf(i.gameId, i.kind) !== key)
        keys.add(key)
      }
      items.push(item)
      const sinceFlush = Date.now() - lastFlushAt
      if (disposed || items.length >= maxItems || sinceFlush >= intervalMs) {
        flush()
        return
      }
      if (!timer) {
        timer = setTimeout(flush, Math.max(0, intervalMs - sinceFlush))
        timer.unref?.()
      }
    },
    has: (gameId, kind) => keys.has(keyOf(gameId, kind)),
    flush,
    dispose() {
      disposed = true
      flush()
    },
    get pending() {
      return items.length
    }
  }
}
