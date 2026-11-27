// PC Saves' records, <userData>/pc-saves.json: per game (by library id) the save folder the user chose and where its
// copy in the Emulation folder stands. Writes are serialized and land atomically (temp file + rename); a missing or
// damaged file reads as empty (a damaged one is kept aside as pc-saves.json.bad).
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import type { RecompCloudState } from '../../shared/recomp'
import { renameRetry } from '../util/fs'

/** The copy's state: the recompilations' (shared/recomp.ts RecompCloudState), the same three-way rule. */
export type SaveCopyState = RecompCloudState

export interface PcSaveRecord {
  /** The save folder on this PC (absolute). */
  folder: string
  /** The game's stable key (gameMetadataKey), frozen when the folder was first chosen: names its copy folder. */
  key: string
  /** The game's title when the folder was chosen (the copy folder's readable name, meta.json). */
  title: string
  /** The copy folder's name in <Emulation>/PC Saves, once chosen. */
  copyFolder?: string
  /** A copy another PC made for what looks like this game (same title, another key): asked about once. */
  proposed?: { name: string; machine: string; title: string }
  /** Copy folders the user said are not this game's. */
  declined?: string[]
  /** The PC whose saves the copy held at the last copy. */
  copyMachine?: string | null
  state: SaveCopyState
}

export interface PcSavesFile {
  version: 1
  /** The Emulation folder the last-synced hashes refer to (a change forgets them: a difference is then a conflict). */
  savesRoot: string | null
  games: Record<string, PcSaveRecord>
}

export function emptyPcSaves(): PcSavesFile {
  return { version: 1, savesRoot: null, games: {} }
}

export function freshCopyState(): SaveCopyState {
  return {
    enabled: true,
    syncedHash: null,
    localHash: null,
    syncedAt: null,
    pending: false,
    error: null,
    conflict: null
  }
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function normalizeState(v: unknown): SaveCopyState {
  const s = isObject(v) ? v : {}
  const c = isObject(s.conflict) ? s.conflict : null
  return {
    enabled: true,
    syncedHash: str(s.syncedHash),
    localHash: str(s.localHash),
    syncedAt: str(s.syncedAt),
    pending: s.pending === true,
    error: str(s.error),
    conflict:
      c && str(c.localAt) && str(c.cloudAt) && str(c.cloudDevice)
        ? {
            localAt: str(c.localAt)!,
            cloudAt: str(c.cloudAt)!,
            cloudDevice: str(c.cloudDevice)!,
            ...(c.gone === true ? { gone: true } : {})
          }
        : null,
    ...(s.freshStart === true ? { freshStart: true } : {})
  }
}

export function normalizePcSaves(v: unknown): PcSavesFile {
  const out = emptyPcSaves()
  if (!isObject(v)) return out
  out.savesRoot = str(v.savesRoot)
  const games = isObject(v.games) ? v.games : {}
  for (const [id, raw] of Object.entries(games)) {
    if (!isObject(raw)) continue
    const folder = str(raw.folder)
    const key = str(raw.key)
    if (!folder || !key) continue
    const p = isObject(raw.proposed) ? raw.proposed : null
    out.games[id] = {
      folder,
      key,
      title: str(raw.title) ?? key,
      ...(str(raw.copyFolder) ? { copyFolder: str(raw.copyFolder)! } : {}),
      ...(p && str(p.name) && str(p.machine)
        ? { proposed: { name: str(p.name)!, machine: str(p.machine)!, title: str(p.title) ?? '' } }
        : {}),
      ...(Array.isArray(raw.declined)
        ? { declined: raw.declined.filter((d): d is string => typeof d === 'string') }
        : {}),
      copyMachine: str(raw.copyMachine),
      state: normalizeState(raw.state)
    }
  }
  return out
}

export interface PcSavesStore {
  read(): Promise<PcSavesFile>
  /** `fn` mutates the copy it gets; written when it resolves (a throw writes nothing). */
  update(fn: (f: PcSavesFile) => void | Promise<void>): Promise<PcSavesFile>
}

export function createPcSavesStore(file: string): PcSavesStore {
  let cached: PcSavesFile | null = null
  let chain: Promise<unknown> = Promise.resolve()
  async function load(): Promise<PcSavesFile> {
    if (cached) return cached
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      cached = emptyPcSaves()
      return cached
    }
    try {
      cached = normalizePcSaves(JSON.parse(text))
    } catch {
      await fs.copyFile(file, `${file}.bad`).catch(() => undefined)
      cached = emptyPcSaves()
    }
    return cached
  }
  const clone = (f: PcSavesFile): PcSavesFile => JSON.parse(JSON.stringify(f)) as PcSavesFile
  return {
    read() {
      const next = chain.then(async () => clone(await load()))
      chain = next.catch(() => undefined)
      return next
    },
    update(fn) {
      const next = chain.then(async () => {
        const copy = clone(await load())
        await fn(copy)
        await fs.mkdir(dirname(file), { recursive: true })
        const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
        await fs.writeFile(tmp, JSON.stringify(copy, null, 2))
        await renameRetry(tmp, file)
        cached = copy
        return clone(copy)
      })
      chain = next.catch(() => undefined)
      return next
    }
  }
}
