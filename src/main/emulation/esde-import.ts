import { XMLParser } from 'fast-xml-parser'
import { basename, dirname, join, normalize } from 'path'
import type { Game, GameMetadata, MediaKind, SystemDefinition } from '../../shared/types'
import type { Logger } from '../logger'
import { isDirectory, listDir, readTextIfExists, statSafe } from '../util/fs'
import { knownFolders } from '../util/paths'
import type { EsdeImportUpdate } from './types'

export interface EsdeImportOptions {
  /** ROM games of the library (source 'rom'). */
  games: Game[]
  /** System definitions, used to map <altemulator> labels to EmulatorCommand ids. */
  systems?: SystemDefinition[]
  /** settings.library.esdeHome; null = auto-detect %USERPROFILE%\ES-DE. */
  esdeHome: string | null
  romsRoot: string | null
  log: Logger
}

export interface EsdeImportResult {
  updates: EsdeImportUpdate[]
  /** The ES-DE home that was read, or null when none was found. */
  esdeHome: string | null
  /**
   * System id -> EmulatorCommand id for every gamelist whose system-wide <alternativeEmulator> label matches one of
   * the system's commands (the usual way an ES-DE user changes emulator; per-game <altemulator> is the exception).
   * Labels ES-DE marked `<INVALID>` and labels matching no command are left out.
   */
  preferredEmulators: Record<string, string>
}

/** One <game> (or <folder>) element of an ES-DE gamelist.xml, with ES-DE's own value formats. */
export interface EsdeGamelistEntry {
  /** `./relative/path.ext` (forward slashes, relative to the system folder) or an absolute path. */
  path: string
  name?: string
  sortname?: string
  desc?: string
  /** 0..1 */
  rating?: number
  /** YYYYMMDDTHHMMSS */
  releasedate?: string
  developer?: string
  publisher?: string
  genre?: string
  players?: string
  favorite?: boolean
  hidden?: boolean
  completed?: boolean
  kidgame?: boolean
  broken?: boolean
  playcount?: number
  /** Seconds. */
  playtime?: number
  /** YYYYMMDDTHHMMSS */
  lastplayed?: string
  /** ES-DE command label of the per-game alternative emulator. */
  altemulator?: string
}

export interface EsdeGamelist {
  games: EsdeGamelistEntry[]
  folders: EsdeGamelistEntry[]
  /** System-wide alternative emulator label, when set. */
  alternativeEmulator?: string
}

/** ES-DE media folders, in lookup order, for each PlayOut media kind. */
export const ESDE_MEDIA_TYPES: Record<Exclude<MediaKind, 'screenshot' | 'icon'>, string[]> = {
  cover: ['covers', '3dboxes'],
  logo: ['marquees'],
  hero: ['fanart', 'screenshots', 'titlescreens'],
  video: ['videos']
}
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.webp']
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.wmv', '.mov', '.webm', '.m4v']

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) => name === 'game' || name === 'folder',
  parseTagValue: false,
  trimValues: true
})

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'object') return undefined
  const s = String(value).trim()
  return s ? s : undefined
}

function bool(value: unknown): boolean | undefined {
  const s = text(value)?.toLowerCase()
  if (s === undefined) return undefined
  return s === 'true' || s === '1' || s === 'yes'
}

function int(value: unknown): number | undefined {
  const s = text(value)
  if (s === undefined) return undefined
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : undefined
}

function float(value: unknown): number | undefined {
  const s = text(value)
  if (s === undefined) return undefined
  const n = Number.parseFloat(s)
  return Number.isFinite(n) ? n : undefined
}

function entryFrom(raw: Record<string, unknown>): EsdeGamelistEntry | null {
  const path = text(raw.path)
  if (!path) return null
  const entry: EsdeGamelistEntry = { path }
  const assign = <K extends keyof EsdeGamelistEntry>(
    key: K,
    value: EsdeGamelistEntry[K] | undefined
  ): void => {
    if (value !== undefined) entry[key] = value
  }
  assign('name', text(raw.name))
  assign('sortname', text(raw.sortname))
  assign('desc', text(raw.desc))
  assign('rating', float(raw.rating))
  assign('releasedate', text(raw.releasedate))
  assign('developer', text(raw.developer))
  assign('publisher', text(raw.publisher))
  assign('genre', text(raw.genre))
  assign('players', text(raw.players))
  assign('favorite', bool(raw.favorite))
  assign('hidden', bool(raw.hidden))
  assign('completed', bool(raw.completed))
  assign('kidgame', bool(raw.kidgame))
  assign('broken', bool(raw.broken))
  assign('playcount', int(raw.playcount))
  assign('playtime', int(raw.playtime))
  assign('lastplayed', text(raw.lastplayed))
  assign('altemulator', text(raw.altemulator))
  return entry
}

/**
 * Parse an ES-DE gamelist.xml. Tolerates the non-standard second root element <alternativeEmulator> that ES-DE
 * writes before <gameList>.
 */
export function parseGamelist(xml: string): EsdeGamelist {
  const doc = parser.parse(xml.replace(/^\uFEFF/, '')) as Record<string, unknown>
  const list = (doc.gameList ?? {}) as Record<string, unknown>
  const items = (value: unknown): EsdeGamelistEntry[] =>
    (Array.isArray(value) ? value : value ? [value] : [])
      .map((raw) =>
        raw && typeof raw === 'object' ? entryFrom(raw as Record<string, unknown>) : null
      )
      .filter((e): e is EsdeGamelistEntry => e !== null)
  const result: EsdeGamelist = { games: items(list.game), folders: items(list.folder) }
  const alt = (doc.alternativeEmulator ?? list.alternativeEmulator) as
    Record<string, unknown> | undefined
  const label = alt && typeof alt === 'object' ? text(alt.label) : undefined
  if (label) result.alternativeEmulator = label
  return result
}

/** ES-DE datetime (YYYYMMDDTHHMMSS) -> 'YYYY-MM-DD'; the epoch default and malformed values give undefined. */
export function esdeDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T\d{6})?$/)
  if (!match) return undefined
  const [, year, month, day] = match
  if (year === '1970' && month === '01' && day === '01') return undefined
  if (
    Number(year) < 1950 ||
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > 31
  )
    return undefined
  return `${year}-${month}-${day}`
}

/** ES-DE datetime -> ISO 8601 timestamp (local time), or undefined for the '0' / epoch defaults. */
export function esdeTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.trim().match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/)
  if (!match) return undefined
  const [, y, mo, d, h, mi, s] = match
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 1980) return undefined
  return date.toISOString()
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value || value.toLowerCase() === 'unknown') return undefined
  const parts = value
    .split(/\s*[,/]\s*|\s+\/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length ? parts : undefined
}

/**
 * Play state of a gamelist entry: favorite/hidden flags, play count, play time (ES-DE stores seconds), last played
 * and the per-game alternative emulator, matched to one of the system's commands by its ES-DE label.
 */
export function applyPlayState(
  update: EsdeImportUpdate,
  entry: EsdeGamelistEntry,
  system: SystemDefinition | undefined
): void {
  if (entry.favorite) update.favorite = true
  if (entry.hidden) update.hidden = true
  if (entry.playcount !== undefined && entry.playcount > 0) update.playCount = entry.playcount
  if (entry.playtime !== undefined && entry.playtime > 0)
    update.playtimeMinutes = Math.round(entry.playtime / 60)
  const lastPlayed = esdeTimestamp(entry.lastplayed)
  if (lastPlayed) update.lastPlayed = lastPlayed
  if (entry.altemulator && system) {
    const emulatorId = emulatorIdForLabel(system, entry.altemulator)
    if (emulatorId) update.emulatorId = emulatorId
  }
}

/**
 * ES-DE labels its commands like PlayOut does ("Snes9x - Current"); compare case-insensitively ignoring spacing. A
 * label of a command PlayOut merged into another (aliases: "RPCS3 Game Serial (Standalone)") gives the merged one.
 */
export function emulatorIdForLabel(system: SystemDefinition, label: string): string | undefined {
  const key = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const wanted = key(label)
  if (!wanted) return undefined
  return (
    system.emulators.find((e) => key(e.label) === wanted || key(e.id) === wanted) ??
    system.emulators.find((e) => e.aliases?.some((alias) => key(alias) === wanted))
  )?.id
}

/** Metadata fields of a gamelist entry mapped to PlayOut's GameMetadata. */
export function metadataFromEntry(
  entry: EsdeGamelistEntry,
  systemId: string
): Partial<GameMetadata> {
  const metadata: Partial<GameMetadata> = {}
  if (entry.desc) metadata.description = entry.desc
  const releaseDate = esdeDate(entry.releasedate)
  if (releaseDate) metadata.releaseDate = releaseDate
  const developers = splitList(entry.developer)
  if (developers) metadata.developers = developers
  const publishers = splitList(entry.publisher)
  if (publishers) metadata.publishers = publishers
  const genres = splitList(entry.genre)
  if (genres) metadata.genres = genres
  if (entry.players && entry.players.toLowerCase() !== 'unknown') metadata.players = entry.players
  if (entry.rating !== undefined && entry.rating > 0)
    metadata.rating = Math.max(0, Math.min(100, Math.round(entry.rating * 100)))
  if (Object.keys(metadata).length) metadata.sources = { esde: `${systemId}:${entry.path}` }
  return metadata
}

function relativeKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase()
}

function absoluteKey(path: string): string {
  return normalize(path).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Relative path of a ROM below its system folder, from the externalId (`<system folder>/<relative path>`). */
export function relativeRomPath(game: Game): string {
  const parts = game.externalId.replace(/\\/g, '/').split('/')
  return parts.length > 1 ? parts.slice(1).join('/') : parts[0]
}

async function detectEsdeHome(configured: string | null, log: Logger): Promise<string | null> {
  const candidates: string[] = []
  if (configured) candidates.push(configured, join(configured, 'ES-DE'))
  const folders = knownFolders()
  candidates.push(join(folders.userProfile, 'ES-DE'))
  const homeDrive =
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? join(process.env.HOMEDRIVE, process.env.HOMEPATH)
      : null
  if (homeDrive) candidates.push(join(homeDrive, 'ES-DE'))
  for (const dir of [...new Set(candidates.map((c) => normalize(c)))]) {
    if (
      (await isDirectory(join(dir, 'gamelists'))) ||
      (await isDirectory(join(dir, 'downloaded_media')))
    )
      return dir
  }
  if (configured)
    log.warn(
      `no gamelists or downloaded_media folder under the configured ES-DE home ${configured}`
    )
  return null
}

/** `<string name="X" value="Y" />` entries of es_settings.xml that matter for the import. */
export function parseEsdeSettings(xml: string): { mediaDirectory?: string; romDirectory?: string } {
  const read = (name: string): string | undefined => {
    const match = xml.match(new RegExp(`<string\\s+name="${name}"\\s+value="([^"]*)"`, 'i'))
    const value = match?.[1].trim()
    return value ? value.replace(/&amp;/g, '&').replace(/&quot;/g, '"') : undefined
  }
  const out: { mediaDirectory?: string; romDirectory?: string } = {}
  const media = read('MediaDirectory')
  if (media) out.mediaDirectory = media
  const roms = read('ROMDirectory')
  if (roms) out.romDirectory = roms
  return out
}

function expandEsdePath(value: string, esdeHome: string): string {
  const home = dirname(esdeHome)
  let out = value.replace(/^~(?=[\\/]|$)/, home)
  out = out.replace(/%ESPATH%/gi, home)
  return normalize(out)
}

/** Caches one directory listing per media folder so that lookups cost one readdir per folder, not one stat per game. */
class MediaIndex {
  private readonly listings = new Map<string, Promise<Map<string, string>>>()

  constructor(private readonly mediaDir: string) {}

  private listing(dir: string): Promise<Map<string, string>> {
    let pending = this.listings.get(dir)
    if (!pending) {
      pending = listDir(dir).then((entries) => {
        const map = new Map<string, string>()
        for (const e of entries) if (e.isFile()) map.set(e.name.toLowerCase(), e.name)
        return map
      })
      this.listings.set(dir, pending)
    }
    return pending
  }

  /** `<mediaDir>/<system>/<type>/<relDir>/<stem>.<ext>` for the first extension that exists. */
  async find(
    systemId: string,
    type: string,
    relDir: string,
    stem: string,
    extensions: string[]
  ): Promise<string | null> {
    const dir = join(this.mediaDir, systemId, type, relDir)
    const names = await this.listing(dir)
    for (const ext of extensions) {
      const name = names.get(`${stem}${ext}`.toLowerCase())
      if (name) return join(dir, name)
    }
    return null
  }
}

/**
 * Read an existing ES-DE installation: gamelists/<system>/gamelist.xml for metadata and downloaded_media for art,
 * matched to the given ROM games by their path relative to the system folder.
 */
export async function importFromEsde(options: EsdeImportOptions): Promise<EsdeImportResult> {
  const { log } = options
  const esdeHome = await detectEsdeHome(options.esdeHome, log)
  if (!esdeHome) return { updates: [], esdeHome: null, preferredEmulators: {} }

  const settings = parseEsdeSettings(
    (await readTextIfExists(join(esdeHome, 'settings', 'es_settings.xml'))) ?? ''
  )
  const mediaDir = settings.mediaDirectory
    ? expandEsdePath(settings.mediaDirectory, esdeHome)
    : join(esdeHome, 'downloaded_media')
  const esdeRomDir = settings.romDirectory
    ? expandEsdePath(settings.romDirectory, esdeHome)
    : join(dirname(esdeHome), 'ROMs')
  const media = new MediaIndex(mediaDir)
  log.info(`importing from ${esdeHome} (media: ${mediaDir})`)

  const bySystem = new Map<string, Game[]>()
  for (const game of options.games) {
    if (game.source !== 'rom') continue
    const list = bySystem.get(game.platformId) ?? []
    list.push(game)
    bySystem.set(game.platformId, list)
  }

  const systemsById = new Map((options.systems ?? []).map((s) => [s.id, s] as const))
  const updates: EsdeImportUpdate[] = []
  const preferredEmulators: Record<string, string> = {}
  for (const [systemId, games] of bySystem) {
    const gamelistFile = join(esdeHome, 'gamelists', systemId, 'gamelist.xml')
    let entries = new Map<string, EsdeGamelistEntry>()
    const xml = await readTextIfExists(gamelistFile)
    if (xml !== null) {
      try {
        const gamelist = parseGamelist(xml)
        entries = indexEntries(gamelist, systemId, esdeRomDir)
        log.info(`${systemId}: ${gamelist.games.length} gamelist entries`)
        const system = systemsById.get(systemId)
        if (gamelist.alternativeEmulator && system) {
          const label = gamelist.alternativeEmulator
          const emulatorId = label.startsWith('<INVALID>')
            ? undefined
            : emulatorIdForLabel(system, label)
          if (emulatorId) {
            preferredEmulators[systemId] = emulatorId
            log.info(`${systemId}: system-wide alternative emulator '${label}' -> ${emulatorId}`)
          } else {
            log.warn(
              `${systemId}: system-wide alternative emulator '${label}' matches no command; keeping the default`
            )
          }
        }
      } catch (err) {
        log.warn(`${systemId}: could not parse ${gamelistFile}: ${(err as Error).message}`)
      }
    }

    for (const game of games) {
      const rel = relativeRomPath(game)
      const entry =
        entries.get(relativeKey(rel)) ??
        (game.romPath ? entries.get(absoluteKey(game.romPath)) : undefined)
      const metadata = entry ? metadataFromEntry(entry, systemId) : {}

      const isDir =
        game.extra?.directory === true ||
        (game.romPath ? !!(await statSafe(game.romPath))?.isDirectory() : false)
      const fileName = basename(rel.replace(/\\/g, '/'))
      const stem = isDir ? fileName : fileName.replace(/\.[^.]*$/, '')
      const relDir = dirname(rel.replace(/\\/g, '/'))
      const relMediaDir = relDir === '.' ? '' : relDir
      const localMedia: EsdeImportUpdate['localMedia'] = {}
      for (const [kind, types] of Object.entries(ESDE_MEDIA_TYPES) as [
        keyof typeof ESDE_MEDIA_TYPES,
        string[]
      ][]) {
        for (const type of types) {
          const found = await media.find(
            systemId,
            type,
            relMediaDir,
            stem,
            kind === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS
          )
          if (found) {
            localMedia[kind] = found
            break
          }
        }
      }

      if (!Object.keys(metadata).length && !Object.keys(localMedia).length && !entry) continue
      const update: EsdeImportUpdate = { gameId: game.id, metadata, localMedia }
      if (entry?.name) update.title = entry.name
      if (entry) applyPlayState(update, entry, systemsById.get(systemId))
      updates.push(update)
    }
  }
  log.info(`ES-DE import: ${updates.length} of ${options.games.length} games matched`)
  return { updates, esdeHome, preferredEmulators }
}

function indexEntries(
  gamelist: EsdeGamelist,
  systemId: string,
  esdeRomDir: string
): Map<string, EsdeGamelistEntry> {
  const map = new Map<string, EsdeGamelistEntry>()
  for (const entry of gamelist.games) {
    const p = entry.path.trim()
    if (p.startsWith('./') || p.startsWith('.\\')) {
      map.set(relativeKey(p.slice(2)), entry)
      continue
    }
    if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')) {
      map.set(absoluteKey(p), entry)
      // Absolute paths inside the ES-DE system folder also match by relative path.
      const systemDir = absoluteKey(join(esdeRomDir, systemId)) + '\\'
      const abs = absoluteKey(p)
      if (abs.startsWith(systemDir)) map.set(relativeKey(abs.slice(systemDir.length)), entry)
      continue
    }
    map.set(relativeKey(p), entry)
  }
  return map
}
