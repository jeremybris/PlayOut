// IGDB covers by external id (docs/ARCHITECTURE.md §4.6 "Art pipeline", research §2 and §13.7): one Apicalypse
// query per batch of 500 (`where external_games.uid = (...) & external_games.external_game_source = 1` for Steam
// appids, `where id = (...)` for games a scraper already matched) gives `cover.image_id`, and
// `images.igdb.com/.../t_cover_big_2x/<image_id>.jpg` (528x704) needs no auth. The Twitch client-credentials
// token is requested here the same way `igdb.ts` does, with the same safety margin.
import type { Settings } from '../../../shared/types'
import type { Logger } from '../../logger'
import { HttpError, httpJson, RateLimiter, redactUrl, USER_AGENT } from '../http'
import { IGDB_BASE_URL, igdbImageUrl, igdbLimiter, igdbScraper, TWITCH_TOKEN_URL } from '../igdb'
import type { ArtCandidates, ArtIds, DirectArtSource } from '../types'

export const IGDB_EXTERNAL_BATCH = 500
/** `external_games.external_game_source` of Steam. */
const STEAM_SOURCE = 1
const TOKEN_SAFETY_MS = 60_000

const SOURCE_ID = 'igdb-external' as const

interface IgdbGameRow {
  id?: number
  cover?: { image_id?: string }
  external_games?: { uid?: string; external_game_source?: number; category?: number }[]
}
interface TwitchToken {
  access_token?: string
  expires_in?: number
}

export interface IgdbExternalOptions {
  baseUrl?: string
  tokenUrl?: string
  /** The token bucket; default `igdb.ts`'s `igdbLimiter`, shared with the scraper (tests inject their own). */
  limiter?: RateLimiter
  /** The Twitch token provider; default the scraper's own (one token request per app), tests inject their own. */
  token?: (settings: Settings) => Promise<string>
  log?: Logger
}

/** Build the two queries of a batch: by Steam appid and by stored IGDB id. Exported for tests. */
export function igdbQueries(games: { gameId: string; ids: ArtIds }[]): {
  bySteam: string | null
  byId: string | null
} {
  const uids = [...new Set(games.map((g) => g.ids.steamAppId).filter((id): id is number => !!id))]
  const igdbIds = [
    ...new Set(
      games.map((g) => g.ids.igdbId).filter((id): id is string => !!id && /^\d+$/.test(id))
    )
  ]
  const fields = 'fields cover.image_id,external_games.uid,external_games.external_game_source;'
  return {
    bySteam: uids.length
      ? `${fields} where external_games.uid = (${uids.map((u) => `"${u}"`).join(',')}) & external_games.external_game_source = ${STEAM_SOURCE}; limit ${IGDB_EXTERNAL_BATCH};`
      : null,
    byId: igdbIds.length
      ? `${fields} where id = (${igdbIds.join(',')}); limit ${IGDB_EXTERNAL_BATCH};`
      : null
  }
}

export function createIgdbExternalSource(
  options: IgdbExternalOptions = {}
): DirectArtSource & { limiter: RateLimiter } {
  const log = options.log
  const baseUrl = (options.baseUrl ?? IGDB_BASE_URL).replace(/\/+$/, '')
  const tokenUrl = options.tokenUrl ?? TWITCH_TOKEN_URL
  const limiter = options.limiter ?? igdbLimiter
  // A test that names its own token URL gets a token cache of its own; the app shares the scraper's.
  const sharedToken =
    options.token ??
    (options.tokenUrl ? undefined : (settings: Settings) => igdbScraper.token(settings))
  let cached: { clientId: string; token: string; expiresAt: number } | null = null

  function credentials(settings: Settings): { clientId: string; clientSecret: string } {
    return {
      clientId: settings.scrapers.igdb.clientId?.trim() ?? '',
      clientSecret: settings.scrapers.igdb.clientSecret?.trim() ?? ''
    }
  }

  async function token(settings: Settings): Promise<string> {
    if (sharedToken) return sharedToken(settings)
    const { clientId, clientSecret } = credentials(settings)
    if (cached && cached.clientId === clientId && cached.expiresAt > Date.now()) return cached.token
    const response = await httpJson<TwitchToken>(
      tokenUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials'
        }).toString()
      },
      { log }
    )
    if (!response.access_token)
      throw new HttpError('igdb-external: token response without access_token', {
        status: 0,
        url: tokenUrl
      })
    const ttl = Math.max(0, (response.expires_in ?? 0) * 1000 - TOKEN_SAFETY_MS)
    cached = { clientId, token: response.access_token, expiresAt: Date.now() + ttl }
    return response.access_token
  }

  async function query(settings: Settings, body: string): Promise<IgdbGameRow[]> {
    const { clientId } = credentials(settings)
    const url = `${baseUrl}/games`
    try {
      return await httpJson<IgdbGameRow[]>(
        url,
        {
          method: 'POST',
          headers: {
            'Client-ID': clientId,
            Authorization: `Bearer ${await token(settings)}`,
            accept: 'application/json',
            'user-agent': USER_AGENT
          },
          body
        },
        { limiter, retries: 1, log }
      )
    } catch (err) {
      log?.debug(`igdb-external: ${redactUrl(url)}: ${(err as Error).message}`)
      return []
    }
  }

  return {
    id: SOURCE_ID,
    batchSize: IGDB_EXTERNAL_BATCH,
    limiter,
    hasIdFor: (ids) => !!ids.steamAppId || (!!ids.igdbId && /^\d+$/.test(ids.igdbId)),
    isConfigured: (settings) => {
      const { clientId, clientSecret } = credentials(settings)
      return clientId.length > 0 && clientSecret.length > 0
    },
    async candidates(games, kinds, settings) {
      const out = new Map<string, ArtCandidates>()
      if (!kinds.includes('cover')) return out
      const wanted = games.filter(({ ids }) => ids.steamAppId || ids.igdbId)
      if (!wanted.length) return out
      const { bySteam, byId } = igdbQueries(wanted.map((g) => ({ gameId: g.game.id, ids: g.ids })))
      const bySteamId = new Map<string, string[]>()
      const byIgdbId = new Map<string, string[]>()
      for (const { game, ids } of wanted) {
        if (ids.steamAppId) {
          const key = String(ids.steamAppId)
          bySteamId.set(key, [...(bySteamId.get(key) ?? []), game.id])
        }
        if (ids.igdbId) byIgdbId.set(ids.igdbId, [...(byIgdbId.get(ids.igdbId) ?? []), game.id])
      }
      const land = (gameIds: string[] | undefined, imageId: string): void => {
        for (const gameId of gameIds ?? []) {
          if (out.has(gameId)) continue
          out.set(gameId, {
            cover: [
              {
                kind: 'cover',
                source: SOURCE_ID,
                url: igdbImageUrl(imageId, 't_cover_big_2x'),
                width: 528,
                height: 704
              }
            ]
          })
        }
      }
      if (byId) {
        for (const row of await query(settings, byId)) {
          if (row.id && row.cover?.image_id) land(byIgdbId.get(String(row.id)), row.cover.image_id)
        }
      }
      if (bySteam) {
        for (const row of await query(settings, bySteam)) {
          const imageId = row.cover?.image_id
          if (!imageId) continue
          for (const external of row.external_games ?? []) {
            const source = external.external_game_source ?? external.category
            if (source !== STEAM_SOURCE || !external.uid) continue
            land(bySteamId.get(external.uid), imageId)
          }
        }
      }
      return out
    }
  }
}
