import type { Game } from '@shared/types'
import type { MusicTrack } from '@shared/overlay'
import {
  FolderOpen,
  ListMinus,
  ListPlus,
  Pause,
  Play,
  Shuffle,
  SkipBack,
  SkipForward
} from 'lucide-react'
import { useCallback, useEffect, type ReactElement } from 'react'
import { api } from '../api/client'
import { Button } from '../components/Button'
import { IconButton } from '../components/IconButton'
import { MenuItem } from '../components/MenuItem'
import { Spinner } from '../components/Spinner'
import { useT } from '../i18n'
import { createLog } from '../lib/log'
import { displayTitle } from '../lib/library'
import { useLibraryStore } from '../state/library'
import { useSettingsStore } from '../state/settings'
import { useUiStore } from '../state/ui'
import { addToPlaylist, removeFromPlaylist, trackFor } from './music'
import { currentPath, useMusicPlayer } from './musicPlayer'
import { OverlayGroup } from './parts'
import { useRunningGameId } from './shared'

const log = createLog('overlay-local-music')

/** Rows drawn at most: every row is a focusable, and a folder of thousands would slow the focus engine down. */
const MAX_ROWS = 200

/** Local music: the folder's tracks, the player's controls and the running game's playlist. */
export function LocalMusic(): ReactElement {
  const folderSetting = useSettingsStore((s) => s.settings?.music.folder ?? null)
  const update = useSettingsStore((s) => s.update)
  const toast = useUiStore((s) => s.toast)
  const loadLibrary = useMusicPlayer((s) => s.loadLibrary)
  const loaded = useMusicPlayer((s) => s.loaded)
  const loading = useMusicPlayer((s) => s.loading)
  const t = useT()

  // A new folder (chosen here or in Settings) is listed again.
  useEffect(() => {
    if (folderSetting) void loadLibrary()
  }, [folderSetting, loadLibrary])

  const choose = useCallback(() => {
    api
      .chooseMusicFolder()
      .then((folder) => {
        if (folder) return update({ music: { folder } })
        return undefined
      })
      .catch((err) => {
        log.error('chooseMusicFolder failed', err)
        toast(t('overlay.music.chooseFailed'), 'error')
      })
  }, [t, toast, update])

  if (!folderSetting) {
    return (
      <OverlayGroup title={t('overlay.music.title')}>
        <p className="ov-hint">{t('overlay.music.intro')}</p>
        <Button focusKey="overlay:music:choose" icon={<FolderOpen />} onPress={choose}>
          {t('overlay.music.choose')}
        </Button>
      </OverlayGroup>
    )
  }
  return (
    <OverlayGroup
      title={t('overlay.music.title')}
      aside={loading ? <Spinner size="sm" /> : undefined}
    >
      <Transport />
      <GamePlaylist />
      {loaded ? <TrackList /> : null}
    </OverlayGroup>
  )
}

/** The current track and previous / play-pause / next / shuffle. */
function Transport(): ReactElement {
  const path = useMusicPlayer(currentPath)
  const byPath = useMusicPlayer((s) => s.byPath)
  const playing = useMusicPlayer((s) => s.playing)
  const shuffle = useMusicPlayer((s) => s.shuffle)
  const player = useMusicPlayer.getState
  const t = useT()
  const track = path ? trackFor(path, byPath) : null
  return (
    <div className="ov-local">
      <div className="ov-local__text">
        <span className="ov-local__title u-truncate">
          {track ? track.title : t('overlay.music.notPlaying')}
        </span>
        {track?.folder ? <span className="ov-local__folder u-truncate">{track.folder}</span> : null}
      </div>
      <div className="ov-transport ov-transport--sm">
        <IconButton
          focusKey="overlay:music:previous"
          size="sm"
          icon={<SkipBack />}
          aria-label={t('overlay.music.previous')}
          disabled={!track}
          onPress={() => player().previous()}
        />
        <IconButton
          focusKey="overlay:music:toggle"
          icon={playing ? <Pause /> : <Play />}
          aria-label={playing ? t('overlay.media.pause') : t('overlay.media.play')}
          onPress={() => player().toggle()}
        />
        <IconButton
          focusKey="overlay:music:next"
          size="sm"
          icon={<SkipForward />}
          aria-label={t('overlay.music.next')}
          disabled={!track}
          onPress={() => player().next()}
        />
        <IconButton
          focusKey="overlay:music:shuffle"
          size="sm"
          icon={<Shuffle />}
          aria-label={t('overlay.music.shuffle')}
          active={shuffle}
          onPress={() => player().setShuffle(!shuffle)}
        />
      </div>
    </div>
  )
}

/** The running PlayOut game, when there is one. */
function useRunningGame(): Game | undefined {
  const gameId = useRunningGameId()
  return useLibraryStore((s) => (gameId ? s.byId.get(gameId) : undefined))
}

/** Save the game's playlist and keep the overlay's copy of the game in step. */
function useSavePlaylist(): (game: Game, playlist: string[]) => void {
  const applyGame = useLibraryStore((s) => s.applyGame)
  const toast = useUiStore((s) => s.toast)
  const t = useT()
  return useCallback(
    (game, playlist) => {
      api
        .updateGame(game.id, { user: { playlist: playlist.length ? playlist : null } })
        .then(applyGame)
        .catch((err) => {
          log.error(`updateGame(${game.id}) playlist failed`, err)
          toast(t('overlay.music.saveFailed'), 'error')
        })
    },
    [applyGame, t, toast]
  )
}

/** "Play <game>'s playlist" with its track count. */
function GamePlaylist(): ReactElement | null {
  const game = useRunningGame()
  const t = useT()
  if (!game) return null
  const playlist = game.user.playlist ?? []
  const title = displayTitle(game)
  return (
    <div className="ov-playlist">
      <span className="ov-playlist__text u-truncate">
        {playlist.length
          ? t('overlay.music.playlist', { title, count: playlist.length })
          : t('overlay.music.noPlaylist', { title })}
      </span>
      {playlist.length ? (
        <Button
          focusKey="overlay:music:playlist"
          icon={<Play />}
          onPress={() => useMusicPlayer.getState().playQueue(playlist)}
        >
          {t('overlay.music.playPlaylist')}
        </Button>
      ) : null}
    </div>
  )
}

/** The folder's tracks: press one to play the folder from it; + / − add it to or remove it from the game's playlist. */
function TrackList(): ReactElement {
  const tracks = useMusicPlayer((s) => s.tracks)
  const path = useMusicPlayer(currentPath)
  const game = useRunningGame()
  const save = useSavePlaylist()
  const t = useT()

  if (tracks.length === 0) return <p className="ov-hint">{t('overlay.music.noFiles')}</p>
  const shown = tracks.slice(0, MAX_ROWS)
  const paths = tracks.map((t) => t.path)
  return (
    <div className="ov-tracks" role="list">
      {shown.map((track, i) => (
        <TrackRow
          key={track.path}
          track={track}
          playing={track.path === path}
          inPlaylist={!!game?.user.playlist?.includes(track.path)}
          onPlay={() => useMusicPlayer.getState().playQueue(paths, i)}
          onPlaylist={
            game
              ? (add) =>
                  save(
                    game,
                    add
                      ? addToPlaylist(game.user.playlist, track.path)
                      : removeFromPlaylist(game.user.playlist, track.path)
                  )
              : undefined
          }
        />
      ))}
      {tracks.length > MAX_ROWS ? (
        <p className="ov-hint">{t('overlay.music.more', { count: tracks.length - MAX_ROWS })}</p>
      ) : null}
    </div>
  )
}

function TrackRow({
  track,
  playing,
  inPlaylist,
  onPlay,
  onPlaylist
}: {
  track: MusicTrack
  playing: boolean
  inPlaylist: boolean
  onPlay: () => void
  onPlaylist?: (add: boolean) => void
}): ReactElement {
  const t = useT()
  return (
    <div className="ov-track" role="listitem">
      <MenuItem
        className="ov-track__main"
        focusKey={`overlay:track:${track.path}`}
        label={track.title}
        trailing={
          track.folder ? <span className="ov-track__folder">{track.folder}</span> : undefined
        }
        selected={playing}
        onPress={onPlay}
      />
      {onPlaylist ? (
        <IconButton
          focusKey={`overlay:track:${track.path}:playlist`}
          size="sm"
          variant="ghost"
          icon={inPlaylist ? <ListMinus /> : <ListPlus />}
          aria-label={
            inPlaylist ? t('overlay.music.removeFromPlaylist') : t('overlay.music.addToPlaylist')
          }
          active={inPlaylist}
          onPress={() => onPlaylist(!inPlaylist)}
        />
      ) : null}
    </div>
  )
}
