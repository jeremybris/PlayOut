/**
 * "Free up memory while PlayOut is running" (Settings › System; main/performance/memory): what a cleanup pass did and
 * what the UI shows. Every technique is temporary: Windows pages the trimmed memory back in when a program needs it
 * and refills its cache by itself. Nothing is stopped, disabled or changed for good.
 */

/** Why a pass ran: the button, a game starting, or available memory running low. */
export type MemoryPassReason = 'manual' | 'session' | 'pressure'

/**
 * How far a pass reached: 'user' trims the working sets of the signed-in user's own background programs (no
 * administrator rights); 'system' goes through the power helper and also covers other accounts' programs and
 * Windows' memory lists.
 */
export type MemoryTier = 'user' | 'system'

export type MemoryStepState = 'done' | 'failed' | 'skipped'

/**
 * One step of a pass; `detail` says why it failed or was skipped. `ms` is how long it took (whole milliseconds):
 * absent for a step that was skipped or never started, and when the time is not known.
 */
export interface MemoryStep {
  state: MemoryStepState
  detail?: string
  ms?: number
}

/** The steps of a pass, in the order they ran. Only `workingSets` exists in a 'user' pass. */
export interface MemoryPassSteps {
  /** Background programs' working sets trimmed (the counts are the result's trimmed / denied / skipped). */
  workingSets: MemoryStep
  /** Modified pages written out, so they can be reused. */
  modifiedList?: MemoryStep
  /** The low-priority part of Windows' standby cache dropped. */
  lowPriorityStandby?: MemoryStep
  /**
   * The whole standby cache dropped: only when little memory was free after the steps before it although the cache
   * was large. It raises free memory, never available memory (the cache counts as available).
   */
  standby?: MemoryStep
  /** Identical memory pages merged. */
  combine?: MemoryStep
}

export interface MemoryPassResult {
  /** When the pass ended (ISO 8601). */
  at: string
  reason: MemoryPassReason
  tier: MemoryTier
  beforeAvailableMb: number
  afterAvailableMb: number
  /** afterAvailableMb - beforeAvailableMb, never negative. */
  freedMb: number
  /** Programs whose working set was trimmed. */
  trimmed: number
  /** Programs left alone: PlayOut, the game, the window in front, Windows, security software and the like. */
  skipped: number
  /** Programs Windows did not let PlayOut trim (another account's, elevated or protected ones). */
  denied: number
  steps: MemoryPassSteps
  /**
   * How long the cleanup itself took (whole milliseconds; all steps, as measured where they ran): not the wait
   * before available memory is read again. Absent when nothing ran or the time is not known.
   */
  durationMs?: number
  /** The pass did not finish (it timed out, or the process list could not be read). */
  error?: string
}

/**
 * Whether the power helper can do the system-wide part: 'ready'; 'missing' / 'outdated' (install it, or the newer
 * one, in Settings › System); 'not-answering' (installed, but it does not answer: remove it and install it again);
 * 'unavailable' on PCs the helper is not offered on; 'unknown' until the PC has been looked at (nothing is said).
 */
export type MemorySystemTier =
  'ready' | 'missing' | 'outdated' | 'not-answering' | 'unavailable' | 'unknown'

export interface MemoryStatus {
  /** settings.performance.memory.enabled. */
  enabled: boolean
  /** A pass is running now. */
  running: boolean
  systemWide: MemorySystemTier
  /** The last pass of this run; null before the first. */
  last: MemoryPassResult | null
}
