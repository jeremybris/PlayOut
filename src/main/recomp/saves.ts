// Where a recompilation keeps its saves: documented save folders (the developer's recomplauncher.json, the catalog)
// written as portable templates ({local}/Zelda64Recompiled/saves), expanded on this PC, and — when nobody documents
// them — searched for in the usual save places (findSaveFolders), or found by watching which files a play session
// changes (RecompLauncher's watch_start / watch_end, reimplemented).
// The resolved folders are what cloud.ts copies to and from the Emulation folder, so everything here errs on the side of
// a narrower folder: a save root is never a drive, the user's profile, a known folder itself, or the install folder.
import { createHash } from 'crypto'
import { createReadStream, promises as fs, type Dirent } from 'fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path'
import type { InstalledRecomp, RecompEntry } from '../../shared/recomp'
import { isInside, normalizePath, type KnownFolders } from '../util/paths'
import { tMain } from '../i18n'

/** What a template is expanded against on this PC. */
export interface SaveContext {
  /** The recompilation's install folder ({install}, relative paths, "<game folder>"). */
  install: string
  folders: KnownFolders
  /** The user's Documents folder when known (it may be redirected to OneDrive); else <profile>\Documents. */
  documents?: string
}

/** A file bigger than this is not a save (RecompLauncher's MAX_FILE). */
export const MAX_SAVE_FILE = 64 * 1024 * 1024
/** A .bin bigger than this is a disc image track, not a save (Xbox and many ports keep saves in small .bin files). */
export const MAX_BIN_SAVE = 16 * 1024 * 1024
/** Snapshot limits around a play session. */
export const SNAPSHOT_MAX_FILES = 20_000
export const SNAPSHOT_MAX_DEPTH = 6
/** hashSaves refuses save folders with more files than this (the folder is surely not just saves). */
export const MAX_SAVE_FILES = 20_000

function documentsOf(ctx: { folders: KnownFolders; documents?: string }): string {
  return ctx.documents ?? join(ctx.folders.userProfile, 'Documents')
}

/** {placeholder} → folder. Order matters only for toSaveTemplate ties, which pick the longest base anyway. */
function placeholders(ctx: SaveContext): [string, string][] {
  const f = ctx.folders
  return [
    ['{install}', ctx.install],
    ['{local}', f.localAppData],
    ['{config}', f.appData],
    ['{roaming}', f.appData],
    ['{locallow}', join(f.userProfile, 'AppData', 'LocalLow')],
    ['{documents}', documentsOf(ctx)],
    ['{savedgames}', join(f.userProfile, 'Saved Games')],
    ['{home}', f.userProfile]
  ]
}

/** %VAR% → folder (only the folders a save can sensibly live under; anything else makes the template unusable). */
function envVars(ctx: SaveContext): Record<string, string> {
  const f = ctx.folders
  return {
    APPDATA: f.appData,
    LOCALAPPDATA: f.localAppData,
    USERPROFILE: f.userProfile,
    HOME: f.userProfile,
    HOMEPATH: f.userProfile,
    DOCUMENTS: documentsOf(ctx),
    MYDOCUMENTS: documentsOf(ctx),
    PROGRAMDATA: f.programData,
    PUBLIC: f.publicDir,
    USERNAME: basename(f.userProfile)
  }
}

/** Stands for {install} while a template is expanded. */
const INSTALL = '\u0000install\u0000'
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
const UNC = /^\\\\[^\\]+\\[^\\]+/

/**
 * A save-path template (or a path copied out of a README) as a real folder on this PC, or null when it is prose, uses
 * a variable PlayOut does not know, points outside the install through "..", or is a Linux/macOS path.
 * Understands %APPDATA% %LOCALAPPDATA% %USERPROFILE% %HOME% %DOCUMENTS%, $HOME, ~, {install} {local} {config}
 * {documents} {home} {savedgames} {locallow}, "<game folder>" (and similar) = the install, "<username>", leading
 * "Documents/" or "AppData/" (the user's), and relative paths (inside the install). A trailing wildcard part
 * ("{install}/save/*.sav") is dropped: the folder is what is synced.
 */
export function expandSaveTemplate(t: string, ctx: SaveContext): string | null {
  let s = t.trim().replace(/^["'`]+|["'`]+$/g, '')
  if (!s || s.length > 400 || /[\r\n]/.test(s)) return null

  // <game folder>, <install dir>, <exe folder>... = the install; <username> = the user's name; anything else in angle
  // brackets is a placeholder PlayOut cannot fill.
  s = s.replace(/<([^<>]+)>/g, (m, inner: string) => {
    const k = inner.trim().toLowerCase()
    if (
      /^(game|install|installation|exe|executable|program|app|application|recomp)[ _-]?(folder|dir|directory|path|location)?$/.test(
        k
      )
    ) {
      return INSTALL
    }
    if (/^(user ?name|user|your user ?name|windows user ?name)$/.test(k))
      return basename(ctx.folders.userProfile)
    return m
  })
  if (/[<>]/.test(s)) return null

  // Template placeholders (case-insensitive).
  let unknown = false
  s = s.replace(/\{([a-z]+)\}/gi, (m, name: string) => {
    const hit = placeholders(ctx).find(([p]) => p === `{${name.toLowerCase()}}`)
    if (!hit) {
      unknown = true
      return m
    }
    return hit[0] === '{install}' ? INSTALL : hit[1]
  })
  if (unknown) return null

  // %VAR% and $HOME / ${HOME}; any other variable is unresolvable.
  const vars = envVars(ctx)
  s = s.replace(/%([^%\\/]+)%/g, (m, name: string) => {
    const v = vars[name.toUpperCase()]
    if (v === undefined) unknown = true
    return v ?? m
  })
  s = s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name: string) => {
    if (name.toUpperCase() === 'HOME' || name.toUpperCase() === 'USERPROFILE')
      return ctx.folders.userProfile
    unknown = true
    return m
  })
  if (unknown || s.includes('%')) return null

  if (s.startsWith('~')) {
    if (!/^~([\\/]|$)/.test(s)) return null
    s = ctx.folders.userProfile + s.slice(1)
  }

  // Wildcards: keep the folder before the first wildcard part.
  const parts = s.split(/[\\/]+/)
  const wild = parts.findIndex((p) => /[*?]/.test(p))
  if (wild === 0) return null
  if (wild > 0) s = parts.slice(0, wild).join('\\')

  if (/["|]/.test(s)) return null
  // Prose ("in the same folder as the game", "Saves are kept next to the exe"): a part of 4+ words.
  if (s.split(/[\\/]+/).some((p) => p.trim().split(/\s+/).length >= 4)) return null

  let out: string
  const at = s.indexOf(INSTALL)
  if (at >= 0) {
    // The install placeholder only makes sense at the start, once.
    if (at !== 0 || s.indexOf(INSTALL, 1) !== -1) return null
    const rest = s.slice(INSTALL.length).replace(/^[\\/]+/, '')
    out = rest ? resolve(ctx.install, rest) : resolve(ctx.install)
    if (!isInside(ctx.install, out)) return null
  } else if (WINDOWS_ABSOLUTE.test(s) || UNC.test(s)) {
    out = resolve(s)
  } else if (s.startsWith('/') || s.startsWith('\\')) {
    // A Unix path (or a rooted path with no drive): not a Windows save folder.
    return null
  } else {
    const [first, ...more] = s.split(/[\\/]+/)
    const head = first.toLowerCase()
    if (head === 'documents' || head === 'my documents') {
      out = resolve(documentsOf(ctx), ...more)
    } else if (head === 'appdata' || head === 'saved games') {
      out = resolve(ctx.folders.userProfile, s)
    } else {
      out = resolve(ctx.install, s)
      if (!isInside(ctx.install, out)) return null
    }
  }
  return out.replace(/[\\/]+$/, '') || out
}

/**
 * A real path as a portable template (the inverse of expandSaveTemplate): the longest known base it is inside wins,
 * so an install under AppData becomes {install}/..., not {config}/PlayOut/....
 */
export function toSaveTemplate(realPath: string, ctx: SaveContext): string {
  const p = resolve(realPath)
  let best: [string, string] | null = null
  for (const [name, base] of placeholders(ctx)) {
    if (name === '{roaming}') continue
    if (!base || !isInside(base, p)) continue
    if (!best || normalizePath(base).length > normalizePath(best[1]).length) best = [name, base]
  }
  if (!best) return p.replace(/\\/g, '/')
  const rest = p
    .slice(resolve(best[1]).length)
    .replace(/^[\\/]+/, '')
    .replace(/\\/g, '/')
  return rest ? `${best[0]}/${rest}` : best[0]
}

/**
 * Whether a folder may be used as a save root (synced, and on restore cleaned of files the copy does not have).
 * Refuses drive roots, the install folder itself and anything above it, the known folders themselves (AppData,
 * Documents, the profile, Program Files...) and anything above them.
 */
export function isSafeSaveRoot(path: string, ctx: SaveContext): boolean {
  if (!isAbsolute(path)) return false
  const p = resolve(path)
  if (dirname(p) === p) return false
  const f = ctx.folders
  const guarded = [
    ctx.install,
    f.userProfile,
    f.appData,
    f.localAppData,
    join(f.userProfile, 'AppData'),
    join(f.userProfile, 'AppData', 'LocalLow'),
    join(f.userProfile, 'Saved Games'),
    join(documentsOf(ctx), 'My Games'),
    documentsOf(ctx),
    f.programData,
    f.programFiles,
    f.programFilesX86,
    f.publicDir
  ]
  return !guarded.some((g) => g && isInside(p, g))
}

/**
 * First folder names under AppData / Documents that hold other programs' data (browsers, Windows, PlayOut's own
 * settings and secrets), never a game's saves a catalog or developer file may point at.
 */
const UNTRUSTED_DENY_FIRST = new Set([
  'microsoft',
  'packages',
  'programs',
  'temp',
  'windowspowershell',
  'powershell',
  'google',
  'mozilla',
  'bravesoftware',
  'opera software',
  'vivaldi',
  'nvidia',
  'playout',
  'discord',
  'steam'
])

/**
 * Whether a save folder named by someone other than the user (the catalog, the developer's recomplauncher.json) is
 * plausible: inside the install, or a named folder below the usual save places — AppData\Roaming, AppData\Local,
 * AppData\LocalLow, Documents (and its My Games), Saved Games — that is not a dot-folder (.ssh, .aws), the Start Menu
 * or another program's data. Anything else (the profile's other folders, C:\Windows, another drive, a UNC path) is
 * refused: the save copy would put it in the Emulation folder and, on another PC, overwrite and clean it.
 */
export function isPlausibleSaveFolder(path: string, ctx: SaveContext): boolean {
  if (!isSafeSaveRoot(path, ctx)) return false
  const p = resolve(path)
  if (isInside(ctx.install, p)) return true
  const f = ctx.folders
  const docs = documentsOf(ctx)
  const base = [
    f.appData,
    f.localAppData,
    join(f.userProfile, 'AppData', 'LocalLow'),
    join(docs, 'My Games'),
    join(f.userProfile, 'Saved Games'),
    docs
  ]
    .filter((b) => b && isInside(b, p) && normalizePath(b) !== normalizePath(p))
    .sort((a, b) => normalizePath(b).length - normalizePath(a).length)[0]
  if (!base) return false
  const parts = relParts(base, p)
  if (!parts.length) return false
  if (UNTRUSTED_DENY_FIRST.has(parts[0].toLowerCase())) return false
  return !parts.some((x) => x.startsWith('.') || /^(start menu|startup)$/i.test(x))
}

/** Whether `path` (inside the install) is, or holds, a file the release ships. */
function holdsReleaseFiles(path: string, install: string, releaseFiles: Iterable<string>): boolean {
  const p = resolve(path)
  if (!isInside(install, p)) return false
  const rel = relParts(install, p).join('/').toLowerCase()
  if (!rel) return true
  for (const k of releaseFiles) {
    const key = k.replace(/\\/g, '/').toLowerCase()
    if (key === rel || key.startsWith(`${rel}/`)) return true
  }
  return false
}

// ---------------------------------------------------------------------------------------------------------------
// Detection around a play session

/** Words too generic to tell a game's folder from another (RecompLauncher's NOT_NAMES, plus a few more). */
const NOT_NAMES = new Set([
  'recomp',
  'recompiled',
  'recompilation',
  'decomp',
  'decompilation',
  'edition',
  'game',
  'games',
  'the',
  'port',
  'version',
  'windows',
  'release',
  'remastered',
  'launcher',
  'native',
  'project',
  'engine',
  'source',
  'plus',
  'deluxe',
  'collection',
  'classic',
  'definitive',
  'complete',
  'super',
  'legend',
  'world',
  'tools',
  'data',
  'save',
  'saves',
  'config',
  'settings',
  'program',
  'files',
  'microsoft',
  'google',
  'nvidia',
  'playout'
])

/** Folder names never treated as a game's own folder (another program's data). */
const NOT_ROOTS = new Set([
  'recomplauncher',
  'playout',
  'microsoft',
  'packages',
  'temp',
  'google',
  'nvidia'
])

/** Name tokens of a game: the whole name squashed (≥4 chars) and each word of ≥4 chars not on the stop-list. */
export function nameTokens(names: string[]): string[] {
  const out = new Set<string>()
  for (const n of names) {
    if (!n) continue
    // Apostrophes join ("Majora's" is one word).
    const lower = n.toLowerCase().replace(/['’]/g, '')
    const squashed = lower.replace(/[^a-z0-9]/g, '')
    if (squashed.length >= 4) out.add(squashed)
    for (const w of lower.split(/[^a-z0-9]+/)) {
      if (w.length >= 4 && !NOT_NAMES.has(w)) out.add(w)
    }
  }
  return [...out].sort()
}

function nameMatches(dirName: string, tokens: string[]): boolean {
  const n = dirName.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (n.length < 4 || NOT_ROOTS.has(n)) return false
  return tokens.some((t) => n.includes(t) || (n.length >= 6 && t.includes(n)))
}

/** Folders not worth walking (big, never saves). */
const SKIP_WALK = new Set([
  'shadercache',
  'shader cache',
  'cache',
  'logs',
  'crashdumps',
  '.git',
  'node_modules'
])

export interface SaveSnapshot {
  /** Every file seen (absolute path) with its size and modification time. */
  files: Map<string, { size: number; mtimeMs: number }>
  /** The folders walked: the install first, then folders named like the game. */
  roots: string[]
}

/**
 * What a listed entry really is. Windows lists every reparse point as a link, OneDrive placeholders (cloud files,
 * downloaded or not) too: lstat tells the real links and junctions (null: never followed) apart, as in
 * streaming/emulation-sync/scan.ts. `unreadable` (default: null) is what an entry whose lstat fails gives.
 */
async function entryKind(
  dir: string,
  e: Dirent,
  unreadable: (err: unknown) => 'dir' | 'file' | null = () => null
): Promise<'dir' | 'file' | null> {
  if (!e.isSymbolicLink()) return e.isDirectory() ? 'dir' : e.isFile() ? 'file' : null
  let st: Awaited<ReturnType<typeof fs.lstat>>
  try {
    st = await fs.lstat(join(dir, e.name))
  } catch (err) {
    return unreadable(err)
  }
  if (st.isSymbolicLink()) return null
  return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null
}

async function walkInto(
  root: string,
  into: SaveSnapshot['files'],
  budget: { left: number }
): Promise<void> {
  const stack: [string, number][] = [[root, 0]]
  while (stack.length && budget.left > 0) {
    const [dir, depth] = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (budget.left <= 0) return
      const p = join(dir, e.name)
      // Links and junctions are not followed: they lead out of the folder (often into a big shared one).
      const kind = await entryKind(dir, e)
      if (kind === 'dir') {
        if (depth < SNAPSHOT_MAX_DEPTH && !SKIP_WALK.has(e.name.toLowerCase()))
          stack.push([p, depth + 1])
      } else if (kind === 'file') {
        try {
          const st = await fs.lstat(p)
          budget.left--
          into.set(p, { size: st.size, mtimeMs: st.mtimeMs })
        } catch {
          /* gone meanwhile */
        }
      }
    }
  }
}

/** The places a recompilation may save in, before it starts: its install, and folders named like it. */
export async function snapshotSaveCandidates(
  entry: RecompEntry,
  installed: InstalledRecomp,
  folders: KnownFolders,
  documents?: string
): Promise<SaveSnapshot> {
  const repoName = entry.repo.split('/').pop() ?? ''
  const tokens = nameTokens([entry.game, entry.name, repoName])
  const docs = documents ?? join(folders.userProfile, 'Documents')
  const bases: string[] = []
  for (const b of [
    docs,
    join(docs, 'My Games'),
    join(folders.userProfile, 'Saved Games'),
    folders.appData,
    folders.localAppData,
    join(folders.userProfile, 'AppData', 'LocalLow')
  ]) {
    if (!bases.some((x) => normalizePath(x) === normalizePath(b))) bases.push(b)
  }
  const install = resolve(installed.dir)
  const roots = [install]
  for (const base of bases) {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!nameMatches(e.name, tokens) || (await entryKind(base, e)) !== 'dir') continue
      const p = join(base, e.name)
      // Already walked (inside the install), or holding the install (PlayOut's own data folder): skip.
      if (roots.some((r) => isInside(r, p) || isInside(p, r))) continue
      roots.push(p)
    }
  }
  const files: SaveSnapshot['files'] = new Map()
  const budget = { left: SNAPSHOT_MAX_FILES }
  for (const r of roots) await walkInto(r, files, budget)
  return { files, roots }
}

/** Never saves: programs, archives, disc images, logs, configuration, crash dumps. */
const NOT_SAVE_EXT = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.jar',
  '.pyd',
  '.pdb',
  '.msi',
  '.zip',
  '.7z',
  '.rar',
  '.iso',
  '.cue',
  '.chd',
  '.rvz',
  '.wbfs',
  '.cso',
  '.xex',
  '.nsp',
  '.xci',
  '.z64',
  '.n64',
  '.v64',
  '.log',
  '.txt',
  '.ini',
  '.cfg',
  '.toml',
  '.yaml',
  '.yml',
  '.dmp',
  '.tmp',
  '.lock',
  '.part',
  '.png',
  '.jpg',
  '.jpeg',
  '.bmp',
  '.mp4',
  '.wav',
  '.ogg',
  '.ttf',
  '.otf'
])
/** Folders whose files are never saves. */
const NOT_SAVE_DIRS = new Set([
  'mods',
  'mod',
  'cache',
  'shadercache',
  'shader cache',
  'logs',
  'log',
  'screenshots',
  'crashdumps',
  'texturepacks',
  'textures'
])
const PROGRAM_EXT = new Set(['.exe', '.dll', '.so', '.dylib', '.jar', '.jmod', '.pyd'])

/** Whether a file that changed during play looks like a save. */
export function looksLikeSave(name: string, size: number): boolean {
  const lower = name.toLowerCase()
  if (lower.includes('crash')) return false
  const ext = extname(lower)
  if (NOT_SAVE_EXT.has(ext)) return false
  if (size > MAX_SAVE_FILE) return false
  if (ext === '.bin' && size > MAX_BIN_SAVE) return false
  return true
}

function relParts(root: string, p: string): string[] {
  return p
    .slice(resolve(root).length)
    .split(/[\\/]+/)
    .filter(Boolean)
}

/** Whether a folder (from the snapshot) holds programs: a runtime the game fetched, its tools. Never a save place. */
function holdsPrograms(dir: string, snap: SaveSnapshot): boolean {
  for (const p of snap.files.keys()) {
    if (isInside(dir, p) && PROGRAM_EXT.has(extname(p).toLowerCase())) return true
  }
  return false
}

/**
 * After the session: the folders where the game wrote something that looks like a save, as templates. A hit in the
 * install becomes {install}/<first folder> (or the file itself when at the top); a hit elsewhere becomes the
 * matched folder. Release files, programs folders, mods/cache/logs/screenshots are ignored.
 */
export function detectSaveFolders(
  before: SaveSnapshot,
  after: SaveSnapshot,
  installed: InstalledRecomp,
  ctx: SaveContext
): string[] {
  const install = resolve(installed.dir)
  const release = new Set(installed.releaseFiles.map((f) => f.replace(/\\/g, '/').toLowerCase()))
  const roots = after.roots.length ? after.roots : before.roots
  const out = new Set<string>()
  for (const [p, st] of after.files) {
    const was = before.files.get(p)
    if (was && was.size === st.size && was.mtimeMs === st.mtimeMs) continue
    if (!looksLikeSave(basename(p), st.size)) continue
    const root = roots.filter((r) => isInside(r, p)).sort((a, b) => b.length - a.length)[0]
    if (!root) continue
    const parts = relParts(root, p)
    if (parts.slice(0, -1).some((d) => NOT_SAVE_DIRS.has(d.toLowerCase()))) continue
    let template: string
    if (normalizePath(root) === normalizePath(install)) {
      const rel = parts.join('/').toLowerCase()
      if (release.has(rel)) continue
      if (parts.length === 1) {
        template = toSaveTemplate(p, ctx)
      } else {
        const first = join(install, parts[0])
        if (holdsPrograms(first, after)) continue
        // A folder that also holds release files would sync (and on restore overwrite or delete) game data: the
        // widest folder down to the save that holds none, else the save file itself.
        let folder: string | null = null
        for (let k = 1; k < parts.length; k++) {
          const candidate = join(install, ...parts.slice(0, k))
          if (!holdsReleaseFiles(candidate, install, release)) {
            folder = candidate
            break
          }
        }
        template = toSaveTemplate(folder ?? p, ctx)
      }
    } else {
      if (holdsPrograms(root, after)) continue
      if (!isSafeSaveRoot(root, ctx)) continue
      template = toSaveTemplate(root, ctx)
    }
    out.add(template)
  }
  return [...out].sort()
}

// ---------------------------------------------------------------------------------------------------------------
// Searching the usual places (after install, and "Find automatically")

/** Folder names inside an install that hold saves (a top-level folder of the install). */
const INSTALL_SAVE_DIRS =
  /^(saves?|savedata|save[ _-]data|savegames?|saved[ _-]?games|userdata|profiles?)$/i
/** Files walked per candidate folder; a folder with more is not just saves. */
export const FIND_MAX_FILES = 2000
const FIND_MAX_DEPTH = 4
/** Company folders looked into under AppData\LocalLow (Unity games save in LocalLow\<company>\<game>). */
const FIND_MAX_COMPANIES = 300

/** The name tokens of a recompilation: its game, project and repository names, and its program's name. */
export function recompNameTokens(
  entry: Pick<RecompEntry, 'game' | 'name' | 'repo'>,
  installed: Pick<InstalledRecomp, 'exe'>
): string[] {
  const repoName = entry.repo.split('/').pop() ?? ''
  const exe = installed.exe ? basename(installed.exe, extname(installed.exe)) : ''
  return nameTokens([entry.game, entry.name, repoName, exe])
}

/**
 * A recompilation's whole names squashed (game, project, repository, program): a folder named exactly like one, or
 * starting with one of 6 characters or more ("Zelda64Recompiled" for "Zelda64Recomp"), is a strong match.
 */
export function recompWholeNames(
  entry: Pick<RecompEntry, 'game' | 'name' | 'repo'>,
  installed: Pick<InstalledRecomp, 'exe'>
): string[] {
  const repoName = entry.repo.split('/').pop() ?? ''
  const exe = installed.exe ? basename(installed.exe, extname(installed.exe)) : ''
  const out = new Set<string>()
  for (const n of [entry.game, entry.name, repoName, exe]) {
    const s = (n ?? '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]/g, '')
    if (s.length >= 4) out.add(s)
  }
  return [...out]
}

/** Whether a folder name is a strong match for the whole names (see recompWholeNames). */
function strongNameMatch(dirName: string, whole: string[]): boolean {
  const n = dirName.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (n.length < 4 || NOT_ROOTS.has(n)) return false
  return whole.some((w) => n === w || (w.length >= 6 && n.startsWith(w)))
}

/**
 * A folder found by findSaveFolders: how many save-like files it holds, and when the newest changed. `strong`: named
 * like the whole game, project, repository or program (or a save folder of the install); a folder that only shares a
 * word with them ("DarkSoulsIII" for Perfect Dark, "StardewValley" for Star Fox) is not, and is never used on its
 * own: only offered.
 */
export interface FoundSaveFolder {
  path: string
  saves: number
  newest: number
  strong: boolean
}

/** Count a candidate's save-like files; null when it is no save folder (programs, too many files, no saves). */
async function judgeCandidate(dir: string, strong: boolean): Promise<FoundSaveFolder | null> {
  const stack: [string, number][] = [[dir, 0]]
  let files = 0
  let saves = 0
  let newest = 0
  while (stack.length) {
    const [d, depth] = stack.pop()!
    let entries: Dirent[]
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const kind = await entryKind(d, e)
      const p = join(d, e.name)
      if (kind === 'dir') {
        if (depth < FIND_MAX_DEPTH && !SKIP_WALK.has(e.name.toLowerCase()))
          stack.push([p, depth + 1])
        continue
      }
      if (kind !== 'file') continue
      if (++files > FIND_MAX_FILES) return null
      if (PROGRAM_EXT.has(extname(e.name).toLowerCase())) return null
      const parts = relParts(dir, p).slice(0, -1)
      if (parts.some((x) => NOT_SAVE_DIRS.has(x.toLowerCase()))) continue
      let st: Awaited<ReturnType<typeof fs.lstat>>
      try {
        st = await fs.lstat(p)
      } catch {
        continue
      }
      if (!looksLikeSave(e.name, st.size)) continue
      saves++
      newest = Math.max(newest, st.mtimeMs)
    }
  }
  return saves ? { path: dir, saves, newest, strong } : null
}

/**
 * Look for a recompilation's save folders before anyone knows them: folders named like the game, the project, the
 * repository or the program under Documents, Documents\My Games, Saved Games, AppData\Roaming, AppData\Local and
 * AppData\LocalLow (and LocalLow\<company>\), and save-named folders at the top of the install ("saves", "savedata",
 * "userdata"...) that hold no release files. Only folders holding save-like files and no programs count, and only
 * plausible save folders (isPlausibleSaveFolder: never AppData, Documents, the profile, another program's data...).
 * `exclude` folders (and folders inside or holding them) are skipped: PlayOut's own folders, other recompilations'
 * save folders. Best first (most save-like files, then newest).
 */
export async function findSaveFolders(
  entry: Pick<RecompEntry, 'game' | 'name' | 'repo'>,
  installed: Pick<InstalledRecomp, 'dir' | 'exe' | 'releaseFiles'>,
  ctx: SaveContext,
  opts: { exclude?: string[] } = {}
): Promise<FoundSaveFolder[]> {
  const tokens = recompNameTokens(entry, installed)
  const whole = recompWholeNames(entry, installed)
  const f = ctx.folders
  const docs = documentsOf(ctx)
  const localLow = join(f.userProfile, 'AppData', 'LocalLow')
  const bases = [
    docs,
    join(docs, 'My Games'),
    join(f.userProfile, 'Saved Games'),
    f.appData,
    f.localAppData,
    localLow
  ].filter((b, i, all) => b && all.findIndex((x) => normalizePath(x) === normalizePath(b)) === i)
  const install = resolve(installed.dir)
  const exclude = (opts.exclude ?? []).filter(Boolean)
  const candidates: { path: string; strong: boolean }[] = []
  const add = (p: string): void => {
    if (candidates.some((c) => normalizePath(c.path) === normalizePath(p))) return
    if (exclude.some((x) => isInside(x, p) || isInside(p, x))) return
    // An install inside a save place (PlayOut's own data folder): only the install's save folders below count.
    if (isInside(p, install)) return
    if (!isPlausibleSaveFolder(p, ctx)) return
    candidates.push({ path: p, strong: strongNameMatch(basename(p), whole) })
  }
  const dirsOf = async (dir: string): Promise<Dirent[]> => {
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: Dirent[] = []
    for (const e of entries) if ((await entryKind(dir, e)) === 'dir') out.push(e)
    return out
  }
  if (tokens.length) {
    for (const base of bases) {
      const dirs = await dirsOf(base)
      for (const e of dirs) if (nameMatches(e.name, tokens)) add(join(base, e.name))
      if (normalizePath(base) !== normalizePath(localLow)) continue
      for (const company of dirs.slice(0, FIND_MAX_COMPANIES)) {
        if (nameMatches(company.name, tokens)) continue
        for (const e of await dirsOf(join(base, company.name)))
          if (nameMatches(e.name, tokens)) add(join(base, company.name, e.name))
      }
    }
  }
  const release = installed.releaseFiles ?? []
  for (const e of await dirsOf(install)) {
    if (!INSTALL_SAVE_DIRS.test(e.name)) continue
    const p = join(install, e.name)
    if (holdsReleaseFiles(p, install, release)) continue
    // The install itself sits inside excluded folders (the Recompilations folder): only a folder holding an excluded
    // one (another recompilation's save folder) is skipped here.
    if (!isSafeSaveRoot(p, ctx) || exclude.some((x) => isInside(p, x))) continue
    if (!candidates.some((c) => normalizePath(c.path) === normalizePath(p)))
      candidates.push({ path: p, strong: true })
  }
  const found: FoundSaveFolder[] = []
  for (const c of candidates) {
    const judged = await judgeCandidate(c.path, c.strong)
    if (judged) found.push(judged)
  }
  return found.sort((a, b) => b.saves - a.saves || b.newest - a.newest)
}

// ---------------------------------------------------------------------------------------------------------------
// Resolution

/** The `saves` templates of the developer's recomplauncher.json next to the release (tolerant: [] when absent/odd). */
export async function readDeveloperSaves(installDir: string): Promise<string[]> {
  let text: string
  try {
    text = await fs.readFile(join(installDir, 'recomplauncher.json'), 'utf8')
  } catch {
    return []
  }
  try {
    const json = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
    const saves = (json as { saves?: unknown })?.saves
    if (!Array.isArray(saves)) return []
    const out: string[] = []
    for (const s of saves) {
      if (typeof s === 'string') out.push(s)
      else if (s && typeof s === 'object') {
        // { path, platform? } shapes: keep Windows / any.
        const o = s as { path?: unknown; platform?: unknown; os?: unknown }
        const plat =
          typeof o.platform === 'string' ? o.platform : typeof o.os === 'string' ? o.os : 'any'
        if (typeof o.path === 'string' && /^(any|all|windows|win|win64)$/i.test(plat))
          out.push(o.path)
      }
    }
    return out
  } catch {
    return []
  }
}

/** Keep the templates that expand to a usable save root here, deduplicated (by real folder), in order. */
export function usableSaveTemplates(templates: string[], ctx: SaveContext): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of templates) {
    const real = expandSaveTemplate(t, ctx)
    if (!real || !isSafeSaveRoot(real, ctx)) continue
    const key = normalizePath(real)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/**
 * usableSaveTemplates for folders named by the catalog or the developer (or detected): only plausible save folders
 * (isPlausibleSaveFolder; `strict` false skips that for detected ones, which are found by name under the save places
 * already), and never an install folder that holds release files.
 */
function trustedSaveTemplates(
  templates: string[],
  ctx: SaveContext,
  installed: Pick<InstalledRecomp, 'releaseFiles'>,
  strict: boolean
): string[] {
  return usableSaveTemplates(templates, ctx).filter((t) => {
    const real = expandSaveTemplate(t, ctx)!
    if (strict && !isPlausibleSaveFolder(real, ctx)) return false
    return !holdsReleaseFiles(real, ctx.install, installed.releaseFiles ?? [])
  })
}

/** Templates → real folders, dropping the ones that cannot be used here (same filter as usableSaveTemplates). */
export function expandSavePaths(templates: string[], ctx: SaveContext): string[] {
  return usableSaveTemplates(templates, ctx).map((t) => expandSaveTemplate(t, ctx)!)
}

/**
 * The save folders to use, as templates (expand with expandSavePaths): the first layer that has any usable folder —
 * the user's own choice, the developer's recomplauncher.json, the catalog, what was detected earlier — else [] with
 * source null (detection runs around the next play).
 */
export async function resolveSavePaths(
  entry: Pick<RecompEntry, 'savePaths'>,
  installed: InstalledRecomp,
  ctx: SaveContext
): Promise<{ paths: string[]; source: InstalledRecomp['saveSource'] }> {
  if (installed.saveSource === 'user') {
    const user = usableSaveTemplates(installed.savePaths, ctx)
    if (user.length) return { paths: user, source: 'user' }
  }
  // Folders named by others are untrusted: only plausible save folders, never ones holding release files.
  const dev = trustedSaveTemplates(await readDeveloperSaves(installed.dir), ctx, installed, true)
  if (dev.length) return { paths: dev, source: 'developer' }
  const catalog = trustedSaveTemplates(entry.savePaths, ctx, installed, true)
  if (catalog.length) return { paths: catalog, source: 'catalog' }
  if (installed.saveSource === 'detected' || installed.saveSource === 'install') {
    const detected = trustedSaveTemplates(installed.savePaths, ctx, installed, false)
    if (detected.length) return { paths: detected, source: installed.saveSource }
  }
  return { paths: [], source: null }
}

// ---------------------------------------------------------------------------------------------------------------
// Listing and hashing

export interface SaveFile {
  /** Index of the save root in the list given. */
  root: number
  /** Path inside the root, '/'-separated (for a root that is a file: its name). */
  rel: string
  abs: string
  size: number
  mtimeMs: number
}

/** A missing file or folder (gone, or a path through a file): nothing to list there. */
function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function unreadableSaves(path: string, err: unknown): Error {
  return new Error(
    tMain('mainRecomp.saves.unreadable', {
      path,
      error: err instanceof Error ? err.message : String(err)
    })
  )
}

/**
 * Every file under the save roots (a root may be a single file). The roots themselves may be links (an emulator-style
 * junction to a shared folder); links inside them are not followed (OneDrive placeholders are listed: they are the
 * saves). Missing roots give nothing. Anything there that cannot be read (a locked folder, a placeholder that fails to
 * open) throws: saves that cannot be listed would read as no saves, and be restored over.
 */
export async function listSaveFiles(paths: string[]): Promise<SaveFile[]> {
  const out: SaveFile[] = []
  for (let i = 0; i < paths.length; i++) {
    const root = resolve(paths[i])
    let st: Awaited<ReturnType<typeof fs.stat>>
    try {
      st = await fs.stat(root)
    } catch (err) {
      if (isGone(err)) continue
      throw unreadableSaves(root, err)
    }
    if (st.isFile()) {
      out.push({ root: i, rel: basename(root), abs: root, size: st.size, mtimeMs: st.mtimeMs })
      continue
    }
    if (!st.isDirectory()) continue
    const stack: string[] = [root]
    while (stack.length) {
      const dir = stack.pop()!
      let entries: Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (err) {
        if (isGone(err)) continue
        throw unreadableSaves(dir, err)
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        const kind = await entryKind(dir, e, (err) => {
          if (isGone(err)) return null
          throw unreadableSaves(p, err)
        })
        if (kind === 'dir') stack.push(p)
        else if (kind === 'file') {
          let fst: Awaited<ReturnType<typeof fs.lstat>>
          try {
            fst = await fs.lstat(p)
          } catch (err) {
            if (isGone(err)) continue
            throw unreadableSaves(p, err)
          }
          out.push({
            root: i,
            rel: relParts(root, p).join('/'),
            abs: p,
            size: fst.size,
            mtimeMs: fst.mtimeMs
          })
          if (out.length > MAX_SAVE_FILES) {
            throw new Error(
              tMain('mainRecomp.saves.tooManyFiles', { folder: paths[i], max: MAX_SAVE_FILES })
            )
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.root - b.root || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((ok, fail) => {
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('error', fail)
      .on('end', () => ok())
  })
  return hash.digest('hex')
}

/** The hash of a set of saves: sha256 over the sorted "<root>/<rel>\t<sha256>" lines; null when there are no files. */
export function savesHash(files: { root: number; rel: string; sha256: string }[]): string | null {
  if (!files.length) return null
  const lines = files.map((f) => `${f.root}/${f.rel}\t${f.sha256}`).sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/**
 * The saves' content hash (identical saves give the same hash on any PC, whatever their times) and each file's hash.
 */
export async function hashSaves(paths: string[]): Promise<{
  hash: string | null
  files: { rel: string; size: number; sha256: string; root: number }[]
}> {
  const listed = await listSaveFiles(paths)
  const files: { rel: string; size: number; sha256: string; root: number }[] = []
  for (const f of listed) {
    files.push({ rel: f.rel, size: f.size, sha256: await sha256File(f.abs), root: f.root })
  }
  return { hash: savesHash(files), files }
}
