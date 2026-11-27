import {
  METADATA_EDIT_FIELDS,
  gameMetadataKey,
  type MetadataEdit,
  type MetadataEditField
} from '../../shared/metadata-edit'
import { sameMetadataValue } from '../../shared/metadata-cloud'
import type { Game } from '../../shared/types'
import { JsonStore } from '../store/json-store'
import { safeParseMetadataEdit } from './schema'
import { tMain } from '../i18n'

/**
 * The user's metadata edits of host-only games (a paired host's `remote:` games, which have no record on this PC):
 * userData/remote-metadata-edits.json. LibraryService lays them over the host's metadata (viewRemote) the way a
 * local game's own edit is laid over its scraped metadata: host < cloud < this edit.
 *
 * An edit is stored under a stable identity, the game's cloud key (gameMetadataKey: the same for this game on every
 * host and for this PC's own copy after a download), else `host-game:<the host's id of it>` (no host id in it: a
 * re-paired host keeps its games' edits). The host's ids of the game are kept with it, so a download that comes back
 * under another key still finds it (adopt).
 */

export interface RemoteEditEntry {
  /** The edited fields, the title among them (a host game has no titleOverride of this PC's). */
  edit: MetadataEdit
  /** The hosts' ids of the game (HostGame.id). */
  hostGameIds: string[]
  updatedAt: string
}

export interface RemoteEditsFile {
  version: 1
  games: Record<string, RemoteEditEntry>
}

export type RemoteEditsStore = Pick<JsonStore<RemoteEditsFile>, 'get' | 'set'>

export const emptyRemoteEdits = (): RemoteEditsFile => ({ version: 1, games: {} })

/** The file as read: every entry validated, a malformed one dropped. */
export function normalizeRemoteEdits(raw: unknown): RemoteEditsFile {
  const out = emptyRemoteEdits()
  const games = (raw as { games?: unknown } | null)?.games
  if (!games || typeof games !== 'object') return out
  for (const [key, value] of Object.entries(games as Record<string, unknown>)) {
    if (!key || key.length > 300 || !value || typeof value !== 'object') continue
    const entry = value as Partial<RemoteEditEntry>
    const edit = safeParseMetadataEdit(entry.edit)
    if (!edit || !Object.keys(edit).length) continue
    const ids = Array.isArray(entry.hostGameIds)
      ? entry.hostGameIds.filter((id): id is string => typeof id === 'string' && !!id)
      : []
    out.games[key] = {
      edit,
      hostGameIds: [...new Set(ids)].slice(0, 20),
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : ''
    }
  }
  return out
}

/** The JSON store behind RemoteMetadataEdits (userData/remote-metadata-edits.json). */
export function remoteEditsJsonStore(file: string): JsonStore<RemoteEditsFile> {
  return new JsonStore({
    file,
    defaults: emptyRemoteEdits,
    normalize: normalizeRemoteEdits,
    debounceMs: 400
  })
}

/** The host's id of a `remote:` game (RemoteGameInfo.hostGameId), else its own id. */
function hostGameIdOf(game: Pick<Game, 'id' | 'remote'>): string {
  return game.remote?.hostGameId || game.id
}

/**
 * The store key of a host game's edit: its cloud key, else `host-game:<host's id>`. Null only for a game with
 * neither (never for a real host game).
 */
export function remoteEditKey(
  game: Pick<
    Game,
    'id' | 'remote' | 'source' | 'externalId' | 'platformId' | 'extra' | 'romPath' | 'exePath'
  >
): string | null {
  const key = gameMetadataKey(game)
  if (key) return key
  const id = hostGameIdOf(game)
  return id ? `host-game:${id}` : null
}

/**
 * A host game as its host offers it, as this PC's "scraped" layer: the host owner's name for it (user.titleOverride)
 * is its title here, and it has no user data of this PC's. Returns a copy.
 */
export function hostLayer(game: Game): Game {
  const title = game.user?.titleOverride?.trim()
  return { ...game, ...(title ? { title } : {}), user: {} }
}

/** `edit` with the fields of `fields` (all of them when absent) taken out. */
function without(edit: MetadataEdit, fields?: readonly MetadataEditField[]): MetadataEdit {
  const next: MetadataEdit = { ...edit }
  for (const f of fields ?? METADATA_EDIT_FIELDS) delete next[f]
  return next
}

export class RemoteMetadataEdits {
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly store: RemoteEditsStore,
    private readonly now: () => number = Date.now
  ) {}

  get size(): number {
    return Object.keys(this.store.get().games).length
  }

  /** The stored entry of a host game: by its key, else by the host's id of it. */
  private find(game: Game): [string, RemoteEditEntry] | null {
    const games = this.store.get().games
    const key = remoteEditKey(game)
    if (key && games[key]) return [key, games[key]]
    const hostId = hostGameIdOf(game)
    for (const [k, entry] of Object.entries(games))
      if (entry.hostGameIds.includes(hostId)) return [k, entry]
    return null
  }

  /** The user's edit of a host game (title included); empty when it has none. */
  get(game: Game): MetadataEdit {
    return { ...(this.find(game)?.[1].edit ?? {}) }
  }

  /**
   * Save the user's edit of a host game: each field of `edit` replaces the same field (an empty title removes the
   * title edit); the fields of `clear` lose theirs first. Returns the whole edit afterwards.
   */
  set(game: Game, edit: MetadataEdit, clear?: readonly MetadataEditField[]): MetadataEdit {
    const found = this.find(game)
    let next = clear?.length
      ? without(found?.[1].edit ?? {}, clear)
      : { ...(found?.[1].edit ?? {}) }
    for (const field of METADATA_EDIT_FIELDS) {
      const value = edit[field]
      if (value === undefined) continue
      ;(next as Record<string, unknown>)[field] = value
    }
    if (next.title !== undefined && !next.title.trim()) next = without(next, ['title'])
    return this.write(game, found, next)
  }

  /** Remove the user's edit of `fields` (all of them when absent). Returns the whole edit afterwards. */
  clear(game: Game, fields?: readonly MetadataEditField[]): MetadataEdit {
    const found = this.find(game)
    if (!found) return {}
    return this.write(game, found, without(found[1].edit, fields))
  }

  private write(
    game: Game,
    found: [string, RemoteEditEntry] | null,
    edit: MetadataEdit
  ): MetadataEdit {
    // An entry first stored under `host-game:<id>` (or an older cloud key) moves to the game's cloud key once it has
    // one, so the cloud's confirmation of a published edit (tidy, by that key) finds it.
    const key = gameMetadataKey(game) ?? found?.[0] ?? remoteEditKey(game)
    if (!key) throw new Error(tMain('mainApp.edits.unknownGame'))
    const hostId = hostGameIdOf(game)
    this.store.set((d) => {
      if (found && found[0] !== key) delete d.games[found[0]]
      if (!Object.keys(edit).length) {
        delete d.games[key]
        return
      }
      const ids = new Set(found?.[1].hostGameIds ?? [])
      ids.add(hostId)
      d.games[key] = {
        edit,
        hostGameIds: [...ids].slice(-20),
        updatedAt: new Date(this.now()).toISOString()
      }
    })
    this.notify()
    return { ...edit }
  }

  /**
   * The cloud now carries `fields` under the cloud key `key` (the owner's write, confirmed by all.json): the entry
   * stored under that key drops each field whose value is the same, so later cloud approvals of it are not hidden
   * behind it. Returns the fields dropped.
   */
  tidy(key: string, fields: MetadataEdit): MetadataEditField[] {
    const entry = this.store.get().games[key]
    if (!entry) return []
    const same = METADATA_EDIT_FIELDS.filter(
      (f) =>
        entry.edit[f] !== undefined &&
        fields[f] !== undefined &&
        sameMetadataValue(entry.edit[f], fields[f])
    )
    if (!same.length) return []
    const edit = without(entry.edit, same)
    this.store.set((d) => {
      if (!Object.keys(edit).length) delete d.games[key]
      else if (d.games[key]) d.games[key] = { ...d.games[key], edit }
    })
    this.notify()
    return same
  }

  /**
   * The edit a game this PC just got from a host (a downloaded ROM) takes over: the entry with the same cloud key,
   * else the one that has `hostGameId`. The entry stays (the host's card keeps its edit should it come back).
   */
  forLocal(local: Game, hostGameId?: string): MetadataEdit | null {
    const games = this.store.get().games
    const key = gameMetadataKey(local)
    if (key && games[key]) return { ...games[key].edit }
    if (hostGameId)
      for (const entry of Object.values(games))
        if (entry.hostGameIds.includes(hostGameId)) return { ...entry.edit }
    return null
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (err) {
        console.error('remote metadata edits listener failed', err)
      }
    }
  }
}
