/**
 * PlayOut metadata relay (Cloudflare Worker).
 *
 *   GET  /health      -> { ok: true }
 *   POST /suggest     { key, title, fields, appVersion, clientId }
 *                     -> { ok: true, pr: { number, url }, updated?: true } | { ok: false, error }
 *   POST /contribute  { clientId, appVersion, rows: GameDbRow[] (1-25) }
 *                     -> { ok: true, added, present, refused, later } | { ok: false, error }
 *
 * A suggestion is validated (validate.ts), rate limited (ratelimit.ts: checked before GitHub is asked anything,
 * counted as a suggestion only once it is about to become a pull request), merged onto the current
 * games/<key>.json of the metadata repo and opened as a pull request labelled 'suggestion' from a branch
 * suggest/<key>-<id>. Nothing reaches main until the owner merges it. A game has at most one open suggestion pull
 * request: a later suggestion for it updates that one (its branch rebuilt on main's current head with both
 * suggestions combined, newest wins per field; `updated: true` in the answer), and one that takes everything back
 * to the cloud value closes it (409).
 *
 * A contribution brings games for the PlayOut database (the `database` branch of the same metadata repo): each row is
 * validated on its own (refused rows are reported, the rest go on), the request is rate limited with counters of its
 * own (in the DB_LIMITS Durable Object, db-limiter.ts, which counts atomically), and the rows whose keys the database
 * lacks are appended to their shards on that branch (database.ts, the only code that writes there; never main, never
 * suggest/...). A row the database has already is never changed. Rows it did not get to are answered as `later`,
 * with Retry-After.
 */

import {
  addLabels,
  branchSha,
  commentOnSuggestionPull,
  commitFileOn,
  createBranch,
  deleteBranch,
  fastForwardSuggestBranch,
  getPull,
  GitHubError,
  listOpenSuggestions,
  MAX_PULL_PAGES,
  mergeBase,
  openPullRequest,
  readFile,
  suggestionPullsFor,
  treeOf,
  updateSuggestionPull,
  writeFile,
  type OpenPull,
  type RepoRef
} from './github'
import {
  clearAppTokenCache,
  installationToken,
  PrivateKeyError,
  type AppPermissions
} from './appauth'
import { appendRows, assertDbRepo, groupByShard, type DbRepoRef } from './database'
import { gameDbShardPath } from './database-format'
import { dbLimitsOf } from './db-limiter'
import {
  countTurnedAway,
  dbRateLimitConfig,
  peekRateLimit,
  rateLimitConfig,
  takeRateLimit,
  type RateLimitResult
} from './ratelimit'

// The Durable Object class of the database's rate limits: wrangler.toml binds it as DB_LIMITS.
export { DbRateLimiter } from './db-limiter'
import { changedFields, logEntriesOf, plainText, prBody } from './summary'
import {
  mergeFields,
  storedFieldsOf,
  validateContribution,
  validateSuggestion,
  MAX_BODY_BYTES,
  type MetadataFields,
  type StoredFields,
  type Suggestion
} from './validate'

export interface Env {
  /** The relay's GitHub App (SETUP.md, step 5): its numeric App ID. */
  GITHUB_APP_ID?: string
  /** The app's private key, the .pem GitHub downloads (PKCS#1 or PKCS#8). */
  GITHUB_APP_PRIVATE_KEY?: string
  /** Optional; discovered from the repository when missing. */
  GITHUB_APP_INSTALLATION_ID?: string
  /** Fallback only, used when no GitHub App is configured: a plain token (fine-grained or classic). */
  GITHUB_TOKEN?: string
  RATE_LIMIT: KVNamespace
  REPO_OWNER?: string
  REPO_NAME?: string
  BASE_BRANCH?: string
  RATE_IP_PER_HOUR?: string
  RATE_IP48_PER_HOUR?: string
  RATE_CLIENT_PER_HOUR?: string
  RATE_GLOBAL_PER_HOUR?: string
  /** No new suggestion while this many wait for review (default DEFAULT_MAX_OPEN_SUGGESTIONS). */
  MAX_OPEN_SUGGESTIONS?: string
  /**
   * The PlayOut database (/contribute). Both must be set, and name exactly database.ts DB_REPO, or /contribute
   * answers 503.
   */
  DB_REPO_OWNER?: string
  DB_REPO_NAME?: string
  /** Its branch; 'database' when missing (and nothing else is allowed). */
  DB_BRANCH?: string
  /** The database's rate-limit counters (db-limiter.ts DbRateLimiter); /contribute answers 503 without it. */
  DB_LIMITS?: DurableObjectNamespace
  RATE_DB_IP_PER_HOUR?: string
  RATE_DB_IP48_PER_HOUR?: string
  RATE_DB_CLIENT_PER_HOUR?: string
  RATE_DB_GLOBAL_PER_HOUR?: string
}

/** Retry-After (seconds) when too many suggestions wait for review. */
export const BACKLOG_RETRY_AFTER = 3600
/** Without MAX_OPEN_SUGGESTIONS: the value wrangler.toml deploys, kept equal to it by hand. */
export const DEFAULT_MAX_OPEN_SUGGESTIONS = 300

function maxOpenSuggestions(env: Env): number {
  const x = Number(env.MAX_OPEN_SUGGESTIONS)
  return Number.isInteger(x) && x > 0 ? x : DEFAULT_MAX_OPEN_SUGGESTIONS
}

function usesApp(env: Env): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY)
}

/** True when the relay can authenticate to GitHub (a GitHub App, or the fallback token). */
function hasGitHubAuth(env: Env): boolean {
  return usesApp(env) || Boolean(env.GITHUB_TOKEN)
}

/**
 * The bearer token for a repository: the GitHub App's installation token (limited to that repository and to
 * `permissions`, by default what /suggest needs), else GITHUB_TOKEN.
 */
async function githubToken(
  env: Env,
  owner: string,
  repo: string,
  deps: Deps,
  permissions?: AppPermissions
): Promise<string> {
  if (usesApp(env)) {
    return installationToken(
      {
        appId: env.GITHUB_APP_ID!.trim(),
        privateKey: env.GITHUB_APP_PRIVATE_KEY!,
        installationId: env.GITHUB_APP_INSTALLATION_ID?.trim() || undefined,
        owner,
        repo,
        ...(permissions ? { permissions } : {})
      },
      { fetch: deps.fetch, now: deps.now }
    )
  }
  return env.GITHUB_TOKEN!
}

/** Test hooks: a fake fetch for GitHub, a fixed clock and id, and a wait that returns at once. */
export interface Deps {
  fetch?: typeof fetch
  now?: () => number
  id?: () => string
  sleep?: (ms: number) => Promise<void>
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  })
}

function fail(error: string, status: number, headers?: Record<string, string>): Response {
  return json({ ok: false, error }, status, headers)
}

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8)
}

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '0')
  if (declared > MAX_BODY_BYTES) return null
  const text = await request.text()
  return new TextEncoder().encode(text).length > MAX_BODY_BYTES ? null : text
}

/** A games/<key>.json record as an object, or null when the text is not one. */
function recordOf(text: string): Record<string, unknown> | null {
  try {
    const r = JSON.parse(text) as unknown
    if (typeof r === 'object' && r !== null && !Array.isArray(r))
      return r as Record<string, unknown>
  } catch {
    // A broken file is replaced by the suggestion; the PR diff shows it.
  }
  return null
}

/** The file a suggestion writes: main's record with `fields`. */
function recordText(
  s: Suggestion,
  record: Record<string, unknown>,
  fields: StoredFields,
  at: string
): string {
  const out = {
    key: s.key,
    title: fields.title ?? (typeof record.title === 'string' ? record.title : s.title),
    fields,
    updatedAt: at
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/** '2026-11-16 12:30 UTC' for a pull request's log. */
function shownTime(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`
}

/** main as the relay read it for this request. */
interface MainState {
  sha: string
  file: { text: string; sha: string } | null
  record: Record<string, unknown>
  fields: StoredFields
}

/**
 * What an open suggestion pull request suggests, and what it would suggest with `s` on top: the fields its head's
 * file changes against the commit it was made from (the merge base with main: so a value main gained since is not
 * taken back), laid onto main's current fields, then the new suggestion's fields (newest wins per field).
 */
async function planUpdate(
  repo: RepoRef,
  pull: OpenPull,
  path: string,
  main: MainState,
  s: Suggestion
): Promise<{ suggested: StoredFields; combined: StoredFields }> {
  const delta: Record<string, unknown> = {}
  const head = await readFile(repo, path, pull.headSha)
  const headRecord = head && recordOf(head.text)
  if (headRecord) {
    const from = await mergeBase(repo, main.sha, pull.headSha)
    const baseFile = from === main.sha ? main.file : await readFile(repo, path, from)
    const baseFields = storedFieldsOf(baseFile ? recordOf(baseFile.text) : {})
    const headFields = storedFieldsOf(headRecord) as Record<string, unknown>
    for (const k of changedFields(baseFields, headFields as StoredFields)) {
      delta[k] = headFields[k] ?? null
    }
  }
  // An unreadable head file suggests nothing: the new suggestion replaces it.
  const suggested = mergeFields(main.fields, delta as MetadataFields)
  return { suggested, combined: mergeFields(suggested, s.fields) }
}

/**
 * Rebuilds a suggestion pull request on main's current head: one new commit with main's tree and the combined
 * record, whose parents are the branch's head as read and main's head, then the branch moved onto it in one step
 * (the pull request never shows an empty or half-written state, and never goes stale or conflicts: its merge base is
 * main's head, so it shows exactly the combined change), then the body: the table for the combined change and the
 * log with this suggestion added.
 *
 * The move is a fast-forward, not a forced push: if another request moved the branch since it was read, GitHub
 * refuses it (422) and nothing is overwritten. The pull request is then read again and the combination redone once
 * on its new head; a second refusal (or a pull request closed meanwhile) throws, and the caller answers 502 so the
 * client sends the suggestion again.
 */
async function rebuildPull(
  repo: RepoRef,
  pull: OpenPull,
  opts: {
    path: string
    main: MainState
    combined: StoredFields
    s: Suggestion
    at: string
    message: string
  }
): Promise<void> {
  const { path, main, s, at } = opts
  let combined = opts.combined
  let current = pull
  const baseTree = await treeOf(repo, main.sha)
  for (let attempt = 1; ; attempt++) {
    const commit = await commitFileOn(repo, {
      baseTree,
      parents: current.headSha === main.sha ? [main.sha] : [current.headSha, main.sha],
      path,
      text: recordText(s, main.record, combined, at),
      message: opts.message
    })
    try {
      await fastForwardSuggestBranch(repo, current.headRef, commit)
      break
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 422) || attempt >= 2) throw e
    }
    // Another update moved the branch since it was read: combine with what it suggests now.
    const fresh = await getPull(repo, current.number)
    if (!fresh || !fresh.open || fresh.headRef !== current.headRef) {
      throw new GitHubError('the suggestion pull request changed meanwhile', 409)
    }
    current = fresh
    const plan = await planUpdate(repo, current, path, main, s)
    if (changedFields(main.fields, plan.combined).length === 0) {
      throw new GitHubError('the suggestion pull request changed meanwhile', 409)
    }
    // It has this suggestion already (the same one sent twice at once): nothing to write.
    if (changedFields(plan.suggested, plan.combined).length === 0) return
    combined = plan.combined
  }
  const log = logEntriesOf(current.body)
  try {
    await updateSuggestionPull(repo, current, {
      body: prBody({
        key: s.key,
        title: s.title,
        before: main.fields,
        after: combined,
        suggestion: s.fields,
        appVersion: s.appVersion,
        isNewFile: !main.file,
        at: shownTime(at),
        earlier: log.entries,
        earlierTrimmed: log.trimmed
      })
    })
  } catch (e) {
    // The branch has the combined change; only the description is behind.
    console.error('suggest: PR body not updated', e instanceof Error ? e.message : 'unknown error')
  }
}

/**
 * Closes a suggestion pull request the newest suggestion took back entirely, then notes why and deletes its branch.
 * Closed first: a close GitHub refuses throws (502) and leaves the pull request exactly as it was, with no note
 * claiming it was closed.
 */
async function withdrawPull(repo: RepoRef, pull: OpenPull): Promise<void> {
  await updateSuggestionPull(repo, pull, { state: 'closed' })
  try {
    await commentOnSuggestionPull(
      repo,
      pull,
      'Closed by the metadata relay: a newer suggestion for this game sets every field back to its current cloud value, so nothing is left to change.'
    )
  } catch {
    // Closed without the note.
  }
  try {
    await deleteBranch(repo, pull.headRef)
  } catch {
    // Left for the owner to delete.
  }
}

/**
 * After opening `ours`: when another open suggestion pull request for the same game has a lower number (opened by
 * a request at the same moment), this suggestion goes into that one and `ours` is closed and its branch deleted.
 * The pull request it went into, or null when `ours` stays (nothing earlier, or any step failed: `ours` is a
 * complete suggestion then). One page of the newest pull requests is enough: a race is seconds old.
 */
async function foldIntoEarlier(
  repo: RepoRef,
  ours: { number: number; headRef: string; author: string },
  where: { owner: string; repo: string; base: string },
  opts: { path: string; main: MainState; s: Suggestion; at: string; message: string }
): Promise<OpenPull | null> {
  try {
    const { pulls } = await listOpenSuggestions(repo, Number.MAX_SAFE_INTEGER, 1)
    // The earlier one may not have its label yet (its request adds it just after opening it): one opened under the
    // same login as ours is the relay's too, whether that is the app or a GITHUB_TOKEN's user.
    const target = suggestionPullsFor(pulls, opts.s.key, { ...where, author: ours.author }).find(
      (p) => p.number < ours.number
    )
    if (!target) return null
    const plan = await planUpdate(repo, target, opts.path, opts.main, opts.s)
    if (changedFields(opts.main.fields, plan.combined).length === 0) return null
    if (changedFields(plan.suggested, plan.combined).length > 0) {
      await rebuildPull(repo, target, { ...opts, combined: plan.combined })
    }
    try {
      await updateSuggestionPull(repo, ours, { state: 'closed' })
    } catch (e) {
      // Both stay open; the owner closes the duplicate (the earlier one has this suggestion too).
      console.error(
        'suggest: duplicate PR not closed',
        e instanceof Error ? e.message : 'unknown error'
      )
      return target
    }
    try {
      await commentOnSuggestionPull(
        repo,
        ours,
        `Combined into #${target.number}, the open suggestion for the same game.`
      )
    } catch {
      // Closed without the note.
    }
    try {
      await deleteBranch(repo, ours.headRef)
    } catch {
      // Left for the owner to delete.
    }
    return target
  } catch (e) {
    console.error('suggest: not combined', e instanceof Error ? e.message : 'unknown error')
    return null
  }
}

export async function handleSuggest(
  request: Request,
  env: Env,
  deps: Deps = {}
): Promise<Response> {
  if (!hasGitHubAuth(env)) {
    return fail('relay is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY missing)', 503)
  }
  if (!env.RATE_LIMIT) return fail('relay is not configured (RATE_LIMIT KV missing)', 503)
  const type = request.headers.get('Content-Type') ?? ''
  if (!/^application\/json\b/i.test(type)) return fail('Content-Type must be application/json', 415)

  const text = await readBody(request)
  if (text === null) return fail('request is larger than 64 KB', 413)
  const parsed = validateSuggestion(text)
  if (!parsed.ok) return fail(parsed.error, 400)
  const s = parsed.value

  // Every request that gets this far is counted once, by its outcome: as a suggestion when it is about to become
  // a pull request, else as a request turned away (ratelimit.ts). Counting all of them as suggestions made one
  // that changes nothing, or that arrives while too many wait for review, cost the sender one of the hour's
  // suggestions; counting none of those would make the GitHub calls below free to repeat without end.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const limits = rateLimitConfig(env)
  const now = deps.now?.() ?? Date.now()
  const tooMany = (limit: Exclude<RateLimitResult, { ok: true }>): Response =>
    fail(`too many suggestions (${limit.scope}); try again later`, 429, {
      'Retry-After': String(limit.retryAfter)
    })
  let counted = false
  const turnedAway = async (): Promise<void> => {
    if (counted) return
    counted = true
    try {
      await countTurnedAway(env.RATE_LIMIT, ip, limits, now)
    } catch (e) {
      console.error('rate-limit store failed', e instanceof Error ? e.message : 'unknown error')
    }
  }
  const allowed = await peekRateLimit(env.RATE_LIMIT, ip, s.clientId, limits, now)
  if (!allowed.ok) return tooMany(allowed)

  const owner = env.REPO_OWNER || 'jeremybris'
  const repoName = env.REPO_NAME || 'PlayOut-metadata'
  let token: string
  try {
    token = await githubToken(env, owner, repoName, deps)
  } catch (e) {
    // Never the key or a token: PrivateKeyError and GitHubError messages carry neither.
    console.error('GitHub sign-in failed', e instanceof Error ? e.message : 'unknown error')
    await turnedAway()
    if (e instanceof PrivateKeyError) return fail('relay is not configured (GitHub App key)', 503)
    // A reinstalled app has a new installation id, a revoked one no token: look both up afresh next time.
    if (e instanceof GitHubError && (e.status === 401 || e.status === 404)) clearAppTokenCache()
    return fail('relay cannot reach the metadata repository (GitHub App)', 502)
  }
  const repo: RepoRef = { owner, repo: repoName, token, fetch: deps.fetch }
  const base = env.BASE_BRANCH || 'main'
  const where = { owner, repo: repoName, base }
  const path = `games/${s.key}.json`
  const branch = `suggest/${s.key}-${(deps.id ?? shortId)()}`
  const at = new Date(now).toISOString()
  const message = `Suggestion: ${plainText(s.title)} (${s.key})`
  let branchCreated = false

  try {
    // At most one open suggestion per game: a later one for the same game updates that pull request instead of
    // opening another (two pull requests creating the same new file conflict as soon as one is merged).
    const cap = maxOpenSuggestions(env)
    // Paging goes on past the cap until this game's pull request is seen (within MAX_PULL_PAGES): an update is
    // accepted over the cap, and an older one may sit behind the newest pull requests.
    const ofThisGame = (p: OpenPull): boolean => suggestionPullsFor([p], s.key, where).length > 0
    const open = await listOpenSuggestions(repo, cap, MAX_PULL_PAGES, ofThisGame)
    const existing = suggestionPullsFor(open.pulls, s.key, where)[0]
    // Spam that gets past the rate limits cannot pile up without limit: past the cap, nothing new until the owner
    // has gone through the open ones (an update adds no pull request).
    if (!existing && open.count >= cap) {
      await turnedAway()
      return fail('too many suggestions wait for review; try again later', 429, {
        'Retry-After': String(BACKLOG_RETRY_AFTER)
      })
    }
    const baseSha = await branchSha(repo, base)
    const current = await readFile(repo, path, base)
    const record = (current && recordOf(current.text)) || {}
    const main: MainState = { sha: baseSha, file: current, record, fields: storedFieldsOf(record) }
    const before = main.fields

    if (existing) {
      const plan = await planUpdate(repo, existing, path, main, s)
      if (changedFields(before, plan.combined).length === 0) {
        // The newest suggestion takes everything back to the cloud value: nothing is left to suggest.
        await turnedAway()
        await withdrawPull(repo, existing)
        return fail('the suggestion matches the cloud record already', 409)
      }
      if (changedFields(plan.suggested, plan.combined).length === 0) {
        // The pull request suggests exactly this already (a suggestion sent again): nothing to write.
        await turnedAway()
        return json({ ok: true, pr: { number: existing.number, url: existing.url }, updated: true })
      }
      counted = true
      const limit = await takeRateLimit(env.RATE_LIMIT, ip, s.clientId, limits, now)
      if (!limit.ok) return tooMany(limit)
      await rebuildPull(repo, existing, { path, main, combined: plan.combined, s, at, message })
      return json({ ok: true, pr: { number: existing.number, url: existing.url }, updated: true })
    }

    const after = mergeFields(before, s.fields)
    if (changedFields(before, after).length === 0) {
      await turnedAway()
      return fail('the suggestion matches the cloud record already', 409)
    }
    // A real suggestion: only now does it take one of the hour's (checked again: others arrived meanwhile).
    counted = true
    const limit = await takeRateLimit(env.RATE_LIMIT, ip, s.clientId, limits, now)
    if (!limit.ok) return tooMany(limit)

    await createBranch(repo, branch, baseSha)
    branchCreated = true
    await writeFile(repo, {
      path,
      branch,
      text: recordText(s, record, after, at),
      message,
      sha: current?.sha
    })
    const pr = await openPullRequest(repo, {
      title: `Suggestion: ${plainText(s.title)}`,
      head: branch,
      base,
      body: prBody({
        key: s.key,
        title: s.title,
        before,
        after,
        suggestion: s.fields,
        appVersion: s.appVersion,
        isNewFile: !current,
        at: shownTime(at)
      })
    })
    // The pull request stands from here on: nothing below may delete its branch.
    branchCreated = false
    try {
      await addLabels(repo, pr.number, ['suggestion'])
    } catch {
      // The PR stands without its label.
    }
    // Two suggestions for one game sent at the same moment both found no pull request and opened one each: the
    // later one (higher number) folds itself into the earliest and closes, so they end as one.
    const ours = { number: pr.number, headRef: branch, author: pr.author }
    const into = await foldIntoEarlier(repo, ours, where, {
      path,
      main,
      s,
      at,
      message
    })
    if (into) return json({ ok: true, pr: { number: into.number, url: into.url }, updated: true })
    return json({ ok: true, pr: { number: pr.number, url: pr.url } })
  } catch (e) {
    await turnedAway()
    if (branchCreated) {
      try {
        await deleteBranch(repo, branch)
      } catch {
        // Left for the owner to delete.
      }
    }
    const status = e instanceof GitHubError ? e.status : 0
    // A cached installation token GitHub no longer takes (app reinstalled, key rotated): sign in afresh next time.
    if (status === 401 && usesApp(env)) clearAppTokenCache()
    console.error('suggest failed', e instanceof Error ? e.message : e)
    return fail(
      status === 401 || status === 403
        ? 'relay cannot reach the metadata repository (token)'
        : 'GitHub did not accept the suggestion; try again later',
      502
    )
  }
}

// ---------------------------------------------------------------------------------------------------------------
// POST /contribute: games for the PlayOut database

/**
 * At most this many GitHub calls per /contribute request (Workers' free plan allows 50 subrequests per request; the
 * sign-in takes up to two more). A shard that would not fit is left for a later request (`later`).
 */
export const MAX_DB_GITHUB_CALLS = 44
/** A shard needs at least this many calls: one read and one write. */
const CALLS_PER_SHARD = 2
/** Retry-After (seconds) with games left for later after GitHub failed or the call budget ran out. */
export const DB_LATER_RETRY_AFTER = 60
/** Retry-After (seconds) when the DB_LIMITS Durable Object did not answer. */
const DB_LIMITS_RETRY_AFTER = 300

class CallBudgetError extends Error {}
class RateLimitedError extends Error {
  constructor(readonly limit: Exclude<RateLimitResult, { ok: true }>) {
    super('rate limited')
  }
}

/** The database repository wrangler.toml names, or why the relay may not write it. */
function dbRepoOf(env: Env): { owner: string; repo: string; branch: string } | string {
  const owner = env.DB_REPO_OWNER?.trim()
  const repo = env.DB_REPO_NAME?.trim()
  if (!owner || !repo) return 'relay is not configured (DB_REPO_OWNER / DB_REPO_NAME missing)'
  const ref = { owner, repo, branch: env.DB_BRANCH?.trim() || 'database' }
  try {
    assertDbRepo(ref)
  } catch {
    return 'relay is not configured (DB_REPO_* names a repository the relay may not write)'
  }
  return ref
}

export async function handleContribute(
  request: Request,
  env: Env,
  deps: Deps = {}
): Promise<Response> {
  if (!hasGitHubAuth(env)) {
    return fail('relay is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY missing)', 503)
  }
  if (!env.DB_LIMITS) return fail('relay is not configured (DB_LIMITS Durable Object missing)', 503)
  const db = dbRepoOf(env)
  if (typeof db === 'string') return fail(db, 503)
  const type = request.headers.get('Content-Type') ?? ''
  if (!/^application\/json\b/i.test(type)) return fail('Content-Type must be application/json', 415)

  const text = await readBody(request)
  if (text === null) return fail('request is larger than 64 KB', 413)
  const parsed = validateContribution(text)
  if (!parsed.ok) return fail(parsed.error, 400)
  const c = parsed.value
  if (!c.rows.length) {
    return json(
      { ok: false, error: 'no game in the request can go in the database', refused: c.refused },
      400
    )
  }

  // As with suggestions: a request is counted once, as a contribution when it is about to write a shard, else as
  // turned away. These counters are the database's own, with their own limits, in the DB_LIMITS Durable Object:
  // unlike KV it counts atomically, so requests sent at the same moment cannot all slip under a limit.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const now = deps.now?.() ?? Date.now()
  const counters = dbLimitsOf(env.DB_LIMITS, ip, c.clientId, dbRateLimitConfig(env), now)
  const tooMany = (limit: Exclude<RateLimitResult, { ok: true }>): Response =>
    fail(`too many contributions (${limit.scope}); try again later`, 429, {
      'Retry-After': String(limit.retryAfter)
    })
  let counted = false
  const turnedAway = async (): Promise<void> => {
    if (counted) return
    counted = true
    try {
      await counters.turnedAway()
    } catch (e) {
      console.error('rate-limit store failed', e instanceof Error ? e.message : 'unknown error')
    }
  }
  let allowed: RateLimitResult
  try {
    allowed = await counters.peek()
  } catch (e) {
    console.error('rate-limit store failed', e instanceof Error ? e.message : 'unknown error')
    return fail('the rate limits cannot be checked; try again later', 503, {
      'Retry-After': String(DB_LIMITS_RETRY_AFTER)
    })
  }
  if (!allowed.ok) return tooMany(allowed)

  let token: string
  try {
    // Contents only: the database takes commits, never pull requests.
    token = await githubToken(env, db.owner, db.repo, deps, { contents: 'write' })
  } catch (e) {
    console.error('GitHub sign-in failed', e instanceof Error ? e.message : 'unknown error')
    await turnedAway()
    if (e instanceof PrivateKeyError) return fail('relay is not configured (GitHub App key)', 503)
    if (e instanceof GitHubError && (e.status === 401 || e.status === 404)) clearAppTokenCache()
    return fail('relay cannot reach the PlayOut database (GitHub App)', 502)
  }

  let calls = 0
  const baseFetch = deps.fetch ?? fetch
  const budgetFetch: typeof fetch = (input, init) => {
    if (++calls > MAX_DB_GITHUB_CALLS)
      return Promise.reject(new CallBudgetError('call budget used up'))
    return baseFetch(input, init)
  }
  const ref: DbRepoRef = { ...db, token, fetch: budgetFetch, sleep: deps.sleep }
  const takeOnce = async (): Promise<void> => {
    if (counted) return
    counted = true
    const limit = await counters.take()
    if (!limit.ok) throw new RateLimitedError(limit)
  }

  const added: string[] = []
  const present: string[] = []
  const later: string[] = []
  let failure: unknown = null
  for (const [path, rows] of groupByShard(c.rows, gameDbShardPath)) {
    if (failure !== null || calls + CALLS_PER_SHARD > MAX_DB_GITHUB_CALLS) {
      later.push(...rows.map((r) => r.key))
      continue
    }
    try {
      const r = await appendRows(ref, path, rows, { beforeWrite: takeOnce })
      added.push(...r.added)
      present.push(...r.present)
    } catch (e) {
      failure = e
      later.push(...rows.map((r) => r.key))
    }
  }

  if (failure !== null) {
    const status = failure instanceof GitHubError ? failure.status : 0
    if (status === 401 && usesApp(env)) clearAppTokenCache()
    if (!(failure instanceof RateLimitedError) && !(failure instanceof CallBudgetError)) {
      console.error('contribute failed', failure instanceof Error ? failure.message : failure)
    }
  }
  // Nothing done at all: the request failed as a whole.
  if (failure !== null && !added.length && !present.length) {
    if (failure instanceof RateLimitedError) return tooMany(failure.limit)
    await turnedAway()
    const status = failure instanceof GitHubError ? failure.status : 0
    return fail(
      status === 401 || status === 403
        ? 'relay cannot reach the PlayOut database (token)'
        : 'GitHub did not accept the games; try again later',
      502
    )
  }
  // Every game was in the database already: turned away, it took none of the hour's contributions.
  if (!added.length) await turnedAway()
  // Games left for later are the sender's to send again (PlayOut keeps them queued). When a rate limit stopped the
  // request part way, Retry-After says when that limit opens again; after a GitHub failure, a short wait.
  const retryAfter =
    failure instanceof RateLimitedError
      ? failure.limit.retryAfter
      : later.length
        ? DB_LATER_RETRY_AFTER
        : null
  return json(
    { ok: true, added, present, refused: c.refused, later },
    200,
    retryAfter === null ? {} : { 'Retry-After': String(retryAfter) }
  )
}

export async function handle(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return fail('method not allowed', 405)
    return json({ ok: true })
  }
  if (url.pathname === '/suggest') {
    if (request.method !== 'POST') return fail('method not allowed', 405, { Allow: 'POST' })
    return handleSuggest(request, env, deps)
  }
  if (url.pathname === '/contribute') {
    if (request.method !== 'POST') return fail('method not allowed', 405, { Allow: 'POST' })
    return handleContribute(request, env, deps)
  }
  return fail('not found', 404)
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env)
  }
} satisfies ExportedHandler<Env>
