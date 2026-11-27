/**
 * What the Recompilation page and the game page's UP button show, worked out from the shared recomp types
 * (shared/recomp.ts): the button's state, the actions of a version, progress text, the facts rail, the game-file
 * and save lines. Pure (no React, no api calls) so the wording and the choices are unit tested.
 */
import type {
  GameFileNeed,
  GameFileState,
  GameRecomps,
  InstalledRecomp,
  RecompCloudState,
  RecompEntry,
  RecompExecutable,
  RecompExecutables,
  RecompProgress,
  RecompRelease,
  RecompTag
} from '@shared/recomp'
import type { GameRecompInfo } from '@shared/types'
import { t } from '../../i18n'
import { formatBytes, formatDate } from '../../lib/format'
import { recompBusy } from '../../state/recomp'

/** The UP button left of Play (ActionBar `recomp`). */
export interface RecompButtonState {
  state: 'available' | 'installed' | 'busy'
  onPress: () => void
  label: string
}

/**
 * The installed recompilation the UP button starts (and the play menu's "Delete recompilation" removes): the chosen
 * one when it is installed, else the first installed one. Undefined = none is installed.
 */
export function recompToLaunch(
  info: Pick<GameRecompInfo, 'installed' | 'preferred'> | undefined
): string | undefined {
  if (!info?.installed.length) return undefined
  return info.installed.includes(info.preferred) ? info.preferred : info.installed[0]
}

/**
 * Whose progress the UP button shows: the installed one it would start (an update of it makes UP busy), else the
 * chosen one (its install). Undefined = the game has no recompilation info.
 */
export function recompProgressId(
  info: Pick<GameRecompInfo, 'installed' | 'preferred'> | undefined
): string | undefined {
  return recompToLaunch(info) ?? info?.preferred
}

/**
 * The UP button's state (`progress` = recompProgressId's): busy while that recompilation installs or updates (it opens the page, which shows
 * the progress), installed when any recompilation of the game is installed (UP starts recompToLaunch's, by id), else
 * available (UP opens the page). `names` (entry id -> name), when known, names the one it starts. Undefined = the
 * game has no recompilation.
 */
export function recompButton(
  title: string,
  info: GameRecompInfo | undefined,
  progress: RecompProgress | undefined,
  launch: (recompId: string) => void,
  open: () => void,
  names?: Record<string, string>
): RecompButtonState | undefined {
  if (!info || info.count < 1) return undefined
  if (progress && recompBusy(progress))
    return {
      state: 'busy',
      onPress: () => open(),
      // Unpacking (an install's archive, or a setup's game disc before it runs) shows its percent, not "Installing".
      label:
        progress.phase === 'extracting'
          ? progressText(progress).title
          : t('recomp.button.installing')
    }
  const id = recompToLaunch(info)
  if (id) {
    const name = names?.[id]
    return {
      state: 'installed',
      onPress: () => launch(id),
      label: name
        ? t('recomp.button.playWith', { title, name })
        : t('recomp.button.play', { title })
    }
  }
  return { state: 'available', onPress: () => open(), label: t('recomp.recompilations') }
}

// ---- the program it starts ------------------------------------------------------------------------------------

/** Who chose the program, in words. */
export function exeSourceText(source: RecompExecutables['source']): string {
  switch (source) {
    case 'user':
      return t('recomp.exe.chosenByYou')
    case 'developer':
      return t('recomp.exe.namedByDeveloper')
    default:
      return t('recomp.exe.playOutPick')
  }
}

/** The program as shown: relative to the install folder, or the full path for one outside it. */
export function exeShownPath(
  view: Pick<RecompExecutables, 'current' | 'currentFull' | 'outside'>
): string {
  if (!view.current) return t('recomp.exe.noneFound')
  return view.outside ? (view.currentFull ?? view.current) : view.current
}

/** The file name of a program path. */
export const exeFileName = (path: string): string => path.split(/[\\/]/).pop() || path

/** A label on a program row. */
export interface ExeBadge {
  label: string
  kind: 'accent' | 'plain' | 'warn'
}

/** The labels of one program in the list: Current / PlayOut's pick / why it is probably not the game. */
export function exeBadges(exe: Pick<RecompExecutable, 'current' | 'auto' | 'note'>): ExeBadge[] {
  const out: ExeBadge[] = []
  if (exe.current) out.push({ label: t('recomp.exe.inUse'), kind: 'accent' })
  if (exe.auto) out.push({ label: t('recomp.exe.playOutPick'), kind: 'plain' })
  if (exe.note) out.push({ label: exe.note, kind: 'warn' })
  return out
}

/**
 * The UP button's "Which program starts …?" chooser: the programs that could be the game first, PlayOut's best guess
 * (its pick, else the one in use, else the first that could be the game) first; then the ones that are probably not
 * the game (still pickable). `best` is focused first; null when no program could be the game.
 */
export function exeChoiceList(view: Pick<RecompExecutables, 'candidates'>): {
  best: RecompExecutable | null
  list: RecompExecutable[]
} {
  const games = view.candidates.filter((c) => c.note === null)
  const others = view.candidates.filter((c) => c.note !== null)
  const best = games.find((c) => c.auto) ?? games.find((c) => c.current) ?? games[0] ?? null
  return { best, list: [...(best ? [best] : []), ...games.filter((c) => c !== best), ...others] }
}

/** A row's labels in the chooser: "Best guess" on PlayOut's guess, why a program is probably not the game. */
export function exeChoiceBadges(exe: Pick<RecompExecutable, 'note'>, best: boolean): ExeBadge[] {
  const out: ExeBadge[] = []
  if (best) out.push({ label: t('recomp.exe.bestGuess'), kind: 'accent' })
  if (exe.note) out.push({ label: exe.note, kind: 'warn' })
  return out
}

/** The versions in the title's order (recommended first), whatever order `entries` came in. */
export function orderedEntries(data: Pick<GameRecomps, 'entries' | 'title'>): RecompEntry[] {
  const rank = new Map(data.title.entries.map((id, i) => [id, i]))
  return [...data.entries].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  )
}

/** The labels of a version row: Recommended / Installed / Your choice. */
export function versionBadges(
  entry: RecompEntry,
  data: Pick<GameRecomps, 'installed' | 'preferred' | 'updates'>
): { label: string; kind: 'accent' | 'plain' | 'update' }[] {
  const out: { label: string; kind: 'accent' | 'plain' | 'update' }[] = []
  if (entry.id === data.preferred) out.push({ label: t('recomp.badge.yourChoice'), kind: 'accent' })
  if (entry.recommended) out.push({ label: t('recomp.badge.recommended'), kind: 'plain' })
  if (data.installed[entry.id]) out.push({ label: t('recomp.badge.installed'), kind: 'plain' })
  if (data.updates[entry.id]) out.push({ label: t('recomp.badge.update'), kind: 'update' })
  return out
}

/** What the version's action row offers. */
export interface EntryActions {
  /** Install / update in progress (the progress block takes the primary slot). */
  busy: boolean
  /** Not installed: the Install button's label ("Install · 120 MB"). */
  install: string | null
  /** Installed: Play. */
  play: boolean
  /** Installed with a newer release: its tag. */
  update: string | null
  /**
   * Installed and kept on an older release (Change version): its tag. The update slot shows "Pinned to <tag>" and
   * Back to latest instead of an update.
   */
  pinned: string | null
  /** The last install / update failed: why. */
  failed: string | null
  /** The last install / update finished with a warning (no checksum to verify against). */
  warning: string | null
}

export function entryActions(
  entry: RecompEntry,
  installed: InstalledRecomp | undefined,
  update: string | undefined,
  progress: RecompProgress | undefined
): EntryActions {
  const busy = recompBusy(progress)
  const failed =
    !busy && progress?.phase === 'failed'
      ? progress.message || t('recomp.actions.notFinished')
      : null
  // The unverified-download warning is about the files on disk: none once the version is uninstalled.
  const warning = installed ? (progress?.warning ?? null) : null
  if (installed) {
    const pinned = busy ? null : (installed.pinnedTag ?? null)
    return {
      busy,
      install: null,
      play: !busy,
      update: busy || pinned ? null : (update ?? null),
      pinned,
      failed,
      warning
    }
  }
  const size = entry.downloadBytes ? formatBytes(entry.downloadBytes) : null
  const install = failed
    ? size
      ? t('recomp.actions.retrySize', { size })
      : t('recomp.actions.retry')
    : size
      ? t('recomp.actions.installSize', { size })
      : t('recomp.actions.install')
  return {
    busy,
    install: busy ? null : install,
    play: false,
    update: null,
    pinned: null,
    failed,
    warning
  }
}

/** A phase in words, in the current language. */
function phaseText(phase: RecompProgress['phase']): string {
  switch (phase) {
    case 'queued':
      return t('recomp.phase.queued')
    case 'checking':
      return t('recomp.phase.checking')
    case 'downloading':
      return t('recomp.phase.downloading')
    case 'verifying':
      return t('recomp.phase.verifying')
    case 'extracting':
      return t('recomp.phase.extracting')
    case 'installing':
      return t('recomp.phase.installing')
    case 'done':
      return t('recomp.phase.done')
    case 'failed':
      return t('recomp.phase.failed')
  }
}

/**
 * The progress block's lines: the phase (with the percent while downloading, or unpacking when main tells one: a
 * setup program's game being unpacked before it runs) and the bytes or main's message.
 */
export function progressText(p: RecompProgress): {
  title: string
  detail: string
  percent: number | null
} {
  const percent =
    (p.phase === 'downloading' || p.phase === 'extracting') &&
    p.progress !== null &&
    Number.isFinite(p.progress)
      ? Math.max(0, Math.min(100, p.progress * 100))
      : null
  const title =
    percent === null
      ? phaseText(p.phase)
      : p.phase === 'downloading'
        ? t('recomp.phase.downloadingPercent', { percent: Math.round(percent) })
        : t('recomp.phase.extractingPercent', { percent: Math.round(percent) })
  const bytes =
    p.bytes !== null && p.total !== null && p.total > 0
      ? t('recomp.phase.bytes', { done: formatBytes(p.bytes), total: formatBytes(p.total) })
      : null
  return { title, detail: p.message ?? bytes ?? '', percent }
}

/** How complete a recompilation is, in words. */
export function completenessText(completeness: NonNullable<RecompEntry['completeness']>): string {
  switch (completeness) {
    case 'playable':
      return t('recomp.completeness.playable')
    case 'mostly':
      return t('recomp.completeness.mostly')
    case 'partial':
      return t('recomp.completeness.partial')
    case 'wip':
      return t('recomp.completeness.wip')
  }
}

const HOST_NAMES: Record<RecompEntry['host'], string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  codeberg: 'Codeberg'
}

/** "GitHub" / "GitLab" / "Codeberg", for "View on …". */
export function hostName(host: RecompEntry['host']): string {
  return HOST_NAMES[host] ?? t('recomp.theWeb')
}

/** One line of the facts rail. `tone` 'warn' for an unverified download. */
export interface Fact {
  label: string
  value: string
  tone?: 'warn'
}

/** The facts rail: only what is known. */
/**
 * When the project last put out a release (ISO): the newest release date of its release list when it is at hand
 * (test builds left out, as the update check does), else what the catalogs know (the project's last release, the
 * catalog version's date). Null when nothing tells.
 */
export function lastUpdated(
  entry: Pick<RecompEntry, 'updatedAt' | 'released'>,
  releases?: readonly RecompRelease[] | null
): string | null {
  const dates = (
    releases?.length
      ? releases.filter((r) => !r.prerelease).map((r) => r.publishedAt)
      : [entry.updatedAt, entry.released]
  ).filter((d): d is string => !!d && Number.isFinite(Date.parse(d)))
  if (!dates.length) return null
  return dates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
}

/** The date of a project's first release (test builds left out), from its release list; null without one. */
export function firstReleased(releases?: readonly RecompRelease[] | null): string | null {
  const dates = (releases ?? [])
    .filter((r) => !r.prerelease)
    .map((r) => r.publishedAt)
    .filter((d): d is string => !!d && Number.isFinite(Date.parse(d)))
  if (!dates.length) return null
  return dates.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a))
}

export function entryFacts(
  entry: RecompEntry,
  installed: InstalledRecomp | undefined,
  update: string | undefined,
  /** The project's releases, when loaded: Last updated goes by them (newer than the catalogs may know). */
  releases?: readonly RecompRelease[] | null
): Fact[] {
  const facts: Fact[] = []
  const latest = update ?? entry.latestTag
  if (installed) facts.push({ label: t('recomp.facts.installedVersion'), value: installed.tag })
  if (latest && latest !== installed?.tag)
    facts.push({ label: t('recomp.facts.latestVersion'), value: latest })
  // Released: the project's first release when its releases are at hand (Last updated is its newest), else the
  // catalog version's date, as before.
  const released = formatDate(firstReleased(releases) ?? entry.released, 'medium')
  if (released) facts.push({ label: t('recomp.facts.released'), value: released })
  const updated = formatDate(lastUpdated(entry, releases), 'medium')
  if (updated) facts.push({ label: t('recomp.facts.lastUpdated'), value: updated })
  if (entry.downloadBytes)
    facts.push({ label: t('recomp.facts.downloadSize'), value: formatBytes(entry.downloadBytes) })
  if (installed?.diskBytes)
    facts.push({ label: t('recomp.facts.sizeOnDisk'), value: formatBytes(installed.diskBytes) })
  if (entry.completeness) {
    facts.push({
      label: t('recomp.facts.completeness'),
      value: completenessText(entry.completeness)
    })
  }
  facts.push({ label: t('recomp.facts.original'), value: entry.console })
  if (entry.stars !== null)
    facts.push({ label: t('recomp.facts.stars'), value: entry.stars.toLocaleString() })
  if (entry.downloads !== null) {
    facts.push({ label: t('recomp.facts.downloads'), value: entry.downloads.toLocaleString() })
  }
  if (entry.license) facts.push({ label: t('recomp.facts.license'), value: entry.license })
  if (entry.author) facts.push({ label: t('recomp.facts.by'), value: entry.author })
  if (installed) {
    const label = t('recomp.facts.downloadCheck')
    facts.push(
      installed.verified === 'unverified'
        ? { label, value: t('recomp.facts.noChecksum'), tone: 'warn' }
        : {
            label,
            value:
              installed.verified === 'scanned'
                ? t('recomp.facts.scannedMatch')
                : t('recomp.facts.checksumMatched')
          }
    )
  }
  return facts
}

/** Tag chip tone: catalog features plain, status accent, setup plain, warnings red. */
export function tagTone(tag: RecompTag): 'accent' | 'plain' | 'warn' {
  return tag.kind === 'status' ? 'accent' : tag.kind === 'warning' ? 'warn' : 'plain'
}

/**
 * The game-file lines when main sent none for this version (it sends them for the chosen one): the version's needs,
 * nothing picked yet. 'self' / 'none' and optional needs never hold a start back.
 */
export function needsAsStates(entry: RecompEntry): GameFileState[] {
  return entry.needs.map((need) => ({
    ...need,
    path: null,
    source: null,
    verified: null,
    ready: need.optional || need.how === 'self' || need.how === 'none'
  }))
}

/** The needs that matter on the page ('none' asks for nothing). */
export function shownNeeds(states: GameFileState[]): GameFileState[] {
  return states.filter((s) => s.how !== 'none')
}

/** Whether a game-file need lets PlayOut hand over a file (else the recompilation asks for it itself). */
export function needPickable(need: Pick<GameFileNeed, 'how'>): boolean {
  return need.how === 'folder' || need.how === 'flag' || need.how === 'env'
}

/** How the file reaches the recompilation, in words. */
export function needHowText(need: GameFileNeed, recompName: string): string {
  switch (need.how) {
    case 'self':
      return t('recomp.need.self', { name: recompName })
    case 'folder': {
      // '.', './' or '' = the install folder itself.
      const folder = (need.folder ?? '').replace(/^[.\\/]+$/, '')
      const file = need.fileName
      if (folder)
        return file
          ? t('recomp.need.folderAs', { folder, file })
          : t('recomp.need.folder', { folder })
      return file ? t('recomp.need.nextToGameAs', { file }) : t('recomp.need.nextToGame')
    }
    case 'flag':
    case 'env':
      return t('recomp.need.handsTo', { name: recompName })
    case 'none':
      return ''
  }
}

/** "Accepts .z64, .n64 · USA · SLUS-01013": what a good file looks like. */
export function needSpecText(need: GameFileNeed): string {
  const parts: string[] = []
  if (need.formats.length > 0)
    parts.push(t('recomp.need.accepts', { formats: need.formats.join(', ') }))
  else if (need.accepts === 'folder') parts.push(t('recomp.need.aFolder'))
  if (need.region) parts.push(need.region)
  if (need.serial) parts.push(need.serial)
  return parts.join(' · ')
}

/** The verified badge of a picked file. */
export function verifiedBadge(
  state: Pick<GameFileState, 'verified' | 'path'>
): { label: string; tone: 'accent' | 'plain' | 'warn' } | null {
  if (!state.path) return null
  switch (state.verified) {
    case 'match':
      return { label: t('recomp.verified.match'), tone: 'accent' }
    case 'mismatch':
      return { label: t('recomp.verified.mismatch'), tone: 'warn' }
    case 'unverified':
      return { label: t('recomp.verified.unverified'), tone: 'plain' }
    default:
      return null
  }
}

export function sourceText(source: GameFileState['source']): string {
  return source === 'library'
    ? t('recomp.fileSource.library')
    : source === 'picked'
      ? t('recomp.fileSource.picked')
      : ''
}

/** Where the save folders came from. */
export function saveSourceText(source: InstalledRecomp['saveSource']): string {
  switch (source) {
    case 'user':
      return t('recomp.saveSource.user')
    case 'developer':
      return t('recomp.saveSource.developer')
    case 'catalog':
      return t('recomp.saveSource.catalog')
    case 'detected':
      return t('recomp.saveSource.detected')
    case 'install':
      return t('recomp.saveSource.install')
    default:
      return ''
  }
}

/** The save-copy line of the Saves section (the copy in the Emulation folder). */
export function cloudStatusText(cloud: RecompCloudState): { text: string; tone?: 'warn' } {
  if (!cloud.enabled) return { text: t('recomp.cloud.off') }
  if (cloud.conflict) return { text: t('recomp.cloud.conflict'), tone: 'warn' }
  if (cloud.error) return { text: t('recomp.cloud.error', { error: cloud.error }), tone: 'warn' }
  if (cloud.pending) return { text: t('recomp.cloud.pending') }
  if (cloud.syncedAt)
    return { text: t('recomp.cloud.syncedAt', { date: formatDate(cloud.syncedAt, 'medium') }) }
  return { text: t('recomp.cloud.on') }
}

/** The conflict banner's sentence. */
export function conflictText(conflict: NonNullable<RecompCloudState['conflict']>): string {
  const local = formatDate(conflict.localAt, 'medium')
  const cloud = formatDate(conflict.cloudAt, 'medium')
  // The dates are optional "(date)" after each side: punctuation only, so they are filled in here.
  const vars = { localAt: local ? ` (${local})` : '', cloudAt: cloud ? ` (${cloud})` : '' }
  return conflict.cloudDevice
    ? t('recomp.conflict.textDevice', { ...vars, device: conflict.cloudDevice })
    : t('recomp.conflict.text', vars)
}

/**
 * What a release row's button does. With the installed tag in the host's list (newest first), the rows above it are
 * updates and the rest go back. Without it (the release was deleted, renamed or made a draft), only a release
 * published after the installed build was put on this PC is surely newer; for the others, say neither ('install').
 */
export function releaseInstallKind(
  release: Pick<RecompRelease, 'tag' | 'publishedAt'>,
  releases: Pick<RecompRelease, 'tag'>[],
  installed: Pick<InstalledRecomp, 'tag' | 'installedAt' | 'updatedAt'> | undefined
): 'install' | 'update' | 'back' {
  if (!installed) return 'install'
  const at = releases.findIndex((r) => r.tag === installed.tag)
  if (at >= 0) {
    const index = releases.findIndex((r) => r.tag === release.tag)
    return index >= 0 && index < at ? 'update' : 'back'
  }
  const published = release.publishedAt ? Date.parse(release.publishedAt) : NaN
  const put = Date.parse(installed.updatedAt || installed.installedAt)
  return Number.isFinite(published) && Number.isFinite(put) && published > put
    ? 'update'
    : 'install'
}

/** A release row's install label (releaseInstallKind in words). */
export function releaseInstallLabel(
  release: Pick<RecompRelease, 'tag' | 'publishedAt'>,
  releases: Pick<RecompRelease, 'tag'>[],
  installed: Pick<InstalledRecomp, 'tag' | 'installedAt' | 'updatedAt'> | undefined
): string {
  switch (releaseInstallKind(release, releases, installed)) {
    case 'update':
      return t('recomp.releaseLabel.update')
    case 'back':
      return t('recomp.releaseLabel.back')
    default:
      return t('recomp.releaseLabel.install')
  }
}

/** The release list shown: newest first, at most `limit`. */
export function shownReleases<T>(releases: T[], limit = 10): T[] {
  return releases.slice(0, limit)
}
