import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { EmulatorSetupProgress, Settings } from '../../shared/types'
import { createEmulatorSetupService, type EmulatorSetupModules } from './service'
import type { EmulatorSpec, ResolvedDownload, Runner, SetupManifest } from './types'

// The real presets are tested in presets/*.test.ts.
vi.mock('./presets', () => ({ PRESETS: {}, PRESETS_VERSION: 1 }))
vi.mock('./presets/ryujinx', () => ({ refreshRyujinxControllers: vi.fn(async () => undefined) }))

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const fixed = (name: string, version: string) =>
  ({
    kind: 'fixed',
    url: `https://example.test/${name}`,
    version,
    sha256: 'x',
    fileName: name
  }) as const

const CATALOG: EmulatorSpec[] = [
  {
    id: 'ALPHA',
    name: 'Alpha',
    folder: 'Alpha',
    exe: 'alpha.exe',
    source: fixed('alpha.zip', '1.0'),
    update: { channel: 'nightly', source: fixed('alpha-nightly.zip', '2.0-nightly') },
    keep: ['settings.ini']
  },
  {
    id: 'BETA',
    name: 'Beta',
    folder: 'Beta',
    exe: 'beta.exe',
    source: fixed('beta.zip', '1.0')
  }
]

/**
 * Fake modules: an "archive" is its version; unpacking writes <exe> holding that version, a default settings.ini and
 * a new file. `broken` names archives that unpack without the exe.
 */
function fakeModules(options: { fail?: string; broken?: string } = {}): {
  modules: Partial<EmulatorSetupModules>
  resolved: string[]
  downloaded: string[]
} {
  const resolved: string[] = []
  const downloaded: string[] = []
  const exeOf = (file: string): string => (file.includes('beta') ? 'beta.exe' : 'alpha.exe')
  return {
    resolved,
    downloaded,
    modules: {
      async resolveSource(spec) {
        if (spec.kind !== 'fixed') throw new Error('unexpected source')
        resolved.push(spec.fileName)
        if (options.fail && spec.fileName === options.fail)
          throw new Error('HTTP 503 from example.test')
        return [{ version: spec.version, url: spec.url, fileName: spec.fileName }]
      },
      async downloadFile(d: ResolvedDownload, dir) {
        downloaded.push(d.fileName)
        const file = join(dir, d.fileName)
        await fs.writeFile(file, d.version)
        return file
      },
      async ensureSevenZip(workDir) {
        return join(workDir, '7zr.exe')
      },
      async extractArchive(file, destDir) {
        const version = await fs.readFile(file, 'utf8')
        await fs.mkdir(destDir, { recursive: true })
        if (!options.broken || !file.endsWith(options.broken))
          await fs.writeFile(join(destDir, exeOf(file)), version)
        await fs.writeFile(join(destDir, 'settings.ini'), 'defaults')
        await fs.writeFile(join(destDir, `new-in-${version}.dll`), 'dll')
      },
      async configureEmulator() {
        // Folder settings are tested in configure.test.ts.
        return undefined
      },
      async syncBios() {
        return []
      },
      async runtimesMissing() {
        return []
      },
      async ensureRuntimes() {
        return []
      }
    }
  }
}

describe('Update all emulators', () => {
  let dir: string
  let exeDir: string
  let userData: string
  const root = (): string => join(exeDir, 'Emulators')

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'playout-emu-update-'))
    exeDir = join(dir, 'app')
    userData = join(dir, 'userData')
    await fs.mkdir(exeDir, { recursive: true })
    await fs.mkdir(userData, { recursive: true })
    vi.clearAllMocks()
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  function make(
    modules: Partial<EmulatorSetupModules>,
    run: Runner = async () => ({ code: 0, stdout: '', stderr: '' })
  ): {
    service: ReturnType<typeof createEmulatorSetupService>
    emitted: EmulatorSetupProgress[]
    onInstalled: ReturnType<typeof vi.fn>
  } {
    const settings: Settings = defaultSettings()
    const emitted: EmulatorSetupProgress[] = []
    const onInstalled = vi.fn()
    const service = createEmulatorSetupService({
      settings: { get: () => settings, update: () => settings },
      userData,
      exeDir,
      emit: (p) => emitted.push(p),
      log,
      onInstalled,
      catalog: CATALOG,
      modules,
      run,
      runElevated: async () => 0,
      readRegistry: async () => null,
      progressIntervalMs: 0
    })
    return { service, emitted, onInstalled }
  }

  const manifest = async (): Promise<SetupManifest> =>
    JSON.parse(await fs.readFile(join(root(), '.playout', 'emulators.json'), 'utf8'))
  const read = (...p: string[]): Promise<string> => fs.readFile(join(root(), ...p), 'utf8')

  it('puts the nightly build over the installed one, keeping settings, and reports each emulator', async () => {
    const fake = fakeModules()
    const { service, emitted, onInstalled } = make(fake.modules)
    await service.setup()
    await fs.writeFile(join(root(), 'Alpha', 'settings.ini'), 'mine')
    await fs.writeFile(join(root(), 'Alpha', 'saves.dat'), 'progress')
    onInstalled.mockClear()

    const status = await service.update()
    expect(status.lastUpdate?.items).toEqual([
      {
        id: 'ALPHA',
        name: 'Alpha',
        result: 'updated',
        from: '1.0',
        to: '2.0-nightly',
        channel: 'nightly'
      },
      { id: 'BETA', name: 'Beta', result: 'unavailable', from: '1.0' }
    ])
    expect(await read('Alpha', 'alpha.exe')).toBe('2.0-nightly')
    expect(await read('Alpha', 'settings.ini')).toBe('mine')
    expect(await read('Alpha', 'saves.dat')).toBe('progress')
    expect(await read('Alpha', 'new-in-2.0-nightly.dll')).toBe('dll')
    expect(status.items.find((i) => i.id === 'ALPHA')).toMatchObject({
      version: '2.0-nightly',
      channel: 'nightly'
    })
    const m = await manifest()
    expect(m.installed.ALPHA).toMatchObject({ version: '2.0-nightly', channel: 'nightly' })
    expect(m.installed.ALPHA.updatedAt).toBeTruthy()
    expect(onInstalled).toHaveBeenCalledTimes(1)
    expect(emitted.some((p) => p.stage === 'updates' && p.total === 1)).toBe(true)
    expect(emitted.at(-1)).toEqual({ done: 0, total: 0 })
    // Nothing left behind: no staging folder, no backup, no archive.
    expect((await fs.readdir(root())).sort()).toEqual(['.playout', 'Alpha', 'Beta'])
    expect(await fs.readdir(join(root(), '.playout', 'downloads'))).toEqual([])
    expect(await fs.readdir(join(root(), '.playout'))).not.toContain('update-backup')

    // The same build again: nothing is downloaded.
    fake.downloaded.length = 0
    const again = await service.update()
    expect(again.lastUpdate?.items[0]).toMatchObject({ result: 'current', to: '2.0-nightly' })
    expect(fake.downloaded).toEqual([])
  })

  it('leaves an emulator that is open alone', async () => {
    const fake = fakeModules()
    let open = false
    const { service } = make(fake.modules, async (file) => ({
      code: 0,
      stdout: file === 'tasklist' && open ? '"alpha.exe","1234","Console","1","10,000 K"\r\n' : '',
      stderr: ''
    }))
    await service.setup()
    open = true
    fake.resolved.length = 0
    const status = await service.update()
    expect(status.lastUpdate?.items[0]).toMatchObject({ result: 'running', from: '1.0' })
    expect(fake.resolved).toEqual([])
    expect(await read('Alpha', 'alpha.exe')).toBe('1.0')
  })

  it('keeps the installed build when the feed or the download fails', async () => {
    const failing = fakeModules({ fail: 'alpha-nightly.zip' })
    const { service } = make(failing.modules)
    await service.setup()
    const status = await service.update()
    expect(status.lastUpdate?.items[0]).toMatchObject({
      result: 'failed',
      error: 'HTTP 503 from example.test'
    })
    expect(await read('Alpha', 'alpha.exe')).toBe('1.0')
    expect((await manifest()).installed.ALPHA.version).toBe('1.0')
  })

  it('refuses a build without the exe and leaves the folder as it was', async () => {
    const broken = fakeModules({ broken: 'alpha-nightly.zip' })
    const { service } = make(broken.modules)
    await service.setup()
    const status = await service.update()
    expect(status.lastUpdate?.items[0]).toMatchObject({
      result: 'failed',
      error: 'alpha.exe is not in the downloaded files'
    })
    expect(await read('Alpha', 'alpha.exe')).toBe('1.0')
    expect(await fs.readdir(join(root(), 'Alpha'))).not.toContain('new-in-2.0-nightly.dll')
  })

  it('reports nothing to update when no emulator is installed', async () => {
    const { service, emitted } = make(fakeModules().modules)
    const status = await service.update()
    expect(status.lastUpdate?.items).toEqual([])
    expect(emitted.some((p) => p.stage === 'updates')).toBe(false)
  })

  it('joins a running update instead of starting a second one', async () => {
    const fake = fakeModules()
    const { service } = make(fake.modules)
    await service.setup()
    fake.downloaded.length = 0
    const [a, b] = await Promise.all([service.update(), service.update()])
    expect(a.lastUpdate).toEqual(b.lastUpdate)
    expect(fake.downloaded).toEqual(['alpha-nightly.zip'])
  })

  it('touches nothing when the list of running programs cannot be read', async () => {
    const fake = fakeModules()
    let broken = false
    const { service } = make(fake.modules, async () =>
      broken ? { code: 1, stdout: '', stderr: 'denied' } : { code: 0, stdout: '', stderr: '' }
    )
    await service.setup()
    broken = true
    fake.resolved.length = 0
    const status = await service.update()
    expect(status.lastUpdate?.items[0]).toMatchObject({ result: 'failed' })
    expect(status.lastUpdate?.items[0]?.error).toMatch(/running programs could not be read/)
    expect(fake.resolved).toEqual([])
    expect(await read('Alpha', 'alpha.exe')).toBe('1.0')
  })

  it('leaves an emulator PlayOut just began launching alone', async () => {
    const fake = fakeModules()
    const { service } = make(fake.modules)
    await service.setup()
    await service.beforeLaunch('ALPHA')
    const status = await service.update()
    expect(status.lastUpdate?.items[0]).toMatchObject({ result: 'running' })
    expect(await read('Alpha', 'alpha.exe')).toBe('1.0')
  })

  it('undoes, at the next start, an update PlayOut closed during', async () => {
    const fake = fakeModules()
    const first = make(fake.modules)
    await first.service.setup()
    // What a swap cut short leaves: the new exe in place, the old one in the backup, and the journal.
    const backup = join(root(), '.playout', 'update-backup', 'Alpha')
    await fs.mkdir(backup, { recursive: true })
    await fs.rename(join(root(), 'Alpha', 'alpha.exe'), join(backup, 'alpha.exe'))
    await fs.writeFile(join(root(), 'Alpha', 'alpha.exe'), '2.0-nightly')
    await fs.writeFile(join(root(), 'Alpha', 'half.dll'), 'new')
    await fs.writeFile(`${backup}.journal`, 'B\talpha.exe\nC\talpha.exe\nC\thalf.dll\n')
    await first.service.dispose()

    const second = make(fake.modules)
    await second.service.startup()
    expect(await read('Alpha', 'alpha.exe')).toBe('1.0')
    expect(await fs.readdir(join(root(), 'Alpha'))).not.toContain('half.dll')
    expect(await fs.readdir(join(root(), '.playout'))).not.toContain('update-backup')
  })
})
