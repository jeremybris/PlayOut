// Install sizes of Epic games from Epic's own build manifests (ARCHITECTURE.md §4.11). With the user's Epic sign-in,
// the Launcher's assets API names the current build's manifest on Epic's CDN; the manifest lists every file of the
// install as chunk parts, whose sizes add up to the installed bytes: exact, like steamcmd's depots for Steam.
// Format as read by Legendary (legendary/models/manifest.py, json_manifest.py).
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { HttpError, httpBytes, httpJson, RateLimiter } from './http'

const ASSETS_HOST = 'https://launcher-public-service-prod06.ol.epicgames.com'
const MANIFEST_MAGIC = 0x44bec00c
/** The Launcher's own user agent (as Legendary sends it): the assets API and the CDN serve the Launcher. */
const LAUNCHER_UA =
  'UELauncher/11.0.1-14907503+++Portal+Release-Live Windows/10.0.19041.1.256.64bit'
/** A manifest bigger than this (uncompressed) is not read: Fortnite's is about 30 MB, a usual game's well under 5. */
const MAX_MANIFEST_BYTES = 256 * 1024 * 1024

// The Launcher's own API: a few calls a second, like the Launcher checking a library for updates.
const assetsLimiter = new RateLimiter(4, 4)
const cdnLimiter = new RateLimiter(8, 8)

/** A build's installed bytes; `optional` of them are files with install tags (language packs, high-res textures, ...). */
export interface EpicBuildSize {
  bytes: number
  /** Bytes of tagged files: the Launcher installs some of them by default, so the total is then an upper bound. */
  optional: number
}

export interface EpicGameRef {
  appName: string
  namespace: string
  catalogItemId: string
}

interface AssetsResponse {
  elements?: {
    hash?: string
    manifests?: { uri?: string; queryParams?: { name?: string; value?: string }[] }[]
  }[]
}

/** Reads the little-endian fields of a manifest body, failing on a read past the end. */
class Reader {
  pos = 0
  constructor(private readonly buf: Buffer) {}
  need(n: number): void {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('truncated manifest')
  }
  u8(): number {
    this.need(1)
    return this.buf.readUInt8(this.pos++)
  }
  u32(): number {
    this.need(4)
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }
  i32(): number {
    this.need(4)
    const v = this.buf.readInt32LE(this.pos)
    this.pos += 4
    return v
  }
  skip(n: number): void {
    this.need(n)
    this.pos += n
  }
  seek(pos: number): void {
    if (pos < 0 || pos > this.buf.length) throw new Error('truncated manifest')
    this.pos = pos
  }
  /** An Unreal FString, skipped: a negative length counts UTF-16 characters, a positive one bytes (null included). */
  skipString(): void {
    const len = this.i32()
    this.skip(len < 0 ? -len * 2 : len)
  }
  /** An Unreal FString's text (install tags are short ASCII). */
  string(): string {
    const len = this.i32()
    const bytes = len < 0 ? -len * 2 : len
    this.need(bytes)
    const raw = this.buf.subarray(this.pos, this.pos + bytes)
    this.pos += bytes
    return len < 0
      ? raw.toString('utf16le').replace(/\0+$/, '')
      : raw.toString('latin1').replace(/\0+$/, '')
  }
}

/** Legendary's blob_to_num: every 3 decimal digits are one byte, least significant first. */
export function blobToNumber(blob: string): number {
  let n = 0
  let factor = 1
  for (let i = 0; i + 3 <= blob.length; i += 3) {
    n += Number(blob.slice(i, i + 3)) * factor
    factor *= 256
  }
  return n
}

function jsonManifestSize(text: string): EpicBuildSize | undefined {
  const data = JSON.parse(text) as {
    FileManifestList?: { FileChunkParts?: { Size?: string }[]; InstallTags?: string[] }[]
  }
  if (!Array.isArray(data.FileManifestList)) return undefined
  let bytes = 0
  let optional = 0
  for (const file of data.FileManifestList) {
    let size = 0
    for (const part of file.FileChunkParts ?? [])
      if (typeof part.Size === 'string') size += blobToNumber(part.Size)
    bytes += size
    if (file.InstallTags?.some((t) => t)) optional += size
  }
  return { bytes, optional }
}

/** The body of a binary manifest after its header, inflated and checked against the header's SHA-1. */
function binaryBody(buf: Buffer): Buffer {
  const r = new Reader(buf)
  r.u32() // magic
  const headerSize = r.u32()
  const sizeUncompressed = r.u32()
  const sizeCompressed = r.u32()
  r.skip(20)
  const sha = buf.subarray(16, 36)
  const storedAs = r.u8()
  if (headerSize < 37 || headerSize > buf.length) throw new Error('bad manifest header')
  if (sizeUncompressed > MAX_MANIFEST_BYTES) throw new Error('manifest too big')
  const raw = buf.subarray(headerSize)
  if (!(storedAs & 1)) return raw
  const body = inflateSync(raw.subarray(0, sizeCompressed || raw.length), {
    maxOutputLength: MAX_MANIFEST_BYTES
  })
  if (!createHash('sha1').update(body).digest().equals(sha))
    throw new Error('manifest hash mismatch')
  return body
}

/**
 * The installed bytes a build manifest describes: the sizes of every file's chunk parts added up (and how many of
 * them are tagged, optional files). Binary and JSON manifests both; an encrypted one (newer builds of some games)
 * hides only its file names, so it is read the same. Throws on a body that is not a manifest.
 */
export function parseEpicManifestSize(buf: Buffer): EpicBuildSize {
  if (buf.length >= 4 && buf.readUInt32LE(0) === MANIFEST_MAGIC) {
    const body = binaryBody(buf)
    const r = new Reader(body)
    // ManifestMeta and the chunk data list each start with their own size (counting the size field itself).
    const metaSize = r.u32()
    r.seek(metaSize)
    const cdlStart = r.pos
    r.seek(cdlStart + r.u32())
    // The file manifest list: names, link targets, hashes, flags and install tags, then each file's chunk parts.
    const fmlStart = r.pos
    const fmlSize = r.u32()
    const fmlVersion = r.u8()
    const count = r.u32()
    if (count > body.length) throw new Error('bad file count')
    for (let i = 0; i < count; i++) r.skipString()
    for (let i = 0; i < count; i++) r.skipString()
    r.skip(count * 20)
    r.skip(count)
    const tagged: boolean[] = []
    for (let i = 0; i < count; i++) {
      const tags = r.u32()
      // An empty tag is no tag (the base install).
      let any = false
      for (let t = 0; t < tags; t++) if (r.string() !== '') any = true
      tagged.push(any)
    }
    let total = 0
    let optional = 0
    for (let i = 0; i < count; i++) {
      const parts = r.u32()
      let size = 0
      for (let p = 0; p < parts; p++) {
        const start = r.pos
        const structSize = r.u32()
        r.skip(16 + 4) // chunk guid, offset in the chunk
        size += r.u32()
        if (structSize < 28) throw new Error('bad chunk part')
        r.seek(start + structSize)
      }
      total += size
      if (tagged[i]) optional += size
    }
    // The list must end where its size says (after the MD5s and MIME types of version 1, the SHA-256s of version 2):
    // a layout read wrong is refused instead of giving a wrong size.
    if (fmlVersion >= 1) {
      for (let i = 0; i < count; i++) if (r.u32()) r.skip(16)
      for (let i = 0; i < count; i++) r.skipString()
    }
    if (fmlVersion >= 2) r.skip(count * 32)
    if (fmlVersion <= 2 && r.pos !== fmlStart + fmlSize) throw new Error('bad file list')
    return { bytes: total, optional }
  }
  const text = buf.toString('utf8').replace(/^\uFEFF/, '')
  if (text.trimStart().startsWith('{')) {
    const size = jsonManifestSize(text)
    if (size !== undefined) return size
  }
  throw new Error('not an Epic manifest')
}

/** The current Windows build's manifest URLs (CDN mirrors, any one will do) and the manifest's SHA-1. */
async function manifestUrls(
  accessToken: string,
  game: EpicGameRef
): Promise<{ urls: string[]; hash?: string } | undefined> {
  const url =
    `${ASSETS_HOST}/launcher/api/public/assets/v2/platform/Windows/namespace/${encodeURIComponent(game.namespace)}` +
    `/catalogItem/${encodeURIComponent(game.catalogItemId)}/app/${encodeURIComponent(game.appName)}/label/Live`
  let data: AssetsResponse
  try {
    data = await httpJson<AssetsResponse>(
      url,
      { headers: { Authorization: `bearer ${accessToken}`, 'User-Agent': LAUNCHER_UA } },
      // Inside the size scan's budget for Epic: two tries of 10 s.
      { limiter: assetsLimiter, retries: 1, timeoutMs: 10_000 }
    )
  } catch (err) {
    // No Windows build for this app (a Mac-only item, an add-on, a game withdrawn from the store): no size here. Any
    // other refusal (403 included: a firewall, a missing permission) throws, so it is asked again later.
    if (err instanceof HttpError && err.status === 404) return undefined
    throw err
  }
  const element = data.elements?.[0]
  const urls = (element?.manifests ?? []).flatMap((m) => {
    if (!m.uri) return []
    const params = (m.queryParams ?? [])
      .filter((p) => p.name)
      .map((p) => `${p.name}=${p.value ?? ''}`)
      .join('&')
    return [params ? `${m.uri}?${params}` : m.uri]
  })
  return urls.length ? { urls, hash: element?.hash } : undefined
}

/**
 * What the Epic Games Launcher would install for this game on Windows, from its current build manifest; undefined
 * when Epic has no Windows build of it. Throws when Epic or its CDN cannot be reached, or an HttpError with status 401
 * when the token is refused.
 */
export async function epicInstallSize(
  accessToken: string,
  game: EpicGameRef
): Promise<EpicBuildSize | undefined> {
  const found = await manifestUrls(accessToken, game)
  if (!found) return undefined
  let lastError: unknown
  // Two mirrors at most: the size scan's budget for Epic leaves no room for more.
  for (const url of found.urls.slice(0, 2)) {
    try {
      // The CDN's own signed address: no sign-in sent there.
      const { data } = await httpBytes(
        url,
        { headers: { 'User-Agent': LAUNCHER_UA } },
        // One try per mirror, well inside the size scan's minute per game; the next mirror is the retry.
        { limiter: cdnLimiter, retries: 0, timeoutMs: 15_000 }
      )
      if (found.hash && createHash('sha1').update(data).digest('hex') !== found.hash.toLowerCase())
        throw new Error('manifest does not match its hash')
      const size = parseEpicManifestSize(data)
      return size.bytes ? size : undefined
    } catch (err) {
      // The CDN address is signed: the error names its host and status only, so no log line carries the signature.
      const host = new URL(url).host
      const what =
        err instanceof HttpError
          ? err.status
            ? `HTTP ${err.status}`
            : err.message.replace(/\s*\(https?:[^)]*\)/g, '')
          : err instanceof Error
            ? err.message
            : String(err)
      lastError = new Error(`manifest from ${host}: ${what}`)
    }
  }
  throw lastError
}
