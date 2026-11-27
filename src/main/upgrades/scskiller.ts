import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { dirname, join, resolve } from 'path'
import { StringDecoder } from 'string_decoder'
import { digestHex, type Release } from '../emulator-setup/sources'
import type { ResolvedDownload } from '../emulator-setup/types'
import { tMain } from '../i18n'

/**
 * Shader precompiling through SCSKiller's command line (github.com/BlueHeisenberg/SCSKiller, GPL; PlayOut only drives
 * its exe, docs/research/upgrades/scskiller.md). The portable build is kept unpacked as released (the command line in
 * current\cli finds its tools in ..\native and its data folder beside the .portable marker), its recorder is kept off,
 * and `compile <id>` is streamed into progress lines for the player.
 */

const RELEASE_API = 'https://api.github.com/repos/BlueHeisenberg/SCSKiller/releases/latest'
const DOWNLOAD_PREFIX = 'https://github.com/BlueHeisenberg/SCSKiller/releases/download/'
/** The portable build (the plain SCSKiller.zip refuses to run outside a development setup). */
const PORTABLE_ZIP = /^SCSKiller-[\d.]+-Portable\.zip$/i
const SUMS_FILE = 'SHA256SUMS-unsigned.txt'
/** The folder (inside the tools folder) holding the unpacked portable build. */
export const SCSKILLER_FOLDER = 'SCSKiller'
/** Records which release is unpacked in the SCSKiller folder. */
const VERSION_MARKER = '.playout-version'

/** The newest SCSKiller portable release. */
export interface ScsKillerRelease {
  /** "1.4.8". */
  version: string
  zipUrl: string
  /** The release's SHA256SUMS-unsigned.txt, null when the release has none. */
  sumsUrl: string | null
  /** "SCSKiller-1.4.8-Portable.zip". */
  fileName: string
  /** Size in bytes, when GitHub gives it. */
  size: number | null
  /** The zip's SHA-256 from GitHub (the asset digest, else the release notes' checksum list), lower-case hex. */
  sha256: string | null
}

interface ReleaseWithBody extends Release {
  body?: string | null
  draft?: boolean
}

/** The `<hex>  <name>` line for `fileName` in a sha256sum-style list (case-insensitive name, `*` binary marks too). */
export function checksumFor(text: string, fileName: string): string | null {
  const want = fileName.toLowerCase()
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(raw)
    if (!m) continue
    const name = m[2]!.replace(/\\/g, '/').toLowerCase()
    if (name === want || name.endsWith(`/${want}`)) return m[1]!.toLowerCase()
  }
  return null
}

/** The newest SCSKiller portable release from its GitHub, or null when the release has no portable zip. */
export async function latestScsKiller(deps: {
  fetchJson: (url: string) => Promise<unknown>
}): Promise<ScsKillerRelease | null> {
  const release = (await deps.fetchJson(RELEASE_API)) as ReleaseWithBody | null
  if (!release || typeof release !== 'object' || release.draft) return null
  const assets = Array.isArray(release.assets) ? release.assets : []
  const zip = assets.find((a) => typeof a?.name === 'string' && PORTABLE_ZIP.test(a.name))
  if (!zip || typeof zip.browser_download_url !== 'string') return null
  if (!zip.browser_download_url.startsWith(DOWNLOAD_PREFIX)) return null
  const sums = assets.find((a) => a?.name === SUMS_FILE)
  const tag = release.tag_name || release.name || ''
  const version = tag.replace(/^v/i, '') || /[\d.]+\d/.exec(zip.name)?.[0] || 'latest'
  const sumsUrl =
    sums && typeof sums.browser_download_url === 'string'
      ? sums.browser_download_url.startsWith(DOWNLOAD_PREFIX)
        ? sums.browser_download_url
        : null
      : null
  return {
    version,
    zipUrl: zip.browser_download_url,
    sumsUrl,
    fileName: zip.name,
    size: typeof zip.size === 'number' && zip.size > 0 ? zip.size : null,
    sha256:
      digestHex(zip.digest) ??
      (typeof release.body === 'string' ? checksumFor(release.body, zip.name) : null)
  }
}

async function exists(path: string): Promise<boolean> {
  return fs
    .access(path)
    .then(() => true)
    .catch(() => false)
}

/** The command line's path inside an unpacked portable build. */
export function scsKillerExe(root: string): string {
  return join(root, 'current', 'cli', 'scskiller.exe')
}

/** SCSKiller's data folder for a portable build's command line (`<root>\data`, beside the .portable marker). */
export function scsKillerDataDir(exe: string): string {
  return join(resolve(dirname(exe), '..', '..'), 'data')
}

/** The name of the folder an earlier SCSKiller install is moved to while an update swaps folders. */
const OLD_SUFFIX = '.old'

/**
 * Renames a folder, trying again for a moment while Windows still holds it (antivirus scanning a folder that was just
 * moved, a closing program); a lasting lock still fails.
 */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

/**
 * Finishes or undoes a folder swap an earlier ensureScsKiller left half done (PlayOut closed, a lock that outlived a
 * rollback): with no install folder the moved-away install goes back; with both, a data folder still in the old one is
 * moved into the install, then the old folder goes. Never deletes a folder that still holds SCSKiller's data.
 */
async function recoverSwap(root: string, old: string): Promise<void> {
  if (!(await exists(old))) return
  if (!(await exists(root))) {
    await renameRetry(old, root)
    return
  }
  if (await exists(join(old, 'data'))) {
    if (await exists(join(root, 'data'))) return // Both have data: keep both, nothing is deleted.
    await renameRetry(join(old, 'data'), join(root, 'data'))
  }
  await fs.rm(old, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * The path of SCSKiller's command line, downloading and unpacking `release` into `<toolsDir>\SCSKiller` first when
 * that version is not there yet. The zip's SHA-256 must match the GitHub checksum (asset digest / release notes) and
 * SHA256SUMS-unsigned.txt when that lists the zip (it normally lists only SCSKiller.zip; when it cannot be fetched the
 * GitHub checksum is used alone); with neither checksum, nothing is downloaded. The zip is unpacked as released (cli
 * needs ..\native, the data folder sits beside .portable). On an update the old install is first renamed away (which
 * fails cleanly while SCSKiller runs), the new one put in its place and SCSKiller's data folder moved over; any failure
 * puts the old install back, and the data folder is never deleted. Calls run one at a time (two games precompiling at
 * once share the staging folders), so a later call finds the version the earlier one put in and downloads nothing.
 */
export function ensureScsKiller(
  release: ScsKillerRelease,
  toolsDir: string,
  deps: EnsureScsKillerDeps
): Promise<string> {
  const run = ensureQueue.then(
    () => ensureNow(release, toolsDir, deps),
    () => ensureNow(release, toolsDir, deps)
  )
  ensureQueue = run.catch(() => undefined)
  return run
}

/** What ensureScsKiller needs from outside. */
export interface EnsureScsKillerDeps {
  download: (d: ResolvedDownload, dir: string) => Promise<string>
  fetchText: (url: string) => Promise<string>
  extractZip: (zip: string, destDir: string) => Promise<void>
  sha256: (file: string) => Promise<string>
}

/** The ensureScsKiller calls, one after the other. */
let ensureQueue: Promise<unknown> = Promise.resolve()

/** ensureScsKiller's work, for one call at a time. */
async function ensureNow(
  release: ScsKillerRelease,
  toolsDir: string,
  deps: EnsureScsKillerDeps
): Promise<string> {
  const root = join(toolsDir, SCSKILLER_FOLDER)
  const old = `${root}${OLD_SUFFIX}`
  const exe = scsKillerExe(root)
  await recoverSwap(root, old)
  const marker = await fs.readFile(join(root, VERSION_MARKER), 'utf8').catch(() => '')
  if (marker.trim() === release.version && (await exists(exe))) return exe

  if (!release.zipUrl.startsWith(DOWNLOAD_PREFIX))
    throw new Error(`SCSKiller: refusing a download from outside its GitHub: ${release.zipUrl}`)
  const github = release.sha256?.toLowerCase() ?? null
  let sums: string | null = null
  if (release.sumsUrl) {
    try {
      sums = await deps.fetchText(release.sumsUrl)
    } catch (err) {
      // The list normally names only SCSKiller.zip, so the GitHub checksum is enough when there is one.
      if (!github) throw err
    }
  }
  const listed = sums != null ? checksumFor(sums, release.fileName) : null
  if (listed && github && listed !== github)
    throw new Error(
      `SCSKiller ${release.version}: the published checksums of ${release.fileName} disagree`
    )
  const expected = listed ?? github
  if (!expected)
    throw new Error(
      `SCSKiller ${release.version}: no checksum is published for ${release.fileName}`
    )

  const staging = join(toolsDir, `${SCSKILLER_FOLDER}.download`)
  const unpacked = join(toolsDir, `${SCSKILLER_FOLDER}.new`)
  await fs.rm(staging, { recursive: true, force: true })
  await fs.rm(unpacked, { recursive: true, force: true })
  try {
    const zip = await deps.download(
      {
        version: release.version,
        url: release.zipUrl,
        fileName: release.fileName,
        sha256: expected,
        size: release.size ?? undefined
      },
      staging
    )
    const actual = (await deps.sha256(zip)).toLowerCase()
    if (actual !== expected)
      throw new Error(`SCSKiller ${release.version}: ${release.fileName} failed its checksum check`)
    await deps.extractZip(zip, unpacked)
    if (
      !(await exists(scsKillerExe(unpacked))) ||
      !(await exists(join(unpacked, 'current', 'native')))
    )
      throw new Error(
        `SCSKiller ${release.version}: the download is not the portable build expected`
      )
    await swapIn(unpacked, root, old, release.version)
    await fs.writeFile(join(root, VERSION_MARKER), release.version, 'utf8')
    return exe
  } finally {
    // Neither folder ever holds SCSKiller's data here: it is only moved between the old and the new install.
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(unpacked, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Puts the unpacked build in place of the install at `root`, keeping SCSKiller's own state (its settings with the
 * recorder off, scan caches, per-game compile records): root -> old, unpacked -> root, old\data -> root\data, then old
 * is removed. A failure puts the old install back where it can; the data folder is only ever renamed, never deleted.
 */
async function swapIn(unpacked: string, root: string, old: string, version: string): Promise<void> {
  const busy = (err: unknown): Error =>
    new Error(
      tMain('mainUpgrades.shaders.installBusy', {
        version,
        error: err instanceof Error ? err.message : String(err)
      })
    )
  const hadRoot = await exists(root)
  if (hadRoot) {
    try {
      await renameRetry(root, old)
    } catch (err) {
      throw busy(err)
    }
  }
  try {
    await renameRetry(unpacked, root)
  } catch (err) {
    if (hadRoot) await renameRetry(old, root).catch(() => undefined)
    throw busy(err)
  }
  if (!hadRoot) return
  const oldData = join(old, 'data')
  if (await exists(oldData)) {
    try {
      await fs.rm(join(root, 'data'), { recursive: true, force: true })
      await renameRetry(oldData, join(root, 'data'))
    } catch (err) {
      // Undo: the new build goes back to the staging folder and the old install (data and all) returns.
      try {
        await renameRetry(root, unpacked)
        await renameRetry(old, root)
      } catch {
        throw new Error(tMain('mainUpgrades.shaders.installFailedKept', { version, folder: old }))
      }
      throw busy(err)
    }
  }
  await fs.rm(old, { recursive: true, force: true }).catch(() => undefined)
}

/** The file operations disableRecorder uses (tests pass fakes; the default is the real file system). */
export interface RecorderSettingsIo {
  readFile(path: string): Promise<string | null>
  writeFile(path: string, text: string): Promise<void>
}

const realSettingsIo: RecorderSettingsIo = {
  readFile: (path) => fs.readFile(path, 'utf8').catch(() => null),
  async writeFile(path, text) {
    const part = `${path}.playout-tmp`
    await fs.writeFile(part, text, 'utf8')
    await fs.rename(part, path)
  }
}

/**
 * Turns off SCSKiller's "Record in all compatible games" switch (RecordAllGames false, WelcomeSeen true) in
 * `<stateDir>\settings.json`, so its recorder never goes into games even if its app is opened. The command line never
 * installs recorders itself. The file is patched in place (its other fields kept); a missing or unreadable file is left
 * alone. `stateDir` defaults to the installed build's folder (%LOCALAPPDATA%\SCSKiller); PlayOut's portable copy keeps
 * its state in scsKillerDataDir(exe).
 */
export async function disableRecorder(
  stateDir: string = join(process.env.LOCALAPPDATA ?? '', 'SCSKiller'),
  io: RecorderSettingsIo = realSettingsIo
): Promise<void> {
  const file = join(stateDir, 'settings.json')
  const text = await io.readFile(file)
  if (text == null) return
  let settings: unknown
  try {
    settings = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return
  const obj = settings as Record<string, unknown>
  if (obj.RecordAllGames === false && obj.WelcomeSeen === true) return
  obj.RecordAllGames = false
  obj.WelcomeSeen = true
  await io.writeFile(file, JSON.stringify(obj, null, 2))
}

/** A running command-line tool: its exit code (null when it could not start or was killed), and a tree kill. */
export interface ToolProcess {
  exited: Promise<number | null>
  /** Kills the program and every process it started. */
  killTree(): void
}

/** Starts a program without a shell and hands over its output line by line. */
export type SpawnTool = (
  file: string,
  args: string[],
  options: { cwd: string; onLine: (line: string, stream: 'stdout' | 'stderr') => void }
) => ToolProcess

/** Splits a stream's chunks into lines (CRLF, LF or a bare CR as console progress uses), UTF-8 decoded. */
export function lineSplitter(onLine: (line: string) => void): {
  push(chunk: Buffer): void
  end(): void
} {
  const decoder = new StringDecoder('utf8')
  let rest = ''
  const flush = (text: string): void => {
    rest += text
    // A CR at the very end may be the first half of a CRLF split across chunks: it waits for the next chunk.
    const parts = rest.split(/\r\n|\n|\r(?!$)/)
    rest = parts.pop() ?? ''
    for (const part of parts) onLine(part)
  }
  return {
    push: (chunk) => flush(decoder.write(chunk)),
    end() {
      flush(decoder.end())
      rest = rest.replace(/\r$/, '')
      if (rest) onLine(rest)
      rest = ''
    }
  }
}

/** The real SpawnTool: child_process without a shell, hidden window, `taskkill /T /F` for the tree kill. */
export const spawnTool: SpawnTool = (file, args, options) => {
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(file, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    options.onLine((err as Error).message, 'stderr')
    return { exited: Promise.resolve(null), killTree: () => undefined }
  }
  const out = lineSplitter((line) => options.onLine(line, 'stdout'))
  const errs = lineSplitter((line) => options.onLine(line, 'stderr'))
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => errs.push(chunk))
  const exited = new Promise<number | null>((resolveExit) => {
    let done = false
    child.on('error', (err) => {
      if (done) return
      done = true
      options.onLine(err.message, 'stderr')
      resolveExit(null)
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      out.end()
      errs.end()
      resolveExit(code)
    })
  })
  return {
    exited,
    killTree() {
      const pid = child.pid
      if (process.platform === 'win32' && pid) {
        try {
          const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
            windowsHide: true,
            shell: false,
            stdio: 'ignore'
          })
          // taskkill that cannot start, or that ends without killing the tree, falls back to killing the program.
          killer.on('error', () => child.kill('SIGKILL'))
          killer.on('exit', (code) => {
            if (code !== 0) child.kill('SIGKILL')
          })
          return
        } catch {
          /* fall through */
        }
      }
      child.kill('SIGKILL')
    }
  }
}

/** The game to precompile. */
export interface ShaderTarget {
  /** Steam games: the appid (SCSKiller's id is then steam:<appid>). */
  steamAppId?: string
  installDir: string
  title: string
  /** Other games: the game's exe, so SCSKiller can add it by hand (`add <exe> <folder>`). */
  exePath?: string
}

/** What compileShaders ends with. */
export interface ShaderResult {
  ok: boolean
  message: string
  /** SCSKiller cannot precompile this game (or anything on this graphics card). */
  unsupported?: boolean
}

/** One parsed `compile` progress line. */
export interface CompileLine {
  gameId: string
  stage: string
  /** Done / total of the stage, when the line has them. */
  done: number | null
  total: number | null
  /** Percent of the stage (Planning, Materializing, Merging), when the line has one. */
  percent: number | null
  failed: number | null
  /** The text after " - " (an error on Failed, a note on Waiting / Paused). */
  note: string | null
}

const STAGES = new Set([
  'Waiting',
  'Indexing',
  'Planning',
  'Materializing',
  'Warming',
  'Merging',
  'Paused',
  'Done',
  'Failed',
  'Stopped',
  'Saving',
  'Finishing'
])

/** Parses `HH:mm:ss <gameId> <Stage><details>`; null for any other line. */
export function parseCompileLine(line: string): CompileLine | null {
  const m = /^\s*\d{1,2}:\d\d:\d\d\s+(\S+)\s+([A-Za-z]+)(.*)$/.exec(line)
  if (!m || !STAGES.has(m[2]!)) return null
  const rest = m[3]!
  const counts = /(\d+)\/(\d+)/.exec(rest)
  const percent = /(\d+(?:[.,]\d+)?)%/.exec(rest)
  const failed = /\((\d+) failed/.exec(rest)
  const dash = rest.indexOf(' - ')
  return {
    gameId: m[1]!,
    stage: m[2]!,
    done: counts ? Number(counts[1]) : null,
    total: counts ? Number(counts[2]) : null,
    percent: percent ? Number(percent[1]!.replace(',', '.')) : null,
    failed: failed ? Number(failed[1]) : null,
    note: dash >= 0 ? rest.slice(dash + 3).trim() || null : null
  }
}

/** Where each stage sits on the whole compile's bar (Warming is the long part). */
const STAGE_SPAN: Record<string, [number, number]> = {
  Indexing: [0, 0.05],
  Planning: [0.05, 0.15],
  Materializing: [0.15, 0.25],
  Warming: [0.25, 0.95],
  Merging: [0.95, 0.98],
  Saving: [0.98, 0.99],
  Finishing: [0.99, 1],
  Done: [1, 1]
}

const count = (n: number): string => n.toLocaleString('en-US')

/** The whole compile's progress (0..1) at a line, or null when the line says nothing about it. */
export function compileProgress(line: CompileLine): number | null {
  const span = STAGE_SPAN[line.stage]
  if (!span) return null
  let within = 0
  if (line.percent != null) within = line.percent / 100
  else if (line.done != null && line.total) within = line.done / line.total
  within = Math.min(1, Math.max(0, within))
  return span[0] + (span[1] - span[0]) * within
}

/** A plain-English line for the player. */
export function compileMessage(line: CompileLine): string {
  // Whole sentences per case (with or without the percent, the counts or the failures), never glued pieces.
  const percent = line.percent != null ? Math.round(line.percent) : null
  const withPercent = (key: string, keyPercent: string): string =>
    percent != null ? tMain(keyPercent, { percent }) : tMain(key)
  const counted = line.done != null && line.total != null
  switch (line.stage) {
    case 'Waiting':
      return line.note
        ? tMain('mainUpgrades.compile.waitingWhy', { note: line.note })
        : tMain('mainUpgrades.compile.waiting')
    case 'Indexing':
      return counted
        ? tMain('mainUpgrades.compile.indexingCount', {
            done: count(line.done!),
            total: count(line.total!)
          })
        : tMain('mainUpgrades.compile.indexing')
    case 'Planning':
      return withPercent('mainUpgrades.compile.planning', 'mainUpgrades.compile.planningPercent')
    case 'Materializing':
      return withPercent('mainUpgrades.compile.preparing', 'mainUpgrades.compile.preparingPercent')
    case 'Warming':
      if (!counted) return tMain('mainUpgrades.compile.compiling')
      return line.failed
        ? tMain('mainUpgrades.compile.compilingCountFailed', {
            done: count(line.done!),
            total: count(line.total!),
            failed: count(line.failed)
          })
        : tMain('mainUpgrades.compile.compilingCount', {
            done: count(line.done!),
            total: count(line.total!)
          })
    case 'Merging':
      return withPercent('mainUpgrades.compile.merging', 'mainUpgrades.compile.mergingPercent')
    case 'Saving':
      return tMain('mainUpgrades.compile.saving')
    case 'Finishing':
      return tMain('mainUpgrades.compile.finishing')
    case 'Paused': {
      const why = line.note?.replace(/^paused\s*/i, '')
      return why
        ? tMain('mainUpgrades.compile.pausedWhy', { why })
        : tMain('mainUpgrades.compile.paused')
    }
    case 'Done':
      if (line.done == null) return tMain('mainUpgrades.compile.done')
      return line.failed
        ? tMain('mainUpgrades.compile.doneCountFailed', {
            done: count(line.done),
            failed: count(line.failed)
          })
        : tMain('mainUpgrades.compile.doneCount', { done: count(line.done) })
    case 'Failed':
      return line.note
        ? tMain('mainUpgrades.compile.failedWhy', { note: line.note })
        : tMain('mainUpgrades.compile.failed')
    case 'Stopped':
      return tMain('mainUpgrades.compile.stopped')
    default:
      return line.stage
  }
}

/** Error texts meaning SCSKiller cannot do this game (or this PC) at all. */
const UNSUPPORTED_TEXT =
  /not supported|aren't supported|isn't supported|unsupported|can't reach this game|no shaders it can compile|no game matches|encrypted game files/i

/**
 * SCSKiller's `error: …` text without the prefix (`fromError` true), else the last non-empty line, which may be one
 * of its diagnostic log lines and so never decides that a game is unsupported.
 */
function errorText(lines: string[]): { text: string; fromError: boolean } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*error:\s*(.+)$/i.exec(lines[i]!)
    if (m) return { text: m[1]!.trim(), fromError: true }
  }
  const last = lines.map((l) => l.trim()).filter(Boolean)
  return last.length ? { text: last[last.length - 1]!, fromError: false } : null
}

/** The `GPU: <name>, driver <v> (<profile>)` line's profile. */
export function parseGpuProfile(stdout: string[]): string | null {
  for (const line of stdout) {
    const m = /^\s*GPU:.*\(([^()]*)\)\s*$/.exec(line)
    if (m) return m[1]!.trim()
  }
  return null
}

/** `status <id>`: the game's install folder and status ("Ready") with its reason. */
export function parseGameStatus(stdout: string[]): {
  install: string | null
  status: string | null
  reason: string | null
} {
  let install: string | null = null
  let status: string | null = null
  let reason: string | null = null
  for (const line of stdout) {
    const s = /^\s+status\s+([A-Za-z]+)(?::\s*(.*))?$/.exec(line)
    if (s && status == null) {
      status = s[1]!
      reason = s[2]?.trim() || null
      continue
    }
    const i = /^\s+install\s+(.+)$/.exec(line)
    if (i && install == null) install = i[1]!.trim()
  }
  return { install, status, reason }
}

/** The rows of `scan` / `status`: status name, id and name. */
export function parseGameRows(stdout: string[]): { status: string; id: string; name: string }[] {
  const rows: { status: string; id: string; name: string }[] = []
  for (const line of stdout) {
    const m = /^(\S+)\s+(\S+)\s+(.*?)((?: {2}\[[^\]]*\])*) {2}- (.*)$/.exec(line)
    if (m) rows.push({ status: m[1]!, id: m[2]!, name: m[3]!.trim() })
  }
  return rows
}

const samePath = (a: string, b: string): boolean =>
  resolve(a)
    .replace(/[\\/]+$/, '')
    .toLowerCase() ===
  resolve(b)
    .replace(/[\\/]+$/, '')
    .toLowerCase()

const simpleName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const CANCELLED: ShaderResult = { ok: false, message: 'Cancelled' }

/** How long a cancel waits for the killed process tree to end before returning anyway. */
const KILL_WAIT_MS = 5000

/**
 * Precompiles one game's shaders with SCSKiller's command line: `scan`, the recorder switched off, the game's id
 * (steam:<appid>; else the scanned game with the same name and install folder, store games included; else, only when
 * no scanned game matches, `add <exe> <folder>` when the exe is known), `status <id>`, then `compile <id>` with its
 * output turned into progress. Games SCSKiller cannot do come back with `unsupported: true` (decided only from its
 * `error:` lines, Failed notes and statuses, never from a plain log line). Aborting `signal` kills the process tree
 * (the driver may lose the compile in flight) and comes back as Cancelled within a few seconds even when the tree
 * lingers. The recorder switch is written through `deps.settingsIo` (default: the real file system). Never rejects.
 */
export async function compileShaders(
  exe: string,
  target: ShaderTarget,
  onProgress: (p: { progress: number | null; message: string }) => void,
  signal: AbortSignal,
  deps: {
    spawn: SpawnTool
    /** The file access for SCSKiller's settings.json (default: the real file system). */
    settingsIo?: RecorderSettingsIo
    /** How long a cancel waits for the killed tree to end (default 5 seconds). */
    killWaitMs?: number
  }
): Promise<ShaderResult> {
  const cwd = dirname(exe)
  const run = async (
    args: string[],
    onStdout?: (line: string) => void
  ): Promise<{ code: number | null; stdout: string[]; stderr: string[]; aborted: boolean }> => {
    const stdout: string[] = []
    const stderr: string[] = []
    if (signal.aborted) return { code: null, stdout, stderr, aborted: true }
    const proc = deps.spawn(exe, args, {
      cwd,
      onLine(line, stream) {
        if (stream === 'stderr') {
          if (stderr.length < 2000) stderr.push(line)
          return
        }
        if (stdout.length < 20000) stdout.push(line)
        onStdout?.(line)
      }
    })
    // A cancel kills the tree and stops waiting a little later even if the program (or a child holding its output)
    // lives on.
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const gaveUp = new Promise<null>((resolveWait) => {
      onAbort = (): void => {
        proc.killTree()
        timer = setTimeout(() => resolveWait(null), deps.killWaitMs ?? KILL_WAIT_MS)
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const code = await Promise.race([proc.exited, gaveUp])
      return { code, stdout, stderr, aborted: signal.aborted }
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
      if (timer) clearTimeout(timer)
    }
  }
  const failure = (what: string, r: { stdout: string[]; stderr: string[] }): ShaderResult => {
    const found = errorText(r.stderr) ?? errorText(r.stdout)
    const text = found?.text ?? tMain('mainUpgrades.compile.noDetails')
    return found?.fromError && UNSUPPORTED_TEXT.test(text)
      ? { ok: false, unsupported: true, message: text }
      : { ok: false, message: tMain('mainUpgrades.compile.failure', { what, text }) }
  }

  try {
    onProgress({ progress: null, message: tMain('mainUpgrades.compile.lookingForGame') })
    const scan = await run(['scan'])
    if (scan.aborted) return CANCELLED
    if (scan.code !== 0) return failure(tMain('mainUpgrades.compile.couldNotLook'), scan)
    const profile = parseGpuProfile(scan.stdout)
    if (profile?.toLowerCase() === 'unsupported')
      return {
        ok: false,
        unsupported: true,
        message: tMain('mainUpgrades.compile.gpuUnsupported')
      }
    // The scan creates SCSKiller's settings on a first run; the recorder is switched off before anything compiles.
    try {
      await disableRecorder(scsKillerDataDir(exe), deps.settingsIo ?? realSettingsIo)
    } catch (err) {
      return {
        ok: false,
        message: tMain('mainUpgrades.compile.settingsNotSaved', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    let id: string | null = null
    if (target.steamAppId && /^\d+$/.test(target.steamAppId.trim())) {
      id = `steam:${target.steamAppId.trim()}`
    } else {
      // A game a store lists (Epic, GOG, Xbox, …) keeps its store id; `add` is only for games no store lists.
      const want = simpleName(target.title)
      for (const row of parseGameRows(scan.stdout).filter((r) => simpleName(r.name) === want)) {
        const st = await run(['status', row.id])
        if (st.aborted) return CANCELLED
        const install = parseGameStatus(st.stdout).install
        if (install && samePath(install, target.installDir)) {
          id = row.id
          break
        }
      }
      if (!id && target.exePath) {
        const added = await run(['add', target.exePath, target.installDir])
        if (added.aborted) return CANCELLED
        if (added.code !== 0) return failure(tMain('mainUpgrades.compile.couldNotAdd'), added)
        for (const line of added.stdout) {
          const m = /^\s*(?:added|already listed):\s+(\S+)/i.exec(line)
          if (m) id = m[1]!
        }
      }
    }
    if (!id)
      return { ok: false, unsupported: true, message: tMain('mainUpgrades.compile.notListed') }

    const status = await run(['status', id])
    if (status.aborted) return CANCELLED
    if (status.code !== 0) return failure(tMain('mainUpgrades.compile.couldNotRead'), status)
    const { status: state, reason } = parseGameStatus(status.stdout)
    switch (state) {
      case 'Warmed':
        return { ok: true, message: tMain('mainUpgrades.compile.alreadyDone') }
      case 'Unsupported':
      case 'NeedsRecording':
        return {
          ok: false,
          unsupported: true,
          message: reason ?? tMain('mainUpgrades.compile.cannotPrecompile')
        }
      case 'NeedsSteamStart':
      case 'NeedsOfflineSession':
        return { ok: false, message: reason ?? tMain('mainUpgrades.compile.startGameFirst') }
      default:
        break
    }

    let progress = 0
    let last: CompileLine | null = null
    let nothing = false
    onProgress({ progress: 0, message: tMain('mainUpgrades.compile.starting') })
    const compile = await run(['compile', id], (text) => {
      if (/nothing to compile/i.test(text)) nothing = true
      const line = parseCompileLine(text)
      if (!line) return
      last = line
      const p = compileProgress(line)
      if (p != null) progress = Math.max(progress, p)
      onProgress({
        progress: p == null && progress === 0 ? null : progress,
        message: compileMessage(line)
      })
    })
    if (compile.aborted) return CANCELLED
    const end = last as CompileLine | null
    if (compile.code === 0) {
      if (nothing && !end) return { ok: true, message: tMain('mainUpgrades.compile.nothingLeft') }
      return {
        ok: true,
        message: end?.stage === 'Done' ? compileMessage(end) : tMain('mainUpgrades.compile.done')
      }
    }
    if (end?.stage === 'Failed' && end.note) {
      return UNSUPPORTED_TEXT.test(end.note)
        ? { ok: false, unsupported: true, message: end.note }
        : { ok: false, message: compileMessage(end) }
    }
    if (end?.stage === 'Stopped' && !compile.stderr.some((l) => /error:/i.test(l)))
      return { ok: false, message: tMain('mainUpgrades.compile.stoppedGameStarted') }
    return failure(tMain('mainUpgrades.compile.failed'), compile)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
