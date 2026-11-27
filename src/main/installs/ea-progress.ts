// EA app install progress (grade: measured, docs/research/store-accounts.md §6.4): %LOCALAPPDATA%\Electronic
// Arts\EA Desktop\Logs\EADesktopVerbose.log carries one `getDownloadProgress` line per second (bytes, rate, ETA), the
// `sendInstallStatus` JSON with QUEUED / ACTIVE / INSTALLED, and `installedStatus=[Installed]` at the end. The UI uses
// the storefront offer while the service renames the job to the legacy offer, so slug and software id match too.
import { createLogTail, type LogTail } from './log-tail'
import type { InstallProbe, ProbeResult } from './tracker'

export interface EaInstallIds {
  /** Legacy offer id (`Origin.OFR.50.0001139`). */
  offerId?: string
  /** `product.gameSlug` / `baseSlug`. */
  slug?: string
  softwareId?: string
  contentId?: string
}

export interface EaInstallState {
  status: 'none' | 'queued' | 'active' | 'installed' | 'cancelled'
  bytesDone: number
  /** Estimated from rate and time remaining; 0 when unknown. */
  bytesTotal: number
  lines: number
}

export function emptyEaState(): EaInstallState {
  return { status: 'none', bytesDone: 0, bytesTotal: 0, lines: 0 }
}

function mentions(line: string, ids: EaInstallIds): boolean {
  const lower = line.toLowerCase()
  const keys = [ids.offerId, ids.slug, ids.softwareId, ids.contentId].filter(
    (k): k is string => !!k && k.length > 2
  )
  return keys.some((k) => lower.includes(k.toLowerCase()))
}

const PROGRESS_RE =
  /received download progress downloaded = \[(\d+)\], Kb\/s = \[([\d.]+)\], timeRemaining = \[([\d.]+)\], offer = \[([^\]]+)\]/
const STATUS_RE = /"installStatusString"\s*:\s*"(\w+)"/
const INSTALLED_RE = /installedStatus=\[(\w+)\]/

/** Feed one log line; returns true when it concerned this install. */
export function applyEaLogLine(state: EaInstallState, line: string, ids: EaInstallIds): boolean {
  if (!mentions(line, ids)) return false
  let m: RegExpExecArray | null
  if ((m = PROGRESS_RE.exec(line))) {
    const done = Number(m[1])
    const rate = Number(m[2]) * 1000
    const remaining = Number(m[3])
    state.bytesDone = done
    if (rate > 0 && remaining > 0)
      state.bytesTotal = Math.max(state.bytesTotal, Math.round(done + rate * remaining))
    if (state.status !== 'installed') state.status = 'active'
    state.lines++
    return true
  }
  if ((m = INSTALLED_RE.exec(line))) {
    const value = m[1].toLowerCase()
    if (value === 'installed') state.status = 'installed'
    else if (value === 'queued') state.status = 'queued'
    else if (value === 'active') state.status = 'active'
    else if (value === 'notinstalled' && state.status !== 'none') state.status = 'cancelled'
    state.lines++
    return true
  }
  if ((m = STATUS_RE.exec(line))) {
    const value = m[1].toUpperCase()
    if (value === 'QUEUED') state.status = 'queued'
    else if (value === 'ACTIVE') state.status = 'active'
    else if (value === 'INSTALLED') state.status = 'installed'
    state.lines++
    return true
  }
  return false
}

export function progressFromEaState(state: EaInstallState): ProbeResult | null {
  const fingerprint = `${state.status}:${state.bytesDone}:${state.lines}`
  switch (state.status) {
    case 'none':
      return null
    case 'queued':
      return { state: 'queued', fingerprint }
    case 'active': {
      const result: ProbeResult = { state: 'downloading', fingerprint }
      if (state.bytesDone > 0) result.bytesDone = state.bytesDone
      if (state.bytesTotal > state.bytesDone) {
        result.bytesTotal = state.bytesTotal
        result.percent = Math.min(99, (state.bytesDone / state.bytesTotal) * 100)
      }
      return result
    }
    case 'installed':
      return { state: 'installing', percent: 100, complete: true, fingerprint }
    case 'cancelled':
      return { cancelled: true, fingerprint }
  }
}

export interface EaProbeDeps {
  ids: EaInstallIds
  logFile: string
  tail?: LogTail
}

export function createEaProbe(deps: EaProbeDeps): InstallProbe {
  const tail = deps.tail ?? createLogTail(deps.logFile)
  const state = emptyEaState()
  return async () => {
    for (const line of await tail.readNew()) applyEaLogLine(state, line, deps.ids)
    return progressFromEaState(state)
  }
}
