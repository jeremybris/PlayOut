import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeGame, stubFetch, testLog, testSettings } from '../test-helpers'
import { RateLimiter } from '../http'
import type { DirectArtSource } from '../types'
import { createIgdbExternalSource, igdbQueries } from './igdb-external'

const BASE = 'https://igdb.test/v4'
const TOKEN = 'https://twitch.test/token'

afterEach(() => {
  vi.unstubAllGlobals()
})

function source(): DirectArtSource {
  return createIgdbExternalSource({
    baseUrl: BASE,
    tokenUrl: TOKEN,
    limiter: new RateLimiter(1000, 1000),
    log: testLog
  })
}

describe('igdbQueries', () => {
  it('builds the Steam external-id query and the stored-id query', () => {
    const { bySteam, byId } = igdbQueries([
      { gameId: 'a', ids: { steamAppId: 620 } },
      { gameId: 'b', ids: { steamAppId: 440, igdbId: '1020' } },
      { gameId: 'c', ids: { igdbId: 'x' } }
    ])
    expect(bySteam).toBe(
      'fields cover.image_id,external_games.uid,external_games.external_game_source; where external_games.uid = ("620","440") & external_games.external_game_source = 1; limit 500;'
    )
    expect(byId).toBe(
      'fields cover.image_id,external_games.uid,external_games.external_game_source; where id = (1020); limit 500;'
    )
    expect(igdbQueries([])).toEqual({ bySteam: null, byId: null })
  })
})

describe('igdb-external source', () => {
  it('needs Twitch credentials', async () => {
    const calls = stubFetch({})
    const s = source()
    expect(s.isConfigured(testSettings())).toBe(false)
    expect(s.batchSize).toBe(500)
    expect(calls).toHaveLength(0)
  })

  it('fetches a token once, then resolves covers by Steam appid and by stored IGDB id', async () => {
    const bodies: string[] = []
    const calls = stubFetch({
      [TOKEN]: { access_token: 'tok', expires_in: 3600 },
      [`${BASE}/games`]: async (_url, init) => {
        const body = String(init?.body)
        bodies.push(body)
        const rows = body.includes('where id')
          ? [{ id: 1020, cover: { image_id: 'co1020' } }]
          : [
              {
                id: 7,
                cover: { image_id: 'co7' },
                external_games: [
                  { uid: '620', external_game_source: 1 },
                  { uid: 'something', external_game_source: 5 }
                ]
              },
              { id: 8, external_games: [{ uid: '440', category: 1 }] }
            ]
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    })
    const settings = testSettings({ igdb: { clientId: 'id', clientSecret: 'secret' } })
    const s = source()
    expect(s.isConfigured(settings)).toBe(true)
    const games = [
      { game: fakeGame('steam', '620'), ids: { steamAppId: 620 } },
      { game: fakeGame('steam', '440'), ids: { steamAppId: 440 } },
      { game: fakeGame('gog', '1'), ids: { gogProductId: '1', igdbId: '1020' } },
      { game: fakeGame('gog', '2'), ids: { gogProductId: '2' } }
    ]
    const found = await s.candidates(games, ['cover'], settings)
    expect(calls.filter((c) => c === TOKEN)).toHaveLength(1)
    expect(bodies).toHaveLength(2)
    expect([...found.keys()].sort()).toEqual(['gog:1', 'steam:620'])
    expect(found.get('steam:620')?.cover?.[0]).toMatchObject({
      url: 'https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co7.jpg',
      width: 528,
      height: 704,
      source: 'igdb-external'
    })
    expect(found.get('gog:1')?.cover?.[0].url).toContain('co1020')

    await s.candidates(games, ['cover'], settings)
    expect(calls.filter((c) => c === TOKEN)).toHaveLength(1)
    expect(await s.candidates(games, ['hero'], settings)).toEqual(new Map())
  })
})
