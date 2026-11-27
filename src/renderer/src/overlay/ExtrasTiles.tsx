import { BatteryCharging, Layers, RefreshCw, Rocket, SunMedium, Timer } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { PERF_OVERLAY_LEVELS, type PerfOverlayLevel } from '@shared/overlay-extras'
import { useT } from '../i18n'
import { OptionDrawer } from './OptionDrawer'
import { useOverlayStore } from './overlayStore'
import { QuickTile } from './parts'
import { usePolling } from './usePolling'
import {
  cpuBoostDetail,
  enduranceDetail,
  enduranceValue,
  formatFrameLimit,
  frameLimitDetail,
  perfOverlayDetail,
  perfOverlayLabel,
  syncDetail
} from './text'

/** While the Game tiles' state could not be read: how often it is asked again, ms. */
const EXTRAS_RETRY_MS = 3_000

/**
 * The Game group's tiles (docs/home-overlay.md, "Overlay extras"): the frame rate limit and "Sync FPS + refresh"
 * (RivaTuner's per-game profile), the performance overlay RivaTuner draws, Windows' Auto HDR and the CPU boost of the
 * profile in effect, and Intel's Endurance Gaming when the Intel graphics driver offers it. A tile that cannot act now is dimmed and says why in its detail line.
 */
export function ExtrasTiles(): ReactElement {
  const extras = useOverlayStore((s) => s.extras)
  const setFrameLimit = useOverlayStore((s) => s.setFrameLimit)
  const setFrameLimitSync = useOverlayStore((s) => s.setFrameLimitSync)
  const setPerfOverlayLevel = useOverlayStore((s) => s.setPerfOverlayLevel)
  const setAutoHdr = useOverlayStore((s) => s.setAutoHdr)
  const setCpuBoost = useOverlayStore((s) => s.setCpuBoost)
  const endurance = useOverlayStore((s) => s.intel?.enduranceGaming)
  const setEnduranceGaming = useOverlayStore((s) => s.setEnduranceGaming)
  const extrasUnavailable = useOverlayStore((s) => s.extrasUnavailable)
  const refreshExtras = useOverlayStore((s) => s.refreshExtras)
  const open = useOverlayStore((s) => s.open)
  const [drawer, setDrawer] = useState<'fpsLimit' | 'perfOverlay' | 'endurance' | null>(null)
  const t = useT()
  const onOff = (on: boolean): string => (on ? t('overlay.on') : t('overlay.off'))

  // Not read yet (or the read failed): asked again every few seconds while the group shows.
  usePolling(refreshExtras, EXTRAS_RETRY_MS, open && extras === null)

  // A drawer whose tile just became unavailable (the game exited, RivaTuner stopped) closes: it would offer a choice
  // the tile says cannot be made.
  const canOpen = {
    fpsLimit: !!extras?.rtssTiles && !!extras.frameLimit.available,
    perfOverlay: !!extras?.osdTile && !!extras.perfOverlay.available,
    endurance:
      !!endurance && !endurance.absent && endurance.supported && endurance.options.length > 0
  }
  const shown = drawer && canOpen[drawer] ? drawer : null
  // Reset while rendering (React re-renders at once), so it does not open again when the tile comes back.
  if (drawer && !shown) setDrawer(null)

  if (!extras)
    return (
      <div className="ov-hint">
        {extrasUnavailable ? t('overlay.extras.unavailable') : t('overlay.extras.checking')}
      </div>
    )

  const { frameLimit, sync, perfOverlay, autoHdr, cpuBoost } = extras
  // The RivaTuner tiles are offered only after their in-game check (shared/overlay-extras.ts RTSS_TILES_VERIFIED for
  // the frame limit and sync, RTSS_OSD_VERIFIED for the performance overlay).
  const rtssTiles = extras.rtssTiles
  return (
    <>
      <div className="ov-tiles ov-tiles--wrap">
        {rtssTiles ? (
          <>
            <QuickTile
              focusKey="overlay:tile:fpsLimit"
              icon={<Timer />}
              label={t('overlay.extras.frameLimit.label')}
              value={formatFrameLimit(frameLimit.fps)}
              detail={frameLimitDetail(extras)}
              disabled={!frameLimit.available}
              onPress={() => setDrawer('fpsLimit')}
            />
            <QuickTile
              focusKey="overlay:tile:fpsSync"
              icon={<RefreshCw />}
              label={t('overlay.extras.sync.label')}
              value={onOff(sync.enabled)}
              detail={syncDetail(sync)}
              toggled={sync.enabled}
              disabled={!sync.available}
              onPress={() => void setFrameLimitSync(!sync.enabled)}
            />
          </>
        ) : null}
        {extras.osdTile ? (
          <>
            <QuickTile
              focusKey="overlay:tile:perfOverlay"
              icon={<Layers />}
              label={t('overlay.extras.perfOverlay.label')}
              value={perfOverlayLabel(perfOverlay.level)}
              detail={
                !perfOverlay.available
                  ? perfOverlay.reason
                  : perfOverlay.drawing
                    ? t('overlay.extras.perfOverlay.showing')
                    : perfOverlay.level > 0
                      ? t('overlay.extras.perfOverlay.showsInGames')
                      : t('overlay.extras.perfOverlay.drawnBy')
              }
              disabled={!perfOverlay.available}
              onPress={() => setDrawer('perfOverlay')}
            />
          </>
        ) : null}
        <QuickTile
          focusKey="overlay:tile:autoHdr"
          icon={<SunMedium />}
          label={t('overlay.extras.autoHdr.label')}
          value={onOff(autoHdr.enabled === true)}
          detail={autoHdr.available ? autoHdr.note : autoHdr.reason}
          toggled={autoHdr.enabled === true}
          disabled={!autoHdr.available}
          onPress={() => void setAutoHdr(autoHdr.enabled !== true)}
        />
        <QuickTile
          focusKey="overlay:tile:cpuBoost"
          icon={<Rocket />}
          label={t('overlay.extras.cpuBoost.label')}
          value={onOff(cpuBoost.enabled)}
          detail={cpuBoostDetail(cpuBoost)}
          toggled={cpuBoost.enabled}
          disabled={!cpuBoost.available}
          onPress={() => void setCpuBoost(!cpuBoost.enabled)}
        />
        {endurance && !endurance.absent ? (
          <QuickTile
            focusKey="overlay:tile:endurance"
            icon={<BatteryCharging />}
            label={t('overlay.extras.endurance.label')}
            value={enduranceValue(endurance)}
            detail={enduranceDetail(endurance)}
            disabled={!endurance.supported || endurance.options.length === 0}
            onPress={() => setDrawer('endurance')}
          />
        ) : null}
      </div>
      {extras.clash ? <p className="ov-clash">{extras.clash}</p> : null}
      {shown === 'fpsLimit' ? (
        <OptionDrawer
          focusKey="overlay:drawer:fpsLimit"
          title={t('overlay.extras.frameLimit.label')}
          options={frameLimit.options.map((fps) => ({
            key: String(fps),
            label: formatFrameLimit(fps),
            detail:
              fps === 0
                ? t('overlay.extras.frameLimit.unlimited')
                : sync.enabled && fps === frameLimit.fps
                  ? t('overlay.extras.frameLimit.nowFollows')
                  : undefined,
            // While synced nothing is checked: any pick (even the display's rate) is an explicit choice that turns
            // sync off and sticks for this game.
            selected: !sync.enabled && fps === frameLimit.fps
          }))}
          onSelect={(key) => void setFrameLimit(Number(key))}
          onClose={() => setDrawer(null)}
        />
      ) : null}
      {shown === 'perfOverlay' ? (
        <OptionDrawer
          focusKey="overlay:drawer:perfOverlay"
          title={t('overlay.extras.perfOverlay.label')}
          options={PERF_OVERLAY_LEVELS.map((level) => ({
            key: String(level),
            label: perfOverlayLabel(level),
            detail: perfOverlayDetail(level),
            selected: level === perfOverlay.level
          }))}
          onSelect={(key) => void setPerfOverlayLevel(Number(key) as PerfOverlayLevel)}
          onClose={() => setDrawer(null)}
        />
      ) : null}
      {shown === 'endurance' && endurance ? (
        <OptionDrawer
          focusKey="overlay:drawer:endurance"
          title={t('overlay.extras.endurance.label')}
          options={endurance.options.map((o) => ({
            key: o.key,
            label: o.label,
            selected: o.key === endurance.value
          }))}
          onSelect={(key) => void setEnduranceGaming(key)}
          onClose={() => setDrawer(null)}
        />
      ) : null}
    </>
  )
}
