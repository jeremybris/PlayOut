import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaySession } from '../../shared/types'
import {
  accountTotalStore,
  copyForStore,
  compareCursors,
  createPlaytimeSyncState,
  cursorOf,
  MAX_SESSIONS_PER_REQUEST,
  parseCursor,
  parseGameIds,
  parseWireSessions,
  sessionsAfter,
  toWire
} from './playtime-sync'

const NOW = Date.parse('2026-11-17T12:00:00.000Z')

function wire(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    game: 'steam:620',
    startedAt: '2026-11-17T10:00:00.000Z',
    endedAt: '2026-11-17T11:00:00.000Z',
    minutes: 60,
    ...overrides
  }
}

function session(id: string, endedAt?: string, extra: Partial<PlaySession> = {}): PlaySession {
  return {
    id,
    gameId: 'steam:620',
    startedAt: '2026-11-17T09:00:00.000Z',
    endedAt,
    minutes: 10,
    ...extra
  }
}

describe('parseWireSessions', () => {
  it('keeps the valid sessions, the first of each id', () => {
    const out = parseWireSessions(
      [
        wire('s_a'),
        wire('s_a', { minutes: 5 }),
        wire('bad id!'),
        wire('s_b', { minutes: -1 }),
        wire('s_c', { endedAt: 'never' }),
        wire('s_d', { endedAt: '2026-11-17T09:00:00.000Z' }), // ends before it starts
        wire('s_e', { game: '' }),
        wire('s_f', { minutes: 1e9 }),
        'nope',
        wire('s_g', { minutes: 12.6 })
      ],
      NOW
    )
    expect(out?.map((s) => [s.id, s.minutes])).toEqual([
      ['s_a', 60],
      // More minutes than the session ran: cut to its start to end, never dropped.
      ['s_f', 60],
      ['s_g', 13]
    ])
  })

  it('keeps a session longer than a week (a game left running), its minutes as measured', () => {
    const out = parseWireSessions(
      [
        wire('s_long', {
          startedAt: '2026-11-08T10:00:00.000Z',
          endedAt: '2026-11-16T10:00:00.000Z',
          minutes: 11_500
        })
      ],
      NOW
    )
    expect(out?.map((s) => [s.id, s.minutes])).toEqual([['s_long', 11_500]])
  })

  it('keeps a known store, and a session naming an unknown one without it', () => {
    const out = parseWireSessions(
      [wire('s_a', { store: 'steam' }), wire('s_b', { store: 'nope' })],
      NOW
    )
    expect(out?.map((s) => [s.id, s.store])).toEqual([
      ['s_a', 'steam'],
      ['s_b', undefined]
    ])
  })

  it('refuses what is not a list, or too long a list', () => {
    expect(parseWireSessions({}, NOW)).toBeNull()
    expect(parseWireSessions(null, NOW)).toBeNull()
    expect(
      parseWireSessions(
        Array.from({ length: MAX_SESSIONS_PER_REQUEST + 1 }, (_, i) => wire(`s_${i}`)),
        NOW
      )
    ).toBeNull()
  })

  it("puts the times on this PC's clock and drops a session more than a day ahead", () => {
    // The other PC's clock is an hour ahead.
    const out = parseWireSessions(
      [
        wire('s_a'),
        wire('s_late', {
          startedAt: '2026-11-19T10:00:00.000Z',
          endedAt: '2026-11-19T11:00:00.000Z'
        })
      ],
      NOW,
      3_600_000
    )
    expect(out).toEqual([
      expect.objectContaining({
        id: 's_a',
        startedAt: '2026-11-17T09:00:00.000Z',
        endedAt: '2026-11-17T10:00:00.000Z'
      })
    ])
    // A difference under a second is the request's own timing.
    expect(parseWireSessions([wire('s_a')], NOW, 400)![0].startedAt).toBe(
      '2026-11-17T10:00:00.000Z'
    )
  })
})

describe('cursors', () => {
  it('orders by recorded time (taken here, else ended), then id', () => {
    expect(cursorOf(session('s_a'))).toBeNull() // still running
    expect(cursorOf(session('s_a', '2026-11-17T10:00:00.000Z'))).toEqual({
      at: Date.parse('2026-11-17T10:00:00.000Z'),
      id: 's_a'
    })
    expect(
      cursorOf(session('s_a', '2026-11-17T10:00:00.000Z', { syncedAt: '2026-11-17T11:30:00.000Z' }))
        ?.at
    ).toBe(Date.parse('2026-11-17T11:30:00.000Z'))
    expect(compareCursors({ at: 1, id: 'b' }, { at: 1, id: 'a' })).toBeGreaterThan(0)
    expect(compareCursors({ at: 1, id: 'b' }, { at: 2, id: 'a' })).toBeLessThan(0)
    expect(compareCursors(null, { at: 0, id: 'a' })).toBeLessThan(0)
    expect(compareCursors(null, null)).toBe(0)
    expect(parseCursor({ at: 5, id: 's_x' })).toEqual({ at: 5, id: 's_x' })
    expect(parseCursor({ at: -1, id: 's_x' })).toBeNull()
    expect(parseCursor('x')).toBeNull()
  })

  it('pages sessions in recorded order, including ties on the same time', () => {
    const t = '2026-11-17T10:00:00.000Z'
    // Several sessions taken at once share their recorded time.
    const all = [
      session('s_c', t),
      session('s_a', t),
      session('s_run'),
      session('s_b', t),
      session('s_x', t, { gameId: 'other' })
    ]
    const keep = (s: PlaySession): boolean => s.gameId === 'steam:620'
    const first = sessionsAfter(all, keep, null, 2)
    expect(first.page.map((s) => s.id)).toEqual(['s_a', 's_b'])
    expect(first.more).toBe(true)
    const second = sessionsAfter(all, keep, first.next, 2)
    expect(second.page.map((s) => s.id)).toEqual(['s_c'])
    expect(second.more).toBe(false)
    const none = sessionsAfter(all, keep, second.next, 2)
    expect(none).toEqual({ page: [], next: second.next, more: false })
  })

  it("names the store whose account total counts a session, and picks the other PC's copy of it", () => {
    expect(accountTotalStore({ source: 'steam' })).toBe('steam')
    expect(accountTotalStore({ source: 'gog' })).toBeUndefined()
    expect(accountTotalStore({ source: 'gog', storePlaytimeMinutes: 5 })).toBe('gog')
    expect(accountTotalStore({ source: 'rom' })).toBeUndefined()
    const own = session('s_a', '2026-11-17T10:00:00.000Z')
    expect(toWire(own, 'h:1', { source: 'steam' }).store).toBe('steam')
    expect(toWire(own, 'h:1', { source: 'gog' }).store).toBeUndefined()
    // A session taken from another PC keeps the store it came with, whatever copy took it here.
    const taken = session('s_b', '2026-11-17T10:00:00.000Z', { from: 'pc', store: 'epic' })
    expect(toWire(taken, 'h:1', { source: 'steam' }).store).toBe('epic')
    const copies = [
      { id: 'gog:1', source: 'gog' },
      { id: 'steam:1', source: 'steam' }
    ]
    expect(copyForStore(copies, 'steam', copies[0]).id).toBe('steam:1')
    expect(copyForStore(copies, 'epic', copies[0]).id).toBe('gog:1')
    expect(copyForStore(copies, undefined, copies[0]).id).toBe('gog:1')
  })

  it('reads game ids, and sends a session by the id the other PC knows', () => {
    expect(parseGameIds(['a', 1, '', 'b\u0001', 'manual:x'])).toEqual(['a', 'manual:x'])
    expect(parseGameIds('a')).toBeNull()
    expect(toWire(session('s_a', '2026-11-17T10:00:00.000Z', { from: 'pc' }), 'host:1')).toEqual({
      id: 's_a',
      game: 'host:1',
      startedAt: '2026-11-17T09:00:00.000Z',
      endedAt: '2026-11-17T10:00:00.000Z',
      minutes: 10
    })
  })
})

describe('createPlaytimeSyncState', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-ptsync-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  it('keeps each host’s cursors across a restart and ignores a damaged file', async () => {
    const file = join(dir, 'playtime-sync.json')
    const a = createPlaytimeSyncState({ file, log: log as never })
    await a.load()
    expect(a.get('host-1')).toEqual({
      sent: null,
      sentGames: [],
      received: null,
      receivedGames: []
    })
    a.set('host-1', {
      sent: { at: 5, id: 's_a' },
      sentGames: ['steam:620'],
      received: { at: 7, id: 's_b' },
      receivedGames: ['rom:ps2:x']
    })
    a.set('bad id!', { sent: null, sentGames: [], received: null, receivedGames: [] })
    await a.flush()
    const b = createPlaytimeSyncState({ file, log: log as never })
    await b.load()
    expect(b.get('host-1')).toEqual({
      sent: { at: 5, id: 's_a' },
      sentGames: ['steam:620'],
      received: { at: 7, id: 's_b' },
      receivedGames: ['rom:ps2:x']
    })
    await fs.writeFile(file, '{"hosts":{"host-1":{"sent":"x","sentGames":5}}}')
    await b.load()
    expect(b.get('host-1')).toEqual({
      sent: null,
      sentGames: [],
      received: null,
      receivedGames: []
    })
  })
})
