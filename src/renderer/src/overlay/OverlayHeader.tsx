import { Activity, Battery, BatteryCharging, Clock, Gauge, Pause, Zap } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { Chip } from '../components/Chip'
import { useT } from '../i18n'
import { formatClock } from '../lib/format'
import { displayTitle } from '../lib/library'
import { useLibraryStore } from '../state/library'
import { useSettingsStore } from '../state/settings'
import { useSystemStore } from '../state/system'
import { useOverlayStore } from './overlayStore'
import { useRunningGameId } from './shared'
import { fpsChip, fpsChipTitle, profileChip, wattsChip } from './text'
import { usePolling } from './usePolling'

const CLOCK_INTERVAL_MS = 5000
/** The live fps and watts chips: read once a second, only while the overlay is open (the header mounts with it). */
const LIVE_INTERVAL_MS = 1000

/** The clock text. The header mounts with each open (the panel is unmounted while closed), so it starts current. */
function useClock(clock24h: boolean): string {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])
  return formatClock(now, clock24h)
}

/**
 * Panel header: the tab's title, what the overlay is over, and the live fps / watts chips (each hidden while unknown)
 * before the profile / battery / clock chips.
 */
export function OverlayHeader({ title }: { title: string }): ReactElement {
  const program = useOverlayStore((s) => s.program)
  const paused = useOverlayStore((s) => s.paused)
  const performance = useOverlayStore((s) => s.performance)
  const open = useOverlayStore((s) => s.open)
  const live = useOverlayStore((s) => s.live)
  const refreshLive = useOverlayStore((s) => s.refreshLive)
  const settings = useSettingsStore((s) => s.settings)
  const battery = useSystemStore((s) => s.status?.battery ?? null)
  const gameId = useRunningGameId()
  const game = useLibraryStore((s) => (gameId ? s.byId.get(gameId) : undefined))
  const clock = useClock(settings?.ui.clock24h ?? false)
  usePolling(refreshLive, LIVE_INTERVAL_MS, open)
  const t = useT()
  const fps = fpsChip(live)
  const watts = wattsChip(live, performance)

  const over = game ? displayTitle(game) : program
  return (
    <header className="ov-header">
      <div className="ov-header__text">
        <h2 className="ov-header__title">{title}</h2>
        {over ? <div className="ov-header__over u-truncate">{over}</div> : null}
      </div>
      <div className="ov-header__chips">
        {paused ? (
          <Chip icon={<Pause />} title={t('overlay.header.pausedTitle')}>
            {t('overlay.header.paused')}
          </Chip>
        ) : null}
        {fps ? (
          <Chip icon={<Activity />} title={fpsChipTitle(live)}>
            {fps}
          </Chip>
        ) : null}
        {watts ? (
          <Chip icon={<Zap />} title={t('overlay.header.cpuPower')}>
            {watts}
          </Chip>
        ) : null}
        <Chip icon={<Gauge />} title={t('overlay.header.powerProfile')}>
          {profileChip(
            performance,
            settings?.performance.profiles,
            settings?.performance.useWatts ?? true
          )}
        </Chip>
        {battery?.present ? (
          <Chip
            icon={battery.charging ? <BatteryCharging /> : <Battery />}
            title={t('overlay.header.battery')}
          >
            {Math.round(battery.percent)}%
          </Chip>
        ) : null}
        <Chip icon={<Clock />}>{clock}</Chip>
      </div>
    </header>
  )
}
