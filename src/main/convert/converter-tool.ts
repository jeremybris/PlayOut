import { createWriteStream, promises as fs } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import type { Logger } from '../logger'
import { extractZip } from '../util/zip'
import { tMain } from '../i18n'

/**
 * Game Format Converter (github.com/Mr-Shizzy/Game-Format-Converter, GPL-3.0): the program that does Settings ›
 * Convert's conversions, with MAME's chdman bundled. It is not part of PlayOut: its official Windows release is
 * downloaded on first use into `<root>\<version>`, unchanged, and run through its command line (`cli`), as a
 * separate program.
 */
export const CONVERTER_REPO = 'Mr-Shizzy/Game-Format-Converter'
const RELEASE_API = `https://api.github.com/repos/${CONVERTER_REPO}/releases/latest`
const USER_AGENT = 'PlayOut (+https://github.com/jeremybris/PlayOut)'
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000
const MARKER = 'playout-converter.json'
export const CONVERTER_EXE = 'Game Format Converter.exe'
/**
 * The oldest converter Convert works with: 2.1.1 added the ROM tools (N64, SNES, Mega Drive, PC Engine, DS) and
 * Games on Demand to ISO. An older one downloaded before is replaced by the latest release at the next conversion.
 */
export const MIN_CONVERTER_VERSION = '2.1.1'

/** Whether version `a` ("2.1.1") is `b` or newer; numeric parts compared in turn, a missing one counting as 0. */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}

export interface ConverterInstall {
  version: string
  exe: string
}

export interface ConverterToolDeps {
  /** `<userData>\tools\game-format-converter`. */
  root: string
  log: Logger
  fetch?: typeof fetch
}

interface Marker {
  version: string
  dir: string
}

/** Strip the release zip's top folder ("Game Format Converter\…"): the files land in the version folder itself. */
export function converterEntryPath(name: string): string | null {
  const parts = name.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length < 2) return parts[0] ?? null
  return parts.slice(1).join('/')
}

async function exists(path: string): Promise<boolean> {
  return fs.access(path).then(
    () => true,
    () => false
  )
}

/** The installed converter, or null when it is not downloaded (or its files are gone). */
export async function installedConverter(root: string): Promise<ConverterInstall | null> {
  try {
    const marker = JSON.parse(await fs.readFile(join(root, MARKER), 'utf8')) as Marker
    if (typeof marker.version !== 'string' || typeof marker.dir !== 'string') return null
    const exe = join(root, marker.dir, CONVERTER_EXE)
    return (await exists(exe)) ? { version: marker.version, exe } : null
  } catch {
    return null
  }
}

/**
 * The converter, downloaded first when it is not there (or older than MIN_CONVERTER_VERSION): the latest release's
 * Windows zip, extracted into its own version folder; the marker is written last, so a broken download is never taken
 * for an installed one, and the older version is removed only once the new one is in place.
 */
export async function ensureConverter(
  deps: ConverterToolDeps,
  onBytes?: (done: number, total: number) => void
): Promise<ConverterInstall> {
  const installed = await installedConverter(deps.root)
  if (installed && versionAtLeast(installed.version, MIN_CONVERTER_VERSION)) return installed
  if (!installed) return downloadConverter(deps, onBytes)
  deps.log.info(
    `Convert: Game Format Converter ${installed.version} is older than ${MIN_CONVERTER_VERSION}; updating`
  )
  try {
    return await downloadConverter(deps, onBytes)
  } catch (err) {
    // Offline, or GitHub unreachable: the older converter still does what it did (a newer conversion fails with its
    // own message), and the update is tried again at the next conversion.
    deps.log.warn(`Convert: the converter could not be updated: ${(err as Error).message}`)
    return installed
  }
}

/** The latest release's Windows zip, downloaded and extracted into its own version folder. */
async function downloadConverter(
  deps: ConverterToolDeps,
  onBytes?: (done: number, total: number) => void
): Promise<ConverterInstall> {
  const http = deps.fetch ?? fetch
  const res = await http(RELEASE_API, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(60_000)
  })
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the converter's release`)
  const release = (await res.json()) as {
    tag_name?: string
    assets?: { name: string; browser_download_url: string; size: number }[]
  }
  const asset = release.assets?.find((a) => /-win64\.zip$/i.test(a.name))
  const version = (release.tag_name ?? '').replace(/^v/i, '')
  if (!asset || !version || !/^[\w.-]+$/.test(version))
    throw new Error(tMain('mainConvert.tool.noWindows'))
  deps.log.info(`Convert: downloading Game Format Converter ${version} (${asset.name})`)
  await fs.mkdir(deps.root, { recursive: true })
  const zip = join(deps.root, `${asset.name}.part`)
  const dir = join(deps.root, version)
  try {
    const download = await http(asset.browser_download_url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    })
    if (!download.ok || !download.body)
      throw new Error(tMain('mainConvert.tool.downloadFailed', { status: download.status }))
    const total = Number(download.headers.get('content-length')) || asset.size || 0
    let got = 0
    const body = Readable.fromWeb(download.body as unknown as WebReadableStream<Uint8Array>)
    body.on('data', (chunk: Buffer) => {
      got += chunk.length
      onBytes?.(got, total)
    })
    await pipeline(body, createWriteStream(zip))
    await fs.rm(dir, { recursive: true, force: true })
    await extractZip(zip, dir, (e) => converterEntryPath(e.name))
    if (!(await exists(join(dir, CONVERTER_EXE))))
      throw new Error(tMain('mainConvert.tool.noExe', { file: CONVERTER_EXE }))
    await fs.writeFile(join(deps.root, MARKER), JSON.stringify({ version, dir: version }))
    // Earlier versions go once the new one is in place.
    for (const entry of await fs.readdir(deps.root, { withFileTypes: true }))
      if (entry.isDirectory() && entry.name !== version)
        await fs.rm(join(deps.root, entry.name), { recursive: true, force: true }).catch(() => {})
    deps.log.info(`Convert: Game Format Converter ${version} is ready`)
    return { version, exe: join(dir, CONVERTER_EXE) }
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  } finally {
    await fs.rm(zip, { force: true }).catch(() => {})
  }
}
