import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import type { InstallQueueEntry } from '../../shared/types'
import { EventBus } from '../events'
import {
  createInstallQueue,
  MAX_QUEUE_ENTRIES,
  type InstallQueue,
  type InstallQueueItem,
  type InstallQueueRunner
} from './queue'

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** A runner whose downloads end when the test says so. */
interface FakeRunner extends InstallQueueRunner {
  started: { gameId: string; resumed: boolean }[]
  /** One per start that returned a download: its own end and whether its own stop ran. */
  runs: { gameId: string; signal: AbortSignal; stopped: boolean; ended: boolean }[]
  /** The signal of each start, in order. */
  signals: AbortSignal[]
  stopped: string[]
  /** The reason each stop got, in order. */
  stopReasons: (string | undefined)[]
  reported: { gameId: string; message: string }[]
  /** End the download of this game ('retry': its source could not be reached). */
  finish(gameId: string, outcome?: 'retry' | 'finished'): void
  /** Runs of these games are not ended by their stop (past their transfer: they finish by themselves). */
  lingerOnStop?: Set<string>
  /** The `handedOff` option of each start, in order. */
  handedOff: boolean[]
  /** Each start's `markHandedOff`, by game. */
  marks: Map<string, () => void>
  /** Games `ready` holds back. */
  notReady: Set<string>
  /** The next start of this game fails with this message. */
  failNext: Map<string, string>
  skipIds: Set<string>
  /** Starts of these games wait until released. */
  hold: Map<string, () => void>
  holdIds: Set<string>
}

function fakeRunner(): FakeRunner {
  const ends = new Map<string, (outcome?: 'retry' | 'finished') => void>()
  const r: FakeRunner = {
    started: [],
    runs: [],
    signals: [],
    stopped: [],
    stopReasons: [],
    reported: [],
    failNext: new Map(),
    skipIds: new Set(),
    hold: new Map(),
    holdIds: new Set(),
    handedOff: [],
    marks: new Map(),
    notReady: new Set(),
    finish: (gameId, outcome) => ends.get(gameId)?.(outcome),
    async start(entry, { resumed, signal, handedOff, markHandedOff }) {
      r.started.push({ gameId: entry.gameId, resumed })
      r.handedOff.push(handedOff)
      r.marks.set(entry.gameId, markHandedOff)
      r.signals.push(signal)
      if (r.holdIds.has(entry.gameId))
        await new Promise<void>((resolve) => r.hold.set(entry.gameId, resolve))
      const error = r.failNext.get(entry.gameId)
      if (error) {
        r.failNext.delete(entry.gameId)
        return { error }
      }
      const run = { gameId: entry.gameId, signal, stopped: false, ended: false }
      r.runs.push(run)
      let end: (outcome?: 'retry' | 'finished') => void = () => {}
      const done = new Promise<void | 'retry' | 'finished'>((resolve) => (end = resolve)).then(
        (outcome) => {
          run.ended = true
          return outcome
        }
      )
      ends.set(entry.gameId, end)
      return {
        done,
        // Like the real runners: stops exactly this run's download.
        stop: (reason) => {
          if (run.stopped) return
          run.stopped = true
          r.stopped.push(entry.gameId)
          r.stopReasons.push(reason)
          // A run past its transfer (lingerOnStop) is not ended by the stop: it finishes by itself (finish()).
          if (!r.lingerOnStop?.has(entry.gameId)) end()
        }
      }
    },
    reportError(entry, message) {
      r.reported.push({ gameId: entry.gameId, message })
    },
    skip: (entry) => r.skipIds.has(entry.gameId),
    ready: (entry) => !r.notReady.has(entry.gameId)
  }
  return r
}

function item(gameId: string, kind: InstallQueueItem['kind'] = 'store'): InstallQueueItem {
  return kind === 'store'
    ? { gameId, title: gameId, kind, source: 'steam', from: 'Steam' }
    : { gameId, title: gameId, kind, source: 'host', from: 'DESKTOP' }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let dir: string
let bus: EventBus
let emitted: InstallQueueEntry[][]
const queues: InstallQueue[] = []

function makeQueue(settleWaitMs?: number): InstallQueue {
  const q = createInstallQueue({
    stateFile: join(dir, 'queue.json'),
    events: bus,
    log: quiet,
    ...(settleWaitMs ? { settleWaitMs } : {})
  })
  queues.push(q)
  return q
}

const ids = (q: InstallQueue): string[] => q.list().map((e) => `${e.gameId}:${e.state}`)

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-queue-'))
  bus = new EventBus()
  emitted = []
  bus.on('installs:queue', (list) => emitted.push(list))
})
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.dispose()))
  await fs.rm(dir, { recursive: true, force: true })
})

describe('install queue', () => {
  it('runs one download at a time, whatever the kind, in the order they were added', async () => {
    const q = makeQueue()
    const store = fakeRunner()
    const rom = fakeRunner()
    q.register('store', store)
    q.register('host-rom', rom)
    await q.begin()

    expect(await q.add(item('steam:1'))).toEqual({ position: 0 })
    expect(await q.add(item('remote:h:rom:a', 'host-rom'))).toEqual({ position: 1 })
    expect(await q.add(item('gog:2'))).toEqual({ position: 2 })
    // Already queued: its place, no second entry.
    expect(await q.add(item('gog:2'))).toEqual({ position: 2 })
    expect(ids(q)).toEqual(['steam:1:active', 'remote:h:rom:a:waiting', 'gog:2:waiting'])
    expect(store.started).toEqual([{ gameId: 'steam:1', resumed: false }])
    expect(rom.started).toEqual([])
    expect(q.activeId()).toBe('steam:1')
    expect(emitted.at(-1)?.map((e) => e.gameId)).toEqual(['steam:1', 'remote:h:rom:a', 'gog:2'])

    store.finish('steam:1')
    await tick()
    expect(rom.started).toEqual([{ gameId: 'remote:h:rom:a', resumed: false }])
    expect(ids(q)).toEqual(['remote:h:rom:a:active', 'gog:2:waiting'])

    rom.finish('remote:h:rom:a')
    await tick()
    expect(store.started.map((s) => s.gameId)).toEqual(['steam:1', 'gog:2'])
    store.finish('gog:2')
    await tick()
    expect(q.list()).toEqual([])
    expect(emitted.at(-1)).toEqual([])
  })

  it('returns an immediate start error to the caller, and reports one that comes at a later turn', async () => {
    const q = makeQueue()
    const store = fakeRunner()
    q.register('store', store)
    await q.begin()

    store.failNext.set('steam:1', 'Steam is not installed')
    expect(await q.add(item('steam:1'))).toEqual({
      position: 0,
      error: 'Steam is not installed'
    })
    expect(store.reported).toEqual([])
    expect(q.list()).toEqual([])

    await q.add(item('steam:2'))
    await q.add(item('steam:3'))
    await q.add(item('steam:4'))
    store.failNext.set('steam:3', 'no install form')
    store.finish('steam:2')
    await tick()
    // steam:3 failed in its turn: reported, dropped, and steam:4 started.
    expect(store.reported).toEqual([{ gameId: 'steam:3', message: 'no install form' }])
    expect(ids(q)).toEqual(['steam:4:active'])
  })

  it('skips a game whose turn comes when it no longer needs installing', async () => {
    const q = makeQueue()
    const store = fakeRunner()
    q.register('store', store)
    await q.begin()
    await q.add(item('steam:1'))
    await q.add(item('steam:2'))
    await q.add(item('steam:3'))
    store.skipIds.add('steam:2')
    store.finish('steam:1')
    await tick()
    expect(store.started.map((s) => s.gameId)).toEqual(['steam:1', 'steam:3'])
    expect(store.reported).toEqual([])
  })

  it('removes a waiting game, or stops the active one and starts the next', async () => {
    const q = makeQueue()
    const store = fakeRunner()
    q.register('store', store)
    await q.begin()
    await q.add(item('steam:1'))
    await q.add(item('steam:2'))
    await q.add(item('steam:3'))

    q.remove('steam:2')
    expect(store.stopped).toEqual([])
    expect(ids(q)).toEqual(['steam:1:active', 'steam:3:waiting'])

    q.remove('steam:1')
    expect(store.stopped).toEqual(['steam:1'])
    await tick()
    expect(ids(q)).toEqual(['steam:3:active'])
    expect(store.started.map((s) => s.gameId)).toEqual(['steam:1', 'steam:3'])
    q.remove('nope')
    expect(ids(q)).toEqual(['steam:3:active'])
  })

  it('stops a game removed while its start still runs, once the start returns', async () => {
    const q = makeQueue()
    const store = fakeRunner()
    q.register('store', store)
    await q.begin()
    store.holdIds.add('steam:1')
    const adding = q.add(item('steam:1'))
    await tick()
    await q.add(item('steam:2'))
    q.remove('steam:1')
    expect(store.stopped).toEqual([])
    await tick()
    // The next one does not wait for the slow start.
    expect(store.started.map((s) => s.gameId)).toEqual(['steam:1', 'steam:2'])
    store.hold.get('steam:1')!()
    expect(await adding).toEqual({ position: 0 })
    expect(store.stopped).toEqual(['steam:1'])
    expect(ids(q)).toEqual(['steam:2:active'])
  })

  it('a game removed and added again during its start: the old run never stops the new one, and never overlaps it', async () => {
    const q = makeQueue()
    const store = fakeRunner()
    q.register('store', store)
    await q.begin()
    store.holdIds.add('steam:1')
    const first = q.add(item('steam:1'))
    await tick()
    q.remove('steam:1')
    expect(store.signals[0].aborted).toBe(true)
    const second = q.add(item('steam:1'))
    await tick()
    // The new run waits for the old start to settle: no second start of the game yet.
    expect(store.started).toHaveLength(1)
    expect(ids(q)).toEqual(['steam:1:active'])

    store.holdIds.delete('steam:1')
    store.hold.get('steam:1')!()
    expect(await first).toEqual({ position: 0 })
    expect(await second).toEqual({ position: 0 })
    // The old start's own download was stopped; the new run's is untouched and still the active one.
    expect(store.started).toHaveLength(2)
    expect(store.runs.map((x) => [x.stopped, x.ended])).toEqual([
      [true, true],
      [false, false]
    ])
    expect(store.signals[1].aborted).toBe(false)
    // Still one download at a time: the next game waits behind it.
    expect(await q.add(item('steam:2'))).toEqual({ position: 1 })
    expect(store.started.map((x) => x.gameId)).toEqual(['steam:1', 'steam:1'])
    store.finish('steam:1')
    await tick()
    expect(store.started.map((x) => x.gameId)).toEqual(['steam:1', 'steam:1', 'steam:2'])
  })

  it('a start that never settles holds the next run of the game only so long, and its late stop is its own', async () => {
    const q = makeQueue(20)
    const store = fakeRunner()
    q.register('store', store)
    await q.begin()
    store.holdIds.add('steam:1')
    void q.add(item('steam:1'))
    await tick()
    const oldHold = store.hold.get('steam:1')!
    q.remove('steam:1')
    store.holdIds.delete('steam:1')
    await q.add(item('steam:1'))
    expect(store.started).toHaveLength(2)
    expect(store.runs).toHaveLength(1)
    // The old start returns late: only what it made is stopped.
    oldHold()
    await tick()
    expect(store.runs.map((x) => x.stopped)).toEqual([false, true])
    expect(store.runs[0].signal.aborted).toBe(false)
    expect(ids(q)).toEqual(['steam:1:active'])
  })

  it('moves waiting games, never past the active one', async () => {
    const q = makeQueue()
    q.register('store', fakeRunner())
    await q.begin()
    for (const id of ['steam:1', 'steam:2', 'steam:3', 'steam:4']) await q.add(item(id))

    q.move('steam:4', -1)
    expect(ids(q)).toEqual([
      'steam:1:active',
      'steam:2:waiting',
      'steam:4:waiting',
      'steam:3:waiting'
    ])
    q.move('steam:2', -1)
    q.move('steam:1', 1)
    q.move('steam:3', 1)
    expect(ids(q)).toEqual([
      'steam:1:active',
      'steam:2:waiting',
      'steam:4:waiting',
      'steam:3:waiting'
    ])
    q.move('steam:2', 1)
    expect(ids(q)).toEqual([
      'steam:1:active',
      'steam:4:waiting',
      'steam:2:waiting',
      'steam:3:waiting'
    ])
  })

  it('keeps the line on disk and resumes the active download after a restart', async () => {
    const first = makeQueue()
    const store = fakeRunner()
    first.register('store', store)
    await first.begin()
    await first.add(item('steam:1'))
    await first.add(item('remote:h:rom:a', 'host-rom'))
    await first.add(item('steam:2'))
    // PlayOut quits: the watch ending on the way out does not move the line on.
    await first.dispose()
    store.finish('steam:1')
    await tick()
    expect(first.list().map((e) => e.gameId)).toEqual(['steam:1', 'remote:h:rom:a', 'steam:2'])
    const saved = JSON.parse(await fs.readFile(join(dir, 'queue.json'), 'utf8'))
    expect(saved.entries.map((e: InstallQueueEntry) => `${e.gameId}:${e.state}`)).toEqual([
      'steam:1:active',
      'remote:h:rom:a:waiting',
      'steam:2:waiting'
    ])

    const second = makeQueue()
    const store2 = fakeRunner()
    const rom2 = fakeRunner()
    second.register('store', store2)
    second.register('host-rom', rom2)
    // Added before begin: waits behind the saved line.
    expect(await second.add(item('steam:9'))).toEqual({ position: 3 })
    expect(store2.started).toEqual([])
    await second.begin()
    await second.begin()
    expect(store2.started).toEqual([{ gameId: 'steam:1', resumed: true }])
    store2.finish('steam:1')
    await tick()
    expect(rom2.started).toEqual([{ gameId: 'remote:h:rom:a', resumed: false }])
    expect(ids(second)).toEqual(['remote:h:rom:a:active', 'steam:2:waiting', 'steam:9:waiting'])
  })

  it('drops a saved active entry that no longer needs installing, and starts at once when idle before begin', async () => {
    await fs.writeFile(
      join(dir, 'queue.json'),
      JSON.stringify({
        version: 1,
        entries: [
          { ...item('steam:2'), state: 'waiting', addedAt: '2026-01-01T00:00:00.000Z' },
          { ...item('steam:1'), state: 'active', addedAt: '2026-01-01T00:00:00.000Z' }
        ]
      })
    )
    const q = makeQueue()
    const store = fakeRunner()
    q.register('store', store)
    store.skipIds.add('steam:1')
    // The saved active one goes first, whatever its place in the file.
    expect(await q.add(item('steam:3'))).toEqual({ position: 2 })
    await q.begin()
    expect(store.started).toEqual([{ gameId: 'steam:2', resumed: false }])

    const empty = createInstallQueue({
      stateFile: join(dir, 'other.json'),
      events: bus,
      log: quiet
    })
    queues.push(empty)
    const runner = fakeRunner()
    empty.register('store', runner)
    expect(await empty.add(item('steam:5'))).toEqual({ position: 0 })
    expect(runner.started).toEqual([{ gameId: 'steam:5', resumed: false }])
  })

  it('keeps an entry whose source cannot be reached at its place, starts the others, and retries it on poke', async () => {
    const q = makeQueue()
    const store = fakeRunner()
    const rom = fakeRunner()
    q.register('store', store)
    q.register('host-rom', rom)
    await q.begin()
    await q.add(item('remote:h:rom:a', 'host-rom'))
    await q.add(item('remote:h:rom:b', 'host-rom'))
    await q.add(item('steam:1'))
    // The host is offline: the runner holds its games back and the run asks for a retry.
    rom.notReady.add('remote:h:rom:a').add('remote:h:rom:b')
    rom.finish('remote:h:rom:a', 'retry')
    await tick()
    // Kept (waiting, still first of the waiting ones), the host's other game not started, the store one runs.
    expect(rom.started.map((x) => x.gameId)).toEqual(['remote:h:rom:a'])
    expect(store.started.map((x) => x.gameId)).toEqual(['steam:1'])
    expect(ids(q)).toEqual(['steam:1:active', 'remote:h:rom:a:waiting', 'remote:h:rom:b:waiting'])
    store.finish('steam:1')
    await tick()
    // Nothing ready: idle, no loop.
    expect(ids(q)).toEqual(['remote:h:rom:a:waiting', 'remote:h:rom:b:waiting'])
    expect(rom.started).toHaveLength(1)
    q.poke()
    await tick()
    expect(rom.started).toHaveLength(1)
    // A new game that is ready starts at once, though held entries wait before it.
    expect(await q.add(item('steam:2'))).toEqual({ position: 0 })
    expect(ids(q)).toEqual(['steam:2:active', 'remote:h:rom:a:waiting', 'remote:h:rom:b:waiting'])
    store.finish('steam:2')
    await tick()
    // The host is back: the line goes on in its order.
    rom.notReady.clear()
    q.poke()
    await tick()
    expect(rom.started.map((x) => x.gameId)).toEqual(['remote:h:rom:a', 'remote:h:rom:a'])
    expect(ids(q)).toEqual(['remote:h:rom:a:active', 'remote:h:rom:b:waiting'])
    // A held entry can still be removed.
    rom.notReady.add('remote:h:rom:b')
    q.remove('remote:h:rom:b')
    expect(ids(q)).toEqual(['remote:h:rom:a:active'])
  })

  it("lists a held entry's waiting reason from its runner, and sends the list again on poke", async () => {
    const q = makeQueue()
    const store = fakeRunner()
    const rom = fakeRunner()
    rom.waitingFor = (entry) =>
      rom.notReady.has(entry.gameId) ? `Waiting for ${entry.from} to come back online` : undefined
    q.register('store', store)
    q.register('host-rom', rom)
    await q.begin()
    await q.add(item('steam:1'))
    await q.add(item('remote:h:rom:a', 'host-rom'))
    rom.notReady.add('remote:h:rom:a')
    expect(q.list()[1]).toMatchObject({
      gameId: 'remote:h:rom:a',
      waitingFor: 'Waiting for DESKTOP to come back online'
    })
    // The active entry and a game simply waiting its turn have none.
    expect(q.list()[0]).not.toHaveProperty('waitingFor')
    // Back online: poke sends the list again without the reason.
    rom.notReady.clear()
    const before = emitted.length
    q.poke()
    expect(emitted.length).toBe(before + 1)
    expect(emitted.at(-1)?.[1]).not.toHaveProperty('waitingFor')
    // Never saved with the entry.
    await q.dispose()
    rom.notReady.add('remote:h:rom:a')
    const saved = JSON.parse(await fs.readFile(join(dir, 'queue.json'), 'utf8'))
    expect(saved.entries[1]).not.toHaveProperty('waitingFor')
  })

  it('never restarts a retried entry before a poke, even if its runner says it is ready', async () => {
    const q = makeQueue()
    const rom = fakeRunner()
    q.register('host-rom', rom)
    await q.begin()
    await q.add(item('remote:h:rom:a', 'host-rom'))
    rom.finish('remote:h:rom:a', 'retry')
    await tick()
    await tick()
    expect(rom.started).toHaveLength(1)
    expect(ids(q)).toEqual(['remote:h:rom:a:waiting'])
    q.poke()
    await tick()
    expect(rom.started).toHaveLength(2)
  })

  it('saves the hand-off with the entry, only in the file, and resumes without it as a full start', async () => {
    const first = makeQueue()
    const store = fakeRunner()
    first.register('store', store)
    await first.begin()
    await first.add(item('steam:1'))
    await first.add(item('steam:2'))
    expect(store.handedOff).toEqual([false])
    store.marks.get('steam:1')!()
    await first.dispose()
    const saved = JSON.parse(await fs.readFile(join(dir, 'queue.json'), 'utf8'))
    expect(saved.entries.map((e: { handedOff?: boolean }) => e.handedOff)).toEqual([
      true,
      undefined
    ])
    // Not part of the public entry.
    expect(first.list()[0]).not.toHaveProperty('handedOff')
    expect(emitted.flat().some((e) => 'handedOff' in e)).toBe(false)

    const second = makeQueue()
    const store2 = fakeRunner()
    second.register('store', store2)
    await second.begin()
    expect(store2.started).toEqual([{ gameId: 'steam:1', resumed: true }])
    expect(store2.handedOff).toEqual([true])
    await second.dispose()

    // PlayOut quit before the hand-off was marked (or the file predates the flag): not handed off.
    const raw = JSON.parse(await fs.readFile(join(dir, 'queue.json'), 'utf8'))
    delete raw.entries[0].handedOff
    await fs.writeFile(join(dir, 'queue.json'), JSON.stringify(raw))
    const third = makeQueue()
    const store3 = fakeRunner()
    third.register('store', store3)
    await third.begin()
    expect(store3.started).toEqual([{ gameId: 'steam:1', resumed: true }])
    expect(store3.handedOff).toEqual([false])
  })

  it('caps titles, origins and the number of entries', async () => {
    const q = makeQueue()
    const store = fakeRunner()
    q.register('store', store)
    await q.begin()
    await q.add({ ...item('steam:1'), title: 'x'.repeat(2000), from: 'y'.repeat(2000) })
    expect(q.list()[0].title).toHaveLength(500)
    expect(q.list()[0].from).toHaveLength(200)
    for (let i = 2; i <= MAX_QUEUE_ENTRIES; i++) await q.add(item(`steam:${i}`))
    expect(q.list()).toHaveLength(MAX_QUEUE_ENTRIES)
    const over = await q.add(item('steam:extra'))
    expect(over.error).toMatch(/full/)
    expect(q.has('steam:extra')).toBe(false)
    // A game already queued still answers with its place.
    expect(await q.add(item('steam:2'))).toEqual({ position: 1 })
  })

  it('drops only the invalid entries of a damaged file', async () => {
    await fs.writeFile(
      join(dir, 'queue.json'),
      JSON.stringify({
        version: 1,
        entries: [
          { ...item('steam:1'), state: 'waiting', addedAt: '2026-01-01T00:00:00.000Z' },
          { gameId: 'steam:bad', kind: 'nope' },
          42,
          { ...item('steam:2'), title: 'z'.repeat(501), state: 'waiting', addedAt: 'x' },
          { ...item('steam:3'), state: 'waiting', addedAt: '2026-01-01T00:00:00.000Z' }
        ]
      })
    )
    const q = makeQueue()
    q.register('store', fakeRunner())
    await q.add(item('steam:9'))
    expect(q.list().map((e) => e.gameId)).toEqual(['steam:1', 'steam:3', 'steam:9'])
  })
})

describe('install queue: pause and resume', () => {
  /** A store runner that cannot pause (holds) and a ROM runner that stops; `asked` lists its pauseActive calls. */
  function setup(): {
    q: InstallQueue
    store: FakeRunner
    rom: FakeRunner
    asked: { gameId: string; resumed: boolean }[]
  } {
    const q = makeQueue()
    const store = fakeRunner()
    const rom = fakeRunner()
    const asked: { gameId: string; resumed: boolean }[] = []
    store.pauseActive = (entry, { resumed }) => {
      asked.push({ gameId: entry.gameId, resumed })
      return 'hold'
    }
    q.register('store', store)
    q.register('host-rom', rom)
    return { q, store, rom, asked }
  }
  const states = (q: InstallQueue): string[] =>
    q.list().map((e) => `${e.gameId}:${e.state}${e.paused ? ':paused' : ''}`)

  it('a paused waiting game keeps its place, is skipped for the next one, and goes in its turn once resumed', async () => {
    const { q, store, rom } = setup()
    await q.begin()
    await q.add(item('steam:1'))
    await q.add(item('remote:h:rom:a', 'host-rom'))
    await q.add(item('steam:2'))
    q.pause('remote:h:rom:a')
    expect(states(q)).toEqual([
      'steam:1:active',
      'remote:h:rom:a:waiting:paused',
      'steam:2:waiting'
    ])
    expect(emitted.at(-1)?.find((e) => e.gameId === 'remote:h:rom:a')?.paused).toBe(true)
    // Pausing it again changes nothing.
    const before = emitted.length
    q.pause('remote:h:rom:a')
    expect(emitted.length).toBe(before)

    store.finish('steam:1')
    await tick()
    expect(rom.started).toEqual([])
    expect(states(q)).toEqual(['steam:2:active', 'remote:h:rom:a:waiting:paused'])
    // Resumed while another downloads: it waits its turn.
    q.resume('remote:h:rom:a')
    expect(states(q)).toEqual(['steam:2:active', 'remote:h:rom:a:waiting'])
    expect(q.list()[1]).not.toHaveProperty('paused')
    store.finish('steam:2')
    await tick()
    expect(rom.started.map((s) => s.gameId)).toEqual(['remote:h:rom:a'])
  })

  it('resuming a paused game while nothing downloads starts it at once', async () => {
    const { q, rom } = setup()
    await q.begin()
    await q.add(item('remote:h:rom:a', 'host-rom'))
    q.pause('remote:h:rom:a')
    await tick()
    expect(states(q)).toEqual(['remote:h:rom:a:waiting:paused'])
    q.resume('remote:h:rom:a')
    await tick()
    expect(states(q)).toEqual(['remote:h:rom:a:active'])
    expect(rom.started.map((s) => s.resumed)).toEqual([false, false])
  })

  it('pausing the active ROM download stops its run with "pause", keeps it first and starts the next', async () => {
    const { q, rom, store } = setup()
    await q.begin()
    await q.add(item('remote:h:rom:a', 'host-rom'))
    await q.add(item('steam:1'))
    q.pause('remote:h:rom:a')
    expect(rom.stopped).toEqual(['remote:h:rom:a'])
    expect(rom.stopReasons).toEqual(['pause'])
    expect(rom.signals[0].aborted).toBe(true)
    await tick()
    expect(store.started.map((s) => s.gameId)).toEqual(['steam:1'])
    expect(states(q)).toEqual(['steam:1:active', 'remote:h:rom:a:waiting:paused'])
    // Its stopped run ending late does not move the line.
    rom.finish('remote:h:rom:a')
    await tick()
    expect(states(q)).toEqual(['steam:1:active', 'remote:h:rom:a:waiting:paused'])
    // Removing a game still stops it without a reason.
    q.remove('steam:1')
    expect(store.stopReasons).toEqual([undefined])
  })

  it('a ROM download paused while it was being added (past its transfer) leaves the queue when it finishes', async () => {
    const { q, rom, store } = setup()
    rom.lingerOnStop = new Set(['remote:h:rom:a'])
    await q.begin()
    await q.add(item('remote:h:rom:a', 'host-rom'))
    await q.add(item('steam:1'))
    q.pause('remote:h:rom:a')
    await tick()
    expect(states(q)).toEqual(['steam:1:active', 'remote:h:rom:a:waiting:paused'])
    // The scan and import finish anyway: an installed game is not left paused in the queue.
    rom.finish('remote:h:rom:a', 'finished')
    await tick()
    expect(states(q)).toEqual(['steam:1:active'])
    expect(store.stopped).toEqual([])
  })

  it('a paused-then-resumed ROM download is not dropped by its old run finishing', async () => {
    const { q, rom } = setup()
    rom.lingerOnStop = new Set(['remote:h:rom:a'])
    await q.begin()
    await q.add(item('remote:h:rom:a', 'host-rom'))
    await q.add(item('remote:h:rom:b', 'host-rom'))
    q.pause('remote:h:rom:a')
    q.resume('remote:h:rom:a')
    rom.finish('remote:h:rom:a', 'finished')
    await tick()
    // Not paused any more: its next run decides, the entry stays.
    expect(q.list().map((e) => e.gameId)).toContain('remote:h:rom:a')
  })

  it('pausing a ROM download whose start still runs stops what the start made, with "pause"', async () => {
    const { q, rom } = setup()
    rom.holdIds.add('remote:h:rom:a')
    await q.begin()
    const adding = q.add(item('remote:h:rom:a', 'host-rom'))
    await tick()
    q.pause('remote:h:rom:a')
    expect(rom.signals[0].aborted).toBe(true)
    rom.hold.get('remote:h:rom:a')!()
    await adding
    expect(rom.stopReasons).toEqual(['pause'])
    expect(states(q)).toEqual(['remote:h:rom:a:waiting:paused'])
  })

  it('a store download that cannot be paused stays active and holds the line; resume only clears the mark', async () => {
    const { q, store, asked } = setup()
    await q.begin()
    await q.add(item('steam:1'))
    await q.add(item('steam:2'))
    q.pause('steam:1')
    expect(asked).toEqual([{ gameId: 'steam:1', resumed: false }])
    expect(store.stopped).toEqual([])
    expect(store.signals[0].aborted).toBe(false)
    expect(states(q)).toEqual(['steam:1:active:paused', 'steam:2:waiting'])
    await tick()
    expect(store.started.map((s) => s.gameId)).toEqual(['steam:1'])
    // Paused again: the store is not asked twice.
    q.pause('steam:1')
    expect(asked).toHaveLength(1)
    q.resume('steam:1')
    expect(states(q)).toEqual(['steam:1:active', 'steam:2:waiting'])
    expect(asked).toHaveLength(1)
    // It still ends the usual way.
    store.finish('steam:1')
    await tick()
    expect(states(q)).toEqual(['steam:2:active'])
  })

  it('a paused store download that ends leaves the queue, and removing paused games works', async () => {
    const { q, store } = setup()
    await q.begin()
    await q.add(item('steam:1'))
    await q.add(item('steam:2'))
    await q.add(item('steam:3'))
    q.pause(null)
    store.finish('steam:1')
    await tick()
    // Everything left is paused: nothing starts.
    expect(states(q)).toEqual(['steam:2:waiting:paused', 'steam:3:waiting:paused'])
    expect(store.started.map((s) => s.gameId)).toEqual(['steam:1'])
    q.remove('steam:2')
    expect(states(q)).toEqual(['steam:3:waiting:paused'])
    expect(store.started.map((s) => s.gameId)).toEqual(['steam:1'])
  })

  it('pause all and resume all apply to every game; a new game still starts when everything is paused', async () => {
    const { q, rom, store, asked } = setup()
    await q.begin()
    await q.add(item('remote:h:rom:a', 'host-rom'))
    await q.add(item('steam:1'))
    await q.add(item('remote:h:rom:b', 'host-rom'))
    q.pause(null)
    await tick()
    expect(rom.stopReasons).toEqual(['pause'])
    expect(asked).toEqual([])
    expect(store.started).toEqual([])
    expect(states(q)).toEqual([
      'remote:h:rom:a:waiting:paused',
      'steam:1:waiting:paused',
      'remote:h:rom:b:waiting:paused'
    ])
    // Paused games can be moved.
    q.move('remote:h:rom:b', -1)
    expect(q.list().map((e) => e.gameId)).toEqual(['remote:h:rom:a', 'remote:h:rom:b', 'steam:1'])
    expect(await q.add(item('steam:9'))).toEqual({ position: 0 })
    expect(states(q)[0]).toBe('steam:9:active')
    q.resume(null)
    expect(q.list().some((e) => e.paused)).toBe(false)
    store.finish('steam:9')
    await tick()
    expect(states(q)[0]).toBe('remote:h:rom:a:active')
    expect(rom.started.map((s) => s.gameId)).toEqual(['remote:h:rom:a', 'remote:h:rom:a'])
  })

  it('pause all with a store download active holds it and pauses the rest', async () => {
    const { q, store, asked } = setup()
    await q.begin()
    await q.add(item('steam:1'))
    await q.add(item('remote:h:rom:a', 'host-rom'))
    q.pause(null)
    expect(asked.map((a) => a.gameId)).toEqual(['steam:1'])
    expect(states(q)).toEqual(['steam:1:active:paused', 'remote:h:rom:a:waiting:paused'])
    expect(store.stopped).toEqual([])
  })

  it('a runner without a pause of its own (or whose pauseActive throws) is stopped', async () => {
    const q = makeQueue()
    const store = fakeRunner()
    store.pauseActive = () => {
      throw new Error('boom')
    }
    q.register('store', store)
    await q.begin()
    await q.add(item('steam:1'))
    q.pause('steam:1')
    expect(store.stopReasons).toEqual(['pause'])
    expect(states(q)).toEqual(['steam:1:waiting:paused'])
  })

  it('keeps paused across a restart: a stopped download stays paused waiting, a held store one is watched again', async () => {
    const first = setup()
    await first.q.begin()
    await first.q.add(item('steam:1'))
    await first.q.add(item('remote:h:rom:a', 'host-rom'))
    await first.q.add(item('steam:2'))
    first.q.pause('steam:1')
    first.q.pause('remote:h:rom:a')
    await first.q.dispose()
    const saved = JSON.parse(await fs.readFile(join(dir, 'queue.json'), 'utf8'))
    expect(saved.entries.map((e: InstallQueueEntry) => e.paused ?? false)).toEqual([
      true,
      true,
      false
    ])

    const second = setup()
    await second.q.begin()
    expect(second.store.started).toEqual([{ gameId: 'steam:1', resumed: true }])
    // Asked how it pauses as a resumed entry (the store page does not open again).
    expect(second.asked).toEqual([{ gameId: 'steam:1', resumed: true }])
    expect(states(second.q)).toEqual([
      'steam:1:active:paused',
      'remote:h:rom:a:waiting:paused',
      'steam:2:waiting'
    ])
    second.store.finish('steam:1')
    await tick()
    expect(states(second.q)).toEqual(['steam:2:active', 'remote:h:rom:a:waiting:paused'])
    expect(second.rom.started).toEqual([])
  })

  it('a saved active ROM download that is paused stays paused, and an entry without the flag is not paused', async () => {
    await fs.writeFile(
      join(dir, 'queue.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            ...item('remote:h:rom:a', 'host-rom'),
            state: 'active',
            paused: true,
            addedAt: '2026-01-01T00:00:00.000Z'
          },
          { ...item('steam:1'), state: 'waiting', addedAt: '2026-01-01T00:00:00.000Z' },
          { ...item('steam:2'), state: 'waiting', paused: 'yes', addedAt: 'x' }
        ]
      })
    )
    const { q, rom, store } = setup()
    await q.begin()
    expect(rom.started).toEqual([])
    expect(store.started.map((s) => s.gameId)).toEqual(['steam:1'])
    // A junk flag drops only that entry.
    expect(states(q)).toEqual(['steam:1:active', 'remote:h:rom:a:waiting:paused'])
  })

  it('ignores unknown games and does nothing after dispose', async () => {
    const { q } = setup()
    await q.begin()
    await q.add(item('steam:1'))
    const before = emitted.length
    q.pause('steam:nope')
    q.resume('steam:nope')
    q.resume('steam:1')
    expect(emitted.length).toBe(before)
    await q.dispose()
    q.pause(null)
    expect(q.list()[0].paused).toBeUndefined()
  })
})
