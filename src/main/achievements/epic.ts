// Epic Games achievements, read the way Legendary and Heroic read them (legendary/api/egs.py get_game_achievements and
// get_game_achievements_user, queries in legendary/models/gql.py): the launcher store's GraphQL service. A game's
// achievement definitions are public (no login) and keyed by its sandbox id, which is the namespace PlayOut already
// stores in `extra.epicNamespace`; the signed-in account's unlocks come from the same service with the launcher's
// access token, joined to the definitions by achievement name. The definitions alone say whether a game has
// achievements at all (totalAchievements null or 0): that is the only answer PlayOut takes as "none".
//
// launcher.store.epicgames.com, not store.epicgames.com: the latter is behind a Cloudflare check that answers Node's
// fetch with a challenge page. This is Epic's own launcher service, not a published API: when Epic changes it, reads
// fail quietly (logged, retried later) and nothing else breaks. Tokens are never logged or stored here.
import { createHash } from 'node:crypto'
import type { AchievementsInfo } from '../../shared/types'
import { HttpError, httpJson, RateLimiter, type HttpOptions } from '../scrapers/http'
import { PriorityPacer } from './gog'

const GRAPHQL_URL = 'https://launcher.store.epicgames.com/graphql'
/**
 * Epic's check of an access token: 200 with the token's account when Epic accepts it, 401 when not. Legendary asks the
 * same (EPCAPI.resume_session in legendary/api/egs.py: GET https://{_oauth_host}/account/api/oauth/verify).
 */
const VERIFY_URL = 'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/verify'

/**
 * The user agent Legendary sends to the launcher store's GraphQL service (EPCAPI._store_user_agent in
 * legendary/api/egs.py, https://github.com/derrod/legendary; Heroic runs Legendary for its Epic games).
 */
export const EPIC_STORE_USER_AGENT = 'EpicGamesLauncher/14.0.8-22004686+++Portal+Release-Live'

const DEFINITIONS_QUERY = `query Achievement($sandboxId: String!, $locale: String!) {
  Achievement {
    productAchievementsRecordBySandbox(sandboxId: $sandboxId, locale: $locale) {
      totalAchievements
      totalProductXP
      achievements {
        achievement {
          name
          hidden
          unlockedDisplayName
          lockedDisplayName
          unlockedDescription
          lockedDescription
          unlockedIconLink
          lockedIconLink
          XP
        }
      }
    }
  }
}`

const PLAYER_QUERY = `query PlayerAchievement($epicAccountId: String!, $sandboxId: String!) {
  PlayerAchievement {
    playerAchievementGameRecordsBySandbox(epicAccountId: $epicAccountId, sandboxId: $sandboxId) {
      records {
        totalXP
        totalUnlocked
        playerAchievements {
          playerAchievement {
            achievementName
            unlocked
            unlockDate
            XP
          }
        }
      }
    }
  }
}`

/** Whose request it is: a game page being opened goes before the background scan's. */
export type EpicPriority = 'page' | 'scan'

/** About one request a second, shared by every Epic achievements request; a page open's go first. */
const pacer = new PriorityPacer(new RateLimiter(1, 2))
const request = (priority: EpicPriority): HttpOptions => ({
  timeoutMs: 20_000,
  retries: 1,
  limiter: { take: () => pacer.take(priority) }
})
/** A game's definitions are read again after this long (they change only when the game adds achievements). */
const DEFINITIONS_TTL_MS = 6 * 60 * 60 * 1000
/** A token refused with a server error (Epic answers a bad token with a 500) is refreshed at most this often. */
const SERVER_ERROR_REFRESH_MS = 10 * 60 * 1000
/** Server errors (or answers that are no JSON) for this many games in a row: Epic's service is down for everyone. */
const SERVER_ERRORS_FOR_ALL = 3

/** The signed-in Epic account, as the achievements need it (never logged). */
export interface EpicAccountCredential {
  accountId: string
  accessToken: string
}

/** Epic's GraphQL answered with errors and no data the query asked for (the service changed, or refused the token). */
export class EpicGraphqlError extends Error {
  constructor(
    message: string,
    /** The errors mention authentication: the token was refused. */
    readonly auth: boolean
  ) {
    super(message)
    this.name = 'EpicGraphqlError'
  }
}

interface GraphqlAnswer<T> {
  data?: T
  errors?: unknown
}

async function graphql<T>(
  query: string,
  variables: Record<string, string>,
  priority: EpicPriority,
  token?: string
): Promise<GraphqlAnswer<T>> {
  return httpJson<GraphqlAnswer<T>>(
    GRAPHQL_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': EPIC_STORE_USER_AGENT,
        ...(token ? { Authorization: `bearer ${token}` } : {})
      },
      body: JSON.stringify({ query, variables })
    },
    request(priority)
  )
}

/** Whether a GraphQL answer carries errors: then its data (even when present) may be partial and is not trusted. */
const hasErrors = (answer: GraphqlAnswer<unknown>): boolean =>
  Array.isArray(answer.errors) && answer.errors.length > 0

/** Epic's error codes of a refused token (errors.com.epicgames.common.authentication.token_verification_failed, ...). */
const AUTH_ERROR_CODE =
  /^errors\.com\.epicgames\.common\.(?:(?:authentication|authorization|oauth)\.|missing_permission$)/i
/** Message wording of a refused token (only the message is looked at, never ids or other fields). */
const AUTH_MESSAGE =
  /\b(?:unauthori[sz]ed|unauthenticated|not authenticated|authentication (?:failed|required)|invalid (?:bearer |access )?token|token (?:is )?(?:invalid|expired))\b/i

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** One GraphQL error says the token was refused: a 401/403 status, an auth error code, or an auth message. */
export function isEpicAuthError(error: unknown): boolean {
  const e = record(error)
  if (!e) return false
  const extensions = record(e.extensions)
  let service = record(e.serviceResponse)
  if (!service && typeof e.serviceResponse === 'string') {
    try {
      service = record(JSON.parse(e.serviceResponse))
    } catch {
      service = undefined
    }
  }
  const statuses = [e.status, e.statusCode, extensions?.status, extensions?.statusCode]
  if (statuses.some((s) => s === 401 || s === 403)) return true
  const codes = [e.errorCode, extensions?.errorCode, service?.errorCode]
  if (codes.some((c) => typeof c === 'string' && AUTH_ERROR_CODE.test(c))) return true
  if (extensions?.code === 'UNAUTHENTICATED' || extensions?.code === 'FORBIDDEN') return true
  return typeof e.message === 'string' && AUTH_MESSAGE.test(e.message)
}

/** A GraphQL answer with errors or without the asked data: an EpicGraphqlError naming what Epic said (no token in it). */
function graphqlFailure(answer: GraphqlAnswer<unknown>, what: string): EpicGraphqlError {
  const errors = Array.isArray(answer.errors) ? answer.errors : []
  const auth = errors.some(isEpicAuthError)
  const first = record(errors[0])
  const message = typeof first?.message === 'string' ? first.message.slice(0, 200) : 'no data'
  return new EpicGraphqlError(`Epic gave no ${what}: ${message}`, auth)
}

export interface EpicAchievementDef {
  name: string
  hidden: boolean
  unlockedName?: string
  lockedName?: string
  unlockedDescription?: string
  lockedDescription?: string
  unlockedIcon?: string
  lockedIcon?: string
  xp?: number
}

export interface EpicDefinitions {
  /** totalAchievements as Epic states it. */
  total: number
  /** totalProductXP, when Epic gives it. */
  xp?: number
  achievements: EpicAchievementDef[]
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined
const httpsUrl = (v: unknown): string | undefined => {
  const s = text(v)
  return s && /^https:\/\//i.test(s) ? s : undefined
}
const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined

interface DefinitionsData {
  Achievement?: {
    productAchievementsRecordBySandbox?: {
      totalAchievements?: unknown
      totalProductXP?: unknown
      achievements?: { achievement?: Record<string, unknown> | null }[] | null
    } | null
  } | null
}

/**
 * The definitions in an answer of the definitions query; null when Epic states the game has no achievements
 * (totalAchievements null or 0) in an answer without errors. Throws when the answer carries errors (a null count next
 * to an error is a failure, never "none") or is not the shape Legendary reads (the service changed).
 */
export function parseEpicDefinitions(
  answer: GraphqlAnswer<DefinitionsData>
): EpicDefinitions | null {
  const defs = answer.data?.Achievement?.productAchievementsRecordBySandbox
  if (hasErrors(answer) || !defs || typeof defs !== 'object')
    throw graphqlFailure(answer, 'achievement definitions')
  const total = defs.totalAchievements
  if (total === null || total === 0) return null
  if (count(total) === undefined)
    throw new EpicGraphqlError('Epic gave an unreadable achievement count', false)
  const achievements: EpicAchievementDef[] = []
  const seen = new Set<string>()
  for (const row of Array.isArray(defs.achievements) ? defs.achievements : []) {
    const a = row?.achievement
    const name = text(a?.name)
    if (!a || !name || seen.has(name)) continue
    seen.add(name)
    achievements.push({
      name,
      hidden: a.hidden === true,
      unlockedName: text(a.unlockedDisplayName),
      lockedName: text(a.lockedDisplayName),
      unlockedDescription: text(a.unlockedDescription),
      lockedDescription: text(a.lockedDescription),
      unlockedIcon: httpsUrl(a.unlockedIconLink),
      lockedIcon: httpsUrl(a.lockedIconLink),
      xp: count(a.XP)
    })
  }
  return { total: total as number, xp: count(defs.totalProductXP), achievements }
}

/** Definitions by sandbox and locale, in memory only. */
const definitionsCache = new Map<string, { at: number; value: EpicDefinitions | null }>()

/** A game's achievement definitions (public, no login); null when it has none. */
export async function epicAchievementDefinitions(
  sandboxId: string,
  locale = 'en-US',
  priority: EpicPriority = 'scan'
): Promise<EpicDefinitions | null> {
  const key = `${sandboxId}\n${locale}`
  const known = definitionsCache.get(key)
  if (known && Date.now() - known.at < DEFINITIONS_TTL_MS) return known.value
  const answer = await graphql<DefinitionsData>(DEFINITIONS_QUERY, { sandboxId, locale }, priority)
  const value = parseEpicDefinitions(answer)
  definitionsCache.set(key, { at: Date.now(), value })
  return value
}

export interface EpicPlayerAchievement {
  name: string
  unlocked: boolean
  unlockDate?: string
}

interface PlayerData {
  PlayerAchievement?: {
    playerAchievementGameRecordsBySandbox?: {
      records?:
        | {
            playerAchievements?: { playerAchievement?: Record<string, unknown> | null }[] | null
          }[]
        | null
    } | null
  } | null
}

/**
 * The account's achievements of the game in an answer of the player query; null when Epic gave no records. Epic gives
 * none both for a game the account never unlocked anything in and for a request whose token it ignored, so null is
 * "nothing unlocked" only once the token is known to be accepted (readEpicAchievements checks it). Throws when the
 * answer carries errors (an auth one: the token was refused) or is not the shape Legendary reads.
 */
export function parseEpicPlayer(answer: GraphqlAnswer<PlayerData>): EpicPlayerAchievement[] | null {
  const holder = answer.data?.PlayerAchievement?.playerAchievementGameRecordsBySandbox
  if (hasErrors(answer) || !holder || typeof holder !== 'object')
    throw graphqlFailure(answer, 'player achievements')
  if (!Array.isArray(holder.records) || !holder.records.length) return null
  const out: EpicPlayerAchievement[] = []
  for (const rec of holder.records) {
    for (const row of Array.isArray(rec?.playerAchievements) ? rec.playerAchievements : []) {
      const p = row?.playerAchievement
      const name = text(p?.achievementName)
      if (!p || !name) continue
      out.push({ name, unlocked: p.unlocked === true, unlockDate: text(p.unlockDate) })
    }
  }
  return out
}

/**
 * The account's achievements of the game (null: Epic gave no records, see parseEpicPlayer); HttpError /
 * EpicGraphqlError when Epic refused or failed.
 */
export async function epicPlayerAchievements(
  credential: EpicAccountCredential,
  sandboxId: string,
  priority: EpicPriority = 'scan'
): Promise<EpicPlayerAchievement[] | null> {
  const answer = await graphql<PlayerData>(
    PLAYER_QUERY,
    { epicAccountId: credential.accountId, sandboxId },
    priority,
    credential.accessToken
  )
  return parseEpicPlayer(answer)
}

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')
/** The account and access token (a hash only) Epic last said it accepts. */
let acceptedToken: string | null = null

/**
 * Whether Epic accepts the access token for the account (asked once per token). False when Epic refuses it; throws
 * when Epic could not be asked.
 */
export async function epicTokenAccepted(
  credential: EpicAccountCredential,
  priority: EpicPriority = 'scan'
): Promise<boolean> {
  const hash = tokenHash(`${credential.accountId}\n${credential.accessToken}`)
  if (acceptedToken === hash) return true
  try {
    const answer = await httpJson<{ account_id?: unknown }>(
      VERIFY_URL,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': EPIC_STORE_USER_AGENT,
          Authorization: `bearer ${credential.accessToken}`
        }
      },
      request(priority)
    )
    if (typeof answer.account_id === 'string' && answer.account_id !== credential.accountId)
      return false
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return false
    throw err
  }
  acceptedToken = hash
  return true
}

/** An unlock date worth showing: a real time (Epic fills "0001-01-01" for none). */
function unlockedAt(when: string | undefined): string | undefined {
  if (!when) return undefined
  const ms = Date.parse(when)
  return Number.isFinite(ms) && new Date(ms).getUTCFullYear() >= 2000
    ? new Date(ms).toISOString()
    : undefined
}

/**
 * The definitions joined with the account's unlocks (by achievement name), in Epic's order. XP shows as points. A hidden
 * achievement keeps its texts: the list shows "Hidden" until it is unlocked.
 */
export function mapEpicAchievements(
  defs: EpicDefinitions,
  player: EpicPlayerAchievement[],
  url?: string
): AchievementsInfo {
  const byName = new Map<string, EpicPlayerAchievement>()
  for (const p of player) if (p.unlocked || !byName.has(p.name)) byName.set(p.name, p)
  let earned = 0
  let possible = 0
  const list: AchievementsInfo['list'] = defs.achievements.map((def) => {
    const mine = byName.get(def.name)
    const unlocked = mine?.unlocked === true
    possible += def.xp ?? 0
    if (unlocked) earned += def.xp ?? 0
    const item: AchievementsInfo['list'][number] = {
      id: def.name,
      name:
        (unlocked ? def.unlockedName : def.lockedName) ??
        def.unlockedName ??
        def.lockedName ??
        def.name,
      description: unlocked
        ? (def.unlockedDescription ?? def.lockedDescription)
        : (def.lockedDescription ?? def.unlockedDescription),
      unlocked,
      unlockedAt: unlocked ? unlockedAt(mine?.unlockDate) : undefined,
      icon: unlocked ? (def.unlockedIcon ?? def.lockedIcon) : (def.lockedIcon ?? def.unlockedIcon),
      ...(def.hidden ? { hidden: true } : {}),
      ...(def.xp !== undefined ? { points: def.xp } : {})
    }
    return Object.fromEntries(
      Object.entries(item).filter(([, v]) => v !== undefined)
    ) as AchievementsInfo['list'][number]
  })
  const totalXp = defs.xp && defs.xp > 0 ? defs.xp : possible
  return {
    provider: 'epic',
    total: list.length,
    unlocked: list.filter((a) => a.unlocked).length,
    ...(totalXp > 0 ? { points: { earned, total: totalXp } } : {}),
    ...(url ? { url } : {}),
    list
  }
}

/** What Epic says about one game's achievements for the signed-in account. */
export type EpicRead =
  | { kind: 'list'; info: AchievementsInfo }
  /** Epic's definitions state the game has no achievements. */
  | { kind: 'none' }
  /** Epic states a count but listed none: read again once played. */
  | { kind: 'unknown' }
  /** Not signed in to Epic in PlayOut, or Epic refused the account's token even after a refresh. */
  | { kind: 'signed-out' }

export interface EpicReadDeps {
  /**
   * The signed-in account; `refresh` asks Epic for a new access token first. Null: signed out. Throws when the token
   * could not be refreshed (Epic's sign-in service out of reach): the scan waits and tries again.
   */
  credential(refresh: boolean): Promise<EpicAccountCredential | null>
  definitions?: typeof epicAchievementDefinitions
  player?: typeof epicPlayerAchievements
  /** Whether Epic accepts the token (asked when Epic gave no records). */
  tokenAccepted?: typeof epicTokenAccepted
  /** Whether Epic's GraphQL service answers at all (a public request), after a server error on the player query. */
  serviceAnswers?: (sandboxId: string, priority: EpicPriority) => Promise<boolean>
  locale?: () => string
  /** The game's page on the Epic store (https only), for the list's link. */
  storeUrl?: string
}

/** When a server error last made the token refresh (see SERVER_ERROR_REFRESH_MS). */
let serverErrorRefreshAt = 0
/** Games in a row whose read met a server error (see SERVER_ERRORS_FOR_ALL). */
let serverErrorsInRow = 0

/** The token check said Epic does not accept the account's token. */
class EpicTokenRefused extends Error {
  constructor() {
    super('Epic refused the access token')
    this.name = 'EpicTokenRefused'
  }
}

/** Epic refused the token itself: a 401, GraphQL errors about authentication, or the token check said no. */
const tokenRefused = (err: unknown): boolean =>
  (err instanceof HttpError && err.status === 401) ||
  (err instanceof EpicGraphqlError && err.auth) ||
  err instanceof EpicTokenRefused

/** Epic's service failed rather than answered: a 5xx, or an answer that is no JSON (an error page). */
const serverTrouble = (err: unknown): boolean =>
  err instanceof HttpError && (err.status >= 500 || /^invalid JSON/.test(err.message))

/**
 * A failure every Epic game would meet, as an HttpError with status 0: the scan pauses as a whole with a growing wait
 * (scan-scheduler.ts sharedFailure) instead of failing game by game. The original's text is kept for the log.
 */
function everyoneWaits(what: string, err: unknown): HttpError {
  const why = err instanceof Error ? err.message : String(err)
  return new HttpError(`Epic ${what}: ${why}`.slice(0, 300), { status: 0, url: GRAPHQL_URL })
}

/** The public definitions query answers (not from the cache): Epic's GraphQL service works. */
async function graphqlAnswers(sandboxId: string, priority: EpicPriority): Promise<boolean> {
  try {
    const answer = await graphql<DefinitionsData>(
      DEFINITIONS_QUERY,
      { sandboxId, locale: 'en-US' },
      priority
    )
    return !hasErrors(answer) && !!answer.data?.Achievement
  } catch {
    return false
  }
}

/**
 * One game's achievements with the signed-in Epic account. Throws when Epic could not be asked: a failure of this game
 * (the scan's backoff takes it), or an HttpError with status 0 when Epic is out of reach for every game (the token
 * could not be refreshed, the token check failed, or the GraphQL service failed for several games in a row or does not
 * answer at all): the whole scan pauses. A refused token is refreshed once; refused again, the account counts as signed
 * out.
 */
export async function readEpicAchievements(
  sandboxId: string,
  deps: EpicReadDeps,
  priority: EpicPriority = 'scan'
): Promise<EpicRead> {
  const credentialOf = async (refresh: boolean): Promise<EpicAccountCredential | null> => {
    try {
      return await deps.credential(refresh)
    } catch (err) {
      // Not a sign-out: the token could not be refreshed now.
      throw everyoneWaits('sign-in could not be refreshed', err)
    }
  }
  let credential = await credentialOf(false)
  if (!credential) return { kind: 'signed-out' }
  const definitionsOf = deps.definitions ?? epicAchievementDefinitions
  const playerOf = deps.player ?? epicPlayerAchievements
  const acceptedOf = deps.tokenAccepted ?? epicTokenAccepted
  const answersOf = deps.serviceAnswers ?? graphqlAnswers
  /** A server error of this game; several games in a row (or the service not answering at all) pause everything. */
  const failed = (err: unknown, down = false): unknown => {
    if (!serverTrouble(err)) return err
    serverErrorsInRow++
    return down || serverErrorsInRow >= SERVER_ERRORS_FOR_ALL
      ? everyoneWaits('achievements service failed', err)
      : err
  }
  let defs: EpicDefinitions | null
  try {
    defs = await definitionsOf(sandboxId, deps.locale?.() ?? 'en-US', priority)
  } catch (err) {
    throw failed(err)
  }
  if (!defs || !defs.achievements.length) {
    serverErrorsInRow = 0
    return { kind: defs ? 'unknown' : 'none' }
  }
  let player: EpicPlayerAchievement[]
  for (let attempt = 0; ; attempt++) {
    try {
      const records = await playerOf(credential, sandboxId, priority)
      if (records) player = records
      else {
        // No records: nothing unlocked, or a token Epic ignored. Only an accepted token makes it "nothing unlocked".
        let accepted: boolean
        try {
          accepted = await acceptedOf(credential, priority)
        } catch (err) {
          throw err instanceof HttpError ? everyoneWaits('token check failed', err) : err
        }
        if (!accepted) throw new EpicTokenRefused()
        player = []
      }
      break
    } catch (err) {
      if (tokenRefused(err)) {
        if (attempt > 0) return { kind: 'signed-out' }
        credential = await credentialOf(true)
        if (!credential) return { kind: 'signed-out' }
        continue
      }
      // Epic answers a token it does not accept with a 500 page too. A refresh is tried only when the service answers a
      // public request (not during an outage), and at most once a while (not once per game).
      if (
        attempt === 0 &&
        serverTrouble(err) &&
        Date.now() - serverErrorRefreshAt > SERVER_ERROR_REFRESH_MS
      ) {
        if (!(await answersOf(sandboxId, priority))) throw failed(err, true)
        serverErrorRefreshAt = Date.now()
        credential = await credentialOf(true)
        if (!credential) return { kind: 'signed-out' }
        continue
      }
      throw failed(err)
    }
  }
  serverErrorsInRow = 0
  return { kind: 'list', info: mapEpicAchievements(defs, player, deps.storeUrl) }
}

/** An Epic store page (https on store.epicgames.com) to link the list to; undefined for anything else. */
export function epicStoreUrl(link: unknown): string | undefined {
  const s = text(link)
  if (!s) return undefined
  try {
    const url = new URL(s)
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'store.epicgames.com'
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

/** Tests: forget the definitions read, the accepted token and the server-error state. */
export function resetEpicCaches(): void {
  definitionsCache.clear()
  serverErrorRefreshAt = 0
  serverErrorsInRow = 0
  acceptedToken = null
}
