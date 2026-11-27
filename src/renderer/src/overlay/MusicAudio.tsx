import { useEffect, useRef, type ReactElement } from 'react'
import { t } from '../i18n'
import { createLog } from '../lib/log'
import { useSettingsStore } from '../state/settings'
import { useUiStore } from '../state/ui'
import { audioVolume, trackUrl } from './music'
import { currentPath, useMusicPlayer } from './musicPlayer'

const log = createLog('overlay-audio')

/**
 * The one <audio> element of the local player. Mounted at the overlay app's root (never inside a tab), so it keeps
 * playing while the overlay is closed or another tab is shown.
 */
export function MusicAudio(): ReactElement {
  const ref = useRef<HTMLAudioElement | null>(null)
  const path = useMusicPlayer(currentPath)
  const playing = useMusicPlayer((s) => s.playing)
  const volume = useSettingsStore((s) => s.settings?.music.volume ?? 0.6)
  const muted = useSettingsStore((s) => s.settings?.music.muted ?? false)

  useEffect(() => {
    const audio = ref.current
    if (!audio) return
    if (!path) {
      audio.removeAttribute('src')
      audio.load()
      return
    }
    audio.src = trackUrl(path)
  }, [path])

  useEffect(() => {
    const audio = ref.current
    if (!audio || !path) return
    if (playing) {
      audio.play().catch((err: unknown) => {
        // A pause() racing the load rejects play() with AbortError: not a failure.
        if (err instanceof DOMException && err.name === 'AbortError') return
        log.error(`could not play ${path}`, err)
        useMusicPlayer.getState().setPlaying(false)
      })
    } else {
      audio.pause()
    }
  }, [path, playing])

  useEffect(() => {
    if (ref.current) ref.current.volume = audioVolume(volume)
  }, [volume])

  useEffect(() => {
    if (ref.current) ref.current.muted = muted
  }, [muted])

  return (
    <audio
      ref={ref}
      preload="auto"
      onEnded={() => {
        const player = useMusicPlayer.getState()
        const before = currentPath(player)
        player.next()
        // A one-track queue stays on the same path, so the effects above do not run again: start it over here.
        const audio = ref.current
        if (audio && before && currentPath(useMusicPlayer.getState()) === before) {
          audio.currentTime = 0
          audio.play().catch((err: unknown) => log.error(`could not replay ${before}`, err))
        }
      }}
      onError={() => {
        if (!path) return
        log.warn(`track failed to load: ${path}`)
        useUiStore.getState().toast(t('overlay.music.playFailed'), 'error')
        useMusicPlayer.getState().setPlaying(false)
      }}
    />
  )
}
