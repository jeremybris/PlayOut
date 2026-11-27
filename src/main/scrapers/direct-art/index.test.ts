import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import type { RateLimiter } from '../http'
import { igdbLimiter } from '../igdb'
import { steamGridDbLimiter } from '../steamgriddb'
import { fakeGame, testLog, testSettings } from '../test-helpers'
import type { ArtCandidates, DirectArtSource } from '../types'
import { createDirectArtRegistry, createDirectArtSources } from './index'

function stubSource(
  id: DirectArtSource['id'],
  batchSize: number,
  configured: boolean,
  answer: (gameId: string) => ArtCandidates | null
): DirectArtSource & { batches: number[] } {
  const batches: number[] = []
  return {
    id,
    batchSize,
    batches,
    isConfigured: () => configured,
    candidates: async (games) => {
      batches.push(games.length)
      const out = new Map<string, ArtCandidates>()
      for (const { game } of games) {
        const art = answer(game.id)
        if (art) out.set(game.id, art)
      }
      return out
    }
  }
}

const url = (source: DirectArtSource['id'], u: string): ArtCandidates => ({
  cover: [{ kind: 'cover', source, url: u }]
})

describe('direct art registry', () => {
  it('splits games into batches per source and merges candidates in source order', async () => {
    const cdn = stubSource('steam-cdn', 1, true, (id) =>
      id === 'steam:1' ? url('steam-cdn', 'cdn/1') : null
    )
    const sgdb = stubSource('steamgriddb-platform', 2, true, (id) =>
      url('steamgriddb-platform', `sgdb/${id}`)
    )
    const igdb = stubSource('igdb-external', 500, false, () => url('igdb-external', 'never'))
    const registry = createDirectArtRegistry({ log: testLog, sources: [cdn, sgdb, igdb] })
    const games = ['steam:1', 'steam:2', 'steam:3'].map((id) => ({
      game: fakeGame('steam', id.split(':')[1]),
      ids: { steamAppId: Number(id.split(':')[1]) }
    }))
    const found = await registry.candidates(games, ['cover'], testSettings())
    expect(cdn.batches).toEqual([1, 1, 1])
    expect(sgdb.batches).toEqual([2, 1])
    expect(igdb.batches).toEqual([])
    expect(found.get('steam:1')?.cover?.map((c) => c.url)).toEqual(['cdn/1', 'sgdb/steam:1'])
    expect(found.get('steam:2')?.cover?.map((c) => c.url)).toEqual(['sgdb/steam:2'])
  })

  it('survives a failing source', async () => {
    const broken: DirectArtSource = {
      id: 'xbox-catalog',
      batchSize: 20,
      isConfigured: () => true,
      candidates: async () => {
        throw new Error('boom')
      }
    }
    const cdn = stubSource('steam-cdn', 1, true, () => url('steam-cdn', 'cdn'))
    const registry = createDirectArtRegistry({ log: testLog, sources: [broken, cdn] })
    const found = await registry.candidates(
      [{ game: fakeGame('steam', '1'), ids: { steamAppId: 1 } }],
      ['cover'],
      testSettings()
    )
    expect(found.get('steam:1')?.cover?.[0].url).toBe('cdn')
  })

  it('lists the six sources in lane order', () => {
    expect(createDirectArtSources({ log: testLog }).map((s) => s.id)).toEqual([
      'steam-cdn',
      'gog-images',
      'epic-catalog',
      'xbox-catalog',
      'steamgriddb-platform',
      'igdb-external'
    ])
  })

  it("shares the scrapers' limiters so a service never sees two independent buckets", () => {
    const sources = createDirectArtSources({ log: testLog }) as (DirectArtSource & {
      limiter?: RateLimiter
    })[]
    expect(sources.find((s) => s.id === 'steamgriddb-platform')?.limiter).toBe(steamGridDbLimiter)
    expect(sources.find((s) => s.id === 'igdb-external')?.limiter).toBe(igdbLimiter)
  })

  it('says which games each source can key on', () => {
    const by = Object.fromEntries(createDirectArtSources({ log: testLog }).map((s) => [s.id, s]))
    expect(by['steam-cdn'].hasIdFor?.({ steamAppId: 620 })).toBe(true)
    expect(by['steam-cdn'].hasIdFor?.({ gogProductId: '1' })).toBe(false)
    expect(by['gog-images'].hasIdFor?.({ gogProductId: '1' })).toBe(true)
    expect(by['gog-images'].hasIdFor?.({ steamAppId: 620 })).toBe(false)
    expect(by['epic-catalog'].hasIdFor?.({ epicAppName: 'Jasper' })).toBe(true)
    expect(by['xbox-catalog'].hasIdFor?.({ xboxStoreId: '9NBLGGH4R315' })).toBe(true)
    expect(by['xbox-catalog'].hasIdFor?.({ steamAppId: 620 })).toBe(false)
    expect(by['steamgriddb-platform'].hasIdFor?.({ steamAppId: 620 })).toBe(true)
    expect(by['steamgriddb-platform'].hasIdFor?.({ gogProductId: '1' })).toBe(false)
    expect(by['igdb-external'].hasIdFor?.({ igdbId: '1020' })).toBe(true)
    expect(by['igdb-external'].hasIdFor?.({ epicAppName: 'x' })).toBe(false)
  })
})
