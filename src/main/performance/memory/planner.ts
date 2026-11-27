import type { MemoryPassReason } from '../../../shared/memory'

/**
 * When a memory cleanup pass runs. Pure: the service gives it the clock and the memory reading and does what it
 * answers. A pass is never periodic: trimmed programs page their memory back in when they are used again, so a pass
 * only runs when it is worth that (a game starts, or available memory is low), and never twice in a short time.
 */

/** How often available memory is sampled while the setting is on. */
export const SAMPLE_MS = 30_000
/** A game's start is left alone for this long before its pass. */
export const SESSION_DELAY_MS = 20_000
/** The pass after a game's start is skipped when one ran this recently. */
export const SESSION_MIN_GAP_MS = 60_000
/**
 * Between two passes for low memory: after the first, the second and every later pass of one low-memory episode.
 * Memory that stays low although passes run is a game that needs it, not something another pass fixes: the passes
 * get rarer instead of trimming the same background programs every few minutes.
 */
export const PRESSURE_COOLDOWNS_MS: readonly number[] = [3 * 60_000, 10 * 60_000, 30 * 60_000]
/** Between two passes for low memory (the first step of PRESSURE_COOLDOWNS_MS). */
export const COOLDOWN_MS = 3 * 60_000
/** Between two passes for low memory when the last one freed almost nothing (it would not help now either). */
export const LOW_YIELD_COOLDOWN_MS = 10 * 60_000
/** "Almost nothing". */
export const LOW_YIELD_MB = 150
/** A low-memory episode is over once memory has not been low for this long: the cooldowns start short again. */
export const EPISODE_RECOVERY_MS = 10 * 60_000
/** After a pass for low memory that could not decide what to trim (passSkipped): not asked again for this long. */
export const SKIP_BACKOFF_MS = 2 * 60_000
/** A pass that has not ended after this long is given up on. */
export const PASS_TIMEOUT_MS = 60_000

const LOW_SHARE = 0.15
const LOW_FLOOR_MB = 2048
/** On small PCs the 2 GB floor would be most of the memory: never more than this share of the total. */
const LOW_CAP_SHARE = 0.3
/** On big PCs 15 % is many GB that nothing misses: never more than this. */
const LOW_CAP_MB = 4096
/** The whole standby cache is dropped only with less free memory than this share of the "low" line. */
const STANDBY_SHARE = 0.5

/**
 * Available memory under this is "low": 15 % of the total or 2 GB, whichever is larger, but never more than 30 % of
 * the total nor more than 4 GB (4 GB PC: 1.2 GB; 8 GB: 2 GB; 16 GB: 2.4 GB; 32 GB and above: 4 GB).
 */
export function lowMemoryThresholdMb(totalMb: number): number {
  if (!Number.isFinite(totalMb) || totalMb <= 0) return 0
  return Math.round(
    Math.min(Math.max(totalMb * LOW_SHARE, LOW_FLOOR_MB), totalMb * LOW_CAP_SHARE, LOW_CAP_MB)
  )
}

export function isMemoryLow(availableMb: number, totalMb: number): boolean {
  return (
    Number.isFinite(availableMb) && availableMb >= 0 && availableMb < lowMemoryThresholdMb(totalMb)
  )
}

/** What the planner remembers between calls. */
export interface PlannerState {
  /** When the last pass ended, and what it freed; null before the first. */
  lastPassAt: number | null
  lastFreedMb: number | null
  /** When the pass of the game that just started is due; null when none is waiting. */
  sessionDueAt: number | null
  /** When memory was last seen low; null when no low-memory episode is open. */
  lastLowAt: number | null
  /** Passes for low memory in the open episode (they lengthen the cooldown). */
  episodePasses: number
  /** The whole standby cache was dropped in the open episode: not again until memory has recovered. */
  episodePurged: boolean
  /** No pass for low memory before this (passSkipped); null when nothing holds it back. */
  blockedUntil: number | null
}

export const INITIAL_PLANNER_STATE: PlannerState = Object.freeze({
  lastPassAt: null,
  lastFreedMb: null,
  sessionDueAt: null,
  lastLowAt: null,
  episodePasses: 0,
  episodePurged: false,
  blockedUntil: null
})

/** A game started: its pass is due after SESSION_DELAY_MS (replacing one still waiting). */
export function sessionStarted(state: PlannerState, now: number): PlannerState {
  return { ...state, sessionDueAt: now + SESSION_DELAY_MS }
}

/** The game ended before its pass: nothing waits any more. */
export function sessionEnded(state: PlannerState): PlannerState {
  return state.sessionDueAt === null ? state : { ...state, sessionDueAt: null }
}

/** What a pass was, for the cooldowns: why it ran and whether it dropped the whole standby cache. */
export interface PassOutcome {
  reason?: MemoryPassReason
  standbyPurged?: boolean
}

/**
 * A pass ended (any reason, also a manual one): the cooldowns count from here. A pass for low memory counts towards
 * the open episode, so the next one waits longer.
 */
export function passEnded(
  state: PlannerState,
  now: number,
  freedMb: number,
  outcome: PassOutcome = {}
): PlannerState {
  return {
    ...state,
    lastPassAt: now,
    lastFreedMb: Math.max(0, freedMb),
    episodePasses: state.episodePasses + (outcome.reason === 'pressure' ? 1 : 0),
    episodePurged: state.episodePurged || outcome.standbyPurged === true,
    blockedUntil: null
  }
}

/**
 * A pass for low memory did nothing because it could not tell what to leave alone (the game's programs or the window
 * in front were unknown): not a pass (no cooldown), but it is not tried again at every sample either.
 */
export function passSkipped(state: PlannerState, now: number): PlannerState {
  return { ...state, blockedUntil: now + SKIP_BACKOFF_MS }
}

/**
 * The cooldown after the last pass: longer with every pass for low memory in the same episode (3, 10, 30 minutes),
 * and at least LOW_YIELD_COOLDOWN_MS when the last pass freed almost nothing.
 */
export function cooldownMs(state: PlannerState): number {
  const step = Math.min(Math.max(0, state.episodePasses - 1), PRESSURE_COOLDOWNS_MS.length - 1)
  const episode = PRESSURE_COOLDOWNS_MS[step] ?? COOLDOWN_MS
  return state.lastFreedMb !== null && state.lastFreedMb < LOW_YIELD_MB
    ? Math.max(episode, LOW_YIELD_COOLDOWN_MS)
    : episode
}

/** Memory was read: a low reading opens or continues the episode; enough of it for long enough closes it. */
function episodeAfter(state: PlannerState, now: number, low: boolean): PlannerState {
  if (low) return state.lastLowAt === now ? state : { ...state, lastLowAt: now }
  if (state.lastLowAt === null || now - state.lastLowAt < EPISODE_RECOVERY_MS) return state
  return { ...state, lastLowAt: null, episodePasses: 0, episodePurged: false }
}

export interface PlannerInput {
  now: number
  /** settings.performance.memory.enabled. */
  enabled: boolean
  /** The PC is going to sleep, or PlayOut is quitting. */
  paused: boolean
  /** A pass is running (passes never overlap). */
  running: boolean
  availableMb: number
  totalMb: number
}

export type PlannerDecision =
  | { run: false; why: 'off' | 'paused' | 'running' | 'waiting' | 'enough' | 'cooldown' }
  | { run: true; reason: Exclude<MemoryPassReason, 'manual'> }

/**
 * Whether a pass should start now, and the state to keep. A due session pass comes first (dropped, not postponed,
 * when it cannot run or one ran within SESSION_MIN_GAP_MS); otherwise only low memory starts one, and only after the
 * cooldown, which grows while memory stays low (cooldownMs).
 */
export function planPass(
  state: PlannerState,
  input: PlannerInput
): { decision: PlannerDecision; state: PlannerState } {
  const { now } = input
  if (!input.enabled) return { decision: { run: false, why: 'off' }, state: sessionEnded(state) }
  const low = isMemoryLow(input.availableMb, input.totalMb)
  state = episodeAfter(state, now, low)
  if (input.paused) return { decision: { run: false, why: 'paused' }, state }
  if (input.running) return { decision: { run: false, why: 'running' }, state }
  if (state.sessionDueAt !== null) {
    if (now < state.sessionDueAt) return { decision: { run: false, why: 'waiting' }, state }
    const next = { ...state, sessionDueAt: null }
    const recent = state.lastPassAt !== null && now - state.lastPassAt < SESSION_MIN_GAP_MS
    if (!recent) return { decision: { run: true, reason: 'session' }, state: next }
    state = next
  }
  if (!low) return { decision: { run: false, why: 'enough' }, state }
  if (state.lastPassAt !== null && now - state.lastPassAt < cooldownMs(state))
    return { decision: { run: false, why: 'cooldown' }, state }
  if (state.blockedUntil !== null && now < state.blockedUntil)
    return { decision: { run: false, why: 'cooldown' }, state }
  return { decision: { run: true, reason: 'pressure' }, state }
}

/**
 * The free memory (zeroed and free pages, not "available" memory: the cache itself counts as available) under which
 * the helper also drops the whole standby cache, when the cache holds at least as much: half the "low" line, read
 * after the steps before it. Dropping the cache cannot raise available memory, it only frees pages ahead of time,
 * and the game reads its files from it: so at most once per low-memory episode, and never when the cache is small
 * (nothing to gain). 0 (never) when the total is unknown or this episode already had its purge.
 */
export function standbyPurgeBelowMb(totalMb: number, state?: PlannerState): number {
  if (state?.episodePurged) return 0
  return Math.round(lowMemoryThresholdMb(totalMb) * STANDBY_SHARE)
}
