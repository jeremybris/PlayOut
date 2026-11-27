import type { GpuInfo, OptiScalerState } from '@shared/upgrades'
import { createHash } from 'crypto'
import { constants as fsConstants, createReadStream, promises as fs } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { tMain } from '../i18n'

// OptiScaler (github.com/optiscaler/OptiScaler) installed into a PC game so AMD / Intel graphics can use the game's
// DLSS options (FSR / XeSS behind them). This is a TypeScript take on the release's setup_windows.bat
// (docs/research/upgrades/optiscaler.md): the release files are copied next to the game's exe, OptiScaler.dll under a
// proxy name Windows loads (dxgi.dll unless another mod already uses it), and on AMD / Intel the ini gets the
// recommended upscalers. Every file added and every game file replaced (kept as `<file>.playout-original`) is listed in
// `<exeDir>/.playout-optiscaler.json`, so Remove puts the folder back exactly.

/** The GitHub API address of OptiScaler's newest stable release. */
export const OPTISCALER_RELEASE_API =
  'https://api.github.com/repos/optiscaler/OptiScaler/releases/latest'

/** Where OptiScaler's release files may be downloaded from (its own GitHub releases). */
const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/optiscaler/OptiScaler/releases/download/'

/** The release archive's name ("Optiscaler_0.9.5-final.20261116.7z"; the suffix changes between releases). */
const ASSET_PATTERN = /^Optiscaler_.*\.7z$/i

/** The manifest PlayOut writes beside the proxy file. */
export const OPTISCALER_MANIFEST = '.playout-optiscaler.json'

/** Suffix of a game file PlayOut replaced and keeps to put back. */
export const BACKUP_SUFFIX = '.playout-original'

/**
 * File names Windows loads OptiScaler under, best first: dxgi.dll is the most compatible; the others are used when a
 * name is taken by another mod (ReShade, Special K, …). OptiScaler.asi is left out (it needs an ASI loader).
 */
export const PROXY_NAMES: readonly string[] = [
  'dxgi.dll',
  'winmm.dll',
  'version.dll',
  'dbghelp.dll',
  'd3d12.dll',
  'wininet.dll',
  'winhttp.dll'
]

/** Release files never copied into the game (the setup scripts and the readme). */
const SKIPPED_PACKAGE_FILES = /^(setup_windows\.bat|setup_linux\.sh|!!.*\.txt|\.playout-complete)$/i

/** Release files only AMD / Intel need (NVIDIA's own nvapi and DLSS frame generation are used there). */
const NON_NVIDIA_FILES = new Set([
  'fakenvapi.dll',
  'fakenvapi.ini',
  'dlssg_to_fsr3_amd_is_better.dll'
])

/** Files OptiScaler and its helpers create while the game runs (removed with it unless they were there before). */
const RUNTIME_FILES = ['OptiScaler.log', 'fakenvapi.log', 'dlssg_to_fsr3.log', 'DlssOverrides']

/** Signs of an OptiScaler someone installed by hand (setup_windows.bat leaves these). */
const MANUAL_INSTALL_FILES = [
  'OptiScaler.ini',
  'OptiScaler.asi',
  'Remove OptiScaler.bat',
  'Remove_OptiScaler.bat'
]

/** Names an older OptiScaler was installed under by hand (checked for OptiScaler's own dll). */
const OLD_OPTISCALER_NAMES = ['nvngx.dll', 'nvapi64.dll']

/** Settings files OptiScaler and fakenvapi rewrite themselves, so they are always PlayOut's to remove. */
const SETTINGS_FILES = /^(optiscaler\.ini|fakenvapi\.ini)$/i

/** Folder inside the game's exe folder where an update keeps the previous install until the new one is in. */
const PREVIOUS_DIR = '.playout-optiscaler-previous'

/** Marker written into a fully extracted cached release. */
const COMPLETE_MARKER = '.playout-complete'

/** Who must have signed the vendor dlls in the release (Authenticode subject, and company name when needed). */
export function releaseDllSigner(name: string): { signer: string; companyName?: string } | null {
  if (/^amd_fidelityfx_.*\.dll$/i.test(name)) return { signer: 'Advanced Micro Devices, Inc.' }
  if (/^libxell\.dll$/i.test(name))
    return {
      signer: 'Microsoft Windows Hardware Compatibility Publisher',
      companyName: 'Intel Corporation'
    }
  if (/^libxess.*\.dll$/i.test(name)) return { signer: 'Intel Corporation' }
  return null
}

/** Cache work (download, extract, clean up) runs one at a time across every game. */
let cacheQueue: Promise<unknown> = Promise.resolve()

/** Cached release folders an install is copying from right now (lower case), with how many installs use each. */
const packagesInUse = new Map<string, number>()

/** A path's key for comparing (Windows paths are not case sensitive). */
function pathKey(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

/** Whether `child` is `parent` or inside it. */
export function isInsideDir(parent: string, child: string): boolean {
  const rel = relative(pathKey(parent), pathKey(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const MAX_DEPTH = 8
const MAX_ENTRIES = 50_000
/** Folders that hold installers and redistributables, never the game. */
const SKIP_DIRS =
  /^(_commonredist|__installer|redist|redistributables?|directx|vcredist|dotnet|support|\$recycle\.bin|playout co-op)$/i
/** Exes that are not the game itself. */
const NOT_GAME_EXE =
  /(launch|crash|report|unins|setup|install|redist|prereq|updater|patcher|helper|easyanticheat|battleye|^eac|be_service|cefprocess|webhelper|dxsetup|vc_?redist|dotnet|benchmark|config|settings)/i
/** Unreal's real game exe ("Sandfall-Win64-Shipping.exe"). */
const UNREAL_SHIPPING = /-(Win64|WinGDK)-Shipping\.exe$/i

/** The file operations the install, scan and removal use (tests may fake them). */
export interface OptiScalerIo {
  /** Entries of a folder; links (symbolic links, junctions) are reported so they can be skipped. */
  readdir(dir: string): Promise<{ name: string; isDirectory: boolean; isLink: boolean }[]>
  /** Size and kind of a path, null when it does not exist. */
  stat(path: string): Promise<{ size: number; isDirectory: boolean } | null>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: string | Buffer): Promise<void>
  /** Copies a file; fails when the destination exists. */
  copyFile(from: string, to: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Deletes a file; a missing file is not an error. */
  unlink(path: string): Promise<void>
  /** Deletes a file or folder with everything in it; missing is not an error. */
  removeTree(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  /** Deletes a folder only when it is empty; never fails. */
  rmdirIfEmpty(path: string): Promise<void>
  /** The SHA-256 of a file's content (lower-case hex). */
  sha256(path: string): Promise<string>
}

/** The real file operations. */
export const nodeOptiScalerIo: OptiScalerIo = {
  async readdir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isLink: e.isSymbolicLink()
    }))
  },
  async stat(path) {
    try {
      const s = await fs.lstat(path)
      return { size: s.size, isDirectory: s.isDirectory() }
    } catch {
      return null
    }
  },
  readFile: (path) => fs.readFile(path),
  writeFile: (path, data) => fs.writeFile(path, data),
  copyFile: (from, to) => fs.copyFile(from, to, fsConstants.COPYFILE_EXCL),
  rename: (from, to) => fs.rename(from, to),
  async unlink(path) {
    await fs.rm(path, { force: true })
  },
  async removeTree(path) {
    await fs.rm(path, { recursive: true, force: true })
  },
  async mkdir(path) {
    await fs.mkdir(path, { recursive: true })
  },
  async rmdirIfEmpty(path) {
    await fs.rmdir(path).catch(() => undefined)
  },
  sha256(path) {
    return new Promise((done, fail) => {
      const hash = createHash('sha256')
      createReadStream(path)
        .on('error', fail)
        .on('data', (chunk) => hash.update(chunk))
        .on('end', () => done(hash.digest('hex')))
    })
  }
}

/** A downloadable OptiScaler release. */
export interface OptiScalerRelease {
  /** "0.9.5" */
  version: string
  url: string
  size: number
  /** From GitHub's asset digest, when it gives one. */
  sha256: string | null
  fileName: string
}

/** What PlayOut wrote into a game folder (the manifest), paths relative to that folder with forward slashes. */
export interface OptiScalerManifest {
  tool: 'OptiScaler'
  version: string
  /** The file name OptiScaler.dll was copied as ("dxgi.dll"). */
  asName: string
  gpuVendor: GpuInfo['vendor']
  /** Files that did not exist before (deleted on removal). */
  added: string[]
  /** Game files replaced; each original is kept as `<file>.playout-original` and put back on removal. */
  replaced: string[]
  /** Game files left alone because a `.playout-original` of them already existed (another upgrade's backup). */
  kept: string[]
  /** Folders created (deleted on removal when empty). */
  dirs: string[]
  /** Files OptiScaler may create while running that were not there before (deleted on removal). */
  runtime: string[]
  /**
   * Size and SHA-256 of every file PlayOut wrote, by path. On removal a file that no longer matches (a game update or
   * a file check put the game's own copy there) is left alone. Missing in manifests from before this was recorded.
   */
  files: Record<string, { size: number; sha256: string }>
}

interface GithubRelease {
  tag_name?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }[]
}

/**
 * The newest stable OptiScaler release and its .7z archive, from its GitHub releases. null when the answer has no
 * usable archive (or is a nightly / prerelease). Network errors are thrown.
 */
export async function latestOptiScaler(deps: {
  fetchJson: (url: string) => Promise<unknown>
}): Promise<OptiScalerRelease | null> {
  const release = (await deps.fetchJson(OPTISCALER_RELEASE_API)) as GithubRelease | null
  if (!release || typeof release !== 'object') return null
  if (release.draft === true || release.prerelease === true) return null
  const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : ''
  if (!tag || /nightly/i.test(tag)) return null
  const version = tag.replace(/^v/i, '')
  if (!/^[\w.-]+$/.test(version)) return null
  const asset = (Array.isArray(release.assets) ? release.assets : []).find(
    (a) =>
      typeof a?.name === 'string' &&
      ASSET_PATTERN.test(a.name) &&
      typeof a.browser_download_url === 'string' &&
      a.browser_download_url.startsWith(RELEASE_DOWNLOAD_PREFIX)
  )
  if (!asset) return null
  const digest = typeof asset.digest === 'string' ? asset.digest.trim().toLowerCase() : ''
  const sha = /^sha256:([0-9a-f]{64})$/.exec(digest)
  return {
    version,
    url: asset.browser_download_url as string,
    size: typeof asset.size === 'number' && asset.size > 0 ? asset.size : 0,
    sha256: sha ? sha[1] : null,
    fileName: asset.name as string
  }
}

/** The folder a cached release is extracted to. */
function cachedReleaseDir(cacheDir: string, version: string): string {
  return join(cacheDir, `OptiScaler-${version.replace(/[^\w.-]/g, '_')}`)
}

/** Whether a path exists (real file system). */
async function pathExists(path: string): Promise<boolean> {
  return fs.access(path).then(
    () => true,
    () => false
  )
}

/** What ensureOptiScaler needs from outside. */
export interface EnsureOptiScalerDeps {
  /** Downloads a file into `dir`, checking its size and sha256 (when given); returns the saved path. */
  download: (
    file: { url: string; fileName: string; size: number; sha256: string | null },
    dir: string
  ) => Promise<string>
  extract7z: (archive: string, destDir: string) => Promise<void>
  /**
   * True when the file's Authenticode signature is valid and signed by `expectedSigner` (and `companyName`), the same
   * check the vendor dll swap uses. When left out, the AMD / Intel dlls in the release are not signer-checked.
   */
  verifySigner?: (path: string, expectedSigner: string, companyName?: string) => Promise<boolean>
}

/**
 * The release's files, downloaded (checked against its size and sha256 by `deps.download`) and extracted into
 * `<cacheDir>/OptiScaler-<version>`, reused when already there. A release GitHub gives no sha256 for is refused
 * unless `options.allowUnverified` is set (after the user agreed to a warning). The AMD and Intel dlls in it must pass
 * `deps.verifySigner` before the release is kept. Older cached versions are deleted, except one an install is copying
 * from. Calls run one at a time. Returns the folder holding OptiScaler.dll.
 */
export function ensureOptiScaler(
  release: OptiScalerRelease,
  cacheDir: string,
  deps: EnsureOptiScalerDeps,
  options: { allowUnverified?: boolean } = {}
): Promise<string> {
  const run = cacheQueue.then(
    () => ensureNow(release, cacheDir, deps, options),
    () => ensureNow(release, cacheDir, deps, options)
  )
  cacheQueue = run.catch(() => undefined)
  return run
}

async function ensureNow(
  release: OptiScalerRelease,
  cacheDir: string,
  deps: EnsureOptiScalerDeps,
  options: { allowUnverified?: boolean }
): Promise<string> {
  if (!release.url.startsWith(RELEASE_DOWNLOAD_PREFIX))
    throw new Error(tMain('mainUpgrades.opti.onlyGithub'))
  const dir = cachedReleaseDir(cacheDir, release.version)
  if (
    (await pathExists(join(dir, COMPLETE_MARKER))) &&
    (await pathExists(join(dir, 'OptiScaler.dll')))
  )
    return dir
  if (!release.sha256 && !options.allowUnverified)
    throw new Error(tMain('mainUpgrades.opti.noChecksum'))
  await fs.mkdir(cacheDir, { recursive: true })
  const staging = `${dir}.part`
  await fs.rm(staging, { recursive: true, force: true })
  const archive = await deps.download(
    { url: release.url, fileName: release.fileName, size: release.size, sha256: release.sha256 },
    cacheDir
  )
  try {
    await deps.extract7z(archive, staging)
    let root = staging
    if (!(await pathExists(join(root, 'OptiScaler.dll')))) {
      // A release wrapped in one folder: use it.
      const entries = await fs.readdir(staging, { withFileTypes: true })
      const only = entries.length === 1 && entries[0].isDirectory() ? entries[0].name : null
      if (only && (await pathExists(join(staging, only, 'OptiScaler.dll'))))
        root = join(staging, only)
    }
    if (await pathExists(join(root, 'OptiScaler.sln')))
      throw new Error(tMain('mainUpgrades.opti.sourceCode'))
    if (!(await pathExists(join(root, 'OptiScaler.dll'))))
      throw new Error(tMain('mainUpgrades.opti.noDll'))
    if (!(await pathExists(join(root, 'OptiScaler.ini'))))
      throw new Error(tMain('mainUpgrades.opti.noIni'))
    if (deps.verifySigner)
      for (const e of await fs.readdir(root, { withFileTypes: true })) {
        const pin = e.isFile() ? releaseDllSigner(e.name) : null
        if (pin && !(await deps.verifySigner(join(root, e.name), pin.signer, pin.companyName)))
          throw new Error(
            tMain('mainUpgrades.opti.notSigned', { file: e.name, signer: pin.signer })
          )
      }
    await fs.writeFile(join(root, COMPLETE_MARKER), release.version)
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rename(root, dir)
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
    await fs.rm(archive, { force: true })
  }
  // Older cached releases are no longer needed (games keep their own copies), unless an install is copying from one.
  // Cache work runs one at a time, so a leftover ".part" folder is from a run that was cut short.
  for (const e of await fs.readdir(cacheDir, { withFileTypes: true })) {
    const path = join(cacheDir, e.name)
    if (
      e.isDirectory() &&
      /^OptiScaler-/i.test(e.name) &&
      pathKey(path) !== pathKey(dir) &&
      !packagesInUse.has(pathKey(path))
    )
      await fs.rm(path, { recursive: true, force: true })
  }
  return dir
}

/** Whether a path is inside a Microsoft Store WindowsApps folder (Windows does not let programs change those). */
export function isProtectedPath(path: string): boolean {
  return /(^|[\\/])WindowsApps([\\/]|$)/i.test(path)
}

/**
 * Walks `root` breadth first (shallowest first), never following links, skipping WindowsApps, capped at depth 8 and
 * a number of entries. `visit` gets each file with its depth (0: in `root`); `enterDir` can skip a folder.
 */
async function walk(
  root: string,
  io: Pick<OptiScalerIo, 'readdir'>,
  visit: (path: string, name: string, depth: number) => void | Promise<void>,
  enterDir: (name: string) => boolean = () => true,
  maxDepth = MAX_DEPTH
): Promise<void> {
  let queue = [root]
  let seen = 0
  for (let depth = 0; depth <= maxDepth && queue.length; depth++) {
    const next: string[] = []
    for (const dir of queue) {
      let entries: { name: string; isDirectory: boolean; isLink: boolean }[]
      try {
        entries = await io.readdir(dir)
      } catch {
        continue
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const e of entries) {
        if (++seen > MAX_ENTRIES) return
        if (e.isLink) continue
        const path = join(dir, e.name)
        if (e.isDirectory) {
          if (!/^WindowsApps$/i.test(e.name) && enterDir(e.name)) next.push(path)
        } else await visit(path, e.name, depth)
      }
    }
    queue = next
  }
}

/**
 * Unreal's real game exe (`*-Win64-Shipping.exe`, or WinGDK, the Store build) in a game's folder, never one under the
 * Engine folder: Win64 before WinGDK, then the one in a Binaries folder, then the shallowest. null when there is none
 * or the game is in a protected folder (WindowsApps).
 */
export async function pickShippingExe(
  installDir: string,
  io: Pick<OptiScalerIo, 'readdir'> = nodeOptiScalerIo
): Promise<string | null> {
  if (isProtectedPath(installDir)) return null
  const shipping: { path: string; depth: number }[] = []
  await walk(
    installDir,
    io,
    (path, name, depth) => {
      if (UNREAL_SHIPPING.test(name)) shipping.push({ path, depth })
    },
    (name) => !SKIP_DIRS.test(name) && !/^Engine$/i.test(name)
  )
  if (!shipping.length) return null
  const score = (p: string): number =>
    (/-Win64-Shipping\.exe$/i.test(p) ? 0 : 2) +
    (/[\\/]Binaries[\\/](Win64|WinGDK)$/i.test(dirname(p)) ? 0 : 1)
  shipping.sort((a, b) => score(a.path) - score(b.path) || a.depth - b.depth)
  return shipping[0].path
}

/** Whether an exe's file name is a launcher, crash reporter, installer or other program that is not the game. */
export function isNotGameExe(name: string): boolean {
  return NOT_GAME_EXE.test(name)
}

/**
 * The folder OptiScaler goes into: the folder of Unreal's `*-Win64-Shipping.exe` (or WinGDK, the Store build) under
 * Binaries, never one under the Engine folder; else the folder of the game's known exe (`exePath`) when it is not a
 * launcher; else the folder of the largest exe near the top of the install folder that is not a launcher, crash
 * reporter or installer. null when there is none or the game is in a protected folder (WindowsApps).
 */
export async function pickExeDir(
  installDir: string,
  exePath?: string,
  io: OptiScalerIo = nodeOptiScalerIo
): Promise<string | null> {
  if (isProtectedPath(installDir)) return null
  const shipping = await pickShippingExe(installDir, io)
  if (shipping) return dirname(shipping)
  // The known exe only counts inside the game's folder (not a shared launcher or runtime folder elsewhere).
  if (
    exePath &&
    isInsideDir(installDir, exePath) &&
    !isProtectedPath(exePath) &&
    !NOT_GAME_EXE.test(basename(exePath)) &&
    (await io.stat(exePath))?.isDirectory === false
  )
    return dirname(exePath)
  let best: { path: string; size: number; depth: number } | null = null
  await walk(
    installDir,
    io,
    async (path, name, depth) => {
      if (!/\.exe$/i.test(name) || NOT_GAME_EXE.test(name)) return
      const size = (await io.stat(path))?.size ?? 0
      if (!best || size > best.size || (size === best.size && depth < best.depth))
        best = { path, size, depth }
    },
    (name) => !SKIP_DIRS.test(name),
    3
  )
  return best ? dirname((best as { path: string }).path) : null
}

/**
 * The OriginalFilename a Windows program file's version information gives ("OptiScaler.dll"), null when it has
 * none. This is how OptiScaler's own renamed dll is told from another mod's dxgi.dll.
 */
export function readOriginalFilename(buf: Buffer): string | null {
  const key = Buffer.from('OriginalFilename\0', 'utf16le')
  const at = buf.indexOf(key)
  // A version String block: wLength, wValueLength (in characters), wType, then the key.
  if (at < 6) return null
  const valueChars = buf.readUInt16LE(at - 4)
  if (!valueChars) return null
  let p = at + key.length
  if ((p - (at - 6)) % 4 !== 0) p += 2 // padding to a 32-bit boundary
  let end = p
  const limit = Math.min(buf.length - 1, p + valueChars * 2)
  while (end < limit && buf.readUInt16LE(end) !== 0) end += 2
  return end > p ? buf.toString('utf16le', p, end) : null
}

/** Whether a dll is OptiScaler under another name. */
async function isOptiScalerDll(path: string, io: OptiScalerIo): Promise<boolean> {
  const s = await io.stat(path)
  if (!s || s.isDirectory || s.size > 128 * 1024 * 1024) return false
  try {
    return readOriginalFilename(await io.readFile(path))?.toLowerCase() === 'optiscaler.dll'
  } catch {
    return false
  }
}

/**
 * `text` (an ini file) with `key` in `[section]` set to `value`, edited in place (comments, order and line endings
 * kept). A missing key is added at the end of its section, a missing section at the end of the file.
 */
export function setIniValue(text: string, section: string, key: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const header = /^\s*\[([^\]]+)\]\s*$/
  const keyLine = new RegExp(`^(\\s*)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*)=`, 'i')
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const m = header.exec(lines[i])
    if (!m) continue
    if (start >= 0) {
      end = i
      break
    }
    if (m[1].trim().toLowerCase() === section.toLowerCase()) start = i
  }
  if (start < 0) {
    const tail = lines.length && lines[lines.length - 1] === '' ? lines.pop() : undefined
    lines.push(`[${section}]`, `${key}=${value}`)
    if (tail !== undefined) lines.push(tail)
    return lines.join(eol)
  }
  for (let i = start + 1; i < end; i++) {
    const m = keyLine.exec(lines[i])
    if (m) {
      lines[i] = `${m[1]}${key}=${value}`
      return lines.join(eol)
    }
  }
  let insert = end
  while (insert > start + 1 && lines[insert - 1].trim() === '') insert--
  lines.splice(insert, 0, `${key}=${value}`)
  return lines.join(eol)
}

/** The ini settings PlayOut writes for a graphics card maker (none for NVIDIA: its defaults are right). */
export function iniEditsFor(
  vendor: GpuInfo['vendor']
): { section: string; key: string; value: string }[] {
  switch (vendor) {
    case 'amd':
      // FSR 3.1 (FSR 4 on cards that have it) instead of XeSS / FSR 2.2.
      return [
        { section: 'Upscalers', key: 'Dx12Upscaler', value: 'fsr31' },
        { section: 'Upscalers', key: 'Dx11Upscaler', value: 'fsr31_12' },
        { section: 'Upscalers', key: 'VulkanUpscaler', value: 'fsr31_12' }
      ]
    case 'intel':
      return [{ section: 'Upscalers', key: 'Dx12Upscaler', value: 'xess' }]
    default:
      return []
  }
}

/**
 * `newText` (a new release's ini) with the values the user had in `oldText` (the previous ini) carried over, for every
 * key the new ini still has in the same section. Comments, order, new keys and line endings of `newText` are kept;
 * keys the new release dropped are not brought back. Keys in `except` keep the new release's value.
 */
export function carryIniValues(
  newText: string,
  oldText: string,
  except: readonly { section: string; key: string }[] = []
): string {
  const skipped = new Set(except.map((e) => `${e.section.toLowerCase()}\n${e.key.toLowerCase()}`))
  const header = /^\s*\[([^\]]+)\]\s*$/
  const entry = /^(\s*)([^;#=\s][^=]*?)(\s*)=(.*)$/
  const old = new Map<string, string>()
  let section = ''
  for (const line of oldText.split(/\r?\n/)) {
    const h = header.exec(line)
    if (h) section = h[1].trim().toLowerCase()
    else {
      const m = entry.exec(line)
      const id = m ? `${section}\n${m[2].toLowerCase()}` : ''
      if (m && !skipped.has(id)) old.set(id, m[4])
    }
  }
  const eol = newText.includes('\r\n') ? '\r\n' : '\n'
  section = ''
  return newText
    .split(/\r?\n/)
    .map((line) => {
      const h = header.exec(line)
      if (h) {
        section = h[1].trim().toLowerCase()
        return line
      }
      const m = entry.exec(line)
      if (!m) return line
      const value = old.get(`${section}\n${m[2].toLowerCase()}`)
      return value === undefined || value === m[4] ? line : `${m[1]}${m[2]}${m[3]}=${value}`
    })
    .join(eol)
}

/** Every file under `dir`, relative with forward slashes (never following links). */
async function listFiles(dir: string, io: OptiScalerIo): Promise<string[]> {
  const files: string[] = []
  await walk(dir, io, (path) => {
    files.push(relative(dir, path).split(sep).join('/'))
  })
  return files
}

/** A manifest path as a real path inside `exeDir`. */
function inDir(exeDir: string, rel: string): string {
  return join(exeDir, ...rel.split('/'))
}

/** Reads and checks a manifest; null when missing or not PlayOut's. */
async function readManifest(path: string, io: OptiScalerIo): Promise<OptiScalerManifest | null> {
  try {
    const m = JSON.parse((await io.readFile(path)).toString('utf8')) as Partial<OptiScalerManifest>
    const list = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((s): s is string => typeof s === 'string' && isSafeRelative(s))
        : []
    if (m?.tool !== 'OptiScaler' || typeof m.asName !== 'string' || typeof m.version !== 'string')
      return null
    const files: OptiScalerManifest['files'] = {}
    if (m.files && typeof m.files === 'object')
      for (const [rel, f] of Object.entries(m.files as Record<string, unknown>)) {
        const r = f as { size?: unknown; sha256?: unknown } | null
        if (
          isSafeRelative(rel) &&
          typeof r?.size === 'number' &&
          typeof r.sha256 === 'string' &&
          /^[0-9a-f]{64}$/.test(r.sha256)
        )
          files[rel] = { size: r.size, sha256: r.sha256 }
      }
    return {
      tool: 'OptiScaler',
      version: m.version,
      asName: m.asName,
      gpuVendor: m.gpuVendor ?? 'other',
      added: list(m.added),
      replaced: list(m.replaced),
      kept: list(m.kept),
      dirs: list(m.dirs),
      runtime: list(m.runtime),
      files
    }
  } catch {
    return null
  }
}

/** A manifest path that stays inside its folder. */
function isSafeRelative(rel: string): boolean {
  return (
    rel.length > 0 &&
    !/^[\\/]|^[a-z]:/i.test(rel) &&
    !rel.split(/[\\/]/).some((p) => p === '..' || p === '')
  )
}

/**
 * Whether a file PlayOut wrote is still the one it wrote: 'ours', 'missing', or 'changed' when something else (a game
 * update, a file check in the store's app) has put another file there since. The settings files OptiScaler rewrites
 * itself, and files from manifests without sizes and hashes, count as 'ours'.
 */
async function writtenState(
  exeDir: string,
  m: OptiScalerManifest,
  rel: string,
  io: OptiScalerIo
): Promise<'ours' | 'missing' | 'changed'> {
  const path = inDir(exeDir, rel)
  const s = await io.stat(path)
  if (!s) return 'missing'
  if (s.isDirectory) return 'changed'
  const written = m.files[rel]
  if (!written || (!rel.includes('/') && SETTINGS_FILES.test(rel))) return 'ours'
  if (s.size !== written.size) return 'changed'
  return (await io.sha256(path)) === written.sha256 ? 'ours' : 'changed'
}

/**
 * Puts a folder back as the manifest says it was (tolerates a half-done install). A file that changed since PlayOut
 * wrote it is left as it is (for a replaced one, the out-of-date backup is deleted); those are returned.
 */
async function undo(exeDir: string, m: OptiScalerManifest, io: OptiScalerIo): Promise<string[]> {
  const changed: string[] = []
  for (const rel of [...m.added].reverse()) {
    const state = await writtenState(exeDir, m, rel, io)
    if (state === 'ours') await io.unlink(inDir(exeDir, rel))
    else if (state === 'changed') changed.push(rel)
  }
  for (const rel of m.replaced) {
    const original = inDir(exeDir, rel)
    const backup = original + BACKUP_SUFFIX
    // Only when the backup is there: otherwise the file in place is still the game's own.
    if (!(await io.stat(backup))) continue
    if ((await writtenState(exeDir, m, rel, io)) === 'changed') {
      // The game has a newer copy of its own there now: keep it; the backup is out of date.
      changed.push(rel)
      await io.unlink(backup)
    } else {
      await io.unlink(original)
      await io.rename(backup, original)
    }
  }
  for (const rel of m.runtime) await io.removeTree(inDir(exeDir, rel))
  const dirs = [...m.dirs].sort((a, b) => b.split('/').length - a.split('/').length)
  for (const rel of dirs) await io.rmdirIfEmpty(inDir(exeDir, rel))
  await io.unlink(join(exeDir, OPTISCALER_MANIFEST))
  return changed
}

/** An earlier PlayOut install set aside during an update, so it can be put back when the update fails. */
interface PreviousInstall {
  manifest: OptiScalerManifest
  /** The manifest file as it was. */
  manifestData: Buffer
  /**
   * What was done to each file: an added file moved into PREVIOUS_DIR, or a replaced game file put back from its
   * backup (`moved` when OptiScaler's copy of it went into PREVIOUS_DIR).
   */
  held: { rel: string; kind: 'added' | 'replaced'; moved: boolean }[]
  /** The user's OptiScaler.ini, null when there was none. */
  ini: string | null
}

/**
 * Takes an earlier PlayOut install out of the way without losing it: its files go into PREVIOUS_DIR and the game files
 * it replaced are put back. Files that changed since it wrote them stay (they are the game's now).
 */
async function setAside(exeDir: string, prev: PreviousInstall, io: OptiScalerIo): Promise<void> {
  const m = prev.manifest
  const hold = join(exeDir, PREVIOUS_DIR)
  await io.removeTree(hold)
  const iniRel = m.added.find((r) => r.toLowerCase() === 'optiscaler.ini')
  if (iniRel && (await io.stat(inDir(exeDir, iniRel)))?.isDirectory === false)
    prev.ini = (await io.readFile(inDir(exeDir, iniRel))).toString('utf8')
  const moveAside = async (rel: string): Promise<void> => {
    const to = inDir(hold, rel)
    await io.mkdir(dirname(to))
    await io.rename(inDir(exeDir, rel), to)
  }
  for (const rel of m.added)
    if ((await writtenState(exeDir, m, rel, io)) === 'ours') {
      await moveAside(rel)
      prev.held.push({ rel, kind: 'added', moved: true })
    }
  for (const rel of m.replaced) {
    const original = inDir(exeDir, rel)
    const backup = original + BACKUP_SUFFIX
    if (!(await io.stat(backup))) continue
    const state = await writtenState(exeDir, m, rel, io)
    if (state === 'changed') {
      await io.unlink(backup)
      continue
    }
    const moved = state === 'ours'
    if (moved) await moveAside(rel)
    prev.held.push({ rel, kind: 'replaced', moved })
    await io.rename(backup, original)
  }
}

/** Puts back an install setAside took out of the way. */
async function restorePrevious(
  exeDir: string,
  prev: PreviousInstall,
  io: OptiScalerIo
): Promise<void> {
  const hold = join(exeDir, PREVIOUS_DIR)
  for (const h of [...prev.held].reverse()) {
    const path = inDir(exeDir, h.rel)
    if (h.kind === 'replaced' && (await io.stat(path)) && !(await io.stat(path + BACKUP_SUFFIX)))
      await io.rename(path, path + BACKUP_SUFFIX)
    if (h.moved) {
      await io.mkdir(dirname(path))
      await io.rename(inDir(hold, h.rel), path)
    }
  }
  await io.writeFile(join(exeDir, OPTISCALER_MANIFEST), prev.manifestData)
  await io.removeTree(hold)
}

/** A list with `more` added, leaving out names it already has (not case sensitive). */
function withMore(list: string[], more: string[]): string[] {
  const out = [...list]
  for (const s of more) if (!out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s)
  return out
}

/**
 * Installs OptiScaler from an extracted release (`packageDir`) into `exeDir`. A previous PlayOut install there is
 * updated: it is set aside first and put back when the update fails, and the user's OptiScaler.ini settings are carried
 * into the new release's ini. OptiScaler.dll is copied as dxgi.dll, or the next free name in PROXY_NAMES when another
 * mod uses it (never overwritten). Game files the release would replace are kept as `<file>.playout-original`. On
 * AMD / Intel the ini gets their upscalers (iniEditsFor; spoofing stays on its "auto", which is on for them) and the
 * fake nvapi and DLSS frame generation files are added; on NVIDIA those are left out and the ini is untouched.
 * Writes the manifest `<exeDir>/.playout-optiscaler.json` with the size and SHA-256 of every file written; a failure
 * puts the folder back and throws. `exeDir` must be inside `options.installDir` when that is given; `relDir` is
 * `exeDir` relative to it ("" for the same folder, and when it is not given).
 */
export async function installOptiScaler(
  exeDir: string,
  packageDir: string,
  options: { gpuVendor: GpuInfo['vendor']; version: string; installDir?: string },
  io: OptiScalerIo = nodeOptiScalerIo
): Promise<{ relDir: string; asName: string; version: string }> {
  if (isProtectedPath(exeDir)) throw new Error(tMain('mainUpgrades.opti.protected'))
  if (options.installDir !== undefined && !isInsideDir(options.installDir, exeDir))
    throw new Error(tMain('mainUpgrades.opti.outsideGame', { folder: exeDir }))
  // The cached release is not cleaned up while it is copied from.
  const key = pathKey(packageDir)
  packagesInUse.set(key, (packagesInUse.get(key) ?? 0) + 1)
  try {
    const asName = await installNow(exeDir, packageDir, options, io)
    const relDir = options.installDir !== undefined ? relative(options.installDir, exeDir) : ''
    return { relDir, asName, version: options.version }
  } finally {
    const left = (packagesInUse.get(key) ?? 1) - 1
    if (left > 0) packagesInUse.set(key, left)
    else packagesInUse.delete(key)
  }
}

/** installOptiScaler's work; returns the name OptiScaler.dll was copied as. */
async function installNow(
  exeDir: string,
  packageDir: string,
  options: { gpuVendor: GpuInfo['vendor']; version: string },
  io: OptiScalerIo
): Promise<string> {
  if (!(await io.stat(exeDir))?.isDirectory)
    throw new Error(tMain('mainUpgrades.opti.folderMissing', { folder: exeDir }))
  if (await io.stat(join(packageDir, 'OptiScaler.sln')))
    throw new Error(tMain('mainUpgrades.opti.sourceCode'))
  if (!(await io.stat(join(packageDir, 'OptiScaler.dll'))))
    throw new Error(tMain('mainUpgrades.opti.noDll'))

  // An earlier PlayOut install is updated; one made by hand is not touched.
  const manifestPath = join(exeDir, OPTISCALER_MANIFEST)
  let prev: PreviousInstall | null = null
  if (await io.stat(manifestPath)) {
    const manifest = await readManifest(manifestPath, io)
    if (!manifest)
      throw new Error(
        tMain('mainUpgrades.opti.manifestUnreadable', { file: OPTISCALER_MANIFEST, folder: exeDir })
      )
    prev = { manifest, manifestData: await io.readFile(manifestPath), held: [], ini: null }
  }

  let m: OptiScalerManifest | null = null
  try {
    if (prev) await setAside(exeDir, prev, io)

    for (const name of MANUAL_INSTALL_FILES)
      if (await io.stat(join(exeDir, name)))
        throw new Error(tMain('mainUpgrades.opti.byHand', { name }))
    for (const name of [...PROXY_NAMES, ...OLD_OPTISCALER_NAMES])
      if (await isOptiScalerDll(join(exeDir, name), io))
        throw new Error(tMain('mainUpgrades.opti.byHand', { name }))

    let asName: string | null = null
    for (const name of PROXY_NAMES)
      if (!(await io.stat(join(exeDir, name)))) {
        asName = name
        break
      }
    if (!asName)
      throw new Error(tMain('mainUpgrades.opti.namesTaken', { names: PROXY_NAMES.join(', ') }))

    const nvidia = options.gpuVendor === 'nvidia'
    const sources = (await listFiles(packageDir, io)).filter((rel) => {
      const name = rel.split('/').pop()!
      if (!rel.includes('/') && SKIPPED_PACKAGE_FILES.test(name)) return false
      if (nvidia && !rel.includes('/') && NON_NVIDIA_FILES.has(name.toLowerCase())) return false
      return true
    })

    // Plan every change before making any, so the manifest lists all of them.
    const plan: OptiScalerManifest = {
      tool: 'OptiScaler',
      version: options.version,
      asName,
      gpuVendor: options.gpuVendor,
      added: [],
      replaced: [],
      kept: [],
      dirs: [],
      runtime: [],
      files: {}
    }
    const copies: { from: string; to: string; rel: string; replace: boolean }[] = []
    const dirSet = new Set<string>()
    for (const rel of sources) {
      const target = rel.toLowerCase() === 'optiscaler.dll' ? asName : rel
      const parts = target.split('/')
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/')
        if (!dirSet.has(d.toLowerCase())) {
          dirSet.add(d.toLowerCase())
          if (!(await io.stat(inDir(exeDir, d)))) plan.dirs.push(d)
        }
      }
      const to = inDir(exeDir, target)
      const existing = await io.stat(to)
      if (existing?.isDirectory) {
        plan.kept.push(target)
        continue
      }
      if (existing) {
        if (await io.stat(to + BACKUP_SUFFIX)) {
          plan.kept.push(target)
          continue
        }
        plan.replaced.push(target)
      } else plan.added.push(target)
      copies.push({ from: inDir(packageDir, rel), to, rel: target, replace: !!existing })
    }
    for (const name of RUNTIME_FILES)
      if (!(await io.stat(join(exeDir, name)))) plan.runtime.push(name)
    if (prev) {
      // Folders and logs of the earlier install still belong to OptiScaler; the set-aside folder goes after a crash.
      plan.dirs = withMore(plan.dirs, prev.manifest.dirs)
      plan.runtime = withMore(plan.runtime, [...prev.manifest.runtime, PREVIOUS_DIR])
    }

    m = plan
    await io.writeFile(manifestPath, JSON.stringify(m, null, 2))
    for (const d of m.dirs) await io.mkdir(inDir(exeDir, d))
    for (const c of copies) {
      if (c.replace) await io.rename(c.to, c.to + BACKUP_SUFFIX)
      await io.copyFile(c.from, c.to)
      m.files[c.rel] = { size: (await io.stat(c.to))?.size ?? 0, sha256: await io.sha256(c.to) }
    }

    const ini = join(exeDir, 'OptiScaler.ini')
    if ((await io.stat(ini))?.isDirectory === false) {
      const fresh = (await io.readFile(ini)).toString('utf8')
      let text = fresh
      const sameVendor = prev?.manifest.gpuVendor === options.gpuVendor
      // The user's settings carry over; when the graphics card maker changed, PlayOut's own edits for the old one
      // do not.
      if (prev?.ini != null)
        text = carryIniValues(
          text,
          prev.ini,
          sameVendor ? [] : iniEditsFor(prev.manifest.gpuVendor)
        )
      if (prev?.ini == null || !sameVendor)
        for (const e of iniEditsFor(options.gpuVendor))
          text = setIniValue(text, e.section, e.key, e.value)
      if (text !== fresh) {
        await io.writeFile(ini, text)
        m.files['OptiScaler.ini'] = {
          size: (await io.stat(ini))?.size ?? 0,
          sha256: await io.sha256(ini)
        }
      }
    }
    await io.writeFile(manifestPath, JSON.stringify(m, null, 2))
  } catch (err) {
    if (m) {
      // The earlier install's logs and its set-aside files are not this attempt's to delete.
      const keep = prev ? [...prev.manifest.runtime, PREVIOUS_DIR].map((r) => r.toLowerCase()) : []
      const runtime = m.runtime.filter((r) => !keep.includes(r.toLowerCase()))
      await undo(exeDir, { ...m, runtime }, io).catch(() => undefined)
    }
    if (prev) await restorePrevious(exeDir, prev, io).catch(() => undefined)
    throw err
  }
  if (prev) await io.removeTree(join(exeDir, PREVIOUS_DIR))
  return m.asName
}

/** Every PlayOut OptiScaler manifest under `installDir` (shallowest first). */
async function findManifests(installDir: string, io: OptiScalerIo): Promise<string[]> {
  if (isProtectedPath(installDir)) return []
  const found: string[] = []
  await walk(installDir, io, (path, name) => {
    if (name.toLowerCase() === OPTISCALER_MANIFEST) found.push(path)
  })
  return found
}

/**
 * The OptiScaler PlayOut installed in a game: the folder (relative to `installDir`, "" for the same folder), the
 * file name and the version, from its manifest. null when there is none.
 */
export async function findOptiScalerInstall(
  installDir: string,
  io: OptiScalerIo = nodeOptiScalerIo
): Promise<OptiScalerState['installed']> {
  for (const path of await findManifests(installDir, io)) {
    const m = await readManifest(path, io)
    if (m)
      return { relDir: relative(installDir, dirname(path)), asName: m.asName, version: m.version }
  }
  return null
}

/**
 * Every game file an OptiScaler PlayOut installed has added or replaced, relative to `installDir` with forward
 * slashes, from all its manifests in the game. These belong to OptiScaler: the DLL update leaves them alone, so
 * Remove OptiScaler can still take them out (or put the game's own back). Empty when there is no PlayOut install.
 */
export async function optiScalerFiles(
  installDir: string,
  io: OptiScalerIo = nodeOptiScalerIo
): Promise<string[]> {
  const out: string[] = []
  for (const path of await findManifests(installDir, io)) {
    const m = await readManifest(path, io)
    if (!m) continue
    const dir = dirname(path)
    for (const rel of [...m.added, ...m.replaced])
      out.push(relative(installDir, inDir(dir, rel)).split(sep).join('/'))
  }
  return out
}

/**
 * Removes every OptiScaler PlayOut installed in a game: the files it added (and the logs OptiScaler wrote) are
 * deleted, the game files it replaced are put back from their `.playout-original` copies, and the folders it made are
 * deleted when empty. Nothing PlayOut did not add is touched: a file the game has replaced since (a game update or a
 * file check) stays, and for a replaced one the out-of-date backup is deleted. Returns those files, relative to
 * `installDir` with forward slashes (empty when everything went back). Does nothing when there is no PlayOut install.
 */
export async function removeOptiScaler(
  installDir: string,
  io: OptiScalerIo = nodeOptiScalerIo
): Promise<string[]> {
  const leftAlone: string[] = []
  for (const path of await findManifests(installDir, io)) {
    const m = await readManifest(path, io)
    if (!m) continue
    const dir = dirname(path)
    for (const rel of await undo(dir, m, io))
      leftAlone.push(relative(installDir, inDir(dir, rel)).split(sep).join('/'))
  }
  return leftAlone
}
