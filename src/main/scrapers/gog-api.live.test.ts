// Live checks against GOG's keyless endpoints (docs/research/metadata-apis.md §7). They only run when
// PLAYOUT_LIVE=1 is set, so the normal suite never touches the network; every call is bounded by its own timeout.
import { describe, expect, it } from 'vitest'

import type { Game } from '../../shared/types'
import { gogScraper, loadGamesDbRelease, loadGogProduct } from './gog-api'

const live = process.env.PLAYOUT_LIVE === '1'
// The Witcher: Enhanced Edition, the product the research report verified.
const WITCHER = '1207658924'

function game(): Game {
  return {
    id: `gog:${WITCHER}`,
    source: 'gog',
    externalId: WITCHER,
    platformId: 'gog',
    title: 'The Witcher',
    sortTitle: 'witcher',
    installed: true,
    launch: { kind: 'uri', uri: `goggalaxy://openGameView/${WITCHER}` },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-10-29T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {},
    extra: { gogProductId: WITCHER }
  }
}

describe.skipIf(!live)('GOG live', () => {
  it('reads the product and the gamesdb release', { timeout: 30_000 }, async () => {
    const product = await loadGogProduct(WITCHER)
    expect(product?.title).toMatch(/witcher/i)
    const release = await loadGamesDbRelease(WITCHER)
    expect(release?.game?.vertical_cover?.url_format).toContain('{formatter}')
    expect(await loadGogProduct('999999999999')).toBeNull()
  })

  it('scrapes the game end to end with text and art URLs', { timeout: 45_000 }, async () => {
    const settings = {} as never
    const candidates = await gogScraper.search(game(), settings)
    expect(candidates).toHaveLength(1)
    const result = await gogScraper.fetch(game(), candidates[0], settings)
    expect(result.title).toMatch(/witcher/i)
    expect(result.metadata.description?.length ?? 0).toBeGreaterThan(50)
    expect(result.metadata.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(result.media.cover).toMatch(/^https:\/\//)
    expect(result.media.hero).toMatch(/^https:\/\//)
    expect(result.media.logo).toMatch(/^https:\/\//)
    const head = await fetch(result.media.cover!, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000)
    })
    expect(head.ok).toBe(true)
  })

  it('searches the public catalog', { timeout: 30_000 }, async () => {
    const candidates = await gogScraper.search(game(), {} as never, 'witcher')
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.length).toBeLessThanOrEqual(8)
    expect(candidates[0].scraper).toBe('gog')
    expect(candidates.every((c) => /^\d+$/.test(c.externalId))).toBe(true)
  })
})
