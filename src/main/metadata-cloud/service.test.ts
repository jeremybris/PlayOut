// The metadata cloud service against a fake fetch (no network), a temp folder and a fake safeStorage.
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MetadataCloudNotice, MetadataCloudStatus } from '../../shared/metadata-cloud'
import type { MetadataEdit, MetadataEditField } from '../../shared/metadata-edit'
import type { Game } from '../../shared/types'
import type { TokenCrypto } from '../accounts/token-store'
import type { Logger } from '../logger'
import { MetadataCloudOverlay } from '../metadata-edits/cloud-overlay'
import type { MetadataEditChange } from '../services/library-service'
import { fromBase64, toBase64 } from './github'
import { MAX_QUEUED } from './files'
import {
  MetadataCloudService,
  QUEUE_RATE_LIMIT_MARGIN_MS,
  QUEUE_RETRY_MS,
  readTextWithin,
  type CloudLibrary
} from './service'

const TOKEN = 'github_pat_TESTONLY_0123456789'
const ALL_URL = 'https://raw.test/all.json'
const API = 'https://api.github.com/repos/jeremybris/PlayOut-metadata'

const noop = (): void => undefined
const quiet: Logger = { debug: noop, info: noop, warn: noop, error: noop }

/** Reversible fake of safeStorage: "encrypts" by reversing and prefixing. */
const fakeCrypto: TokenCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${[...text].reverse().join('')}`),
  decryptString: (buf) => {
    const s = buf.toString()
    if (!s.startsWith('enc:')) throw new Error('bad blob')
    return [...s.slice(4)].reverse().join('')
  }
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

type Route = (call: Call) => Response | Promise<Response | undefined> | undefined

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

function fakeFetch(routes: Route[], calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) }
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    }
    calls.push(call)
    for (const route of routes) {
      const res = await route(call)
      if (res) return res
    }
    throw new Error(`offline: ${call.method} ${url}`)
  }) as typeof fetch
}

function game(id: string, appId: number, user: Game['user'] = {}): Game {
  return {
    id,
    source: 'steam',
    externalId: String(appId),
    platformId: 'pc',
    title: `Game ${appId}`,
    sortTitle: `game ${appId}`,
    installed: true,
    favorite: false,
    hidden: false,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    user
  } as unknown as Game
}

class FakeLibrary implements CloudLibrary {
  hook: Parameters<CloudLibrary['setMetadataEditedHook']>[0] = null
  cleared: { id: string; fields?: readonly MetadataEditField[] }[] = []
  constructor(public list: Game[]) {}
  games(): Game[] {
    return this.list
  }
  setMetadataEditedHook(hook: Parameters<CloudLibrary['setMetadataEditedHook']>[0]): void {
    this.hook = hook
  }
  clearMetadataEdit(id: string, fields?: readonly MetadataEditField[]): Game {
    this.cleared.push({ id, fields })
    const g = this.list.find((x) => x.id === id)!
    const edits = { ...(g.user.metadataEdits ?? {}) } as Record<string, unknown>
    for (const f of fields ?? []) delete edits[f]
    g.user = { ...g.user, metadataEdits: edits as MetadataEdit }
    return g
  }
  remoteTidied: { key: string; fields: MetadataEdit }[] = []
  tidyRemoteMetadataEdit(key: string, fields: MetadataEdit): void {
    this.remoteTidied.push({ key, fields })
  }
}

let dir: string
let calls: Call[]
let routes: Route[]
let notices: MetadataCloudNotice[]
let statuses: MetadataCloudStatus[]
let overlay: MetadataCloudOverlay
let library: FakeLibrary
let service: MetadataCloudService | null
const START = Date.parse('2026-11-16T12:00:00.000Z')
/** The service's clock (tests move it on). */
let clock = START

function create(): MetadataCloudService {
  service = new MetadataCloudService({
    dir,
    overlay,
    library,
    events: {
      emit: ((event: string, payload: unknown) => {
        if (event === 'metadata-cloud:notice') notices.push(payload as MetadataCloudNotice)
        if (event === 'metadata-cloud:status') statuses.push(payload as MetadataCloudStatus)
      }) as never
    },
    log: quiet,
    appVersion: '0.1.138',
    fetch: fakeFetch(routes, calls),
    crypto: fakeCrypto,
    now: () => clock,
    allJsonUrl: ALL_URL,
    debounceMs: 0
  })
  return service
}

const allJson =
  (games: Record<string, unknown>, extra: Record<string, unknown> = {}, etag = '"v1"'): Route =>
  (c) =>
    c.url === ALL_URL
      ? c.headers['If-None-Match'] === etag
        ? new Response(null, { status: 304 })
        : json({ generatedAt: '2026-11-16T10:00:00Z', games, ...extra }, 200, { ETag: etag })
      : undefined

/** GitHub's token check: the account and write access to the repository. */
const tokenOk: Route = (c) => {
  if (c.url === 'https://api.github.com/user') return json({ login: 'jeremybris' })
  if (c.url === API && c.method === 'GET') return json({ permissions: { push: true } })
  return undefined
}

/** A fake repository: path -> { text, sha } on main; PUTs write it. */
function repo(files: Map<string, { text: string; sha: string }>): Route {
  let n = 0
  return (c) => {
    const m = /\/contents\/([^?]+)(?:\?ref=(.*))?$/.exec(c.url.slice(API.length))
    if (!c.url.startsWith(API) || !m) return undefined
    const path = decodeURIComponent(m[1]!)
    if (c.method === 'GET') {
      const f = files.get(path)
      return f
        ? json({ content: toBase64(f.text), encoding: 'base64', sha: f.sha })
        : json({ message: 'Not Found' }, 404)
    }
    if (c.method === 'PUT') {
      const body = c.body as { content: string; sha?: string }
      const f = files.get(path)
      if (f && body.sha !== f.sha) return json({ message: 'sha mismatch' }, 409)
      files.set(path, { text: fromBase64(body.content), sha: `sha${++n}` })
      return json({ content: {} }, f ? 200 : 201)
    }
    return undefined
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'playout-cloud-'))
  calls = []
  routes = []
  notices = []
  statuses = []
  overlay = new MetadataCloudOverlay()
  library = new FakeLibrary([game('steam:620', 620), game('steam:400', 400)])
  service = null
  clock = START
})

afterEach(async () => {
  vi.useRealTimers()
  await service?.dispose()
  await rm(dir, { recursive: true, force: true })
})

describe('readTextWithin', () => {
  /** A body sent in chunks with no Content-Length; counts the chunks handed out and whether it was cancelled. */
  function chunked(chunks: Uint8Array[]): {
    res: Response
    pulled: () => number
    cancelled: () => boolean
  } {
    let pulled = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulled < chunks.length) controller.enqueue(chunks[pulled++]!)
          else controller.close()
        },
        cancel() {
          cancelled = true
        }
      },
      { highWaterMark: 0 }
    )
    return { res: new Response(body), pulled: () => pulled, cancelled: () => cancelled }
  }
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

  it('reads a body within the limit, a character split across chunks included', async () => {
    const whole = bytes('{"title":"Pokémon – 日本語"}')
    const { res } = chunked([whole.slice(0, 15), whole.slice(15, 16), whole.slice(16)])
    expect(await readTextWithin(res, whole.byteLength)).toBe('{"title":"Pokémon – 日本語"}')
    expect(await readTextWithin(new Response(null), 10)).toBe('')
  })

  it('measures bytes, not UTF-16 units', async () => {
    // 40 characters, 120 bytes: under a limit of 100 by `length`, over it on the wire.
    const text = '€'.repeat(40)
    expect(await readTextWithin(new Response(text), 100)).toBeNull()
    expect(await readTextWithin(new Response(text), 120)).toBe(text)
  })

  it('stops downloading at the limit when no Content-Length announced the size', async () => {
    const { res, pulled, cancelled } = chunked(
      Array.from({ length: 50 }, () => bytes('x'.repeat(10)))
    )
    expect(res.headers.get('content-length')).toBeNull()
    expect(await readTextWithin(res, 25)).toBeNull()
    expect(cancelled()).toBe(true)
    // 3 chunks pass the limit; the other 47 were never asked for.
    expect(pulled()).toBeLessThanOrEqual(4)
  })
})

describe('all.json', () => {
  it('shows the cached cloud at once, then downloads all.json and caches it with its ETag', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'cache.json'),
      JSON.stringify({ version: 1, etag: '"v0"', games: { 'steam-620': { genres: ['Old'] } } })
    )
    routes.push(allJson({ 'steam-620': { genres: ['Puzzle'] }, 'steam-1': { title: 'X' } }))
    const s = create()
    await s.start()
    // the cached entry was applied before the download answered
    expect(calls[0]?.headers['If-None-Match']).toBe('"v0"')
    await s.sync()
    expect(overlay.get('steam-620')).toEqual({ genres: ['Puzzle'] })
    const status = s.status()
    expect(status.cloudGames).toBe(2)
    expect(status.libraryGames).toBe(1)
    expect(status.lastError).toBeNull()
    await s.dispose()
    const cache = JSON.parse(await readFile(join(dir, 'cache.json'), 'utf8')) as {
      etag: string
      games: Record<string, unknown>
    }
    expect(cache.etag).toBe('"v1"')
    expect(Object.keys(cache.games)).toEqual(['steam-620', 'steam-1'])
  })

  it('keeps the cloud on 304 and on failure (offline), and an empty repository is an empty cloud', async () => {
    routes.push(allJson({ 'steam-620': { genres: ['Puzzle'] } }))
    const s = create()
    await s.start()
    await s.sync()
    await s.sync() // 304
    expect(calls.filter((c) => c.url === ALL_URL).at(-1)?.headers['If-None-Match']).toBe('"v1"')
    expect(overlay.get('steam-620')).toEqual({ genres: ['Puzzle'] })
    routes.length = 0 // offline
    const status = await s.sync()
    expect(status.lastError).toMatch(/could not be reached/)
    expect(overlay.get('steam-620')).toEqual({ genres: ['Puzzle'] })
    routes.push((c) => (c.url === ALL_URL ? json({ message: 'nope' }, 404) : undefined))
    expect((await s.sync()).lastError).toBeNull()
    expect(overlay.size).toBe(0)
  })

  it('drops malformed entries and reads the relay the repository announces', async () => {
    routes.push(
      allJson(
        { 'steam-620': { localPlayers: 'four' }, 'steam-400': { localPlayers: 4 } },
        { relayUrl: 'https://relay.test/suggest' }
      )
    )
    const s = create()
    await s.start()
    await s.sync()
    expect(overlay.has('steam-620')).toBe(false)
    expect(overlay.get('steam-400')).toEqual({ localPlayers: 4 })
    expect(s.status().sharedRelayUrl).toBe('https://relay.test')
  })
})

describe('owner token', () => {
  it('stores the token encrypted, checks it and never puts it in a URL', async () => {
    routes.push(allJson({}), tokenOk)
    const s = create()
    await s.start()
    const status = await s.setConfig({ token: TOKEN })
    expect(status.owner).toBe(true)
    expect(status.token).toMatchObject({ state: 'ok', login: 'jeremybris' })
    expect(JSON.stringify(status)).not.toContain(TOKEN)
    for (const c of calls) expect(c.url).not.toContain(TOKEN)
    expect(calls.find((c) => c.url.endsWith('/user'))?.headers.Authorization).toBe(
      `Bearer ${TOKEN}`
    )
    await s.dispose()
    const file = await readFile(join(dir, 'config.json'), 'utf8')
    expect(file).not.toContain(TOKEN)
    expect(file).toContain('encrypted')
  })

  it('reports a refused token and one without write access', async () => {
    routes.push(allJson({}), (c) =>
      c.url.endsWith('/user') ? json({ message: 'Bad credentials' }, 401) : undefined
    )
    const s = create()
    await s.start()
    expect((await s.setConfig({ token: TOKEN })).token.state).toBe('invalid')
    routes.splice(1, 1, (c) => {
      if (c.url.endsWith('/user')) return json({ login: 'someone' })
      if (c.url === API) return json({ permissions: { push: false } })
      return undefined
    })
    const status = await s.checkToken()
    expect(status.token.state).toBe('no-access')
    expect(status.owner).toBe(false)
    expect((await s.setConfig({ token: '' })).token.state).toBe('none')
  })

  it('refuses a relay URL that is not https', async () => {
    routes.push(allJson({}))
    const s = create()
    await s.start()
    await expect(s.setConfig({ relayUrl: 'http://relay.test' })).rejects.toThrow(/https/)
    expect((await s.setConfig({ relayUrl: 'https://relay.test/health/' })).relayUrl).toBe(
      'https://relay.test'
    )
  })
})

describe('owner: publish', () => {
  it('merges the saved fields onto games/<key>.json, shows them at once and tidies the local edit once all.json has it', async () => {
    const files = new Map([
      [
        'games/steam-620.json',
        {
          text: JSON.stringify({
            key: 'steam-620',
            title: 'Portal 2',
            fields: { hltb: { main: 8 } }
          }),
          sha: 'abc'
        }
      ]
    ])
    routes.push(allJson({}), tokenOk, repo(files))
    library.list[0]!.user = { metadataEdits: { genres: ['Puzzle'] } }
    const s = create()
    await s.start()
    await s.setConfig({ token: TOKEN })
    const change: MetadataEditChange = { set: { genres: ['Puzzle'] } }
    await library.hook!(library.list[0]!, 'steam-620', { genres: ['Puzzle'] }, change)
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.url).toBe(`${API}/contents/games/steam-620.json`)
    expect((put.body as { sha: string }).sha).toBe('abc')
    const written = JSON.parse(files.get('games/steam-620.json')!.text) as {
      title: string
      fields: MetadataEdit
    }
    expect(written.title).toBe('Portal 2')
    expect(written.fields).toEqual({ hltb: { main: 8 }, genres: ['Puzzle'] })
    expect(overlay.get('steam-620')).toEqual(written.fields)
    // the local edit stays until a downloaded all.json carries the publish
    expect(library.cleared).toEqual([])
    expect(notices.at(-1)?.kind).toBe('published')
    routes.unshift(allJson({ 'steam-620': written.fields }, {}, '"v2"'))
    await s.sync()
    expect(library.cleared).toEqual([{ id: 'steam:620', fields: ['genres'] }])
    expect(s.status().lastError).toBeNull()
  })

  it('keeps parts of the file this build does not know when it publishes another field', async () => {
    const files = new Map([
      [
        'games/steam-620.json',
        {
          text: JSON.stringify({
            key: 'steam-620',
            title: 'Portal 2',
            fields: {
              controls: { controller: 'full', vr: 'supported', keyboard: true, future: 'x' },
              someLaterField: { a: 1 }
            }
          }),
          sha: 'abc'
        }
      ]
    ])
    routes.push(allJson({}), tokenOk, repo(files))
    const s = create()
    await s.start()
    await s.setConfig({ token: TOKEN })
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { genres: ['Puzzle'] } })
    const written = JSON.parse(files.get('games/steam-620.json')!.text) as {
      fields: Record<string, unknown>
    }
    // the untouched controls keep their raw JSON (with keys this build strips) and an unknown field stays
    expect(written.fields).toEqual({
      controls: { controller: 'full', vr: 'supported', keyboard: true, future: 'x' },
      someLaterField: { a: 1 },
      genres: ['Puzzle']
    })
  })

  it("tidies the owner's edit of a host-only game too once all.json carries the publish", async () => {
    const files = new Map<string, { text: string; sha: string }>()
    routes.push(allJson({}), tokenOk, repo(files))
    // A host-only game: nothing in this PC's library has the key.
    library.list = []
    const s = create()
    await s.start()
    await s.setConfig({ token: TOKEN })
    const host = { ...game('remote:host-1:steam:999', 999), id: 'remote:host-1:steam:999' }
    await library.hook!(host, 'steam-999', { description: 'D1' }, { set: { description: 'D1' } })
    expect(overlay.get('steam-999')).toEqual({ description: 'D1' })
    expect(library.remoteTidied).toEqual([])
    routes.unshift(allJson({ 'steam-999': { description: 'D1' } }, {}, '"v2"'))
    await s.sync()
    expect(library.remoteTidied).toEqual([{ key: 'steam-999', fields: { description: 'D1' } }])
  })

  it('keeps a publish over an older all.json (and a 404) until one carries it', async () => {
    const files = new Map<string, { text: string; sha: string }>()
    let games: Record<string, unknown> = { 'steam-400': { genres: ['Old'] } }
    let generatedAt = '2026-11-16T10:00:00Z'
    let missing = false
    routes.push(
      (c) =>
        c.url === ALL_URL
          ? missing
            ? json({ message: 'Not Found' }, 404)
            : json({ generatedAt, games }, 200, { ETag: `"${JSON.stringify(games).length}"` })
          : undefined,
      tokenOk,
      repo(files)
    )
    library.list[0]!.user = { metadataEdits: { genres: ['Puzzle'] } }
    const s = create()
    await s.start()
    await s.setConfig({ token: TOKEN })
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { genres: ['Puzzle'] } })
    expect(overlay.get('steam-620')).toEqual({ genres: ['Puzzle'] })
    // an all.json built before the publish: the publish stays laid over it
    await s.sync()
    expect(overlay.get('steam-620')).toEqual({ genres: ['Puzzle'] })
    expect(overlay.get('steam-400')).toEqual({ genres: ['Old'] })
    missing = true
    await s.sync()
    expect(overlay.get('steam-620')).toEqual({ genres: ['Puzzle'] })
    expect(library.cleared).toEqual([])
    // survives a restart (kept in cache.json)
    await s.dispose()
    overlay = new MetadataCloudOverlay()
    const again = create()
    routes.length = 0
    await again.start()
    await settle()
    expect(overlay.get('steam-620')).toEqual({ genres: ['Puzzle'] })
    routes.push((c) =>
      c.url === ALL_URL ? json({ generatedAt, games }, 200, { ETag: '"z"' }) : undefined
    )
    games = { 'steam-620': { genres: ['Puzzle'] } }
    generatedAt = '2026-11-16T12:05:00Z'
    await again.sync()
    expect(overlay.get('steam-620')).toEqual({ genres: ['Puzzle'] })
    expect(library.cleared).toEqual([{ id: 'steam:620', fields: ['genres'] }])
    await again.dispose()
    const cache = JSON.parse(await readFile(join(dir, 'cache.json'), 'utf8')) as {
      pending?: unknown
    }
    expect(cache.pending).toBeUndefined()
  })

  it('gives a pending publish up when an all.json built well after it does not carry it', async () => {
    const files = new Map<string, { text: string; sha: string }>()
    let generatedAt = '2026-11-16T10:00:00Z'
    routes.push(
      (c) =>
        c.url === ALL_URL
          ? json({ generatedAt, games: { 'steam-620': { genres: ['Other'] } } })
          : undefined,
      tokenOk,
      repo(files)
    )
    const s = create()
    await s.start()
    await s.setConfig({ token: TOKEN })
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { genres: ['Puzzle'] } })
    await s.sync()
    expect(overlay.get('steam-620')).toEqual({ genres: ['Puzzle'] })
    generatedAt = '2026-11-16T13:00:00Z'
    await s.sync()
    expect(overlay.get('steam-620')).toEqual({ genres: ['Other'] })
  })

  it('creates a new file and queues the edit when GitHub cannot be reached', async () => {
    const files = new Map<string, { text: string; sha: string }>()
    routes.push(allJson({}), tokenOk)
    const s = create()
    await s.start()
    await s.setConfig({ token: TOKEN })
    await library.hook!(library.list[1]!, 'steam-400', {}, { set: { localPlayers: 2 } })
    expect(notices.at(-1)?.kind).toBe('queued')
    expect(s.status().queued).toBe(1)
    routes.push(repo(files))
    await s.flushQueue()
    expect(JSON.parse(files.get('games/steam-400.json')!.text)).toMatchObject({
      key: 'steam-400',
      title: 'Game 400',
      fields: { localPlayers: 2 }
    })
    expect(s.status().queued).toBe(0)
    expect(notices.at(-1)?.kind).toBe('published')
  })

  it('never publishes an empty title', async () => {
    const files = new Map<string, { text: string; sha: string }>()
    routes.push(allJson({}), tokenOk, repo(files))
    const s = create()
    await s.start()
    await s.setConfig({ token: TOKEN })
    const before = calls.length
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { title: '  ' } })
    expect(calls.length).toBe(before)
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { title: '', localPlayers: 2 } })
    expect(JSON.parse(files.get('games/steam-620.json')!.text).fields).toEqual({ localPlayers: 2 })
  })

  it('sends nothing for a removed edit', async () => {
    routes.push(allJson({}), tokenOk)
    const s = create()
    await s.start()
    await s.setConfig({ token: TOKEN })
    const before = calls.length
    await library.hook!(library.list[0]!, 'steam-620', {}, { cleared: ['genres'] })
    expect(calls.length).toBe(before)
    expect(notices).toEqual([])
  })
})

describe('everyone else: suggest', () => {
  it('queues without a relay, then suggests through it once one is set', async () => {
    routes.push(allJson({}))
    const s = create()
    await s.start()
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { genres: ['Puzzle'] } })
    expect(notices.at(-1)).toMatchObject({ kind: 'queued' })
    expect(notices.at(-1)?.message).toMatch(/will be suggested/)
    // a second edit of the same game joins the waiting one
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { localPlayers: 2 } })
    expect(s.status().queued).toBe(1)

    routes.push((c) =>
      c.url === 'https://relay.test/suggest'
        ? json({ ok: true, pr: { number: 3, url: 'https://github.com/x/pull/3' } })
        : undefined
    )
    await s.setConfig({ relayUrl: 'https://relay.test' })
    await settle()
    await s.flushQueue()
    const post = calls.find((c) => c.url === 'https://relay.test/suggest')!
    expect(post.method).toBe('POST')
    expect(post.body).toMatchObject({
      key: 'steam-620',
      title: 'Game 620',
      fields: { genres: ['Puzzle'], localPlayers: 2 },
      appVersion: '0.1.138'
    })
    expect((post.body as { clientId: string }).clientId).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(post.headers.Authorization).toBeUndefined()
    expect(s.status().queued).toBe(0)
    expect(notices.at(-1)?.kind).toBe('suggested')
  })

  it('suggests at once through the shared relay; keeps it on 503, drops it on 400', async () => {
    routes.push(allJson({}, { relayUrl: 'https://relay.test' }))
    let answer = 503
    routes.push((c) =>
      c.url === 'https://relay.test/suggest'
        ? json({ ok: false, error: 'bad field' }, answer)
        : undefined
    )
    const s = create()
    await s.start()
    await s.sync()
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { genres: ['A'] } })
    expect(s.status().queued).toBe(1)
    answer = 400
    await s.flushQueue()
    expect(s.status().queued).toBe(0)
    expect(notices.at(-1)).toMatchObject({ kind: 'error' })
  })

  it('keeps waiting edits however often they fail; only the oldest go when too many wait', async () => {
    routes.push(allJson({}))
    const s = create()
    await s.start()
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { genres: ['Puzzle'] } })
    for (let i = 0; i < 60; i++) await s.flushQueue(true)
    expect(s.status().queued).toBe(1)
    for (let i = 0; i < MAX_QUEUED; i++)
      await library.hook!(
        game(`steam:${i}`, 1000 + i),
        `steam-${1000 + i}`,
        {},
        {
          set: { localPlayers: 2 }
        }
      )
    expect(s.status().queued).toBe(MAX_QUEUED)
    expect(notices.some((n) => n.kind === 'error' && n.title === 'Game 620')).toBe(true)
  })

  it('stops a flush at the first 429 and waits before the next', async () => {
    routes.push(allJson({}))
    const s = create()
    await s.start()
    for (const g of library.list)
      await library.hook!(g, `steam-${g.externalId}`, {}, { set: { localPlayers: 2 } })
    await library.hook!(game('steam:5', 5), 'steam-5', {}, { set: { localPlayers: 3 } })
    expect(s.status().queued).toBe(3)
    let posts = 0
    routes.push((c) => {
      if (c.url !== 'https://relay.test/suggest') return undefined
      posts++
      return json({ ok: false, error: 'too many suggestions (client); try again later' }, 429, {
        'Retry-After': '120'
      })
    })
    await s.setConfig({ relayUrl: 'https://relay.test' })
    await settle()
    await s.flushQueue()
    expect(posts).toBe(1)
    expect(s.status()).toMatchObject({
      queued: 3,
      queueLimit: 'client',
      queueNextAt: new Date(START + 120_000 + QUEUE_RATE_LIMIT_MARGIN_MS).toISOString()
    })
    // backing off: the hourly flush and a save send nothing now
    await s.flushQueue()
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { localPlayers: 4 } })
    expect(posts).toBe(1)
    expect(notices.at(-1)?.kind).toBe('queued')
    expect(notices.at(-1)?.message).toMatch(
      /^Game 620: saved here\. 3 edits waiting to be suggested\. The suggestion service accepts 30 per hour from one PC; PlayOut sends the rest automatically \(next at .+\)\.$/
    )
    // a new relay (forced flush) tries again, still stopping at the first failure
    await s.flushQueue(true)
    expect(posts).toBe(2)
    await s.dispose()
    const queue = JSON.parse(await readFile(join(dir, 'queue.json'), 'utf8')) as {
      items: { key: string; lastError?: string }[]
    }
    expect(queue.items.find((i) => i.key === 'steam-620')?.lastError).toMatch(
      /accepts 30 per hour from one PC/
    )
    expect(JSON.stringify(queue)).not.toMatch(/Waiting before sending again/)
  })

  it("waits exactly the relay's Retry-After every hour (never doubling) and its timer sends the next batch", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    routes.push(allJson({}))
    const s = create()
    await s.start()
    const games = [...library.list, game('steam:5', 5), game('steam:6', 6)]
    for (const g of games)
      await library.hook!(g, `steam-${g.externalId}`, {}, { set: { localPlayers: 4 } })
    expect(s.status().queued).toBe(4)
    // The relay takes one suggestion per "hour" here, then answers 429 until the hour is over.
    let allowance = 1
    const sent: string[] = []
    routes.push((c) => {
      if (c.url !== 'https://relay.test/suggest') return undefined
      if (allowance <= 0)
        return json({ ok: false, error: 'too many suggestions (client); try again later' }, 429, {
          'Retry-After': '3600'
        })
      allowance--
      sent.push((c.body as { key: string }).key)
      return json({ ok: true, pr: { number: sent.length, url: 'https://github.com/x/pull/1' } })
    })
    await s.setConfig({ relayUrl: 'https://relay.test' })
    await settle()
    await s.flushQueue()
    const wait = 3600_000 + QUEUE_RATE_LIMIT_MARGIN_MS
    expect(sent).toEqual(['steam-620'])
    expect(s.status()).toMatchObject({
      queued: 3,
      queueLimit: 'client',
      queueNextAt: new Date(START + wait).toISOString()
    })
    for (const [i, key] of ['steam-400', 'steam-5'].entries()) {
      // Nothing goes a moment early: the timer waits for the time it was set to.
      clock += wait - 1000
      await vi.advanceTimersByTimeAsync(wait - 1000)
      await settle()
      expect(sent).toHaveLength(i + 1)
      allowance = 1
      clock += 1000
      await vi.advanceTimersByTimeAsync(1000)
      await settle()
      expect(sent.at(-1)).toBe(key)
      // Limited again at once: the same wait as before, not a doubled one.
      expect(s.status()).toMatchObject({
        queued: 2 - i,
        queueLimit: 'client',
        queueNextAt: new Date(clock + wait).toISOString()
      })
    }
    allowance = 1
    clock += wait
    await vi.advanceTimersByTimeAsync(wait)
    await settle()
    expect(sent).toEqual(['steam-620', 'steam-400', 'steam-5', 'steam-6'])
    expect(s.status()).toMatchObject({ queued: 0, queueLimit: null, queueNextAt: null })
  })

  it('names the limit each relay 429 is about, and keeps waiting the Retry-After for each', async () => {
    routes.push(allJson({}))
    const s = create()
    await s.start()
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { localPlayers: 4 } })
    let error = ''
    routes.push((c) =>
      c.url === 'https://relay.test/suggest'
        ? json({ ok: false, error }, 429, { 'Retry-After': '3600' })
        : undefined
    )
    await s.setConfig({ relayUrl: 'https://relay.test' })
    await settle()
    for (const [message, limit] of [
      ['too many suggestions wait for review; try again later', 'backlog'],
      ['too many suggestions (ip48); try again later', 'network'],
      ['too many suggestions (global); try again later', 'service']
    ] as const) {
      error = message
      await s.flushQueue(true)
      expect(s.status()).toMatchObject({
        queued: 1,
        queueLimit: limit,
        queueNextAt: new Date(clock + 3600_000 + QUEUE_RATE_LIMIT_MARGIN_MS).toISOString()
      })
    }
  })

  it('a token saved while a flush waits on the relay publishes the waiting edits at once, not after its 429 wait', async () => {
    const files = new Map<string, { text: string; sha: string }>()
    routes.push(allJson({}))
    const s = create()
    await s.start()
    const games = [...library.list, game('steam:5', 5)]
    for (const g of games)
      await library.hook!(g, `steam-${g.externalId}`, {}, { set: { localPlayers: 4 } })
    expect(s.status().queued).toBe(3)
    let answer: (res: Response) => void = () => undefined
    let posts = 0
    routes.push((c) => {
      if (c.url !== 'https://relay.test/suggest') return undefined
      posts++
      return new Promise<Response>((resolve) => (answer = resolve))
    })
    routes.push(tokenOk, repo(files))
    await s.setConfig({ relayUrl: 'https://relay.test' })
    await settle()
    expect(posts).toBe(1)
    // The owner saves the token while the relay has not answered yet.
    expect((await s.setConfig({ token: TOKEN })).token.state).toBe('ok')
    answer(
      json({ ok: false, error: 'too many suggestions (client); try again later' }, 429, {
        'Retry-After': '3570'
      })
    )
    await settle()
    await settle()
    expect(posts).toBe(1)
    expect([...files.keys()].sort()).toEqual([
      'games/steam-400.json',
      'games/steam-5.json',
      'games/steam-620.json'
    ])
    expect(s.status()).toMatchObject({ queued: 0, queueLimit: null, queueNextAt: null })
  })

  it('doubles the wait on real failures; a flush that sends something starts it afresh', async () => {
    routes.push(allJson({}))
    const s = create()
    await s.start()
    const games = [...library.list, game('steam:5', 5)]
    for (const g of games)
      await library.hook!(g, `steam-${g.externalId}`, {}, { set: { localPlayers: 2 } })
    let accept = 0
    routes.push((c) => {
      if (c.url !== 'https://relay.test/suggest') return undefined
      if (accept <= 0) return json({ ok: false, error: 'upstream' }, 503)
      accept--
      return json({ ok: true, pr: { number: 1, url: 'https://github.com/x/pull/1' } })
    })
    await s.setConfig({ relayUrl: 'https://relay.test' })
    await settle()
    await s.flushQueue()
    expect(s.status()).toMatchObject({
      queueLimit: null,
      queueNextAt: new Date(clock + QUEUE_RETRY_MS).toISOString()
    })
    clock += QUEUE_RETRY_MS
    await s.flushQueue()
    expect(s.status().queueNextAt).toBe(new Date(clock + 2 * QUEUE_RETRY_MS).toISOString())
    clock += 2 * QUEUE_RETRY_MS
    accept = 1
    await s.flushQueue()
    expect(s.status()).toMatchObject({
      queued: 2,
      queueNextAt: new Date(clock + QUEUE_RETRY_MS).toISOString()
    })
  })

  it('takes a reset field out of the waiting edit', async () => {
    routes.push(allJson({}))
    const s = create()
    await s.start()
    await library.hook!(
      library.list[0]!,
      'steam-620',
      {},
      {
        set: { genres: ['Puzzle'], localPlayers: 2 }
      }
    )
    await library.hook!(library.list[1]!, 'steam-400', {}, { set: { genres: ['A'] } })
    await library.hook!(library.list[0]!, 'steam-620', {}, { cleared: ['genres'] })
    // setMetadataEdit with a field it removes, and a new value
    await library.hook!(
      library.list[1]!,
      'steam-400',
      {},
      {
        set: { localPlayers: 1 },
        cleared: ['genres']
      }
    )
    await s.dispose()
    const queue = JSON.parse(await readFile(join(dir, 'queue.json'), 'utf8')) as {
      items: { key: string; fields: MetadataEdit }[]
    }
    expect(queue.items.map((i) => [i.key, i.fields])).toEqual([
      ['steam-620', { localPlayers: 2 }],
      ['steam-400', { localPlayers: 1 }]
    ])
  })

  it('drops the whole waiting edit when every field is reset', async () => {
    routes.push(allJson({}))
    const s = create()
    await s.start()
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { genres: ['Puzzle'] } })
    expect(s.status().queued).toBe(1)
    await library.hook!(library.list[0]!, 'steam-620', {}, {})
    expect(s.status().queued).toBe(0)
  })

  it('sends nothing when suggesting is turned off', async () => {
    routes.push(allJson({}, { relayUrl: 'https://relay.test' }))
    const s = create()
    await s.start()
    await s.sync()
    await s.setConfig({ suggestEdits: false })
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { genres: ['A'] } })
    expect(calls.some((c) => c.url.startsWith('https://relay.test'))).toBe(false)
    expect(s.status().queued).toBe(0)
  })

  it('keeps an edit with HTML on this PC instead of sending it', async () => {
    routes.push(allJson({}, { relayUrl: 'https://relay.test' }))
    const s = create()
    await s.start()
    await s.sync()
    await library.hook!(
      library.list[0]!,
      'steam-620',
      {},
      { set: { description: 'Fun <script>x</script>', genres: ['A'] } }
    )
    expect(calls.some((c) => c.url.startsWith('https://relay.test'))).toBe(false)
    expect(s.status().queued).toBe(0)
    expect(notices.at(-1)).toMatchObject({ kind: 'error' })
    expect(notices.at(-1)?.message).toMatch(/Description/)
  })
})

describe('owner: suggestions', () => {
  function pullRoutes(files: Map<string, { text: string; sha: string }>, log: string[]): Route {
    const head = new Map([
      [
        'games/steam-620.json',
        JSON.stringify({
          key: 'steam-620',
          title: 'Portal 2',
          fields: { genres: ['Puzzle'], hltb: { main: 9 } }
        })
      ]
    ])
    return (c) => {
      const path = c.url.slice(API.length)
      if (path.startsWith('/pulls?state=open'))
        return json([
          {
            number: 7,
            html_url: 'https://github.com/pr/7',
            title: 'Suggestion: Portal 2',
            created_at: '2026-11-15T00:00:00Z',
            labels: [{ name: 'suggestion' }],
            head: {
              sha: 'h7',
              ref: 'suggest/steam-620-ab',
              repo: { full_name: 'jeremybris/PlayOut-metadata' }
            }
          },
          {
            number: 8,
            html_url: 'https://github.com/pr/8',
            title: 'Docs',
            created_at: '2026-11-15T00:00:00Z',
            labels: [],
            head: { sha: 'h8', ref: 'docs', repo: { full_name: 'jeremybris/PlayOut-metadata' } }
          }
        ])
      if (path === '/pulls/7/files?per_page=100')
        return json([{ filename: 'games/steam-620.json' }])
      if (path === '/pulls/7' && c.method === 'GET')
        return json({
          number: 7,
          html_url: 'https://github.com/pr/7',
          title: 'Suggestion: Portal 2',
          created_at: '2026-11-15T00:00:00Z',
          labels: [{ name: 'suggestion' }],
          head: {
            sha: 'h7',
            ref: 'suggest/steam-620-ab',
            repo: { full_name: 'jeremybris/PlayOut-metadata' }
          }
        })
      if (path === '/contents/games/steam-620.json?ref=h7')
        return json({
          content: toBase64(head.get('games/steam-620.json')!),
          encoding: 'base64',
          sha: 's'
        })
      if (path === '/pulls/7/merge' && c.method === 'PUT') {
        log.push(`merge ${(c.body as { sha: string }).sha}`)
        return json({ merged: true })
      }
      if (path === '/pulls/7' && c.method === 'PATCH') {
        log.push(`close ${(c.body as { state: string }).state}`)
        return json({})
      }
      if (c.method === 'DELETE') {
        log.push(`delete ${path}`)
        return new Response(null, { status: 204 })
      }
      return repo(files)(c)
    }
  }

  it('lists the open suggestions with each field old -> new', async () => {
    const files = new Map([
      [
        'games/steam-620.json',
        { text: JSON.stringify({ fields: { genres: ['Action'] } }), sha: 'm' }
      ]
    ])
    const log: string[] = []
    routes.push(allJson({}), tokenOk, pullRoutes(files, log))
    const s = create()
    await s.start()
    await s.setConfig({ token: TOKEN })
    const list = await s.suggestions()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ number: 7, key: 'steam-620', gameTitle: 'Portal 2' })
    expect(list[0]!.changes).toEqual([
      { field: 'genres', label: 'Genres', before: 'Action', after: 'Puzzle' },
      { field: 'hltb', label: 'How long to beat', before: '(not set)', after: 'Main 9 h' }
    ])
  })

  it('approves (merges the reviewed head and shows it) and rejects (closes, deletes the branch)', async () => {
    const files = new Map<string, { text: string; sha: string }>()
    const log: string[] = []
    routes.push(allJson({}), tokenOk, pullRoutes(files, log))
    const s = create()
    await s.start()
    await s.setConfig({ token: TOKEN })
    await s.resolveSuggestion(7, 'approve', 'h7')
    expect(log).toEqual(['merge h7'])
    expect(overlay.get('steam-620')).toEqual({ genres: ['Puzzle'], hltb: { main: 9 } })
    await s.resolveSuggestion(7, 'reject')
    expect(log).toEqual(['merge h7', 'close closed', 'delete /git/refs/heads/suggest/steam-620-ab'])
  })

  /** PR #9 for steam-620: head h9 on base b9; `state` changes what GitHub answers. */
  function pr9(
    files: Map<string, { text: string; sha: string }>,
    log: string[],
    state: {
      heads: string[]
      changed: string[]
      headFile: unknown
      merge: number
      inRepo?: boolean
      /** The file at the base b9 (default: genres Action). */
      baseFile?: unknown
      /** The last comment posted. */
      comment?: string
    }
  ): Route {
    let reads = 0
    const pull = (sha: string): unknown => ({
      number: 9,
      html_url: 'https://github.com/pr/9',
      title: 'Suggestion: Portal 2',
      created_at: '2026-11-15T00:00:00Z',
      labels: [{ name: 'suggestion' }],
      head: {
        sha,
        ref: 'suggest/steam-620-cd',
        repo: {
          full_name: state.inRepo === false ? 'someone/fork' : 'jeremybris/PlayOut-metadata'
        }
      },
      base: { sha: 'b9' }
    })
    return (c) => {
      const path = c.url.slice(API.length)
      if (!c.url.startsWith(API)) return undefined
      if (path.startsWith('/pulls?state=open')) return json([pull(state.heads[0]!)])
      if (path === '/pulls/9' && c.method === 'GET')
        return json(pull(state.heads[Math.min(reads++, state.heads.length - 1)]!))
      if (path === '/pulls/9/files?per_page=100')
        return json(state.changed.map((filename) => ({ filename })))
      const ref = /\?ref=(.+)$/.exec(path)?.[1]
      if (ref && ref !== 'main') {
        const text =
          ref === 'b9'
            ? JSON.stringify(
                state.baseFile ?? {
                  key: 'steam-620',
                  title: 'Portal 2',
                  fields: { genres: ['Action'] }
                }
              )
            : JSON.stringify(state.headFile)
        return json({ content: toBase64(text), encoding: 'base64', sha: `blob-${ref}` })
      }
      if (path === '/pulls/9/merge' && c.method === 'PUT') {
        log.push(`merge ${(c.body as { sha: string }).sha}`)
        return state.merge === 200
          ? json({ merged: true })
          : json({ message: 'Pull Request is not mergeable' }, state.merge)
      }
      if (path === '/issues/9/comments' && c.method === 'POST') {
        log.push('comment')
        state.comment = (c.body as { body: string }).body
        return json({}, 201)
      }
      if (path === '/pulls/9' && c.method === 'PATCH') {
        log.push(`close ${(c.body as { state: string }).state}`)
        return json({})
      }
      if (c.method === 'DELETE') {
        log.push(`delete ${path}`)
        return new Response(null, { status: 204 })
      }
      if (path.startsWith('/contents/') && c.method === 'PUT') log.push(`put ${path}`)
      return repo(files)(c)
    }
  }

  const portal = (fields: MetadataEdit): unknown => ({
    key: 'steam-620',
    title: 'Portal 2',
    fields
  })

  async function owner(route: Route): Promise<MetadataCloudService> {
    routes.push(allJson({}), tokenOk, route)
    const s = create()
    await s.start()
    await s.setConfig({ token: TOKEN })
    return s
  }

  it('approve refuses a head that moved since it was reviewed or while it was checked', async () => {
    const log: string[] = []
    const files = new Map<string, { text: string; sha: string }>()
    const state = {
      heads: ['h9', 'h9', 'h9x'],
      changed: ['games/steam-620.json'],
      headFile: portal({ genres: ['Puzzle'] }),
      merge: 200
    }
    const s = await owner(pr9(files, log, state))
    // approving needs the head the owner reviewed
    await expect(s.resolveSuggestion(9, 'approve')).rejects.toThrow(/as it was reviewed/)
    await expect(s.resolveSuggestion(9, 'approve', 'h0')).rejects.toThrow(/changed after/)
    await expect(s.resolveSuggestion(9, 'approve', 'h9')).rejects.toThrow(/changed after/)
    expect(log).toEqual([])
  })

  it('lists what approving would change: head against its base, from main as it is now', async () => {
    const log: string[] = []
    // main moved on since the suggestion was opened: description D2, tags Y, hltb 8
    const files = new Map([
      [
        'games/steam-620.json',
        {
          text: JSON.stringify(
            portal({ genres: ['Action'], description: 'D2', tags: ['Y'], hltb: { main: 8 } })
          ),
          sha: 'm1'
        }
      ]
    ])
    const s = await owner(
      pr9(files, log, {
        heads: ['h9'],
        changed: ['games/steam-620.json'],
        baseFile: portal({ genres: ['Action'], description: 'D1', tags: ['X'] }),
        // description as at its base (not a change), hltb as main has it, tags removed, genres changed
        headFile: portal({ genres: ['Puzzle'], description: 'D1', hltb: { main: 8 } }),
        merge: 200
      })
    )
    const [item] = await s.suggestions()
    expect(item).toMatchObject({ number: 9, key: 'steam-620', headSha: 'h9' })
    expect(item!.changes).toEqual([
      { field: 'genres', label: 'Genres', before: 'Action', after: 'Puzzle' },
      { field: 'tags', label: 'Tags', before: 'Y', after: '(not set)' }
    ])
  })

  it('approve applies a field the suggestion removes when it no longer merges', async () => {
    const log: string[] = []
    const files = new Map([
      [
        'games/steam-620.json',
        {
          text: JSON.stringify(portal({ genres: ['Action'], tags: ['X'], hltb: { main: 8 } })),
          sha: 'm1'
        }
      ]
    ])
    const state = {
      heads: ['h9'],
      changed: ['games/steam-620.json'],
      baseFile: portal({ genres: ['Action'], tags: ['X'] }),
      headFile: portal({ genres: ['Action'] }),
      merge: 405,
      comment: undefined as string | undefined
    }
    const s = await owner(pr9(files, log, state))
    await s.resolveSuggestion(9, 'approve', 'h9')
    expect(log).toEqual([
      'merge h9',
      'put /contents/games/steam-620.json',
      'comment',
      'close closed',
      'delete /git/refs/heads/suggest/steam-620-cd'
    ])
    const written = JSON.parse(files.get('games/steam-620.json')!.text) as {
      fields: MetadataEdit
    }
    expect(written.fields).toEqual({ genres: ['Action'], hltb: { main: 8 } })
    expect(overlay.get('steam-620')).toEqual(written.fields)
    expect(state.comment).toMatch(/were applied/)
  })

  it('approve reports nothing applied when main already has what the suggestion changes', async () => {
    const log: string[] = []
    const files = new Map([
      ['games/steam-620.json', { text: JSON.stringify(portal({ genres: ['Puzzle'] })), sha: 'm1' }]
    ])
    const state = {
      heads: ['h9'],
      changed: ['games/steam-620.json'],
      baseFile: portal({ genres: ['Action'], tags: ['X'] }),
      headFile: portal({ genres: ['Puzzle'] }),
      merge: 409,
      comment: undefined as string | undefined
    }
    const s = await owner(pr9(files, log, state))
    await s.resolveSuggestion(9, 'approve', 'h9')
    expect(log).not.toContain('put /contents/games/steam-620.json')
    expect(state.comment).toMatch(/already has/)
  })

  it('approve refuses other files, an invalid file and HTML, and merges the checked head', async () => {
    const log: string[] = []
    const files = new Map<string, { text: string; sha: string }>()
    const state = {
      heads: ['h9'],
      changed: ['games/steam-620.json', 'config.json'],
      headFile: portal({ genres: ['Puzzle'] }) as unknown,
      merge: 200
    }
    const s = await owner(pr9(files, log, state))
    await expect(s.resolveSuggestion(9, 'approve', 'h9')).rejects.toThrow(/other files/)
    state.changed = ['games/steam-620.json']
    state.headFile = { key: 'steam-620', fields: { localPlayers: 'four' } }
    await expect(s.resolveSuggestion(9, 'approve', 'h9')).rejects.toThrow(/not valid/)
    state.headFile = { key: 'steam-440', fields: { localPlayers: 4 } }
    await expect(s.resolveSuggestion(9, 'approve', 'h9')).rejects.toThrow(/not valid/)
    state.headFile = portal({ description: '<img src=x onerror=alert(1)>' })
    await expect(s.resolveSuggestion(9, 'approve', 'h9')).rejects.toThrow(/does not accept/)
    expect(log).toEqual([])
    state.headFile = portal({ genres: ['Puzzle'] })
    await s.resolveSuggestion(9, 'approve', 'h9')
    expect(log).toEqual(['merge h9'])
    expect(overlay.get('steam-620')).toEqual({ genres: ['Puzzle'] })
  })

  it('approve applies a suggestion that no longer merges onto the current file, then closes it', async () => {
    const log: string[] = []
    // main moved on since the suggestion was opened (an owner publish of the same game)
    const files = new Map([
      [
        'games/steam-620.json',
        {
          text: JSON.stringify(portal({ genres: ['Action'], hltb: { main: 8 } })),
          sha: 'm1'
        }
      ]
    ])
    const s = await owner(
      pr9(files, log, {
        heads: ['h9'],
        changed: ['games/steam-620.json'],
        headFile: portal({ genres: ['Puzzle'] }),
        merge: 405
      })
    )
    await s.resolveSuggestion(9, 'approve', 'h9')
    expect(log).toEqual([
      'merge h9',
      'put /contents/games/steam-620.json',
      'comment',
      'close closed',
      'delete /git/refs/heads/suggest/steam-620-cd'
    ])
    const written = JSON.parse(files.get('games/steam-620.json')!.text) as {
      fields: MetadataEdit
    }
    expect(written.fields).toEqual({ genres: ['Puzzle'], hltb: { main: 8 } })
    expect(overlay.get('steam-620')).toEqual(written.fields)
  })

  it('refuses without a working token', async () => {
    routes.push(allJson({}))
    const s = create()
    await s.start()
    await expect(s.suggestions()).rejects.toThrow(/token/)
    await expect(s.resolveSuggestion(7, 'approve', 'h7')).rejects.toThrow(/token/)
  })
})

describe('queue: saves while an edit is being sent', () => {
  /** A promise and the function that settles it. */
  function gate(): { wait: Promise<void>; open: () => void } {
    let open!: () => void
    const wait = new Promise<void>((r) => (open = r))
    return { wait, open }
  }

  it('a field reset while its save is being sent is not queued again', async () => {
    const g = gate()
    routes.push(allJson({}, { relayUrl: 'https://relay.test' }), async (c) => {
      if (c.url !== 'https://relay.test/suggest') return undefined
      await g.wait
      return json({ ok: false, error: 'busy' }, 503)
    })
    const s = create()
    await s.start()
    await s.sync()
    const saving = library.hook!(
      library.list[0]!,
      'steam-620',
      {},
      { set: { genres: ['A'], localPlayers: 2 } }
    )
    await settle()
    expect(calls.some((c) => c.url === 'https://relay.test/suggest')).toBe(true)
    await library.hook!(library.list[0]!, 'steam-620', {}, { cleared: ['genres'] })
    g.open()
    await saving
    expect(notices.at(-1)?.kind).toBe('queued')
    await s.dispose()
    const queue = JSON.parse(await readFile(join(dir, 'queue.json'), 'utf8')) as {
      items: { key: string; fields: MetadataEdit; attempts: number }[]
    }
    expect(queue.items.map((i) => [i.key, i.fields, i.attempts])).toEqual([
      ['steam-620', { localPlayers: 2 }, 1]
    ])
  })

  it('a newer save replaces the waiting value, so the older one is never sent after it', async () => {
    const files = new Map<string, { text: string; sha: string }>()
    routes.push(allJson({}), tokenOk)
    const s = create()
    await s.start()
    await s.setConfig({ token: TOKEN })
    // GitHub cannot be reached: A waits
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { genres: ['A'] } })
    expect(s.status().queued).toBe(1)
    routes.push(repo(files))
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { genres: ['B'] } })
    expect(s.status().queued).toBe(0)
    await s.flushQueue(true)
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(JSON.parse(files.get('games/steam-620.json')!.text).fields).toEqual({ genres: ['B'] })
  })

  it('a save made while a flush sends the older value goes after it, and the newer value wins', async () => {
    const files = new Map<string, { text: string; sha: string }>()
    routes.push(allJson({}), tokenOk)
    const s = create()
    await s.start()
    await s.setConfig({ token: TOKEN })
    await library.hook!(library.list[0]!, 'steam-620', {}, { set: { genres: ['A'] } })
    expect(s.status().queued).toBe(1)
    const g = gate()
    let held = false
    routes.push(async (c) => {
      if (c.method === 'PUT' && !held) {
        held = true
        await g.wait
      }
      return undefined
    }, repo(files))
    const flushing = s.flushQueue(true)
    await settle()
    expect(held).toBe(true)
    const saving = library.hook!(library.list[0]!, 'steam-620', {}, { set: { genres: ['B'] } })
    await settle()
    // nothing else goes while the flush's write is under way
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
    g.open()
    await Promise.all([flushing, saving])
    const sent = calls
      .filter((c) => c.method === 'PUT')
      .map((c) => JSON.parse(fromBase64((c.body as { content: string }).content)).fields)
    expect(sent).toEqual([{ genres: ['A'] }, { genres: ['B'] }])
    expect(JSON.parse(files.get('games/steam-620.json')!.text).fields).toEqual({ genres: ['B'] })
    expect(s.status().queued).toBe(0)
  })
})
