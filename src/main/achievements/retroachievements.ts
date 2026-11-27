// RetroAchievements Web API client (https://api-docs.retroachievements.org): the account check, the per-console
// game lists that map ROM hashes to games, the user's progress across every game, and one game's achievements.
// Every call needs the user's own Web API key (`y`); it is never logged (redactSecrets masks `y=` and `z=`).
import type { AchievementsInfo } from '../../shared/types'
import { buildUrl, httpJson, HttpError, RateLimiter, type HttpOptions } from '../scrapers/http'
import { tMain } from '../i18n'

export const RA_SITE = 'https://retroachievements.org'
export const RA_API = `${RA_SITE}/API`
export const RA_MEDIA = 'https://media.retroachievements.org'
/** Where a signed-in user finds their Web API key. */
export const RA_KEY_URL = `${RA_SITE}/settings`

// RetroAchievements does not publish a number; every client of one key shares the limit, so stay well below it.
const limiter = new RateLimiter(3, 3)
const REQUEST: HttpOptions = { timeoutMs: 20_000, retries: 1 }

let userAgent = 'PlayOut'

/** RetroAchievements asks every client to identify itself; set once at startup (`PlayOut/<version>`). */
export function configureRetroAchievements(options: { userAgent: string }): void {
  userAgent = options.userAgent
}

export interface RaCredentials {
  username: string
  apiKey: string
}

export function raReady(creds: RaCredentials | null | undefined): creds is RaCredentials {
  return !!creds && creds.username.trim() !== '' && creds.apiKey.trim() !== ''
}

/** RetroAchievements refused the key (HTTP 401 / 403, or its "Unauthenticated." body). */
export class RaAuthError extends Error {
  constructor() {
    super(tMain('mainApp.ra.credentialsRejected'))
    this.name = 'RaAuthError'
  }
}

/** True for RetroAchievements' refusal of the key, whatever status carried it. */
export function isRaAuthFailure(err: unknown): boolean {
  if (err instanceof RaAuthError) return true
  if (!(err instanceof HttpError)) return false
  if (err.status === 401 || err.status === 419) return true
  return err.status === 403 && /unauthenticated|unauthorized/i.test(err.body ?? '')
}

interface CallOptions {
  /** Skip the shared limiter (the credential check: one request per edit, never queued behind a sync). */
  direct?: boolean
  http?: HttpOptions
}

async function call<T>(
  endpoint: string,
  creds: RaCredentials,
  params: Record<string, string | number>,
  options: CallOptions = {}
): Promise<T> {
  if (!options.direct) await limiter.take()
  const url = buildUrl(`${RA_API}/${endpoint}`, {
    ...params,
    z: creds.username.trim(),
    y: creds.apiKey.trim()
  })
  try {
    const body = await httpJson<T>(
      url,
      { headers: { 'User-Agent': userAgent, Accept: 'application/json' } },
      options.http ?? REQUEST
    )
    // The refusal also comes back as a 200 on some paths: { message: "Unauthenticated.", errors: [...] }.
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const b = body as { message?: unknown; errors?: unknown }
      if (b.message === 'Unauthenticated.' || (Array.isArray(b.errors) && !('ID' in b))) {
        throw new RaAuthError()
      }
    }
    return body
  } catch (err) {
    if (isRaAuthFailure(err)) throw new RaAuthError()
    throw err
  }
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface RaProfile {
  user: string
  avatar?: string
  points: number
  softcorePoints: number
}

interface ProfileResponse {
  User?: string
  UserPic?: string
  TotalPoints?: number
  TotalSoftcorePoints?: number
}

/** The user's profile; null when RetroAchievements has no user by that name. Throws RaAuthError for a bad key. */
export async function raProfile(
  creds: RaCredentials,
  options: CallOptions = {}
): Promise<RaProfile | null> {
  let body: ProfileResponse | unknown[] | null
  try {
    body = await call<ProfileResponse | unknown[] | null>(
      'API_GetUserProfile.php',
      creds,
      { u: creds.username.trim() },
      options
    )
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null
    throw err
  }
  if (!body || Array.isArray(body) || typeof body.User !== 'string' || !body.User) return null
  return {
    user: body.User,
    avatar: body.UserPic ? mediaUrl(body.UserPic) : undefined,
    points: Number(body.TotalPoints) || 0,
    softcorePoints: Number(body.TotalSoftcorePoints) || 0
  }
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

export interface RaGame {
  id: number
  title: string
  consoleId: number
  achievements: number
  points: number
  icon?: string
  /** Lower-case MD5s of every ROM RetroAchievements recognises for the game. */
  hashes: string[]
}

interface GameListRow {
  ID?: number
  Title?: string
  ConsoleID?: number
  NumAchievements?: number
  Points?: number
  ImageIcon?: string
  Hashes?: string[]
}

/** Every game of a console that has achievements, with its ROM hashes. Large for some consoles: cache it. */
export async function raGameList(consoleId: number, creds: RaCredentials): Promise<RaGame[]> {
  const rows = await call<GameListRow[] | null>(
    'API_GetGameList.php',
    creds,
    { i: consoleId, f: 1, h: 1 },
    { http: { timeoutMs: 60_000, retries: 2 } }
  )
  if (!Array.isArray(rows)) return []
  const out: RaGame[] = []
  for (const r of rows) {
    const id = Number(r.ID)
    if (!Number.isInteger(id) || id <= 0 || typeof r.Title !== 'string') continue
    out.push({
      id,
      title: r.Title,
      consoleId: Number(r.ConsoleID) || consoleId,
      achievements: Number(r.NumAchievements) || 0,
      points: Number(r.Points) || 0,
      icon: r.ImageIcon ? mediaUrl(r.ImageIcon) : undefined,
      hashes: Array.isArray(r.Hashes)
        ? r.Hashes.filter((h): h is string => typeof h === 'string').map((h) => h.toLowerCase())
        : []
    })
  }
  return out
}

export interface RaProgress {
  gameId: number
  unlocked: number
  unlockedHardcore: number
  total: number
}

interface CompletionResponse {
  Count?: number
  Total?: number
  Results?: {
    GameID?: number
    MaxPossible?: number
    NumAwarded?: number
    NumAwardedHardcore?: number
  }[]
}

const COMPLETION_PAGE = 500

/** The user's progress on every game they have played, paged 500 at a time. */
export async function raCompletionProgress(creds: RaCredentials): Promise<RaProgress[]> {
  const out: RaProgress[] = []
  for (let offset = 0; offset < 100_000; offset += COMPLETION_PAGE) {
    const page = await call<CompletionResponse | null>('API_GetUserCompletionProgress.php', creds, {
      u: creds.username.trim(),
      c: COMPLETION_PAGE,
      o: offset
    })
    const results = Array.isArray(page?.Results) ? page.Results : []
    for (const r of results) {
      const gameId = Number(r.GameID)
      if (!Number.isInteger(gameId) || gameId <= 0) continue
      const softcore = Number(r.NumAwarded) || 0
      const hardcore = Number(r.NumAwardedHardcore) || 0
      out.push({
        gameId,
        // NumAwarded counts every unlock, hardcore ones included; keep the larger in case a server counts apart.
        unlocked: Math.max(softcore, hardcore),
        unlockedHardcore: hardcore,
        total: Number(r.MaxPossible) || 0
      })
    }
    const total = Number(page?.Total) || 0
    if (!results.length || offset + results.length >= total) break
  }
  return out
}

/** A game the user played lately (on any device), with their progress in it. */
export interface RaRecentGame extends RaProgress {
  /** When they last played it (ISO); undefined when unreadable. */
  lastPlayed?: string
}

interface RecentRow {
  GameID?: number
  LastPlayed?: string
  NumPossibleAchievements?: number
  NumAchieved?: number
  NumAchievedHardcore?: number
}

/** RetroAchievements answers at most this many recently played games per request. */
export const RA_RECENT_MAX = 50

/**
 * The games the user played most recently, newest first (one request): play on any device (RetroArch on a handheld,
 * another PC) shows up here, so the counts of every recognised ROM played lately can be refreshed at once.
 */
export async function raRecentlyPlayed(
  creds: RaCredentials,
  count = RA_RECENT_MAX
): Promise<RaRecentGame[]> {
  const rows = await call<RecentRow[] | null>('API_GetUserRecentlyPlayedGames.php', creds, {
    u: creds.username.trim(),
    c: Math.max(1, Math.min(RA_RECENT_MAX, count))
  })
  if (!Array.isArray(rows)) return []
  const out: RaRecentGame[] = []
  for (const r of rows) {
    const gameId = Number(r.GameID)
    if (!Number.isInteger(gameId) || gameId <= 0) continue
    const softcore = Number(r.NumAchieved) || 0
    const hardcore = Number(r.NumAchievedHardcore) || 0
    out.push({
      gameId,
      unlocked: Math.max(softcore, hardcore),
      unlockedHardcore: hardcore,
      total: Number(r.NumPossibleAchievements) || 0,
      lastPlayed: raDate(r.LastPlayed)
    })
  }
  return out
}

interface GameProgressResponse {
  ID?: number
  Title?: string
  NumAchievements?: number
  Achievements?:
    | Record<
        string,
        {
          ID?: number
          Title?: string
          Description?: string
          Points?: number
          BadgeName?: string
          DisplayOrder?: number
          DateEarned?: string
          DateEarnedHardcore?: string
        }
      >
    | unknown[]
}

/** "YYYY-MM-DD HH:MM:SS" (UTC) to ISO; undefined when absent or unreadable. */
function raDate(text: string | undefined): string | undefined {
  if (!text) return undefined
  const date = new Date(`${text.trim().replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** One game's achievements with the user's unlocks; null when the game has none. */
export async function raGameProgress(
  gameId: number,
  creds: RaCredentials
): Promise<AchievementsInfo | null> {
  const body = await call<GameProgressResponse | null>(
    'API_GetGameInfoAndUserProgress.php',
    creds,
    { g: gameId, u: creds.username.trim() }
  )
  // PHP encodes an empty map as [].
  const achievements =
    body?.Achievements && !Array.isArray(body.Achievements) ? Object.values(body.Achievements) : []
  if (!achievements.length) return null
  achievements.sort(
    (a, b) => (a.DisplayOrder ?? 0) - (b.DisplayOrder ?? 0) || (a.ID ?? 0) - (b.ID ?? 0)
  )
  let earned = 0
  let possible = 0
  const list: AchievementsInfo['list'] = achievements.map((a) => {
    const hardcoreAt = raDate(a.DateEarnedHardcore)
    const unlockedAt = hardcoreAt ?? raDate(a.DateEarned)
    const unlocked = unlockedAt !== undefined
    const points = Number(a.Points) || 0
    possible += points
    if (unlocked) earned += points
    const badge = a.BadgeName?.trim()
    return {
      id: String(a.ID ?? a.Title ?? ''),
      name: a.Title?.trim() || 'Achievement',
      description: a.Description?.trim() || undefined,
      unlocked,
      unlockedAt,
      icon: badge ? `${RA_MEDIA}/Badge/${badge}${unlocked ? '' : '_lock'}.png` : undefined,
      points,
      hardcore: hardcoreAt !== undefined || undefined
    }
  })
  return {
    provider: 'retroachievements',
    total: list.length,
    unlocked: list.filter((a) => a.unlocked).length,
    points: { earned, total: possible },
    url: `${RA_SITE}/game/${gameId}`,
    list
  }
}

/** RetroAchievements returns image paths ("/Images/012345.png", "/UserPic/Name.png"); the media host serves them. */
export function mediaUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${RA_MEDIA}${path.startsWith('/') ? '' : '/'}${path}`
}
