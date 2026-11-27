import type { PlayOutApi } from '@shared/api'
import { createMockApi } from './mock'

function shouldUseMock(): boolean {
  if (typeof window === 'undefined' || !window.playout) return true
  try {
    return new URLSearchParams(window.location.search).get('mock') === '1'
  } catch {
    return false
  }
}

/** True when the in-memory mock backs the UI (browser dev, --mock, screenshots). */
export const isMock = shouldUseMock()

/** The one API instance the whole renderer uses. */
export const api: PlayOutApi = isMock ? createMockApi() : window.playout!
