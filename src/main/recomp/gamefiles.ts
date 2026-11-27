// The player's own game files for a recompilation: which ones it asks for (catalog needs, or the developer's own
// `recomplauncher.json` next to the release), which library file or folder fits each one, whether a picked file is a
// known good dump (hashing it once), and how they reach the recomp at launch (a command-line argument, an
// environment variable, or a copy into a folder of the install). Behaviour follows RecompLauncher's "game" / named
// inputs format (docs/DEVELOPERS.md, docs/SETUP-INPUTS.md), reimplemented here; nothing of the recomp is run.
import { createHash } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, dirname, extname, isAbsolute, join, parse as parsePath, resolve } from 'path'
import { z } from 'zod'
import type { Game } from '../../shared/types'
import type { GameFileNeed, GameFileState, InstalledRecomp, RecompEntry } from '../../shared/recomp'
import type { Logger } from '../logger'
import { crc32Update } from '../util/hash'
import { isInside, normalizePath } from '../util/paths'
import { tMain } from '../i18n'

export type VerifyResult = 'match' | 'mismatch' | 'unverified'
type HashAlgo = GameFileNeed['hashes'][number]['algo']

/** Files bigger than this are not hashed (a whole Blu-ray image would take minutes); they count as unverified. */
export const MAX_VERIFY_BYTES = 8 * 1024 ** 3

/** The developer profile RecompLauncher reads next to a release. */
export const DEVELOPER_PROFILE = 'recomplauncher.json'
const MAX_PROFILE_BYTES = 1024 * 1024

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * Each need of the entry with what is in use for it: the user's pick (or an earlier library choice) stored on the
 * install, else a fitting file from the library. `verified` holds results of `verifyGameFile` by path.
 * A need is ready when it is optional, the recomp asks for it itself ('self' / 'none'), or a path is set and is not a
 * library file known to be the wrong dump (an explicit pick of a mismatching file is respected: some recomps accept
 * other revisions, and the page shows the mismatch).
 */
export function gameFileStates(
  entry: Pick<RecompEntry, 'needs'>,
  installed: Pick<InstalledRecomp, 'gameFiles'> | null,
  libraryFiles: string[],
  verified: Record<string, VerifyResult>
): GameFileState[] {
  const base: GameFileState[] = entry.needs
    .filter((n) => n.how !== 'none')
    .map((need) => {
      const chosen = installed?.gameFiles[need.id]
      return withPath(need, chosen?.path ?? null, chosen?.source ?? null, verified)
    })
  const picks = autoPick(base, libraryFiles)
  return base.map((s) => {
    const pick = picks[s.id]
    return pick ? withPath(s, pick.path, pick.source, verified) : s
  })
}

function withPath(
  need: GameFileNeed,
  path: string | null,
  source: GameFileState['source'],
  verified: Record<string, VerifyResult>
): GameFileState {
  const v = path ? (verified[path] ?? null) : null
  return {
    ...need,
    path,
    source: path ? source : null,
    verified: v,
    ready: isReady(need, path, source, v)
  }
}

function isReady(
  need: GameFileNeed,
  path: string | null,
  source: GameFileState['source'],
  verified: VerifyResult | null
): boolean {
  if (need.optional || need.how === 'self' || need.how === 'none') return true
  if (!path) return false
  return !(source === 'library' && verified === 'mismatch')
}

/**
 * States whose file or folder is gone from disk (moved, drive unplugged) lose their path, so the page asks again
 * instead of the launch failing inside the recomp.
 */
export async function dropMissingPaths(states: GameFileState[]): Promise<GameFileState[]> {
  return Promise.all(
    states.map(async (s) => {
      if (!s.path) return s
      const st = await fs.stat(s.path).catch(() => null)
      const fits = st && (st.isDirectory() ? s.accepts !== 'file' : s.accepts !== 'folder')
      if (fits) return s
      return { ...s, path: null, source: null, verified: null, ready: isReady(s, null, null, null) }
    })
  )
}

// ---------------------------------------------------------------------------
// Library files
// ---------------------------------------------------------------------------

/**
 * The library's copy of a game that can serve as a recomp's game file: a ROM / disc image for emulated games, the
 * install folder for PC games (source ports want the original's data folder). .m3u / .cue companions are not
 * listed: the recomps want the image itself.
 */
export function libraryFilesFor(
  game: Pick<Game, 'source' | 'romPath' | 'installDir' | 'launch'>
): string[] {
  const out: string[] = []
  const add = (p: string | undefined | null): void => {
    if (!p) return
    if (!out.some((o) => normalizePath(o) === normalizePath(p))) out.push(p)
  }
  add(game.romPath)
  if (game.launch.kind === 'emulator') add(game.launch.romPath)
  if (game.source !== 'rom') add(game.installDir)
  return out
}

/** A library path that names a file (it has a real extension: letters, not a version number like "Game 1.0"). */
function looksLikeFile(path: string): boolean {
  const ext = extname(path).toLowerCase()
  return /^\.[a-z0-9]{1,5}$/.test(ext) && /[a-z]/.test(ext)
}

function fitsNeed(need: GameFileNeed, path: string): boolean {
  const file = looksLikeFile(path)
  if (file) {
    if (need.accepts === 'folder') return false
    return need.formats.length === 0 || need.formats.includes(extname(path).toLowerCase())
  }
  return need.accepts !== 'file'
}

/**
 * Library files for the needs nothing is set for yet: only 'game' needs (a ROM is never a BIOS or an update), a
 * file whose extension the need accepts (any, when it lists none) or a folder for needs that take folders. One
 * library path serves one need at most.
 */
export function autoPick(
  states: GameFileState[],
  libraryFiles: string[]
): Record<string, { path: string; source: 'library' }> {
  const out: Record<string, { path: string; source: 'library' }> = {}
  const used = new Set(states.filter((s) => s.path).map((s) => normalizePath(s.path as string)))
  for (const s of states) {
    if (s.path || s.kind !== 'game' || s.how === 'none') continue
    const hit = libraryFiles.find((p) => !used.has(normalizePath(p)) && fitsNeed(s, p))
    if (!hit) continue
    used.add(normalizePath(hit))
    out[s.id] = { path: hit, source: 'library' }
  }
  return out
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Digests computed for one file version (path + size + mtime), by algorithm. */
export type DigestCache = Map<string, Partial<Record<HashAlgo, string>>>

/**
 * Whether the file is one of the need's known good dumps. The file is read once for every algorithm the need lists;
 * digests are kept in `cache` by path, size and modification time, so a later check of the same file (another need,
 * the next launch) costs nothing. Folders, missing files, files over 8 GB and needs without hashes are 'unverified'.
 */
export async function verifyGameFile(
  path: string,
  need: Pick<GameFileNeed, 'hashes'>,
  cache?: DigestCache
): Promise<VerifyResult> {
  const hashes = need.hashes.filter((h) => h.value.trim())
  if (hashes.length === 0) return 'unverified'
  const st = await fs.stat(path).catch(() => null)
  if (!st || !st.isFile() || st.size > MAX_VERIFY_BYTES) return 'unverified'
  const key = `${normalizePath(path)}|${st.size}|${Math.round(st.mtimeMs)}`
  const known = cache?.get(key) ?? {}
  const wanted = [...new Set(hashes.map((h) => h.algo))].filter((a) => !known[a])
  if (wanted.length > 0) {
    const fresh = await digestFile(path, wanted)
    if (!fresh) return 'unverified'
    Object.assign(known, fresh)
    cache?.set(key, known)
  }
  const match = hashes.some((h) => known[h.algo] === normalizeHex(h.algo, h.value))
  return match ? 'match' : 'mismatch'
}

function normalizeHex(algo: HashAlgo, value: string): string {
  const hex = value.trim().toLowerCase().replace(/^0x/, '')
  return algo === 'crc32' ? hex.padStart(8, '0') : hex
}

async function digestFile(
  path: string,
  algos: HashAlgo[]
): Promise<Partial<Record<HashAlgo, string>> | null> {
  const hashers = algos
    .filter((a): a is Exclude<HashAlgo, 'crc32'> => a !== 'crc32')
    .map((a) => [a, createHash(a)] as const)
  const wantCrc = algos.includes('crc32')
  let crc = 0
  return new Promise((done) => {
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      for (const [, h] of hashers) h.update(buf)
      if (wantCrc) crc = crc32Update(crc, buf)
    })
    stream.on('error', () => done(null))
    stream.on('end', () => {
      const out: Partial<Record<HashAlgo, string>> = {}
      for (const [a, h] of hashers) out[a] = h.digest('hex')
      if (wantCrc) out.crc32 = crc.toString(16).padStart(8, '0')
      done(out)
    })
  })
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export interface LaunchPrep {
  /** Arguments for the game files, appended after the recomp's own. */
  args: string[]
  env: Record<string, string>
  /** Files (or folders) to place into the install before starting. */
  copies: { from: string; to: string }[]
  /** Required needs that are not ready: the launch stops and the page asks for them. */
  missing: GameFileState[]
}

/**
 * How the chosen game files reach the recomp. 'flag' needs become `[flag, path]` (`[path]` for a bare argument,
 * `[flag + path]` when the flag ends with "=" as in "--game="), 'env' needs an environment variable, 'folder' needs a
 * copy into `<install>/<folder>/<fileName or the file's own name>` (never outside the install). 'self' needs are
 * left to the recomp's own picker and never block.
 */
export function prepareLaunch(
  entry: Pick<RecompEntry, 'id'>,
  installed: Pick<InstalledRecomp, 'dir'>,
  states: GameFileState[]
): LaunchPrep {
  void entry
  const prep: LaunchPrep = { args: [], env: {}, copies: [], missing: [] }
  for (const s of states) {
    if (s.how === 'none' || s.how === 'self') continue
    if (!s.ready || !s.path) {
      if (!s.ready) prep.missing.push(s)
      continue
    }
    if (s.how === 'flag') {
      const flag = s.flag ?? ''
      if (!flag) prep.args.push(s.path)
      else if (flag.endsWith('=')) prep.args.push(flag + s.path)
      else prep.args.push(flag, s.path)
    } else if (s.how === 'env') {
      if (s.env) prep.env[s.env] = s.path
    } else if (s.how === 'folder') {
      // `intoFolder`: the picked folder's files go straight into `folder` (the install itself for '.'), else the pick
      // goes in under its own (or the catalog's) name.
      const to = s.intoFolder
        ? resolve(installed.dir, s.folder ?? '')
        : resolve(installed.dir, s.folder ?? '', s.fileName ?? basename(s.path))
      // A catalog folder like "../x" must never place files outside the install.
      if (
        !isInside(installed.dir, to) ||
        (!s.intoFolder && normalizePath(to) === normalizePath(installed.dir))
      ) {
        continue
      }
      // The pick is the target (nothing to copy), or one holds the other: a folder holding the target (the install
      // itself, or a folder above it) would be copied into its own copy without end.
      const from = resolve(s.path)
      if (isInside(from, to) || isInside(to, from)) continue
      prep.copies.push({ from: s.path, to })
    }
  }
  return prep
}

/**
 * Put the game files in place: a hard link when source and target share a volume (instant, no extra space), else a
 * copy (through a temporary name, so an interrupted copy is never taken for the real file). A target that already
 * has the source's size and modification time is left alone. Folders are copied file by file the same way.
 */
export async function applyCopies(
  copies: { from: string; to: string }[],
  log: Logger
): Promise<void> {
  for (const c of copies) {
    const st = await fs.stat(c.from)
    if (st.isDirectory()) await placeFolder(c.from, c.to, log)
    else await placeFile(c.from, c.to, st, log)
  }
}

async function placeFolder(from: string, to: string, log: Logger, root = to): Promise<void> {
  // Never into itself: a source holding the destination would be copied into its own copy without end.
  if (isInside(resolve(from), resolve(root)) || isInside(resolve(root), resolve(from))) {
    throw new Error(tMain('mainRecomp.files.nested', { picked: from, folder: root }))
  }
  await fs.mkdir(to, { recursive: true })
  for (const d of await fs.readdir(from, { withFileTypes: true })) {
    const src = join(from, d.name)
    const dst = join(to, d.name)
    if (isInside(resolve(src), resolve(root))) continue
    if (d.isDirectory()) await placeFolder(src, dst, log, root)
    else if (d.isFile()) await placeFile(src, dst, await fs.stat(src), log)
  }
}

function sameVolume(a: string, b: string): boolean {
  return parsePath(resolve(a)).root.toLowerCase() === parsePath(resolve(b)).root.toLowerCase()
}

async function placeFile(
  from: string,
  to: string,
  st: { size: number; mtimeMs: number; atime: Date; mtime: Date },
  log: Logger
): Promise<void> {
  const existing = await fs.stat(to).catch(() => null)
  if (existing?.isDirectory())
    throw new Error(tMain('mainRecomp.files.folderInTheWay', { path: to }))
  if (
    existing &&
    existing.size === st.size &&
    Math.abs(existing.mtimeMs - st.mtimeMs) < 2000 // FAT / network shares keep 2-second times
  ) {
    return
  }
  await fs.mkdir(dirname(to), { recursive: true })
  const tmp = `${to}.playout-tmp`
  await fs.rm(tmp, { force: true })
  let linked = false
  if (sameVolume(from, to)) {
    try {
      await fs.link(from, tmp)
      linked = true
    } catch {
      // Not NTFS, a different volume behind a mount point, or no permission: copy instead.
    }
  }
  if (!linked) {
    await fs.copyFile(from, tmp)
    await fs.utimes(tmp, st.atime, st.mtime)
  }
  try {
    await fs.rm(to, { force: true })
    await fs.rename(tmp, to)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  log.info(`${linked ? 'Linked' : 'Copied'} game file ${from} -> ${to}`)
}

// ---------------------------------------------------------------------------
// Developer profile (recomplauncher.json)
// ---------------------------------------------------------------------------

export interface DeveloperProfile {
  /** What the recomp asks for, translated to PlayOut's needs. */
  needs: GameFileNeed[]
  /** Save folders / files as the developer wrote them: templates with {install}, {local}, {config}, {documents}, {home}. */
  saves: string[]
  /**
   * The program to start (relative to the install: the first listed one that exists) and its own arguments and
   * environment, with path tokens filled in. Arguments that carried a game file ({game}, {input:id}) are taken out
   * here: they come back from `prepareLaunch` as the needs' flags.
   */
  start?: { program?: string; args?: string[]; env?: Record<string, string> }
}

const str = z.string()
const strArr = z.array(z.string())
const placesSchema = z.array(z.object({ path: z.string(), if: z.string().optional() }))
const profileSchema = z.object({
  format: z.literal(1),
  game: z
    .object({
      kind: z.enum(['iso', 'folder', 'iso_or_folder']).optional(),
      label: str.optional(),
      check: z.record(z.string(), z.unknown()).optional(),
      dumps: z
        .array(z.object({ name: str.optional(), size: z.number().optional(), crc32: str }))
        .optional()
        .catch(undefined),
      update: z
        .object({
          into: str,
          label: str,
          accepts: z.enum(['file', 'folder', 'file or folder']).optional(),
          optional: z.boolean().optional(),
          name: str.optional(),
          sha256: str.optional()
        })
        .optional()
        .catch(undefined)
    })
    .optional()
    .catch(undefined),
  inputs: z
    .array(
      z
        .object({
          id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          label: str,
          role: z.enum(['game', 'disc', 'dlc', 'update', 'key', 'runtime']).optional(),
          optional: z.boolean().optional(),
          shared: str.optional(),
          destination: str.optional(),
          formats: z
            .array(
              z.object({
                type: z.enum(['file', 'folder']),
                extensions: strArr.optional()
              })
            )
            .optional()
        })
        .nullable()
        .catch(null)
    )
    .optional()
    .catch(undefined),
  start: z
    .object({
      program: z.union([strArr, str]),
      args: strArr.optional(),
      env: z.record(z.string(), z.string()).optional()
    })
    .optional()
    .catch(undefined),
  saves: strArr.optional().catch(undefined),
  folders: z.record(z.string(), placesSchema.catch([])).optional().catch(undefined),
  games: z
    .array(z.object({ saves: strArr.optional() }).catch({}))
    .optional()
    .catch(undefined)
})
type Profile = z.infer<typeof profileSchema>

/** Windows variables a recomp may not set (RecompLauncher refuses them too). */
const RESERVED_ENV =
  /^(path|pathext|comspec|systemroot|windir|temp|tmp|userprofile|appdata|localappdata|homedrive|homepath)$/i

/**
 * Read the developer's `recomplauncher.json` beside the release (the install folder, or one folder down for a
 * release that keeps its program in bin/). Tolerant: unknown fields are ignored, a broken section is dropped, and a
 * missing, oversized or non-format-1 file gives null so the catalog's description is used instead.
 */
export async function readDeveloperProfile(installDir: string): Promise<DeveloperProfile | null> {
  const file = await findProfile(installDir)
  if (!file) return null
  let raw: unknown
  try {
    const text = await fs.readFile(file, 'utf8')
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  const parsed = profileSchema.safeParse(raw)
  if (!parsed.success) return null
  return await translateProfile(parsed.data, installDir)
}

async function findProfile(installDir: string): Promise<string | null> {
  const isSmallFile = async (p: string): Promise<boolean> => {
    const st = await fs.stat(p).catch(() => null)
    return !!st && st.isFile() && st.size <= MAX_PROFILE_BYTES
  }
  const direct = join(installDir, DEVELOPER_PROFILE)
  if (await isSmallFile(direct)) return direct
  const dirs = await fs.readdir(installDir, { withFileTypes: true }).catch(() => [])
  for (const d of dirs
    .filter((x) => x.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(installDir, d.name, DEVELOPER_PROFILE)
    if (await isSmallFile(p)) return p
  }
  return null
}

function pathTokens(installDir: string): Record<string, string> {
  const home = process.env.USERPROFILE || homedir()
  return {
    '{install}': installDir,
    '{documents}': join(home, 'Documents'),
    '{local}': process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'),
    '{config}': process.env.APPDATA || join(home, 'AppData', 'Roaming'),
    '{home}': home,
    // The pad in use is not known before start; Xbox layout is the common case on Windows.
    '{pad}': 'xbox'
  }
}

function fillTokens(value: string, tokens: Record<string, string>): string {
  let out = value
  for (const [k, v] of Object.entries(tokens)) out = out.split(k).join(v)
  return out
}

/** Where one game file goes, from the start arguments / environment that mention its token. */
interface Delivery {
  how: 'flag' | 'env'
  flag?: string
  env?: string
}

/**
 * Take the arguments carrying `token` out of `args` and say how the file is passed: a lone token is a bare argument,
 * or the value of the flag before it ("--iso", "{game}"); "--game={game}" keeps "--game=" as the flag.
 */
function takeToken(args: string[], env: Record<string, string>, token: string): Delivery | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === token) {
      const prev = i > 0 ? args[i - 1] : null
      if (prev && prev.startsWith('-') && !/\{(game|input:[^}]+)\}/.test(prev)) {
        args.splice(i - 1, 2)
        return { how: 'flag', flag: prev }
      }
      args.splice(i, 1)
      return { how: 'flag', flag: '' }
    }
    const at = a.indexOf(token)
    if (at >= 0) {
      args.splice(i, 1)
      return { how: 'flag', flag: a.slice(0, at) }
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (value.includes(token) && !RESERVED_ENV.test(name)) {
      delete env[name]
      return { how: 'env', env: name }
    }
  }
  return null
}

function extList(exts: string[] | undefined): string[] {
  return [...new Set((exts ?? []).map((e) => '.' + e.replace(/^\./, '').toLowerCase()))]
}

function safeDestination(dest: string): { folder: string; fileName: string } | null {
  const d = dest.replace(/\\/g, '/')
  if (!d || isAbsolute(d) || d.includes(':') || /[{}]/.test(d) || d.endsWith('/')) return null
  if (d.split('/').some((p) => p === '..' || p === '.' || p === '')) return null
  const slash = d.lastIndexOf('/')
  return { folder: slash < 0 ? '' : d.slice(0, slash), fileName: d.slice(slash + 1) }
}

async function translateProfile(p: Profile, installDir: string): Promise<DeveloperProfile> {
  const tokens = pathTokens(installDir)
  const args = [...(p.start?.args ?? [])]
  const env = { ...(p.start?.env ?? {}) }
  const needs: GameFileNeed[] = []

  const deliver = (token: string, need: GameFileNeed): GameFileNeed => {
    const d = takeToken(args, env, token)
    if (!d) return need
    return d.how === 'flag'
      ? { ...need, how: 'flag', flag: d.flag }
      : { ...need, how: 'env', env: d.env }
  }

  if (p.game) {
    const kind = p.game.kind ?? 'iso'
    const accepts = kind === 'folder' ? 'folder' : kind === 'iso' ? 'file' : 'either'
    const nup = typeof p.game.check?.nup_build_id === 'string'
    const ids = Array.isArray(p.game.check?.ids)
      ? (p.game.check.ids as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    const game: GameFileNeed = {
      id: 'game',
      label: tMain('mainRecomp.files.yourGame'),
      description: p.game.label ?? '',
      kind: 'game',
      // Without {game} in the start arguments the recomp finds the copy itself (or reads it from its settings).
      how: 'self',
      accepts,
      formats: kind === 'folder' || nup ? [] : ['.iso'],
      optional: false,
      hashes: (p.game.dumps ?? [])
        .filter((d) => /^[0-9a-f]{8}$/i.test(d.crc32))
        .map((d) => ({ algo: 'crc32' as const, value: d.crc32.toLowerCase() })),
      ...(ids.length > 0 ? { serial: ids[0] } : {})
    }
    needs.push(deliver('{game}', game))
    const up = p.game.update
    if (up) {
      const dest = safeDestination(up.name ? `${up.into}/${up.name}` : `${up.into}/x`)
      if (dest) {
        needs.push({
          id: 'update',
          label: tMain('mainRecomp.files.gameUpdate'),
          description: up.label,
          kind: 'update',
          how: 'folder',
          accepts:
            up.accepts === 'folder'
              ? 'folder'
              : up.accepts === 'file or folder'
                ? 'either'
                : 'file',
          formats: [],
          folder: dest.folder,
          ...(up.name ? { fileName: up.name } : {}),
          optional: up.optional ?? false,
          hashes:
            up.sha256 && /^[0-9a-f]{64}$/i.test(up.sha256)
              ? [{ algo: 'sha256', value: up.sha256.toLowerCase() }]
              : []
        })
      }
    }
  }

  for (const input of p.inputs ?? []) {
    if (!input || input.role === 'runtime' || input.shared === 'nvidia.dlss') continue
    if (needs.some((n) => n.id === input.id)) continue
    const role = input.role ?? 'game'
    const formats = input.formats ?? []
    const takesFile = formats.length === 0 || formats.some((f) => f.type === 'file')
    const takesFolder = formats.some((f) => f.type === 'folder')
    let need: GameFileNeed = {
      id: input.id,
      label: input.label,
      description: input.label,
      kind:
        role === 'game' || role === 'disc'
          ? 'game'
          : role === 'dlc'
            ? 'dlc'
            : role === 'update'
              ? 'update'
              : 'other',
      how: 'self',
      accepts: takesFile && takesFolder ? 'either' : takesFolder ? 'folder' : 'file',
      formats: formats.some((f) => f.type === 'file' && !(f.extensions?.length ?? 0))
        ? []
        : extList(formats.flatMap((f) => f.extensions ?? [])),
      // Shared keys are never optional (RecompLauncher's rule).
      optional: input.shared ? false : (input.optional ?? false),
      hashes: []
    }
    const dest = input.destination ? safeDestination(input.destination) : null
    if (dest) {
      need = { ...need, how: 'folder', folder: dest.folder, fileName: dest.fileName }
      // The arguments name the placed copy; point them at it.
      const placed = join(installDir, dest.folder, dest.fileName)
      for (let i = 0; i < args.length; i++)
        args[i] = args[i].split(`{input:${input.id}}`).join(placed)
      for (const k of Object.keys(env)) env[k] = env[k].split(`{input:${input.id}}`).join(placed)
    } else {
      need = deliver(`{input:${input.id}}`, need)
    }
    needs.push(need)
  }

  // Tokens of inputs this profile does not declare (or that were dropped) cannot be filled: leave those arguments out.
  const unfilled = /\{(game|input:[^}]*)\}/
  const startArgs = args.filter((a) => !unfilled.test(a)).map((a) => fillTokens(a, tokens))
  const startEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (RESERVED_ENV.test(k) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || unfilled.test(v))
      continue
    startEnv[k] = fillTokens(v, tokens)
  }

  let start: DeveloperProfile['start']
  if (p.start) {
    const programs = Array.isArray(p.start.program) ? p.start.program : [p.start.program]
    let program: string | undefined
    for (const prog of programs) {
      const rel = prog.replace(/\\/g, '/')
      if (!rel || isAbsolute(rel) || rel.split('/').includes('..')) continue
      if (
        await fs.stat(join(installDir, rel)).then(
          (s) => s.isFile(),
          () => false
        )
      ) {
        program = rel
        break
      }
    }
    // None exists yet (an .exe-less listing, or Linux names): the first Windows-looking one is the best hint.
    program ??= programs.find((x) => /\.exe$/i.test(x)) ?? undefined
    start = { ...(program ? { program } : {}), args: startArgs, env: startEnv }
  }

  const saves = new Set<string>()
  const addSave = (s: string): void => {
    const t = s.trim()
    if (t) saves.add(t)
  }
  for (const s of p.saves ?? []) addSave(s)
  for (const g of p.games ?? []) for (const s of g.saves ?? []) addSave(s)
  const savePlaces = p.folders?.saves ?? []
  if (savePlaces.length > 0) {
    const chosen = await choosePlace(savePlaces, tokens)
    if (chosen) addSave(chosen)
  }

  return { needs, saves: [...saves], ...(start ? { start } : {}) }
}

/**
 * The first place whose `if` exists, else the first without `if`. Conditions are checked only when they can be
 * resolved (all tokens known); others count as not met.
 */
async function choosePlace(
  places: { path: string; if?: string }[],
  tokens: Record<string, string>
): Promise<string | null> {
  for (const place of places) {
    if (place.if === undefined) return place.path
    const cond = fillTokens(place.if, tokens)
    if (/[{}]/.test(cond) || !isAbsolute(cond)) continue
    if (
      await fs.stat(cond).then(
        () => true,
        () => false
      )
    )
      return place.path
  }
  return null
}

/**
 * An entry's needs with the developer profile of the installed release taken into account: the developer knows
 * their current release best, so the profile's needs replace the catalog's, keeping the catalog's known dumps,
 * region and serial on the game need when the profile has none of its own.
 */
export function mergeProfileNeeds(
  catalog: GameFileNeed[],
  profile: GameFileNeed[]
): GameFileNeed[] {
  if (profile.length === 0) return catalog
  const catGame = catalog.find((n) => n.kind === 'game')
  const firstGame = profile.find((n) => n.kind === 'game')
  return profile.map((n) => {
    if (!catGame || n !== firstGame) return n
    return {
      ...n,
      description: n.description || catGame.description,
      hashes: n.hashes.length > 0 ? n.hashes : catGame.hashes,
      formats: n.formats.length > 0 || n.accepts === 'folder' ? n.formats : catGame.formats,
      ...((n.region ?? catGame.region) ? { region: n.region ?? catGame.region } : {}),
      ...((n.serial ?? catGame.serial) ? { serial: n.serial ?? catGame.serial } : {})
    }
  })
}
