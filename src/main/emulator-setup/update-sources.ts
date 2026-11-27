import { fetchHeaders, fetchJson, fetchText, type HttpDeps } from './download'
import { digestHex, named, pickAsset, strings, type Release } from './sources'
import type { ResolvedDownload, SourceSpec } from './types'

/**
 * The update channels of Update all emulators (docs/emulator-setup.md, "Updates"): each resolves to the newest nightly
 * / dev build of one emulator, read from the feed the emulator's own updater uses where it has one (RPCS3, Dolphin,
 * mGBA, Ryujinx, PCSX2 and DuckStation's GitHub releases). The feeds were checked on 2026-11-18.
 *
 * A version is only compared for equality with the installed one (the manifest's), so it names the build exactly (a
 * commit, a build number, or a date plus a digest for a moving "latest" file).
 */

export type UpdateSourceSpec = Extract<
  SourceSpec,
  {
    kind:
      | 'github-tag'
      | 'github-newest'
      | 'rpcs3'
      | 'dolphin-dev'
      | 'ppsspp-dev'
      | 'flycast-dev'
      | 'melonds-nightly'
      | 'mgba-dev'
      | 'ryujinx-canary'
      | 'scummvm-daily'
      | 'retroarch-nightly'
  }
>

const GITHUB_API = 'https://api.github.com/repos'
export const RPCS3_UPDATE =
  'https://update.rpcs3.net/?api=v3&c=0000000000000000000000000000000000000000&os_type=windows&os_arch=x64'
export const DOLPHIN_DEV = 'https://dolphin-emu.org/update/latest/dev/'
export const PPSSPP_STATUS = 'https://builds.ppsspp.org/meta/status.json'
export const FLYCAST_BUCKET = 'https://flycast-builds.s3.fr-par.scw.cloud/'
export const FLYCAST_LIST = `${FLYCAST_BUCKET}?list-type=2&prefix=win/heads/master-`
export const MELONDS_NIGHTLIES = 'https://melonds.kuribo64.net/nightlies.php'
export const MGBA_LATEST = 'https://mgba.io/latest.ini'
export const RYUJINX_CANARY =
  'https://update.ryujinx.app/latest/query?os=windows&arch=x64&rc=canary'
export const SCUMMVM_DAILY =
  'https://buildbot.scummvm.org/dailybuilds/master/windows-x86-64-master-latest.zip'
export const RETROARCH_NIGHTLY = 'https://buildbot.libretro.com/nightly/windows/x86_64/'

/** A URL the feed gave: https only. */
function httpsUrl(url: unknown, what: string): string {
  if (typeof url === 'string') {
    try {
      if (new URL(url).protocol === 'https:') return url
    } catch {
      /* not a URL */
    }
  }
  throw new Error(`${what} gave no usable https download link`)
}

/** A version or file name taken from a feed, safe for logs, paths and the manifest. */
function token(value: unknown, what: string): string {
  if (typeof value === 'string' && /^[\w.+-]{1,120}$/.test(value)) return value
  throw new Error(`${what} gave no usable version`)
}

const sizeOf = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

const hex64 = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined

/** DuckStation: the release under its fixed "preview" tag; the version is its publish date plus the file's digest. */
async function githubTag(
  repo: string,
  tag: string,
  asset: RegExp,
  deps: HttpDeps
): Promise<ResolvedDownload[]> {
  return named(`GitHub ${repo} ${tag} build`, async () => {
    const release = await fetchJson<Release & { published_at?: string }>(
      `${GITHUB_API}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      deps
    )
    const d = pickAsset(release, asset, repo)
    const found = release.assets?.find((a) => asset.test(a.name)) as
      { digest?: string | null; updated_at?: string; id?: number } | undefined
    const date = (found?.updated_at ?? release.published_at ?? '').slice(0, 10)
    const id = digestHex(found?.digest)?.slice(0, 8) ?? String(found?.id ?? 'unknown')
    return [{ ...d, version: `${tag}-${date || 'unknown'}-${id}` }]
  })
}

/**
 * Orders release tags by version: numbers first (v2.9.183 > v2.8.3, 2127.0-rc4 > 2126.2), then a release above its
 * own pre-releases (2127.0 > 2127.0-rc4), then the pre-release number (rc4 > rc3). Positive when `a` is newer.
 */
export function compareTags(a: string, b: string): number {
  const split = (tag: string): { base: number[]; pre: number[] | null } => {
    const t = tag.trim().replace(/^[^\d]*/, '')
    const i = t.search(/[-+]/)
    const base = (i < 0 ? t : t.slice(0, i)).split('.').map((n) => Number.parseInt(n, 10) || 0)
    const rest = i < 0 ? '' : t.slice(i + 1)
    return { base, pre: rest ? (rest.match(/\d+/g) ?? ['0']).map(Number) : null }
  }
  const nums = (x: number[], y: number[]): number => {
    for (let k = 0; k < Math.max(x.length, y.length); k++) {
      const d = (x[k] ?? 0) - (y[k] ?? 0)
      if (d) return d
    }
    return 0
  }
  const pa = split(a)
  const pb = split(b)
  const base = nums(pa.base, pb.base)
  if (base) return base
  if (!pa.pre || !pb.pre) return pa.pre ? -1 : pb.pre ? 1 : 0
  return nums(pa.pre, pb.pre)
}

/**
 * The newest release, pre-releases included (drafts never), by version (the list is in creation order: a hotfix of
 * an older line comes after newer nightlies), among those that already have a matching file (a nightly is published
 * before its files are uploaded). The asset is the first pattern's match, else the next one's.
 */
async function githubNewest(
  repo: string,
  assets: RegExp[],
  deps: HttpDeps
): Promise<ResolvedDownload[]> {
  return named(`GitHub ${repo} newest build`, async () => {
    const releases = await fetchJson<(Release & { draft?: boolean })[]>(
      `${GITHUB_API}/${repo}/releases?per_page=20`,
      deps
    )
    if (!Array.isArray(releases)) throw new Error('the release list is not a list')
    let best: { release: Release; asset: RegExp } | null = null
    for (const release of releases) {
      if (!release || release.draft || !release.tag_name) continue
      const asset = assets.find((p) => release.assets?.some((a) => p.test(a.name)))
      if (!asset) continue
      if (!best || compareTags(release.tag_name, best.release.tag_name!) > 0)
        best = { release, asset }
    }
    if (!best) throw new Error(`no recent release has a file matching ${assets[0]!.source}`)
    return [pickAsset(best.release, best.asset, repo)]
  })
}

interface Rpcs3Feed {
  return_code?: number
  latest_build?: {
    version?: string
    windows?: { download?: string; size?: number; checksum?: string }
  }
}

/** RPCS3: update.rpcs3.net (what Help > Check for updates reads), with its SHA-256 and size. */
async function rpcs3(deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named('RPCS3 update server', async () => {
    const feed = await fetchJson<Rpcs3Feed>(RPCS3_UPDATE, deps)
    // -1: our commit is unknown (we send none), 0: current, 1: newer; anything else is a server error.
    if (feed.return_code !== undefined && ![-1, 0, 1].includes(feed.return_code))
      throw new Error(`the server answered code ${feed.return_code}`)
    const build = feed.latest_build
    const version = token(build?.version, 'the server')
    const url = httpsUrl(build?.windows?.download, 'the server')
    return [
      {
        version,
        url,
        fileName: url.split('/').pop() || `rpcs3-${version}.7z`,
        sha256: hex64(build?.windows?.checksum),
        size: sizeOf(build?.windows?.size)
      }
    ]
  })
}

interface DolphinUpdate {
  shortrev?: string
  artifacts?: { system?: string; url?: string }[]
}

/** Dolphin: the dev track of its update service (its own updater's), the Windows x64 7z. */
async function dolphinDev(deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named('Dolphin update service (dev)', async () => {
    const info = await fetchJson<DolphinUpdate>(DOLPHIN_DEV, deps)
    const url = httpsUrl(
      info.artifacts?.find((a) => a.system === 'Windows x64')?.url,
      'the dev track'
    )
    if (!/-x64\.7z$/i.test(url)) throw new Error('the dev track lists no Windows x64 7z')
    const version = token(info.shortrev, 'the dev track')
    return [{ version, url, fileName: url.split('/').pop() || 'dolphin-x64.7z' }]
  })
}

/** PPSSPP: the buildbot's newest finished build (status.json "latest"; "building" may be older and has no files). */
async function ppssppDev(deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named('PPSSPP buildbot', async () => {
    const status = await fetchJson<{ latest?: { description?: string; builds?: unknown } }>(
      PPSSPP_STATUS,
      deps
    )
    const version = token(status.latest?.description, 'the buildbot')
    const windows = (status.latest?.builds as Record<string, unknown> | undefined)?.Windows
    const file = [...strings(windows)]
      .map((s) => s.split('/').pop() ?? '')
      .find((s) => /^ppsspp_win_[\w.+-]+\.zip$/i.test(s))
    if (!file) throw new Error(`build ${version} has no Windows zip`)
    return [
      {
        version,
        url: `https://builds.ppsspp.org/builds/${encodeURIComponent(version)}/${file}`,
        fileName: file
      }
    ]
  })
}

/** Flycast: the newest master build in its CI bucket (an S3 listing; keys are not in date order). */
async function flycastDev(deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named('Flycast build bucket', async () => {
    const xml = await fetchText(FLYCAST_LIST, deps)
    let best: { key: string; sha: string; at: string; size?: number } | null = null
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const body = m[1]!
      const key = /<Key>([^<]+)<\/Key>/.exec(body)?.[1]
      const sha = key ? /^win\/heads\/master-([0-9a-f]{40})\/flycast\.zip$/.exec(key)?.[1] : null
      const at = /<LastModified>([^<]+)<\/LastModified>/.exec(body)?.[1] ?? ''
      if (!key || !sha) continue
      if (!best || at > best.at)
        best = { key, sha, at, size: sizeOf(/<Size>(\d+)<\/Size>/.exec(body)?.[1]) }
    }
    if (!best) throw new Error('no Windows master build is listed')
    return [
      {
        version: `master-${best.sha.slice(0, 7)}`,
        url: `${FLYCAST_BUCKET}${best.key}`,
        fileName: `flycast-master-${best.sha.slice(0, 7)}.zip`,
        size: best.size
      }
    ]
  })
}

/** melonDS: the newest entry of its nightlies page (one per master commit, newest first), with its SHA-256. */
async function melondsNightly(deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named('melonDS nightlies', async () => {
    const html = await fetchText(MELONDS_NIGHTLIES, deps)
    const m = /href="(nightly\/(\d+)\/melonDS-windows-x86_64\.zip)"/.exec(html)
    if (!m) throw new Error('no Windows x86_64 nightly is listed')
    // The checksum is in the same table row; the commit in the entry's title above it.
    const row = html.slice(m.index, html.indexOf('</tr>', m.index) + 1 || m.index + 600)
    const sha256 = /\b([0-9a-f]{64})\b/i.exec(row)?.[1]?.toLowerCase()
    const before = html.slice(0, m.index)
    const commits = [...before.matchAll(/Commit\s+([0-9a-f]{7,40})/gi)]
    const commit = commits.at(-1)?.[1]?.slice(0, 7)
    return [
      {
        version: `nightly-${commit ?? m[2]}`,
        url: `https://melonds.kuribo64.net/${m[1]}`,
        fileName: `melonDS-nightly-${commit ?? m[2]}-windows-x86_64.zip`,
        sha256
      }
    ]
  })
}

/** `key: value` lines of one [section] of mGBA's latest.ini. */
export function iniSection(text: string, section: string): Map<string, string> {
  const out = new Map<string, string>()
  let inside = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const head = /^\[([^\]]+)\]$/.exec(line)
    if (head) {
      inside = head[1] === section
      continue
    }
    if (!inside) continue
    const kv = /^([\w.-]+)\s*[:=]\s*(.*)$/.exec(line)
    if (kv) out.set(kv[1]!, kv[2]!.trim())
  }
  return out
}

/** mGBA: the dev build of its update manifest (what its own updater reads), with its SHA-256 and size. */
async function mgbaDev(deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named('mGBA update manifest', async () => {
    const text = await fetchText(MGBA_LATEST, deps)
    const bucket = httpsUrl(iniSection(text, 'meta').get('bucket'), 'the manifest')
    const win = iniSection(text, 'platform.win64')
    const name = win.get('dev.name')
    if (!name || !/^[\w./-]+\.7z$/.test(name) || name.includes('..'))
      throw new Error('the manifest lists no Windows x64 dev build')
    const rev = win.get('dev.rev')
    const commit = win.get('dev.commit')?.slice(0, 7)
    const version = token(
      rev ? `r${rev}${commit ? `-${commit}` : ''}` : name.split('/').pop()?.replace(/\.7z$/, ''),
      'the manifest'
    )
    return [
      {
        version,
        url: new URL(name, bucket.endsWith('/') ? bucket : `${bucket}/`).toString(),
        fileName: name.split('/').pop()!,
        sha256: hex64(win.get('dev.sha256')),
        size: sizeOf(win.get('dev.size'))
      }
    ]
  })
}

/** Ryujinx: the canary channel of its update server (what its own updater asks). */
async function ryujinxCanary(deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named('Ryujinx update server (canary)', async () => {
    const info = await fetchJson<{ tag?: string; download_url?: string }>(RYUJINX_CANARY, deps)
    const version = token(info.tag, 'the server')
    const url = httpsUrl(info.download_url, 'the server')
    const fileName = url.split('/').pop() ?? ''
    if (!/win_x64\.zip$/i.test(fileName)) throw new Error('the server gave no Windows x64 zip')
    return [{ version, url, fileName }]
  })
}

/** ScummVM: the daily build of master (a fixed -latest URL; the version is its date and ETag). */
async function scummvmDaily(deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named('ScummVM daily builds', async () => {
    const headers = await fetchHeaders(SCUMMVM_DAILY, deps)
    const modified = Date.parse(headers.get('last-modified') ?? '')
    const etag = (headers.get('etag') ?? '').replace(/^W\//, '').replace(/[^\w]/g, '').slice(0, 8)
    if (!Number.isFinite(modified) && !etag) throw new Error('the build has no date or tag')
    const date = Number.isFinite(modified)
      ? new Date(modified).toISOString().slice(0, 10)
      : 'unknown'
    return [
      {
        version: `master-${date}${etag ? `-${etag}` : ''}`,
        url: SCUMMVM_DAILY,
        fileName: 'scummvm-windows-x86-64-master-latest.zip',
        size: sizeOf(headers.get('content-length'))
      }
    ]
  })
}

/** RetroArch: the nightly frontend (RetroArch_update.7z: the program, no assets or settings) and its cores. */
async function retroarchNightly(deps: HttpDeps): Promise<ResolvedDownload[]> {
  return named('libretro buildbot (RetroArch nightly)', async () => {
    const html = await fetchText(RETROARCH_NIGHTLY, deps)
    const dates = [...html.matchAll(/(\d{4}-\d{2}-\d{2})_RetroArch\.7z/g)].map((m) => m[1]!).sort()
    const date = dates.at(-1)
    if (!date || !html.includes('RetroArch_update.7z') || !html.includes('RetroArch_cores.7z'))
      throw new Error('the nightly folder lists no RetroArch build')
    const version = `nightly-${date}`
    return [
      { version, url: `${RETROARCH_NIGHTLY}RetroArch_update.7z`, fileName: 'RetroArch_update.7z' },
      { version, url: `${RETROARCH_NIGHTLY}RetroArch_cores.7z`, fileName: 'RetroArch_cores.7z' }
    ]
  })
}

/** The files of the newest build on an update channel. */
export function resolveUpdateSource(
  spec: UpdateSourceSpec,
  deps: HttpDeps
): Promise<ResolvedDownload[]> {
  switch (spec.kind) {
    case 'github-tag':
      return githubTag(spec.repo, spec.tag, spec.asset, deps)
    case 'github-newest':
      return githubNewest(spec.repo, spec.asset, deps)
    case 'rpcs3':
      return rpcs3(deps)
    case 'dolphin-dev':
      return dolphinDev(deps)
    case 'ppsspp-dev':
      return ppssppDev(deps)
    case 'flycast-dev':
      return flycastDev(deps)
    case 'melonds-nightly':
      return melondsNightly(deps)
    case 'mgba-dev':
      return mgbaDev(deps)
    case 'ryujinx-canary':
      return ryujinxCanary(deps)
    case 'scummvm-daily':
      return scummvmDaily(deps)
    case 'retroarch-nightly':
      return retroarchNightly(deps)
  }
}
