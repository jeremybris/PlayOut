// The overlay's Music section (docs/home-overlay.md, Media): what Windows is playing (SMTC, through the native
// host) and the local music folder.
import type { MediaAction, MediaSession, MusicLibrary, MusicTrack } from '@shared/overlay'
import type { Settings } from '@shared/types'
import type { Logger } from '../logger'
import type { NativeOps } from '../native-host/native-ops'
import { listMusic } from './music-library'

/** The part of the native host this needs; the host's ops object (createNativeOps) is passed straight in. */
export type MediaNative = Pick<NativeOps, 'mediaSession' | 'mediaControl'>

export interface MediaServiceDeps {
  native: MediaNative
  settings: { get(): Settings }
  log: Logger
  /** Tests: the folder scan and the pause before re-reading the session. */
  listMusic?: (folder: string) => Promise<MusicTrack[]>
  wait?: (ms: number) => Promise<void>
}

export interface MediaService {
  /** What Windows is playing, or null (nothing, or the host is not running). */
  session(): Promise<MediaSession | null>
  /** Send play/pause/next/previous, then the session as it is after the app reacted. */
  control(action: MediaAction): Promise<MediaSession | null>
  /** The music folder's tracks; no folder chosen gives none. */
  library(): Promise<MusicLibrary>
}

/** Apps update SMTC a moment after a command; reading at once would show the old track or state. */
export const CONTROL_SETTLE_MS = 300

export function createMediaService(deps: MediaServiceDeps): MediaService {
  const list = deps.listMusic ?? ((folder: string) => listMusic(folder))
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const session = async (): Promise<MediaSession | null> => {
    try {
      return await deps.native.mediaSession()
    } catch (err) {
      deps.log.warn(`media session: ${(err as Error).message}`)
      return null
    }
  }

  return {
    session,
    async control(action) {
      try {
        await deps.native.mediaControl(action)
      } catch (err) {
        // Still answer with the session, so the overlay shows the real state rather than an error.
        deps.log.warn(`media ${action}: ${(err as Error).message}`)
      }
      await wait(CONTROL_SETTLE_MS)
      return session()
    },
    async library() {
      const folder = deps.settings.get().music.folder
      if (!folder) return { folder: null, tracks: [] }
      try {
        return { folder, tracks: await list(folder) }
      } catch (err) {
        deps.log.warn(`music folder ${folder}: ${(err as Error).message}`)
        return { folder, tracks: [] }
      }
    }
  }
}
