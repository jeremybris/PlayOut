// Live checks against Steam's public, keyless endpoints (docs/research/metadata-apis.md §5). They only run when
// PLAYOUT_LIVE=1 is set, so the normal suite never touches the network; every call is bounded by its own timeout.
import { describe, expect, it } from 'vitest'

import {
  firstAvailableUrl,
  loadSteamAppDetails,
  mapSteamAppDetails,
  steamCdnUrl,
  steamCurrentPlayers
} from './steam-store'

const live = process.env.PLAYOUT_LIVE === '1'
const PORTAL_2 = 620

describe.skipIf(!live)('Steam live', () => {
  it('reads appdetails for Portal 2 and maps it', { timeout: 30_000 }, async () => {
    const data = await loadSteamAppDetails(PORTAL_2)
    expect(data?.name).toBe('Portal 2')
    const result = mapSteamAppDetails(PORTAL_2, data!)
    expect(result.metadata.releaseDate).toBe('2011-04-18')
    expect(result.metadata.developers).toEqual(['Valve'])
    expect(result.metadata.description?.length ?? 0).toBeGreaterThan(100)
    expect(result.metadata.description).not.toMatch(/<[^>]+>/)
    expect(result.media.screenshots?.length ?? 0).toBeGreaterThan(0)
  })

  it('returns null for an app without a store page', { timeout: 30_000 }, async () => {
    expect(await loadSteamAppDetails(999_999_999)).toBeNull()
  })

  it('finds the full-size CDN art', { timeout: 30_000 }, async () => {
    expect(await firstAvailableUrl([steamCdnUrl(PORTAL_2, 'library_600x900_2x.jpg')])).toBe(
      steamCdnUrl(PORTAL_2, 'library_600x900_2x.jpg')
    )
    expect(await firstAvailableUrl([steamCdnUrl(PORTAL_2, 'library_hero.jpg')])).toBe(
      steamCdnUrl(PORTAL_2, 'library_hero.jpg')
    )
    expect(await firstAvailableUrl([steamCdnUrl(PORTAL_2, 'logo.png')])).toBe(
      steamCdnUrl(PORTAL_2, 'logo.png')
    )
  })

  it('reads the current player count', { timeout: 30_000 }, async () => {
    const count = await steamCurrentPlayers(PORTAL_2)
    expect(typeof count).toBe('number')
    expect(count!).toBeGreaterThan(0)
    expect(await steamCurrentPlayers(999_999_999)).toBeNull()
  })
})
