import { promises as fs } from 'fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renameRetry } from './fs'

function busy(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('renameRetry', () => {
  afterEach(() => vi.restoreAllMocks())

  it('rides out a short antivirus lock on Windows', async () => {
    const rename = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(busy('EPERM'))
      .mockRejectedValueOnce(busy('EBUSY'))
      .mockResolvedValueOnce(undefined)
    const sleeps: number[] = []
    await renameRetry('a', 'b', { platform: 'win32', sleep: async (ms) => void sleeps.push(ms) })
    expect(rename).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([100, 200])
  })

  it('throws other errors, other platforms and a lock that does not end', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValue(busy('ENOENT'))
    await expect(renameRetry('a', 'b', { platform: 'win32' })).rejects.toMatchObject({
      code: 'ENOENT'
    })
    vi.spyOn(fs, 'rename').mockRejectedValue(busy('EPERM'))
    await expect(renameRetry('a', 'b', { platform: 'linux' })).rejects.toMatchObject({
      code: 'EPERM'
    })
    const sleep = vi.fn(async () => undefined)
    await expect(
      renameRetry('a', 'b', { platform: 'win32', attempts: 3, sleep })
    ).rejects.toMatchObject({ code: 'EPERM' })
    expect(sleep).toHaveBeenCalledTimes(2)
  })
})
