import { createHash } from 'crypto'
import { createWriteStream, promises as fs } from 'fs'
import { join } from 'path'
import { Readable, Transform, type TransformCallback } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import { renameRetry } from '../util/fs'
import type { Logger, ResolvedDownload } from './types'
import { tMain } from '../i18n'

/**
 * HTTPS downloads for the emulator setup: release lookups (JSON / HTML) and archive downloads, streamed to disk with
 * a SHA-256 check, retried on network errors and server errors. Only https:// URLs are ever fetched (also after
 * redirects).
 */

/** What every HTTP call of the emulator setup gets (fetch is injectable for tests). */
export interface HttpDeps {
  /** Default: the global fetch. */
  fetch?: typeof fetch
  /** Cancels lookups and downloads (the user closed PlayOut or cancelled the setup). */
  signal?: AbortSignal
  log: Logger
  /** Base delay between attempts (doubled each retry). Default 1000 ms; tests pass 0. */
  retryDelayMs?: number
}

/** Identifies PlayOut to the hosts (never a browser user agent). */
export const USER_AGENT = 'PlayOut-Setup (+https://github.com/jeremybris/PlayOut)'

const ATTEMPTS = 3
const API_TIMEOUT_MS = 30_000
/** A download that sends nothing for this long is abandoned (and retried). */
const STALL_TIMEOUT_MS = 60_000

/** An HTTP error status (4xx are not retried; 5xx are). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Throws unless `url` is an https:// URL. */
function requireHttps(url: string, what: string): void {
  let protocol = ''
  try {
    protocol = new URL(url).protocol
  } catch {
    /* not a URL */
  }
  if (protocol !== 'https:') throw permanent(`refusing a non-https URL for ${what}: ${url}`)
}

/** The response's final URL (after redirects) must still be https. Fakes in tests leave it empty. */
function checkFinalUrl(res: Response, what: string): void {
  if (res.url) requireHttps(res.url, what)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** A readable error for a failed response (GitHub's rate limit is named as such). */
function statusError(res: Response, url: string): HttpError {
  const host = hostOf(url)
  if (
    host === 'api.github.com' &&
    (res.status === 403 || res.status === 429) &&
    res.headers.get('x-ratelimit-remaining') === '0'
  )
    return new HttpError(res.status, url, tMain('mainEmulatorSetup.download.rateLimit'))
  if (host === 'api.github.com' && (res.status === 403 || res.status === 429))
    return new HttpError(
      res.status,
      url,
      tMain('mainEmulatorSetup.download.refused', { status: res.status })
    )
  return new HttpError(res.status, url, `HTTP ${res.status} from ${host}`)
}

const isAbort = (err: unknown, signal?: AbortSignal): boolean =>
  !!signal?.aborted || (err instanceof Error && err.name === 'AbortError')

/** Whether a failed attempt is worth repeating: network errors, timeouts and 5xx (not 4xx, not cancellation). */
function retryable(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429
  if (err instanceof Error && (err as { permanent?: boolean }).permanent) return false
  return true
}

/** An error that retrying cannot fix (a checksum or size mismatch). */
function permanent(message: string): Error {
  return Object.assign(new Error(message), { permanent: true })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Runs `attempt` up to three times, backing off between attempts while the failure is retryable. */
async function withRetries<T>(what: string, deps: HttpDeps, attempt: () => Promise<T>): Promise<T> {
  const base = deps.retryDelayMs ?? 1000
  for (let i = 1; ; i++) {
    try {
      return await attempt()
    } catch (err) {
      if (i >= ATTEMPTS || !retryable(err, deps.signal)) throw err
      deps.log.warn(
        `${what}: attempt ${i} failed (${err instanceof Error ? err.message : String(err)}); retrying`
      )
      await sleep(base * 2 ** (i - 1), deps.signal)
    }
  }
}

/** `signal` combined with a timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function get(
  url: string,
  deps: HttpDeps,
  headers: Record<string, string>,
  signal: AbortSignal,
  method: 'GET' | 'HEAD' = 'GET'
): Promise<Response> {
  requireHttps(url, hostOf(url))
  const http = deps.fetch ?? fetch
  const res = await http(url, {
    method,
    headers: { 'User-Agent': USER_AGENT, ...headers },
    signal
  })
  checkFinalUrl(res, hostOf(url))
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw statusError(res, url)
  }
  return res
}

function apiHeaders(url: string, headers?: Record<string, string>): Record<string, string> {
  return hostOf(url) === 'api.github.com'
    ? { Accept: 'application/vnd.github+json', ...headers }
    : { ...headers }
}

/** GET a JSON document (GitHub API calls send its Accept header). Retries network errors and 5xx. */
export async function fetchJson<T>(
  url: string,
  deps: HttpDeps,
  headers?: Record<string, string>
): Promise<T> {
  return withRetries(url, deps, async () => {
    const res = await get(
      url,
      deps,
      apiHeaders(url, headers),
      withTimeout(deps.signal, API_TIMEOUT_MS)
    )
    const text = await res.text()
    try {
      return JSON.parse(text) as T
    } catch {
      throw permanent(`${hostOf(url)} did not answer with JSON`)
    }
  })
}

/** GET a text document (an HTML index, a .sha256 file). Retries network errors and 5xx. */
export async function fetchText(url: string, deps: HttpDeps): Promise<string> {
  return withRetries(url, deps, async () => {
    const res = await get(url, deps, {}, withTimeout(deps.signal, API_TIMEOUT_MS))
    return res.text()
  })
}

/**
 * HEAD a file (following redirects): its headers, to tell which build a fixed "latest" URL holds right now (ETag,
 * Last-Modified, Content-Length). Retries network errors and 5xx.
 */
export async function fetchHeaders(url: string, deps: HttpDeps): Promise<Headers> {
  return withRetries(url, deps, async () => {
    const res = await get(url, deps, {}, withTimeout(deps.signal, API_TIMEOUT_MS), 'HEAD')
    await res.body?.cancel().catch(() => undefined)
    return res.headers
  })
}

/** A file name safe to join to a folder: its last path segment, without characters Windows rejects. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base
    .replace(/[<>:"|?*]/g, '_')
    .split('')
    .filter((c) => c.charCodeAt(0) >= 32)
    .join('')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  return clean || 'download'
}

/** Passes the bytes through while hashing and counting them. */
function meter(onChunk: (chunk: Buffer) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
      onChunk(chunk)
      done(null, chunk)
    }
  })
}

/**
 * Download `d` into `dir` as `<dir>/<fileName>`: streamed to `<fileName>.part` while hashing, checked against
 * `d.sha256` and `d.size` when given, then renamed into place. Network errors and 5xx are retried (three attempts);
 * a mismatch is not. The .part file never survives a failure. Returns the saved file's path. `onBytes` is called
 * for every chunk (throttling is the caller's job).
 */
export async function downloadFile(
  d: ResolvedDownload,
  dir: string,
  deps: HttpDeps,
  onBytes?: (done: number, total: number) => void
): Promise<string> {
  const name = safeFileName(d.fileName)
  requireHttps(d.url, name)
  const target = join(dir, name)
  const part = `${target}.part`
  const expected = d.sha256?.toLowerCase()
  await fs.mkdir(dir, { recursive: true })
  try {
    await withRetries(name, deps, async () => {
      // A stall timer, reset on every chunk: a big download may take long, but must not hang.
      const stall = new AbortController()
      let timer = setTimeout(
        () => stall.abort(new Error(tMain('mainEmulatorSetup.download.stalled'))),
        STALL_TIMEOUT_MS
      )
      const kick = (): void => {
        clearTimeout(timer)
        timer = setTimeout(
          () => stall.abort(new Error(tMain('mainEmulatorSetup.download.stalled'))),
          STALL_TIMEOUT_MS
        )
      }
      const signal = deps.signal ? AbortSignal.any([deps.signal, stall.signal]) : stall.signal
      try {
        const res = await get(d.url, deps, {}, signal)
        if (!res.body) throw new Error(tMain('mainEmulatorSetup.download.noData', { file: name }))
        const total = Number(res.headers.get('content-length')) || d.size || 0
        const hash = createHash('sha256')
        let got = 0
        await pipeline(
          Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
          meter((chunk) => {
            kick()
            hash.update(chunk)
            got += chunk.length
            onBytes?.(got, total)
          }),
          createWriteStream(part),
          { signal }
        )
        if (d.size !== undefined && got !== d.size)
          throw permanent(
            tMain('mainEmulatorSetup.download.wrongSize', {
              file: name,
              size: got,
              expected: d.size
            })
          )
        const actual = hash.digest('hex')
        if (expected && actual !== expected)
          throw permanent(tMain('mainEmulatorSetup.download.checksum', { file: name }))
      } finally {
        clearTimeout(timer)
      }
    })
    await fs.rm(target, { force: true })
    await renameRetry(part, target)
    deps.log.info(`downloaded ${name} (${d.version})`)
    return target
  } catch (err) {
    if (isAbort(err, deps.signal) && deps.signal?.aborted)
      deps.log.info(`${name}: download cancelled`)
    throw err
  } finally {
    await fs.rm(part, { force: true }).catch(() => undefined)
  }
}
