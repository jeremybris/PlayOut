import { describe, expect, it, vi } from 'vitest'
import type { Game, GameMetadata, ScreenshotsProgress } from '../../shared/types'
import {
  createSteamScreenshots,
  mergeScreenshotList,
  screenshotKey,
  STEAM_SCREENSHOTS_TTL_MS,
  steamScreenshotsDue,
  type SteamScreenshotsDeps
} from './steam-screenshots'
import type { MediaPolicy } from './types'
import type { MirrorEntry, MirroredScreenshot, ScreenshotMirror } from './screenshot-mirror'

const NOW = Date.parse('2026-11-10T12:00:00Z')
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

function steamGame(appId: number, metadata: Partial<GameMetadata> = {}): Game {
  return {
    id: `steam:${appId}`,
    source: 'steam',
    externalId: String(appId),
    platformId: 'steam',
    title: `Game ${appId}`,
    metadata,
    user: {}
  } as unknown as Game
}

const shots = (
  appId: number,
  n: number
): { id: number; path_thumbnail: string; path_full: string }[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i,
    path_thumbnail: `https://cdn/${appId}/ss_${i}.600x338.jpg?t=1`,
    path_full: `https://cdn/${appId}/ss_${i}.1920x1080.jpg?t=1`
  }))

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test fixture: its shape is what the tests read
function setup(
  games: Game[],
  options: {
    details?: (appId: number) => Promise<{ screenshots?: ReturnType<typeof shots> } | null>
    thumb?: (url: string, policy?: MediaPolicy) => Promise<string | null>
    mirror?: ScreenshotMirror
  } = {}
) {
  const byId = new Map(games.map((g) => [g.id, g]))
  const progress: ScreenshotsProgress[] = []
  let reading = 0
  let peak = 0
  const details = vi.fn(async (appId: number) => {
    reading++
    peak = Math.max(peak, reading)
    await new Promise((r) => setTimeout(r, 1))
    reading--
    return options.details ? options.details(appId) : { screenshots: shots(appId, 2) }
  })
  const thumbs = vi.fn(async (gameId: string, key: string, url: string, policy?: MediaPolicy) =>
    options.thumb ? options.thumb(url, policy) : `media://cache/${gameId}/steam-thumb-${key}.jpg`
  )
  const pruned: { gameId: string; keep: string[] }[] = []
  const removed: string[] = []
  const deps: SteamScreenshotsDeps = {
    library: {
      games: () => [...byId.values()],
      getGame: (id) => byId.get(id),
      applyMetadata: (id, update) => {
        const g = byId.get(id)!
        g.metadata = { ...g.metadata, ...update.metadata }
      }
    },
    imageCache: {
      importSteamThumbnail: thumbs,
      pruneSteamThumbnails: async (gameId, keep) => {
        pruned.push({ gameId, keep: [...keep] })
      },
      remove: async (gameId) => {
        removed.push(gameId)
      }
    },
    emit: (p) => progress.push(p),
    log,
    loadDetails: details,
    now: () => NOW,
    ...(options.mirror ? { mirror: options.mirror } : {})
  }
  return {
    service: createSteamScreenshots(deps),
    byId,
    progress,
    details,
    thumbs,
    pruned,
    removed,
    peak: () => peak
  }
}

describe('steamScreenshotsDue', () => {
  it('is due for a Steam game never read, a month old, or with a thumbnail not saved', () => {
    expect(steamScreenshotsDue(steamGame(1), NOW)).toBe(true)
    const fresh = new Date(NOW).toISOString()
    const done = { thumbnail: 't', full: 'f', local: 'media://x' }
    expect(
      steamScreenshotsDue(
        steamGame(1, { steamScreenshots: { items: [done], updatedAt: fresh } }),
        NOW
      )
    ).toBe(false)
    expect(
      steamScreenshotsDue(
        steamGame(1, {
          steamScreenshots: { items: [{ thumbnail: 't', full: 'f' }], updatedAt: fresh }
        }),
        NOW
      )
    ).toBe(true)
    expect(
      steamScreenshotsDue(
        steamGame(1, {
          steamScreenshots: {
            items: [{ thumbnail: 't', full: 'f', missing: true }],
            updatedAt: fresh
          }
        }),
        NOW
      )
    ).toBe(false)
    const old = new Date(NOW - STEAM_SCREENSHOTS_TTL_MS).toISOString()
    expect(
      steamScreenshotsDue(
        steamGame(1, { steamScreenshots: { items: [done], updatedAt: old } }),
        NOW
      )
    ).toBe(true)
  })

  it('is never due for a game that is not a Steam game', () => {
    expect(steamScreenshotsDue({ ...steamGame(1), source: 'epic' } as Game, NOW)).toBe(false)
  })
})

describe('mergeScreenshotList', () => {
  it("keeps a saved thumbnail for the same screenshot, whatever Steam's ?t= says", () => {
    const merged = mergeScreenshotList(
      [
        { thumbnail: 'https://cdn/a.jpg?t=2', full: 'https://cdn/A.jpg?t=2' },
        { thumbnail: 'https://cdn/b.jpg', full: 'B' }
      ],
      [{ thumbnail: 'https://cdn/a.jpg?t=1', full: 'x', local: 'media://a' }]
    )
    expect(merged).toEqual([
      { thumbnail: 'https://cdn/a.jpg?t=2', full: 'https://cdn/A.jpg?t=2', local: 'media://a' },
      { thumbnail: 'https://cdn/b.jpg', full: 'B' }
    ])
  })
})

describe('createSteamScreenshots', () => {
  it('downloads every Steam game list and thumbnails once, reporting progress and ending at 0', async () => {
    const epic = { ...steamGame(9), id: 'epic:9', source: 'epic' } as Game
    const { service, byId, progress, details, thumbs } = setup([steamGame(1), steamGame(2), epic])
    service.kick()
    await service.idle()
    expect(details).toHaveBeenCalledTimes(2)
    expect(thumbs).toHaveBeenCalledTimes(4)
    const saved = byId.get('steam:1')!.metadata.steamScreenshots!
    expect(saved.items.map((s) => s.local)).toEqual(
      saved.items.map((s) => `media://cache/steam:1/steam-thumb-${screenshotKey(s)}.jpg`)
    )
    // Named by the screenshot, never by its place in the list.
    expect(screenshotKey(saved.items[0]!)).not.toBe(screenshotKey(saved.items[1]!))
    expect(progress[0]).toMatchObject({ done: 0, total: 2 })
    expect(progress.at(-1)).toEqual({ done: 0, total: 0 })
    // Nothing is due any more.
    service.kick()
    await service.idle()
    expect(details).toHaveBeenCalledTimes(2)
  })

  it('never runs two passes at once: a kick while one runs makes it look again afterwards', async () => {
    const { service, details, peak } = setup([steamGame(1), steamGame(2), steamGame(3)])
    service.kick()
    service.kick()
    service.kick()
    await service.idle()
    expect(peak()).toBe(1)
    expect(details).toHaveBeenCalledTimes(3)
  })

  it('marks a thumbnail the CDN does not have, and leaves one that failed on the network for next time', async () => {
    const { service, byId } = setup([steamGame(1)], {
      thumb: async (url, policy) => {
        if (url.includes('ss_0')) return null // 404: the answer is "no such file"
        policy?.onNetworkError?.(url)
        return null
      }
    })
    service.kick()
    await service.idle()
    const items = byId.get('steam:1')!.metadata.steamScreenshots!.items
    expect(items[0]).toMatchObject({ missing: true })
    expect(items[1]!.missing).toBeUndefined()
    expect(items[1]!.local).toBeUndefined()
  })

  it('stops the pass after five games in a row fail', async () => {
    const games = Array.from({ length: 8 }, (_, i) => steamGame(i + 1))
    const { service, details } = setup(games, {
      details: async () => {
        throw new Error('Steam is down')
      }
    })
    service.kick()
    await service.idle()
    expect(details).toHaveBeenCalledTimes(5)
  })

  it('gives a page the saved list, else reads it from Steam (once, even when asked twice)', async () => {
    const fresh = new Date(NOW).toISOString()
    const saved = steamGame(5, {
      steamScreenshots: {
        items: [{ thumbnail: 't', full: 'f', local: 'media://t' }],
        updatedAt: fresh
      }
    })
    const { service, details } = setup([saved, steamGame(6)])
    expect(await service.forGame('steam:5')).toEqual([
      { thumbnail: 't', full: 'f', local: 'media://t' }
    ])
    const [a, b] = await Promise.all([service.forGame('steam:6'), service.forGame('steam:6')])
    expect(a).toHaveLength(2)
    expect(b).toEqual(a)
    expect(details).toHaveBeenCalledTimes(1)
    expect(await service.forGame('nope')).toBeNull()
  })

  it('gives up a thumbnail after three failed passes, and stops a game at its first network failure', async () => {
    const { service, byId, thumbs } = setup([steamGame(1)], {
      thumb: async (url, policy) => {
        policy?.onNetworkError?.(url)
        return null
      }
    })
    for (let pass = 1; pass <= 3; pass++) {
      service.kick()
      await service.idle()
      expect(thumbs).toHaveBeenCalledTimes(pass)
    }
    const items = byId.get('steam:1')!.metadata.steamScreenshots!.items
    expect(items[0]).toMatchObject({ failures: 3, missing: true })
    expect(items[1]!.missing).toBeUndefined()
  })

  it('drops the thumbnails of screenshots a refreshed list no longer has', async () => {
    const { service, pruned } = setup([steamGame(1)])
    service.kick()
    await service.idle()
    expect(pruned).toHaveLength(1)
    expect(pruned[0]!.keep).toHaveLength(2)
  })

  it('removes the media folder of a game removed while its thumbnails downloaded', async () => {
    const holder: { byId?: Map<string, Game> } = {}
    const s = setup([steamGame(1)], {
      thumb: async () => {
        holder.byId?.delete('steam:1')
        return 'media://x'
      }
    })
    holder.byId = s.byId
    s.service.kick()
    await s.service.idle()
    expect(s.removed).toEqual(['steam:1'])
  })

  it('tells the open game page what it saved', async () => {
    const saved: string[] = []
    const s = setup([steamGame(1)])
    s.service.dispose()
    const again = createSteamScreenshots({
      library: {
        games: () => [...s.byId.values()],
        getGame: (id) => s.byId.get(id),
        applyMetadata: (id, update) => {
          const g = s.byId.get(id)!
          g.metadata = { ...g.metadata, ...update.metadata }
        }
      },
      imageCache: {
        importSteamThumbnail: async () => 'media://x',
        pruneSteamThumbnails: async () => {},
        remove: async () => {}
      },
      emit: () => {},
      onSaved: (gameId) => saved.push(gameId),
      log,
      loadDetails: async (appId) => ({ screenshots: shots(appId, 1) }),
      now: () => NOW
    })
    again.kick()
    await again.idle()
    expect(saved).toEqual(['steam:1', 'steam:1'])
  })
})

describe('the Drive screenshot mirror', () => {
  const mirroredList = (appId: number, n: number, mirroredCount = n): MirroredScreenshot[] =>
    shots(appId, n).map((s, i) => ({
      thumbnail: s.path_thumbnail,
      full: s.path_full,
      ...(i < mirroredCount ? { drive: `drive-${appId}-${i}` } : {})
    }))
  const listed = (list: MirroredScreenshot[]): MirrorEntry => ({ list, files: new Map() })
  function fakeMirror(games: Record<number, MirrorEntry>): ScreenshotMirror & {
    asked: number[]
  } {
    const asked: number[] = []
    return {
      asked,
      forApp: async (appId) => {
        asked.push(appId)
        return games[appId] ?? null
      },
      fileUrl: (id) => `https://drive/${id}`
    }
  }

  it("takes a never-read game's list and thumbnails from the mirror, with no Steam read", async () => {
    const game = steamGame(10)
    const mirror = fakeMirror({ 10: listed(mirroredList(10, 3)) })
    const t = setup([game], { mirror })
    t.service.kick()
    await t.service.idle()
    expect(t.details).not.toHaveBeenCalled()
    const urls = t.thumbs.mock.calls.map((c) => c[2])
    expect(urls.sort()).toEqual([
      'https://drive/drive-10-0',
      'https://drive/drive-10-1',
      'https://drive/drive-10-2'
    ])
    // A Drive answer must be an image (its error pages are HTML).
    expect(t.thumbs.mock.calls.every((c) => c[3]?.imageOnly)).toBe(true)
    const items = t.byId.get(game.id)!.metadata.steamScreenshots!.items
    expect(items.map((s) => s.full)).toEqual(shots(10, 3).map((s) => s.path_full))
    expect(items.every((s) => s.local && !('drive' in s))).toBe(true)
  })

  it('falls back to Steam for a thumbnail the mirror lacks or fails to give', async () => {
    const game = steamGame(11)
    const mirror = fakeMirror({ 11: listed(mirroredList(11, 3, 2)) })
    const t = setup([game], {
      mirror,
      thumb: async (url) => (url === 'https://drive/drive-11-0' ? null : `media://${url}`)
    })
    t.service.kick()
    await t.service.idle()
    const urls = t.thumbs.mock.calls.map((c) => c[2])
    expect(urls).toContain('https://cdn/11/ss_0.600x338.jpg?t=1')
    expect(urls).toContain('https://cdn/11/ss_2.600x338.jpg?t=1')
    expect(urls).not.toContain('https://cdn/11/ss_1.600x338.jpg?t=1')
    expect(t.byId.get(game.id)!.metadata.steamScreenshots!.items.every((s) => s.local)).toBe(true)
  })

  it('reads a game the mirror does not have from Steam', async () => {
    const t = setup([steamGame(12)], { mirror: fakeMirror({}) })
    t.service.kick()
    await t.service.idle()
    expect(t.details).toHaveBeenCalledWith(12)
    expect(t.thumbs.mock.calls.map((c) => c[2])).toEqual([
      'https://cdn/12/ss_0.600x338.jpg?t=1',
      'https://cdn/12/ss_1.600x338.jpg?t=1'
    ])
  })

  it('is left alone when every game has been read before (not a first-time setup)', async () => {
    const fresh = new Date(NOW).toISOString()
    const game = steamGame(13, {
      steamScreenshots: {
        items: [{ thumbnail: 'https://cdn/13/a.jpg', full: 'f' }],
        updatedAt: fresh
      }
    })
    const mirror = fakeMirror({ 13: listed(mirroredList(13, 1)) })
    const t = setup([game], { mirror })
    t.service.kick()
    await t.service.idle()
    expect(mirror.asked).toEqual([])
    expect(t.thumbs.mock.calls.map((c) => c[2])).toEqual(['https://cdn/13/a.jpg'])
  })

  it('stops using a failing mirror for the rest of the pass', async () => {
    const games = [steamGame(20), steamGame(21), steamGame(22)]
    const mirror = fakeMirror({
      20: listed(mirroredList(20, 6)),
      21: listed(mirroredList(21, 6)),
      22: listed(mirroredList(22, 6))
    })
    const t = setup(games, {
      mirror,
      thumb: async (url) => (url.startsWith('https://drive/') ? null : `media://${url}`)
    })
    t.service.kick()
    await t.service.idle()
    const driveCalls = t.thumbs.mock.calls.filter((c) => c[2].startsWith('https://drive/')).length
    expect(driveCalls).toBeLessThan(18)
    expect(games.every((g) => g.metadata.steamScreenshots!.items.every((s) => s.local))).toBe(true)
  })

  it("takes a game the manifest lacks from its folder's files, its list from Steam", async () => {
    const game = steamGame(30)
    const key0 = screenshotKey({ thumbnail: shots(30, 2)[0]!.path_thumbnail })
    const mirror = fakeMirror({ 30: { list: null, files: new Map([[key0, 'file-0']]) } })
    const t = setup([game], { mirror })
    t.service.kick()
    await t.service.idle()
    expect(t.details).toHaveBeenCalledWith(30)
    expect(t.thumbs.mock.calls.map((c) => c[2])).toEqual([
      'https://drive/file-0',
      'https://cdn/30/ss_1.600x338.jpg?t=1'
    ])
  })

  it("keeps Steam's CDN to one download at a time while the mirror runs several", async () => {
    let cdnNow = 0
    let cdnPeak = 0
    let driveNow = 0
    let drivePeak = 0
    const t = setup([steamGame(40)], {
      mirror: fakeMirror({ 40: listed(mirroredList(40, 12, 6)) }),
      thumb: async (url) => {
        const drive = url.startsWith('https://drive/')
        if (drive) drivePeak = Math.max(drivePeak, ++driveNow)
        else cdnPeak = Math.max(cdnPeak, ++cdnNow)
        await new Promise((r) => setTimeout(r, 2))
        if (drive) driveNow--
        else cdnNow--
        return `media://${url}`
      }
    })
    t.service.kick()
    await t.service.idle()
    expect(drivePeak).toBeGreaterThan(1)
    expect(cdnPeak).toBe(1)
    expect(t.thumbs).toHaveBeenCalledTimes(12)
  })
})
