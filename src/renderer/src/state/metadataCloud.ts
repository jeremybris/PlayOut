import type { MetadataCloudStatus, MetadataSuggestion } from '@shared/metadata-cloud'
import { create } from 'zustand'
import { api } from '../api/client'
import { createLog } from '../lib/log'
import { ipcErrorMessage } from './coop'
import { useUiStore } from './ui'

const log = createLog('metadata-cloud')

/**
 * The metadata cloud in the renderer (Settings › Metadata › Cloud metadata): its status, and for the owner the open
 * suggestions. Kept current by 'metadata-cloud:status'; 'metadata-cloud:notice' (an edit published, suggested,
 * queued or refused) becomes a toast wherever the user is. Subscribed once below (App imports this module).
 */
export interface MetadataCloudState {
  status: MetadataCloudStatus | null
  suggestions: MetadataSuggestion[] | null
  suggestionsError: string | null
  loadingSuggestions: boolean
  load: () => Promise<void>
  loadSuggestions: () => Promise<void>
  /** Drop one suggestion from the list after it was approved or rejected. */
  removeSuggestion: (number: number) => void
}

export const useMetadataCloudStore = create<MetadataCloudState>()((set) => ({
  status: null,
  suggestions: null,
  suggestionsError: null,
  loadingSuggestions: false,

  async load() {
    try {
      set({ status: await api.getMetadataCloudStatus() })
    } catch (err) {
      log.error('getMetadataCloudStatus failed', err)
    }
  },

  async loadSuggestions() {
    set({ loadingSuggestions: true, suggestionsError: null })
    try {
      set({ suggestions: await api.listMetadataSuggestions() })
    } catch (err) {
      log.error('listMetadataSuggestions failed', err)
      set({ suggestionsError: ipcErrorMessage(err) })
    } finally {
      set({ loadingSuggestions: false })
    }
  },

  removeSuggestion(number) {
    set((s) => ({ suggestions: s.suggestions?.filter((x) => x.number !== number) ?? null }))
  }
}))

api.on('metadata-cloud:status', (status) => {
  const before = useMetadataCloudStore.getState().status
  useMetadataCloudStore.setState({ status })
  // A token that stopped working hides the list it fed.
  if (before?.owner && !status.owner)
    useMetadataCloudStore.setState({ suggestions: null, suggestionsError: null })
})

api.on('metadata-cloud:notice', ({ kind, message }) => {
  const toast = useUiStore.getState().toast
  if (kind === 'error') toast(message, 'error', 8000)
  else if (kind === 'published' || kind === 'suggested') toast(message, 'success')
  else toast(message, 'info', kind === 'queued' ? 6000 : undefined)
})
