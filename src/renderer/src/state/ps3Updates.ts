import type { Ps3UpdateProgress } from '@shared/types'
import { create } from 'zustand'
import { api } from '../api/client'
import { t } from '../i18n'
import { useUiStore } from './ui'

/**
 * PS3 game updates as main reports them ('ps3-update:progress', main/emulation/ps3-update-service.ts): the one being
 * checked, downloaded or installed shows as a bottom bar; the automatic pass's finished install or failure shows as a
 * toast (one started from the game menu toasts its result there).
 */
export const usePs3UpdateStore = create<{ current: Ps3UpdateProgress | null }>()(() => ({
  current: null
}))

api.on('ps3-update:progress', (p) => {
  const active = p.phase === 'checking' || p.phase === 'downloading' || p.phase === 'installing'
  usePs3UpdateStore.setState({ current: active ? p : null })
  if (p.manual) return
  const toast = useUiStore.getState().toast
  if (p.phase === 'done' && p.version)
    toast(t('state.ps3Updates.updated', { title: p.title, version: p.version }), 'success')
  else if (p.phase === 'failed' && p.message) toast(p.message, 'error')
})
