import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('./http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http')>()
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
  bundleBase,
  buildSearchPayload,
  extractSearchPath,
  hltbConsolesFor,
  hltbLookup,
  hltbSearchTerms,
  hltbTimesOf,
  normalizeTitle,
  pickBestHltbMatch,
  resetHltbState,
  searchVariants,
  stripEdition,
  titleSimilarity,
  yearTagHidden,
  type HltbSearchResult
} from './hltb'

// Values from the live game-page JSON for Portal 2 (docs/research/metadata-apis.md §6.3); the search endpoint
// returns the same keys with `release_world` as a year.
const PORTAL_2: HltbSearchResult = {
  game_id: 7231,
  game_name: 'Portal 2',
  game_alias: '',
  game_type: 'game',
  game_image: 'Portal2cover.jpg',
  comp_main: 30885,
  comp_plus: 49570,
  comp_100: 82821,
  comp_all: 38322,
  release_world: 2011,
  profile_steam: 620
}
const PORTAL: HltbSearchResult = {
  game_id: 7230,
  game_name: 'Portal',
  game_alias: '',
  game_type: 'game',
  comp_main: 10800,
  comp_plus: 14400,
  comp_100: 36000,
  release_world: 2007
}
const PORTAL_DLC: HltbSearchResult = {
  game_id: 9000,
  game_name: 'Portal 2: Sixense MotionPack',
  game_type: 'dlc',
  comp_main: 7200,
  release_world: 2011
}
const PORTAL_MEL: HltbSearchResult = {
  game_id: 25000,
  game_name: 'Portal Stories: Mel',
  game_type: 'game',
  comp_main: 21600,
  release_world: 2015
}
const WITCHER: HltbSearchResult = {
  game_id: 10270,
  game_name: 'The Witcher',
  game_alias: 'The Witcher: Enhanced Edition',
  game_type: 'game',
  comp_main: 129600,
  release_world: 2007
}
const MEGAMAN: HltbSearchResult = {
  game_id: 5806,
  game_name: 'Mega Man X',
  game_alias: 'Rockman X',
  game_type: 'game',
  comp_main: 10800,
  release_world: 1993
}
const NO_TIMES: HltbSearchResult = {
  game_id: 1,
  game_name: 'Half-Life 3',
  game_type: 'game',
  release_world: 2030
}

const RESULTS = [PORTAL_2, PORTAL, PORTAL_DLC, PORTAL_MEL, WITCHER, MEGAMAN, NO_TIMES]

interface Call {
  url: string
  method: string
  headers: Headers
  body: unknown
}

function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const call: Call = {
        url: String(input),
        method: (init.method ?? 'GET').toUpperCase(),
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      }
      calls.push(call)
      return handler(call)
    })
  )
  return calls
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  resetHltbState()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('title matching', () => {
  it('normalises titles and strips edition suffixes', () => {
    expect(normalizeTitle('The Witcher® 3: Wild Hunt – Game of the Year Edition')).toBe(
      'the witcher 3 wild hunt game of the year edition'
    )
    expect(normalizeTitle('Pokémon Rouge & Bleu')).toBe('pokemon rouge and bleu')
    expect(
      stripEdition(normalizeTitle('The Witcher 3: Wild Hunt - Game of the Year Edition'))
    ).toBe('the witcher 3 wild hunt')
    expect(stripEdition(normalizeTitle('Fallout 3: Game of the Year Edition'))).toBe('fallout 3')
    expect(stripEdition('resident evil 4 hd')).toBe('resident evil 4')
    expect(stripEdition('deluxe edition')).toBe('deluxe edition')
  })

  it('scores whole titles higher than prefixes', () => {
    expect(titleSimilarity('portal 2', 'portal 2')).toBe(1)
    expect(titleSimilarity('portal', 'portal 2')).toBeLessThan(0.8)
    expect(titleSimilarity('the witcher 3 wild hunt', 'the witcher 3 wild hunt')).toBe(1)
    expect(titleSimilarity('mega man x', 'megaman x')).toBeGreaterThan(0.5)
    expect(titleSimilarity('', 'x')).toBe(0)
  })

  it('picks the best match using the title, aliases and the release year', () => {
    expect(pickBestHltbMatch('Portal 2', 2011, RESULTS)?.result.game_id).toBe(7231)
    expect(pickBestHltbMatch('Portal 2', undefined, RESULTS)?.result.game_id).toBe(7231)
    expect(pickBestHltbMatch('Portal', 2007, RESULTS)?.result.game_id).toBe(7230)
    expect(pickBestHltbMatch('Portal', undefined, RESULTS)?.result.game_id).toBe(7230)
    expect(pickBestHltbMatch('The Witcher: Enhanced Edition', 2008, RESULTS)?.result.game_id).toBe(
      10270
    )
    expect(pickBestHltbMatch('Rockman X', 1993, RESULTS)?.result.game_id).toBe(5806)
    expect(pickBestHltbMatch('Portal Stories - Mel', 2015, RESULTS)?.result.game_id).toBe(25000)
  })

  it("matches a port released years after HLTB's entry, but not an entry years after the store's", () => {
    // Phoenix Wright: Ace Attorney Trilogy: HLTB's only entry is the 2014 compilation, Steam's port is from 2019.
    const trilogy: HltbSearchResult = {
      game_id: 23310,
      game_name: 'Phoenix Wright: Ace Attorney Trilogy',
      game_type: 'compil',
      comp_main: 217587,
      comp_all: 241785,
      comp_lvl_combine: 1,
      release_world: 2014
    }
    expect(
      pickBestHltbMatch('Phoenix Wright: Ace Attorney Trilogy', 2019, [trilogy])?.result.game_id
    ).toBe(23310)
    // A remake on HLTB (2023) is not the 2008 game a store sells under the same name.
    const remake: HltbSearchResult = {
      game_id: 2,
      game_name: 'Dead Space',
      comp_main: 3600,
      release_world: 2023
    }
    expect(pickBestHltbMatch('Dead Space', 2008, [remake])?.score ?? 0).toBeLessThan(1)
    // The entry of the right year still wins over an older one of the same name.
    const original: HltbSearchResult = { ...remake, game_id: 1, release_world: 2008 }
    expect(pickBestHltbMatch('Dead Space', 2023, [original, remake])?.result.game_id).toBe(2)
  })

  it('rejects unrelated titles, wrong years and entries without times', () => {
    expect(pickBestHltbMatch('Half-Life 2', 2004, RESULTS)).toBeNull()
    expect(pickBestHltbMatch('Half-Life 3', 2030, RESULTS)).toBeNull()
    expect(pickBestHltbMatch('Portal', 2011, [PORTAL_2, PORTAL_DLC])).toBeNull()
    expect(pickBestHltbMatch('', 2011, RESULTS)).toBeNull()
    expect(pickBestHltbMatch('Portal 2', 2011, [])).toBeNull()
  })

  it('converts HLTB seconds to hours with one decimal', () => {
    expect(hltbTimesOf(PORTAL_2)).toEqual({
      main: 8.6,
      extra: 13.8,
      completionist: 23,
      combined: false
    })
    expect(
      hltbTimesOf({ game_id: 1, game_name: 'x', comp_main: 0, comp_plus: 0, comp_100: 0 })
    ).toBeNull()
    expect(hltbTimesOf({ game_id: 1, game_name: 'x', comp_plus: 3600 })).toEqual({
      extra: 1,
      combined: false
    })
  })

  it("reads HLTB's Solo time for a game whose play styles are combined (no Main Story box on its page)", () => {
    // Phoenix Wright: Ace Attorney Trilogy (#23310) as HLTB's search answered it: Solo 67.2 h.
    const trilogy = {
      game_id: 23310,
      game_name: 'Phoenix Wright: Ace Attorney Trilogy',
      game_type: 'compil',
      comp_main: 217587,
      comp_plus: 247920,
      comp_100: 259994,
      comp_all: 241785,
      comp_lvl_combine: 1
    }
    expect(hltbTimesOf(trilogy)).toMatchObject({ solo: 67.2, combined: true, main: 60.4 })
    // A separate-styles game has no Solo time, its Main Story stands.
    expect(hltbTimesOf({ ...trilogy, comp_lvl_combine: 0 })?.solo).toBeUndefined()
    // No Main Story time at all: Solo fills in, whatever the styles.
    expect(
      hltbTimesOf({ game_id: 2, game_name: 'y', comp_all: 7200, comp_lvl_combine: 0 })
    ).toEqual({ solo: 2, combined: false })
    // A combined game with only a Solo time is still a match.
    expect(
      hltbTimesOf({ game_id: 3, game_name: 'z', comp_all: 3600, comp_lvl_combine: 1 })
    ).toEqual({ solo: 1, combined: true })
  })

  it("searches with the words HLTB's names have: no wrapping dashes, '+' splits", () => {
    // The Steam title of HLTB's "Kingdom Hearts HD 1.5 + 2.5 ReMIX" (#42802): searched as given, HLTB found nothing.
    expect(hltbSearchTerms('KINGDOM HEARTS -HD 1.5+2.5 ReMIX-')).toEqual([
      'KINGDOM',
      'HEARTS',
      'HD',
      '1.5',
      '2.5',
      'ReMIX'
    ])
    expect(hltbSearchTerms('Half-Life 2')).toEqual(['Half-Life', '2'])
  })

  it('finds the game of a store "Game + Add-on" title, never a number joined by +', () => {
    expect(bundleBase('KINGDOM HEARTS III + Re Mind (DLC)')).toBe('KINGDOM HEARTS III')
    expect(bundleBase('KINGDOM HEARTS III + Re Mind')).toBe('KINGDOM HEARTS III')
    expect(bundleBase('Kingdom Hearts HD 1.5 + 2.5 ReMIX')).toBeUndefined()
    expect(bundleBase('KINGDOM HEARTS -HD 1.5+2.5 ReMIX-')).toBeUndefined()
    expect(bundleBase('Portal 2')).toBeUndefined()
    // Searched in full first (HLTB lists some bundles as one entry), then the game's own name.
    expect(searchVariants('KINGDOM HEARTS III + Re Mind (DLC)')).toEqual([
      'KINGDOM HEARTS III + Re Mind (DLC)',
      'KINGDOM HEARTS III'
    ])
  })

  it('never takes a DLC entry for a "Game + Add-on" title', () => {
    const results = [
      {
        ...PORTAL_2,
        game_id: 74017,
        game_name: 'Kingdom Hearts III Re:Mind',
        game_type: 'dlc',
        release_world: 2020
      },
      {
        ...PORTAL_2,
        game_id: 13157,
        game_name: 'Kingdom Hearts III',
        game_type: 'game',
        release_world: 2019
      }
    ]
    expect(pickBestHltbMatch('KINGDOM HEARTS III + Re Mind', 2020, results)?.result.game_id).toBe(
      74017
    )
    // Without DLC entries, the game itself is the closest name.
    expect(
      pickBestHltbMatch('KINGDOM HEARTS III + Re Mind', 2020, results, { noDlc: true })?.result
        .game_id
    ).toBe(13157)
    expect(
      pickBestHltbMatch('KINGDOM HEARTS III', 2020, results, { noDlc: true })?.result.game_id
    ).toBe(13157)
  })

  it('builds search terms and progressively broader variants', () => {
    expect(hltbSearchTerms('The Witcher® 3: Wild Hunt – Game of the Year Edition')).toEqual([
      'The',
      'Witcher',
      '3',
      'Wild',
      'Hunt',
      'Game',
      'of',
      'the',
      'Year',
      'Edition'
    ])
    expect(hltbSearchTerms('Spider-Man: Miles Morales')).toEqual(['Spider-Man', 'Miles', 'Morales'])
    expect(searchVariants('The Witcher 3: Wild Hunt - Game of the Year Edition')).toEqual([
      'The Witcher 3: Wild Hunt - Game of the Year Edition',
      'The Witcher 3: Wild Hunt',
      'The Witcher 3'
    ])
    expect(searchVariants('Portal 2')).toEqual(['Portal 2'])
    // A short series label first: HLTB lists the game by its name alone (howlongtobeat.com/game/3722).
    expect(searchVariants('007: From Russia with Love')).toEqual([
      '007: From Russia with Love',
      'From Russia with Love'
    ])
    expect(searchVariants('007 - From Russia with Love')).toEqual([
      '007 - From Russia with Love',
      'From Russia with Love'
    ])
    expect(searchVariants('Halo: Reach')).toEqual(['Halo: Reach', 'Reach'])
    // ...and the match is still judged against the whole title: a game named only "Reach" is not Halo: Reach.
    expect(
      pickBestHltbMatch('Halo: Reach', 2010, [
        { game_id: 1, game_name: 'Reach', game_type: 'game', comp_main: 3600, release_world: 2010 }
      ])
    ).toBeNull()
    expect(
      pickBestHltbMatch('007: From Russia with Love', 2005, [
        {
          game_id: 3722,
          game_name: 'From Russia with Love',
          game_alias: 'Desde Rusia con Amor, 007: Russia Yori Ai Okomete',
          game_type: 'game',
          comp_main: 22897,
          comp_plus: 29049,
          comp_100: 37361,
          release_world: 2005
        }
      ])?.result.game_id
    ).toBe(3722)
    expect(searchVariants('DOOM Eternal (Deluxe Edition)')).toEqual([
      'DOOM Eternal (Deluxe Edition)',
      'DOOM Eternal'
    ])
  })
})

describe('same name, another year or console', () => {
  // HLTB names a later game of an older one's name with its year.
  const entry = (
    id: number,
    name: string,
    year: number,
    platforms: string,
    main: number
  ): HltbSearchResult => ({
    game_id: id,
    game_name: name,
    game_type: 'game',
    comp_main: main,
    release_world: year,
    profile_platform: platforms
  })
  const SSX_2000 = entry(8981, 'SSX', 2000, 'PlayStation 2', 18000)
  const SSX_2012 = entry(8982, 'SSX (2012)', 2012, 'PlayStation 3, Xbox 360', 28800)
  const SSX_3 = entry(8983, 'SSX 3', 2003, 'PlayStation 2, Xbox, Nintendo GameCube', 36000)
  const SSX = [SSX_2000, SSX_2012, SSX_3]
  const ZELDA = [
    entry(10035, "The Legend of Zelda: Link's Awakening", 1993, 'Game Boy', 50400),
    entry(10036, "The Legend of Zelda: Link's Awakening DX", 1998, 'Game Boy Color', 54000),
    entry(68235, "The Legend of Zelda: Link's Awakening (2019)", 2019, 'Nintendo Switch', 52200)
  ]
  const ROM = "The Legend of Zelda Link's Awakening"

  it('reads the year in an entry’s name as its year, not as part of the name', () => {
    expect(pickBestHltbMatch('SSX', 2012, SSX)?.result.game_id).toBe(8982)
    expect(pickBestHltbMatch('SSX', 2000, SSX)?.result.game_id).toBe(8981)
    // The name's year is the entry's when HLTB gives no other.
    const undated = { ...SSX_2012, release_world: 0 }
    expect(pickBestHltbMatch('SSX', 2012, [SSX_2000, undated])?.result.game_id).toBe(8982)
    // Alone it is a match too (it was none: "SSX (2012)" is far from "SSX" as it stands).
    expect(pickBestHltbMatch('SSX', 2012, [SSX_2012, SSX_3])?.result.game_id).toBe(8982)
    expect(pickBestHltbMatch(ROM, 2019, ZELDA)?.result.game_id).toBe(68235)
    expect(pickBestHltbMatch(ROM, 1993, ZELDA)?.result.game_id).toBe(10035)
  })

  it('without a year keeps the entry named without one, unless the console says otherwise', () => {
    expect(pickBestHltbMatch('SSX', undefined, SSX)?.result.game_id).toBe(8981)
    const ps3 = hltbConsolesFor('ps3', 'Sony PlayStation 3')
    const ps2 = hltbConsolesFor('ps2', 'Sony PlayStation 2')
    expect(pickBestHltbMatch('SSX', undefined, SSX, { consoles: ps3 })?.result.game_id).toBe(8982)
    expect(pickBestHltbMatch('SSX', undefined, SSX, { consoles: ps2 })?.result.game_id).toBe(8981)
    expect(
      pickBestHltbMatch('SSX', undefined, SSX, {
        consoles: hltbConsolesFor('xbox360', 'Microsoft Xbox 360')
      })?.result.game_id
    ).toBe(8982)
    const nsw = hltbConsolesFor('switch', 'Nintendo Switch')
    const gb = hltbConsolesFor('gb', 'Nintendo Game Boy')
    expect(pickBestHltbMatch(ROM, undefined, ZELDA, { consoles: nsw })?.result.game_id).toBe(68235)
    expect(pickBestHltbMatch(ROM, undefined, ZELDA, { consoles: gb })?.result.game_id).toBe(10035)
  })

  it('never needs the console: an entry HLTB lists elsewhere, or nowhere, still matches', () => {
    const ps3 = hltbConsolesFor('ps3', 'Sony PlayStation 3')
    expect(pickBestHltbMatch('SSX', 2000, [SSX_2000], { consoles: ps3 })?.result.game_id).toBe(8981)
    const unlisted = { ...SSX_2012, profile_platform: undefined }
    expect(pickBestHltbMatch('SSX', 2012, [unlisted], { consoles: ps3 })?.result.game_id).toBe(8982)
    // The year outweighs the console (a PlayStation 2 classic sold on the PlayStation 3).
    expect(pickBestHltbMatch('SSX', 2000, SSX, { consoles: ps3 })?.result.game_id).toBe(8981)
  })

  it('knows HLTB’s own names of consoles', () => {
    expect(hltbConsolesFor('psx', 'Sony PlayStation 1')).toContain('PlayStation')
    expect(hltbConsolesFor('snes', 'Nintendo SNES (Super Nintendo)')).toContain('Super Nintendo')
    expect(hltbConsolesFor('pc')).toEqual([])
    // "PlayStation" (the first one) is not the PlayStation 3.
    const ps1 = { ...SSX_2000, profile_platform: 'PlayStation' }
    const ps3 = hltbConsolesFor('ps3', 'Sony PlayStation 3')
    expect(pickBestHltbMatch('SSX', undefined, [ps1], { consoles: ps3 })?.score).toBe(1)
  })

  it('tells which recorded lookups the year in a name could have got wrong', () => {
    expect(yearTagHidden('SSX', 2012)).toBe(true)
    expect(yearTagHidden('SSX', 2012, true)).toBe(true)
    // A long title was close enough to its entry with a year: matched then as now.
    expect(yearTagHidden(ROM, 2019)).toBe(false)
    expect(yearTagHidden(ROM, 2019, true)).toBe(false)
    expect(yearTagHidden('', 2012)).toBe(false)
  })
})

describe('wire format', () => {
  it('sends the payload the site front end sends', () => {
    const payload = buildSearchPayload(['portal', '2'])
    expect(payload).toMatchObject({
      searchType: 'games',
      searchTerms: ['portal', '2'],
      searchPage: 1,
      size: 20,
      searchOptions: {
        games: {
          userId: 0,
          platform: '',
          sortCategory: 'popular',
          rangeCategory: 'main',
          rangeTime: { min: null, max: null },
          gameplay: { perspective: '', flow: '', genre: '' },
          year: '',
          modifier: ''
        },
        users: { sortCategory: 'postcount' },
        lists: { sortCategory: 'follows' },
        filter: '',
        sort: 0,
        randomizer: 0
      },
      useCache: true
    })
  })

  it('finds the search route in the site chunk', () => {
    // Verbatim from howlongtobeat.com's chunk 1ip4u_c7v73bt.js (2026-10-29).
    const chunk =
      'useCache:!(c?.user_id>0)},r=await fetch("/api/search/site",{method:"POST",headers:{"Content-Type":"application/json","x-auth-token":t},body:JSON.stringify(a)})'
    expect(extractSearchPath(chunk)).toBe('/api/search/site')
    expect(
      extractSearchPath(
        'fetch("/api/user",{method:"POST",headers:{"Content-Type":"application/json"}})'
      )
    ).toBeNull()
  })
})

describe('hltbLookup', () => {
  it('mints a session, searches with the token and honeypot, and caches the answer', async () => {
    const calls = stubFetch((call) => {
      if (call.url.includes('/api/search/site/init'))
        return json(200, { token: 'tok-1', hpKey: 'hp_k', hpVal: 'hp_v' })
      if (call.url === 'https://howlongtobeat.com/api/search/site') {
        expect(call.headers.get('x-auth-token')).toBe('tok-1')
        expect(call.headers.get('x-hp-key')).toBe('hp_k')
        expect(call.headers.get('x-hp-val')).toBe('hp_v')
        expect(call.headers.get('user-agent')).toMatch(/^Mozilla\/5\.0/)
        expect(call.headers.get('origin')).toBe('https://howlongtobeat.com')
        expect(call.headers.get('referer')).toBe('https://howlongtobeat.com/')
        expect((call.body as Record<string, unknown>).hp_k).toBe('hp_v')
        expect((call.body as Record<string, unknown>).searchTerms).toEqual(['Portal', '2'])
        return json(200, {
          category: 'games',
          count: 4,
          pageCurrent: 1,
          data: [PORTAL, PORTAL_2, PORTAL_DLC, PORTAL_MEL]
        })
      }
      return new Response('nope', { status: 404 })
    })
    expect(await hltbLookup('Portal 2', 2011)).toEqual({
      main: 8.6,
      extra: 13.8,
      completionist: 23,
      combined: false
    })
    expect(calls).toHaveLength(2)
    expect(await hltbLookup('Portal 2', 2011)).toEqual({
      main: 8.6,
      extra: 13.8,
      completionist: 23,
      combined: false
    })
    expect(calls).toHaveLength(2)
  })

  it('searches the game of "Game + Add-on" only when the part after + is an add-on', async () => {
    const game = (id: number, name: string, type: string, year: number): HltbSearchResult => ({
      ...PORTAL_2,
      game_id: id,
      game_name: name,
      game_type: type,
      release_world: year
    })
    const searched: string[][] = []
    stubFetch((call) => {
      if (call.url.includes('/init')) return json(200, { token: 'tok' })
      const terms = (call.body as { searchTerms: string[] }).searchTerms
      searched.push(terms)
      const text = terms.join(' ')
      if (text === 'KINGDOM HEARTS III + Re Mind'.replace(' +', ''))
        return json(200, { data: [game(74017, 'Kingdom Hearts III Re:Mind', 'dlc', 2020)] })
      if (text === 'KINGDOM HEARTS III')
        return json(200, {
          data: [
            game(13157, 'Kingdom Hearts III', 'game', 2019),
            game(74017, 'Kingdom Hearts III Re:Mind', 'dlc', 2020)
          ]
        })
      if (text === 'Bayonetta Vanquish')
        return json(200, {
          data: [game(72802, 'Bayonetta & Vanquish 10th Anniversary Bundle', 'compil', 2020)]
        })
      if (text === 'Bayonetta') return json(200, { data: [game(966, 'Bayonetta', 'game', 2009)] })
      return json(200, { data: [] })
    })
    // HLTB lists the add-on as a DLC entry: the game itself is looked up and matched.
    expect((await hltbLookup('KINGDOM HEARTS III + Re Mind', 2020))?.main).toBe(8.6)
    expect(searched.map((t) => t.join(' '))).toEqual([
      'KINGDOM HEARTS III Re Mind',
      'KINGDOM HEARTS III'
    ])
    // Two games: never only the first one's times.
    expect(await hltbLookup('Bayonetta + Vanquish', 2020)).toBeNull()
    expect(searched.map((t) => t.join(' '))).not.toContain('Bayonetta')
  })

  it('renews a rejected session once and reuses it afterwards', async () => {
    let minted = 0
    const calls = stubFetch((call) => {
      if (call.url.includes('/init')) return json(200, { token: `tok-${++minted}` })
      if (call.headers.get('x-auth-token') === 'tok-1') return json(403, { error: 'expired' })
      return json(200, { data: [PORTAL, PORTAL_2] })
    })
    expect(await hltbLookup('Portal', 2007)).toEqual({
      main: 3,
      extra: 4,
      completionist: 10,
      combined: false
    })
    expect(minted).toBe(2)
    expect(await hltbLookup('Portal 2')).toEqual({
      main: 8.6,
      extra: 13.8,
      completionist: 23,
      combined: false
    })
    expect(minted).toBe(2)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(3)
  })

  it('broadens the search when the exact title finds nothing', async () => {
    const searches: string[][] = []
    stubFetch((call) => {
      if (call.url.includes('/init')) return json(200, { token: 't' })
      const terms = (call.body as { searchTerms: string[] }).searchTerms
      searches.push(terms)
      return json(200, { data: terms.length > 3 ? [] : [WITCHER] })
    })
    expect(await hltbLookup("The Witcher: Enhanced Edition Director's Cut", 2008)).toEqual({
      main: 36,
      combined: false
    })
    expect(searches).toEqual([
      ['The', 'Witcher', 'Enhanced', 'Edition', "Director's", 'Cut'],
      ['The', 'Witcher', "Director's", 'Cut'],
      ['The', 'Witcher']
    ])
  })

  it('never throws: failures, bad JSON and empty titles yield null', async () => {
    stubFetch(() => new Response('<html>blocked</html>', { status: 503 }))
    expect(await hltbLookup('Portal 2', 2011)).toBeNull()
    stubFetch((call) => (call.url.includes('/init') ? json(200, {}) : json(200, { data: [] })))
    expect(await hltbLookup('Portal 2', 2011)).toBeNull()
    expect(await hltbLookup('   ')).toBeNull()
    stubFetch((call) =>
      call.url.includes('/init') ? json(200, { token: 't' }) : json(200, { data: [NO_TIMES] })
    )
    expect(await hltbLookup('Half-Life 3', 2030)).toBeNull()
  })

  it('pauses lookups after repeated failures', async () => {
    const calls = stubFetch(() => new Response('down', { status: 500 }))
    for (let i = 0; i < 3; i++) expect(await hltbLookup(`Game ${i}`)).toBeNull()
    const before = calls.length
    expect(await hltbLookup('Another Game')).toBeNull()
    expect(calls.length).toBe(before)
  })

  it('re-discovers the search route from the site scripts after a 404', async () => {
    const calls = stubFetch((call) => {
      if (
        call.url === 'https://howlongtobeat.com/api/search/site/init' ||
        call.url.startsWith('https://howlongtobeat.com/api/search/site/init?')
      )
        return json(200, { token: 'old' })
      if (call.url === 'https://howlongtobeat.com/api/search/site')
        return new Response('gone', { status: 404 })
      if (call.url === 'https://howlongtobeat.com/')
        return new Response(
          '<script src="/_next/static/chunks/a.js" defer=""></script><script src="/_next/static/chunks/b.js" defer=""></script>',
          { status: 200 }
        )
      if (call.url === 'https://howlongtobeat.com/_next/static/chunks/a.js')
        return new Response('console.log(1)', { status: 200 })
      if (call.url === 'https://howlongtobeat.com/_next/static/chunks/b.js')
        return new Response(
          'r=await fetch("/api/find/games",{method:"POST",headers:{"Content-Type":"application/json","x-auth-token":t},body:JSON.stringify(a)})',
          { status: 200 }
        )
      if (call.url.startsWith('https://howlongtobeat.com/api/find/games/init'))
        return json(200, { token: 'new' })
      if (call.url === 'https://howlongtobeat.com/api/find/games') {
        expect(call.headers.get('x-auth-token')).toBe('new')
        return json(200, { data: [PORTAL_2] })
      }
      return new Response('unexpected ' + call.url, { status: 500 })
    })
    expect(await hltbLookup('Portal 2', 2011)).toEqual({
      main: 8.6,
      extra: 13.8,
      completionist: 23,
      combined: false
    })
    expect(calls.map((c) => c.url.replace(/\?t=\d+$/, ''))).toEqual([
      'https://howlongtobeat.com/api/search/site/init',
      'https://howlongtobeat.com/api/search/site',
      'https://howlongtobeat.com/',
      'https://howlongtobeat.com/_next/static/chunks/a.js',
      'https://howlongtobeat.com/_next/static/chunks/b.js',
      'https://howlongtobeat.com/api/find/games/init',
      'https://howlongtobeat.com/api/find/games'
    ])
  })
})
