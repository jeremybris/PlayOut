import type { GameMetadata } from '@shared/types'
import type { ReactElement } from 'react'
import { Stat } from '../../components/Stat'
import { useT } from '../../i18n'
import { formatCompactCount } from '../../lib/format'
import { currentShare, playersOf } from '../../lib/players'

/**
 * Steam games' "Players" on the action bar: overlapping bars (green = the all-time peak, orange = online now) with
 * the two numbers right of them, the peak over a line and the number online now under it (6.7K, 1.2M).
 */
export function PlayersStat({
  meta,
  className
}: {
  meta: Pick<GameMetadata, 'currentPlayers' | 'peakPlayers'>
  className?: string
}): ReactElement | null {
  const t = useT()
  const players = playersOf(meta)
  if (!players) return null
  const { current, peak } = players
  const peakText = peak !== null ? formatCompactCount(peak) : '—'
  const currentText = current !== null ? formatCompactCount(current) : '—'
  // One whole sentence for each of the four cases (a number known or not), never fragments glued together.
  const ariaLabel =
    peak !== null && current !== null
      ? t('gameDetail.stats.players.ariaBoth', {
          peak: peak.toLocaleString(),
          current: current.toLocaleString()
        })
      : peak !== null
        ? t('gameDetail.stats.players.ariaPeakOnly', { peak: peak.toLocaleString() })
        : current !== null
          ? t('gameDetail.stats.players.ariaCurrentOnly', { current: current.toLocaleString() })
          : t('gameDetail.stats.players.ariaNone')
  return (
    <Stat
      label={t('gameDetail.stats.players.label')}
      className={className ? `gdetail__online ${className}` : 'gdetail__online'}
      value={
        <span className="gdetail__online-body" role="img" aria-label={ariaLabel}>
          <span className="gdetail__online-chart" aria-hidden="true">
            {peak !== null ? (
              <span className="gdetail__online-bar gdetail__online-bar--peak" />
            ) : null}
            <span
              className="gdetail__online-bar gdetail__online-bar--current"
              style={{ width: `${currentShare(current, peak)}%` }}
            />
          </span>
          <span className="gdetail__online-numbers" aria-hidden="true">
            <span className="gdetail__online-peak" title={t('gameDetail.stats.players.peakTitle')}>
              {peakText}
            </span>
            <span
              className="gdetail__online-current"
              title={t('gameDetail.stats.players.currentTitle')}
            >
              {currentText}
            </span>
          </span>
        </span>
      }
    />
  )
}
