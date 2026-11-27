import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compareVersions,
  downloadPackage,
  fetchUpdateList,
  installedVersion,
  isSonyPackageUrl,
  packageSha1,
  parseUpdateList,
  pendingPackages,
  rpcs3Dev0,
  updateListUrl,
  type FileFetch,
  type Ps3UpdatePackage,
  type TextGet
} from './ps3-updates'

const SAMPLE = `<?xml version='1.0' encoding='UTF-8'?><titlepatch status="alive" titleid="BCUS98174"><tag name="BCUS98174_T11" popup="true" signoff="true" popup_delay="15000000"><package version="01.11" size="284414928" sha1sum="5f978c88721962b54f5b12053ee06f896ef3b4a1" url="http://b0.ww.np.dl.playstation.net/tppkg/np/BCUS98174/BCUS98174_T11/e5171f7aa057da9a/UP9000-BCUS98174_00-LASTOFUSPATCH111-A0111-V0100-PE.pkg" ps3_system_ver="04.4000"><paramsfo><TITLE>The Last of Us 1.11</TITLE></paramsfo></package></tag></titlepatch>`

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const URL_OK = 'http://b0.ww.np.dl.playstation.net/tppkg/np/X/x.pkg'

function list(titleId: string, packages: string): string {
  return `<?xml version="1.0"?><titlepatch titleid="${titleId}"><tag name="t">${packages}</tag></titlepatch>`
}

function pkgTag(attrs: Record<string, string>): string {
  return `<package ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')}/>`
}

/** A PARAM.SFO with these string entries (format 0x0204, utf8 with a trailing null). */
function sfo(entries: Record<string, string>): Buffer {
  const keys = Object.keys(entries)
  const keyTable = Buffer.from(keys.map((k) => `${k}\0`).join(''), 'latin1')
  const values = keys.map((k) => Buffer.from(`${entries[k]}\0`, 'latin1'))
  const indexSize = 16 * keys.length
  const keyStart = 20 + indexSize
  const dataStart = keyStart + keyTable.length
  const header = Buffer.alloc(20)
  header.writeUInt32BE(0x00505346, 0)
  header.writeUInt32LE(0x0101, 4)
  header.writeUInt32LE(keyStart, 8)
  header.writeUInt32LE(dataStart, 12)
  header.writeUInt32LE(keys.length, 16)
  const index = Buffer.alloc(indexSize)
  let keyOffset = 0
  let dataOffset = 0
  keys.forEach((k, i) => {
    index.writeUInt16LE(keyOffset, i * 16)
    index.writeUInt16LE(0x0204, i * 16 + 2)
    index.writeUInt32LE(values[i].length, i * 16 + 4)
    index.writeUInt32LE(values[i].length, i * 16 + 8)
    index.writeUInt32LE(dataOffset, i * 16 + 12)
    keyOffset += k.length + 1
    dataOffset += values[i].length
  })
  return Buffer.concat([header, index, keyTable, ...values])
}

/** A fake PKG: `body` and a 32-byte trailer starting with the body's SHA-1 (as a real PKG stores it). */
function fakePkg(body: Buffer): { bytes: Buffer; sha1: string } {
  const sha1 = createHash('sha1').update(body).digest('hex')
  const trailer = Buffer.alloc(32)
  Buffer.from(sha1, 'hex').copy(trailer)
  return { bytes: Buffer.concat([body, trailer]), sha1 }
}

/** A fetch answering `bytes` as a stream, in chunks. */
function streamingFetch(bytes: Buffer, status = 200): ReturnType<typeof vi.fn> & FileFetch {
  return vi.fn(async () => {
    const chunks: Buffer[] = []
    for (let i = 0; i < bytes.length; i += 256) chunks.push(bytes.subarray(i, i + 256))
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift()
        if (next) controller.enqueue(new Uint8Array(next))
        else controller.close()
      }
    })
    return new Response(body, { status })
  }) as unknown as ReturnType<typeof vi.fn> & FileFetch
}

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-ps3-updates-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('parseUpdateList', () => {
  it("reads Sony's real update list", () => {
    expect(parseUpdateList(SAMPLE, 'BCUS98174')).toEqual([
      {
        version: '01.11',
        size: 284414928,
        sha1: '5f978c88721962b54f5b12053ee06f896ef3b4a1',
        url: 'http://b0.ww.np.dl.playstation.net/tppkg/np/BCUS98174/BCUS98174_T11/e5171f7aa057da9a/UP9000-BCUS98174_00-LASTOFUSPATCH111-A0111-V0100-PE.pkg',
        systemVersion: '04.4000'
      }
    ])
    // The title id is compared without regard to case.
    expect(parseUpdateList(SAMPLE, 'bcus98174')).toHaveLength(1)
  })

  it("lists nothing for another title's list, an empty one or garbage", () => {
    expect(parseUpdateList(SAMPLE, 'BLUS30443')).toEqual([])
    expect(parseUpdateList('', 'BCUS98174')).toEqual([])
    expect(parseUpdateList('<html>Not found</html>', 'BCUS98174')).toEqual([])
    expect(parseUpdateList('\u0000\u0001 garbage <<<>>>', 'BCUS98174')).toEqual([])
    expect(parseUpdateList(list('BCUS98174', ''), 'BCUS98174')).toEqual([])
  })

  it('skips packages with a bad sha1, url, version or size', () => {
    const good = { version: '01.02', size: '100', sha1sum: SHA_A, url: URL_OK }
    const xml = list(
      'BLUS30443',
      [
        pkgTag(good),
        pkgTag({ ...good, version: '01.03', sha1sum: 'xyz' }),
        pkgTag({ ...good, version: '01.04', sha1sum: SHA_A.slice(1) }),
        pkgTag({ ...good, version: '01.05', url: 'http://evil.example.com/x.pkg' }),
        pkgTag({ ...good, version: '01.06', url: 'http://b0.ww.np.dl.playstation.net/x.exe' }),
        pkgTag({ ...good, version: '01.07', url: 'not a url' }),
        pkgTag({ ...good, version: 'one' }),
        pkgTag({ ...good, version: '1.2.3' }),
        pkgTag({ ...good, version: '01.08', size: '32' }),
        pkgTag({ ...good, version: '01.09', size: 'big' })
      ].join('')
    )
    expect(parseUpdateList(xml, 'BLUS30443').map((p) => p.version)).toEqual(['01.02'])
    // No ps3_system_ver: null; an upper-case sha1 is lowered.
    expect(
      parseUpdateList(
        list('BLUS30443', pkgTag({ ...good, sha1sum: SHA_A.toUpperCase() })),
        'BLUS30443'
      )[0]
    ).toMatchObject({ sha1: SHA_A, systemVersion: null })
  })

  it('sorts the packages oldest first', () => {
    const xml = list(
      'BLUS30443',
      ['01.10', '01.02', '01.09']
        .map((v) => pkgTag({ version: v, size: '100', sha1sum: SHA_A, url: URL_OK }))
        .join('')
    )
    expect(parseUpdateList(xml, 'BLUS30443').map((p) => p.version)).toEqual([
      '01.02',
      '01.09',
      '01.10'
    ])
  })

  it('decodes XML entities in attributes', () => {
    const url = 'https://a0.ww.np.dl.playstation.net/x.pkg?a=1&amp;b=&quot;2&quot;'
    const xml = `<titlepatch titleid='BLUS30443'><tag><package version='01.01' size='64' sha1sum='${SHA_B}' url='${url}' ps3_system_ver='&lt;4&gt;&apos;'/></tag></titlepatch>`
    // The query is not part of the pathname, so this is still a .pkg.
    expect(parseUpdateList(xml, 'BLUS30443')).toEqual([
      {
        version: '01.01',
        size: 64,
        sha1: SHA_B,
        url: 'https://a0.ww.np.dl.playstation.net/x.pkg?a=1&b="2"',
        systemVersion: "<4>'"
      }
    ])
  })
})

describe('isSonyPackageUrl', () => {
  it("takes only .pkg files on Sony's download servers over http(s)", () => {
    expect(isSonyPackageUrl(URL_OK)).toBe(true)
    expect(isSonyPackageUrl('https://dl.playstation.net/a/B.PKG')).toBe(true)
    expect(isSonyPackageUrl('http://b0.ww.np.dl.playstation.net/a/b.exe')).toBe(false)
    expect(isSonyPackageUrl('http://dl.playstation.net.evil.com/a.pkg')).toBe(false)
    expect(isSonyPackageUrl('http://evildl.playstation.net/a.pkg')).toBe(false)
    expect(isSonyPackageUrl('ftp://b0.ww.np.dl.playstation.net/a.pkg')).toBe(false)
    expect(isSonyPackageUrl('file:///C:/a.pkg')).toBe(false)
    expect(isSonyPackageUrl('')).toBe(false)
    expect(isSonyPackageUrl('not a url.pkg')).toBe(false)
  })
})

describe('compareVersions', () => {
  it('compares numerically', () => {
    expect(compareVersions('01.11', '01.02')).toBe(1)
    expect(compareVersions('01.02', '01.11')).toBe(-1)
    expect(compareVersions('01.10', '1.10')).toBe(0)
    expect(compareVersions('02.00', '01.99')).toBe(1)
    expect(compareVersions('01', '01.00')).toBe(0)
    expect(compareVersions('01.01', '01')).toBe(1)
  })
})

describe('pendingPackages', () => {
  const pkgs: Ps3UpdatePackage[] = ['01.01', '01.02', '01.03'].map((version) => ({
    version,
    size: 100,
    sha1: SHA_A,
    url: URL_OK,
    systemVersion: null
  }))
  it('keeps the packages newer than the installed version, all when unknown', () => {
    expect(pendingPackages(pkgs, '01.01').map((p) => p.version)).toEqual(['01.02', '01.03'])
    expect(pendingPackages(pkgs, '01.03')).toEqual([])
    expect(pendingPackages(pkgs, '02.00')).toEqual([])
    expect(pendingPackages(pkgs, null)).toHaveLength(3)
    expect(pendingPackages([], null)).toEqual([])
  })
})

describe('installedVersion', () => {
  async function put(path: string, data: Buffer): Promise<void> {
    await fs.mkdir(join(path, '..'), { recursive: true })
    await fs.writeFile(path, data)
  }

  it("takes the installed update's APP_VER when it is newer than the game folder's", async () => {
    const dev0 = join(dir, 'dev_hdd0')
    const game = join(dir, 'Game')
    await put(join(game, 'PS3_GAME', 'PARAM.SFO'), sfo({ TITLE_ID: 'BLUS30443', APP_VER: '01.00' }))
    expect(await installedVersion(dev0, 'BLUS30443', game)).toBe('01.00')
    await put(
      join(dev0, 'game', 'BLUS30443', 'PARAM.SFO'),
      sfo({ TITLE_ID: 'BLUS30443', APP_VER: '01.05' })
    )
    expect(await installedVersion(dev0, 'BLUS30443', game)).toBe('01.05')
    // The disc folder's own version wins when it is the newer one.
    await put(join(game, 'PS3_GAME', 'PARAM.SFO'), sfo({ TITLE_ID: 'BLUS30443', APP_VER: '01.07' }))
    expect(await installedVersion(dev0, 'BLUS30443', game)).toBe('01.07')
    // Without a game folder (a disc image), the update alone.
    expect(await installedVersion(dev0, 'BLUS30443', null)).toBe('01.05')
  })

  it('reads a PSN folder (PARAM.SFO at its top) and ignores malformed versions', async () => {
    const dev0 = join(dir, 'dev_hdd0')
    const psn = join(dir, 'Psn')
    await put(join(psn, 'PARAM.SFO'), sfo({ TITLE_ID: 'NPUB30024', APP_VER: '01.02' }))
    await put(join(dev0, 'game', 'NPUB30024', 'PARAM.SFO'), sfo({ APP_VER: 'garbage' }))
    expect(await installedVersion(dev0, 'NPUB30024', psn)).toBe('01.02')
  })

  it('is null when neither has a version', async () => {
    const dev0 = join(dir, 'dev_hdd0')
    expect(await installedVersion(dev0, 'BLUS30443', null)).toBeNull()
    expect(await installedVersion(dev0, 'BLUS30443', join(dir, 'missing'))).toBeNull()
    await put(join(dir, 'Game', 'PS3_GAME', 'PARAM.SFO'), sfo({ TITLE_ID: 'BLUS30443' }))
    expect(await installedVersion(dev0, 'BLUS30443', join(dir, 'Game'))).toBeNull()
  })
})

describe('fetchUpdateList', () => {
  const answer = (status: number, body: string): ReturnType<typeof vi.fn> & TextGet =>
    vi.fn(async () => ({ status, body })) as unknown as ReturnType<typeof vi.fn> & TextGet

  it("asks Sony's list URL and parses it", async () => {
    const get = answer(200, SAMPLE)
    expect(await fetchUpdateList('BCUS98174', get)).toHaveLength(1)
    expect(get).toHaveBeenCalledWith(updateListUrl('BCUS98174'), undefined)
    expect(updateListUrl('BCUS98174')).toBe(
      'https://a0.ww.np.dl.playstation.net/tpl/np/BCUS98174/BCUS98174-ver.xml'
    )
  })

  it('is empty for a 404 or an empty body', async () => {
    expect(await fetchUpdateList('BCUS98174', answer(404, 'Not Found'))).toEqual([])
    expect(await fetchUpdateList('BCUS98174', answer(200, ''))).toEqual([])
    expect(await fetchUpdateList('BCUS98174', answer(200, '  \n'))).toEqual([])
  })

  it('throws for a server error', async () => {
    await expect(fetchUpdateList('BCUS98174', answer(500, 'oops'))).rejects.toThrow(/500/)
  })

  it('is empty for a bad serial without asking the server', async () => {
    const get = answer(200, SAMPLE)
    for (const id of ['', 'BCUS9817', 'bcus98174', '../x', 'BCUS98174/../../x'])
      expect(await fetchUpdateList(id, get)).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })
})

describe('packageSha1', () => {
  it('hashes all but the last 32 bytes and checks the stored hash', async () => {
    const { bytes, sha1 } = fakePkg(Buffer.from('a PS3 package body '.repeat(50)))
    const path = join(dir, 'a.pkg')
    await fs.writeFile(path, bytes)
    expect(await packageSha1(path)).toEqual({ sha1, trailerAgrees: true })
    // A trailer that does not start with that hash.
    const bad = Buffer.from(bytes)
    bad[bad.length - 32] ^= 0xff
    await fs.writeFile(path, bad)
    expect(await packageSha1(path)).toEqual({ sha1, trailerAgrees: false })
  })

  it('refuses a file of 32 bytes or less', async () => {
    const path = join(dir, 'tiny.pkg')
    await fs.writeFile(path, Buffer.alloc(32))
    await expect(packageSha1(path)).rejects.toThrow(/too small/)
  })
})

describe('rpcs3Dev0', () => {
  const exeDir = (): string => join(dir, 'RPCS3')
  const exe = (): string => join(exeDir(), 'rpcs3.exe')
  async function vfs(dev0Line: string | null): Promise<void> {
    await fs.mkdir(join(exeDir(), 'config'), { recursive: true })
    const lines = ['$(EmulatorDir): ""']
    if (dev0Line !== null) lines.push(`/dev_hdd0/: ${dev0Line}`)
    lines.push('/dev_hdd1/: $(EmulatorDir)dev_hdd1/', '/dev_flash/: ""', '')
    await fs.writeFile(join(exeDir(), 'config', 'vfs.yml'), lines.join('\n'))
  }

  it('is dev_hdd0 next to rpcs3.exe without a vfs.yml, or without a /dev_hdd0/ line', async () => {
    expect(await rpcs3Dev0(exe())).toBe(join(exeDir(), 'dev_hdd0'))
    await vfs(null)
    expect(await rpcs3Dev0(exe())).toBe(join(exeDir(), 'dev_hdd0'))
    await vfs('')
    expect(await rpcs3Dev0(exe())).toBe(join(exeDir(), 'dev_hdd0'))
  })

  it('expands $(EmulatorDir)', async () => {
    await vfs('$(EmulatorDir)dev_hdd0/')
    expect(await rpcs3Dev0(exe())).toBe(join(exeDir(), 'dev_hdd0'))
    await vfs('$(EmulatorDir)../Shared/hdd0/')
    expect(await rpcs3Dev0(exe())).toBe(join(dir, 'Shared', 'hdd0'))
  })

  it('takes a custom absolute path', async () => {
    const custom = join(dir, 'Emulation', 'Updates and DLC', 'PS3', 'dev_hdd0')
    await vfs(`${custom.split('\\').join('/')}/`)
    expect(await rpcs3Dev0(exe())).toBe(custom)
  })

  it('strips quotes around the value', async () => {
    await vfs('"$(EmulatorDir)my hdd/"')
    expect(await rpcs3Dev0(exe())).toBe(join(exeDir(), 'my hdd'))
    const custom = join(dir, 'Quoted HDD')
    await vfs(`'${custom.split('\\').join('/')}/'`)
    expect(await rpcs3Dev0(exe())).toBe(custom)
  })

  it('reads a vfs.yml with Windows line endings', async () => {
    await fs.mkdir(join(exeDir(), 'config'), { recursive: true })
    const custom = join(dir, 'CRLF HDD')
    await fs.writeFile(
      join(exeDir(), 'config', 'vfs.yml'),
      `$(EmulatorDir): ""\r\n/dev_hdd0/: "${custom.split('\\').join('/')}/"\r\n/dev_hdd1/: x\r\n`
    )
    expect(await rpcs3Dev0(exe())).toBe(custom)
  })
})

describe('downloadPackage', () => {
  const body = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 251))
  const { bytes, sha1 } = fakePkg(body)
  const pkg: Ps3UpdatePackage = {
    version: '01.02',
    size: bytes.length,
    sha1,
    url: URL_OK,
    systemVersion: null
  }

  it('downloads into <version>-<sha1>.pkg and reports the bytes', async () => {
    const fetch = streamingFetch(bytes)
    const onBytes = vi.fn()
    const out = join(dir, 'cache')
    const file = await downloadPackage(pkg, out, { fetch, onBytes })
    expect(file).toBe(join(out, `01.02-${sha1}.pkg`))
    expect(await fs.readFile(file)).toEqual(bytes)
    expect(fetch).toHaveBeenCalledWith(URL_OK, expect.anything())
    expect(onBytes).toHaveBeenCalled()
    expect(onBytes).toHaveBeenLastCalledWith(bytes.length, bytes.length)
    expect(await fs.readdir(out)).toEqual([`01.02-${sha1}.pkg`])
  })

  it('throws for a wrong size and leaves no .part behind', async () => {
    const out = join(dir, 'cache')
    await expect(
      downloadPackage({ ...pkg, size: pkg.size + 10 }, out, { fetch: streamingFetch(bytes) })
    ).rejects.toThrow(/incomplete/)
    expect(await fs.readdir(out)).toEqual([])
  })

  it('throws for a wrong sha1 and keeps nothing', async () => {
    const out = join(dir, 'cache')
    await expect(
      downloadPackage({ ...pkg, sha1: SHA_A }, out, { fetch: streamingFetch(bytes) })
    ).rejects.toThrow(/checksum/)
    expect(await fs.readdir(out)).toEqual([])
  })

  it('cuts off a body longer than the listed size and keeps nothing', async () => {
    const out = join(dir, 'cache')
    const onBytes = vi.fn()
    await expect(
      downloadPackage(pkg, out, {
        fetch: streamingFetch(Buffer.concat([bytes, Buffer.alloc(5000)])),
        onBytes
      })
    ).rejects.toThrow(/larger than Sony lists/)
    expect(await fs.readdir(out)).toEqual([])
    // Never reported past the size.
    for (const [done, total] of onBytes.mock.calls) expect(done).toBeLessThanOrEqual(total)
  })

  it('refuses a Content-Length other than the listed size before writing', async () => {
    const out = join(dir, 'cache')
    const fetch = vi.fn(
      async () =>
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { 'content-length': String(bytes.length + 1) }
        })
    ) as unknown as FileFetch
    await expect(downloadPackage(pkg, out, { fetch })).rejects.toThrow(/wrong size/)
    expect(await fs.readdir(out)).toEqual([])
    // The right Content-Length is fine.
    const right = vi.fn(
      async () =>
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { 'content-length': String(bytes.length) }
        })
    ) as unknown as FileFetch
    expect(await downloadPackage(pkg, out, { fetch: right })).toBe(join(out, `01.02-${sha1}.pkg`))
  })

  it('throws for an HTTP error', async () => {
    await expect(
      downloadPackage(pkg, join(dir, 'cache'), { fetch: streamingFetch(bytes, 404) })
    ).rejects.toThrow(/404/)
  })

  it('reuses a complete, matching file without downloading', async () => {
    const out = join(dir, 'cache')
    await fs.mkdir(out)
    await fs.writeFile(join(out, `01.02-${sha1}.pkg`), bytes)
    const fetch = streamingFetch(bytes)
    expect(await downloadPackage(pkg, out, { fetch })).toBe(join(out, `01.02-${sha1}.pkg`))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('downloads again over a damaged file of the same name', async () => {
    const out = join(dir, 'cache')
    await fs.mkdir(out)
    const damaged = Buffer.from(bytes)
    damaged[5] ^= 0xff
    await fs.writeFile(join(out, `01.02-${sha1}.pkg`), damaged)
    const fetch = streamingFetch(bytes)
    const file = await downloadPackage(pkg, out, { fetch })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(file)).toEqual(bytes)
  })
})
