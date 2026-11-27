/**
 * The PlayOut database's format (the `database` branch of jeremybris/PlayOut-metadata): each game's stable facts as
 * plain CSV, one row per game, in shards data/<prefix>/<nn>.csv.
 *
 * This is a copy of PlayOut's src/shared/game-database.ts (the row, the columns, the checks, the CSV and the shards),
 * because the relay cannot import the app's code. The two must stay equal: they must accept exactly the same rows,
 * write exactly the same CSV and put a key in the same shard. test/fixtures/game-db-cases.json holds the cases both
 * sides are tested against (test/database-format.test.ts here, src/shared/game-database.relay-parity.test.ts in the
 * app): change the two copies and the cases together.
 */

/** The columns, in file order (the header row). */
export const GAME_DB_COLUMNS = [
  'key',
  'title',
  'platform',
  'release_date',
  'genres',
  'tags',
  'developers',
  'publishers',
  'local_players',
  'steam_appid'
] as const

export type GameDbColumn = (typeof GAME_DB_COLUMNS)[number]

/** One game's row. Lists are kept as arrays here and joined with LIST_SEPARATOR in the file. */
export interface GameDbRow {
  /** PlayOut's gameMetadataKey: the same game on every PC ("steam-570", "ps2-slus20062"). */
  key: string
  title: string
  /** 'pc' for every store's game; a ROM's ES-DE system id ('ps2', 'snes', ...). */
  platform: string
  /** '' or 'YYYY', 'YYYY-MM', 'YYYY-MM-DD'. */
  releaseDate: string
  genres: string[]
  tags: string[]
  developers: string[]
  publishers: string[]
  /** 1-64, or null when unknown. */
  localPlayers: number | null
  /** The game's Steam app, when known (an alias: a GOG or Epic copy finds the Steam copy's row by it). */
  steamAppId: number | null
}

/** Between the values of a list inside one cell ("Action|RPG"). A value may never contain it. */
export const LIST_SEPARATOR = '|'
/** Files are split into this many shards per key prefix, so each stays small (the relay rewrites a whole shard). */
export const GAME_DB_SHARDS = 16
/** At most this many rows in one /contribute request. */
export const GAME_DB_MAX_ROWS_PER_REQUEST = 25

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,159}$/
const PLATFORM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
/** Same rule as RELEASE_DATE_RE in PlayOut's main/metadata-edits/schema.ts. */
export const GAME_DB_RELEASE_DATE_RE =
  /^(?:[0-9]{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12][0-9]|3[01]))?)?)?$/
export const GAME_DB_LIMITS = {
  title: 200,
  value: 100,
  genres: 20,
  tags: 30,
  developers: 20,
  publishers: 20
} as const

/** Control characters (tabs, line breaks, NUL...) and the bidirectional overrides that can disguise text. */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/

/**
 * Whether a cell's text could run as a formula when the CSV is opened in a spreadsheet ("=HYPERLINK(...)",
 * "+cmd", "@SUM"): refused. A leading '-' is allowed only before a letter ("-ERROR-"), never before a digit or a sign,
 * and never with a '(' anywhere after it: spreadsheets read "-HYPERLINK(...)" as the formula =-HYPERLINK(...).
 */
function formulaLike(text: string): boolean {
  if (/^[=+@]/.test(text)) return true
  return /^-(?![\p{L}])/u.test(text) || /^-[^(]*\(/.test(text)
}

/** Why a text value is refused, or null when it is fine. */
function textProblem(text: string, max: number): string | null {
  if (text !== text.trim()) return 'has spaces at the start or end'
  if (!text) return 'is empty'
  if (text.length > max) return `is longer than ${max} characters`
  if (UNSAFE_TEXT.test(text)) return 'has control characters'
  if (text.includes(LIST_SEPARATOR)) return `contains "${LIST_SEPARATOR}"`
  if (formulaLike(text)) return 'starts like a spreadsheet formula'
  return null
}

/** Why a row is refused (the first problem found), or null when it may go in the database. */
export function gameDbRowProblem(row: GameDbRow): string | null {
  if (!KEY_RE.test(row.key)) return 'key is not a game key'
  const title = textProblem(row.title, GAME_DB_LIMITS.title)
  if (title) return `title ${title}`
  if (!PLATFORM_RE.test(row.platform)) return 'platform is not a platform id'
  if (!GAME_DB_RELEASE_DATE_RE.test(row.releaseDate))
    return 'release date is not YYYY, YYYY-MM or YYYY-MM-DD'
  for (const name of ['genres', 'tags', 'developers', 'publishers'] as const) {
    const list = row[name]
    if (!Array.isArray(list)) return `${name} is not a list`
    if (list.length > GAME_DB_LIMITS[name])
      return `${name} has more than ${GAME_DB_LIMITS[name]} values`
    const seen = new Set<string>()
    for (const value of list) {
      if (typeof value !== 'string') return `${name} has a value that is not text`
      const problem = textProblem(value, GAME_DB_LIMITS.value)
      if (problem) return `${name} value ${problem}`
      const lower = value.toLowerCase()
      if (seen.has(lower)) return `${name} lists "${value}" twice`
      seen.add(lower)
    }
  }
  if (
    row.localPlayers !== null &&
    !(Number.isInteger(row.localPlayers) && row.localPlayers >= 1 && row.localPlayers <= 64)
  )
    return 'local players is not a number from 1 to 64'
  if (
    row.steamAppId !== null &&
    !(Number.isInteger(row.steamAppId) && row.steamAppId > 0 && row.steamAppId < 2 ** 31)
  )
    return 'Steam app id is not a positive whole number'
  // A row says something beyond its title and platform, or it is not worth a line.
  const facts =
    row.releaseDate ||
    row.genres.length ||
    row.tags.length ||
    row.developers.length ||
    row.publishers.length ||
    row.localPlayers !== null
  if (!facts) return 'has no facts'
  return null
}

// ---------------------------------------------------------------------------
// Shards
// ---------------------------------------------------------------------------

/** FNV-1a over the key's UTF-8 bytes (32-bit): the same shard on every PC and in the relay. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * The file a key's row lives in: data/<prefix>/<nn>.csv, the prefix being the key's first part ("steam", "gog",
 * "ps2", "rom") and nn one of GAME_DB_SHARDS shards ("00"-"15").
 */
export function gameDbShardPath(key: string): string {
  const prefix = key.split('-')[0] || 'other'
  const shard = String(fnv1a(key) % GAME_DB_SHARDS).padStart(2, '0')
  return `data/${prefix}/${shard}.csv`
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180: comma separated, a cell with a comma, a quote or a line break is quoted, quotes doubled)
// ---------------------------------------------------------------------------

/** One cell as written in the file: quoted when it holds a comma, a quote or a line break. */
export function csvCell(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** The text of one of a row's cells. */
export function gameDbCellOf(row: GameDbRow, column: GameDbColumn): string {
  switch (column) {
    case 'key':
      return row.key
    case 'title':
      return row.title
    case 'platform':
      return row.platform
    case 'release_date':
      return row.releaseDate
    case 'genres':
      return row.genres.join(LIST_SEPARATOR)
    case 'tags':
      return row.tags.join(LIST_SEPARATOR)
    case 'developers':
      return row.developers.join(LIST_SEPARATOR)
    case 'publishers':
      return row.publishers.join(LIST_SEPARATOR)
    case 'local_players':
      return row.localPlayers === null ? '' : String(row.localPlayers)
    case 'steam_appid':
      return row.steamAppId === null ? '' : String(row.steamAppId)
  }
}

/** The row's cells, in GAME_DB_COLUMNS order. */
function cellsOf(row: GameDbRow): string[] {
  return GAME_DB_COLUMNS.map((column) => gameDbCellOf(row, column))
}

/** How rows are ordered in a shard: by key, compared as plain strings. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A whole shard: the header, then the rows sorted by key, each line ending in '\n'. */
export function encodeGameDbCsv(rows: readonly GameDbRow[]): string {
  const sorted = [...rows].sort((a, b) => compareKeys(a.key, b.key))
  const lines = [GAME_DB_COLUMNS.join(','), ...sorted.map((r) => cellsOf(r).map(csvCell).join(','))]
  return lines.join('\n') + '\n'
}

/** The records of a CSV text, each a list of cells (quoted cells unquoted). A BOM is ignored. */
export function parseCsvRecords(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const records: string[][] = []
  let record: string[] = []
  let value = ''
  let quoted = false
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          value += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      value += ch
      i++
      continue
    }
    if (ch === '"' && value === '') {
      quoted = true
      i++
      continue
    }
    if (ch === ',') {
      record.push(value)
      value = ''
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      record.push(value)
      value = ''
      if (record.length > 1 || record[0] !== '') records.push(record)
      record = []
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1
      continue
    }
    value += ch
    i++
  }
  if (value !== '' || record.length) {
    record.push(value)
    if (record.length > 1 || record[0] !== '') records.push(record)
  }
  return records
}

const listOf = (text: string): string[] =>
  text === '' ? [] : text.split(LIST_SEPARATOR).map((v) => v.trim())

const numberOf = (text: string): number | null => {
  if (text.trim() === '') return null
  const n = Number(text)
  return Number.isFinite(n) ? n : NaN
}

/**
 * The valid rows of a shard's CSV, by key. A file's columns are read by its header (columns added later are
 * ignored by older readers; a missing column reads as empty); an invalid row is skipped, never an exception.
 */
export function parseGameDbCsv(text: string): Map<string, GameDbRow> {
  const out = new Map<string, GameDbRow>()
  const records = parseCsvRecords(text)
  const header = records.shift()
  if (!header) return out
  const at = new Map(header.map((name, i) => [name.trim(), i]))
  const get = (record: string[], name: GameDbColumn): string => {
    const i = at.get(name)
    return i === undefined ? '' : (record[i] ?? '')
  }
  for (const record of records) {
    const row: GameDbRow = {
      key: get(record, 'key'),
      title: get(record, 'title'),
      platform: get(record, 'platform'),
      releaseDate: get(record, 'release_date'),
      genres: listOf(get(record, 'genres')),
      tags: listOf(get(record, 'tags')),
      developers: listOf(get(record, 'developers')),
      publishers: listOf(get(record, 'publishers')),
      localPlayers: numberOf(get(record, 'local_players')),
      steamAppId: numberOf(get(record, 'steam_appid'))
    }
    if (gameDbRowProblem(row) === null && !out.has(row.key)) out.set(row.key, row)
  }
  return out
}
