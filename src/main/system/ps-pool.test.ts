import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPsPool } from './ps-pool'
import { PsError, type PsWorker } from './ps-worker'

/** A fake worker: each script waits until the test answers it (by script text), like a slow folder walk. */
function fakeWorkers(): {
  create: () => PsWorker
  made: PsWorker[]
  answer: (script: string, value: unknown) => void
  started: string[]
} {
  const made: PsWorker[] = []
  const pending = new Map<string, (v: unknown) => void>()
  const started: string[] = []
  const create = (): PsWorker => {
    const rejects = new Set<(e: PsError) => void>()
    let disposed = false
    const worker: PsWorker = {
      run: <T>(script: string) =>
        new Promise<T | null>((resolve, reject) => {
          if (disposed) return reject(new PsError('disposed', 'disposed'))
          started.push(script)
          rejects.add(reject)
          pending.set(script, (v) => {
            rejects.delete(reject)
            resolve(v as T)
          })
        }),
      isRunning: () => !disposed,
      dispose: vi.fn(() => {
        disposed = true
        for (const r of rejects) r(new PsError('disposed', 'disposed'))
        rejects.clear()
      })
    }
    made.push(worker)
    return worker
  }
  return {
    create,
    made,
    started,
    answer: (script, value) => pending.get(script)?.(value)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createPsPool', () => {
  it("runs a short script beside a long one (no waiting behind another game's measure)", async () => {
    const f = fakeWorkers()
    const pool = createPsPool({ size: 2, create: f.create })
    const long = pool.run('huge game')
    const short = pool.run('small game')
    expect(f.started).toEqual(['huge game', 'small game'])
    f.answer('small game', 1)
    expect(await short).toBe(1)
    f.answer('huge game', 2)
    expect(await long).toBe(2)
    expect(f.made).toHaveLength(2)
    pool.dispose()
  })

  it('queues past its size and hands the first free worker to the next script', async () => {
    const f = fakeWorkers()
    const pool = createPsPool({ size: 1, create: f.create })
    const a = pool.run('a')
    const b = pool.run('b')
    expect(f.started).toEqual(['a'])
    f.answer('a', 'A')
    expect(await a).toBe('A')
    await vi.waitFor(() => expect(f.started).toEqual(['a', 'b']))
    f.answer('b', 'B')
    expect(await b).toBe('B')
    expect(f.made).toHaveLength(1)
    pool.dispose()
  })

  it('ends idle workers after a while', async () => {
    vi.useFakeTimers()
    const f = fakeWorkers()
    const pool = createPsPool({ size: 2, create: f.create, idleMs: 1000 })
    const a = pool.run('a')
    f.answer('a', 1)
    await a
    await vi.advanceTimersByTimeAsync(1001)
    expect(f.made[0]!.dispose).toHaveBeenCalled()
    // The next script starts a new worker.
    const b = pool.run('b')
    expect(f.made).toHaveLength(2)
    f.answer('b', 2)
    expect(await b).toBe(2)
    pool.dispose()
  })

  it('dispose stops running and waiting scripts', async () => {
    const f = fakeWorkers()
    const pool = createPsPool({ size: 1, create: f.create })
    const running = pool.run('a')
    const queued = pool.run('b')
    pool.dispose()
    await expect(running).rejects.toMatchObject({ code: 'disposed' })
    await expect(queued).rejects.toMatchObject({ code: 'disposed' })
    await expect(pool.run('c')).rejects.toMatchObject({ code: 'disposed' })
  })
})
