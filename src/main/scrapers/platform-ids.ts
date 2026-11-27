// Maps PlayOut platform keys (resources/systems/platform-ids.json) to the numeric platform ids of IGDB,
// ScreenScraper and TheGamesDB, and derives the key and search name a scraper should use for a game.
import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { Game } from '../../shared/types'
import { createLogger } from '../logger'
import { cleanRomTitle } from '../util/text'
import type { ConsoleYears } from './candidate-match'

export type PlatformScraper = 'igdb' | 'screenscraper' | 'thegamesdb'

export interface PlatformIdEntry {
  name?: string
  igdb?: number | null
  screenscraper?: number | null
  thegamesdb?: number | null
  /** The years the console had new games, `[first, last]` (last null while it still has): consoles only. */
  years?: ConsoleYears
  /** Set on entries that only mirror another key (ES-DE folder names such as 'sfc' -> 'snes'). */
  alias?: string
}

export const PLATFORM_IDS_FILE = 'platform-ids.json'
/** Key used for store, manual and other Windows games. */
export const PC_PLATFORM_KEY = 'pc'

const log = createLogger('scrapers:platform-ids')

let configuredDir: string | null = null
let table: Record<string, PlatformIdEntry> | null = null

function moduleDir(): string | null {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return null
  }
}

/** Where to look for the data file: the configured directory, then the source tree, the built bundle and the cwd. */
function candidateDirs(): string[] {
  const dirs: string[] = []
  if (configuredDir) dirs.push(configuredDir)
  const here = moduleDir()
  if (here)
    dirs.push(resolve(here, '../../../resources/systems'), resolve(here, '../../resources/systems'))
  dirs.push(resolve(process.cwd(), 'resources', 'systems'))
  return [...new Set(dirs)]
}

/** Point the loader at the app's resources/systems directory; clears any table loaded before. */
export function configurePlatformIds(dir: string): void {
  configuredDir = dir
  table = null
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase()
}

function parseTable(text: string): Record<string, PlatformIdEntry> {
  const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('expected an object of platform entries')
  const out: Record<string, PlatformIdEntry> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    const num = (field: string): number | null =>
      typeof v[field] === 'number' && Number.isFinite(v[field]) ? (v[field] as number) : null
    const [from, to] = Array.isArray(v.years) ? (v.years as unknown[]) : []
    out[normalizeKey(key)] = {
      name: typeof v.name === 'string' ? v.name : undefined,
      igdb: num('igdb'),
      screenscraper: num('screenscraper'),
      thegamesdb: num('thegamesdb'),
      ...(typeof from === 'number' && Number.isInteger(from)
        ? { years: { from, ...(typeof to === 'number' && to >= from ? { to } : {}) } }
        : {}),
      alias: typeof v.alias === 'string' ? v.alias : undefined
    }
  }
  return out
}

function load(): Record<string, PlatformIdEntry> {
  if (table) return table
  const dirs = candidateDirs()
  for (const dir of dirs) {
    const file = join(dir, PLATFORM_IDS_FILE)
    if (!existsSync(file)) continue
    try {
      table = parseTable(readFileSync(file, 'utf8'))
      log.debug(`loaded ${Object.keys(table).length} platform entries from ${file}`)
      return table
    } catch (err) {
      log.error(`cannot read ${file}: ${(err as Error).message}`)
    }
  }
  log.error(`${PLATFORM_IDS_FILE} not found; looked in ${dirs.join(', ')}`)
  table = {}
  return table
}

/** The scraper's numeric id for a platform key ('snes', 'pc', ...), or undefined when unknown or not mapped. */
export function platformIdFor(scraper: PlatformScraper, platformKey: string): number | undefined {
  const entry = load()[normalizeKey(platformKey)]
  const id = entry?.[scraper]
  return typeof id === 'number' && id > 0 ? id : undefined
}

/** Display name of a platform key from the data file, when known. */
export function platformNameFor(platformKey: string): string | undefined {
  return load()[normalizeKey(platformKey)]?.name
}

/**
 * The years the console of a platform key had new games (undefined for a computer, an arcade board, an engine, or a
 * console the data file gives none for): which of several same-titled games a ROM in that console's folder can be.
 */
export function platformYearsFor(platformKey: string): ConsoleYears | undefined {
  return load()[normalizeKey(platformKey)]?.years
}

/** Every key in the data file (aliases included). */
export function knownPlatformKeys(): string[] {
  return Object.keys(load())
}

/**
 * The platform key a scraper should look up for a game: `extra.platformKey` when the ROM scanner recorded one,
 * the system id for ROMs (system ids follow ES-DE folder names, which the data file also lists), 'pc' otherwise.
 */
export function platformKeyForGame(game: Pick<Game, 'source' | 'platformId' | 'extra'>): string {
  const explicit = game.extra?.platformKey
  if (typeof explicit === 'string' && explicit.trim()) return normalizeKey(explicit)
  if (game.source !== 'rom') return PC_PLATFORM_KEY
  return normalizeKey(game.platformId) || PC_PLATFORM_KEY
}

/**
 * The name to search for: an explicit query, else the user's title override or the game title with ROM tags
 * such as "(USA)" / "[!]" and trademark symbols removed.
 */
export function searchNameFor(
  game: Pick<Game, 'title'> & Partial<Pick<Game, 'user'>>,
  query?: string
): string {
  const explicit = query?.trim()
  if (explicit) return explicit
  const base = game.user?.titleOverride?.trim() || game.title.trim()
  const cleaned = cleanRomTitle(base, false).title.replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim()
  return cleaned || base
}
