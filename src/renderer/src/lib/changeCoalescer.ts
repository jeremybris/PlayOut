// Coalesces the main process's `library:changed` events into refreshes (state/library.ts). A trailing debounce
// alone never fires while events keep coming (the art pipeline emits one every 250 ms for minutes), so this is a
// debounce with a maximum wait: a refresh goes out `minMs` after the last event, and no later than `maxMs` after
// the first unhandled one. Events that name a few games refresh only those games (`onGames`); an event without
// ids, or more ids than `limit` since the last refresh, refreshes the whole snapshot (`onAll`).

export interface ChangeCoalescerOptions {
  /** Quiet time after the last event before a refresh (default 150 ms). */
  minMs?: number
  /** Longest an event waits for its refresh (default 500 ms). */
  maxMs?: number
  /** Up to this many distinct game ids are fetched one by one; more than that is a full refresh (default 50). */
  limit?: number
  onGames(ids: string[]): void
  onAll(): void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface ChangeCoalescer {
  /** One `library:changed`; `gameIds` undefined means "anything may have changed". */
  note(gameIds?: string[]): void
  /** Fire now whatever is pending (tests, teardown). */
  flush(): void
}

export function createChangeCoalescer(options: ChangeCoalescerOptions): ChangeCoalescer {
  const minMs = options.minMs ?? 150
  const maxMs = options.maxMs ?? 500
  const limit = options.limit ?? 50
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const ids = new Set<string>()
  let all = false
  let firstAt: number | null = null
  let timer: unknown = null

  function flush(): void {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    if (firstAt === null) return
    const full = all || ids.size > limit
    const pending = [...ids]
    ids.clear()
    all = false
    firstAt = null
    if (full) options.onAll()
    else if (pending.length) options.onGames(pending)
  }

  return {
    note(gameIds) {
      const t = now()
      firstAt ??= t
      if (!gameIds) all = true
      else for (const id of gameIds) ids.add(id)
      if (timer !== null) clearTimer(timer)
      const delay = Math.max(0, Math.min(minMs, firstAt + maxMs - t))
      timer = setTimer(flush, delay)
    },
    flush
  }
}
