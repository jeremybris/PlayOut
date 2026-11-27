import { afterAll, describe, expect, it, vi } from 'vitest'
import { createPsWorker, PsError, type PsWorker } from './ps-worker'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const onWindows = process.platform === 'win32'

const workers: PsWorker[] = []
function worker(options: Parameters<typeof createPsWorker>[0] = { log }): PsWorker {
  const w = createPsWorker(options)
  workers.push(w)
  return w
}

afterAll(() => {
  for (const w of workers) w.dispose()
})

describe.skipIf(!onWindows)('powershell worker', () => {
  it('answers scripts from one warm process and reports script errors', async () => {
    const w = worker({ log, init: '$global:PlayOutTestInit = 41' })
    const t0 = performance.now()
    expect(await w.run<number>('1 + 1')).toBe(2)
    const coldMs = Math.round(performance.now() - t0)
    expect(w.isRunning()).toBe(true)

    const t1 = performance.now()
    expect(await w.run<number>('$global:PlayOutTestInit + 1')).toBe(42)
    const warmMs = Math.round(performance.now() - t1)
    expect(warmMs).toBeLessThan(coldMs)

    expect(await w.run('$null')).toBeNull()
    expect(await w.run<{ a: number; b: string }>("@{ a = 1; b = 'x' }")).toEqual({ a: 1, b: 'x' })
    expect(await w.run<number[]>('1, 2, 3')).toEqual([1, 2, 3])
    expect(await w.run<string>("'Command & Conquer™'")).toBe('Command & Conquer™')

    await expect(w.run("throw 'boom'")).rejects.toMatchObject({
      name: 'PsError',
      code: 'script',
      message: 'boom'
    })
    // The process survives a script error.
    expect(await w.run<number>('5')).toBe(5)
    console.info(`[ps-worker] cold ${coldMs} ms, warm ${warmMs} ms`)
  }, 30_000)

  it('serialises concurrent runs in order', async () => {
    const w = worker()
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => w.run<number>(`Start-Sleep -Milliseconds 20; ${n}`))
    )
    expect(results).toEqual([1, 2, 3, 4, 5])
  }, 30_000)

  it('times out a stuck script, restarts the process and keeps serving', async () => {
    const w = worker()
    expect(await w.run<number>('1')).toBe(1)
    const t0 = performance.now()
    await expect(w.run('Start-Sleep -Seconds 30', { timeoutMs: 500 })).rejects.toMatchObject({
      code: 'timeout'
    })
    expect(performance.now() - t0).toBeLessThan(5_000)
    expect(await w.run<number>('2', { timeoutMs: 15_000 })).toBe(2)
  }, 40_000)

  it('rejects everything after dispose', async () => {
    const w = worker()
    expect(await w.run<number>('1')).toBe(1)
    w.dispose()
    expect(w.isRunning()).toBe(false)
    await expect(w.run('1')).rejects.toBeInstanceOf(PsError)
    await expect(w.run('1')).rejects.toMatchObject({ code: 'disposed' })
  }, 30_000)

  it('falls back to one-shot processes when the executable cannot be spawned repeatedly', async () => {
    const w = worker({ log, exe: 'playout-no-such-powershell.exe' })
    // Three failed spawns within a minute trigger the cooldown; the queued job then runs in a fresh process.
    expect(await w.run<number>('7', { timeoutMs: 15_000 })).toBe(7)
    expect(w.isRunning()).toBe(false)
  }, 40_000)
})
