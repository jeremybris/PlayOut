import { Battery, BatteryCharging, Cpu, Gauge, MemoryStick, Monitor, Zap } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { useT, type Translate } from '../i18n'
import { formatMegabytes, formatPercent } from '../lib/format'
import { useSystemStore } from '../state/system'
import { ExtrasTiles } from './ExtrasTiles'
import { OptionDrawer } from './OptionDrawer'
import { useOverlayStore, type TileFilter } from './overlayStore'
import { FilterChip, OverlayGroup, QuickTile } from './parts'
import { BrightnessControl, VolumeControl } from './SystemControls'
import {
  formatHz,
  formatResolution,
  memoryPercent,
  refreshOptions,
  resolutionOptions,
  sameMode
} from './text'
import { usePolling } from './usePolling'

/** The filter chips, labelled in the current language (built per render, never kept). */
function filters(t: Translate): { id: TileFilter; label: string }[] {
  return [
    { id: 'all', label: t('overlay.quick.filters.all') },
    { id: 'display', label: t('overlay.quick.filters.display') },
    { id: 'game', label: t('overlay.quick.filters.game') },
    { id: 'sound', label: t('overlay.quick.filters.sound') },
    { id: 'system', label: t('overlay.quick.filters.system') }
  ]
}

const PERF_INTERVAL_MS = 2000

/** The Performance tab's filter chips and the tiles they show. */
export function QuickTiles({ active }: { active: boolean }): ReactElement {
  const filter = useOverlayStore((s) => s.filter)
  const setFilter = useOverlayStore((s) => s.setFilter)
  const t = useT()
  const show = (group: Exclude<TileFilter, 'all'>): boolean => filter === 'all' || filter === group
  return (
    <OverlayGroup title={t('overlay.quick.title')}>
      <div className="ov-chips" role="toolbar" aria-label={t('overlay.quick.show')}>
        {filters(t).map((f) => (
          <FilterChip
            key={f.id}
            focusKey={`overlay:filter:${f.id}`}
            label={f.label}
            selected={filter === f.id}
            onPress={() => setFilter(f.id)}
          />
        ))}
      </div>
      {show('display') ? <DisplayTiles /> : null}
      {show('game') ? <ExtrasTiles /> : null}
      {show('sound') ? <VolumeControl focusKey="overlay:tile:volume" /> : null}
      {show('system') ? <SystemTiles polling={active} /> : null}
    </OverlayGroup>
  )
}

/** Brightness, then the refresh rate and resolution tiles that open a drawer of the monitor's modes. */
function DisplayTiles(): ReactElement {
  const display = useOverlayStore((s) => s.display)
  const setDisplayMode = useOverlayStore((s) => s.setDisplayMode)
  const [drawer, setDrawer] = useState<'hz' | 'resolution' | null>(null)
  const t = useT()

  const current = display?.current
  const modes =
    current && display
      ? drawer === 'hz'
        ? refreshOptions(display.modes, current)
        : resolutionOptions(display.modes, current)
      : []

  return (
    <>
      <BrightnessControl focusKey="overlay:tile:brightness" />
      {current ? (
        <div className="ov-tiles">
          <QuickTile
            focusKey="overlay:tile:hz"
            icon={<Gauge />}
            label={t('overlay.display.refreshRate')}
            value={formatHz(current.hz)}
            onPress={() => setDrawer('hz')}
          />
          <QuickTile
            focusKey="overlay:tile:resolution"
            icon={<Monitor />}
            label={t('overlay.display.resolution')}
            value={formatResolution(current)}
            onPress={() => setDrawer('resolution')}
          />
        </div>
      ) : null}
      {drawer && current ? (
        <OptionDrawer
          focusKey={`overlay:drawer:${drawer}`}
          title={
            drawer === 'hz' ? t('overlay.display.refreshRate') : t('overlay.display.resolution')
          }
          options={modes.map((mode, i) => ({
            key: String(i),
            label: drawer === 'hz' ? formatHz(mode.hz) : formatResolution(mode),
            selected:
              drawer === 'hz'
                ? Math.round(mode.hz) === Math.round(current.hz)
                : mode.width === current.width && mode.height === current.height
          }))}
          onSelect={(key) => {
            const mode = modes[Number(key)]
            if (mode && !sameMode(mode, current)) void setDisplayMode(mode)
          }}
          onClose={() => setDrawer(null)}
        />
      ) : null}
    </>
  )
}

/** CPU, GPU and memory use (polled while shown) and the battery. */
function SystemTiles({ polling }: { polling: boolean }): ReactElement {
  const perf = useSystemStore((s) => s.perf)
  const refreshPerf = useSystemStore((s) => s.refreshPerf)
  const battery = useSystemStore((s) => s.status?.battery ?? null)
  usePolling(refreshPerf, PERF_INTERVAL_MS, polling)
  const t = useT()

  const memory = memoryPercent(perf)
  return (
    <div className="ov-tiles">
      <QuickTile
        focusKey="overlay:tile:cpu"
        icon={<Cpu />}
        label={t('overlay.quick.cpu')}
        value={formatPercent(perf?.cpuPercent)}
        meter={perf?.cpuPercent}
      />
      {perf?.gpuPercent !== null && perf?.gpuPercent !== undefined ? (
        <QuickTile
          focusKey="overlay:tile:gpu"
          icon={<Gauge />}
          label={t('overlay.quick.gpu')}
          value={formatPercent(perf.gpuPercent)}
          meter={perf.gpuPercent}
        />
      ) : null}
      <QuickTile
        focusKey="overlay:tile:ram"
        icon={<MemoryStick />}
        label={t('overlay.quick.memory')}
        value={formatPercent(memory)}
        detail={
          perf?.memoryUsedMb !== null && perf?.memoryUsedMb !== undefined
            ? t('overlay.quick.memoryDetail', {
                used: formatMegabytes(perf.memoryUsedMb),
                total: formatMegabytes(perf.memoryTotalMb)
              })
            : undefined
        }
        meter={memory}
      />
      <QuickTile
        focusKey="overlay:tile:battery"
        icon={!battery?.present ? <Zap /> : battery.charging ? <BatteryCharging /> : <Battery />}
        label={t('overlay.quick.battery')}
        value={battery?.present ? `${Math.round(battery.percent)}%` : t('overlay.quick.pluggedIn')}
        detail={
          battery?.present
            ? battery.charging
              ? t('overlay.quick.charging')
              : t('overlay.quick.onBattery')
            : undefined
        }
        meter={battery?.present ? battery.percent : undefined}
      />
    </div>
  )
}
