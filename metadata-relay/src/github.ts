/**
 * The few GitHub REST calls the relay makes, with the GitHub App's installation token (appauth.ts).
 *
 * Every write (create / move / delete a branch, commit a file) is confined to branches under `suggest/`: the relay
 * never writes `main` or any other ref, whatever its caller passes, and it changes, comments on or closes only pull
 * requests whose head is a suggest/ branch. The repository's rulesets enforce the same on GitHub's side (SETUP.md),
 * so a bug here or a leaked token still cannot reach `main`. (commitFileOn creates a commit object on no branch;
 * only fastForwardSuggestBranch puts it on one.)
 */

export interface RepoRef {
  owner: string
  repo: string
  token: string
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

const API = 'https://api.github.com'

async function gh<T>(ref: RepoRef, method: string, path: string, body?: unknown): Promise<T> {
  const doFetch = ref.fetch ?? fetch
  const res = await doFetch(`${API}/repos/${ref.owner}/${ref.repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ref.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'PlayOut-metadata-relay',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = ((await res.json()) as { message?: string }).message ?? ''
    } catch {
      // no JSON body
    }
    throw new GitHubError(`GitHub ${method} ${path}: ${res.status} ${detail}`.trim(), res.status)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** UTF-8 text to base64 (GitHub's contents API carries bytes as base64). */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

export function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/**
 * The only branches the relay may write: suggest/<key>-<id> (a game's suggestion) and suggest/recomp/<file>-<id> (a
 * recompilation's, recomps.ts: <file> is <owner>__<repo>). No '..', no ref tricks. A game key has no '/', so the two
 * kinds never meet.
 */
const SUGGEST_BRANCH_RE =
  /^suggest\/(?:[a-z0-9_][a-z0-9._-]{0,299}|recomp\/[a-z0-9][a-z0-9._-]{0,250})$/

export class RefNotAllowedError extends Error {}

/** Throws unless `branch` is a suggest/ branch the relay may write. */
export function assertSuggestBranch(branch: string): void {
  if (
    typeof branch !== 'string' ||
    !SUGGEST_BRANCH_RE.test(branch) ||
    branch.includes('..') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock')
  ) {
    throw new RefNotAllowedError(
      `the relay only writes branches under suggest/ (refused: ${branch})`
    )
  }
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export async function branchSha(ref: RepoRef, branch: string): Promise<string> {
  const r = await gh<{ object: { sha: string } }>(
    ref,
    'GET',
    `/git/ref/heads/${encodePath(branch)}`
  )
  return r.object.sha
}

/** A file's text and blob sha on a branch; null when it does not exist. */
export async function readFile(
  ref: RepoRef,
  path: string,
  branch: string
): Promise<{ text: string; sha: string } | null> {
  try {
    const r = await gh<{ content?: string; encoding?: string; sha: string }>(
      ref,
      'GET',
      `/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`
    )
    if (r.encoding !== 'base64' || typeof r.content !== 'string') {
      throw new GitHubError(`GitHub returned ${path} in an unexpected form`, 502)
    }
    return { text: fromBase64(r.content), sha: r.sha }
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null
    throw e
  }
}

export async function createBranch(ref: RepoRef, branch: string, sha: string): Promise<void> {
  assertSuggestBranch(branch)
  await gh(ref, 'POST', '/git/refs', { ref: `refs/heads/${branch}`, sha })
}

export async function deleteBranch(ref: RepoRef, branch: string): Promise<void> {
  assertSuggestBranch(branch)
  await gh(ref, 'DELETE', `/git/refs/heads/${encodePath(branch)}`)
}

export async function writeFile(
  ref: RepoRef,
  opts: { path: string; branch: string; text: string; message: string; sha?: string }
): Promise<void> {
  // The contents API writes the default branch (main) when `branch` is missing: always name a suggest/ branch.
  assertSuggestBranch(opts.branch)
  await gh(ref, 'PUT', `/contents/${encodePath(opts.path)}`, {
    message: opts.message,
    content: toBase64(opts.text),
    branch: opts.branch,
    ...(opts.sha ? { sha: opts.sha } : {})
  })
}

export async function openPullRequest(
  ref: RepoRef,
  opts: { title: string; head: string; base: string; body: string }
): Promise<{ number: number; url: string; author: string }> {
  assertSuggestBranch(opts.head)
  const r = await gh<{ number: number; html_url: string; user?: { login?: string } | null }>(
    ref,
    'POST',
    '/pulls',
    { title: opts.title, head: opts.head, base: opts.base, body: opts.body }
  )
  // author: the login the relay signs in as (the app's bot, or the GITHUB_TOKEN's user).
  return { number: r.number, url: r.html_url, author: r.user?.login ?? '' }
}

/** Adds labels to an issue / pull request (GitHub creates a label that does not exist yet). */
export async function addLabels(ref: RepoRef, issue: number, labels: string[]): Promise<void> {
  await gh(ref, 'POST', `/issues/${issue}/labels`, { labels })
}

/** An open pull request as the list call answers it, reduced to what the relay looks at. */
export interface OpenPull {
  number: number
  url: string
  body: string
  labels: string[]
  /** 'Bot' for a GitHub App's pull requests (the relay's own, when it signs in as its app). */
  userType: string
  /** Who opened it. */
  userLogin: string
  headRef: string
  headSha: string
  /** owner/repo the head branch lives in ('' when its fork is gone). */
  headRepo: string
  baseRef: string
}

interface RawPull {
  number: number
  html_url?: string
  body?: string | null
  labels?: { name?: string }[]
  user?: { type?: string; login?: string } | null
  state?: string
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null }
  base?: { ref?: string }
}

function openPullOf(p: RawPull): OpenPull {
  return {
    number: p.number,
    url: p.html_url ?? '',
    body: p.body ?? '',
    labels: (p.labels ?? []).map((l) => l.name ?? ''),
    userType: p.user?.type ?? '',
    userLogin: p.user?.login ?? '',
    headRef: p.head?.ref ?? '',
    headSha: p.head?.sha ?? '',
    headRepo: p.head?.repo?.full_name ?? '',
    baseRef: p.base?.ref ?? ''
  }
}

/**
 * At most this many pages of open pull requests per request (100 each). At the default cap of 300 the count stops
 * by page 4 at the latest; the bound keeps a /suggest request far inside Workers' 50 subrequests whatever the cap
 * or the number of other open pull requests.
 */
export const MAX_PULL_PAGES = 5

/** A game suggestion's head branch (suggest/<key>-<id>): every suggest/ branch but the recompilations'. */
export const isGameSuggestion = (p: OpenPull): boolean =>
  p.headRef.startsWith('suggest/') && !p.headRef.startsWith('suggest/recomp/')

/** A recompilation suggestion's head branch (suggest/recomp/<file>-<id>). */
export const isRecompSuggestion = (p: OpenPull): boolean => p.headRef.startsWith('suggest/recomp/')

/**
 * The open pull requests, newest first (GitHub's order), and how many of them come from the relay's suggest/
 * branches, counting up to `cap + 1` at most (pages of 100, so a backlog costs one or two calls; never more than
 * MAX_PULL_PAGES, or `pages` when given). A list cut short by that bound counts as `cap + 1`: more pull requests
 * are open than the relay may page through, so it takes no new one (MAX_OPEN_SUGGESTIONS works up to 499).
 * With `wanted`, paging goes on past the cap (within the same page bound) until a pull request it accepts is seen:
 * an older open suggestion for the game being suggested may sit behind the newest ones.
 */
export async function listOpenSuggestions(
  ref: RepoRef,
  cap: number,
  pages = MAX_PULL_PAGES,
  wanted?: (p: OpenPull) => boolean,
  /**
   * Which open pull requests count toward `cap`: the game suggestions by default. The recompilation suggestions
   * (suggest/recomp/) have a backlog of their own, so a pile of them never stops the game suggestions.
   */
  counts: (p: OpenPull) => boolean = isGameSuggestion
): Promise<{ count: number; pulls: OpenPull[] }> {
  let count = 0
  let found = !wanted
  const all: OpenPull[] = []
  for (let page = 1; ; page++) {
    const raw = await gh<RawPull[]>(ref, 'GET', `/pulls?state=open&per_page=100&page=${page}`)
    const pulls = raw.map(openPullOf)
    all.push(...pulls)
    count += pulls.filter(counts).length
    if (wanted && !found) found = pulls.some(wanted)
    if ((count > cap && found) || raw.length < 100) break
    if (page >= pages) {
      count = Math.max(count, cap + 1)
      break
    }
  }
  return { count, pulls: all }
}

/** One pull request, or null when there is none of that number; `open` is false once it is closed or merged. */
export async function getPull(
  ref: RepoRef,
  number: number
): Promise<(OpenPull & { open: boolean }) | null> {
  try {
    const p = await gh<RawPull>(ref, 'GET', `/pulls/${number}`)
    return { ...openPullOf(p), open: p.state === 'open' }
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null
    throw e
  }
}

/** The id part of suggest/<key>-<id>: index.ts shortId (hex), or any run of a-z 0-9 without '-'. */
const SUGGEST_ID_RE = /^[a-z0-9]{1,32}$/

/**
 * The open pull requests the relay itself opened for one game, lowest number first: head branch
 * suggest/<key>-<id> in this repository (never a fork's), into `base`, labelled 'suggestion' or opened by a bot
 * (the app; its label may have failed), or opened by `where.author` when given (the login the relay signs in as:
 * with a GITHUB_TOKEN its pull requests are a user's, and one opened a moment ago may not have its label yet).
 * Nothing else is ever updated or closed by the relay.
 */
export function suggestionPullsFor(
  pulls: OpenPull[],
  key: string,
  where: { owner: string; repo: string; base: string; author?: string }
): OpenPull[] {
  const prefix = `suggest/${key}-`
  const repo = `${where.owner}/${where.repo}`.toLowerCase()
  return pulls
    .filter((p) => {
      if (!p.headRef.startsWith(prefix) || !SUGGEST_ID_RE.test(p.headRef.slice(prefix.length))) {
        return false
      }
      try {
        assertSuggestBranch(p.headRef)
      } catch {
        return false
      }
      return (
        p.headRepo.toLowerCase() === repo &&
        p.baseRef === where.base &&
        /^[0-9a-f]{40}$/.test(p.headSha) &&
        (p.labels.includes('suggestion') ||
          p.userType === 'Bot' ||
          (Boolean(where.author) && p.userLogin === where.author))
      )
    })
    .sort((a, b) => a.number - b.number)
}

/** The merge base of two commits (or branches). */
export async function mergeBase(ref: RepoRef, base: string, head: string): Promise<string> {
  const r = await gh<{ merge_base_commit?: { sha?: string } }>(
    ref,
    'GET',
    `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
  )
  const sha = r.merge_base_commit?.sha
  if (!sha) throw new GitHubError('GitHub returned no merge base', 502)
  return sha
}

/** The tree of a commit. */
export async function treeOf(ref: RepoRef, commit: string): Promise<string> {
  const c = await gh<{ tree: { sha: string } }>(
    ref,
    'GET',
    `/git/commits/${encodeURIComponent(commit)}`
  )
  return c.tree.sha
}

/**
 * A new commit, not on any branch yet: `baseTree` with one file set to `text`, on `parents`. Moving a suggest/
 * branch onto it (fastForwardSuggestBranch) is then one atomic step.
 */
export async function commitFileOn(
  ref: RepoRef,
  opts: { baseTree: string; parents: string[]; path: string; text: string; message: string }
): Promise<string> {
  const tree = await gh<{ sha: string }>(ref, 'POST', '/git/trees', {
    base_tree: opts.baseTree,
    tree: [{ path: opts.path, mode: '100644', type: 'blob', content: opts.text }]
  })
  const commit = await gh<{ sha: string }>(ref, 'POST', '/git/commits', {
    message: opts.message,
    tree: tree.sha,
    parents: opts.parents
  })
  return commit.sha
}

/**
 * Moves a suggest/ branch forward to `sha` (never main or any other ref). Not forced: GitHub refuses it (422) unless
 * `sha` descends from the branch's current head, so a branch another request moved meanwhile is never overwritten.
 */
export async function fastForwardSuggestBranch(
  ref: RepoRef,
  branch: string,
  sha: string
): Promise<void> {
  assertSuggestBranch(branch)
  await gh(ref, 'PATCH', `/git/refs/heads/${encodePath(branch)}`, { sha, force: false })
}

/** Changes a suggestion pull request's body, or closes it; refused for one whose head is not a suggest/ branch. */
export async function updateSuggestionPull(
  ref: RepoRef,
  pull: { number: number; headRef: string },
  patch: { body?: string; state?: 'closed' }
): Promise<void> {
  assertSuggestBranch(pull.headRef)
  await gh(ref, 'PATCH', `/pulls/${pull.number}`, patch)
}

/** A comment on a suggestion pull request; refused for one whose head is not a suggest/ branch. */
export async function commentOnSuggestionPull(
  ref: RepoRef,
  pull: { number: number; headRef: string },
  body: string
): Promise<void> {
  assertSuggestBranch(pull.headRef)
  await gh(ref, 'POST', `/issues/${pull.number}/comments`, { body })
}

/** A repository as GET /repos/{owner}/{repo} answers it, reduced to what /suggest-recomp looks at. */
export interface RepoInfo {
  /** "owner/repo" as GitHub spells it now (a renamed repository answers with its new name). */
  fullName: string
  private: boolean
  disabled: boolean
  archived: boolean
  fork: boolean
}

/**
 * Another repository's facts (a recompilation's, read only: the relay never writes anywhere but the metadata
 * repository's suggest/ branches). `ref` names that repository; null when GitHub has no such repository (404).
 */
export async function getRepoInfo(ref: RepoRef): Promise<RepoInfo | null> {
  try {
    const r = await gh<{
      full_name?: string
      private?: boolean
      visibility?: string
      disabled?: boolean
      archived?: boolean
      fork?: boolean
    }>(ref, 'GET', '')
    return {
      fullName: typeof r.full_name === 'string' ? r.full_name : '',
      private: r.private !== false || (r.visibility !== undefined && r.visibility !== 'public'),
      disabled: r.disabled === true,
      archived: r.archived === true,
      fork: r.fork === true
    }
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null
    throw e
  }
}

/** A repository's newest releases (one page of 10), reduced to what /suggest-recomp looks at. */
export async function listReleases(
  ref: RepoRef
): Promise<{ draft: boolean; prerelease: boolean; assets: number }[]> {
  const raw = await gh<unknown>(ref, 'GET', '/releases?per_page=10')
  if (!Array.isArray(raw)) throw new GitHubError('GitHub returned no release list', 502)
  return raw.map((r: { draft?: boolean; prerelease?: boolean; assets?: unknown[] }) => ({
    draft: r?.draft === true,
    prerelease: r?.prerelease === true,
    assets: Array.isArray(r?.assets) ? r.assets.length : 0
  }))
}
