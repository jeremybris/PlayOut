// Epic install progress (grade: state-only with a measured fallback, docs/research/store-accounts.md §2.4): the
// `.item` manifest for the AppName appears when the install starts with `bIsIncompleteInstall: true`; the percent is
// the install folder's size (without .egstore) against `InstallSize`. The manifest flipping to complete with the
// launch executable in place means done; a manifest that disappears again means cancelled.
import { join } from 'path'
import { isFile, listDir, readJson } from '../util/fs'
import { dirSize } from './probe-fs'
import type { InstallProbe, ProbeResult } from './tracker'

export interface EpicItemManifest {
  AppName?: string
  InstallLocation?: string
  InstallSize?: number
  LaunchExecutable?: string
  bIsIncompleteInstall?: boolean
}

/** Map a manifest and the bytes present on disk to a probe result. */
export function progressFromItem(
  item: EpicItemManifest,
  bytesOnDisk: number,
  launchExeExists: boolean
): ProbeResult {
  const total =
    typeof item.InstallSize === 'number' && item.InstallSize > 0 ? item.InstallSize : undefined
  const fingerprint = `${item.bIsIncompleteInstall ? 1 : 0}:${bytesOnDisk}:${launchExeExists ? 1 : 0}`
  if (item.bIsIncompleteInstall === false) {
    return launchExeExists
      ? { state: 'installing', percent: 100, complete: true, fingerprint }
      : { state: 'installing', fingerprint }
  }
  if (total) {
    return {
      state: 'downloading',
      percent: Math.max(0, Math.min(99, (bytesOnDisk / total) * 100)),
      bytesDone: bytesOnDisk,
      bytesTotal: total,
      fingerprint
    }
  }
  return { state: 'downloading', bytesDone: bytesOnDisk, fingerprint }
}

export interface EpicProbeDeps {
  appName: string
  manifestsDir: string
}

export function createEpicProbe(deps: EpicProbeDeps): InstallProbe {
  let knownFile: string | null = null
  let seen = false
  const wanted = deps.appName.toLowerCase()

  async function findItem(): Promise<EpicItemManifest | null> {
    if (knownFile) {
      const item = await readJson<EpicItemManifest>(knownFile)
      if (item && (item.AppName ?? '').toLowerCase() === wanted) return item
      knownFile = null
    }
    for (const entry of await listDir(deps.manifestsDir)) {
      if (!entry.isFile() || !/\.item$/i.test(entry.name)) continue
      const file = join(deps.manifestsDir, entry.name)
      const item = await readJson<EpicItemManifest>(file)
      if (item && (item.AppName ?? '').toLowerCase() === wanted) {
        knownFile = file
        return item
      }
    }
    return null
  }

  return async () => {
    const item = await findItem()
    if (!item) return seen ? { cancelled: true, fingerprint: 'gone' } : null
    seen = true
    const location = item.InstallLocation?.trim()
    const bytes = location ? await dirSize(location, { exclude: ['.egstore'] }) : 0
    const exe = location && item.LaunchExecutable ? join(location, item.LaunchExecutable) : null
    return progressFromItem(item, bytes, exe ? await isFile(exe) : false)
  }
}
