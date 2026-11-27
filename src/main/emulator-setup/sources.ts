import { fetchJson, fetchText, type HttpDeps } from './download'
import type { ResolvedDownload, SourceSpec } from './types'
import { resolveUpdateSource } from './update-sources'

/**
 * Resolves an emulator's SourceSpec to the files to download (the newest stable Windows x64 build). Every error names
 * the source it came from.
 */

const GITHUB_API = 'https://api.github.com/repos'
const DOLPHIN_UPDATE = 'https://dolphin-emu.org/update/latest/beta/'
const RETROARCH_STABLE = 'https://buildbot.libretro.com/stable/'
const SCUMMVM_RELEASE = `${GITHUB_API}/scummvm/scummvm/releases/latest`

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size?: number
  /** GitHub only: 'sha256:<hex>'. */
  digest?: string | null
}

export interface Release {
  tag_name?: string
  name?: string
  assets?: ReleaseAsset[]
}

/** `sha256:<hex>` -> lower-case hex, or undefined. */
export function digestHex(digest: string | null | undefined): string | undefined {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(digest?.trim() ?? '')
  return m ? m[1]!.toLowerCase() : undefined
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Runs `fn`, prefixing its error with the source's name. */
export async function named<T>(source: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const e = new Error(`${source}: ${message(err)}`)
    if (err instanceof Error && err.name === 'AbortError') e.name = 'AbortError'
    throw e
  }
}

/** The release's first asset whose name matches. */
export function pickAsset(release: Release, asset: RegExp, what: string): ResolvedDownload {
  const found = release.assets?.find((a) => asset.test(a.name))
  if (!found)
    throw new Error(
      `the latest release${release.tag_name ? ` (${release.tag_name})` : ''} of ${what} has no file matching ${asset.source}`
    )
  return {
    version: release.tag_name || release.name || 'latest',
    url: found.browser_download_url,
    fileName: found.name,
    sha256: digestHex(found.digest),
    size: typeof found.size === 'number' && found.size > 0 ? found.size : undefined
  }
}

async function github(repo: string, asset: RegExp, deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named(`GitHub release of ${repo}`, async () => {
    const release = await fetchJson<Release>(`${GITHUB_API}/${repo}/releases/latest`, deps)
    return [pickAsset(release, asset, repo)]
  })
}

async function forgejo(api: string, asset: RegExp, deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named(`release lookup ${api}`, async () => {
    const release = await fetchJson<Release>(api, deps)
    const d = pickAsset(release, asset, api)
    // Forgejo publishes no digest.
    return [{ ...d, sha256: undefined }]
  })
}

/** Every string anywhere in `value`. */
export function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value
  else if (Array.isArray(value)) for (const v of value) yield* strings(v)
  else if (value && typeof value === 'object')
    for (const v of Object.values(value as Record<string, unknown>)) yield* strings(v)
}

interface DolphinUpdate {
  shortrev?: string
  artifacts?: { system?: string; url?: string }[]
}

async function dolphin(deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named('Dolphin update service', async () => {
    const info = await fetchJson<DolphinUpdate>(DOLPHIN_UPDATE, deps)
    let url = info.artifacts?.find((a) => a.system === 'Windows x64')?.url
    // Tolerate a changed shape: any https URL of a Windows x64 7z.
    if (!url) url = [...strings(info)].find((s) => /^https:\/\/\S+-x64\.7z$/i.test(s))
    if (!url) throw new Error('no Windows x64 build is listed')
    const fileName = url.split('/').pop() || 'dolphin-x64.7z'
    const version = info.shortrev || /dolphin-([^/]+)-x64\.7z$/i.exec(url)?.[1] || 'latest'
    return [{ version, url, fileName }]
  })
}

/** Compares dotted numeric versions. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** The x.y.z folder versions an index page links to (absolute, relative or full URLs). */
export function stableVersions(html: string): string[] {
  const found = new Set<string>()
  for (const m of html.matchAll(/href="(?:[^"]*\/)?(\d+\.\d+\.\d+)\/"/g)) found.add(m[1]!)
  return [...found].sort(compareVersions)
}

async function retroarch(deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named('libretro buildbot (RetroArch stable)', async () => {
    const versions = stableVersions(await fetchText(RETROARCH_STABLE, deps))
    const version = versions.at(-1)
    if (!version) throw new Error('no stable version folder was found')
    const base = `${RETROARCH_STABLE}${version}/windows/x86_64/`
    return [
      { version, url: `${base}RetroArch.7z`, fileName: 'RetroArch.7z' },
      { version, url: `${base}RetroArch_cores.7z`, fileName: 'RetroArch_cores.7z' }
    ]
  })
}

async function scummvm(deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named('ScummVM release', async () => {
    const release = await fetchJson<Release>(SCUMMVM_RELEASE, deps)
    const version = (release.tag_name ?? '').replace(/^v/i, '')
    if (!/^[\w.-]+$/.test(version)) throw new Error('the latest release has no usable tag')
    const fileName = `scummvm-${version}-win32-x86_64.zip`
    const url = `https://downloads.scummvm.org/frs/scummvm/${version}/${fileName}`
    let sha256: string | undefined
    try {
      sha256 = /\b([0-9a-f]{64})\b/i
        .exec(await fetchText(`${url}.sha256`, deps))?.[1]
        ?.toLowerCase()
    } catch (err) {
      if (deps.signal?.aborted) throw err
      deps.log.warn(
        `ScummVM ${version}: no checksum file (${message(err)}); downloading unverified`
      )
    }
    return [{ version, url, fileName, sha256 }]
  })
}

/** The files to download for an emulator's source (RetroArch: the frontend and its cores). */
export async function resolveSource(spec: SourceSpec, deps: HttpDeps): Promise<ResolvedDownload[]> {
  switch (spec.kind) {
    case 'github':
      return github(spec.repo, spec.asset, deps)
    case 'forgejo':
      return forgejo(spec.api, spec.asset, deps)
    case 'dolphin':
      return dolphin(deps)
    case 'retroarch':
      return retroarch(deps)
    case 'scummvm':
      return scummvm(deps)
    case 'fixed':
      return [
        {
          version: spec.version,
          url: spec.url,
          fileName: spec.fileName,
          sha256: spec.sha256.toLowerCase()
        }
      ]
    case 'drive-folder':
      // Not an archive: the service downloads the folder itself (drive-folder.ts).
      throw new Error(`Drive folder ${spec.folderId} is downloaded as a folder, not as files`)
    default:
      // Update all emulators' channels (nightly / dev builds).
      return resolveUpdateSource(spec, deps)
  }
}
