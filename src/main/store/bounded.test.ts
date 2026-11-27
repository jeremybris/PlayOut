import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bounded, flushStores } from './bounded'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const never = (): Promise<never> => new Promise<never>(() => undefined)

describe('bounded', () => {
  it('resolves the value of a task that finishes in time and leaves no timer behind', async () => {
    await expect(bounded(Promise.resolve(5), 1000)).resolves.toEqual({ outcome: 'done', value: 5 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up waiting for a task that never settles', async () => {
    let result: unknown = null
    void bounded(never(), 1000).then((r) => {
      result = r
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(result).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toEqual({ outcome: 'timed out' })
  })

  it('reports a rejection or a synchronous throw as failed instead of rejecting', async () => {
    const error = new Error('disk full')
    await expect(bounded(Promise.reject(error), 1000)).resolves.toEqual({
      outcome: 'failed',
      error
    })
    await expect(
      bounded(() => {
        throw error
      }, 1000)
    ).resolves.toEqual({ outcome: 'failed', error })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('flushStores', () => {
  it('saves every store and names the ones that failed, threw or hung, within the limit', async () => {
    const saved = vi.fn(() => Promise.resolve(true))
    let unsaved: string[] | null = null
    void flushStores(
      {
        settings: { tryFlush: saved },
        library: { tryFlush: () => Promise.resolve(false) },
        sessions: { tryFlush: never },
        edits: {
          tryFlush: () => {
            throw new Error('broken')
          }
        }
      },
      3000
    ).then((names) => {
      unsaved = names
    })
    await vi.advanceTimersByTimeAsync(2999)
    expect(unsaved).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(unsaved).toEqual(['library', 'sessions', 'edits'])
    expect(saved).toHaveBeenCalledTimes(1)
  })

  it('resolves at once when every store saved', async () => {
    await expect(
      flushStores({ a: { tryFlush: () => Promise.resolve(true) } }, 3000)
    ).resolves.toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})
