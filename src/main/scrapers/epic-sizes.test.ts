import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blobToNumber, epicInstallSize, parseEpicManifestSize } from './epic-sizes'

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const i32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeInt32LE(n)
  return b
}
/** An FString: ASCII with its null, or UTF-16 (negative length) with its two-byte null. */
const fstring = (s: string, utf16 = false): Buffer => {
  if (!s) return i32(0)
  if (utf16)
    return Buffer.concat([i32(-(s.length + 1)), Buffer.from(s, 'utf16le'), Buffer.alloc(2)])
  return Buffer.concat([i32(s.length + 1), Buffer.from(s, 'ascii'), Buffer.alloc(1)])
}
/** A section that starts with its own size (the size field counted). */
const section = (body: Buffer): Buffer => Buffer.concat([u32(body.length + 4), body])
/** A chunk part: struct size, guid, offset, size (and `extra` unknown trailing bytes, which are skipped). */
const part = (size: number, extra = 0): Buffer =>
  Buffer.concat([u32(28 + extra), Buffer.alloc(16, 7), u32(0), u32(size), Buffer.alloc(extra, 9)])

interface File {
  name: string
  parts: Buffer[]
  tags?: string[]
}

function fileList(files: File[]): Buffer {
  const body = Buffer.concat([
    Buffer.from([2]), // version
    u32(files.length),
    ...files.map((f, i) => fstring(f.name, i === 1)),
    ...files.map(() => fstring('')),
    ...files.map(() => Buffer.alloc(20, 1)),
    ...files.map(() => Buffer.from([0])),
    ...files.map((f) =>
      Buffer.concat([u32(f.tags?.length ?? 0), ...(f.tags ?? []).map((t) => fstring(t))])
    ),
    ...files.map((f) => Buffer.concat([u32(f.parts.length), ...f.parts])),
    // Version 1: an MD5 (the first file has one) and a MIME type per file; version 2: a SHA-256 per file.
    ...files.map((_, i) => (i === 0 ? Buffer.concat([u32(1), Buffer.alloc(16, 4)]) : u32(0))),
    ...files.map(() => fstring('application/octet-stream')),
    Buffer.alloc(files.length * 32, 3)
  ])
  return section(body)
}

function binaryManifest(
  files: File[],
  opts: { compressed?: boolean; version?: number; badHash?: boolean } = {}
): Buffer {
  const meta = section(
    Buffer.concat([Buffer.from([0]), u32(18), Buffer.from([0]), fstring('Fennel')])
  )
  const cdl = section(Buffer.concat([Buffer.from([3]), u32(2), Buffer.alloc(100, 5)]))
  const body = Buffer.concat([meta, cdl, fileList(files), section(Buffer.alloc(8))])
  const compressed = opts.compressed ?? true
  const stored = compressed ? deflateSync(body) : body
  const version = opts.version ?? 21
  const sha = createHash('sha1').update(body).digest()
  if (opts.badHash) sha[0] ^= 0xff
  const tail = version >= 22 ? Buffer.alloc(32) : Buffer.alloc(0)
  const headerSize = 41 + tail.length
  const header = Buffer.concat([
    u32(0x44bec00c),
    u32(headerSize),
    u32(body.length),
    u32(stored.length),
    sha,
    Buffer.from([compressed ? 1 : 0]),
    u32(version),
    tail
  ])
  return Buffer.concat([header, stored])
}

describe('parseEpicManifestSize', () => {
  const files: File[] = [
    { name: 'Game.exe', parts: [part(1000), part(24)] },
    { name: 'Content/Paks/Spiel-Ä.pak', parts: [part(5_000_000, 4)], tags: ['ondemand'] },
    { name: 'readme.txt', parts: [] }
  ]

  it('adds up the chunk parts of every file of a compressed binary manifest', () => {
    expect(parseEpicManifestSize(binaryManifest(files))).toEqual({
      bytes: 5_001_024,
      optional: 5_000_000
    })
  })

  it('reads an uncompressed one and a version 22 header (encryption fields)', () => {
    expect(parseEpicManifestSize(binaryManifest(files, { compressed: false })).bytes).toBe(
      5_001_024
    )
    expect(parseEpicManifestSize(binaryManifest(files, { version: 22 })).bytes).toBe(5_001_024)
  })

  it('refuses a body that does not match its hash, and a truncated one', () => {
    expect(() => parseEpicManifestSize(binaryManifest(files, { badHash: true }))).toThrow(/hash/)
    const whole = binaryManifest(files, { compressed: false })
    expect(() => parseEpicManifestSize(whole.subarray(0, whole.length - 300))).toThrow()
  })

  it('reads a JSON manifest, whose sizes are byte blobs', () => {
    expect(blobToNumber('000016000000')).toBe(4096)
    expect(blobToNumber('232003000000')).toBe(1000)
    const json = JSON.stringify({
      ManifestFileVersion: '013000000000',
      FileManifestList: [
        { Filename: 'a.exe', FileChunkParts: [{ Size: '000016000000' }, { Size: '232003000000' }] },
        { Filename: 'b.pak', InstallTags: ['highres'], FileChunkParts: [{ Size: '000000001000' }] }
      ]
    })
    expect(parseEpicManifestSize(Buffer.from(json))).toEqual({
      bytes: 4096 + 1000 + 65536,
      optional: 65536
    })
  })

  it('refuses a file list that does not end where its size says', () => {
    const list = fileList(files)
    // One byte more in the list than its contents: the layout was misread.
    const padded = Buffer.concat([u32(list.length + 1), list.subarray(4), Buffer.alloc(1)])
    const meta = section(Buffer.from([0]))
    const cdl = section(Buffer.from([3]))
    const body = Buffer.concat([meta, cdl, padded])
    const header = Buffer.concat([
      u32(0x44bec00c),
      u32(41),
      u32(body.length),
      u32(body.length),
      createHash('sha1').update(body).digest(),
      Buffer.from([0]),
      u32(21)
    ])
    expect(() => parseEpicManifestSize(Buffer.concat([header, body]))).toThrow(/file list/)
  })

  it('throws on something that is not a manifest', () => {
    expect(() => parseEpicManifestSize(Buffer.from('<html>Access denied</html>'))).toThrow()
  })
})

describe('epicInstallSize', () => {
  afterEach(() => vi.restoreAllMocks())
  const ref = { appName: 'Fennel', namespace: 'ns', catalogItemId: 'cat' }

  it('never puts the signed CDN address in its error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/assets/v2/'))
        return new Response(
          JSON.stringify({
            elements: [
              {
                manifests: [
                  {
                    uri: 'https://cdn.example.test/Builds/x.manifest',
                    queryParams: [{ name: 'f_token', value: 'SECRETSIG' }]
                  }
                ]
              }
            ]
          }),
          { status: 200 }
        )
      return new Response('denied', { status: 403 })
    })
    const err = await epicInstallSize('tok', ref).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(String((err as Error).message)).toContain('cdn.example.test')
    expect(String((err as Error).message)).not.toContain('SECRETSIG')
  })

  it('reads no Windows build (404) as none, and throws on a 403', async () => {
    const status = { code: 404 }
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('{}', { status: status.code })
    )
    await expect(epicInstallSize('tok', ref)).resolves.toBeUndefined()
    status.code = 403
    await expect(epicInstallSize('tok', ref)).rejects.toThrow()
  })
})
