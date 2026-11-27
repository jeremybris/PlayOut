// Which recompilations PlayOut has seen in the catalogs, and since when, so the browser (Settings › Recompilations ›
// Browse) can mark the ones a catalog check turned up as new. Only complete checks (every catalog reached) are
// recorded: entries of a catalog that was offline once would otherwise all look new when it came back.

import { promises as fs } from 'fs'
import { dirname } from 'path'

/** A recompilation stays "new" this long after it was first seen. */
export const NEW_FOR_MS = 14 * 24 * 60 * 60 * 1000

export interface SeenFile {
  /** The first complete check: everything seen then was already listed, not new. */
  baseline: string
  /** Entry id -> when it was first seen (ISO). */
  ids: Record<string, string>
}

/** `prev` with the ids not seen before stamped `nowIso` (the first time, everything is the baseline). */
export function recordSeen(prev: SeenFile | null, ids: Iterable<string>, nowIso: string): SeenFile {
  const out: SeenFile = prev
    ? { baseline: prev.baseline, ids: { ...prev.ids } }
    : { baseline: nowIso, ids: {} }
  for (const id of ids) out.ids[id] ??= nowIso
  return out
}

/**
 * `prev` with `ids` counted as known since the baseline (never "new"): the recompilations this PC added itself, once
 * PlayOut's list carries them. Null while nothing was recorded yet (the first complete check makes them all known).
 */
export function recordKnown(prev: SeenFile | null, ids: Iterable<string>): SeenFile | null {
  if (!prev) return null
  const out: SeenFile = { baseline: prev.baseline, ids: { ...prev.ids } }
  for (const id of ids) out.ids[id] = prev.baseline
  return out
}

/** Whether `id` showed up after the baseline, within NEW_FOR_MS of `now`. */
export function isNew(seen: SeenFile | null, id: string, now: Date): boolean {
  const at = seen?.ids[id]
  if (!seen || !at || at <= seen.baseline) return false
  const ms = Date.parse(at)
  return Number.isFinite(ms) && now.getTime() - ms < NEW_FOR_MS && ms <= now.getTime() + 60_000
}

export async function readSeen(file: string): Promise<SeenFile | null> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<SeenFile>
    if (typeof raw.baseline !== 'string' || !raw.ids || typeof raw.ids !== 'object') return null
    const ids: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.ids)) if (typeof v === 'string') ids[k] = v
    return { baseline: raw.baseline, ids }
  } catch {
    return null
  }
}

export async function writeSeen(file: string, seen: SeenFile): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(seen), 'utf8')
  await fs.rename(tmp, file)
}
