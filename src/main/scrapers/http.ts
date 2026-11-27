import type { Logger } from '../logger'
import { tMain } from '../i18n'

/** Sent on every scraper request so API operators can identify the client. */
export const USER_AGENT = 'PlayOut/1.0 (+https://github.com/playout)'

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_RETRIES = 3
const DEFAULT_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000
const BODY_EXCERPT_CHARS = 500
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504])

/** Query parameters that carry credentials; they are masked in every URL that reaches a log or an error message. */
const SENSITIVE_PARAMS =
  /^(y|devid|devpassword|ssid|sspassword|password|apikey|api_key|key|token|access_token|refresh_token|webapi_token|code|authorization|sessionid|steamLoginSecure|client_id|client_secret|secret)$/i

export interface HttpOptions {
  /** Abort the request after this long (default 20 s). */
  timeoutMs?: number
  /** Extra attempts after the first one for 429 / 5xx responses and network errors (default 3). */
  retries?: number
  /**
   * The HTTP statuses that are retried (default 429, 500, 502, 503, 504). TheGamesDB leaves 429 out: its 429 means
   * the monthly allowance is used up, and asking again only spends calls.
   */
  retryStatuses?: readonly number[]
  /** Base of the exponential backoff between attempts (default 500 ms); a Retry-After header can extend it. */
  backoffBaseMs?: number
  /**
   * Fixed waits before each retry (retry 1 waits delaysMs[0], ...; the last value repeats) instead of the exponential
   * backoff; a Retry-After header can still extend a wait, up to the 30 s cap.
   */
  delaysMs?: number[]
  /** Called after every attempt (success or failure), for a trace log. A throwing hook is ignored. */
  onAttempt?: (attempt: HttpAttempt) => void
  /** Token bucket to wait on before every attempt. */
  limiter?: RateLimiter
  /**
   * Concurrency gate held for the whole of each attempt (limiter wait, request and body read) and released
   * during retry back-off, so a service's thread allowance covers both API calls and media downloads.
   */
  gate?: Gate
  log?: Logger
}

/** One request attempt, as `onAttempt` reports it. */
export interface HttpAttempt {
  /** Request URL with credential parameters masked. */
  url: string
  method: string
  /** 1-based attempt number and the most attempts this call makes. */
  attempt: number
  attempts: number
  /** HTTP status, or 0 for a network failure / timeout. */
  status: number
  statusText?: string
  durationMs: number
  /** Response body size in bytes. */
  bytes?: number
  retryAfter?: string
  /** Network failure / timeout description. */
  error?: string
  /** Up to 500 characters of a non-2xx response body (not redacted: the hook redacts before logging). */
  body?: string
  /** The wait before the next attempt, when one follows. */
  retryInMs?: number
}

export class HttpError extends Error {
  readonly status: number
  /** HTTP reason phrase ('Bad Gateway'), when the server sent one. */
  readonly statusText?: string
  /** Request URL with credential parameters masked. */
  readonly url: string
  /** Up to 500 characters of the response body, for callers that inspect API error texts. */
  readonly body?: string
  /** The wait the server asked for in a Retry-After header (ms), when it sent one. */
  readonly retryAfterMs?: number

  constructor(
    message: string,
    info: {
      status: number
      url: string
      body?: string
      statusText?: string
      retryAfterMs?: number
    }
  ) {
    super(message)
    this.name = 'HttpError'
    this.status = info.status
    if (info.statusText) this.statusText = info.statusText
    this.url = redactUrl(info.url)
    this.body = info.body
    if (info.retryAfterMs !== undefined) this.retryAfterMs = info.retryAfterMs
  }
}

/** Mask credential query parameters (devpassword, apikey, ...) so a URL can be logged or shown. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    let changed = false
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_PARAMS.test(key)) {
        parsed.searchParams.set(key, '***')
        changed = true
      }
    }
    return changed ? parsed.toString() : url
  } catch {
    return url.replace(/([?&])([^=&]+)=([^&#]*)/g, (m, sep: string, key: string) =>
      SENSITIVE_PARAMS.test(key) ? `${sep}${key}=***` : m
    )
  }
}

export type QueryValue = string | number | boolean | undefined | null

/** Append query parameters to a URL; undefined and null values are skipped. */
export function buildUrl(base: string, params: Record<string, QueryValue> = {}): string {
  const url = new URL(base)
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * Token bucket: `perSecond` requests per second with up to `burst` immediate ones. Callers are served in order;
 * when the bucket is empty each caller reserves the next free slot, so a queue of N calls completes in N/perSecond s.
 */
export class RateLimiter {
  private readonly perSecond: number
  private readonly burst: number
  private tokens: number
  private last: number

  constructor(perSecond: number, burst = 1) {
    if (!(perSecond > 0)) throw new Error('RateLimiter: perSecond must be positive')
    this.perSecond = perSecond
    this.burst = Math.max(1, Math.floor(burst))
    this.tokens = this.burst
    this.last = performance.now()
  }

  take(): Promise<void> {
    const now = performance.now()
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond)
    this.last = now
    this.tokens -= 1
    if (this.tokens >= 0) return Promise.resolve()
    return sleep(Math.ceil((-this.tokens / this.perSecond) * 1000))
  }
}

/**
 * Limits concurrent requests to a service's thread allowance (ScreenScraper: 1 for non-contributors). Capacity
 * can be raised later (from the account record) and queued callers are served in order.
 */
export class Gate {
  private active = 0
  private readonly queue: (() => void)[] = []

  constructor(private capacity: number) {}

  /** Calls currently holding a slot. */
  get running(): number {
    return this.active
  }

  setCapacity(n: number): void {
    this.capacity = Math.max(1, n)
    this.drain()
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // A released waiter already holds its slot (drain reserves it), so only the fast path takes one here.
    if (this.active >= this.capacity) await new Promise<void>((resolve) => this.queue.push(resolve))
    else this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.drain()
    }
  }

  private drain(): void {
    while (this.active < this.capacity && this.queue.length) {
      this.active++
      this.queue.shift()!()
    }
  }
}

interface RawResponse {
  status: number
  data: Buffer
  headers: Headers
}

/** UTF-8 decode that drops a leading BOM, as Response.text() does. */
function decodeText(data: Buffer): string {
  return new TextDecoder('utf-8').decode(data)
}

function withTimeout(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function describeNetworkError(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (e?.name === 'TimeoutError') return `request timed out after ${timeoutMs} ms`
  if (e?.name === 'AbortError') return 'request aborted'
  const detail = e?.cause?.code || e?.cause?.message || e?.message || String(err)
  return `network error: ${detail}`
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

function retryDelay(
  attempt: number,
  retryAfter: string | null,
  baseMs: number,
  delaysMs?: number[]
): number {
  const planned = delaysMs?.length
    ? delaysMs[Math.min(attempt, delaysMs.length - 1)]
    : baseMs * 2 ** attempt + Math.random() * baseMs * 0.5
  const requested = parseRetryAfter(retryAfter) ?? 0
  return Math.min(MAX_BACKOFF_MS, Math.max(planned, requested))
}

async function request(url: string, init: RequestInit, options: HttpOptions): Promise<RawResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES)
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_MS
  const headers = new Headers(init.headers)
  if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT)
  if (!headers.has('accept')) headers.set('accept', 'application/json, text/plain;q=0.9, */*;q=0.8')
  const safeUrl = redactUrl(url)
  const method = (init.method ?? 'GET').toUpperCase()
  const report = (info: Omit<HttpAttempt, 'url' | 'method' | 'attempts'>): void => {
    if (!options.onAttempt) return
    try {
      options.onAttempt({ url: safeUrl, method, attempts: retries + 1, ...info })
    } catch {
      // A trace hook never breaks the request.
    }
  }

  for (let attempt = 0; ; attempt++) {
    const startedAt = performance.now()
    const elapsed = (): number => Math.round(performance.now() - startedAt)
    const attemptOnce = async (): Promise<{ res: Response; data: Buffer }> => {
      if (options.limiter) await options.limiter.take()
      const res = await fetch(url, {
        ...init,
        headers,
        signal: withTimeout(init.signal, timeoutMs)
      })
      const data = Buffer.from(await res.arrayBuffer())
      return { res, data }
    }
    let res: Response
    let data: Buffer
    try {
      ;({ res, data } = options.gate ? await options.gate.run(attemptOnce) : await attemptOnce())
    } catch (err) {
      const message = describeNetworkError(err, timeoutMs)
      const callerAborted = !!init.signal?.aborted
      const willRetry = attempt < retries && !callerAborted
      const delay = willRetry ? retryDelay(attempt, null, backoffBaseMs, options.delaysMs) : 0
      report({
        attempt: attempt + 1,
        status: 0,
        durationMs: elapsed(),
        error: message,
        retryInMs: willRetry ? Math.round(delay) : undefined
      })
      if (willRetry) {
        options.log?.debug(
          `${message} for ${safeUrl}; retry ${attempt + 1}/${retries} in ${Math.round(delay)} ms`
        )
        await sleep(delay)
        continue
      }
      throw new HttpError(`${message} (${safeUrl})`, { status: 0, url })
    }
    const retryAfter = res.headers.get('retry-after') ?? undefined
    const retryable = options.retryStatuses
      ? options.retryStatuses.includes(res.status)
      : RETRY_STATUSES.has(res.status)
    const willRetry = !res.ok && attempt < retries && retryable
    const delay = willRetry
      ? retryDelay(attempt, retryAfter ?? null, backoffBaseMs, options.delaysMs)
      : 0
    report({
      attempt: attempt + 1,
      status: res.status,
      statusText: res.statusText || undefined,
      durationMs: elapsed(),
      bytes: data.length,
      retryAfter,
      body: res.ok ? undefined : decodeText(data).slice(0, BODY_EXCERPT_CHARS),
      retryInMs: willRetry ? Math.round(delay) : undefined
    })
    if (res.ok) return { status: res.status, data, headers: res.headers }
    if (willRetry) {
      options.log?.debug(
        `HTTP ${res.status} for ${safeUrl}; retry ${attempt + 1}/${retries} in ${Math.round(delay)} ms`
      )
      await sleep(delay)
      continue
    }
    const statusText = res.statusText ? ` ${res.statusText}` : ''
    throw new HttpError(`HTTP ${res.status}${statusText} for ${safeUrl}`, {
      status: res.status,
      statusText: res.statusText || undefined,
      url,
      body: decodeText(data).slice(0, BODY_EXCERPT_CHARS),
      retryAfterMs: parseRetryAfter(retryAfter ?? null)
    })
  }
}

/** GET/POST a URL and parse the JSON body. Throws HttpError for non-2xx responses, network failures and non-JSON bodies. */
export async function httpJson<T>(
  url: string,
  init: RequestInit = {},
  options: HttpOptions = {}
): Promise<T> {
  const res = await request(url, init, options)
  const text = decodeText(res.data)
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as T
  } catch {
    throw new HttpError(`invalid JSON from ${redactUrl(url)}`, {
      status: res.status,
      url,
      body: text.slice(0, BODY_EXCERPT_CHARS)
    })
  }
}

/** Like httpJson but returns the raw body text. */
export async function httpText(
  url: string,
  init: RequestInit = {},
  options: HttpOptions = {}
): Promise<string> {
  return decodeText((await request(url, init, options)).data)
}

/**
 * Download a binary body (media) with the same retry, Retry-After, limiter and gate handling as httpJson, so
 * API-hosted media endpoints that count against thread limits (ScreenScraper mediaJeu.php) are not hammered.
 */
export async function httpBytes(
  url: string,
  init: RequestInit = {},
  options: HttpOptions = {}
): Promise<{ data: Buffer; contentType: string | null }> {
  const res = await request(url, init, options)
  return { data: res.data, contentType: res.headers.get('content-type') }
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Re-label an HttpError with a short, service-prefixed message the UI can show ('SteamGridDB: invalid API key').
 * `specific` supplies the service's own wording for a status; the generic text covers the rest.
 */
export function serviceError(
  service: string,
  err: HttpError,
  specific?: (err: HttpError) => string | undefined
): HttpError {
  let text = specific?.(err)
  if (!text) {
    if (err.status === 0) text = err.message.replace(/ \(https?:\/\/[^)]*\)$/, '')
    else if (err.status === 429) text = tMain('mainScrapers.http.rateLimit')
    else if (err.status >= 500)
      text = tMain('mainScrapers.http.serverError', { status: err.status })
    else if (err.body === undefined) text = err.message.replace(/ for https?:\/\/\S+$/, '')
    else text = tMain('mainScrapers.http.unexpected', { status: err.status })
  }
  return new HttpError(`${service}: ${text}`, { status: err.status, url: err.url, body: err.body })
}
