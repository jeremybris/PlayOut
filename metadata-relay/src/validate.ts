/**
 * Strict validation of a suggestion sent by PlayOut (POST /suggest).
 *
 * Only the editable metadata fields are accepted (the app's MetadataEdit, src/shared/metadata-edit.ts): anything
 * else, a wrong type, an over-long value or HTML/script-like text makes the whole request fail. A field set to
 * `null` asks for that field to be removed from the cloud record (back to what the scrapers find).
 */

import { isShardPath } from './database'
import {
  GAME_DB_MAX_ROWS_PER_REQUEST,
  gameDbRowProblem,
  gameDbShardPath,
  type GameDbRow
} from './database-format'
import { DB_PLATFORMS } from './platforms'
import { RECOMP_CONSOLES } from './recomp-consoles'

export const MAX_BODY_BYTES = 64 * 1024

export type ControllerSupport = 'full' | 'partial' | 'none'
export type VrSupport = 'only' | 'supported' | 'none'
export type ReviewSource = 'steam' | 'igdb'
export type Difficulty = '' | 'story' | 'easy' | 'medium' | 'hard' | 'impossible'

/**
 * The app's MetadataEdit, plus `null` per field. An empty value ('' / [] / 0 / no times / no score) is a real
 * correction: "the game has none".
 */
export interface MetadataFields {
  title?: string | null
  description?: string | null
  shortDescription?: string | null
  /** 'YYYY-MM-DD', 'YYYY-MM', 'YYYY' or '' (no date). */
  releaseDate?: string | null
  developers?: string[] | null
  publishers?: string[] | null
  genres?: string[] | null
  tags?: string[] | null
  /** Most local players; 0 = none shown. */
  localPlayers?: number | null
  /**
   * The controls badge. `touch` = touch screen support, `keyboard` = full mouse and keyboard support alongside a
   * controller: each only present when true (a false one is dropped).
   */
  controls?: {
    controller: ControllerSupport
    vr: VrSupport
    touch?: boolean
    keyboard?: boolean
  } | null
  /** HowLongToBeat hours; a time left out has none. */
  hltb?: { main?: number; extra?: number; completionist?: number; solo?: number } | null
  reviewScore?: { score?: number; source?: ReviewSource } | null
  /** Filters > Difficulty's level; '' = Default (no pick: Medium). */
  difficulty?: Difficulty | null
}

/** Fields as stored in games/<key>.json (no nulls: a removed field is simply absent). */
export type StoredFields = { [K in keyof MetadataFields]?: Exclude<MetadataFields[K], null> }

export interface Suggestion {
  key: string
  title: string
  fields: MetadataFields
  appVersion: string
  clientId: string
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * gameMetadataKey's forms (steam-<appid>, <store>-<id>, <systemId>-<serial|title>, <normalized title>): lowercase
 * a-z 0-9 . _ -, starting and ending with a letter, digit or '_', no '..'.
 */
const KEY_RE = /^[a-z0-9_](?:[a-z0-9._-]*[a-z0-9_])?$/
const STEAM_KEY_RE = /^steam-[1-9][0-9]{0,9}$/
const MAX_KEY = 250
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const APP_VERSION_RE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(?:[-+][0-9A-Za-z.-]{1,20})?$/
// The same rule as PlayOut's own check (src/main/metadata-edits/schema.ts) and the repository's schema
// (metadata-repo/schema.json 'releaseDate'): change the three together. '' (no date) is let through below.
const RELEASE_DATE_RE = /^[0-9]{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12][0-9]|3[01]))?)?$/

/** Tags (`<p`, `</div`, `<!--`, `<?php`), script URLs and control characters other than \t \n \r. */
const UNSAFE_TEXT: RegExp[] = [
  // No whitespace allowed after '<' in a tag, so plain text such as "a < b" passes.
  /<[a-zA-Z/!?]/,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*text\/html/i,
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
]

export function isValidKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY) return false
  if (!KEY_RE.test(key) || key.includes('..')) return false
  // A Steam key must carry a numeric app id.
  if (key.startsWith('steam-') && !STEAM_KEY_RE.test(key)) return false
  return true
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkText(
  name: string,
  v: unknown,
  max: number,
  opts: { multiline?: boolean; allowEmpty?: boolean } = {}
): string {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
  const s = v.trim()
  if (s.length === 0 && !opts.allowEmpty) throw new Error(`${name} must not be empty`)
  if (s.length > max) throw new Error(`${name} is longer than ${max} characters`)
  if (!opts.multiline && /[\r\n]/.test(s)) throw new Error(`${name} must be a single line`)
  if (UNSAFE_TEXT.some((re) => re.test(s))) {
    throw new Error(`${name} contains HTML or script-like text`)
  }
  return s
}

function checkList(name: string, v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) throw new Error(`${name} must be a list`)
  if (v.length > maxItems) throw new Error(`${name} has more than ${maxItems} entries`)
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of v) {
    const s = checkText(`${name} entry`, item, maxLen)
    const k = s.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

function checkNumber(name: string, v: unknown, min: number, max: number, integer: boolean): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`)
  if (integer && !Number.isInteger(v)) throw new Error(`${name} must be a whole number`)
  if (v < min || v > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return integer ? v : Math.round(v * 100) / 100
}

function checkObject(
  name: string,
  v: unknown,
  allowed: readonly string[]
): Record<string, unknown> {
  if (!isPlainObject(v)) throw new Error(`${name} must be an object`)
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) throw new Error(`${name}.${k} is not an editable field`)
  }
  return v
}

function checkBoolean(name: string, v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error(`${name} must be true or false`)
  return v
}

function checkEnum<T extends string>(name: string, v: unknown, values: readonly T[]): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw new Error(`${name} must be one of ${values.join(', ')}`)
  }
  return v as T
}

type FieldValidator = (v: unknown) => unknown

const HLTB_KEYS = ['main', 'extra', 'completionist', 'solo'] as const
const CONTROLLER = ['full', 'partial', 'none'] as const
const VR = ['only', 'supported', 'none'] as const
const REVIEW_SOURCES = ['steam', 'igdb'] as const
const DIFFICULTIES = ['', 'story', 'easy', 'medium', 'hard', 'impossible'] as const

/** One entry per editable field (the app's METADATA_EDIT_FIELDS). Extend both together. */
const FIELD_VALIDATORS: { [K in keyof MetadataFields]-?: FieldValidator } = {
  title: (v) => checkText('title', v, 200),
  description: (v) => checkText('description', v, 20_000, { multiline: true, allowEmpty: true }),
  shortDescription: (v) =>
    checkText('shortDescription', v, 1_000, { multiline: true, allowEmpty: true }),
  releaseDate: (v) => {
    const s = checkText('releaseDate', v, 10, { allowEmpty: true })
    if (s !== '' && !RELEASE_DATE_RE.test(s)) {
      throw new Error('releaseDate must be YYYY, YYYY-MM or YYYY-MM-DD')
    }
    return s
  },
  developers: (v) => checkList('developers', v, 20, 100),
  publishers: (v) => checkList('publishers', v, 20, 100),
  genres: (v) => checkList('genres', v, 20, 60),
  tags: (v) => checkList('tags', v, 30, 60),
  localPlayers: (v) => checkNumber('localPlayers', v, 0, 64, true),
  controls: (v) => {
    const o = checkObject('controls', v, ['controller', 'vr', 'touch', 'keyboard'])
    const out: NonNullable<MetadataFields['controls']> = {
      controller: checkEnum('controls.controller', o.controller, CONTROLLER),
      vr: checkEnum('controls.vr', o.vr, VR)
    }
    // Touch screen / full mouse and keyboard support: stored only when true.
    if (o.touch !== undefined && checkBoolean('controls.touch', o.touch)) out.touch = true
    if (o.keyboard !== undefined && checkBoolean('controls.keyboard', o.keyboard))
      out.keyboard = true
    return out
  },
  hltb: (v) => {
    const o = checkObject('hltb', v, HLTB_KEYS)
    const out: Record<string, number> = {}
    for (const k of HLTB_KEYS) {
      if (o[k] !== undefined) out[k] = checkNumber(`hltb.${k}`, o[k], 0, 10_000, false)
    }
    return out
  },
  reviewScore: (v) => {
    const o = checkObject('reviewScore', v, ['score', 'source'])
    const out: { score?: number; source?: ReviewSource } = {}
    if (o.score !== undefined) out.score = checkNumber('reviewScore.score', o.score, 0, 100, false)
    if (o.source !== undefined)
      out.source = checkEnum('reviewScore.source', o.source, REVIEW_SOURCES)
    return out
  },
  difficulty: (v) => checkEnum('difficulty', v, DIFFICULTIES)
}

export const EDITABLE_FIELDS = Object.keys(FIELD_VALIDATORS) as (keyof MetadataFields)[]

export function validateFields(input: unknown): Validated<MetadataFields> {
  if (!isPlainObject(input)) return { ok: false, error: 'fields must be an object' }
  const keys = Object.keys(input)
  if (keys.length === 0) return { ok: false, error: 'fields must not be empty' }
  const out: Record<string, unknown> = {}
  try {
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(FIELD_VALIDATORS, k)) {
        throw new Error(`${k} is not an editable field`)
      }
      const validator = (FIELD_VALIDATORS as Record<string, FieldValidator>)[k]
      const v = input[k]
      out[k] = v === null ? null : validator(v)
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true, value: out as MetadataFields }
}

/** Validates the raw body text of POST /suggest. */
export function validateSuggestion(bodyText: string): Validated<Suggestion> {
  if (new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) {
    return { ok: false, error: 'request is larger than 64 KB' }
  }
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return { ok: false, error: 'request is not valid JSON' }
  }
  if (!isPlainObject(body)) return { ok: false, error: 'request must be a JSON object' }
  for (const k of Object.keys(body)) {
    if (!['key', 'title', 'fields', 'appVersion', 'clientId'].includes(k)) {
      return { ok: false, error: `unknown property ${k}` }
    }
  }
  if (!isValidKey(body.key)) return { ok: false, error: 'key is not a valid game key' }
  let title: string
  try {
    title = checkText('title', body.title, 200)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  if (typeof body.appVersion !== 'string' || !APP_VERSION_RE.test(body.appVersion)) {
    return { ok: false, error: 'appVersion is not a version number' }
  }
  if (typeof body.clientId !== 'string' || !CLIENT_ID_RE.test(body.clientId)) {
    return { ok: false, error: 'clientId is not valid' }
  }
  const fields = validateFields(body.fields)
  if (!fields.ok) return fields
  return {
    ok: true,
    value: {
      key: body.key,
      title,
      fields: fields.value,
      appVersion: body.appVersion,
      clientId: body.clientId
    }
  }
}

/**
 * The suggestion laid over the current cloud fields: a value replaces the whole field (as in the app, an hltb or
 * reviewScore value is complete: a time left out has none), null removes it.
 */
export function mergeFields(current: StoredFields, suggestion: MetadataFields): StoredFields {
  const out: Record<string, unknown> = { ...current }
  for (const [k, v] of Object.entries(suggestion)) {
    if (v === null) delete out[k]
    else out[k] = v
  }
  return out as StoredFields
}

/** The `fields` of a cloud record read from the repo (anything unusable counts as empty). */
export function storedFieldsOf(record: unknown): StoredFields {
  if (!isPlainObject(record) || !isPlainObject(record.fields)) return {}
  return record.fields as StoredFields
}

// ---------------------------------------------------------------------------------------------------------------
// POST /contribute: games for the PlayOut database

/** One row as PlayOut sends it: its GameDbRow (src/shared/game-database.ts gameDbRowOf), as JSON. */
const ROW_PROPERTIES = [
  'key',
  'title',
  'platform',
  'releaseDate',
  'genres',
  'tags',
  'developers',
  'publishers',
  'localPlayers',
  'steamAppId'
] as const

/** Key prefixes of a store's games: their platform is 'pc' (gameDbPlatformOf). */
const PC_KEY_PREFIXES = new Set(['steam', 'gog', 'epic', 'ea', 'ubisoft', 'battlenet', 'xbox'])

/**
 * The key prefix of programs the user added by hand. Their keys are made from the folder names around the program
 * on the user's own disk (gameMetadataKey's manualKeyText), so they are never taken: the database is public and
 * append only, and such a key rarely names the same game on another PC anyway.
 */
const MANUAL_KEY_PREFIX = 'manual'

export interface Contribution {
  clientId: string
  appVersion: string
  /** The rows that may go in the database, each key once, in the order sent. */
  rows: GameDbRow[]
  /** The rows refused, with why. */
  refused: { key: string; error: string }[]
}

/** A row sent as JSON, as a GameDbRow; a missing list reads as empty, a missing number or date as none. */
function rowOf(input: unknown): GameDbRow | string {
  if (!isPlainObject(input)) return 'row must be an object'
  for (const k of Object.keys(input)) {
    if (!(ROW_PROPERTIES as readonly string[]).includes(k)) return `row has unknown property ${k}`
  }
  const text = (name: string, v: unknown, optional: boolean): string | Error =>
    v === undefined && optional
      ? ''
      : typeof v === 'string'
        ? v
        : new Error(`${name} must be a string`)
  const list = (name: string, v: unknown): string[] | Error =>
    v === undefined ? [] : Array.isArray(v) ? (v as string[]) : new Error(`${name} must be a list`)
  const num = (name: string, v: unknown): number | null | Error =>
    v === undefined || v === null
      ? null
      : typeof v === 'number'
        ? v
        : new Error(`${name} must be a number or null`)
  const row = {
    key: text('key', input.key, false),
    title: text('title', input.title, false),
    platform: text('platform', input.platform, false),
    releaseDate: text('releaseDate', input.releaseDate, true),
    genres: list('genres', input.genres),
    tags: list('tags', input.tags),
    developers: list('developers', input.developers),
    publishers: list('publishers', input.publishers),
    localPlayers: num('localPlayers', input.localPlayers),
    steamAppId: num('steamAppId', input.steamAppId)
  }
  for (const v of Object.values(row)) if (v instanceof Error) return v.message
  return row as GameDbRow
}

/**
 * Why a row is refused beyond the format's own checks (gameDbRowProblem): its key must be one gameMetadataKey makes
 * and that the database can store, not an added program's, and fit its platform ('pc' for a store's game, a known
 * ES-DE system for a ROM) and its Steam app.
 */
function contributedRowProblem(row: GameDbRow): string | null {
  const problem = gameDbRowProblem(row)
  if (problem) return problem
  if (!isValidKey(row.key)) return 'key is not a valid game key'
  if (!isShardPath(gameDbShardPath(row.key))) return 'key cannot be stored in the database'
  const prefix = row.key.split('-')[0]
  if (prefix === MANUAL_KEY_PREFIX) return 'added programs are not taken'
  if (!DB_PLATFORMS.has(row.platform)) return 'platform is not one PlayOut knows'
  if (PC_KEY_PREFIXES.has(prefix)) {
    if (row.platform !== 'pc') return `platform of a ${prefix} game must be pc`
  } else if (
    !row.key.startsWith(`${row.platform}-`) &&
    !row.key.startsWith(`rom-${row.platform}-`)
  ) {
    return 'key does not belong to the platform'
  }
  if (prefix === 'steam' && row.steamAppId !== null && `steam-${row.steamAppId}` !== row.key) {
    return 'Steam app id does not match the key'
  }
  return null
}

/** Validates the raw body text of POST /contribute: the request as a whole, then each row on its own. */
export function validateContribution(bodyText: string): Validated<Contribution> {
  if (new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) {
    return { ok: false, error: 'request is larger than 64 KB' }
  }
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return { ok: false, error: 'request is not valid JSON' }
  }
  if (!isPlainObject(body)) return { ok: false, error: 'request must be a JSON object' }
  for (const k of Object.keys(body)) {
    if (!['clientId', 'appVersion', 'rows'].includes(k)) {
      return { ok: false, error: `unknown property ${k}` }
    }
  }
  if (typeof body.appVersion !== 'string' || !APP_VERSION_RE.test(body.appVersion)) {
    return { ok: false, error: 'appVersion is not a version number' }
  }
  if (typeof body.clientId !== 'string' || !CLIENT_ID_RE.test(body.clientId)) {
    return { ok: false, error: 'clientId is not valid' }
  }
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return { ok: false, error: 'rows must be a list of at least one game' }
  }
  if (body.rows.length > GAME_DB_MAX_ROWS_PER_REQUEST) {
    return { ok: false, error: `rows has more than ${GAME_DB_MAX_ROWS_PER_REQUEST} games` }
  }
  const rows: GameDbRow[] = []
  const refused: { key: string; error: string }[] = []
  const seen = new Set<string>()
  for (const input of body.rows) {
    const rawKey = isPlainObject(input) && typeof input.key === 'string' ? input.key : ''
    // Echoed back as sent, but never more of it than a key can be.
    const key = rawKey.slice(0, MAX_KEY)
    const row = rowOf(input)
    const error =
      typeof row === 'string'
        ? row
        : (contributedRowProblem(row) ?? (seen.has(row.key) ? 'is sent twice' : null))
    if (error !== null || typeof row === 'string') {
      refused.push({ key, error: error ?? 'is not a row' })
      continue
    }
    seen.add(row.key)
    rows.push(row)
  }
  return {
    ok: true,
    value: { clientId: body.clientId, appVersion: body.appVersion, rows, refused }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// POST /suggest-recomp: a recompilation added in PlayOut's Recompilations browser

/** A GitHub account name: letters, digits and single dashes inside, at most 39 (PlayOut's own check is the same). */
const GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
/** A GitHub repository name. */
const GH_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const RECOMP_GAME_MAX = 200
const RECOMP_BLURB_MAX = 500

export interface RecompSuggestion {
  owner: string
  repo: string
  game: string
  systemId: string
  /** '' when none was sent. */
  blurb: string
  appVersion: string
  clientId: string
}

/** owner and repo of `https://github.com/<owner>/<repo>` (an optional trailing '/', nothing else); null otherwise. */
export function parseRecompUrl(url: unknown): { owner: string; repo: string } | null {
  if (typeof url !== 'string' || url.length > 200) return null
  const m = /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+)\/?$/.exec(url)
  if (!m) return null
  const [, owner, repo] = m
  if (!GH_OWNER_RE.test(owner) || !GH_REPO_RE.test(repo)) return null
  if (repo === '.' || repo === '..' || /\.git$/i.test(repo)) return null
  return { owner, repo }
}

/** Validates the raw body text of POST /suggest-recomp. */
export function validateRecompSuggestion(bodyText: string): Validated<RecompSuggestion> {
  if (new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) {
    return { ok: false, error: 'request is larger than 64 KB' }
  }
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return { ok: false, error: 'request is not valid JSON' }
  }
  if (!isPlainObject(body)) return { ok: false, error: 'request must be a JSON object' }
  for (const k of Object.keys(body)) {
    if (!['url', 'game', 'systemId', 'blurb', 'appVersion', 'clientId'].includes(k)) {
      return { ok: false, error: `unknown property ${k}` }
    }
  }
  if (typeof body.appVersion !== 'string' || !APP_VERSION_RE.test(body.appVersion)) {
    return { ok: false, error: 'appVersion is not a version number' }
  }
  if (typeof body.clientId !== 'string' || !CLIENT_ID_RE.test(body.clientId)) {
    return { ok: false, error: 'clientId is not valid' }
  }
  const ref = parseRecompUrl(body.url)
  if (!ref) return { ok: false, error: 'url is not https://github.com/<owner>/<repo>' }
  // Only the consoles PlayOut keeps a recompilation for (its all.json parser drops any other).
  if (typeof body.systemId !== 'string' || !RECOMP_CONSOLES.has(body.systemId)) {
    return { ok: false, error: 'systemId is not a system PlayOut knows' }
  }
  try {
    const game = checkText('game', body.game, RECOMP_GAME_MAX)
    const blurb =
      body.blurb === undefined
        ? ''
        : checkText('blurb', body.blurb, RECOMP_BLURB_MAX, { allowEmpty: true })
    // No control character at all, tabs included: PlayOut drops a record that holds one.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(game + blurb)) {
      throw new Error('game and blurb must not contain tabs or control characters')
    }
    return {
      ok: true,
      value: {
        ...ref,
        game,
        systemId: body.systemId,
        blurb,
        appVersion: body.appVersion,
        clientId: body.clientId
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid request' }
  }
}
