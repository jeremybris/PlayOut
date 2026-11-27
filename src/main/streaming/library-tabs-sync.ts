// The Library tabs kept the same on paired PCs (Settings › Streaming › "Sync Library tabs with the host / clients").
// Each PC keeps a small document next to its settings (userData/library-tabs-sync.json): its tabs (without their
// search text, which stays per PC), when they were last changed by the user here or on another PC, and by which PC.
// A client sends its document to each paired host (POST /v1/library-tabs) and gets the host's back, on its regular
// refresh and two seconds after a tab change; on both sides the newest document wins and replaces the tabs (a tie
// goes to the host, so a fresh client never overwrites its host's tabs, unless the client already took another
// host's copy). The host keeps the newest document it has seen, so a change made on one client reaches the host and
// then every other client.
//
// Only a change the user makes stamps the document: restoring the tabs, the renderer's first-run tabs, a migration or
// applying another PC's copy do not (they are either the same tabs once normalized, or adopted with the old time).
//
// A copy with no tabs has no say (it never replaces tabs), and a copy with a tab this PC cannot read (a newer
// PlayOut's filter or sort) is refused whole, so PCs on different versions never lose tabs to each other.

import { promises as fs } from 'fs'
import { dirname } from 'path'
import type { LibraryTabDef, Settings } from '../../shared/types'
import type { Logger } from '../logger'
import { libraryTabDefSchema, MAX_LIBRARY_TABS } from '../store/settings-schema'
import { readJson, renameRetry } from '../util/fs'

/** A PC's synced Library tabs. */
export interface LibraryTabsDoc {
  v: 1
  /** The tabs, without their search text (`query`). */
  tabs: LibraryTabDef[]
  /** When the user last changed them (ISO, the clock of the PC that keeps this copy). */
  updatedAt: string
  /** The PC whose change this is (its streaming identity). */
  by: string
}

/** The time of tabs never changed since the sync came (a new install, an upgrade): any edited copy beats it. */
export const NEVER_EDITED = '1970-01-01T00:00:00.000Z'
/** Times before this are "never edited" (NEVER_EDITED): not clock-corrected. */
const EDITED_AFTER_MS = Date.UTC(2000, 0, 1)
/** Largest document taken or sent (JSON). The host's request cap is set from it. */
export const MAX_TABS_DOC_BYTES = 256 * 1024
/** A copy dated further ahead than this (on this PC's clock) is refused: a wrong clock must not win forever. */
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000
const DEVICE_ID = /^[\w-]{1,128}$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Tabs as settings.json keeps them, repaired entry by entry like normalizeSettings (a malformed tab is dropped, a
 * repeated id keeps its first, at most MAX_LIBRARY_TABS), with their search text removed. Filters naming platforms,
 * stores or systems this PC does not have are kept as they are. Null when `raw` is not a list.
 */
export function syncedTabs(raw: unknown): LibraryTabDef[] | null {
  if (!Array.isArray(raw)) return null
  const seen = new Set<string>()
  const out: LibraryTabDef[] = []
  for (const entry of raw) {
    const parsed = libraryTabDefSchema.safeParse(entry)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    const tab = { ...(parsed.data as LibraryTabDef) }
    delete tab.query
    out.push(tab)
    if (out.length === MAX_LIBRARY_TABS) break
  }
  return out
}

/** Whether two tab lists are the same once normalized (search text ignored). */
export function sameTabs(a: unknown, b: unknown): boolean {
  return JSON.stringify(syncedTabs(a) ?? []) === JSON.stringify(syncedTabs(b) ?? [])
}

const timeOf = (doc: LibraryTabsDoc): number => Date.parse(doc.updatedAt)
const neverEdited = (ms: number): boolean => ms < EDITED_AFTER_MS

/**
 * Another PC's document, checked: null when it is not one (wrong shape, too large, a bad time or id, not a list of
 * tabs), or when any of its tabs cannot be read here (a newer PlayOut's filter or sort: taking the rest would delete
 * those tabs on every PC). `skewMs` is the other PC's clock minus this PC's; `nowMs` this PC's time.
 */
export function parseTabsDoc(raw: unknown, nowMs: number, skewMs = 0): LibraryTabsDoc | null {
  if (!isObject(raw) || raw.v !== 1) return null
  let size: number
  try {
    size = Buffer.byteLength(JSON.stringify(raw))
  } catch {
    return null
  }
  if (size > MAX_TABS_DOC_BYTES) return null
  if (typeof raw.by !== 'string' || !DEVICE_ID.test(raw.by)) return null
  if (typeof raw.updatedAt !== 'string' || raw.updatedAt.length > 40) return null
  const t = Date.parse(raw.updatedAt)
  if (!Number.isFinite(t) || t < 0) return null
  if (!Array.isArray(raw.tabs) || raw.tabs.length > MAX_LIBRARY_TABS * 2) return null
  if (!raw.tabs.every((entry) => libraryTabDefSchema.safeParse(entry).success)) return null
  const tabs = syncedTabs(raw.tabs)
  if (!tabs) return null
  // On this PC's clock (an untouched copy keeps its never-edited time).
  const local = neverEdited(t) ? t : Math.round(t - skewMs)
  if (local > nowMs + MAX_FUTURE_MS) return null
  return { v: 1, tabs, updatedAt: new Date(local).toISOString(), by: raw.by }
}

/**
 * Which copy wins: 'theirs' when the other PC's (already on this PC's clock, parseTabsDoc) is newer, or as new and it
 * is this PC's host while this PC's copy is its own (`mineIsOwn`: not one already taken from another PC, so a client
 * of two hosts keeps the first host's copy instead of taking each in turn); otherwise 'mine'. A copy without tabs
 * never wins, and loses to any copy with tabs. Copies with the same tabs never need a change ('same').
 */
export function pickTabsDoc(
  mine: LibraryTabsDoc,
  theirs: LibraryTabsDoc,
  theirsIsHost: boolean,
  mineIsOwn = true
): 'mine' | 'theirs' | 'same' {
  if (sameTabs(mine.tabs, theirs.tabs)) return 'same'
  if (theirs.tabs.length === 0) return 'mine'
  if (mine.tabs.length === 0) return 'theirs'
  const a = timeOf(mine)
  const b = timeOf(theirs)
  if (b > a) return 'theirs'
  if (b === a && theirsIsHost && mineIsOwn) return 'theirs'
  return 'mine'
}

export interface LibraryTabsSyncDeps {
  /** userData/library-tabs-sync.json. */
  file: string
  settings: { get(): Settings; onChange(listener: (settings: Settings) => void): () => void }
  /** Replace this PC's Library tabs (settings ui.libraryTabs; the renderer gets them by its settings event). */
  apply(tabs: LibraryTabDef[]): void
  /** This PC's streaming identity (the document's `by`). */
  deviceId(): string
  log: Logger
  now?: () => number
}

export interface LibraryTabsSync {
  /** Read the document (or create it from the current tabs, never edited). Before anything else. */
  load(): Promise<void>
  /** This PC's document, to send (null before load). */
  doc(): LibraryTabsDoc | null
  /**
   * Another PC's document (unchecked): taken when it wins (pickTabsDoc), replacing this PC's tabs. `skewMs` is that
   * PC's clock minus this one's. Returns whether this PC's tabs changed.
   */
  offer(raw: unknown, from: { name: string; isHost: boolean; skewMs?: number }): boolean
  /** Called (after the change is stored) when the user changes the tabs on this PC. */
  onLocalChange(listener: () => void): () => void
  /** Write a pending document now. */
  flush(): Promise<void>
  dispose(): void
}

export function createLibraryTabsSync(deps: LibraryTabsSyncDeps): LibraryTabsSync {
  const now = deps.now ?? Date.now
  const { log } = deps
  let doc: LibraryTabsDoc | null = null
  let applying = false
  const listeners = new Set<() => void>()
  let off: (() => void) | null = null
  let writing: Promise<void> = Promise.resolve()
  let dirty = false
  const myId = (): string => deps.deviceId() || 'local'

  function save(): void {
    dirty = true
    writing = writing
      .then(async () => {
        if (!dirty || !doc) return
        dirty = false
        await fs.mkdir(dirname(deps.file), { recursive: true })
        const tmp = `${deps.file}.${process.pid}.tmp`
        await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8')
        await renameRetry(tmp, deps.file)
      })
      .catch((err) => log.warn(`saving the synced Library tabs: ${String(err)}`))
  }

  function localChange(settings: Settings): void {
    if (applying || !doc) return
    const tabs = syncedTabs(settings.ui.libraryTabs) ?? []
    if (sameTabs(tabs, doc.tabs)) return
    const t = timeOf(doc)
    // The renderer's first tabs (built from the platforms when there were none; the last tab cannot be removed):
    // adopted as never edited, not an edit, so a new PC takes the other PCs' tabs instead of overwriting them.
    if (doc.tabs.length === 0) {
      doc = { v: 1, tabs, updatedAt: NEVER_EDITED, by: myId() }
      save()
      return
    }
    // Strictly after the last change kept (another PC's clock may have dated it a moment ahead).
    const stamp = Math.max(now(), t + 1)
    doc = { v: 1, tabs, updatedAt: new Date(stamp).toISOString(), by: myId() }
    save()
    for (const l of listeners) {
      try {
        l()
      } catch (err) {
        log.warn(`Library tabs change listener: ${String(err)}`)
      }
    }
  }

  return {
    async load() {
      const saved = await readJson<unknown>(deps.file).catch(() => null)
      // A saved copy is this PC's own: no clock correction, and no future limit beyond the usual.
      const parsed = parseTabsDoc(saved, now())
      if (parsed) doc = parsed
      else {
        doc = {
          v: 1,
          tabs: syncedTabs(deps.settings.get().ui.libraryTabs) ?? [],
          updatedAt: NEVER_EDITED,
          by: myId()
        }
        save()
      }
      off?.()
      off = deps.settings.onChange(localChange)
      // A change made while the file was read.
      localChange(deps.settings.get())
    },

    doc: () => doc,

    offer(raw, from) {
      if (!doc) return false
      const theirs = parseTabsDoc(raw, now(), from.skewMs ?? 0)
      if (!theirs) {
        log.debug(`ignored ${from.name}'s Library tabs: not a valid copy (or from a newer PlayOut)`)
        return false
      }
      const pick = pickTabsDoc(doc, theirs, from.isHost, doc.by === myId())
      // Never an empty list (pickTabsDoc already refuses one).
      if (pick !== 'theirs' || theirs.tabs.length === 0) return false
      // Kept with its own time: a tie taken from one host stays a tie for this PC's other hosts, which keep theirs.
      const kept = theirs
      // This PC's search text of each tab stays.
      const queries = new Map(
        (deps.settings.get().ui.libraryTabs ?? []).map((t) => [t.id, t.query] as const)
      )
      const tabs = kept.tabs.map((t) => {
        const query = queries.get(t.id)
        return query ? { ...t, query } : { ...t }
      })
      doc = kept
      applying = true
      try {
        deps.apply(tabs)
      } finally {
        applying = false
      }
      save()
      log.info(
        `Library tabs taken from ${from.name} (${tabs.length} tabs, changed ${kept.updatedAt})`
      )
      return true
    },

    onLocalChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    flush: () => writing,

    dispose() {
      off?.()
      off = null
      listeners.clear()
    }
  }
}
