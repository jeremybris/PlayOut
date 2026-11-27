// Ubisoft Connect install progress (grade: state-only, docs/research/store-accounts.md §7.3): the
// `HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id>` key names the install folder as soon as the download
// starts; `uplay_install.state` with a first byte of 0x0A marks the install complete. Folder growth feeds the
// indeterminate bar in between.
import { promises as fs } from 'fs'
import { join } from 'path'
import { readRegistryKey, type RegistryKey } from '../system/registry'
import { isDirectory } from '../util/fs'
import { dirSize } from './probe-fs'
import type { InstallProbe, ProbeResult } from './tracker'

const INSTALLS_KEY = 'SOFTWARE\\Ubisoft\\Launcher\\Installs'
const STATE_INSTALLED = 0x0a

export function installDirFromKey(key: RegistryKey | null): string | null {
  const value = key?.values.InstallDir
  if (typeof value !== 'string' || !value.trim()) return null
  return value
    .trim()
    .replace(/\//g, '\\')
    .replace(/[\\]+$/, '')
}

export function progressFromState(bytes: number, stateFirstByte: number | null): ProbeResult {
  if (stateFirstByte === STATE_INSTALLED)
    return { state: 'installing', percent: 100, complete: true, fingerprint: `installed:${bytes}` }
  return {
    state: 'downloading',
    bytesDone: bytes,
    fingerprint: `bytes:${bytes}:${stateFirstByte ?? '-'}`
  }
}

export async function readStateFirstByte(file: string): Promise<number | null> {
  let handle: fs.FileHandle
  try {
    handle = await fs.open(file, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(1)
    const { bytesRead } = await handle.read(buffer, 0, 1, 0)
    return bytesRead === 1 ? buffer[0] : null
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export interface UbisoftProbeDeps {
  id: string
  readKey?: typeof readRegistryKey
}

export function createUbisoftProbe(deps: UbisoftProbeDeps): InstallProbe {
  const readKey = deps.readKey ?? readRegistryKey
  // The InstallDir never moves once the key exists: it is read (one or two PowerShell runs) until it appears and
  // cached from then on, so a 10 s probe costs a folder walk, not a registry read.
  let cachedDir: string | null = null
  let seen = false
  return async () => {
    if (cachedDir === null) {
      const key =
        (await readKey('HKLM', `${INSTALLS_KEY}\\${deps.id}`, { view: 'x86', depth: 0 })) ??
        (await readKey('HKLM', `${INSTALLS_KEY}\\${deps.id}`, { view: 'default', depth: 0 }))
      cachedDir = installDirFromKey(key)
    }
    const dir = cachedDir
    if (!dir || !(await isDirectory(dir))) {
      // The folder vanished after it existed: cancelled; the key itself is re-read next time.
      if (seen) cachedDir = null
      return seen ? { cancelled: true, fingerprint: 'gone' } : null
    }
    seen = true
    const bytes = await dirSize(dir)
    return progressFromState(bytes, await readStateFirstByte(join(dir, 'uplay_install.state')))
  }
}
