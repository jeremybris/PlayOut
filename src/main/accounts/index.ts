// AccountsService (docs/ARCHITECTURE.md §4.8): status rows for the Library "Settings" tab, sign-in through the auth
// window, encrypted token storage, and the owned-library import that turns a store account into greyed cards.
import type { BrowserWindow } from 'electron'
import { join } from 'path'
import { STORE_PLATFORMS } from '../../shared/platforms'
import {
  STORE_SOURCES,
  type AccountStatus,
  type ClientInfo,
  type Game,
  type ImportOwnedResult,
  type OwnedGame,
  type StoreSourceId
} from '../../shared/types'
import type { EventBus } from '../events'
import type { Logger } from '../logger'
import type { MetadataService } from '../scrapers/types'
import type { LibraryService, RemoteMediaImport } from '../services/library-service'
import type { SettingsStore } from '../store/settings-store'
import { createAuthWindows, partitionFor, type AuthWindows } from './auth-window'
import { createBattlenetAccount, loadProductRows, type BattlenetProductRow } from './battlenet'
import { eaAccount } from './ea'
import { epicAccount } from './epic'
import { gogAccount } from './gog'
import { NO_DIAG, type DiagLog } from '../diag-log'
import {
  loadJsonViaWindow,
  OWNED_IMPORT_DELAYS_MS,
  OWNED_IMPORT_RETRIES,
  runOwnedImport,
  type OwnedImportScope
} from './api'
import { describeForTrace, formatAttempt } from './import-trace'
import {
  parseOwnedApps,
  steamAccount,
  steamKeyTokens,
  STEAM_USERDATA_URL,
  type SteamTokens
} from './steam'
import { TokenStore } from './token-store'
import {
  classifyStoreFailure,
  describeError,
  SessionExpiredError,
  StoreUnavailableError,
  storeFailureMessage,
  type AccountContext,
  type AccountTokens,
  type InstallSpec,
  type StoreAccount
} from './types'
import { ubisoftAccount } from './ubisoft'
import { xboxAccount } from './xbox'
import { tMain } from '../i18n'

export interface AccountsDeps {
  settings: SettingsStore
  library: LibraryService
  events: EventBus
  metadata: MetadataService
  window: { get(): BrowserWindow | null; focus(): void; isFullscreen(): boolean }
  log: Logger
  /** `app.getPath('userData')`: accounts.json lives there. */
  userData: string
  /** resources/systems, for the Battle.net product table. */
  resourcesDir: string
  // Injectable for tests
  tokenStore?: TokenStore
  authWindows?: AuthWindows
  accounts?: StoreAccount[]
  /** Clears a partition's cookies/storage on sign-out; defaults to Electron's session API. */
  clearPartition?: (partition: string) => Promise<void>
  /** Game ids with a tracked install: an import that no longer lists them must not delete their record. */
  trackedInstalls?: () => string[]
  /** An owned list was merged into the library: it may have added games. */
  onOwnedImported?: (source: StoreSourceId) => void
  /** The store's account was signed out, or another account signed in over it: data read with it is stale. */
  onSignedOut?: (source: StoreSourceId) => void
  /** logs/store-import.log: every HTTP attempt of an owned import and its outcome (default: nowhere). */
  importTrace?: DiagLog
}

export interface AccountsService {
  getAccounts(): Promise<AccountStatus[]>
  signIn(source: StoreSourceId): Promise<AccountStatus>
  signOut(source: StoreSourceId): Promise<AccountStatus>
  importOwned(sources?: StoreSourceId[]): Promise<ImportOwnedResult>
  /** The store module (install spec, confirm message) for the install service. */
  account(source: StoreSourceId): StoreAccount
  /** `installSpec` of the store, with the client info the caller detected. */
  installSpec(game: Game, client: ClientInfo): InstallSpec | null
  installError(game: Game, client: ClientInfo): string
  /**
   * The Steam credential for other services (achievements): the signed-in account's token, or the Settings API key.
   * `refresh` mints a new access token first (Steam refused the stored one); null when Steam is signed out.
   */
  steamCredential(refresh?: boolean): Promise<SteamTokens | null>
  /**
   * A current Epic access token for other services (install sizes from Epic's manifests), refreshed first when it is
   * about to expire (`refresh`: refreshed now, Epic refused it); null when Epic is signed out or cannot be reached.
   */
  epicAccessToken(refresh?: boolean): Promise<string | null>
  /**
   * The signed-in Epic account for Epic's achievements (achievements/epic.ts): its account id with a current access
   * token, as epicAccessToken gives it (`refresh`: refreshed now, Epic refused it). Never logged. Null when Epic is
   * signed out (or Epic ended the session); throws when the token could not be refreshed (Epic out of reach).
   */
  epicCredential(refresh?: boolean): Promise<{ accountId: string; accessToken: string } | null>
  /** Whether an Epic account is signed in to PlayOut (stored; whether Epic still accepts it is not checked). */
  epicSignedIn(): boolean
  /**
   * The signed-in GOG account for GOG's achievements (achievements/gog.ts): its user id and refresh token, which GOG
   * exchanges for a game's own token as Galaxy does. Read after any refresh in progress; never changed here. Null when
   * GOG is signed out.
   */
  gogCredential(): Promise<{ userId: string; refreshToken: string } | null>
  /**
   * The app ids (games and DLC) the Steam account signed in to PlayOut owns, read from the store with its cookie
   * session on the hidden Steam window; null when Steam is signed out, signed in with an API key only, or the store
   * did not answer (ownership unknown).
   */
  steamOwnedApps(): Promise<Set<number> | null>
  dispose(): Promise<void>
}

export const sessionExpiredMessage = (): string => tMain('mainAccounts.sessionExpired')
/**
 * After an import failed on the store's side (outage, rate limit, unreachable), PlayOut imports that store again by
 * itself after these waits, one at a time, then stops until the next normal import (start, scan, Import click).
 */
export const RETRY_LATER_MINUTES = [10, 30]
export const apiKeySignOutMessage = (): string => tMain('mainAccounts.apiKeySignOut')

async function defaultClearPartition(partition: string): Promise<void> {
  const { session } = await import('electron')
  await session.fromPartition(partition).clearStorageData()
}

export async function createAccountsService(deps: AccountsDeps): Promise<AccountsService> {
  const { log } = deps
  const tokenStore = deps.tokenStore ?? new TokenStore(join(deps.userData, 'accounts.json'), log)
  await tokenStore.load()
  const authWindows =
    deps.authWindows ?? createAuthWindows({ parent: () => deps.window.get(), log })
  const clearPartition = deps.clearPartition ?? defaultClearPartition

  let battlenetProducts: BattlenetProductRow[] = []
  const accounts = new Map<StoreSourceId, StoreAccount>()
  if (deps.accounts) {
    for (const a of deps.accounts) accounts.set(a.source, a)
  } else {
    battlenetProducts = await loadProductRows(deps.resourcesDir, log)
    for (const a of [
      steamAccount,
      epicAccount,
      gogAccount,
      eaAccount,
      createBattlenetAccount(() => battlenetProducts),
      ubisoftAccount,
      xboxAccount
    ])
      accounts.set(a.source, a)
  }

  const importing = new Set<StoreSourceId>()
  // The row's error; `kind: 'store'` marks a problem on the store's side (shown as a notice, retried by itself).
  const errors = new Map<StoreSourceId, { text: string; kind?: 'store' }>()
  const trace = deps.importTrace ?? NO_DIAG
  // One pending automatic retry per store, and how many of RETRY_LATER_MINUTES the current outage has used.
  const retryTimers = new Map<StoreSourceId, ReturnType<typeof setTimeout>>()
  const retryRound = new Map<StoreSourceId, number>()
  const inflight = new Map<StoreSourceId, Promise<ImportOwnedResult['sources'][number]>>()
  // Bumped by signOut: an import that started under an older generation writes nothing back once it resumes
  // (its refresh may take 20 s, and the user signed out in between).
  const generation = new Map<StoreSourceId, number>()
  let disposed = false

  const generationOf = (source: StoreSourceId): number => generation.get(source) ?? 0

  function account(source: StoreSourceId): StoreAccount {
    const a = accounts.get(source)
    if (!a) throw new Error(`Unknown store ${source}`)
    return a
  }

  function context(source: StoreSourceId): AccountContext {
    return { settings: deps.settings.get(), log, hidden: authWindows.hidden(source) }
  }

  /**
   * One token refresh per store at a time (an import, the Steam credential and the Epic token can all start one):
   * a store that rotates refresh tokens would refuse the second as a dead session. Shared only within one sign-in:
   * after a sign-out or a new sign-in the old account's refresh is not joined.
   */
  const refreshes = new Map<string, Promise<AccountTokens | null>>()
  const refreshKey = (source: StoreSourceId): string => `${source}:${generationOf(source)}`
  function sharedRefresh(
    source: StoreSourceId,
    tokens: AccountTokens
  ): Promise<AccountTokens | null> {
    const key = refreshKey(source)
    const running = refreshes.get(key)
    if (running) return running
    const task = account(source)
      .refresh(tokens, context(source))
      .finally(() => refreshes.delete(key))
    refreshes.set(key, task)
    return task
  }

  /** The stored credential, or for Steam the API key from Settings when nothing is stored. */
  async function tokensFor(source: StoreSourceId): Promise<AccountTokens | null> {
    const stored = await tokenStore.get(source)
    if (stored) return stored
    if (source === 'steam') return steamKeyTokens(deps.settings.get())
    return null
  }

  async function status(source: StoreSourceId): Promise<AccountStatus> {
    const a = account(source)
    const tokens = a.supported ? await tokensFor(source) : null
    const meta = tokenStore.meta(source)
    const row: AccountStatus = {
      source,
      supported: a.supported,
      signedIn: tokens !== null,
      importing: importing.has(source)
    }
    if (a.reason) row.reason = a.reason
    if (tokens?.kind === 'apikey') row.viaSettings = true
    if (tokens) {
      const name =
        meta.displayName ??
        (typeof tokens.accountName === 'string' ? tokens.accountName : undefined) ??
        (typeof tokens.displayName === 'string' ? tokens.displayName : undefined) ??
        (typeof tokens.gamertag === 'string' ? tokens.gamertag : undefined)
      if (name) row.displayName = name
      if (tokens.kind === 'apikey' && !meta.displayName)
        row.displayName = `${tokens.steamId64} (API key)`
    }
    if (meta.lastImportAt) row.lastImportAt = meta.lastImportAt
    if (meta.lastImportCount !== undefined) row.lastImportCount = meta.lastImportCount
    const error = errors.get(source)
    if (error) {
      row.error = error.text
      if (error.kind) row.errorKind = error.kind
    }
    return row
  }

  async function getAccounts(): Promise<AccountStatus[]> {
    const rows: AccountStatus[] = []
    // STORE_SOURCES order; a store without a module (an injected subset in tests) has no row.
    for (const source of STORE_SOURCES as readonly StoreSourceId[])
      if (accounts.has(source)) rows.push(await status(source))
    return rows
  }

  async function emitChanged(): Promise<void> {
    if (disposed) return
    try {
      deps.events.emit('accounts:changed', await getAccounts())
    } catch (err) {
      log.warn(`accounts:changed failed: ${describeError(err)}`)
    }
  }

  /** The credential is dead: forget it (API-key credentials live in Settings and stay) and tell the user. */
  async function dropSession(source: StoreSourceId, tokens: AccountTokens): Promise<void> {
    if (tokens.kind !== 'apikey') {
      tokenStore.delete(source)
      deps.onSignedOut?.(source)
    }
    errors.set(source, { text: sessionExpiredMessage() })
  }

  /** Drop the store's pending automatic retry and forget how many the current outage used. */
  function cancelRetry(source: StoreSourceId): void {
    const timer = retryTimers.get(source)
    if (timer) clearTimeout(timer)
    retryTimers.delete(source)
    retryRound.delete(source)
  }

  /**
   * After a store-side failure: import the store again in 10 minutes, then (if that failed too) in 30, then stop.
   * A failure of a normal import (start, scan, Import click) starts the sequence over. Never more than one timer per
   * store. Returns the wait in minutes, or undefined when no retry was scheduled.
   */
  function scheduleRetry(source: StoreSourceId, viaRetry: boolean): number | undefined {
    const pending = retryTimers.get(source)
    if (pending) clearTimeout(pending)
    retryTimers.delete(source)
    const round = viaRetry ? (retryRound.get(source) ?? 0) : 0
    if (disposed || round >= RETRY_LATER_MINUTES.length) {
      retryRound.delete(source)
      return undefined
    }
    const minutes = RETRY_LATER_MINUTES[round]
    retryRound.set(source, round + 1)
    const timer = setTimeout(() => {
      retryTimers.delete(source)
      if (disposed) return
      log.info(`${source}: retrying the owned import after the store-side failure`)
      trace.line(
        `${source}: automatic retry after ${minutes} min${inflight.has(source) ? ' (joins the running import)' : ''}`
      )
      void runImports([source], true)
    }, minutes * 60_000)
    timer.unref?.()
    retryTimers.set(source, timer)
    return minutes
  }

  /** The store's display name for messages ('Steam', 'Epic Games'). */
  const displayStore = (source: StoreSourceId): string =>
    STORE_PLATFORMS[source]?.name ?? account(source).storeName

  /** The API calls of a store's owned fetch: slower retries, each attempt traced, retry lines into main.log. */
  function ownedScope(source: StoreSourceId): OwnedImportScope {
    return {
      retries: OWNED_IMPORT_RETRIES,
      delaysMs: OWNED_IMPORT_DELAYS_MS,
      onAttempt: (attempt) => trace.line(formatAttempt(source, attempt)),
      // http.ts writes its retry lines at debug level, which main.log does not keep.
      log: {
        debug: (...a) => log.info(...a),
        info: (...a) => log.info(...a),
        warn: (...a) => log.warn(...a),
        error: (...a) => log.error(...a)
      }
    }
  }

  /**
   * One `enqueue` for the import (ARCHITECTURE.md §4.6 "Art pipeline"): the store's cover / hero / logo / icon URLs
   * are the cover lane's seeds (covers first, 8 downloads in flight, Steam / GOG / Epic 404 fallbacks, library
   * writes batched), the local caches and direct URLs cover the games whose seed failed, and the full lane fills
   * text, HLTB and the other art afterwards. With auto-scrape off only the seeds and the local caches are used.
   */
  function finishImport(newGameIds: string[], media: RemoteMediaImport[]): void {
    if (disposed || (!newGameIds.length && !media.length)) return
    const seedIds = media.map((m) => m.gameId)
    deps.metadata.enqueue([...newGameIds, ...seedIds], {
      seeds: media,
      coverOnly: !deps.settings.get().scrapers.autoScrape
    })
  }

  /**
   * A store-side failure (outage, rate limit, unreachable): the row shows a notice that names the store, not PlayOut,
   * and one automatic retry is scheduled. The library is not touched.
   */
  function storeSideFailure(
    source: StoreSourceId,
    err: unknown,
    failure: NonNullable<ReturnType<typeof classifyStoreFailure>>,
    viaRetry: boolean,
    phase: string
  ): string {
    const minutes = scheduleRetry(source, viaRetry)
    const message = storeFailureMessage(displayStore(source), failure, minutes)
    log.warn(
      `${source}: ${phase} failed on the store's side (${failure.kind}), library unchanged; ${
        minutes !== undefined ? `retry in ${minutes} min` : 'no automatic retry left'
      }: ${describeError(err)}`
    )
    trace.line(
      `${source}: outcome store unavailable (${failure.kind}${failure.status ? ` HTTP ${failure.status}` : ''}) during ${phase}; ${
        minutes !== undefined ? `retry in ${minutes} min` : 'no automatic retry left'
      }: ${describeForTrace(err)}`
    )
    errors.set(source, { text: message, kind: 'store' })
    return message
  }

  async function importOne(
    source: StoreSourceId,
    viaRetry = false
  ): Promise<ImportOwnedResult['sources'][number]> {
    const a = account(source)
    const result: ImportOwnedResult['sources'][number] = {
      id: source,
      imported: 0,
      added: 0,
      removed: 0
    }
    if (!a.supported) {
      result.error = a.reason ?? tMain('mainAccounts.notSupported')
      return result
    }
    let tokens = await tokensFor(source)
    if (!tokens) {
      result.error = tMain('mainAccounts.notSignedIn')
      return result
    }
    importing.add(source)
    errors.delete(source)
    await emitChanged()
    // The generation this import belongs to; a sign-out in the meantime makes every write below a no-op.
    const started = generationOf(source)
    const abandoned = (): boolean => disposed || generationOf(source) !== started
    const startedAt = Date.now()
    trace.line(`${source}: owned import started${viaRetry ? ' (automatic retry)' : ''}`)
    const sessionExpired = async (current: AccountTokens): Promise<typeof result> => {
      cancelRetry(source)
      await dropSession(source, current)
      trace.line(`${source}: outcome session expired`)
      result.error = sessionExpiredMessage()
      return result
    }
    const fetchOwned = (current: AccountTokens, ctx: AccountContext): Promise<OwnedGame[]> =>
      runOwnedImport(ownedScope(source), () => a.fetchOwned(current, ctx))
    try {
      const ctx = context(source)
      // Only the store saying "dead" (null) forgets the credential. A thrown refresh (timeout, offline, 5xx) says
      // nothing about the session: the tokens and the previous owned list stay and the next import tries again.
      let refreshed: AccountTokens | null
      try {
        refreshed = await sharedRefresh(source, tokens)
      } catch (err) {
        if (abandoned()) return result
        const failure = classifyStoreFailure(err)
        if (failure) {
          result.error = storeSideFailure(source, err, failure, viaRetry, 'sign-in refresh')
          return result
        }
        const message =
          err instanceof StoreUnavailableError
            ? err.message
            : tMain('mainAccounts.couldNotReach', { store: a.storeName })
        log.warn(`${source}: refresh failed, keeping the credential: ${describeError(err)}`)
        trace.line(`${source}: outcome refresh failed: ${describeForTrace(err)}`)
        cancelRetry(source)
        errors.set(source, { text: message })
        result.error = message
        return result
      }
      if (abandoned()) return result
      if (!refreshed) return await sessionExpired(tokens)
      tokens = refreshed
      if (tokens.kind !== 'apikey') await tokenStore.set(source, tokens)

      let owned
      try {
        owned = await fetchOwned(tokens, ctx)
      } catch (err) {
        if (abandoned()) return result
        if (!(err instanceof SessionExpiredError)) throw err
        // One more refresh on an authentication error, then the session counts as dead. Through `sharedRefresh`
        // like the first: a refresh started meanwhile (the Steam credential, the Epic token) is joined, never run
        // next to this one, which would spend a rotating refresh token twice.
        const again = await sharedRefresh(source, tokens)
        if (abandoned()) return result
        if (!again) return await sessionExpired(tokens)
        tokens = again
        if (tokens.kind !== 'apikey') await tokenStore.set(source, tokens)
        try {
          owned = await fetchOwned(tokens, ctx)
        } catch (err2) {
          if (abandoned()) return result
          if (!(err2 instanceof SessionExpiredError)) throw err2
          return await sessionExpired(tokens)
        }
      }
      if (abandoned()) return result
      cancelRetry(source)

      const merge = deps.library.mergeOwned(source, owned, {
        keepIds: new Set(deps.trackedInstalls?.() ?? [])
      })
      deps.library.registerPlatforms([STORE_PLATFORMS[source]])
      deps.onOwnedImported?.(source)
      result.imported = owned.length
      result.added = merge.added
      result.removed = merge.removed
      tokenStore.setMeta(source, {
        lastImportAt: new Date().toISOString(),
        lastImportCount: owned.length
      })
      log.info(
        `${source}: imported ${owned.length} owned game(s): ${merge.added} added, ${merge.updated} updated, ${merge.removed} removed`
      )
      trace.line(
        `${source}: outcome imported ${owned.length} game(s): ${merge.added} added, ${merge.removed} removed, in ${(
          (Date.now() - startedAt) /
          1000
        ).toFixed(1)} s`
      )
      finishImport(merge.newGameIds, merge.remoteMedia)
      return result
    } catch (err) {
      const message = describeError(err)
      const failure = abandoned() ? null : classifyStoreFailure(err)
      if (failure) {
        result.error = storeSideFailure(source, err, failure, viaRetry, 'owned import')
        return result
      }
      log.error(`${source}: owned import failed: ${message}`)
      trace.line(`${source}: outcome error: ${describeForTrace(err)}`)
      if (!abandoned()) {
        cancelRetry(source)
        errors.set(source, { text: tMain('mainAccounts.importFailed', { error: message }) })
      }
      result.error = message
      return result
    } finally {
      importing.delete(source)
      await tokenStore
        .flush()
        .catch((err) => log.warn(`accounts.json flush failed: ${describeError(err)}`))
      await emitChanged()
    }
  }

  function importOwned(sources?: StoreSourceId[]): Promise<ImportOwnedResult> {
    return runImports(sources, false)
  }

  /** `viaRetry`: started by the automatic retry after a store-side failure (continues its 10 / 30 min sequence). */
  async function runImports(
    sources: StoreSourceId[] | undefined,
    viaRetry: boolean
  ): Promise<ImportOwnedResult> {
    const wanted: StoreSourceId[] = []
    for (const source of sources ?? (STORE_SOURCES as readonly StoreSourceId[])) {
      if (!accounts.has(source) || wanted.includes(source)) continue
      const a = account(source)
      if (!a.supported) continue
      if (sources === undefined && (await tokensFor(source)) === null) continue
      wanted.push(source)
    }
    const rows = await Promise.all(
      wanted.map((source) => {
        const existing = inflight.get(source)
        if (existing) return existing
        const task = importOne(source, viaRetry).finally(() => inflight.delete(source))
        inflight.set(source, task)
        return task
      })
    )
    return { sources: rows }
  }

  let steamRefresh: Promise<SteamTokens | null> | null = null

  async function steamCredential(refresh = false): Promise<SteamTokens | null> {
    if (!accounts.has('steam') || disposed) return null
    const tokens = (await tokensFor('steam')) as SteamTokens | null
    if (!tokens || !refresh || tokens.kind !== 'web') return tokens
    // One refresh at a time; the import refreshes too, and both write the same store entry.
    steamRefresh ??= (async (): Promise<SteamTokens | null> => {
      const started = generationOf('steam')
      let refreshed: AccountTokens | null
      try {
        refreshed = await sharedRefresh('steam', tokens)
      } catch (err) {
        log.warn(`steam: token refresh failed: ${describeError(err)}`)
        return null
      }
      if (disposed || generationOf('steam') !== started) return null
      if (!refreshed) {
        await dropSession('steam', tokens)
        await emitChanged()
        return steamKeyTokens(deps.settings.get())
      }
      await tokenStore.set('steam', refreshed)
      return refreshed as SteamTokens
    })().finally(() => {
      steamRefresh = null
    })
    return steamRefresh
  }

  async function gogCredential(): Promise<{ userId: string; refreshToken: string } | null> {
    if (!accounts.has('gog') || disposed) return null
    // A refresh in progress may replace the refresh token: read the one it stores.
    await refreshes.get(refreshKey('gog'))?.catch(() => null)
    const tokens = await tokensFor('gog')
    if (!tokens || disposed) return null
    const { userId, refreshToken } = tokens as { userId?: unknown; refreshToken?: unknown }
    return typeof userId === 'string' && userId && typeof refreshToken === 'string' && refreshToken
      ? { userId, refreshToken }
      : null
  }

  const epicReads = new Map<boolean, Promise<{ accountId: string; accessToken: string } | null>>()

  function epicAccessToken(force = false): Promise<string | null> {
    // Install sizes only need a token or none: a refresh that could not reach Epic is "none" here.
    return epicCredential(force).then(
      (c) => c?.accessToken ?? null,
      () => null
    )
  }

  function epicCredential(
    force = false
  ): Promise<{ accountId: string; accessToken: string } | null> {
    if (!accounts.has('epic') || disposed) return Promise.resolve(null)
    // One at a time: a whole scan asks for the token, and every refresh writes the same store entry.
    const running = epicReads.get(force)
    if (running) return running
    // The other kind of read still running (forced vs not): this one starts from what it stores, never from the same
    // refresh token (Epic may have spent it, and refusing it would sign Epic out).
    const other = epicReads.get(!force)
    const task = (async (): Promise<{ accountId: string; accessToken: string } | null> => {
      await other?.catch(() => null)
      // A forced refresh waits for one already running (the import's, an expiry refresh) and starts from what it
      // stored: the refresh token it used may be spent.
      if (force) await refreshes.get(refreshKey('epic'))?.catch(() => null)
      // Taken before the read: a sign-out while the token is read or refreshed writes nothing back.
      const started = generationOf('epic')
      const tokens = await tokensFor('epic')
      if (!tokens || disposed || generationOf('epic') !== started) return null
      // A forced refresh: the token looks expired to the store module, which then always asks Epic for a new one.
      const asked = force ? { ...tokens, expiresAt: new Date(0).toISOString() } : tokens
      let refreshed: AccountTokens | null
      try {
        // A token that is not about to expire comes back as it is.
        refreshed = await sharedRefresh('epic', asked)
      } catch (err) {
        // Epic could not be reached (still signed in): the caller tries again later, it is no sign-out.
        log.debug(`epic: token refresh failed: ${describeError(err)}`)
        throw err
      }
      if (disposed || generationOf('epic') !== started) return null
      if (!refreshed) {
        await dropSession('epic', tokens)
        await emitChanged()
        return null
      }
      if (refreshed !== tokens && refreshed !== asked) await tokenStore.set('epic', refreshed)
      const accessToken = refreshed.accessToken
      const accountId = refreshed.accountId ?? tokens.accountId
      return typeof accessToken === 'string' &&
        accessToken &&
        typeof accountId === 'string' &&
        accountId
        ? { accountId, accessToken }
        : null
    })().finally(() => epicReads.delete(force))
    epicReads.set(force, task)
    return task
  }

  async function signIn(source: StoreSourceId): Promise<AccountStatus> {
    const a = account(source)
    if (!a.supported)
      throw new Error(a.reason ?? tMain('mainAccounts.accountsUnsupported', { store: a.storeName }))
    if (authWindows.isOpen()) throw new Error(tMain('mainAccounts.signIn.windowOpen'))
    const ctx = context(source)
    let tokens: AccountTokens | null
    try {
      tokens = await a.signIn(authWindows.visible(source, a.storeName), ctx)
    } catch (err) {
      const message = describeError(err)
      log.error(`${source}: sign-in failed: ${message}`)
      errors.set(source, { text: tMain('mainAccounts.signIn.failed', { error: message }) })
      await emitChanged()
      throw new Error(tMain('mainAccounts.signIn.failed', { error: message }), { cause: err })
    }
    if (!tokens) {
      log.info(`${source}: sign-in window closed without a credential`)
      return status(source)
    }
    errors.delete(source)
    cancelRetry(source)
    // A new sign-in starts a new generation: an import fenced by an earlier sign-out stays fenced.
    generation.set(source, generationOf(source) + 1)
    await tokenStore.set(source, tokens)
    // Whoever was signed in before (an expired session, the Settings key, another account): its data goes, and
    // the import below refills it for this account.
    deps.onSignedOut?.(source)
    let displayName: string | undefined
    try {
      displayName = await a.displayName(tokens, ctx)
    } catch (err) {
      log.debug(`${source}: display name lookup failed: ${describeError(err)}`)
    }
    tokenStore.setMeta(source, { displayName })
    await tokenStore
      .flush()
      .catch((err) => log.warn(`accounts.json flush failed: ${describeError(err)}`))
    log.info(`${source}: signed in${displayName ? ` as ${displayName}` : ''}`)
    await emitChanged()
    void importOwned([source])
    return status(source)
  }

  async function signOut(source: StoreSourceId): Promise<AccountStatus> {
    const a = account(source)
    // The Steam API key lives in Settings > Metadata, not in the token store: there is nothing here to sign out of,
    // and removing the owned games would only last until the next import re-added them.
    const stored = await tokenStore.get(source)
    if (!stored && (await tokensFor(source))?.kind === 'apikey')
      throw new Error(apiKeySignOutMessage())
    // Fence the import that may be running for this store (startup, post-scan or Import click): it must not write
    // the credential or the owned list back when its refresh returns. Hidden loaders on the partition close first
    // so none of them repopulates the cookies after the clear.
    generation.set(source, generationOf(source) + 1)
    authWindows.closeHidden(source)
    tokenStore.delete(source)
    errors.delete(source)
    cancelRetry(source)
    deps.onSignedOut?.(source)
    await inflight.get(source)?.catch(() => undefined)
    try {
      await clearPartition(partitionFor(source))
    } catch (err) {
      log.warn(`${source}: clearing the sign-in partition failed: ${describeError(err)}`)
    }
    if ((await tokensFor(source)) === null) {
      const merge = deps.library.mergeOwned(source, [], {
        keepIds: new Set(deps.trackedInstalls?.() ?? [])
      })
      log.info(`${source}: signed out; ${merge.removed} owned-only game(s) removed`)
    } else {
      // The web credential is gone but the API key from Settings still signs the account in; the games stay.
      log.info(`${source}: web sign-in removed; ${a.storeName} stays signed in through the API key`)
    }
    await tokenStore
      .flush()
      .catch((err) => log.warn(`accounts.json flush failed: ${describeError(err)}`))
    await emitChanged()
    return status(source)
  }

  // One line per start so a support log shows which stores are signed in (names only, never credentials).
  log.info(
    `accounts: ${(await getAccounts())
      .map(
        (r) =>
          `${r.source}=${!r.supported ? 'unsupported' : r.signedIn ? `signed in${r.displayName ? ` (${r.displayName})` : ''}` : 'signed out'}`
      )
      .join(' ')}`
  )

  return {
    getAccounts,
    signIn,
    signOut,
    importOwned,
    account,
    steamCredential,
    epicAccessToken,
    epicCredential,
    epicSignedIn: () => accounts.has('epic') && !disposed && tokenStore.has('epic'),
    gogCredential,
    async steamOwnedApps() {
      if (!accounts.has('steam') || disposed) return null
      const tokens = await tokensFor('steam')
      if (!tokens || tokens.kind !== 'web') return null
      try {
        const data = await loadJsonViaWindow<unknown>(
          authWindows.hidden('steam'),
          STEAM_USERDATA_URL,
          'Steam'
        )
        return parseOwnedApps(data)
      } catch (err) {
        log.debug(`steam: owned apps not read: ${describeError(err)}`)
        return null
      }
    },
    installSpec: (game, client) =>
      game.source === 'manual' || game.source === 'rom'
        ? null
        : account(game.source).installSpec(game, client),
    installError: (game, client) => {
      if (game.source === 'manual' || game.source === 'rom')
        return tMain('mainAccounts.install.notFromStore')
      const a = account(game.source)
      return (
        a.installError?.(game, client) ??
        tMain('mainAccounts.install.cannotInstall', { store: a.storeName })
      )
    },
    async dispose() {
      disposed = true
      for (const source of [...retryTimers.keys()]) cancelRetry(source)
      authWindows.closeAll()
      await tokenStore.flush().catch(() => undefined)
    }
  }
}

export type { StoreAccount, InstallSpec, AccountTokens } from './types'
