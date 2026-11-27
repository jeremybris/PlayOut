import { describe, expect, it, vi } from 'vitest'
import { fakeGame, testLog, testSettings } from '../test-helpers'
import type { ArtCandidates, LocalArtSource } from '../types'
import { createLocalArtRegistry } from './index'

function stubSource(
  id: LocalArtSource['id'],
  available: boolean,
  answer: ArtCandidates
): LocalArtSource & { calls: { index: number; reset: number; lookup: number; kinds: string[][] } } {
  const calls = { index: 0, reset: 0, lookup: 0, kinds: [] as string[][] }
  return {
    id,
    calls,
    isAvailable: async () => available,
    index: async () => {
      calls.index++
    },
    reset: () => {
      calls.reset++
    },
    lookup: async (_game, _ids, kinds) => {
      calls.lookup++
      calls.kinds.push([...kinds])
      return answer
    }
  }
}

const cover = (source: LocalArtSource['id'], path: string): ArtCandidates => ({
  cover: [{ kind: 'cover', source, path }]
})

describe('local art registry', () => {
  it('takes each kind from the first source that has it and skips unavailable sources', async () => {
    const steam = stubSource('steam-cache', true, cover('steam-cache', 'a.jpg'))
    const galaxy = stubSource('galaxy-cache', true, {
      ...cover('galaxy-cache', 'b.webp'),
      hero: [{ kind: 'hero', source: 'galaxy-cache', path: 'h.webp' }]
    })
    const esde = stubSource('esde-media', false, cover('esde-media', 'c.png'))
    const playnite = stubSource('playnite-files', true, cover('playnite-files', 'd.png'))
    const registry = createLocalArtRegistry({
      settings: { get: () => testSettings() },
      log: testLog,
      sources: [steam, galaxy, esde, playnite]
    })
    const found = await registry.lookup(fakeGame('steam', '1'), { steamAppId: 1 }, [
      'cover',
      'hero'
    ])
    expect(found.cover?.map((c) => c.path)).toEqual(['a.jpg'])
    expect(found.hero?.map((c) => c.path)).toEqual(['h.webp'])
    expect(galaxy.calls.kinds).toEqual([['hero']])
    // Every kind was answered before Playnite's turn, so it is not asked at all.
    expect(playnite.calls.lookup).toBe(0)
    expect(esde.calls.lookup).toBe(0)
    expect(esde.calls.index).toBe(0)
    expect(steam.calls.index).toBe(1)
  })

  it('indexes each source once per run and again after reset', async () => {
    const steam = stubSource('steam-cache', true, {})
    const registry = createLocalArtRegistry({
      settings: { get: () => testSettings() },
      log: testLog,
      sources: [steam]
    })
    const game = fakeGame('steam', '1')
    await Promise.all([
      registry.lookup(game, { steamAppId: 1 }, ['cover']),
      registry.lookup(game, { steamAppId: 1 }, ['cover'])
    ])
    expect(steam.calls.index).toBe(1)
    registry.reset()
    expect(steam.calls.reset).toBe(1)
    await registry.lookup(game, { steamAppId: 1 }, ['cover'])
    expect(steam.calls.index).toBe(2)
  })

  it('answers nothing when scrapers.localArt is off', async () => {
    const steam = stubSource('steam-cache', true, cover('steam-cache', 'a.jpg'))
    const settings = testSettings({ localArt: false })
    const registry = createLocalArtRegistry({
      settings: { get: () => settings },
      log: testLog,
      sources: [steam]
    })
    expect(await registry.lookup(fakeGame('steam', '1'), { steamAppId: 1 }, ['cover'])).toEqual({})
    expect(steam.calls.lookup).toBe(0)
  })

  it('survives a source that throws', async () => {
    const broken: LocalArtSource = {
      id: 'playnite-files',
      isAvailable: async () => true,
      index: async () => undefined,
      reset: vi.fn(),
      lookup: async () => {
        throw new Error('boom')
      }
    }
    const steam = stubSource('steam-cache', true, cover('steam-cache', 'a.jpg'))
    const registry = createLocalArtRegistry({
      settings: { get: () => testSettings() },
      log: testLog,
      sources: [broken, steam]
    })
    const found = await registry.lookup(fakeGame('steam', '1'), { steamAppId: 1 }, ['cover'])
    expect(found.cover?.[0].path).toBe('a.jpg')
  })
})
