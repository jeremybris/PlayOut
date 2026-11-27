import { DYNAMIC_FPS, DYNAMIC_FPS_PRESETS, type DynamicTdpStatus } from '@shared/overlay'
import { Activity, Target } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { Slider } from '../components/Slider'
import { useT } from '../i18n'
import { FilterChip } from './parts'
import { clampTargetFps, dynamicReadout, formatFps } from './text'

export interface DynamicTdpControlsProps {
  /** The target in effect. */
  targetFps: number
  /** The live readout (PerformanceStatus.dynamic). */
  status: DynamicTdpStatus | undefined
  /** A new target: the caller keeps it as the game's own or as the Settings default. */
  onTarget(fps: number): void
}

/**
 * Dynamic TDP in the overlay: the live readout ('58 fps · 14 W'), the target presets as chips (one press with a
 * gamepad) and a slider for any other target from 20 to 240 fps.
 */
export function DynamicTdpControls({
  targetFps,
  status,
  onTarget
}: DynamicTdpControlsProps): ReactElement {
  const t = useT()
  const [draft, setDraft] = useState(targetFps)
  // A target changed elsewhere (Settings, the per-game switch) replaces the draft.
  const [seen, setSeen] = useState(targetFps)
  if (seen !== targetFps) {
    setSeen(targetFps)
    setDraft(targetFps)
  }
  const readout = dynamicReadout(status)

  return (
    <div className="ov-editor" aria-label={t('overlay.dynamic.label')}>
      {readout ? (
        <div className="ov-dynamic__readout" role="status" aria-live="polite">
          <Activity className="ov-dynamic__icon" />
          <span>{readout}</span>
        </div>
      ) : null}
      <div className="ov-chips" role="radiogroup" aria-label={t('overlay.dynamic.target')}>
        {DYNAMIC_FPS_PRESETS.map((fps) => (
          <FilterChip
            key={fps}
            focusKey={`overlay:dynamic:fps:${fps}`}
            label={formatFps(fps)}
            selected={targetFps === fps}
            onPress={() => onTarget(fps)}
          />
        ))}
      </div>
      <Slider
        className="ov-slider"
        focusKey="overlay:dynamic:target"
        icon={<Target />}
        label={t('overlay.dynamic.target')}
        value={draft}
        min={DYNAMIC_FPS.min}
        max={DYNAMIC_FPS.max}
        step={5}
        formatValue={formatFps}
        onChange={setDraft}
        onCommit={(v) => onTarget(clampTargetFps(v))}
      />
    </div>
  )
}
