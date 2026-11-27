import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { defaultSettings } from '../../shared/defaults'
import type { Game, Settings } from '../../shared/types'
import { hashFile } from '../util/hash'
import { HttpError, RateLimiter } from './http'
import { createImageCache } from './image-cache'
import { createScreenScraperScraper, mapScreenScraperGame, pickByRegion } from './screenscraper'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const API = 'https://api.screenscraper.fr/api2'
const MEDIA = `${API}/mediaJeu.php?devid=dev&devpassword=pw&softname=PlayOut-1.0&systemeid=1&jeuid=3&media=`

/** jeuInfos.php JSON shape from docs/research/metadata-apis.md section 3.4. */
function jeuFixture(rommd5: string): Record<string, unknown> {
  return {
    id: '3',
    romid: '11',
    notgame: 'false',
    noms: [
      { region: 'ss', text: 'Sonic The Hedgehog 2' },
      { region: 'us', text: 'Sonic the Hedgehog 2 (US name)' },
      { region: 'eu', text: 'Sonic the Hedgehog 2 (EU name)' },
      { region: 'jp', text: 'Sonic the Hedgehog 2 (JP name)' },
      { region: 'wor', text: 'Sonic the Hedgehog 2' }
    ],
    cloneof: '0',
    systeme: { id: '1', text: 'Megadrive' },
    editeur: { id: '4', text: 'SEGA' },
    developpeur: { id: '5', text: 'Sonic Team' },
    joueurs: { text: '1-2' },
    note: { text: '17' },
    synopsis: [
      { langue: 'fr', text: 'Sonic revient.' },
      { langue: 'en', text: 'Sonic is back.' }
    ],
    classifications: [
      { type: 'ESRB', text: 'E' },
      { type: 'PEGI', text: '3' }
    ],
    dates: [
      { region: 'wor', text: '1992-11-24' },
      { region: 'us', text: '1992-11-21' },
      { region: 'eu', text: '1992-11-24' },
      { region: 'jp', text: '1992' }
    ],
    genres: [
      {
        id: '7',
        principale: '1',
        parentid: '0',
        noms: [
          { langue: 'en', text: 'Platform' },
          { langue: 'fr', text: 'Plateforme' }
        ]
      },
      { id: '8', principale: '0', parentid: '0', noms: [{ langue: 'fr', text: 'Action' }] }
    ],
    medias: [
      { type: 'box-2D', parent: 'jeu', url: `${MEDIA}box-2D(us)`, region: 'us', format: 'png' },
      { type: 'box-2D', parent: 'jeu', url: `${MEDIA}box-2D(eu)`, region: 'eu', format: 'png' },
      {
        type: 'box-2D-back',
        parent: 'jeu',
        url: `${MEDIA}box-2D-back(us)`,
        region: 'us',
        format: 'png'
      },
      { type: 'wheel', parent: 'jeu', url: `${MEDIA}wheel(wor)`, region: 'wor', format: 'png' },
      {
        type: 'wheel-hd',
        parent: 'jeu',
        url: `${MEDIA}wheel-hd(wor)`,
        region: 'wor',
        format: 'png'
      },
      { type: 'fanart', parent: 'jeu', url: `${MEDIA}fanart`, format: 'jpg' },
      { type: 'mixrbv2', parent: 'jeu', url: `${MEDIA}mixrbv2(wor)`, region: 'wor', format: 'png' },
      { type: 'ss', parent: 'jeu', url: `${MEDIA}ss(wor)`, region: 'wor', format: 'png' },
      { type: 'sstitle', parent: 'jeu', url: `${MEDIA}sstitle(wor)`, region: 'wor', format: 'png' },
      { type: 'video', parent: 'jeu', url: `${MEDIA}video`, format: 'mp4' }
    ],
    rom: { id: '11', romfilename: 'Sonic The Hedgehog 2 (World).md', rommd5, romsize: '1048576' }
  }
}

const SSUSER = {
  id: 'jeremy',
  niveau: '1',
  maxthreads: '1',
  requeststoday: '12',
  maxrequestsperday: '10000'
}

function envelope(response: Record<string, unknown>): Record<string, unknown> {
  return {
    header: { APIversion: '2', success: 'true' },
    response: { serveurs: {}, ssuser: SSUSER, ...response }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } })
}

interface Call {
  url: URL
  params: URLSearchParams
}

type Handler = (call: Call) => Response

function stubApi(
  routes: Partial<Record<'jeuInfos.php' | 'jeuRecherche.php', Handler | Handler[]>>
): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input)
      const call = { url, params: url.searchParams }
      calls.push(call)
      const route = routes[url.pathname.split('/').pop() as 'jeuInfos.php']
      if (!route) return text('Erreur : Rom/Jeu non trouvée !', 404)
      const handler = Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]) : route
      return handler(call)
    })
  )
  return calls
}

function settings(overrides: Partial<Settings['scrapers']> = {}): Settings {
  const s = defaultSettings()
  s.scrapers.screenscraper = { devId: 'dev', devPassword: 'pw', user: 'jeremy', password: 'secret' }
  Object.assign(s.scrapers, overrides)
  return s
}

let dir: string
let romPath: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-ss-'))
  romPath = join(dir, 'Sonic The Hedgehog 2 (World).md')
  await fs.writeFile(romPath, Buffer.alloc(4096, 0x53))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(dir, { recursive: true, force: true })
})

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 'rom:megadrive:abc',
    source: 'rom',
    externalId: 'Sonic The Hedgehog 2 (World).md',
    platformId: 'megadrive',
    title: 'Sonic The Hedgehog 2 (World)',
    sortTitle: 'sonic the hedgehog 2',
    installed: true,
    romPath,
    launch: { kind: 'emulator', systemId: 'megadrive', romPath },
    tracking: { mode: 'spawned' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {},
    ...overrides
  }
}

function newScraper(): ReturnType<typeof createScreenScraperScraper> {
  return createScreenScraperScraper({ limiter: new RateLimiter(10_000, 100) })
}

describe('screenScraperScraper', () => {
  it('needs developer credentials; the user account is optional', () => {
    const scraper = newScraper()
    expect(scraper.id).toBe('screenscraper')
    const s = settings()
    s.scrapers.screenscraper.user = ''
    s.scrapers.screenscraper.password = ''
    expect(scraper.isConfigured(s)).toBe(true)
    s.scrapers.screenscraper.devPassword = ''
    expect(scraper.isConfigured(s)).toBe(false)
  })

  it('identifies a ROM by crc/md5/sha1 + size and caches the record for fetch', async () => {
    const hashes = (await hashFile(romPath))!
    const calls = stubApi({ 'jeuInfos.php': () => json(envelope({ jeu: jeuFixture(hashes.md5) })) })
    const scraper = newScraper()
    const candidates = await scraper.search(game(), settings())
    expect(calls).toHaveLength(1)
    const p = calls[0].params
    expect(calls[0].url.pathname).toBe('/api2/jeuInfos.php')
    expect(p.get('devid')).toBe('dev')
    expect(p.get('devpassword')).toBe('pw')
    expect(p.get('softname')).toBe('PlayOut-1.0')
    expect(p.get('output')).toBe('json')
    expect(p.get('ssid')).toBe('jeremy')
    expect(p.get('sspassword')).toBe('secret')
    expect(p.get('systemeid')).toBe('1')
    expect(p.get('romtype')).toBe('rom')
    expect(p.get('romnom')).toBe('Sonic The Hedgehog 2 (World).md')
    expect(p.get('romtaille')).toBe('4096')
    expect(p.get('crc')).toBe(hashes.crc32)
    expect(p.get('md5')).toBe(hashes.md5)
    expect(p.get('sha1')).toBe(hashes.sha1)
    expect(hashes.md5).toMatch(/^[0-9a-f]{32}$/)
    expect(hashes.sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(hashes.crc32).toMatch(/^[0-9a-f]{8}$/)
    expect(candidates).toEqual([
      {
        scraper: 'screenscraper',
        byId: true,
        externalId: '3',
        title: 'Sonic the Hedgehog 2 (US name)',
        releaseDate: '1992-11-21',
        platform: 'Megadrive',
        platformIds: [1],
        cover: `${MEDIA}box-2D(us)&ssid=jeremy&sspassword=secret`
      }
    ])

    const result = await scraper.fetch(game(), candidates[0], settings())
    expect(calls).toHaveLength(1)
    expect(result.title).toBe('Sonic the Hedgehog 2 (US name)')
    expect(result.metadata).toEqual({
      sources: { screenscraper: '3' },
      description: 'Sonic is back.',
      releaseDate: '1992-11-21',
      developers: ['Sonic Team'],
      publishers: ['SEGA'],
      genres: ['Platform', 'Action'],
      rating: 85,
      players: '1-2',
      tags: ['ESRB E', 'PEGI 3']
    })
    expect(result.media).toEqual({
      cover: `${MEDIA}box-2D(us)&ssid=jeremy&sspassword=secret`,
      hero: `${MEDIA}fanart&ssid=jeremy&sspassword=secret`,
      logo: `${MEDIA}wheel-hd(wor)&ssid=jeremy&sspassword=secret`,
      screenshots: [
        `${MEDIA}ss(wor)&ssid=jeremy&sspassword=secret`,
        `${MEDIA}sstitle(wor)&ssid=jeremy&sspassword=secret`
      ]
    })
  })

  it('honours the region preference for names, dates and media', async () => {
    const hashes = (await hashFile(romPath))!
    stubApi({ 'jeuInfos.php': () => json(envelope({ jeu: jeuFixture(hashes.md5) })) })
    const scraper = newScraper()
    const eu = settings({ region: 'eu' })
    eu.scrapers.screenscraper.user = ''
    eu.scrapers.screenscraper.password = ''
    const [candidate] = await scraper.search(game(), eu)
    expect(candidate.title).toBe('Sonic the Hedgehog 2 (EU name)')
    expect(candidate.releaseDate).toBe('1992-11-24')
    expect(candidate.cover).toBe(`${MEDIA}box-2D(eu)`)
    const result = await scraper.fetch(game(), candidate, eu)
    expect(result.media.cover).toBe(`${MEDIA}box-2D(eu)`)
    expect(result.media.hero).toBe(`${MEDIA}fanart`)
  })

  it('falls back to a name search when the hash is unknown, dropping the empty placeholder entry', async () => {
    const calls = stubApi({
      'jeuInfos.php': () => text('Erreur : Rom/Jeu non trouvée !', 404),
      'jeuRecherche.php': () =>
        json(envelope({ jeux: [jeuFixture('ffffffffffffffffffffffffffffffff'), {}] }))
    })
    const candidates = await newScraper().search(game(), settings())
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/api2/jeuInfos.php',
      '/api2/jeuRecherche.php'
    ])
    expect(calls[1].params.get('recherche')).toBe('Sonic The Hedgehog 2')
    expect(calls[1].params.get('systemeid')).toBe('1')
    expect(calls[1].params.has('crc')).toBe(false)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].externalId).toBe('3')
  })

  it('searches by name directly for playlists, directories and explicit queries', async () => {
    const m3u = join(dir, 'Final Fantasy VII.m3u')
    await fs.writeFile(m3u, 'disc1.chd\n')
    const calls = stubApi({ 'jeuRecherche.php': () => json(envelope({ jeux: [] })) })
    const scraper = newScraper()
    await scraper.search(
      game({ romPath: m3u, title: 'Final Fantasy VII (USA)', platformId: 'psx' }),
      settings()
    )
    await scraper.search(
      game({ romPath: dir, title: 'Shadow of the Colossus', platformId: 'ps3' }),
      settings()
    )
    await scraper.search(game(), settings(), 'sonic 3')
    expect(calls.map((c) => c.url.pathname)).toEqual(Array(3).fill('/api2/jeuRecherche.php'))
    expect(calls[0].params.get('recherche')).toBe('Final Fantasy VII')
    expect(calls[0].params.get('systemeid')).toBe('57')
    expect(calls[1].params.get('recherche')).toBe('Shadow of the Colossus')
    expect(calls[2].params.get('recherche')).toBe('sonic 3')
  })

  it('returns no candidates for a name search that finds nothing', async () => {
    stubApi({})
    expect(await newScraper().search(game(), settings(), 'nothing here')).toEqual([])
  })

  it('fetches by game id when the record is not cached', async () => {
    const calls = stubApi({ 'jeuInfos.php': () => json(envelope({ jeu: jeuFixture('00') })) })
    const result = await newScraper().fetch(
      game(),
      { scraper: 'screenscraper', externalId: '3', title: 'Sonic 2' },
      settings()
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].params.get('gameid')).toBe('3')
    expect(calls[0].params.get('systemeid')).toBe('1')
    expect(calls[0].params.has('md5')).toBe(false)
    expect(result.metadata.publishers).toEqual(['SEGA'])
  })

  it('maps login and quota errors to messages without leaking credentials', async () => {
    stubApi({
      'jeuInfos.php': () => text('Erreur de login : Verifier vos identifiants developpeur !', 403)
    })
    const err = await newScraper()
      .search(game(), settings())
      .catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).message).toBe('ScreenScraper: invalid developer credentials')
    expect((err as HttpError).url).not.toContain('pw')
    expect((err as HttpError).url).not.toContain('secret')
    expect((err as HttpError).url).toContain('devpassword=***')

    vi.unstubAllGlobals()
    stubApi({ 'jeuInfos.php': () => text('Quota depasse', 430) })
    await expect(newScraper().search(game(), settings())).rejects.toThrow(
      'ScreenScraper: daily request quota exceeded'
    )

    vi.unstubAllGlobals()
    stubApi({
      'jeuInfos.php': () =>
        json(envelope({ ssuser: { ...SSUSER, niveau: '0' }, jeu: jeuFixture('00') }))
    })
    await expect(newScraper().search(game(), settings())).rejects.toThrow(
      'ScreenScraper: invalid user name or password'
    )

    vi.unstubAllGlobals()
    stubApi({ 'jeuInfos.php': () => text('API fermee', 423) })
    await expect(newScraper().search(game(), settings())).rejects.toThrow(
      'ScreenScraper: API closed for maintenance'
    )
  })

  it('downloads media through the same thread gate as the API calls', async () => {
    // mediaJeu.php counts against the account's thread limit (metadata-apis.md 3.6: 429 "thread limits reached"),
    // so a media download must wait while a jeuInfos call holds the only slot of a non-contributor account.
    const paths: string[] = []
    let releaseInfo!: (res: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => {
        const url = new URL(input)
        paths.push(url.pathname)
        if (url.pathname.endsWith('jeuInfos.php'))
          return new Promise<Response>((resolve) => (releaseInfo = resolve))
        return Promise.resolve(
          new Response(Buffer.alloc(256, 1), {
            status: 200,
            headers: { 'content-type': 'image/png' }
          })
        )
      })
    )
    const scraper = newScraper()
    expect(scraper.mediaPolicy?.gate).toBeDefined()
    const info = scraper.fetch(
      game(),
      { scraper: 'screenscraper', externalId: '3', title: 'Sonic 2' },
      settings()
    )
    await sleep(10)
    expect(paths).toEqual(['/api2/jeuInfos.php'])

    const cache = createImageCache({ dir: join(dir, 'media'), log })
    const download = cache.importRemote(
      'rom:megadrive:abc',
      'cover',
      `${MEDIA}box-2D(us)&ssid=jeremy&sspassword=secret`,
      undefined,
      scraper.mediaPolicy
    )
    await sleep(30)
    expect(paths).toEqual(['/api2/jeuInfos.php'])
    releaseInfo(json(envelope({ jeu: jeuFixture('00') })))
    expect((await info).metadata.publishers).toEqual(['SEGA'])
    expect(await download).toMatch(/^media:\/\/cache\/rom_megadrive_abc\/cover\.png\?v=\d+$/)
    expect(paths).toEqual(['/api2/jeuInfos.php', '/api2/mediaJeu.php'])
  })

  it('refuses to run without developer credentials', async () => {
    const calls = stubApi({})
    const s = settings()
    s.scrapers.screenscraper.devId = ''
    await expect(newScraper().search(game(), s)).rejects.toThrow(
      'ScreenScraper: developer credentials not configured'
    )
    expect(calls).toHaveLength(0)
  })
})

describe('mapScreenScraperGame / pickByRegion', () => {
  it('walks the region chain and falls back to region-less and first entries', () => {
    const items = [{ region: 'jp', text: 'jp' }, { region: 'eu', text: 'eu' }, { text: 'none' }]
    expect(pickByRegion(items, ['us', 'wor', 'eu'])?.text).toBe('eu')
    expect(pickByRegion(items, ['us'])?.text).toBe('none')
    expect(pickByRegion([{ region: 'jp', text: 'jp' }], ['us'])?.text).toBe('jp')
    expect(pickByRegion([], ['us'])).toBeUndefined()
  })

  it('maps sparse records, numeric ratings and odd dates defensively', () => {
    const result = mapScreenScraperGame(
      {
        id: 9,
        noms: [{ region: 'wor', text: 'Game' }],
        note: { text: '20' },
        dates: [{ region: 'wor', text: 'about 1998' }]
      },
      { region: 'us', language: 'en' }
    )
    expect(result.title).toBe('Game')
    expect(result.metadata).toEqual({
      sources: { screenscraper: '9' },
      rating: 100,
      releaseDate: '1998'
    })
    expect(result.media).toEqual({})
    expect(
      mapScreenScraperGame({ id: 1, note: { text: '0' } }, { region: 'us', language: 'en' })
        .metadata.rating
    ).toBeUndefined()
  })
})
