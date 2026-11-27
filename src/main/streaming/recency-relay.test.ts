import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logger'
import {
  createRecencyRelay,
  isLaterPlay,
  isStoreGameId,
  latestRecency,
  MAX_RECENCY_ENTRIES,
  MAX_RECENCY_WANTED,
  ownRecency,
  parseRecency,
  parseWanted,
  RECENCY_TOLERANCE_MS
} from './recency-relay'

const NOW = Date.parse('2026-11-17T12:00:00.000Z')
const HOUR = 3_600_000
const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

describe('isStoreGameId', () => {
  it("is true for a store game's library id only", () => {
    for (const id of ['steam:620', 'gog:1207658924', 'epic:ns:item', 'xbox:9NBLGGH4R315', 'ea:x'])
      expect(isStoreGameId(id)).toBe(true)
    for (const id of [
      'rom:snes/z.sfc',
      'manual:abc',
      'remote:host-1:steam:620',
      'steam:',
      'steam',
      'steam:6\n20',
      `steam:${'9'.repeat(201)}`,
      620,
      null,
      undefined
    ])
      expect(isStoreGameId(id)).toBe(false)
  })
})

describe('ownRecency', () => {
  const game = (
    id: string,
    lastPlayed?: string,
    hidden = false
  ): Parameters<typeof ownRecency>[0][number] => ({
    id,
    source: id.split(':')[0] as never,
    hidden,
    lastPlayed
  })

  it('sends the last played of the store games asked for, never a hidden, unplayed or other game', () => {
    const games = [
      game('steam:1', '2026-11-10T10:00:00.000Z'),
      game('gog:2', '2026-11-12T10:00:00.000Z'),
      game('steam:3', '2026-11-11T10:00:00.000Z', true),
      game('steam:4'),
      game('steam:5', 'never'),
      game('rom:snes/z.sfc', '2026-11-13T10:00:00.000Z'),
      game('manual:abc', '2026-11-13T10:00:00.000Z'),
      game('steam:6', '2026-11-14T10:00:00.000Z')
    ]
    expect(ownRecency(games, (g) => g.id !== 'steam:6')).toEqual([
      { game: 'gog:2', at: Date.parse('2026-11-12T10:00:00.000Z') },
      { game: 'steam:1', at: Date.parse('2026-11-10T10:00:00.000Z') }
    ])
  })

  it('sends the most recent ones only', () => {
    const games = Array.from({ length: MAX_RECENCY_ENTRIES + 20 }, (_, i) =>
      game(`steam:${i}`, new Date(NOW - i * HOUR).toISOString())
    )
    const sent = ownRecency(games, () => true)
    expect(sent).toHaveLength(MAX_RECENCY_ENTRIES)
    expect(sent[0]).toEqual({ game: 'steam:0', at: NOW })
    expect(sent.some((e) => e.game === `steam:${MAX_RECENCY_ENTRIES}`)).toBe(false)
  })
})

describe('parseRecency', () => {
  it('keeps the valid dates, the latest of each game, latest first', () => {
    expect(
      parseRecency(
        [
          { game: 'steam:1', at: NOW - 3 * HOUR },
          { game: 'gog:2', at: NOW - HOUR },
          { game: 'steam:1', at: NOW - 2 * HOUR },
          { game: 'rom:snes/z.sfc', at: NOW - HOUR },
          { game: 'steam:3', at: '2026-11-17T10:00:00.000Z' },
          { game: 'steam:4', at: Number.NaN },
          { game: 'steam:5', at: 0 },
          { game: 'steam:6', at: -5 },
          { at: NOW },
          null,
          'junk'
        ],
        NOW
      )
    ).toEqual([
      { game: 'gog:2', at: NOW - HOUR },
      { game: 'steam:1', at: NOW - 2 * HOUR }
    ])
    expect(parseRecency([], NOW)).toEqual([])
  })

  it('is null for what is no list, or one too long', () => {
    expect(parseRecency(undefined, NOW)).toBeNull()
    expect(parseRecency({ game: 'steam:1', at: NOW }, NOW)).toBeNull()
    const many = Array.from({ length: MAX_RECENCY_ENTRIES + 1 }, (_, i) => ({
      game: `steam:${i}`,
      at: NOW - HOUR
    }))
    expect(parseRecency(many, NOW)).toBeNull()
    expect(parseRecency(many.slice(1), NOW)).toHaveLength(MAX_RECENCY_ENTRIES)
  })

  it("puts the dates on this PC's clock and never ahead of it", () => {
    // The other PC's clock runs an hour ahead.
    expect(parseRecency([{ game: 'steam:1', at: NOW - HOUR }], NOW, HOUR)).toEqual([
      { game: 'steam:1', at: NOW - 2 * HOUR }
    ])
    // Below a second the difference is the request's own timing.
    expect(parseRecency([{ game: 'steam:1', at: NOW - HOUR }], NOW, 400)).toEqual([
      { game: 'steam:1', at: NOW - HOUR }
    ])
    expect(parseRecency([{ game: 'steam:1', at: NOW - HOUR }], NOW, Number.NaN)).toEqual([
      { game: 'steam:1', at: NOW - HOUR }
    ])
    // Ahead of this PC's clock by less than a day: taken as now. Further: a wrong clock, dropped.
    expect(
      parseRecency(
        [
          { game: 'steam:1', at: NOW + 3 * HOUR },
          { game: 'steam:2', at: NOW + 25 * HOUR }
        ],
        NOW
      )
    ).toEqual([{ game: 'steam:1', at: NOW }])
  })
})

describe('latestRecency', () => {
  it('keeps one date a game, the latest, in a stable order, up to the limit', () => {
    const entries = [
      { game: 'steam:b', at: 5 },
      { game: 'steam:a', at: 5 },
      { game: 'steam:c', at: 9 },
      { game: 'steam:a', at: 3 }
    ]
    expect(latestRecency(entries)).toEqual([
      { game: 'steam:c', at: 9 },
      { game: 'steam:a', at: 5 },
      { game: 'steam:b', at: 5 }
    ])
    expect(latestRecency(entries, 1)).toEqual([{ game: 'steam:c', at: 9 }])
  })
})

describe('the relay table', () => {
  async function file(): Promise<string> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'playout-recency-'))
    dirs.push(dir)
    return join(dir, 'recency-relay.json')
  }

  const BOTH = new Set(['steam:1', 'gog:2'])
  const T1 = NOW - 3 * HOUR
  const T2 = NOW - 2 * HOUR

  it('keeps the latest date of each game and never tells a PC what it said itself', () => {
    const relay = createRecencyRelay({ log })
    const first = [
      { game: 'steam:1', at: T1 },
      { game: 'gog:2', at: T2 }
    ]
    expect(relay.take(first, 'pc-a')).toBe(2)
    // An older or equal date changes nothing (and the PC it came from stays).
    expect(relay.take([{ game: 'steam:1', at: T1 }], 'pc-b')).toBe(0)
    expect(relay.take([{ game: 'steam:1', at: T1 - HOUR }], 'pc-b')).toBe(0)
    expect(relay.entriesFor('pc-a', BOTH)).toEqual([])
    expect(relay.entriesFor('pc-b', BOTH)).toEqual([
      { game: 'gog:2', at: T2 },
      { game: 'steam:1', at: T1 }
    ])
    // A later play on another PC replaces it: now it is the first PC's to hear.
    expect(relay.take([{ game: 'steam:1', at: NOW - HOUR }], 'pc-b')).toBe(1)
    expect(relay.entriesFor('pc-a', BOTH)).toEqual([{ game: 'steam:1', at: NOW - HOUR }])
    expect(relay.entriesFor('pc-b', BOTH)).toEqual([{ game: 'gog:2', at: T2 }])
    expect(relay.entriesFor('pc-c', BOTH)).toHaveLength(2)
    // A sender that is no PC id is not kept.
    expect(relay.take([{ game: 'steam:9', at: NOW }], 'not a pc')).toBe(0)
  })

  it("a date that comes back a little later is the same play: nothing changes, and it stays the first PC's", () => {
    const relay = createRecencyRelay({ log })
    const one = new Set(['steam:1'])
    expect(isLaterPlay(T1 + RECENCY_TOLERANCE_MS, T1)).toBe(false)
    expect(isLaterPlay(T1 + RECENCY_TOLERANCE_MS + 1, T1)).toBe(true)
    expect(isLaterPlay(T1, 0)).toBe(true)
    expect(isLaterPlay(0, 0)).toBe(false)
    relay.take([{ game: 'steam:1', at: T1 }], 'pc-a')
    // pc-b took the date and sends it back: its two clock corrections put it some milliseconds later.
    for (const drift of [3, 6, 1000, RECENCY_TOLERANCE_MS])
      expect(relay.take([{ game: 'steam:1', at: T1 + drift }], 'pc-b')).toBe(0)
    expect(relay.entriesFor('pc-a', one)).toEqual([])
    expect(relay.entriesFor('pc-b', one)).toEqual([{ game: 'steam:1', at: T1 }])
    // A real later play is taken.
    expect(relay.take([{ game: 'steam:1', at: T1 + RECENCY_TOLERANCE_MS + 1 }], 'pc-b')).toBe(1)
    expect(relay.entriesFor('pc-a', one)).toEqual([
      { game: 'steam:1', at: T1 + RECENCY_TOLERANCE_MS + 1 }
    ])
  })

  it('tells a PC only about the games it names', () => {
    const relay = createRecencyRelay({ log })
    relay.take(
      [
        { game: 'steam:1', at: T1 },
        { game: 'gog:2', at: T2 }
      ],
      'pc-a'
    )
    expect(relay.entriesFor('pc-b', new Set())).toEqual([])
    expect(relay.entriesFor('pc-b', new Set(['gog:2', 'steam:404']))).toEqual([
      { game: 'gog:2', at: T2 }
    ])
    expect([...parseWanted(['gog:2', 'gog:2', 'rom:snes/z.sfc', 7, null, 'steam:1'])]).toEqual([
      'gog:2',
      'steam:1'
    ])
    expect(parseWanted('gog:2').size).toBe(0)
    expect(parseWanted(undefined).size).toBe(0)
    expect(parseWanted(Array.from({ length: MAX_RECENCY_WANTED + 1 }, () => 'gog:2')).size).toBe(0)
  })

  it("a PC's list replaces what it sent before, and a PC that is forgotten takes its dates with it", async () => {
    const path = await file()
    const relay = createRecencyRelay({ file: path, log })
    relay.take(
      [
        { game: 'steam:1', at: T1 },
        { game: 'gog:2', at: T2 }
      ],
      'pc-a'
    )
    relay.take([{ game: 'steam:3', at: T2 }], 'pc-b')
    const all = new Set(['steam:1', 'gog:2', 'steam:3'])
    // pc-a hid steam:1 (it no longer lists it): the others are no longer told. pc-b's own date is not pc-a's to drop.
    expect(relay.take([{ game: 'gog:2', at: T2 }], 'pc-a')).toBe(1)
    expect(relay.entriesFor('pc-c', all)).toEqual([
      { game: 'gog:2', at: T2 },
      { game: 'steam:3', at: T2 }
    ])
    // pc-a is unpaired.
    expect(relay.forget('pc-a')).toBe(1)
    expect(relay.forget('pc-a')).toBe(0)
    expect(relay.entriesFor('pc-c', all)).toEqual([{ game: 'steam:3', at: T2 }])
    await relay.flush()
    const again = createRecencyRelay({ file: path, log })
    await again.load()
    expect(again.entriesFor('pc-c', all)).toEqual([{ game: 'steam:3', at: T2 }])
  })

  it('keeps the most recent games only', () => {
    const relay = createRecencyRelay({ log })
    const many = Array.from({ length: MAX_RECENCY_ENTRIES }, (_, i) => ({
      game: `steam:${i}`,
      at: 1000 + i
    }))
    relay.take(many, 'pc-a')
    relay.take([{ game: 'gog:new', at: 5000 }], 'pc-c')
    const kept = relay.entriesFor('pc-b', new Set(['gog:new', ...many.map((e) => e.game)]))
    expect(kept).toHaveLength(MAX_RECENCY_ENTRIES)
    expect(kept[0]).toEqual({ game: 'gog:new', at: 5000 })
    // The oldest one made room.
    expect(kept.some((e) => e.game === 'steam:0')).toBe(false)
  })

  it('is kept across a restart, and a damaged file is an empty table', async () => {
    const path = await file()
    const relay = createRecencyRelay({ file: path, log })
    await relay.load()
    relay.take([{ game: 'steam:1', at: 100 }], 'pc-a')
    relay.take([{ game: 'gog:2', at: 200 }], 'pc-b')
    await relay.flush()
    const again = createRecencyRelay({ file: path, log })
    // A date taken before the file was read stays when it is the later one.
    again.take([{ game: 'steam:1', at: 150 }], 'pc-c')
    await again.load()
    expect(again.entriesFor('pc-z', BOTH)).toEqual([
      { game: 'gog:2', at: 200 },
      { game: 'steam:1', at: 150 }
    ])
    expect(again.entriesFor('pc-b', BOTH)).toEqual([{ game: 'steam:1', at: 150 }])
    await again.flush()

    await fs.writeFile(
      path,
      JSON.stringify({
        games: {
          'steam:1': { at: 100, from: 'pc-a' },
          'rom:snes/z.sfc': { at: 100, from: 'pc-a' },
          'steam:2': { at: 'soon', from: 'pc-a' },
          'steam:3': { at: 100, from: 'not a pc' },
          'steam:4': null
        }
      })
    )
    const checked = createRecencyRelay({ file: path, log })
    await checked.load()
    const any = new Set(['steam:1', 'steam:2', 'steam:3', 'steam:4'])
    expect(checked.entriesFor('pc-z', any)).toEqual([{ game: 'steam:1', at: 100 }])
    await fs.writeFile(path, '{ not json')
    const empty = createRecencyRelay({ file: path, log })
    await empty.load()
    expect(empty.entriesFor('pc-z', any)).toEqual([])
  })
})
