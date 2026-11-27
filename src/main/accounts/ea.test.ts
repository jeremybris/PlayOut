import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createEaAccount,
  filterOwnedItems,
  mapEaOwned,
  ownedGamesUrl,
  ownershipClass,
  type EaLegacyOffer,
  type EaOwnedItem
} from './ea'
import { context, requestBody, scriptedWindow, stubFetch } from './test-helpers'
import { SessionExpiredError, StoreUnavailableError } from './types'

const ITEMS: EaOwnedItem[] = [
  {
    id: 'i1',
    originOfferId: 'Origin.OFR.50.0002487',
    product: {
      name: 'A Way Out™',
      gameSlug: 'a-way-out',
      baseItem: { gameType: 'BASE_GAME' },
      gameProductUser: { ownershipMethods: ['PURCHASE'] }
    }
  },
  {
    id: 'i2',
    originOfferId: 'Origin.OFR.50.0001139',
    product: {
      name: 'The Sims 3',
      gameSlug: 'the-sims-3',
      baseItem: { gameType: 'BASE_GAME' },
      gameProductUser: { ownershipMethods: ['VAULT'] }
    }
  },
  {
    id: 'i3',
    originOfferId: 'Origin.OFR.50.0009',
    product: { name: 'EA app', baseItem: { gameType: 'BASE_GAME', isLauncher: true } }
  },
  {
    id: 'i4',
    originOfferId: 'Origin.OFR.50.0010',
    product: {
      name: 'Steam thing',
      gameSlug: 'steam-thing',
      baseItem: { gameType: 'BASE_GAME' },
      gameProductUser: { ownershipMethods: ['STEAM'] }
    }
  }
]

const OFFERS = new Map<string, EaLegacyOffer>([
  [
    'Origin.OFR.50.0002487',
    {
      offerId: 'Origin.OFR.50.0002487',
      contentId: '1028663',
      installCheckOverride:
        '[HKEY_LOCAL_MACHINE\\SOFTWARE\\Hazelight\\AWayOut\\Install Dir]\\AWayOut.exe',
      softwareId: 'Origin.SFT.50.0000658'
    }
  ],
  [
    'Origin.OFR.50.0001139',
    { offerId: 'Origin.OFR.50.0001139', contentId: '55906', installCheckOverride: '' }
  ],
  ['Origin.OFR.50.0010', { offerId: 'Origin.OFR.50.0010', contentId: '' }]
])

afterEach(() => vi.unstubAllGlobals())

describe('ea parsing', () => {
  it('builds the persisted query URL with the documented variables', () => {
    const url = new URL(ownedGamesUrl('0'))
    expect(url.searchParams.get('operationName')).toBe('getPreloadedOwnedGames')
    const variables = JSON.parse(url.searchParams.get('variables')!)
    expect(variables).toMatchObject({
      isMac: false,
      limit: 500,
      next: '0',
      platforms: ['PC'],
      type: ['DIGITAL_FULL_GAME', 'PACKAGED_FULL_GAME']
    })
    expect(JSON.parse(url.searchParams.get('extensions')!).persistedQuery.sha256Hash).toMatch(
      /^779f1cd1/
    )
  })

  it('classifies ownership and filters launchers', () => {
    expect(ownershipClass(['PURCHASE'])).toBe('owned')
    expect(ownershipClass(['XGP_VAULT'])).toBe('gamepass')
    expect(ownershipClass(['STEAM_SUBSCRIPTION'])).toBe('eaplay')
    expect(filterOwnedItems(ITEMS).map((i) => i.id)).toEqual(['i1', 'i2', 'i4'])
  })

  it('maps items to content ids and marks entitlements the EA app cannot install', () => {
    const { owned, skipped } = mapEaOwned(ITEMS, OFFERS)
    expect(owned).toHaveLength(2)
    expect(owned[0]).toMatchObject({
      externalId: '1028663',
      title: 'A Way Out',
      extra: {
        contentId: '1028663',
        eaOfferId: 'Origin.OFR.50.0002487',
        eaSoftwareId: 'Origin.SFT.50.0000658',
        eaSlug: 'a-way-out',
        eaOwnership: 'owned'
      }
    })
    expect(owned[0].extra?.eaManagedElsewhere).toBeUndefined()
    expect(owned[1]).toMatchObject({
      externalId: '55906',
      extra: { eaOwnership: 'eaplay', eaManagedElsewhere: true }
    })
    expect(skipped).toEqual(['Steam thing'])
  })
})

describe('ea account', () => {
  const account = createEaAccount()

  it('signs in when the site lands on its home page', async () => {
    expect(
      await account.signIn(
        scriptedWindow([
          { url: 'https://accounts.ea.com/connect/auth?x' },
          { url: 'https://www.ea.com/' }
        ]),
        context()
      )
    ).toMatchObject({ kind: 'cookie' })
    expect(
      await account.signIn(
        scriptedWindow([{ url: 'https://accounts.ea.com/connect/auth?x' }]),
        context()
      )
    ).toBeNull()
  })

  it('mints the bearer from the SPA request header in a hidden window', async () => {
    const hidden = scriptedWindow([
      {
        url: 'https://www.ea.com/sales/deals',
        requests: [
          {
            url: 'https://service-aggregation-layer.juno.ea.com/graphql?operationName=x',
            requestHeaders: { accept: '*/*' }
          },
          {
            url: 'https://service-aggregation-layer.juno.ea.com/graphql?operationName=y',
            requestHeaders: { authorization: 'Bearer jwt.token' }
          }
        ]
      }
    ])
    const fresh = await account.refresh({ kind: 'cookie', signedInAt: 'x' }, context(hidden))
    expect(fresh).toMatchObject({ kind: 'cookie', token: 'jwt.token' })
    // The page bounced to the sign-in: the session is dead.
    expect(
      await account.refresh(
        { kind: 'cookie', signedInAt: 'x' },
        context(scriptedWindow([{ url: 'https://signin.ea.com/p/web2/login?execution=e1' }]))
      )
    ).toBeNull()
    // No bearer within the window (offline, slow site): unknown, the credential stays.
    await expect(
      account.refresh(
        { kind: 'cookie', signedInAt: 'x' },
        context(scriptedWindow([{ url: 'https://www.ea.com/sales/deals' }]))
      )
    ).rejects.toBeInstanceOf(StoreUnavailableError)
  })

  it('pages the owned list, resolves legacy offers and reports UNAUTHENTICATED', async () => {
    const fetchMock = stubFetch((url, init) => {
      if (new Headers(init.headers).get('authorization') !== 'Bearer jwt')
        return {
          status: 401,
          body: {
            errors: [{ message: 'Not authenticated.', extensions: { code: 'UNAUTHENTICATED' } }],
            data: null
          }
        }
      if (init.method === 'POST') {
        const offerIds = JSON.parse(requestBody(init)).variables.offerIds as string[]
        return { body: { data: { legacyOffers: offerIds.map((id) => OFFERS.get(id) ?? null) } } }
      }
      const next = JSON.parse(url.searchParams.get('variables')!).next
      return next === '0'
        ? { body: { data: { me: { ownedGameProducts: { next: '2', items: ITEMS.slice(0, 2) } } } } }
        : { body: { data: { me: { ownedGameProducts: { next: null, items: ITEMS.slice(2) } } } } }
    })
    const owned = await account.fetchOwned(
      { kind: 'cookie', signedInAt: 'x', token: 'jwt' },
      context()
    )
    expect(owned.map((g) => g.externalId)).toEqual(['1028663', '55906'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await expect(
      account.fetchOwned({ kind: 'cookie', signedInAt: 'x', token: 'expired' }, context())
    ).rejects.toBeInstanceOf(SessionExpiredError)
    await expect(
      account.fetchOwned({ kind: 'cookie', signedInAt: 'x' }, context())
    ).rejects.toBeInstanceOf(SessionExpiredError)
  })

  describe('never reports a failed answer as a shorter library', () => {
    const tokens = { kind: 'cookie', signedInAt: 'x', token: 'jwt' }
    const ownedPage = {
      body: { data: { me: { ownedGameProducts: { next: null, items: ITEMS.slice(0, 1) } } } }
    }

    it.each([
      ['an owned-list GraphQL error', { body: { errors: [{ message: 'boom' }], data: null } }],
      ['an owned list that is absent', { body: { data: { me: null } } }],
      [
        'an owned page without items',
        { body: { data: { me: { ownedGameProducts: { next: null, items: null } } } } }
      ]
    ])('rejects on %s', async (_name, answer) => {
      stubFetch(() => answer)
      await expect(account.fetchOwned(tokens, context())).rejects.toBeInstanceOf(
        StoreUnavailableError
      )
    })

    it.each([
      ['a failed lookup', { status: 400, body: {} }],
      ['a lookup GraphQL error', { body: { errors: [{ message: 'boom' }], data: null } }],
      ['a lookup with partial errors', { body: { errors: [{}], data: { legacyOffers: [] } } }],
      ['a lookup with no offers field', { body: { data: {} } }],
      ['a lookup with an empty batch', { body: { data: { legacyOffers: [] } } }]
    ])('rejects on %s', async (_name, answer) => {
      stubFetch((_url, init) => (init.method === 'POST' ? answer : ownedPage))
      await expect(account.fetchOwned(tokens, context())).rejects.toThrow()
    })

    it('accepts an account that really owns nothing', async () => {
      stubFetch(() => ({
        body: { data: { me: { ownedGameProducts: { next: null, items: [] } } } }
      }))
      await expect(account.fetchOwned(tokens, context())).resolves.toEqual([])
    })

    it('treats UNAUTHENTICATED in a 200 lookup answer as an expired session', async () => {
      stubFetch((_url, init) =>
        init.method === 'POST'
          ? { body: { errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] } }
          : ownedPage
      )
      await expect(account.fetchOwned(tokens, context())).rejects.toBeInstanceOf(
        SessionExpiredError
      )
    })
  })

  it('installs through origin2 unless the game is managed elsewhere', () => {
    const client = { installed: true, path: 'C:\\EA\\EALauncher.exe' }
    expect(
      account.installSpec(
        { externalId: '1028663', extra: { contentId: '1028663' } } as never,
        client
      )
    ).toEqual({ kind: 'uri', uri: 'origin2://game/launch/?offerIds=1028663' })
    // With the offer id (every account-imported record) the non-launching download form is used, so a stale
    // record of a game the EA app already installed cannot start it.
    expect(
      account.installSpec(
        {
          externalId: '1028663',
          extra: { contentId: '1028663', eaOfferId: 'Origin.OFR.50.0001139' }
        } as never,
        client
      )
    ).toEqual({ kind: 'uri', uri: 'origin2://game/download?offerId=Origin.OFR.50.0001139' })
    const managed = {
      externalId: '55906',
      extra: { contentId: '55906', eaManagedElsewhere: true }
    } as never
    expect(account.installSpec(managed, client)).toBeNull()
    expect(account.installError!(managed, client)).toMatch(/another store/)
    expect(account.installSpec({ externalId: 'path:abc', extra: {} } as never, client)).toBeNull()
  })
})
