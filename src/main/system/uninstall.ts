// Add/Remove Programs entries: the shared building block of the store providers (Battle.net, EA, Epic, Ubisoft)
// per docs/research/playnite-stores.md. One cached read serves every provider during a scan.
import { createLogger } from '../logger'
import { readRegistryKey, type RegistryKey, type RegistryView } from './registry'

const log = createLogger('system:uninstall')

export interface UninstallEntry {
  /** Registry subkey name, e.g. 'Battle.net' or '{C05D8CDB-...}'. */
  keyName: string
  hive: 'HKLM' | 'HKCU'
  view: RegistryView
  displayName: string
  installLocation: string
  uninstallString: string
  publisher: string
  displayIcon: string
  displayVersion: string
}

const UNINSTALL_PATH = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
const UNINSTALL_CACHE_MS = 15_000

let uninstallCache: {
  at: number
  read: Promise<{ entries: UninstallEntry[]; failed: string[] }>
} | null = null

function valueString(key: RegistryKey, name: string): string {
  const v = key.values[name]
  if (v === undefined || v === null) return ''
  return Array.isArray(v) ? v.join(' ') : String(v)
}

export function uninstallEntriesFromKey(
  key: RegistryKey,
  hive: 'HKLM' | 'HKCU',
  view: RegistryView
): UninstallEntry[] {
  return key.subkeys.map((sub) => ({
    keyName: sub.leaf,
    hive,
    view,
    displayName: valueString(sub, 'DisplayName'),
    installLocation: valueString(sub, 'InstallLocation'),
    uninstallString: valueString(sub, 'UninstallString'),
    publisher: valueString(sub, 'Publisher'),
    displayIcon: valueString(sub, 'DisplayIcon'),
    displayVersion: valueString(sub, 'DisplayVersion')
  }))
}

/**
 * All Add/Remove Programs entries: HKLM in the 64-bit and 32-bit (WOW6432Node) views plus HKCU. Three PowerShell
 * calls, cached for a few seconds because several providers ask for the same list during one scan. A hive that
 * cannot be read adds nothing; with `complete` the read rejects instead, for callers that act on an entry being
 * absent (a partial list would make a still-installed program look gone).
 */
export async function readUninstallEntries(
  options: { maxAgeMs?: number; complete?: boolean } = {}
): Promise<UninstallEntry[]> {
  const maxAge = options.maxAgeMs ?? UNINSTALL_CACHE_MS
  if (!uninstallCache || Date.now() - uninstallCache.at >= maxAge) {
    const sources: { hive: 'HKLM' | 'HKCU'; view: RegistryView }[] = [
      { hive: 'HKLM', view: 'x64' },
      { hive: 'HKLM', view: 'x86' },
      { hive: 'HKCU', view: 'default' }
    ]
    const failed: string[] = []
    const read = Promise.all(
      sources.map(async ({ hive, view }) => {
        try {
          const key = await readRegistryKey(hive, UNINSTALL_PATH, {
            view,
            depth: 1,
            timeoutMs: 30_000
          })
          if (key) return uninstallEntriesFromKey(key, hive, view)
          // HKLM's Uninstall key exists on every Windows: no answer there (PowerShell's empty or unparsable output
          // also reads as null) is a failed read, not an empty hive. HKCU's may really be missing.
          if (hive === 'HKLM') failed.push(`${hive}/${view}`)
          return []
        } catch (err) {
          log.warn(`uninstall entries ${hive}/${view} failed: ${(err as Error).message}`)
          failed.push(`${hive}/${view}`)
          return []
        }
      })
    ).then((lists) => ({ entries: lists.flat(), failed }))
    uninstallCache = { at: Date.now(), read }
  }
  const { entries, failed } = await uninstallCache.read
  if (options.complete && failed.length)
    throw new Error(`uninstall entries ${failed.join(', ')} could not be read`)
  return entries
}

/** Test hook: forget the cached read. */
export function resetUninstallEntriesCache(): void {
  uninstallCache = null
}
