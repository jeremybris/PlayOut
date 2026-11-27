import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import type { AccountStatus, OwnedGame } from '../../shared/types'
import { EventBus } from '../events'
import { LibraryService } from '../services/library-service'
import { LibraryStore } from '../store/library-store'
import { SessionsStore } from '../store/sessions-store'
import { SettingsStore } from '../store/settings-store'
import {
  createAccountsService,
  RETRY_LATER_MINUTES,
  sessionExpiredMessage,
  type AccountsService
} from './index'
import { HttpError } from '../scrapers/http'
import { scriptedWindow, silentLog } from './test-helpers'
import { TokenStore } from './token-store'
import type { EnqueueOptions } from '../scrapers/types'
import {
  SessionExpiredError,
  type AccountTokens,
  type AuthWindow,
  type StoreAccount
} from './types'

let dir: string
let library: LibraryService
let service: AccountsService
let changed: AccountStatus[][]
let enqueued: { ids: string[]; options?: EnqueueOptions }[]
let cleared: string[]
let fake: {
  signInResult: AccountTokens | null
  refreshResult: AccountTokens | null | 'same'
  /** When set, `refresh` throws this instead of returning. */
  refreshError: Error | null
  /** When set, `refresh` waits for it first (the sign-out race). */
  refreshGate: Promise<void> | null
  owned: OwnedGame[]
  fetchError: Error | null
  fetchCalls: number
  /** Called at the start of every `fetchOwned`. */
  onFetch: (() => void) | null
  /** `refresh` calls running now, and the most that ever ran at once. */
  refreshActive: number
  refreshMaxActive: number
}
let visibleOpen = false
let hiddenClosed: string[]
let hiddenWindow: AuthWindow
let libraryEvents: { reason: string; gameIds?: string[] }[]
let settings: SettingsStore
let traceLines: string[]

const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (t: string) => Buffer.from(t, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8')
}

function fakeStore(): StoreAccount {
  return {
    source: 'steam',
    storeName: 'Steam',
    supported: true,
    confirmMessage: 'Confirm the install in Steam',
    signIn: async () => fake.signInResult,
    refresh: async (t) => {
      fake.refreshActive++
      fake.refreshMaxActive = Math.max(fake.refreshMaxActive, fake.refreshActive)
      try {
        if (fake.refreshGate) await fake.refreshGate
        if (fake.refreshError) throw fake.refreshError
        return fake.refreshResult === 'same' ? t : fake.refreshResult
      } finally {
        fake.refreshActive--
      }
    },
    displayName: async (t) => (typeof t.accountName === 'string' ? t.accountName : undefined),
    fetchOwned: async () => {
      fake.fetchCalls++
      fake.onFetch?.()
      if (fake.fetchError) throw fake.fetchError
      return fake.owned
    },
    installSpec: () => null
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-accounts-'))
  changed = []
  enqueued = []
  cleared = []
  hiddenClosed = []
  hiddenWindow = { run: async () => null }
  libraryEvents = []
  traceLines = []
  visibleOpen = false
  fake = {
    signInResult: { kind: 'web', steamId64: '1', accountName: 'example_user', webapiToken: 't' },
    refreshResult: 'same',
    refreshError: null,
    refreshGate: null,
    owned: [
      { externalId: '620', title: 'Portal 2', coverUrl: 'https://cdn/620.jpg' },
      { externalId: '440', title: 'Team Fortress 2' }
    ],
    fetchError: null,
    fetchCalls: 0,
    onFetch: null,
    refreshActive: 0,
    refreshMaxActive: 0
  }
  const events = new EventBus()
  events.on('accounts:changed', (rows) => changed.push(rows))
  events.on('library:changed', (payload) => libraryEvents.push(payload))
  const store = new LibraryStore(join(dir, 'library.json'))
  const sessions = new SessionsStore(join(dir, 'sessions.json'))
  settings = new SettingsStore(join(dir, 'settings.json'))
  await Promise.all([store.load(), sessions.load(), settings.load()])
  library = new LibraryService(store, sessions, events)
  const tokenStore = new TokenStore(join(dir, 'accounts.json'), silentLog, crypto)
  service = await createAccountsService({
    settings,
    library,
    events,
    metadata: { enqueue: (ids, options) => enqueued.push({ ids, options }) } as never,
    window: { get: () => null, focus: () => {}, isFullscreen: () => false },
    log: silentLog,
    userData: dir,
    resourcesDir: dir,
    tokenStore,
    accounts: [
      fakeStore(),
      {
        ...fakeStore(),
        source: 'ubisoft',
        storeName: 'Ubisoft Connect',
        supported: false,
        reason: 'No sign-in'
      }
    ],
    authWindows: {
      visible: () => ({ run: async () => null }),
      hidden: () => hiddenWindow,
      isOpen: () => visibleOpen,
      closeAll: () => {},
      closeHidden: (source) => {
        hiddenClosed.push(source)
      }
    },
    clearPartition: async (p) => {
      cleared.push(p)
    },
    importTrace: { file: '', line: (text) => traceLines.push(text) }
  })
})
afterEach(async () => {
  await service.dispose()
  await fs.rm(dir, { recursive: true, force: true })
})

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5))
}

describe('AccountsService', () => {
  it('lists every store with the unsupported reason and signed-out defaults', async () => {
    const rows = await service.getAccounts()
    expect(rows.find((r) => r.source === 'steam')).toEqual({
      source: 'steam',
      supported: true,
      signedIn: false,
      importing: false
    })
    expect(rows.find((r) => r.source === 'ubisoft')).toMatchObject({
      supported: false,
      reason: 'No sign-in',
      signedIn: false
    })
  })

  it('signs in, stores the credential, imports the owned list and emits accounts:changed', async () => {
    const status = await service.signIn('steam')
    expect(status).toMatchObject({ source: 'steam', signedIn: true, displayName: 'example_user' })
    await settle()
    const after = (await service.getAccounts()).find((r) => r.source === 'steam')!
    expect(after.lastImportCount).toBe(2)
    expect(after.lastImportAt).toBeTruthy()
    expect(after.importing).toBe(false)
    const portal = library.getGame('steam:620')!
    expect(portal).toMatchObject({
      installed: false,
      owned: true,
      launch: { kind: 'uri', uri: 'steam://install/620' }
    })
    expect(library.platforms().map((p) => p.id)).toContain('steam')
    expect([...new Set(enqueued.flatMap((e) => e.ids))].sort()).toEqual(['steam:440', 'steam:620'])
    expect(changed.length).toBeGreaterThanOrEqual(3)
    expect(changed.at(-1)!.find((r) => r.source === 'steam')!.importing).toBe(false)
    expect(
      JSON.parse(await fs.readFile(join(dir, 'accounts.json'), 'utf8')).accounts.steam.displayName
    ).toBe('example_user')
  })

  it('leaves the status unchanged when the window closes without a credential', async () => {
    fake.signInResult = null
    expect(await service.signIn('steam')).toMatchObject({ signedIn: false })
    expect(fake.fetchCalls).toBe(0)
  })

  it('rejects a second sign-in while a window is open and unsupported stores', async () => {
    visibleOpen = true
    await expect(service.signIn('steam')).rejects.toThrow('A sign-in window is already open')
    await expect(service.signIn('ubisoft')).rejects.toThrow('No sign-in')
  })

  it('signs out: tokens gone, partition cleared, owned-only games removed', async () => {
    await service.signIn('steam')
    await settle()
    library.mergeScan(
      'steam',
      [
        {
          source: 'steam',
          externalId: '440',
          platformId: 'steam',
          title: 'TF2',
          launch: { kind: 'uri', uri: 'steam://rungameid/440' },
          tracking: { mode: 'none' }
        }
      ],
      { markMissing: false }
    )
    const status = await service.signOut('steam')
    expect(status).toMatchObject({ signedIn: false })
    expect(cleared).toEqual(['persist:account-steam'])
    expect(library.getGame('steam:620')).toBeUndefined()
    expect(library.getGame('steam:440')).toMatchObject({ installed: true, owned: false })
    expect(status.lastImportAt).toBeUndefined()
  })

  it('marks the session expired when the refresh fails or the API answers 401 twice', async () => {
    await service.signIn('steam')
    await settle()
    fake.refreshResult = null
    const result = await service.importOwned(['steam'])
    expect(result.sources[0]).toMatchObject({ id: 'steam', error: sessionExpiredMessage() })
    const row = (await service.getAccounts()).find((r) => r.source === 'steam')!
    expect(row).toMatchObject({ signedIn: false, error: sessionExpiredMessage() })
    // The games stay (the account may come back); nothing is removed by a failed import.
    expect(library.getGame('steam:620')?.owned).toBe(true)

    fake.refreshResult = 'same'
    await service.signIn('steam')
    await settle()
    fake.fetchError = new SessionExpiredError('Steam')
    const calls = fake.fetchCalls
    const again = await service.importOwned(['steam'])
    expect(again.sources[0].error).toBe(sessionExpiredMessage())
    expect(fake.fetchCalls).toBe(calls + 2)
  })

  it('shares the second refresh after a 401 with a refresh started meanwhile (rotating refresh tokens)', async () => {
    await service.signIn('steam')
    await settle()
    fake.refreshMaxActive = 0
    // The owned fetch answers 401 once; the refresh that follows it is slow.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    fake.fetchError = new SessionExpiredError('Steam')
    fake.onFetch = () => {
      fake.onFetch = null
      fake.refreshGate = gate
    }
    const pending = service.importOwned(['steam'])
    for (let i = 0; i < 200 && fake.refreshActive === 0; i++)
      await new Promise((r) => setTimeout(r, 5))
    expect(fake.refreshActive).toBe(1)
    // Another reader of the credential asks for a refresh while that one runs: it must join it.
    const credential = service.steamCredential(true)
    await settle()
    expect(fake.refreshActive).toBe(1)
    fake.fetchError = null
    fake.refreshGate = null
    release()
    const result = await pending
    expect(result.sources[0]).toMatchObject({ id: 'steam', imported: 2 })
    expect(result.sources[0].error).toBeUndefined()
    expect(await credential).toMatchObject({ kind: 'web' })
    expect(fake.refreshMaxActive).toBe(1)
  })

  it('sign-out sticks while an import of that store is in flight', async () => {
    await service.signIn('steam')
    await settle()
    // The import's refresh is slow (a hidden-window re-mint); the user signs out meanwhile.
    let release!: () => void
    fake.refreshGate = new Promise<void>((r) => (release = r))
    const pending = service.importOwned(['steam'])
    await new Promise((r) => setTimeout(r, 5))
    const signOut = service.signOut('steam')
    await new Promise((r) => setTimeout(r, 5))
    expect(hiddenClosed).toEqual(['steam'])
    release()
    await signOut
    const result = await pending
    expect(result.sources[0]).toMatchObject({ id: 'steam', imported: 0 })
    await settle()
    const row = (await service.getAccounts()).find((r) => r.source === 'steam')!
    expect(row).toMatchObject({ signedIn: false })
    expect(row.lastImportCount).toBeUndefined()
    expect(library.getGame('steam:620')).toBeUndefined()
    expect(JSON.parse(await fs.readFile(join(dir, 'accounts.json'), 'utf8')).accounts.steam).toBe(
      undefined
    )
  })

  it('keeps the credential and the games when the refresh could not reach the store', async () => {
    await service.signIn('steam')
    await settle()
    fake.refreshError = new Error('fetch failed')
    const result = await service.importOwned(['steam'])
    expect(result.sources[0].error).toMatch(/Could not reach Steam/)
    const row = (await service.getAccounts()).find((r) => r.source === 'steam')!
    expect(row).toMatchObject({ signedIn: true, displayName: 'example_user', lastImportCount: 2 })
    expect(row.error).toMatch(/Could not reach Steam/)
    expect(library.getGame('steam:620')?.owned).toBe(true)
    // The next import, with the store back, clears the error.
    fake.refreshError = null
    await service.importOwned(['steam'])
    expect((await service.getAccounts()).find((r) => r.source === 'steam')!.error).toBeUndefined()
  })

  // Fake setTimeout covers the retry timer and the stores' debounced saves; `until` keeps the fake clock moving in
  // small steps while it polls, so a save an import waits on can finish.
  const until = (check: () => unknown | Promise<unknown>): Promise<unknown> =>
    vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(200)
      await check()
    })
  const steamRow = async (): Promise<AccountStatus> =>
    (await service.getAccounts()).find((r) => r.source === 'steam')!
  /** The Steam row of the last accounts:changed: the state once an import's save and emit are done. */
  const lastEmitted = (): AccountStatus | undefined =>
    changed.at(-1)?.find((r) => r.source === 'steam' && !r.importing)
  const minutes = async (n: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(n * 60_000)
  }

  it("tells the user a 5xx is on the store's side, keeps the games and retries in 10 then 30 minutes", async () => {
    await service.signIn('steam')
    await settle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fake.fetchError = new HttpError(
        'HTTP 502 Bad Gateway for https://api.steampowered.com/x?key=***',
        { status: 502, statusText: 'Bad Gateway', url: 'https://api.steampowered.com/x?key=K' }
      )
      const result = await service.importOwned(['steam'])
      const expected =
        "Steam's servers are not responding right now (HTTP 502 Bad Gateway). This is a problem on Steam's side, not in PlayOut. Your Steam games are unchanged; PlayOut will try again in 10 minutes."
      expect(result.sources[0].error).toBe(expected)
      expect(await steamRow()).toMatchObject({
        signedIn: true,
        error: expected,
        errorKind: 'store'
      })
      expect(library.getGame('steam:620')?.owned).toBe(true)
      expect(
        traceLines.some((l) => l.startsWith('steam: outcome store unavailable (server HTTP 502)'))
      ).toBe(true)
      // The outcome line keeps host + path only: no query string (steamid, key) in the shared trace.
      const outcome = traceLines.find((l) => l.includes('outcome store unavailable'))!
      expect(outcome).toMatch(/for https:\/\/api\.steampowered\.com\/x$/)
      expect(outcome).not.toContain('?')

      // A second failing import (Import click) restarts the 10 minutes without stacking a second timer.
      await service.importOwned(['steam'])
      const calls = fake.fetchCalls
      await minutes(9)
      expect(fake.fetchCalls).toBe(calls)
      await minutes(RETRY_LATER_MINUTES[0] - 9)
      // Finished = its outcome is in the trace and the last accounts:changed (sent after the save) has the notice.
      await until(() => expect(lastEmitted()?.error).toMatch(/in 30 minutes/))
      expect(fake.fetchCalls).toBe(calls + 1)

      // The 30-minute retry fails as well: no third one.
      await minutes(RETRY_LATER_MINUTES[1])
      await until(() => expect(lastEmitted()?.error).toMatch(/Import again later/))
      expect(fake.fetchCalls).toBe(calls + 2)
      await minutes(120)
      expect(fake.fetchCalls).toBe(calls + 2)

      // A later normal import that fails starts over; the store coming back clears the notice and the timer.
      fake.fetchError = new HttpError('HTTP 503', { status: 503, url: 'u' })
      await service.importOwned(['steam'])
      expect((await steamRow()).error).toMatch(/Service Unavailable.*try again in 10 minutes/)
      fake.fetchError = null
      await service.importOwned(['steam'])
      const row = await steamRow()
      expect(row.error).toBeUndefined()
      expect(row.errorKind).toBeUndefined()
      expect(traceLines.at(-1)).toMatch(/^steam: outcome imported 2 game\(s\)/)
      const after = fake.fetchCalls
      await minutes(60)
      expect(fake.fetchCalls).toBe(after)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the automatic retry on sign-out and on dispose', async () => {
    await service.signIn('steam')
    await settle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fake.fetchError = new HttpError('HTTP 429', { status: 429, url: 'u' })
      const result = await service.importOwned(['steam'])
      expect(result.sources[0].error).toMatch(
        /^Steam is limiting requests right now \(HTTP 429 Too Many Requests\)/
      )
      const signOut = service.signOut('steam')
      await until(() => signOut)
      const calls = fake.fetchCalls
      await minutes(60)
      expect(fake.fetchCalls).toBe(calls)

      const signIn = service.signIn('steam')
      await until(async () => {
        await signIn
        expect((await steamRow()).errorKind).toBe('store')
      })
      const before = fake.fetchCalls
      await service.dispose()
      await minutes(60)
      expect(fake.fetchCalls).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps "Import failed" for PlayOut-side errors and schedules no retry', async () => {
    await service.signIn('steam')
    await settle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fake.fetchError = new HttpError('invalid JSON from https://api.steampowered.com/x', {
        status: 200,
        url: 'u'
      })
      await service.importOwned(['steam'])
      const row = await steamRow()
      expect(row.error).toBe('Import failed: invalid JSON from https://api.steampowered.com/x')
      expect(row.errorKind).toBeUndefined()
      const calls = fake.fetchCalls
      await minutes(60)
      expect(fake.fetchCalls).toBe(calls)
      // A 401 is still an expired session.
      fake.fetchError = new SessionExpiredError('Steam')
      fake.refreshResult = null
      const again = await service.importOwned(['steam'])
      expect(again.sources[0].error).toBe(sessionExpiredMessage())
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the API-key credential as set in Settings and refuses to sign it out', async () => {
    settings.update({ scrapers: { steam: { apiKey: 'K', steamId64: '76561198000000101' } } })
    const row = (await service.getAccounts()).find((r) => r.source === 'steam')!
    expect(row).toMatchObject({ signedIn: true, viaSettings: true })
    expect(row.displayName).toContain('(API key)')
    await expect(service.signOut('steam')).rejects.toThrow(/Settings > Metadata/)
    // A web sign-in on top of the key: signing out removes the web credential, the key keeps the games.
    await service.signIn('steam')
    await settle()
    expect(library.getGame('steam:620')?.owned).toBe(true)
    const after = await service.signOut('steam')
    expect(after).toMatchObject({ signedIn: true, viaSettings: true })
    expect(library.getGame('steam:620')?.owned).toBe(true)
  })

  it('hands the store art to the metadata service as cover-lane seeds in one enqueue', async () => {
    fake.owned = [
      {
        externalId: '1',
        title: 'A',
        coverUrl: 'https://cdn/1c.jpg',
        heroUrl: 'https://cdn/1h.jpg'
      },
      {
        externalId: '2',
        title: 'B',
        coverUrl: 'https://cdn/2c.jpg',
        heroUrl: 'https://cdn/2h.jpg'
      },
      { externalId: '3', title: 'C', coverUrl: 'https://cdn/3c.jpg', heroUrl: 'https://cdn/3h.jpg' }
    ]
    settings.mutate((s) => {
      s.scrapers.autoScrape = false
    })
    await service.signIn('steam')
    await settle()
    // The service downloads nothing itself (ARCHITECTURE.md §4.8): one enqueue carries the new games and the
    // store URLs as seeds, covers only because auto-scrape is off.
    expect(libraryEvents.filter((e) => e.reason === 'metadata')).toHaveLength(0)
    expect(enqueued).toHaveLength(1)
    expect([...new Set(enqueued[0].ids)].sort()).toEqual(['steam:1', 'steam:2', 'steam:3'])
    expect(enqueued[0].options).toMatchObject({ coverOnly: true })
    expect(enqueued[0].options?.seeds?.map((s) => `${s.gameId}:${s.kind}`)).toEqual([
      'steam:1:cover',
      'steam:1:hero',
      'steam:2:cover',
      'steam:2:hero',
      'steam:3:cover',
      'steam:3:hero'
    ])
    expect(enqueued[0].options?.seeds?.[0]).toMatchObject({ url: 'https://cdn/1c.jpg' })
  })

  it('coalesces concurrent imports and skips signed-out sources when none are named', async () => {
    expect((await service.importOwned()).sources).toEqual([])
    await service.signIn('steam')
    await settle()
    fake.fetchCalls = 0
    const [a, b] = await Promise.all([
      service.importOwned(['steam']),
      service.importOwned(['steam'])
    ])
    expect(fake.fetchCalls).toBe(1)
    expect(a.sources[0]).toEqual(b.sources[0])
    expect(a.sources[0]).toMatchObject({ imported: 2, added: 0, removed: 0 })
    fake.owned = fake.owned.slice(0, 1)
    expect((await service.importOwned()).sources[0]).toMatchObject({ imported: 1, removed: 1 })
    expect(library.getGame('steam:440')).toBeUndefined()
  })
})

describe('steamOwnedApps', () => {
  it('reads the owned apps through the hidden Steam window once signed in', async () => {
    expect(await service.steamOwnedApps()).toBeNull()
    await service.signIn('steam')
    // The hidden window did not answer: ownership unknown.
    expect(await service.steamOwnedApps()).toBeNull()
    hiddenWindow = scriptedWindow([
      {
        url: 'https://store.steampowered.com/dynamicstore/userdata/',
        js: '{"rgOwnedApps":[620,337840],"rgWishlist":[]}'
      }
    ])
    expect(await service.steamOwnedApps()).toEqual(new Set([620, 337840]))
  })

  it('is null for a page that is not JSON (the store session is gone)', async () => {
    await service.signIn('steam')
    hiddenWindow = scriptedWindow([
      { url: 'https://store.steampowered.com/login/', js: '<html>Sign in</html>' }
    ])
    expect(await service.steamOwnedApps()).toBeNull()
  })
})
