import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
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

import {
  configureRetroAchievements,
  RA_MEDIA,
  RaAuthError,
  raCompletionProgress,
  raGameList,
  raGameProgress,
  raProfile,
  raRecentlyPlayed,
  type RaCredentials
} from './retroachievements'

// Made-up credentials: every request goes to the stubbed fetch below.
const CREDS: RaCredentials = { username: ' TestUser ', apiKey: ' test-key-123 ' }

const fetchMock = vi.fn()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function requestUrl(call = 0): URL {
  return new URL(String(fetchMock.mock.calls[call][0]))
}

function requestHeaders(call = 0): Headers {
  return new Headers((fetchMock.mock.calls[call][1] as RequestInit).headers)
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  configureRetroAchievements({ userAgent: 'PlayOut/9.9.9' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('raProfile', () => {
  it('maps the profile and resolves the avatar on the media host', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        User: 'TestUser',
        UserPic: '/UserPic/TestUser.png',
        TotalPoints: 1234,
        TotalSoftcorePoints: 56
      })
    )
    await expect(raProfile(CREDS)).resolves.toEqual({
      user: 'TestUser',
      avatar: `${RA_MEDIA}/UserPic/TestUser.png`,
      points: 1234,
      softcorePoints: 56
    })
  })

  it('sends the trimmed username and key as z= and y=, and a User-Agent', async () => {
    fetchMock.mockResolvedValueOnce(json({ User: 'TestUser' }))
    await raProfile(CREDS)
    const url = requestUrl()
    expect(url.origin + url.pathname).toBe(
      'https://retroachievements.org/API/API_GetUserProfile.php'
    )
    expect(url.searchParams.get('z')).toBe('TestUser')
    expect(url.searchParams.get('y')).toBe('test-key-123')
    expect(url.searchParams.get('u')).toBe('TestUser')
    expect(requestHeaders().get('user-agent')).toBe('PlayOut/9.9.9')
  })

  it('defaults missing points to 0 and leaves the avatar out when there is none', async () => {
    fetchMock.mockResolvedValueOnce(json({ User: 'TestUser' }))
    await expect(raProfile(CREDS)).resolves.toEqual({
      user: 'TestUser',
      avatar: undefined,
      points: 0,
      softcorePoints: 0
    })
  })

  it('returns null for an unknown user answered with an empty array', async () => {
    fetchMock.mockResolvedValueOnce(json([]))
    await expect(raProfile(CREDS)).resolves.toBeNull()
  })

  it('returns null for an unknown user answered with 404', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Not found' }, 404))
    await expect(raProfile(CREDS)).resolves.toBeNull()
  })

  it('throws RaAuthError for a 401 "Unauthenticated." response', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Unauthenticated.' }, 401))
    await expect(raProfile(CREDS)).rejects.toBeInstanceOf(RaAuthError)
  })

  it('throws RaAuthError for a 200 body carrying the refusal', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ message: 'Unauthenticated.', errors: [{ status: 401, code: 'unauthorized' }] })
    )
    await expect(raProfile(CREDS)).rejects.toBeInstanceOf(RaAuthError)
  })
})

describe('raGameList', () => {
  it('maps rows, lower-cases hashes and skips rows without an ID', async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        {
          ID: 1,
          Title: 'Sonic the Hedgehog',
          ConsoleID: 1,
          NumAchievements: 23,
          Points: 400,
          ImageIcon: '/Images/012345.png',
          Hashes: ['ABCDEF0123456789ABCDEF0123456789', 'deadbeefdeadbeefdeadbeefdeadbeef']
        },
        { Title: 'No ID', ConsoleID: 1, Hashes: ['FFFF'] },
        { ID: 2, Title: 'Bare' }
      ])
    )
    const games = await raGameList(1, CREDS)
    expect(games).toEqual([
      {
        id: 1,
        title: 'Sonic the Hedgehog',
        consoleId: 1,
        achievements: 23,
        points: 400,
        icon: `${RA_MEDIA}/Images/012345.png`,
        hashes: ['abcdef0123456789abcdef0123456789', 'deadbeefdeadbeefdeadbeefdeadbeef']
      },
      {
        id: 2,
        title: 'Bare',
        consoleId: 1,
        achievements: 0,
        points: 0,
        icon: undefined,
        hashes: []
      }
    ])
    const url = requestUrl()
    expect(url.pathname).toBe('/API/API_GetGameList.php')
    expect(url.searchParams.get('i')).toBe('1')
    expect(url.searchParams.get('h')).toBe('1')
    expect(url.searchParams.get('f')).toBe('1')
  })

  it('returns an empty list for a non-array body', async () => {
    fetchMock.mockResolvedValueOnce(json(null))
    await expect(raGameList(1, CREDS)).resolves.toEqual([])
  })
})

describe('raCompletionProgress', () => {
  it('pages through every result and keeps softcore and hardcore counts apart', async () => {
    const firstPage = Array.from({ length: 500 }, (_, i) => ({
      GameID: i + 1,
      MaxPossible: 10,
      NumAwarded: 4,
      NumAwardedHardcore: 2
    }))
    fetchMock
      .mockResolvedValueOnce(json({ Count: 500, Total: 501, Results: firstPage }))
      .mockResolvedValueOnce(
        json({
          Count: 1,
          Total: 501,
          // A server that counts hardcore apart: the larger count is the number unlocked.
          Results: [{ GameID: 9001, MaxPossible: 30, NumAwarded: 3, NumAwardedHardcore: 7 }]
        })
      )
    const progress = await raCompletionProgress(CREDS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestUrl(0).searchParams.get('o')).toBe('0')
    expect(requestUrl(0).searchParams.get('c')).toBe('500')
    expect(requestUrl(1).searchParams.get('o')).toBe('500')
    expect(progress).toHaveLength(501)
    expect(progress[0]).toEqual({ gameId: 1, unlocked: 4, unlockedHardcore: 2, total: 10 })
    expect(progress[500]).toEqual({ gameId: 9001, unlocked: 7, unlockedHardcore: 7, total: 30 })
  })

  it('stops after one page when it holds everything', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        Count: 2,
        Total: 2,
        Results: [
          { GameID: 5, MaxPossible: 12, NumAwarded: 12, NumAwardedHardcore: 0 },
          { GameID: 0, MaxPossible: 1, NumAwarded: 1 }
        ]
      })
    )
    await expect(raCompletionProgress(CREDS)).resolves.toEqual([
      { gameId: 5, unlocked: 12, unlockedHardcore: 0, total: 12 }
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('raGameProgress', () => {
  it('maps achievements in display order with unlocks, badges and points', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        ID: 1,
        Title: 'Sonic the Hedgehog',
        NumAchievements: 3,
        Achievements: {
          '30': {
            ID: 30,
            Title: 'Locked one',
            Description: 'Not yet',
            Points: 25,
            BadgeName: '00030',
            DisplayOrder: 3
          },
          '10': {
            ID: 10,
            Title: 'Hardcore one',
            Description: ' Beat it ',
            Points: 10,
            BadgeName: '00010',
            DisplayOrder: 1,
            DateEarned: '2024-01-01 10:00:00',
            DateEarnedHardcore: '2024-01-02 11:30:00'
          },
          '20': {
            ID: 20,
            Title: 'Softcore one',
            Points: 5,
            BadgeName: '00020',
            DisplayOrder: 2,
            DateEarned: '2024-03-04 05:06:07'
          }
        }
      })
    )
    const info = await raGameProgress(1, CREDS)
    expect(info).toEqual({
      provider: 'retroachievements',
      total: 3,
      unlocked: 2,
      points: { earned: 15, total: 40 },
      url: 'https://retroachievements.org/game/1',
      list: [
        {
          id: '10',
          name: 'Hardcore one',
          description: 'Beat it',
          unlocked: true,
          unlockedAt: '2024-01-02T11:30:00.000Z',
          icon: `${RA_MEDIA}/Badge/00010.png`,
          points: 10,
          hardcore: true
        },
        {
          id: '20',
          name: 'Softcore one',
          description: undefined,
          unlocked: true,
          unlockedAt: '2024-03-04T05:06:07.000Z',
          icon: `${RA_MEDIA}/Badge/00020.png`,
          points: 5,
          hardcore: undefined
        },
        {
          id: '30',
          name: 'Locked one',
          description: 'Not yet',
          unlocked: false,
          unlockedAt: undefined,
          icon: `${RA_MEDIA}/Badge/00030_lock.png`,
          points: 25,
          hardcore: undefined
        }
      ]
    })
    const url = requestUrl()
    expect(url.pathname).toBe('/API/API_GetGameInfoAndUserProgress.php')
    expect(url.searchParams.get('g')).toBe('1')
    expect(url.searchParams.get('u')).toBe('TestUser')
  })

  it('returns null when the game has no achievements (PHP empty map [])', async () => {
    fetchMock.mockResolvedValueOnce(json({ ID: 2, Title: 'None', Achievements: [] }))
    await expect(raGameProgress(2, CREDS)).resolves.toBeNull()
  })
})

describe('raRecentlyPlayed', () => {
  it("reads the user's recently played games with their progress", async () => {
    fetchMock.mockResolvedValueOnce(
      json([
        {
          GameID: 319,
          LastPlayed: '2026-11-20 18:30:00',
          NumPossibleAchievements: 77,
          NumAchieved: 20,
          NumAchievedHardcore: 25
        },
        { GameID: 0 },
        { GameID: 228, NumPossibleAchievements: 96 }
      ])
    )
    const games = await raRecentlyPlayed(CREDS, 500)
    const url = requestUrl()
    expect(url.pathname).toBe('/API/API_GetUserRecentlyPlayedGames.php')
    expect(url.searchParams.get('u')).toBe('TestUser')
    // At most 50 a request.
    expect(url.searchParams.get('c')).toBe('50')
    expect(games).toEqual([
      {
        gameId: 319,
        unlocked: 25,
        unlockedHardcore: 25,
        total: 77,
        lastPlayed: '2026-11-20T18:30:00.000Z'
      },
      { gameId: 228, unlocked: 0, unlockedHardcore: 0, total: 96, lastPlayed: undefined }
    ])
  })
})
