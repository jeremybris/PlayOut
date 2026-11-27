import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Game, InstallProgress } from '../../shared/types'
import { EventBus } from '../events'
import {
  blindMessage,
  cancelledMessage,
  createInstallTracker,
  heldTimeoutMessage,
  stalledMessage,
  timeoutMessage,
  unconfirmedMessage,
  type InstallTracker,
  type ProbeResult,
  type WatchOptions
} from './tracker'

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'steam:620',
    source: 'steam',
    externalId: '620',
    platformId: 'steam',
    title: 'Portal 2',
    sortTitle: 'portal 2',
    installed: false,
    owned: true,
    launch: { kind: 'uri', uri: 'steam://install/620' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {},
    ...overrides
  }
}

interface Harness {
  tracker: InstallTracker
  events: InstallProgress[]
  probeResult: { current: ProbeResult | null }
  installed: { value: boolean }
  scans: number
  scanOptions: unknown[]
  logs: string[]
}

const timing = {
  probeMs: 1_000,
  stateOnlyProbeMs: 5_000,
  scanMs: 10_000,
  timeoutMs: 60_000,
  unconfirmedMs: 20_000,
  heldTimeoutMs: 3_600_000,
  emitMinMs: 1_000
}

function harness(): Harness {
  const events: InstallProgress[] = []
  const bus = new EventBus()
  bus.on('install:progress', (p) => events.push(p))
  const probeResult = { current: null as ProbeResult | null }
  const installed = { value: false }
  const logs: string[] = []
  const h: Harness = {
    events,
    probeResult,
    installed,
    scans: 0,
    scanOptions: [],
    logs,
    tracker: createInstallTracker({
      library: { getGame: () => makeGame({ installed: installed.value }) },
      scan: {
        async run(_ids, options) {
          h.scans++
          h.scanOptions.push(options)
        }
      },
      events: bus,
      log: {
        debug: () => {},
        info: (m) => logs.push(String(m)),
        warn: (m) => logs.push(String(m)),
        error: () => {}
      },
      timing
    })
  }
  return h
}

function start(h: Harness, measured = true): InstallProgress {
  return h.tracker.start({
    game: makeGame(),
    source: 'steam',
    storeName: 'Steam',
    confirmMessage: 'Confirm the install in Steam',
    probe: async () => h.probeResult.current,
    measured
  }).progress
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('install tracker', () => {
  it('goes starting -> downloading -> done on the confirming scan', async () => {
    const h = harness()
    const initial = start(h)
    expect(initial).toMatchObject({ state: 'starting', message: 'Confirm the install in Steam' })
    expect(initial.percent).toBeUndefined()
    expect(h.events).toHaveLength(1)

    h.probeResult.current = {
      state: 'downloading',
      percent: 25,
      bytesDone: 25,
      bytesTotal: 100,
      fingerprint: 'a'
    }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.events.at(-1)).toMatchObject({
      state: 'downloading',
      percent: 25,
      message: 'Installing through Steam…'
    })
    expect(h.tracker.list()).toHaveLength(1)

    h.probeResult.current = { state: 'downloading', percent: 60, fingerprint: 'b' }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.events.at(-1)!.percent).toBe(60)
    expect(h.scans).toBe(0)

    // The 10 s confirming scan reports installed: the watch ends with done and one final event.
    h.installed.value = true
    await vi.advanceTimersByTimeAsync(8_000)
    expect(h.scans).toBe(1)
    expect(h.events.at(-1)).toMatchObject({ state: 'done', percent: 100 })
    expect(h.tracker.list()).toEqual([])
    expect(h.tracker.has('steam:620')).toBe(false)
  })

  it('does not end on the confirming scan while the probe says the install is in flight', async () => {
    const h = harness()
    start(h)
    // Steam wrote bit 4 early: the scan marks the game installed while the download is at 1 %.
    h.probeResult.current = { state: 'downloading', percent: 1, inFlight: true, fingerprint: 'a' }
    h.installed.value = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.scans).toBeGreaterThanOrEqual(1)
    expect(h.events.at(-1)!.state).toBe('downloading')
    expect(h.tracker.has('steam:620')).toBe(true)
    // The store finishes: the next scan ends the watch.
    h.probeResult.current = { state: 'installing', percent: 100, complete: true, fingerprint: 'b' }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.events.at(-1)).toMatchObject({ state: 'done' })
  })

  it('runs its confirming scans as reason confirm', async () => {
    const h = harness()
    start(h)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.scanOptions).toEqual([{ reason: 'confirm' }])
  })

  it('runs the confirming scan right away when the store says the install completed', async () => {
    const h = harness()
    start(h)
    h.probeResult.current = {
      state: 'installing',
      percent: 100,
      complete: true,
      fingerprint: 'done'
    }
    h.installed.value = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.scans).toBe(1)
    expect(h.events.at(-1)!.state).toBe('done')
  })

  it('fails after the no-change timeout, and a change resets the clock', async () => {
    const h = harness()
    start(h)
    await vi.advanceTimersByTimeAsync(50_000)
    h.probeResult.current = { state: 'downloading', percent: 10, fingerprint: 'x' }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.tracker.list()).toHaveLength(1)
    // Same fingerprint from here on: 60 s later the watch times out.
    await vi.advanceTimersByTimeAsync(59_000)
    expect(h.tracker.list()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.events.at(-1)).toMatchObject({ state: 'failed', message: timeoutMessage('Steam') })
    expect(h.tracker.list()).toEqual([])
  })

  it('reports a cancelled install and keeps scanning without a probe', async () => {
    const h = harness()
    start(h)
    h.probeResult.current = { cancelled: true, fingerprint: 'gone' }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.events.at(-1)).toMatchObject({ state: 'failed', message: cancelledMessage('Steam') })

    const h2 = harness()
    h2.tracker.start({
      game: makeGame(),
      source: 'steam',
      storeName: 'Steam',
      confirmMessage: 'c',
      probe: null,
      measured: false
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h2.scans).toBe(1)
    expect(h2.events.at(-1)!.state).toBe('starting')
  })

  it('cancel ends the watch silently and a second start keeps the existing watch', async () => {
    const h = harness()
    start(h)
    h.probeResult.current = { state: 'downloading', percent: 5, fingerprint: 'a' }
    await vi.advanceTimersByTimeAsync(1_000)
    const again = start(h)
    expect(again.percent).toBe(5)
    const before = h.events.length
    expect(h.tracker.cancel('steam:620')).toBe(true)
    expect(h.tracker.cancel('steam:620')).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.events.length).toBe(before)
    expect(h.tracker.list()).toEqual([])
  })

  it('pauses on suspend without crediting the gap to the timeout', async () => {
    const h = harness()
    start(h)
    await vi.advanceTimersByTimeAsync(30_000)
    h.tracker.pause()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.tracker.list()).toHaveLength(1)
    h.tracker.resume()
    await vi.advanceTimersByTimeAsync(25_000)
    expect(h.tracker.list()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(h.events.at(-1)!.state).toBe('failed')
  })

  it('throttles events to one per second unless the state changes', async () => {
    const h = harness()
    start(h)
    const bus = { emit: vi.fn() }
    const fast = createInstallTracker({
      library: { getGame: () => makeGame() },
      scan: { run: async () => {} },
      events: bus,
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      timing: { ...timing, probeMs: 200, emitMinMs: 1_000 }
    })
    let n = 0
    fast.start({
      game: makeGame(),
      source: 'steam',
      storeName: 'Steam',
      confirmMessage: 'c',
      probe: async () => ({ state: 'downloading', percent: ++n, fingerprint: String(n) }),
      measured: true
    })
    await vi.advanceTimersByTimeAsync(1_000)
    // start + the state change at 200 ms + at most one more within the second
    expect(bus.emit.mock.calls.length).toBeLessThanOrEqual(3)
    fast.dispose()
    expect(fast.list()).toEqual([])
  })

  it('calls onEnd when a watch ends or is cancelled, never on dispose', async () => {
    const h = harness()
    const ended: string[] = []
    const watch = (id: string): void => {
      h.tracker.start({
        game: makeGame({ id }),
        source: 'steam',
        storeName: 'Steam',
        confirmMessage: 'Confirm the install in Steam',
        probe: null,
        measured: true,
        onEnd: () => ended.push(id)
      })
    }
    watch('steam:1')
    watch('steam:2')
    watch('steam:3')
    h.tracker.cancel('steam:1')
    expect(ended).toEqual(['steam:1'])
    h.installed.value = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ended.sort()).toEqual(['steam:1', 'steam:2', 'steam:3'])
    watch('steam:4')
    h.tracker.dispose()
    expect(ended).toHaveLength(3)
  })

  it("a start's own cancel ends only the watch it made, never a later watch of the same game", async () => {
    const h = harness()
    const ended: string[] = []
    const options = (tag: string): WatchOptions => ({
      game: makeGame({ id: 'steam:1' }),
      source: 'steam',
      storeName: 'Steam',
      confirmMessage: 'c',
      probe: null,
      measured: true,
      onEnd: () => ended.push(tag)
    })
    const first = h.tracker.start(options('first'))
    expect(first.created).toBe(true)
    // A second start finds the watch: it does not own it, but hears when it ends.
    const joined = h.tracker.start(options('joined'))
    expect(joined.created).toBe(false)
    expect(joined.cancel()).toBe(false)
    expect(h.tracker.has('steam:1')).toBe(true)

    expect(first.cancel()).toBe(true)
    expect(ended).toEqual(['first', 'joined'])
    const second = h.tracker.start(options('second'))
    expect(second.created).toBe(true)
    // The first start's cancel, called late, leaves the new watch alone.
    expect(first.cancel()).toBe(false)
    expect(h.tracker.has('steam:1')).toBe(true)
    expect(ended).toEqual(['first', 'joined'])
    expect(second.cancel()).toBe(true)
    expect(ended).toEqual(['first', 'joined', 'second'])
  })

  describe('a watch the install queue holds', () => {
    function startHeld(h: Harness, options: Partial<WatchOptions> = {}): () => number {
      let ends = 0
      h.tracker.start({
        game: makeGame(),
        source: 'steam',
        storeName: 'Steam',
        confirmMessage: 'Confirm the install in Steam',
        probe: async () => h.probeResult.current,
        measured: true,
        holdWhenStalled: true,
        onEnd: () => ends++,
        ...options
      })
      return () => ends
    }

    it('ends as failed when a store expected to show a fresh install never did, so the queue moves on', async () => {
      const h = harness()
      const ends = startHeld(h, { expectStoreStart: true })
      // The probe sees something, but not the install (still starting).
      h.probeResult.current = { fingerprint: 'nothing yet' }
      await vi.advanceTimersByTimeAsync(19_000)
      expect(h.tracker.has('steam:620')).toBe(true)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(h.events.at(-1)).toMatchObject({
        state: 'failed',
        message: unconfirmedMessage('Steam')
      })
      expect(unconfirmedMessage('Steam')).toBe(
        'Steam did not start the install. Press Install to try again.'
      )
      expect(ends()).toBe(1)
      expect(h.tracker.has('steam:620')).toBe(false)
    })

    it('never ends a held watch by a timer when the store is not expected to show it (resumed, unreliable probe)', async () => {
      const h = harness()
      const ends = startHeld(h)
      h.probeResult.current = { fingerprint: 'nothing yet' }
      // Long past both limits: still held, the confirming scan still runs, only the line says PlayOut cannot see it.
      await vi.advanceTimersByTimeAsync(59_000)
      expect(h.tracker.list()[0]).toMatchObject({ state: 'starting' })
      await vi.advanceTimersByTimeAsync(300_000)
      expect(h.tracker.has('steam:620')).toBe(true)
      expect(ends()).toBe(0)
      expect(blindMessage('Steam')).toBe(
        "PlayOut cannot see Steam's progress. Remove it from the queue once Steam finished or cancelled it."
      )
      expect(h.events.at(-1)).toMatchObject({ state: 'starting', message: blindMessage('Steam') })
      expect(h.events.filter((e) => e.message === blindMessage('Steam'))).toHaveLength(1)
      const scans = h.scans
      await vi.advanceTimersByTimeAsync(30_000)
      expect(h.scans).toBeGreaterThan(scans)
      // The confirming scan is what ends it.
      h.installed.value = true
      await vi.advanceTimersByTimeAsync(10_000)
      expect(h.events.at(-1)).toMatchObject({ state: 'done' })
      expect(ends()).toBe(1)
    })

    it('ends a held watch as failed after the long last-resort timeout without any change, so the queue is released', async () => {
      const h = harness()
      const ends = startHeld(h)
      // A store PlayOut cannot follow, cancelled there: the probe never sees anything new.
      h.probeResult.current = { fingerprint: 'nothing yet' }
      await vi.advanceTimersByTimeAsync(3_590_000)
      expect(h.tracker.has('steam:620')).toBe(true)
      expect(ends()).toBe(0)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(heldTimeoutMessage('Steam', 3_600_000)).toBe(
        'No progress from Steam for 1 hour, so PlayOut stopped waiting for it. Press Install to try again.'
      )
      expect(h.events.at(-1)).toMatchObject({
        state: 'failed',
        message: heldTimeoutMessage('Steam', 3_600_000)
      })
      expect(ends()).toBe(1)
      expect(h.tracker.has('steam:620')).toBe(false)
    })

    it('never ends a held watch whose download still moves, however slow, nor credits a suspend to the long timeout', async () => {
      const h = harness()
      const ends = startHeld(h)
      // One more byte every 50 minutes, for five hours: each change starts the long timeout again.
      for (let i = 0; i < 6; i++) {
        h.probeResult.current = { state: 'downloading', bytesDone: i, fingerprint: `bytes:${i}` }
        await vi.advanceTimersByTimeAsync(3_000_000)
      }
      expect(h.tracker.has('steam:620')).toBe(true)
      expect(ends()).toBe(0)
      // The PC sleeps for two hours: the gap is not counted.
      h.tracker.pause()
      await vi.advanceTimersByTimeAsync(7_200_000)
      h.tracker.resume()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(h.tracker.has('steam:620')).toBe(true)
      expect(ends()).toBe(0)
    })

    it('ends a held watch when the store says it was cancelled', async () => {
      const h = harness()
      const ends = startHeld(h)
      h.probeResult.current = { state: 'downloading', percent: 5, fingerprint: 'a' }
      await vi.advanceTimersByTimeAsync(1_000)
      h.probeResult.current = { cancelled: true, fingerprint: 'gone' }
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.events.at(-1)).toMatchObject({ state: 'failed', message: cancelledMessage('Steam') })
      expect(ends()).toBe(1)
    })

    it('keeps watching a stalled install the store showed, and only says so', async () => {
      const h = harness()
      const ends = startHeld(h)
      h.probeResult.current = { state: 'downloading', percent: 40, fingerprint: 'same' }
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.events.at(-1)).toMatchObject({ state: 'downloading', percent: 40 })
      // Long past both limits without a change: still watched, same state, the message says it may be paused.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(h.tracker.has('steam:620')).toBe(true)
      expect(ends()).toBe(0)
      const stalled = stalledMessage('Steam', 60_000)
      expect(stalled).toBe('No progress from Steam for 1 minute; it may be paused there')
      expect(h.events.at(-1)).toMatchObject({ state: 'downloading', percent: 40, message: stalled })
      expect(h.tracker.list()[0].message).toBe(stalled)
      // The line does not flicker: one stalled event, not one per probe.
      const count = h.events.length
      await vi.advanceTimersByTimeAsync(10_000)
      expect(h.events.length).toBe(count)
      // The confirming scan keeps running.
      expect(h.scans).toBeGreaterThan(5)
      // Progress again: the usual line comes back.
      h.probeResult.current = { state: 'downloading', percent: 41, fingerprint: 'moved' }
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.events.at(-1)).toMatchObject({
        percent: 41,
        message: 'Installing through Steam…'
      })
      // And it still ends with done.
      h.installed.value = true
      await vi.advanceTimersByTimeAsync(10_000)
      expect(h.events.at(-1)).toMatchObject({ state: 'done' })
      expect(ends()).toBe(1)
    })

    it("keeps the store's own message (Paused in Steam) over the stall line", async () => {
      const h = harness()
      startHeld(h)
      h.probeResult.current = {
        state: 'queued',
        message: 'Paused in Steam',
        fingerprint: 'paused'
      }
      await vi.advanceTimersByTimeAsync(90_000)
      expect(h.tracker.list()[0]).toMatchObject({ state: 'queued', message: 'Paused in Steam' })
    })

    it('without a probe holds on (even with expectStoreStart) and says PlayOut cannot see it', async () => {
      const h = harness()
      const ends = startHeld(h, { probe: null, expectStoreStart: true })
      await vi.advanceTimersByTimeAsync(300_000)
      expect(h.tracker.has('steam:620')).toBe(true)
      expect(ends()).toBe(0)
      expect(h.tracker.list()[0].message).toBe(blindMessage('Steam'))
      expect(h.events.some((e) => e.message === timeoutMessage('Steam'))).toBe(false)
      h.installed.value = true
      await vi.advanceTimersByTimeAsync(10_000)
      expect(h.events.at(-1)).toMatchObject({ state: 'done' })
    })

    it('does not count a suspend against the unconfirmed limit', async () => {
      const h = harness()
      startHeld(h, { expectStoreStart: true })
      await vi.advanceTimersByTimeAsync(10_000)
      h.tracker.pause()
      await vi.advanceTimersByTimeAsync(60_000)
      h.tracker.resume()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(h.tracker.has('steam:620')).toBe(true)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(h.tracker.has('steam:620')).toBe(false)
    })
  })
})
