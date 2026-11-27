import type { MusicTrack } from '@shared/overlay'
import { create } from 'zustand'
import { api } from '../api/client'
import { createLog } from '../lib/log'
import { currentSettings } from '../state/settings'
import { gameStartAction, nextIndex, previousIndex } from './music'

const log = createLog('overlay-music')

/**
 * The overlay's local music player (docs/home-overlay.md "Local music"). The queue lives here and the <audio>
 * element in MusicAudio.tsx follows it, so music keeps playing while the overlay window is hidden (its renderer
 * stays alive) and while the user switches tabs.
 */
export interface MusicPlayerState {
  folder: string | null
  tracks: MusicTrack[]
  byPath: Map<string, MusicTrack>
  loaded: boolean
  loading: boolean
  /** Paths relative to the music folder. */
  queue: string[]
  /** The current track's index in `queue`; -1 = nothing loaded. */
  index: number
  playing: boolean
  shuffle: boolean
  loadLibrary(): Promise<void>
  /** Replace the queue and start at `start` (playing, or paused when `autoplay` is false). */
  playQueue(paths: string[], start?: number, autoplay?: boolean): void
  toggle(): void
  setPlaying(playing: boolean): void
  next(): void
  previous(): void
  setShuffle(shuffle: boolean): void
}

export const useMusicPlayer = create<MusicPlayerState>()((set, get) => ({
  folder: null,
  tracks: [],
  byPath: new Map(),
  loaded: false,
  loading: false,
  queue: [],
  index: -1,
  playing: false,
  shuffle: false,
  async loadLibrary() {
    if (get().loading) return
    set({ loading: true })
    try {
      const library = await api.getMusicLibrary()
      set({
        folder: library.folder,
        tracks: library.tracks,
        byPath: new Map(library.tracks.map((t) => [t.path, t])),
        loaded: true
      })
    } catch (err) {
      log.error('getMusicLibrary failed', err)
      set({ loaded: true })
    } finally {
      set({ loading: false })
    }
  },
  playQueue(paths, start = 0, autoplay = true) {
    if (paths.length === 0) return
    const index = Math.min(Math.max(0, start), paths.length - 1)
    set({ queue: [...paths], index, playing: autoplay })
  },
  toggle() {
    const { index, queue, tracks } = get()
    // Nothing loaded yet: Play starts the whole folder.
    if (index < 0 || queue.length === 0) {
      if (tracks.length) get().playQueue(tracks.map((t) => t.path))
      return
    }
    set({ playing: !get().playing })
  },
  setPlaying(playing) {
    set({ playing })
  },
  next() {
    const { queue, index, shuffle } = get()
    const next = nextIndex(queue.length, index, shuffle)
    if (next >= 0) set({ index: next })
  },
  previous() {
    const { queue, index } = get()
    const previous = previousIndex(queue.length, index)
    if (previous >= 0) set({ index: previous })
  },
  setShuffle(shuffle) {
    set({ shuffle })
  }
}))

/** The path of the track the player is on, or null. */
export function currentPath(state: Pick<MusicPlayerState, 'queue' | 'index'>): string | null {
  return state.index >= 0 ? (state.queue[state.index] ?? null) : null
}

/**
 * 'session:started': play or load the game's playlist when settings.music.gameStart asks for it. The game is read
 * from the API (the overlay's library copy may predate a playlist edited in PlayOut's window).
 */
export async function onGameStarted(gameId: string): Promise<void> {
  const { gameStart, folder } = currentSettings().music
  // Without a music folder the playlist's paths cannot be served: nothing to play (and no error toast).
  if (gameStart === 'keep' || !folder) return
  try {
    const game = await api.getGame(gameId)
    const action = gameStartAction(gameStart, game?.user.playlist)
    if (action === 'none' || !game?.user.playlist) return
    const player = useMusicPlayer.getState()
    if (!player.loaded) await player.loadLibrary()
    useMusicPlayer.getState().playQueue(game.user.playlist, 0, action === 'play')
  } catch (err) {
    log.error(`game start music for ${gameId} failed`, err)
  }
}
