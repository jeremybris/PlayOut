// Steam install progress (grade: measured, docs/research/store-accounts.md §1.6): appmanifest_<appid>.acf in every
// library folder. The manifest is in flight while any update bit is set (UpdateRequired, UpdateRunning,
// UpdatePaused, UpdateStarted, Preallocating, Downloading, Staging, Committing), while `buildid` is still 0 (a
// fresh install gets its build id at the commit) or while the target build differs from the installed one; bit 4
// (FullyInstalled) alone proves nothing, Steam sets it early (StateFlags 1030 / 1542 mid-download). Download % =
// BytesDownloaded / BytesToDownload, then BytesStaged / BytesToStage. Done = bit 4, a build id, no update bit and
// the install folder; the manifest absent on three consecutive probes together with steamapps\downloading\<appid>
// means cancelled (a torn or locked read is retried, never reported).
import { join } from 'path'
import { parseVdf, vdfGet, vdfNumber, vdfString } from '../util/vdf'
import { isDirectory, listDir, readTextIfExists, statSafe } from '../util/fs'
import type { InstallProbe, ProbeResult } from './tracker'
import { tMain } from '../i18n'

export const STATE_UPDATE_REQUIRED = 2
export const STATE_FULLY_INSTALLED = 4
export const STATE_UPDATE_RUNNING = 256
export const STATE_UPDATE_PAUSED = 512
export const STATE_UPDATE_STARTED = 1024
export const STATE_UNINSTALLING = 2048
export const STATE_PREALLOCATING = 524288
export const STATE_DOWNLOADING = 1048576
export const STATE_STAGING = 2097152
export const STATE_COMMITTING = 4194304
/** Any of these says Steam is still working on the app, whatever bit 4 says. */
export const STATE_IN_FLIGHT_BITS =
  STATE_UPDATE_REQUIRED |
  STATE_UPDATE_RUNNING |
  STATE_UPDATE_PAUSED |
  STATE_UPDATE_STARTED |
  STATE_PREALLOCATING |
  STATE_DOWNLOADING |
  STATE_STAGING |
  STATE_COMMITTING
/** A manifest must be absent on this many consecutive probes before the install counts as cancelled. */
export const MISSING_PROBES_FOR_CANCEL = 3

export interface AcfProgress {
  appId: number
  stateFlags: number
  installDir: string
  bytesToDownload: number
  bytesDownloaded: number
  bytesToStage: number
  bytesStaged: number
  buildId: number
  targetBuildId: number
}

/** Parse the progress-relevant fields of an appmanifest; null without an AppState block or app id. */
export function parseAcfProgress(text: string): AcfProgress | null {
  let state
  try {
    state = vdfGet(parseVdf(text), 'AppState')
  } catch {
    return null
  }
  if (!state || typeof state !== 'object') return null
  const appId = vdfNumber(vdfGet(state, 'appid'))
  if (appId === undefined || !Number.isInteger(appId) || appId <= 0) return null
  const num = (key: string): number => vdfNumber(vdfGet(state, key)) ?? 0
  return {
    appId,
    stateFlags: num('StateFlags'),
    installDir: (vdfString(vdfGet(state, 'installdir')) ?? '').trim(),
    bytesToDownload: num('BytesToDownload'),
    bytesDownloaded: num('BytesDownloaded'),
    bytesToStage: num('BytesToStage'),
    bytesStaged: num('BytesStaged'),
    buildId: num('buildid'),
    targetBuildId: num('TargetBuildID')
  }
}

function pct(done: number, total: number): number {
  return Math.max(0, Math.min(99, (done / total) * 100))
}

/** Whether the manifest describes an app Steam is still installing or updating (see the header comment). */
export function isInFlight(
  acf: Pick<AcfProgress, 'stateFlags' | 'buildId' | 'targetBuildId'>
): boolean {
  if ((acf.stateFlags & STATE_FULLY_INSTALLED) === 0) return true
  if (acf.stateFlags & STATE_IN_FLIGHT_BITS) return true
  if (acf.buildId === 0) return true
  return acf.targetBuildId > 0 && acf.targetBuildId !== acf.buildId
}

/** Map a manifest to a probe result; `installDirExists` is the scan's own "done" condition next to bit 4. */
export function progressFromAcf(acf: AcfProgress, installDirExists: boolean): ProbeResult {
  const fingerprint = [
    acf.stateFlags,
    acf.bytesDownloaded,
    acf.bytesToDownload,
    acf.bytesStaged,
    acf.bytesToStage,
    acf.buildId,
    acf.targetBuildId,
    installDirExists ? 1 : 0
  ].join(':')
  if (acf.stateFlags & STATE_UNINSTALLING) return { cancelled: true, fingerprint }
  if (!isInFlight(acf)) {
    return installDirExists
      ? { state: 'installing', percent: 100, complete: true, fingerprint }
      : { state: 'installing', percent: 100, fingerprint }
  }
  // In flight: the confirming scan may already see bit 4 and the folder, but the watch is not done yet.
  const inFlight = true
  const paused = (acf.stateFlags & STATE_UPDATE_PAUSED) !== 0
  const message = paused ? tMain('mainInstalls.pausedInSteam') : undefined
  if (acf.bytesToDownload > 0) {
    if (acf.bytesDownloaded >= acf.bytesToDownload) {
      // Download complete: staging / committing. Staged bytes give the second phase its own percent.
      if (acf.bytesToStage > 0)
        return {
          state: 'installing',
          percent: pct(acf.bytesStaged, acf.bytesToStage),
          bytesDone: acf.bytesStaged,
          bytesTotal: acf.bytesToStage,
          message,
          inFlight,
          fingerprint
        }
      return { state: 'installing', percent: 99, message, inFlight, fingerprint }
    }
    return {
      state: acf.bytesDownloaded === 0 ? 'queued' : 'downloading',
      percent: pct(acf.bytesDownloaded, acf.bytesToDownload),
      bytesDone: acf.bytesDownloaded,
      bytesTotal: acf.bytesToDownload,
      message,
      inFlight,
      fingerprint
    }
  }
  return { state: 'queued', message, inFlight, fingerprint }
}

export interface SteamProbeDeps {
  appId: number
  /** Library roots (the folders holding `steamapps`), re-read on every probe so a new library is picked up. */
  libraries: () => Promise<string[]>
}

export function createSteamProbe(deps: SteamProbeDeps): InstallProbe {
  let seenManifest = false
  let missingProbes = 0
  let last: ProbeResult | null = null
  return async () => {
    const libraries = await deps.libraries()
    let downloading = false
    let unreadable = false
    for (const library of libraries) {
      const steamapps = join(library, 'steamapps')
      const file = join(steamapps, `appmanifest_${deps.appId}.acf`)
      if (!downloading)
        downloading = await isDirectory(join(steamapps, 'downloading', String(deps.appId)))
      const text = await readTextIfExists(file)
      if (text === null) {
        // Missing, or present but locked (Steam's `.acf.tmp` rename, the final commit): only ENOENT is "missing".
        if ((await statSafe(file)) !== null) unreadable = true
        continue
      }
      const acf = parseAcfProgress(text)
      if (!acf) {
        // Torn read while Steam rewrites the file: keep the previous result and look again next time.
        unreadable = true
        continue
      }
      seenManifest = true
      missingProbes = 0
      const dirExists =
        !!acf.installDir && (await isDirectory(join(steamapps, 'common', acf.installDir)))
      last = progressFromAcf(acf, dirExists)
      return last
    }
    if (unreadable) return last
    if (downloading) {
      missingProbes = 0
      last = {
        state: 'downloading',
        inFlight: true,
        fingerprint: `downloading-dir:${await downloadingSize(libraries, deps.appId)}`
      }
      return last
    }
    if (seenManifest && ++missingProbes >= MISSING_PROBES_FOR_CANCEL)
      return { cancelled: true, fingerprint: 'gone' }
    return seenManifest ? last : null
  }
}

async function downloadingSize(libraries: string[], appId: number): Promise<number> {
  let count = 0
  for (const library of libraries) {
    const dir = join(library, 'steamapps', 'downloading', String(appId))
    count += (await listDir(dir)).length
  }
  return count
}
