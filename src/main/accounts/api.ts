// HTTP helpers shared by the store importers: JSON calls with the project's retry/timeout rules, auth failures
// turned into `SessionExpiredError`, and a hidden-window JSON read for cookie-session APIs (Battle.net).
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Logger } from '../logger'
import {
  httpJson,
  HttpError,
  httpText,
  redactUrl,
  type HttpAttempt,
  type HttpOptions
} from '../scrapers/http'
import { describeError, SessionExpiredError, StoreUnavailableError, type AuthWindow } from './types'
import { tMain } from '../i18n'

export interface ApiCallOptions {
  /** The store name for the SessionExpiredError message. */
  store: string
  /** HTTP statuses that mean "the credential is dead" (default 401 and 403). */
  authStatuses?: number[]
  timeoutMs?: number
  /** Extra attempts for 429/5xx and network errors (default 2; 3 inside an owned-library import). */
  retries?: number
  /** Fixed waits before each retry (default: 0.5 s exponential; 2 s, 6 s, 15 s inside an owned-library import). */
  delaysMs?: number[]
  /** Per-attempt hook (the owned-import trace log). */
  onAttempt?: (attempt: HttpAttempt) => void
  /** Receives the retry lines ("HTTP 502 for ...; retry 1/3 in 2000 ms"). */
  log?: Logger
}

/**
 * Retry rules for the owned-library fetch of a store: a store API that answers 5xx / 429 is usually having a bad
 * minute, so the import waits longer between attempts than the 0.5 s / 1 s scraper default before giving up.
 */
export const OWNED_IMPORT_RETRIES = 3
export const OWNED_IMPORT_DELAYS_MS = [2_000, 6_000, 15_000]

/**
 * Retry rules for an optional call made during an owned import whose failure is swallowed (Epic play time, Xbox
 * user stats): the quick scraper default, so a degraded side endpoint does not hold up a working import.
 */
export const OPTIONAL_CALL_RETRY: Readonly<Pick<ApiCallOptions, 'retries' | 'delaysMs'>> = {
  retries: 2,
  delaysMs: [500, 1_000]
}

/** What every apiJson / apiText call made while a store's owned list is fetched picks up (see `runOwnedImport`). */
export interface OwnedImportScope {
  retries: number
  delaysMs: number[]
  onAttempt?: (attempt: HttpAttempt) => void
  log?: Logger
}

const ownedImportScope = new AsyncLocalStorage<OwnedImportScope>()

/**
 * Run a store's `fetchOwned` with the owned-import retry rules, trace hook and logger applied to each of its API
 * calls, without every store module having to thread them through.
 */
export function runOwnedImport<T>(scope: OwnedImportScope, fn: () => Promise<T>): Promise<T> {
  return ownedImportScope.run(scope, fn)
}

const DEFAULT_AUTH_STATUSES = [401, 403]

function isAuthFailure(err: unknown, statuses: number[]): boolean {
  return err instanceof HttpError && statuses.includes(err.status)
}

function httpOptions(options: ApiCallOptions): HttpOptions {
  const scope = ownedImportScope.getStore()
  return {
    timeoutMs: options.timeoutMs ?? 20_000,
    retries: options.retries ?? scope?.retries ?? 2,
    delaysMs: options.delaysMs ?? scope?.delaysMs,
    onAttempt: options.onAttempt ?? scope?.onAttempt,
    log: options.log ?? scope?.log
  }
}

/** GET/POST JSON; a 401/403 (or `authStatuses`) answer becomes a SessionExpiredError the service understands. */
export async function apiJson<T>(
  url: string,
  init: RequestInit,
  options: ApiCallOptions
): Promise<T> {
  try {
    return await httpJson<T>(url, init, httpOptions(options))
  } catch (err) {
    if (isAuthFailure(err, options.authStatuses ?? DEFAULT_AUTH_STATUSES))
      throw new SessionExpiredError(options.store)
    throw err
  }
}

/** Like apiJson for endpoints whose success body is text (or whose error body matters). */
export async function apiText(
  url: string,
  init: RequestInit,
  options: ApiCallOptions
): Promise<string> {
  try {
    return await httpText(url, init, httpOptions(options))
  } catch (err) {
    if (isAuthFailure(err, options.authStatuses ?? DEFAULT_AUTH_STATUSES))
      throw new SessionExpiredError(options.store)
    throw err
  }
}

/** `application/x-www-form-urlencoded` body from a record (undefined values skipped). */
export function formBody(fields: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) params.set(key, value)
  return params.toString()
}

/**
 * Read a JSON document the store serves to its own signed-in web pages (Battle.net's `/api/*`) through a hidden
 * window on the store's partition, so the partition's cookies authenticate the request. Only a document on the
 * requested URL's origin is read (a redirect elsewhere counts as a login redirect). Returns null when the page did
 * not render JSON (the session is dead) and throws `StoreUnavailableError` when the window timed out.
 */
export async function loadJsonViaWindow<T>(
  hidden: AuthWindow,
  url: string,
  store = tMain('mainAccounts.unavailable.theStore')
): Promise<T | null> {
  const origin = new URL(url).origin
  const result = await hidden.run<{ json: T } | { dead: true }>({
    url,
    timeoutMs: 20_000,
    async onNavigate(ctx) {
      if (!ctx.loaded) return undefined
      if (!ctx.url.startsWith(`${origin}/`) && ctx.url !== origin) return { dead: true }
      const text = await ctx.executeJavaScript<string>(
        'document.body ? document.body.innerText : ""'
      )
      const trimmed = (text ?? '').trim()
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { dead: true }
      try {
        return { json: JSON.parse(trimmed) as T }
      } catch {
        return { dead: true }
      }
    }
  })
  if (!result) throw new StoreUnavailableError(store, tMain('mainAccounts.unavailable.noAnswer'))
  if ('dead' in result) return null
  return result.json
}

/**
 * The store's token endpoint failed during a refresh: an authentication answer (SessionExpiredError from
 * `authStatuses`) means the credential is dead and the refresh returns null; anything else (network failure, 429,
 * 5xx) is rethrown so the service keeps the credential and retries on the next import.
 */
export function refreshFailure(err: unknown, store: string, log: Logger): null {
  if (err instanceof SessionExpiredError) {
    log.warn(`${store}: token refresh rejected: ${describeError(err)}`)
    return null
  }
  log.warn(`${store}: token refresh failed, keeping the credential: ${describeError(err)}`)
  throw err
}

export { HttpError, redactUrl }
