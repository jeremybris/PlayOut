// The recompilations the user added in the browser (RecompBrowser's Add): userData/recomp-added.json
// { version: 1, entries: AddedRecomp[] }, written atomically. Kept out of recomps.json on purpose: its parser
// (state.ts parseRecompManifest) keeps only the fields it knows, so an older PlayOut would drop them when it saves.
// Whatever the file holds is reduced to valid entries; a damaged one is dropped, never an exception.
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { AddedRecomp, AddedRecompState } from '../../shared/recomp'
import { GITHUB_OWNER_RE, GITHUB_REPO_RE, repoKey } from './catalog'
import { isRecompConsole } from './consoles'

export const ADDED_FILE = 'recomp-added.json'
/** At most this many added recompilations are kept (the newest). */
export const MAX_ADDED = 500
export const MAX_GAME_CHARS = 200
export const MAX_BLURB_CHARS = 500

const STATES: readonly AddedRecompState[] = ['local', 'queued', 'suggested', 'published']

export interface AddedFile {
  version: 1
  entries: AddedRecomp[]
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** One line of plain text, at most `max` characters; '' when there is none. */
export function oneLine(text: unknown, max: number): string {
  if (typeof text !== 'string') return ''
  const flat = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** A stored entry, or null when it is not a valid one. */
export function parseAddedEntry(raw: unknown): AddedRecomp | null {
  if (!isObject(raw)) return null
  const repo = typeof raw.repo === 'string' ? raw.repo : ''
  const [owner = '', name = ''] = repo.split('/')
  if (repo.split('/').length !== 2 || !GITHUB_OWNER_RE.test(owner) || !GITHUB_REPO_RE.test(name))
    return null
  if (name === '.' || name === '..') return null
  const id = repoKey('github', repo)
  if (raw.id !== id) return null
  const game = oneLine(raw.game, MAX_GAME_CHARS)
  if (!game || !isRecompConsole(raw.systemId)) return null
  const addedAt =
    typeof raw.addedAt === 'string' && !Number.isNaN(Date.parse(raw.addedAt))
      ? raw.addedAt
      : new Date(0).toISOString()
  const state = STATES.includes(raw.state as AddedRecompState)
    ? (raw.state as AddedRecompState)
    : 'local'
  const blurb = oneLine(raw.blurb, MAX_BLURB_CHARS)
  const prUrl =
    typeof raw.prUrl === 'string' && /^https:\/\/github\.com\/[^\s]{1,300}$/.test(raw.prUrl)
      ? raw.prUrl
      : undefined
  // Only an add that stayed on this PC carries why it was refused.
  const refused = state === 'local' ? oneLine(raw.refused, 300) : ''
  return {
    id,
    repo,
    game,
    systemId: raw.systemId,
    ...(blurb ? { blurb } : {}),
    ...(typeof raw.stars === 'number' && Number.isFinite(raw.stars) && raw.stars >= 0
      ? { stars: Math.round(raw.stars) }
      : {}),
    ...(typeof raw.license === 'string' && raw.license.length <= 100
      ? { license: raw.license }
      : {}),
    ...(raw.archived === true ? { archived: true } : {}),
    ...(raw.fork === true ? { fork: true } : {}),
    addedAt,
    state,
    ...(prUrl ? { prUrl } : {}),
    ...(refused ? { refused } : {})
  }
}

export function parseAddedFile(text: string): AddedFile {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return { version: 1, entries: [] }
  }
  const out: AddedRecomp[] = []
  const seen = new Set<string>()
  for (const item of isObject(raw) && Array.isArray(raw.entries) ? raw.entries : []) {
    const e = parseAddedEntry(item)
    if (!e || seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return { version: 1, entries: out.slice(-MAX_ADDED) }
}

/** The added recompilations in `dir` (userData); empty when there is no file or it cannot be read. */
export async function readAdded(dir: string): Promise<AddedRecomp[]> {
  try {
    return parseAddedFile(await fs.readFile(join(dir, ADDED_FILE), 'utf8')).entries
  } catch {
    return []
  }
}

/** Write the list (atomically: a temp file renamed over the old one). */
export async function writeAdded(dir: string, entries: readonly AddedRecomp[]): Promise<void> {
  const file = join(dir, ADDED_FILE)
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const body: AddedFile = { version: 1, entries: entries.slice(-MAX_ADDED) }
  await fs.writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, file)
}

/** The list with `entry` in it (replacing the one of the same id, moved to the end). */
export function withAdded(entries: readonly AddedRecomp[], entry: AddedRecomp): AddedRecomp[] {
  return [...entries.filter((e) => e.id !== entry.id), entry].slice(-MAX_ADDED)
}

/** Tags, script URLs and control characters (the metadata repository's check refuses them). */
const UNSAFE_TEXT = [/<[a-zA-Z/!?]/, /javascript\s*:/i, /vbscript\s*:/i, /data\s*:\s*text\/html/i]

/** Whether `text` is plain text the metadata repository takes (no HTML, no script URLs). */
export function isPlainLine(text: string): boolean {
  return !UNSAFE_TEXT.some((re) => re.test(text))
}
