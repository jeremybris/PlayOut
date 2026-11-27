/** How a step that was given a time limit ended. */
export type Bounded<T> =
  { outcome: 'done'; value: T } | { outcome: 'failed'; error: unknown } | { outcome: 'timed out' }

/**
 * Wait for `task`, but no longer than `ms`. Never rejects and never hangs: a task that throws or rejects resolves as
 * 'failed', one still running after `ms` as 'timed out' (it keeps running; only the wait ends). For the saves and
 * disposes on the way out (main/index.ts), where one step that never settles must not keep PlayOut from closing.
 */
export function bounded<T>(task: Promise<T> | (() => Promise<T>), ms: number): Promise<Bounded<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ outcome: 'timed out' }), ms)
    const settle = (result: Bounded<T>): void => {
      clearTimeout(timer)
      resolve(result)
    }
    let running: Promise<T>
    try {
      running = typeof task === 'function' ? task() : task
    } catch (error) {
      settle({ outcome: 'failed', error })
      return
    }
    Promise.resolve(running).then(
      (value) => settle({ outcome: 'done', value }),
      (error: unknown) => settle({ outcome: 'failed', error })
    )
  })
}

/** A store that can report whether its save reached the disk (JsonStore and the stores built on it). */
export interface FlushableStore {
  tryFlush(): Promise<boolean>
}

/**
 * Save every store, each within `ms`; resolves the names of those that were not saved in time (write failed, threw
 * or still writing). Never rejects, so it is safe on the way out and in the last-resort error handler.
 */
export async function flushStores(
  stores: Readonly<Record<string, FlushableStore>>,
  ms: number
): Promise<string[]> {
  const names = Object.keys(stores)
  const results = await Promise.all(names.map((name) => bounded(() => stores[name].tryFlush(), ms)))
  return names.filter((_, i) => {
    const result = results[i]
    return !(result.outcome === 'done' && result.value)
  })
}
