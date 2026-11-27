import { describe, expect, it, vi } from 'vitest'
import { createScreenshotMirror, SCREENSHOT_MANIFEST_NAME } from './screenshot-mirror'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

const listing = (entries: [string, string][]): string =>
  entries
    .map(([id, name]) => `<div id="entry-${id}"><div class="flip-entry-title">${name}</div></div>`)
    .join('')

const CDN = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/620'
const manifest = {
  version: 1,
  games: {
    '620': [
      { thumbnail: `${CDN}/a.600x338.jpg?t=1`, full: `${CDN}/a.1920x1080.jpg?t=1`, drive: 'f1' },
      { thumbnail: `${CDN}/b.600x338.jpg?t=1`, full: `${CDN}/b.1920x1080.jpg?t=1` }
    ]
  }
}
const KEY = 'AbCdEfGhIjKlMn_-'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test fixture
function setup(answers: (url: string) => string, now = { t: 0 }) {
  const fetchText = vi.fn(async (url: string) => answers(url))
  return {
    fetchText,
    now,
    mirror: createScreenshotMirror({ log, folderId: 'root', fetchText, now: () => now.t })
  }
}

function folder(rootEntries: [string, string][], body: string = JSON.stringify(manifest)) {
  return (url: string): string => {
    if (url.includes('id=root')) return listing(rootEntries)
    if (url.includes('id=dir400'))
      return listing([
        ['t1', `steam-thumb-${KEY}.jpg`],
        ['c1', 'cover.jpg'],
        ['bad', 'steam-thumb-short.jpg']
      ])
    if (url.includes('id=dir500')) return listing([['c2', 'cover.jpg']])
    return body
  }
}
const ROOT: [string, string][] = [
  ['dir620', 'steam_620'],
  ['dir400', 'steam_400'],
  ['dir500', 'steam_500'],
  ['man', SCREENSHOT_MANIFEST_NAME]
]

describe('screenshot mirror', () => {
  it("reads the folder and manifest once and gives a listed game's list with its Drive files", async () => {
    const t = setup(folder(ROOT))
    const [a, b] = await Promise.all([t.mirror.forApp(620), t.mirror.forApp(620)])
    expect(a).toEqual({ list: manifest.games['620'], files: new Map() })
    expect(b).toEqual(a)
    expect(t.fetchText).toHaveBeenCalledTimes(2)
    expect(t.fetchText.mock.calls[1]![0]).toContain('id=man')
    expect(t.mirror.fileUrl('f1')).toContain('id=f1')
  })

  it("gives a game the manifest lacks its folder's thumbnails by key, and nothing for a game without any", async () => {
    const t = setup(folder(ROOT))
    expect(await t.mirror.forApp(400)).toEqual({ list: null, files: new Map([[KEY, 't1']]) })
    expect(await t.mirror.forApp(500)).toBeNull()
    expect(await t.mirror.forApp(1)).toBeNull()
  })

  it('serves the game folders without a manifest, or with a broken one', async () => {
    const none = setup(folder(ROOT.filter(([id]) => id !== 'man')))
    expect((await none.mirror.forApp(400))?.files.get(KEY)).toBe('t1')
    expect(await none.mirror.forApp(620)).toBeNull()
    const broken = setup(folder(ROOT, '<html>quota</html>'))
    expect((await broken.mirror.forApp(400))?.files.get(KEY)).toBe('t1')
  })

  it('takes only Steam https URLs from the manifest', async () => {
    const foreign = setup(
      folder(
        ROOT,
        JSON.stringify({
          version: 1,
          games: { '620': [{ thumbnail: 'https://evil.example/x.jpg', full: `${CDN}/a.jpg` }] }
        })
      )
    )
    expect(await foreign.mirror.forApp(620)).toBeNull()
    const plain = setup(
      folder(
        ROOT,
        JSON.stringify({
          version: 1,
          games: {
            '620': [{ thumbnail: `${CDN.replace('https', 'http')}/x.jpg`, full: `${CDN}/a.jpg` }]
          }
        })
      )
    )
    expect(await plain.mirror.forApp(620)).toBeNull()
  })

  it('gives nothing while the folder cannot be read, and asks again only after a while', async () => {
    const now = { t: 0 }
    const t = setup(() => {
      throw new Error('offline')
    }, now)
    expect(await t.mirror.forApp(620)).toBeNull()
    expect(await t.mirror.forApp(620)).toBeNull()
    expect(t.fetchText).toHaveBeenCalledTimes(1)
    now.t = 16 * 60 * 1000
    await t.mirror.forApp(620)
    expect(t.fetchText).toHaveBeenCalledTimes(2)
  })

  it("hands out copies, so a caller's change never reaches the manifest", async () => {
    const t = setup(folder(ROOT))
    const first = (await t.mirror.forApp(620))!
    first.list![0]!.thumbnail = 'changed'
    expect((await t.mirror.forApp(620))!.list![0]!.thumbnail).toBe(
      manifest.games['620'][0]!.thumbnail
    )
  })
})
