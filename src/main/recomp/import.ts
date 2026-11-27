// Settings › Recompilations › Import: finding the recompilations another launcher installed in the folders the user
// picked, and which catalog recompilation each one is. Only the picked folders and their own app folders are read
// (never the rest of the computer), and nothing here changes a file: import-run.ts moves the folders.
//
// The three launchers, as they leave an app folder:
//  - Quiver Launcher (portable; formerly GithubLauncher): <root>\apps.json lists every app ("folderName",
//    "repository" owner/repo, "repositorySource" gitlab, "name"); <root>\apps\<folderName> holds version.txt (the
//    release tag), installed-build.txt (line 1 the downloaded file, line 2 its sha256) and selected_executable.txt
//    (the program the player chose, a full path). A folder with only "Place app files here.txt" is not installed.
//  - RecompLauncher: <library>\<app id> (its pc-catalog id), beside .staging / .downloads / .backups. It writes
//    nothing into the folder; the project's own recomplauncher.json (when it ships one) names the repository, and a
//    VERSION / BUILDINFO.json / RELEASE.json file sometimes the version.
//  - Decomp Buddy: <install folder>\<game> with decomp-buddy.json (repo, repoUrl, release.tag, release.files, plan).
import { promises as fs } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import type { RecompEntry, RecompImportItem, RecompImportLauncher } from '../../shared/recomp'
import { isInside, normalizePath } from '../util/paths'
import { isInstallerName } from './assets'
import { parseRepoRef, repoKey, type RecompCatalog } from './catalog'
import { keyOf, listFiles } from './install'
import { normalizeGameTitle } from './titles'

type Host = RecompEntry['host']

/** One app folder another launcher installed, as read from it (nothing matched yet). */
export interface ImportCandidate {
  folder: string
  launcher: RecompImportLauncher
  /** The launcher's name for it, else the folder's. */
  name: string
  /** Other names to match by title (the folder name, the project name). */
  otherNames: string[]
  repo: { host: Host; repo: string } | null
  /** RecompLauncher's app id (its folder name), lowercase. */
  rlId: string | null
  /** The release tag the launcher recorded (null: unknown). */
  tag: string | null
  /** The file it downloaded and its sha256 (Quiver), when known. */
  asset: string | null
  sha256: string | null
  /** The program to start, relative to the folder (Decomp Buddy's plan), when the launcher says. */
  exeHint: string | null
  /** The program the player chose in the other launcher: a full path as it was then (Quiver). */
  userExe: string | null
  /** Files the release shipped (lowercase '/' keys): only Decomp Buddy lists them. */
  releaseFiles: string[]
  /** When it was installed (ISO), when the folder says. */
  installedAt: string | null
  /** Only a setup program is in the folder (the game it installs lives elsewhere). */
  installerOnly: boolean
  /** The game reads the player's disc image or game folder from where it is (RecompLauncher's profile says so). */
  readsGameInPlace: boolean
  /** RecompLauncher's own save backups of it (<library>\.backups\<id>), which stay where they are. */
  launcherBackups: string | null
  /** Why it cannot be imported ('not-windows': a Decomp Buddy set-up for a console or a phone). */
  refused: 'not-windows' | null
}

export interface ImportDetection {
  candidates: ImportCandidate[]
  /** Folders looked at that are not an installed app of a supported launcher. */
  ignored: number
}

/** Text and JSON files read here are small; anything bigger is not the launcher's record. */
const MAX_RECORD_BYTES = 4 * 1024 * 1024
/** The files a launcher leaves beside an app (not the app's own). */
const QUIVER_MARKERS = new Set([
  'version.txt',
  'installed-build.txt',
  'selected_executable.txt',
  'lastplayed.txt',
  'quiver-launch.log',
  'place app files here.txt'
])
const DB_MARKERS = new Set([
  'decomp-buddy.json',
  'about this game.txt',
  'install.html',
  'artwork.png',
  'artwork.jpg'
])
/** Files RecompLauncher-installed projects ship with their version in them. */
const VERSION_FILES = [
  'VERSION',
  'VERSION.txt',
  'version.txt',
  'BUILDINFO.json',
  'RELEASE.json',
  'manifest.json'
]
/** RecompLauncher's own folders beside its apps. Quiver Launcher's apps folder has .staging and .downloads too. */
const RL_LIBRARY_MARKERS = ['.staging', '.downloads', '.backups']
/** Quiver's placeholder in an app folder with no release installed (it makes it again for a folder that went). */
const QUIVER_PLACEHOLDER = 'place app files here.txt'
const QUIVER_EXES = ['quiverlauncher.exe', 'githublauncher.exe']

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

async function statOrNull(path: string): Promise<import('fs').Stats | null> {
  return fs.lstat(path).catch(() => null)
}

async function isDir(path: string): Promise<boolean> {
  const st = await statOrNull(path)
  return !!st && st.isDirectory() && !st.isSymbolicLink()
}

async function isFile(path: string): Promise<boolean> {
  return !!(await statOrNull(path))?.isFile()
}

/** A small text file's text (null: missing, too big or unreadable). */
export async function readSmallText(path: string): Promise<string | null> {
  const st = await statOrNull(path)
  if (!st?.isFile() || st.size > MAX_RECORD_BYTES) return null
  return fs.readFile(path, 'utf8').then(
    (t) => t.replace(/^\uFEFF/, ''),
    () => null
  )
}

async function readJson(path: string): Promise<unknown> {
  const text = await readSmallText(path)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** The entries of a folder (none when it cannot be read). */
async function entriesOf(dir: string): Promise<import('fs').Dirent[]> {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => [])
}

/** A child of `dir` by name, ignoring case (Windows shows Quiver's "apps" as "Apps"). */
async function childNamed(dir: string, name: string): Promise<string | null> {
  const lower = name.toLowerCase()
  const hit = (await entriesOf(dir)).find((e) => e.name.toLowerCase() === lower)
  return hit ? join(dir, hit.name) : null
}

/** The app folders below `dir`: folders (not links), not hidden (".staging", ".downloads"). */
async function appFolders(dir: string): Promise<string[]> {
  return (await entriesOf(dir))
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
    .map((e) => join(dir, e.name))
    .sort((a, b) => a.localeCompare(b))
}

// --- Quiver Launcher ---------------------------------------------------------------------------------------------

interface QuiverRoot {
  root: string
  appsDir: string
  /** apps.json's apps by folder name (lowercase). */
  apps: Map<string, Json>
}

/** `dir` as a Quiver Launcher folder (apps.json beside QuiverLauncher.exe, .portable or settings.json), else null. */
async function quiverRootAt(dir: string): Promise<QuiverRoot | null> {
  const names = new Set((await entriesOf(dir)).map((e) => e.name.toLowerCase()))
  if (!names.has('apps.json')) return null
  if (!QUIVER_EXES.some((n) => names.has(n)) && !names.has('.portable')) return null
  const data = await readJson(join(dir, 'apps.json'))
  const apps = new Map<string, Json>()
  for (const raw of isObject(data) && Array.isArray(data.apps) ? data.apps : []) {
    if (!isObject(raw)) continue
    const folder = str(raw.folderName)
    if (folder) apps.set(folder.toLowerCase(), raw)
  }
  const settings = await readJson(join(dir, 'settings.json'))
  const custom = isObject(settings) ? str(settings.AppsPath ?? settings.appsPath) : null
  const appsDir =
    custom && isAbsolute(custom) && (await isDir(custom))
      ? resolve(custom)
      : ((await childNamed(dir, 'apps')) ?? join(dir, 'apps'))
  return { root: dir, appsDir, apps }
}

/** The PascalCase part of Quiver's "<GameName>-<Project>" folder name, spaced ("SkateIt" -> "Skate It"). */
function spacedPascal(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
}

/** Whether the folder holds only a setup program (and launcher or developer notes). */
async function installerOnly(folder: string, skip: Set<string>): Promise<boolean> {
  const files = (await listFiles(folder, { maxDepth: 1 })).filter(
    (f) => !skip.has(f.key.split('/').pop()!)
  )
  const exes = files.filter((f) => /\.(exe|msi)$/i.test(f.key))
  return (
    exes.length > 0 &&
    exes.every((f) => isInstallerName(f.key)) &&
    files.filter((f) => !/\.(txt|md|url|ico|png|jpg|log)$/i.test(f.key)).length <= 3
  )
}

/** Whether the folder holds anything but the launcher's own files. */
async function hasAppFiles(folder: string, skip: Set<string>): Promise<boolean> {
  for (const e of await entriesOf(folder)) {
    if (e.isDirectory()) return true
    if (!skip.has(e.name.toLowerCase())) return true
  }
  return false
}

async function mtimeIso(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    const st = await statOrNull(p)
    if (st?.isFile()) return new Date(st.mtimeMs).toISOString()
  }
  return null
}

async function readQuiverApp(folder: string, app: Json | null): Promise<ImportCandidate | null> {
  const markers = new Map(
    (await entriesOf(folder))
      .filter((e) => e.isFile() && QUIVER_MARKERS.has(e.name.toLowerCase()))
      .map((e) => [e.name.toLowerCase(), join(folder, e.name)])
  )
  // Not installed: Quiver's placeholder only (an app without a release), or an empty folder.
  if (!(await hasAppFiles(folder, QUIVER_MARKERS))) return null
  // Quiver's own: listed in its apps.json, or with its record files in it. Any other folder of its apps folder (which
  // settings.json may point anywhere, Documents included) is not an app it installed.
  if (!app && ![...markers.keys()].some((k) => k !== QUIVER_PLACEHOLDER)) return null
  const versionText = markers.get('version.txt')
    ? await readSmallText(markers.get('version.txt')!)
    : null
  const build = markers.get('installed-build.txt')
    ? await readSmallText(markers.get('installed-build.txt')!)
    : null
  const buildLines = (build ?? '').split(/\r?\n/).map((l) => l.trim())
  const selected = markers.get('selected_executable.txt')
    ? (await readSmallText(markers.get('selected_executable.txt')!))?.trim()
    : null
  const folderName = basename(folder)
  const [gamePart, projectPart] = folderName.split('-', 2)
  const repoRef = app && str(app.repository)
  const repo = repoRef
    ? parseRepoRef(repoRef, str(app!.repositorySource) ?? str(app!.host) ?? null)
    : null
  const name = (app && str(app.name)) ?? spacedPascal(gamePart ?? folderName)
  const otherNames = [
    folderName,
    gamePart ? spacedPascal(gamePart) : null,
    (app && str(app.project)) ?? projectPart ?? null
  ].filter((n): n is string => !!n && n !== name)
  return {
    folder,
    launcher: 'quiver',
    name,
    otherNames,
    repo,
    rlId: null,
    tag: versionText?.split(/\r?\n/)[0]?.trim() || null,
    asset: buildLines[0] || null,
    sha256: /^[0-9a-f]{64}$/i.test(buildLines[1] ?? '') ? buildLines[1]!.toLowerCase() : null,
    exeHint: null,
    userExe: selected && /\.exe$/i.test(selected) && isAbsolute(selected) ? selected : null,
    releaseFiles: [],
    installedAt: await mtimeIso([
      markers.get('installed-build.txt') ?? '',
      markers.get('version.txt') ?? ''
    ]),
    installerOnly: await installerOnly(folder, QUIVER_MARKERS),
    readsGameInPlace: false,
    launcherBackups: null,
    refused: null
  }
}

// --- RecompLauncher ----------------------------------------------------------------------------------------------

/** Whether an app folder carries Quiver Launcher's record files (version.txt with installed-build.txt, its log …). */
async function looksQuiverApp(folder: string): Promise<boolean> {
  const names = new Set(
    (await entriesOf(folder)).filter((e) => e.isFile()).map((e) => e.name.toLowerCase())
  )
  return (
    (names.has('version.txt') && names.has('installed-build.txt')) ||
    names.has('quiver-launch.log') ||
    names.has('selected_executable.txt') ||
    names.has(QUIVER_PLACEHOLDER)
  )
}

/**
 * Whether `dir` is a RecompLauncher library: its .backups folder, or its .staging / .downloads folders while none of
 * its app folders is one of Quiver Launcher's (whose apps folder has those two as well).
 */
async function isRlLibrary(dir: string): Promise<boolean> {
  const names = new Set((await entriesOf(dir)).map((e) => e.name.toLowerCase()))
  if (names.has('.backups')) return true
  if (!RL_LIBRARY_MARKERS.some((m) => names.has(m))) return false
  for (const f of await appFolders(dir)) if (await looksQuiverApp(f)) return false
  return true
}

const VERSION_RE = /\bv?(\d+(?:\.\d+){1,3}(?:-[0-9a-z.]+)?)(?:\+[0-9a-z.]+)?\b/i

/** A version written in a project's own version file ("ProjectVersion=0.0.8", "0.4.1+6151ac4f", JSON "version"). */
export function versionFromText(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed) as unknown
      if (isObject(data)) {
        const v = str(data.version) ?? str(data.tag) ?? str(data.Version)
        return v ? versionFromText(v) : null
      }
    } catch {
      return null
    }
  }
  const m = VERSION_RE.exec(trimmed.split(/\r?\n/).slice(0, 5).join(' '))
  return m ? m[1]! : null
}

async function readRlApp(folder: string, library: string | null): Promise<ImportCandidate | null> {
  if (!(await hasAppFiles(folder, new Set()))) return null
  const profile = await readJson(join(folder, 'recomplauncher.json'))
  const p = isObject(profile) ? profile : null
  const repoRef = p ? str(p.repo) : null
  const repo = repoRef ? parseRepoRef(repoRef, str(p!.host)) : null
  let tag: string | null = p ? (str(p.version) ? versionFromText(str(p.version)!) : null) : null
  for (const f of VERSION_FILES) {
    if (tag) break
    const text = await readSmallText(join(folder, f))
    if (text) tag = versionFromText(text)
  }
  const game = p && isObject(p.game) ? p.game : null
  const folderName = basename(folder)
  const backups = library ? join(library, '.backups', folderName) : null
  return {
    folder,
    launcher: 'recomplauncher',
    name: (p && str(p.name)) ?? folderName,
    otherNames: p && str(p.name) ? [folderName] : [],
    repo,
    rlId: folderName.toLowerCase(),
    tag,
    asset: null,
    sha256: null,
    exeHint: null,
    userExe: null,
    releaseFiles: [],
    installedAt: null,
    installerOnly: await installerOnly(folder, new Set(['recomplauncher.json'])),
    readsGameInPlace: !!game && /iso|folder/.test(String(game.kind ?? '')),
    launcherBackups: backups && (await isDir(backups)) ? backups : null,
    refused: null
  }
}

// --- Decomp Buddy -------------------------------------------------------------------------------------------------

function hostOfUrl(url: string | null): Host | null {
  if (!url) return null
  if (/^https?:\/\/(www\.)?gitlab\.com\//i.test(url)) return 'gitlab'
  if (/^https?:\/\/(www\.)?codeberg\.org\//i.test(url)) return 'codeberg'
  if (/^https?:\/\/(www\.)?github\.com\//i.test(url)) return 'github'
  return null
}

async function readDbApp(folder: string): Promise<ImportCandidate | null> {
  const data = await readJson(join(folder, 'decomp-buddy.json'))
  if (!isObject(data)) return null
  const repoRef = str(data.repo)
  const host = hostOfUrl(str(data.repoUrl)) ?? 'github'
  const repo = repoRef ? parseRepoRef(repoRef, host) : null
  const release = isObject(data.release) ? data.release : null
  const plan = isObject(data.plan) ? data.plan : null
  const build = plan && isObject(plan.build) ? plan.build : null
  const exe = build ? str(build.executable) : null
  const files = release && Array.isArray(release.files) ? release.files : []
  const target = str(data.target) ?? 'windows'
  const name =
    str(data.displayName) ?? (plan && str(plan.game_title)) ?? str(data.folder) ?? basename(folder)
  return {
    folder,
    launcher: 'decompbuddy',
    name,
    otherNames: [basename(folder)].filter((n) => n !== name),
    repo,
    rlId: null,
    tag: release ? str(release.tag) : null,
    asset: null,
    sha256: null,
    exeHint: exe && !isAbsolute(exe) && !exe.split(/[\\/]/).includes('..') ? exe : null,
    userExe: null,
    releaseFiles: files
      .filter((f): f is string => typeof f === 'string' && !!f && !f.split(/[\\/]/).includes('..'))
      .map(keyOf)
      .filter((k) => !DB_MARKERS.has(k)),
    installedAt: str(data.setUpAt),
    installerOnly: await installerOnly(folder, DB_MARKERS),
    readsGameInPlace: false,
    launcherBackups: null,
    refused: target.toLowerCase() === 'windows' ? null : 'not-windows'
  }
}

// --- detection ----------------------------------------------------------------------------------------------------

/**
 * The installed apps in the picked folders. Each picked folder may be a launcher's own folder (Quiver Launcher's, a
 * RecompLauncher library, a Decomp Buddy install folder), its apps folder, or one app folder: only it and its own
 * child folders are read. `skip`: folders never taken (PlayOut's Recompilations folder and what is in it).
 */
export async function detectImport(
  picked: string[],
  skip: (folder: string) => boolean = () => false
): Promise<ImportDetection> {
  const out: ImportCandidate[] = []
  const seen = new Set<string>()
  let ignored = 0
  const add = (c: ImportCandidate | null, folder: string): void => {
    const key = normalizePath(folder)
    if (seen.has(key)) return
    seen.add(key)
    if (c) out.push(c)
    else ignored++
  }
  const quiverApps = async (q: QuiverRoot): Promise<void> => {
    for (const f of await appFolders(q.appsDir)) {
      if (skip(f)) continue
      add(await readQuiverApp(f, q.apps.get(basename(f).toLowerCase()) ?? null), f)
    }
  }

  for (const raw of picked) {
    const dir = resolve(raw)
    if (!(await isDir(dir)) || skip(dir)) continue
    // A Quiver Launcher folder, its apps folder, or one of its apps.
    const q = await quiverRootAt(dir)
    if (q) {
      await quiverApps(q)
      continue
    }
    const parentQ = await quiverRootAt(dirname(dir))
    if (parentQ && normalizePath(parentQ.appsDir) === normalizePath(dir)) {
      await quiverApps(parentQ)
      continue
    }
    const grandQ = await quiverRootAt(dirname(dirname(dir)))
    if (grandQ && normalizePath(grandQ.appsDir) === normalizePath(dirname(dir))) {
      add(await readQuiverApp(dir, grandQ.apps.get(basename(dir).toLowerCase()) ?? null), dir)
      continue
    }
    // One app folder of Decomp Buddy or RecompLauncher.
    if (await isFile(join(dir, 'decomp-buddy.json'))) {
      add(await readDbApp(dir), dir)
      continue
    }
    // One of Quiver's apps whose Quiver folder is not where it would be (a custom apps folder, apps.json gone).
    if (await looksQuiverApp(dir)) {
      add(await readQuiverApp(dir, null), dir)
      continue
    }
    if (
      (await isRlLibrary(dirname(dir))) ||
      ((await isFile(join(dir, 'recomplauncher.json'))) && !(await isRlLibrary(dir)))
    ) {
      add(await readRlApp(dir, (await isRlLibrary(dirname(dir))) ? dirname(dir) : null), dir)
      continue
    }
    // A folder of app folders: a RecompLauncher library or a Decomp Buddy install folder.
    const library = (await isRlLibrary(dir)) ? dir : null
    for (const f of await appFolders(dir)) {
      if (skip(f)) continue
      const childQ = library ? null : await quiverRootAt(f)
      if (childQ) await quiverApps(childQ)
      else if (await isFile(join(f, 'decomp-buddy.json'))) add(await readDbApp(f), f)
      else if (await looksQuiverApp(f)) add(await readQuiverApp(f, null), f)
      else if (library || (await isFile(join(f, 'recomplauncher.json'))))
        add(await readRlApp(f, library), f)
      else add(null, f)
    }
  }
  return { candidates: out, ignored }
}

/**
 * Whether `dir` holds nothing but the placeholder or record files a launcher makes again for an app folder that went
 * (Quiver's "Place app files here.txt"): small files only, no folder. Safe to remove so the app's own folder can go
 * back there.
 */
export async function onlyLauncherLeftovers(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null)
  if (!entries) return false
  for (const e of entries) {
    if (!e.isFile() || !QUIVER_MARKERS.has(e.name.toLowerCase())) return false
    const st = await statOrNull(join(dir, e.name))
    if (!st || st.size > 64 * 1024) return false
  }
  return true
}

// --- matching -----------------------------------------------------------------------------------------------------

export interface ImportMatch {
  match: RecompImportItem['match']
  /** Entry ids (the pick first when there is one). */
  ids: string[]
}

/**
 * Which catalog recompilation a candidate is: its repository (several entries for a multi-game repository: the user
 * picks), else RecompLauncher's app id, else a project of the same name that moved owner (to confirm), else the
 * game's name (to confirm).
 */
export function matchCandidate(c: ImportCandidate, catalog: RecompCatalog | null): ImportMatch {
  if (!catalog) return { match: 'none', ids: [] }
  const known = (ids: readonly string[] | undefined): string[] =>
    (ids ?? []).filter((id) => catalog.entries.has(id))
  if (c.repo) {
    const ids = known(catalog.byRepo.get(repoKey(c.repo.host, c.repo.repo)))
    if (ids.length) return { match: 'repo', ids }
  }
  if (c.rlId) {
    const ids = known(catalog.byRl?.get(c.rlId))
    if (ids.length) return { match: 'launcher-id', ids }
  }
  if (c.repo) {
    const name = c.repo.repo.split('/').pop()!.toLowerCase()
    const ids = [...catalog.entries.values()]
      .filter((e) => e.repo.split('/').pop()!.toLowerCase() === name)
      .map((e) => e.id)
    if (ids.length) return { match: 'title', ids }
  }
  const wanted = new Set(
    [c.name, ...c.otherNames].map(normalizeGameTitle).filter((n) => n.length >= 3)
  )
  const ids = [...catalog.entries.values()]
    .filter((e) =>
      [e.game, e.name, ...(e.otherNames ?? [])].some((n) => wanted.has(normalizeGameTitle(n)))
    )
    .map((e) => e.id)
  return ids.length ? { match: 'title', ids } : { match: 'none', ids: [] }
}

// --- after the move -----------------------------------------------------------------------------------------------

/** Settings files whose old folder path is rewritten after the move (logs are left as they are). */
const CONFIG_EXTENSIONS = new Set([
  '.txt',
  '.json',
  '.ini',
  '.cfg',
  '.conf',
  '.toml',
  '.yaml',
  '.yml',
  '.xml'
])
const MAX_CONFIG_BYTES = 256 * 1024

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `path` spelled with any of the separators a file may use for it ("\", "/", JSON's "\\"). */
function pathPattern(path: string): RegExp {
  const parts = resolve(path)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(escapeRe)
  // The path ends at a separator, a quote, a list separator or the end of a line, never at a space: the name may go on
  // ("…\zelda 2\save.dat" is another folder than "…\zelda").
  return new RegExp(`${parts.join('(?:\\\\\\\\|\\\\|/)')}(?=[\\\\/"'<>;,|\\t\\r\\n]|$)`, 'gim')
}

/** Whether a file's bytes are UTF-8 (read and written again, they come out the same). */
function isUtf8(buf: Buffer): boolean {
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
}

/** Every character of `s` fits in one byte (latin1): a path a non-UTF-8 file can hold byte for byte. */
const oneByte = (s: string): boolean => [...s].every((ch) => ch.charCodeAt(0) <= 0xff)

/** A free backup name beside `path`: "<name>.playout-old", then "-2", "-3"… */
async function freeBackupName(path: string): Promise<string> {
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${path}.playout-old` : `${path}.playout-old-${i}`
    if (!(await statOrNull(name))) return name
  }
}

/**
 * The moved app's small settings files that name its old folder (Quiver's selected_executable.txt, a game's
 * launcher settings) name the new one: each changed file is kept first as "<name>.playout-old". Logs, big files and
 * binary files are left alone. Returns the files changed.
 */
export async function rewriteOldPaths(dir: string, from: string, to: string): Promise<string[]> {
  const re = pathPattern(from)
  const changed: string[] = []
  for (const f of await listFiles(dir, { maxDepth: 3 })) {
    const ext = f.key.slice(f.key.lastIndexOf('.'))
    if (!CONFIG_EXTENSIONS.has(ext) || f.size > MAX_CONFIG_BYTES || /log/i.test(basename(f.key)))
      continue
    const buf = await fs.readFile(f.path).catch(() => null)
    if (!buf || buf.includes(0)) continue
    // UTF-8 is read as UTF-8; any other file (an ANSI .ini) byte for byte as latin1, so every byte but the path's own
    // is written back exactly as it was. A path that does not fit in one byte per character is then left alone.
    const encoding: BufferEncoding = isUtf8(buf) ? 'utf8' : 'latin1'
    if (encoding === 'latin1' && (!oneByte(resolve(from)) || !oneByte(resolve(to)))) continue
    const text = buf.toString(encoding)
    re.lastIndex = 0
    if (!re.test(text)) continue
    re.lastIndex = 0
    const next = text.replace(re, (hit) => {
      const sep = hit.includes('\\\\') ? '\\\\' : hit.includes('/') ? '/' : '\\'
      return resolve(to)
        .split(/[\\/]+/)
        .join(sep)
    })
    if (next === text) continue
    // Always kept first, under a name that is free (an earlier backup stays as it is).
    await fs.copyFile(f.path, await freeBackupName(f.path))
    await fs.writeFile(f.path, Buffer.from(next, encoding))
    changed.push(f.path)
  }
  return changed
}

/** `path` (inside `from`) at the same place inside `to`; null when it is not inside `from`. */
export function rebaseInto(path: string, from: string, to: string): string | null {
  const p = resolve(path)
  const f = resolve(from)
  if (!isInside(f, p)) return null
  return join(resolve(to), p.slice(f.length).replace(/^[\\/]+/, ''))
}
