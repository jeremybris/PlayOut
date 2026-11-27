import { Sun, Volume2, VolumeX } from 'lucide-react'
import { useCallback, type ReactElement } from 'react'
import { api } from '../api/client'
import { Slider } from '../components/Slider'
import { Toggle } from '../components/Toggle'
import { useT } from '../i18n'
import { createLog } from '../lib/log'
import { useSystemStore } from '../state/system'
import { useUiStore } from '../state/ui'

const log = createLog('overlay-system')

/**
 * Volume slider with its Mute switch just below it (a controller reaches it with down: left / right move the slider),
 * the same behaviour as the Quick panel's: the slider moves at once (local patch), Windows is told when the value
 * settles; moving it unmutes.
 */
export function VolumeControl({ focusKey }: { focusKey: string }): ReactElement | null {
  const volume = useSystemStore((s) => s.status?.volume ?? null)
  const patchStatus = useSystemStore((s) => s.patchStatus)
  const toast = useUiStore((s) => s.toast)
  const t = useT()

  const commit = useCallback(
    (level: number) => {
      const calls = [api.setVolume(level)]
      if (volume?.muted) calls.push(api.setMuted(false))
      Promise.all(calls).catch((err) => {
        log.error('setVolume failed', err)
        toast(t('overlay.system.volumeFailed'), 'error')
      })
    },
    [t, toast, volume?.muted]
  )
  const setMute = useCallback(
    (muted: boolean) => {
      if (!volume || muted === volume.muted) return
      patchStatus({ volume: { ...volume, muted } })
      api.setMuted(muted).catch((err) => {
        log.error('setMuted failed', err)
        toast(muted ? t('overlay.system.muteFailed') : t('overlay.system.unmuteFailed'), 'error')
      })
    },
    [patchStatus, t, toast, volume]
  )

  if (!volume) return null
  return (
    <div className="ov-slider-row">
      <Slider
        className="ov-slider"
        focusKey={focusKey}
        icon={volume.muted ? <VolumeX /> : <Volume2 />}
        label={t('overlay.system.volume')}
        value={volume.level}
        onChange={(level) => patchStatus({ volume: { level, muted: false } })}
        onCommit={commit}
        formatValue={(v) => (volume.muted ? t('overlay.system.muted') : `${Math.round(v)}%`)}
      />
      <Toggle
        className="ov-mute"
        focusKey={`${focusKey}:mute`}
        icon={<VolumeX />}
        label={t('overlay.system.mute')}
        checked={volume.muted}
        onChange={setMute}
      />
    </div>
  )
}

/** Brightness slider; nothing when the screen's brightness cannot be set (an external monitor). */
export function BrightnessControl({ focusKey }: { focusKey: string }): ReactElement | null {
  const brightness = useSystemStore((s) => s.status?.brightness ?? null)
  const patchStatus = useSystemStore((s) => s.patchStatus)
  const toast = useUiStore((s) => s.toast)
  const t = useT()
  const commit = useCallback(
    (percent: number) => {
      api.setBrightness(percent).catch((err) => {
        log.error('setBrightness failed', err)
        toast(t('overlay.system.brightnessFailed'), 'error')
      })
    },
    [t, toast]
  )
  if (brightness === null) return null
  return (
    <Slider
      className="ov-slider"
      focusKey={focusKey}
      icon={<Sun />}
      label={t('overlay.system.brightness')}
      value={brightness}
      onChange={(percent) => patchStatus({ brightness: percent })}
      onCommit={commit}
    />
  )
}
