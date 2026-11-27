import type { SystemStatus } from '@shared/types'
import {
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Bluetooth,
  BluetoothOff,
  Download,
  EthernetPort,
  Pause,
  Power,
  Search,
  Volume1,
  Volume2,
  VolumeX,
  Wifi,
  WifiHigh,
  WifiLow,
  WifiOff,
  WifiZero
} from 'lucide-react'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT, type Translate } from '../../i18n'
import { FocusContext, useFocusable } from '../../input/focus'
import { cx } from '../../lib/cx'
import { formatClock } from '../../lib/format'
import { romDownloadProgressView } from '../../lib/streaming'
import { activeQueueEntry, queueSummary, useInstallQueueStore } from '../../state/installQueue'
import { installPercent, useInstallsStore } from '../../state/installs'
import { useSettingsStore } from '../../state/settings'
import { useStreamingStore } from '../../state/streaming'
import { useSystemStore } from '../../state/system'
import { useUiStore } from '../../state/ui'
import { SYSTEMBAR_KEY } from './rows'

/** The clock re-renders this often; the minute display is at most this stale after a minute boundary. */
const CLOCK_TICK_MS = 30_000

export interface SystemBarProps {
  /** Draw the pill above the open panel modal (it is never covered by a panel or its scrim). */
  raised?: boolean
  /** Slide the pill away with the rest of Home while the Library view is shown (its band takes that space). */
  away?: boolean
}

/**
 * Top-right glass pill (design 2.3): search | downloads (while the install queue is not empty) | volume, Bluetooth,
 * network | battery %, power, clock.
 * Items with an action are focusable 44u targets; the status glyphs reflect the system store. Settings
 * is reached through the Menu button hint and the quick panel, so the pill carries no gear.
 */
export function SystemBar({ raised = false, away = false }: SystemBarProps): ReactElement {
  const t = useT()
  const status = useSystemStore((s) => s.status)
  const clock24h = useSettingsStore((s) => s.settings?.ui.clock24h ?? false)
  const openModal = useUiStore((s) => s.openModal)
  const clock = useClock(clock24h)
  const downloads = useDownloadsSummary()

  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({
    focusKey: SYSTEMBAR_KEY,
    trackChildren: true,
    saveLastFocusedChild: true
  })

  const battery = status?.battery
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className={cx(
          'system-bar',
          'glass',
          raised && 'system-bar--raised',
          away && 'system-bar--away'
        )}
        role="toolbar"
        aria-label={t('home.systemBar.label')}
        aria-hidden={away}
      >
        <BarItem
          icon={<Search />}
          label={t('home.systemBar.search')}
          focusKey={`${SYSTEMBAR_KEY}:search`}
          onPress={() => openModal({ type: 'search' })}
          className="system-bar__item--search"
        />
        <span className="system-bar__divider" aria-hidden="true" />
        {downloads ? (
          <>
            <BarItem
              icon={downloads.paused ? <Pause /> : <Download />}
              text={downloads.text}
              label={downloads.label}
              focusKey={`${SYSTEMBAR_KEY}:downloads`}
              onPress={() => openModal({ type: 'quickpanel', focus: 'downloads' })}
            />
            <span className="system-bar__divider" aria-hidden="true" />
          </>
        ) : null}
        <BarItem
          icon={volumeIcon(status?.volume)}
          label={volumeLabel(status?.volume, t)}
          focusKey={`${SYSTEMBAR_KEY}:volume`}
          onPress={() => openModal({ type: 'quickpanel' })}
        />
        <BarItem
          icon={status?.bluetooth.on ? <Bluetooth /> : <BluetoothOff />}
          label={
            status?.bluetooth.on
              ? t('home.systemBar.bluetoothOn')
              : t('home.systemBar.bluetoothOff')
          }
        />
        <BarItem icon={networkIcon(status?.network)} label={networkLabel(status?.network, t)} />
        <span className="system-bar__divider" aria-hidden="true" />
        {battery?.present ? (
          <BarItem
            icon={batteryIcon(battery)}
            text={`${Math.round(battery.percent)}%`}
            label={
              battery.charging
                ? t('home.systemBar.batteryCharging', { percent: Math.round(battery.percent) })
                : t('home.systemBar.battery', { percent: Math.round(battery.percent) })
            }
            className="system-bar__item--battery"
          />
        ) : null}
        <BarItem
          icon={<Power />}
          label={t('home.systemBar.power')}
          focusKey={`${SYSTEMBAR_KEY}:power`}
          onPress={() => openModal({ type: 'quickpanel' })}
        />
        <BarItem
          text={clock}
          label={t('home.systemBar.clock')}
          className="system-bar__item--clock"
        />
      </div>
    </FocusContext.Provider>
  )
}

function BarItem({
  icon,
  text,
  label,
  focusKey,
  onPress,
  className
}: {
  icon?: ReactNode
  text?: string
  label: string
  focusKey?: string
  onPress?: () => void
  className?: string
}): ReactElement {
  const focusable = onPress !== undefined
  const { ref, props: controlProps } = useFocusableControl<HTMLDivElement>({
    focusKey,
    onPress,
    focusable,
    scroll: false
  })
  return (
    <div
      ref={ref}
      className={cx(
        'system-bar__item',
        focusable && 'system-bar__item--button',
        text !== undefined && 'system-bar__item--text',
        className
      )}
      role={focusable ? 'button' : 'img'}
      aria-label={label}
      title={label}
      {...(focusable ? controlProps : {})}
    >
      {icon}
      {text !== undefined ? <span className="system-bar__label">{text}</span> : null}
    </div>
  )
}

/**
 * The pill's downloads item: the active download's percent (store install or host ROM) and how many games wait,
 * or null while the install queue is empty. Paused (the active download, or every game with none active): a pause
 * glyph and no percent.
 */
function useDownloadsSummary(): { text?: string; label: string; paused: boolean } | null {
  const entries = useInstallQueueStore((s) => s.entries)
  const active = activeQueueEntry(entries)
  const install = useInstallsStore((s) =>
    active?.kind === 'store' ? s.installs.get(active.gameId) : undefined
  )
  const rom = useStreamingStore((s) =>
    active?.kind === 'host-rom' ? s.downloads[active.gameId] : undefined
  )
  if (entries.length === 0) return null
  // An ended ROM attempt (its host went offline; the queue keeps it) has no live percent.
  const percent = installPercent(
    rom ? (rom.state === 'downloading' ? romDownloadProgressView(rom) : null) : install
  )
  return queueSummary(entries, percent)
}

function useClock(clock24h: boolean): string {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return formatClock(now, clock24h)
}

function volumeIcon(volume: SystemStatus['volume'] | undefined): ReactNode {
  if (!volume) return <Volume2 />
  if (volume.muted || volume.level <= 0) return <VolumeX />
  return volume.level < 50 ? <Volume1 /> : <Volume2 />
}

function volumeLabel(volume: SystemStatus['volume'] | undefined, t: Translate): string {
  if (!volume) return t('home.systemBar.volume')
  return volume.muted
    ? t('home.systemBar.volumeMuted')
    : t('home.systemBar.volumeLevel', { percent: Math.round(volume.level) })
}

function networkIcon(network: SystemStatus['network'] | undefined): ReactNode {
  if (!network) return <Wifi />
  if (!network.connected) return <WifiOff />
  if (network.kind === 'ethernet') return <EthernetPort />
  const signal = network.signal
  if (signal === undefined) return <Wifi />
  if (signal <= 20) return <WifiZero />
  if (signal <= 45) return <WifiLow />
  if (signal <= 75) return <WifiHigh />
  return <Wifi />
}

function networkLabel(network: SystemStatus['network'] | undefined, t: Translate): string {
  if (!network || !network.connected) return t('home.systemBar.noNetwork')
  if (network.kind === 'ethernet') return t('home.systemBar.ethernet')
  return network.ssid
    ? t('home.systemBar.wifiNamed', { ssid: network.ssid })
    : t('home.systemBar.wifi')
}

/** The outline battery at its level; charging is reported in the item's label rather than as a bolt glyph. */
function batteryIcon(battery: { percent: number }): ReactNode {
  if (battery.percent <= 10) return <BatteryWarning />
  if (battery.percent <= 35) return <BatteryLow />
  if (battery.percent <= 70) return <BatteryMedium />
  return <BatteryFull />
}
