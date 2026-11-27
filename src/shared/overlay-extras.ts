/**
 * The overlay's extra quick settings (docs/home-overlay.md): the live FPS and watts header chips, the frame rate
 * limit (RivaTuner Statistics Server, per game), "Sync FPS + refresh", the performance overlay drawn by RTSS, Auto HDR
 * and the CPU boost tile. Shared between the main process (main/overlay/extras.ts, main/rtss) and the overlay.
 */

import type { PowerChoice, PowerProfileId } from './overlay'

/** The frame rate limits the drawer offers (0 = unlimited, shown as ∞); the display's current rate is added. */
export const FRAME_LIMIT_PRESETS: readonly number[] = [30, 40, 45, 60, 72, 90, 120]
/** Highest limit accepted (RTSS allows more, but nothing above a 1000 Hz display makes sense). */
export const FRAME_LIMIT_MAX = 1000

/** The drawer's choices: 0 (∞), the presets and the display's rate (rounded) when not one of them, ascending. */
export function frameLimitOptions(hz?: number | null): number[] {
  const out = [...FRAME_LIMIT_PRESETS]
  const rate = typeof hz === 'number' && Number.isFinite(hz) ? Math.round(hz) : 0
  if (rate > 1 && rate <= FRAME_LIMIT_MAX && !out.includes(rate)) out.push(rate)
  return [0, ...out.sort((a, b) => a - b)]
}

/**
 * The frame limit and Sync FPS + refresh tiles passed the in-game check (2026-11-15, TowerFall Ascension, RTSS 7.3.7:
 * ~138 FPS uncapped, 30 with Limit=30, 43-45 with 45, ~135 again after ∞ removed the profile PlayOut had created; each
 * change took effect within about 2 s of PlayOut's profile reload). Set false to hide them again (PLAYOUT_RTSS_TILES=1
 * still turns them on for a check).
 */
export const RTSS_TILES_VERIFIED = true

/**
 * The performance overlay tile passed the in-game check (2026-11-14, Spelunky 2: PlayOut's text drawn by RivaTuner in
 * the game's corner, updated each second, and the slot released afterwards).
 */
export const RTSS_OSD_VERIFIED = true

/** The performance overlay: 0 off, 1 FPS, 2 FPS + frame time + CPU % + GPU % + watts, 3 adds RAM, battery and time. */
export type PerfOverlayLevel = 0 | 1 | 2 | 3
export const PERF_OVERLAY_LEVELS: readonly PerfOverlayLevel[] = [0, 1, 2, 3]

/** The presets whose CPU boost the tile overrides (Custom's own cpuBoost is edited directly). */
export type BoostPresetId = Exclude<PowerProfileId, 'custom'>

/**
 * RivaTuner Statistics Server on this PC: 'missing' = not installed; 'stopped' = installed, not running (its shared
 * memory is absent); 'running' = its shared memory answers (signature 'RTSS', v2.x).
 */
export interface RtssStatus {
  state: 'missing' | 'stopped' | 'running'
  /** Its version from the registry (ProductVersion), e.g. '7.3.7'. */
  version?: string
}

/**
 * Why a tile cannot act, in one sentence for the tile's detail line; absent when it can. Used by every tile below.
 */
export type TileReason = string

export interface FrameLimitStatus {
  /** The tile can change the limit now (RTSS running, power helper ready at protocol >= 3, a game to apply it to). */
  available: boolean
  reason?: TileReason
  /** The limit in effect for the target: 0 = unlimited. With sync on, the display's rate. */
  fps: number
  /** The game's own remembered choice (0 = unlimited), regardless of sync. */
  chosen: number
  /** What the drawer lists: 0 first, then FRAME_LIMIT_PRESETS and the display's current rate, ascending. */
  options: number[]
  /** The program the limit applies to (RTSS's per-exe profile), e.g. 'JWE3.exe'; absent without a target. */
  exe?: string
  /** The PlayOut game it is remembered for; absent when the target is a program PlayOut did not start. */
  gameId?: string
}

export interface SyncRefreshStatus {
  /** settings.performance.syncFpsToRefresh. */
  enabled: boolean
  /** Same availability as the frame limit (sync drives it). */
  available: boolean
  reason?: TileReason
  /** The display's current rate, rounded (what the limit follows while on); absent when unknown. */
  hz?: number
}

export interface PerfOverlayStatus {
  /** settings.performance.perfOverlay. */
  level: PerfOverlayLevel
  /** RTSS is running (the overlay is drawn by it). */
  available: boolean
  reason?: TileReason
  /** The overlay is being drawn now (a game runs and the level is not 0). */
  drawing: boolean
}

export interface AutoHdrStatus {
  /** The global AutoHDREnable token: true = 1, false = 0, null = not set / unreadable. */
  enabled: boolean | null
  /** Windows HDR is on for the overlay's display: null when it could not be read. */
  hdrOn: boolean | null
  /** False while Windows HDR is off for the display (reason says so) or the value cannot be written. */
  available: boolean
  reason?: TileReason
  /** Always 'Applies to games started next' (the tile's detail line). */
  note: string
}

export interface CpuBoostStatus {
  /** Boost in the config in effect (the active profile's, with its override). */
  enabled: boolean
  /** False while Dynamic TDP is in effect ('Managed by Dynamic TDP') or no profile is ('Windows controls it'). */
  available: boolean
  reason?: TileReason
  /** The profile the tile changes (custom: its own cpuBoost; a preset: settings.performance.boostOverrides). */
  profile: PowerChoice | null
  /** A preset's override is in force (its built-in value is the other one). */
  overridden: boolean
}

/** Everything the extra tiles show; emitted on 'overlay:extras' whenever any part changes. */
export interface OverlayExtrasStatus {
  rtss: RtssStatus
  /** The frame limit and sync tiles are offered (RTSS_TILES_VERIFIED); hidden when false. */
  rtssTiles: boolean
  /** The performance overlay tile is offered (RTSS_OSD_VERIFIED); hidden when false. */
  osdTile: boolean
  frameLimit: FrameLimitStatus
  sync: SyncRefreshStatus
  perfOverlay: PerfOverlayStatus
  autoHdr: AutoHdrStatus
  cpuBoost: CpuBoostStatus
  /** Another program also driving RTSS (Winhanced), in one sentence; absent when none. */
  clash?: string
}

/** The header chips' live readings, polled about once a second while the overlay is open. */
export interface LiveStats {
  /** The game's frame rate (whole frames), or null when none is measured. */
  fps: number | null
  frameTimeMs?: number
  /** Where fps came from: RTSS's shared memory, or the power helper's PresentMon (Dynamic TDP). */
  fpsSource: 'rtss' | 'presentmon' | null
  /** The CPU's power now, or Dynamic TDP's set watts, rounded; null when unknown (the chip hides). */
  watts: number | null
}

/** One Intel graphics driver setting (main/intel/intel-graphics.ts, through the Intel Graphics Control Library). */
export interface IntelFeatureStatus {
  supported: boolean
  /** The current value as one of `options[].key`; null when unknown. */
  value: string | null
  /** The values the driver lists, in its order ('off', 'auto:balanced', ...). */
  options: { key: string; label: string }[]
  /** Why the feature is unavailable (supported false) or the last error. */
  reason?: string
  /** This PC has no Intel graphics driver or adapter for it (64-bit included): the tile is not shown at all. */
  absent?: boolean
}

/** The Intel driver settings the overlay offers; a feature is absent when this PC has no Intel driver for it. */
export interface IntelGraphicsStatus {
  /** Endurance Gaming: the driver's battery saver for games (global, every game). */
  enduranceGaming?: IntelFeatureStatus
  /** Never set: the frame generation override is not offered (the probed driver lists no values for it). */
  frameGenOverride?: IntelFeatureStatus
}
