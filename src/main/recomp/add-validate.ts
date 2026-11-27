// Checking a GitHub repository before it is added to the Recompilations browser (RecompBrowser's Add → Check): one
// pass per press, never retried. In turn: the link is read (parseGithubUrl), the repository is asked for (public, not
// disabled; the name GitHub spells it with now is the one used from then on; archived and forks are allowed, with a
// warning), it must not be listed already (a catalog, PlayOut's list or the user's own adds), and its releases must
// have a Windows download (the same pick an install makes). Nothing is downloaded or run. GitHub is read without
// signing in (the owner's metadata token is never used for this).
import type { RecompRepoCheck, RecompRepoRefusal } from '../../shared/recomp'
import { tMain } from '../i18n'
import { pickWindowsAsset } from './assets'
import { parseGithubUrl, repoKey } from './catalog'
import { originDisplayName, RECOMP_CONSOLE_IDS } from './consoles'
import { FetchFailed, RECOMP_USER_AGENT, type CachedFetchDeps } from './http-cache'
import {
  fetchReleases as realFetchReleases,
  newestRelease,
  RepoNotFound,
  type GhRelease
} from './releases'
import { oneLine, MAX_BLURB_CHARS, MAX_GAME_CHARS } from './added'

export interface RepoCheckDeps {
  cache: CachedFetchDeps
  fetch?: typeof fetch
  fetchReleases?: typeof realFetchReleases
  /** The recompilation already listed for this repository id (a catalog, PlayOut's list, the user's adds), else null. */
  listed(id: string): string | null
  now?: () => number
}

/** Words a repository's name carries that are not the game's ("Zelda64Recomp" → "Zelda64"). */
const NOT_THE_GAME =
  /\b(?:recomp(?:iled|ilation)?|decomp(?:iled|ilation)?|port|pc|native|windows|win(?:32|64)?|source|src|reverse|re|engine|remake)\b/gi

/** The game a repository is probably of, from its name: words split, project words left out. */
export function guessGame(repoName: string): string {
  const words = repoName
    .replace(/\.git$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .replace(NOT_THE_GAME, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const game = words || repoName
  return oneLine(game.charAt(0).toUpperCase() + game.slice(1), MAX_GAME_CHARS)
}

function refuse(
  reason: RecompRepoRefusal,
  vars: Record<string, string | number> = {},
  existingId?: string
): RecompRepoCheck {
  return {
    ok: false,
    reason,
    message: tMain(`mainRecomp.add.${reason}`, vars),
    ...(existingId ? { existingId } : {})
  }
}

/** "14:05" for GitHub's x-ratelimit-reset (seconds), or '' when it did not say. */
function resetTime(res: Response | null): string {
  const reset = Number(res?.headers.get('x-ratelimit-reset') ?? '')
  if (!Number.isFinite(reset) || reset <= 0) return ''
  return new Date(reset * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

const isRateLimited = (res: Response): boolean =>
  res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')

/** The consoles the dialog offers, with their names (RECOMP_CONSOLE_IDS, 'other' last). */
export function recompConsoles(): { id: string; name: string }[] {
  return RECOMP_CONSOLE_IDS.map((id) => ({ id, name: originDisplayName(id) }))
}

/** Check `input` (a link or "owner/repo") for the browser's Add. */
export async function checkRecompRepo(
  input: string,
  deps: RepoCheckDeps
): Promise<RecompRepoCheck> {
  const ref = parseGithubUrl(input)
  if ('error' in ref) return refuse(ref.error)
  const doFetch = deps.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(
      `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`,
      {
        headers: {
          'User-Agent': RECOMP_USER_AGENT,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        signal: AbortSignal.timeout(30_000)
      }
    )
  } catch (err) {
    return refuse('failed', { error: (err as Error).message })
  }
  if (isRateLimited(res)) return refuse('rateLimited', { time: resetTime(res) || '—' })
  if (res.status === 404 || res.status === 451) return refuse('notFound')
  if (!res.ok) return refuse('failed', { error: `GitHub ${res.status}` })
  let info: Record<string, unknown>
  try {
    info = (await res.json()) as Record<string, unknown>
  } catch {
    return refuse('failed', { error: 'GitHub did not answer with JSON' })
  }
  const fullName = typeof info.full_name === 'string' ? info.full_name : ''
  const isPublic = info.private === false && (info.visibility ?? 'public') === 'public'
  if (!isPublic || info.disabled === true) return refuse('notFound')
  const canonical = parseGithubUrl(fullName)
  if ('error' in canonical) return refuse('notFound')
  const repo = `${canonical.owner}/${canonical.repo}`
  const id = repoKey('github', repo)
  const listed = deps.listed(id)
  if (listed) return refuse('alreadyListed', { repo }, listed)

  let releases: GhRelease[]
  try {
    releases = await (deps.fetchReleases ?? realFetchReleases)({ host: 'github', repo }, deps.cache)
  } catch (err) {
    if (err instanceof RepoNotFound) return refuse('notFound')
    if (err instanceof FetchFailed && err.rateLimited) return refuse('rateLimited', { time: '—' })
    return refuse('failed', { error: (err as Error).message })
  }
  if (!releases.some((r) => !r.draft)) return refuse('noReleases')
  const newest = newestRelease(releases, { pattern: null })
  const picked = newest
    ? pickWindowsAsset(newest.assets, { pattern: null, tag: newest.tag_name })
    : null
  if (!newest || !picked) return refuse('noWindows')

  const description = oneLine(info.description, MAX_BLURB_CHARS)
  const license = (info.license as { spdx_id?: unknown; name?: unknown } | null) ?? null
  const licenseName =
    typeof license?.spdx_id === 'string' && license.spdx_id !== 'NOASSERTION'
      ? license.spdx_id
      : typeof license?.name === 'string'
        ? license.name
        : null
  return {
    ok: true,
    id,
    repo,
    repoUrl: `https://github.com/${repo}`,
    description,
    stars:
      typeof info.stargazers_count === 'number' && info.stargazers_count >= 0
        ? info.stargazers_count
        : null,
    license: licenseName ? licenseName.slice(0, 100) : null,
    archived: info.archived === true,
    fork: info.fork === true,
    tag: newest.tag_name,
    asset: { name: picked.asset.name, size: picked.asset.size },
    game: guessGame(canonical.repo),
    consoles: recompConsoles()
  }
}
