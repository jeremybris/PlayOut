import type { PlayOutApi } from '../shared/api'

declare global {
  interface Window {
    /** Present when running inside Electron; absent in the browser (mock API is used instead). */
    playout?: PlayOutApi
  }
}

export {}
