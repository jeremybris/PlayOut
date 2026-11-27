import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  digestHex,
  ensurePeerParty,
  hashFile,
  parseChecksum,
  readInstallRecord,
  RELEASES_LATEST,
  UPDATE_CHECK_MS
} from './release'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

describe('parseChecksum', () => {
  const x = sha('exe')
  it('reads both checksum forms', () => {
    expect(parseChecksum(`${x}  peerparty.exe\n`, 'peerparty.exe')).toEqual({ sha256: x })
    expect(parseChecksum(`${x.toUpperCase()}  *dist/PeerParty.exe\r\n`, 'peerparty.exe')).toEqual({
      sha256: x
    })
    expect(parseChecksum(`${x}\n`, 'peerparty.exe')).toEqual({ sha256: x })
    expect(parseChecksum(`${sha('n')}  NOTES.md\n${x}  peerparty.exe\n`, 'peerparty.exe')).toEqual({
      sha256: x
    })
    expect(
      parseChecksum(
        `peerparty-release 1\nversion 0.2.0\nfile peerparty.exe\nsize 1234\nsha256 ${x}\n`,
        'peerparty.exe'
      )
    ).toEqual({ sha256: x, size: 1234 })
  })

  it('refuses checksums for other files or none', () => {
    expect(parseChecksum(`${x}  other.exe\n`, 'peerparty.exe')).toBeNull()
    expect(parseChecksum(`file other.exe\nsha256 ${x}\n`, 'peerparty.exe')).toBeNull()
    expect(parseChecksum('sha256 1234\n', 'peerparty.exe')).toBeNull()
    expect(parseChecksum('<html>Not Found</html>', 'peerparty.exe')).toBeNull()
    expect(parseChecksum('', 'peerparty.exe')).toBeNull()
  })

  it("reads GitHub's digest", () => {
    expect(digestHex(`sha256:${x.toUpperCase()}`)).toBe(x)
    expect(digestHex('md5:abc')).toBeNull()
    expect(digestHex(null)).toBeNull()
  })
})

describe('ensurePeerParty', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const scratch = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'playout-pp-release-'))
    dirs.push(d)
    return join(d, 'PeerParty')
  }
  const exeBytes = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(5000, 7)])
  /** Download files left in the folder. */
  const leftovers = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.download')) : []

  it('hashes the file on disk', async () => {
    const dir = scratch()
    rmSync(dir, { recursive: true, force: true })
    const file = `${dir}.bin`
    writeFileSync(file, exeBytes)
    expect(await hashFile(file)).toEqual({
      sha: sha(exeBytes),
      size: exeBytes.length,
      head: Buffer.from('MZ')
    })
  })

  it('gives each download its own file, so two at once both install checked bytes', async () => {
    const dir = scratch()
    const deps = { dir, log, busy: () => false, fetch: github({}) }
    const [a, b] = await Promise.all([ensurePeerParty(deps), ensurePeerParty(deps)])
    expect(a.tag).toBe('v0.5.1')
    expect(b.tag).toBe('v0.5.1')
    expect(readFileSync(join(dir, 'peerparty.exe'))).toEqual(exeBytes)
    expect(leftovers(dir)).toEqual([])
  })

  function github(options: {
    tag?: string
    exe?: Buffer
    checksum?: string | null
    digest?: string | null
    size?: number
  }): typeof fetch & { calls: string[] } {
    const exe = options.exe ?? exeBytes
    const calls: string[] = []
    const assets = [
      {
        name: 'peerparty.exe',
        browser_download_url: 'https://dl/peerparty.exe',
        size: options.size ?? exe.length,
        digest: options.digest === undefined ? `sha256:${sha(exe)}` : options.digest
      },
      ...(options.checksum === null
        ? []
        : [
            {
              name: 'peerparty.exe.sha256',
              browser_download_url: 'https://dl/peerparty.exe.sha256',
              size: 80
            }
          ])
    ]
    const http = (async (url: string) => {
      calls.push(url)
      if (url === RELEASES_LATEST)
        return new Response(JSON.stringify({ tag_name: options.tag ?? 'v0.5.1', assets }))
      if (url.endsWith('.sha256'))
        return new Response(options.checksum ?? `${sha(exe)}  peerparty.exe\n`)
      if (url.endsWith('peerparty.exe')) return new Response(new Uint8Array(exe))
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch & { calls: string[] }
    http.calls = calls
    return http
  }

  it('downloads, checks and installs the latest release, then trusts it for a day', async () => {
    const dir = scratch()
    const progress: string[] = []
    let now = Date.parse('2026-11-24T10:00:00Z')
    const http = github({})
    const deps = {
      dir,
      log,
      busy: () => false,
      fetch: http,
      now: () => now,
      onProgress: (p: { phase: string }) => progress.push(p.phase)
    }
    expect(await ensurePeerParty(deps, { gameId: 'g' })).toEqual({
      exe: join(dir, 'peerparty.exe'),
      tag: 'v0.5.1'
    })
    expect(readFileSync(join(dir, 'peerparty.exe'))).toEqual(exeBytes)
    expect(leftovers(dir)).toEqual([])
    expect(progress).toEqual(['checking', 'downloading', 'verifying', 'installing'])
    expect((await readInstallRecord(dir))?.sha256).toBe(sha(exeBytes))
    http.calls.length = 0
    now += UPDATE_CHECK_MS - 1
    await ensurePeerParty(deps)
    expect(http.calls).toEqual([])
    now += 2
    await ensurePeerParty(deps)
    expect(http.calls).toEqual([RELEASES_LATEST])
  })

  it('refuses a download whose hash or size does not match, or that is not a program', async () => {
    const dir = scratch()
    const bad = (o: Parameters<typeof github>[0]): ReturnType<typeof ensurePeerParty> =>
      ensurePeerParty({ dir, log, busy: () => false, fetch: github(o) })
    await expect(bad({ checksum: `${sha('other')}  peerparty.exe` })).rejects.toThrow(
      /failed its check/
    )
    await expect(bad({ digest: `sha256:${sha('other')}` })).rejects.toThrow(/GitHub/)
    await expect(bad({ size: 10 })).rejects.toThrow(/bytes/)
    const notExe = Buffer.from('not a program')
    await expect(bad({ exe: notExe })).rejects.toThrow(/Windows program/)
    expect(existsSync(join(dir, 'peerparty.exe'))).toBe(false)
    expect(leftovers(dir)).toEqual([])
  })

  it('accepts the digest alone, and refuses when nothing can check the download', async () => {
    const dir = scratch()
    await expect(
      ensurePeerParty({
        dir,
        log,
        busy: () => false,
        fetch: github({ checksum: null, digest: null })
      })
    ).rejects.toThrow('Could not check the PeerParty download')
    expect(
      (await ensurePeerParty({ dir, log, busy: () => false, fetch: github({ checksum: null }) }))
        .tag
    ).toBe('v0.5.1')
  })

  it('updates only while no PeerParty runs, and keeps the old copy offline or on a bad update', async () => {
    const dir = scratch()
    await ensurePeerParty({ dir, log, busy: () => false, fetch: github({}) })
    const newer = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 9)])
    const busyRun = await ensurePeerParty(
      { dir, log, busy: () => true, fetch: github({ tag: 'v0.6.0', exe: newer }) },
      { force: true }
    )
    expect(busyRun.tag).toBe('v0.5.1')
    expect(readFileSync(join(dir, 'peerparty.exe'))).toEqual(exeBytes)
    const offline = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(
      (await ensurePeerParty({ dir, log, busy: () => false, fetch: offline }, { force: true })).tag
    ).toBe('v0.5.1')
    const badUpdate = await ensurePeerParty(
      {
        dir,
        log,
        busy: () => false,
        fetch: github({ tag: 'v0.6.0', exe: newer, checksum: `${sha('x')}  peerparty.exe` })
      },
      { force: true }
    )
    expect(badUpdate.tag).toBe('v0.5.1')
    expect(readFileSync(join(dir, 'peerparty.exe'))).toEqual(exeBytes)
    const good = await ensurePeerParty(
      { dir, log, busy: () => false, fetch: github({ tag: 'v0.6.0', exe: newer }) },
      { force: true }
    )
    expect(good.tag).toBe('v0.6.0')
    expect(readFileSync(join(dir, 'peerparty.exe'))).toEqual(newer)
    expect(existsSync(join(dir, 'peerparty.exe.old'))).toBe(false)
  })

  it('fails without a copy when GitHub cannot be reached', async () => {
    const dir = scratch()
    const offline = (async () =>
      new Response('{"message":"API rate limit exceeded"}', {
        status: 403
      })) as unknown as typeof fetch
    await expect(ensurePeerParty({ dir, log, busy: () => false, fetch: offline })).rejects.toThrow(
      /limiting requests/
    )
  })
})
