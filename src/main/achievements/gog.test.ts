import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Rate limiting is covered by http.test.ts; here it would only slow the suite down.
vi.mock('../scrapers/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scrapers/http')>()
  return {
    ...actual,
    RateLimiter: class {
      take(): Promise<void> {
        return Promise.resolve()
      }
    }
  }
})

import { HttpError } from '../scrapers/http'
import {
  gogAchievementItems,
  GogAuthError,
  gogClientOf,
  gogGameToken,
  gogListsAchievements,
  mapGogAchievements,
  readGogAchievements,
  resetGogCaches,
  type GogReadDeps
} from './gog'

// Made-up ids and tokens: every request goes to the stubbed fetch below.
const ACCOUNT = { userId: '4815162342', refreshToken: 'test-refresh-token' }
const account = async (): Promise<typeof ACCOUNT> => ACCOUNT
const CLIENT = { clientId: '50144443643664262', clientSecret: 'test-secret' }

const fetchMock = vi.fn()
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const url = (call: number): string => String(fetchMock.mock.calls[call][0])
const init = (call: number): RequestInit => fetchMock.mock.calls[call][1] as RequestInit

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  resetGogCaches()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gogClientOf', () => {
  it("reads the game's Galaxy client from its compressed build manifest", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ items: [{ link: 'https://cdn.gog.com/manifest/abc' }] }))
      .mockResolvedValueOnce(
        new Response(
          deflateSync(Buffer.from(JSON.stringify({ clientId: '501', clientSecret: 's' })))
        )
      )
    expect(await gogClientOf('1454587428')).toEqual({ clientId: '501', clientSecret: 's' })
    expect(url(0)).toBe(
      'https://content-system.gog.com/products/1454587428/os/windows/builds?generation=2'
    )
  })

  it('has none for a game without a Galaxy build or client id', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }))
    expect(await gogClientOf('1')).toBeNull()
    fetchMock
      .mockResolvedValueOnce(json({ items: [{ link: 'https://cdn.gog.com/m' }] }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ baseProductId: '1' })))
    expect(await gogClientOf('1')).toBeNull()
  })
})

describe('gogListsAchievements', () => {
  it("reads the product page's features", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ _embedded: { features: [{ id: 'achievements' }, { id: 'single' }] } })
    )
    expect(await gogListsAchievements('1')).toBe(true)
    fetchMock.mockResolvedValueOnce(json({ _embedded: { features: [{ id: 'cloud_saves' }] } }))
    expect(await gogListsAchievements('2')).toBe(false)
    fetchMock.mockResolvedValueOnce(json({ error: 'x' }, 404))
    expect(await gogListsAchievements('3')).toBeNull()
  })
})

describe('gogGameToken', () => {
  it("exchanges the account's refresh token in a POST body, never the URL, and keeps the game token in memory", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'game-token', expires_in: 3600 }))
    expect(await gogGameToken(CLIENT, account)).toBe('game-token')
    expect(url(0)).toBe('https://auth.gog.com/token')
    expect(url(0)).not.toContain('refresh')
    const body = new URLSearchParams(String(init(0).body))
    expect(body.get('client_id')).toBe(CLIENT.clientId)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe(ACCOUNT.refreshToken)
    expect(body.get('without_new_session')).toBe('1')
    // Kept until it is about to expire.
    expect(await gogGameToken(CLIENT, account)).toBe('game-token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a refused account', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400))
    await expect(gogGameToken(CLIENT, account)).rejects.toBeInstanceOf(GogAuthError)
    fetchMock.mockResolvedValueOnce(json({}, 401))
    await expect(gogGameToken(CLIENT, account)).rejects.toBeInstanceOf(GogAuthError)
  })

  it("treats a refusal of the game's own client as that game's failure, not the account's", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_client' }, 400))
    const err = await gogGameToken(CLIENT, account).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err).not.toBeInstanceOf(GogAuthError)
    fetchMock.mockResolvedValueOnce(json({ error: 'forbidden' }, 403))
    expect(await gogGameToken(CLIENT, account).catch((e: unknown) => e)).not.toBeInstanceOf(
      GogAuthError
    )
  })

  it('reads the account when its turn comes, and asks once more when a refresh replaced its token meanwhile', async () => {
    let current = { ...ACCOUNT, refreshToken: 'old-token' }
    const reads = vi.fn(async () => current)
    fetchMock.mockImplementationOnce(async () => {
      // PlayOut's own refresh of the account rotates its refresh token while this request is out.
      current = { ...ACCOUNT, refreshToken: 'new-token' }
      return json({ error: 'invalid_grant' }, 400)
    })
    fetchMock.mockResolvedValueOnce(json({ access_token: 'game-token', expires_in: 3600 }))
    expect(await gogGameToken(CLIENT, reads)).toBe('game-token')
    expect(new URLSearchParams(String(init(0).body)).get('refresh_token')).toBe('old-token')
    expect(new URLSearchParams(String(init(1).body)).get('refresh_token')).toBe('new-token')
  })

  it('gives no token when the account was signed out meanwhile', async () => {
    let signedIn = true
    const reads = vi.fn(async () => {
      const now = signedIn ? ACCOUNT : null
      signedIn = false
      return now
    })
    expect(await gogGameToken(CLIENT, reads)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('gogAchievementItems', () => {
  it('reads every page, and has none for a 404', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ items: [{ achievement_key: 'a' }], page_token: 'next' }))
      .mockResolvedValueOnce(json({ items: [{ achievement_key: 'b' }], page_token: '0' }))
    const items = await gogAchievementItems(CLIENT, ACCOUNT.userId, 'game-token', 'es-ES')
    expect(items).toHaveLength(2)
    expect(url(0)).toBe(
      `https://gameplay.gog.com/clients/${CLIENT.clientId}/users/${ACCOUNT.userId}/achievements`
    )
    expect(url(1)).toContain('page_token=next')
    expect(new Headers(init(0).headers).get('Authorization')).toBe('Bearer game-token')
    expect(new Headers(init(0).headers).get('X-Gog-Lc')).toBe('es-ES')
    fetchMock.mockResolvedValueOnce(json({}, 404))
    expect(await gogAchievementItems(CLIENT, ACCOUNT.userId, 'game-token')).toBeNull()
    // A refused game token is the game's failure (thrown as is), not the account's.
    fetchMock.mockResolvedValueOnce(json({}, 401))
    const err = await gogAchievementItems(CLIENT, ACCOUNT.userId, 't').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err).not.toBeInstanceOf(GogAuthError)
  })
})

describe('mapGogAchievements', () => {
  it('maps unlocks, icons and hidden achievements, skipping duplicates', () => {
    const info = mapGogAchievements([
      {
        achievement_key: 'WIN',
        name: 'Winner',
        description: 'Win once.',
        date_unlocked: '2026-10-01T12:00:00+0000',
        image_url_unlocked: 'https://images.gog.com/u.png',
        image_url_locked: 'https://images.gog.com/l.png',
        visible: true
      },
      { achievement_key: 'SECRET', name: 'Secret', visible: false, date_unlocked: null },
      { achievement_key: 'WIN', name: 'Again' },
      { achievement_id: 7, name: 'Bad icon', image_url_locked: 'http://insecure/l.png' }
    ])
    expect(info).toMatchObject({ provider: 'gog', total: 3, unlocked: 1 })
    expect(info.list[0]).toMatchObject({
      id: 'WIN',
      unlocked: true,
      icon: 'https://images.gog.com/u.png'
    })
    expect(info.list[0].unlockedAt).toBe(new Date('2026-10-01T12:00:00Z').toISOString())
    expect(info.list[1]).toMatchObject({ id: 'SECRET', unlocked: false, hidden: true })
    expect(info.list[2]).toEqual({ id: '7', name: 'Bad icon', unlocked: false })
  })
})

describe('readGogAchievements', () => {
  const deps = (overrides: Partial<GogReadDeps> = {}): GogReadDeps => ({
    account: async () => ACCOUNT,
    clientOf: vi.fn(async () => CLIENT),
    listsAchievements: vi.fn(async () => true),
    token: vi.fn(async () => 'game-token'),
    items: vi.fn(async () => [{ achievement_key: 'a', name: 'A', date_unlocked: '2026-01-01' }]),
    ...overrides
  })

  it('reads nothing while signed out', async () => {
    const d = deps({ account: async () => null })
    expect(await readGogAchievements('1', d)).toEqual({ kind: 'signed-out' })
    expect(d.clientOf).not.toHaveBeenCalled()
  })

  it("gives the list, and reads a product's client once", async () => {
    const d = deps()
    expect(await readGogAchievements('1', d)).toMatchObject({
      kind: 'list',
      info: { total: 1, unlocked: 1 }
    })
    await readGogAchievements('1', d)
    expect(d.clientOf).toHaveBeenCalledTimes(1)
  })

  it('asks once more with a new game token when GOG refused the one it had', async () => {
    const items = vi
      .fn<NonNullable<GogReadDeps['items']>>()
      .mockRejectedValueOnce(new HttpError('HTTP 401', { status: 401, url: 'https://gameplay' }))
      .mockResolvedValueOnce([{ achievement_key: 'a', name: 'A' }])
    const d = deps({ items })
    expect(await readGogAchievements('1', d)).toMatchObject({ kind: 'list' })
    expect(d.token).toHaveBeenCalledTimes(2)
    // A second refusal is the game's failure.
    resetGogCaches()
    items.mockRejectedValue(new HttpError('HTTP 401', { status: 401, url: 'https://gameplay' }))
    await expect(readGogAchievements('1', deps({ items }))).rejects.toBeInstanceOf(HttpError)
  })

  it("passes a page open's priority to every request", async () => {
    const d = deps()
    await readGogAchievements('1', d, 'page')
    expect(d.clientOf).toHaveBeenCalledWith('1', 'page')
    expect(d.token).toHaveBeenCalledWith(expect.anything(), expect.any(Function), 'page')
  })

  it('says none only when the product page lists no achievements either', async () => {
    expect(
      await readGogAchievements(
        '1',
        deps({ items: vi.fn(async () => null), listsAchievements: vi.fn(async () => false) })
      )
    ).toEqual({ kind: 'none' })
    resetGogCaches()
    expect(await readGogAchievements('1', deps({ items: vi.fn(async () => []) }))).toEqual({
      kind: 'unknown'
    })
    resetGogCaches()
    expect(
      await readGogAchievements(
        '1',
        deps({ clientOf: vi.fn(async () => null), listsAchievements: vi.fn(async () => null) })
      )
    ).toEqual({ kind: 'unknown' })
  })
})
