import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  dialog: {},
  shell: {}
}))

import { createHandlers, type AppServices } from './handlers'

function services(): {
  friends: { list: ReturnType<typeof vi.fn>; message: ReturnType<typeof vi.fn> }
  handlers: ReturnType<typeof createHandlers>
} {
  const friends = {
    list: vi.fn(async () => ({ friends: [], fetchedAt: 1 })),
    message: vi.fn(async () => undefined)
  }
  return {
    friends,
    handlers: createHandlers({
      friends,
      log: { error: vi.fn(), warn: vi.fn() },
      window: { get: () => null }
    } as unknown as AppServices)
  }
}

describe('friends handlers', () => {
  it('pass a SteamID64 to Steam chat and the refresh flag to the list', async () => {
    const { friends, handlers } = services()
    await handlers.messageSteamFriend('76561198000000001')
    await handlers.getSteamFriends()
    await handlers.getSteamFriends({ refresh: true })
    expect(friends.message.mock.calls).toEqual([['76561198000000001']])
    expect(friends.list.mock.calls).toEqual([[undefined], [{ refresh: true }]])
  })

  it('refuse anything but 17 digits, so no other URI can be opened', async () => {
    const { friends, handlers } = services()
    for (const bad of [
      '',
      '7656119800000000',
      '765611980000000012',
      'steam://friends/message/76561198000000001',
      'https://example.com',
      '76561198000000001\n',
      ' 76561198000000001',
      42,
      null
    ]) {
      await expect(handlers.messageSteamFriend(bad as never)).rejects.toThrow()
    }
    expect(friends.message).not.toHaveBeenCalled()
    await expect(handlers.getSteamFriends({ refresh: 'yes' } as never)).rejects.toThrow()
    await expect(handlers.getSteamFriends({ url: 'x' } as never)).rejects.toThrow()
    expect(friends.list).not.toHaveBeenCalled()
  })
})
