// Which file of a release is the Windows build of a recompilation. Releases ship one file per system and processor
// (Zelda64Recompiled-v1.2.2-Windows.zip beside -Linux-X64.zip, -macOS.zip, a .pdb ...), named differently from one
// project to the next and sometimes from one release to the next. In turn: the catalog's name pattern, the name of
// the file installed before (followed across versions), then a score of what each file's name says (system,
// processor, kind of file). The approach follows RecompLauncher's asset scoring and decomp-buddy's version
// following; the code is PlayOut's own.

/** A release file as GitHub (and the GitLab / Forgejo mappings) describe it. */
export interface ReleaseAsset {
  name: string
  size: number
  browser_download_url: string
  /** GitHub's "sha256:<hex>", when published. */
  digest?: string | null
}

export interface AssetHint {
  /** The catalog's Windows file: an exact name, or a pattern with * / ? wildcards. */
  pattern: string | null
  /** The file installed before (an update follows it into the new release). */
  previousName?: string | null
  /** The release that file came from. */
  previousTag?: string | null
  /** The release being picked from. */
  tag?: string | null
}

export interface PickedAsset<A extends ReleaseAsset = ReleaseAsset> {
  asset: A
  /** A setup program / Windows Installer package to run, not a portable archive. */
  installer: boolean
}

/** A setup program or Windows Installer package (left for the user to run, never run silently). */
export function isInstallerName(name: string): boolean {
  return /(setup|install(er)?)[^/\\]*\.(exe|msi)$/i.test(name) || /\.msi$/i.test(name)
}

/** `*` matches any run of characters, `?` one; case-insensitive. */
export function wildcardMatch(pattern: string, name: string): boolean {
  const source = pattern
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${source}$`, 'is').test(name)
}

/**
 * The words of a file name, lowercase: "Zelda64Recompiled-v1.2.2-Linux-X64.zip" -> zelda64recompiled, v1, 2, 2,
 * linux, x64, zip. "x86_64" / "x86-64" are one word (x64), not "x86" (32-bit) and "64".
 */
function words(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/x86[_-]64/g, 'x64')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const WINDOWS_WORDS = new Set(['windows', 'win', 'win64', 'win32', 'win10', 'win11', 'msvc', 'pc'])
const OTHER_OS_WORDS = new Set([
  // Linux
  'linux',
  'appimage',
  'ubuntu',
  'debian',
  'fedora',
  'steamdeck',
  'deck',
  'flatpak',
  // macOS
  'macos',
  'mac',
  'osx',
  'darwin',
  'apple',
  'dmg',
  'universal'
])
const ARM_WORDS = new Set(['arm64', 'aarch64', 'arm', 'armv7', 'arm32'])
const X64_WORDS = new Set(['x64', 'amd64', 'win64', '64bit'])

/** Words after the version that mark a console or phone build (a game's own name may contain "Wii", "Xbox"). */
const PLATFORM_WORDS = new Set([
  'switch',
  'switch2',
  'nx',
  'nsp',
  'xci',
  'nro',
  'android',
  'apk',
  'aab',
  'ios',
  'ipa',
  'ps3',
  'ps4',
  'ps5',
  'vita',
  'psp',
  '3ds',
  'wiiu',
  'wii',
  'xbox',
  'vpk',
  'web',
  'wasm',
  'emscripten'
])
const PLATFORM_ENDINGS = ['.apk', '.ipa', '.nsp', '.xci', '.nro', '.vpk', '.pkg', '.deb', '.rpm']

/** Compilers, SDKs and libraries some releases mirror for building the game (never the game). */
const DEPENDENCY_PREFIXES = [
  'llvm-mingw',
  'mingw-w64',
  'msys2-',
  'w64devkit',
  'vulkansdk',
  'vulkan-sdk',
  'fidelityfx-sdk',
  'dxsdk',
  'winlibs-',
  'sdl2-devel',
  'sdl3-devel'
]

/** Pieces that come beside a game (its server, editor, tools): picked only when nothing else is there. */
const SIDE_WORDS = new Set([
  'server',
  'dedicated',
  'srv',
  'editor',
  'tools',
  'toolkit',
  'sdk',
  'modkit',
  'devkit'
])

/**
 * A piece that comes beside a game, not the game: its server ("ProjectAvalanche-server-windows-x64.zip"), an editor
 * ("fm-editor-1.0-windows.zip", "KarMapEditor-1.3-windows-x64.zip", a save editor), tools or an SDK. A catalog can name
 * one by mistake as the Windows file; PlayOut takes the game instead whenever the release has one.
 */
export function isSidePiece(name: string): boolean {
  // CamelCase parts are words of their own here ("KarMapEditor": kar, map, editor).
  return words(name.replace(/([a-z0-9])([A-Z])/g, '$1-$2')).some((x) => SIDE_WORDS.has(x))
}

type FileKind = 'zip' | '7z' | 'exe' | 'msi'

/**
 * The kind of a file PlayOut can install on Windows, by its ending: zip and 7z archives (zip by PlayOut's reader,
 * 7z by 7-Zip), programs and installer packages. RAR and tarballs are left out: PlayOut cannot unpack them.
 */
function kindOf(name: string): FileKind | null {
  const n = name.toLowerCase()
  if (n.endsWith('.zip')) return 'zip'
  if (n.endsWith('.7z')) return '7z'
  if (n.endsWith('.exe')) return 'exe'
  if (n.endsWith('.msi')) return 'msi'
  return null
}

/** Debug symbols, sources, checksums, signatures and build dependencies: never the game. */
export function notABuild(name: string): boolean {
  const n = name.toLowerCase()
  if (/\.(sha256|sha512|sha1|md5|sig|asc|pdb|txt|json|sum)$/.test(n)) return true
  const w = words(name)
  if (
    w.some((x) =>
      ['symbols', 'pdb', 'debug', 'dbg', 'source', 'sources', 'src', 'devel', 'toolchain'].includes(
        x
      )
    )
  )
    return true
  return DEPENDENCY_PREFIXES.some((p) => n.startsWith(p))
}

/** Built for an ARM processor only (PlayOut runs on x64 Windows). */
function armOnly(name: string): boolean {
  const w = words(name)
  return w.some((x) => ARM_WORDS.has(x)) && !w.some((x) => X64_WORDS.has(x))
}

/** Its name says another system and not Windows. */
function otherOs(name: string): boolean {
  const w = words(name)
  return w.some((x) => OTHER_OS_WORDS.has(x)) && !w.some((x) => WINDOWS_WORDS.has(x))
}

/** A console or phone build: by its ending, or by a platform word after the version number. */
function forOtherPlatform(name: string): boolean {
  const n = name.toLowerCase()
  if (PLATFORM_ENDINGS.some((e) => n.endsWith(e))) return true
  const version = /(?:^|[^a-z0-9])v?\d+(?:\.\d+)+|(?:^|[^a-z0-9])v\d+/.exec(n)
  if (!version) return false
  return words(n.slice(version.index + version[0].length)).some((x) => PLATFORM_WORDS.has(x))
}

/**
 * How good a Windows x64 build `name` looks (higher is better), or null when it is not one at all. Every usable
 * file scores above zero, so a lone "Game-Setup.exe" with no system in its name still counts.
 */
export function scoreWindowsAsset(name: string): number | null {
  const kind = kindOf(name)
  if (!kind) return null
  if (notABuild(name) || armOnly(name) || otherOs(name) || forOtherPlatform(name)) return null
  const w = words(name)
  let score = 1000
  if (w.some((x) => WINDOWS_WORDS.has(x))) score += 50
  if (w.some((x) => X64_WORDS.has(x))) score += 20
  if (w.some((x) => ['setup', 'installer', 'install'].includes(x))) score -= 15
  if (isSidePiece(name)) score -= 60
  score += { zip: 12, '7z': 10, exe: 6, msi: 2 }[kind]
  return score
}

/** Usable as a Windows build at all (the pattern stage only drops what can never run here). */
function usable(name: string): boolean {
  return kindOf(name) !== null && !notABuild(name) && !armOnly(name) && !forOtherPlatform(name)
}

/**
 * A file name (or a catalog's wildcard pattern) that can never be a Windows x64 build: a phone or console package
 * (.apk, .ipa, ...), a Linux or macOS package (.AppImage, .dmg, .deb, ...) or an ARM-only build. Archives that merely
 * name another system ("-universal.zip") are not ruled out here.
 */
export function notForWindows(name: string): boolean {
  return (
    /\.(?:appimage|dmg|flatpak|snap|deb|rpm)$/i.test(name.trim()) ||
    armOnly(name) ||
    forOtherPlatform(name)
  )
}

/** Separators made one: GitHub turns spaces into dots, and projects switch between . - _ across releases. */
function sameSeparators(s: string): string {
  return s.replace(/[._ ]/g, '-')
}

/** Two names alike but for their numbers: each digit run of one is a digit run of the other. */
function sameShape(a: string, b: string): boolean {
  const parts = (s: string): string[] => s.toLowerCase().match(/\d+|\D+/g) ?? []
  const x = parts(a)
  const y = parts(b)
  return (
    x.length === y.length &&
    x.every((p, i) => {
      const q = y[i]!
      const digits = /^\d/.test(p)
      return digits === /^\d/.test(q) && (digits || p === q)
    })
  )
}

/**
 * The files the catalog's pattern means in this release: a wildcard match; else the same with separators made one;
 * else (an exact name with numbers in it, written for another release) the same name with other numbers.
 */
function byPattern<A extends ReleaseAsset>(assets: A[], pattern: string): A[] {
  const exact = assets.filter((a) => wildcardMatch(pattern, a.name))
  if (exact.length) return exact
  const loose = assets.filter((a) => wildcardMatch(sameSeparators(pattern), sameSeparators(a.name)))
  if (loose.length || /[*?]/.test(pattern) || !/\d/.test(pattern)) return loose
  return assets.filter((a) => sameShape(pattern, a.name))
}

/** A name with its version numbers and commit ids made '#' (for comparing names across releases). */
function looseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/(?<![0-9a-z])g?(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![0-9a-z])/g, '#')
    .replace(/\d+([._-]\d+)*/g, '#')
}

/**
 * The file of a newer release that is what `oldName` (from release `oldTag`) was: the same name; else the old name
 * with the old version swapped for another version-shaped string; else the same name but for its numbers and commit
 * ids; else (codename releases, "SoH-Ackbar-Delta-Win64.zip" -> "SoH-Blair-Alfa-Win64.zip") the same first and last
 * '-' part. Every guess counts only when exactly one file fits.
 */
export function followAsset<A extends ReleaseAsset>(
  oldName: string,
  oldTag: string | null | undefined,
  assets: A[]
): A | null {
  const exact =
    assets.find((a) => a.name === oldName) ??
    assets.find((a) => a.name.toLowerCase() === oldName.toLowerCase())
  if (exact) return exact
  const one = (hits: A[]): A | null => (hits.length === 1 ? hits[0]! : null)
  const bare = String(oldTag ?? '').replace(/^[^0-9]*/, '')
  if (bare && oldName.includes(bare)) {
    const at = oldName.indexOf(bare)
    const pre = oldName.slice(0, at)
    const post = oldName.slice(at + bare.length)
    const hit = one(
      assets.filter(
        (a) =>
          a.name.length > pre.length + post.length &&
          a.name.startsWith(pre) &&
          a.name.endsWith(post) &&
          /^[0-9][0-9A-Za-z.+_-]*$/.test(a.name.slice(pre.length, a.name.length - post.length))
      )
    )
    if (hit) return hit
  }
  const want = looseName(oldName)
  const loose = one(assets.filter((a) => looseName(a.name) === want))
  if (loose) return loose
  const ends = (n: string): string | null => {
    const p = n.toLowerCase().split('-')
    return p.length >= 3 ? `${p[0]}|${p[p.length - 1]}` : null
  }
  const wantEnds = ends(oldName)
  return wantEnds ? one(assets.filter((a) => ends(a.name) === wantEnds)) : null
}

/** Of equally good files, the one whose name shares the most (non-number) words with `before`. */
function mostLike<A extends ReleaseAsset>(list: A[], before: string | null | undefined): A {
  if (!before || list.length === 1) return list[0]!
  const had = new Set(words(before).filter((w) => !/^v?\d+$/.test(w)))
  let best = list[0]!
  let bestCount = -1
  for (const a of list) {
    const count = words(a.name).filter((w) => had.has(w)).length
    if (count > bestCount) {
      best = a
      bestCount = count
    }
  }
  return best
}

/**
 * The best-scoring of `list` (ties: the one most like the file installed before, then the largest, as the full game
 * usually is, then by name).
 */
function best<A extends ReleaseAsset>(list: A[], hint: AssetHint): A | null {
  const scored = list
    .map((a) => ({ a, s: scoreWindowsAsset(a.name) }))
    .filter((x): x is { a: A; s: number } => x.s !== null)
  if (!scored.length) return null
  const top = Math.max(...scored.map((x) => x.s))
  const tied = scored
    .filter((x) => x.s === top)
    .map((x) => x.a)
    .sort((x, y) => (y.size || 0) - (x.size || 0) || x.name.localeCompare(y.name))
  return mostLike(tied, hint.previousName ?? hint.pattern)
}

/** The release's own game build when `name` is a side piece (its server, an editor ...) and the release has one. */
function gameInstead<A extends ReleaseAsset>(name: string, assets: A[], hint: AssetHint): A | null {
  if (!isSidePiece(name)) return null
  return best(
    assets.filter((a) => !isSidePiece(a.name)),
    hint
  )
}

/**
 * The Windows x64 build of a release, or null when it has none. In turn: the catalog's pattern (only files that can
 * run on Windows; the best of several), the file installed before followed into this release, then the best score
 * over every file.
 */
export function pickWindowsAsset<A extends ReleaseAsset>(
  assets: A[],
  hint: AssetHint
): PickedAsset<A> | null {
  const done = (asset: A | null): PickedAsset<A> | null =>
    asset ? { asset, installer: isInstallerName(asset.name) } : null
  const pattern = hint.pattern?.trim()
  if (pattern) {
    const named = byPattern(assets, pattern).filter((a) => usable(a.name))
    if (named.length) {
      // Prefer what the scorer likes; a pattern naming a file whose name says another OS still wins over nothing.
      const picked = best(named, hint) ?? mostLike(named, hint.previousName)
      // A catalog naming the game's server or editor by mistake: the game itself, when the release has it.
      return done(gameInstead(picked.name, assets, hint) ?? picked)
    }
  }
  if (hint.previousName) {
    const followed = followAsset(
      hint.previousName,
      hint.previousTag,
      assets.filter((a) => usable(a.name))
    )
    if (followed && scoreWindowsAsset(followed.name) !== null)
      // A side piece installed before (from such a catalog) is not followed when the game is there.
      return done(gameInstead(followed.name, assets, hint) ?? followed)
  }
  // The game before any side piece, however their names score.
  return done(
    best(
      assets.filter((a) => !isSidePiece(a.name)),
      hint
    ) ?? best(assets, hint)
  )
}
