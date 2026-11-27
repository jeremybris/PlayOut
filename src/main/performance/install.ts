import { promises as fsp } from 'fs'
import { join, win32 } from 'path'
import { downloadFile, fetchJson, type HttpDeps } from '../emulator-setup/download'
import { encodedPowerShellArgs, runElevated as defaultRunElevated } from '../emulator-setup/run'
import type { ResolvedDownload } from '../emulator-setup/types'
import { execCommand, type CommandRunner } from '../system/power'
import type { PsRunner } from '../system/ps-worker'
import { PRESENTMON_DOWNLOAD, PRESENTMON_FILE } from './presentmon'
import {
  helperScript,
  HELPER_USER_FILE,
  installExitText,
  installScript,
  INSTALL_EXIT,
  removeScript,
  sha256
} from './helper/script'
import { tMain } from '../i18n'

/**
 * Installing and removing the elevated power helper (docs/home-overlay.md, Power profiles). One UAC prompt installs
 * PawnIO when it is missing (its official signed installer), the signed PawnIO module for this CPU, helper.ps1, the
 * user's SID (user.sid: whose pipe the helper serves), the pinned PresentMon build (Dynamic TDP's frame rates,
 * presentmon.ts), and a scheduled task that runs helper.ps1 as SYSTEM from boot
 * (restarted if it fails) and is started at once, so PlayOut only ever connects to its pipe.
 */

/** PawnIO's installer releases (pawnio.eu links here; namazso/PawnIO itself publishes no release assets). */
export const PAWNIO_SETUP_API = 'https://api.github.com/repos/namazso/PawnIO.Setup/releases/latest'
export const PAWNIO_MODULES_API =
  'https://api.github.com/repos/namazso/PawnIO.Modules/releases/latest'

const PAWNIO_UNINSTALL_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PawnIO'

export type HelperModule = 'IntelMSR.bin' | 'RyzenSMU.bin'

/**
 * The helper folder, ProgramData\PlayOut\PowerHelper, with ProgramData from the known folder
 * ([Environment]::GetFolderPath('CommonApplicationData'), through the PowerShell worker): the same resolution the
 * elevated scripts make themselves. Never %ProgramData% from PlayOut's environment, which a user-level process can
 * override. PlayOut only reads the install state from this path; it never passes it to the elevated scripts.
 */
export async function resolveHelperDir(ps: PsRunner): Promise<string> {
  const base = await ps.run<string>("[Environment]::GetFolderPath('CommonApplicationData')", {
    timeoutMs: 10_000
  })
  const dir = typeof base === 'string' ? base.trim() : ''
  if (!win32.isAbsolute(dir) || !/^[a-z]:\\/i.test(dir))
    throw new Error(tMain('mainPerformance.install.noProgramData'))
  return win32.join(dir, 'PlayOut', 'PowerHelper')
}

interface GithubAsset {
  name?: unknown
  browser_download_url?: unknown
  digest?: unknown
  size?: unknown
}

interface GithubRelease {
  tag_name?: unknown
  assets?: unknown
}

/** The asset of a GitHub "latest release" answer whose name matches, as a download (digest = SHA-256 when given). */
export function pickAsset(release: unknown, name: RegExp): ResolvedDownload | null {
  const r = (release ?? {}) as GithubRelease
  const assets = Array.isArray(r.assets) ? (r.assets as GithubAsset[]) : []
  const a = assets.find((x) => typeof x.name === 'string' && name.test(x.name))
  if (!a || typeof a.browser_download_url !== 'string' || typeof a.name !== 'string') return null
  if (!a.browser_download_url.startsWith('https://github.com/namazso/')) return null
  const digest =
    typeof a.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(a.digest)
      ? a.digest.slice(7).toLowerCase()
      : undefined
  return {
    version: typeof r.tag_name === 'string' ? r.tag_name : 'latest',
    url: a.browser_download_url,
    fileName: a.name,
    sha256: digest,
    size: typeof a.size === 'number' ? a.size : undefined
  }
}

/** `reg query` output -> InstallLocation, or null. */
export function parseInstallLocation(stdout: string): string | null {
  const m = /InstallLocation\s+REG_\w+\s+(.+)/i.exec(stdout)
  return m ? m[1].trim() || null : null
}

/** PawnIO's folder when it is installed (its uninstall key, else Program Files\PawnIO), with PawnIOLib.dll in it. */
export async function findPawnIO(
  run: CommandRunner = execCommand,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const r = await run('reg.exe', ['query', PAWNIO_UNINSTALL_KEY, '/v', 'InstallLocation'], 10_000)
  const candidates = [
    r.code === 0 ? parseInstallLocation(r.stdout) : null,
    join(env.ProgramFiles || 'C:\\Program Files', 'PawnIO')
  ]
  for (const dir of candidates) {
    if (!dir) continue
    try {
      await fsp.access(join(dir, 'PawnIOLib.dll'))
      return dir
    } catch {
      /* next */
    }
  }
  return null
}

let helperText: string | null = null
/** The helper.ps1 this PlayOut version installs (generated once). */
export function currentHelperScript(): string {
  helperText ??= helperScript()
  return helperText
}

export type HelperInstallState = 'missing' | 'outdated' | 'installed'

/**
 * Reads the installed helper.ps1 (users may read the folder) and compares it with this version's. With `userSid`,
 * a helper installed for another Windows user (user.sid) is 'outdated': its pipe is not this user's.
 */
export async function helperInstallState(
  helperDir: string,
  module: HelperModule,
  userSid?: string
): Promise<HelperInstallState> {
  let text: string
  let owner: string
  try {
    text = await fsp.readFile(join(helperDir, 'helper.ps1'), 'utf8')
    await fsp.access(join(helperDir, module))
    owner = (await fsp.readFile(join(helperDir, HELPER_USER_FILE), 'utf8')).trim()
  } catch {
    return 'missing'
  }
  if (userSid !== undefined && owner.toUpperCase() !== userSid.toUpperCase()) return 'outdated'
  // An install from before Dynamic TDP (protocol 1) has no PresentMon.exe: an update brings it, not a fresh install.
  try {
    await fsp.access(join(helperDir, PRESENTMON_FILE))
  } catch {
    return 'outdated'
  }
  return sha256(text) === sha256(currentHelperScript()) ? 'installed' : 'outdated'
}

export interface InstallDeps {
  http: HttpDeps
  /** Where downloads and the generated helper.ps1 wait for the elevated step. */
  cacheDir: string
  /** The user the helper's pipe is for (stored in the admin-only folder by the elevated step). */
  userSid: string
  run?: CommandRunner
  /** Tests: where Program Files is. */
  env?: NodeJS.ProcessEnv
  runElevated?: (file: string, args: string[]) => Promise<number | null>
  /** Tests: another PresentMon download than the pinned one. */
  presentmon?: ResolvedDownload
}

export type InstallResult = { ok: true } | { ok: false; cancelled: boolean; message: string }

async function fileSha256(path: string): Promise<string> {
  return sha256(await fsp.readFile(path))
}

/** A cached download whose hash still matches is reused (a reinstall after a PlayOut update needs no download). */
async function cachedDownload(d: ResolvedDownload, dir: string, http: HttpDeps): Promise<string> {
  const path = join(dir, d.fileName)
  if (d.sha256) {
    try {
      if ((await fileSha256(path)) === d.sha256) return path
    } catch {
      /* not cached */
    }
  }
  return downloadFile(d, dir, http)
}

export async function installHelper(
  deps: InstallDeps,
  module: HelperModule
): Promise<InstallResult> {
  const run = deps.run ?? execCommand
  const elevate =
    deps.runElevated ??
    ((file, args) => defaultRunElevated(file, args, undefined, { hidden: true }))
  try {
    await fsp.mkdir(deps.cacheDir, { recursive: true })
    const helperPath = join(deps.cacheDir, 'helper.ps1')
    const text = currentHelperScript()
    await fsp.writeFile(helperPath, text, 'utf8')

    const modules = pickAsset(
      await fetchJson(PAWNIO_MODULES_API, deps.http),
      /^release_[\w.]+\.zip$/i
    )
    if (!modules) throw new Error(tMain('mainPerformance.install.noModulesZip'))
    const modulesPath = await cachedDownload(
      modules,
      join(deps.cacheDir, 'modules', modules.version.replace(/[^\w.-]/g, '_')),
      deps.http
    )

    let setup: { path: string; sha256: string } | null = null
    if (!(await findPawnIO(run, deps.env))) {
      const d = pickAsset(await fetchJson(PAWNIO_SETUP_API, deps.http), /^PawnIO_setup\.exe$/i)
      if (!d) throw new Error(tMain('mainPerformance.install.noInstaller'))
      const path = await cachedDownload(
        d,
        join(deps.cacheDir, 'setup', d.version.replace(/[^\w.-]/g, '_')),
        deps.http
      )
      setup = { path, sha256: await fileSha256(path) }
    }

    const pm = deps.presentmon ?? PRESENTMON_DOWNLOAD
    const presentmonPath = await cachedDownload(
      pm,
      join(deps.cacheDir, 'presentmon', pm.version.replace(/[^\w.-]/g, '_')),
      deps.http
    )
    // Next to helper.ps1, where the install script takes it from (the helper checks its pinned hash before each run).
    await fsp.copyFile(presentmonPath, join(deps.cacheDir, PRESENTMON_FILE))

    const script = installScript({
      helper: { path: helperPath, sha256: sha256(Buffer.from(text, 'utf8')) },
      modules: { path: modulesPath, sha256: await fileSha256(modulesPath), module },
      setup,
      userSid: deps.userSid
    })
    const code = await elevate('powershell.exe', encodedPowerShellArgs(script))
    if (code === INSTALL_EXIT.OK) {
      deps.http.log.info(`power helper installed (${module}${setup ? ', with PawnIO' : ''})`)
      return { ok: true }
    }
    const message = installExitText(code)
    deps.http.log.warn(`power helper install: ${message}`)
    return { ok: false, cancelled: code === INSTALL_EXIT.CANCELLED, message }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    deps.http.log.warn(`power helper install failed: ${message}`)
    return { ok: false, cancelled: false, message }
  }
}

export async function removeHelper(
  deps: Pick<InstallDeps, 'runElevated'> & { log: HttpDeps['log'] }
): Promise<InstallResult> {
  const elevate =
    deps.runElevated ??
    ((file, args) => defaultRunElevated(file, args, undefined, { hidden: true }))
  const code = await elevate('powershell.exe', encodedPowerShellArgs(removeScript()))
  if (code === INSTALL_EXIT.OK) {
    deps.log.info('power helper removed')
    return { ok: true }
  }
  const message = installExitText(code)
  deps.log.warn(`power helper removal: ${message}`)
  return { ok: false, cancelled: code === INSTALL_EXIT.CANCELLED, message }
}
