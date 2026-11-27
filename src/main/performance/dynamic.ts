import type { DynamicTdpStatus } from '../../shared/overlay'

/**
 * Dynamic TDP's controller (docs/home-overlay.md, Dynamic TDP): once a second the service hands it the measured frame
 * rate (or null) and it answers with the sustained watts to set, if they change. Pure: the service owns the timer,
 * the helper and the writes (service.ts).
 *
 * - The frame rate is smoothed (an exponential moving average over ~3 s), so one hitch does not move the watts.
 * - Below the target by more than the deadband (2 fps or 5 %, whichever is more) it raises the watts, by up to 5 W
 *   in proportion to the shortfall; above it by more than the deadband it lowers them by 1 W (slow down, fast up: a
 *   missing frame is felt, a spare watt is not).
 * - After a change it waits ~3 s for the frame rate to follow before judging again.
 * - Plateau: when climbing ~6 W gave (almost) no more frames (the GPU, a frame cap or v-sync limits the game), it
 *   goes back to where that climb started (the lowest watts known to reach that frame rate) and remembers the
 *   plateau's frame rate. While the plateau holds it keeps lowering 1 W at a time as long as the frames stay at the
 *   plateau (and steps back up 1 W, remembering that floor, when they drop), so a capped game settles near the least
 *   watts that still hold its cap. It tries climbing again (from there) after a minute; when that retry again gains
 *   nothing, after twice as long each time (at most 10 minutes). A new target, a climb that gains frames, a stretch
 *   without frames, or frames leaving the plateau (above it: the cap lifted; below it at the ceiling's watts: the
 *   load changed) forget the plateau.
 * - No frames for a while (a menu that does not present, a game PresentMon cannot see): it holds, then goes to a safe
 *   middle value.
 * - Always inside the PC's range and the user's optional floor and ceiling; boost = sustained + a margin, capped.
 * - Writes only when the value changes, and at most every `minWriteMs` (ASUS firmware writes are slow).
 */

export interface WattsLimits {
  min: number
  max: number
}

export interface DynamicConfig {
  targetFps: number
  /** The range Dynamic TDP may use (the PC's range narrowed by the user's floor and ceiling). */
  limits: WattsLimits
  /** The highest boost limit the PC takes. */
  boostMax: number
  /** Boost = sustained + this, watts. */
  boostMargin: number
  /** The moving average's time constant, seconds. */
  emaSeconds: number
  /** How long to wait after a change before judging again, ms. */
  settleMs: number
  /** The largest single raise, watts. */
  maxRaise: number
  /** Each lowering step, watts. */
  lowerStep: number
  /** Climbing this many watts without plateauGainFps more frames = a plateau. */
  plateauWatts: number
  /** The least gain over plateauWatts that is still worth climbing for (at least this, or 2 % of the target). */
  plateauGainFps: number
  /** How long a plateau holds before climbing is tried again, ms (doubled after each fruitless retry). */
  plateauRetryMs: number
  /** The longest wait between retries, ms. */
  plateauRetryMaxMs: number
  /** No frames for this long: go to the middle of the range, ms. */
  noFpsTimeoutMs: number
  /** At most one write per this many ms (0: no limit). */
  minWriteMs: number
}

export const DYNAMIC_TICK_MS = 1_000

export const DYNAMIC_DEFAULTS: Omit<DynamicConfig, 'targetFps' | 'limits' | 'boostMax'> = {
  boostMargin: 5,
  emaSeconds: 3,
  settleMs: 3_000,
  maxRaise: 5,
  lowerStep: 1,
  plateauWatts: 6,
  plateauGainFps: 1,
  plateauRetryMs: 60_000,
  plateauRetryMaxMs: 600_000,
  noFpsTimeoutMs: 10_000,
  minWriteMs: 0
}

/** ASUS firmware watts: at most one write every 5 s. */
export const ASUS_MIN_WRITE_MS = 5_000

export interface DynamicState {
  /** The sustained limit in force (or about to be written on the first step). */
  watts: number
  written: boolean
  /** The smoothed frame rate; null until frames come (and again after the no-frames timeout). */
  ema: number | null
  /** The last raw sample (for the readout). */
  fps: number | null
  startedAt: number
  lastSampleAt: number | null
  lastChangeAt: number | null
  lastWriteAt: number | null
  /** Where the current climb started, and the frame rate there. */
  climb: { fromWatts: number; fps: number } | null
  /** A plateau in force: no climbing above `watts` until `at` + `retryMs`. */
  ceiling: { watts: number; at: number; retryMs: number } | null
  /**
   * The last plateau found (kept across a retry, so a fruitless one waits longer): its frame rate, the lowest watts
   * known to still hold it (`floor`, raised when a step down lost frames) and the wait before the next retry.
   */
  plateau: { fps: number; floor: number; retryMs: number } | null
  /** The target the plateau and climb were judged against. */
  target: number
  phase: DynamicTdpStatus['state']
}

export interface DynamicStepResult {
  state: DynamicState
  /** The limits to write now, or null to leave them. */
  write: { watts: number; boostWatts: number } | null
}

const clamp = (v: number, l: WattsLimits): number => Math.min(l.max, Math.max(l.min, Math.round(v)))

/** The PC's range narrowed by the user's floor and ceiling (ignored when outside it; a floor above the ceiling wins). */
export function dynamicLimits(
  device: WattsLimits,
  user: { minWatts: number | null; maxWatts: number | null }
): WattsLimits {
  const min = Math.ceil(device.min)
  const max = Math.max(min, Math.floor(device.max))
  const lo = user.minWatts !== null ? Math.min(max, Math.max(min, user.minWatts)) : min
  const hi = user.maxWatts !== null ? Math.min(max, Math.max(min, user.maxWatts)) : max
  return { min: lo, max: Math.max(lo, hi) }
}

export function middleWatts(l: WattsLimits): number {
  return Math.round((l.min + l.max) / 2)
}

export function boostFor(
  watts: number,
  cfg: Pick<DynamicConfig, 'boostMax' | 'boostMargin'>
): number {
  return Math.max(watts, Math.min(cfg.boostMax, watts + cfg.boostMargin))
}

export function deadband(targetFps: number): number {
  return Math.max(2, targetFps * 0.05)
}

/** A fresh controller: starts at `startWatts` (default the middle of the range), written on the first step. */
export function createDynamicState(
  limits: WattsLimits,
  targetFps: number,
  now: number,
  startWatts?: number
): DynamicState {
  return {
    watts: clamp(startWatts ?? middleWatts(limits), limits),
    written: false,
    ema: null,
    fps: null,
    startedAt: now,
    lastSampleAt: null,
    lastChangeAt: null,
    lastWriteAt: null,
    climb: null,
    ceiling: null,
    plateau: null,
    target: targetFps,
    phase: 'measuring'
  }
}

/** One tick: `fps` is the frame rate measured over the last ~1.5 s, or null when no frames came. */
export function dynamicStep(
  prev: DynamicState,
  fps: number | null,
  now: number,
  cfg: DynamicConfig
): DynamicStepResult {
  const s: DynamicState = { ...prev }
  const l = cfg.limits

  // A new target: what was learned about climbing no longer applies.
  if (s.target !== cfg.targetFps) {
    s.target = cfg.targetFps
    s.climb = null
    s.ceiling = null
    s.plateau = null
  }
  // The retry: climbing is allowed again (from the watts in force); the plateau's memory stays.
  if (s.ceiling && now - s.ceiling.at >= s.ceiling.retryMs) s.ceiling = null

  const change = (next: number, phase: DynamicState['phase']): DynamicStepResult => {
    const watts = clamp(next, l)
    if (s.written && watts === s.watts) {
      s.phase = phase
      return { state: s, write: null }
    }
    if (
      s.written &&
      cfg.minWriteMs > 0 &&
      s.lastWriteAt !== null &&
      now - s.lastWriteAt < cfg.minWriteMs
    ) {
      // Too soon for this backend: judge again on a later tick.
      s.phase = 'settling'
      return { state: s, write: null }
    }
    s.watts = watts
    s.written = true
    s.lastWriteAt = now
    s.lastChangeAt = now
    s.phase = phase
    return { state: s, write: { watts, boostWatts: boostFor(watts, cfg) } }
  }
  const hold = (phase: DynamicState['phase']): DynamicStepResult => {
    // The first step always writes the start value (and a range change moves a value now outside it).
    if (!s.written || clamp(s.watts, l) !== s.watts) return change(s.watts, phase)
    s.phase = phase
    return { state: s, write: null }
  }

  // --- the sample ---
  if (fps !== null && Number.isFinite(fps) && fps > 0) {
    const dt = s.lastSampleAt === null ? null : (now - s.lastSampleAt) / 1000
    const alpha =
      dt === null || s.ema === null ? 1 : 1 - Math.exp(-Math.max(0, dt) / cfg.emaSeconds)
    s.ema = s.ema === null ? fps : s.ema + alpha * (fps - s.ema)
    s.fps = fps
    s.lastSampleAt = now
  } else {
    s.fps = null
    const since = now - (s.lastSampleAt ?? s.startedAt)
    if (since >= cfg.noFpsTimeoutMs) {
      s.ema = null
      s.climb = null
      s.ceiling = null
      s.plateau = null
      return change(middleWatts(l), 'no-fps')
    }
    return hold(s.phase === 'no-fps' ? 'no-fps' : 'measuring')
  }

  // The first step only puts the start value in; judging starts with the frames that follow it.
  if (!s.written) return change(s.watts, 'measuring')
  const ema = s.ema!
  if (s.lastChangeAt !== null && now - s.lastChangeAt < cfg.settleMs) return hold('settling')

  const band = deadband(cfg.targetFps)
  const minGain = Math.max(cfg.plateauGainFps, cfg.targetFps * 0.02)
  /** The climb gained nothing: back to where it started, and no climbing above that until the retry. */
  const plateauFound = (climb: { fromWatts: number; fps: number }): DynamicStepResult => {
    // A plateau already known = this was a retry that gained nothing: wait longer before the next one.
    const retryMs = s.plateau
      ? Math.min(cfg.plateauRetryMaxMs, s.plateau.retryMs * 2)
      : cfg.plateauRetryMs
    const fromWatts = clamp(climb.fromWatts, l)
    s.plateau = {
      fps: Math.max(climb.fps, s.plateau?.fps ?? 0),
      floor: Math.min(fromWatts, s.plateau?.floor ?? l.min),
      retryMs
    }
    s.ceiling = { watts: fromWatts, at: now, retryMs }
    s.climb = null
    return change(fromWatts, 'plateau')
  }
  if (ema < cfg.targetFps - band) {
    if (s.ceiling && s.plateau) {
      // The frames left the plateau: above it (the cap lifted) or below it at the ceiling's watts (the load
      // changed). What the plateau taught no longer applies: forget it and climb normally.
      const p = s.plateau
      if (ema > p.fps + minGain || (ema < p.fps - minGain && s.watts >= s.ceiling.watts)) {
        s.plateau = null
        s.ceiling = null
        s.climb = null
      }
    }
    if (s.ceiling && s.plateau) {
      // Below the target, but more watts do not help: hold the plateau's frames with the fewest watts.
      const p = s.plateau
      if (s.watts > s.ceiling.watts) return change(s.ceiling.watts, 'plateau')
      if (ema >= p.fps - minGain) {
        if (s.watts > Math.max(l.min, p.floor)) return change(s.watts - cfg.lowerStep, 'lowering')
        return hold('plateau')
      }
      // The frames dropped under the plateau: that step down was one too many.
      if (s.watts < s.ceiling.watts) {
        const back = Math.min(s.ceiling.watts, s.watts + cfg.lowerStep)
        s.plateau = { ...p, floor: Math.max(p.floor, back) }
        return change(back, 'raising')
      }
      return hold('plateau')
    }
    if (s.watts >= l.max) {
      // The top reached on a climb that gained nothing either: a plateau too.
      if (
        s.climb &&
        s.watts - s.climb.fromWatts >= Math.ceil(cfg.plateauWatts / 2) &&
        ema - s.climb.fps < minGain
      )
        return plateauFound(s.climb)
      s.climb = null
      return hold('max')
    }
    if (s.climb && s.watts - s.climb.fromWatts >= cfg.plateauWatts) {
      if (ema - s.climb.fps < minGain) return plateauFound(s.climb)
      // More watts brought frames: whatever limited the game before does not any more.
      s.plateau = null
      s.climb = { fromWatts: s.watts, fps: ema }
    }
    if (!s.climb) s.climb = { fromWatts: s.watts, fps: ema }
    const shortfall = (cfg.targetFps - ema) / cfg.targetFps
    const step = Math.min(cfg.maxRaise, Math.max(1, Math.ceil(shortfall * 25)))
    return change(Math.min(l.max, s.watts + step), 'raising')
  }
  s.climb = null
  if (ema > cfg.targetFps + band) {
    if (s.watts <= l.min) return hold('min')
    return change(s.watts - cfg.lowerStep, 'lowering')
  }
  return hold('holding')
}
