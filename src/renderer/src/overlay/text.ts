/**
 * Pure text and list helpers for the overlay (docs/home-overlay.md) and Settings › Controls' home button group.
 * Kept free of React so they can be unit tested (text.test.ts). The words come from the overlay language file
 * (src/shared/i18n/locales/<language>/overlay.json), read in the current language at each call.
 */
import { t } from '../i18n'
import {
  DYNAMIC_FPS,
  PAD_BUTTON_LABELS,
  type DisplayMode,
  type DynamicTdpStatus,
  type HomeButtonStatus,
  type OverrideStatus,
  type PadButton,
  type PerformanceStatus,
  type PowerChoice,
  type PowerHelperState,
  type PowerProfileConfig,
  type PowerProfileId,
  type WattsBackendStatus
} from '@shared/overlay'
import type {
  IntelFeatureStatus,
  LiveStats,
  OverlayExtrasStatus,
  PerfOverlayLevel
} from '@shared/overlay-extras'
import type { PerfSample, Settings } from '@shared/types'

export type ProfileChoice = PowerChoice | 'none'

/**
 * The profile cards in the order the overlay shows them without a ready power helper; 'none' = PlayOut leaves
 * Windows as it is.
 */
export const PROFILE_CHOICES: readonly ProfileChoice[] = [
  'silent',
  'balanced',
  'performance',
  'custom',
  'none'
]

/**
 * With the power helper ready: Dynamic TDP first (the default), Custom watts, Off. The fallback profiles (Silent,
 * Balanced, Performance) are not offered: one saved before the helper runs, and shows, as Dynamic TDP.
 */
export const HELPER_PROFILE_CHOICES: readonly ProfileChoice[] = ['dynamic', 'custom', 'none']

/** True when Dynamic TDP is available (the power helper is installed, answering and new enough). */
export function dynamicAvailable(helper: PowerHelperState | undefined): boolean {
  return helper === 'ready'
}

/** The cards (and the 'Outside games' choices) for this PC. */
export function profileChoices(helper: PowerHelperState | undefined): readonly ProfileChoice[] {
  return dynamicAvailable(helper) ? HELPER_PROFILE_CHOICES : PROFILE_CHOICES
}

/**
 * A choice as it applies on this PC (what the main process does): with a ready helper the fallback profiles are
 * Dynamic TDP. Undefined and null stay as they are.
 */
export function shownChoice<T extends ProfileChoice | undefined | null>(
  choice: T,
  helper: PowerHelperState | undefined
): T | 'dynamic' {
  return dynamicAvailable(helper) && choice && !HELPER_PROFILE_CHOICES.includes(choice)
    ? 'dynamic'
    : choice
}

/** A profile's name, in the current language (a function, so a language change shows at the next render). */
export function profileLabel(choice: ProfileChoice): string {
  const labels: Record<ProfileChoice, string> = {
    dynamic: t('overlay.profiles.labels.dynamic'),
    silent: t('overlay.profiles.labels.silent'),
    balanced: t('overlay.profiles.labels.balanced'),
    performance: t('overlay.profiles.labels.performance'),
    custom: t('overlay.profiles.labels.custom'),
    none: t('overlay.profiles.labels.none')
  }
  return labels[choice]
}

/** What a profile does in a word or two (the cards sit five in a row), for cards without watts. */
export function profileDescription(choice: ProfileChoice): string {
  const descriptions: Record<ProfileChoice, string> = {
    dynamic: t('overlay.profiles.descriptions.dynamic'),
    silent: t('overlay.profiles.descriptions.silent'),
    balanced: t('overlay.profiles.descriptions.balanced'),
    performance: t('overlay.profiles.descriptions.performance'),
    custom: t('overlay.profiles.descriptions.custom'),
    none: t('overlay.profiles.descriptions.none')
  }
  return descriptions[choice]
}

/** '60 fps': a frame rate as the profile cards, chips and selects write it. */
export function formatFps(fps: number): string {
  return t('overlay.fps', { fps })
}

/**
 * The 'Outside games' value as the UI shows it (what the main process does): 'auto' (the factory default) is Dynamic
 * TDP with a ready helper and Off without; a saved fallback profile is Dynamic TDP with the helper; a saved 'dynamic'
 * without the helper runs as Balanced.
 */
export function effectiveDefaultProfile(
  value: Settings['performance']['defaultProfile'],
  helper: PowerHelperState | undefined
): ProfileChoice {
  const ready = dynamicAvailable(helper)
  if (value === 'auto') return ready ? 'dynamic' : 'none'
  if (value === 'dynamic' && !ready) return 'balanced'
  return shownChoice(value, helper)
}

/** Dynamic TDP's target as a whole number in range. */
export function clampTargetFps(fps: number): number {
  return Math.min(DYNAMIC_FPS.max, Math.max(DYNAMIC_FPS.min, Math.round(fps)))
}

/** The live readout under Dynamic TDP: '58 fps · 14 W', or what it is waiting for. */
export function dynamicReadout(d: DynamicTdpStatus | undefined): string {
  if (!d) return ''
  const watts = d.watts !== undefined ? formatWatts(d.watts) : null
  const fps = d.fps !== undefined ? formatFps(Math.round(d.fps)) : null
  switch (d.state) {
    case 'idle':
      return t('overlay.dynamic.idle', { fps: d.targetFps })
    case 'no-fps':
      return watts ? t('overlay.dynamic.noFpsWatts', { watts }) : t('overlay.dynamic.noFps')
    case 'measuring':
      if (!fps)
        return watts
          ? t('overlay.dynamic.measuringWatts', { watts })
          : t('overlay.dynamic.measuring')
  }
  // The readings themselves ('58 fps · 14 W'): numbers and units, joined the same way in every language.
  const reading = [fps, watts].filter(Boolean).join(' · ')
  if (d.state === 'plateau') return t('overlay.dynamic.plateau', { reading })
  if (d.state === 'max') return t('overlay.dynamic.max', { reading })
  return reading
}

/** True when watts can be set: the helper answers and the user wants watts. */
export function wattsReady(watts: WattsBackendStatus | undefined, useWatts: boolean): boolean {
  return useWatts && watts?.state === 'ready'
}

/** '15 W'; a fraction keeps one decimal ('7.5 W'). */
export function formatWatts(watts: number): string {
  return `${Math.round(watts * 10) / 10} W`
}

/** The line under a profile card: its watts when they apply, else what the profile does. */
export function profileDetail(
  choice: ProfileChoice,
  config: PowerProfileConfig | undefined,
  ready: boolean,
  targetFps?: number
): string {
  if (choice === 'dynamic') return targetFps ? formatFps(targetFps) : profileDescription('dynamic')
  if (choice !== 'none' && ready && config?.watts !== null && config?.watts !== undefined) {
    return config.boostWatts !== null && config.boostWatts !== undefined
      ? `${Math.round(config.watts * 10) / 10}/${formatWatts(config.boostWatts)}`
      : formatWatts(config.watts)
  }
  return profileDescription(choice)
}

/** The header chip: 'Balanced · 15 W' (what the CPU draws now, else the profile's limit), or 'Windows' when off. */
export function profileChip(
  status: PerformanceStatus | null,
  profiles: Record<PowerProfileId, PowerProfileConfig> | undefined,
  useWatts: boolean
): string {
  if (!status) return '…'
  if (!status.active) return t('overlay.profiles.chipOff')
  const label = profileLabel(status.active)
  if (status.active === 'dynamic')
    return status.dynamic
      ? t('overlay.profiles.chipFps', { label, fps: status.dynamic.targetFps })
      : label
  if (!wattsReady(status.watts, useWatts)) return label
  const watts = status.watts.currentWatts ?? profiles?.[status.active]?.watts
  return watts !== null && watts !== undefined
    ? t('overlay.profiles.chipWatts', { label, watts: formatWatts(watts) })
    : label
}

/** The watts backend in one line (Settings › System and the overlay's Custom editor). */
export function wattsBackendText(watts: WattsBackendStatus | undefined): string {
  if (!watts) return t('overlay.checking')
  const method = watts.method ? (METHOD_NAMES[watts.method] ?? watts.method) : undefined
  switch (watts.state) {
    case 'ready': {
      if (watts.minWatts === undefined || watts.maxWatts === undefined)
        return method ? t('overlay.watts.readyMethod', { method }) : t('overlay.watts.ready')
      const min = formatWatts(watts.minWatts)
      const max = formatWatts(watts.maxWatts)
      return method
        ? t('overlay.watts.readyMethodRange', { method, min, max })
        : t('overlay.watts.readyRange', { min, max })
    }
    case 'not-installed':
      return method
        ? t('overlay.watts.notInstalledMethod', { method })
        : t('overlay.watts.notInstalled')
    case 'unsupported':
      // The main process's own sentence when it has one (the reason this PC cannot).
      return watts.message ?? t('overlay.watts.unsupported')
    case 'error':
      return watts.message
        ? t('overlay.watts.errorMessage', { message: watts.message })
        : t('overlay.watts.error')
  }
}

const METHOD_NAMES: Record<string, string> = {
  ryzenadj: 'AMD Ryzen',
  'ryzen-smu': 'AMD Ryzen',
  'intel-msr': 'Intel',
  'asus-wmi': 'ASUS'
}

/** 'View + Menu'; an empty combo reads 'Not set'. */
export function comboText(buttons: readonly PadButton[]): string {
  if (buttons.length === 0) return t('overlay.combo.notSet')
  return buttons.map((b) => PAD_BUTTON_LABELS[b]).join(' + ')
}

/** A single button other than Home is one games use: the home button needs two or more held together. */
export function singleButtonComboText(): string {
  return t('overlay.combo.singleButton')
}
/** At most this many buttons in the home combo (the settings schema). */
export const MAX_COMBO_BUTTONS = 4

/**
 * Why a captured combo cannot be the home button, or null when it can: 1 to 4 different buttons, and a single
 * button only when it is Home (Guide / PS).
 */
export function comboProblem(buttons: readonly PadButton[]): string | null {
  if (buttons.length === 0) return t('overlay.combo.noButtons')
  if (new Set(buttons).size !== buttons.length) return t('overlay.combo.twice')
  if (buttons.length > MAX_COMBO_BUTTONS)
    return t('overlay.combo.tooMany', { max: MAX_COMBO_BUTTONS })
  if (buttons.length === 1 && buttons[0] !== 'guide') return singleButtonComboText()
  return null
}

/**
 * The toast after a capture that ended without a usable combo: `done` is what it ended with ([] = the main process
 * rejected or cancelled it) and `mostHeld` the most buttons held at once. Nothing when no button was pressed (a plain
 * cancel needs no explanation).
 */
export function captureNotice(done: readonly PadButton[], mostHeld: number): string | undefined {
  if (done.length) return comboProblem(done) ?? undefined
  if (mostHeld === 0) return undefined
  if (mostHeld === 1) return singleButtonComboText()
  if (mostHeld > MAX_COMBO_BUTTONS) return t('overlay.combo.tooMany', { max: MAX_COMBO_BUTTONS })
  return t('overlay.combo.notRecorded')
}

/** Steam's or Game Bar's override state in one line. */
export function overrideText(
  kind: 'steam' | 'gameBar',
  status: OverrideStatus | undefined
): string {
  // Product names, the same in every language.
  const name = kind === 'steam' ? 'Steam' : 'Game Bar'
  if (!status) return t('overlay.checking')
  let text: string
  switch (status.state) {
    case 'off':
      text = t('overlay.override.off', { name })
      break
    case 'applied':
      text =
        kind === 'steam' ? t('overlay.override.steamApplied') : t('overlay.override.gameBarApplied')
      break
    case 'already':
      text =
        kind === 'steam' ? t('overlay.override.steamAlready') : t('overlay.override.gameBarAlready')
      break
    case 'missing':
      text = t('overlay.override.missing', { name })
      break
    case 'pending':
      // A pending status that carries its own reason (waiting for a game to end) says just that.
      if (status.message) return status.message
      text =
        kind === 'steam' ? t('overlay.override.steamPending') : t('overlay.override.gameBarPending')
      break
    case 'error':
      text = t('overlay.override.error', { name })
      break
  }
  // The main process's own sentence follows ours (two whole sentences, so no word order to keep).
  return status.message ? `${text} ${status.message}` : text
}

/** The controller reader and the pads it sees, in one line. */
export function readerText(status: Pick<HomeButtonStatus, 'reader' | 'pads'> | null): string {
  if (!status) return t('overlay.checking')
  const { reader, pads } = status
  if (reader.state === 'starting') return t('overlay.reader.starting')
  if (reader.state === 'unavailable')
    return reader.message
      ? t('overlay.reader.unavailableMessage', { message: reader.message })
      : t('overlay.reader.unavailable')
  if (pads.length === 0) return t('overlay.reader.none')
  return t('overlay.reader.pads', { pads: pads.map((p) => p.name).join(', ') })
}

/** '1920 × 1080'. */
export function formatResolution(mode: Pick<DisplayMode, 'width' | 'height'>): string {
  return `${mode.width} × ${mode.height}`
}

/** '60 Hz'. */
export function formatHz(hz: number): string {
  return `${Math.round(hz)} Hz`
}

/** The refresh rates of the current resolution, highest first. */
export function refreshOptions(modes: readonly DisplayMode[], current: DisplayMode): DisplayMode[] {
  const seen = new Set<number>()
  const out: DisplayMode[] = []
  for (const mode of modes) {
    if (mode.width !== current.width || mode.height !== current.height) continue
    const hz = Math.round(mode.hz)
    if (seen.has(hz)) continue
    seen.add(hz)
    out.push(mode)
  }
  if (!seen.has(Math.round(current.hz))) out.push(current)
  return out.sort((a, b) => b.hz - a.hz)
}

/**
 * One mode per resolution, largest first: each keeps the current refresh rate where that resolution has it, else
 * its highest (so changing the resolution never drops the screen to a low rate it was not at).
 */
export function resolutionOptions(
  modes: readonly DisplayMode[],
  current: DisplayMode
): DisplayMode[] {
  const best = new Map<string, DisplayMode>()
  for (const mode of [...modes, current]) {
    const key = `${mode.width}x${mode.height}`
    const kept = best.get(key)
    const keepsRate = (m: DisplayMode): boolean => Math.round(m.hz) === Math.round(current.hz)
    if (!kept || (!keepsRate(kept) && (keepsRate(mode) || mode.hz > kept.hz))) best.set(key, mode)
  }
  return [...best.values()].sort(
    (a, b) => b.width * b.height - a.width * a.height || b.width - a.width
  )
}

export function sameMode(a: DisplayMode, b: DisplayMode): boolean {
  return a.width === b.width && a.height === b.height && Math.round(a.hz) === Math.round(b.hz)
}

/** Memory in use as a percentage, or null when unknown. */
export function memoryPercent(perf: PerfSample | null | undefined): number | null {
  if (!perf || perf.memoryUsedMb === null || !perf.memoryTotalMb) return null
  return (perf.memoryUsedMb / perf.memoryTotalMb) * 100
}

/** What settings.performance.profiles[*].watts / boostWatts accept (the settings schema). */
export const PROFILE_WATTS_MIN = 3
export const PROFILE_WATTS_MAX = 200

/**
 * The power helper's range for this PC, with a safe fallback when it did not say, inside what the settings accept: a
 * desktop CPU can report far more than 200 W (TDP x 2.5 without a PL max), which the settings would reject.
 */
export function wattsRange(watts: WattsBackendStatus | undefined): { min: number; max: number } {
  const limit = (w: number): number =>
    Math.min(PROFILE_WATTS_MAX, Math.max(PROFILE_WATTS_MIN, Math.round(w)))
  const min = limit(watts?.minWatts ?? 5)
  const max = limit(watts?.maxWatts ?? 30)
  if (max > min) return { min, max }
  return min < PROFILE_WATTS_MAX ? { min, max: min + 1 } : { min: min - 1, max: min }
}

/**
 * The Custom profile with its watts turned on (a middle sustained limit and a boost about a third above it, inside
 * the range) or off (both null: PlayOut leaves the CPU's own limits).
 */
export function withWatts(
  config: PowerProfileConfig,
  on: boolean,
  range: { min: number; max: number }
): PowerProfileConfig {
  if (!on) return { ...config, watts: null, boostWatts: null }
  const clamp = (w: number): number => Math.min(range.max, Math.max(range.min, Math.round(w)))
  const watts = clamp(config.watts ?? (range.min + range.max) / 2)
  const boostWatts = Math.max(watts, clamp(config.boostWatts ?? watts * 1.3))
  return { ...config, watts, boostWatts }
}

/** Both watts limits as whole numbers inside what the settings accept (null stays null). */
export function fitWatts(config: PowerProfileConfig): PowerProfileConfig {
  const fit = (w: number | null): number | null =>
    w === null ? null : Math.min(PROFILE_WATTS_MAX, Math.max(PROFILE_WATTS_MIN, Math.round(w)))
  return { ...config, watts: fit(config.watts), boostWatts: fit(config.boostWatts) }
}

/** Set the sustained limit; the boost limit never stays below it. */
export function setSustainedWatts(config: PowerProfileConfig, watts: number): PowerProfileConfig {
  const boostWatts = config.boostWatts === null ? null : Math.max(config.boostWatts, watts)
  return { ...config, watts, boostWatts }
}

/** Set the boost limit; never below the sustained one. */
export function setBoostWatts(config: PowerProfileConfig, boostWatts: number): PowerProfileConfig {
  return { ...config, boostWatts: Math.max(boostWatts, config.watts ?? boostWatts) }
}

/** 'Spotify.exe' -> 'Spotify'; a packaged app's id keeps its readable part ('…SpotifyMusic_zpdnekdrzrea0!Spotify'). */
export function appName(app: string): string {
  const tail = app.split('!').pop() ?? app
  return tail.replace(/^.*\\/, '').replace(/\.exe$/i, '') || app
}

// --- overlay extras (shared/overlay-extras.ts) ------------------------------------------------------

/** A frame rate limit: '∞' for unlimited (0), else '60 FPS'. */
export function formatFrameLimit(fps: number): string {
  return fps > 0 ? t('overlay.fpsUpper', { fps: Math.round(fps) }) : '∞'
}

/** The performance overlay tile's value: 'Off', 'Level 1' … 'Level 3'. */
export function perfOverlayLabel(level: PerfOverlayLevel): string {
  return level === 0 ? t('overlay.off') : t('overlay.extras.perfOverlay.level', { level })
}

/** What a performance overlay level shows (the drawer's second line); undefined for Off. */
export function perfOverlayDetail(level: PerfOverlayLevel): string | undefined {
  switch (level) {
    case 1:
      return t('overlay.extras.perfOverlay.level1')
    case 2:
      return t('overlay.extras.perfOverlay.level2')
    case 3:
      return t('overlay.extras.perfOverlay.level3')
    default:
      return undefined
  }
}

/**
 * The header's watts chip: '15 W' from the live reading, else Dynamic TDP's watts or the CPU's power now while the
 * watts backend is ready; null (the chip hides) when unknown.
 */
export function wattsChip(
  live: LiveStats | null,
  performance: PerformanceStatus | null
): string | null {
  const fallback =
    performance?.watts.state === 'ready'
      ? (performance.dynamic?.watts ?? performance.watts.currentWatts)
      : undefined
  const watts = live?.watts ?? fallback
  return typeof watts === 'number' && Number.isFinite(watts) ? `${Math.round(watts)} W` : null
}

/** The header's frame rate chip: '120 FPS', or null (the chip hides) when nothing is measured. */
export function fpsChip(live: LiveStats | null): string | null {
  const fps = live?.fps
  return typeof fps === 'number' && Number.isFinite(fps)
    ? t('overlay.fpsUpper', { fps: Math.round(fps) })
    : null
}

/** The frame rate chip's tooltip: where the reading comes from. */
export function fpsChipTitle(live: LiveStats | null): string {
  if (live?.fpsSource === 'rtss') return t('overlay.header.fpsTitleRtss')
  if (live?.fpsSource === 'presentmon') return t('overlay.header.fpsTitleDynamic')
  return t('overlay.header.fpsTitle')
}

/** The frame limit tile's detail: why it cannot act, the display it follows, or the program it applies to. */
export function frameLimitDetail(
  extras: Pick<OverlayExtrasStatus, 'frameLimit' | 'sync'>
): string | undefined {
  const { frameLimit, sync } = extras
  if (!frameLimit.available) return frameLimit.reason
  if (sync.enabled && sync.hz)
    return t('overlay.extras.frameLimit.followsDisplay', { hz: formatHz(sync.hz) })
  return frameLimit.exe
}

/** The sync tile's detail: why it cannot act, or the limit it sets while on. */
export function syncDetail(sync: OverlayExtrasStatus['sync']): string | undefined {
  if (!sync.available) return sync.reason
  if (sync.enabled)
    return sync.hz
      ? t('overlay.extras.sync.limit', { hz: formatHz(sync.hz) })
      : t('overlay.extras.sync.followsDisplay')
  return t('overlay.extras.sync.followsRefresh')
}

/** The CPU boost tile's detail: why it cannot act, else the profile it changes ('Balanced (changed)'). */
export function cpuBoostDetail(boost: OverlayExtrasStatus['cpuBoost']): string | undefined {
  if (!boost.available) return boost.reason
  if (!boost.profile) return undefined
  const profile = profileLabel(boost.profile)
  return boost.overridden ? t('overlay.extras.cpuBoost.changed', { profile }) : profile
}

/** The Endurance Gaming tile's value: the driver's option label ('Auto, balanced'), or '—' when unknown. */
export function enduranceValue(eg: IntelFeatureStatus): string {
  const option = eg.options.find((o) => o.key === eg.value)
  if (option) return option.label
  return eg.value === 'off' ? t('overlay.off') : '—'
}

/** The Endurance Gaming tile's detail: why it cannot act (or the driver's last refusal), else what it does. */
export function enduranceDetail(eg: IntelFeatureStatus): string {
  if (eg.reason) return eg.reason
  return t('overlay.extras.endurance.detail')
}
