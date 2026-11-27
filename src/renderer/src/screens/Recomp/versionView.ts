// Words and rules for managing the version of an installed recompilation (VersionManager.tsx: the Version row and
// its release list, shared by the Recompilation page and Settings › Recompilations), kept pure so they are tested
// without rendering.
import type { InstalledRecomp, RecompRelease, RecompRow } from '@shared/recomp'
import { t } from '../../i18n'
import { formatDate } from '../../lib/format'

/** Tags compared as the hosts write them loosely ("v1.2" and "1.2", any case). */
export function sameRecompTag(a: string, b: string): boolean {
  const norm = (t: string): string =>
    t
      .trim()
      .toLowerCase()
      .replace(/^v(?=\d)/, '')
  return norm(a) === norm(b)
}

/** Which chip the Version row shows (an id: versionChipText words it). */
export type VersionChip = 'Latest' | 'Older version' | 'Pre-release'

/** The Version row's chip in the current language. */
export function versionChipText(chip: VersionChip): string {
  switch (chip) {
    case 'Latest':
      return t('recomp.version.latest')
    case 'Older version':
      return t('recomp.version.older')
    case 'Pre-release':
      return t('recomp.version.prerelease')
  }
}

/**
 * The Version row's chip: an older version (kept by choice, or with an update waiting), a pre-release, the latest
 * (the last release check saw no newer one); null before a release check.
 */
export function versionChip(
  row: Pick<RecompRow, 'update' | 'release'> & {
    installed: Pick<InstalledRecomp, 'tag' | 'pinnedTag'>
  }
): VersionChip | null {
  if (row.installed.pinnedTag || row.update) return 'Older version'
  if (!row.release) return null
  if (row.release.prerelease) return 'Pre-release'
  return row.release.latest && sameRecompTag(row.release.latest, row.installed.tag)
    ? 'Latest'
    : null
}

/** The Version row's value: the tag in use and when it was published (else installed). */
export function versionText(
  installed: Pick<InstalledRecomp, 'tag' | 'publishedAt' | 'updatedAt'>
): string {
  const date = formatDate(installed.publishedAt ?? installed.updatedAt, 'medium')
  return date ? `${installed.tag} · ${date}` : installed.tag
}

/** The Version row's description: what Change version does, or that the version is kept. */
export function versionDesc(installed: Pick<InstalledRecomp, 'pinnedTag'>): string {
  return installed.pinnedTag
    ? t('recomp.version.pinnedDesc', { tag: installed.pinnedTag })
    : t('recomp.version.desc')
}

/**
 * The newest release with a Windows download, as main marks it (RecompRelease.newest: by version, test builds left
 * out, the same rule as its update check), never guessed from the list's order.
 */
export function newestInstallable<T extends Pick<RecompRelease, 'newest'>>(
  releases: T[]
): T | null {
  return releases.find((r) => r.newest === true) ?? null
}

/**
 * What a release list says of the version in use (as main's release check reports it for Settings): whether it is a
 * pre-release, and the newest release with a Windows download.
 */
export function releaseInfo(
  releases: Pick<RecompRelease, 'tag' | 'prerelease' | 'newest'>[],
  tag: string
): NonNullable<RecompRow['release']> {
  return {
    prerelease: releases.find((r) => sameRecompTag(r.tag, tag))?.prerelease === true,
    latest: newestInstallable(releases)?.tag ?? null
  }
}

/** Whether choosing `release` keeps the recompilation there (main's pinFor, as RecompRelease.pins carries it). */
export function wouldPin(release: Pick<RecompRelease, 'pins'>): boolean {
  return release.pins === true
}

export interface VersionItem {
  release: RecompRelease
  inUse: boolean
  /** Why it cannot be chosen (no Windows download), else null. */
  unavailable: string | null
}

/**
 * The release list: the project's releases newest first (the host's order), the one in use marked (none when the
 * recompilation is not installed).
 */
export function versionItems(
  releases: RecompRelease[],
  installed: Pick<InstalledRecomp, 'tag'> | undefined
): VersionItem[] {
  return releases.map((release) => ({
    release,
    inUse: !!installed && sameRecompTag(release.tag, installed.tag),
    unavailable: release.asset ? null : t('recomp.version.noWindowsDownload')
  }))
}

/**
 * Where focus goes when "Show all" (which then goes away) is pressed, best first (focus names for the screen's
 * focusKey): the first newly shown release's action (only when it has one: not in use, a Windows download), its
 * notes (only when it has some), else Change version.
 */
export function showAllFocus(items: VersionItem[], shown: number): string[] {
  const next = items[shown]
  if (!next) return ['versions']
  const { release, inUse, unavailable } = next
  return [
    ...(!inUse && !unavailable ? [`version:${release.tag}:use`] : []),
    ...(release.notes.trim() ? [`version:${release.tag}:notes`] : []),
    'versions'
  ]
}

/** The release list's button: installed, another version of it; not installed yet, that release. */
export function versionActionLabel(installed: boolean): string {
  return installed ? t('recomp.version.useThis') : t('recomp.releaseLabel.install')
}

/** The confirmation before switching versions. */
export function switchConfirm(
  name: string,
  release: Pick<RecompRelease, 'tag' | 'pins'>
): { title: string; message: string } {
  return {
    title: t('recomp.version.switchTitle', { name, tag: release.tag }),
    message: wouldPin(release)
      ? t('recomp.version.switchPinned', { tag: release.tag })
      : t('recomp.version.switchKept')
  }
}
