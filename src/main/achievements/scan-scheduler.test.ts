import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '../scrapers/http'
import {
  createScanRecord,
  createScanRunner,
  failEntries,
  lastSessionTimes,
  playedAfter,
  readEntry,
  SCAN_PARK_AFTER,
  scanBackoff,
  scanDue,
  sharedFailure,
  type ScanEntry
} from './scan-scheduler'

const HOUR = 60 * 60 * 1000

describe('scanDue and playedAfter', () => {
  const at = Date.parse('2026-11-01T12:00:00Z')
  const played =
    (game: { lastPlayed?: string }, entry: ScanEntry, lastSession?: number) => (since: number) =>
      playedAfter(game, entry, since, lastSession)

  it('reads a game never read, and one whose failed read waited long enough', () => {
    expect(scanDue(undefined, at, () => false)).toBe(true)
    expect(scanDue({ fails: 1, retryAt: at + 1000 }, at, () => false)).toBe(false)
    expect(scanDue({ fails: 1, retryAt: at - 1 }, at, () => false)).toBe(true)
  })

  it('reads a game again only after it was played since its last read', () => {
    const entry: ScanEntry = { at, seen: '2026-10-30T10:00:00.000Z' }
    const game = { lastPlayed: '2026-10-30T10:00:00.000Z' }
    expect(scanDue(entry, at + HOUR, played(game, entry))).toBe(false)
    // A PlayOut session ended after the read, a paired PC's session arrived, or the last played moved on.
    expect(
      scanDue(
        { ...entry, playedAt: at + 1 },
        at + HOUR,
        played(game, { ...entry, playedAt: at + 1 })
      )
    ).toBe(true)
    expect(scanDue(entry, at + HOUR, played(game, entry, at + 5))).toBe(true)
    const later = { lastPlayed: '2026-11-02T10:00:00.000Z' }
    expect(scanDue(entry, at + HOUR, played(later, entry))).toBe(true)
  })

  it('keeps a parked game until it is played', () => {
    const entry: ScanEntry = { fails: SCAN_PARK_AFTER, parkedAt: at }
    expect(scanDue(entry, at + 100 * HOUR, played({}, entry))).toBe(false)
    expect(scanDue(entry, at + 100 * HOUR, played({}, entry, at + 10))).toBe(true)
  })

  it('records the last played seen and keeps a session that ended after the read', () => {
    expect(readEntry({ lastPlayed: 'x' }, { playedAt: at + 5 }, at)).toEqual({
      at,
      seen: 'x',
      playedAt: at + 5
    })
    expect(readEntry({}, { playedAt: at - 5 }, at)).toEqual({ at, seen: null })
  })

  it('takes the newest session of each game, a synced one by when it arrived', () => {
    const times = lastSessionTimes([
      { gameId: 'a', endedAt: '2026-11-01T00:00:00Z' },
      { gameId: 'a', endedAt: '2026-10-01T00:00:00Z', syncedAt: '2026-11-03T00:00:00Z' },
      { gameId: 'b' }
    ])
    expect(times.get('a')).toBe(Date.parse('2026-11-03T00:00:00Z'))
    expect(times.has('b')).toBe(false)
  })
})

describe('failEntries', () => {
  it('waits longer after each failure and parks a game after five in a row', () => {
    const table: Record<string, ScanEntry> = { a: { at: 1 } }
    const now = 1_000_000
    expect(failEntries(table, ['a'], 1000, new Error('x'), now)).toBe(now + 1000)
    expect(failEntries(table, ['a'], 1000, new Error('x'), now)).toBe(now + 2000)
    for (let i = 2; i < SCAN_PARK_AFTER - 1; i++)
      failEntries(table, ['a'], 1000, new Error('x'), now)
    expect(failEntries(table, ['a'], 1000, new Error('x'), now)).toBe(Number.POSITIVE_INFINITY)
    expect(table.a).toMatchObject({ at: 1, fails: SCAN_PARK_AFTER, parkedAt: now })
    expect(table.a.retryAt).toBeUndefined()
  })

  it("waits at least as long as the server's Retry-After", () => {
    const table: Record<string, ScanEntry> = {}
    const err = new HttpError('slow down', { status: 429, url: 'https://x', retryAfterMs: 60_000 })
    expect(failEntries(table, ['a'], 1000, err, 0)).toBe(60_000)
    expect(sharedFailure(err)).toBe(true)
    expect(sharedFailure(new HttpError('gone', { status: 404, url: 'https://x' }))).toBe(false)
    expect(scanBackoff(1000, 40)).toBe(6 * HOUR)
  })
})

describe('createScanRecord', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-scan-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const write = async (file: string, value: unknown): Promise<void> => {
    await fs.writeFile(file, JSON.stringify(value))
  }

  it('gives parked games one more try on start, applies an early change once read, and drops games that left', async () => {
    const file = join(dir, 'scans.json')
    await write(file, { a: { at: 1, fails: 5, parkedAt: 2 }, b: { at: 1 }, gone: { at: 1 } })
    const record = createScanRecord<ScanEntry & { none?: boolean }>({
      file,
      keep: (id) => id !== 'gone',
      write,
      onSaveError: vi.fn()
    })
    record.change((t) => {
      delete t.b
    })
    expect(record.loaded()).toBeNull()
    const table = await record.load()
    expect(table.a).toEqual({ at: 1 })
    expect(table.b).toBeUndefined()
    await record.save()
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ a: { at: 1 } })
  })
})

describe('createScanRunner', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs one pass at a time, and once more for a call made during one', async () => {
    let release: () => void = () => undefined
    const pass = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const runner = createScanRunner({
      startDelayMs: 0,
      kickDelayMs: 5,
      backoffMs: 1000,
      pass,
      onError: vi.fn()
    })
    const first = runner.run()
    void runner.run()
    release()
    await new Promise((r) => setTimeout(r, 0))
    release()
    await first
    expect(pass).toHaveBeenCalledTimes(2)
    runner.dispose()
  })

  it('waits for the start delay, then pauses longer after each failure until a pass goes through', async () => {
    vi.useFakeTimers()
    const pass = vi.fn(async () => undefined)
    const runner = createScanRunner({
      startDelayMs: 1000,
      kickDelayMs: 5,
      backoffMs: 100,
      pass,
      onError: vi.fn()
    })
    await runner.run()
    expect(pass).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(pass).toHaveBeenCalledTimes(1)
    expect(runner.pause()).toBe(100)
    expect(runner.pausedFor()).toBeGreaterThan(0)
    // A kick does not cut the pause short; the pass runs once it is over.
    runner.kick()
    await vi.advanceTimersByTimeAsync(50)
    expect(pass).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60)
    expect(pass).toHaveBeenCalledTimes(2)
    // A second failure in a row waits twice as long; a pass that went through starts over.
    expect(runner.pause()).toBe(200)
    runner.passed()
    expect(runner.pause()).toBe(100)
    runner.clearPause()
    expect(runner.pausedFor()).toBe(0)
    runner.dispose()
  })
})
