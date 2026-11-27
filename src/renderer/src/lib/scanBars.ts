import type {
  ArtProgress,
  EmulatorSetupProgress,
  HltbProgress,
  PlayersProgress,
  Ps3UpdateProgress,
  RatingsProgress,
  ScreenshotsProgress
} from '@shared/types'
import { t } from '../i18n'

/** One bar of the bottom progress stack (components/ScanBars.tsx). */
export interface ScanBar {
  key: string
  /** The bar's accessible name. */
  name: string
  label: string
  done: number
  total: number
  paused: boolean
}

/** "12 of 340": how far a pass is. */
function countText(done: number, total: number): string {
  return t('lib.scanBars.count', {
    done: Math.min(done, total).toLocaleString(),
    total: total.toLocaleString()
  })
}

/** A bar's label with the game it is at now, when there is one ("… · 12 of 340 · Halo"). */
const withCurrent = (label: string, current: string | undefined): string =>
  current ? `${label} · ${current}` : label

/** The install-size scan's bar (installed folders measured, other games looked up; ARCHITECTURE.md §4.11). */
export function sizeScanBar(scan: {
  done: number
  total: number
  paused: boolean
  current?: string
}): ScanBar | null {
  const { done, total, paused, current } = scan
  if (total <= 0) return null
  const count = countText(done, total)
  return {
    key: 'sizes',
    name: t('lib.scanBars.sizes.name'),
    label: paused
      ? t('lib.scanBars.sizes.paused', { left: total.toLocaleString() })
      : current
        ? t('lib.scanBars.sizes.measuring', { count, current })
        : t('lib.scanBars.sizes.checking', { count }),
    done,
    total,
    paused
  }
}

/** The review scores pass's bar (Steam's summaries in seconds, then IGDB for the games without one). */
export function ratingsScanBar(scan: RatingsProgress): ScanBar | null {
  const { done, total, stage, paused, current } = scan
  if (total <= 0) return null
  const left = Math.max(0, total - done).toLocaleString()
  const count = countText(done, total)
  return {
    key: 'ratings',
    name: t('lib.scanBars.ratings.name'),
    label: paused
      ? t('lib.scanBars.ratings.paused', { left })
      : stage === 'steam'
        ? t('lib.scanBars.ratings.steam', { count })
        : withCurrent(t('lib.scanBars.ratings.igdb', { count }), current),
    done,
    total,
    paused: !!paused
  }
}

/**
 * The background HowLongToBeat pass's bar (one game a second: HLTB's pace). None for the H.L.T.B. sort's lookups
 * (`source` 'sort'): the Library's header shows those ("Looking up H.L.T.B. times… N left").
 */
export function hltbScanBar(scan: HltbProgress): ScanBar | null {
  const { done, total, current } = scan
  if (total <= 0 || scan.source === 'sort') return null
  return {
    key: 'hltb',
    name: t('lib.scanBars.hltb.name'),
    label: withCurrent(t('lib.scanBars.hltb.label', { count: countText(done, total) }), current),
    done,
    total,
    paused: false
  }
}

/** The background download of Steam games' store screenshots (one game every couple of seconds: Steam's pace). */
export function screenshotsScanBar(scan: ScreenshotsProgress): ScanBar | null {
  const { done, total, current } = scan
  if (total <= 0) return null
  return {
    key: 'screenshots',
    name: t('lib.scanBars.screenshots.name'),
    label: withCurrent(
      t('lib.scanBars.screenshots.label', { count: countText(done, total) }),
      current
    ),
    done,
    total,
    paused: false
  }
}

/** Copying the paired hosts' metadata and art into this PC (several at once, at the connection's pace). */
export function hostSyncBar(scan: ScreenshotsProgress): ScanBar | null {
  const { done, total, current } = scan
  if (total <= 0) return null
  return {
    key: 'host-sync',
    name: t('lib.scanBars.hostSync.name'),
    label: withCurrent(
      t('lib.scanBars.hostSync.label', { count: countText(done, total) }),
      current
    ),
    done,
    total,
    paused: false
  }
}

const mb = (bytes: number): string => Math.round(bytes / 1_000_000).toLocaleString()

/** "120 of 700 MB": a download's progress. */
const mbText = (done: number, total: number): string =>
  t('lib.scanBars.megabytes', { done: mb(done), total: mb(total) })

/** LaunchBox's database being downloaded (MB of about 110), then read for its player counts. */
export function playersScanBar(scan: PlayersProgress): ScanBar | null {
  const { stage, done, total } = scan
  if (total <= 0) return null
  const share = Math.min(100, Math.max(0, Math.round((done / total) * 100)))
  return {
    key: 'players',
    name: t('lib.scanBars.players.name'),
    label:
      stage === 'download'
        ? t('lib.scanBars.players.downloading', { size: mbText(done, total) })
        : t('lib.scanBars.players.reading', { percent: share }),
    done,
    total,
    paused: false
  }
}

/**
 * The game art being downloaded (ARCHITECTURE.md §4.6 "Art progress"): one cover per game first, then each game's
 * remaining art (hero, logo, icon, screenshots) once the covers are in.
 */
export function artScanBar(scan: ArtProgress): ScanBar | null {
  const { stage, done, total } = scan
  if (total <= 0) return null
  const count = countText(done, total)
  return {
    key: 'art',
    name: t('lib.scanBars.art.name'),
    label:
      stage === 'cover'
        ? t('lib.scanBars.art.covers', { count })
        : t('lib.scanBars.art.other', { count }),
    done,
    total,
    paused: false
  }
}

/** A PS3 game's update being checked, downloaded or installed (main/emulation/ps3-update-service.ts). */
export function ps3UpdateBar(p: Ps3UpdateProgress | null): ScanBar | null {
  if (!p) return null
  const name = t('lib.scanBars.ps3.name')
  const { title, version } = p
  if (p.phase === 'downloading' && p.total) {
    const size = mbText(Math.min(p.bytes ?? 0, p.total), p.total)
    return {
      key: 'ps3-update',
      name,
      label: version
        ? t('lib.scanBars.ps3.downloadingVersion', { title, version, size })
        : t('lib.scanBars.ps3.downloading', { title, size }),
      done: p.bytes ?? 0,
      total: p.total,
      paused: false
    }
  }
  const label =
    p.phase === 'installing'
      ? version
        ? t('lib.scanBars.ps3.installingVersion', { title, version })
        : t('lib.scanBars.ps3.installing', { title })
      : t('lib.scanBars.ps3.checking', { title })
  return { key: 'ps3-update', name, label, done: 0, total: 1, paused: false }
}

/**
 * PlayOut's own emulators being set up (docs/emulator-setup.md): the Visual C++ / DirectX runtimes first, then the
 * downloads and unpacking (a few emulators at a time), then the BIOS links. The label is the step, then the parts
 * known of it (the emulators at work, the count, the MB, the files), joined by " · ".
 */
export function emulatorSetupBar(scan: EmulatorSetupProgress): ScanBar | null {
  const { done, total, stage, current, bytesDone, bytesTotal, filesDone, filesTotal } = scan
  if (total <= 0) return null
  const count = countText(done, total)
  const names = current?.length ? [current.join(', ')] : []
  const bytes =
    bytesTotal && bytesTotal > 0 ? [mbText(Math.min(bytesDone ?? 0, bytesTotal), bytesTotal)] : []
  const files =
    filesTotal && filesTotal > 0
      ? [
          t('lib.scanBars.emulators.files', {
            done: Math.min(filesDone ?? 0, filesTotal).toLocaleString(),
            total: filesTotal.toLocaleString()
          })
        ]
      : []
  const parts =
    stage === 'runtimes'
      ? [t('lib.scanBars.emulators.runtimes'), ...bytes]
      : stage === 'bios'
        ? [t('lib.scanBars.emulators.bios'), count]
        : stage === 'updates'
          ? [t('lib.scanBars.emulators.updating'), ...names, count, ...bytes]
          : [t('lib.scanBars.emulators.settingUp'), ...names, count, ...bytes, ...files]
  return {
    key: 'emulator-setup',
    name:
      stage === 'updates'
        ? t('lib.scanBars.emulators.updatesName')
        : t('lib.scanBars.emulators.setupName'),
    label: parts.join(' · '),
    done,
    total,
    paused: false
  }
}
