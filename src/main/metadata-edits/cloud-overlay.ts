import { isDeepStrictEqual } from 'util'
import type { MetadataEdit } from '../../shared/metadata-edit'
import { safeParseMetadataEdit } from './schema'

export type CloudOverlayListener = (changedKeys: string[]) => void

/**
 * The metadata cloud's corrections in memory: game key (shared/metadata-edit.ts gameMetadataKey) -> fields. The
 * library lays them over the scraped metadata (LibraryService.view) below the user's own edits. The cloud
 * part fills it (from the cached and downloaded all.json) and reflects the owner's own publishes at once with `set`.
 * Every entry is validated: a malformed one is dropped, never shown.
 */
export class MetadataCloudOverlay {
  private entries = new Map<string, MetadataEdit>()
  private readonly listeners = new Set<CloudOverlayListener>()

  /** The cloud's fields for a game key; undefined when it has none. */
  get(key: string | null | undefined): MetadataEdit | undefined {
    return key ? this.entries.get(key) : undefined
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  get size(): number {
    return this.entries.size
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  /** A copy of every entry (key -> fields). */
  all(): Record<string, MetadataEdit> {
    return Object.fromEntries(this.entries)
  }

  /**
   * Replace every entry (a new all.json: `{ <key>: fields }`). Listeners hear the keys that were added, changed or
   * removed; nothing when it is the same. Returns those keys.
   */
  replaceAll(games: Record<string, unknown>): string[] {
    const next = new Map<string, MetadataEdit>()
    for (const [key, raw] of Object.entries(games ?? {})) {
      if (!key || key.length > 300) continue
      const edit = safeParseMetadataEdit(raw)
      if (edit && Object.keys(edit).length) next.set(key, edit)
    }
    const changed: string[] = []
    for (const [key, edit] of next)
      if (!isDeepStrictEqual(this.entries.get(key), edit)) changed.push(key)
    for (const key of this.entries.keys()) if (!next.has(key)) changed.push(key)
    this.entries = next
    if (changed.length) this.notify(changed)
    return changed
  }

  /** Set one game's entry (null or an empty edit removes it). Returns whether anything changed. */
  set(key: string, fields: unknown): boolean {
    if (!key) return false
    const edit = fields == null ? null : safeParseMetadataEdit(fields)
    const before = this.entries.get(key)
    if (!edit || !Object.keys(edit).length) {
      if (!before) return false
      this.entries.delete(key)
    } else {
      if (isDeepStrictEqual(before, edit)) return false
      this.entries.set(key, edit)
    }
    this.notify([key])
    return true
  }

  onChange(listener: CloudOverlayListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(keys: string[]): void {
    for (const listener of this.listeners) {
      try {
        listener(keys)
      } catch (err) {
        console.error('metadata cloud listener failed', err)
      }
    }
  }
}
