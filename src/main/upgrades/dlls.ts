import { createHash, randomBytes } from 'crypto'
import { constants as fsConstants, promises as fs, type Dirent } from 'fs'
import { basename, join, relative } from 'path'
import type { ResolvedDownload } from '../emulator-setup/types'
import type { FoundUpscalerDll, UpscalerDllKind } from '../../shared/upgrades'
import { tMain } from '../i18n'

/**
 * The DLL update upgrade: finds a game's DLSS / FSR / XeSS files, fetches the newest official ones from NVIDIA, Intel
 * and AMD's own GitHub repositories (docs/research/upgrades/vendor-dlls.md), checks them (size, git blob SHA-1, file
 * version, Authenticode signer) and swaps them in. Every replaced file is kept beside it as
 * `<file>.playout-original`, so Restore puts the game back exactly. Older files are never put over newer ones.
 *
 * Which backups belong to this upgrade is listed in `<installDir>/.playout-dlls.json` (DLL_MANIFEST), with the
 * SHA-256 of the file PlayOut put in. A backup not listed there belongs to another upgrade (OptiScaler keeps its
 * originals under the same suffix) and is never touched here. A listed backup whose game file no longer matches what
 * PlayOut put in (the game was updated or its files verified since) is outdated: it is dropped, not restored.
 */

/** The file name games ship each upscaler file under. */
export const DLL_FILE_NAMES: Record<UpscalerDllKind, string> = {
  dlss: 'nvngx_dlss.dll',
  dlssg: 'nvngx_dlssg.dll',
  dlssd: 'nvngx_dlssd.dll',
  'fsr-dx12': 'amd_fidelityfx_dx12.dll',
  'fsr-vk': 'amd_fidelityfx_vk.dll',
  xess: 'libxess.dll',
  'xess-dx11': 'libxess_dx11.dll',
  'xess-fg': 'libxess_fg.dll',
  xell: 'libxell.dll'
}

/** The suffix of the copy kept of every file PlayOut replaced. */
export const BACKUP_SUFFIX = '.playout-original'

/** The list of files this upgrade replaced, kept in the game's folder (see the module comment). */
export const DLL_MANIFEST = '.playout-dlls.json'

/** The suffix of the new file while it is copied in, before it is renamed over the game's file. */
const NEW_SUFFIX = '.playout-new'

/** Why nothing can be changed or put back when the manifest is damaged. */
const manifestUnreadable = (): string => tMain('mainUpgrades.dlls.manifestUnreadable')

/** Why a file in a protected folder (WindowsApps, or access denied) is left alone. */
const protectedReason = (): string => tMain('mainUpgrades.dlls.protected')

/** Folders deeper than this inside the game are not looked at. */
const MAX_DEPTH = 8
/** At most this many folder entries are looked at (a huge folder cannot stall the menu). */
const MAX_ENTRIES = 200_000

/** The file system calls this module makes (tests may replace them). */
export interface DllIo {
  readdir(dir: string): Promise<Dirent[]>
  readFile(path: string): Promise<Buffer>
  exists(path: string): Promise<boolean>
  /** Copy `from` to `to`; with `exclusive`, fails when `to` exists. */
  copyFile(from: string, to: string, exclusive?: boolean): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string): Promise<void>
  mkdir(dir: string): Promise<void>
  writeFile(path: string, data: string): Promise<void>
}

/** The real file system. */
export const nodeDllIo: DllIo = {
  readdir: (dir) => fs.readdir(dir, { withFileTypes: true }),
  readFile: (path) => fs.readFile(path),
  exists: (path) =>
    fs.lstat(path).then(
      () => true,
      () => false
    ),
  copyFile: (from, to, exclusive) =>
    fs.copyFile(from, to, exclusive ? fsConstants.COPYFILE_EXCL : 0),
  rename: (from, to) => fs.rename(from, to),
  rm: (path) => fs.rm(path, { force: true, recursive: true }),
  mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => undefined),
  writeFile: (path, data) => fs.writeFile(path, data, 'utf8')
}

/** One file this upgrade replaced. */
interface DllManifestEntry {
  /** Path inside the game's folder, as scanned. */
  relPath: string
  /** SHA-256 of the file PlayOut put in; null when unknown (a swap that failed halfway: trust the backup). */
  sha256: string | null
  /** The version PlayOut put in. */
  version: string
}

/** The files this upgrade replaced in one game, by manifestKey. */
interface DllManifest {
  files: Record<string, DllManifestEntry>
}

/** The manifest key of a path inside the game (forward slashes, lower case: Windows paths ignore case). */
function manifestKey(relPath: string): string {
  return relPath
    .split(/[\\/]/)
    .filter((p) => p !== '' && p !== '.')
    .join('/')
    .toLowerCase()
}

/** True when a path inside the game stays inside it (not absolute, no ".."). */
function isInside(relPath: string): boolean {
  return (
    relPath.length > 0 && !/^[\\/]|^[a-z]:/i.test(relPath) && !relPath.split(/[\\/]/).includes('..')
  )
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The game's manifest: empty when there is none, null when it exists but cannot be read or is damaged. */
async function readManifest(installDir: string, io: DllIo): Promise<DllManifest | null> {
  const path = join(installDir, DLL_MANIFEST)
  if (!(await io.exists(path))) return { files: {} }
  let raw: unknown
  try {
    raw = JSON.parse((await io.readFile(path)).toString('utf8'))
  } catch {
    return null
  }
  const files = (raw as { files?: unknown } | null)?.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) return null
  const out: DllManifest = { files: {} }
  for (const value of Object.values(files as Record<string, unknown>)) {
    const e = value as Partial<DllManifestEntry> | null
    if (
      !e ||
      typeof e.relPath !== 'string' ||
      !isInside(e.relPath) ||
      typeof e.version !== 'string' ||
      !(e.sha256 === null || (typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256)))
    )
      return null
    out.files[manifestKey(e.relPath)] = {
      relPath: e.relPath,
      sha256: e.sha256,
      version: e.version
    }
  }
  return out
}

/** Saves the manifest (written aside, then renamed over); deletes it when nothing is listed. */
async function writeManifest(installDir: string, m: DllManifest, io: DllIo): Promise<void> {
  const path = join(installDir, DLL_MANIFEST)
  if (Object.keys(m.files).length === 0) {
    await io.rm(path)
    return
  }
  const temp = path + '.tmp'
  await io.writeFile(temp, JSON.stringify(m, null, 2))
  await io.rename(temp, path)
}

/**
 * True when a listed backup still holds the game's own file for `current` (the bytes now in the game, null when
 * the file is missing): the game file is still the one PlayOut put in, or the entry trusts the backup.
 */
function backupIsCurrent(entry: DllManifestEntry, current: Buffer | null): boolean {
  if (entry.sha256 === null || current === null) return true
  return sha256Of(current) === entry.sha256
}

const KIND_BY_NAME = new Map<string, UpscalerDllKind>(
  (Object.entries(DLL_FILE_NAMES) as Array<[UpscalerDllKind, string]>).map(([kind, name]) => [
    name.toLowerCase(),
    kind
  ])
)

/** True when a path runs through a `WindowsApps` folder (Microsoft Store games: protected and integrity checked). */
function inWindowsApps(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part.toLowerCase() === 'windowsapps')
}

/**
 * Find the game's upscaler files: every file named as in DLL_FILE_NAMES (any letter case) inside `installDir`, with
 * its file version and whether PlayOut keeps an original of it. Junctions and symbolic links are never followed,
 * `WindowsApps` folders inside the game are skipped, and the search stops 8 folders deep. `swapped` is true only for
 * a file listed in the manifest whose backup is there and which is still the file PlayOut put in. Files the manifest
 * lists that the search did not reach, or that are missing now (while their backup is there), are added too (a
 * missing one with version null), so Restore is still offered for them. Nothing is changed.
 */
export async function scanUpscalerDlls(
  installDir: string,
  io: DllIo = nodeDllIo
): Promise<Array<FoundUpscalerDll & { path: string }>> {
  const found: Array<FoundUpscalerDll & { path: string }> = []
  const manifest = (await readManifest(installDir, io)) ?? { files: {} }
  const seen = new Set<string>()
  /** Adds one game file (bytes null: missing or unreadable). */
  const add = async (
    kind: UpscalerDllKind,
    path: string,
    bytes: Buffer | null,
    missing: boolean
  ): Promise<void> => {
    const relPath = relative(installDir, path)
    const key = manifestKey(relPath)
    const entry = manifest.files[key]
    seen.add(key)
    const version = bytes ? readPeFileVersion(bytes) : null
    const swapped =
      !!entry &&
      (await io.exists(path + BACKUP_SUFFIX)) &&
      (missing || (bytes !== null && backupIsCurrent(entry, bytes)))
    found.push({ kind, relPath, path, version, swapped })
  }
  /** The bytes of a file, null when it cannot be read. */
  const read = (path: string): Promise<Buffer | null> => io.readFile(path).catch(() => null)
  let entries = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    let list: Dirent[]
    try {
      list = await io.readdir(dir)
    } catch {
      return
    }
    for (const entry of list) {
      if (++entries > MAX_ENTRIES) return
      // Junctions and symbolic links are reparse points: never followed, never swapped.
      if (entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && entry.name.toLowerCase() !== 'windowsapps')
          await walk(path, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const kind = KIND_BY_NAME.get(entry.name.toLowerCase())
      if (!kind) continue
      await add(kind, path, await read(path), false)
    }
  }
  await walk(installDir, 0)
  // Listed files the search missed (it was cut short, or the file is gone while its backup is there).
  for (const [key, entry] of Object.entries(manifest.files)) {
    if (seen.has(key)) continue
    const kind = KIND_BY_NAME.get(basename(entry.relPath).toLowerCase())
    const path = join(installDir, entry.relPath)
    if (!kind || inWindowsApps(path) || !(await io.exists(path + BACKUP_SUFFIX))) continue
    if (await io.exists(path)) await add(kind, path, await read(path), false)
    else await add(kind, path, null, true)
  }
  return found.sort((a, b) => a.relPath.localeCompare(b.relPath))
}

const FIXED_SIGNATURE = 0xfeef04bd
const VERSION_KEY = Buffer.from('VS_VERSION_INFO', 'utf16le')

/** The four numeric parts of the VS_FIXEDFILEINFO starting at `at`, or null when it is not one. */
function fixedInfoAt(buf: Buffer, at: number): string | null {
  if (at < 0 || at + 16 > buf.length) return null
  if (buf.readUInt32LE(at) !== FIXED_SIGNATURE) return null
  // dwStrucVersion is 0x00010000 in every real version resource.
  if (buf.readUInt32LE(at + 4) !== 0x00010000) return null
  const ms = buf.readUInt32LE(at + 8)
  const ls = buf.readUInt32LE(at + 12)
  return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`
}

/**
 * The file version of a Windows DLL or EXE ("310.9.16.0"), read from the numeric parts of its version resource
 * (VS_FIXEDFILEINFO), not the text one (NVIDIA writes "310,9,16,0" there). Null when the bytes are not a program
 * file or have no version.
 */
export function readPeFileVersion(buf: Buffer): string | null {
  if (buf.length < 64 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null
  // The fixed info follows the "VS_VERSION_INFO" key (padded to 4 bytes); look there first.
  for (let key = buf.indexOf(VERSION_KEY); key >= 0; key = buf.indexOf(VERSION_KEY, key + 2)) {
    const start = key + VERSION_KEY.length
    for (let at = start; at <= start + 8; at++) {
      const v = fixedInfoAt(buf, at)
      if (v) return v
    }
  }
  // Fall back to the bare signature (with a valid structure version).
  const sig = Buffer.alloc(4)
  sig.writeUInt32LE(FIXED_SIGNATURE)
  for (let at = buf.indexOf(sig); at >= 0; at = buf.indexOf(sig, at + 1)) {
    const v = fixedInfoAt(buf, at)
    if (v) return v
  }
  return null
}

/** The numeric parts of a dotted version ("v310.9.16" gives 310, 9, 16); anything else counts as 0. */
function versionParts(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((p) => {
      const n = parseInt(p, 10)
      return Number.isFinite(n) ? n : 0
    })
}

/**
 * Compare two dotted versions by their numeric parts (missing parts count as 0, so "310.9.16" equals "310.9.16.0").
 * Negative when `a` is older, positive when newer, 0 when equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a)
  const pb = versionParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * The FSR version of AMD's FSR 3.1 files by their file version (which is the FidelityFX API's version, not FSR's;
 * from DLSS Swapper's manifest).
 */
const FSR_DISPLAY_VERSIONS: Record<string, string> = {
  '1.0.0.36208': '3.1.0',
  '1.0.0.36604': '3.1.0',
  '1.0.0.36752': '3.1.0',
  '1.0.1.37507': '3.1.1',
  '1.0.1.38338': '3.1.2',
  '1.0.2.38022': '3.1.2',
  '1.0.1.39157': '3.1.3',
  '1.0.1.40157': '3.1.3',
  '1.0.1.39321': '3.1.3',
  '1.0.1.41314': '3.1.4',
  '1.0.1.42386': '3.1.4'
}

/** The FSR version ("3.1.4") of an FSR 3.1 file's file version ("1.0.1.41314"), when known. */
export function fsrDisplayVersion(fileVersion: string): string | null {
  const parts = versionParts(fileVersion)
  while (parts.length < 4) parts.push(0)
  return FSR_DISPLAY_VERSIONS[parts.slice(0, 4).join('.')] ?? null
}

/**
 * True when `candidate` is newer than the game's `current` file of this kind. FSR 3.1 files compare by their FSR
 * version (their file versions do not grow in order). An FSR file PlayOut does not know is only counted older when
 * both its whole file version and its build number are lower, so a file with a higher version (a newer FidelityFX
 * API) is never replaced because of a lower build number. Use this, not compareVersions, to tell whether a game's
 * file can be updated.
 */
export function isNewerDll(kind: UpscalerDllKind, current: string, candidate: string): boolean {
  if (kind === 'fsr-dx12' || kind === 'fsr-vk') {
    const a = fsrDisplayVersion(current)
    const b = fsrDisplayVersion(candidate)
    if (a && b) return compareVersions(b, a) > 0
    const build = (v: string): number => versionParts(v)[3] ?? 0
    return compareVersions(candidate, current) > 0 && build(candidate) > build(current)
  }
  return compareVersions(candidate, current) > 0
}

/** The vendors whose upscaler files latestVendorDlls looks up. */
export type DllVendor = 'NVIDIA' | 'Intel' | 'AMD'

/** One official upscaler file: where to get it and how to check it. */
export interface VendorDll {
  kind: UpscalerDllKind
  /** Its file version ("310.9.16.0"). */
  version: string
  fileName: string
  /** raw.githubusercontent.com address in the vendor's own repository. */
  url: string
  size: number
  /** Git blob SHA-1 the GitHub API gives for it. */
  gitBlobSha: string | null
  sha256: string | null
  /** Who must have signed it (Authenticode subject). */
  signer:
    | 'NVIDIA Corporation'
    | 'Intel Corporation'
    | 'Advanced Micro Devices, Inc.'
    | 'Microsoft Windows Hardware Compatibility Publisher'
}

/** A GitHub API JSON lookup (the service passes the emulator setup's fetchJson). */
type FetchJson = <T>(url: string) => Promise<T>

interface GitHubContent {
  name?: string
  type?: string
  size?: number
  sha?: string
  download_url?: string | null
}

const API = 'https://api.github.com/repos'
const RAW = 'https://raw.githubusercontent.com'

const NVIDIA_REPO = 'NVIDIA/DLSS'
const NVIDIA_DIR = 'lib/Windows_x86_64/rel'
const INTEL_REPO = 'intel/xess'
const INTEL_DIR = 'bin'
const AMD_REPO = 'GPUOpen-LibrariesAndSDKs/FidelityFX-SDK'
/** The FSR 3.1 files games ship are only in SDK 1.1.4 (2.x split them up); no newer one will come. */
const AMD_TAG = 'v1.1.4'
const AMD_DIR = 'PrebuiltSignedDLL'

/**
 * The file versions of Intel's and AMD's files by name and size (their release tags are SDK versions, not file
 * versions, and the API does not give file versions). A file not listed here is not offered until PlayOut knows it.
 */
const KNOWN_FILE_VERSIONS: Record<string, Array<{ size: number; version: string }>> = {
  'libxess.dll': [{ size: 77795704, version: '2.0.2.68' }],
  'libxess_dx11.dll': [{ size: 156016, version: '2.0.2.68' }],
  'libxess_fg.dll': [{ size: 22957432, version: '1.3.1.78' }],
  'libxell.dll': [{ size: 415368, version: '1.3.2.10' }],
  'amd_fidelityfx_dx12.dll': [{ size: 6675664, version: '1.0.1.41314' }],
  'amd_fidelityfx_vk.dll': [{ size: 9332432, version: '1.0.1.41314' }]
}

const NVIDIA_KINDS: UpscalerDllKind[] = ['dlss', 'dlssg', 'dlssd']
const INTEL_KINDS: UpscalerDllKind[] = ['xess', 'xess-dx11', 'xess-fg', 'xell']
const AMD_KINDS: UpscalerDllKind[] = ['fsr-dx12', 'fsr-vk']

/** The signer pinned for each kind (XeLL is signed through Microsoft's hardware program). */
function signerOf(kind: UpscalerDllKind): VendorDll['signer'] {
  if (kind === 'xell') return 'Microsoft Windows Hardware Compatibility Publisher'
  if (NVIDIA_KINDS.includes(kind)) return 'NVIDIA Corporation'
  if (INTEL_KINDS.includes(kind)) return 'Intel Corporation'
  return 'Advanced Micro Devices, Inc.'
}

/** The company name an Authenticode check must also see in the file (only XeLL needs it). */
function companyOf(kind: UpscalerDllKind): string | undefined {
  return kind === 'xell' ? 'Intel Corporation' : undefined
}

async function latestTag(repo: string, fetchJson: FetchJson): Promise<string | null> {
  const release = await fetchJson<{ tag_name?: unknown }>(`${API}/${repo}/releases/latest`)
  const tag = typeof release?.tag_name === 'string' ? release.tag_name.trim() : ''
  // Only plain tags ("v310.9.16") go into a URL.
  return /^[A-Za-z0-9._-]+$/.test(tag) ? tag : null
}

async function listFiles(
  repo: string,
  dir: string,
  tag: string,
  fetchJson: FetchJson
): Promise<GitHubContent[]> {
  const list = await fetchJson<unknown>(
    `${API}/${repo}/contents/${dir}?ref=${encodeURIComponent(tag)}`
  )
  return Array.isArray(list) ? (list as GitHubContent[]) : []
}

/** The VendorDll of one listed file, or null when it is not usable (unknown version, or no git blob SHA-1 to check). */
function vendorFile(
  kind: UpscalerDllKind,
  repo: string,
  dir: string,
  tag: string,
  files: GitHubContent[],
  version: string | null
): VendorDll | null {
  const fileName = DLL_FILE_NAMES[kind]
  const entry = files.find(
    (f) => typeof f.name === 'string' && f.name.toLowerCase() === fileName && f.type !== 'dir'
  )
  if (!entry || typeof entry.size !== 'number' || entry.size <= 0) return null
  if (typeof entry.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(entry.sha)) return null
  const v =
    version ??
    KNOWN_FILE_VERSIONS[fileName]?.find((known) => known.size === entry.size)?.version ??
    null
  if (!v) return null
  const prefix = `${RAW}/${repo}/`
  const url =
    typeof entry.download_url === 'string' && entry.download_url.startsWith(prefix)
      ? entry.download_url
      : `${prefix}${tag}/${dir}/${fileName}`
  return {
    kind,
    version: v,
    fileName,
    url,
    size: entry.size,
    gitBlobSha: entry.sha.toLowerCase(),
    sha256: null,
    signer: signerOf(kind)
  }
}

/** "v310.9.16" as a four-part file version ("310.9.16.0"), or null when the tag is not a version. */
function tagVersion(tag: string): string | null {
  if (!/^v?\d+(\.\d+){1,3}$/i.test(tag)) return null
  const parts = versionParts(tag)
  while (parts.length < 4) parts.push(0)
  return parts.join('.')
}

/**
 * The newest official file of each kind: NVIDIA DLSS (the DLSS repository's latest release, lib/Windows_x86_64/rel),
 * Intel XeSS (the xess repository's latest release, bin) and AMD FSR 3.1 (FidelityFX SDK 1.1.4, PrebuiltSignedDLL).
 * A vendor that cannot be reached is left out (the others still come back) and named to `onVendorFailed`, so the
 * caller can tell a partial answer from a complete one and ask again soon. About 5 GitHub API calls; the caller
 * caches the answer.
 */
export async function latestVendorDlls(deps: {
  fetchJson: FetchJson
  /** Called for each vendor whose files could not be looked up (offline, rate limited). */
  onVendorFailed?: (vendor: DllVendor, err: unknown) => void
}): Promise<Partial<Record<UpscalerDllKind, VendorDll>>> {
  const out: Partial<Record<UpscalerDllKind, VendorDll>> = {}
  const add = (file: VendorDll | null): void => {
    if (file) out[file.kind] = file
  }
  const nvidia = async (): Promise<void> => {
    const tag = await latestTag(NVIDIA_REPO, deps.fetchJson)
    const version = tag && tagVersion(tag)
    if (!tag || !version) return
    const files = await listFiles(NVIDIA_REPO, NVIDIA_DIR, tag, deps.fetchJson)
    for (const kind of NVIDIA_KINDS)
      add(vendorFile(kind, NVIDIA_REPO, NVIDIA_DIR, tag, files, version))
  }
  const intel = async (): Promise<void> => {
    const tag = await latestTag(INTEL_REPO, deps.fetchJson)
    if (!tag) return
    const files = await listFiles(INTEL_REPO, INTEL_DIR, tag, deps.fetchJson)
    for (const kind of INTEL_KINDS) add(vendorFile(kind, INTEL_REPO, INTEL_DIR, tag, files, null))
  }
  const amd = async (): Promise<void> => {
    const files = await listFiles(AMD_REPO, AMD_DIR, AMD_TAG, deps.fetchJson)
    for (const kind of AMD_KINDS) add(vendorFile(kind, AMD_REPO, AMD_DIR, AMD_TAG, files, null))
  }
  const tries: Array<[DllVendor, () => Promise<void>]> = [
    ['NVIDIA', nvidia],
    ['Intel', intel],
    ['AMD', amd]
  ]
  await Promise.all(
    tries.map(([vendor, look]) =>
      look().catch((err: unknown) => {
        deps.onVendorFailed?.(vendor, err)
      })
    )
  )
  return out
}

/** Git's blob SHA-1 of some bytes: sha1("blob " + size + "\0" + bytes), as the GitHub API gives it. */
export function gitBlobSha1(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

/** Throws unless `bytes` is the expected official file (size, blob SHA-1, SHA-256, program file, version). */
function checkBytes(file: VendorDll, bytes: Buffer): void {
  const name = file.fileName
  if (bytes.length !== file.size)
    throw new Error(
      tMain('mainUpgrades.dlls.damagedSize', {
        file: name,
        size: bytes.length,
        expected: file.size
      })
    )
  if (file.gitBlobSha && gitBlobSha1(bytes) !== file.gitBlobSha.toLowerCase())
    throw new Error(tMain('mainUpgrades.dlls.checksum', { file: name }))
  if (file.sha256 && createHash('sha256').update(bytes).digest('hex') !== file.sha256.toLowerCase())
    throw new Error(tMain('mainUpgrades.dlls.checksum', { file: name }))
  const version = readPeFileVersion(bytes)
  if (!version) throw new Error(tMain('mainUpgrades.dlls.notProgram', { file: name }))
  if (compareVersions(version, file.version) !== 0)
    throw new Error(
      tMain('mainUpgrades.dlls.wrongVersion', { file: name, version, expected: file.version })
    )
}

/** What ensureVendorDll needs from outside. */
interface VendorDllDeps {
  /** Download `d` into `dir` as `<dir>/<d.fileName>`; returns the saved path (emulator setup's downloadFile). */
  download(d: ResolvedDownload, dir: string): Promise<string>
  /** True when the file's Authenticode signature is valid and signed by `expectedSigner` (and `companyName`). */
  verifySigner(path: string, expectedSigner: string, companyName?: string): Promise<boolean>
}

/** The ensureVendorDll calls running now, by cached file path (lower case), so two callers share one download. */
const inFlight = new Map<string, Promise<string>>()

/**
 * The official file, downloaded once into `<cacheDir>/<kind>/<version>/<fileName>` and checked: size, git blob
 * SHA-1 (and SHA-256 when known), file version, then the Authenticode signer it must carry. A file already in the
 * cache goes through the same checks (bytes and signer) before it is reused. A file failing any check is deleted and
 * an error is thrown; a file with neither checksum known is refused. Calls for the same file at the same time share
 * one download; each download goes into its own temporary folder. A call that joined another's download and saw it
 * fail tries once more with its own `deps`: the first caller may have been stopped (its download aborted), which must
 * not fail a caller nobody stopped. Returns the cached file's path.
 */
export async function ensureVendorDll(
  file: VendorDll,
  cacheDir: string,
  deps: VendorDllDeps,
  io: DllIo = nodeDllIo
): Promise<string> {
  if (!/^https:\/\/raw\.githubusercontent\.com\//.test(file.url))
    throw new Error(tMain('mainUpgrades.dlls.notVendorUrl', { file: file.fileName }))
  if (!file.gitBlobSha && !file.sha256)
    throw new Error(tMain('mainUpgrades.dlls.noChecksum', { file: file.fileName }))
  const dir = join(cacheDir, file.kind, safeSegment(file.version))
  const target = join(dir, file.fileName)
  const key = target.toLowerCase()
  const running = inFlight.get(key)
  if (running) return running.catch(() => ensureVendorDll(file, cacheDir, deps, io))
  const job = fetchVendorDll(file, dir, target, deps, io).finally(() => {
    if (inFlight.get(key) === job) inFlight.delete(key)
  })
  inFlight.set(key, job)
  return job
}

/** True when `path` holds the official file: its bytes pass checkBytes and its signer is the pinned one. */
async function isVerified(
  file: VendorDll,
  path: string,
  deps: VendorDllDeps,
  io: DllIo
): Promise<boolean> {
  if (!(await io.exists(path))) return false
  try {
    checkBytes(file, await io.readFile(path))
  } catch {
    return false
  }
  return deps.verifySigner(path, file.signer, companyOf(file.kind)).catch(() => false)
}

/** ensureVendorDll's work, for one caller at a time per file. */
async function fetchVendorDll(
  file: VendorDll,
  dir: string,
  target: string,
  deps: VendorDllDeps,
  io: DllIo
): Promise<string> {
  if (await isVerified(file, target, deps, io)) return target
  await io.rm(target)
  const partDir = join(dir, `download-${randomBytes(6).toString('hex')}`)
  await io.mkdir(partDir)
  try {
    const saved = await deps.download(
      {
        version: file.version,
        url: file.url,
        fileName: file.fileName,
        size: file.size,
        sha256: file.sha256 ?? undefined
      },
      partDir
    )
    checkBytes(file, await io.readFile(saved))
    if (!(await deps.verifySigner(saved, file.signer, companyOf(file.kind))))
      throw new Error(
        tMain('mainUpgrades.dlls.notSigned', { file: file.fileName, signer: file.signer })
      )
    // Another PlayOut process may have put a checked copy there meanwhile: use it.
    if (await isVerified(file, target, deps, io)) return target
    await io.rm(target)
    await io.rename(saved, target)
    return target
  } finally {
    await io.rm(partDir)
  }
}

/** A version as a folder name (digits and dots only in practice). */
function safeSegment(version: string): string {
  return version.replace(/[^0-9A-Za-z._-]/g, '_') || 'unknown'
}

/** The reason to show for a file system error on one file. */
function errorReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'EPERM' || code === 'EACCES') return protectedReason()
  if (code === 'EBUSY') return tMain('mainUpgrades.dlls.inUse')
  return err instanceof Error ? err.message : String(err)
}

/** Why a file whose backup belongs to another upgrade is left alone. */
const otherUpgradeReason = (): string => tMain('mainUpgrades.dlls.otherUpgrade')

/**
 * Put the newest official files over the game's files of the same kind (only the same file name: a frame generation
 * file never replaces an upscaler file). A file is replaced only when the new one is newer (isNewerDll, against the
 * version read from the file now); DLSS 1 files and files whose version cannot be read are left alone. The game's
 * file is first kept as `<file>.playout-original` (an existing copy of this upgrade is never overwritten, so it
 * always holds the game's own file) and listed in DLL_MANIFEST. The new file is copied in beside the game's file and
 * then renamed over it, so a failed copy never touches the game's file; when the game's file did change anyway, its
 * backup is kept and listed so Restore can put it back. A backup that belongs to another upgrade is left alone
 * (the file is skipped), and a backup made outdated by a game update since is dropped first (the updated file is
 * then kept as the new original). Files that cannot be changed (protected folder, in use) are listed in `skipped`
 * with the reason; the rest still go ahead.
 */
export async function swapDlls(
  installDir: string,
  found: ReadonlyArray<FoundUpscalerDll>,
  files: Partial<Record<UpscalerDllKind, { path: string; version: string }>>,
  io: DllIo = nodeDllIo
): Promise<{ replaced: string[]; skipped: { relPath: string; reason: string }[] }> {
  const replaced: string[] = []
  const skipped: { relPath: string; reason: string }[] = []
  const wanted = found.filter((dll) => files[dll.kind])
  if (wanted.length === 0) return { replaced, skipped }
  const manifest = await readManifest(installDir, io)
  if (!manifest)
    return {
      replaced,
      skipped: wanted.map((dll) => ({ relPath: dll.relPath, reason: manifestUnreadable() }))
    }
  const save = (): Promise<void> => writeManifest(installDir, manifest, io)
  const newHashes = new Map<string, string>()
  for (const dll of wanted) {
    const next = files[dll.kind]
    if (!next) continue
    const relPath = dll.relPath
    const path = join(installDir, relPath)
    if (!isInside(relPath) || relative(installDir, path).startsWith('..')) {
      skipped.push({ relPath, reason: tMain('mainUpgrades.dlls.outsideFolder') })
      continue
    }
    if (inWindowsApps(path)) {
      skipped.push({ relPath, reason: protectedReason() })
      continue
    }
    const key = manifestKey(relPath)
    const backup = path + BACKUP_SUFFIX
    let before: Buffer
    try {
      before = await io.readFile(path)
    } catch (err) {
      skipped.push({ relPath, reason: errorReason(err) })
      continue
    }
    const beforeHash = sha256Of(before)
    let hasBackup = await io.exists(backup)
    const listed = manifest.files[key]
    if (hasBackup && !listed) {
      skipped.push({ relPath, reason: otherUpgradeReason() })
      continue
    }
    if (listed && (!hasBackup || !backupIsCurrent(listed, before))) {
      // The game's file changed since PlayOut swapped it (a game update or a file check): the backup is outdated.
      try {
        if (hasBackup) await io.rm(backup)
        delete manifest.files[key]
        await save()
      } catch (err) {
        skipped.push({ relPath, reason: errorReason(err) })
        continue
      }
      hasBackup = false
    }
    const version = readPeFileVersion(before)
    if (!version) {
      skipped.push({ relPath, reason: tMain('mainUpgrades.dlls.versionUnreadable') })
      continue
    }
    if (dll.kind === 'dlss' && (versionParts(version)[0] ?? 0) < 2) {
      skipped.push({ relPath, reason: tMain('mainUpgrades.dlls.dlss1') })
      continue
    }
    if (!isNewerDll(dll.kind, version, next.version)) {
      skipped.push({ relPath, reason: tMain('mainUpgrades.dlls.isNewest') })
      continue
    }
    let newHash = newHashes.get(next.path)
    if (!newHash) {
      try {
        const hash = sha256Of(await io.readFile(next.path))
        newHashes.set(next.path, hash)
        newHash = hash
      } catch (err) {
        skipped.push({
          relPath,
          reason: tMain('mainUpgrades.dlls.newUnreadable', { reason: errorReason(err) })
        })
        continue
      }
    }
    const temp = path + NEW_SUFFIX
    const prior = manifest.files[key]
    let madeBackup = false
    try {
      if (!hasBackup) {
        await io.copyFile(path, backup, true)
        madeBackup = true
      }
      await io.rm(temp)
      await io.copyFile(next.path, temp)
      // Listed before the game's file changes, so a backup is never left unlisted.
      manifest.files[key] = { relPath, sha256: newHash, version: next.version }
      await save()
      await io.rename(temp, path)
      replaced.push(relPath)
    } catch (err) {
      await io.rm(temp).catch(() => undefined)
      let reason = errorReason(err)
      // What is in the game now: its hash, null when the file is missing, '' when it cannot be read.
      let now: string | null
      try {
        now = sha256Of(await io.readFile(path))
      } catch {
        now = (await io.exists(path).catch(() => true)) ? '' : null
      }
      if (now === beforeHash) {
        // The game's file is untouched: the backup made for it can go.
        if (prior) manifest.files[key] = prior
        else delete manifest.files[key]
        if (madeBackup) {
          try {
            await io.rm(backup)
          } catch {
            // Still there: it is an exact copy of the game's file, so list it (Restore puts back the same bytes).
            manifest.files[key] = { relPath, sha256: beforeHash, version }
          }
        }
      } else {
        // The game's file changed or is gone: keep the backup, listed, so Restore can put the game's file back.
        manifest.files[key] = { relPath, sha256: now || null, version: next.version }
        reason = tMain('mainUpgrades.dlls.changedKeptBackup', { reason })
      }
      await save().catch(() => undefined)
      skipped.push({ relPath, reason })
    }
  }
  return { replaced, skipped }
}

/**
 * Put back the game's own files: every file listed in DLL_MANIFEST gets its `<file>.playout-original` moved back
 * over it, also when the file itself is missing now. The found files (`_found`) are not needed: the manifest lists
 * what to put back, so files a scan missed are restored too; the parameter stays for the callers. A listed file the game has updated since (it is
 * no longer the file PlayOut put in) keeps the game's newer file: its outdated backup is deleted and it is not listed
 * in `restored`. Backups of other upgrades are never touched. Files that cannot be put back (protected folder, in
 * use) are listed in `failed`, as is a damaged manifest; the rest still are.
 */
export async function restoreDlls(
  installDir: string,
  _found: ReadonlyArray<FoundUpscalerDll>,
  io: DllIo = nodeDllIo
): Promise<{ restored: string[]; failed: { relPath: string; reason: string }[] }> {
  const restored: string[] = []
  const failed: { relPath: string; reason: string }[] = []
  const manifest = await readManifest(installDir, io)
  if (!manifest)
    return { restored, failed: [{ relPath: DLL_MANIFEST, reason: manifestUnreadable() }] }
  const entries = Object.entries(manifest.files).sort((a, b) =>
    a[1].relPath.localeCompare(b[1].relPath)
  )
  for (const [key, entry] of entries) {
    const path = join(installDir, entry.relPath)
    const backup = path + BACKUP_SUFFIX
    try {
      if (!(await io.exists(backup))) {
        delete manifest.files[key]
        continue
      }
      const current = (await io.exists(path)) ? await io.readFile(path) : null
      if (!backupIsCurrent(entry, current)) {
        // Updated by the game since: its own newer file stays, the outdated backup goes.
        await io.rm(backup)
        delete manifest.files[key]
        continue
      }
      await io.rename(backup, path)
      delete manifest.files[key]
      restored.push(entry.relPath)
    } catch (err) {
      failed.push({ relPath: entry.relPath, reason: errorReason(err) })
    }
  }
  if (Object.keys(manifest.files).length !== entries.length) {
    try {
      await writeManifest(installDir, manifest, io)
    } catch (err) {
      failed.push({ relPath: DLL_MANIFEST, reason: errorReason(err) })
    }
  }
  return { restored, failed }
}
