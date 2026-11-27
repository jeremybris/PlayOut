// PS3 game updates: the list Sony's update server keeps for a game (the same one a PS3 asks for, and that
// PS3GameUpdateDownloader shows), the update packages (PKG) downloaded and checked against their SHA-1, and their
// install through RPCS3 (`rpcs3.exe --headless --installpkg <pkg>`), which unpacks them into the dev_hdd0 it uses
// (Emulation\Updates and DLC\PS3\dev_hdd0, ps3-hdd.ts).

import { createHash } from 'crypto'
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { request as httpsRequest } from 'https'
import { dirname, join, resolve } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { sfoFileString } from './ps3-hdd'
import { tMain } from '../i18n'

/**
 * Sony's root certificate for its PS3 update server (SCEI DNAS Root 05, SHA-256
 * 51:D5:A7:83:3F:67:F1:D1:C6:21:2F:75:99:7E:4B:83:DA:DA:0F:79:10:BA:4B:5A:3F:A4:E9:B7:B9:BC:82:7C). The server's
 * certificate chains to it, not to a public authority, so the update list is fetched trusting it, and only it, for
 * that one host; nothing else about the connection is relaxed.
 */
export const SONY_UPDATE_CA = `-----BEGIN CERTIFICATE-----
MIID0jCCArqgAwIBAgIBADANBgkqhkiG9w0BAQUFADBUMQswCQYDVQQGEwJKUDEp
MCcGA1UEChMgU29ueSBDb21wdXRlciBFbnRlcnRhaW5tZW50IEluYy4xGjAYBgNV
BAMTEVNDRUkgRE5BUyBSb290IDA1MB4XDTA0MDcxMjA5MDExOVoXDTM3MTIwNjA5
MDExOVowVDELMAkGA1UEBhMCSlAxKTAnBgNVBAoTIFNvbnkgQ29tcHV0ZXIgRW50
ZXJ0YWlubWVudCBJbmMuMRowGAYDVQQDExFTQ0VJIEROQVMgUm9vdCAwNTCCASIw
DQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANmPeza8PwCqlI7esOGIkoSESnIN
g72ZD3Ut63jy7SdothPIvGBqVZWYkIpqJYJd1I4Nh//IpXQCQL0PnJLrh9BBeowq
Muf5NNq3Us80Ihiu9CvNEAEO18g3OFV1TYdSwQ5zUsk33OUeI7h4aBPDVcZXYeHt
dbPLqe4K8igian5prrAD5S6h28t8aAm+qMWRo+bW25B/841XwDGBP7/IxZv8Yoio
rCo80CVYe6lGoU08eeqQiaHI5zAF281DWZSoVfLjJUEWmEnxqr8aOhszRGePi+Ei
7UQjHDuZX9rLhDI1zAND+BA259tn/iwOqVXe20OccJllHJcG4Ecmd98f5qMCAwEA
AaOBrjCBqzAdBgNVHQ4EFgQUxlahM1tPzoN3YgVEhm0gV7Wv2twwfAYDVR0jBHUw
c4AUxlahM1tPzoN3YgVEhm0gV7Wv2tyhWKRWMFQxCzAJBgNVBAYTAkpQMSkwJwYD
VQQKEyBTb255IENvbXB1dGVyIEVudGVydGFpbm1lbnQgSW5jLjEaMBgGA1UEAxMR
U0NFSSBETkFTIFJvb3QgMDWCAQAwDAYDVR0TBAUwAwEB/zANBgkqhkiG9w0BAQUF
AAOCAQEACZPihjwXA27wJ03tEKcHAeFLi8aBw2ysH4GwuH1dWb3UpuznWOB0iQT1
wQocnEFYCJx5XFEnj4aLWpSHLEq/sSO+my+aPoTEsy20ajF+YLYZm0bZxH50CJYh
rkET4C2aC0XvhGp9k1JQ1o0W6+cFT5LTlXapsq8Btt31t+XDPX7RqGV4WGekt3hM
T7xRc7JWXdAQijIrbYi8mtbM07KEGnPU6IT8C47+0mSurpwLOoWL1tPgo6ePpLNi
c4quUMgh9RXVjeTyXOMmyYdeUm2gt7qErvQONli+6Epmhm0A2khpIMHSpQjTE8gV
rZp42a6+zg1iYy2vFBOmiQ17GRUl0A==
-----END CERTIFICATE-----
`

/** The update list of a title: https://a0.ww.np.dl.playstation.net/tpl/np/<ID>/<ID>-ver.xml (empty = no updates). */
export function updateListUrl(titleId: string): string {
  return `https://a0.ww.np.dl.playstation.net/tpl/np/${titleId}/${titleId}-ver.xml`
}

/** One update package of a title. */
export interface Ps3UpdatePackage {
  /** The version the game has after it ("01.11"). */
  version: string
  size: number
  /** SHA-1 of the package without its last 32 bytes (lowercase hex). */
  sha1: string
  url: string
  /** The PS3 system software it needs ("04.4000"), when listed. */
  systemVersion: string | null
}

const SERIAL = /^[A-Z]{4}\d{5}$/
const SHA1 = /^[0-9a-f]{40}$/
const VERSION = /^\d{1,2}\.\d{1,2}$/

function xmlAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    out[m[1]!] = (m[2] ?? m[3] ?? '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  return out
}

/**
 * The packages of an update list (`<titlepatch titleid="..."><tag><package version size sha1sum url .../>`), oldest
 * first. Empty for an empty or unreadable list, another title's list, or packages that are not Sony's PKG downloads.
 */
export function parseUpdateList(xml: string, titleId: string): Ps3UpdatePackage[] {
  const head = /<titlepatch\b[^>]*>/i.exec(xml)
  if (!head || xmlAttrs(head[0]).titleid?.toUpperCase() !== titleId.toUpperCase()) return []
  const out: Ps3UpdatePackage[] = []
  for (const m of xml.matchAll(/<package\b[^>]*>/gi)) {
    const a = xmlAttrs(m[0])
    const size = Number(a.size)
    const sha1 = (a.sha1sum ?? '').toLowerCase()
    const url = a.url ?? ''
    if (!VERSION.test(a.version ?? '') || !Number.isFinite(size) || size <= 32) continue
    if (!SHA1.test(sha1) || !isSonyPackageUrl(url)) continue
    out.push({ version: a.version!, size, sha1, url, systemVersion: a.ps3_system_ver ?? null })
  }
  return out.sort((x, y) => compareVersions(x.version, y.version))
}

/** A package URL from Sony's own download servers (http or https, *.dl.playstation.net, a .pkg). */
export function isSonyPackageUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      /(^|\.)dl\.playstation\.net$/i.test(u.hostname) &&
      /\.pkg$/i.test(u.pathname)
    )
  } catch {
    return false
  }
}

/** Compares "01.11" style versions numerically (-1, 0, 1). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * The packages still to install, oldest first: every listed package newer than `installed` (a PS3 installs them one
 * after another too; most games list only their latest, which holds the earlier ones). `installed` null = unknown:
 * all of them.
 */
export function pendingPackages(
  packages: readonly Ps3UpdatePackage[],
  installed: string | null
): Ps3UpdatePackage[] {
  return packages.filter((p) => !installed || compareVersions(p.version, installed) > 0)
}

/**
 * The version a PS3 game is at: the APP_VER of its installed update or PSN install (dev_hdd0\game\<ID>\PARAM.SFO),
 * else of the game folder itself (PS3_GAME\PARAM.SFO), else null (a disc image: its base version, not read).
 */
export async function installedVersion(
  dev0: string,
  titleId: string,
  gameFolder: string | null
): Promise<string | null> {
  const candidates = [join(dev0, 'game', titleId, 'PARAM.SFO')]
  if (gameFolder)
    candidates.push(join(gameFolder, 'PS3_GAME', 'PARAM.SFO'), join(gameFolder, 'PARAM.SFO'))
  let best: string | null = null
  for (const p of candidates) {
    const v = await sfoFileString(p, 'APP_VER')
    if (v && VERSION.test(v) && (!best || compareVersions(v, best) > 0)) best = v
  }
  return best
}

/**
 * The dev_hdd0 an RPCS3 installs into: its config\vfs.yml's /dev_hdd0/ (PlayOut's own RPCS3 points it at
 * Emulation\Updates and DLC\PS3\dev_hdd0; one chosen in Settings may keep RPCS3's default, $(EmulatorDir)dev_hdd0/
 * next to it).
 */
export async function rpcs3Dev0(exe: string): Promise<string> {
  const emuDir = dirname(exe)
  const text = await fs.readFile(join(emuDir, 'config', 'vfs.yml'), 'utf8').catch(() => '')
  const line =
    /^\/dev_hdd0\/:[ \t]*(.*)$/m
      .exec(text)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? ''
  const value = (line || '$(EmulatorDir)dev_hdd0/').replace(/\$\(EmulatorDir\)/g, `${emuDir}/`)
  return resolve(emuDir, value)
}

/** A GET that answers the status and the body (text), for the update list. */
export type TextGet = (
  url: string,
  signal?: AbortSignal
) => Promise<{ status: number; body: string }>

/** The update list request: Sony's server, trusting SONY_UPDATE_CA only. Bodies over 1 MB are refused. */
export const sonyGet: TextGet = (url, signal) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: 'GET', ca: SONY_UPDATE_CA, timeout: 20_000, signal },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > 1024 * 1024) {
            req.destroy(new Error(tMain('mainEmulation.ps3.listTooLarge')))
            return
          }
          chunks.push(c)
        })
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
        res.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error(tMain('mainEmulation.ps3.serverNoAnswer'))))
    req.on('error', reject)
    req.end()
  })

/** The update packages Sony lists for `titleId` (empty when it has none). Throws when the server cannot be reached. */
export async function fetchUpdateList(
  titleId: string,
  get: TextGet = sonyGet,
  signal?: AbortSignal
): Promise<Ps3UpdatePackage[]> {
  if (!SERIAL.test(titleId)) return []
  const res = await get(updateListUrl(titleId), signal)
  // 404 (and an empty body) is how the server says a title has no updates.
  if (res.status === 404 || !res.body.trim()) return []
  if (res.status !== 200)
    throw new Error(tMain('mainEmulation.ps3.serverAnswered', { status: res.status, titleId }))
  return parseUpdateList(res.body, titleId)
}

/**
 * SHA-1 of a package without its last 32 bytes (where the PKG stores its own SHA-1), and whether that stored one
 * agrees.
 */
export async function packageSha1(path: string): Promise<{ sha1: string; trailerAgrees: boolean }> {
  const st = await fs.stat(path)
  if (st.size <= 32) throw new Error(tMain('mainEmulation.ps3.notPkg'))
  const hash = createHash('sha1')
  await pipeline(createReadStream(path, { start: 0, end: st.size - 33 }), hash)
  const sha1 = hash.digest('hex')
  const handle = await fs.open(path, 'r')
  try {
    const tail = Buffer.alloc(20)
    await handle.read(tail, 0, 20, st.size - 32)
    return { sha1, trailerAgrees: tail.toString('hex') === sha1 }
  } finally {
    await handle.close()
  }
}

/** Downloads a file (fetch: tests replace it), reporting the bytes as they come. */
export type FileFetch = typeof fetch

/**
 * Downloads `pkg` into `dir` (as <name>.part, renamed when complete and checked) and returns its path. The size and
 * the SHA-1 must match the update list's; a mismatch deletes the file and throws.
 */
export async function downloadPackage(
  pkg: Ps3UpdatePackage,
  dir: string,
  options: {
    fetch?: FileFetch
    signal?: AbortSignal
    onBytes?: (done: number, total: number) => void
  } = {}
): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  // Named by its checksum: safe on disk whatever the URL holds, and a finished one is found again.
  const dest = join(dir, `${pkg.version}-${pkg.sha1}.pkg`)
  const part = `${dest}.part`
  const done = await fs.stat(dest).catch(() => null)
  if (done?.size === pkg.size && (await packageSha1(dest)).sha1 === pkg.sha1) return dest
  const res = await (options.fetch ?? fetch)(pkg.url, { signal: options.signal })
  if (!res.ok || !res.body)
    throw new Error(tMain('mainEmulation.ps3.downloadFailed', { status: res.status }))
  let bytes = 0
  const listed = Number(res.headers.get('content-length'))
  if (Number.isFinite(listed) && listed > 0 && listed !== pkg.size)
    throw new Error(tMain('mainEmulation.ps3.wrongSize', { size: listed, expected: pkg.size }))
  // Never more than the listed size is written: a server sending more is cut off.
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length
      if (bytes > pkg.size) {
        done(new Error(tMain('mainEmulation.ps3.tooLarge', { expected: pkg.size })))
        return
      }
      options.onBytes?.(bytes, pkg.size)
      done(null, chunk)
    }
  })
  try {
    await pipeline(
      Readable.fromWeb(res.body as import('stream/web').ReadableStream),
      counter,
      createWriteStream(part),
      { signal: options.signal }
    )
    const st = await fs.stat(part)
    if (st.size !== pkg.size)
      throw new Error(tMain('mainEmulation.ps3.incomplete', { size: st.size, expected: pkg.size }))
    const { sha1 } = await packageSha1(part)
    if (sha1 !== pkg.sha1) throw new Error(tMain('mainEmulation.ps3.checksum'))
    await fs.rm(dest, { force: true })
    await fs.rename(part, dest)
    return dest
  } catch (err) {
    await fs.rm(part, { force: true }).catch(() => undefined)
    throw err
  }
}
