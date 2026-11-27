import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '../logger'

const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const downloadFile = vi.fn()
vi.mock('./download', () => ({ downloadFile: (...args: unknown[]) => downloadFile(...args) }))

const { ensureSevenZip, SEVEN_ZIP } = await import('./sevenzip')

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-7z-'))
  downloadFile.mockReset()
  downloadFile.mockImplementation(async (_d: unknown, to: string) => {
    await new Promise((r) => setTimeout(r, 10))
    const path = join(to, '7zr.exe')
    await fs.writeFile(path, 'downloaded')
    return path
  })
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('ensureSevenZip', () => {
  it('pins 7-Zip 26.06 from the official GitHub release', () => {
    expect(SEVEN_ZIP).toMatchObject({
      url: 'https://github.com/ip7z/7zip/releases/download/26.06/7zr.exe',
      size: 600064,
      sha256: 'e80db2dad715a6c5adabe292d31ed54e11f4e9b99ca349827b50573b175891bc'
    })
  })

  it('downloads once for concurrent callers', async () => {
    const [a, b] = await Promise.all([ensureSevenZip(dir, { log }), ensureSevenZip(dir, { log })])
    expect(a).toBe(join(dir, '7zr.exe'))
    expect(b).toBe(a)
    expect(downloadFile).toHaveBeenCalledTimes(1)
    expect(downloadFile.mock.calls[0]![0]).toBe(SEVEN_ZIP)
  })

  it('downloads again when the file on disk is not the pinned one', async () => {
    await fs.writeFile(join(dir, '7zr.exe'), 'tampered')
    await ensureSevenZip(dir, { log })
    expect(downloadFile).toHaveBeenCalledTimes(1)
  })

  it('reuses a file whose hash matches', async () => {
    const content = Buffer.from('fake 7zr')
    await fs.writeFile(join(dir, '7zr.exe'), content)
    const realSha = SEVEN_ZIP.sha256
    SEVEN_ZIP.sha256 = createHash('sha256').update(content).digest('hex')
    try {
      expect(await ensureSevenZip(dir, { log })).toBe(join(dir, '7zr.exe'))
      expect(downloadFile).not.toHaveBeenCalled()
    } finally {
      SEVEN_ZIP.sha256 = realSha
    }
  })
})
