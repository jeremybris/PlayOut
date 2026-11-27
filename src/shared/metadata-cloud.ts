import { difficultyLabel } from './difficulty'
import type { Translate } from './i18n'
import {
  METADATA_EDIT_FIELDS,
  controlsPicks,
  type ControlsEdit,
  type ControlsPick,
  type MetadataEdit,
  type MetadataEditField
} from './metadata-edit'

/**
 * The PlayOut metadata cloud: the public GitHub repository jeremybris/PlayOut-metadata (one games/<key>.json per
 * corrected game, plus all.json, rebuilt by a GitHub Action on every push to main). Every PlayOut downloads all.json
 * without an account (main/metadata-cloud). The owner publishes with a fine-grained token; anyone else's edits are
 * suggested through the relay (metadata-relay/, a Cloudflare Worker that opens pull requests labelled 'suggestion').
 */
export const METADATA_REPO = {
  owner: 'jeremybris',
  repo: 'PlayOut-metadata',
  branch: 'main'
} as const

export const METADATA_REPO_URL = `https://github.com/${METADATA_REPO.owner}/${METADATA_REPO.repo}`

/** The merged file every PlayOut reads. */
export const METADATA_ALL_JSON_URL = `https://raw.githubusercontent.com/${METADATA_REPO.owner}/${METADATA_REPO.repo}/${METADATA_REPO.branch}/all.json`

/** Where the owner creates the fine-grained token (Settings › Metadata links here). */
export const GITHUB_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new'

/** The state of the owner token (Settings › Metadata › Cloud metadata). */
export type MetadataTokenState =
  /** No token saved: this PC suggests its edits. */
  | 'none'
  /** Saved, not checked yet (or the check could not reach GitHub). */
  | 'unchecked'
  /** GitHub accepted it and it may write to the metadata repository: this PC publishes. */
  | 'ok'
  /** GitHub refused it (wrong, expired or revoked). */
  | 'invalid'
  /** Valid, but it cannot write to the metadata repository. */
  | 'no-access'

export interface MetadataCloudStatus {
  /** all.json is being downloaded now. */
  syncing: boolean
  /** The last time all.json was checked successfully (downloaded or unchanged). */
  lastSyncAt: string | null
  /** When the repository last rebuilt all.json (its generatedAt). */
  generatedAt: string | null
  /** The last download error, until a download succeeds. */
  lastError: string | null
  /** Games in the cloud. */
  cloudGames: number
  /** Games of this library the cloud corrects. */
  libraryGames: number
  /** This PC's relay URL (Settings); '' = use the shared one. */
  relayUrl: string
  /** The relay URL the repository announces (config.json -> all.json relayUrl); '' = none yet. */
  sharedRelayUrl: string
  /** Send this PC's edits as suggestions (anyone without the owner token). */
  suggestEdits: boolean
  /** Suggestions saved here, waiting for the relay. */
  queued: number
  /**
   * Why the waiting edits wait, when the suggestion service limited them (it answered 429; see MetadataQueueLimit).
   * null otherwise.
   */
  queueLimit: MetadataQueueLimit | null
  /** When PlayOut next sends the waiting edits (while it waits before sending again); null = no wait. */
  queueNextAt: string | null
  token: {
    state: MetadataTokenState
    /** The GitHub account the token belongs to (after a check). */
    login?: string
    checkedAt?: string
    error?: string
  }
  /** A checked token that can write: edits are published, suggestions can be approved. */
  owner: boolean
}

/**
 * Why waiting suggestions wait (MetadataCloudStatus.queueLimit): 'client' = this PC's suggestions per hour,
 * 'network' = the suggestions per hour from this PC's internet address (or its IPv6 /48), 'service' = everyone's per
 * hour, 'backlog' = too many suggestions wait for the maintainer's review.
 */
export type MetadataQueueLimit = 'client' | 'network' | 'service' | 'backlog'

/**
 * The limit a relay 429 names in its error (metadata-relay index.ts): 'too many suggestions (client|ip|ip48|global);
 * try again later', or 'too many suggestions wait for review; try again later'. Anything else counts as 'service'.
 */
export function relayLimit(error: string): MetadataQueueLimit {
  if (/wait for review/i.test(error)) return 'backlog'
  if (/\(client\)/.test(error)) return 'client'
  if (/\(ip(48)?\)/.test(error)) return 'network'
  return 'service'
}

/**
 * How many suggestions the relay accepts from one PC per clock hour. Not read from the relay: it has to equal
 * RATE_CLIENT_PER_HOUR in metadata-relay/wrangler.toml (what is deployed) and `DEFAULT_RATE_LIMITS.clientPerHour` in
 * metadata-relay/src/ratelimit.ts (the relay's default without it); main/metadata-cloud/relay-limits.test.ts fails
 * when the three disagree.
 */
export const RELAY_SUGGESTIONS_PER_HOUR = 30

/** A clock time as the user reads it ('1:12 AM'); '' when unreadable. */
function clockTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * What the waiting edits wait for while the suggestion service limits them, e.g. '19 edits waiting to be suggested.
 * The suggestion service accepts 30 per hour from one PC; PlayOut sends the rest automatically (next at 1:12 AM).'
 * Both processes show it, so the caller passes its translator: tMain in main, t in the renderer.
 */
export function queueLimitText(
  queued: number,
  limit: MetadataQueueLimit,
  nextAt: string | null,
  t: Translate
): string {
  const time = nextAt ? clockTime(nextAt) : ''
  // Whole sentences per limit, with and without the time, so no language has to glue "(next at ...)" on.
  switch (limit) {
    case 'client':
      return time
        ? t('metadataCloud.queueLimit.clientAt', {
            count: queued,
            perHour: RELAY_SUGGESTIONS_PER_HOUR,
            time
          })
        : t('metadataCloud.queueLimit.client', {
            count: queued,
            perHour: RELAY_SUGGESTIONS_PER_HOUR
          })
    case 'network':
      return time
        ? t('metadataCloud.queueLimit.networkAt', { count: queued, time })
        : t('metadataCloud.queueLimit.network', { count: queued })
    case 'backlog':
      return time
        ? t('metadataCloud.queueLimit.backlogAt', { count: queued, time })
        : t('metadataCloud.queueLimit.backlog', { count: queued })
    default:
      return time
        ? t('metadataCloud.queueLimit.serviceAt', { count: queued, time })
        : t('metadataCloud.queueLimit.service', { count: queued })
  }
}

/** Settings › Metadata › Cloud metadata: what the user can change (a field left out stays as it is). */
export interface MetadataCloudConfigPatch {
  /** '' clears it. Must be https (http only for localhost). */
  relayUrl?: string
  /** The owner's fine-grained token; '' or null removes it. Never sent back to the renderer. */
  token?: string | null
  suggestEdits?: boolean
}

/** One field of a suggestion: the cloud's value now and the suggested one, as text. */
export interface MetadataFieldChange {
  field: MetadataEditField
  label: string
  before: string
  after: string
}

/** An open suggestion (a pull request labelled 'suggestion'), for the owner's Approve / Reject list. */
export interface MetadataSuggestion {
  number: number
  url: string
  /** The PR's title ('Suggestion: Portal 2'). */
  title: string
  /** The game key of the file it changes; null when it changes something other than one games/<key>.json. */
  key: string | null
  /** The game's title (from the suggested file). */
  gameTitle: string
  createdAt: string
  /** The head commit shown here: Approve merges only this head (refused when the pull request moved on since). */
  headSha: string
  /** The fields it changes, main's current value -> suggested value (only what approving would change). */
  changes: MetadataFieldChange[]
  /** Why its changes could not be read (it can still be approved or rejected on GitHub). */
  error?: string
}

/** A publish or suggestion result, shown as a toast ('metadata-cloud:notice'). */
export interface MetadataCloudNotice {
  kind: 'published' | 'suggested' | 'queued' | 'unchanged' | 'error'
  /** The game's title. */
  title: string
  message: string
}

/**
 * A field's name as the Edit sheet and the suggestion list show it, in the caller's language (tMain in main, t in the
 * renderer): it goes into translated sentences, so it must not stay English.
 */
export function metadataFieldLabel(field: MetadataEditField, t: Translate): string {
  switch (field) {
    case 'title':
      return t('metadataCloud.fields.title')
    case 'description':
      return t('metadataCloud.fields.description')
    case 'shortDescription':
      return t('metadataCloud.fields.shortDescription')
    case 'releaseDate':
      return t('metadataCloud.fields.releaseDate')
    case 'developers':
      return t('metadataCloud.fields.developers')
    case 'publishers':
      return t('metadataCloud.fields.publishers')
    case 'genres':
      return t('metadataCloud.fields.genres')
    case 'tags':
      return t('metadataCloud.fields.tags')
    case 'localPlayers':
      return t('metadataCloud.fields.localPlayers')
    case 'controls':
      return t('metadataCloud.fields.controls')
    case 'hltb':
      return t('metadataCloud.fields.hltb')
    case 'reviewScore':
      return t('metadataCloud.fields.reviewScore')
    case 'difficulty':
      return t('metadataCloud.fields.difficulty')
  }
}

/**
 * One Controls pick's name (the Edit sheet's rows); VR reads "VR only" when a headset is needed and nothing else in
 * `picks` plays it (a hand-written `{ vr: 'only', keyboard: true }` reads "Mouse & Keyboard, VR", not "VR only").
 */
function controlsPickText(
  pick: ControlsPick,
  c: ControlsEdit,
  picks: readonly ControlsPick[],
  t: Translate
): string {
  switch (pick) {
    case 'full':
      return t('metadataCloud.values.controlsFull')
    case 'partial':
      return t('metadataCloud.values.controlsPartial')
    case 'keyboard':
      return t('metadataCloud.values.controlsKeyboard')
    case 'vr':
      return c.vr === 'only' &&
        picks.every((p) => p !== 'full' && p !== 'partial' && p !== 'keyboard')
        ? t('metadataCloud.values.vrOnly')
        : t('metadataCloud.values.controlsVr')
    case 'touch':
      return t('metadataCloud.values.controlsTouch')
    case 'lightgun':
      return t('metadataCloud.values.controlsLightgun')
  }
}

/**
 * Controls as text: the names of what the Edit sheet's rows show for them (controlsPicks), in the rows' order
 * ("Full Controller Support, Mouse & Keyboard, VR"). Any controls (scraped ones and older entries too) read as their
 * picks, and two controls with the same picks save the same, so a change always reads as one.
 */
function controlsText(c: ControlsEdit, t: Translate): string {
  const picks = controlsPicks(c)
  return picks.map((pick) => controlsPickText(pick, c, picks, t)).join(', ')
}

const hours = (h: number): string => `${Math.round(h * 10) / 10}`

/**
 * A field's value as one line of text (the suggestion list); '(not set)' when absent, '(none)' when empty. The words
 * around the values are in the caller's language (`t`); the values themselves (names, genres) stay as written.
 */
export function describeMetadataValue(
  edit: MetadataEdit | null | undefined,
  field: MetadataEditField,
  t: Translate
): string {
  const value = edit?.[field]
  if (value === undefined || value === null) return t('metadataCloud.values.notSet')
  const none = t('metadataCloud.values.none')
  switch (field) {
    case 'developers':
    case 'publishers':
    case 'genres':
    case 'tags': {
      const list = value as string[]
      return list.length ? list.join(', ') : none
    }
    case 'localPlayers':
      return (value as number) > 0 ? `${value as number}` : none
    case 'controls': {
      return controlsText(value as ControlsEdit, t)
    }
    case 'hltb': {
      const h = value as NonNullable<MetadataEdit['hltb']>
      const parts: string[] = []
      if (h.main !== undefined)
        parts.push(t('metadataCloud.values.hltbMain', { hours: hours(h.main) }))
      if (h.extra !== undefined)
        parts.push(t('metadataCloud.values.hltbExtra', { hours: hours(h.extra) }))
      if (h.completionist !== undefined)
        parts.push(t('metadataCloud.values.hltbCompletionist', { hours: hours(h.completionist) }))
      if (h.solo !== undefined)
        parts.push(t('metadataCloud.values.hltbSolo', { hours: hours(h.solo) }))
      return parts.length ? parts.join(', ') : none
    }
    case 'reviewScore': {
      const r = value as NonNullable<MetadataEdit['reviewScore']>
      if (r.score === undefined) return none
      return `${r.score}${r.source ? ` (${r.source === 'steam' ? 'Steam' : 'IGDB'})` : ''}`
    }
    case 'difficulty':
      return value
        ? difficultyLabel(value as string)
        : t('metadataCloud.values.defaultDifficulty', { level: difficultyLabel('medium') })
    default: {
      const text = String(value)
      if (!text) return none
      return text.length > 160 ? `${text.slice(0, 157)}...` : text
    }
  }
}

/** Stable JSON for comparing two values (object keys sorted). */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // A controls flag set to false (touch, keyboard) says the same as none.
      .filter(([k, v]) => v !== undefined && !(v === false && (k === 'touch' || k === 'keyboard')))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** Whether two values of a field are the same. */
export function sameMetadataValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b)
}

/** The fields whose value differs between two records, in the Edit sheet's order, as text in `t`'s language. */
export function diffMetadataFields(
  before: MetadataEdit | null | undefined,
  after: MetadataEdit | null | undefined,
  t: Translate
): MetadataFieldChange[] {
  const out: MetadataFieldChange[] = []
  for (const field of METADATA_EDIT_FIELDS) {
    if (sameMetadataValue(before?.[field], after?.[field])) continue
    out.push({
      field,
      label: metadataFieldLabel(field, t),
      before: describeMetadataValue(before, field, t),
      after: describeMetadataValue(after, field, t)
    })
  }
  return out
}

/** `edit`'s fields laid over `base` (each field replaces the whole field, as in PlayOut). */
export function mergeMetadataFields(
  base: MetadataEdit | null | undefined,
  edit: MetadataEdit
): MetadataEdit {
  const out: MetadataEdit = { ...(base ?? {}) }
  for (const field of METADATA_EDIT_FIELDS)
    if (edit[field] !== undefined) (out as Record<string, unknown>)[field] = edit[field]
  return out
}

/**
 * Text the metadata repository refuses (metadata-repo/scripts/validate.mjs and the relay check the same): HTML tags,
 * script URLs and control characters other than tab / newline.
 */
const UNSAFE_TEXT: readonly RegExp[] = [
  /<[a-zA-Z/!?]/,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*text\/html/i,
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
]

/** The fields of `edit` whose text the metadata repository would refuse (empty when it can be shared). */
export function unsafeMetadataFields(edit: MetadataEdit): MetadataEditField[] {
  const bad = (value: unknown): boolean =>
    typeof value === 'string'
      ? UNSAFE_TEXT.some((re) => re.test(value))
      : Array.isArray(value)
        ? value.some(bad)
        : false
  return METADATA_EDIT_FIELDS.filter((field) => bad(edit[field]))
}

/**
 * A relay URL as typed (with or without /suggest or /health, a trailing slash) reduced to its base; null when it is
 * not a usable URL (https only, http only for localhost; no credentials, query or fragment). '' stays ''.
 */
export function normalizeRelayUrl(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return ''
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
  if (url.username || url.password || url.search || url.hash) return null
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(suggest|health)$/i, '')
  return `${url.origin}${path}`
}
