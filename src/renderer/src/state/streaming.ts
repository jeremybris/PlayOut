import type {
  Game,
  RemoteGameInfo,
  RemoteLibrary,
  RomDownloadProgress,
  StreamSession,
  StreamingStatus
} from '@shared/types'
import { useMemo } from 'react'
import { create } from 'zustand'
import { api } from '../api/client'
import { t, useLanguageStore } from '../i18n'
import { displayTitle } from '../lib/library'
import { hostOfflineWait } from '../lib/streaming'
import { createLog } from '../lib/log'
import { ipcErrorMessage } from './coop'
import { romDownloadToastText } from './installQueue'
import { useSettingsStore } from './settings'
import { useUiStore, type ToastKind } from './ui'

const log = createLog('streaming')

/**
 * Streaming in the renderer: the host and client status Settings > Streaming shows, the paired hosts' games
 * (host-only games and the hosts that also have one of this PC's games), the running stream and ROM downloads from a
 * host. Kept current by the four `streaming:*` events, subscribed once below.
 */
export interface StreamingState {
  status: StreamingStatus | null
  remote: RemoteLibrary | null
  /** The last stream event (one stream at a time); the game's page shows "Connecting…" / "Streaming" from it. */
  session: StreamSession | null
  /** ROM downloads by `remote:` game id; finished and failed ones stay until the next attempt. */
  downloads: Record<string, RomDownloadProgress>
  /** Read the status and the remote library (Settings and the library call it once; events keep them current). */
  load: () => Promise<void>
  /** Ask every paired host for its games again. */
  refreshRemote: () => Promise<void>
  /** Stream a host-only game, or this PC's game from `hostId` (a game both PCs have). Errors are toasted. */
  streamGame: (game: Game, hostId?: string) => Promise<void>
  stopStream: () => Promise<void>
  /** Download a host-only ROM game into this PC's ROM folder. */
  downloadRom: (game: Game) => Promise<void>
  cancelDownload: (gameId: string) => Promise<void>
  /** Put a host-only game as main returned it (an Edit sheet save) in place of its card; 'streaming:library' follows. */
  applyRemoteGame: (game: Game) => void
}

const toast = (text: string, kind?: ToastKind, ms?: number): void => {
  useUiStore.getState().toast(text, kind, ms)
}

export const useStreamingStore = create<StreamingState>()((set, get) => ({
  status: null,
  remote: null,
  session: null,
  downloads: {},

  applyRemoteGame(game) {
    set((s) =>
      s.remote && s.remote.games.some((g) => g.id === game.id)
        ? {
            remote: {
              ...s.remote,
              games: s.remote.games.map((g) => (g.id === game.id ? game : g))
            }
          }
        : {}
    )
  },

  async load() {
    const [status, remote] = await Promise.allSettled([
      api.getStreamingStatus(),
      api.getRemoteLibrary()
    ])
    if (status.status === 'fulfilled') set({ status: status.value })
    else log.warn('getStreamingStatus failed', status.reason)
    if (remote.status === 'fulfilled') set({ remote: remote.value })
    else log.warn('getRemoteLibrary failed', remote.reason)
  },

  async refreshRemote() {
    try {
      set({ remote: await api.refreshRemoteLibrary() })
    } catch (err) {
      log.warn('refreshRemoteLibrary failed', err)
      toast(ipcErrorMessage(err) || t('state.streaming.refreshFailed'), 'error')
    }
  },

  async streamGame(game, hostId) {
    // The 'error' session event says why a stream failed; only a failure without one is shown here.
    if (get().session?.gameId === game.id) set({ session: null })
    toast(t('state.streaming.connecting', { title: displayTitle(game) }))
    try {
      await api.streamGame(game.id, hostId)
    } catch (err) {
      log.warn('streamGame failed', err)
      const session = get().session
      if (!(session?.gameId === game.id && session.state === 'error'))
        toast(
          t('state.streaming.streamFailed', {
            title: displayTitle(game),
            error: ipcErrorMessage(err)
          }),
          'error',
          8000
        )
    }
  },

  async stopStream() {
    try {
      await api.stopStream()
    } catch (err) {
      log.warn('stopStream failed', err)
      toast(ipcErrorMessage(err) || t('state.streaming.stopFailed'), 'error')
    }
  },

  async downloadRom(game) {
    // No ROM folder yet (main would refuse): Settings > Library, where it is chosen, instead of an error.
    if (romFolderMissing()) {
      toast(NO_ROM_FOLDER_TEXT, 'error')
      useUiStore.getState().openModal({ type: 'settings', section: 'library' })
      return
    }
    set((s) => ({ downloads: withoutKey(s.downloads, game.id) }))
    try {
      await api.downloadRemoteRom(game.id)
      // Started from a cover the menu closes at once: say what happened, from the queue as the call left it (its
      // 'installs:queue' event arrives first): it began (the card then shows its progress), it waits for its host to
      // come back online, or it waits in the install queue behind another game. The host-offline news may already
      // be on screen from the download's own event: not said twice.
      const text = romDownloadToastText(displayTitle(game), game.id, game.remote?.hostName)
      if (!useUiStore.getState().toasts.some((t) => t.text === text)) toast(text)
    } catch (err) {
      log.warn('downloadRemoteRom failed', err)
      if (get().downloads[game.id]?.state !== 'failed')
        toast(
          t('state.streaming.downloadFailed', {
            title: displayTitle(game),
            error: ipcErrorMessage(err)
          }),
          'error',
          8000
        )
    }
  },

  async cancelDownload(gameId) {
    try {
      await api.cancelRemoteRomDownload(gameId)
    } catch (err) {
      log.warn('cancelRemoteRomDownload failed', err)
      toast(ipcErrorMessage(err) || t('state.streaming.cancelFailed'), 'error')
    }
  }
}))

/**
 * What the Download slot says while no ROM folder is set (a ROM download has nowhere to go). In the language shown:
 * reassigned when it changes, and an ES module's importers read the new value.
 */
export let NO_ROM_FOLDER_TEXT = t('state.streaming.noRomFolder')
useLanguageStore.subscribe(() => {
  NO_ROM_FOLDER_TEXT = t('state.streaming.noRomFolder')
})

/** True once settings are loaded and no ROM folder is set. */
export function romFolderMissing(): boolean {
  const settings = useSettingsStore.getState().settings
  return !!settings && !settings.library.romsRoot
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

// A paired host's logins filled the ones this PC had none of (main/streaming/host-logins.ts).
api.on('streaming:logins', ({ hostName, services }) =>
  useUiStore
    .getState()
    .toast(
      t('state.streaming.logins', { host: hostName, services: services.join(', ') }),
      'success'
    )
)

api.on('streaming:status', (status) => {
  const before = useStreamingStore.getState().status
  useStreamingStore.setState({ status })
  // The host side: the PIN just disappears when the other PC pairs, and the new row may be off-screen.
  if (!before) return
  const known = new Set(before.host.clients.map((c) => c.id))
  for (const c of status.host.clients)
    if (!known.has(c.id)) toast(t('state.streaming.paired', { name: c.name }), 'success')
})
api.on('streaming:library', (remote) => useStreamingStore.setState({ remote }))

api.on('streaming:session', (session) => {
  useStreamingStore.setState({ session })
  if (session.state === 'error')
    toast(
      session.message || t('state.streaming.sessionFailed', { host: session.hostName }),
      'error',
      8000
    )
})

api.on('streaming:download', (progress) => {
  // A paused one (pauseInstall) stays with what it reached, said by the queue (no toast): it continues when resumed.
  useStreamingStore.setState((s) => ({
    // A cancelled download leaves nothing to show; the game offers Download again.
    downloads:
      progress.state === 'cancelled'
        ? withoutKey(s.downloads, progress.gameId)
        : { ...s.downloads, [progress.gameId]: progress }
  }))
  // A host that went offline mid-download keeps its turn in the install queue ("Waiting for <host>…", retried when
  // it is back): said as news, not as an error.
  const offline = hostOfflineWait(progress)
  if (offline) toast(offline, 'info')
  else if (progress.state === 'failed')
    toast(progress.message || t('state.streaming.hostDownloadFailed'), 'error', 8000)
  else if (progress.state === 'done')
    toast(progress.message || t('state.streaming.downloaded'), 'success')
})

api.on('installs:queue', (entries) => {
  // A ROM waiting for its offline host that left the queue (removed by the user, its host unpaired) is no longer
  // waiting: its "Waiting for <host>…" goes, so the game offers Download again rather than a stale failure + Retry.
  // Nor is one main still lists but no longer holds back (no waitingFor: its host answered again): it just waits its
  // turn, and the old "Waiting for <host>…" must not stay on screen while another game downloads.
  const { downloads } = useStreamingStore.getState()
  const byId = new Map(entries.map((e) => [e.gameId, e]))
  // A paused download whose game left the queue (removed by the user, its host unpaired) is gone too.
  const gone = Object.keys(downloads).filter((id) => {
    if (downloads[id]?.state === 'paused') return !byId.has(id)
    if (hostOfflineWait(downloads[id]) === undefined) return false
    const entry = byId.get(id)
    return !entry || (entry.state === 'waiting' && !entry.waitingFor)
  })
  if (gone.length === 0) return
  const next = { ...downloads }
  for (const id of gone) delete next[id]
  useStreamingStore.setState({ downloads: next })
})

const NO_REMOTES: RemoteGameInfo[] = []

/**
 * The hosts a game can be streamed (or downloaded) from: for this PC's own game the hosts that also have it, for a
 * host-only game its own host.
 */
export function remoteFor(remote: RemoteLibrary | null, gameId: string): RemoteGameInfo[] {
  if (!remote) return NO_REMOTES
  const also = remote.alsoOnHost[gameId]
  if (also?.length) return also
  const own = remote.games.find((g) => g.id === gameId)?.remote
  return own ? [own] : NO_REMOTES
}

export function useRemoteFor(gameId: string): RemoteGameInfo[] {
  const remote = useStreamingStore((s) => s.remote)
  // Memoized on the library object so components get the same array until the library changes.
  return useMemo(() => remoteFor(remote, gameId), [remote, gameId])
}

/** The stream of this game (any state, 'ended' and 'error' included), or null when another game or none streams. */
export function useStreamSession(gameId: string): StreamSession | null {
  return useStreamingStore((s) => (s.session?.gameId === gameId ? s.session : null))
}

export function useRomDownload(gameId: string | null | undefined): RomDownloadProgress | null {
  return useStreamingStore((s) => (gameId ? (s.downloads[gameId] ?? null) : null))
}

/**
 * A recompilation-only game's original on the paired PCs (RemoteLibrary.recompSources), each with the `remote:` id
 * its download and queue place go by. Empty when no paired PC has it.
 */
export function useRecompSources(
  gameId: string | null
): { remoteId: string; info: RemoteGameInfo }[] {
  const sources = useStreamingStore((s) => (gameId ? s.remote?.recompSources?.[gameId] : undefined))
  return useMemo(
    () =>
      (sources ?? []).map((info) => ({
        remoteId: `remote:${info.hostId}:${info.hostGameId}`,
        info
      })),
    [sources]
  )
}
