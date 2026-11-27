// A recompilation's releases (GitHub, GitLab or Codeberg/Forgejo), all mapped to GitHub's shape, through the
// conditional-GET cache (a revalidation answered 304 does not count against GitHub's 60-an-hour anonymous limit);
// which release to offer, whether a tag is newer than the installed one, and the project's README.
import type { RecompEntry, RecompRelease } from '../../shared/recomp'
import { isSidePiece, pickWindowsAsset, type AssetHint, type ReleaseAsset } from './assets'
import { cachedFetch, type CachedFetchDeps } from './http-cache'

export interface GhRelease {
  tag_name: string
  name: string | null
  published_at: string | null
  prerelease: boolean
  draft: boolean
  body: string | null
  html_url: string
  assets: ReleaseAsset[]
}

/** Release lists are fresh for 6 hours (RecompLauncher's RELEASES_FRESH); a forced check revalidates. */
const RELEASES_MAX_AGE_MS = 6 * 3600_000
const README_MAX_AGE_MS = 24 * 3600_000
/** A README larger than this is cut (some embed whole changelogs). */
const README_MAX_CHARS = 200 * 1024

type Json = Record<string, unknown>

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The project's repository is gone: the host answered 404 for its release list (cached as an empty body). A
 * repository without releases answers an empty list ("[]"), never 404, so this always means removed, renamed or
 * made private.
 */
export class RepoNotFound extends Error {
  constructor(entry: Pick<RecompEntry, 'host' | 'repo'>) {
    const host =
      entry.host === 'gitlab' ? 'GitLab' : entry.host === 'codeberg' ? 'Codeberg' : 'GitHub'
    super(`${entry.repo} was not found on ${host} (removed, renamed or made private)`)
    this.name = 'RepoNotFound'
  }
}

function parseList(body: string, what: string): unknown[] {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    throw new Error(`${what} did not answer with JSON`)
  }
  if (!Array.isArray(data)) throw new Error(`${what} did not answer with a release list`)
  return data
}

/** GitHub's and Forgejo's release objects (Forgejo uses GitHub's field names). */
function fromGithubShape(r: unknown): GhRelease | null {
  if (!isObject(r)) return null
  const tag = str(r.tag_name)
  if (!tag) return null
  const assets: ReleaseAsset[] = []
  for (const a of Array.isArray(r.assets) ? r.assets : []) {
    if (!isObject(a)) continue
    const name = str(a.name)
    const url = str(a.browser_download_url)
    if (!name || !url) continue
    assets.push({ name, size: num(a.size), browser_download_url: url, digest: str(a.digest) })
  }
  return {
    tag_name: tag,
    name: str(r.name),
    published_at: str(r.published_at) ?? str(r.created_at),
    prerelease: r.prerelease === true,
    draft: r.draft === true,
    body: str(r.body),
    html_url: str(r.html_url) ?? '',
    assets
  }
}

/** GitLab's release objects: links instead of uploaded assets, no sizes or digests, upcoming = not out yet. */
function fromGitlab(r: unknown, repo: string): GhRelease | null {
  if (!isObject(r)) return null
  const tag = str(r.tag_name)
  if (!tag) return null
  const links = isObject(r.assets) && Array.isArray(r.assets.links) ? r.assets.links : []
  const assets: ReleaseAsset[] = []
  for (const l of links) {
    if (!isObject(l)) continue
    const url = str(l.direct_asset_url) ?? str(l.url)
    const name = str(l.name) ?? (url ? decodeURIComponent(url.split('/').pop() ?? '') : null)
    if (!name || !url) continue
    assets.push({ name, size: 0, browser_download_url: url, digest: null })
  }
  const self = isObject(r._links) ? str(r._links.self) : null
  return {
    tag_name: tag,
    name: str(r.name),
    published_at: str(r.released_at) ?? str(r.created_at),
    prerelease: false,
    draft: r.upcoming_release === true,
    body: str(r.description),
    html_url: self ?? `https://gitlab.com/${repo}/-/releases/${encodeURIComponent(tag)}`,
    assets
  }
}

/** The release-list URL of a project (GitLab's project path is URL-encoded as one segment). */
export function releasesUrl(entry: Pick<RecompEntry, 'host' | 'repo'>): string {
  switch (entry.host) {
    case 'gitlab':
      return `https://gitlab.com/api/v4/projects/${encodeURIComponent(entry.repo)}/releases?per_page=30`
    case 'codeberg':
      return `https://codeberg.org/api/v1/repos/${entry.repo}/releases?limit=30`
    default:
      return `https://api.github.com/repos/${entry.repo}/releases?per_page=30`
  }
}

/**
 * The project's releases, newest first as the host lists them. Throws when the host fails and nothing is cached, and
 * RepoNotFound when the repository no longer exists.
 */
export async function fetchReleases(
  entry: Pick<RecompEntry, 'host' | 'repo'>,
  deps: CachedFetchDeps,
  opts: { force?: boolean } = {}
): Promise<GhRelease[]> {
  const url = releasesUrl(entry)
  const headers: Record<string, string> =
    entry.host === 'github'
      ? { Accept: 'application/vnd.github+json' }
      : { Accept: 'application/json' }
  const { body } = await cachedFetch(url, deps, {
    maxAgeMs: RELEASES_MAX_AGE_MS,
    force: opts.force,
    headers
  })
  // A 404 is cached as an empty body (so a missing repo is not asked again on every check).
  if (!body.trim()) throw new RepoNotFound(entry)
  const list = parseList(body, new URL(url).host)
  const map = entry.host === 'gitlab' ? (r: unknown) => fromGitlab(r, entry.repo) : fromGithubShape
  return list.map(map).filter((r): r is GhRelease => r !== null)
}

/** "sha256:<64 hex>" -> the lowercase hex, else null. */
export function sha256FromDigest(d?: string | null): string | null {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(d?.trim() ?? '')
  return m ? m[1]!.toLowerCase() : null
}

/** Tags compare without a leading "v" and ignoring case. */
export function sameTag(a: string, b: string): boolean {
  const clean = (t: string): string =>
    t
      .trim()
      .toLowerCase()
      .replace(/^v(?=\d)/, '')
  return clean(a) === clean(b)
}

/** Releases that say they are not real releases (test uploads), never offered. */
function notARelease(r: GhRelease): boolean {
  const text = `${r.name ?? ''} ${r.tag_name}`
  return /not[\s_-]*a[\s_-]*release|test[\s_-]*(file|build)?[\s_-]*only/i.test(text)
}

/**
 * A comparable version key from a tag: up to four numbers, then 1 for a final release or 0 for a pre-release
 * (alpha/beta/rc/pre/dev/nightly) and its number. Null when the tag has no number.
 */
export function versionKey(tag: string): number[] | null {
  const t = tag.toLowerCase()
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/.exec(t)
  if (!m) return null
  const nums = [1, 2, 3, 4].map((i) => Number(m[i] ?? 0))
  const rest = t.slice(m.index + m[0].length)
  const pre = /(alpha|beta|rc|pre|preview|dev|nightly|test)[^0-9]*(\d+)?/.exec(rest)
  return [...nums, pre ? 0 : 1, pre ? Number(pre[2] ?? 0) : 0]
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

const timeOf = (r: GhRelease): number | null => {
  const t = r.published_at ? Date.parse(r.published_at) : NaN
  return Number.isFinite(t) ? t : null
}

/** The letters in front of a tag's version number ("v1.2" -> "", "geometrywars3-v1" -> "geometrywars"). */
function tagPrefix(tag: string): string {
  const t = tag.trim().toLowerCase()
  const m = /\d/.exec(t)
  return (m ? t.slice(0, m.index) : t).replace(/[^a-z]+/g, '').replace(/^v$/, '')
}

/**
 * Version order of two tags numbered the same way (the same letters in front of the number), else null: a backport
 * ("v1.9.5" published after "v2.0.0") is still older, while "geometrywars3-v1" and "splitsecond-v2" say nothing.
 */
function compareVersions(a: string, b: string): number | null {
  if (tagPrefix(a) !== tagPrefix(b)) return null
  const ka = versionKey(a)
  const kb = versionKey(b)
  if (!ka || !kb) return null
  return compareKeys(ka, kb)
}

/**
 * Positive when release `a` is newer than `b`: by version when both tags are numbered the same way, else (or on a
 * tie) by publish date (both known), else by list order (hosts list newest first).
 */
function compareReleases(a: GhRelease, b: GhRelease, releases: GhRelease[]): number {
  const byVersion = compareVersions(a.tag_name, b.tag_name)
  if (byVersion) return byVersion
  const at = timeOf(a)
  const bt = timeOf(b)
  if (at !== null && bt !== null && at !== bt) return at - bt
  return releases.indexOf(b) - releases.indexOf(a)
}

/**
 * Whether `candidateTag` is newer than `installedTag`. Both in the list: by version when both tags are numbered the
 * same way, else by publish date (both known), else by list order. Otherwise by the numbers in the tags; tags without
 * numbers are never "newer". The same tag is never newer (isRepublished covers rolling tags).
 */
export function isNewer(
  candidateTag: string,
  installedTag: string,
  releases: GhRelease[]
): boolean {
  if (sameTag(candidateTag, installedTag)) return false
  const ci = releases.findIndex((r) => sameTag(r.tag_name, candidateTag))
  const ii = releases.findIndex((r) => sameTag(r.tag_name, installedTag))
  if (ci >= 0 && ii >= 0) return compareReleases(releases[ci]!, releases[ii]!, releases) > 0
  const ck = versionKey(candidateTag)
  const ik = versionKey(installedTag)
  if (!ck || !ik) return false
  return compareKeys(ck, ik) > 0
}

/** What PlayOut recorded about the installed release (InstalledRecomp's fields). */
export interface InstalledRelease {
  tag: string
  asset?: string
  downloadBytes?: number
  sha256?: string
  publishedAt?: string | null
}

/**
 * Whether the install is a side piece of the game (its server, an editor ...: a catalog named it by mistake) and
 * `candidate` has the game itself: then updating to it, even at the same tag, installs the game.
 */
export function replacesSidePiece(
  candidate: GhRelease,
  installed: InstalledRelease,
  hint: AssetHint
): boolean {
  if (!installed.asset || !isSidePiece(installed.asset)) return false
  const picked = pickWindowsAsset(candidate.assets, { ...hint, tag: candidate.tag_name })
  return !!picked && !isSidePiece(picked.asset.name)
}

/**
 * Whether `candidate` is the installed tag published again with another build: projects with a rolling tag
 * ("nightly", "latest", "continuous") delete the release and create it anew. Known publish dates decide (the
 * candidate is later); an install record without one compares the Windows file of the same name by checksum, else by
 * size.
 */
export function isRepublished(
  candidate: GhRelease,
  installed: InstalledRelease,
  hint: AssetHint
): boolean {
  if (!sameTag(candidate.tag_name, installed.tag)) return false
  const ct = timeOf(candidate)
  const it = installed.publishedAt ? Date.parse(installed.publishedAt) : NaN
  if (ct !== null && Number.isFinite(it)) return ct > it
  const picked = pickWindowsAsset(candidate.assets, { ...hint, tag: candidate.tag_name })
  if (!picked || !installed.asset || picked.asset.name !== installed.asset) return false
  const sha = sha256FromDigest(picked.asset.digest)
  if (sha && installed.sha256) return sha !== installed.sha256.toLowerCase()
  return (
    !!picked.asset.size &&
    !!installed.downloadBytes &&
    picked.asset.size !== installed.downloadBytes
  )
}

/**
 * The release to offer: the newest non-draft, non-pre-release one with a Windows build (pre-releases count when the
 * installed one is a pre-release). Never one older than the installed release: then null (nothing to offer). The
 * installed release itself may come back (it is the newest), so callers compare with isNewer. `opts.hasDownload`
 * replaces the Windows-build test (VR mods keep other files too); `opts.allowPre` counts pre-releases anyway.
 */
export function latestRelease(
  releases: GhRelease[],
  installedTag: string | null,
  hint: AssetHint,
  opts: { hasDownload?: (r: GhRelease) => boolean; allowPre?: boolean } = {}
): GhRelease | null {
  const installed = installedTag
    ? releases.find((r) => sameTag(r.tag_name, installedTag))
    : undefined
  const allowPre = opts.allowPre === true || installed?.prerelease === true
  const hasDownload =
    opts.hasDownload ??
    ((r: GhRelease) => pickWindowsAsset(r.assets, { ...hint, tag: r.tag_name }) !== null)
  const candidates = releases.filter(
    (r) => !r.draft && (allowPre || !r.prerelease) && !notARelease(r) && hasDownload(r)
  )
  if (!candidates.length) return null
  // Newest: by version (a backport published later is still older), then publish date, then the host's order.
  const newest = candidates.reduce((a, b) => (compareReleases(b, a, releases) > 0 ? b : a))
  if (
    installedTag &&
    !sameTag(newest.tag_name, installedTag) &&
    !isNewer(newest.tag_name, installedTag, releases)
  )
    return null
  return newest
}

/**
 * The project's newest release with a Windows build, whatever is installed: the newest full release, else (a project
 * that only publishes pre-releases) the newest pre-release. Null = none has a Windows build.
 */
export function newestRelease(releases: GhRelease[], hint: AssetHint): GhRelease | null {
  return (
    latestRelease(releases, null, hint) ?? latestRelease(releases, null, hint, { allowPre: true })
  )
}

/**
 * The pin a release chosen under Change version leaves (InstalledRecomp.pinnedTag): its tag when the project has a
 * newer release with a Windows build (the user wants to stay on the older one), else null (it is the newest, or newer
 * than the newest full release: it follows updates again).
 */
export function pinFor(releases: GhRelease[], chosenTag: string, hint: AssetHint): string | null {
  const newest = newestRelease(releases, hint)
  return newest && isNewer(newest.tag_name, chosenTag, releases) ? chosenTag : null
}

/** A release for the Updates list, with the Windows file PlayOut would download. */
export function toRecompRelease(r: GhRelease, hint: AssetHint): RecompRelease {
  const picked = pickWindowsAsset(r.assets, { ...hint, tag: r.tag_name })
  return {
    tag: r.tag_name,
    name: r.name?.trim() || r.tag_name,
    publishedAt: r.published_at,
    prerelease: r.prerelease,
    notes: r.body ?? '',
    url: r.html_url,
    asset: picked
      ? {
          name: picked.asset.name,
          size: picked.asset.size,
          sha256: sha256FromDigest(picked.asset.digest)
        }
      : null
  }
}

/** The README's raw-text URL and Accept header for a project. */
function readmeRequest(entry: Pick<RecompEntry, 'host' | 'repo'>): {
  url: string
  headers: Record<string, string>
} {
  switch (entry.host) {
    case 'gitlab':
      return {
        url: `https://gitlab.com/api/v4/projects/${encodeURIComponent(entry.repo)}/repository/files/README.md/raw?ref=HEAD`,
        headers: {}
      }
    case 'codeberg':
      return { url: `https://codeberg.org/api/v1/repos/${entry.repo}/raw/README.md`, headers: {} }
    default:
      return {
        url: `https://api.github.com/repos/${entry.repo}/readme`,
        headers: { Accept: 'application/vnd.github.raw' }
      }
  }
}

/** The project's README as Markdown (cut at 200 KB); '' when it has none or the host cannot be reached. */
export async function fetchReadme(
  entry: Pick<RecompEntry, 'host' | 'repo'>,
  deps: CachedFetchDeps
): Promise<string> {
  const { url, headers } = readmeRequest(entry)
  try {
    const { body } = await cachedFetch(url, deps, { maxAgeMs: README_MAX_AGE_MS, headers })
    return body.length > README_MAX_CHARS ? body.slice(0, README_MAX_CHARS) : body
  } catch (err) {
    deps.log.warn(`README of ${entry.repo}: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}
