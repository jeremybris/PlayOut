// Manual (.exe) provider: user-added executables and the "scan a folder for games" heuristics (docs/ARCHITECTURE.md §4.3,
// docs/research/playnite-stores.md §3). Titles and icons come from the executables themselves via PowerShell: the
// PE version resource (FileDescription / ProductName) and the largest image of the first icon group.
import { promises as fs } from 'fs'
import { basename, dirname, extname, join, resolve } from 'path'
import { PC_PLATFORM } from '../../shared/platforms'
import type { ScannedGame } from '../../shared/types'
import type { Logger } from '../logger'
import type { LibraryService } from '../services/library-service'
import { asArray, psQuote, runPowerShellJson } from '../system/powershell'
import { ensureDir, isDirectory, isFile, listDir, statSafe } from '../util/fs'
import { sha1Hex } from '../util/hash'
import { newId } from '../util/ids'
import { knownFolders, normalizePath } from '../util/paths'
import type { ManualGameInput, ManualProvider } from './types'
import { tMain } from '../i18n'

export interface ManualProviderDeps {
  library: Pick<LibraryService, 'games'>
  log: Logger
  /** Where extracted icon PNGs are written. Default: %LOCALAPPDATA%\PlayOut\icon-extract. */
  iconDir?: string
}

/** How many directory levels below a game folder are searched for executables. */
export const MAX_SCAN_DEPTH = 3

// ---------------------------------------------------------------------------
// File-name heuristics
// ---------------------------------------------------------------------------

/**
 * Executables that are never the game (matched against the file name, case-insensitive, unanchored unless the
 * pattern says otherwise). Playnite's scanFileExclusionMasks plus the helpers found in real store folders.
 */
const EXCLUDED_NAME_PATTERNS: RegExp[] = [
  // installers, uninstallers, redistributables
  /uninst/i,
  /unins\d+/i,
  /setup/i,
  /install/i,
  /redist/i,
  /vcredist/i,
  /vc_redist/i,
  /dxsetup/i,
  /directx/i,
  /dotnet/i,
  /^ndp\d/i,
  /cleanup/i,
  /cleaner/i,
  // crash and error reporting
  /crashhandler/i,
  /crash_?report/i,
  /crashsender/i,
  /crashclient/i,
  /crashpad/i,
  /crashlog/i,
  /crashdump/i,
  /createdump/i,
  /bugsplat/i,
  /bssndrpt/i,
  /bugtrap/i,
  /bugreport/i,
  /sendreport/i,
  /err(or)?rep/i,
  // helpers, updaters, embedded runtimes
  /helper/i,
  /handler/i,
  /update/i,
  /patcher/i,
  /config/i,
  /^python(w)?\.exe$/i,
  /^zsync(make)?\.exe$/i,
  /qtwebengine/i,
  /cefsharp/i,
  /webview/i,
  /msedge/i,
  /proxy/i,
  /usvfs/i,
  /^7z/i,
  /unrar/i,
  /unzip/i,
  /winrar/i,
  /^mono\.exe$/i,
  /^node\.exe$/i,
  /^java(w)?\.exe$/i,
  /^ffmpeg/i,
  /^vlc/i,
  /regsvr/i,
  /^register/i,
  /^activat/i,
  /dxdiag/i,
  /sysinfo/i,
  /diagnos/i,
  /\.vshost\.exe$/i,
  // store clients, anti-cheat, drivers
  /^steam(service|errorreporter|webhelper|_monitor)?\.exe$/i,
  /galaxyclient/i,
  /epicgameslauncher/i,
  /epiconlineservices/i,
  /epicwebhelper/i,
  /^origin\.exe$/i,
  /eadesktop/i,
  /ealink/i,
  /ubisoftconnect/i,
  /^uplay/i,
  /anticheat/i,
  /battleye/i,
  /beservice/i,
  /physx/i,
  /nvidia/i,
  /vigem/i,
  // documents and decorations
  /readme/i,
  /^manual\.exe$/i,
  /license/i,
  /eula/i,
  /wallpaper/i,
  /screensaver/i
]

/** Executables that are only chosen when nothing better exists in the folder (launchers, servers, editors, tools). */
const DEPRIORITIZED_NAME_PATTERNS: RegExp[] = [
  /launcher/i,
  /^launch/i,
  /bootstrap/i,
  /loader/i,
  /^start_/i,
  /^startgame/i,
  /^start\.exe$/i,
  /editor/i,
  /server/i,
  /dedicated/i,
  /pitboss/i,
  /multiplayer/i,
  /mp\.exe$/i,
  /benchmark/i,
  /^test(app|web|client|_)/i,
  /tool/i,
  /mod_?manager/i,
  /modorganizer/i,
  /settings/i,
  /options/i,
  /sdk/i,
  /browser/i,
  /console/i,
  /cli\.exe$/i,
  /debug/i,
  /demo/i,
  /trial/i,
  /_be\.exe$/i,
  /(32|x86)\.exe$/i,
  /win32/i
]

/** Directories that never hold the game executable; they are not entered. */
const SKIPPED_DIR_NAMES = new Set([
  'redist',
  '_redist',
  '__redist',
  '_commonredist',
  '_customredists',
  'redistributables',
  'directx',
  'dotnet',
  'vcredist',
  'support',
  'prerequisites',
  'prereq',
  'installer',
  'installers',
  '__installer',
  'install',
  'uninstall',
  'tools',
  'tool',
  'sdk',
  'mono',
  'monobleedingedge',
  'engine',
  'thirdparty',
  'third_party',
  'third-party',
  'easyanticheat',
  'battleye',
  'crashreporter',
  'crashsender',
  'logs',
  'log',
  'saves',
  'savegames',
  'screenshots',
  'mods',
  'plugins',
  'node_modules',
  'docs',
  'documentation',
  'manual',
  'manuals',
  'drivers',
  'locales',
  'localization',
  'resources',
  'launcher',
  'epiconlineservices',
  '$recycle.bin',
  'system volume information'
])

/** Directory names that typically contain the main executable (bin, Binaries\Win64, x64 ...). */
const BINARY_DIR_NAMES = new Set([
  'bin',
  'bin64',
  'bin32',
  'binaries',
  'win64',
  'win32',
  'x64',
  'x86',
  'game',
  'app',
  'release',
  'retail',
  'windows',
  'windowsnoeditor',
  'wingdk',
  'win',
  'exe',
  'client'
])

export function isExcludedExecutable(fileName: string): boolean {
  return EXCLUDED_NAME_PATTERNS.some((p) => p.test(fileName))
}

export function isDeprioritizedExecutable(fileName: string): boolean {
  return DEPRIORITIZED_NAME_PATTERNS.some((p) => p.test(fileName))
}

export function isSkippedDirectory(dirName: string): boolean {
  const lower = dirName.toLowerCase()
  return SKIPPED_DIR_NAMES.has(lower) || lower.endsWith('_data')
}

export interface ExeCandidate {
  path: string
  /** Path relative to the game folder (backslashes), e.g. 'bin\\x64\\factorio.exe'. */
  relativePath: string
  name: string
  size: number
  /** 0 = directly inside the game folder. */
  depth: number
}

/** Lower-case letters and digits only: 'Mafia: Definitive Edition' -> 'mafiadefinitiveedition'. */
export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Normalised executable stem without platform suffixes: 'Palworld-Win64-Shipping' -> 'palworld', 'DOOMx64vk' -> 'doom'. */
export function normalizeExeStem(stem: string): string {
  const normalized = normalizeName(stem)
  const stripped = normalized.replace(
    /(win64shipping|win32shipping|shipping|win64|win32|x64|x86|dx9|dx10|dx11|dx12|vulkan|vk|64|32)+$/,
    ''
  )
  return stripped.length >= 2 ? stripped : normalized
}

/** First letters of the words of a folder name, digits kept whole: 'EARTH DEFENSE FORCE 6' -> 'edf6'. */
function acronym(folderName: string): string {
  return folderName
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => (/^\p{N}+$/u.test(word) ? word : word[0]))
    .join('')
    .toLowerCase()
}

/** 3 = the executable is named after the folder, 2 = partial or acronym match, 1 = unrelated. */
export function nameMatchScore(folderName: string, fileName: string): number {
  const folder = normalizeName(folderName)
  const stem = normalizeExeStem(basename(fileName, extname(fileName)))
  if (!folder || !stem) return 1
  if (folder === stem) return 3
  const shorter = Math.min(folder.length, stem.length)
  if (shorter >= 3 && (folder.includes(stem) || stem.includes(folder))) return 2
  const short = acronym(folderName)
  if (
    short.length >= 2 &&
    (stem === short || (stem.startsWith(short) && stem.length - short.length <= 2))
  )
    return 2
  return 1
}

function pathSegments(relativePath: string): string[] {
  return relativePath.split(/[\\/]/).slice(0, -1)
}

/** 3 = in the game folder itself, 2 = in a bin/binaries style folder, 1 = elsewhere. */
export function locationScore(candidate: Pick<ExeCandidate, 'relativePath' | 'depth'>): number {
  if (candidate.depth === 0) return 3
  return pathSegments(candidate.relativePath).some((s) => BINARY_DIR_NAMES.has(s.toLowerCase()))
    ? 2
    : 1
}

/** 2 = 64-bit or unspecified build, 1 = a 32-bit variant (x86 / win32 folders or suffixes). */
function architectureScore(candidate: Pick<ExeCandidate, 'relativePath' | 'name'>): number {
  const segments = pathSegments(candidate.relativePath).map((s) => s.toLowerCase())
  if (segments.some((s) => s === 'x86' || s === 'win32' || s === '32bit' || s === 'bin32')) return 1
  return /(32|x86)\.exe$/i.test(candidate.name) ? 1 : 2
}

/**
 * Order the executables of one game folder from most to least likely main executable: excluded names are dropped,
 * launchers/servers/tools go last, then the name that matches the folder, then root/bin locations, then 64-bit
 * builds, then the largest file.
 */
export function rankCandidates(folderName: string, candidates: ExeCandidate[]): ExeCandidate[] {
  const scored = candidates
    .filter((c) => c.size > 0 && !isExcludedExecutable(c.name))
    .map((c) => ({
      candidate: c,
      primary: isDeprioritizedExecutable(c.name) ? 0 : 1,
      name: nameMatchScore(folderName, c.name),
      location: locationScore(c),
      arch: architectureScore(c)
    }))
  scored.sort(
    (a, b) =>
      b.primary - a.primary ||
      b.name - a.name ||
      b.location - a.location ||
      b.arch - a.arch ||
      b.candidate.size - a.candidate.size ||
      a.candidate.relativePath.localeCompare(b.candidate.relativePath)
  )
  return scored.map((s) => s.candidate)
}

export function pickExecutable(
  folderName: string,
  candidates: ExeCandidate[]
): ExeCandidate | null {
  return rankCandidates(folderName, candidates)[0] ?? null
}

/**
 * Every *.exe under `dir`, at most `maxDepth` directory levels down, skipping hidden entries and the folders that
 * only hold redistributables, engines, tools and the like. Never throws on unreadable folders.
 */
export async function collectExecutables(
  dir: string,
  maxDepth = MAX_SCAN_DEPTH
): Promise<ExeCandidate[]> {
  const found: ExeCandidate[] = []
  const queue: { path: string; relative: string; depth: number }[] = [
    { path: dir, relative: '', depth: 0 }
  ]
  while (queue.length) {
    const current = queue.shift()!
    for (const entry of await listDir(current.path)) {
      if (entry.name.startsWith('.')) continue
      const entryPath = join(current.path, entry.name)
      const relative = current.relative ? `${current.relative}\\${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (current.depth < maxDepth && !isSkippedDirectory(entry.name)) {
          queue.push({ path: entryPath, relative, depth: current.depth + 1 })
        }
      } else if (entry.isFile() && /\.exe$/i.test(entry.name)) {
        const stats = await statSafe(entryPath)
        found.push({
          path: entryPath,
          relativePath: relative,
          name: entry.name,
          size: stats?.size ?? 0,
          depth: current.depth
        })
      }
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const GENERIC_TITLES = new Set([
  'game',
  'launcher',
  'application',
  'app',
  'main',
  'player',
  'client',
  'unity',
  'unity player',
  'unreal',
  'unreal engine',
  'ue4',
  'ue5',
  'godot',
  'godot engine',
  'windows',
  'microsoft windows operating system',
  'console application',
  'windows application',
  'win32 application',
  'wpf application',
  'executable',
  'program',
  'untitled',
  'setup/uninstall',
  'crash handler'
])

/**
 * A usable title from a PE version string (FileDescription or ProductName), or null when the string is empty,
 * generic ('Unity', 'Game'), an engine/launcher name, a template placeholder or an internal identifier.
 */
export function cleanVersionInfoTitle(value: string | null | undefined): string | null {
  if (!value) return null
  let title = value
    .replace(/[™®©]/g, '')
    .replace(/\((tm|r|c)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  title = title.replace(
    /\s+(application|client|executable|game client|game executable|main executable|exe)$/i,
    ''
  )
  title = title.replace(/[\s.,:;\-–—]+$/g, '').trim()
  if (!title || title.length > 120) return null
  if (/todo/i.test(title)) return null
  if (/\.(exe|dll)$/i.test(title)) return null
  if (/\b(engine|launcher|updater|installer|helper|crash handler)$/i.test(title)) return null
  if (GENERIC_TITLES.has(title.toLowerCase())) return null
  // 'sputm90r': a lower-case identifier with digits is a build name, not a title
  if (/^[a-z0-9]+$/.test(title) && /\d/.test(title)) return null
  return title
}

/** 'Super_Game [GOG] v1.2.3' -> 'Super Game'. */
export function cleanFolderTitle(folderName: string): string {
  const title = folderName
    .replace(/_/g, ' ')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s+v?\d+(\.\d+)+$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return title || folderName
}

export interface ExeVersionInfo {
  description?: string
  product?: string
}

/**
 * Title precedence: FileDescription, ProductName, the game folder name, the file name. A version string that merely
 * repeats the file name ('FalloutNV', 'skate.') loses to the folder name ('Fallout New Vegas', 'Skate').
 */
export function resolveTitle(info: ExeVersionInfo, exeStem: string, folderName?: string): string {
  const fromInfo = cleanVersionInfoTitle(info.description) ?? cleanVersionInfoTitle(info.product)
  const fromFolder = folderName ? cleanFolderTitle(folderName) : null
  if (fromInfo && fromFolder && normalizeName(fromInfo) === normalizeName(exeStem))
    return fromFolder
  return fromInfo ?? fromFolder ?? exeStem
}

// ---------------------------------------------------------------------------
// Launch arguments
// ---------------------------------------------------------------------------

/** Split a command-line string into argv tokens: whitespace separates, "double" and 'single' quotes group, \" escapes. */
export function tokenizeArgs(input: string | undefined | null): string[] {
  const out: string[] = []
  if (!input) return out
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote) {
        quote = null
      } else if (ch === '\\' && quote === '"' && input[i + 1] === '"') {
        current += '"'
        i++
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        out.push(current)
        current = ''
        hasToken = false
      }
    } else if (ch === '\\' && input[i + 1] === '"') {
      current += '"'
      hasToken = true
      i++
    } else {
      current += ch
      hasToken = true
    }
  }
  if (hasToken) out.push(current)
  return out
}

// ---------------------------------------------------------------------------
// PowerShell: version info + icon extraction
// ---------------------------------------------------------------------------

export interface ExeInspection extends ExeVersionInfo {
  path: string
  /** Absolute path of the extracted PNG, when an icon was saved. */
  icon?: string
  iconWidth?: number
  iconHeight?: number
  /** 'png' = PNG frame copied as-is, 'ico' = DIB frame converted, 'associated' = shell icon, 'none' = PE without icons. */
  iconMethod?: string
}

interface InspectRequest {
  path: string
  /** Output PNG path, or '' to skip icon extraction. */
  icon: string
}

interface InspectRow {
  path?: string
  description?: string
  product?: string
  icon?: string
  width?: number
  height?: number
  method?: string
  error?: string
}

const INSPECT_CHUNK_SIZE = 25
const INSPECT_TIMEOUT_MS = 60_000

// Reads the first RT_GROUP_ICON of a PE file and returns its largest image: PNG frames as-is, DIB frames wrapped in a
// single-image .ico that System.Drawing can decode. C# 5 syntax: PowerShell 5.1 compiles this with the .NET 4 csc.
const ICON_CSHARP = `
using System;
using System.IO;
using System.Runtime.InteropServices;

public sealed class PlayOutIconResult
{
    public bool Loaded;
    public bool Png;
    public byte[] Data;
    public int Width;
    public int Height;
}

public static class PlayOutIcon
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr LoadLibraryExW(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool EnumResourceNamesW(IntPtr module, IntPtr type, EnumResNameProc callback, IntPtr param);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "FindResourceW")]
    static extern IntPtr FindResourceById(IntPtr module, IntPtr name, IntPtr type);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "FindResourceW")]
    static extern IntPtr FindResourceByName(IntPtr module, string name, IntPtr type);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32.dll")]
    static extern IntPtr LockResource(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern uint SizeofResource(IntPtr module, IntPtr resource);

    delegate bool EnumResNameProc(IntPtr module, IntPtr type, IntPtr name, IntPtr param);

    const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;
    const uint LOAD_LIBRARY_AS_IMAGE_RESOURCE = 0x00000020;
    static readonly IntPtr RT_ICON = (IntPtr)3;
    static readonly IntPtr RT_GROUP_ICON = (IntPtr)14;

    static byte[] ReadResource(IntPtr module, IntPtr handle)
    {
        if (handle == IntPtr.Zero) return null;
        IntPtr loaded = LoadResource(module, handle);
        if (loaded == IntPtr.Zero) return null;
        IntPtr data = LockResource(loaded);
        uint size = SizeofResource(module, handle);
        if (data == IntPtr.Zero || size == 0) return null;
        byte[] bytes = new byte[size];
        Marshal.Copy(data, bytes, 0, (int)size);
        return bytes;
    }

    public static PlayOutIconResult Largest(string path)
    {
        PlayOutIconResult result = new PlayOutIconResult();
        IntPtr module = LoadLibraryExW(path, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE);
        if (module == IntPtr.Zero) return result;
        result.Loaded = true;
        try
        {
            IntPtr firstId = IntPtr.Zero;
            string firstName = null;
            EnumResourceNamesW(module, RT_GROUP_ICON, delegate(IntPtr m, IntPtr t, IntPtr name, IntPtr p)
            {
                if (((long)name >> 16) == 0) firstId = name; else firstName = Marshal.PtrToStringUni(name);
                return false;
            }, IntPtr.Zero);
            if (firstId == IntPtr.Zero && firstName == null) return result;
            IntPtr group = firstName != null ? FindResourceByName(module, firstName, RT_GROUP_ICON) : FindResourceById(module, firstId, RT_GROUP_ICON);
            byte[] dir = ReadResource(module, group);
            if (dir == null || dir.Length < 6) return result;
            int count = BitConverter.ToUInt16(dir, 4);
            int best = -1;
            long bestArea = -1;
            int bestBits = -1;
            for (int i = 0; i < count; i++)
            {
                int o = 6 + i * 14;
                if (o + 14 > dir.Length) break;
                int w = dir[o] == 0 ? 256 : dir[o];
                int h = dir[o + 1] == 0 ? 256 : dir[o + 1];
                int bits = BitConverter.ToUInt16(dir, o + 6);
                long area = (long)w * h;
                if (area > bestArea || (area == bestArea && bits > bestBits)) { best = i; bestArea = area; bestBits = bits; }
            }
            if (best < 0) return result;
            int e = 6 + best * 14;
            byte[] image = ReadResource(module, FindResourceById(module, (IntPtr)BitConverter.ToUInt16(dir, e + 12), RT_ICON));
            if (image == null) return result;
            result.Width = dir[e] == 0 ? 256 : dir[e];
            result.Height = dir[e + 1] == 0 ? 256 : dir[e + 1];
            if (image.Length > 24 && image[0] == 0x89 && image[1] == 0x50 && image[2] == 0x4E && image[3] == 0x47)
            {
                result.Png = true;
                result.Data = image;
                result.Width = (image[16] << 24) | (image[17] << 16) | (image[18] << 8) | image[19];
                result.Height = (image[20] << 24) | (image[21] << 16) | (image[22] << 8) | image[23];
                return result;
            }
            using (MemoryStream ms = new MemoryStream())
            using (BinaryWriter bw = new BinaryWriter(ms))
            {
                bw.Write((ushort)0);
                bw.Write((ushort)1);
                bw.Write((ushort)1);
                bw.Write(dir, e, 8);
                bw.Write((uint)image.Length);
                bw.Write((uint)22);
                bw.Write(image);
                result.Data = ms.ToArray();
            }
            return result;
        }
        finally
        {
            FreeLibrary(module);
        }
    }
}
`

function inspectScript(requestFile: string): string {
  return `
Add-Type -AssemblyName System.Drawing
# PowerShell 5.1 runs in .NET 4.5 compatibility mode where Icon.ToBitmap() cannot decode PNG frames; opt out.
try { [System.AppContext]::SetSwitch('Switch.System.Drawing.DontSupportPngFramesInIcons', $false) } catch {}
$resourceReader = $true
try { Add-Type -TypeDefinition @'
${ICON_CSHARP}
'@ } catch { $resourceReader = $false }
$items = @(Get-Content -LiteralPath ${psQuote(requestFile)} -Raw -Encoding UTF8 | ConvertFrom-Json)
foreach ($item in $items) {
  $r = [ordered]@{ path = [string]$item.path; description = ''; product = ''; icon = ''; width = 0; height = 0; method = ''; error = '' }
  try {
    $vi = (Get-Item -LiteralPath $item.path -Force).VersionInfo
    $r.description = [string]$vi.FileDescription
    $r.product = [string]$vi.ProductName
  } catch { $r.error = 'version: ' + $_.Exception.Message }
  if ($item.icon) {
    try {
      $saved = $false
      if ($resourceReader) {
        $res = [PlayOutIcon]::Largest($item.path)
        if ($res.Data) {
          if ($res.Png) {
            [System.IO.File]::WriteAllBytes($item.icon, $res.Data)
            $r.width = $res.Width
            $r.height = $res.Height
            $r.method = 'png'
          } else {
            $ms = New-Object System.IO.MemoryStream(,$res.Data)
            $ico = New-Object System.Drawing.Icon($ms)
            $bmp = $ico.ToBitmap()
            $bmp.Save($item.icon, [System.Drawing.Imaging.ImageFormat]::Png)
            $r.width = $bmp.Width
            $r.height = $bmp.Height
            $r.method = 'ico'
            $bmp.Dispose()
            $ico.Dispose()
            $ms.Dispose()
          }
          $saved = $true
        } elseif ($res.Loaded) {
          # A PE file without icon resources: the shell would only offer the generic executable icon.
          $r.method = 'none'
        }
      }
      if (-not $saved -and $r.method -ne 'none') {
        $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($item.path)
        if ($ico) {
          $bmp = $ico.ToBitmap()
          $bmp.Save($item.icon, [System.Drawing.Imaging.ImageFormat]::Png)
          $r.width = $bmp.Width
          $r.height = $bmp.Height
          $r.method = 'associated'
          $bmp.Dispose()
          $ico.Dispose()
          $saved = $true
        }
      }
      if ($saved) { $r.icon = [string]$item.icon }
    } catch { $r.error = $r.error + ' icon: ' + $_.Exception.Message }
  }
  [pscustomobject]$r
}
`
}

/**
 * Read version info and extract icons for several executables in as few PowerShell runs as possible. Never throws:
 * an executable that could not be inspected gets an entry without title or icon.
 */
async function inspectExecutables(
  items: { path: string; iconPath?: string }[],
  iconDir: string,
  log: Logger
): Promise<ExeInspection[]> {
  const results = new Map<string, ExeInspection>()
  for (const item of items) results.set(normalizePath(item.path), { path: item.path })
  if (!items.length) return []
  const wantsIcons = items.some((i) => i.iconPath)
  if (wantsIcons) {
    try {
      await ensureDir(iconDir)
    } catch (err) {
      log.warn(`icon directory ${iconDir} could not be created: ${(err as Error).message}`)
    }
  }
  const requestDir =
    wantsIcons && (await isDirectory(iconDir)) ? iconDir : knownFolders().localAppData
  for (let offset = 0; offset < items.length; offset += INSPECT_CHUNK_SIZE) {
    const chunk = items.slice(offset, offset + INSPECT_CHUNK_SIZE)
    const request: InspectRequest[] = chunk.map((i) => ({ path: i.path, icon: i.iconPath ?? '' }))
    const requestFile = join(requestDir, `${newId('inspect')}.json`)
    try {
      await fs.writeFile(requestFile, JSON.stringify(request), 'utf8')
      const rows = asArray(
        await runPowerShellJson<InspectRow | InspectRow[]>(inspectScript(requestFile), {
          timeoutMs: INSPECT_TIMEOUT_MS
        })
      )
      if (!rows.length) {
        log.warn(`executable inspection returned nothing for ${chunk.length} file(s)`)
        continue
      }
      for (const row of rows) {
        if (!row || typeof row.path !== 'string') continue
        const entry = results.get(normalizePath(row.path))
        if (!entry) continue
        entry.description = row.description || undefined
        entry.product = row.product || undefined
        if (row.icon) {
          const stats = await statSafe(row.icon)
          // The media cache ignores files under 64 bytes; a PNG that small is not an image anyway.
          if (stats && stats.size >= 64) {
            entry.icon = row.icon
            entry.iconWidth = row.width
            entry.iconHeight = row.height
          }
        }
        entry.iconMethod = row.method || undefined
        if (row.error) log.debug(`inspect ${row.path}: ${row.error.trim()}`)
      }
    } catch (err) {
      log.warn(`executable inspection failed: ${(err as Error).message}`)
    } finally {
      await fs.rm(requestFile, { force: true }).catch(() => undefined)
    }
  }
  return items.map((i) => results.get(normalizePath(i.path))!)
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

function defaultIconDir(): string {
  return join(knownFolders().localAppData, 'PlayOut', 'icon-extract')
}

/** %LOCALAPPDATA%\PlayOut\icon-extract\<sha1 of the lower-cased path>.png */
export function iconPathFor(exePath: string, iconDir = defaultIconDir()): string {
  return join(iconDir, `${sha1Hex(normalizePath(exePath))}.png`)
}

function exeStem(exePath: string): string {
  return basename(exePath, extname(exePath))
}

function buildScannedGame(
  exePath: string,
  title: string,
  options: { args?: string[]; cwd?: string; installDir?: string; icon?: string }
): ScannedGame {
  const dir = dirname(exePath)
  return {
    source: 'manual',
    externalId: normalizePath(exePath),
    platformId: PC_PLATFORM.id,
    title,
    installDir: options.installDir ?? dir,
    exePath,
    launch: { kind: 'exec', file: exePath, args: options.args ?? [], cwd: options.cwd || dir },
    tracking: { mode: 'spawned' },
    localMedia: options.icon ? { icon: options.icon } : undefined
  }
}

export function createManualProvider(deps: ManualProviderDeps): ManualProvider {
  const log = deps.log
  const iconDir = deps.iconDir ?? defaultIconDir()

  async function addGame(input: ManualGameInput): Promise<ScannedGame> {
    const exePath = resolve(input.exePath.trim())
    if (!(await isFile(exePath)))
      throw new Error(tMain('mainApp.scan.exeMissing', { path: exePath }))
    if (!/\.exe$/i.test(exePath))
      log.warn(`${exePath} is not an .exe file; it will be launched directly anyway`)
    const [info] = await inspectExecutables(
      [{ path: exePath, iconPath: iconPathFor(exePath, iconDir) }],
      iconDir,
      log
    )
    const title = input.title?.trim() || resolveTitle(info, exeStem(exePath))
    const game = buildScannedGame(exePath, title, {
      args: tokenizeArgs(input.args),
      cwd: input.cwd?.trim() || undefined,
      icon: info.icon
    })
    log.info(
      `manual game ${title} -> ${exePath}${info.icon ? ` (icon ${info.iconWidth}x${info.iconHeight}, ${info.iconMethod})` : ''}`
    )
    return game
  }

  async function scanFolder(folder: string): Promise<ScannedGame[]> {
    const root = resolve(folder)
    if (!(await isDirectory(root))) {
      log.warn(`scanFolder: ${root} is not a directory`)
      return []
    }
    // One walk covers both layouts: the folder is a game itself (an exe at its root or under bin/binaries), or it
    // is a library whose direct subfolders are the games (each searched MAX_SCAN_DEPTH levels deep).
    const all = await collectExecutables(root, MAX_SCAN_DEPTH + 1)
    const rootIsGame = all.some(
      (c) =>
        c.depth === 0 ||
        (c.depth <= MAX_SCAN_DEPTH &&
          BINARY_DIR_NAMES.has(pathSegments(c.relativePath)[0].toLowerCase()))
    )
    const groups = new Map<string, { dir: string; candidates: ExeCandidate[] }>()
    if (rootIsGame) {
      groups.set(root, { dir: root, candidates: all.filter((c) => c.depth <= MAX_SCAN_DEPTH) })
    } else {
      for (const c of all) {
        if (c.depth === 0) continue
        const [first, ...rest] = c.relativePath.split('\\')
        const dir = join(root, first)
        const group = groups.get(dir) ?? { dir, candidates: [] }
        group.candidates.push({ ...c, relativePath: rest.join('\\'), depth: c.depth - 1 })
        groups.set(dir, group)
      }
    }

    const picks: { dir: string; exe: ExeCandidate }[] = []
    for (const group of groups.values()) {
      const exe = pickExecutable(basename(group.dir), group.candidates)
      if (exe) picks.push({ dir: group.dir, exe })
      else
        log.debug(
          `scanFolder: no game executable among ${group.candidates.length} file(s) in ${group.dir}`
        )
    }
    log.info(`scanFolder: ${picks.length} game(s) among ${all.length} executable(s) under ${root}`)
    if (!picks.length) return []

    const infos = await inspectExecutables(
      picks.map((p) => ({ path: p.exe.path, iconPath: iconPathFor(p.exe.path, iconDir) })),
      iconDir,
      log
    )
    return picks.map((pick, i) => {
      const info = infos[i]
      const title = resolveTitle(info, exeStem(pick.exe.path), basename(pick.dir))
      log.debug(
        `scanFolder: ${title} -> ${pick.exe.relativePath} (${Math.round(pick.exe.size / 1024)} KB) in ${pick.dir}`
      )
      return buildScannedGame(pick.exe.path, title, { installDir: pick.dir, icon: info.icon })
    })
  }

  return {
    id: 'manual',
    name: 'PC games',
    platforms: () => [PC_PLATFORM],
    async detectClient() {
      return { installed: true }
    },
    async scanInstalled(ctx) {
      // Re-validate the manual games already in the library; one whose executable disappeared is not reported, so the
      // library marks it uninstalled (it is never deleted automatically).
      const games = deps.library.games().filter((g) => g.source === 'manual')
      const result: ScannedGame[] = []
      for (const g of games) {
        if (!g.exePath) continue
        if (await isFile(g.exePath)) {
          result.push({
            source: 'manual',
            externalId: g.externalId,
            platformId: PC_PLATFORM.id,
            title: g.title,
            installDir: g.installDir,
            exePath: g.exePath,
            launch: g.launch,
            tracking: g.tracking
          })
          ctx.progress(result.length)
        } else {
          ctx.log.info(`manual game ${g.title}: executable missing at ${g.exePath}`)
        }
      }
      return result
    },
    addGame,
    scanFolder
  }
}
