import type { RetroAchievementsStatus } from '@shared/types'
import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '../api/client'
import { t } from '../i18n'
import { createLog } from '../lib/log'
import { useUiStore } from './ui'

const log = createLog('retroachievements')

interface RetroAchievementsState {
  /** The account as the main process last reported it; null until the first answer. */
  status: RetroAchievementsStatus | null
}

export const useRetroAchievementsStore = create<RetroAchievementsState>()(() => ({ status: null }))

let started = false
/**
 * Set by an edit of the username or key: the first definite answer with a higher revision is shown as a
 * notification. Kept here, not in the Settings section, so the answer still shows after the section closes.
 */
let announceAfter: number | null = null

function receive(status: RetroAchievementsStatus): void {
  const current = useRetroAchievementsStore.getState().status
  // getRetroAchievementsStatus may answer after a newer event.
  if (current && current.revision > status.revision) return
  useRetroAchievementsStore.setState({ status })
  if (announceAfter === null || status.revision <= announceAfter) return
  if (status.state === 'checking') return
  announceAfter = null
  announce(status)
}

/** One notification for an answer: signed in, rejected, unreachable or a failed sync. */
export function announce(status: RetroAchievementsStatus): void {
  const toast = useUiStore.getState().toast
  switch (status.state) {
    case 'signed-in':
      if (status.message) toast(t('state.ra.note', { message: status.message }), 'info')
      else toast(t('state.ra.signedIn', { user: status.user ?? '' }), 'success')
      return
    case 'invalid':
      toast(status.message ?? t('state.ra.notSignedIn'), 'error')
      return
    case 'error':
      toast(status.message ?? t('state.ra.unreachable'), 'info')
      return
    default:
      return
  }
}

/** Subscribe once for the app's lifetime; later calls do nothing. */
export function startRetroAchievementsStatus(): void {
  if (started) return
  started = true
  api.on('retroachievements:status', receive)
  api
    .getRetroAchievementsStatus()
    .then(receive)
    .catch((err) => log.error('getRetroAchievementsStatus failed', err))
}

/** The username or key was just edited: announce the answer to it, whenever it comes. */
export function announceNextRetroAnswer(): void {
  announceAfter = useRetroAchievementsStore.getState().status?.revision ?? -1
}

/** Sync now answers for itself: no notification for the same answer from the edit path. */
export function claimRetroAnswer(): void {
  announceAfter = null
}

/** The account's current status, kept live by 'retroachievements:status'. */
export function useRetroAchievementsStatus(): RetroAchievementsStatus | null {
  useEffect(startRetroAchievementsStatus, [])
  return useRetroAchievementsStore((s) => s.status)
}

/** True while the account is usable: signed in, or syncing as a known user. */
export function retroSignedIn(status: RetroAchievementsStatus | null): boolean {
  return status?.state === 'signed-in' || (status?.state === 'checking' && !!status.user)
}
