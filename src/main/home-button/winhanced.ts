import { win32 } from 'path'
import type { PadButton } from '../../shared/overlay'
import { runningProcesses, type HomeButtonIo } from './io'
import { tMain } from '../i18n'

/**
 * Winhanced (a handheld companion app) reads the controller too: View + Menu opens Game Bar or its own overlay, and
 * it can take the Guide button. When PlayOut's combo overlaps one of those, both react to the same press, so
 * Settings shows a warning (the user's choice: warn, do not change Winhanced).
 */
export const WINHANCED_PROCESSES = ['WHService.exe', 'Winhanced.exe', 'WinhancedWatchdog.exe']

export interface WinhancedSettings {
  /** View + Menu opens Game Bar (or Winhanced's overlay). Winhanced's default is on. */
  startSelectOpensGameBar: boolean
  guideButtonOpensOverlay: boolean
  remapGuideButton: boolean
  /** Its overlay is used instead of Game Bar. */
  useInAppOverlay: boolean
}

const DEFAULTS: WinhancedSettings = {
  startSelectOpensGameBar: true,
  guideButtonOpensOverlay: false,
  remapGuideButton: false,
  useInAppOverlay: false
}

/** appsettings.json's fields; a missing or unreadable file gives Winhanced's defaults. */
export function parseWinhancedSettings(json: string | null): WinhancedSettings {
  let raw: Record<string, unknown> = {}
  try {
    const parsed: unknown = json
      ? JSON.parse(json.charCodeAt(0) === 0xfeff ? json.slice(1) : json)
      : {}
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
  } catch {
    /* defaults */
  }
  const flag = (name: string, fallback: boolean): boolean =>
    typeof raw[name] === 'boolean' ? (raw[name] as boolean) : fallback
  return {
    startSelectOpensGameBar: flag('StartSelectOpensGameBar', DEFAULTS.startSelectOpensGameBar),
    guideButtonOpensOverlay: flag('GuideButtonOpensOverlay', DEFAULTS.guideButtonOpensOverlay),
    remapGuideButton: flag('RemapGuideButton', DEFAULTS.remapGuideButton),
    useInAppOverlay: flag('UseInAppOverlay', DEFAULTS.useInAppOverlay)
  }
}

/**
 * Two shortcuts clash when pressing one also completes the other: one's buttons include all of the other's. So
 * View + Menu clashes with a combo of Menu alone, with View + Menu, and with View + Menu + A, but not with Menu + A.
 */
function overlaps(combo: readonly PadButton[], theirs: readonly PadButton[]): boolean {
  if (combo.length === 0) return false
  return theirs.every((b) => combo.includes(b)) || combo.every((b) => theirs.includes(b))
}

/** The warning for Settings, in one sentence; undefined when there is no clash. */
export function winhancedClash(
  combo: readonly PadButton[],
  settings: WinhancedSettings
): string | undefined {
  if (
    (settings.guideButtonOpensOverlay || settings.remapGuideButton) &&
    overlaps(combo, ['guide'])
  ) {
    return tMain('mainApp.winhanced.home')
  }
  if (settings.startSelectOpensGameBar && overlaps(combo, ['view', 'menu'])) {
    return settings.useInAppOverlay
      ? tMain('mainApp.winhanced.viewMenuOverlay')
      : tMain('mainApp.winhanced.viewMenuGameBar')
  }
  return undefined
}

/** Winhanced's settings when it runs; null when it does not. */
export async function detectWinhanced(
  io: Pick<HomeButtonIo, 'run' | 'readFile' | 'env'>
): Promise<WinhancedSettings | null> {
  const running = await runningProcesses(io.run, WINHANCED_PROCESSES)
  if (running.length === 0) return null
  const localAppData = io.env.LOCALAPPDATA
  const data = localAppData
    ? await io.readFile(win32.join(localAppData, 'Winhanced', 'appsettings.json')).catch(() => null)
    : null
  return parseWinhancedSettings(data ? data.toString('utf8') : null)
}
