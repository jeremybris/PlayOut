import type { InstallQueueEntry } from '@shared/types'
import type { ProgressView } from '../lib/streaming'
import { create } from 'zustand'
import { api } from '../api/client'
import { currentLanguage, t } from '../i18n'
import { createLog } from '../lib/log'
import { ipcErrorMessage } from './coop'
import { useInstallsStore } from './installs'
import { useUiStore } from './ui'

const log = createLog('install-queue')

/**
 * PlayOut's install queue (ARCHITECTURE.md §4.8 "Install queue"): one game downloads at a time, whatever the store,
 * and ROM downloads from another PC wait their turn too. Main owns the order; this mirrors it, filled by
 * getInstallQueue() when a window loads and replaced by every 'installs:queue' event (the active entry first). The
 * active entry's progress stays in state/installs.ts (store) or state/streaming.ts (host ROM).
 */
export interface InstallQueueState {
  entries: InstallQueueEntry[]
  refresh(): Promise<void>
  /**
   * Take a game out of the queue: a waiting one just leaves it; the active one stops (a host ROM's download is
   * cancelled, a store install stops being tracked while the store may keep downloading) and the next one starts.
   */
  remove(gameId: string): Promise<void>
  /** Move a waiting game one place earlier (-1) or later (1). */
  move(gameId: string, delta: -1 | 1): Promise<void>
  /**
   * Pause one game (null: every game). A waiting one keeps its place but is skipped; a ROM download from another PC
   * stops, keeps what it has and waits paused, and the next game starts. A store install PlayOut cannot pause: it
   * stays the active download, marked paused, and the store's downloads page opens (a toast says to pause it there).
   */
  pause(gameId: string | null): Promise<void>
  /** Resume one paused game (null: every one): it downloads in its turn (now, when nothing else does). */
  resume(gameId: string | null): Promise<void>
}

const toast = (text: string, kind?: 'info' | 'error'): void => {
  useUiStore.getState().toast(text, kind)
}

export const useInstallQueueStore = create<InstallQueueState>()((set, get) => ({
  entries: [],
  async refresh() {
    try {
      set({ entries: await api.getInstallQueue() })
    } catch (err) {
      log.error('getInstallQueue failed', err)
    }
  },
  async remove(gameId) {
    const entry = get().entries.find((e) => e.gameId === gameId)
    // Read before the call: the 'installs:queue' event it sends (which arrives before its answer) already drops the
    // bar of the store install it stopped, and the toast must still know whether that one was downloading.
    const progress = useInstallsStore.getState().installs.get(gameId)
    try {
      await api.removeFromInstallQueue(gameId)
    } catch (err) {
      log.error('removeFromInstallQueue failed', err)
      toast(ipcErrorMessage(err) || t('state.queue.changeFailed'), 'error')
      return
    }
    if (entry?.state !== 'active' || entry.kind !== 'store') return
    // Like the play menu's Cancel tracking: the progress bar goes, and the store may well keep downloading. One that
    // never reported progress ("Starting…") was only handed to the store: nothing is known to be downloading.
    useInstallsStore.getState().remove(gameId)
    toast(
      queueStarting(0, progress)
        ? t('state.queue.cancelled', { title: entry.title })
        : t('state.queue.stoppedTracking', { title: entry.title, store: entry.from })
    )
  },
  async move(gameId, delta) {
    try {
      await api.moveInInstallQueue(gameId, delta)
    } catch (err) {
      log.error('moveInInstallQueue failed', err)
      toast(ipcErrorMessage(err) || t('state.queue.changeFailed'), 'error')
    }
  },
  async pause(gameId) {
    // Read before the call: its 'installs:queue' event arrives first and already marks them paused.
    const stores = get().entries.filter(
      (e) =>
        (gameId === null || e.gameId === gameId) &&
        e.state === 'active' &&
        e.kind === 'store' &&
        !e.paused
    )
    try {
      await api.pauseInstall(gameId)
    } catch (err) {
      log.error('pauseInstall failed', err)
      toast(ipcErrorMessage(err) || t('state.queue.pauseFailed'), 'error')
      return
    }
    for (const entry of stores) toast(storePauseToastText(entry))
  },
  async resume(gameId) {
    try {
      await api.resumeInstall(gameId)
    } catch (err) {
      log.error('resumeInstall failed', err)
      toast(ipcErrorMessage(err) || t('state.queue.resumeFailed'), 'error')
    }
  }
}))

api.on('installs:queue', (entries) => {
  // A store install taken out of the queue while it ran (from the other window: the overlay's Downloads tab or the
  // main window's quick panel) ends with no final 'install:progress': its bar goes here too. One that ended on its
  // own sent done / failed first, and that stays for the panel's Play or Retry.
  const before = activeQueueEntry(useInstallQueueStore.getState().entries)
  useInstallQueueStore.setState({ entries })
  if (before?.kind !== 'store' || entries.some((e) => e.gameId === before.gameId)) return
  const progress = useInstallsStore.getState().installs.get(before.gameId)
  if (progress && progress.state !== 'done' && progress.state !== 'failed')
    useInstallsStore.getState().remove(before.gameId)
})

/** React hook: the whole queue, the active entry first. */
export function useInstallQueue(): InstallQueueEntry[] {
  return useInstallQueueStore((s) => s.entries)
}

/**
 * A game's place in the queue: 0 while it downloads, 1 for the next one, and so on; null when not queued.
 * `installedHere`: the game is installed on this PC (a local game, never a host's): it counts as not queued
 * whatever the queue says, so it never loses Play to a queue entry that has not caught up yet.
 */
export function queuePosition(
  entries: readonly InstallQueueEntry[],
  gameId: string,
  installedHere = false
): number | null {
  if (installedHere) return null
  let waiting = 0
  for (const entry of entries) {
    if (entry.state === 'active') {
      if (entry.gameId === gameId) return 0
      continue
    }
    waiting += 1
    if (entry.gameId === gameId) return waiting
  }
  return null
}

/** React hook: queuePosition of one game (re-renders only when that number changes). */
export function useQueuePosition(
  gameId: string | null | undefined,
  installedHere = false
): number | null {
  return useInstallQueueStore((s) =>
    gameId ? queuePosition(s.entries, gameId, installedHere) : null
  )
}

/** True for a game installed on this PC (not a paired host's): the queue never takes its Play. */
export function isInstalledHere(
  game: { installed: boolean; remote?: unknown } | null | undefined
): boolean {
  return !!game?.installed && !game.remote
}

/** Why a queued game is held back (InstallQueueEntry.waitingFor), e.g. "Waiting for <host> to come back online". */
export function queueWaitingFor(
  entries: readonly InstallQueueEntry[],
  gameId: string
): string | undefined {
  return entries.find((e) => e.gameId === gameId && e.state === 'waiting')?.waitingFor
}

/** True for a game the user paused in the queue (InstallQueueEntry.paused). */
export function queuePaused(entries: readonly InstallQueueEntry[], gameId: string): boolean {
  return entries.some((e) => e.gameId === gameId && !!e.paused)
}

/** React hook: queuePaused of one game. */
export function useQueuePaused(gameId: string | null | undefined): boolean {
  return useInstallQueueStore((s) => (gameId ? queuePaused(s.entries, gameId) : false))
}

/** React hook: one game's queue entry (undefined when not queued). */
export function useQueueEntry(gameId: string | null | undefined): InstallQueueEntry | undefined {
  return useInstallQueueStore((s) =>
    gameId ? s.entries.find((e) => e.gameId === gameId) : undefined
  )
}

/** True once every queued game is paused: the list offers "Resume all" rather than "Pause all". */
export function queueAllPaused(entries: readonly InstallQueueEntry[]): boolean {
  return entries.length > 0 && entries.every((e) => !!e.paused)
}

/**
 * The note of a paused game: "Paused" (with the percent it reached, when known). The active store install, which
 * PlayOut cannot pause, adds where to pause it: "Paused · Pause it in Steam too".
 */
export function queuePausedText(
  entry: Pick<InstallQueueEntry, 'kind' | 'state' | 'from'>,
  percent?: number | null
): string {
  const known = percent !== null && percent !== undefined && Number.isFinite(percent)
  // The store install PlayOut holds: the store may still be downloading (its bar keeps moving), so no "Paused at N%";
  // short enough for the overlay's rows.
  if (entry.kind === 'store' && entry.state === 'active')
    return t('state.queue.pausedStore', { store: entry.from })
  return known
    ? t('state.queue.pausedAt', { percent: Math.round(percent) })
    : t('state.queue.paused')
}

/** The toast after pausing the store install that downloads now: PlayOut holds the queue, the store must pause too. */
export function storePauseToastText(entry: Pick<InstallQueueEntry, 'title' | 'from'>): string {
  return t('state.queue.storeKeepsDownloading', { store: entry.from, title: entry.title })
}

/** React hook: queueWaitingFor of one game. */
export function useQueueWaitingFor(gameId: string | null | undefined): string | undefined {
  return useInstallQueueStore((s) => (gameId ? queueWaitingFor(s.entries, gameId) : undefined))
}

/**
 * The toast after asking for a host ROM's download, from the queue as the call left it (its 'installs:queue' event
 * arrives before the call's answer): downloading now, held back (its waitingFor, e.g. the host is offline), or
 * queued behind another game. A game the queue does not list (it ended at once) reads as started.
 */
export function romDownloadToastText(title: string, gameId: string, hostName?: string): string {
  const entry = useInstallQueueStore.getState().entries.find((e) => e.gameId === gameId)
  const started = hostName
    ? t('state.queue.downloadingFrom', { title, host: hostName })
    : t('state.queue.downloading', { title })
  if (entry?.state === 'active') return started
  if (entry?.waitingFor) return entry.waitingFor
  if (entry || queueBusyWithOther(gameId)) return queuedToastText(title, gameId)
  return started
}

/**
 * True for the game downloading now (queue position 0) while nothing has reported its progress yet: a store hand-off
 * before its first 'install:progress', or a ROM download from another PC that resumes after a restart (main waits up
 * to a minute for the host). Such a game shows "Starting…" with Stop tracking / Cancel download (the queue's
 * remove), never Install or Download. `progress` is its tracked install or ROM download: one that ended (failed,
 * cancelled, or paused and then resumed) before the queue started it again counts as none; a done one is progress
 * (Play / "Adding…" follow).
 */
export function queueStarting(
  position: number | null | undefined,
  progress: { state: string } | null | undefined
): boolean {
  return (
    position === 0 &&
    (!progress ||
      progress.state === 'failed' ||
      progress.state === 'cancelled' ||
      progress.state === 'paused')
  )
}

/** The progress block of a queueStarting game: an indeterminate bar saying "Starting…" (in the language shown). */
export const QUEUE_STARTING_VIEW: ProgressView = {
  state: 'starting',
  get message() {
    return t('state.queue.starting')
  }
}

/**
 * The system bar's downloads item, from the queue and the active download's percent (null: unknown): its text (the
 * percent), its label, and whether it reads as paused (the active download is, or with none active every game is):
 * no percent then.
 */
export function queueSummary(
  entries: readonly InstallQueueEntry[],
  percent: number | null
): { text?: string; label: string; paused: boolean } {
  const active = activeQueueEntry(entries)
  const paused = active ? !!active.paused : queueAllPaused(entries)
  const text = percent !== null && !paused ? `${Math.round(percent)}%` : undefined
  const waiting = entries.length - (active ? 1 : 0)
  const label = [
    active
      ? paused
        ? t('state.queue.summary.activePaused', { title: active.title })
        : text
          ? t('state.queue.summary.downloadingPercent', { title: active.title, percent: text })
          : t('state.queue.summary.downloading', { title: active.title })
      : paused
        ? t('state.queue.summary.allPaused')
        : t('state.queue.summary.downloads'),
    waiting > 0 ? t('state.queue.summary.waiting', { count: waiting }) : ''
  ]
    .filter(Boolean)
    .join(', ')
  return { text, label, paused }
}

/** The game downloading now, if any. */
export function activeQueueEntry(
  entries: readonly InstallQueueEntry[]
): InstallQueueEntry | undefined {
  return entries.find((e) => e.state === 'active')
}

/**
 * After Move up / Move down on a waiting row: the part of that row to focus, given the queue as it is now. The
 * pressed arrow while it is still enabled; once it turned disabled (the row reached the top or the bottom) the other
 * arrow, else Remove. Null when the game is no longer waiting (it started or left the queue).
 */
export function queueMoveFocusPart(
  entries: readonly InstallQueueEntry[],
  gameId: string,
  pressed: 'up' | 'down'
): 'up' | 'down' | 'remove' | null {
  const waiting = entries.filter((e) => e.state === 'waiting')
  const place = waiting.findIndex((e) => e.gameId === gameId) + 1
  if (place === 0) return null
  const enabled = { up: place > 1, down: place < waiting.length }
  const other = pressed === 'up' ? 'down' : 'up'
  if (enabled[pressed]) return pressed
  return enabled[other] ? other : 'remove'
}

/**
 * 1 -> 'Next in line', 2 -> '2nd in line', 3 -> '3rd in line'. The ordinal's form follows the language's own rules
 * (Intl.PluralRules, type ordinal: English 'one' is 1st, 21st, 'two' 2nd, 'few' 3rd, 'other' 4th, 11th...).
 */
export function queuePlaceText(position: number): string {
  if (position <= 1) return t('state.queue.place.next')
  const vars = { position }
  switch (ordinalForm(position)) {
    case 'one':
      return t('state.queue.place.one', vars)
    case 'two':
      return t('state.queue.place.two', vars)
    case 'few':
      return t('state.queue.place.few', vars)
    default:
      return t('state.queue.place.other', vars)
  }
}

function ordinalForm(n: number): Intl.LDMLPluralRule {
  try {
    return new Intl.PluralRules(currentLanguage(), { type: 'ordinal' }).select(n)
  } catch {
    return 'other'
  }
}

/**
 * The toast for a game that went into the queue rather than starting: names the download it waits for (the
 * 'installs:queue' event that put it there arrives before the call's answer).
 */
export function queuedToastText(title: string, gameId: string): string {
  const active = activeQueueEntry(useInstallQueueStore.getState().entries)
  return active && active.gameId !== gameId
    ? t('state.queue.queuedAfter', { title, active: active.title })
    : t('state.queue.queued', { title })
}

/** True while another game than this one downloads: a new download of this one would wait in the queue. */
export function queueBusyWithOther(gameId: string): boolean {
  const active = activeQueueEntry(useInstallQueueStore.getState().entries)
  return !!active && active.gameId !== gameId
}
