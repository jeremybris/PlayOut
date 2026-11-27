import type { SyncFile } from './scan'

/** What the host sends and receives for the Emulation folder sync (JSON over the host service). */

export interface EmulationManifest {
  /** The host's Emulation folder (a different folder than last time resets what the client remembers). */
  root: string
  /** Its id (FOLDER_ID_FILE): another id than last time resets what the client remembers, like another root. */
  folderId: string
  /** The host's clock when it answered (for the time difference between the PCs). */
  now: number
  files: SyncFile[]
  /** Paths of files there but not readable right now (an emulator has them open): left alone this pass. */
  unsettled: string[]
  /** Links in the host's folder (junctions…): nothing at or under them is synced. */
  linked: string[]
  /**
   * Folders the host leaves out besides roms and texturepacks (its ROM folder inside its Emulation folder): left
   * alone on the client too, so they never read as deleted on the host.
   */
  excluded: string[]
}

export interface EmulationCommit {
  /** The upload the bytes were sent under. */
  id: string
  path: string
  size: number
  hash: string
  /** The file's modified time on the client, kept on the host's copy. */
  mtimeMs: number
  /** The host's copy the client expects to replace (its hash), or null: none. A different one refuses (changed). */
  expect: string | null
  /** Keep the host's copy in its backups first (it lost a conflict). */
  backup?: boolean
}

export interface EmulationDelete {
  path: string
  /** The hash of the host's copy the client expects to delete. */
  expect: string
}

/**
 * Uploads go in pieces this size, each one request: the host gives one request 15 s, so a piece must cross even a
 * slow upload link (0.3 Mbit/s) in that time.
 */
export const UPLOAD_CHUNK_BYTES = 512 * 1024

/** The Emulation folder sync over one host connection (client side), as host-client.ts provides it. */
export interface EmulationTransport {
  manifest(signal?: AbortSignal): Promise<EmulationManifest>
  /** Download one file to `dest` (written fresh). */
  download(path: string, dest: string, signal?: AbortSignal): Promise<void>
  uploadChunk(
    id: string,
    offset: number,
    total: number,
    data: Buffer,
    signal?: AbortSignal
  ): Promise<void>
  commit(commit: EmulationCommit, signal?: AbortSignal): Promise<void>
  remove(request: EmulationDelete, signal?: AbortSignal): Promise<void>
}
