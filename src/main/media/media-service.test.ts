import { describe, expect, it, vi } from 'vitest'
import type { MediaSession } from '@shared/overlay'
import type { Settings } from '@shared/types'
import { createMediaService, CONTROL_SETTLE_MS, type MediaNative } from './media-service'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const playing: MediaSession = {
  app: 'Spotify.exe',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  status: 'playing',
  canNext: true,
  canPrevious: true
}

function settingsWith(folder: string | null): { get(): Settings } {
  return { get: () => ({ music: { folder, gameStart: 'keep', volume: 0.6 } }) as Settings }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the vi.fn mock types are the point
function make(native: Partial<MediaNative>, folder: string | null = null) {
  const wait = vi.fn(async () => {})
  const listMusic = vi.fn(async () => [{ path: 'a/b.mp3', title: 'b', folder: 'a' }])
  const svc = createMediaService({
    native: {
      mediaSession: async () => null,
      mediaControl: async () => {},
      ...native
    },
    settings: settingsWith(folder),
    log,
    wait,
    listMusic
  })
  return { svc, wait, listMusic }
}

describe('media service', () => {
  it('reads the session, null when the host fails', async () => {
    expect(await make({ mediaSession: async () => playing }).svc.session()).toEqual(playing)
    const failing = make({
      mediaSession: async () => {
        throw new Error('host down')
      }
    })
    expect(await failing.svc.session()).toBeNull()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('host down'))
  })

  it('sends the command, waits for the app, then re-reads', async () => {
    const order: string[] = []
    const { svc, wait } = make({
      mediaControl: async (a) => {
        order.push(`control ${a}`)
      },
      mediaSession: async () => {
        order.push('read')
        return { ...playing, status: 'paused' }
      }
    })
    wait.mockImplementation(async () => {
      order.push('wait')
    })
    expect((await svc.control('toggle'))?.status).toBe('paused')
    expect(order).toEqual(['control toggle', 'wait', 'read'])
    expect(wait).toHaveBeenCalledWith(CONTROL_SETTLE_MS)
  })

  it('still answers with the session when the command fails', async () => {
    const { svc } = make({
      mediaControl: async () => {
        throw new Error('no session')
      },
      mediaSession: async () => playing
    })
    expect(await svc.control('next')).toEqual(playing)
  })

  it('lists the music folder, none without one', async () => {
    const none = make({})
    expect(await none.svc.library()).toEqual({ folder: null, tracks: [] })
    expect(none.listMusic).not.toHaveBeenCalled()

    const some = make({}, 'D:\\Music')
    expect(await some.svc.library()).toEqual({
      folder: 'D:\\Music',
      tracks: [{ path: 'a/b.mp3', title: 'b', folder: 'a' }]
    })
    expect(some.listMusic).toHaveBeenCalledWith('D:\\Music')
  })

  it('gives an empty list when the scan fails', async () => {
    const { svc, listMusic } = make({}, 'X:\\Gone')
    listMusic.mockRejectedValueOnce(new Error('denied'))
    expect(await svc.library()).toEqual({ folder: 'X:\\Gone', tracks: [] })
  })

  it('waits for real by default', async () => {
    vi.useFakeTimers()
    try {
      const reads = vi.fn(async () => playing)
      const svc = createMediaService({
        native: { mediaSession: reads, mediaControl: async () => {} },
        settings: settingsWith(null),
        log
      })
      const p = svc.control('play')
      await vi.advanceTimersByTimeAsync(CONTROL_SETTLE_MS - 1)
      expect(reads).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(await p).toEqual(playing)
    } finally {
      vi.useRealTimers()
    }
  })
})
