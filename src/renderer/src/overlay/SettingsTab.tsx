import {
  Gamepad2,
  Gauge,
  Home,
  ListMusic,
  Music,
  Sparkles,
  Target,
  VolumeX,
  Zap
} from 'lucide-react'
import type { ReactElement } from 'react'
import { api } from '../api/client'
import { Button } from '../components/Button'
import { SelectField } from '../components/SelectField'
import { Slider } from '../components/Slider'
import { Toggle } from '../components/Toggle'
import { useT } from '../i18n'
import { useSettingsStore } from '../state/settings'
import { defaultProfileOptions, GAME_START_OPTIONS, targetFpsOptions } from './options'
import { useOverlayStore } from './overlayStore'
import { OverlayGroup } from './parts'
import { dynamicAvailable, effectiveDefaultProfile } from './text'

/** Settings tab: the overlay's own settings; everything else is in PlayOut's Settings. */
export function SettingsTab(): ReactElement | null {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const helper = useOverlayStore((s) => s.performance?.helper)
  const t = useT()
  if (!settings) return null
  const { performance, music, ui } = settings
  const dynamic = dynamicAvailable(helper)
  const targetFps = performance.dynamic.targetFps

  return (
    <>
      <OverlayGroup title={t('overlay.settings.power')}>
        <SelectField
          focusKey="overlay:settings:defaultProfile"
          icon={<Gauge />}
          label={t('overlay.settings.outsideGames')}
          value={effectiveDefaultProfile(performance.defaultProfile, helper)}
          options={defaultProfileOptions(helper)}
          onChange={(defaultProfile) => void update({ performance: { defaultProfile } })}
        />
        {dynamic ? (
          <SelectField
            focusKey="overlay:settings:targetFps"
            icon={<Target />}
            label={t('overlay.settings.dynamicTarget')}
            value={String(targetFps)}
            options={targetFpsOptions(targetFps)}
            onChange={(v) =>
              void update({
                performance: { dynamic: { ...performance.dynamic, targetFps: Number(v) } }
              })
            }
          />
        ) : null}
        <Toggle
          focusKey="overlay:settings:perGame"
          icon={<Gamepad2 />}
          label={t('overlay.settings.perGame')}
          checked={performance.perGame}
          onChange={(perGame) => void update({ performance: { perGame } })}
        />
        <Toggle
          focusKey="overlay:settings:useWatts"
          icon={<Zap />}
          label={t('overlay.settings.setWatts.label')}
          description={t('overlay.settings.setWatts.description')}
          checked={performance.useWatts}
          onChange={(useWatts) => void update({ performance: { useWatts } })}
        />
      </OverlayGroup>
      <OverlayGroup title={t('overlay.settings.music')}>
        <SelectField
          focusKey="overlay:settings:gameStart"
          icon={<ListMusic />}
          label={t('overlay.settings.gameStart')}
          value={music.gameStart}
          options={GAME_START_OPTIONS}
          onChange={(gameStart) => void update({ music: { gameStart } })}
        />
        <Slider
          className="ov-slider"
          focusKey="overlay:settings:musicVolume"
          icon={<Music />}
          label={t('overlay.settings.musicVolume')}
          value={Math.round(music.volume * 100)}
          step={5}
          formatValue={(v) => (music.muted ? t('overlay.system.muted') : `${Math.round(v)}%`)}
          // Moving the volume unmutes the music, as the system volume does.
          onChange={(v) => void update({ music: { volume: v / 100, muted: false } })}
        />
        {/* Just below the volume, so a controller reaches it with down (left / right move the slider). */}
        <Toggle
          className="ov-mute"
          focusKey="overlay:settings:musicMute"
          icon={<VolumeX />}
          label={t('overlay.settings.mute')}
          checked={music.muted}
          onChange={(muted) => void update({ music: { muted } })}
        />
      </OverlayGroup>
      <OverlayGroup title={t('overlay.settings.look')}>
        <Toggle
          focusKey="overlay:settings:animations"
          icon={<Sparkles />}
          label={t('overlay.settings.animations')}
          checked={ui.animations}
          onChange={(animations) => void update({ ui: { animations } })}
        />
      </OverlayGroup>
      <p className="ov-hint">{t('overlay.settings.hint')}</p>
      <Button
        focusKey="overlay:settings:playout"
        icon={<Home />}
        onPress={() => void api.showPlayOut()}
      >
        {t('overlay.settings.openPlayOut')}
      </Button>
    </>
  )
}
