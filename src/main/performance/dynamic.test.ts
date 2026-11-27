import { describe, expect, it } from 'vitest'
import {
  boostFor,
  createDynamicState,
  deadband,
  DYNAMIC_DEFAULTS,
  dynamicLimits,
  dynamicStep,
  middleWatts,
  type DynamicConfig,
  type DynamicState
} from './dynamic'

const cfg = (over: Partial<DynamicConfig> = {}): DynamicConfig => ({
  ...DYNAMIC_DEFAULTS,
  targetFps: 60,
  limits: { min: 5, max: 30 },
  boostMax: 30,
  ...over
})

/** Runs ticks once a second from `start`, feeding fps(watts) each time; returns the last state and the writes. */
function run(
  state: DynamicState,
  fps: (watts: number) => number | null,
  seconds: number,
  c: DynamicConfig = cfg(),
  start = 1_000
): { state: DynamicState; writes: number[]; end: number } {
  const writes: number[] = []
  let s = state
  let t = start
  for (let i = 0; i < seconds; i++, t += 1_000) {
    const r = dynamicStep(s, fps(s.watts), t, c)
    s = r.state
    if (r.write) writes.push(r.write.watts)
  }
  return { state: s, writes, end: t }
}

describe('dynamic TDP limits', () => {
  it('narrows the PC range with the user floor and ceiling, and stays inside it', () => {
    expect(dynamicLimits({ min: 5, max: 30 }, { minWatts: null, maxWatts: null })).toEqual({
      min: 5,
      max: 30
    })
    expect(dynamicLimits({ min: 5, max: 30 }, { minWatts: 8, maxWatts: 20 })).toEqual({
      min: 8,
      max: 20
    })
    expect(dynamicLimits({ min: 5, max: 30 }, { minWatts: 3, maxWatts: 90 })).toEqual({
      min: 5,
      max: 30
    })
    // A floor above the ceiling wins.
    expect(dynamicLimits({ min: 5, max: 30 }, { minWatts: 25, maxWatts: 10 })).toEqual({
      min: 25,
      max: 25
    })
    expect(middleWatts({ min: 5, max: 30 })).toBe(18)
    expect(boostFor(20, { boostMax: 30, boostMargin: 5 })).toBe(25)
    expect(boostFor(28, { boostMax: 30, boostMargin: 5 })).toBe(30)
    expect(boostFor(30, { boostMax: 30, boostMargin: 5 })).toBe(30)
    expect(deadband(60)).toBe(3)
    expect(deadband(30)).toBe(2)
  })
})

describe('dynamic TDP step', () => {
  it('writes the start value on the first tick (the middle, or the value given), with boost', () => {
    const r = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0), null, 0, cfg())
    expect(r.write).toEqual({ watts: 18, boostWatts: 23 })
    expect(r.state.phase).toBe('measuring')
    const given = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0, 12), 60, 0, cfg())
    expect(given.write?.watts).toBe(12)
  })

  it('raises in proportion to the shortfall (at most 5 W), then waits for the frames to follow', () => {
    // The start value goes in at 0 s; judging starts once it settled (3 s).
    let s = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0, 10), 30, 0, cfg()).state
    expect(dynamicStep(s, 30, 2_000, cfg()).state.phase).toBe('settling')
    // Half the target: the full 5 W.
    const r = dynamicStep(s, 30, 3_000, cfg())
    expect(r.write).toEqual({ watts: 15, boostWatts: 20 })
    expect(r.state.phase).toBe('raising')
    s = r.state
    // Settling: no change for ~3 s even though the frames are still short.
    for (const t of [4_000, 5_000, 5_900]) {
      const x = dynamicStep(s, 30, t, cfg())
      expect(x.write).toBeNull()
      expect(x.state.phase).toBe('settling')
      s = x.state
    }
    expect(dynamicStep(s, 30, 6_000, cfg()).write?.watts).toBe(20)

    // A small shortfall (4 fps): 2 W.
    const near = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0, 10), 56, 0, cfg()).state
    expect(dynamicStep(near, 56, 3_000, cfg()).write?.watts).toBe(12)
  })

  it('lowers 1 W at a time above the target, and holds inside the deadband', () => {
    const s = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0, 20), 90, 0, cfg()).state
    const r = dynamicStep(s, 90, 3_000, cfg())
    expect(r.write).toEqual({ watts: 19, boostWatts: 24 })
    expect(r.state.phase).toBe('lowering')

    const inBand = dynamicStep(
      createDynamicState({ min: 5, max: 30 }, 60, 0, 20),
      61,
      0,
      cfg()
    ).state
    for (const f of [58, 61, 62.5, 57.5]) {
      const x = dynamicStep({ ...inBand, ema: f }, f, 3_000, cfg())
      expect(x.write).toBeNull()
      expect(x.state.phase).toBe('holding')
    }
  })

  it('settles near the watts where the target is met', () => {
    // A game that runs at 4 fps per watt: 60 fps needs 15 W.
    const first = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0, 6), 24, 0, cfg()).state
    const { state } = run(first, (w) => w * 4, 120)
    expect(state.watts).toBeGreaterThanOrEqual(14)
    expect(state.watts).toBeLessThanOrEqual(16)
    expect(Math.abs(state.ema! - 60)).toBeLessThanOrEqual(deadband(60) + 4)
  })

  it('smooths the frame rate: a short dip does not move the watts', () => {
    let s = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0, 15), 60, 0, cfg()).state
    for (let t = 1_000; t <= 5_000; t += 1_000) s = dynamicStep(s, 60, t, cfg()).state
    const r = dynamicStep(s, 50, 6_000, cfg())
    expect(r.state.ema!).toBeGreaterThan(57)
    expect(r.write).toBeNull()
    expect(r.state.phase).toBe('holding')
  })

  it('stops climbing at a plateau (more watts, no more frames), and tries again later or for a new target', () => {
    // The game is capped at 45 fps by the GPU, whatever the watts (45 fps from 12 W on).
    const first = dynamicStep(
      createDynamicState({ min: 5, max: 30 }, 60, 0, 12),
      45,
      0,
      cfg()
    ).state
    const capped = (w: number): number => Math.min(45, w * 4)
    const { state, end } = run(first, capped, 40)
    expect(state.phase).toBe('plateau')
    expect(state.ceiling).not.toBeNull()
    expect(state.plateau?.fps).toBeCloseTo(45, 0)
    // Back where the climb started, not left at the top.
    expect(state.watts).toBe(12)
    // Held until a minute after the plateau was found.
    const left = Math.floor((state.ceiling!.at + 60_000 - end) / 1_000)
    expect(left).toBeGreaterThan(5)
    const held = run(state, capped, left, cfg(), end)
    expect(held.writes).toEqual([])
    expect(held.state.phase).toBe('plateau')
    // A minute later it climbs again, from the plateau's watts.
    const later = dynamicStep(held.state, 45, state.ceiling!.at + 60_000, cfg())
    expect(later.state.ceiling).toBeNull()
    expect(later.state.phase).toBe('raising')
    expect(later.write?.watts).toBeLessThanOrEqual(12 + 5)
    // A new target forgets the plateau at once.
    const retarget = dynamicStep(held.state, 25, held.end, cfg({ targetFps: 30 }))
    expect(retarget.state.ceiling).toBeNull()
    expect(retarget.state.plateau).toBeNull()
  })

  it('a 30 fps-capped game settles near the least watts that hold 30 fps, not at the maximum', () => {
    // 4 fps per watt up to a 30 fps cap: 30 fps from 8 W on.
    const capped = (w: number): number => Math.min(30, w * 4)
    const first = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0), 30, 0, cfg()).state
    const { state, writes } = run(first, capped, 180)
    expect(Math.max(...writes)).toBeLessThan(30)
    expect(state.watts).toBeGreaterThanOrEqual(8)
    expect(state.watts).toBeLessThanOrEqual(9)
    expect(state.plateau?.floor).toBeGreaterThanOrEqual(8)
    // Over half an hour it stays low: the retries climb from there, gain nothing and come back.
    const ticks: number[] = []
    let s = state
    for (let t = 181_000; t < 181_000 + 1_800_000; t += 1_000) {
      s = dynamicStep(s, capped(s.watts), t, cfg()).state
      ticks.push(s.watts)
    }
    expect(ticks.reduce((a, b) => a + b, 0) / ticks.length).toBeLessThan(11)
    expect(Math.max(...ticks)).toBeLessThan(30)
  })

  it('waits twice as long after each retry that gains nothing, at most 10 minutes', () => {
    const capped = (w: number): number => Math.min(30, w * 4)
    let s = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0), 30, 0, cfg()).state
    const waits: number[] = []
    let last: number | null = null
    for (let t = 1_000; t < 3_600_000; t += 1_000) {
      s = dynamicStep(s, capped(s.watts), t, cfg()).state
      const r = s.ceiling?.retryMs ?? null
      if (r !== null && r !== last) waits.push(r)
      last = r ?? last
    }
    expect(waits.slice(0, 5)).toEqual([60_000, 120_000, 240_000, 480_000, 600_000])
    expect(Math.max(...waits)).toBe(600_000)
  })

  it('climbs again within a few ticks when a capped cutscene ends (frames above the plateau)', () => {
    // A 30 fps cutscene for 5 minutes: it settles on a plateau near 8 W.
    const cutscene = (w: number): number => Math.min(30, w * 4)
    const first = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0), 30, 0, cfg()).state
    const scene = run(first, cutscene, 300)
    expect(scene.state.plateau).not.toBeNull()
    expect(scene.state.ceiling).not.toBeNull()
    const ceilingWatts = scene.state.ceiling!.watts
    // Uncapped gameplay that needs more watts (60 fps at 12 W): it climbs again at once, not after the retry.
    const gameplay = (w: number): number => w * 5
    const after = run(scene.state, gameplay, 8, cfg(), scene.end)
    expect(after.state.plateau).toBeNull()
    expect(after.state.ceiling).toBeNull()
    expect(Math.max(...after.writes)).toBeGreaterThan(ceilingWatts)
    const settled = run(after.state, gameplay, 60, cfg(), after.end)
    expect(settled.state.watts).toBeGreaterThanOrEqual(11)
    expect(settled.state.watts).toBeLessThanOrEqual(14)
  })

  it('climbs again within a few ticks when the load changes (frames below the plateau at its ceiling)', () => {
    const s = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0, 10), 30, 0, cfg()).state
    const atCeiling: DynamicState = {
      ...s,
      plateau: { fps: 30, floor: 10, retryMs: 600_000 },
      ceiling: { watts: 10, at: 5_000, retryMs: 600_000 },
      climb: null,
      watts: 10,
      ema: 30,
      lastSampleAt: 9_000,
      lastChangeAt: 5_000
    }
    // A heavier scene: 20 fps at 10 W, 60 fps needs 30 W.
    const heavy = (w: number): number => w * 2
    const r = run(atCeiling, heavy, 8, cfg(), 10_000)
    expect(r.state.plateau).toBeNull()
    expect(Math.max(...r.writes)).toBeGreaterThan(10)
  })

  it('a climb that gains frames forgets the plateau', () => {
    const s = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0, 10), 40, 0, cfg()).state
    const withPlateau: DynamicState = {
      ...s,
      plateau: { fps: 40, floor: 10, retryMs: 240_000 },
      ceiling: null,
      climb: { fromWatts: 10, fps: 40 },
      watts: 16,
      ema: 50
    }
    const r = dynamicStep(withPlateau, 50, 10_000, cfg())
    expect(r.state.plateau).toBeNull()
    expect(r.state.phase).toBe('raising')
  })

  it('holds without frames, then goes to the middle of the range', () => {
    let s = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0, 28), 60, 0, cfg()).state
    s = dynamicStep(s, 60, 1_000, cfg()).state
    for (let t = 2_000; t < 11_000; t += 1_000) {
      const r = dynamicStep(s, null, t, cfg())
      expect(r.write).toBeNull()
      s = r.state
    }
    const r = dynamicStep(s, null, 11_000, cfg())
    expect(r.write).toEqual({ watts: 18, boostWatts: 23 })
    expect(r.state.phase).toBe('no-fps')
    expect(r.state.ema).toBeNull()
    expect(dynamicStep(r.state, null, 12_000, cfg()).write).toBeNull()
    // Before any frame the timeout counts from the start.
    const fresh = dynamicStep(
      createDynamicState({ min: 5, max: 30 }, 60, 0, 28),
      null,
      0,
      cfg()
    ).state
    expect(dynamicStep(fresh, null, 10_000, cfg()).write?.watts).toBe(18)
  })

  it('stays inside the range: holds at the maximum and the minimum, follows a narrowed range', () => {
    const top = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0, 30), 20, 0, cfg()).state
    const r = dynamicStep(top, 20, 3_000, cfg())
    expect(r.write).toBeNull()
    expect(r.state.phase).toBe('max')
    const bottom = dynamicStep(
      createDynamicState({ min: 5, max: 30 }, 60, 0, 5),
      200,
      0,
      cfg()
    ).state
    expect(dynamicStep(bottom, 200, 3_000, cfg()).state.phase).toBe('min')
    // The user lowered the ceiling under the value in force: it moves at once.
    const narrowed = dynamicStep(top, 60, 1_000, cfg({ limits: { min: 5, max: 20 } }))
    expect(narrowed.write?.watts).toBe(20)
  })

  it('writes at most every minWriteMs (ASUS firmware)', () => {
    const c = cfg({ minWriteMs: 5_000 })
    let s = dynamicStep(createDynamicState({ min: 5, max: 30 }, 60, 0, 20), 120, 0, c).state
    const times: number[] = []
    for (let t = 1_000; t <= 20_000; t += 1_000) {
      const r = dynamicStep(s, 120, t, c)
      if (r.write) times.push(t)
      s = r.state
    }
    for (let i = 1; i < times.length; i++)
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(5_000)
    expect(times.length).toBeGreaterThan(0)
  })
})
