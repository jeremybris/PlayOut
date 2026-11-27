import type { ReactElement } from 'react'
import { DownloadQueueList } from '../components/DownloadQueueList'
import { useT } from '../i18n'
import { GameActions } from './GameActions'
import { isIngameOverlay } from './ingame'
import { LocalMusic } from './LocalMusic'
import { OverlayGroup } from './parts'
import { NowPlaying } from './NowPlaying'
import { ProfileSection } from './ProfileSection'
import { QuickTiles } from './QuickTiles'
import { railKey } from './shared'

/** Performance tab: the game actions, the power profiles and the quick tiles. */
export function PerformanceTab({ active }: { active: boolean }): ReactElement {
  return (
    <>
      <GameActions focusKey="overlay:game" />
      <ProfileSection />
      <QuickTiles active={active} />
    </>
  )
}

/**
 * Downloads tab: PlayOut's install queue (one game downloads at a time, whatever the store), the active download's
 * progress first. Focus falls back to the rail entry when the list empties under it.
 */
export function DownloadsTab(): ReactElement {
  const t = useT()
  return (
    <OverlayGroup title={t('overlay.downloads.title')}>
      <DownloadQueueList focusKey="overlay:downloads" fallbackFocusKey={railKey('downloads')} />
    </OverlayGroup>
  )
}

/**
 * Music tab: what Windows is playing, then the local player. `active`: polled only while shown and open. The in-game
 * overlay has no local player (the window overlay's page plays the music folder and keeps playing): Windows' media
 * controls only.
 */
export function MusicTab({ active }: { active: boolean }): ReactElement {
  const t = useT()
  return (
    <>
      <NowPlaying active={active} />
      {isIngameOverlay() ? (
        <p className="ov-hint">{t('overlay.music.ingameHint')}</p>
      ) : (
        <LocalMusic />
      )}
    </>
  )
}
