import type { CustomFilter } from './types'

/**
 * The user's own filters (settings.library.customFilters): a game's options menu > Create a filter names one and
 * picks its icon, and puts the game in it; Filters > Custom lists them. Pure helpers shared by main's settings schema
 * and the renderer.
 */

/** Most filters a user keeps. */
export const MAX_CUSTOM_FILTERS = 100
/** Most games one filter holds. */
export const MAX_CUSTOM_FILTER_GAMES = 10_000
/** Longest name. */
export const MAX_CUSTOM_FILTER_NAME = 40
/** Longest game id kept (a manual game's id holds its exe path). */
export const MAX_CUSTOM_FILTER_GAME_ID = 1000
/** Longest key a game is found again by (CustomFilter.gameKeys). */
export const MAX_CUSTOM_FILTER_GAME_KEY = 2000

/**
 * The icons a filter can have, in the picker's order (renderer lib/customFilterIcons.tsx draws each with its lucide
 * icon in its own colour).
 */
export const CUSTOM_FILTER_ICONS = [
  'star',
  'heart',
  'bookmark',
  'flame',
  'trophy',
  'crown',
  'gem',
  'rocket',
  'sword',
  'shield',
  'skull',
  'ghost',
  'puzzle',
  'gamepad',
  'joystick',
  'car',
  'plane',
  'music',
  'book',
  'coffee',
  'moon',
  'sun',
  'leaf',
  'zap',
  'target',
  'flag',
  'map',
  'globe',
  'users',
  'baby',
  'clock',
  'calendar',
  'tag',
  'sparkles',
  'snowflake',
  'mountain',
  'dices',
  'brain',
  'bomb',
  'cat'
] as const
export type CustomFilterIcon = (typeof CUSTOM_FILTER_ICONS)[number]

/** The icon of a filter saved with one this version does not know. */
export const DEFAULT_CUSTOM_FILTER_ICON: CustomFilterIcon = 'star'

export function isCustomFilterIcon(icon: unknown): icon is CustomFilterIcon {
  return typeof icon === 'string' && (CUSTOM_FILTER_ICONS as readonly string[]).includes(icon)
}

/** A known icon as it is, anything else the default. */
export function customFilterIcon(icon: unknown): CustomFilterIcon {
  return isCustomFilterIcon(icon) ? icon : DEFAULT_CUSTOM_FILTER_ICON
}

/** A name as it is kept: trimmed, inner runs of spaces made one. */
export function cleanFilterName(name: string): string {
  return name.replace(/\s+/g, ' ').trim()
}

/** Why a name cannot be used: empty, too long, or another filter has it (case-insensitive). */
export type FilterNameProblem = 'empty' | 'tooLong' | 'taken'

/** What is wrong with `name` for a filter (`exceptId`: the filter being renamed), or null when it can be used. */
export function filterNameProblem(
  name: string,
  filters: readonly Pick<CustomFilter, 'id' | 'name'>[],
  exceptId?: string
): FilterNameProblem | null {
  const clean = cleanFilterName(name)
  if (!clean) return 'empty'
  if (clean.length > MAX_CUSTOM_FILTER_NAME) return 'tooLong'
  const lower = clean.toLowerCase()
  if (filters.some((f) => f.id !== exceptId && cleanFilterName(f.name).toLowerCase() === lower))
    return 'taken'
  return null
}

let counter = 0
/** A fresh filter id, unique within a session and across sessions (and not one of `taken`). */
export function newCustomFilterId(
  taken: readonly Pick<CustomFilter, 'id'>[] = [],
  now = Date.now()
): string {
  for (;;) {
    counter = (counter + 1) % 1_000_000
    const id = `cf${now.toString(36)}${counter.toString(36)}`
    if (!taken.some((f) => f.id === id)) return id
  }
}

/**
 * The filters as they are kept: each with a usable id (each once), a cleaned name (cut to the longest; a second
 * filter of the same name gets a number), a known icon and its game ids each once; at most MAX_CUSTOM_FILTERS, each
 * with at most MAX_CUSTOM_FILTER_GAMES games. A malformed entry is dropped, the others kept.
 */
export function normalizeCustomFilters(raw: unknown): CustomFilter[] {
  if (!Array.isArray(raw)) return []
  const out: CustomFilter[] = []
  for (const entry of raw) {
    if (out.length >= MAX_CUSTOM_FILTERS) break
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id.trim() : ''
    if (!id || id.length > 100 || out.some((f) => f.id === id)) continue
    let name =
      typeof e.name === 'string' ? cleanFilterName(e.name).slice(0, MAX_CUSTOM_FILTER_NAME) : ''
    if (!name) continue
    const base = name
    for (let n = 2; filterNameProblem(name, out) === 'taken'; n++) {
      const suffix = ` ${n}`
      name = base.slice(0, MAX_CUSTOM_FILTER_NAME - suffix.length).trimEnd() + suffix
    }
    const ids = Array.isArray(e.gameIds) ? e.gameIds : []
    const gameIds = [
      ...new Set(
        ids.filter(
          (g): g is string =>
            typeof g === 'string' && g.length > 0 && g.length <= MAX_CUSTOM_FILTER_GAME_ID
        )
      )
    ].slice(0, MAX_CUSTOM_FILTER_GAMES)
    const filter: CustomFilter = { id, name, icon: customFilterIcon(e.icon), gameIds }
    const gameKeys = keptGameKeys(e.gameKeys, gameIds)
    if (gameKeys) filter.gameKeys = gameKeys
    out.push(filter)
  }
  return out
}

/** A filter's gameKeys as kept: string keys of ids in `gameIds` only, within MAX_CUSTOM_FILTER_GAME_KEY; null when none. */
export function keptGameKeys(
  raw: unknown,
  gameIds: readonly string[]
): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const ids = new Set(gameIds)
  const out: Record<string, string> = {}
  let any = false
  for (const [id, key] of Object.entries(raw as Record<string, unknown>)) {
    if (!ids.has(id) || typeof key !== 'string' || !key || key.length > MAX_CUSTOM_FILTER_GAME_KEY)
      continue
    out[id] = key
    any = true
  }
  return any ? out : null
}
