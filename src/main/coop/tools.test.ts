import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureTools, PINNED_RELEASE_TAG, toolsReady } from './tools'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'playout-coop-tools-'))
  log.warn.mockClear()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(answer: (url: string) => Response): { urls: string[]; done: Promise<void> } {
  const urls: string[] = []
  const fake = (async (url: string) => {
    urls.push(url)
    return answer(url)
  }) as typeof fetch
  const done = ensureTools({
    root: join(dir, 'engine'),
    workDir: dir,
    log: log as never,
    fetch: fake
  })
  return { urls, done }
}

describe('Co-Op tools: the Nucleus Co-op release', () => {
  it('says so when GitHub limits requests, instead of reading the error as a release', async () => {
    const { urls, done } = run(() =>
      json({ message: 'API rate limit exceeded for 203.0.113.7.', documentation_url: 'x' }, 403)
    )
    await expect(done).rejects.toThrow(/GitHub is limiting requests.*HTTP 403/)
    // Nothing else was asked for, and nothing is marked as installed.
    expect(urls).toHaveLength(1)
    expect(await toolsReady(join(dir, 'engine'))).toBe(false)
  })

  it('reports another failed answer with its status and message', async () => {
    await expect(run(() => json({ message: 'Server Error' }, 500)).done).rejects.toThrow(
      'the Nucleus Co-op release could not be looked up (HTTP 500: Server Error)'
    )
    await expect(run(() => new Response('<html>', { status: 502 })).done).rejects.toThrow(
      'the Nucleus Co-op release could not be looked up (HTTP 502)'
    )
    await expect(run(() => json({ message: 'odd' })).done).rejects.toThrow(/could not be read/)
  })

  it('asks for the release the helper is built for, the latest only when that one is gone', async () => {
    const pinned = run(() => json({ tag_name: PINNED_RELEASE_TAG, assets: [] }))
    await expect(pinned.done).rejects.toThrow('the Nucleus Co-op release has no app package')
    expect(pinned.urls).toHaveLength(1)
    expect(pinned.urls[0]).toMatch(new RegExp(`/releases/tags/${PINNED_RELEASE_TAG}$`))

    const gone = run((url) =>
      url.endsWith('/latest') ? json({ tag_name: 'v9', assets: [] }) : json({}, 404)
    )
    await expect(gone.done).rejects.toThrow('the Nucleus Co-op release has no app package')
    expect(gone.urls.map((u) => u.split('/releases/')[1])).toEqual([
      `tags/${PINNED_RELEASE_TAG}`,
      'latest'
    ])
    expect(log.warn).toHaveBeenCalledTimes(1)
  })
})
