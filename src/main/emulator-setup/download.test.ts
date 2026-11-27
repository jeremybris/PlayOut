import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logger'
import {
  downloadFile,
  fetchJson,
  fetchText,
  safeFileName,
  USER_AGENT,
  type HttpDeps
} from './download'

const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

interface Call {
  url: string
  headers: Record<string, string>
}

/** A fetch answering from a list of handlers, one per call (the last repeats). */
function fakeFetch(handlers: ((url: string) => Response | Promise<Response>)[]): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } })
    const h = handlers[Math.min(calls.length - 1, handlers.length - 1)]!
    return h(url)
  }
  return { fetch: fn as typeof fetch, calls }
}

const deps = (f: typeof fetch, extra: Partial<HttpDeps> = {}): HttpDeps => ({
  fetch: f,
  log,
  retryDelayMs: 0,
  ...extra
})

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-dl-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const body = Buffer.from('emulator archive bytes')
const ok = (): Response =>
  new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } })

describe('downloadFile', () => {
  it('streams, verifies the hash and size, and renames into place', async () => {
    const f = fakeFetch([ok])
    const progress: [number, number][] = []
    const path = await downloadFile(
      {
        version: '1',
        url: 'https://host/a.7z',
        fileName: 'a.7z',
        sha256: sha(body).toUpperCase(),
        size: body.length
      },
      dir,
      deps(f.fetch),
      (done, total) => progress.push([done, total])
    )
    expect(path).toBe(join(dir, 'a.7z'))
    expect(await fs.readFile(path)).toEqual(body)
    expect(progress.at(-1)).toEqual([body.length, body.length])
    expect(await fs.readdir(dir)).toEqual(['a.7z'])
    expect(f.calls[0]!.headers['User-Agent']).toBe(USER_AGENT)
    expect(USER_AGENT).not.toMatch(/Mozilla/)
  })

  it('rejects a checksum mismatch without retrying and leaves no .part', async () => {
    const f = fakeFetch([ok])
    await expect(
      downloadFile(
        { version: '1', url: 'https://host/a.7z', fileName: 'a.7z', sha256: '0'.repeat(64) },
        dir,
        deps(f.fetch)
      )
    ).rejects.toThrow(/checksum mismatch/)
    expect(f.calls).toHaveLength(1)
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('rejects a size mismatch', async () => {
    const f = fakeFetch([ok])
    await expect(
      downloadFile(
        { version: '1', url: 'https://host/a.7z', fileName: 'a.7z', size: 3 },
        dir,
        deps(f.fetch)
      )
    ).rejects.toThrow(/expected 3/)
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('retries 5xx and network errors, then succeeds', async () => {
    const f = fakeFetch([
      () => new Response('busy', { status: 503 }),
      () => {
        throw new TypeError('fetch failed')
      },
      ok
    ])
    const path = await downloadFile(
      { version: '1', url: 'https://host/a.zip', fileName: 'a.zip' },
      dir,
      deps(f.fetch)
    )
    expect(f.calls).toHaveLength(3)
    expect(await fs.readFile(path)).toEqual(body)
  })

  it('gives up after three attempts', async () => {
    const f = fakeFetch([() => new Response('down', { status: 500 })])
    await expect(
      downloadFile(
        { version: '1', url: 'https://host/a.zip', fileName: 'a.zip' },
        dir,
        deps(f.fetch)
      )
    ).rejects.toThrow(/HTTP 500/)
    expect(f.calls).toHaveLength(3)
  })

  it('does not retry a 404', async () => {
    const f = fakeFetch([() => new Response('gone', { status: 404 })])
    await expect(
      downloadFile(
        { version: '1', url: 'https://host/a.zip', fileName: 'a.zip' },
        dir,
        deps(f.fetch)
      )
    ).rejects.toThrow(/HTTP 404 from host/)
    expect(f.calls).toHaveLength(1)
  })

  it('refuses http URLs, also after a redirect', async () => {
    const f = fakeFetch([ok])
    await expect(
      downloadFile(
        { version: '1', url: 'http://host/a.zip', fileName: 'a.zip' },
        dir,
        deps(f.fetch)
      )
    ).rejects.toThrow(/non-https/)
    expect(f.calls).toHaveLength(0)
    const redirected = fakeFetch([
      () => {
        const res = ok()
        Object.defineProperty(res, 'url', { value: 'http://evil/a.zip' })
        return res
      }
    ])
    await expect(
      downloadFile(
        { version: '1', url: 'https://host/a.zip', fileName: 'a.zip' },
        dir,
        deps(redirected.fetch)
      )
    ).rejects.toThrow(/non-https/)
    expect(redirected.calls).toHaveLength(1)
  })

  it('sanitizes the file name', async () => {
    const f = fakeFetch([ok])
    const path = await downloadFile(
      { version: '1', url: 'https://host/a.zip', fileName: '..\\..\\evil/x:y.zip' },
      dir,
      deps(f.fetch)
    )
    expect(path).toBe(join(dir, 'x_y.zip'))
    expect(safeFileName('../..')).toBe('download')
  })

  it('honors a cancelled signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const f = fakeFetch([
      () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
    ])
    await expect(
      downloadFile(
        { version: '1', url: 'https://host/a.zip', fileName: 'a.zip' },
        dir,
        deps(f.fetch, { signal: controller.signal })
      )
    ).rejects.toThrow()
    expect(f.calls).toHaveLength(1)
    expect(await fs.readdir(dir)).toEqual([])
  })
})

describe('fetchJson / fetchText', () => {
  it('sends the GitHub Accept header to the GitHub API only', async () => {
    const f = fakeFetch([() => Response.json({ a: 1 })])
    expect(
      await fetchJson<{ a: number }>(
        'https://api.github.com/repos/x/y/releases/latest',
        deps(f.fetch)
      )
    ).toEqual({ a: 1 })
    expect(f.calls[0]!.headers.Accept).toBe('application/vnd.github+json')
    await fetchJson('https://dolphin-emu.org/update/latest/beta/', deps(f.fetch))
    expect(f.calls[1]!.headers.Accept).toBeUndefined()
  })

  it('names GitHub rate limiting', async () => {
    const f = fakeFetch([
      () => new Response('limit', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
    ])
    await expect(
      fetchJson('https://api.github.com/repos/x/y/releases/latest', deps(f.fetch))
    ).rejects.toThrow(/rate limit/)
    expect(f.calls).toHaveLength(1)
  })

  it('fetches text and refuses http', async () => {
    const f = fakeFetch([() => new Response('<html>')])
    expect(await fetchText('https://buildbot.libretro.com/stable/', deps(f.fetch))).toBe('<html>')
    await expect(fetchText('http://buildbot.libretro.com/stable/', deps(f.fetch))).rejects.toThrow(
      /non-https/
    )
  })
})
