// GOG Galaxy install progress (grade: measured by file count, docs/research/store-accounts.md §3.4): the
// `ProductInstall (<id>)` job in %ProgramData%\GOG.com\Galaxy\logs\GalaxyClient.log goes Scheduled -> Running ->
// "Initializing download ... files to download <F>" -> one "Marking file ... as complete." per file -> "Writing
// ...goggame-galaxyFileList.ini" -> "Changing installation state of product <id> from none to installed".
import { createLogTail, type LogTail } from './log-tail'
import type { InstallProbe, ProbeResult } from './tracker'

export type GalaxyPhase =
  'none' | 'scheduled' | 'running' | 'finalizing' | 'installed' | 'uninstalled'

export interface GalaxyInstallState {
  phase: GalaxyPhase
  filesTotal: number
  filesDone: number
  /** `uncompressed size <B>` of the download, when the log said. */
  bytesTotal: number
  /** Log lines seen for this product (part of the fingerprint). */
  lines: number
}

export function emptyGalaxyState(): GalaxyInstallState {
  return { phase: 'none', filesTotal: 0, filesDone: 0, bytesTotal: 0, lines: 0 }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Feed one log line; returns true when it concerned this product. */
export function applyGalaxyLogLine(
  state: GalaxyInstallState,
  line: string,
  productId: string
): boolean {
  const id = escapeRe(productId)
  let m: RegExpExecArray | null
  if ((m = new RegExp(`ProductInstall \\(${id}\\) id: \\d+ state: (\\w+)`).exec(line))) {
    const job = m[1].toLowerCase()
    if (job === 'scheduled') state.phase = 'scheduled'
    else if (job === 'running') state.phase = state.phase === 'finalizing' ? state.phase : 'running'
    else if (job === 'completed' && state.phase !== 'installed') state.phase = 'finalizing'
    state.lines++
    return true
  }
  if (
    (m = new RegExp(
      `Initializing download for product ${id} .*?files to download (\\d+)(?: \\(uncompressed size (\\d+)\\))?`
    ).exec(line))
  ) {
    state.filesTotal = Number(m[1])
    if (m[2]) state.bytesTotal = Number(m[2])
    if (state.phase === 'none' || state.phase === 'scheduled') state.phase = 'running'
    state.lines++
    return true
  }
  if (
    new RegExp(`Storing new ProductState for product ${id} => operation state: installing`).test(
      line
    )
  ) {
    if (state.phase === 'none') state.phase = 'scheduled'
    state.lines++
    return true
  }
  if (new RegExp(`Writing .*goggame-galaxyFileList\\.ini for gameId ${id}\\b`).test(line)) {
    state.phase = 'finalizing'
    state.lines++
    return true
  }
  if (
    new RegExp(`Changing installation state of product ${id} from \\w+ to installed`).test(line)
  ) {
    state.phase = 'installed'
    state.lines++
    return true
  }
  if (
    new RegExp(
      `(Scheduling game ${id} \\(${id}\\) uninstallation|Changing operation state of product ${id} from \\w+ to uninstalling)`
    ).test(line)
  ) {
    state.phase = 'uninstalled'
    state.lines++
    return true
  }
  // Per-file lines carry no product id: they count while this product's job is the one running.
  if (state.phase === 'running' && /Marking file '.*' as complete\./.test(line)) {
    state.filesDone++
    state.lines++
    return true
  }
  return false
}

export function progressFromGalaxyState(state: GalaxyInstallState): ProbeResult | null {
  const fingerprint = `${state.phase}:${state.filesDone}/${state.filesTotal}:${state.lines}`
  switch (state.phase) {
    case 'none':
      return null
    case 'scheduled':
      return { state: 'queued', fingerprint }
    case 'running': {
      if (state.filesTotal > 0) {
        return {
          state: 'downloading',
          percent: Math.min(99, (state.filesDone / state.filesTotal) * 100),
          bytesTotal: state.bytesTotal || undefined,
          fingerprint
        }
      }
      return { state: 'downloading', fingerprint }
    }
    case 'finalizing':
      return { state: 'installing', percent: 99, fingerprint }
    case 'installed':
      return { state: 'installing', percent: 100, complete: true, fingerprint }
    case 'uninstalled':
      return { cancelled: true, fingerprint }
  }
}

export interface GogProbeDeps {
  productId: string
  logFile: string
  tail?: LogTail
}

export function createGogProbe(deps: GogProbeDeps): InstallProbe {
  const tail = deps.tail ?? createLogTail(deps.logFile)
  const state = emptyGalaxyState()
  return async () => {
    for (const line of await tail.readNew()) applyGalaxyLogLine(state, line, deps.productId)
    return progressFromGalaxyState(state)
  }
}
