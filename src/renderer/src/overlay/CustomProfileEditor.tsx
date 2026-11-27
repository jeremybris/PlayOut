import type {
  PowerProfileConfig,
  PowerProfileId,
  WattsBackendStatus,
  WindowsPowerMode
} from '@shared/overlay'
import { Cpu, Flame, Gauge, Rocket, Zap } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { SelectField, type SelectOption } from '../components/SelectField'
import { Slider } from '../components/Slider'
import { Toggle } from '../components/Toggle'
import { useT, type Translate } from '../i18n'
import { useSettingsStore } from '../state/settings'
import {
  fitWatts,
  formatWatts,
  setBoostWatts,
  setSustainedWatts,
  wattsRange,
  withWatts
} from './text'

/** Windows' power modes, labelled in the current language (built per render, never kept). */
function powerModes(t: Translate): SelectOption<WindowsPowerMode>[] {
  return [
    { value: 'efficiency', label: t('overlay.custom.modes.efficiency') },
    { value: 'balanced', label: t('overlay.custom.modes.balanced') },
    { value: 'performance', label: t('overlay.custom.modes.performance') }
  ]
}

export interface CustomProfileEditorProps {
  config: PowerProfileConfig
  profiles: Record<PowerProfileId, PowerProfileConfig>
  /** The power helper when it is ready and wanted: the watts controls show only then. */
  watts?: WattsBackendStatus
}

/**
 * The Custom profile's settings (settings.performance.profiles.custom): Windows power mode, CPU maximum, CPU boost
 * and, with the power helper, sustained and boost watts. Sliders keep a local draft and save when they settle.
 * Saving is all: the main process re-applies the profile in effect when its settings change (applying it from here
 * would make it a manual pick and stop the 'Outside games' default from being followed).
 */
export function CustomProfileEditor({
  config,
  profiles,
  watts
}: CustomProfileEditorProps): ReactElement {
  const update = useSettingsStore((s) => s.update)
  const t = useT()
  const [draft, setDraft] = useState(config)
  // A change saved elsewhere (Settings, the other window) replaces the draft.
  const [seen, setSeen] = useState(config)
  if (seen !== config) {
    setSeen(config)
    setDraft(config)
  }

  const save = (edited: PowerProfileConfig): void => {
    // Never more than the settings accept (200 W), or the whole save is rejected.
    const next = fitWatts(edited)
    setDraft(next)
    void update({ performance: { profiles: { ...profiles, custom: next } } })
  }
  const range = wattsRange(watts)
  const hasWatts = draft.watts !== null

  return (
    <div className="ov-editor" aria-label={t('overlay.custom.label')}>
      <SelectField
        focusKey="overlay:custom:mode"
        icon={<Gauge />}
        label={t('overlay.custom.powerMode')}
        value={draft.powerMode}
        options={powerModes(t)}
        onChange={(powerMode) => save({ ...draft, powerMode })}
      />
      <Slider
        className="ov-slider"
        focusKey="overlay:custom:cpuMax"
        icon={<Cpu />}
        label={t('overlay.custom.cpuMax')}
        value={draft.cpuMaxPercent}
        min={5}
        max={100}
        step={5}
        onChange={(cpuMaxPercent) => setDraft({ ...draft, cpuMaxPercent })}
        onCommit={(cpuMaxPercent) => save({ ...draft, cpuMaxPercent })}
      />
      <Toggle
        focusKey="overlay:custom:boost"
        icon={<Rocket />}
        label={t('overlay.custom.cpuBoost.label')}
        description={t('overlay.custom.cpuBoost.description')}
        checked={draft.cpuBoost}
        onChange={(cpuBoost) => save({ ...draft, cpuBoost })}
      />
      {watts ? (
        <>
          <Toggle
            focusKey="overlay:custom:watts"
            icon={<Zap />}
            label={t('overlay.custom.setWatts.label')}
            description={t('overlay.custom.setWatts.description')}
            checked={hasWatts}
            onChange={(on) => save(withWatts(draft, on, range))}
          />
          {hasWatts ? (
            <>
              <Slider
                className="ov-slider"
                focusKey="overlay:custom:sustained"
                icon={<Zap />}
                label={t('overlay.custom.sustained')}
                value={draft.watts ?? range.min}
                min={range.min}
                max={range.max}
                formatValue={formatWatts}
                onChange={(w) => setDraft(setSustainedWatts(draft, w))}
                onCommit={(w) => save(setSustainedWatts(draft, w))}
              />
              <Slider
                className="ov-slider"
                focusKey="overlay:custom:boostWatts"
                icon={<Flame />}
                label={t('overlay.custom.boost')}
                value={draft.boostWatts ?? draft.watts ?? range.min}
                min={range.min}
                max={range.max}
                formatValue={formatWatts}
                onChange={(w) => setDraft(setBoostWatts(draft, w))}
                onCommit={(w) => save(setBoostWatts(draft, w))}
              />
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
