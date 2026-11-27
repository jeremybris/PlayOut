import { promises as fs } from 'fs'
import { join } from 'path'
import { psQuote } from '../system/powershell'
import { downloadFile, type HttpDeps } from './download'
import type { ResolvedDownload, RuntimeId } from './types'
import { tMain } from '../i18n'

/** What the runtime checks and installs need (injectable for tests). */
export interface RuntimeDeps extends HttpDeps {
  /** Where installers are downloaded (and DirectX extracted); they are deleted afterwards. */
  workDir: string
  /**
   * One registry value as a string ('1', '0x1', '14'), or null when the key or value is missing. In the app:
   * `(hive, key, name) => registryValue(hive, key, name)` from src/main/system/registry.ts.
   */
  readRegistry(hive: 'HKLM' | 'HKCU', key: string, valueName: string): Promise<string | null>
  exists(path: string): Promise<boolean>
  /** Run a program elevated and return its exit code (1223 = UAC declined); see run.ts runElevated. */
  runElevated(file: string, args: string[]): Promise<number | null>
  onBytes?(done: number, total: number): void
  /** %WINDIR% (tests); defaults to %SystemRoot% or C:\Windows. */
  windowsDir?: string
}

const VC_KEYS = [
  'SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
  'SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'
]

export const VCREDIST_DOWNLOAD: ResolvedDownload = {
  version: '14',
  url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
  fileName: 'vc_redist.x64.exe'
}

export const DIRECTX_DOWNLOAD: ResolvedDownload = {
  version: 'Jun2010',
  url: 'https://download.microsoft.com/download/8/4/A/84A35BF1-DAFE-4AE8-82AF-AD2AE20B6B14/directx_Jun2010_redist.exe',
  fileName: 'directx_Jun2010_redist.exe',
  size: 100275120
}

/** vc_redist exit codes that mean installed: success, a newer version already present, reboot required. */
const VC_OK = new Set([0, 1638, 3010])
const DECLINED = 1223

/** Parse a registry number given as decimal ('14') or hex ('0x1'); null when it is neither. */
export function parseRegistryNumber(value: string | null): number | null {
  if (value === null) return null
  const text = value.trim()
  if (/^0x[0-9a-f]+$/i.test(text)) return parseInt(text.slice(2), 16)
  if (/^\d+$/.test(text)) return parseInt(text, 10)
  return null
}

async function vcredistInstalled(deps: RuntimeDeps): Promise<boolean> {
  for (const key of VC_KEYS) {
    const [installed, major, minor] = await Promise.all(
      ['Installed', 'Major', 'Minor'].map((name) =>
        deps.readRegistry('HKLM', key, name).then(parseRegistryNumber, () => null)
      )
    )
    if (installed === 1 && major !== null && minor !== null && major >= 14 && minor >= 40)
      return true
  }
  return false
}

async function directx9Installed(deps: RuntimeDeps): Promise<boolean> {
  const windows = deps.windowsDir ?? process.env.SystemRoot ?? 'C:\\Windows'
  const dir = join(windows, 'SysWOW64')
  for (const dll of ['d3dx9_42.dll', 'xinput1_3.dll'])
    if (!(await deps.exists(join(dir, dll)).catch(() => false))) return false
  return true
}

async function installed(id: RuntimeId, deps: RuntimeDeps): Promise<boolean> {
  return id === 'vcredist' ? vcredistInstalled(deps) : directx9Installed(deps)
}

/** The runtimes of `needs` that this PC lacks (deduplicated, in the order given). */
export async function runtimesMissing(needs: RuntimeId[], deps: RuntimeDeps): Promise<RuntimeId[]> {
  const missing: RuntimeId[] = []
  for (const id of [...new Set(needs)]) if (!(await installed(id, deps))) missing.push(id)
  return missing
}

/**
 * Install the runtimes of `needs` this PC lacks: the Visual C++ 2015-2022 x64 runtime and the DirectX 9 June 2010
 * runtime, each with one UAC prompt. Never throws; returns short user-facing notices (declined prompt, failed or
 * still-missing install).
 */
export async function ensureRuntimes(needs: RuntimeId[], deps: RuntimeDeps): Promise<string[]> {
  const notices: string[] = []
  for (const id of await runtimesMissing(needs, deps)) {
    try {
      const notice = id === 'vcredist' ? await installVcredist(deps) : await installDirectx(deps)
      if (notice) {
        notices.push(notice)
        continue
      }
      if (!(await installed(id, deps)))
        notices.push(
          id === 'vcredist'
            ? tMain('mainEmulatorSetup.runtimes.vcStillMissing')
            : tMain('mainEmulatorSetup.runtimes.dxStillMissing')
        )
    } catch (err) {
      deps.log.warn(`runtime ${id} failed: ${(err as Error).message}`)
      const error = (err as Error).message
      notices.push(
        id === 'vcredist'
          ? tMain('mainEmulatorSetup.runtimes.vcInstallError', { error })
          : tMain('mainEmulatorSetup.runtimes.dxInstallError', { error })
      )
    }
  }
  return notices
}

async function installVcredist(deps: RuntimeDeps): Promise<string | null> {
  await fs.mkdir(deps.workDir, { recursive: true })
  const file = await downloadFile(VCREDIST_DOWNLOAD, deps.workDir, deps, deps.onBytes)
  try {
    const code = await deps.runElevated(file, ['/install', '/passive', '/norestart'])
    deps.log.info(`vc_redist exited with ${code}`)
    if (code !== null && VC_OK.has(code)) return null
    if (code === DECLINED) return tMain('mainEmulatorSetup.runtimes.vcDeclined')
    return tMain('mainEmulatorSetup.runtimes.vcFailed', { code: code ?? 'none' })
  } finally {
    await fs.rm(file, { force: true }).catch(() => undefined)
  }
}

/** The PowerShell script that extracts the DirectX redist and runs DXSETUP silently (one elevation for both). */
export function directxScript(redist: string, extractDir: string): string {
  const target = /\s/.test(extractDir) ? `/T:"${extractDir}"` : `/T:${extractDir}`
  return [
    "$ErrorActionPreference = 'Stop'",
    `$x = Start-Process -FilePath ${psQuote(redist)} -ArgumentList ${psQuote(`/Q ${target}`)} -Wait -PassThru`,
    'if ($x.ExitCode -ne 0) { exit $x.ExitCode }',
    `$s = Start-Process -FilePath ${psQuote(join(extractDir, 'DXSETUP.exe'))} -ArgumentList '/silent' -Wait -PassThru`,
    'exit $s.ExitCode',
    ''
  ].join('\r\n')
}

async function installDirectx(deps: RuntimeDeps): Promise<string | null> {
  await fs.mkdir(deps.workDir, { recursive: true })
  const extractDir = join(deps.workDir, 'directx')
  const script = join(deps.workDir, 'install-directx.ps1')
  const file = await downloadFile(DIRECTX_DOWNLOAD, deps.workDir, deps, deps.onBytes)
  try {
    const size = (await fs.stat(file)).size
    if (size !== DIRECTX_DOWNLOAD.size)
      return tMain('mainEmulatorSetup.runtimes.dxIncomplete', {
        size: String(size),
        expected: String(DIRECTX_DOWNLOAD.size)
      })
    await fs.rm(extractDir, { recursive: true, force: true })
    await fs.mkdir(extractDir, { recursive: true })
    // UTF-8 with a BOM: Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page.
    await fs.writeFile(script, '\ufeff' + directxScript(file, extractDir), 'utf8')
    const code = await deps.runElevated('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script
    ])
    deps.log.info(`DirectX setup exited with ${code}`)
    if (code === 0) return null
    if (code === DECLINED) return tMain('mainEmulatorSetup.runtimes.dxDeclined')
    return tMain('mainEmulatorSetup.runtimes.dxFailed', { code: code ?? 'none' })
  } finally {
    await fs.rm(file, { force: true }).catch(() => undefined)
    await fs.rm(script, { force: true }).catch(() => undefined)
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
