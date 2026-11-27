import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommandRunner } from '../system/power'
import {
  currentHelperScript,
  findPawnIO,
  helperInstallState,
  installHelper,
  parseInstallLocation,
  pickAsset,
  removeHelper,
  resolveHelperDir,
  type InstallDeps,
  PAWNIO_MODULES_API,
  PAWNIO_SETUP_API
} from './install'

const quiet = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined
}
const SID = 'S-1-5-21-3656239912-250964603-1012508381-1001'
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

const ZIP = Buffer.from('PK fake modules zip')
const SETUP = Buffer.from('MZ fake setup')
const PM = Buffer.from('MZ fake presentmon')
const PM_DOWNLOAD = {
  version: 'v2.6.0',
  url: 'https://github.com/GameTechDev/PresentMon/releases/download/v2.6.0/PresentMon-test-x64.exe',
  fileName: 'PresentMon-test-x64.exe',
  sha256: sha(PM)
}

const MODULES_RELEASE = {
  tag_name: '0.2.11',
  assets: [
    {
      name: 'release_0_2_11.zip',
      browser_download_url:
        'https://github.com/namazso/PawnIO.Modules/releases/download/0.2.11/release_0_2_11.zip',
      digest: `sha256:${sha(ZIP)}`,
      size: ZIP.length
    }
  ]
}
const SETUP_RELEASE = {
  tag_name: '2.2.0',
  assets: [
    {
      name: 'PawnIO_setup.exe',
      browser_download_url:
        'https://github.com/namazso/PawnIO.Setup/releases/download/2.2.0/PawnIO_setup.exe',
      digest: `sha256:${sha(SETUP)}`
    }
  ]
}

/** The script inside runElevated's `powershell.exe -EncodedCommand`. */
function decode(args: string[]): string {
  return Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
}

describe('pickAsset', () => {
  it('takes the matching asset with its SHA-256 digest', () => {
    expect(pickAsset(MODULES_RELEASE, /^release_[\w.]+\.zip$/i)).toEqual({
      version: '0.2.11',
      url: MODULES_RELEASE.assets[0].browser_download_url,
      fileName: 'release_0_2_11.zip',
      sha256: sha(ZIP),
      size: ZIP.length
    })
  })

  it('refuses downloads from anywhere but namazso on GitHub', () => {
    const evil = {
      tag_name: '1',
      assets: [
        { name: 'PawnIO_setup.exe', browser_download_url: 'https://example.com/PawnIO_setup.exe' }
      ]
    }
    expect(pickAsset(evil, /^PawnIO_setup\.exe$/)).toBeNull()
    expect(pickAsset({ message: 'Not Found' }, /x/)).toBeNull()
  })
})

describe('PawnIO detection', () => {
  let dir = ''
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'playout-pawnio-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads InstallLocation from reg query', () => {
    const out =
      '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PawnIO\r\n    InstallLocation    REG_SZ    C:\\Program Files\\PawnIO\r\n\r\n'
    expect(parseInstallLocation(out)).toBe('C:\\Program Files\\PawnIO')
    expect(parseInstallLocation('ERROR: not found')).toBeNull()
  })

  it('needs PawnIOLib.dll in the folder found', async () => {
    const pawn = join(dir, 'PawnIO')
    const run: CommandRunner = async () => ({
      code: 0,
      stdout: `    InstallLocation    REG_SZ    ${pawn}\r\n`,
      stderr: ''
    })
    expect(await findPawnIO(run, { ProgramFiles: dir })).toBeNull()
    mkdirSync(pawn)
    writeFileSync(join(pawn, 'PawnIOLib.dll'), 'x')
    expect(await findPawnIO(run, { ProgramFiles: dir })).toBe(pawn)
    const missingKey: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'ERROR' })
    expect(await findPawnIO(missingKey, { ProgramFiles: dir })).toBe(pawn)
  })
})

describe('helperInstallState', () => {
  let dir = ''
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'playout-helperdir-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is installed only with this version of helper.ps1, the module and user.sid', async () => {
    expect(await helperInstallState(dir, 'IntelMSR.bin')).toBe('missing')
    writeFileSync(join(dir, 'helper.ps1'), currentHelperScript(), 'utf8')
    expect(await helperInstallState(dir, 'IntelMSR.bin')).toBe('missing')
    writeFileSync(join(dir, 'IntelMSR.bin'), 'module')
    // An install from before the SYSTEM task has no user.sid.
    expect(await helperInstallState(dir, 'IntelMSR.bin')).toBe('missing')
    writeFileSync(join(dir, 'user.sid'), SID)
    // An install from before Dynamic TDP has no PresentMon.exe: outdated (Update), not missing (Install).
    expect(await helperInstallState(dir, 'IntelMSR.bin')).toBe('outdated')
    expect(await helperInstallState(dir, 'IntelMSR.bin', SID)).toBe('outdated')
    writeFileSync(join(dir, 'PresentMon.exe'), 'pm')
    expect(await helperInstallState(dir, 'IntelMSR.bin')).toBe('installed')
    expect(await helperInstallState(dir, 'IntelMSR.bin', SID)).toBe('installed')
    // Installed for another Windows user: its pipe is not this user's.
    expect(await helperInstallState(dir, 'IntelMSR.bin', 'S-1-5-21-9-9-9-1002')).toBe('outdated')
    writeFileSync(join(dir, 'helper.ps1'), '# an older helper', 'utf8')
    expect(await helperInstallState(dir, 'IntelMSR.bin')).toBe('outdated')
  })

  it('reports a protocol-1 install (an older helper.ps1, no PresentMon.exe) as outdated, not missing', async () => {
    writeFileSync(join(dir, 'helper.ps1'), '# the protocol 1 helper, before Dynamic TDP', 'utf8')
    writeFileSync(join(dir, 'IntelMSR.bin'), 'module')
    writeFileSync(join(dir, 'user.sid'), SID)
    expect(await helperInstallState(dir, 'IntelMSR.bin', SID)).toBe('outdated')
  })
})

describe('installHelper', () => {
  let dir = ''
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'playout-install-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function fakeFetch(log: string[]): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input)
      log.push(url)
      if (url === PAWNIO_MODULES_API) return new Response(JSON.stringify(MODULES_RELEASE))
      if (url === PAWNIO_SETUP_API) return new Response(JSON.stringify(SETUP_RELEASE))
      if (url === PM_DOWNLOAD.url) return new Response(PM)
      if (url.endsWith('.zip')) return new Response(ZIP)
      if (url.endsWith('.exe')) return new Response(SETUP)
      return new Response('not found', { status: 404 })
    }) as typeof fetch
  }

  const noPawnIO: CommandRunner = async () => ({ code: 1, stdout: '', stderr: '' })

  it('downloads, then runs one elevated script that installs PawnIO, copies and checks the files, and registers the task', async () => {
    const fetched: string[] = []
    const elevated: string[][] = []
    const result = await installHelper(
      {
        http: { log: quiet, fetch: fakeFetch(fetched), retryDelayMs: 0 },
        cacheDir: join(dir, 'cache'),
        userSid: SID,
        run: noPawnIO,
        env: { ProgramFiles: join(dir, 'pf') },
        presentmon: PM_DOWNLOAD,
        runElevated: async (file, args) => {
          elevated.push([file, ...args])
          return 0
        }
      },
      'IntelMSR.bin'
    )
    expect(result).toEqual({ ok: true })
    expect(fetched).toEqual([
      PAWNIO_MODULES_API,
      MODULES_RELEASE.assets[0].browser_download_url,
      PAWNIO_SETUP_API,
      SETUP_RELEASE.assets[0].browser_download_url,
      PM_DOWNLOAD.url
    ])
    expect(elevated).toHaveLength(1)
    expect(elevated[0][0]).toBe('powershell.exe')
    const script = decode(elevated[0])
    const helperText = readFileSync(join(dir, 'cache', 'helper.ps1'), 'utf8')
    expect(helperText).toBe(currentHelperScript())
    expect(script).toContain(`'${sha(helperText)}'`)
    expect(script).toContain(`'${sha(ZIP)}'`)
    expect(script).toContain(`'${sha(SETUP)}'`)
    expect(script).toContain(SID)
    expect(script).toContain("'IntelMSR.bin'")
    // PresentMon waits next to helper.ps1 (the helper checks its pinned hash before every start).
    expect(readFileSync(join(dir, 'cache', 'PresentMon.exe'))).toEqual(PM)
    expect(script).toContain('Copy-Item -LiteralPath (Join-Path $cd PresentMon.exe)')
  })

  it('reuses cached downloads and skips PawnIO when it is installed', async () => {
    const deps = (fetched: string[], run: CommandRunner): InstallDeps => ({
      http: { log: quiet, fetch: fakeFetch(fetched), retryDelayMs: 0 },
      cacheDir: join(dir, 'cache'),
      userSid: SID,
      run,
      env: { ProgramFiles: join(dir, 'pf') },
      presentmon: PM_DOWNLOAD,
      runElevated: async () => 0
    })
    await installHelper(deps([], noPawnIO), 'RyzenSMU.bin')
    const second: string[] = []
    let script = ''
    const pawn = join(dir, 'pf', 'PawnIO')
    mkdirSync(pawn, { recursive: true })
    writeFileSync(join(pawn, 'PawnIOLib.dll'), 'x')
    const r = await installHelper(
      {
        ...deps(second, noPawnIO),
        runElevated: async (_f: string, a: string[]) => {
          script = decode(a)
          return 0
        }
      },
      'RyzenSMU.bin'
    )
    expect(r.ok).toBe(true)
    expect(second).toEqual([PAWNIO_MODULES_API]) // the zip came from the cache, no setup lookup
    expect(script).not.toContain('Start-Process')
  })

  it('reports a declined prompt and a failed step', async () => {
    const base = {
      http: { log: quiet, fetch: fakeFetch([]), retryDelayMs: 0 },
      cacheDir: join(dir, 'cache'),
      userSid: SID,
      run: noPawnIO,
      env: { ProgramFiles: join(dir, 'pf') },
      presentmon: PM_DOWNLOAD
    }
    expect(await installHelper({ ...base, runElevated: async () => 1223 }, 'IntelMSR.bin')).toEqual(
      {
        ok: false,
        cancelled: true,
        message: 'The administrator prompt was declined.'
      }
    )
    expect(
      await installHelper({ ...base, runElevated: async () => 14 }, 'IntelMSR.bin')
    ).toMatchObject({
      ok: false,
      cancelled: false,
      message: expect.stringMatching(/task/)
    })
  })

  it('reports a download failure without any prompt', async () => {
    let prompted = false
    const r = await installHelper(
      {
        http: {
          log: quiet,
          fetch: (async () => new Response('{}')) as typeof fetch,
          retryDelayMs: 0
        },
        cacheDir: join(dir, 'cache'),
        userSid: SID,
        run: noPawnIO,
        runElevated: async () => {
          prompted = true
          return 0
        }
      },
      'IntelMSR.bin'
    )
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/no zip/) })
    expect(prompted).toBe(false)
  })
})

describe('removeHelper', () => {
  it('runs the elevated removal', async () => {
    let script = ''
    const r = await removeHelper({
      log: quiet,
      runElevated: async (_f, a) => {
        script = decode(a)
        return 0
      }
    })
    expect(r).toEqual({ ok: true })
    expect(script).toContain('Unregister-ScheduledTask')
    // The folder is resolved by the elevated script itself, never passed in.
    expect(script).toContain("[Environment]::GetFolderPath('CommonApplicationData')")
    expect(script).not.toContain('ProgramData\\PlayOut')
  })
})

describe('resolveHelperDir', () => {
  it('takes ProgramData from the known folder (through PowerShell), not from %ProgramData%', async () => {
    const scripts: string[] = []
    const ps = {
      run: async <T>(script: string): Promise<T | null> => {
        scripts.push(script)
        return 'D:\\ProgramData' as T
      }
    }
    const before = process.env.ProgramData
    process.env.ProgramData = 'C:\\Users\\x\\evil'
    try {
      expect(await resolveHelperDir(ps)).toBe('D:\\ProgramData\\PlayOut\\PowerHelper')
    } finally {
      process.env.ProgramData = before
    }
    expect(scripts).toEqual(["[Environment]::GetFolderPath('CommonApplicationData')"])
  })

  it('refuses an answer that is not an absolute local path', async () => {
    for (const answer of [null, '', 'ProgramData', '\\\\server\\share']) {
      const ps = { run: async <T>(): Promise<T | null> => answer as T }
      await expect(resolveHelperDir(ps)).rejects.toThrow(/ProgramData/)
    }
  })
})
