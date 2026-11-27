import type { MediaAction, MediaSession } from '@shared/overlay'
import { Music2, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { useCallback, useState, type ReactElement } from 'react'
import { api } from '../api/client'
import { IconButton } from '../components/IconButton'
import { useT } from '../i18n'
import { createLog } from '../lib/log'
import { useUiStore } from '../state/ui'
import { OverlayGroup } from './parts'
import { appName } from './text'
import { usePolling } from './usePolling'

const log = createLog('overlay-media')
const MEDIA_INTERVAL_MS = 2000

/**
 * What Windows is playing (any app), read every 2 s while the Music tab is shown and the overlay open, with
 * previous / play-pause / next.
 */
export function NowPlaying({ active }: { active: boolean }): ReactElement {
  const [session, setSession] = useState<MediaSession | null>(null)
  const [loaded, setLoaded] = useState(false)
  const toast = useUiStore((s) => s.toast)
  const t = useT()

  const refresh = useCallback(async () => {
    try {
      setSession(await api.getMediaSession())
    } catch (err) {
      log.error('getMediaSession failed', err)
      setSession(null)
    } finally {
      setLoaded(true)
    }
  }, [])
  usePolling(refresh, MEDIA_INTERVAL_MS, active)

  const control = (action: MediaAction): void => {
    api
      .mediaControl(action)
      .then((next) => setSession(next))
      .catch((err) => {
        log.error(`mediaControl(${action}) failed`, err)
        toast(t('overlay.media.noAnswer'), 'error')
      })
  }

  const playing = session?.status === 'playing'
  return (
    <OverlayGroup title={t('overlay.media.title')}>
      <div className="ov-now">
        <div className="ov-now__art">
          {session?.art ? <img src={session.art} alt="" /> : <Music2 aria-hidden="true" />}
        </div>
        <div className="ov-now__text">
          <span className="ov-now__title u-truncate">
            {session
              ? session.title || t('overlay.media.unknownTitle')
              : loaded
                ? t('overlay.media.nothing')
                : '…'}
          </span>
          {session ? (
            <>
              <span className="ov-now__artist u-truncate">
                {[session.artist, session.album].filter(Boolean).join(' · ')}
              </span>
              <span className="ov-now__app u-truncate">{appName(session.app)}</span>
            </>
          ) : (
            <span className="ov-now__artist">{t('overlay.media.anyApp')}</span>
          )}
        </div>
      </div>
      {session ? (
        <div className="ov-transport">
          <IconButton
            focusKey="overlay:media:previous"
            icon={<SkipBack />}
            aria-label={t('overlay.media.previous')}
            disabled={!session.canPrevious}
            onPress={() => control('previous')}
          />
          <IconButton
            focusKey="overlay:media:toggle"
            size="lg"
            icon={playing ? <Pause /> : <Play />}
            aria-label={playing ? t('overlay.media.pause') : t('overlay.media.play')}
            onPress={() => control('toggle')}
          />
          <IconButton
            focusKey="overlay:media:next"
            icon={<SkipForward />}
            aria-label={t('overlay.media.next')}
            disabled={!session.canNext}
            onPress={() => control('next')}
          />
        </div>
      ) : null}
    </OverlayGroup>
  )
}
