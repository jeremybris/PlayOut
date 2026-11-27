// Xbox app install progress (grade: measured, approximate; docs/research/store-accounts.md §4.4): the game's
// `<drive>:\XboxGames\<Title>\Content` folder appears when the download starts and grows until the package is
// registered; the installed scan (Get-AppxPackage) confirms. The folder name is the display name with `:` turned
// into `-`, so folders are matched on their letters and digits only.
import { join } from 'path'
import { isDirectory, listDir } from '../util/fs'
import { dirSize } from './probe-fs'
import type { InstallProbe, ProbeResult } from './tracker'

export function folderKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** The XboxGames roots that exist on this machine (one per drive letter). */
export async function findXboxRoots(): Promise<string[]> {
  const roots: string[] = []
  for (let i = 0; i < 26; i++) {
    const root = `${String.fromCharCode(65 + i)}:\\XboxGames`
    if (await isDirectory(root)) roots.push(root)
  }
  return roots
}

export function progressFromFolder(bytes: number, bytesTotal: number | undefined): ProbeResult {
  const result: ProbeResult = {
    state: 'downloading',
    bytesDone: bytes,
    fingerprint: `bytes:${bytes}`
  }
  if (bytesTotal && bytesTotal > 0) {
    result.bytesTotal = bytesTotal
    result.percent = Math.min(99, (bytes / bytesTotal) * 100)
  }
  return result
}

export interface XboxProbeDeps {
  title: string
  /** Catalog `MaxDownloadSizeInBytes` when known. */
  bytesTotal?: number
  roots?: () => Promise<string[]>
}

export function createXboxProbe(deps: XboxProbeDeps): InstallProbe {
  const roots = deps.roots ?? findXboxRoots
  const wanted = folderKey(deps.title)
  let known: string | null = null
  let seen = false

  async function findFolder(): Promise<string | null> {
    if (known && (await isDirectory(known))) return known
    known = null
    if (!wanted) return null
    for (const root of await roots()) {
      for (const entry of await listDir(root)) {
        if (!entry.isDirectory() || folderKey(entry.name) !== wanted) continue
        const content = join(root, entry.name, 'Content')
        if (await isDirectory(content)) {
          known = content
          return content
        }
      }
    }
    return null
  }

  return async () => {
    const folder = await findFolder()
    if (!folder) return seen ? { cancelled: true, fingerprint: 'gone' } : null
    seen = true
    return progressFromFolder(await dirSize(folder), deps.bytesTotal)
  }
}
