import { join } from 'path'
import { pathToFileURL } from 'url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlersByChannel = new Map<
  string,
  (event: unknown, ...args: unknown[]) => Promise<unknown>
>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      handlersByChannel.set(channel, fn)
    }
  }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { API_METHODS, ipcChannel } from '../../shared/api'
import { appOrigin, isAppUrl } from '../util/app-origin'
import { registerIpc, type ApiHandlers } from './register'

// Packaged entry as window.ts loads it: <out/main>/../renderer/index.html; in this test __dirname is src/main/ipc.
const APP_URL = pathToFileURL(join(__dirname, '../renderer/index.html')).href

function event(url: string | null): unknown {
  return { senderFrame: url === null ? null : { url } }
}

function fakeHandlers(): ApiHandlers {
  const out: Record<string, unknown> = {}
  for (const m of API_METHODS) out[m] = vi.fn(async (...args: unknown[]) => ({ method: m, args }))
  return out as unknown as ApiHandlers
}

beforeEach(() => {
  handlersByChannel.clear()
})

describe('isAppUrl', () => {
  it('accepts the packaged index.html with or without a query/hash and rejects everything else', () => {
    const origin = 'file:///C:/Program%20Files/PlayOut/resources/app.asar/out/renderer/index.html'
    expect(isAppUrl(origin, origin)).toBe(true)
    expect(isAppUrl(origin + '?mock=1&screen=home', origin)).toBe(true)
    expect(isAppUrl(origin + '#/detail', origin)).toBe(true)
    expect(
      isAppUrl(
        'file:///C:/Program Files/PlayOut/resources/app.asar/out/renderer/index.html',
        origin
      )
    ).toBe(true)
    expect(isAppUrl('file:///C:/Users/me/Downloads/evil.html', origin)).toBe(false)
    expect(
      isAppUrl(
        'file:///C:/Program%20Files/PlayOut/resources/app.asar/out/renderer/other.html',
        origin
      )
    ).toBe(false)
    expect(isAppUrl('https://evil.example/', origin)).toBe(false)
    expect(isAppUrl('media://cache/abc.svg', origin)).toBe(false)
    expect(isAppUrl('about:blank', origin)).toBe(false)
    expect(isAppUrl('', origin)).toBe(false)
    expect(isAppUrl(null, origin)).toBe(false)
    expect(isAppUrl(undefined, origin)).toBe(false)
  })

  it('accepts only the dev server origin in development', () => {
    const origin = 'http://localhost:5173'
    expect(isAppUrl('http://localhost:5173/', origin)).toBe(true)
    expect(isAppUrl('http://localhost:5173/?mock=1', origin)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', origin)).toBe(false)
    expect(isAppUrl('https://localhost:5173/', origin)).toBe(false)
    expect(isAppUrl('http://localhost:5173.evil.example/', origin)).toBe(false)
    expect(isAppUrl('not a url', origin)).toBe(false)
  })

  it('defaults to the packaged renderer entry next to the main bundle', () => {
    expect(appOrigin()).toBe(APP_URL)
    expect(isAppUrl(APP_URL)).toBe(true)
    expect(isAppUrl('https://evil.example/')).toBe(false)
  })
})

describe('registerIpc', () => {
  it('dispatches invokes from the app document and rejects every other sender before the handler runs', async () => {
    const handlers = fakeHandlers()
    registerIpc(handlers)
    expect(handlersByChannel.size).toBe(API_METHODS.length)
    const getSettings = handlersByChannel.get(ipcChannel('getSettings'))!
    const launch = handlersByChannel.get(ipcChannel('launchGame'))!

    await expect(getSettings(event(APP_URL + '?mock=1'))).resolves.toEqual({
      method: 'getSettings',
      args: []
    })
    await expect(launch(event(APP_URL), 'game-1', { emulatorId: 'x' })).resolves.toEqual({
      method: 'launchGame',
      args: ['game-1', { emulatorId: 'x' }]
    })

    await expect(getSettings(event('https://evil.example/'))).rejects.toThrow('Unauthorized')
    await expect(
      launch(event('file:///C:/Users/me/Downloads/drop.html'), 'game-1')
    ).rejects.toThrow('Unauthorized')
    await expect(getSettings(event(null))).rejects.toThrow('Unauthorized')
    await expect(getSettings({})).rejects.toThrow('Unauthorized')
    expect(handlers.getSettings).toHaveBeenCalledTimes(1)
    expect(handlers.launchGame).toHaveBeenCalledTimes(1)
  })

  it('honours a custom trust predicate and still cleans handler errors', async () => {
    const handlers = fakeHandlers()
    ;(handlers.getLibrary as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('disk on fire')
    )
    registerIpc(handlers, { isTrustedSender: (url) => url === 'app://trusted' })
    const getLibrary = handlersByChannel.get(ipcChannel('getLibrary'))!
    await expect(getLibrary(event('app://trusted'))).rejects.toThrow('disk on fire')
    await expect(getLibrary(event(APP_URL))).rejects.toThrow('Unauthorized')
  })
})
