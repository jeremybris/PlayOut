// Store account contract (docs/ARCHITECTURE.md §4.8, docs/research/store-accounts.md §8). One StoreAccount per store
// implements sign-in capture, token refresh, the owned-library fetch and the install form of a game's launch; the
// AccountsService (index.ts) owns the token store, the auth window and the merge into the library.
import type { ClientInfo, Game, OwnedGame, Settings, StoreSourceId } from '../../shared/types'
import type { Logger } from '../logger'
import { HttpError } from '../scrapers/http'

import { mainLanguage, tMain } from '../i18n'
/**
 * Whatever a store needs to call its API again: tokens, ids, capture time. Stored encrypted by the token store and
 * never logged. `kind` tells a store which of its credential paths the record belongs to (Steam: 'web' | 'apikey').
 */
export interface AccountTokens {
  kind: string
  [key: string]: string | number | boolean | undefined
}

/** What the auth window hands a navigation callback: the current URL and a way to read the rendered document. */
export interface AuthPageContext {
  url: string
  /** True for did-finish-load / did-navigate (the document is there), false for will-redirect style events. */
  loaded: boolean
  /** Run a read-only script in the store's page (only documents the store itself rendered are inspected). */
  executeJavaScript<T = unknown>(script: string): Promise<T>
}

export interface AuthRequestDetails {
  url: string
  /** Set for `onBeforeSendHeaders` matches (names lower-cased). */
  requestHeaders?: Record<string, string>
}

/**
 * One page load in a store's partition. `onNavigate` runs on every navigation / load event and `onRequest` on
 * every request matching `requestFilter`; the first non-null value either returns ends the load and resolves `run`.
 */
export interface AuthPage<T> {
  url: string
  userAgent?: string
  /**
   * Registrable sites (`siteOf`) the window may navigate to; a main-frame navigation or popup to any other site is
   * blocked, so a link in a store page footer cannot turn the sign-in window into a general browser and a page the
   * store did not render is never read. Omitted: no restriction (tests, hidden JSON reads of one URL).
   */
  allowedSites?: string[]
  /** Give up after this long (default: 10 minutes for a visible window, 20 s for a hidden one). */
  timeoutMs?: number
  onNavigate?: (ctx: AuthPageContext) => Promise<T | null | undefined> | T | null | undefined
  /** `session.webRequest` URL patterns (Electron match patterns) that `onRequest` wants to see. */
  requestFilter?: string[]
  onRequest?: (details: AuthRequestDetails) => T | null | undefined
}

/** A BrowserWindow on `persist:account-<source>`: the visible sign-in window or a hidden loader for refreshes. */
export interface AuthWindow {
  /** Resolves with the captured value, or null when the window was closed (user) or timed out without one. */
  run<T>(page: AuthPage<T>): Promise<T | null>
}

/** Services a store may use while refreshing or importing. */
export interface AccountContext {
  settings: Settings
  log: Logger
  /** Hidden window on the store's partition for cookie-session re-mints (Steam, Battle.net, EA). */
  hidden: AuthWindow
}

export type InstallSpec =
  | { kind: 'uri'; uri: string }
  | {
      kind: 'exec'
      file: string
      args: string[]
      /**
       * Spawn only while a process of this name (without .exe) runs; otherwise only `followUpUri` is sent (GOG's
       * installGame command is dropped by a client that is not up yet).
       */
      requiresProcess?: string
      /** Sent `followUpDelayMs` after the spawn (GOG: openGameView once the installGame command landed). */
      followUpUri?: string
      followUpDelayMs?: number
    }

export interface StoreAccount {
  source: StoreSourceId
  /** Store name as shown to the user ('Steam', 'Epic Games Launcher'). */
  storeName: string
  supported: boolean
  /** User-facing, when !supported. */
  reason?: string
  /** Open the store's sign-in page in the auth window and capture the credential; null when the user closed it. */
  signIn(win: AuthWindow, ctx: AccountContext): Promise<AccountTokens | null>
  /**
   * Refresh or re-mint the credential. Null means the store said the session is dead (the service forgets the
   * credential and the status becomes "not signed in"); a timeout, network failure or 5xx must throw
   * (`StoreUnavailableError` or the HttpError itself) so the service keeps the credential and retries later.
   */
  refresh(tokens: AccountTokens, ctx: AccountContext): Promise<AccountTokens | null>
  displayName(tokens: AccountTokens, ctx: AccountContext): Promise<string | undefined>
  fetchOwned(tokens: AccountTokens, ctx: AccountContext): Promise<OwnedGame[]>
  /**
   * The install form of the game's launch: a protocol URI or a client command line; null when the game cannot be
   * installed through the client (then `installError` says why).
   */
  installSpec(game: Game, client: ClientInfo): InstallSpec | null
  /** User-facing reason for a null `installSpec`. */
  installError?(game: Game, client: ClientInfo): string
  /** Progress line while the tracker is in `starting` ("Confirm the install in Steam"). */
  confirmMessage: string
}

/** Thrown by a store when the API answered 401/403: the service drops the session and shows the message. */
export class SessionExpiredError extends Error {
  constructor(store: string) {
    super(tMain('mainAccounts.sessionExpiredStore', { store }))
    this.name = 'SessionExpiredError'
  }
}

/**
 * Thrown by a store when it could not be reached or did not answer in time (offline, outage, hidden-window timeout):
 * the credential is kept, the row shows "Could not reach <Store>" and the next import tries again.
 */
export class StoreUnavailableError extends Error {
  /** What went wrong, without the "Could not reach" frame ('the store page did not load'). */
  readonly detail?: string

  constructor(store: string, detail?: string) {
    super(
      detail
        ? tMain('mainAccounts.couldNotReachWhy', { store, detail })
        : tMain('mainAccounts.couldNotReach', { store })
    )
    this.name = 'StoreUnavailableError'
    if (detail) this.detail = detail
  }
}

/**
 * A failure on the store's side of an import, as opposed to an expired session (SessionExpiredError) or a fault
 * in PlayOut itself (a bad answer it could not read, a bug, a disk error):
 * - `server`: the store's API answered HTTP 5xx: the store is having an outage.
 * - `rate-limit`: the store answered HTTP 429.
 * - `timeout`: no answer in time (the store may be overloaded, or the connection may be slow).
 * - `network`: the store could not be reached at all (offline, DNS, connection reset): may well be local.
 */
export interface StoreFailure {
  kind: 'server' | 'rate-limit' | 'timeout' | 'network'
  status?: number
  statusText?: string
  /** Short technical detail for the message ('ECONNRESET', 'the store page did not load'). */
  detail?: string
}

const NETWORK_ERROR =
  /\b(fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNABORTED|UND_ERR_[A-Z_]+|socket hang up|other side closed)\b/i

/** Common reason phrases, for a status whose response carried none (HTTP/2 sends no reason phrase). */
const STATUS_TEXT: Record<number, string> = {
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout'
}

/**
 * Classify an import error as a store-side failure; null for everything else (auth, PlayOut's own errors). Only
 * transport failures count: HTTP 5xx / 429, timeouts and network errors. A wrapping error (Epic's "catalog lookup
 * failed") is classified by its `cause`. A `StoreUnavailableError` is not: it is thrown when the store answered in a
 * shape PlayOut did not expect (a GraphQL error, no owned list) or a hidden page did not give what PlayOut reads, so
 * the store may well have been reached and the service keeps its neutral "Could not reach <Store>" text, no retry.
 */
export function classifyStoreFailure(err: unknown): StoreFailure | null {
  let current: unknown = err
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof SessionExpiredError || current instanceof StoreUnavailableError)
      return null
    const failure = classifyOne(current)
    if (failure) return failure
    current = current instanceof Error ? current.cause : undefined
  }
  return null
}

function classifyOne(err: unknown): StoreFailure | null {
  if (err instanceof HttpError) {
    const statusText = err.statusText ?? STATUS_TEXT[err.status]
    if (err.status === 429) return { kind: 'rate-limit', status: 429, statusText }
    if (err.status >= 500 && err.status <= 599)
      return { kind: 'server', status: err.status, statusText }
    if (err.status === 0) {
      const timedOut = /request timed out after (\d+) ms/.exec(err.message)
      if (timedOut)
        return {
          kind: 'timeout',
          detail: tMain('mainAccounts.failure.noAnswerAfter', {
            seconds: Math.round(Number(timedOut[1]) / 1000)
          })
        }
      const network = /network error: ([^(]+?)\s*\(/.exec(err.message)
      if (network) return { kind: 'network', detail: network[1].trim() }
    }
    return null
  }
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return { kind: 'timeout' }
    const match = NETWORK_ERROR.exec(err.message)
    if (match) return { kind: 'network', detail: match[1] }
  }
  return null
}

function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`
}

/**
 * The user-facing text for a store-side failure. `store` is the store's display name ('Steam', 'Epic Games');
 * `retryInMinutes` is when PlayOut tries again by itself (undefined: no automatic retry is scheduled). Only an HTTP
 * 5xx / 429 that came from the store is blamed on the store outright; an unreachable store may be a local
 * connection problem and the message says so.
 */
export function storeFailureMessage(
  store: string,
  failure: StoreFailure,
  retryInMinutes?: number
): string {
  const code =
    failure.status !== undefined
      ? `HTTP ${failure.status}${failure.statusText ? ` ${failure.statusText}` : ''}`
      : undefined
  // Whole sentences. {owner} is the store's possessive in English ("Steam's", "Epic Games'"); in other languages,
  // which say it with their own words around the name, it is the plain name.
  const owner = mainLanguage() === 'en' ? possessive(store) : store
  const vars = { store, owner, code: code ?? '', detail: failure.detail ?? '' }
  let first: string
  switch (failure.kind) {
    case 'server':
      first = tMain('mainAccounts.failure.server', vars)
      break
    case 'rate-limit':
      first = tMain('mainAccounts.failure.rateLimit', vars)
      break
    case 'timeout':
      first = failure.detail
        ? tMain('mainAccounts.failure.timeoutWhy', vars)
        : tMain('mainAccounts.failure.timeout', vars)
      break
    default:
      first = failure.detail
        ? tMain('mainAccounts.failure.networkWhy', vars)
        : tMain('mainAccounts.failure.network', vars)
  }
  const next =
    retryInMinutes !== undefined
      ? tMain('mainAccounts.failure.retryIn', { minutes: retryInMinutes })
      : tMain('mainAccounts.failure.importLater')
  return tMain('mainAccounts.failure.unchanged', { first, store, next })
}

/** Code / token / cookie values never reach a log line; URLs are masked by `redactUrl`, texts by this. */
export function redactSecrets(text: string): string {
  return text
    .replace(
      /(?<![A-Za-z0-9_])((?:code|key|apikey|api_key|access_token|refresh_token|token|client_secret|webapi_token|steamLoginSecure|sessionid|authorization)[=:]\s*)[^&\s"',;]+/gi,
      '$1***'
    )
    .replace(
      /("(?:code|key|apikey|api_key|access_token|refresh_token|id_token|token|client_secret|webapi_token|steamLoginSecure|sessionid|authorization)"\s*:\s*")[^"]*/gi,
      '$1***'
    )
    .replace(/\b(Bearer|XBL3\.0|basic)\s+[A-Za-z0-9._~+/=;-]+/gi, '$1 ***')
}

/** A loggable one-line description of an error; never includes credentials. */
export function describeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return redactSecrets(text)
}
