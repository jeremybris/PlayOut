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
import { sharedFailure } from './scan-scheduler'
import {
  EPIC_STORE_USER_AGENT,
  epicAchievementDefinitions,
  EpicGraphqlError,
  epicPlayerAchievements,
  epicStoreUrl,
  epicTokenAccepted,
  isEpicAuthError,
  mapEpicAchievements,
  parseEpicDefinitions,
  parseEpicPlayer,
  readEpicAchievements,
  resetEpicCaches,
  type EpicAccountCredential,
  type EpicDefinitions,
  type EpicReadDeps
} from './epic'

// Made-up ids and tokens: every request goes to the stubbed fetch below. The answers are shaped like the launcher
// store's GraphQL answers (the definitions one recorded unauthenticated for Hades, sandbox "min").
const ACCOUNT: EpicAccountCredential = {
  accountId: '0123456789abcdef0123456789abcdef',
  accessToken: 'test-access-token'
}
const FRESH: EpicAccountCredential = { ...ACCOUNT, accessToken: 'test-fresh-token' }

const fetchMock = vi.fn()
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const init = (call: number): RequestInit => fetchMock.mock.calls[call][1] as RequestInit
const sent = (call: number): { query: string; variables: Record<string, string> } =>
  JSON.parse(String(init(call).body))

const definitionsAnswer = (record: unknown): unknown => ({
  data: { Achievement: { productAchievementsRecordBySandbox: record } }
})
const playerAnswer = (records: unknown): unknown => ({
  data: { PlayerAchievement: { playerAchievementGameRecordsBySandbox: { records } } }
})

const HADES_RECORD = {
  totalAchievements: 3,
  totalProductXP: 40,
  achievements: [
    {
      achievement: {
        name: 'AchAccessAdminChamber',
        hidden: false,
        unlockedDisplayName: 'Back to Work',
        unlockedDescription: 'Earn access to and enter the Administrative Chamber',
        lockedDisplayName: 'Back to Work',
        lockedDescription: 'Earn access to and enter the Administrative Chamber',
        unlockedIconLink: 'https://shared-static-prod.epicgames.com/epic-achievements/u1',
        lockedIconLink: 'https://shared-static-prod.epicgames.com/epic-achievements/l1',
        XP: 5
      }
    },
    {
      achievement: {
        name: 'AchSecretEnding',
        hidden: true,
        unlockedDisplayName: 'Family Reunion',
        unlockedDescription: 'See the true ending',
        lockedDisplayName: 'Hidden achievement',
        lockedDescription: 'Keep playing to unlock',
        unlockedIconLink: 'https://shared-static-prod.epicgames.com/epic-achievements/u2',
        lockedIconLink: 'http://insecure.example/l2',
        XP: 25
      }
    },
    {
      achievement: {
        name: 'AchAresKills',
        hidden: false,
        unlockedDisplayName: "War-God's Bloodlust",
        lockedDisplayName: "War-God's Bloodlust",
        lockedDescription: "Fulfill the 'War-God's Bloodlust' Prophecy",
        XP: 10
      }
    }
  ]
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  resetEpicCaches()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('epicAchievementDefinitions', () => {
  it("asks the launcher store's GraphQL service without a login, as the Epic launcher", async () => {
    fetchMock.mockResolvedValueOnce(json(definitionsAnswer(HADES_RECORD)))
    const defs = await epicAchievementDefinitions('min', 'es-ES')
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://launcher.store.epicgames.com/graphql')
    const headers = new Headers(init(0).headers)
    expect(init(0).method).toBe('POST')
    expect(headers.get('User-Agent')).toBe(EPIC_STORE_USER_AGENT)
    expect(headers.get('Authorization')).toBeNull()
    expect(sent(0).variables).toEqual({ sandboxId: 'min', locale: 'es-ES' })
    expect(sent(0).query).toContain('productAchievementsRecordBySandbox')
    expect(defs?.total).toBe(3)
    expect(defs?.xp).toBe(40)
    expect(defs?.achievements.map((a) => a.name)).toEqual([
      'AchAccessAdminChamber',
      'AchSecretEnding',
      'AchAresKills'
    ])
    // Only https icons are kept.
    expect(defs?.achievements[1].lockedIcon).toBeUndefined()
    // Read once per run (for a while).
    await epicAchievementDefinitions('min', 'es-ES')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('takes totalAchievements null or 0 as "no achievements"', async () => {
    fetchMock.mockResolvedValueOnce(
      json(definitionsAnswer({ totalAchievements: null, totalProductXP: null, achievements: null }))
    )
    expect(await epicAchievementDefinitions('nothing')).toBeNull()
    expect(parseEpicDefinitions(definitionsAnswer({ totalAchievements: 0 }) as never)).toBeNull()
  })

  it('throws on an answer of another shape (Epic changed the service), never "none"', () => {
    expect(() =>
      parseEpicDefinitions({ errors: [{ message: 'Cannot query field "x"' }] } as never)
    ).toThrow(EpicGraphqlError)
    expect(() => parseEpicDefinitions(definitionsAnswer(null) as never)).toThrow(EpicGraphqlError)
    expect(() =>
      parseEpicDefinitions(definitionsAnswer({ totalAchievements: 'many' }) as never)
    ).toThrow()
  })

  it('never takes a null count next to GraphQL errors as "none" (a partial failure)', async () => {
    const partial = {
      ...(definitionsAnswer({ totalAchievements: null, achievements: null }) as object),
      errors: [{ message: 'Internal server error', path: ['Achievement'] }]
    }
    expect(() => parseEpicDefinitions(partial as never)).toThrow(EpicGraphqlError)
    // Nothing is cached from it: the next read asks Epic again.
    fetchMock
      .mockResolvedValueOnce(json(partial))
      .mockResolvedValueOnce(json(definitionsAnswer({ totalAchievements: null })))
    await expect(epicAchievementDefinitions('partial')).rejects.toThrow(EpicGraphqlError)
    expect(await epicAchievementDefinitions('partial')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('isEpicAuthError', () => {
  it("tells a refused token from Epic's structured fields and auth wording in the message only", () => {
    expect(isEpicAuthError({ message: 'x', status: 401 })).toBe(true)
    expect(isEpicAuthError({ message: 'x', extensions: { code: 'UNAUTHENTICATED' } })).toBe(true)
    expect(
      isEpicAuthError({
        message: 'Failed to fetch',
        serviceResponse: JSON.stringify({
          errorCode: 'errors.com.epicgames.common.authentication.token_verification_failed',
          numericErrorCode: 1014
        })
      })
    ).toBe(true)
    expect(isEpicAuthError({ message: 'Unauthorized' })).toBe(true)
    // Not about the token: a parse error, schema wording, an id that happens to contain "token".
    expect(isEpicAuthError({ message: 'Syntax Error: Unexpected token <' })).toBe(false)
    expect(isEpicAuthError({ message: 'Field "permission" is not defined by type X' })).toBe(false)
    expect(
      isEpicAuthError({ message: 'Internal error', correlationId: 'token-1234-authorization' })
    ).toBe(false)
    expect(isEpicAuthError('Unauthorized')).toBe(false)
  })
})

describe('epicPlayerAchievements', () => {
  it("sends the account's launcher token as a bearer token and reads every record", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        playerAnswer([
          {
            totalXP: 5,
            totalUnlocked: 1,
            playerAchievements: [
              {
                playerAchievement: {
                  achievementName: 'AchAccessAdminChamber',
                  unlocked: true,
                  unlockDate: '2024-03-02T10:00:00.000Z',
                  XP: 5
                }
              },
              { playerAchievement: { achievementName: 'AchAresKills', unlocked: false } }
            ]
          }
        ])
      )
    )
    const player = await epicPlayerAchievements(ACCOUNT, 'min')
    const headers = new Headers(init(0).headers)
    expect(headers.get('Authorization')).toBe('bearer test-access-token')
    expect(sent(0).variables).toEqual({ epicAccountId: ACCOUNT.accountId, sandboxId: 'min' })
    expect(player).toEqual([
      { name: 'AchAccessAdminChamber', unlocked: true, unlockDate: '2024-03-02T10:00:00.000Z' },
      { name: 'AchAresKills', unlocked: false, unlockDate: undefined }
    ])
  })

  it('gives null for no records: nothing unlocked, or a token Epic ignored (the caller checks the token)', async () => {
    // Recorded shape: Epic answers a request without a valid token exactly like this.
    fetchMock.mockResolvedValueOnce(json(playerAnswer(null)))
    expect(await epicPlayerAchievements(ACCOUNT, 'min')).toBeNull()
    expect(parseEpicPlayer(playerAnswer([]) as never)).toBeNull()
  })

  it('throws on errors next to data: an auth error is a refused token, a parse error is not', () => {
    const refused = {
      ...(playerAnswer(null) as object),
      errors: [
        {
          message: 'Failed to fetch',
          serviceResponse:
            '{"errorCode":"errors.com.epicgames.common.authentication.token_verification_failed"}'
        }
      ]
    }
    const authErr = (() => {
      try {
        parseEpicPlayer(refused as never)
      } catch (err) {
        return err
      }
      return null
    })()
    expect(authErr).toBeInstanceOf(EpicGraphqlError)
    expect((authErr as EpicGraphqlError).auth).toBe(true)
    const syntaxErr = (() => {
      try {
        parseEpicPlayer({ errors: [{ message: 'Syntax Error: Unexpected token <' }] } as never)
      } catch (err) {
        return err
      }
      return null
    })()
    expect(syntaxErr).toBeInstanceOf(EpicGraphqlError)
    expect((syntaxErr as EpicGraphqlError).auth).toBe(false)
  })
})

describe('epicTokenAccepted', () => {
  it("asks Epic's token check (as Legendary does) once per token", async () => {
    fetchMock.mockResolvedValueOnce(json({ account_id: ACCOUNT.accountId, expires_in: 7000 }))
    expect(await epicTokenAccepted(ACCOUNT)).toBe(true)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/verify'
    )
    expect(new Headers(init(0).headers).get('Authorization')).toBe('bearer test-access-token')
    expect(await epicTokenAccepted(ACCOUNT)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('is false for a refused token or another account, and throws when Epic could not be asked', async () => {
    fetchMock.mockResolvedValueOnce(json({ errorCode: 'invalid_token' }, 401))
    expect(await epicTokenAccepted(ACCOUNT)).toBe(false)
    fetchMock.mockResolvedValueOnce(json({ account_id: 'someone-else' }))
    expect(await epicTokenAccepted(FRESH)).toBe(false)
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await expect(epicTokenAccepted(FRESH)).rejects.toThrow()
  })
})

describe('mapEpicAchievements', () => {
  const defs = (): EpicDefinitions =>
    parseEpicDefinitions(definitionsAnswer(HADES_RECORD) as never)!

  it('joins the unlocks to the definitions by name, with XP as points', () => {
    const info = mapEpicAchievements(
      defs(),
      [
        { name: 'AchAccessAdminChamber', unlocked: true, unlockDate: '2024-03-02T10:00:00.000Z' },
        { name: 'AchAresKills', unlocked: false, unlockDate: '0001-01-01T00:00:00.000Z' },
        { name: 'SomethingElse', unlocked: true }
      ],
      'https://store.epicgames.com/en-US/p/hades'
    )
    expect(info).toMatchObject({
      provider: 'epic',
      total: 3,
      unlocked: 1,
      points: { earned: 5, total: 40 },
      url: 'https://store.epicgames.com/en-US/p/hades'
    })
    expect(info.list[0]).toEqual({
      id: 'AchAccessAdminChamber',
      name: 'Back to Work',
      description: 'Earn access to and enter the Administrative Chamber',
      unlocked: true,
      unlockedAt: '2024-03-02T10:00:00.000Z',
      icon: 'https://shared-static-prod.epicgames.com/epic-achievements/u1',
      points: 5
    })
    // Not unlocked: no date, the locked texts and icon (here only the unlocked icon is https).
    expect(info.list[2]).toMatchObject({ id: 'AchAresKills', unlocked: false, points: 10 })
    expect(info.list[2].unlockedAt).toBeUndefined()
  })

  it('keeps a hidden achievement hidden until it is unlocked', () => {
    const locked = mapEpicAchievements(defs(), []).list[1]
    expect(locked).toMatchObject({ hidden: true, unlocked: false, name: 'Hidden achievement' })
    const unlocked = mapEpicAchievements(defs(), [{ name: 'AchSecretEnding', unlocked: true }])
      .list[1]
    expect(unlocked).toMatchObject({
      hidden: true,
      unlocked: true,
      name: 'Family Reunion',
      description: 'See the true ending',
      icon: 'https://shared-static-prod.epicgames.com/epic-achievements/u2'
    })
  })
})

describe('readEpicAchievements', () => {
  const DEFS: EpicDefinitions = {
    total: 2,
    xp: 20,
    achievements: [
      { name: 'A', hidden: false, unlockedName: 'First', xp: 10 },
      { name: 'B', hidden: false, unlockedName: 'Second', xp: 10 }
    ]
  }

  function deps(over: Partial<EpicReadDeps> = {}): EpicReadDeps {
    return {
      credential: vi.fn(async (refresh: boolean) => (refresh ? FRESH : ACCOUNT)),
      definitions: vi.fn(async () => DEFS),
      player: vi.fn(async () => [{ name: 'B', unlocked: true }]),
      ...over
    }
  }

  it('lists the definitions with the unlocks', async () => {
    const d = deps({ storeUrl: 'https://store.epicgames.com/p/x' })
    const read = await readEpicAchievements('ns', d, 'page')
    expect(read).toMatchObject({
      kind: 'list',
      info: { provider: 'epic', total: 2, unlocked: 1, url: 'https://store.epicgames.com/p/x' }
    })
    expect(d.definitions).toHaveBeenCalledWith('ns', 'en-US', 'page')
    expect(d.player).toHaveBeenCalledWith(ACCOUNT, 'ns', 'page')
  })

  it('is signed out without an Epic account, and asks Epic nothing', async () => {
    const d = deps({ credential: vi.fn(async () => null) })
    expect(await readEpicAchievements('ns', d)).toEqual({ kind: 'signed-out' })
    expect(d.definitions).not.toHaveBeenCalled()
  })

  it('is "none" only when the definitions say so (the unlocks are not asked)', async () => {
    const d = deps({ definitions: vi.fn(async () => null) })
    expect(await readEpicAchievements('ns', d)).toEqual({ kind: 'none' })
    expect(d.player).not.toHaveBeenCalled()
    // A count with no list is not "none".
    const empty = deps({ definitions: vi.fn(async () => ({ total: 4, achievements: [] })) })
    expect(await readEpicAchievements('ns', empty)).toEqual({ kind: 'unknown' })
  })

  it('refreshes a refused token once, then counts the account as signed out', async () => {
    const refused = new HttpError('HTTP 401', { status: 401, url: 'https://epic' })
    const player = vi.fn().mockRejectedValueOnce(refused).mockResolvedValueOnce([])
    const d = deps({ player })
    expect((await readEpicAchievements('ns', d)).kind).toBe('list')
    expect(d.credential).toHaveBeenLastCalledWith(true)
    expect(player.mock.calls[1][0]).toBe(FRESH)

    const always = deps({ player: vi.fn().mockRejectedValue(refused) })
    expect(await readEpicAchievements('ns', always)).toEqual({ kind: 'signed-out' })
    expect(always.player).toHaveBeenCalledTimes(2)
    // GraphQL's own "not authenticated" answer counts the same.
    const gql = deps({
      player: vi.fn().mockRejectedValue(new EpicGraphqlError('Epic gave no x: token', true))
    })
    expect(await readEpicAchievements('ns', gql)).toEqual({ kind: 'signed-out' })
  })

  it('is signed out when the refresh finds no account', async () => {
    const credential = vi.fn(async (refresh: boolean) => (refresh ? null : ACCOUNT))
    const d = deps({
      credential,
      player: vi.fn().mockRejectedValue(new HttpError('HTTP 401', { status: 401, url: 'x' }))
    })
    expect(await readEpicAchievements('ns', d)).toEqual({ kind: 'signed-out' })
  })

  it('pauses everything (not signed out) when the token could not be refreshed', async () => {
    const offline = new HttpError('fetch failed', { status: 0, url: 'https://oauth' })
    // The expiry refresh at the start fails.
    const first = deps({ credential: vi.fn().mockRejectedValue(offline) })
    const err1 = await readEpicAchievements('ns', first).catch((e: unknown) => e)
    expect(err1).toBeInstanceOf(HttpError)
    expect(sharedFailure(err1)).toBe(true)
    expect(first.definitions).not.toHaveBeenCalled()
    // The refresh after a 401 fails.
    const credential = vi.fn(async (refresh: boolean) => {
      if (refresh) throw new Error('getaddrinfo ENOTFOUND')
      return ACCOUNT
    })
    const second = deps({
      credential,
      player: vi.fn().mockRejectedValue(new HttpError('HTTP 401', { status: 401, url: 'x' }))
    })
    const err2 = await readEpicAchievements('ns', second).catch((e: unknown) => e)
    expect(sharedFailure(err2)).toBe(true)
  })

  it('takes no records as nothing unlocked only once Epic accepts the token', async () => {
    const tokenAccepted = vi.fn(async () => true)
    const d = deps({ player: vi.fn(async () => null), tokenAccepted })
    expect(await readEpicAchievements('ns', d)).toMatchObject({
      kind: 'list',
      info: { total: 2, unlocked: 0 }
    })
    expect(tokenAccepted).toHaveBeenCalledWith(ACCOUNT, 'scan')
  })

  it('refreshes a token Epic ignores (no records, the check says no), then counts the account as signed out', async () => {
    // A fresh token Epic accepts: its answer counts.
    const accepted = vi.fn(async (c: EpicAccountCredential) => c === FRESH)
    const ok = deps({ player: vi.fn(async () => null), tokenAccepted: accepted })
    expect((await readEpicAchievements('ns', ok)).kind).toBe('list')
    expect(ok.credential).toHaveBeenLastCalledWith(true)
    // Never accepted: signed out, never a 0/N list.
    const never = deps({
      player: vi.fn(async () => null),
      tokenAccepted: vi.fn(async () => false)
    })
    expect(await readEpicAchievements('ns', never)).toEqual({ kind: 'signed-out' })
    // The check could not be made: everything waits, nothing is written.
    const unreachable = deps({
      player: vi.fn(async () => null),
      tokenAccepted: vi.fn().mockRejectedValue(new HttpError('HTTP 503', { status: 503, url: 'v' }))
    })
    const err = await readEpicAchievements('ns', unreachable).catch((e: unknown) => e)
    expect(sharedFailure(err)).toBe(true)
  })

  it('takes GraphQL auth errors next to no records as a refused token (refresh, then signed out)', async () => {
    const refusedAnswer = {
      ...(playerAnswer(null) as object),
      errors: [{ message: 'Unauthorized', status: 401 }]
    }
    const player = vi.fn(async () => parseEpicPlayer(refusedAnswer as never))
    const tokenAccepted = vi.fn(async () => true)
    const d = deps({ player, tokenAccepted })
    expect(await readEpicAchievements('ns', d)).toEqual({ kind: 'signed-out' })
    expect(player).toHaveBeenCalledTimes(2)
    expect(d.credential).toHaveBeenCalledWith(true)
    expect(tokenAccepted).not.toHaveBeenCalled()
    // A parse error is not about the token: no refresh, this game's failure.
    const syntax = deps({
      player: vi.fn(async () =>
        parseEpicPlayer({ errors: [{ message: 'Syntax Error: Unexpected token <' }] } as never)
      )
    })
    await expect(readEpicAchievements('ns', syntax)).rejects.toThrow(EpicGraphqlError)
    expect(syntax.credential).not.toHaveBeenCalledWith(true)
  })

  it('refreshes on a server error only when the service answers otherwise, at most once a while', async () => {
    const down = new HttpError('HTTP 500', { status: 500, url: 'https://epic' })
    // The service answers a public request: the 500 may be the token's. One refresh, then this game's failure.
    const d = deps({
      player: vi.fn().mockRejectedValue(down),
      serviceAnswers: vi.fn(async () => true)
    })
    await expect(readEpicAchievements('ns', d)).rejects.toBe(down)
    expect(d.credential).toHaveBeenCalledWith(true)
    // The next game is not refreshed again.
    const next = deps({
      player: vi.fn().mockRejectedValue(down),
      serviceAnswers: vi.fn(async () => true)
    })
    await expect(readEpicAchievements('ns2', next)).rejects.toBe(down)
    expect(next.credential).not.toHaveBeenCalledWith(true)
    expect(next.player).toHaveBeenCalledTimes(1)

    resetEpicCaches()
    const forbidden = new HttpError('HTTP 403', { status: 403, url: 'https://epic' })
    const blocked = deps({ player: vi.fn().mockRejectedValue(forbidden) })
    await expect(readEpicAchievements('ns', blocked)).rejects.toBe(forbidden)
    const broken = deps({
      definitions: vi.fn().mockRejectedValue(new EpicGraphqlError('x', false))
    })
    await expect(readEpicAchievements('ns', broken)).rejects.toThrow(EpicGraphqlError)
  })

  it('pauses everything on an outage: no refresh when the service does not answer at all', async () => {
    const down = new HttpError('HTTP 502', { status: 502, url: 'https://epic' })
    const d = deps({
      player: vi.fn().mockRejectedValue(down),
      serviceAnswers: vi.fn(async () => false)
    })
    const err = await readEpicAchievements('ns', d).catch((e: unknown) => e)
    expect(sharedFailure(err)).toBe(true)
    expect(d.credential).not.toHaveBeenCalledWith(true)
  })

  it('pauses everything after server errors (or error pages) for several games in a row', async () => {
    const down = new HttpError('HTTP 500', { status: 500, url: 'https://epic' })
    const page = new HttpError('invalid JSON from https://epic', {
      status: 200,
      url: 'https://epic'
    })
    const read = (err: HttpError): Promise<unknown> =>
      readEpicAchievements('ns', deps({ definitions: vi.fn().mockRejectedValue(err) })).catch(
        (e: unknown) => e
      )
    expect(await read(down)).toBe(down)
    expect(await read(page)).toBe(page)
    expect(sharedFailure(await read(down))).toBe(true)
    // A game read in between starts the count over.
    resetEpicCaches()
    expect(await read(down)).toBe(down)
    expect((await readEpicAchievements('ok', deps())).kind).toBe('list')
    expect(await read(down)).toBe(down)
    expect(await read(down)).toBe(down)
  })
})

describe('epicStoreUrl', () => {
  it('keeps only https pages of the Epic store', () => {
    expect(epicStoreUrl('https://store.epicgames.com/en-US/p/hades')).toBe(
      'https://store.epicgames.com/en-US/p/hades'
    )
    expect(epicStoreUrl('http://store.epicgames.com/p/x')).toBeUndefined()
    expect(epicStoreUrl('https://store.epicgames.com.evil.example/p/x')).toBeUndefined()
    expect(epicStoreUrl('javascript:alert(1)')).toBeUndefined()
    expect(epicStoreUrl(undefined)).toBeUndefined()
  })
})
