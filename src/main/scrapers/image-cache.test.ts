import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Gate } from './http'
import { createImageCache, safeGameId } from './image-cache'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-media-'))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(dir, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function image(type = 'image/png', size = 200): Response {
  return new Response(Buffer.alloc(size, 7), { status: 200, headers: { 'content-type': type } })
}

describe('image cache', () => {
  it('maps game ids to safe folder names', () => {
    expect(safeGameId('steam:620')).toBe('steam_620')
    expect(safeGameId('rom:snes:Ab_-1')).toBe('rom_snes_Ab_-1')
  })

  it('imports local files and resolves their media URLs', async () => {
    const cache = createImageCache({ dir, log })
    const src = join(dir, 'src.png')
    await fs.writeFile(src, Buffer.alloc(200, 1))
    const url = await cache.importLocal('steam:620', 'cover', src)
    expect(url).toMatch(/^media:\/\/cache\/steam_620\/cover\.png\?v=\d+$/)
    const path = new URL(url!).pathname
    const file = cache.resolve(path)
    expect(file).toBe(join(dir, 'steam_620', 'cover.png'))
    expect((await fs.stat(file!)).size).toBe(200)
  })

  it('replaces variants of the same kind', async () => {
    const cache = createImageCache({ dir, log })
    const png = join(dir, 'a.png')
    const jpg = join(dir, 'a.jpg')
    await fs.writeFile(png, Buffer.alloc(200, 1))
    await fs.writeFile(jpg, Buffer.alloc(200, 2))
    await cache.importLocal('g:1', 'cover', png)
    await cache.importLocal('g:1', 'cover', jpg)
    expect((await fs.readdir(join(dir, 'g_1'))).sort()).toEqual(['cover.jpg'])
  })

  it("keeps a host's copy and a lookup's image of the same kind side by side, and removes both with the kind", async () => {
    const cache = createImageCache({ dir, log })
    const png = join(dir, 'a.png')
    const jpg = join(dir, 'a.jpg')
    await fs.writeFile(png, Buffer.alloc(200, 1))
    await fs.writeFile(jpg, Buffer.alloc(200, 2))
    const lookup = await cache.importLocal('g:1', 'cover', png)
    const host = await cache.importHostCopy('g:1', 'cover', jpg)
    const shot = await cache.importHostCopy('g:1', 'screenshot', jpg, 2)
    expect(host).toMatch(/\/g_1\/cover-host\.jpg\?v=\d+$/)
    expect(shot).toMatch(/\/g_1\/screenshot-2-host\.jpg\?v=\d+$/)
    // Neither write deleted the other's file: both URLs still resolve to a file.
    for (const url of [lookup, host, shot]) await fs.stat(cache.resolve(new URL(url!).pathname)!)
    await cache.remove('g:1', 'cover')
    expect(await fs.readdir(join(dir, 'g_1'))).toEqual(['screenshot-2-host.jpg'])
  })

  it('keeps the existing file when the new write fails', async () => {
    const cache = createImageCache({ dir, log })
    const png = join(dir, 'a.png')
    const jpg = join(dir, 'a.jpg')
    await fs.writeFile(png, Buffer.alloc(200, 1))
    await fs.writeFile(jpg, Buffer.alloc(200, 2))
    const url = await cache.importLocal('g:1', 'cover', png)
    // A folder where the tmp file would go makes `writeFile` fail (EISDIR / EEXIST), like a locked tmp file.
    await fs.mkdir(join(dir, 'g_1', `cover.jpg.${process.pid}.tmp`))
    expect(await cache.importLocal('g:1', 'cover', jpg)).toBeNull()
    expect((await fs.stat(cache.resolve(new URL(url!).pathname)!)).size).toBe(200)
    expect(await fs.readdir(join(dir, 'g_1'))).toContain('cover.png')
  })

  it('keeps custom art under its own name, out of the way of scraped writes and removals', async () => {
    const cache = createImageCache({ dir, log })
    const own = join(dir, 'own.png')
    const scraped = join(dir, 'scraped.jpg')
    await fs.writeFile(own, Buffer.alloc(200, 1))
    await fs.writeFile(scraped, Buffer.alloc(200, 2))
    const custom = await cache.importCustom('g:1', 'cover', own)
    expect(custom).toMatch(/^media:\/\/cache\/g_1\/custom-cover\.png\?v=\d+$/)
    // The cover-lane download that was in flight lands next to it and takes nothing away.
    await cache.importLocal('g:1', 'cover', scraped)
    expect((await fs.readdir(join(dir, 'g_1'))).sort()).toEqual(['cover.jpg', 'custom-cover.png'])
    await cache.remove('g:1', 'cover')
    expect(await fs.readdir(join(dir, 'g_1'))).toEqual(['custom-cover.png'])
    await cache.remove('g:1', 'cover', { custom: true })
    expect(await fs.readdir(join(dir, 'g_1'))).toEqual([])
  })

  it('retries throttled downloads (429 / 5xx) and gives up on other errors', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
      )
      .mockResolvedValueOnce(image())
      .mockResolvedValueOnce(new Response('gone', { status: 404 }))
      .mockResolvedValueOnce(new Response('NOMEDIA', { status: 200 }))
    vi.stubGlobal('fetch', mock)
    const cache = createImageCache({ dir, log })
    const url = await cache.importRemote(
      'rom:snes:a',
      'cover',
      'https://api.screenscraper.fr/api2/mediaJeu.php?jeuid=3&media=box-2D(us)&sspassword=pw'
    )
    expect(url).toMatch(/^media:\/\/cache\/rom_snes_a\/cover\.png\?v=\d+$/)
    expect(mock).toHaveBeenCalledTimes(2)
    const [, init] = mock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Headers).get('user-agent')).toMatch(/^PlayOut\//)

    expect(
      await cache.importRemote('rom:snes:a', 'hero', 'https://cdn.example/hero.jpg')
    ).toBeNull()
    expect(mock).toHaveBeenCalledTimes(3)
    // A 404 is the expected answer for a direct URL that does not exist: debug, never a warning per miss.
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('404'))
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('404'))
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('sspassword=pw'))
    expect(log.debug).not.toHaveBeenCalledWith(expect.stringContaining('sspassword=pw'))
    // ScreenScraper answers a tiny text body with 200 when the media does not exist.
    expect(
      await cache.importRemote('rom:snes:a', 'logo', 'https://cdn.example/logo.png')
    ).toBeNull()
  })

  it.each([
    [400, false],
    [404, false],
    [410, false],
    [403, true],
    [429, true],
    [503, true]
  ])('status %i tells onNetworkError: %s', async (status, told) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status, headers: { 'retry-after': '0' } }))
    )
    const onNetworkError = vi.fn()
    const cache = createImageCache({ dir, log })
    expect(
      await cache.importRemote('g:1', 'cover', 'https://cdn.example/a.jpg', undefined, {
        retries: 0,
        onNetworkError
      })
    ).toBeNull()
    expect(onNetworkError).toHaveBeenCalledTimes(told ? 1 : 0)
  })

  it('runs downloads through the policy gate so they share the API thread allowance', async () => {
    const mock = vi.fn(async () => image('image/jpeg'))
    vi.stubGlobal('fetch', mock)
    const gate = new Gate(1)
    let release!: () => void
    const held = gate.run(() => new Promise<void>((resolve) => (release = resolve)))
    const cache = createImageCache({ dir, log })
    const gated = cache.importRemote('g:1', 'cover', 'https://api.example/a.jpg', undefined, {
      gate
    })
    const free = cache.importRemote('g:1', 'hero', 'https://cdn.example/b.jpg')
    expect(await free).toMatch(/hero\.jpg/)
    await sleep(20)
    expect(mock).toHaveBeenCalledTimes(1)
    expect(gate.running).toBe(1)
    release()
    await held
    expect(await gated).toMatch(/cover\.jpg/)
    expect(mock).toHaveBeenCalledTimes(2)
    expect(gate.running).toBe(0)
  })

  it('never saves an HTML page as art when only an image will do', async () => {
    const cache = createImageCache({ dir, log })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>quota exceeded</html>'.repeat(10), {
            status: 200,
            headers: { 'content-type': 'text/html' }
          })
      )
    )
    const onNetworkError = vi.fn()
    expect(
      await cache.importSteamThumbnail('steam:1', 'k', 'https://drive/x', {
        imageOnly: true,
        onNetworkError
      })
    ).toBeNull()
    expect(onNetworkError).toHaveBeenCalledOnce()
    expect(await fs.readdir(dir)).toEqual([])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => image('image/jpeg'))
    )
    expect(
      await cache.importSteamThumbnail('steam:1', 'k', 'https://drive/x', { imageOnly: true })
    ).toMatch(/steam_1\/steam-thumb-k\.jpg/)
  })

  it('rejects traversal and unknown paths', () => {
    const cache = createImageCache({ dir, log })
    expect(cache.resolve('/../secret.txt')).toBeNull()
    expect(cache.resolve('/a/../../x')).toBeNull()
    expect(cache.resolve('')).toBeNull()
    expect(cache.resolve('/steam_620/cover.jpg')).toBe(join(dir, 'steam_620', 'cover.jpg'))
  })
})
