// PeerParty (LAN play, main/peerparty) in the renderer: which games the game page offers it for, PeerParty's download /
// check / start progress, the game running through it now and the games Filters > L.A.N. Party shows. Main sends
// 'peerparty:status', 'peerparty:progress', 'peerparty:session' and 'peerparty:compatible'.
import type {
  PeerPartyCompatible,
  PeerPartyProgress,
  PeerPartySession,
  PeerPartyStatus
} from '@shared/peerparty'
import { PEERPARTY_SERVICE_LABELS } from '@shared/peerparty'
import type { Game } from '@shared/types'
import { upgradeRunningMessage } from '@shared/upgrades'
import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '../api/client'
import { t } from '../i18n'
import { displayTitle } from '../lib/library'
import { createLog } from '../lib/log'
import { useUiStore } from './ui'
import { useUpgradesStore } from './upgrades'

const log = createLog('peerparty')

/**
 * An IPC error's own message, without Electron's "Error invoking remote method '…': Error: " prefix (as state/coop.ts
 * does; not imported from there, because that module listens for Co-Op events as soon as it loads, also in the overlay).
 */
function ipcErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
}

/** The progress key of a download that is not tied to one game. */
const ANY_GAME = '*'

interface PeerPartyState {
  /** The latest status per game id. */
  status: Record<string, PeerPartyStatus>
  /** The latest progress per game id (ANY_GAME for a download not tied to one game). */
  progress: Record<string, PeerPartyProgress>
  /** The game running through PeerParty now. */
  session: PeerPartySession | null
  /** Filters > L.A.N. Party: the games PeerParty is offered for, null until first asked (useLanPartyIds). */
  lanParty: { ids: ReadonlySet<string>; scanning: boolean } | null
}

export const usePeerPartyStore = create<PeerPartyState>(() => ({
  status: {},
  progress: {},
  session: null,
  lanParty: null
}))

/** A game's status changes the L.A.N. Party list once it is known (a status still `checking` says nothing yet). */
function lanPartyWith(
  lanParty: PeerPartyState['lanParty'],
  status: PeerPartyStatus
): PeerPartyState['lanParty'] {
  if (!lanParty || status.checking) return lanParty
  if (lanParty.ids.has(status.gameId) === status.supported) return lanParty
  const ids = new Set(lanParty.ids)
  if (status.supported) ids.add(status.gameId)
  else ids.delete(status.gameId)
  return { ...lanParty, ids }
}

function setLanParty(compatible: PeerPartyCompatible): void {
  usePeerPartyStore.setState({
    lanParty: { ids: new Set(compatible.ids), scanning: compatible.scanning }
  })
}

let started = false

/** Listen once for the window's lifetime (the main window and the overlay each start their own); later calls do nothing. */
export function startPeerPartyEvents(): void {
  if (started) return
  started = true
  api.on('peerparty:status', (status) => {
    usePeerPartyStore.setState((s) => ({
      status: { ...s.status, [status.gameId]: status },
      lanParty: lanPartyWith(s.lanParty, status)
    }))
  })
  api.on('peerparty:compatible', setLanParty)
  api.on('peerparty:progress', (progress) => {
    usePeerPartyStore.setState((s) => ({
      progress: { ...s.progress, [progress.gameId ?? ANY_GAME]: progress }
    }))
  })
  api.on('peerparty:session', ({ session }) => {
    usePeerPartyStore.setState({ session })
  })
  api
    .peerPartySession()
    .then((session) => {
      // A session event may have come first: it is newer.
      if (usePeerPartyStore.getState().session === null) usePeerPartyStore.setState({ session })
    })
    .catch((err) => log.warn('peerPartySession failed', err))
}

/**
 * Ask main for the session again (the overlay, at each open: a 'peerparty:session' sent while its page was still
 * loading would otherwise be missed). Starts listening first, so an event newer than the answer is not overwritten.
 */
export function refreshPeerPartySession(): void {
  startPeerPartyEvents()
  const asked = usePeerPartyStore.getState().session
  api
    .peerPartySession()
    .then((session) => {
      // A session event came while asking: it is newer.
      if (usePeerPartyStore.getState().session === asked) usePeerPartyStore.setState({ session })
    })
    .catch((err) => log.warn('peerPartySession failed', err))
}

/** Whether a progress means PeerParty is still at work (downloading, checking, starting). */
export function peerPartyBusy(progress: PeerPartyProgress | null | undefined): boolean {
  return !!progress && progress.phase !== 'done' && progress.phase !== 'failed'
}

/** What the PeerParty square says while busy: "Downloading PeerParty… 42%", "Checking PeerParty…", and so on. */
export function peerPartyProgressText(progress: PeerPartyProgress): string {
  switch (progress.phase) {
    case 'downloading':
      return progress.percent !== undefined && Number.isFinite(progress.percent)
        ? t('state.peerparty.downloadingPercent', { percent: Math.round(progress.percent) })
        : t('state.peerparty.downloading')
    case 'checking':
    case 'verifying':
      return t('state.peerparty.checking')
    case 'installing':
      return t('state.peerparty.installing')
    case 'starting':
      return t('state.peerparty.starting')
    default:
      return progress.message ?? 'PeerParty'
  }
}

/** The PeerParty square's tooltip when it is not busy: the multiplayer services found in the game. */
export function peerPartyTitle(status: Pick<PeerPartyStatus, 'services'>): string {
  const services = status.services.map((s) => PEERPARTY_SERVICE_LABELS[s]).join(', ')
  return services ? t('state.peerparty.titleServices', { services }) : t('state.peerparty.title')
}

/**
 * The game's PeerParty status, asked of main when the page opens and again when the game is installed, uninstalled or
 * moved. Main may answer `checking` first (its folder is being scanned) and send 'peerparty:status' when done.
 */
export function usePeerPartyStatus(
  game: Pick<Game, 'id' | 'installed' | 'installDir' | 'remote'> | undefined
): PeerPartyStatus | undefined {
  const id = game?.id
  const installed = !!game?.installed
  const installDir = game?.installDir
  const remote = !!game?.remote
  useEffect(() => {
    startPeerPartyEvents()
    if (!id || remote) return
    let live = true
    api
      .peerPartyStatus(id)
      .then((status) => {
        if (live) usePeerPartyStore.setState((s) => ({ status: { ...s.status, [id]: status } }))
      })
      .catch((err) => log.warn('peerPartyStatus failed', err))
    return () => {
      live = false
    }
  }, [id, installed, installDir, remote])
  return usePeerPartyStore((s) => (id ? s.status[id] : undefined))
}

/**
 * Filters > L.A.N. Party: the ids of the games PeerParty is offered for, while `active` (the tab has the choice on).
 * Asked of main when it turns on and when the number of installed games changes; main then checks the folders it has
 * never scanned in the background, and the list grows as their answers come ('peerparty:status').
 */
export function useLanPartyIds(
  active: boolean,
  installedCount: number
): ReadonlySet<string> | undefined {
  useEffect(() => {
    startPeerPartyEvents()
    if (!active) return
    let live = true
    api
      .peerPartyCompatible()
      .then((compatible) => {
        if (!live) return
        setLanParty(compatible)
        if (compatible.scanning) useUiStore.getState().toast(t('state.peerparty.scanning'))
      })
      .catch((err) => log.warn('peerPartyCompatible failed', err))
    return () => {
      live = false
    }
  }, [active, installedCount])
  return usePeerPartyStore((s) => s.lanParty?.ids)
}

/**
 * The L.A.N. Party ids for a check made outside the Library (state/libraryShown.ts): main's list once asked for, else
 * the games whose status is known to offer PeerParty, while the list is asked of main for next time.
 */
export function lanPartyIdsNow(players: readonly string[]): ReadonlySet<string> | undefined {
  const { lanParty, status } = usePeerPartyStore.getState()
  if (lanParty || !players.includes('lan-party')) return lanParty?.ids
  startPeerPartyEvents()
  api
    .peerPartyCompatible()
    .then((compatible) => {
      if (!usePeerPartyStore.getState().lanParty) setLanParty(compatible)
    })
    .catch((err) => log.warn('peerPartyCompatible failed', err))
  return new Set(
    Object.values(status)
      .filter((s) => s.supported)
      .map((s) => s.gameId)
  )
}

/** PeerParty's progress for the game (or a download of PeerParty not tied to any game) while it is at work. */
export function usePeerPartyProgress(gameId: string): PeerPartyProgress | null {
  return usePeerPartyStore((s) => {
    const own = s.progress[gameId]
    if (peerPartyBusy(own)) return own!
    const any = s.progress[ANY_GAME]
    return peerPartyBusy(any) ? any! : null
  })
}

/** The game running through PeerParty now, or null. */
export function usePeerPartySession(): PeerPartySession | null {
  useEffect(startPeerPartyEvents, [])
  return usePeerPartyStore((s) => s.session)
}

/** Start the game through PeerParty (main downloads or updates PeerParty first, then starts the game with it). */
export function startPeerParty(game: Game): void {
  const toast = useUiStore.getState().toast
  if (useUpgradesStore.getState().progress[game.id]?.state === 'running') {
    toast(upgradeRunningMessage(t), 'error')
    return
  }
  const title = displayTitle(game)
  toast(t('state.peerparty.startingGame', { title }))
  api
    .playWithPeerParty(game.id)
    .then((result) => {
      if (!result.ok)
        toast(result.error?.message || t('state.peerparty.startFailed', { title }), 'error', 8000)
    })
    .catch((err) => {
      log.error('playWithPeerParty failed', err)
      toast(ipcErrorMessage(err) || t('state.peerparty.startFailed', { title }), 'error', 8000)
    })
}
