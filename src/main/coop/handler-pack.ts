import type { CoopHandlerEntry, CoopProgress } from '@shared/types'
import { promises as fs } from 'fs'
import { basename, join, resolve, sep } from 'path'
import type { Logger } from '../logger'
import { extractZipEntry, listZip, readZipEntry, safeEntryPath, type ZipEntry } from '../util/zip'
import { handlerFileName, parseHandlerScript } from './handler-script'
import { driveFileUrl, driveListingUrl, parseDriveListing } from '../util/google-drive'

export { parseDriveListing, type DriveFile } from '../util/google-drive'

/**
 * Nucleus Co-op handlers (one `.nc` zip per game: handler.js plus optional game files). "Download all handlers"
 * (Settings > Library) fetches the whole pack from the Google Drive folder the user chose, plus the few the Nucleus
 * hub has that the folder lacks, and keeps them zipped under `<coopDir>\archive`. An index of what each handler is
 * for is read from the zips (handler.js only, never run) into `<coopDir>\handlers-index.json`. A game's handler is
 * extracted only when that game is played in Co-Op (`extract`), into the engine's handlers folder, Nucleus's way.
 */

/** The handler pack: a public Google Drive folder (listing page needs no key or sign-in). */
export const HANDLER_FOLDER_ID = '1sD_oauwQ0RcJ8L3trNbcxkzE6bvdKrIy'
const LISTING_URL = driveListingUrl(HANDLER_FOLDER_ID)
const fileUrl = driveFileUrl
/** The Nucleus hub's package download (handlers the Drive folder lacks). */
const hubUrl = (pkg: string, id: string, version: number): string =>
  `https://hub.splitscreen.me/cdn/storage/packages/${encodeURIComponent(pkg)}/original/handler-${encodeURIComponent(id)}-v${version}.nc?download=true`

const USER_AGENT = 'PlayOut (+https://github.com/jeremybris/PlayOut)'
const PARALLEL = 8
const FILE_TIMEOUT_MS = 5 * 60_000
const INDEX_FILE = 'handlers-index.json'
/**
 * Raised when the way handler.js is read changes: an index written by an older reader is read again from the
 * archives at the next download instead of keeping its entries. 2: braces inside strings no longer hide fields.
 */
export const INDEX_VERSION = 2
/** A handler script larger than this is not read (real ones are under 100 KB). */
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024
const META_FILE = 'handlers.json'
/** `handler-<hubId>-v<version>.nc`. */
const ARCHIVE_NAME = /^handler-([A-Za-z0-9]+)-v(\d+)\.nc$/

/** The hub record fields PlayOut uses from handlers.json. */
interface HubRecord {
  _id: string
  title?: string
  gameName?: string
  currentVersion?: number
  currentPackage?: string
  maxPlayers?: number
  playableControllers?: boolean
  playableMouseKeyboard?: boolean
  playableMultiMouseKeyboard?: boolean
}

export interface CoopIndexFile {
  /** The reader that built it (INDEX_VERSION); absent in the first indexes. */
  version?: number
  builtAt: string
  handlers: CoopHandlerEntry[]
}

export interface HandlerPackDeps {
  /** `<userData>\coop`. */
  coopDir: string
  log: Logger
  onProgress?: (progress: CoopProgress) => void
  /** Tests. */
  fetch?: typeof fetch
  now?: () => number
}

export interface HandlerPack {
  /** Download every handler (only the ones not already here), then index them. Single flight. */
  downloadAll(): Promise<{ downloaded: number; total: number; failed: number }>
  /** The index (empty until a download). */
  index(): Promise<CoopHandlerEntry[]>
  /**
   * When the index was last built (ISO time; '' before the first download, and for an index built by an older
   * reader, which is due again).
   */
  builtAt(): Promise<string>
  busy(): boolean
  /**
   * Extract one handler into `<handlersDir>`: `<GameName>.js` and the game files under `<GameName>\`, as Nucleus
   * installs it. Returns the script's path. Already extracted (same archive): nothing to do.
   */
  extract(entry: CoopHandlerEntry, handlersDir: string): Promise<string>
}

/** The handler.js of a package: at the root (Nucleus's rule), else the shallowest .js. */
export function handlerScriptEntry(entries: ZipEntry[]): ZipEntry | undefined {
  const files = entries.filter((e) => !e.name.endsWith('/'))
  return (
    files.find((e) => e.name.toLowerCase() === 'handler.js') ??
    files
      .filter((e) => e.name.toLowerCase().endsWith('.js'))
      .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0]
  )
}

/** Where an extracted handler's script and files go (Nucleus's names). */
export function extractedPaths(
  gameName: string,
  handlersDir: string
): { script: string; folder: string; stamp: string } {
  const name = handlerFileName(gameName)
  const paths = {
    script: join(handlersDir, `${name}.js`),
    folder: join(handlersDir, name),
    stamp: join(handlersDir, `${name}.playout.json`)
  }
  // Never outside the handlers folder, whatever the handler calls its game.
  const inside = (p: string): boolean => resolve(p).startsWith(resolve(handlersDir) + sep)
  if (!inside(paths.script) || !inside(paths.folder) || !inside(paths.stamp))
    throw new Error(`unusable handler name: ${gameName}`)
  return paths
}

export function createHandlerPack(deps: HandlerPackDeps): HandlerPack {
  const { coopDir, log } = deps
  const http = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const archiveDir = join(coopDir, 'archive')
  const indexPath = join(coopDir, INDEX_FILE)
  let running: Promise<{ downloaded: number; total: number; failed: number }> | null = null
  let cached: CoopIndexFile | null = null

  let lastReport = 0
  function report(progress: CoopProgress, force = false): void {
    const t = now()
    if (!force && t - lastReport < 400) return
    lastReport = t
    deps.onProgress?.(progress)
  }

  async function get(url: string): Promise<Response> {
    const res = await http(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FILE_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res
  }

  /** Download one package to `<archiveDir>\<name>`, checked to be a zip (Drive answers errors with HTML pages). */
  async function fetchArchive(url: string, name: string): Promise<void> {
    const res = await get(url)
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length < 22 || body.readUInt32LE(0) !== 0x04034b50)
      throw new Error(
        `not a handler package (${res.headers.get('content-type') ?? 'unknown type'})`
      )
    const part = join(archiveDir, `${name}.part`)
    await fs.writeFile(part, body)
    await fs.rename(part, join(archiveDir, name))
  }

  async function loadIndex(): Promise<CoopIndexFile> {
    if (cached) return cached
    try {
      cached = JSON.parse(await fs.readFile(indexPath, 'utf8')) as CoopIndexFile
      if (!Array.isArray(cached.handlers)) throw new Error('bad index')
    } catch {
      cached = { builtAt: '', handlers: [] }
    }
    return cached
  }

  /** Read every archive's handler.js into the index (archives already indexed keep their entry). */
  async function buildIndex(meta: Map<string, HubRecord>): Promise<CoopIndexFile> {
    const old = await loadIndex()
    // An older reader's entries are not kept: its mistakes would stay for as long as the archive does.
    const previous = new Map(
      (old.version === INDEX_VERSION ? old.handlers : []).map((h) => [h.archive, h])
    )
    const names = (await fs.readdir(archiveDir)).filter((n) => ARCHIVE_NAME.test(n)).sort()
    const handlers: CoopHandlerEntry[] = []
    let done = 0
    for (const archive of names) {
      report({ stage: 'indexing', done: done++, total: names.length })
      const hubId = ARCHIVE_NAME.exec(archive)![1]!
      const record = meta.get(hubId)
      const known = previous.get(archive)
      if (known) {
        handlers.push(withMeta(known, record))
        continue
      }
      try {
        const path = join(archiveDir, archive)
        const script = handlerScriptEntry(await listZip(path))
        if (!script) throw new Error('no handler.js')
        if (script.size > MAX_SCRIPT_BYTES) throw new Error('handler.js is too large')
        const info = parseHandlerScript((await readZipEntry(path, script)).toString('utf8'))
        if (!info) throw new Error('handler.js names no game')
        handlers.push(withMeta({ archive, ...info, hubId: info.hubId ?? hubId }, record))
      } catch (err) {
        log.warn(`Co-Op: ${archive} skipped (${err instanceof Error ? err.message : String(err)})`)
      }
    }
    const file: CoopIndexFile = {
      version: INDEX_VERSION,
      builtAt: new Date(now()).toISOString(),
      handlers
    }
    const tmp = `${indexPath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(file))
    await fs.rename(tmp, indexPath)
    cached = file
    return file
  }

  async function run(): Promise<{ downloaded: number; total: number; failed: number }> {
    await fs.mkdir(archiveDir, { recursive: true })
    report({ stage: 'listing', done: 0, total: 1 }, true)
    try {
      const listing = parseDriveListing(await (await get(LISTING_URL)).text())
      const packages = listing.filter((f) => ARCHIVE_NAME.test(f.name))
      if (packages.length === 0) throw new Error('the handler folder lists no handlers')
      log.info(`Co-Op: the handler folder lists ${packages.length} handler(s)`)

      // handlers.json: the hub's records (titles, players, input support) and the handlers the folder lacks.
      const meta = new Map<string, HubRecord>()
      const metaFile = listing.find((f) => f.name === META_FILE)
      if (metaFile) {
        try {
          const text = await (await get(fileUrl(metaFile.id))).text()
          const records = JSON.parse(text) as HubRecord[]
          for (const r of records) if (r && typeof r._id === 'string') meta.set(r._id, r)
          await fs.writeFile(join(coopDir, META_FILE), text)
        } catch (err) {
          log.warn(
            `Co-Op: handlers.json not read (${err instanceof Error ? err.message : String(err)})`
          )
        }
      }

      const have = new Set(await fs.readdir(archiveDir))
      type Job = { url: string; name: string }
      const jobs: Job[] = packages
        .filter((f) => !have.has(f.name))
        .map((f) => ({ url: fileUrl(f.id), name: f.name }))
      const listed = new Set(packages.map((f) => ARCHIVE_NAME.exec(f.name)![1]!))
      for (const r of meta.values()) {
        if (listed.has(r._id) || !r.currentPackage || !r.currentVersion) continue
        const name = `handler-${r._id}-v${r.currentVersion}.nc`
        if (!have.has(name))
          jobs.push({ url: hubUrl(r.currentPackage, r._id, r.currentVersion), name })
      }
      const total = packages.length + [...meta.values()].filter((r) => !listed.has(r._id)).length
      let done = total - jobs.length
      let downloaded = 0
      let failed = 0
      report({ stage: 'download', done, total }, true)
      const queue = [...jobs]
      await Promise.all(
        Array.from({ length: PARALLEL }, async () => {
          for (let job = queue.shift(); job; job = queue.shift()) {
            try {
              await fetchArchive(job.url, job.name)
              downloaded++
            } catch (err) {
              failed++
              log.warn(
                `Co-Op: ${job.name} not downloaded (${err instanceof Error ? err.message : String(err)})`
              )
            }
            report({ stage: 'download', done: ++done, total })
          }
        })
      )
      let index = await buildIndex(meta)
      if (await removeSuperseded(new Set(index.handlers.map((h) => h.archive))))
        index = await buildIndex(meta)
      log.info(
        `Co-Op: ${downloaded} handler(s) downloaded, ${failed} failed; ${index.handlers.length} indexed`
      )
      return { downloaded, total, failed }
    } finally {
      await removeParts()
      report({ stage: 'download', done: 0, total: 0 }, true)
    }
  }

  /** An older version of a handler is deleted once a newer one is here and could be read. */
  async function removeSuperseded(indexed: ReadonlySet<string>): Promise<boolean> {
    const newest = new Map<string, number>()
    const names = (await fs.readdir(archiveDir)).filter((n) => ARCHIVE_NAME.test(n))
    let removed = false
    for (const n of names.filter((name) => indexed.has(name))) {
      const [, id, v] = ARCHIVE_NAME.exec(n)!
      newest.set(id!, Math.max(newest.get(id!) ?? 0, Number(v)))
    }
    for (const n of names) {
      const [, id, v] = ARCHIVE_NAME.exec(n)!
      if (Number(v) < (newest.get(id!) ?? 0)) {
        await fs.rm(join(archiveDir, n), { force: true })
        removed = true
      }
    }
    return removed
  }

  async function removeParts(): Promise<void> {
    const names = await fs.readdir(archiveDir).catch(() => [] as string[])
    await Promise.all(
      names
        .filter((n) => n.endsWith('.part'))
        .map((n) => fs.rm(join(archiveDir, n), { force: true }))
    )
  }

  return {
    downloadAll() {
      running ??= run().finally(() => {
        running = null
      })
      return running
    },
    async index() {
      return (await loadIndex()).handlers
    },
    async builtAt() {
      const file = await loadIndex()
      return file.version === INDEX_VERSION ? file.builtAt : ''
    },
    busy: () => running !== null,
    async extract(entry, handlersDir) {
      const archive = join(archiveDir, basename(entry.archive))
      const paths = extractedPaths(entry.gameName, handlersDir)
      const stamp = await fs.readFile(paths.stamp, 'utf8').catch(() => '')
      if (stamp === entry.archive && (await exists(paths.script))) return paths.script
      const entries = await listZip(archive)
      const script = handlerScriptEntry(entries)
      if (!script) throw new Error(`${entry.archive} has no handler.js`)
      // A fresh copy: the previous version's files go.
      await fs.rm(paths.folder, { recursive: true, force: true })
      await fs.mkdir(handlersDir, { recursive: true })
      await extractZipEntry(archive, script, paths.script)
      for (const e of entries) {
        if (e === script || e.name.endsWith('/')) continue
        const parts = e.name.split('/')
        // Each top-level folder's contents merge into <GameName>\ (Nucleus's DownloadPrompt); loose root files
        // other than handler.js are not used.
        if (parts.length < 2) continue
        const rest = safeEntryPath(parts.slice(1).join('/'))
        if (!rest) throw new Error(`unsafe path in ${entry.archive}: ${e.name}`)
        await extractZipEntry(archive, e, join(paths.folder, rest))
      }
      await fs.writeFile(paths.stamp, entry.archive)
      return paths.script
    }
  }
}

function withMeta(entry: CoopHandlerEntry, record: HubRecord | undefined): CoopHandlerEntry {
  if (!record) return entry
  return {
    ...entry,
    title: record.title ?? entry.title,
    controllers: record.playableControllers ?? entry.controllers,
    mouseKeyboard: record.playableMouseKeyboard ?? entry.mouseKeyboard,
    multiMouseKeyboard: record.playableMultiMouseKeyboard ?? entry.multiMouseKeyboard
  }
}

async function exists(path: string): Promise<boolean> {
  return fs.access(path).then(
    () => true,
    () => false
  )
}
