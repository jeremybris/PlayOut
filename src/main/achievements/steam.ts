// Steam achievements without a Web API key. Signing in to Steam (Library > Settings) gives PlayOut a web
// access token, which the ISteamUserStats interface refuses ("Required parameter 'key' is missing"); the
// IPlayerService interface takes it. GetAchievementsProgress answers unlocked / total for many games in one call
// (the library pass), GetGameAchievements lists a game's achievements without any credential, and the player's
// unlocks come from GetTopAchievementsForGames, or from the public profile's stats page when that list is short.
import { XMLParser } from 'fast-xml-parser'
import type { AchievementsInfo } from '../../shared/types'
import { buildUrl, httpJson, HttpError, httpText, type HttpOptions } from '../scrapers/http'
import {
  steamAchievements,
  steamStoreAchievementTotal,
  webApiLimiter,
  WEB_API
} from '../scrapers/steam-store'
import { tMain } from '../i18n'

const ICON_BASE = 'https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps'
const COMMUNITY = 'https://steamcommunity.com/profiles'
/** Apps per GetAchievementsProgress call. */
export const PROGRESS_BATCH = 100
const REQUEST: HttpOptions = { timeoutMs: 20_000, retries: 1 }

/** The Settings > Metadata Web API key, or the token of the signed-in Steam account. */
export type SteamCredential =
  { steamId64: string; key: string } | { steamId64: string; accessToken: string }

/** Steam refused the credential (an expired access token, a revoked key). */
export class SteamAuthError extends Error {
  constructor() {
    super(tMain('mainApp.steam.credentialRefused'))
    this.name = 'SteamAuthError'
  }
}

function credentialParams(credential: SteamCredential): Record<string, string> {
  return 'key' in credential ? { key: credential.key } : { access_token: credential.accessToken }
}

function isAuthFailure(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 401 || err.status === 403)
}

export interface SteamProgress {
  unlocked: number
  total: number
}

interface ProgressResponse {
  response?: {
    achievement_progress?: { appid?: number; unlocked?: number; total?: number }[]
  }
}

/**
 * Unlocked / total for every app in `appIds`, PROGRESS_BATCH apps per request. An app without achievements comes
 * back with total 0 or not at all. Throws SteamAuthError when Steam refuses the credential.
 */
export async function steamAchievementsProgress(
  appIds: readonly number[],
  credential: SteamCredential
): Promise<Map<number, SteamProgress>> {
  const out = new Map<number, SteamProgress>()
  for (let i = 0; i < appIds.length; i += PROGRESS_BATCH) {
    const batch = appIds.slice(i, i + PROGRESS_BATCH)
    const form = new URLSearchParams({
      ...credentialParams(credential),
      steamid: credential.steamId64,
      language: 'english'
    })
    batch.forEach((appId, index) => form.set(`appids[${index}]`, String(appId)))
    await webApiLimiter.take()
    let body: ProgressResponse
    try {
      // This method only answers POST.
      body = await httpJson<ProgressResponse>(
        `${WEB_API}/IPlayerService/GetAchievementsProgress/v1/`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString()
        },
        REQUEST
      )
    } catch (err) {
      if (isAuthFailure(err)) throw new SteamAuthError()
      throw err
    }
    for (const row of body?.response?.achievement_progress ?? []) {
      const appId = Number(row.appid)
      if (!Number.isInteger(appId) || appId <= 0) continue
      out.set(appId, { unlocked: Number(row.unlocked) || 0, total: Number(row.total) || 0 })
    }
  }
  return out
}

interface GameAchievementsResponse {
  response?: {
    achievements?: {
      internal_name?: string
      localized_name?: string
      localized_desc?: string
      icon?: string
      icon_gray?: string
      hidden?: boolean
      archived?: boolean
    }[]
  }
}

interface TopAchievementsResponse {
  response?: {
    games?: {
      appid?: number
      total_achievements?: number
      achievements?: { name?: string; icon?: string }[]
    }[]
  }
}

interface CommunityStats {
  playerstats?: {
    error?: string
    achievements?: {
      achievement?: CommunityAchievement | CommunityAchievement[]
    }
  }
}

interface CommunityAchievement {
  '@_closed'?: string | number
  closed?: string | number
  apiname?: string
  unlockTimestamp?: string | number
}

const fileOf = (icon: string | undefined): string => (icon ?? '').split('/').pop() ?? ''

/** The achievements the public profile's stats page shows as earned, by API name, with unlock times. */
async function communityUnlocks(
  appId: number,
  steamId64: string
): Promise<Map<string, number | undefined> | null> {
  const xml = await httpText(
    `${COMMUNITY}/${steamId64}/stats/${appId}/achievements/?xml=1&l=english`,
    {},
    { timeoutMs: 15_000, retries: 0 }
  )
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as CommunityStats
  const stats = parsed.playerstats
  if (!stats || stats.error) return null
  const rows = stats.achievements?.achievement
  const list = Array.isArray(rows) ? rows : rows ? [rows] : []
  const out = new Map<string, number | undefined>()
  for (const row of list) {
    const closed = String(row.closed ?? row['@_closed'] ?? '0') === '1'
    if (!closed || !row.apiname) continue
    const time = Number(row.unlockTimestamp)
    out.set(String(row.apiname).toLowerCase(), Number.isFinite(time) && time > 0 ? time : undefined)
  }
  return out
}

/**
 * A game's achievements with the player's unlocks, read with the signed-in account's access token. null when the
 * game has no achievements. Throws SteamAuthError when Steam refuses the token.
 */
export async function steamAchievementsWithToken(
  appId: number,
  credential: { steamId64: string; accessToken: string }
): Promise<AchievementsInfo | null> {
  await webApiLimiter.take()
  const schema = await httpJson<GameAchievementsResponse>(
    buildUrl(`${WEB_API}/IPlayerService/GetGameAchievements/v1/`, {
      appid: appId,
      language: 'english'
    }),
    {},
    REQUEST
  )
  const defs = (schema?.response?.achievements ?? []).filter((d) => d.internal_name && !d.archived)
  if (!defs.length) return null

  const progress = (await steamAchievementsProgress([appId], credential)).get(appId)
  const unlocked = new Map<string, number | undefined>()
  if (progress && progress.unlocked > 0) {
    await webApiLimiter.take()
    let top: TopAchievementsResponse
    try {
      top = await httpJson<TopAchievementsResponse>(
        buildUrl(`${WEB_API}/IPlayerService/GetTopAchievementsForGames/v1/`, {
          access_token: credential.accessToken,
          steamid: credential.steamId64,
          language: 'english',
          max_achievements: defs.length,
          'appids[0]': appId
        }),
        {},
        REQUEST
      )
    } catch (err) {
      if (isAuthFailure(err)) throw new SteamAuthError()
      throw err
    }
    const earned = top?.response?.games?.find((g) => Number(g.appid) === appId)?.achievements ?? []
    const byIcon = new Map(defs.map((d) => [fileOf(d.icon).toLowerCase(), d]))
    const byName = new Map(defs.map((d) => [d.localized_name?.trim().toLowerCase() ?? '', d]))
    for (const a of earned) {
      const def =
        byIcon.get(fileOf(a.icon).toLowerCase()) ?? byName.get(a.name?.trim().toLowerCase() ?? '')
      if (def?.internal_name) unlocked.set(def.internal_name.toLowerCase(), undefined)
    }
    // Steam may cap that list; the public stats page has every unlock (and its time) when the profile allows it.
    if (unlocked.size < progress.unlocked) {
      const community = await communityUnlocks(appId, credential.steamId64).catch(() => null)
      if (community) for (const [name, time] of community) unlocked.set(name, time)
    }
  }

  const list: AchievementsInfo['list'] = defs.map((d) => {
    const name = d.internal_name as string
    const isUnlocked = unlocked.has(name.toLowerCase())
    const time = unlocked.get(name.toLowerCase())
    const icon = isUnlocked ? d.icon : (d.icon_gray ?? d.icon)
    return {
      id: name,
      name: d.localized_name?.trim() || name,
      description: d.localized_desc?.trim() || undefined,
      unlocked: isUnlocked,
      unlockedAt: time ? new Date(time * 1000).toISOString() : undefined,
      icon: icon ? `${ICON_BASE}/${appId}/${fileOf(icon)}` : undefined,
      hidden: d.hidden === true
    }
  })
  const listed = list.filter((a) => a.unlocked).length
  return {
    provider: 'steam',
    total: list.length,
    // The list can be short of unlocks when Steam caps it and the profile is private; the count is still right.
    unlocked: Math.max(listed, Math.min(progress?.unlocked ?? 0, list.length)),
    list
  }
}

/**
 * How many achievements Steam lists for the app (archived ones left out), read without any credential. A game with
 * achievements lists them in GetGameAchievements. That endpoint answers `{"response":{}}` both for an app without
 * achievements (Call of Duty: United Offensive, 2640) and for one it cannot resolve right now, so an empty list is
 * checked against the store page (appdetails `filters=achievements`): 0 only when the store also lists none, the
 * store's count when it lists some, and null when the store does not know the app (nothing can be said). Throws
 * when Steam cannot be asked (offline, a rate limit, an error status), which says nothing about the game.
 */
export async function steamAchievementCount(appId: number): Promise<number | null> {
  await webApiLimiter.take()
  const schema = await httpJson<GameAchievementsResponse>(
    buildUrl(`${WEB_API}/IPlayerService/GetGameAchievements/v1/`, {
      appid: appId,
      language: 'english'
    }),
    {},
    REQUEST
  )
  if (!schema || typeof schema !== 'object' || !schema.response)
    throw new Error(`Steam sent no achievement list for ${appId}`)
  const listed = (schema.response.achievements ?? []).filter(
    (d) => d.internal_name && !d.archived
  ).length
  if (listed > 0) return listed
  return steamStoreAchievementTotal(appId)
}

/** A game's achievements with whichever credential the user has: the Web API key's full list, or the token's. */
export async function steamGameAchievements(
  appId: number,
  credential: SteamCredential
): Promise<AchievementsInfo | null> {
  if ('key' in credential) {
    const info = await steamAchievements(appId, credential.key, credential.steamId64)
    return info ? { provider: 'steam', ...info } : null
  }
  return steamAchievementsWithToken(appId, credential)
}
