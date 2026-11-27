import type { CoopLayout, CoopProgress, CoopRiskTool } from '@shared/types'
import { t } from '../i18n'
import type { ScanBar } from './scanBars'

/** Co-Op labels and the download bar (pure). Labels are getters, so each read is in the language shown. */

/** Short names (the setup's choices). */
export const COOP_LAYOUT_LABELS: Record<CoopLayout, string> = {
  get FullScreen() {
    return t('lib.coop.layouts.fullScreen')
  },
  get DualHorizontal() {
    return t('lib.coop.layouts.stacked')
  },
  get DualVertical() {
    return t('lib.coop.layouts.sideBySide')
  },
  FourPlayers: '2 × 2',
  SixPlayers: '2 × 3',
  EightPlayers: '2 × 4',
  SixteenPlayers: '4 × 4'
}

/** What a layout does, in a sentence's words ("Ready: 2 players, stacked top and bottom"). */
export const COOP_LAYOUT_DESCRIPTIONS: Record<CoopLayout, string> = {
  get FullScreen() {
    return t('lib.coop.descriptions.fullScreen')
  },
  get DualHorizontal() {
    return t('lib.coop.descriptions.stacked')
  },
  get DualVertical() {
    return t('lib.coop.descriptions.sideBySide')
  },
  get FourPlayers() {
    return t('lib.coop.descriptions.grid', { grid: '2 × 2' })
  },
  get SixPlayers() {
    return t('lib.coop.descriptions.grid', { grid: '2 × 3' })
  },
  get EightPlayers() {
    return t('lib.coop.descriptions.grid', { grid: '2 × 4' })
  },
  get SixteenPlayers() {
    return t('lib.coop.descriptions.grid', { grid: '4 × 4' })
  }
}

/**
 * How the players are laid out, in a sentence's words: one monitor's layout ("stacked top and bottom"), or with more
 * than one monitor each one's share ("main monitor stacked top and bottom, second monitor full screen").
 */
export function coopLayoutSummary(plan: {
  layout: CoopLayout
  monitors?: { layout: CoopLayout; players: number }[]
}): string {
  const monitors = plan.monitors ?? []
  if (monitors.length <= 1) return COOP_LAYOUT_DESCRIPTIONS[plan.layout]
  return monitors
    .map((m, i) => {
      const layout =
        m.players <= 1 ? t('lib.coop.monitors.fullScreen') : COOP_LAYOUT_DESCRIPTIONS[m.layout]
      switch (i) {
        case 0:
          return t('lib.coop.monitors.main', { layout })
        case 1:
          return t('lib.coop.monitors.second', { layout })
        case 2:
          return t('lib.coop.monitors.third', { layout })
        case 3:
          return t('lib.coop.monitors.fourth', { layout })
        default:
          return t('lib.coop.monitors.numbered', { number: i + 1, layout })
      }
    })
    .join(', ')
}

/** Layouts that hold `players` on one screen, smallest first. */
export function coopLayoutsFor(players: number): CoopLayout[] {
  const capacity: [CoopLayout, number][] = [
    ['DualHorizontal', 2],
    ['DualVertical', 2],
    ['FourPlayers', 4],
    ['SixPlayers', 6],
    ['EightPlayers', 8],
    ['SixteenPlayers', 16]
  ]
  return capacity.filter(([, n]) => n >= players).map(([layout]) => layout)
}

const RISK_NAMES: Record<CoopRiskTool, string> = {
  get steamless() {
    return t('lib.coop.risks.steamless')
  },
  get smartsteamemu() {
    return t('lib.coop.risks.smartsteamemu')
  },
  steamstub: 'SteamStub DRM Patcher',
  get eac() {
    return t('lib.coop.risks.eac')
  }
}

/** "Steamless (removes Steam DRM) and an Easy Anti-Cheat bypass". */
export function coopRiskNames(risks: readonly CoopRiskTool[]): string {
  const names = risks.map((r) => RISK_NAMES[r])
  return names.length <= 1
    ? (names[0] ?? '')
    : t('lib.coop.risks.list', {
        first: names.slice(0, -1).join(', '),
        last: names[names.length - 1]!
      })
}

const mb = (bytes: number): string => Math.round(bytes / 1_000_000).toLocaleString()

/** The handler pack or the Nucleus tools being downloaded, along the bottom of the window. */
export function coopScanBar(progress: CoopProgress): ScanBar | null {
  const { stage, done, total } = progress
  if (total <= 0) return null
  const counts = { done: done.toLocaleString(), total: total.toLocaleString() }
  const label =
    stage === 'listing'
      ? t('lib.coop.bar.listing')
      : stage === 'download'
        ? t('lib.coop.bar.downloading', counts)
        : stage === 'indexing'
          ? t('lib.coop.bar.reading', counts)
          : t('lib.coop.bar.tools', { done: mb(done), total: mb(total) })
  return { key: 'coop', name: t('lib.coop.bar.name'), label, done, total, paused: false }
}
