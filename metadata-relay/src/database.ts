/**
 * The only code that writes to the PlayOut database: the `database` branch of jeremybris/PlayOut-metadata.
 *
 * The metadata repository's `main` only the owner changes (github.ts writes nothing but `suggest/` branches, which
 * become pull requests the owner approves). The database is a branch of its own in the same repository and takes
 * new games straight on it: append only. A shard gets rows for keys it does not hold yet; a row that is there, valid
 * or not, is never changed or removed. Everything here is refused, before GitHub is asked anything, unless it names
 * exactly that repository and exactly the `database` branch (DB_REPO; never `main`, never `suggest/...`) and a shard
 * path (data/<prefix>/<nn>.csv), whatever the caller passes. On GitHub's side the main ruleset leaves out only the
 * `database` branch, and a ruleset of its own blocks force pushes and deletions there (SETUP.md, "PlayOut
 * database"), so history cannot be rewritten either.
 */

import {
  GAME_DB_COLUMNS,
  compareKeys,
  csvCell,
  gameDbCellOf,
  parseCsvRecords,
  type GameDbColumn,
  type GameDbRow
} from './database-format'
import { fromBase64, GitHubError, toBase64 } from './github'
import { plainText } from './summary'

/**
 * The one repository and branch the relay may write directly (the metadata repository's `database` branch, never its
 * `main`). wrangler.toml's DB_* variables must name these.
 */
export const DB_REPO = {
  owner: 'jeremybris',
  repo: 'PlayOut-metadata',
  branch: 'database'
} as const

/** The only files the relay may write in it: a shard of the database. */
const SHARD_PATH_RE = /^data\/[a-z0-9]+\/[0-9]{2}\.csv$/

/** How often a write that lost a race with another commit (stale sha) is tried again after the first attempt. */
export const DB_WRITE_RETRIES = 4

export class DbWriteNotAllowedError extends Error {}

export interface DbRepoRef {
  owner: string
  repo: string
  branch: string
  token: string
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch
  /** Waits between retries (tests pass one that returns at once). */
  sleep?: (ms: number) => Promise<void>
  /** A number in [0, 1) for the retry jitter (Math.random otherwise). */
  random?: () => number
}

/** Throws unless the reference names exactly the database repository and its `database` branch. */
export function assertDbRepo(ref: { owner: string; repo: string; branch: string }): void {
  if (ref.owner !== DB_REPO.owner || ref.repo !== DB_REPO.repo || ref.branch !== DB_REPO.branch) {
    throw new DbWriteNotAllowedError(
      `the relay only writes ${DB_REPO.owner}/${DB_REPO.repo} on ${DB_REPO.branch} (refused: ${String(
        ref.owner
      )}/${String(ref.repo)} on ${String(ref.branch)})`
    )
  }
}

/** Whether `path` is a shard of the database (data/<prefix>/<nn>.csv), the only kind of file the relay writes. */
export function isShardPath(path: string): boolean {
  return typeof path === 'string' && SHARD_PATH_RE.test(path)
}

/** Throws unless `path` is a shard of the database (data/<prefix>/<nn>.csv). */
export function assertShardPath(path: string): void {
  if (!isShardPath(path)) {
    throw new DbWriteNotAllowedError(
      `the relay only writes data/<prefix>/<nn>.csv (refused: ${path})`
    )
  }
}

const API = 'https://api.github.com'

async function call(
  ref: DbRepoRef,
  method: string,
  path: string,
  opts: { body?: unknown; accept?: string } = {}
): Promise<Response> {
  const doFetch = ref.fetch ?? fetch
  const res = await doFetch(
    `${API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${ref.token}`,
        Accept: opts.accept ?? 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'PlayOut-metadata-relay',
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    }
  )
  if (!res.ok) {
    let detail = ''
    try {
      detail = ((await res.json()) as { message?: string }).message ?? ''
    } catch {
      // no JSON body
    }
    throw new GitHubError(`GitHub ${method} ${path}: ${res.status} ${detail}`.trim(), res.status)
  }
  return res
}

function contentsPath(path: string): string {
  return `/contents/${path.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * A shard's text and blob sha on the database branch; null when the file does not exist yet (nor does the
 * repository's data, which reads as an empty database). The contents API inlines files up to 1 MB only; a bigger
 * shard is read again as raw text.
 */
export async function readShard(
  ref: DbRepoRef,
  path: string
): Promise<{ text: string; sha: string } | null> {
  assertDbRepo(ref)
  assertShardPath(path)
  const at = `${contentsPath(path)}?ref=${encodeURIComponent(ref.branch)}`
  let r: { content?: string; encoding?: string; sha?: string; type?: string }
  try {
    r = (await (await call(ref, 'GET', at)).json()) as typeof r
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null
    throw e
  }
  if (typeof r?.sha !== 'string' || (r.type !== undefined && r.type !== 'file')) {
    throw new GitHubError(`GitHub returned ${path} in an unexpected form`, 502)
  }
  if (r.encoding === 'base64' && typeof r.content === 'string') {
    return { text: fromBase64(r.content), sha: r.sha }
  }
  // Over 1 MB: the JSON has the sha but no content ("encoding": "none").
  const raw = await call(ref, 'GET', at, { accept: 'application/vnd.github.raw' })
  return { text: await raw.text(), sha: r.sha }
}

/**
 * A shard's text with the rows whose keys it lacks added: every existing record is kept (also one this version
 * cannot read, and columns a later version added), all sorted by key. With the standard header and valid rows this
 * is exactly encodeGameDbCsv of all the rows. Throws when the file has no key column (it is left as it is).
 */
export function mergeShard(
  text: string | null,
  rows: readonly GameDbRow[]
): { text: string; added: string[]; present: string[] } {
  const records = text === null ? [] : parseCsvRecords(text)
  const header = records.shift() ?? [...GAME_DB_COLUMNS]
  const keyAt = header.findIndex((name) => name.trim() === 'key')
  if (keyAt < 0) throw new GitHubError('a database shard has no key column', 502)
  const known = new Set(records.map((r) => r[keyAt] ?? ''))
  const added: string[] = []
  const present: string[] = []
  const lines: { key: string; cells: string[] }[] = records.map((cells) => ({
    key: cells[keyAt] ?? '',
    cells
  }))
  const columns = header.map((name) => name.trim())
  for (const row of rows) {
    if (known.has(row.key)) {
      present.push(row.key)
      continue
    }
    known.add(row.key)
    added.push(row.key)
    lines.push({
      key: row.key,
      cells: columns.map((name) =>
        (GAME_DB_COLUMNS as readonly string[]).includes(name)
          ? gameDbCellOf(row, name as GameDbColumn)
          : ''
      )
    })
  }
  if (!added.length && text !== null) return { text, added, present }
  // A stable sort: records with the same key (never written by the relay) keep their order.
  lines.sort((a, b) => compareKeys(a.key, b.key))
  const out = [header, ...lines.map((l) => l.cells)].map((cells) => cells.map(csvCell).join(','))
  return { text: out.join('\n') + '\n', added, present }
}

/** The commit message of an append: plain text, nothing a suggester chose. */
export function appendMessage(count: number): string {
  return plainText(`Add ${count} game${count === 1 ? '' : 's'} from PlayOut`)
}

export interface AppendOptions {
  /**
   * Called before each write (with the rows about to be added); a throw stops the append and is passed on. The relay
   * counts a contribution against its rate limits here, once, so a request that adds nothing costs none.
   */
  beforeWrite?: (added: string[]) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Appends the rows whose keys the shard lacks, on the database branch, and says which were added and which it had
 * already. Rows must have been checked (gameDbRowProblem) and belong to this shard. A write that lost a race with
 * another commit (GitHub's 409, or 422 for a stale or missing sha) reads the shard again and tries again, up to
 * DB_WRITE_RETRIES times, after a short jittered wait.
 */
export async function appendRows(
  ref: DbRepoRef,
  shardPath: string,
  rows: readonly GameDbRow[],
  opts: AppendOptions = {}
): Promise<{ added: string[]; present: string[] }> {
  assertDbRepo(ref)
  assertShardPath(shardPath)
  const sleep = ref.sleep ?? defaultSleep
  const random = ref.random ?? Math.random
  for (let attempt = 0; ; attempt++) {
    const current = await readShard(ref, shardPath)
    const merged = mergeShard(current?.text ?? null, rows)
    if (!merged.added.length) return { added: [], present: merged.present }
    await opts.beforeWrite?.(merged.added)
    try {
      await call(ref, 'PUT', contentsPath(shardPath), {
        body: {
          message: appendMessage(merged.added.length),
          content: toBase64(merged.text),
          // Always named: the contents API writes the default branch when it is missing.
          branch: ref.branch,
          ...(current ? { sha: current.sha } : {})
        }
      })
      return { added: merged.added, present: merged.present }
    } catch (e) {
      const stale = e instanceof GitHubError && (e.status === 409 || e.status === 422)
      if (!stale || attempt >= DB_WRITE_RETRIES) throw e
      await sleep(Math.round(150 * 2 ** attempt * (0.5 + random())))
    }
  }
}

/** Rows ready for the database, grouped by the shard each key lives in (shards in path order). */
export function groupByShard(
  rows: readonly GameDbRow[],
  shardOf: (key: string) => string
): [string, GameDbRow[]][] {
  const groups = new Map<string, GameDbRow[]>()
  for (const row of rows) {
    const path = shardOf(row.key)
    const list = groups.get(path)
    if (list) list.push(row)
    else groups.set(path, [row])
  }
  return [...groups.entries()].sort((a, b) => compareKeys(a[0], b[0]))
}
