import { createWriteStream, promises as fs } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { Readable, Transform, type TransformCallback } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import { renameRetry } from '../util/fs'
import { driveFileUrl, driveListingUrl, parseDriveListing } from '../util/google-drive'
import { HttpError, USER_AGENT, type HttpDeps } from './download'
import type { SourceSpec } from './types'
import { tMain } from '../i18n'

/**
 * Downloads a public Google Drive folder that holds an unpacked, ready-to-run emulator folder (RPCS3: the user's own
 * preconfigured copy; docs/emulator-setup.md, "RPCS3 from Google Drive"). The folder is listed recursively through
 * Drive's embedded folder view (no key, no sign-in), then each file is downloaded on its own:
 *
 * - bounded concurrency for listings and downloads; 429 / 5xx / network errors are retried with a growing delay;
 * - caps on the number of files, folders and the depth, so a wrong folder id cannot run away;
 * - names are sanitised (no path traversal, no characters or names Windows rejects); entries that cannot be made safe,
 *   and duplicate names (Drive allows them, Windows does not), are skipped with a warning;
 * - every file is written to `<name>.playout-part` and renamed when complete, so a file that exists under its own
 *   name is complete: a run that broke off resumes by downloading only the files that are missing.
 */

export type DriveFolderSource = Extract<SourceSpec, { kind: 'drive-folder' }>

/** A file of the folder: its Drive id and its path relative to the folder (OS separators, sanitised). */
export interface DriveTreeFile {
  id: string
  path: string
}

export interface DriveFolderProgress {
  /** Files present so far (already there from an earlier attempt, or downloaded). */
  filesDone: number
  filesTotal: number
  /** Bytes downloaded in this run (files already there are not counted). */
  bytesDone: number
}

export interface DriveFolderOptions {
  /** Listing and download requests at once (default 6). */
  concurrency?: number
  /** At most this many files (default 5000). */
  maxFiles?: number
  /** At most this many folders, the top one included (default 2000). */
  maxFolders?: number
  /** At most this many folder levels below the top one (default 16). */
  maxDepth?: number
  /** Attempts per request (default 5). */
  attempts?: number
}

/** Written into the installed folder: marks an install from a Drive folder (its settings win; see service.ts). */
export const DRIVE_MARKER = '.playout-drive.json'

const DEFAULTS = {
  concurrency: 6,
  maxFiles: 5000,
  maxFolders: 2000,
  maxDepth: 16,
  attempts: 5
} satisfies Required<DriveFolderOptions>

const LISTING_TIMEOUT_MS = 30_000
/** A download that sends nothing for this long is abandoned (and retried). */
const STALL_TIMEOUT_MS = 60_000
const MAX_DELAY_MS = 60_000
const PART_SUFFIX = '.playout-part'

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

/**
 * One path segment made safe to create on Windows, or null when nothing usable is left ('', '.', '..'). Characters
 * Windows rejects (and path separators) become '_'; trailing dots and spaces are dropped (Windows drops them itself);
 * reserved device names (CON, NUL, COM1, ...) get a leading '_'.
 */
export function safeSegment(name: string): string | null {
  let s = [...name]
    .map((c) => (c.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(c) ? '_' : c))
    .join('')
    .trim()
    .replace(/[. ]+$/, '')
  if (s === '' || s === '.' || s === '..') return null
  if (RESERVED.test(s)) s = `_${s}`
  return s
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** An error retrying cannot fix. */
function permanent(text: string): Error {
  return Object.assign(new Error(text), { permanent: true })
}

function retryable(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429
  return !(err instanceof Error && (err as { permanent?: boolean }).permanent)
}

/** Seconds of a Retry-After header (capped), or 0. */
function retryAfterMs(err: unknown): number {
  const after = (err as { retryAfter?: number }).retryAfter
  return typeof after === 'number' && after > 0 ? Math.min(after * 1000, MAX_DELAY_MS) : 0
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      done()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      fail(signal?.reason ?? new Error('cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Runs `attempt` up to `attempts` times while the failure is retryable, waiting longer each time. */
async function withRetries<T>(
  what: string,
  attempts: number,
  deps: HttpDeps,
  attempt: () => Promise<T>
): Promise<T> {
  const base = deps.retryDelayMs ?? 1000
  for (let i = 1; ; i++) {
    try {
      return await attempt()
    } catch (err) {
      if (i >= attempts || !retryable(err, deps.signal)) throw err
      deps.log.warn(`${what}: attempt ${i} failed (${message(err)}); retrying`)
      const backoff = Math.min(base * 2 ** (i - 1), MAX_DELAY_MS)
      await sleep(Math.max(backoff, base > 0 ? retryAfterMs(err) : 0), deps.signal)
    }
  }
}

/** GET with PlayOut's user agent; https only (also after redirects); an error for a non-2xx status. */
async function get(url: string, deps: HttpDeps, signal: AbortSignal): Promise<Response> {
  const http = deps.fetch ?? fetch
  const res = await http(url, { headers: { 'User-Agent': USER_AGENT }, signal })
  if (res.url && !res.url.startsWith('https://'))
    throw permanent(`refusing a non-https redirect to ${res.url}`)
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    const err = new HttpError(res.status, url, `HTTP ${res.status} from Google Drive`)
    const after = Number(res.headers.get('retry-after'))
    if (after > 0) Object.assign(err, { retryAfter: after })
    throw err
  }
  return res
}

/** Runs `task` over `items` with at most `limit` at once; the first error stops the others from starting more. */
async function pool<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  let next = 0
  let failed: unknown = null
  const worker = async (): Promise<void> => {
    while (next < items.length && failed === null && !signal?.aborted) {
      const item = items[next++]!
      try {
        await task(item)
      } catch (err) {
        failed ??= err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  if (failed !== null) throw failed
  if (signal?.aborted) throw signal.reason ?? new Error('cancelled')
}

/**
 * Every file of the Drive folder, recursively, with its sanitised relative path. Top-level entries named in
 * `source.skip` (case-insensitive) are left out. Throws when a cap is exceeded or a listing keeps failing.
 */
export async function listDriveFolder(
  source: DriveFolderSource,
  deps: HttpDeps,
  options: DriveFolderOptions = {}
): Promise<DriveTreeFile[]> {
  const o = { ...DEFAULTS, ...options }
  const skip = new Set((source.skip ?? []).map((s) => s.toLowerCase()))
  const files: DriveTreeFile[] = []
  let folders = 0
  let level: { id: string; path: string }[] = [{ id: source.folderId, path: '' }]
  for (let depth = 0; level.length; depth++) {
    if (depth > o.maxDepth)
      throw new Error(tMain('mainEmulatorSetup.drive.tooDeep', { max: o.maxDepth }))
    folders += level.length
    if (folders > o.maxFolders)
      throw new Error(tMain('mainEmulatorSetup.drive.tooManyFolders', { max: o.maxFolders }))
    const nextLevel: { id: string; path: string }[] = []
    await pool(
      level,
      o.concurrency,
      async (folder) => {
        const html = await withRetries(
          `Drive folder ${folder.path || '(top)'}`,
          o.attempts,
          deps,
          async () => {
            const signal = deps.signal
              ? AbortSignal.any([deps.signal, AbortSignal.timeout(LISTING_TIMEOUT_MS)])
              : AbortSignal.timeout(LISTING_TIMEOUT_MS)
            const res = await get(driveListingUrl(folder.id), deps, signal)
            const text = await res.text()
            // A listing page always has the folder view's markup; anything else (a sign-in page) is not a listing.
            if (!text.includes('flip-entries') && !text.includes('flip-entry'))
              throw permanent(
                tMain('mainEmulatorSetup.drive.notListed', {
                  folder: folder.path || source.folderId
                })
              )
            return text
          }
        )
        const seen = new Set<string>()
        for (const entry of parseDriveListing(html)) {
          if (!folder.path && skip.has(entry.name.toLowerCase())) continue
          const name = safeSegment(entry.name)
          const shown = folder.path ? `${folder.path}${sep}${entry.name}` : entry.name
          if (!name) {
            deps.log.warn(`Drive folder: skipping ${shown} (its name cannot be used)`)
            continue
          }
          if (seen.has(name.toLowerCase())) {
            deps.log.warn(`Drive folder: skipping a second entry named ${shown}`)
            continue
          }
          seen.add(name.toLowerCase())
          const path = folder.path ? join(folder.path, name) : name
          if (entry.folder) nextLevel.push({ id: entry.id, path })
          else {
            files.push({ id: entry.id, path })
            if (files.length > o.maxFiles)
              throw permanent(tMain('mainEmulatorSetup.drive.tooManyFiles', { max: o.maxFiles }))
          }
        }
      },
      deps.signal
    )
    level = nextLevel
  }
  return files
}

/** Passes the bytes through while counting them. */
function counter(onChunk: (n: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
      onChunk(chunk.length)
      done(null, chunk)
    }
  })
}

/** Download one file to `target` (through `<target>.playout-part`); returns its size. */
async function downloadOne(
  file: DriveTreeFile,
  target: string,
  deps: HttpDeps,
  attempts: number,
  onBytes: (n: number) => void
): Promise<number> {
  const part = `${target}${PART_SUFFIX}`
  try {
    const size = await withRetries(file.path, attempts, deps, async () => {
      const stall = new AbortController()
      const arm = (): ReturnType<typeof setTimeout> =>
        setTimeout(
          () => stall.abort(new Error(tMain('mainEmulatorSetup.download.stalled'))),
          STALL_TIMEOUT_MS
        )
      let timer = arm()
      const signal = deps.signal ? AbortSignal.any([deps.signal, stall.signal]) : stall.signal
      let got = 0
      try {
        const res = await get(driveFileUrl(file.id), deps, signal)
        // Drive answers a quota or sign-in problem with a web page instead of the file.
        const type = res.headers.get('content-type') ?? ''
        if (/text\/html/i.test(type) && !/\.html?$/i.test(file.path)) {
          await res.body?.cancel().catch(() => undefined)
          throw new Error(tMain('mainEmulatorSetup.drive.webPage'))
        }
        // Content-Length is the size on the wire: a compressed answer (fetch decompresses it) is checked by nothing
        // but its successful end.
        const encoding = (res.headers.get('content-encoding') ?? '').trim().toLowerCase()
        const expected =
          encoding && encoding !== 'identity' ? 0 : Number(res.headers.get('content-length')) || 0
        if (!res.body) await fs.writeFile(part, '')
        else
          await pipeline(
            Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
            counter((n) => {
              clearTimeout(timer)
              timer = arm()
              got += n
              onBytes(n)
            }),
            createWriteStream(part),
            { signal }
          )
        if (expected && got !== expected)
          throw new Error(`downloaded ${got} bytes, expected ${expected}`)
        return got
      } catch (err) {
        // The bytes of a failed attempt do not count.
        if (got) onBytes(-got)
        throw err
      } finally {
        clearTimeout(timer)
      }
    })
    await renameRetry(part, target)
    return size
  } finally {
    await fs.rm(part, { force: true }).catch(() => undefined)
  }
}

/** True when `path` is inside `root` (case-insensitive: Windows paths). */
function inside(root: string, path: string): boolean {
  const r = resolve(root)
  const p = resolve(path)
  return p.toLowerCase().startsWith(r.toLowerCase() + sep)
}

/**
 * Downloads the Drive folder `source` into `dest`, keeping its layout. Files already in `dest` under their own name
 * (complete, from an earlier attempt) are kept; the rest are downloaded. Returns the file count. `onProgress` is
 * called for every chunk (throttling is the caller's job).
 */
export async function downloadDriveFolder(
  source: DriveFolderSource,
  dest: string,
  deps: HttpDeps,
  onProgress?: (p: DriveFolderProgress) => void,
  options: DriveFolderOptions = {}
): Promise<{ files: number; downloaded: number }> {
  const o = { ...DEFAULTS, ...options }
  const files = await listDriveFolder(source, deps, o)
  if (!files.length) throw new Error(tMain('mainEmulatorSetup.drive.empty'))
  await fs.mkdir(dest, { recursive: true })
  const progress: DriveFolderProgress = { filesDone: 0, filesTotal: files.length, bytesDone: 0 }
  const report = (): void => onProgress?.({ ...progress })
  const missing: DriveTreeFile[] = []
  for (const file of files) {
    const target = join(dest, file.path)
    if (!inside(dest, target)) throw permanent(`unsafe path in the Drive folder: ${file.path}`)
    const st = await fs.stat(target).catch(() => null)
    if (st?.isFile()) progress.filesDone++
    else missing.push(file)
  }
  if (progress.filesDone)
    deps.log.info(`Drive folder: ${progress.filesDone} file(s) already downloaded, resuming`)
  report()
  const made = new Set<string>()
  await pool(
    missing,
    o.concurrency,
    async (file) => {
      const target = join(dest, file.path)
      const parent = dirname(target)
      if (!made.has(parent)) {
        await fs.mkdir(parent, { recursive: true })
        made.add(parent)
      }
      await downloadOne(file, target, deps, o.attempts, (n) => {
        progress.bytesDone += n
        report()
      })
      progress.filesDone++
      report()
    },
    deps.signal
  )
  deps.log.info(
    `Drive folder ${source.folderId}: ${files.length} file(s), ${missing.length} downloaded`
  )
  return { files: files.length, downloaded: missing.length }
}
