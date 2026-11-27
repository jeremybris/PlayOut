import { createHash, randomBytes } from 'crypto'
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import type { PeerPartyProgress } from '../../shared/peerparty'
import type { Logger } from '../logger'
import { tMain } from '../i18n'

/**
 * PlayOut's own copy of PeerParty (MaximumFreak/PeerParty, MIT): never bundled, but downloaded from the project's
 * latest GitHub release the first time a game is started through it, and checked against the release's
 * `peerparty.exe.sha256` and GitHub's own SHA-256 of the asset before it is used. Updates come the same way, at most
 * once a day, and only while no PeerParty runs. Only a generic User-Agent is sent; no user data leaves the PC.
 */

export const RELEASES_LATEST = 'https://api.github.com/repos/MaximumFreak/PeerParty/releases/latest'
const USER_AGENT = 'PlayOut'
/** How long a release check is trusted before the next start looks again. */
export const UPDATE_CHECK_MS = 24 * 60 * 60_000
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000
/** The checksum file is a line or a few: anything larger is not one. */
const CHECKSUM_MAX_BYTES = 4096
export const EXE_NAME = 'peerparty.exe'
export const CHECKSUM_NAME = 'peerparty.exe.sha256'
export const RECORD_NAME = 'playout-peerparty.json'
/** Progress is sent at most this often while downloading. */
const PROGRESS_EVERY_MS = 250

/** What PlayOut knows about the copy it installed (`playout-peerparty.json`). */
export interface PeerPartyInstallRecord {
  tag: string
  sha256: string
  size: number
  /** When GitHub was last asked for the latest release (ISO time). */
  checkedAt: string
  installedAt: string
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
  /** GitHub's own hash of the asset ("sha256:<hex>"), on releases since mid-2025. */
  digest?: string | null
}

interface Release {
  tag_name?: string
  assets?: ReleaseAsset[]
}

/**
 * The SHA-256 (lowercase hex) for `file` in a checksum file, and its size when the file gives one; null when it has
 * none for `file` or names another file. Both forms PeerParty publishes are read: sha256sum's `<hex>  peerparty.exe`
 * (or `*peerparty.exe`, or the hash alone), and `file …` / `size N` / `sha256 <hex>` lines.
 */
export function parseChecksum(
  text: string,
  file: string
): { sha256: string; size?: number } | null {
  const sameFile = (listed: string): boolean => {
    const name = listed.trim().replace(/^\*/, '')
    const base = name.split(/[\\/]/).pop() ?? name
    return base.toLowerCase() === file.toLowerCase()
  }
  const hex = (value: string): string | null => {
    const h = value.replace(/^sha256:/i, '')
    return /^[0-9a-f]{64}$/i.test(h) ? h.toLowerCase() : null
  }
  let sha: string | null = null
  let size: number | undefined
  let other = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const at = line.search(/\s/)
    const first = at < 0 ? line : line.slice(0, at)
    const rest = at < 0 ? '' : line.slice(at).trim()
    switch (first.toLowerCase()) {
      case 'sha256':
      case 'sha256:':
        sha = hex(rest) ?? sha
        break
      case 'size': {
        const n = Number(rest)
        if (/^\d+$/.test(rest) && Number.isSafeInteger(n)) size = n
        break
      }
      case 'file':
      case 'name':
        if (!sameFile(rest)) other = true
        break
      case 'version':
      case 'peerparty-release':
        break
      default: {
        const h = hex(first)
        if (h && (rest === '' || sameFile(rest))) sha = h
      }
    }
  }
  if (other || !sha) return null
  return size !== undefined ? { sha256: sha, size } : { sha256: sha }
}

/** GitHub's "sha256:<hex>" asset digest as lowercase hex, else null. */
export function digestHex(digest: string | null | undefined): string | null {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(digest ?? '')
  return m ? m[1]!.toLowerCase() : null
}

export interface ReleaseDeps {
  /** `<userData>\PeerParty`. */
  dir: string
  log: Logger
  /** Whether a PeerParty of ours runs now (a session, or a process with our exe's path): no update then. */
  busy(): boolean | Promise<boolean>
  onProgress?(progress: PeerPartyProgress): void
  fetch?: typeof fetch
  now?(): number
}

/**
 * Moves the checked download onto peerparty.exe. Windows refuses a rename onto a file another rename is replacing at
 * the same moment (EPERM / EBUSY / EACCES): tried again a few times, and when peerparty.exe meanwhile is a file with
 * this very hash (another download of the same release won), that one is kept and this download dropped.
 */
async function renameIntoPlace(part: string, exe: string, sha: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(part, exe)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
      const there = await hashFile(exe).catch(() => null)
      if (there?.sha === sha) {
        await fs.rm(part, { force: true }).catch(() => {})
        return
      }
      if (attempt >= 5) throw err
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)))
    }
  }
}

export async function readInstallRecord(dir: string): Promise<PeerPartyInstallRecord | null> {
  try {
    const value = JSON.parse(await fs.readFile(join(dir, RECORD_NAME), 'utf8')) as unknown
    if (!value || typeof value !== 'object') return null
    const r = value as Partial<PeerPartyInstallRecord>
    return typeof r.tag === 'string' && typeof r.sha256 === 'string'
      ? {
          tag: r.tag,
          sha256: r.sha256,
          size: typeof r.size === 'number' ? r.size : 0,
          checkedAt: typeof r.checkedAt === 'string' ? r.checkedAt : '',
          installedAt: typeof r.installedAt === 'string' ? r.installedAt : ''
        }
      : null
  } catch {
    return null
  }
}

async function writeRecord(dir: string, record: PeerPartyInstallRecord): Promise<void> {
  await fs.writeFile(join(dir, RECORD_NAME), JSON.stringify(record, null, 2))
}

async function isFile(path: string): Promise<boolean> {
  return fs.stat(path).then(
    (s) => s.isFile() && s.size > 0,
    () => false
  )
}

/** The SHA-256 (lowercase hex), size and first two bytes of a file on disk. */
export async function hashFile(path: string): Promise<{ sha: string; size: number; head: Buffer }> {
  const hash = createHash('sha256')
  let size = 0
  let head = Buffer.alloc(0)
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk)
    if (head.length < 2) head = Buffer.concat([head, chunk.subarray(0, 2 - head.length)])
    size += chunk.length
  }
  return { sha: hash.digest('hex'), size, head }
}

async function fetchLatest(http: typeof fetch): Promise<Release> {
  const res = await http(RELEASES_LATEST, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(60_000)
  })
  if (!res.ok) {
    const said = await res
      .json()
      .then((body) => String((body as { message?: unknown } | null)?.message ?? ''))
      .catch(() => '')
    const limited = res.status === 429 || (res.status === 403 && /rate limit/i.test(said))
    throw new Error(
      limited
        ? tMain('mainPeerParty.release.rateLimited', { status: res.status })
        : tMain('mainPeerParty.release.lookupFailed', { status: res.status })
    )
  }
  const release = (await res.json().catch(() => null)) as Release | null
  if (!release || typeof release !== 'object' || !Array.isArray(release.assets))
    throw new Error(tMain('mainPeerParty.release.unreadable'))
  return release
}

/** The checksum asset's text, or null when it is missing, too large or could not be downloaded. */
async function fetchChecksum(
  http: typeof fetch,
  asset: ReleaseAsset | undefined,
  log: Logger
): Promise<string | null> {
  if (!asset) return null
  if (asset.size > CHECKSUM_MAX_BYTES) {
    log.warn(`PeerParty: ${asset.name} is ${asset.size} bytes, not a checksum file`)
    return null
  }
  try {
    const res = await http(asset.browser_download_url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > CHECKSUM_MAX_BYTES) throw new Error(`${buf.length} bytes`)
    return buf.toString('utf8')
  } catch (err) {
    log.warn(`PeerParty: ${asset.name} could not be downloaded: ${(err as Error).message}`)
    return null
  }
}

/**
 * PlayOut's peerparty.exe, downloaded or updated first when needed. With an exe already there it is used as it is
 * when the last release check is younger than UPDATE_CHECK_MS (`force` checks anyway), when GitHub cannot be reached,
 * or while a PeerParty of ours runs (an update waits for the next start). Throws when there is no exe and none could
 * be downloaded and checked.
 */
export async function ensurePeerParty(
  deps: ReleaseDeps,
  options: { force?: boolean; gameId?: string | null } = {}
): Promise<{ exe: string; tag: string }> {
  const { dir, log } = deps
  const http = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const gameId = options.gameId ?? null
  const exe = join(dir, EXE_NAME)
  await fs.mkdir(dir, { recursive: true })
  const record = await readInstallRecord(dir)
  const have = await isFile(exe)
  const checkedAt = record ? Date.parse(record.checkedAt) : NaN
  if (have && record && !options.force && now() - checkedAt < UPDATE_CHECK_MS && now() >= checkedAt)
    return { exe, tag: record.tag }

  deps.onProgress?.({ gameId, phase: 'checking', message: 'Checking PeerParty…' })
  let release: Release
  try {
    release = await fetchLatest(http)
  } catch (err) {
    if (have) {
      log.warn(`PeerParty: release check failed, using the copy there: ${(err as Error).message}`)
      return { exe, tag: record?.tag ?? 'unknown' }
    }
    throw new Error(
      tMain('mainPeerParty.release.downloadFailed', { error: (err as Error).message }),
      {
        cause: err
      }
    )
  }
  const tag = String(release.tag_name ?? '')
  const stamp = new Date(now()).toISOString()
  if (have && record && record.tag === tag) {
    await writeRecord(dir, { ...record, checkedAt: stamp })
    return { exe, tag }
  }
  if (have && (await deps.busy())) {
    log.info(
      `PeerParty: ${tag} is out, but PeerParty runs now; the update waits for the next start`
    )
    return { exe, tag: record?.tag ?? 'unknown' }
  }

  const asset = release.assets?.find((a) => a.name.toLowerCase() === EXE_NAME)
  if (!asset) {
    if (have) return { exe, tag: record?.tag ?? 'unknown' }
    throw new Error(tMain('mainPeerParty.release.noExe', { tag, file: EXE_NAME }))
  }
  const checksumText = await fetchChecksum(
    http,
    release.assets?.find((a) => a.name.toLowerCase() === CHECKSUM_NAME),
    log
  )
  const checksum = checksumText !== null ? parseChecksum(checksumText, EXE_NAME) : null
  if (checksumText !== null && !checksum)
    log.warn(`PeerParty: ${CHECKSUM_NAME} names no hash for ${EXE_NAME}`)
  const digest = digestHex(asset.digest)
  if (!checksum && !digest) {
    if (have) {
      log.warn(`PeerParty: ${tag} cannot be checked (no checksum); keeping the copy there`)
      return { exe, tag: record?.tag ?? 'unknown' }
    }
    throw new Error(tMain('mainPeerParty.release.cannotCheck'))
  }
  if (!checksum) log.info(`PeerParty: ${tag} has no checksum file; checking GitHub's digest alone`)

  // A name of its own for each download, so no other download can write into the file being checked.
  const part = join(dir, `${EXE_NAME}.${process.pid}-${randomBytes(6).toString('hex')}.download`)
  const old = join(dir, `${EXE_NAME}.old`)
  try {
    log.info(`PeerParty: downloading ${tag} (${asset.size} bytes)`)
    const res = await http(asset.browser_download_url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const total = asset.size || Number(res.headers.get('content-length')) || 0
    let got = 0
    let sentAt = 0
    const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)
    body.on('data', (chunk: Buffer) => {
      got += chunk.length
      const t = now()
      if (t - sentAt >= PROGRESS_EVERY_MS || got === total) {
        sentAt = t
        deps.onProgress?.({
          gameId,
          phase: 'downloading',
          bytesDone: got,
          bytesTotal: total,
          ...(total > 0 ? { percent: Math.min(100, Math.round((got / total) * 100)) } : {})
        })
      }
    })
    await pipeline(body, createWriteStream(part))

    deps.onProgress?.({ gameId, phase: 'verifying', message: 'Checking PeerParty…' })
    // The finished file itself is checked, not the bytes as they arrived, so the file installed is the file checked.
    const { sha, size, head } = await hashFile(part)
    const problems: string[] = []
    if (checksum && sha !== checksum.sha256)
      problems.push(tMain('mainPeerParty.release.hashNotChecksum', { file: CHECKSUM_NAME }))
    if (digest && sha !== digest) problems.push(tMain('mainPeerParty.release.hashNotGithub'))
    if (asset.size && size !== asset.size)
      problems.push(tMain('mainPeerParty.release.sizeMismatch', { size, expected: asset.size }))
    if (checksum?.size !== undefined && size !== checksum.size)
      problems.push(
        tMain('mainPeerParty.release.sizeMismatchChecksum', { size, expected: checksum.size })
      )
    if (head.length < 2 || head[0] !== 0x4d || head[1] !== 0x5a)
      problems.push(tMain('mainPeerParty.release.notWindows'))
    if (problems.length)
      throw new Error(tMain('mainPeerParty.release.checkFailed', { problems: problems.join('; ') }))

    deps.onProgress?.({ gameId, phase: 'installing', message: 'Installing PeerParty…' })
    await fs.rm(old, { force: true })
    if (have) await fs.rename(exe, old)
    try {
      await renameIntoPlace(part, exe, sha)
    } catch (err) {
      if (have) await fs.rename(old, exe).catch(() => {})
      throw err
    }
    await fs.rm(old, { force: true }).catch(() => {})
    await writeRecord(dir, { tag, sha256: sha, size, checkedAt: stamp, installedAt: stamp })
    log.info(`PeerParty: ${tag} installed (sha256 ${sha})`)
    return { exe, tag }
  } catch (err) {
    await fs.rm(part, { force: true }).catch(() => {})
    if (have) {
      log.warn(
        `PeerParty: update to ${tag} failed, keeping the copy there: ${(err as Error).message}`
      )
      return { exe, tag: record?.tag ?? 'unknown' }
    }
    throw err
  }
}
