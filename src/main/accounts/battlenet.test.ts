import { describe, expect, it } from 'vitest'
import {
  battlenetInstallSpec,
  createBattlenetAccount,
  isDeadSessionUrl,
  isSignedInUrl,
  mapBattlenetOwned,
  type BattlenetProductRow
} from './battlenet'
import { context, scriptedWindow } from './test-helpers'
import { SessionExpiredError, StoreUnavailableError } from './types'

const PRODUCTS: BattlenetProductRow[] = [
  { code: 'WoW', uid: 'wow', name: 'World of Warcraft', type: 'default', apiId: 5730135 },
  { code: 'Pro', uid: 'prometheus', name: 'Overwatch', type: 'default', apiId: 5272175 },
  { code: 'D2', uid: 'Diablo II', name: 'Diablo II', type: 'classic' },
  {
    code: 'D2X',
    uid: 'Diablo II Lord of Destruction',
    name: 'Diablo II: Lord of Destruction',
    type: 'classic'
  },
  { code: 'W3', uid: 'Warcraft III', name: 'Warcraft III', type: 'classic' }
]

const GAMES = {
  gameAccounts: [
    { titleId: 5730135, localizedGameName: 'World of Warcraft', gameAccountName: 'WoW1' },
    { titleId: 5730135, localizedGameName: 'World of Warcraft', gameAccountName: 'WoW2' },
    { titleId: 5272175, localizedGameName: 'Overwatch' },
    { titleId: 99, localizedGameName: 'Unknown thing' }
  ]
}

const CLASSIC = {
  classicGames: [
    { localizedGameName: 'Diablo II', regionalGameFranchiseIconFilename: 'diablo-ii.png' },
    { localizedGameName: 'Diablo II: LoD', regionalGameFranchiseIconFilename: 'diablo-ii-lod.png' },
    { localizedGameName: 'Warcraft III', regionalGameFranchiseIconFilename: 'warcraft-iii.png' }
  ]
}

describe('battlenet owned mapping', () => {
  it('dedupes game accounts per product, resolves classic titles and lists unknown ids', () => {
    const { owned, unknown } = mapBattlenetOwned(GAMES, CLASSIC, PRODUCTS)
    expect(owned.map((g) => g.externalId)).toEqual(['WoW', 'Pro', 'D2X', 'W3'])
    expect(owned[0]).toMatchObject({
      title: 'World of Warcraft',
      extra: { uid: 'wow', battlenetProductType: 'default' }
    })
    expect(unknown).toEqual(['Unknown thing (99)'])
  })

  it('recognises the sign-in landing pages and the dead-session redirect', () => {
    expect(isSignedInUrl('https://account.battle.net/overview')).toBe(true)
    expect(isSignedInUrl('https://account.battle.net/')).toBe(true)
    expect(isSignedInUrl('https://account.battle.net/login/en/?ref=x')).toBe(false)
    expect(
      isDeadSessionUrl('https://oauth.battle.net/authorize?response_type=code&client_id=057')
    ).toBe(true)
  })

  it('builds the client install command', () => {
    expect(battlenetInstallSpec('C:\\Battle.net\\Battle.net.exe', 'wow')).toEqual({
      kind: 'exec',
      file: 'C:\\Battle.net\\Battle.net.exe',
      args: ['--install', '--game=wow']
    })
  })
})

describe('battlenet account', () => {
  const account = createBattlenetAccount(() => PRODUCTS)

  it('signs in when the account overview appears', async () => {
    const tokens = await account.signIn(
      scriptedWindow([
        { url: 'https://account.battle.net/login/en/' },
        { url: 'https://account.battle.net/overview' }
      ]),
      context()
    )
    expect(tokens).toMatchObject({ kind: 'cookie' })
    expect(
      await account.signIn(
        scriptedWindow([{ url: 'https://account.battle.net/login/en/' }]),
        context()
      )
    ).toBeNull()
  })

  it('refreshes through the hidden window and reads the account api', async () => {
    const hidden = scriptedWindow([
      { url: 'https://account.battle.net/overview', js: '{"authenticated":true,"accountId":12345}' }
    ])
    const fresh = await account.refresh({ kind: 'cookie', signedInAt: 'x' }, context(hidden))
    expect(fresh).toMatchObject({ kind: 'cookie', accountId: '12345' })
    expect(await account.displayName(fresh!, context())).toBe('Account 12345')
    const dead = scriptedWindow([
      { url: 'https://oauth.battle.net/authorize?response_type=code', loaded: false }
    ])
    expect(await account.refresh({ kind: 'cookie', signedInAt: 'x' }, context(dead))).toBeNull()
    // Nothing loaded at all (offline, timeout): the session is unknown, not dead.
    await expect(
      account.refresh({ kind: 'cookie', signedInAt: 'x' }, context(scriptedWindow([])))
    ).rejects.toBeInstanceOf(StoreUnavailableError)
    // A JSON document on another origin is never read: it counts as a login redirect.
    const elsewhere = scriptedWindow([
      { url: 'https://account.battle.net/overview' },
      { url: 'https://evil.example/api/', js: '{"authenticated":true,"accountId":1}' }
    ])
    expect(
      await account.refresh({ kind: 'cookie', signedInAt: 'x' }, context(elsewhere))
    ).toBeNull()
  })

  it('reads games-and-subs and classic-games through the partition', async () => {
    let call = 0
    const hidden = {
      async run<T>(page: {
        onNavigate?: (ctx: {
          url: string
          loaded: boolean
          executeJavaScript<R>(s: string): Promise<R>
        }) => Promise<T | null | undefined> | T | null | undefined
      }): Promise<T | null> {
        const body = call++ === 0 ? JSON.stringify(GAMES) : JSON.stringify(CLASSIC)
        const value = await page.onNavigate?.({
          url: 'https://account.battle.net/api/x',
          loaded: true,
          executeJavaScript: async <R>() => body as R
        })
        return value ?? null
      }
    }
    const owned = await account.fetchOwned({ kind: 'cookie', signedInAt: 'x' }, context(hidden))
    expect(owned.map((g) => g.externalId)).toEqual(['WoW', 'Pro', 'D2X', 'W3'])
    const loginShell = scriptedWindow([
      { url: 'https://account.battle.net/login/en/', js: '<html>login</html>' }
    ])
    await expect(
      account.fetchOwned({ kind: 'cookie', signedInAt: 'x' }, context(loginShell))
    ).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('installs through the client exe, never classic titles or without the client', () => {
    const client = { installed: true, path: 'C:\\Battle.net\\Battle.net.exe' }
    expect(
      account.installSpec({ externalId: 'WoW', extra: { uid: 'wow' } } as never, client)
    ).toEqual({
      kind: 'exec',
      file: 'C:\\Battle.net\\Battle.net.exe',
      args: ['--install', '--game=wow']
    })
    expect(account.installSpec({ externalId: 'Pro', extra: {} } as never, client)).toMatchObject({
      args: ['--install', '--game=prometheus']
    })
    expect(
      account.installSpec({ externalId: 'D2', title: 'Diablo II', extra: {} } as never, client)
    ).toBeNull()
    expect(
      account.installError!({ externalId: 'D2', title: 'Diablo II', extra: {} } as never, client)
    ).toMatch(/classic/)
    expect(
      account.installSpec({ externalId: 'WoW', extra: { uid: 'wow' } } as never, {
        installed: false
      })
    ).toBeNull()
  })
})
