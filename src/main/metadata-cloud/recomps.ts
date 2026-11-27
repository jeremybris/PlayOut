// PlayOut's own list of recompilations (all.json `recomps`, built from the metadata repository's recomps/*.json):
// recompilations someone added in the browser and the owner approved. Read strictly: a row is kept only when its id,
// page and repository agree, its console is one PlayOut knows and its text is plain and short; anything else is
// dropped without a word (an older or a damaged all.json never breaks the browser).
import type { CloudRecomp } from '../../shared/recomp'
import { GITHUB_OWNER_RE, GITHUB_REPO_RE, repoKey } from '../recomp/catalog'
import { isRecompConsole } from '../recomp/consoles'

/** At most this many recompilations are read from all.json. */
export const MAX_CLOUD_RECOMPS = 5000
export const CLOUD_RECOMP_GAME_MAX = 200
export const CLOUD_RECOMP_BLURB_MAX = 500

/** Tags, script URLs and control characters: never shown (the repository's check refuses them too). */
const UNSAFE_TEXT = [
  /<[a-zA-Z/!?]/,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*text\/html/i,
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f]/
]

export const isSafeLine = (s: string): boolean => !UNSAFE_TEXT.some((re) => re.test(s))

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** "owner/repo" when `repo` is one GitHub could have, else null. */
export function githubRepoOf(repo: unknown): string | null {
  if (typeof repo !== 'string') return null
  const parts = repo.split('/')
  if (parts.length !== 2) return null
  const [owner, name] = parts as [string, string]
  if (!GITHUB_OWNER_RE.test(owner) || !GITHUB_REPO_RE.test(name) || name === '.' || name === '..')
    return null
  return repo
}

/** One row of all.json `recomps`, or null when it is not a valid one. */
export function parseCloudRecomp(raw: unknown): CloudRecomp | null {
  if (!isObject(raw)) return null
  const repo = githubRepoOf(raw.repo)
  if (!repo) return null
  if (raw.id !== repoKey('github', repo)) return null
  if (raw.repoUrl !== `https://github.com/${repo}`) return null
  if (!isRecompConsole(raw.systemId)) return null
  const game = typeof raw.game === 'string' ? raw.game.trim() : ''
  if (!game || game.length > CLOUD_RECOMP_GAME_MAX || !isSafeLine(game)) return null
  let blurb = ''
  if (raw.blurb !== undefined) {
    if (typeof raw.blurb !== 'string') return null
    blurb = raw.blurb.trim()
    if (blurb.length > CLOUD_RECOMP_BLURB_MAX || !isSafeLine(blurb)) return null
  }
  const addedAt =
    typeof raw.addedAt === 'string' &&
    raw.addedAt.length <= 64 &&
    !Number.isNaN(Date.parse(raw.addedAt))
      ? raw.addedAt
      : null
  return { id: raw.id, repo, repoUrl: raw.repoUrl, game, systemId: raw.systemId, blurb, addedAt }
}

/** all.json's `recomps` (or a cached copy of it): the valid rows, each id once, at most MAX_CLOUD_RECOMPS. */
export function parseCloudRecomps(raw: unknown): CloudRecomp[] {
  if (!Array.isArray(raw)) return []
  const out: CloudRecomp[] = []
  const seen = new Set<string>()
  for (const row of raw) {
    if (out.length >= MAX_CLOUD_RECOMPS) break
    const r = parseCloudRecomp(row)
    if (!r || seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  return out
}

/** The metadata repository's file of a recompilation: recomps/<owner>__<repo>.json, lower case. */
export function recompFilePath(repo: string): string {
  return `recomps/${repo.replace('/', '__').toLowerCase()}.json`
}
