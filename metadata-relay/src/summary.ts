import type { MetadataFields, StoredFields } from './validate'

const LABELS: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  shortDescription: 'Short description',
  releaseDate: 'Release date',
  developers: 'Developers',
  publishers: 'Publishers',
  genres: 'Genres',
  tags: 'Tags',
  localPlayers: 'Local players',
  controls: 'Controls',
  hltb: 'HowLongToBeat (hours)',
  reviewScore: 'Review score',
  difficulty: 'Difficulty'
}

const ZWJ = '\u200d'

/**
 * User text made inert for GitHub: a zero-width joiner after every '@' (no @mention, so no notification), every '#'
 * (no issue reference, so no "fixes #1" closing keyword), inside '://' and after 'www' (no autolink). The text still
 * reads the same. Used on everything a suggestion carries into a PR title, PR body or commit message.
 */
export function defuse(s: string): string {
  return s
    .replace(/@/g, `@${ZWJ}`)
    .replace(/#/g, `#${ZWJ}`)
    .replace(/:\/\//g, `:${ZWJ}//`)
    .replace(/(www)\./gi, `$1${ZWJ}.`)
}

/** One line of plain text for a PR title or commit message: defused, whitespace collapsed, at most `max` chars. */
export function plainText(s: string, max = 120): string {
  const one = s.replace(/\s+/g, ' ').trim()
  const cut = one.length > max ? `${one.slice(0, max - 3)}...` : one
  return defuse(cut)
}

/**
 * Text as an inline code span for a table cell: one line, backticks swapped for ', defused, pipes escaped (a table
 * cell ends at an unescaped pipe even inside a code span; GitHub shows '\|' there as '|'). Markdown, links and
 * mentions do not render inside a code span.
 */
export function codeSpan(text: string): string {
  let s = text
    .replace(/\r?\n+/g, ' ⏎ ')
    .replace(/`/g, "'")
    .trim()
  if (s.length > 300) s = `${s.slice(0, 297)}...`
  return `\`${defuse(s).replace(/\|/g, '\\|')}\``
}

/** Markdown for a value inside a table cell: the value as a code span, or _(none)_ / _(empty)_. */
export function cell(v: unknown): string {
  if (v === undefined) return '_(none)_'
  let s: string
  if (Array.isArray(v)) s = v.join(', ')
  else if (typeof v === 'object' && v !== null) {
    s = Object.entries(v)
      .map(([k, x]) => `${k}: ${String(x)}`)
      .join(', ')
  } else s = String(v)
  return s.trim() === '' ? '_(empty)_' : codeSpan(s)
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The fields whose stored value differs between before and after. */
export function changedFields(before: StoredFields, after: StoredFields): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((k) => !same((before as never)[k], (after as never)[k])).sort()
}

// The log of the suggestions a pull request combines (one per /suggest request, oldest first), between markers the
// relay finds again when a later suggestion for the same game updates the pull request. Suggested text cannot hold
// '<!--' (validate.ts refuses it), so no suggestion can fake a marker.
const LOG_START = '<!-- playout-suggestion-log -->'
const LOG_END = '<!-- /playout-suggestion-log -->'
const LOG_SEP = '<!-- playout-suggestion -->'
const LOG_TRIMMED = '_Older suggestions are left out._'
/** One suggestion's JSON in the log is cut after this many characters. */
export const MAX_LOG_ENTRY_CHARS = 6000
/** The log keeps its newest entries within this many characters (the body stays far below GitHub's 65,536). */
export const MAX_LOG_CHARS = 24000

/** Text (already defused) in a json fence, cut at MAX_LOG_ENTRY_CHARS. */
function jsonFence(defused: string): string {
  const s =
    defused.length > MAX_LOG_ENTRY_CHARS
      ? `${defused.slice(0, MAX_LOG_ENTRY_CHARS)}\n... (cut)`
      : defused
  return ['```json', s, '```'].join('\n')
}

/** One log entry: where the suggestion came from, then the suggestion as sent. */
export function logEntry(suggestion: MetadataFields, appVersion: string, at?: string): string {
  // No backtick can close the fence early.
  const json = defuse(JSON.stringify(suggestion, null, 2).replace(/`/g, "'"))
  const when = at ? ` on ${codeSpan(at)}` : ''
  return `From PlayOut ${codeSpan(appVersion)}${when}:\n\n${jsonFence(json)}`
}

/**
 * The log entries of a pull request body this relay wrote, oldest first; for a body from before the log, its one
 * "Suggestion as sent" block. `trimmed`: older entries were left out already.
 */
export function logEntriesOf(body: string): { entries: string[]; trimmed: boolean } {
  const start = body.indexOf(LOG_START)
  const end = start < 0 ? -1 : body.indexOf(LOG_END, start)
  if (start >= 0 && end > start) {
    const parts = body
      .slice(start + LOG_START.length, end)
      .split(LOG_SEP)
      .map((p) => p.trim())
      .filter(Boolean)
    return {
      entries: parts.filter((p) => p !== LOG_TRIMMED),
      trimmed: parts.includes(LOG_TRIMMED)
    }
  }
  const legacy = body.match(
    /<details><summary>Suggestion as sent<\/summary>\s*```json\n([\s\S]*?)\n```/
  )
  if (!legacy) return { entries: [], trimmed: false }
  const version = body.match(/Sent from PlayOut (`[^`\n]{1,40}`)/)
  return {
    entries: [`From PlayOut ${version?.[1] ?? '(earlier version)'}:\n\n${jsonFence(legacy[1])}`],
    trimmed: false
  }
}

/**
 * The pull request body: a table of the changed fields, then the log of the suggestions as sent (`earlier`, from
 * logEntriesOf, then this one). Every value the suggester chose sits in a code span or a code block and is
 * defused: no mentions, links or closing keywords.
 */
export function prBody(opts: {
  key: string
  title: string
  before: StoredFields
  after: StoredFields
  suggestion: MetadataFields
  appVersion: string
  isNewFile: boolean
  /** When this suggestion arrived (shown in its log entry). */
  at?: string
  /** The log entries of the pull request this suggestion updates, oldest first. */
  earlier?: string[]
  earlierTrimmed?: boolean
}): string {
  const changed = changedFields(opts.before, opts.after)
  const rows = changed.map((k) => {
    const label = LABELS[k] ?? k
    return `| ${label} | ${cell((opts.before as never)[k])} | ${cell((opts.after as never)[k])} |`
  })
  const log = [...(opts.earlier ?? []), logEntry(opts.suggestion, opts.appVersion, opts.at)]
  let trimmed = opts.earlierTrimmed ?? false
  const size = (): number => log.reduce((n, e) => n + e.length + LOG_SEP.length + 2, 0)
  while (log.length > 1 && size() > MAX_LOG_CHARS) {
    log.shift()
    trimmed = true
  }
  const combined = log.length > 1 || trimmed
  const entries = trimmed ? [LOG_TRIMMED, ...log] : log
  const lines = [
    `Suggested metadata change for ${cell(opts.title)} (${codeSpan(`games/${opts.key}.json`)}${opts.isNewFile ? ', new file' : ''}).`,
    '',
    '| Field | Current cloud value | Suggested |',
    '| --- | --- | --- |',
    ...rows,
    '',
    combined
      ? `<details><summary>Suggestions as sent (${log.length}, oldest first)</summary>`
      : '<details><summary>Suggestion as sent</summary>',
    '',
    LOG_START,
    '',
    entries.join(`\n\n${LOG_SEP}\n\n`),
    '',
    LOG_END,
    '',
    '</details>',
    '',
    `Sent from PlayOut ${codeSpan(opts.appVersion)} through the metadata relay.` +
      (combined
        ? ' Later suggestions for this game update this pull request; the table compares them all with the current cloud value.'
        : '') +
      ' Merge to approve, close to reject.'
  ]
  return lines.join('\n')
}
