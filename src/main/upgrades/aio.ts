import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { dirname, join, resolve } from 'path'
import { digestHex, type Release } from '../emulator-setup/sources'
import type { ResolvedDownload } from '../emulator-setup/types'
import { tMain } from '../i18n'

/**
 * DLSS 5 through the DLSS AiO Swapper app (github.com/machiavelli31/DLSS-AiO-Swapper, MIT): its portable exe is
 * downloaded from its GitHub releases (checked against GitHub's SHA-256 of the file) and started on its own. The app
 * takes no command-line arguments, so a game is "focused" by listing its folder in the app's library before it starts
 * (docs/research/upgrades/aio-compact.md, part A).
 */

const RELEASE_API = 'https://api.github.com/repos/machiavelli31/DLSS-AiO-Swapper/releases/latest'
const DOWNLOAD_PREFIX = 'https://github.com/machiavelli31/DLSS-AiO-Swapper/releases/download/'
const PORTABLE_EXE = /^DLSS-AiO-Swapper-[\d.]+-portable\.exe$/i
/** The folder (inside the tools folder) holding the downloaded app. */
export const AIO_FOLDER = 'DLSS-AiO-Swapper'

/** The newest DLSS AiO Swapper portable release. */
export interface AioRelease {
  /** "3.0.15". */
  version: string
  url: string
  /** Size in bytes, when GitHub gives it. */
  size: number | null
  /** GitHub's SHA-256 of the file (lower-case hex); null when GitHub has none (then it is not downloaded). */
  sha256: string | null
  /** "DLSS-AiO-Swapper-3.0.15-portable.exe". */
  fileName: string
}

/** The newest DLSS AiO Swapper portable exe from its GitHub, or null when the release has none. */
export async function latestAioSwapper(deps: {
  fetchJson: (url: string) => Promise<unknown>
}): Promise<AioRelease | null> {
  const release = (await deps.fetchJson(RELEASE_API)) as (Release & { draft?: boolean }) | null
  if (!release || typeof release !== 'object' || release.draft) return null
  const assets = Array.isArray(release.assets) ? release.assets : []
  const exe = assets.find((a) => typeof a?.name === 'string' && PORTABLE_EXE.test(a.name))
  if (!exe || typeof exe.browser_download_url !== 'string') return null
  if (!exe.browser_download_url.startsWith(DOWNLOAD_PREFIX)) return null
  const tag = (release.tag_name || release.name || '').replace(/^v/i, '')
  return {
    version: tag || /[\d.]+\d/.exec(exe.name)?.[0] || 'latest',
    url: exe.browser_download_url,
    size: typeof exe.size === 'number' && exe.size > 0 ? exe.size : null,
    sha256: digestHex(exe.digest) ?? null,
    fileName: exe.name
  }
}

async function exists(path: string): Promise<boolean> {
  return fs
    .access(path)
    .then(() => true)
    .catch(() => false)
}

/**
 * The path of the app's portable exe in `<toolsDir>\DLSS-AiO-Swapper`, downloading `release` first when that version
 * is not there. The download is checked against GitHub's SHA-256 (none published: nothing is downloaded). Older
 * versions are removed afterwards when they are not in use. Calls run one at a time (two games opening DLSS 5 at
 * once would share one download file), so a later call finds the file the earlier one downloaded.
 */
export function ensureAioSwapper(
  release: AioRelease,
  toolsDir: string,
  deps: { download: (d: ResolvedDownload, dir: string) => Promise<string> }
): Promise<string> {
  const run = ensureQueue.then(
    () => ensureNow(release, toolsDir, deps),
    () => ensureNow(release, toolsDir, deps)
  )
  ensureQueue = run.catch(() => undefined)
  return run
}

/** The ensureAioSwapper calls, one after the other. */
let ensureQueue: Promise<unknown> = Promise.resolve()

/** ensureAioSwapper's work, for one call at a time. */
async function ensureNow(
  release: AioRelease,
  toolsDir: string,
  deps: { download: (d: ResolvedDownload, dir: string) => Promise<string> }
): Promise<string> {
  if (!PORTABLE_EXE.test(release.fileName))
    throw new Error(`DLSS AiO Swapper: unexpected file name ${release.fileName}`)
  const dir = join(toolsDir, AIO_FOLDER)
  const target = join(dir, release.fileName)
  if (await exists(target)) return target
  if (!release.url.startsWith(DOWNLOAD_PREFIX))
    throw new Error(`DLSS AiO Swapper: refusing a download from outside its GitHub: ${release.url}`)
  if (!release.sha256)
    throw new Error(tMain('mainUpgrades.aio.noChecksum', { version: release.version }))
  const path = await deps.download(
    {
      version: release.version,
      url: release.url,
      fileName: release.fileName,
      sha256: release.sha256.toLowerCase(),
      size: release.size ?? undefined
    },
    dir
  )
  // Older copies go (one still running is locked and stays until next time).
  const names = await fs.readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (name.toLowerCase() === release.fileName.toLowerCase() || !PORTABLE_EXE.test(name)) continue
    await fs.rm(join(dir, name), { force: true }).catch(() => undefined)
  }
  return path
}

/** The app's library file (%APPDATA%\dlss5-swapper\library.json; the portable and installed builds share it). */
export function aioLibraryFile(appData: string = process.env.APPDATA ?? ''): string {
  return join(appData, 'dlss5-swapper', 'library.json')
}

/** The app's library when it has never run. */
const DEFAULT_LIBRARY = {
  folders: [],
  excludedRoots: [],
  manual: [],
  posters: {},
  hidden: [],
  scans: {}
}

/**
 * Adds `gameDir` to the app's hand-added games ("manual" in library.json; the file is created with the app's defaults
 * when missing). Steam games are found by the app itself and are left out. Returns false when nothing was changed
 * (already listed, a Steam folder, or an unreadable library, which is never overwritten).
 */
export async function addToAioLibrary(libraryFile: string, gameDir: string): Promise<boolean> {
  if (/[\\/]steamapps[\\/]common[\\/]/i.test(gameDir)) return false
  const dir = resolve(gameDir)
  let library: Record<string, unknown>
  const text = await fs.readFile(libraryFile, 'utf8').catch(() => null)
  if (text == null) {
    library = structuredClone(DEFAULT_LIBRARY)
  } else {
    try {
      const parsed: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
      library = parsed as Record<string, unknown>
    } catch {
      return false
    }
  }
  const manual = Array.isArray(library.manual) ? (library.manual as unknown[]) : []
  if (manual.some((p) => typeof p === 'string' && resolve(p).toLowerCase() === dir.toLowerCase()))
    return false
  library.manual = [...manual, dir]
  await fs.mkdir(dirname(libraryFile), { recursive: true })
  const part = `${libraryFile}.playout-tmp`
  await fs.writeFile(part, JSON.stringify(library, null, 2), 'utf8')
  await fs.rename(part, libraryFile)
  return true
}

/**
 * Starts a program on its own (not tied to PlayOut, no window of PlayOut's console). Resolves once it has started and
 * rejects when it cannot start (blocked by antivirus or SmartScreen, the file gone).
 */
export type SpawnDetached = (
  file: string,
  args: string[],
  options: { cwd: string }
) => Promise<void> | void

/** The real SpawnDetached: child_process detached, output ignored, unref'd; settles on its 'spawn' or 'error' event. */
export const spawnDetached: SpawnDetached = (file, args, options) =>
  new Promise<void>((resolveStart, rejectStart) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: false
      })
    } catch (err) {
      rejectStart(err)
      return
    }
    child.once('spawn', () => {
      child.unref()
      resolveStart()
    })
    // Later errors (after the start) have nobody to tell; the listener stays so they never crash PlayOut.
    child.on('error', (err) => rejectStart(err))
  })

/**
 * Opens DLSS AiO Swapper. The app takes no arguments (a second start only brings its window forward), so when
 * `installDir` is given and `deps.isAppRunning` says the app is closed, the game's folder is first added to its
 * library (the app saves its whole library over outside edits while it runs). Throws when the exe is missing or the
 * app fails to start.
 */
export async function openAioSwapper(
  exe: string,
  installDir: string | null,
  deps: {
    spawnDetached: SpawnDetached
    /** Whether the app is running now; without it the library is left alone. */
    isAppRunning?: () => Promise<boolean>
    /** Default: aioLibraryFile(). */
    libraryFile?: string
  }
): Promise<void> {
  if (!(await exists(exe))) throw new Error(tMain('mainUpgrades.aio.notDownloaded'))
  if (installDir && deps.isAppRunning) {
    const running = await deps.isAppRunning().catch(() => true)
    if (!running)
      await addToAioLibrary(deps.libraryFile ?? aioLibraryFile(), installDir).catch(() => false)
  }
  try {
    await deps.spawnDetached(exe, [], { cwd: dirname(exe) })
  } catch (err) {
    throw new Error(
      `DLSS AiO Swapper could not start (was it blocked by antivirus or SmartScreen?): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err }
    )
  }
}
