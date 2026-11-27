import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  handler: null as ((request: { url: string }) => Promise<Response>) | null
}))

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  net: { fetch: async () => new Response('image', { status: 200 }) },
  protocol: {
    registerSchemesAsPrivileged: () => {},
    handle: (_scheme: string, handler: (request: { url: string }) => Promise<Response>) => {
      electron.handler = handler
    }
  }
}))

import { installMediaProtocol, remoteMediaParts } from './media-protocol'

describe('media://remote/... (a paired host’s art)', () => {
  const cached = 'C:\\data\\media-cache\\h1\\abc-cover.v1700000000000.png'
  const asked: (string | undefined)[] = []
  const get = async (url: string): Promise<Response> => electron.handler!({ url })

  beforeEach(() => {
    asked.length = 0
    installMediaProtocol(
      () => 'C:\\data\\media\\steam_1\\cover.png',
      async (_hostId, _hostGameId, kind, rev) => {
        asked.push(rev)
        return kind === 'cover' ? cached : null
      }
    )
  })

  it('reads the three parts of the path', () => {
    expect(remoteMediaParts('/h1/rom%3Aps3%3Assx/cover')).toEqual({
      hostId: 'h1',
      hostGameId: 'rom:ps3:ssx',
      kind: 'cover'
    })
    expect(remoteMediaParts('/h1/cover')).toBeNull()
  })

  it('lets the image of the revision asked for be kept for good', async () => {
    const response = await get('media://remote/h1/steam%3A1/cover?v=1700000000000')
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(asked).toEqual(['1700000000000'])
    // An older host names no revision: the file first fetched is the image.
    const plain = await get('media://remote/h1/steam%3A1/cover')
    expect(plain.headers.get('Cache-Control')).toContain('immutable')
    const own = await get('media://cache/steam_1/cover.png?v=5')
    expect(own.headers.get('Cache-Control')).toContain('immutable')
  })

  it('does not let an earlier revision’s image stay bound to the new revision’s address', async () => {
    // The host could not be reached: the streaming service hands out the file of the revision before.
    const response = await get('media://remote/h1/steam%3A1/cover?v=1800000000000')
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect((await get('media://remote/h1/steam%3A1/hero?v=1')).status).toBe(404)
  })
})
