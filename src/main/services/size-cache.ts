// The local cache of store sizes (ARCHITECTURE.md §4.11): what api.steamcmd.net, GOG and the Steam store answered,
// keyed by store id ("steam:620", "gog:1207658924", "search:hades" -> a Steam app id, "req:620"). A game imported
// again, a second copy of the same game or a library reset reuses the answer instead of asking the store again.
// Answers of "none" are kept too; failures never are.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Logger } from '../logger'
import { describeError } from '../scrapers/steam-store'

/** An answer is asked again after this long. */
export const SIZE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
/**
 * `refresh` (the full scan of a run) asks again only answers older than this: several launches in a day do not ask
 * api.steamcmd.net for every game each time.
 */
export const SIZE_REFRESH_AGE_MS = 12 * 60 * 60 * 1000
/** Writes are coalesced: a background pass answers hundreds of games in a row. */
const WRITE_DELAY_MS = 2000

interface Entry {
  /** The number the store gave (bytes, or a Steam app id for a search); null = it had none. */
  value: number | null
  at: number
}

export interface SizeCache {
  /**
   * The cached answer for `key` while it is fresh, else `fetch`'s (stored unless it throws). Concurrent asks for one
   * key share one fetch.
   */
  get(
    key: string,
    fetch: () => Promise<number | undefined>,
    options?: { refresh?: boolean }
  ): Promise<number | undefined>
  /** Write pending changes now (on quit). */
  flush(): Promise<void>
}

/** `file` null keeps the cache in memory only (tests). */
export function createSizeCache(file: string | null, log: Logger): SizeCache {
  let entries: Map<string, Entry> | null = null
  let loading: Promise<Map<string, Entry>> | null = null
  const inflight = new Map<string, Promise<number | undefined>>()
  /** Keys fetched since the app started: `refresh` asks the store again only once per run. */
  const fetchedThisRun = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  let writing: Promise<void> = Promise.resolve()

  function load(): Promise<Map<string, Entry>> {
    if (entries) return Promise.resolve(entries)
    loading ??= (async () => {
      const map = new Map<string, Entry>()
      if (file) {
        try {
          const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const [key, value] of Object.entries(raw as Record<string, Entry>)) {
              // Expired answers are dropped here, so the file does not keep every key ever asked.
              if (
                value &&
                typeof value.at === 'number' &&
                Date.now() - value.at < SIZE_CACHE_TTL_MS &&
                (value.value === null || typeof value.value === 'number')
              )
                map.set(key, value)
            }
          }
        } catch {
          // No cache yet, or an unreadable one: start empty.
        }
      }
      entries = map
      return map
    })()
    return loading
  }

  function write(): Promise<void> {
    if (!file || !entries) return Promise.resolve()
    const text = JSON.stringify(Object.fromEntries(entries))
    writing = writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        const temp = `${file}.${process.pid}.tmp`
        await writeFile(temp, text, 'utf8')
        await rename(temp, file)
      })
      .catch((err) => log.warn(`install size cache: write failed: ${describeError(err)}`))
    return writing
  }

  function schedule(): void {
    if (!file || timer) return
    timer = setTimeout(() => {
      timer = null
      void write()
    }, WRITE_DELAY_MS)
    timer.unref?.()
  }

  return {
    async get(key, fetch, options = {}) {
      const map = await load()
      const hit = map.get(key)
      const age = hit ? Date.now() - hit.at : Number.POSITIVE_INFINITY
      const refresh = !!options.refresh && !fetchedThisRun.has(key) && age >= SIZE_REFRESH_AGE_MS
      if (hit && !refresh && age < SIZE_CACHE_TTL_MS) return hit.value ?? undefined
      const running = inflight.get(key)
      if (running) return running
      // A refresh that fails keeps the answer it was refreshing: a store being down must not erase a known size.
      const fallback = refresh && hit && age < SIZE_CACHE_TTL_MS ? hit : null
      const task = fetch()
        .then(
          (value) => {
            fetchedThisRun.add(key)
            map.set(key, { value: value ?? null, at: Date.now() })
            schedule()
            return value
          },
          (err: unknown) => {
            if (!fallback) throw err
            // Not asked again this run; the old answer keeps its age, so the next run tries again.
            fetchedThisRun.add(key)
            return fallback.value ?? undefined
          }
        )
        .finally(() => inflight.delete(key))
      inflight.set(key, task)
      return task
    },
    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await write()
    }
  }
}
