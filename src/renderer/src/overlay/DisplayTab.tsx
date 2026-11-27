import { Check } from 'lucide-react'
import type { ReactElement } from 'react'
import { Menu, MenuItem } from '../components/MenuItem'
import { useT } from '../i18n'
import { useOverlayStore } from './overlayStore'
import { OverlayGroup } from './parts'
import { BrightnessControl, VolumeControl } from './SystemControls'
import { formatHz, formatResolution, refreshOptions, resolutionOptions, sameMode } from './text'

/** Display tab: brightness and volume, then every refresh rate and resolution of the game's monitor. */
export function DisplayTab(): ReactElement {
  const display = useOverlayStore((s) => s.display)
  const unavailable = useOverlayStore((s) => s.displayUnavailable)
  const setDisplayMode = useOverlayStore((s) => s.setDisplayMode)
  const t = useT()
  const current = display?.current

  return (
    <>
      <OverlayGroup
        title={
          display?.name
            ? t('overlay.display.screenNamed', { name: display.name })
            : t('overlay.display.screen')
        }
      >
        <BrightnessControl focusKey="overlay:display:brightness" />
        <VolumeControl focusKey="overlay:display:volume" />
        {unavailable ? <p className="ov-hint">{t('overlay.display.cannotChange')}</p> : null}
      </OverlayGroup>
      {display && current ? (
        <>
          <OverlayGroup title={t('overlay.display.refreshRate')}>
            <Menu aria-label={t('overlay.display.refreshRate')}>
              {refreshOptions(display.modes, current).map((mode) => (
                <MenuItem
                  key={mode.hz}
                  focusKey={`overlay:display:hz:${Math.round(mode.hz)}`}
                  label={formatHz(mode.hz)}
                  selected={Math.round(mode.hz) === Math.round(current.hz)}
                  trailing={Math.round(mode.hz) === Math.round(current.hz) ? <Check /> : undefined}
                  onPress={() => {
                    if (!sameMode(mode, current)) void setDisplayMode(mode)
                  }}
                />
              ))}
            </Menu>
          </OverlayGroup>
          <OverlayGroup title={t('overlay.display.resolution')}>
            <Menu aria-label={t('overlay.display.resolution')}>
              {resolutionOptions(display.modes, current).map((mode) => {
                const on = mode.width === current.width && mode.height === current.height
                return (
                  <MenuItem
                    key={`${mode.width}x${mode.height}`}
                    focusKey={`overlay:display:res:${mode.width}x${mode.height}`}
                    label={formatResolution(mode)}
                    selected={on}
                    trailing={on ? <Check /> : undefined}
                    onPress={() => {
                      if (!on) void setDisplayMode(mode)
                    }}
                  />
                )
              })}
            </Menu>
          </OverlayGroup>
        </>
      ) : null}
    </>
  )
}
