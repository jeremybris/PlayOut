import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logger'
import { crc32Update } from '../util/hash'
import {
  ensureGithubTool,
  findToolFile,
  readInstalledTool,
  sha256FromDigest,
  type GithubToolOptions
} from './tools'

const log: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

/** A stored (uncompressed) zip of the given files. */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const nameBuf = Buffer.from(name)
    const crc = crc32Update(0, data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const dir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(dir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, eocd])
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

interface FakeServer {
  fetch: typeof fetch
  calls: string[]
}

/** GitHub's API and download host, answering from memory. */
function fakeGithub(opts: {
  zip: Buffer
  tag?: string
  digest?: string | null
  apiStatus?: number
  assetName?: string
}): FakeServer {
  const calls: string[] = []
  const tag = opts.tag ?? 'v1.0.0'
  const name = opts.assetName ?? 'Tool-x64.zip'
  const fn = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith('https://api.github.com/')) {
      if (opts.apiStatus) return new Response('rate limited', { status: opts.apiStatus })
      return Response.json({
        tag_name: tag,
        assets: [
          { name: 'Tool-arm64.zip', browser_download_url: 'https://dl/arm', size: 1 },
          {
            name,
            browser_download_url: `https://dl/${name}`,
            size: opts.zip.length,
            digest: opts.digest === undefined ? `sha256:${sha(opts.zip)}` : opts.digest
          }
        ]
      })
    }
    if (url.includes(name))
      return new Response(new Uint8Array(opts.zip), {
        headers: { 'content-length': String(opts.zip.length) }
      })
    return new Response('not found', { status: 404 })
  }
  return { fetch: fn as typeof fetch, calls }
}

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-tools-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function options(server: FakeServer, extra: Partial<GithubToolOptions> = {}): GithubToolOptions {
  return {
    root,
    repo: 'owner/tool',
    assetPattern: /^Tool-x64\.zip$/,
    fetch: server.fetch,
    log,
    ...extra
  }
}

describe('ensureGithubTool', () => {
  const zip = makeZip({ 'Tool/tool.exe': 'exe', 'Tool/readme.txt': 'hi' })

  it('downloads, verifies against the API digest, extracts and records the release', async () => {
    const server = fakeGithub({ zip })
    const progress: number[] = []
    const installed = await ensureGithubTool(
      options(server, { onProgress: (done) => progress.push(done) })
    )
    expect(installed.tag).toBe('v1.0.0')
    expect(installed.sha256).toBe(sha(zip))
    expect(installed.dir).toBe(join(root, 'v1.0.0'))
    expect(await fs.readFile(join(installed.dir, 'Tool', 'tool.exe'), 'utf8')).toBe('exe')
    expect(progress.at(-1)).toBe(zip.length)
    expect(server.calls[0]).toBe('https://api.github.com/repos/owner/tool/releases/latest')
    const marker = JSON.parse(await fs.readFile(join(root, 'installed.json'), 'utf8'))
    expect(marker).toMatchObject({ tag: 'v1.0.0', asset: 'Tool-x64.zip', sha256: sha(zip) })
    // No zip or staging folder is left behind.
    expect((await fs.readdir(root)).sort()).toEqual(['installed.json', 'v1.0.0'])
  })

  it('does nothing when the release is already installed', async () => {
    const server = fakeGithub({ zip })
    await ensureGithubTool(options(server))
    const again = await ensureGithubTool(options(server))
    expect(again.tag).toBe('v1.0.0')
    expect(server.calls).toHaveLength(2)
  })

  it('shares one download between callers', async () => {
    const server = fakeGithub({ zip })
    const [a, b] = await Promise.all([
      ensureGithubTool(options(server)),
      ensureGithubTool(options(server))
    ])
    expect(a).toEqual(b)
    expect(server.calls.filter((u) => u.startsWith('https://dl/'))).toHaveLength(1)
  })

  it('downloads again when the required file is gone from the installed release', async () => {
    const server = fakeGithub({ zip })
    const first = await ensureGithubTool(options(server, { requiredFile: 'tool.exe' }))
    // What Windows Defender quarantining the exe looks like: marker and folder stay.
    await fs.rm(join(first.dir, 'Tool', 'tool.exe'))
    const again = await ensureGithubTool(options(server, { requiredFile: 'tool.exe' }))
    expect(await fs.readFile(join(again.dir, 'Tool', 'tool.exe'), 'utf8')).toBe('exe')
    expect(server.calls.filter((u) => u.startsWith('https://dl/'))).toHaveLength(2)
    // While it is there, nothing is downloaded.
    await ensureGithubTool(options(server, { requiredFile: 'tool.exe' }))
    expect(server.calls.filter((u) => u.startsWith('https://dl/'))).toHaveLength(2)
  })

  it('asks for the pinned tag and replaces an older release', async () => {
    const old = fakeGithub({ zip, tag: 'v0.9' })
    await ensureGithubTool(options(old))
    const server = fakeGithub({ zip, tag: 'v1.0.0' })
    const installed = await ensureGithubTool(
      options(server, { pinnedTag: 'v1.0.0', expectedSha256: sha(zip) })
    )
    expect(server.calls[0]).toBe('https://api.github.com/repos/owner/tool/releases/tags/v1.0.0')
    expect(installed.tag).toBe('v1.0.0')
    expect(await readInstalledTool(root)).toMatchObject({ tag: 'v1.0.0' })
    expect(await fs.readdir(root)).not.toContain('v0.9')
  })

  it('refuses a download whose checksum does not match', async () => {
    const server = fakeGithub({ zip })
    await expect(
      ensureGithubTool(options(server, { expectedSha256: 'a'.repeat(64) }))
    ).rejects.toThrow(/different checksum/)
    const noDigest = fakeGithub({ zip, digest: 'sha256:' + 'b'.repeat(64) })
    await expect(ensureGithubTool(options(noDigest))).rejects.toThrow(/checksum mismatch/)
    expect(await readInstalledTool(root)).toBeNull()
    expect(await fs.readdir(root)).toEqual([])
  })

  it('refuses to install without any checksum', async () => {
    const server = fakeGithub({ zip, digest: null })
    await expect(ensureGithubTool(options(server))).rejects.toThrow(/no checksum/)
  })

  it('falls back to the pinned download when the API is unavailable', async () => {
    const server = fakeGithub({ zip, apiStatus: 403 })
    const installed = await ensureGithubTool(
      options(server, {
        pinnedTag: 'v1.0.0',
        pinnedAsset: 'Tool-x64.zip',
        expectedSha256: sha(zip)
      })
    )
    expect(installed.tag).toBe('v1.0.0')
    expect(server.calls[1]).toBe(
      'https://github.com/owner/tool/releases/download/v1.0.0/Tool-x64.zip'
    )
  })

  it('reports a failed lookup without a pinned fallback', async () => {
    const server = fakeGithub({ zip, apiStatus: 500 })
    await expect(ensureGithubTool(options(server))).rejects.toThrow(/HTTP 500/)
  })

  it('refuses a release tag that is not a plain folder name', async () => {
    const server = fakeGithub({ zip, tag: '../evil' })
    await expect(ensureGithubTool(options(server))).rejects.toThrow(/unusable release tag/)
  })
})

describe('helpers', () => {
  it('reads GitHub digests', () => {
    expect(sha256FromDigest('sha256:' + 'AB'.repeat(32))).toBe('ab'.repeat(32))
    expect(sha256FromDigest('sha512:abc')).toBeNull()
    expect(sha256FromDigest(null)).toBeNull()
  })

  it('finds a file at any of the first levels, case-insensitively', async () => {
    await fs.mkdir(join(root, 'a', 'b'), { recursive: true })
    await fs.writeFile(join(root, 'a', 'b', 'Moonlight.exe'), '')
    expect(await findToolFile(root, 'moonlight.exe')).toBe(join(root, 'a', 'b', 'Moonlight.exe'))
    expect(await findToolFile(root, 'moonlight.exe', 1)).toBeNull()
  })

  it('ignores a marker whose folder is gone', async () => {
    await fs.writeFile(join(root, 'installed.json'), JSON.stringify({ tag: 'v1' }))
    expect(await readInstalledTool(root)).toBeNull()
  })
})
