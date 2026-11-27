// Downloading, updating and removing a VR mod, on the recompilations' pipeline (recomp/install.ts): the release's
// file is downloaded from GitHub (checked against GitHub's published digest when there is one), a .zip or .7z is
// unpacked into a staging folder and moved into <VR Mods>/<title (id)>, and any other file (a program, a .dll, a
// .uevrz profile, a setup program) is put in that folder as it is. NOTHING downloaded is ever run: there is no
// self-extractor handling, no setup program, no launch. An update lays the new release over the old one (the
// release's files replaced, files the player changed kept, files the old release shipped but the new one does not
// removed); the player's own files are zipped into <VR Mods>/.playout/backups/<id>/ before an update or a removal.
import { promises as fs } from 'fs'
import { dirname, join, resolve } from 'path'
import type { InstalledVrMod, VrModEntry, VrModProgress } from '../../shared/vr-mods'
import { vrModRepo } from '../../shared/vr-mods'
import { detectArchive, extractArchive } from '../emulator-setup/archive'
import { downloadFile, safeFileName, type HttpDeps } from '../emulator-setup/download'
import type { Logger, Runner } from '../emulator-setup/types'
import {
  backupPlayerFiles,
  backupPlayerFilesListed,
  checkAssetHost,
  defaultFreeSpace,
  dirSize,
  dropLinks,
  formatBytes,
  listFiles,
  overlay,
  removeDropped,
  safeRecompFolder,
  safeRecompId,
  sha256Of,
  unverifiedWarning
} from '../recomp/install'
import { sha256FromDigest, type GhRelease } from '../recomp/releases'
import { recompBackupsDir, recompPlayoutDir } from '../recomp/state'
import { renameRetry, RM_RETRY } from '../util/fs'
import { isInside, normalizePath } from '../util/paths'
import { pickVrAsset } from './assets'
import { tMain } from '../i18n'

export interface VrInstallDeps {
  /** The VR Mods folder (mods live in <root>/<title (id)>). */
  root: string
  /** Downloads go to <cacheDir>/downloads/<id>/ and are removed once in place. */
  cacheDir: string
  http: HttpDeps
  /** PlayOut's own 7zr.exe (downloaded on first use), only to unpack a .7z: the mod itself is never run. */
  sevenZip: () => Promise<string>
  run: Runner
  log: Logger
  onProgress: (p: VrModProgress) => void
  now?: () => Date
  /** Free bytes on the volume holding `dir` (tests); default fs.statfs. Null = unknown (not checked). */
  freeSpace?: (dir: string) => Promise<number | null>
}

export { unverifiedWarning }

const PROGRESS_INTERVAL_MS = 250

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A mod's folder name: "Edge of Eternity VR (edge-of-eternity-vr)". */
export function safeVrFolder(mod: Pick<VrModEntry, 'id' | 'title'>): string {
  return safeRecompFolder({ id: mod.id, name: mod.title })
}

/** Where the player-file backups of one mod go. */
export function vrBackupsDir(root: string, id: string): string {
  return recompBackupsDir(root, safeRecompId(id))
}

/** PlayOut's own files beside the mods (<root>/.playout: the download cache, 7-Zip, backups). */
export const vrPlayoutDir = recompPlayoutDir

/**
 * Put the download into `staging`: a .zip or .7z (by its name and its content) is unpacked (zip-slip guarded, a single
 * top folder removed); anything else is copied in as it is.
 */
async function unpack(
  file: string,
  staging: string,
  assetName: string,
  deps: VrInstallDeps
): Promise<void> {
  await fs.rm(staging, RM_RETRY)
  const lower = assetName.toLowerCase()
  const kind = await detectArchive(file)
  if ((lower.endsWith('.zip') && kind === 'zip') || (lower.endsWith('.7z') && kind === '7z')) {
    await extractArchive(file, staging, { sevenZip: deps.sevenZip, run: deps.run, log: deps.log })
    return
  }
  await fs.mkdir(staging, { recursive: true })
  await fs.copyFile(file, join(staging, safeFileName(assetName)))
}

/**
 * Download `release` of `mod` into its folder (an update when `previous` is given; its folder is reused). Reports
 * progress through `deps.onProgress` (ending with 'done', or 'failed' before the error is rethrown).
 */
export async function installVrMod(
  mod: VrModEntry,
  release: GhRelease,
  previous: InstalledVrMod | null,
  deps: VrInstallDeps
): Promise<InstalledVrMod> {
  const now = (): Date => deps.now?.() ?? new Date()
  let warning: string | null = null
  const emit = (phase: VrModProgress['phase'], extra: Partial<VrModProgress> = {}): void =>
    deps.onProgress({
      id: mod.id,
      phase,
      progress: null,
      bytes: null,
      total: null,
      message: null,
      warning,
      ...extra
    })
  const repo = vrModRepo(mod) ?? previous?.repo
  const dir = resolve(previous?.dir ?? join(deps.root, safeVrFolder(mod)))
  const staging = `${dir}.staging`
  const downloadDir = join(deps.cacheDir, 'downloads', safeRecompId(mod.id))
  try {
    if (!repo) throw new Error(tMain('mainVrMods.notOnGithubShort', { title: mod.title }))
    if (!isInside(deps.root, dir)) throw new Error(`${dir} is not inside the VR Mods folder`)
    emit('checking', {
      message: tMain('mainVrMods.gettingReady', { name: mod.title, version: release.tag_name })
    })
    const picked = pickVrAsset(release.assets, {
      pattern: null,
      previousName: previous?.asset ?? null,
      previousTag: previous?.tag ?? null,
      tag: release.tag_name
    })
    if (!picked)
      throw new Error(tMain('mainVrMods.noFile', { title: mod.title, tag: release.tag_name }))
    const { asset } = picked
    checkAssetHost({ host: 'github' }, asset.browser_download_url)

    await fs.mkdir(deps.root, { recursive: true })
    if (asset.size > 0) {
      const free = await (deps.freeSpace ?? defaultFreeSpace)(deps.root)
      if (free !== null && free < asset.size * 3)
        throw new Error(
          tMain('mainVrMods.noSpace', {
            title: mod.title,
            needed: formatBytes(asset.size * 3),
            free: formatBytes(free)
          })
        )
    }

    const expected = sha256FromDigest(asset.digest)
    if (!expected) warning = unverifiedWarning()

    let last = 0
    emit('downloading', { progress: 0, bytes: 0, total: asset.size || null })
    const file = await downloadFile(
      {
        version: release.tag_name,
        url: asset.browser_download_url,
        fileName: asset.name,
        sha256: expected ?? undefined,
        size: asset.size > 0 ? asset.size : undefined
      },
      downloadDir,
      deps.http,
      (done, total) => {
        const t = Date.now()
        if (t - last < PROGRESS_INTERVAL_MS && done < total) return
        last = t
        emit('downloading', {
          progress: total ? Math.min(1, done / total) : null,
          bytes: done,
          total: total || null
        })
      }
    )
    const downloadBytes = (await fs.stat(file)).size
    // downloadFile has checked `expected` (GitHub's digest) when there is one.
    emit('verifying')
    const sha256 = expected ?? (await sha256Of(file))
    if (!expected)
      deps.log.warn(`${mod.id} ${release.tag_name}: ${asset.name} has no published checksum`)

    const sinceMs = previous ? Date.parse(previous.updatedAt) : NaN
    emit('extracting', { message: tMain('mainVrMods.unpacking', { file: asset.name }) })
    await unpack(file, staging, asset.name, deps)
    await dropLinks(staging, deps.log)
    const staged = await listFiles(staging)
    if (!staged.length) throw new Error(tMain('mainVrMods.empty', { file: asset.name }))
    const releaseFiles = [...new Set(staged.map((f) => f.key))].sort()
    emit('installing', {
      message: previous
        ? tMain('mainVrMods.updatingTo', { tag: release.tag_name })
        : tMain('mainVrMods.saving')
    })
    const existing = await fs.readdir(dir).catch(() => [] as string[])
    if (!existing.length) {
      await fs.rm(dir, RM_RETRY)
      await fs.mkdir(dirname(dir), { recursive: true })
      await renameRetry(staging, dir)
    } else {
      let backedUp: Set<string>
      try {
        const done = await backupPlayerFilesListed(
          dir,
          previous?.releaseFiles ?? [],
          vrBackupsDir(deps.root, mod.id),
          now(),
          sinceMs
        )
        backedUp = done.keys
        if (done.zip) deps.log.info(`${mod.id}: player files backed up to ${done.zip}`)
      } catch (err) {
        throw new Error(
          tMain('mainVrMods.backupFailed', { title: mod.title, error: message(err) }),
          { cause: err }
        )
      }
      const shipped = new Set(previous?.releaseFiles ?? [])
      const setAside = (key: string, st: { mtimeMs: number }): boolean =>
        !backedUp.has(key) &&
        (!shipped.has(key) || (Number.isFinite(sinceMs) && st.mtimeMs > sinceMs))
      await overlay(staging, dir, staged, deps.log, setAside)
      if (previous)
        await removeDropped(
          dir,
          previous.releaseFiles,
          new Set(releaseFiles),
          new Set(),
          sinceMs,
          deps.log
        )
      await fs.rm(staging, RM_RETRY)
    }
    await fs.rm(downloadDir, RM_RETRY).catch(() => undefined)

    const at = now().toISOString()
    const record: InstalledVrMod = {
      id: mod.id,
      title: mod.title,
      repo,
      dir,
      tag: release.tag_name,
      publishedAt: release.published_at,
      asset: asset.name,
      downloadBytes,
      diskBytes: await dirSize(dir),
      sha256,
      verified: expected ? 'github' : 'unverified',
      releaseFiles,
      installedAt: previous?.installedAt ?? at,
      updatedAt: at
    }
    deps.log.info(
      `${mod.id}: ${previous ? 'updated to' : 'downloaded'} ${release.tag_name} (${asset.name}, ${record.verified})`
    )
    emit('done', {
      progress: 1,
      message: tMain('mainVrMods.downloaded', { title: mod.title, tag: release.tag_name })
    })
    return record
  } catch (err) {
    await fs.rm(staging, RM_RETRY).catch(() => undefined)
    await fs.rm(downloadDir, RM_RETRY).catch(() => undefined)
    deps.log.warn(`${mod.id}: download of ${release.tag_name} failed: ${message(err)}`)
    emit('failed', { message: message(err) })
    throw err
  }
}

/**
 * Remove a downloaded mod: its player files are backed up first, then the folder and any leftover download go. Only
 * a folder inside the VR Mods folder is ever deleted.
 */
export async function removeVrModFiles(
  installed: InstalledVrMod,
  deps: Pick<VrInstallDeps, 'root' | 'cacheDir' | 'log' | 'now'>
): Promise<void> {
  const dir = resolve(installed.dir)
  if (!isInside(deps.root, dir) || normalizePath(dir) === normalizePath(resolve(deps.root)))
    throw new Error(tMain('mainVrMods.outsideFolder', { folder: dir }))
  try {
    const zip = await backupPlayerFiles(
      dir,
      installed.releaseFiles,
      vrBackupsDir(deps.root, installed.id),
      deps.now?.() ?? new Date(),
      Date.parse(installed.updatedAt)
    )
    if (zip) deps.log.info(`${installed.id}: player files backed up to ${zip} before removing`)
  } catch (err) {
    deps.log.warn(`${installed.id}: player files could not be backed up (${message(err)})`)
  }
  await fs.rm(dir, RM_RETRY)
  await fs.rm(`${dir}.staging`, RM_RETRY).catch(() => undefined)
  await fs
    .rm(join(deps.cacheDir, 'downloads', safeRecompId(installed.id)), RM_RETRY)
    .catch(() => undefined)
  deps.log.info(`${installed.id}: removed from ${dir}`)
}
