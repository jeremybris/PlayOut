import type { PowerMode, SystemStatus, WindowsSettingsPage } from '@shared/types'
import {
  Battery,
  BatteryCharging,
  BatteryWarning,
  Bluetooth,
  BluetoothOff,
  Cable,
  Gamepad2,
  Monitor,
  Sun,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  Zap
} from 'lucide-react'
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { api } from '../../api/client'
import { Button } from '../../components/Button'
import { ButtonHints } from '../../components/ButtonHints'
import { DownloadQueueList } from '../../components/DownloadQueueList'
import { IconButton } from '../../components/IconButton'
import { Modal } from '../../components/Modal'
import { Slider } from '../../components/Slider'
import { Stat } from '../../components/Stat'
import { useFocusableControl } from '../../hooks/useFocusableControl'
import { useT, type Translate } from '../../i18n'
import { cx } from '../../lib/cx'
import { downloadQueueSafeFocusKey } from '../../lib/focusKeys'
import { formatClock, formatMegabytes, formatPercent } from '../../lib/format'
import { displayTitle } from '../../lib/library'
import { createLog } from '../../lib/log'
import { useInstallQueueStore } from '../../state/installQueue'
import { useLibraryStore } from '../../state/library'
import { useSettingsStore } from '../../state/settings'
import { useSystemStore } from '../../state/system'
import { useUiStore } from '../../state/ui'
import { PowerMenu } from './PowerMenu'
import './quickpanel.css'

const log = createLog('quickpanel')
const PERF_INTERVAL_MS = 2000
const CLOCK_INTERVAL_MS = 1000

/** The power mode buttons, in the language shown (built per render: a constant would keep the language it loaded in). */
function powerModes(t: Translate): { value: PowerMode; label: string }[] {
  return [
    { value: 'efficiency', label: t('quickPanel.powerMode.efficiency') },
    { value: 'balanced', label: t('quickPanel.powerMode.balanced') },
    { value: 'performance', label: t('quickPanel.powerMode.performance') }
  ]
}

/** The Windows settings shortcuts, as powerModes. */
function shortcuts(
  t: Translate
): { page: WindowsSettingsPage; label: string; icon: ReactElement }[] {
  return [
    { page: 'bluetooth', label: t('quickPanel.windowsSettings.bluetooth'), icon: <Bluetooth /> },
    { page: 'wifi', label: t('quickPanel.windowsSettings.wifi'), icon: <Wifi /> },
    { page: 'sound', label: t('quickPanel.windowsSettings.sound'), icon: <Volume2 /> },
    { page: 'display', label: t('quickPanel.windowsSettings.display'), icon: <Monitor /> },
    { page: 'power', label: t('quickPanel.windowsSettings.power'), icon: <Zap /> },
    { page: 'gamepad', label: t('quickPanel.windowsSettings.gamepad'), icon: <Gamepad2 /> }
  ]
}

export interface QuickPanelProps {
  /** 'downloads': focus the install queue's list on open (the system bar's Downloads item); default the tiles. */
  focus?: 'downloads'
  onClose: () => void
}

/** The install queue's list in the panel. */
const DOWNLOADS_KEY = 'quickpanel:downloads'

/** Wall clock + date, re-rendered only when the text changes. */
function useClock(clock24h: boolean): { time: string; date: string } {
  const compute = useCallback(() => {
    const now = new Date()
    return {
      time: formatClock(now, clock24h),
      date: new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric'
      }).format(now)
    }
  }, [clock24h])
  const [value, setValue] = useState(compute)
  // A clock-format change re-renders with the new format straight away (the interval would lag 1 s).
  const [seen24h, setSeen24h] = useState(clock24h)
  if (seen24h !== clock24h) {
    setSeen24h(clock24h)
    setValue(compute())
  }
  useEffect(() => {
    const timer = setInterval(() => {
      const next = compute()
      setValue((current) =>
        current.time === next.time && current.date === next.date ? current : next
      )
    }, CLOCK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [compute])
  return value
}

function batteryInfo(
  status: SystemStatus | null,
  t: Translate
): {
  icon: ReactNode
  value: string
  detail: string
} {
  const battery = status?.battery
  if (!battery || !battery.present) {
    return {
      icon: <Zap />,
      value: t('quickPanel.battery.pluggedIn'),
      detail: t('quickPanel.battery.noBattery')
    }
  }
  const icon = battery.charging ? (
    <BatteryCharging />
  ) : battery.percent <= 10 ? (
    <BatteryWarning />
  ) : (
    <Battery />
  )
  return {
    icon,
    value: `${Math.round(battery.percent)}%`,
    detail: battery.charging ? t('quickPanel.battery.charging') : t('quickPanel.battery.onBattery')
  }
}

function networkInfo(
  status: SystemStatus | null,
  t: Translate
): {
  icon: ReactNode
  value: string
  detail: string
} {
  const network = status?.network
  if (!network || !network.connected || network.kind === 'none') {
    return {
      icon: <WifiOff />,
      value: t('quickPanel.network.offline'),
      detail: t('quickPanel.network.noNetwork')
    }
  }
  if (network.kind === 'ethernet') {
    return {
      icon: <Cable />,
      value: t('quickPanel.network.ethernet'),
      detail: t('quickPanel.network.wired')
    }
  }
  return {
    icon: <Wifi />,
    value: network.ssid ?? t('quickPanel.network.wifi'),
    detail:
      network.signal !== undefined
        ? t('quickPanel.network.signal', { percent: formatPercent(network.signal) })
        : t('quickPanel.network.wifi')
  }
}

function bluetoothInfo(
  status: SystemStatus | null,
  t: Translate
): {
  icon: ReactNode
  value: string
  detail: string
} {
  const bluetooth = status?.bluetooth
  if (!bluetooth || !bluetooth.available) {
    return {
      icon: <BluetoothOff />,
      value: t('quickPanel.bluetooth.unavailable'),
      detail: t('quickPanel.bluetooth.noAdapter')
    }
  }
  return {
    icon: bluetooth.on ? <Bluetooth /> : <BluetoothOff />,
    value: bluetooth.on ? t('quickPanel.bluetooth.on') : t('quickPanel.bluetooth.off'),
    detail: t('quickPanel.bluetooth.name')
  }
}

/** Focusable status tile (battery / network / Bluetooth) that opens the matching Windows settings page. */
function Tile({
  focusKey,
  icon,
  value,
  detail,
  onPress
}: {
  focusKey: string
  icon: ReactNode
  value: string
  detail: string
  onPress: () => void
}): ReactElement {
  const t = useT()
  const { ref, props } = useFocusableControl<HTMLButtonElement>({ focusKey, onPress })
  return (
    <button
      ref={ref}
      type="button"
      className="qp-tile"
      aria-label={t('quickPanel.tileLabel', { detail, value })}
      title={detail}
      {...props}
    >
      <span className="qp-tile__icon">{icon}</span>
      <span className="qp-tile__value u-truncate">{value}</span>
      <span className="qp-tile__detail u-truncate">{detail}</span>
    </button>
  )
}

/**
 * Quick panel under the system bar: clock, the install queue (while a game downloads or waits), battery / network /
 * Bluetooth tiles, volume and brightness, power mode, live CPU / memory / GPU, Windows settings shortcuts and the power menu.
 */
export function QuickPanel({ focus, onClose }: QuickPanelProps): ReactElement {
  const t = useT()
  const status = useSystemStore((s) => s.status)
  const running = useSystemStore((s) => s.running)
  const perf = useSystemStore((s) => s.perf)
  const refreshPerf = useSystemStore((s) => s.refreshPerf)
  const patchStatus = useSystemStore((s) => s.patchStatus)
  const runningGame = useLibraryStore((s) => (running ? s.byId.get(running.gameId) : undefined))
  const clock24h = useSettingsStore((s) => s.settings?.ui.clock24h ?? false)
  const toast = useUiStore((s) => s.toast)
  const clock = useClock(clock24h)
  const downloads = useInstallQueueStore((s) => s.entries.length > 0)
  const downloadsFocusKey = useInstallQueueStore((s) =>
    downloadQueueSafeFocusKey(DOWNLOADS_KEY, s.entries)
  )

  useEffect(() => {
    void refreshPerf()
    const timer = setInterval(() => void refreshPerf(), PERF_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refreshPerf])

  const openWindows = useCallback(
    (page: WindowsSettingsPage) => {
      api.openWindowsSettings(page).catch((err) => {
        log.error(`openWindowsSettings(${page}) failed`, err)
        toast(t('quickPanel.errors.windowsSettings'), 'error')
      })
    },
    [toast, t]
  )

  const volume = status?.volume ?? null
  const setVolume = useCallback(
    (level: number) => patchStatus({ volume: { level, muted: false } }),
    [patchStatus]
  )
  const commitVolume = useCallback(
    (level: number) => {
      const calls = [api.setVolume(level)]
      if (volume?.muted) calls.push(api.setMuted(false))
      Promise.all(calls).catch((err) => {
        log.error('setVolume failed', err)
        toast(t('quickPanel.errors.volume'), 'error')
      })
    },
    [toast, t, volume?.muted]
  )
  const toggleMute = useCallback(() => {
    if (!volume) return
    const muted = !volume.muted
    patchStatus({ volume: { ...volume, muted } })
    api.setMuted(muted).catch((err) => {
      log.error('setMuted failed', err)
      toast(muted ? t('quickPanel.errors.mute') : t('quickPanel.errors.unmute'), 'error')
    })
  }, [patchStatus, toast, t, volume])

  const setBrightness = useCallback(
    (percent: number) => patchStatus({ brightness: percent }),
    [patchStatus]
  )
  const commitBrightness = useCallback(
    (percent: number) => {
      api.setBrightness(percent).catch((err) => {
        log.error('setBrightness failed', err)
        toast(t('quickPanel.errors.brightness'), 'error')
      })
    },
    [toast, t]
  )

  const setMode = useCallback(
    (mode: PowerMode) => {
      if (status?.powerMode === mode) return
      patchStatus({ powerMode: mode })
      api.setPowerMode(mode).catch((err) => {
        log.error('setPowerMode failed', err)
        toast(t('quickPanel.errors.powerMode'), 'error')
      })
    },
    [patchStatus, status?.powerMode, toast, t]
  )

  const battery = batteryInfo(status, t)
  const network = networkInfo(status, t)
  const bluetooth = bluetoothInfo(status, t)
  const showGpu = perf?.gpuPercent !== null && perf?.gpuPercent !== undefined

  return (
    <Modal
      size="dialog"
      focusKey="quickpanel"
      // The tiles first even with downloads above them, unless opened from the system bar's Downloads item: then the
      // first row's title (never a button, so A on a fresh panel never stops or reorders a download).
      preferredChildFocusKey={(focus === 'downloads' && downloadsFocusKey) || 'quickpanel:battery'}
      title={clock.time}
      subtitle={clock.date}
      onClose={onClose}
      className="quickpanel"
      bodyClassName="quickpanel__body"
      aria-label={t('quickPanel.label')}
    >
      {runningGame ? (
        <div className="qp-playing">
          <span className="qp-playing__dot" aria-hidden="true" />
          <span className="u-truncate">
            {t('quickPanel.playing', { title: displayTitle(runningGame) })}
          </span>
        </div>
      ) : null}

      {downloads ? (
        <div className="qp-group">
          <div className="qp-group__title">{t('quickPanel.downloads')}</div>
          <DownloadQueueList focusKey={DOWNLOADS_KEY} fallbackFocusKey="quickpanel:battery" />
        </div>
      ) : null}

      <div className="qp-tiles">
        <Tile
          focusKey="quickpanel:battery"
          icon={battery.icon}
          value={battery.value}
          detail={battery.detail}
          onPress={() => openWindows('power')}
        />
        <Tile
          focusKey="quickpanel:network"
          icon={network.icon}
          value={network.value}
          detail={network.detail}
          onPress={() => openWindows('wifi')}
        />
        <Tile
          focusKey="quickpanel:bluetooth"
          icon={bluetooth.icon}
          value={bluetooth.value}
          detail={bluetooth.detail}
          onPress={() => openWindows('bluetooth')}
        />
      </div>

      <div className="qp-group">
        {volume ? (
          <div className="qp-volume">
            <Slider
              className="qp-volume__slider"
              focusKey="quickpanel:volume"
              icon={volume.muted ? <VolumeX /> : <Volume2 />}
              label={t('quickPanel.volume.label')}
              value={volume.level}
              onChange={setVolume}
              onCommit={commitVolume}
              formatValue={(v) =>
                volume.muted ? t('quickPanel.volume.muted') : `${Math.round(v)}%`
              }
            />
            <IconButton
              focusKey="quickpanel:mute"
              icon={volume.muted ? <VolumeX /> : <Volume2 />}
              aria-label={
                volume.muted ? t('quickPanel.volume.unmute') : t('quickPanel.volume.mute')
              }
              active={volume.muted}
              onPress={toggleMute}
            />
          </div>
        ) : null}
        {status?.brightness !== null && status?.brightness !== undefined ? (
          <Slider
            focusKey="quickpanel:brightness"
            icon={<Sun />}
            label={t('quickPanel.brightness')}
            value={status.brightness}
            onChange={setBrightness}
            onCommit={commitBrightness}
          />
        ) : null}
      </div>

      {status?.powerMode ? (
        <div className="qp-group">
          <div className="qp-group__title">{t('quickPanel.powerMode.title')}</div>
          <div
            className="qp-segmented"
            role="radiogroup"
            aria-label={t('quickPanel.powerMode.title')}
          >
            {powerModes(t).map((mode) => (
              <Button
                key={mode.value}
                focusKey={`quickpanel:mode:${mode.value}`}
                className={cx(
                  'qp-segmented__item',
                  status.powerMode === mode.value && 'qp-segmented__item--on'
                )}
                variant={status.powerMode === mode.value ? 'primary' : 'secondary'}
                onPress={() => setMode(mode.value)}
                aria-label={t('quickPanel.powerMode.buttonLabel', { mode: mode.label })}
              >
                {mode.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="qp-group">
        <div className="qp-group__title">{t('quickPanel.power')}</div>
        <PowerMenu
          focusKey="quickpanel:power"
          onAction={(action) => {
            if (action === 'minimize') onClose()
          }}
        />
      </div>

      <div className="qp-group">
        <div className="qp-group__title">{t('quickPanel.performance.title')}</div>
        <div className="qp-perf">
          <Stat label={t('quickPanel.performance.cpu')} value={formatPercent(perf?.cpuPercent)} />
          <Stat
            label={t('quickPanel.performance.memory')}
            value={
              perf?.memoryUsedMb !== null && perf?.memoryUsedMb !== undefined
                ? `${formatMegabytes(perf.memoryUsedMb)} / ${formatMegabytes(perf.memoryTotalMb)}`
                : '—'
            }
          />
          {showGpu ? (
            <Stat label={t('quickPanel.performance.gpu')} value={formatPercent(perf?.gpuPercent)} />
          ) : null}
        </div>
      </div>

      <div className="qp-group">
        <div className="qp-group__title">{t('quickPanel.windowsSettings.title')}</div>
        <div className="qp-shortcuts">
          {shortcuts(t).map((entry) => (
            <Button
              key={entry.page}
              focusKey={`quickpanel:win:${entry.page}`}
              className="qp-shortcut"
              icon={entry.icon}
              onPress={() => openWindows(entry.page)}
            >
              {entry.label}
            </Button>
          ))}
        </div>
      </div>

      <ButtonHints
        hints={[
          { button: 'a', label: t('quickPanel.hints.select') },
          { button: 'b', label: t('quickPanel.hints.close') }
        ]}
      />
    </Modal>
  )
}
