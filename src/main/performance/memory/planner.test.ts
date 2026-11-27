import { describe, expect, it } from 'vitest'
import {
  COOLDOWN_MS,
  cooldownMs,
  EPISODE_RECOVERY_MS,
  INITIAL_PLANNER_STATE,
  isMemoryLow,
  LOW_YIELD_COOLDOWN_MS,
  LOW_YIELD_MB,
  lowMemoryThresholdMb,
  passEnded,
  passSkipped,
  planPass,
  PRESSURE_COOLDOWNS_MS,
  SAMPLE_MS,
  SKIP_BACKOFF_MS,
  SESSION_DELAY_MS,
  SESSION_MIN_GAP_MS,
  sessionEnded,
  sessionStarted,
  standbyPurgeBelowMb,
  type PlannerInput,
  type PlannerState
} from './planner'

const T0 = 1_000_000
const GB = 1024

/** 16 GB with plenty available, the setting on, nothing running. */
const input = (over: Partial<PlannerInput> = {}): PlannerInput => ({
  now: T0,
  enabled: true,
  paused: false,
  running: false,
  availableMb: 8 * GB,
  totalMb: 16 * GB,
  ...over
})

const low = (over: Partial<PlannerInput> = {}): PlannerInput =>
  input({ availableMb: 1500, ...over })

describe('low memory threshold', () => {
  it('is 15 % of the total or 2 GB, whichever is larger, capped at 30 % on small PCs and at 4 GB', () => {
    expect(lowMemoryThresholdMb(4 * GB)).toBe(1229)
    expect(lowMemoryThresholdMb(8 * GB)).toBe(2048)
    expect(lowMemoryThresholdMb(16 * GB)).toBe(2458)
    expect(lowMemoryThresholdMb(24 * GB)).toBe(3686)
    // 15 % of a big PC is many GB nothing misses: 9.5 GB available of 64 GB is not memory pressure.
    expect(lowMemoryThresholdMb(32 * GB)).toBe(4096)
    expect(lowMemoryThresholdMb(64 * GB)).toBe(4096)
    expect(lowMemoryThresholdMb(128 * GB)).toBe(4096)
    expect(isMemoryLow(9.5 * GB, 64 * GB)).toBe(false)
    expect(isMemoryLow(4095, 128 * GB)).toBe(true)
    expect(lowMemoryThresholdMb(0)).toBe(0)
    expect(lowMemoryThresholdMb(NaN)).toBe(0)
  })

  it('calls memory low only under the threshold', () => {
    expect(isMemoryLow(2457, 16 * GB)).toBe(true)
    expect(isMemoryLow(2458, 16 * GB)).toBe(false)
    expect(isMemoryLow(NaN, 16 * GB)).toBe(false)
    expect(isMemoryLow(100, 0)).toBe(false)
  })

  it('asks for the full standby purge under a lower line of its own, once per low-memory episode', () => {
    expect(standbyPurgeBelowMb(8 * GB)).toBe(1024)
    expect(standbyPurgeBelowMb(16 * GB)).toBe(1229)
    expect(standbyPurgeBelowMb(64 * GB)).toBe(2048)
    expect(standbyPurgeBelowMb(128 * GB)).toBe(2048)
    expect(standbyPurgeBelowMb(0)).toBe(0)
    for (const total of [8, 16, 64].map((g) => g * GB))
      expect(standbyPurgeBelowMb(total)).toBeLessThan(lowMemoryThresholdMb(total))

    let state = planPass(INITIAL_PLANNER_STATE, low()).state
    expect(standbyPurgeBelowMb(16 * GB, state)).toBe(1229)
    // A pass that did not purge leaves the purge available; one that did uses it up.
    state = passEnded(state, T0, 300, { reason: 'pressure', standbyPurged: false })
    expect(standbyPurgeBelowMb(16 * GB, state)).toBe(1229)
    state = passEnded(state, T0 + COOLDOWN_MS, 300, { reason: 'pressure', standbyPurged: true })
    expect(standbyPurgeBelowMb(16 * GB, state)).toBe(0)
    state = passEnded(state, T0 + 20 * 60_000, 300, { reason: 'pressure' })
    expect(standbyPurgeBelowMb(16 * GB, state)).toBe(0)
    // Memory recovered for long enough: a new episode may purge again.
    const calm = T0 + 20 * 60_000 + EPISODE_RECOVERY_MS
    state = planPass(state, low({ now: T0 + 20 * 60_000 })).state
    state = planPass(state, input({ now: calm - 1 })).state
    expect(standbyPurgeBelowMb(16 * GB, state)).toBe(0)
    state = planPass(state, input({ now: calm })).state
    expect(state).toMatchObject({ episodePurged: false, episodePasses: 0, lastLowAt: null })
    expect(standbyPurgeBelowMb(16 * GB, state)).toBe(1229)
  })
})

describe('planPass', () => {
  it('never runs with the setting off, and forgets a waiting game start', () => {
    const waiting = sessionStarted(INITIAL_PLANNER_STATE, T0)
    const r = planPass(waiting, low({ enabled: false, now: T0 + SESSION_DELAY_MS }))
    expect(r.decision).toEqual({ run: false, why: 'off' })
    expect(r.state.sessionDueAt).toBeNull()
  })

  it('never runs on a timer alone: with enough memory nothing happens, however long ago the last pass was', () => {
    const state = passEnded(INITIAL_PLANNER_STATE, T0, 900)
    for (const later of [COOLDOWN_MS, LOW_YIELD_COOLDOWN_MS, 24 * 3_600_000])
      expect(planPass(state, input({ now: T0 + later })).decision).toEqual({
        run: false,
        why: 'enough'
      })
  })

  it('runs for low memory, then not again before the cooldown', () => {
    const first = planPass(INITIAL_PLANNER_STATE, low())
    expect(first.decision).toEqual({ run: true, reason: 'pressure' })
    const after = passEnded(first.state, T0 + 2_000, 900)
    expect(planPass(after, low({ now: T0 + 2_000 + COOLDOWN_MS - 1 })).decision).toEqual({
      run: false,
      why: 'cooldown'
    })
    expect(planPass(after, low({ now: T0 + 2_000 + COOLDOWN_MS })).decision).toEqual({
      run: true,
      reason: 'pressure'
    })
  })

  it('waits much longer after a pass that freed almost nothing, so it never thrashes', () => {
    const poor = passEnded(INITIAL_PLANNER_STATE, T0, LOW_YIELD_MB - 1)
    expect(cooldownMs(poor)).toBe(LOW_YIELD_COOLDOWN_MS)
    expect(planPass(poor, low({ now: T0 + COOLDOWN_MS })).decision).toEqual({
      run: false,
      why: 'cooldown'
    })
    expect(planPass(poor, low({ now: T0 + LOW_YIELD_COOLDOWN_MS })).decision).toMatchObject({
      run: true
    })
    expect(cooldownMs(passEnded(INITIAL_PLANNER_STATE, T0, LOW_YIELD_MB))).toBe(COOLDOWN_MS)
    // A negative reading (memory went down during the pass) counts as nothing freed.
    expect(passEnded(INITIAL_PLANNER_STATE, T0, -300).lastFreedMb).toBe(0)
  })

  /**
   * The 30 s sampler over `minutes`, with available memory from `availableAt`; every pass takes 2 s and frees
   * `freedMb`. Returns when each pass for low memory started, in minutes from the start.
   */
  function simulate(
    minutes: number,
    availableAt: (minute: number) => number,
    freedMb: number
  ): number[] {
    let state = INITIAL_PLANNER_STATE
    const starts: number[] = []
    for (let t = 0; t <= minutes * 60_000; t += SAMPLE_MS) {
      const r = planPass(state, input({ now: T0 + t, availableMb: availableAt(t / 60_000) }))
      state = r.state
      if (!r.decision.run) continue
      expect(r.decision.reason).toBe('pressure')
      starts.push(t / 60_000)
      state = passEnded(state, T0 + t + 2_000, freedMb, { reason: 'pressure' })
    }
    return starts
  }

  it('backs off while memory stays low although every pass frees something: 3, 10, then 30 minutes', () => {
    // Background apps page back in between passes, so each pass "frees" 300 MB and memory is low again.
    const starts = simulate(120, () => 1500, 300)
    const gaps = starts.slice(1).map((s, i) => Math.floor(s - starts[i]!))
    expect(starts[0]).toBe(0)
    expect(gaps).toEqual([3, 10, 30, 30, 30])
    expect(PRESSURE_COOLDOWNS_MS).toEqual([3 * 60_000, 10 * 60_000, 30 * 60_000])
  })

  it('backs off as well when each pass lifts memory over the line for a moment', () => {
    // Enough for the first minute after every third minute, low otherwise: the episode never ends.
    const starts = simulate(60, (minute) => (minute % 3 < 1 ? 3000 : 1500), 1500)
    const gaps = starts.slice(1).map((s, i) => Math.floor(s - starts[i]!))
    expect(gaps).toHaveLength(3)
    expect(gaps[0]).toBeGreaterThanOrEqual(3)
    expect(gaps[1]).toBeGreaterThanOrEqual(10)
    expect(gaps[2]).toBeGreaterThanOrEqual(30)
  })

  it('starts with the short cooldown again once memory has recovered for a while', () => {
    let state = INITIAL_PLANNER_STATE
    let now = T0
    for (let i = 0; i < 3; i++) {
      state = planPass(state, low({ now })).state
      state = passEnded(state, now, 300, { reason: 'pressure' })
      now += cooldownMs(state)
    }
    expect(cooldownMs(state)).toBe(30 * 60_000)
    // Still low at the end of that cooldown, then not low, but not for long enough yet: the episode is still open.
    state = planPass(state, low({ now: now - 1 })).state
    expect(state.lastLowAt).toBe(now - 1)
    state = planPass(state, input({ now })).state
    state = planPass(state, input({ now: now + EPISODE_RECOVERY_MS - 2 })).state
    expect(cooldownMs(state)).toBe(30 * 60_000)
    state = planPass(state, input({ now: now + EPISODE_RECOVERY_MS })).state
    expect(state.episodePasses).toBe(0)
    expect(cooldownMs(state)).toBe(COOLDOWN_MS)
    // The button's and a game start's passes do not count as passes for low memory.
    const manual = passEnded(
      passEnded(INITIAL_PLANNER_STATE, T0, 300, { reason: 'manual' }),
      T0,
      300,
      {
        reason: 'session'
      }
    )
    expect(manual.episodePasses).toBe(0)
    expect(cooldownMs(manual)).toBe(COOLDOWN_MS)
    // A pass that freed almost nothing never shortens a longer episode cooldown.
    expect(cooldownMs({ ...state, episodePasses: 5, lastFreedMb: 0 })).toBe(30 * 60_000)
    expect(cooldownMs({ ...state, episodePasses: 1, lastFreedMb: 0 })).toBe(LOW_YIELD_COOLDOWN_MS)
  })

  it('does not ask again at every sample after a pass that could not decide what to trim', () => {
    const skipped = passSkipped(INITIAL_PLANNER_STATE, T0)
    // Not a pass: no cooldown is recorded, only the short wait.
    expect(skipped.lastPassAt).toBeNull()
    for (const later of [SAMPLE_MS, 2 * SAMPLE_MS, SKIP_BACKOFF_MS - 1])
      expect(planPass(skipped, low({ now: T0 + later })).decision).toEqual({
        run: false,
        why: 'cooldown'
      })
    expect(planPass(skipped, low({ now: T0 + SKIP_BACKOFF_MS })).decision).toEqual({
      run: true,
      reason: 'pressure'
    })
    // A game's own pass is not held back by it, and a pass that ran clears it.
    const due = sessionStarted(skipped, T0 - SESSION_DELAY_MS)
    expect(planPass(due, low({ now: T0 + 1 })).decision).toEqual({ run: true, reason: 'session' })
    expect(passEnded(skipped, T0 + 5, 300).blockedUntil).toBeNull()
  })

  it('runs one pass after a game starts, once the delay has passed, with enough memory too', () => {
    const state = sessionStarted(INITIAL_PLANNER_STATE, T0)
    expect(state.sessionDueAt).toBe(T0 + SESSION_DELAY_MS)
    const early = planPass(state, low({ now: T0 + SESSION_DELAY_MS - 1 }))
    // Not even for low memory: the launch itself is left alone.
    expect(early.decision).toEqual({ run: false, why: 'waiting' })
    const due = planPass(early.state, input({ now: T0 + SESSION_DELAY_MS }))
    expect(due.decision).toEqual({ run: true, reason: 'session' })
    expect(due.state.sessionDueAt).toBeNull()
    // One pass only.
    expect(planPass(due.state, input({ now: T0 + SESSION_DELAY_MS + 1 })).decision).toEqual({
      run: false,
      why: 'enough'
    })
  })

  it('drops the game start pass when one just ran or the game ended first', () => {
    const justRan = sessionStarted(passEnded(INITIAL_PLANNER_STATE, T0, 900), T0)
    const r = planPass(justRan, input({ now: T0 + SESSION_DELAY_MS }))
    expect(SESSION_DELAY_MS).toBeLessThan(SESSION_MIN_GAP_MS)
    expect(r.decision).toEqual({ run: false, why: 'enough' })
    expect(r.state.sessionDueAt).toBeNull()

    const ended = sessionEnded(sessionStarted(INITIAL_PLANNER_STATE, T0))
    expect(ended.sessionDueAt).toBeNull()
    expect(planPass(ended, input({ now: T0 + SESSION_DELAY_MS })).decision).toEqual({
      run: false,
      why: 'enough'
    })
    expect(sessionEnded(INITIAL_PLANNER_STATE)).toBe(INITIAL_PLANNER_STATE)
  })

  it('never overlaps a running pass and never runs while paused; a due game pass waits', () => {
    const due: PlannerState = { ...INITIAL_PLANNER_STATE, sessionDueAt: T0 }
    for (const [over, why] of [
      [{ running: true }, 'running'],
      [{ paused: true }, 'paused'],
      [{ paused: true, running: true }, 'paused']
    ] as const) {
      const r = planPass(due, low({ now: T0 + 5, ...over }))
      expect(r.decision).toEqual({ run: false, why })
      expect(r.state.sessionDueAt).toBe(T0)
    }
    expect(planPass(due, low({ now: T0 + 5 })).decision).toEqual({ run: true, reason: 'session' })
  })
})
