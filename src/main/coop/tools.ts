import { createWriteStream, promises as fs } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import type { Logger } from '../logger'
import { extractZip } from '../util/zip'
import { tMain } from '../i18n'

/**
 * Nucleus Co-op's tools (its hook DLLs, ProtoInput, EasyHook, the Goldberg Steam emulator, XInputPlus, x360ce and the
 * other utilities handlers call for): not shipped with PlayOut (several may not be redistributed), but taken once
 * from the official Nucleus Co-op release the first time Co-Op is used, into the engine root. Only the tools are
 * extracted: the Nucleus app itself (its window, launcher, updater, web view and UI files) is left out, and never
 * run. The managed engine files come from PlayOut's own helper build, copied in afterwards.
 */

const RELEASES_API = 'https://api.github.com/repos/SplitScreen-Me/splitscreenme-nucleus/releases'
/**
 * The Nucleus Co-op release the helper's engine is built to run with (coop-helper/README.md: its ProtoInput calls
 * are made optional for "the released Nucleus Co-op 2.4.2"). A later release may ship tools the engine cannot load,
 * so this one is asked for first; the latest is taken only when GitHub no longer has it.
 */
export const PINNED_RELEASE_TAG = 'v2.4.2'
const USER_AGENT = 'PlayOut (+https://github.com/jeremybris/PlayOut)'
const TIMEOUT_MS = 30 * 60_000
export const TOOLS_MARKER = 'playout-tools.json'
/** The Nucleus Co-op release zip is password-protected; its release notes give the password. */
export const RELEASE_PASSWORD = 'nucleus'

/** Release files that are the Nucleus app or replaced by the helper's own build: not extracted. */
const SKIP =
  /^(NucleusCoop\.exe(\.config)?|Nucleus_Launcher\.exe|Updater\.exe|checkDotNet472Ver\.bat|Settings\.ini|Nucleus\.Gaming\.dll|Nucleus\.IJx(86|64)\.exe|StartGame\.exe(\.config)?|readme\.txt|names\.txt|folder\.txt)$|^(gui|webview|handlers|content|debug|logs)\//i

/** Whether a release zip entry is one of the tools. */
export function isToolEntry(name: string): boolean {
  return !SKIP.test(name.replace(/\\/g, '/'))
}

export interface ToolsDeps {
  root: string
  /** Where the release zip is downloaded to (deleted after). */
  workDir: string
  log: Logger
  onBytes?: (done: number, total: number) => void
  fetch?: typeof fetch
}

interface Release {
  tag_name?: string
  assets?: { name: string; browser_download_url: string; size: number }[]
}

/** One release record from GitHub; null when there is no such release (404). Any other failure throws. */
async function fetchRelease(http: typeof fetch, url: string): Promise<Release | null> {
  const res = await http(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(60_000)
  })
  if (res.status === 404) return null
  if (!res.ok) {
    // GitHub answers errors (rate limit, outage) with JSON too: { "message": "API rate limit exceeded…" }.
    const said = await res
      .json()
      .then((body) => String((body as { message?: unknown } | null)?.message ?? ''))
      .catch(() => '')
    const limited = res.status === 429 || (res.status === 403 && /rate limit/i.test(said))
    throw new Error(
      limited
        ? tMain('mainCoop.tools.rateLimited', { status: res.status })
        : said
          ? tMain('mainCoop.tools.lookupFailedSaid', {
              status: res.status,
              said: said.slice(0, 200)
            })
          : tMain('mainCoop.tools.lookupFailed', { status: res.status })
    )
  }
  const release = (await res.json().catch(() => null)) as Release | null
  if (!release || typeof release !== 'object' || !Array.isArray(release.assets))
    throw new Error(tMain('mainCoop.tools.unreadable'))
  return release
}

export async function toolsReady(root: string): Promise<boolean> {
  return fs.access(join(root, TOOLS_MARKER)).then(
    () => true,
    () => false
  )
}

/** Download and extract the tools when they are not there yet. */
export async function ensureTools(deps: ToolsDeps): Promise<void> {
  if (await toolsReady(deps.root)) return
  const http = deps.fetch ?? fetch
  let release = await fetchRelease(http, `${RELEASES_API}/tags/${PINNED_RELEASE_TAG}`)
  if (!release) {
    deps.log.warn(
      `Co-Op: Nucleus Co-op ${PINNED_RELEASE_TAG} was not found on GitHub; taking the latest release`
    )
    release = await fetchRelease(http, `${RELEASES_API}/latest`)
    if (!release) throw new Error(tMain('mainCoop.tools.noRelease'))
  }
  const asset =
    release.assets?.find((a) => /^NucleusApp.*\.zip$/i.test(a.name)) ??
    release.assets?.find((a) => /\.zip$/i.test(a.name))
  if (!asset) throw new Error(tMain('mainCoop.tools.noPackage'))
  deps.log.info(
    `Co-Op: downloading the Nucleus Co-op tools (${release.tag_name ?? '?'}, ${asset.name})`
  )
  await fs.mkdir(deps.workDir, { recursive: true })
  const zip = join(deps.workDir, 'nucleus-release.zip.part')
  try {
    const res = await http(asset.browser_download_url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) || asset.size || 0
    let got = 0
    const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)
    body.on('data', (chunk: Buffer) => {
      got += chunk.length
      deps.onBytes?.(got, total)
    })
    await pipeline(body, createWriteStream(zip))
    await fs.mkdir(deps.root, { recursive: true })
    const written = await extractZip(zip, deps.root, (e) => (isToolEntry(e.name) ? e.name : null), {
      password: RELEASE_PASSWORD
    })
    await fs.writeFile(
      join(deps.root, TOOLS_MARKER),
      JSON.stringify({
        release: release.tag_name,
        asset: asset.name,
        files: written.length,
        at: new Date().toISOString()
      })
    )
    deps.log.info(`Co-Op: ${written.length} Nucleus Co-op tool file(s) extracted`)
  } finally {
    await fs.rm(zip, { force: true }).catch(() => {})
  }
}

/**
 * Copy PlayOut's helper build (shipped in resources\coop) into the engine root when it changed: the helper runs from
 * there, beside the tools it loads (Nucleus's layout).
 */
export async function syncHelper(helperDir: string, root: string, log: Logger): Promise<void> {
  const stamp = async (dir: string): Promise<string> =>
    fs.readFile(join(dir, 'playout-coop-version.txt'), 'utf8').catch(() => '')
  const shipped = await stamp(helperDir)
  if (!shipped) throw new Error(tMain('mainCoop.noHelperLower'))
  if ((await stamp(root)) === shipped) return
  await fs.mkdir(root, { recursive: true })
  await fs.cp(helperDir, root, { recursive: true, force: true })
  log.info(`Co-Op: helper ${shipped.trim()} copied to ${root}`)
}
