// The recompilation catalog: decomp-buddy's repository list (finds.json + plans.json, tanookistudios.com) is the
// base, RecompLauncher's pc-catalog.json (recomplauncher.com) enriches it (curated names, blurbs, tags, art, sizes,
// how the game files are provided, which version of a game is recommended) and adds the projects decomp-buddy does
// not list. Both are fetched at runtime through the conditional-GET cache and boiled down here to the Windows
// releases PlayOut can download: plans.json is ~16 MB, so only what a RecompEntry needs is kept.
import { promises as fs } from 'fs'
import { join } from 'path'
import type { CachedFetchDeps } from './http-cache'
import { cacheKey, cachedFetch } from './http-cache'
import { originDisplayName, systemIdForConsole } from './consoles'
import { isSidePiece, notForWindows } from './assets'
import { systemGroup } from './match'
import { normalizeGameTitle, titleKeyOf, withoutBrackets, withoutVersionWord } from './titles'
import type {
  AddedRecomp,
  CloudRecomp,
  GameFileHow,
  GameFileNeed,
  RecompEntry,
  RecompRepoRefusal,
  RecompTag,
  RecompTitle
} from '../../shared/recomp'
import { tMain } from '../i18n'

export const FINDS_URL = 'https://tanookistudios.com/decomp-buddy/finds.json'
export const PLANS_URL = 'https://tanookistudios.com/decomp-buddy/plans.json'
export const RL_CATALOG_URL = 'https://recomplauncher.com/pc-catalog.json'

/** Catalogs are re-read from the hosts at most once a day (a Refresh revalidates at once). */
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** plans.json is ~16 MB: give a slow connection more than the cache's default minute. */
const CATALOG_TIMEOUT_MS = 5 * 60 * 1000

export interface RecompCatalog {
  entries: Map<string, RecompEntry>
  titles: Map<string, RecompTitle>
  /** "host:owner/repo" lowercase -> entry ids (several for a multi-game repo). */
  byRepo: Map<string, string[]>
  /**
   * RecompLauncher's app id (its pc-catalog id, the folder name in its library) -> entry ids. Absent in catalogs made
   * by hand (tests).
   */
  byRl?: Map<string, string[]>
  fetchedAt: { 'decomp-buddy': string | null; recomplauncher: string | null }
  /** Sources that could not be reached (a cached copy, or nothing, in use). */
  offline: string[]
}

type Host = RecompEntry['host']
type Completeness = NonNullable<RecompEntry['completeness']>

// --- defensive readers (the catalogs are someone else's JSON) -------------------------------------------------------

type Obj = Record<string, unknown>

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}
function strings(v: unknown): string[] {
  return arr(v)
    .map(str)
    .filter((s): s is string => s !== null)
}

// --- small helpers --------------------------------------------------------------------------------------------------

/** "Pokémon SoulSilver" → "pokemon-soulsilver" (the "#slug" of a game in a multi-game repo). */
export function slugOf(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** "28 MB" / "1.2 GB" / "900 KB" → bytes (RecompLauncher's sizes are rounded display text). */
export function parseSize(text: unknown): number | null {
  if (typeof text === 'number') return num(text)
  const m = /^\s*([\d.,]+)\s*(b|bytes|kb|kib|mb|mib|gb|gib|tb|tib)\s*$/i.exec(String(text ?? ''))
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  if (!Number.isFinite(n) || n < 0) return null
  const unit = m[2].toLowerCase()
  const pow = unit.startsWith('k')
    ? 1
    : unit.startsWith('m')
      ? 2
      : unit.startsWith('g')
        ? 3
        : unit.startsWith('t')
          ? 4
          : 0
  return Math.round(n * 1024 ** pow)
}

/** A repo reference ("owner/repo", "gitlab:group/repo", "forgejo:codeberg.org/o/r") → host + path; null = unsupported. */
export function parseRepoRef(
  ref: string,
  hostField: string | null
): { host: Host; repo: string } | null {
  let host: string = hostField?.toLowerCase() ?? 'github'
  let repo = ref.trim().replace(/^https?:\/\/(?:www\.)?/i, '')
  const prefixed = /^([a-z]+):(.+)$/i.exec(repo)
  if (prefixed) {
    host = prefixed[1].toLowerCase()
    repo = prefixed[2]
  } else if (/^github\.com\//i.test(repo)) {
    host = 'github'
    repo = repo.slice('github.com/'.length)
  } else if (/^gitlab\.com\//i.test(repo)) {
    host = 'gitlab'
    repo = repo.slice('gitlab.com/'.length)
  } else if (/^codeberg\.org\//i.test(repo)) {
    host = 'codeberg'
    repo = repo.slice('codeberg.org/'.length)
  }
  if (host === 'forgejo') {
    // RecompLauncher's "forgejo:<server>/<owner>/<repo>": only Codeberg's server is supported.
    const m = /^codeberg\.org\/(.+)$/i.exec(repo)
    if (!m) return null
    host = 'codeberg'
    repo = m[1]
  }
  repo = repo.replace(/\.git$/i, '').replace(/\/+$/, '')
  if (host !== 'github' && host !== 'gitlab' && host !== 'codeberg') return null
  const parts = repo.split('/')
  if (parts.length < 2 || parts.some((p) => !p || p === '.' || p === '..' || /[\s?#]/.test(p)))
    return null
  if (host !== 'gitlab' && parts.length !== 2) return null
  return { host, repo }
}

/** "host:owner/repo" lower case: the key of a repository (RecompCatalog.byRepo), and an added recompilation's id. */
export function repoKey(host: Host, repo: string): string {
  return `${host}:${repo}`.toLowerCase()
}

export function repoUrlOf(host: Host, repo: string): string {
  const base =
    host === 'github'
      ? 'https://github.com'
      : host === 'gitlab'
        ? 'https://gitlab.com'
        : 'https://codeberg.org'
  return `${base}/${repo}`
}

const INSTALLER_RE = /(?:setup|install(?:er)?)[^/]*\.(?:exe|msi)$|\.msi$/i

/** A program to start, as the catalogs give it: a relative path or bare name of an .exe/.bat/.cmd, never prose. */
function cleanExe(v: unknown): string | null {
  const s = str(v)
  if (!s || s.length > 200) return null
  if (!/^[^<>:"|?*]+\.(?:exe|bat|cmd)$/i.test(s)) return null
  if (s.split(/\s+/).length > 6) return null
  const rel = s.replace(/\\/g, '/').replace(/^\.\//, '')
  if (rel.startsWith('/') || rel.split('/').includes('..')) return null
  return rel
}

/** Numeric parts of a version tag ("v1.2.10-beta3" → [1, 2, 10, 3]), for choosing the newer of two catalog tags. */
function versionParts(tag: string): number[] {
  return (tag.match(/\d+/g) ?? []).map(Number)
}

/** >0 when `a` is the newer tag, <0 when `b` is, 0 when equal or not comparable. */
function compareTags(a: string, b: string): number {
  const na = a.replace(/^v/i, '').toLowerCase()
  const nb = b.replace(/^v/i, '').toLowerCase()
  if (na === nb) return 0
  const pa = versionParts(na)
  const pb = versionParts(nb)
  if (!pa.length || !pb.length) return 0
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

function sameTag(a: string | null, b: string | null): boolean {
  return !!a && !!b && a.replace(/^v/i, '').toLowerCase() === b.replace(/^v/i, '').toLowerCase()
}

/** A "*" wildcard asset pattern (RecompLauncher) tested against an exact asset name. */
function patternMatches(pattern: string, name: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i'
  )
  return re.test(name)
}

const COMPLETENESS: Record<string, Completeness> = {
  playable: 'playable',
  mostly: 'mostly',
  partial: 'partial',
  wip: 'wip'
}
// Getters: the words are read in PlayOut's language when a catalog is built, not when this module loads.
const COMPLETENESS_TAG: Record<Completeness, string> = {
  get playable() {
    return tMain('mainRecomp.tags.playable')
  },
  get mostly() {
    return tMain('mainRecomp.tags.mostly')
  },
  get partial() {
    return tMain('mainRecomp.tags.partial')
  },
  get wip() {
    return tMain('mainRecomp.tags.wip')
  }
}
/** decomp-buddy's facts.features keys, as feature lines when RecompLauncher has none. */
const DB_FEATURES: Record<string, string> = {
  get fps60() {
    return tMain('mainRecomp.features.fps60')
  },
  get widescreen() {
    return tMain('mainRecomp.features.widescreen')
  },
  get hd() {
    return tMain('mainRecomp.features.hd')
  },
  get mods() {
    return tMain('mainRecomp.features.mods')
  },
  get online() {
    return tMain('mainRecomp.features.online')
  },
  get coop() {
    return tMain('mainRecomp.features.coop')
  },
  get raytracing() {
    return tMain('mainRecomp.features.raytracing')
  }
}

// --- game-file needs ------------------------------------------------------------------------------------------------

const NEED_KINDS = new Set<GameFileNeed['kind']>(['game', 'bios', 'dlc', 'update', 'other'])
const HASH_ALGOS = new Set(['sha1', 'md5', 'crc32', 'sha256'])
const HASH_LENGTH: Record<string, number> = { sha1: 40, md5: 32, crc32: 8, sha256: 64 }

/** decomp-buddy's accepted_formats sometimes lists "folder" next to the extensions. */
const FOLDER_WORDS = /^\.?(?:folder|directory|dir|extracted)$/i

function cleanFormats(v: unknown): string[] {
  const out = new Set<string>()
  for (const f of strings(v)) {
    if (FOLDER_WORDS.test(f)) continue
    const ext = (f.startsWith('.') ? f : `.${f}`).toLowerCase()
    if (/^\.[a-z0-9]{1,8}$/.test(ext)) out.add(ext)
  }
  return [...out]
}

function cleanHashes(v: unknown): GameFileNeed['hashes'] {
  const out: GameFileNeed['hashes'] = []
  for (const h of arr(v)) {
    const o = obj(h)
    const algo = str(o?.algo)?.toLowerCase()
    const value = str(o?.value)?.toLowerCase()
    if (!algo || !value || !HASH_ALGOS.has(algo) || !/^[0-9a-f]+$/.test(value)) continue
    if (value.length !== HASH_LENGTH[algo]) continue
    if (!out.some((x) => x.algo === algo && x.value === value)) {
      out.push({ algo: algo as GameFileNeed['hashes'][number]['algo'], value })
    }
  }
  return out
}

/** A command-line flag the notes name ("pass it with --rom <path>"); double-dash flags only, to stay safe. */
function flagFromText(...texts: (string | null)[]): string {
  for (const t of texts) {
    const m = t && /(?:^|[\s`'"(])(--[a-z][a-z0-9_-]*)(?=[\s=`'")]|$)/i.exec(t)
    if (m) return m[1]
  }
  return ''
}

function looksOptional(...texts: (string | null)[]): boolean {
  return texts.some((t) => !!t && /\boptional\b/i.test(t))
}

/** One decomp-buddy plan `game_files[]` item → a need (without its id). */
function needFromPlan(raw: unknown): Omit<GameFileNeed, 'id'> | null {
  const f = obj(raw)
  if (!f) return null
  const label = str(f.label) ?? tMain('mainRecomp.files.gameFiles')
  const description = str(f.description) ?? ''
  const notes = str(f.notes)
  const kindRaw = str(f.kind)?.toLowerCase() as GameFileNeed['kind'] | undefined
  const kind = kindRaw && NEED_KINDS.has(kindRaw) ? kindRaw : 'other'
  const formats = cleanFormats(f.accepted_formats)
  const provided = str(f.how_provided)
  const dropInto = str(f.drop_into)
  let how: GameFileHow = 'self'
  let folder: string | undefined
  let flag: string | undefined
  if (provided === 'folder') {
    // "Game Files" is decomp-buddy's name for the recomp's own picker, not a folder.
    if (dropInto && !/^game files$/i.test(dropInto)) {
      const rel =
        dropInto
          .replace(/\\/g, '/')
          .replace(/^\.\/+/, '')
          .replace(/\/+$/, '') || '.'
      if (!rel.startsWith('/') && !/^[a-z]:/i.test(rel) && !rel.split('/').includes('..')) {
        how = 'folder'
        folder = rel
      }
    }
  } else if (provided === 'command_line') {
    how = 'flag'
    flag = flagFromText(notes, description)
  }
  const text = `${label} ${description}`
  const folderListed = strings(f.accepted_formats).some((x) => FOLDER_WORDS.test(x))
  let accepts: GameFileNeed['accepts'] = 'file'
  if (folderListed) accepts = formats.length ? 'either' : 'folder'
  else if (!formats.length && /\b(folder|directory|extracted)\b/i.test(text)) accepts = 'either'
  const need: Omit<GameFileNeed, 'id'> = {
    label,
    description: description || notes || label,
    kind,
    how,
    accepts,
    formats,
    optional: kind === 'dlc' || looksOptional(label, description),
    hashes: cleanHashes(f.expected_hashes)
  }
  if (folder) need.folder = folder
  if (flag !== undefined) need.flag = flag
  const fileName = str(f.expected_filename)
  if (fileName && !/[\\/]/.test(fileName)) need.fileName = fileName
  const region = str(f.expected_region)
  if (region && !/^(?:any|all|none|n\/a|unknown|region[- ]free)$/i.test(region))
    need.region = region
  const serial = str(f.expected_serial)
  if (serial) need.serial = serial
  return need
}

/** N64 header region letters RecompLauncher uses ("E" = USA, "P" = Europe, "J" = Japan). */
const N64_REGIONS: Record<string, string> = { E: 'USA', P: 'Europe', J: 'Japan', U: 'Australia' }

function rlRegion(region: string | null, systemId: string | null): string | undefined {
  if (!region) return undefined
  if (region.length > 3) return region
  if (systemId === 'n64' && /^[EPJU]+$/.test(region)) {
    return [...region].map((c) => N64_REGIONS[c]).join(' or ')
  }
  return undefined
}

/** RecompLauncher `boot.files` (one object, sometimes a list) → needs. Null = it says nothing; [] = nothing needed. */
function needsFromRl(
  raw: unknown,
  game: string,
  systemId: string | null
): Omit<GameFileNeed, 'id'>[] | null {
  const items = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw])
    .map(obj)
    .filter((o): o is Obj => o !== null)
  if (!items.length) return null
  const out: Omit<GameFileNeed, 'id'>[] = []
  for (const f of items) {
    const howRaw = str(f.how)?.toLowerCase() ?? 'unknown'
    if (howRaw === 'none') continue
    const what = str(f.what) ?? tMain('mainRecomp.files.yourCopy', { game })
    const flagRaw = typeof f.flag === 'string' ? f.flag.trim() : null
    const env = str(f.env)
    const folderRaw = str(f.folder)
    let how: GameFileHow
    if (howRaw === 'folder' && folderRaw) how = 'folder'
    else if (howRaw === 'flag' && flagRaw !== null) how = 'flag'
    else if (howRaw === 'env' && env) how = 'env'
    else if (howRaw === 'unknown' && flagRaw) how = 'flag'
    else if (howRaw === 'unknown' && env) how = 'env'
    else how = 'self' // 'self', 'setup' (the game's own setup asks), unknown
    const acceptsText = str(f.accepts)?.toLowerCase() ?? 'file'
    const folderOk = /\bfolder\b/.test(acceptsText)
    const fileOk = /\b(file|iso|image)\b/.test(acceptsText)
    // A disc image the recomp wants extracted ("extract": "xdvdfs" / "iso9660"): PlayOut does not extract images,
    // so only the extracted folder is taken (a raw .iso copied in would not be found).
    const extract = str(f.extract)
    const accepts: GameFileNeed['accepts'] =
      extract && folderOk ? 'folder' : folderOk && fileOk ? 'either' : folderOk ? 'folder' : 'file'
    const formats = accepts !== 'folder' && /\biso\b/.test(acceptsText) ? ['.iso'] : []
    const need: Omit<GameFileNeed, 'id'> = {
      label: tMain('mainRecomp.files.yourCopy', { game }),
      description:
        extract && accepts === 'folder' && fileOk
          ? tMain('mainRecomp.files.extractFirst', { what, tool: extract })
          : what,
      kind: str(f.role) === 'update' ? 'update' : 'game',
      how,
      accepts,
      formats,
      optional: /^\s*optional\b/i.test(what),
      hashes: cleanHashes(
        strings(Array.isArray(f.sha256) ? f.sha256 : [f.sha256]).map((value) => ({
          algo: 'sha256',
          value
        }))
      )
    }
    if (how === 'folder' && folderRaw) {
      const rel =
        folderRaw
          .replace(/\\/g, '/')
          .replace(/^\.\/+/, '')
          .replace(/\/+$/, '') || '.'
      if (rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.split('/').includes('..'))
        need.how = 'self'
      else need.folder = rel
    }
    if (need.how === 'flag') need.flag = flagRaw ?? ''
    if (need.how === 'env' && env) need.env = env
    const contains = strings(f.contains)
    if (accepts === 'file' && contains[0] && !/[\\/]/.test(contains[0])) need.fileName = contains[0]
    // The folder's own files ("default.xex", a .cue) belong straight in `folder`, not in a subfolder named after
    // the picked one.
    if (need.how === 'folder' && accepts === 'folder' && (contains.length || extract)) {
      need.intoFolder = true
    }
    const region = rlRegion(str(f.region), systemId)
    if (region) need.region = region
    out.push(need)
  }
  return out
}

/** Gives needs stable ids: the first of each kind is the kind ("game", "bios"), later ones "game-2", ... */
function withIds(needs: Omit<GameFileNeed, 'id'>[]): GameFileNeed[] {
  const seen = new Map<string, number>()
  return needs.map((n) => {
    const count = (seen.get(n.kind) ?? 0) + 1
    seen.set(n.kind, count)
    return { id: count === 1 ? n.kind : `${n.kind}-${count}`, ...n }
  })
}

/**
 * Both catalogs' needs → one list. RecompLauncher's `boot.files` is curated, so it decides how the main game copy is
 * provided (or that nothing is needed); decomp-buddy keeps its hashes, serial and formats on that game need, and adds
 * the BIOS / DLC / update needs RecompLauncher does not describe.
 */
function mergeNeeds(
  db: Omit<GameFileNeed, 'id'>[],
  rl: Omit<GameFileNeed, 'id'>[] | null
): GameFileNeed[] {
  if (rl === null) return withIds(db)
  if (rl.length === 0) return []
  const dbGame = db.find((n) => n.kind === 'game')
  const merged = rl.map((n) => {
    if (n.kind !== 'game' || !dbGame) return n
    const m: Omit<GameFileNeed, 'id'> = { ...n, label: dbGame.label }
    if (!m.hashes.length) m.hashes = dbGame.hashes
    if (dbGame.formats.length && m.accepts !== 'folder') m.formats = dbGame.formats
    if (!m.region && dbGame.region) m.region = dbGame.region
    if (dbGame.serial) m.serial = dbGame.serial
    if (!m.fileName && dbGame.fileName && m.how === 'folder' && !m.intoFolder)
      m.fileName = dbGame.fileName
    return m
  })
  for (const n of db) if (n.kind !== 'game') merged.push(n)
  return withIds(merged)
}

// --- intermediate records -------------------------------------------------------------------------------------------

interface DbPart {
  game: string
  consoleText: string
  tag: string | null
  asset: string | null
  exe: string | null
  sha256: string | null
  size: number | null
  needs: Omit<GameFileNeed, 'id'>[]
  notes: string[]
  savePaths: string[]
  completeness: Completeness | null
  archived: boolean
  license: string | null
  features: string[]
}

interface RlPart {
  rlId: string
  name: string | null
  game: string | null
  origin: string | null
  /**
   * The game's name in RecompLauncher's game database record of the app (`about`, from IGDB), with the system groups
   * of the platforms that record lists. It can name the game by another region's title than `game` does.
   */
  aboutName: string | null
  aboutGroups: string[]
  blurb: string | null
  description: string | null
  features: string[]
  tags: string[]
  stars: number | null
  downloads: number | null
  released: string | null
  /** When RecompLauncher added it to its list (ISO date or time). */
  added: string | null
  size: number | null
  icon: string | null
  cover: string | null
  hero: string | null
  license: string | null
  author: string | null
  assetPattern: string | null
  tag: string | null
  scannedWindows: { name: string; sha256: string } | null
  exe: string | null
  needs: Omit<GameFileNeed, 'id'>[] | null
  playerNote: string | null
  needsText: string | null
  installer: boolean
  archived: boolean
  windows: boolean
  /** The game's Xbox 360 title id (8 hex digits, upper case) and its user data folder template, for one-game apps. */
  titleId: string | null
  achievementsFolder: string | null
}

interface Draft {
  id: string
  host: Host
  repo: string
  /** One game of a multi-game repo (RecompLauncher's per-app fields then only apply when matched to this game). */
  multi: boolean
  db: DbPart | null
  finds: {
    /** "Owner/Repo" as the project spells it (plans.json keys are lowercase). */
    repo: string
    title: string | null
    console: string | null
    notes: string | null
    boxart: string | null
    /** When decomp-buddy added it to its list, and when its project last released (ISO times). */
    addedAt: string | null
    updatedAt: string | null
  } | null
  rl: RlPart | null
  /** Repo-level RecompLauncher facts for a multi-game repo it lists as one app. */
  rlRepo: Pick<RlPart, 'stars' | 'downloads' | 'license' | 'author' | 'archived'> | null
  rlIds: string[]
}

function httpUrl(v: unknown): string | null {
  const s = str(v)
  return s && /^https?:\/\//i.test(s) ? s : null
}

/**
 * A catalog date as an ISO time, or null. Dates before the catalogs existed are placeholders (RecompLauncher files
 * apps it could not date under 2020-01-01), not real "added" or "updated" dates.
 */
export function listDate(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const ms = Date.parse(s)
  if (!Number.isFinite(ms) || ms < Date.UTC(2021, 0, 1)) return null
  return new Date(ms).toISOString()
}

/** Any parseable date as an ISO time (release dates may be old), or null. */
function isoDate(v: unknown): string | null {
  const s = str(v)
  const ms = s ? Date.parse(s) : NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** The earliest / latest of some ISO times (nulls skipped). */
function earliest(...xs: (string | null | undefined)[]): string | null {
  const ok = xs.filter((x): x is string => !!x).sort()
  return ok[0] ?? null
}
function latest(...xs: (string | null | undefined)[]): string | null {
  const ok = xs.filter((x): x is string => !!x).sort()
  return ok[ok.length - 1] ?? null
}

function readFinds(finds: unknown): Map<string, NonNullable<Draft['finds']>> {
  const out = new Map<string, NonNullable<Draft['finds']>>()
  for (const g of arr(obj(finds)?.games)) {
    const o = obj(g)
    const ref = str(o?.repo)
    if (!o || !ref) continue
    const parsed = parseRepoRef(ref, null)
    if (!parsed) continue
    out.set(repoKey(parsed.host, parsed.repo), {
      repo: parsed.repo,
      title: str(o.title),
      console: str(o.console),
      notes: str(o.notes),
      boxart: httpUrl(o.boxartUrl),
      addedAt: listDate(o.addedAt),
      updatedAt: isoDate(o.updatedAt)
    })
  }
  return out
}

/** One Windows game of a plan → its decomp-buddy part, or null when there is no prebuilt download. */
function dbPartOf(plan: Obj, game: Obj): DbPart | null {
  const build = obj(game.build)
  if (!build || str(build.method) !== 'release') return null
  let asset = str(build.release_asset)
  let tag = str(build.release_tag) ?? str(plan.tag)
  const scanned = obj(build.scanned)
  let sha256 = str(scanned?.sha256)?.toLowerCase() ?? null
  let size = num(scanned?.size)
  if (str(build.gone)) {
    // The scanned file was taken down; a newer release decomp-buddy saw (not yet scanned) can stand in.
    const next = obj(build.next)
    asset = str(next?.release_asset)
    tag = str(next?.release_tag)
    sha256 = null
    size = null
  }
  if (!asset || !tag) return null
  // decomp-buddy files some Android APKs and Linux AppImages under its Windows target: nothing to install here.
  if (notForWindows(asset)) return null
  if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) sha256 = null
  const facts = obj(plan.facts)
  const completenessRaw = str(facts?.completeness)
  const savePaths: string[] = []
  for (const s of arr(facts?.save_paths)) {
    const o = obj(s)
    const platform = str(o?.platform)?.toLowerCase()
    const path = str(o?.path)
    if (
      (platform === 'windows' || platform === 'any') &&
      path &&
      path.length <= 260 &&
      !savePaths.includes(path)
    ) {
      savePaths.push(path)
    }
  }
  const features = Object.keys(obj(facts?.features) ?? {})
    .map((k) => DB_FEATURES[k])
    .filter((f): f is string => !!f)
  const needs = arr(game.game_files)
    .map(needFromPlan)
    .filter((n): n is Omit<GameFileNeed, 'id'> => n !== null)
  // First-run steps PlayOut does itself (download, extract, start the program) are left out.
  const steps = strings(game.first_run).filter(
    (s) =>
      !/\b(download|extract|unzip|unpack|decompress)\b/i.test(s) &&
      !/^(run|launch|start|open|double[- ]click)\b/i.test(s)
  )
  return {
    game: str(game.game_title) ?? '',
    consoleText: str(game.console) ?? '',
    tag,
    asset,
    exe: cleanExe(build.executable),
    sha256,
    size,
    needs,
    notes: [...steps, ...strings(game.notes)],
    savePaths,
    completeness: completenessRaw ? (COMPLETENESS[completenessRaw.toLowerCase()] ?? null) : null,
    archived: obj(facts?.health)?.archived === true,
    license: str(obj(plan.trust)?.license),
    features
  }
}

function isTakenDown(plan: Obj): boolean {
  const facts = obj(plan.facts)
  return obj(facts?.health)?.dmca === true || !!facts?.takedown
}

/** An Xbox 360 title id as 8 upper-case hex digits, else null. */
function titleIdOf(v: unknown): string | null {
  const s = str(v)?.replace(/^0x/i, '')
  return s && /^[0-9a-f]{8}$/i.test(s) ? s.toUpperCase() : null
}

/** A folder template from the catalog (a short path, one line), else null. */
function folderTemplate(v: unknown): string | null {
  const s = str(v)
  return s && s.length <= 260 && !/[\r\n]/.test(s) ? s : null
}

function rlPartOf(app: Obj, game: string | null, art: Obj | null, systemId: string | null): RlPart {
  const boot = obj(app.boot)
  const assets = obj(app.assets)
  const filesWin = obj(obj(app.files)?.windows)
  const winName = str(filesWin?.name)
  const winSha = str(filesWin?.sha256)?.toLowerCase()
  const windowsRaw = str(assets?.windows)
  const windowsAsset = windowsRaw && !notForWindows(windowsRaw) ? windowsRaw : null
  const systems = strings(app.systems).map((s) => s.toLowerCase())
  const installerBoot = obj(boot?.installer)
  const gameName = game ?? str(app.game) ?? ''
  // The app's database record describes the app as a whole: not one game of a multi-game app (`game` given).
  const about = game === null ? obj(app.about) : null
  // Older catalogs put the title id and folder in an `achievements` object.
  const achievementsInfo = obj(app.achievements)
  return {
    rlId: str(app.id) ?? '',
    name: str(app.name),
    game: gameName || null,
    origin: str(app.origin),
    aboutName: str(about?.name),
    aboutGroups: strings(about?.platforms).flatMap((p) => {
      const sys = systemIdForConsole(p)
      return sys ? [systemGroup(sys.systemId)] : []
    }),
    blurb: str(app.blurb),
    description: str(app.description),
    features: strings(app.features),
    tags: strings(app.tags),
    stars: num(app.stars),
    downloads: num(app.downloads),
    released: str(app.released),
    added: listDate(app.added),
    size: parseSize(app.size),
    icon: httpUrl(art?.icon) ?? httpUrl(app.icon),
    cover: httpUrl(art?.cover) ?? httpUrl(app.cover),
    hero: httpUrl(art?.hero) ?? httpUrl(app.hero),
    license: str(app.license),
    author: str(app.author),
    assetPattern: windowsAsset,
    tag: str(app.tag),
    scannedWindows:
      winName && winSha && /^[0-9a-f]{64}$/.test(winSha) && str(filesWin?.scan) !== 'red'
        ? { name: winName, sha256: winSha }
        : null,
    exe: cleanExe(boot?.start) ?? cleanExe(installerBoot?.then_start),
    needs: boot ? needsFromRl(boot.files, gameName, systemId) : null,
    playerNote: str(boot?.player_note),
    needsText: str(app.needs),
    installer: app.installer === true || str(boot?.kind) === 'installer',
    archived: app.archived === true,
    windows: systems.includes('windows') && !!windowsAsset && app.soon !== true,
    // The app's own (one game): a game of a multi-game app has its own title.
    titleId: game === null ? titleIdOf(app.title_id ?? achievementsInfo?.title_id) : null,
    achievementsFolder:
      game === null ? folderTemplate(app.achievements_folder ?? achievementsInfo?.folder) : null
  }
}

// --- the build ------------------------------------------------------------------------------------------------------

/**
 * The title an entry's recompilations are grouped under: its system's matching group (a DOS and a Windows port of
 * one game are one PC title, every arcade board one arcade title, as the library matcher sees them) and the game's
 * name without a trailing "Version" ("Pokémon Platinum Version" is "Pokemon Platinum").
 */
export function entryTitleKey(systemId: string, game: string): string {
  return titleKeyOf(systemGroup(systemId), withoutVersionWord(game) ?? game)
}

/** A name without trailing bracketed console notes ("GoldenEye 007 (XBLA)" -> "GoldenEye 007"); years, demos stay. */
function withoutConsoleNote(name: string): string {
  let t = name.trim()
  for (;;) {
    const m = /\s*[([]([^)\]]*)[)\]]\s*$/.exec(t)
    if (!m || m.index === 0 || /\bdemo\b/i.test(m[1]!) || !systemIdForConsole(m[1]!)) return t
    t = t.slice(0, m.index).trim()
  }
}

/**
 * Other names of an entry's game (RecompEntry.otherNames): the name RecompLauncher's game database gives the app, when
 * it is a different one and that record is of a game on the entry's own console. So a recompilation listed under its
 * European name ("Harry Potter and the Philosopher's Stone", Xbox) is also found by the American disc ("... Sorcerer's
 * Stone"). Not for PC originals (a shorter PC name is another game: "Prey (2006)" is not "Prey"), nor for one game
 * of a multi-game repository (the record is the app's).
 */
function otherNamesOf(d: Draft, game: string, systemId: string): string[] {
  const rl = d.rl
  if (!rl?.aboutName || d.multi || systemId === 'other') return []
  const group = systemGroup(systemId)
  if (group === 'pc' || !rl.aboutGroups.includes(group)) return []
  // RecompLauncher itself must place the app on that console (a mod of a later port of the game is not the original).
  const origin = rl.origin ? systemIdForConsole(rl.origin) : null
  if (!origin || systemGroup(origin.systemId) !== group) return []
  const name = withoutConsoleNote(rl.aboutName) || rl.aboutName
  const norm = normalizeGameTitle(name)
  return norm && norm !== normalizeGameTitle(withoutConsoleNote(game) || game) ? [name] : []
}

/** The words (3+ letters or digits, lowercase, accents dropped) of a text. */
function wordSet(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && w !== 'the' && w !== 'and')
  )
}

/**
 * RecompLauncher's game for an app that is plainly another game: decomp-buddy names a different one that shares no
 * word with it, and RecompLauncher's own words about the app name decomp-buddy's game and no word of its own ("NeoTS2",
 * listed under "NEO Scavenger", is "A new, open, 64-bit engine for The Sims 2"). Decomp-buddy's game is then the
 * entry's. Never for two spellings of one game (they share a word, or read the same without spaces), when the app's
 * text speaks of its own game, nor when decomp-buddy's "game" is only the project's own name ("Golden Balloon", a
 * Diddy Kong Racing port).
 */
export function rlGameContradicted(
  rl: {
    game: string | null
    name: string | null
    blurb: string | null
    description: string | null
  } | null,
  dbGame: string | null | undefined
): boolean {
  if (!rl?.game || !dbGame) return false
  const base = withoutBrackets(dbGame) ?? dbGame
  const theirs = normalizeGameTitle(base)
  if (theirs.length < 4 || theirs === normalizeGameTitle(rl.game)) return false
  if (rl.name && normalizeGameTitle(rl.name) === theirs) return false
  const own = wordSet(rl.game)
  const dbWords = wordSet(dbGame)
  if (!own.size || [...own].some((w) => dbWords.has(w))) return false
  const text = `${rl.blurb ?? ''} ${rl.description ?? ''}`
  const textWords = wordSet(text)
  return normalizeGameTitle(text).includes(theirs) && ![...own].some((w) => textWords.has(w))
}

function finalize(d: Draft): RecompEntry | null {
  const { db, rl } = d
  const rlRepo = d.rlRepo ?? rl
  const finds = d.finds
  const repoName = d.repo.split('/').pop() ?? d.repo
  const owner = d.repo.split('/')[0]

  const rlGame = rlGameContradicted(rl, db?.game) ? null : rl?.game
  const game = (d.multi ? (db?.game ?? rl?.game) : (rlGame ?? db?.game)) || finds?.title || ''
  if (!game) return null
  const fromOrigin = rl?.origin ? systemIdForConsole(rl.origin) : null
  const fromText = db?.consoleText ? systemIdForConsole(db.consoleText) : null
  const fromFinds = finds?.console ? systemIdForConsole(finds.console) : null
  let sys = fromOrigin ?? fromText ?? fromFinds
  // RecompLauncher's origin codes are coarse ('pc' for DOS games too, 'arcade' for every board): decomp-buddy's text
  // may name the exact system of that family ("PC (MS-DOS)", "Sega Model 3", "Neo Geo AES").
  if (fromOrigin && systemGroup(fromOrigin.systemId) === fromOrigin.systemId) {
    const exact = [fromText, fromFinds].find(
      (x) =>
        !!x && x.systemId !== fromOrigin.systemId && systemGroup(x.systemId) === fromOrigin.systemId
    )
    if (exact) sys = exact
  }
  const systemId = sys?.systemId ?? 'other'
  const consoleName =
    sys?.console ?? db?.consoleText ?? finds?.console ?? originDisplayName('other')

  // The release to offer: the newer of the two catalogs' tags (equal or not comparable: decomp-buddy's, it was
  // virus-scanned). Its checksum and size only carry over with the catalog that described that exact file.
  // RecompLauncher sometimes names a side piece of the game as its Windows file (its server, a map editor, a mod SDK:
  // Project Avalanche's "-server-windows-x64.zip"). Then what it says of that file (name, size, checksum, release,
  // program, setup) is not the game's: decomp-buddy's is taken, or none (assets.ts scores the release's files and
  // passes over side pieces).
  const rlSide = !!rl?.assetPattern && isSidePiece(rl.assetPattern)
  const rlPattern = rlSide ? null : (rl?.assetPattern ?? null)
  const dbAssetFits = !!db?.asset && (!rlPattern || patternMatches(rlPattern, db.asset))
  // RecompLauncher's tag only counts for an app with a Windows build (its newest release may be Linux-only).
  const useRlTag =
    !!rl?.tag && rl.windows && !rlSide && (!db?.tag || compareTags(rl.tag, db.tag) > 0)
  const latestTag = useRlTag ? (rl?.tag ?? null) : (db?.tag ?? rl?.tag ?? null)
  let scannedSha256: string | null = null
  // The file that checksum is of: install.ts applies it to exactly that file, whatever the asset pattern.
  let scannedAsset: string | null = null
  let downloadBytes: number | null = null
  if (db && sameTag(latestTag, db.tag) && dbAssetFits) {
    scannedSha256 = db.sha256
    scannedAsset = scannedSha256 ? (db.asset ?? null) : null
    downloadBytes = db.size
  }
  if (!scannedSha256 && rl?.scannedWindows && !rlSide && sameTag(latestTag, rl.tag)) {
    const fits = !rlPattern || patternMatches(rlPattern, rl.scannedWindows.name)
    if (fits) {
      scannedSha256 = rl.scannedWindows.sha256
      scannedAsset = scannedSha256 ? rl.scannedWindows.name : null
    }
  }
  downloadBytes ??= (rlSide ? null : rl?.size) ?? db?.size ?? null
  const assetPattern = rlPattern ?? db?.asset ?? null
  const installer =
    (!rlSide && !!rl?.installer) ||
    (!!db?.asset && INSTALLER_RE.test(db.asset)) ||
    (!!rlPattern && INSTALLER_RE.test(rlPattern))

  const needs = mergeNeeds(db?.needs ?? [], rlSide ? null : (rl?.needs ?? null))
  const setupNotes: string[] = []
  for (const n of [rlSide ? null : rl?.playerNote, ...(db?.notes ?? [])]) {
    if (n && !setupNotes.includes(n) && setupNotes.length < 12) setupNotes.push(n)
  }
  if (!needs.length && rl?.needsText && !/^(none|nothing)\b/i.test(rl.needsText)) {
    setupNotes.unshift(rl.needsText)
  }

  const completeness = db?.completeness ?? null
  const archived = !!db?.archived || !!rlRepo?.archived
  const tags: RecompTag[] = []
  const addTag = (label: string, kind: RecompTag['kind']): void => {
    if (!tags.some((t) => t.label.toLowerCase() === label.toLowerCase())) tags.push({ label, kind })
  }
  if (completeness) addTag(COMPLETENESS_TAG[completeness], 'status')
  for (const t of rl?.tags ?? []) addTag(t, 'feature')
  const required = needs.filter((n) => !n.optional && n.how !== 'none')
  if (required.length) {
    addTag(tMain('mainRecomp.tags.needsFiles'), 'setup')
    if (required.every((n) => n.how === 'folder' || n.how === 'flag' || n.how === 'env')) {
      addTag(tMain('mainRecomp.tags.easySetup'), 'setup')
    }
  }
  if (installer) addTag(tMain('mainRecomp.tags.installer'), 'setup')
  if (archived) addTag(tMain('mainRecomp.tags.archived'), 'warning')

  const sources: RecompEntry['sources'] = []
  if (db) sources.push('decomp-buddy')
  if (rl || d.rlRepo) sources.push('recomplauncher')
  const otherNames = otherNamesOf(d, game, systemId)

  return {
    id: d.id,
    name: rl?.name ?? repoName,
    game,
    systemId,
    console: consoleName,
    ...(otherNames.length ? { otherNames } : {}),
    host: d.host,
    repo: d.repo,
    repoUrl: repoUrlOf(d.host, d.repo),
    author: rlRepo?.author ?? owner,
    blurb: rl?.blurb ?? finds?.notes ?? '',
    description: rl?.description ?? '',
    features: rl?.features.length ? rl.features : (db?.features ?? []),
    tags,
    latestTag,
    released: rl && sameTag(latestTag, rl.tag) ? rl.released : null,
    // First seen on either list; last release either list knows of.
    addedAt: earliest(rl?.added, finds?.addedAt),
    updatedAt: latest(finds?.updatedAt, rlSide ? null : isoDate(rl?.released)),
    downloadBytes,
    stars: rlRepo?.stars ?? null,
    downloads: rlRepo?.downloads ?? null,
    license: rlRepo?.license ?? db?.license ?? null,
    completeness,
    recommended: false,
    assetPattern,
    exe: (rlSide ? null : rl?.exe) ?? db?.exe ?? null,
    installer,
    scannedSha256,
    scannedAsset,
    needs,
    setupNotes,
    savePaths: db?.savePaths ?? [],
    iconUrl: rl?.icon ?? null,
    coverUrl: rl?.cover ?? finds?.boxart ?? null,
    heroUrl: rl?.hero ?? null,
    archived,
    sources,
    ...(rl?.rlId && (rl.titleId || rl.achievementsFolder)
      ? {
          rl: {
            id: rl.rlId,
            ...(rl.titleId ? { titleId: rl.titleId } : {}),
            ...(rl.achievementsFolder ? { achievementsFolder: rl.achievementsFolder } : {})
          }
        }
      : {})
  }
}

/** A tiny union-find over title keys (RecompLauncher's `titles[]` join groups whose names differ). */
class KeyUnion {
  private parent = new Map<string, string>()
  find(k: string): string {
    let p = this.parent.get(k) ?? k
    if (p !== k) {
      p = this.find(p)
      this.parent.set(k, p)
    }
    return p
  }
  /** Joins `b`'s group into `a`'s (a's root stays the root). */
  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(rb, ra)
  }
}

/**
 * The catalog from the raw source documents (any of them may be missing or malformed). Pure: no I/O.
 */
export function buildCatalog(input: {
  finds?: unknown
  plans?: unknown
  rl?: unknown
  fetchedAt: RecompCatalog['fetchedAt']
  offline: string[]
}): RecompCatalog {
  const drafts = new Map<string, Draft>()
  const draftsByRepo = new Map<string, string[]>()
  const addDraft = (d: Draft): void => {
    drafts.set(d.id, d)
    const key = repoKey(d.host, d.repo)
    draftsByRepo.set(key, [...(draftsByRepo.get(key) ?? []), d.id])
  }

  // 1. decomp-buddy: every Windows game with a prebuilt release, skipping taken-down repos.
  const findsByRepo = readFinds(input.finds)
  const plans = obj(obj(input.plans)?.plans)
  for (const [key, rawPlan] of Object.entries(plans ?? {})) {
    const plan = obj(rawPlan)
    if (!plan || isTakenDown(plan)) continue
    const ref = parseRepoRef(key, null)
    if (!ref) continue
    const games = arr(obj(obj(plan.targets)?.windows)?.games)
      .map(obj)
      .filter((g): g is Obj => g !== null)
    const multi = games.length > 1
    const base = repoKey(ref.host, ref.repo)
    for (const g of games) {
      const db = dbPartOf(plan, g)
      if (!db) continue
      const slug = slugOf(db.game)
      const id = multi ? `${base}#${slug || 'game'}` : base
      if (drafts.has(id)) continue
      addDraft({
        id,
        host: ref.host,
        repo: findsByRepo.get(base)?.repo ?? ref.repo,
        multi,
        db,
        finds: findsByRepo.get(base) ?? null,
        rl: null,
        rlRepo: null,
        rlIds: []
      })
    }
  }

  // Same-named repos, for projects that moved owner or host since one catalog last looked
  // ("2ship2harkinian/2ship2harkinian" → "harbourmasters/2ship2harkinian").
  const dbByRepoName = new Map<string, string[]>()
  for (const d of drafts.values()) {
    const name = (d.repo.split('/').pop() ?? '').toLowerCase()
    dbByRepoName.set(name, [...(dbByRepoName.get(name) ?? []), d.id])
  }

  // 2. RecompLauncher: enrich the matching decomp-buddy entries, add the projects only it lists.
  const rlDoc = obj(input.rl)
  const rlToEntries = new Map<string, string[]>()
  const link = (rlId: string, entryId: string): void => {
    if (!rlId) return
    const list = rlToEntries.get(rlId) ?? []
    if (!list.includes(entryId)) list.push(entryId)
    rlToEntries.set(rlId, list)
    const d = drafts.get(entryId)
    if (d && !d.rlIds.includes(rlId)) d.rlIds.push(rlId)
  }
  for (const rawApp of arr(rlDoc?.apps)) {
    const app = obj(rawApp)
    const rlId = str(app?.id)
    const ref = app && str(app.repo) ? parseRepoRef(str(app.repo) as string, str(app.host)) : null
    if (!app || !rlId || !ref) continue
    const originSys = systemIdForConsole(str(app.origin) ?? '')?.systemId ?? null
    const key = repoKey(ref.host, ref.repo)
    const subGames = arr(app.games)
      .map(obj)
      .filter((g): g is Obj => g !== null && !!str(g.name))
    const existing = draftsByRepo.get(key) ?? []
    // RecompLauncher spells the repo the way the project does (better for display than plans.json's lowercase key).
    for (const id of existing) {
      const d = drafts.get(id) as Draft
      if (repoKey(d.host, d.repo) === key) d.repo = ref.repo
    }

    if (existing.length) {
      if (existing.length === 1 && !subGames.length) {
        const d = drafts.get(existing[0]) as Draft
        if (!d.rl) d.rl = rlPartOf(app, null, null, originSys)
        link(rlId, d.id)
        continue
      }
      // A multi-game repo: per-game fields only where a game is matched by name, repo facts everywhere.
      const repoFacts = rlPartOf(app, null, null, originSys)
      const named = subGames.length
        ? subGames.map((g) => ({ name: str(g.name) as string, art: g }))
        : [{ name: str(app.game) ?? '', art: null as Obj | null }]
      for (const id of existing) {
        const d = drafts.get(id) as Draft
        const norm = normalizeGameTitle(d.db?.game ?? '')
        const hit = named.find((g) => norm && normalizeGameTitle(g.name) === norm)
        if (hit && !d.rl) {
          const part = rlPartOf(app, hit.name, hit.art, originSys)
          // The app's asset pattern, start program and game files are for the whole collection, not this game.
          part.assetPattern = null
          part.scannedWindows = null
          part.exe = null
          part.needs = null
          // ...and so are its tag and date: the collection's newest release may not carry this game's build.
          part.tag = null
          part.released = null
          d.rl = part
          link(rlId, d.id)
        } else if (!d.rl && !d.rlRepo) {
          d.rlRepo = repoFacts
        }
      }
      continue
    }

    // Not in decomp-buddy under this repo: the same project under its new owner/host?
    if (!subGames.length) {
      const name = (ref.repo.split('/').pop() ?? '').toLowerCase()
      const game = str(app.game)
      const key2 = game && originSys ? entryTitleKey(originSys, game) : null
      const candidates = (dbByRepoName.get(name) ?? []).filter((id) => {
        const d = drafts.get(id) as Draft
        if (d.rl || d.multi || !d.db || !key2) return false
        const sys = systemIdForConsole(d.db.consoleText)?.systemId ?? 'other'
        return entryTitleKey(sys, d.db.game) === key2
      })
      if (candidates.length === 1) {
        const d = drafts.get(candidates[0]) as Draft
        d.rl = rlPartOf(app, null, null, originSys)
        link(rlId, d.id)
        // Later apps naming the old repo (RecompLauncher's "-2" duplicates) find the same entry.
        draftsByRepo.set(key, [d.id])
        continue
      }
    }

    // RecompLauncher only: needs a Windows download.
    const probe = rlPartOf(app, null, null, originSys)
    if (!probe.windows) continue
    if (subGames.length) {
      for (const g of subGames) {
        const name = str(g.name) as string
        const id = `${key}#${slugOf(name) || 'game'}`
        if (drafts.has(id)) {
          link(rlId, id)
          continue
        }
        const part = rlPartOf(app, name, g, originSys)
        addDraft({
          id,
          host: ref.host,
          repo: ref.repo,
          multi: true,
          db: null,
          finds: null,
          rl: part,
          rlRepo: null,
          rlIds: []
        })
        link(rlId, id)
      }
    } else if (drafts.has(key)) {
      link(rlId, key) // a second app for the same repo (RecompLauncher's "-2" duplicates)
    } else {
      addDraft({
        id: key,
        host: ref.host,
        repo: ref.repo,
        multi: false,
        db: null,
        finds: findsByRepo.get(key) ?? null,
        rl: probe,
        rlRepo: null,
        rlIds: []
      })
      link(rlId, key)
    }
  }

  // 3. Entries.
  const entries = new Map<string, RecompEntry>()
  const byRepo = new Map<string, string[]>()
  for (const d of drafts.values()) {
    const e = finalize(d)
    if (!e) continue
    entries.set(e.id, e)
    const key = repoKey(e.host, e.repo)
    byRepo.set(key, [...(byRepo.get(key) ?? []), e.id])
  }

  // 4. Titles: same system + same normalized game name, joined further by RecompLauncher's groupings.
  const union = new KeyUnion()
  const keyOf = (e: RecompEntry): string => entryTitleKey(e.systemId, e.game)
  const titleNames: [string, string][] = []
  const entriesOf = (rlId: string): RecompEntry[] =>
    (rlToEntries.get(rlId) ?? []).map((id) => entries.get(id)).filter((e): e is RecompEntry => !!e)
  for (const rawTitle of arr(rlDoc?.titles)) {
    const t = obj(rawTitle)
    if (!t) continue
    const pick = str(t.pick)
    const pickId = pick?.startsWith('pc:') ? pick.slice(3) : null
    // A collection app (one RecompLauncher id, several games) cannot say which of its games is meant: such a member
    // only joins when its game is the title's game anyway, and never anchors the title or is recommended. Members
    // from another console (RecompLauncher groups the N64 and Xbox 360 Banjo-Tooie together) keep their own title:
    // they need that console's game files, and a game in the library is matched within its own system.
    const pickEntries = pickId ? entriesOf(pickId) : []
    const memberIds = [...new Set([...(pickId ? [pickId] : []), ...strings(t.pc)])]
    const anchor =
      pickEntries.length === 1
        ? pickEntries[0]
        : memberIds.map(entriesOf).find((list) => list.length === 1)?.[0]
    if (!anchor) continue
    if (pickEntries.length === 1) pickEntries[0].recommended = true
    const anchorKey = keyOf(anchor)
    for (const rlId of memberIds) {
      const list = entriesOf(rlId)
      for (const m of list) {
        if (systemGroup(m.systemId) !== systemGroup(anchor.systemId)) continue
        if (list.length === 1 || keyOf(m) === anchorKey) union.union(anchorKey, keyOf(m))
      }
    }
    const name = str(t.name)
    if (name) titleNames.push([anchorKey, name])
  }
  const nameByRoot = new Map<string, string>()
  for (const [key, name] of titleNames) {
    const root = union.find(key)
    if (!nameByRoot.has(root)) nameByRoot.set(root, name)
  }

  const groups = new Map<string, RecompEntry[]>()
  for (const e of entries.values()) {
    const root = union.find(keyOf(e))
    groups.set(root, [...(groups.get(root) ?? []), e])
  }
  const titles = new Map<string, RecompTitle>()
  for (const [key, members] of groups) {
    members.sort(
      (a, b) =>
        Number(b.recommended) - Number(a.recommended) ||
        (b.stars ?? -1) - (a.stars ?? -1) ||
        (b.downloads ?? -1) - (a.downloads ?? -1) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id)
    )
    const lead = members[0]
    // A title keeps one recommended version (two RecompLauncher titles may have been joined).
    for (const m of members.slice(1)) m.recommended = false
    // Names sometimes carry a console note ("Mystical Ninja Starring Goemon (Nintendo 64)", "GoldenEye 007 (XBLA)").
    const rlName = nameByRoot.get(key)
    const named = rlName ? withoutConsoleNote(rlName) || undefined : undefined
    const sameSystem = members.find((m) => keyOf(m) === key) ?? lead
    // DOS and Windows versions of a game, or several arcade boards, are one title of the group's system.
    const mixed = members.some((m) => m.systemId !== sameSystem.systemId)
    const groupId = key.slice(0, key.indexOf(':'))
    const titleGame = named ?? (withoutConsoleNote(sameSystem.game) || sameSystem.game)
    const aliases: string[] = []
    for (const name of members.flatMap((m) => m.otherNames ?? [])) {
      const norm = normalizeGameTitle(name)
      if (norm === normalizeGameTitle(titleGame)) continue
      if (!aliases.some((a) => normalizeGameTitle(a) === norm)) aliases.push(name)
    }
    titles.set(key, {
      key,
      game: titleGame,
      ...(aliases.length ? { aliases } : {}),
      systemId: mixed ? groupId : sameSystem.systemId,
      console: mixed ? originDisplayName(groupId) : sameSystem.console,
      entries: members.map((m) => m.id)
    })
  }

  const byRl = new Map<string, string[]>()
  for (const [rlId, ids] of rlToEntries) {
    const there = ids.filter((id) => entries.has(id))
    if (there.length) byRl.set(rlId.toLowerCase(), there)
  }

  return {
    entries,
    titles,
    byRepo,
    byRl,
    fetchedAt: input.fetchedAt,
    offline: [...new Set(input.offline)]
  }
}

// --- loading --------------------------------------------------------------------------------------------------------

interface Loaded {
  doc: unknown
  fetchedAt: number | null
  offline: boolean
}

async function fetchJson(
  url: string,
  deps: CachedFetchDeps,
  force: boolean,
  check: (doc: unknown) => boolean
): Promise<Loaded> {
  try {
    const res = await cachedFetch(
      url,
      { ...deps, timeoutMs: deps.timeoutMs ?? CATALOG_TIMEOUT_MS },
      { maxAgeMs: CATALOG_MAX_AGE_MS, force, notFoundIsError: true }
    )
    let doc: unknown = null
    let problem: string | null = null
    try {
      doc = JSON.parse(res.body)
      if (!check(doc)) problem = 'not the expected catalog shape'
    } catch (err) {
      problem = `not valid JSON (${(err as Error).message})`
    }
    if (problem) {
      // Something else answered (a captive portal, an error page): forget it so the next load asks again instead
      // of trusting it for a day.
      deps.log.warn(`${url}: ${problem}`)
      await fs
        .rm(join(deps.dir, `${cacheKey(url)}.meta.json`), { force: true })
        .catch(() => undefined)
      return { doc: null, fetchedAt: null, offline: true }
    }
    return { doc, fetchedAt: res.fetchedAt, offline: res.from === 'offline' }
  } catch (err) {
    if (deps.signal?.aborted) throw err
    deps.log.warn(`${url}: ${(err as Error).message}`)
    return { doc: null, fetchedAt: null, offline: true }
  }
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}

/**
 * Fetch (through the cache, at most daily; `force` revalidates) and build the catalog. A source that cannot be
 * reached with nothing cached is left out and named in `offline`, as is one whose cached copy stands in.
 */
export async function loadCatalog(
  deps: CachedFetchDeps & { force?: boolean }
): Promise<RecompCatalog> {
  const force = !!deps.force
  const [finds, plans, rl] = await Promise.all([
    fetchJson(FINDS_URL, deps, force, (d) => Array.isArray(obj(d)?.games)),
    fetchJson(PLANS_URL, deps, force, (d) => !!obj(obj(d)?.plans)),
    fetchJson(RL_CATALOG_URL, deps, force, (d) => Array.isArray(obj(d)?.apps))
  ])
  const offline: string[] = []
  // decomp-buddy is usable with plans.json alone (finds.json only adds blurbs and box art).
  if (plans.offline || finds.offline) offline.push('decomp-buddy')
  if (rl.offline) offline.push('recomplauncher')
  const dbTimes = [plans.fetchedAt, finds.fetchedAt].filter((t): t is number => t !== null)
  return buildCatalog({
    finds: finds.doc ?? undefined,
    plans: plans.doc ?? undefined,
    rl: rl.doc ?? undefined,
    fetchedAt: {
      'decomp-buddy': plans.fetchedAt === null ? null : iso(Math.min(...dbTimes)),
      recomplauncher: iso(rl.fetchedAt)
    },
    offline
  })
}

// --- recompilations added in PlayOut (the browser's Add, and PlayOut's own list) ----------------------------------

/** A GitHub account name: letters, digits and single dashes inside, at most 39. */
export const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
/** A GitHub repository name. */
export const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/

/**
 * The GitHub repository a pasted link or name points at: a bare "owner/repo", "github.com/owner/repo" with or
 * without http(s):// and www., any page inside it (/tree/..., /releases/..., /blob/...), a ".git" ending, a query
 * or hash, and "git@github.com:owner/repo.git". Another host is 'notGithub'; anything else unreadable 'badUrl'.
 */
export function parseGithubUrl(
  input: string
): { owner: string; repo: string } | { error: Extract<RecompRepoRefusal, 'notGithub' | 'badUrl'> } {
  const text = String(input ?? '').trim()
  if (!text || text.length > 2048 || /\s/.test(text)) return { error: 'badUrl' }
  let path: string
  const ssh = /^git@([^:]+):(.+)$/i.exec(text)
  if (ssh) {
    if (ssh[1]!.toLowerCase() !== 'github.com') return { error: 'notGithub' }
    path = ssh[2]!
  } else {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    const looksLikeHost = /^[^/]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(text)
    if (hasScheme || looksLikeHost) {
      let url: URL
      try {
        url = new URL(hasScheme ? text : `https://${text}`)
      } catch {
        return { error: 'badUrl' }
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'badUrl' }
      const host = url.hostname.toLowerCase()
      if (host !== 'github.com' && host !== 'www.github.com') return { error: 'notGithub' }
      if (url.username || url.password || url.port) return { error: 'badUrl' }
      path = url.pathname
    } else path = text
  }
  const parts = path.split(/[?#]/)[0]!.split('/').filter(Boolean)
  if (parts.length < 2) return { error: 'badUrl' }
  const owner = parts[0]!
  let repo = parts[1]!
  try {
    repo = decodeURIComponent(repo)
  } catch {
    return { error: 'badUrl' }
  }
  repo = repo.replace(/\.git$/i, '')
  if (!GITHUB_OWNER_RE.test(owner) || !GITHUB_REPO_RE.test(repo) || repo === '.' || repo === '..')
    return { error: 'badUrl' }
  return { owner, repo }
}

/** An added recompilation (this PC's, or PlayOut's list) as a catalog entry: what is known of it, nothing invented. */
function extraEntry(
  x: {
    id: string
    repo: string
    game: string
    systemId: string
    blurb?: string
    addedAt?: string | null
    stars?: number | null
    license?: string | null
    archived?: boolean
  },
  source: 'playout' | 'user'
): RecompEntry {
  const [owner = '', name = x.repo] = x.repo.split('/')
  const archived = !!x.archived
  return {
    id: x.id,
    name,
    game: x.game,
    systemId: x.systemId,
    console: originDisplayName(x.systemId),
    host: 'github',
    repo: x.repo,
    repoUrl: repoUrlOf('github', x.repo),
    author: owner,
    blurb: x.blurb ?? '',
    description: '',
    features: [],
    tags: archived ? [{ label: tMain('mainRecomp.tags.archived'), kind: 'warning' }] : [],
    latestTag: null,
    released: null,
    addedAt: x.addedAt ?? null,
    updatedAt: null,
    downloadBytes: null,
    stars: x.stars ?? null,
    downloads: null,
    license: x.license ?? null,
    completeness: null,
    recommended: false,
    assetPattern: null,
    exe: null,
    installer: false,
    // Never scanned: an added recompilation's download is verified by GitHub's digest or installs unverified.
    scannedSha256: null,
    needs: [],
    setupNotes: [],
    savePaths: [],
    iconUrl: null,
    coverUrl: null,
    heroUrl: null,
    archived,
    sources: [source]
  }
}

/**
 * The catalog with the recompilations added in PlayOut: PlayOut's own list (`cloud`, approved: 'playout') first, then
 * this PC's own adds (`user`). A repository a catalog (or the list before it) has already is left out: the catalog's
 * entry wins, the added one stays stored and shows again if the catalog drops it. Each joins the title of its game
 * when there is one, else gets a title of its own. Pure: `base` is not changed.
 */
export function withExtras(
  base: RecompCatalog,
  extras: { cloud: readonly CloudRecomp[]; user: readonly AddedRecomp[] }
): RecompCatalog {
  if (!extras.cloud.length && !extras.user.length) return base
  const entries = new Map(base.entries)
  const titles = new Map(base.titles)
  const byRepo = new Map(base.byRepo)
  const add = (e: RecompEntry): void => {
    const rk = repoKey('github', e.repo)
    if (byRepo.has(rk) || entries.has(e.id)) return
    entries.set(e.id, e)
    byRepo.set(rk, [e.id])
    const key = entryTitleKey(e.systemId, e.game)
    const title = titles.get(key)
    if (title) titles.set(key, { ...title, entries: [...title.entries, e.id] })
    else
      titles.set(key, {
        key,
        game: e.game,
        systemId: e.systemId,
        console: e.console,
        entries: [e.id]
      })
  }
  for (const c of extras.cloud) add(extraEntry(c, 'playout'))
  for (const u of extras.user) add(extraEntry(u, 'user'))
  return { ...base, entries, titles, byRepo }
}
