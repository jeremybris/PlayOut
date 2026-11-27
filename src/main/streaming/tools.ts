import { createHash } from 'crypto'
import { createWriteStream, promises as fs } from 'fs'
import { join } from 'path'
import { Readable, Transform, type TransformCallback } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import type { Logger } from '../logger'
import { listDir, readJson, renameRetry, RM_RETRY } from '../util/fs'
import { extractZip } from '../util/zip'

/**
 * The streaming helper programs (Sunshine on a host, Moonlight on a client) are GPL-3 programs of their own: PlayOut
 * never ships them, it downloads the official portable zip from the project's GitHub release the first time it needs
 * one, checks it against a SHA-256 and extracts it into `root/<tag>/`. A pinned tag and hash are used: both projects
 * change their CLI and API between releases, and a pinned hash means a replaced release asset is refused.
 */

const API = 'https://api.github.com/repos'
const USER_AGENT = 'PlayOut (+https://github.com/jeremybris/PlayOut)'
const API_TIMEOUT_MS = 60_000
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000
export const INSTALLED_MARKER = 'installed.json'

/** A tool PlayOut knows how to fetch: its repository, asset and (pinned) release. */
export interface GithubToolSpec {
  /** 'owner/name'. */
  repo: string
  /** Picks the release asset by name. */
  assetPattern: RegExp
  /** Take this release instead of the latest one. */
  pinnedTag?: string
  /** The asset's name in the pinned release: used to download it directly when the GitHub API is unreachable. */
  pinnedAsset?: string
  /** Lowercase hex; when set it wins over the API's digest (and a different digest is refused). */
  expectedSha256?: string
}

/** Sunshine's portable ("lite") build: runs as the user from any folder, no service and no admin. */
export const SUNSHINE_TOOL: GithubToolSpec = {
  repo: 'LizardByte/Sunshine',
  assetPattern: /^Sunshine-Windows-AMD64-lite\.zip$/i,
  pinnedTag: 'v2026.914.233613',
  pinnedAsset: 'Sunshine-Windows-AMD64-lite.zip',
  expectedSha256: '233008e46f4c0e501a586cbfd6c4fd4a4c0d414a0b5fc7f13c070eb92ec3824b'
}

/** Moonlight-qt's portable build (settings next to the exe when a portable.dat is in its working folder). */
export const MOONLIGHT_TOOL: GithubToolSpec = {
  repo: 'moonlight-stream/moonlight-qt',
  assetPattern: /^MoonlightPortable-x64-.*\.zip$/i,
  pinnedTag: 'v6.2.0',
  pinnedAsset: 'MoonlightPortable-x64-6.2.0.zip',
  expectedSha256: '6f91d268b41ed5ca8066d9d7578dc403b8db190991ff48f00b1700465f8f7ebf'
}

export interface GithubToolOptions extends GithubToolSpec {
  /** The tool's own folder (e.g. userData/streaming/sunshine/app): releases go in `<root>/<tag>/`. */
  root: string
  fetch?: typeof fetch
  /** Bytes downloaded so far; `total` is 0 when the size is unknown. */
  onProgress?: (done: number, total: number) => void
  log: Logger
  /**
   * A file the release must still hold (the tool's exe). An installed release without it is downloaded again:
   * Windows Defender quarantines streaming hosts now and then, and the marker alone would keep that gap for good.
   */
  requiredFile?: string
}

/** `root/installed.json`, plus where the release was extracted. */
export interface InstalledTool {
  tag: string
  asset: string
  sha256: string
  installedAt: string
  /** `root/<tag>`. */
  dir: string
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size?: number
  digest?: string | null
}

interface Release {
  tag_name?: string
  assets?: ReleaseAsset[]
}

/** A tag used as a folder name: refuse anything that could leave `root`. */
function safeTag(tag: string): string {
  if (!/^[\w.-]+$/.test(tag) || tag === '.' || tag === '..')
    throw new Error(`unusable release tag ${tag}`)
  return tag
}

/** The installed release (its folder still there), or null. */
export async function readInstalledTool(root: string): Promise<InstalledTool | null> {
  const marker = await readJson<Omit<InstalledTool, 'dir'>>(join(root, INSTALLED_MARKER))
  if (!marker?.tag || typeof marker.tag !== 'string') return null
  let dir: string
  try {
    dir = join(root, safeTag(marker.tag))
  } catch {
    return null
  }
  const stat = await fs.stat(dir).catch(() => null)
  return stat?.isDirectory() ? { ...marker, dir } : null
}

/**
 * The first file called `name` (case-insensitive) under `dir`, breadth first: release zips put their files either at
 * the top or in one folder named after the release, and the exe should be found either way.
 */
export async function findToolFile(
  dir: string,
  name: string,
  maxDepth = 3
): Promise<string | null> {
  const wanted = name.toLowerCase()
  let level = [dir]
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const next: string[] = []
    for (const folder of level) {
      const entries = await listDir(folder)
      const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === wanted)
      if (hit) return join(folder, hit.name)
      for (const e of entries) if (e.isDirectory()) next.push(join(folder, e.name))
    }
    level = next.sort()
  }
  return null
}

/** `sha256:<hex>` (GitHub's asset digest) -> hex, or null for another algorithm or none. */
export function sha256FromDigest(digest: string | null | undefined): string | null {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(digest?.trim() ?? '')
  return m ? m[1].toLowerCase() : null
}

/** Whether an installed release still satisfies the spec (a new pin replaces it). */
function satisfies(installed: InstalledTool, spec: GithubToolSpec): boolean {
  if (spec.pinnedTag && installed.tag !== spec.pinnedTag) return false
  if (spec.expectedSha256 && installed.sha256 !== spec.expectedSha256.toLowerCase()) return false
  return true
}

async function resolveRelease(
  opts: GithubToolOptions,
  http: typeof fetch
): Promise<{ tag: string; asset: ReleaseAsset }> {
  const url = opts.pinnedTag
    ? `${API}/${opts.repo}/releases/tags/${encodeURIComponent(opts.pinnedTag)}`
    : `${API}/${opts.repo}/releases/latest`
  let release: Release | null = null
  let failure = ''
  try {
    const res = await http(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    if (res.ok) release = (await res.json()) as Release
    else failure = `HTTP ${res.status}`
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }
  if (release) {
    const asset = release.assets?.find((a) => opts.assetPattern.test(a.name))
    if (!asset) throw new Error(`the ${opts.repo} release has no ${opts.assetPattern.source} asset`)
    return { tag: release.tag_name ?? opts.pinnedTag ?? 'latest', asset }
  }
  // GitHub's API allows 60 anonymous calls an hour per address: a pinned release can still be fetched directly, and
  // the pinned hash keeps that safe.
  if (opts.pinnedTag && opts.pinnedAsset && opts.expectedSha256) {
    opts.log.warn(`${opts.repo}: release lookup failed (${failure}); using the pinned download`)
    return {
      tag: opts.pinnedTag,
      asset: {
        name: opts.pinnedAsset,
        browser_download_url: `https://github.com/${opts.repo}/releases/download/${encodeURIComponent(
          opts.pinnedTag
        )}/${encodeURIComponent(opts.pinnedAsset)}`
      }
    }
  }
  throw new Error(`could not look up the ${opts.repo} release (${failure})`)
}

/** Passes the bytes through while hashing and counting them. */
function meter(onChunk: (chunk: Buffer) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
      onChunk(chunk)
      done(null, chunk)
    }
  })
}

async function install(opts: GithubToolOptions): Promise<InstalledTool> {
  const http = opts.fetch ?? fetch
  const { tag: rawTag, asset } = await resolveRelease(opts, http)
  const tag = safeTag(rawTag)
  const apiSha = sha256FromDigest(asset.digest)
  const pinnedSha = opts.expectedSha256?.toLowerCase() ?? null
  if (pinnedSha && apiSha && pinnedSha !== apiSha)
    throw new Error(`${asset.name}: GitHub lists a different checksum than the one PlayOut expects`)
  const expected = pinnedSha ?? apiSha
  // Never run an unverified download: without a pinned hash or GitHub's digest there is nothing to check against.
  if (!expected) throw new Error(`${asset.name}: no checksum to verify the download against`)

  opts.log.info(`${opts.repo}: downloading ${asset.name} (${tag})`)
  await fs.mkdir(opts.root, { recursive: true })
  const zip = join(opts.root, `${tag}.zip.part`)
  const staging = join(opts.root, `${tag}.extracting`)
  const dir = join(opts.root, tag)
  try {
    const res = await http(asset.browser_download_url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    })
    if (!res.ok || !res.body) throw new Error(`${asset.name}: download failed (HTTP ${res.status})`)
    const total = Number(res.headers.get('content-length')) || asset.size || 0
    const hash = createHash('sha256')
    let got = 0
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
      meter((chunk) => {
        hash.update(chunk)
        got += chunk.length
        opts.onProgress?.(got, total)
      }),
      createWriteStream(zip)
    )
    const actual = hash.digest('hex')
    if (actual !== expected)
      throw new Error(
        `${asset.name}: the download is damaged or not the expected file (checksum mismatch)`
      )

    // Extract beside the final folder and rename it in: a half-extracted release is never taken for an installed one.
    await fs.rm(staging, RM_RETRY)
    const written = await extractZip(zip, staging)
    await fs.rm(dir, RM_RETRY)
    // Defender scans the freshly extracted .exe/.dll files and holds them open for a moment.
    await renameRetry(staging, dir)
    const marker = { tag, asset: asset.name, sha256: actual, installedAt: new Date().toISOString() }
    await fs.writeFile(join(opts.root, INSTALLED_MARKER), JSON.stringify(marker, null, 2))
    opts.log.info(`${opts.repo}: ${asset.name} installed (${written.length} files)`)
    await removeOtherReleases(opts.root, tag)
    return { ...marker, dir }
  } finally {
    await fs.rm(zip, { force: true }).catch(() => undefined)
    await fs.rm(staging, RM_RETRY).catch(() => undefined)
  }
}

/** Earlier releases left in `root` after an update. A folder still in use (a running exe) is left for next time. */
async function removeOtherReleases(root: string, keep: string): Promise<void> {
  for (const e of await listDir(root))
    if (e.isDirectory() && e.name !== keep)
      await fs.rm(join(root, e.name), { recursive: true, force: true }).catch(() => undefined)
}

const inflight = new Map<string, Promise<InstalledTool>>()

/**
 * The tool's installed release, downloading, verifying and extracting it first when it is missing or not the pinned
 * one. Single flight per root: callers that ask while a download runs share it (and its progress goes to the first
 * caller's onProgress).
 */
export function ensureGithubTool(opts: GithubToolOptions): Promise<InstalledTool> {
  const key = opts.root.toLowerCase()
  const running = inflight.get(key)
  if (running) return running
  const job = (async (): Promise<InstalledTool> => {
    const installed = await readInstalledTool(opts.root)
    if (installed && satisfies(installed, opts)) {
      if (!opts.requiredFile || (await findToolFile(installed.dir, opts.requiredFile)))
        return installed
      opts.log.warn(
        `${opts.repo}: ${opts.requiredFile} is gone from ${installed.tag}; downloading it again`
      )
    }
    return install(opts)
  })().finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}
