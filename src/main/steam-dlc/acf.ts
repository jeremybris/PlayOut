// Steam's DLC choice in a game's appmanifest_<appid>.acf (text KeyValues), read and written without touching anything
// else in the file:
//   "AppState" { ...
//     "InstalledDepots" { "<depot>" { "manifest" "…" "size" "…" "dlcappid" "<dlc>" } }   content on disk
//     "UserConfig"      { "language" "english" "DisabledDLC" "1,2" }                     what the user asked for
//     "MountedConfig"   { "language" "english" "DisabledDLC" "1,2" }                     what Steam has applied
//   }
// The DisabledDLC key is absent when no DLC is turned off. Steam reads the file when it starts and writes it over
// while it runs, so the service only edits it with Steam closed (live-tested 2026-11-15).
import { findVdfKey, removeVdfKeyAt, setVdfKeyAt } from '../home-button/steam-vdf'
import { parseVdf, vdfGet, vdfNumber, vdfString, type VdfObject } from '../util/vdf'

export const USER_CONFIG_PATH = ['AppState', 'UserConfig'] as const
export const DISABLED_DLC_KEY = 'DisabledDLC'

export interface AcfDlcState {
  appId: number | null
  stateFlags: number
  /** `UserConfig.DisabledDLC`: the DLC the user turned off. */
  userDisabled: number[]
  /** `MountedConfig.DisabledDLC`: the DLC Steam has turned off. */
  mountedDisabled: number[]
  /** DLC with a depot in `InstalledDepots` (its content is on disk). */
  installedDlc: number[]
}

/** A comma list of app ids ("337840, 337841") as unique positive integers, in the order given. */
export function parseIdList(value: string | undefined): number[] {
  if (!value) return []
  const out: number[] = []
  for (const part of value.split(',')) {
    const n = Number(part.trim())
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

function sameBlock(path: readonly string[], want: readonly string[]): boolean {
  return (
    path.length === want.length && path.every((p, i) => p.toLowerCase() === want[i].toLowerCase())
  )
}

function idListAt(state: VdfObject, block: string): number[] {
  return parseIdList(vdfString(vdfGet(state, block, DISABLED_DLC_KEY)))
}

/** The DLC state of one appmanifest. Throws SyntaxError on text that is not KeyValues or has no AppState. */
export function readAcfDlc(text: string): AcfDlcState {
  const state = vdfGet(parseVdf(text), 'AppState')
  if (!state || typeof state !== 'object') throw new SyntaxError('appmanifest: no AppState block')
  const installedDlc: number[] = []
  const depots = vdfGet(state, 'InstalledDepots')
  if (depots && typeof depots === 'object') {
    for (const depot of Object.values(depots)) {
      if (!depot || typeof depot !== 'object') continue
      const dlc = vdfNumber(vdfGet(depot, 'dlcappid'))
      if (dlc !== undefined && Number.isInteger(dlc) && dlc > 0 && !installedDlc.includes(dlc))
        installedDlc.push(dlc)
    }
  }
  const appId = vdfNumber(vdfGet(state, 'appid'))
  return {
    appId: appId !== undefined && Number.isInteger(appId) && appId > 0 ? appId : null,
    stateFlags: vdfNumber(vdfGet(state, 'StateFlags')) ?? 0,
    userDisabled: idListAt(state, 'UserConfig'),
    mountedDisabled: idListAt(state, 'MountedConfig'),
    installedDlc
  }
}

/**
 * The acf text with `UserConfig.DisabledDLC` set to `disabled` (ascending, comma-separated), added (with the
 * UserConfig block when it is missing) or removed (an empty list), and every other byte left as it was. Only the
 * UserConfig key changes: the same key in MountedConfig is Steam's record of what it applied.
 */
export function writeUserDisabledDlc(
  text: string,
  disabled: readonly number[]
): { text: string; changed: boolean } {
  const ids = [...new Set(disabled)]
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
  // The same DLC in another order is no change: Steam's own order stays.
  const current = findVdfKey(text, DISABLED_DLC_KEY).filter((e) =>
    sameBlock(e.path, USER_CONFIG_PATH)
  )
  if (current.length > 0) {
    const have = parseIdList(current[0].value).sort((a, b) => a - b)
    if (have.length === ids.length && have.every((v, i) => v === ids[i]))
      return { text, changed: false }
  }
  if (ids.length === 0) return removeVdfKeyAt(text, USER_CONFIG_PATH, DISABLED_DLC_KEY)
  const result = setVdfKeyAt(text, USER_CONFIG_PATH, DISABLED_DLC_KEY, ids.join(','))
  return { text: result.text, changed: result.changed }
}

/**
 * StateFlags bits that mean Steam is downloading or writing the app right now: UpdateRunning (256), UpdateStarted
 * (1024), Preallocating (524288), Downloading (1048576), Staging (2097152), Committing (4194304). UpdatePaused (512)
 * wins over them (a paused download is not running); UpdateRequired (2) alone is an update waiting in the queue.
 */
const ACTIVE_BITS = 256 | 1024 | 524288 | 1048576 | 2097152 | 4194304
const PAUSED_BIT = 512

export function isDownloading(stateFlags: number): boolean {
  return (stateFlags & PAUSED_BIT) === 0 && (stateFlags & ACTIVE_BITS) !== 0
}

/**
 * Whether an acf shows Steam downloading or updating the app now. Read with regular expressions rather than a full
 * parse: every manifest of every library is checked, and a half-written one must not throw.
 */
export function acfShowsDownload(text: string): boolean {
  const flags = /"StateFlags"\s+"(\d+)"/i.exec(text)
  return flags ? isDownloading(Number(flags[1])) : false
}
