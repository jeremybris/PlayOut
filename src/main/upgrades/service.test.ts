import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Game } from '../../shared/types'
import type { FoundUpscalerDll, UpgradeProgress } from '../../shared/upgrades'
import { EventBus } from '../events'
import type { PsRunner } from '../system/ps-worker'
import { AntiCheatScanError } from './anticheat'
import type { VendorDll } from './dlls'
import { VIDEO_CONTROLLER_SCRIPT } from './gpu'
import { installOptiScaler } from './optiscaler'
import {
  antiCheatUnknown,
  createUpgradesService,
  dllKindSummaries,
  displayVersion,
  formatSize,
  notOptiScalers,
  parseSubject,
  signatureMatches,
  signatureScript,
  type UpgradeModules,
  type UpgradesServiceDeps
} from './service'

const GB = 1024 ** 3

const RTX_4070 = {
  Name: 'NVIDIA GeForce RTX 4070',
  PNPDeviceID: 'PCI\\VEN_10DE&DEV_2786&SUBSYS_00000000&REV_A1\\4&1',
  DriverVersion: '32.0.15.8157',
  AdapterCompatibility: 'NVIDIA',
  CurrentHorizontalResolution: 2560,
  ConfigManagerErrorCode: 0,
  DedicatedVideoMemory: '12884901888',
  LocationInfo: 'PCI bus 1, device 0, function 0'
}

const ARC_B580 = {
  Name: 'Intel(R) Arc(TM) B580 Graphics',
  PNPDeviceID: 'PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000&REV_00\\4&1',
  DriverVersion: '32.0.101.6979',
  AdapterCompatibility: 'Intel Corporation',
  CurrentHorizontalResolution: 2560,
  ConfigManagerErrorCode: 0,
  DedicatedVideoMemory: '12884901888',
  LocationInfo: 'PCI bus 3, device 0, function 0'
}

const DLSS_310: VendorDll = {
  kind: 'dlss',
  version: '310.9.16.0',
  fileName: 'nvngx_dlss.dll',
  url: 'https://raw.githubusercontent.com/NVIDIA/DLSS/v310.9.16/lib/Windows_x86_64/rel/nvngx_dlss.dll',
  size: 100,
  gitBlobSha: 'a'.repeat(40),
  sha256: null,
  signer: 'NVIDIA Corporation'
}

const roots: string[] = []
const services: Array<{ dispose(): Promise<void> }> = []
afterEach(async () => {
  // Pending writes of the facts file end before its folder goes.
  await Promise.all(services.splice(0).map((s) => s.dispose()))
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function makeGame(dir: string, over: Partial<Game> = {}): Game {
  return {
    id: 'steam:620',
    source: 'steam',
    externalId: '620',
    platformId: 'pc',
    title: 'Portal 2',
    sortTitle: 'portal 2',
    installed: true,
    installDir: dir,
    launch: { kind: 'uri', uri: 'steam://rungameid/620' },
    tracking: { kind: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'done',
    user: {},
    ...over
  } as unknown as Game
}

interface Harness {
  service: ReturnType<typeof createUpgradesService>
  game: Game
  games: Map<string, Game>
  installDir: string
  root: string
  progress: UpgradeProgress[]
  nextEnd: () => Promise<UpgradeProgress>
  scripts: string[]
  deps: UpgradesServiceDeps
}

interface Options {
  game?: Partial<Game>
  gpus?: object[]
  modules?: Partial<UpgradeModules>
  measure?: () => unknown
  running?: () => boolean
  deps?: Partial<UpgradesServiceDeps>
}

function setup(options: Options = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'playout-upgrades-'))
  roots.push(root)
  const installDir = join(root, 'Game')
  mkdirSync(installDir)
  const game = makeGame(installDir, options.game)
  const games = new Map([[game.id, game]])
  const events = new EventBus()
  const progress: UpgradeProgress[] = []
  const ends: Array<(p: UpgradeProgress) => void> = []
  events.on('upgrades:progress', (p) => {
    progress.push(p)
    if (p.state !== 'running') ends.shift()?.(p)
  })
  const nextEnd = (): Promise<UpgradeProgress> => new Promise((r) => ends.push(r))
  const scripts: string[] = []
  const ps: PsRunner = {
    async run<T>(script: string): Promise<T | null> {
      scripts.push(script)
      if (script === VIDEO_CONTROLLER_SCRIPT)
        return JSON.stringify(options.gpus ?? [RTX_4070]) as unknown as T
      if (script.includes('PlayOutWof'))
        return (options.measure?.() ?? {
          size: 10 * GB,
          onDisk: 10 * GB,
          compressedFiles: 0,
          eligible: 10,
          eligibleCompressed: 0,
          changed: null
        }) as T
      if (script.includes('folderCompressed'))
        return { fileSystem: 'NTFS', network: false, folderCompressed: false } as T
      throw new Error(`unexpected script: ${script.slice(0, 40)}`)
    }
  }
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const offline = (): Promise<never> => Promise.reject(new Error('offline in tests'))
  const deps: UpgradesServiceDeps = {
    library: { getGame: (id) => games.get(id) },
    isGameRunning: options.running ?? (() => false),
    events,
    log,
    paths: {
      upgradesDir: join(root, 'Upgrades'),
      factsFile: join(root, 'userData', 'upgrades.json')
    },
    http: { fetchJson: offline, fetchText: offline, download: offline },
    powershell: ps,
    archive: { extract: vi.fn(offline) },
    spawnTool: vi.fn(() => {
      throw new Error('no programs run in tests')
    }),
    spawnDetached: vi.fn(),
    spawnCompact: vi.fn(offline),
    verifySigner: vi.fn(async () => true),
    freeSpace: async () => 1e12,
    lookupWaitMs: 50,
    measureWaitMs: 200,
    modules: {
      compressUnavailable: async () => null,
      ...options.modules
    },
    ...options.deps
  }
  const service = createUpgradesService(deps)
  services.push(service)
  return { service, game, games, installDir, root, progress, nextEnd, scripts, deps }
}

describe('upgradeStatus', () => {
  it('blocks ROMs, games on another PC, games not installed and missing folders', async () => {
    const t = setup()
    const cases: Array<[Partial<Game>, string]> = [
      [{ source: 'rom' }, 'Upgrades are for PC games.'],
      [{ remote: {} as Game['remote'] }, 'This game is on another PC.'],
      [{ installed: false }, 'The game is not installed.'],
      [{ installDir: join(t.root, 'gone') }, "The game's folder was not found."]
    ]
    for (const [over, blocked] of cases) {
      t.games.set(t.game.id, { ...t.game, ...over })
      const status = await t.service.upgradeStatus(t.game.id)
      expect(status.blocked).toBe(blocked)
      expect(status.compress.unavailable).toBe(blocked)
    }
    await expect(t.service.upgradeStatus('steam:1')).rejects.toThrow('Unknown game')
  })

  it('says to close a running game but still shows what it has', async () => {
    const t = setup({ running: () => true })
    const status = await t.service.upgradeStatus(t.game.id)
    expect(status.blocked).toBe('Close the game first.')
    expect(status.dlss5.unavailable).toBeNull()
  })

  it('detects the graphics card once and offers DLSS 5 on an RTX card', async () => {
    const t = setup()
    const first = await t.service.upgradeStatus(t.game.id)
    await t.service.upgradeStatus(t.game.id)
    expect(first.gpu).toMatchObject({ vendor: 'nvidia', rtxSeries: 40 })
    expect(first.dlss5).toEqual({ unavailable: null, appReady: false })
    expect(first.shaders.unavailable).toBeNull()
    expect(t.scripts.filter((s) => s === VIDEO_CONTROLLER_SCRIPT)).toHaveLength(1)
  })

  it('turns shaders and DLSS 5 off on Intel graphics', async () => {
    const t = setup({ gpus: [ARC_B580] })
    const status = await t.service.upgradeStatus(t.game.id)
    expect(status.gpu?.vendor).toBe('intel')
    expect(status.shaders.unavailable).toMatch(/Intel/)
    expect(status.dlss5.unavailable).toMatch(/RTX/)
  })

  it('shows anti-cheat as unknown when the folder could not be checked, and the risk tags', async () => {
    const t = setup({
      game: { metadata: { steamTags: { tags: ['PvP', 'Puzzle'] } } as Game['metadata'] },
      modules: {
        scanAntiCheat: async (dir) => {
          throw new AntiCheatScanError('unreadable', dir)
        }
      }
    })
    const status = await t.service.upgradeStatus(t.game.id)
    expect(status.risk).toEqual({ tags: ['PvP'], antiCheat: [antiCheatUnknown()] })
  })

  it('finds anti-cheat in the folder', async () => {
    const t = setup()
    mkdirSync(join(t.installDir, 'EasyAntiCheat'))
    const status = await t.service.upgradeStatus(t.game.id)
    expect(status.risk.antiCheat).toEqual(['Easy Anti-Cheat'])
  })

  it('answers without the newest DLL versions while their lookup is slow', async () => {
    const latestVendorDlls = vi.fn(() => new Promise<never>(() => undefined))
    const t = setup({
      modules: {
        scanDlls: async (dir) => [
          {
            kind: 'dlss',
            relPath: 'nvngx_dlss.dll',
            version: '3.5.10.0',
            swapped: false,
            path: join(dir, 'nvngx_dlss.dll')
          }
        ],
        latestVendorDlls
      }
    })
    const started = Date.now()
    const status = await t.service.upgradeStatus(t.game.id)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(status.dlls).toEqual({
      found: [{ kind: 'dlss', relPath: 'nvngx_dlss.dll', version: '3.5.10.0', swapped: false }],
      kinds: [{ kind: 'dlss', version: '3.5.10', latest: null, updatable: false }],
      latest: { dlss: null },
      updatable: false,
      restorable: false
    })
    expect(status.optiscaler.hasInputs).toBe(true)
    // A second status does not start a second lookup.
    await t.service.upgradeStatus(t.game.id)
    expect(latestVendorDlls).toHaveBeenCalledTimes(1)
  })

  it('offers the update when a newer official file exists, and Restore for swapped files', async () => {
    const t = setup({
      modules: {
        scanDlls: async (dir) => [
          {
            kind: 'dlss',
            relPath: 'a\\nvngx_dlss.dll',
            version: '3.5.10.0',
            swapped: false,
            path: join(dir, 'a', 'nvngx_dlss.dll')
          },
          {
            kind: 'dlss',
            relPath: 'b\\nvngx_dlss.dll',
            version: '310.9.16.0',
            swapped: true,
            path: join(dir, 'b', 'nvngx_dlss.dll')
          }
        ],
        latestVendorDlls: async () => ({ dlss: DLSS_310 })
      }
    })
    const status = await t.service.upgradeStatus(t.game.id)
    expect(status.dlls.latest).toEqual({ dlss: '310.9.16.0' })
    expect(status.dlls.updatable).toBe(true)
    expect(status.dlls.restorable).toBe(true)
  })

  it('never offers DLSS 1 files an update', async () => {
    const t = setup({
      modules: {
        scanDlls: async (dir) => [
          {
            kind: 'dlss',
            relPath: 'nvngx_dlss.dll',
            version: '1.0.13.0',
            swapped: false,
            path: join(dir, 'nvngx_dlss.dll')
          }
        ],
        latestVendorDlls: async () => ({ dlss: DLSS_310 })
      }
    })
    expect((await t.service.upgradeStatus(t.game.id)).dlls.updatable).toBe(false)
  })

  it('measures the folder and shows CompactGUI estimates for Steam games', async () => {
    const t = setup({
      measure: () => ({
        size: 40 * GB,
        onDisk: 30 * GB,
        compressedFiles: 5,
        eligible: 5,
        eligibleCompressed: 5,
        changed: 0
      }),
      deps: {
        http: {
          fetchJson: () => Promise.reject(new Error('offline')),
          fetchText: async () =>
            JSON.stringify([
              {
                SteamID: 620,
                CompressionResults: [
                  { CompType: 1, BeforeBytes: 100, AfterBytes: 75, TotalResults: 2 }
                ]
              }
            ]),
          download: () => Promise.reject(new Error('offline'))
        }
      }
    })
    const status = await t.service.upgradeStatus(t.game.id)
    expect(status.compress).toEqual({
      state: 'compressed',
      size: 40 * GB,
      onDisk: 30 * GB,
      estimatedSaving: 0.25,
      unavailable: null
    })
  })

  it('shows the last measure while a slow one runs again in the background', async () => {
    let release: (v: unknown) => void = () => undefined
    let calls = 0
    const t = setup({
      measure: () => {
        calls++
        return new Promise((r) => (release = r))
      },
      deps: { measureWaitMs: 20 }
    })
    const status = await t.service.upgradeStatus(t.game.id)
    expect(status.compress).toMatchObject({ state: 'none', onDisk: null })
    release({
      size: 2 * GB,
      onDisk: GB,
      compressedFiles: 1,
      eligible: 1,
      eligibleCompressed: 1,
      changed: null
    })
    await vi.waitFor(async () =>
      expect((await t.service.upgradeStatus(t.game.id)).compress.onDisk).toBe(GB)
    )
    expect(calls).toBe(1)
  })

  it('freshMeasure waits for a measure of the folder now instead of a kept one (a reinstall)', async () => {
    let answer: unknown = {
      size: 2 * GB,
      onDisk: GB,
      compressedFiles: 1,
      eligible: 1,
      eligibleCompressed: 1,
      changed: null
    }
    let calls = 0
    const t = setup({
      measure: () => {
        calls++
        return new Promise((r) => setTimeout(() => r(answer), 50))
      },
      deps: { measureWaitMs: 1000 }
    })
    expect((await t.service.upgradeStatus(t.game.id)).compress.state).toBe('compressed')
    // Uninstalled and installed again: nothing is compressed now. A plain status keeps the measure it has.
    answer = {
      size: 2 * GB,
      onDisk: 2 * GB,
      compressedFiles: 0,
      eligible: 1,
      eligibleCompressed: 0,
      changed: null
    }
    expect((await t.service.upgradeStatus(t.game.id)).compress.state).toBe('compressed')
    const fresh = await t.service.upgradeStatus(t.game.id, { freshMeasure: true })
    expect(fresh.compress).toMatchObject({ state: 'none', onDisk: 2 * GB })
    expect(calls).toBe(2)
  })
})

describe('runUpgrade', () => {
  it('updates the DLLs: downloads the newer kinds, swaps them and reports the versions', async () => {
    const ensureVendorDll = vi.fn(async () => 'C:\\cache\\nvngx_dlss.dll')
    const swapDlls = vi.fn(async () => ({ replaced: ['nvngx_dlss.dll'], skipped: [] }))
    const t = setup({
      modules: {
        scanDlls: async (dir) => [
          {
            kind: 'dlss',
            relPath: 'nvngx_dlss.dll',
            version: '3.5.10.0',
            swapped: false,
            path: join(dir, 'nvngx_dlss.dll')
          }
        ],
        latestVendorDlls: async () => ({ dlss: DLSS_310 }),
        ensureVendorDll,
        swapDlls
      }
    })
    const end = t.nextEnd()
    const status = await t.service.runUpgrade(t.game.id, { kind: 'dlls-update' })
    expect(status.busy).toBe('dlls')
    expect(await end).toMatchObject({
      state: 'done',
      upgrade: 'dlls',
      message: 'Portal 2: DLSS 3.5.10 → 310.9.16'
    })
    expect(ensureVendorDll).toHaveBeenCalledWith(
      DLSS_310,
      join(t.root, 'Upgrades', 'DLLs'),
      expect.objectContaining({ verifySigner: t.deps.verifySigner })
    )
    expect(swapDlls).toHaveBeenCalledWith(t.installDir, expect.any(Array), {
      dlss: { path: 'C:\\cache\\nvngx_dlss.dll', version: '310.9.16.0' }
    })
    expect(t.progress[0]).toMatchObject({ state: 'running', message: 'Starting…' })
    expect((await t.service.upgradeStatus(t.game.id)).busy).toBeNull()
  })

  it('fails with a clear line when the newest versions cannot be looked up', async () => {
    const t = setup({
      modules: {
        scanDlls: async (dir) => [
          {
            kind: 'dlss',
            relPath: 'nvngx_dlss.dll',
            version: '3.5.10.0',
            swapped: false,
            path: join(dir, 'nvngx_dlss.dll')
          }
        ]
      }
    })
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'dlls-update' })
    expect(await end).toMatchObject({
      state: 'failed',
      message:
        'The newest versions could not be looked up. Check the internet connection, then try again.'
    })
  })

  it('runs one action per game, refuses while the game runs, and stops on cancel', async () => {
    let running = false
    const compressFolder = vi.fn<UpgradeModules['compressFolder']>(
      (_dir, _alg, _progress, signal) =>
        new Promise((r) =>
          signal.addEventListener('abort', () =>
            r({ ok: false, message: 'Compression was stopped.' })
          )
        )
    )
    const t = setup({ modules: { compressFolder }, running: () => running })
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'compress', algorithm: 'xpress8k' })
    await expect(t.service.runUpgrade(t.game.id, { kind: 'uncompress' })).rejects.toThrow(
      'An upgrade is already running for this game.'
    )
    await vi.waitFor(() => expect(compressFolder).toHaveBeenCalled())
    await t.service.cancelUpgrade(t.game.id)
    expect(await end).toMatchObject({
      state: 'failed',
      upgrade: 'compress',
      message: 'Compression was stopped.'
    })
    running = true
    await expect(t.service.runUpgrade(t.game.id, { kind: 'dlls-restore' })).rejects.toThrow(
      'Close the game first.'
    )
  })

  it('compresses with the sizes in its line and remembers the algorithm and the time', async () => {
    const compressFolder = vi.fn<UpgradeModules['compressFolder']>(async () => ({
      ok: true,
      message: 'Compressed 10 files.'
    }))
    let measured = {
      size: 41.2 * GB,
      onDisk: 41.2 * GB,
      compressedFiles: 0,
      eligible: 10,
      eligibleCompressed: 0,
      changed: null as number | null
    }
    const t = setup({ modules: { compressFolder }, measure: () => measured })
    await t.service.upgradeStatus(t.game.id)
    measured = { ...measured, onDisk: 30.8 * GB, compressedFiles: 10, eligibleCompressed: 10 }
    let end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'compress', algorithm: 'xpress8k' })
    expect(await end).toMatchObject({
      state: 'done',
      message: 'Portal 2 compressed: 41.2 GB → 30.8 GB'
    })
    expect(compressFolder.mock.calls[0]![5]).toEqual({ previousAlgorithm: null })
    const status = await t.service.upgradeStatus(t.game.id)
    expect(status.compress).toMatchObject({ state: 'compressed', onDisk: 30.8 * GB })

    end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'compress', algorithm: 'lzx' })
    await end
    expect(compressFolder.mock.calls[1]![5]).toEqual({ previousAlgorithm: 'xpress8k' })
    // The measure after a compression knows when it was done (a later game update shows as 'partial').
    expect(t.scripts.filter((s) => s.includes('PlayOutWof')).at(-1)).not.toContain(
      '$sinceMs = [double]0'
    )

    await t.service.dispose()
    const facts = JSON.parse(readFileSync(t.deps.paths.factsFile, 'utf8'))
    expect(facts.games['steam:620']).toMatchObject({ compressAlgorithm: 'lzx' })
    expect(typeof facts.games['steam:620'].compressedAt).toBe('number')
  })

  it('uncompresses with the last bytes on disk for the free space check', async () => {
    const uncompressFolder = vi.fn<UpgradeModules['uncompressFolder']>(async () => ({
      ok: true,
      message: 'Uncompressed 10 files.'
    }))
    let onDisk = 30 * GB
    const t = setup({
      modules: { uncompressFolder },
      measure: () => ({
        size: 40 * GB,
        onDisk,
        compressedFiles: onDisk < 40 * GB ? 10 : 0,
        eligible: 10,
        eligibleCompressed: onDisk < 40 * GB ? 10 : 0,
        changed: null
      })
    })
    await t.service.upgradeStatus(t.game.id)
    onDisk = 40 * GB
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'uncompress' })
    expect(await end).toMatchObject({
      state: 'done',
      message: 'Portal 2 uncompressed: 30.0 GB → 40.0 GB'
    })
    expect(uncompressFolder.mock.calls[0]![4]).toEqual({ onDisk: 30 * GB })
  })

  it('precompiles shaders for a Steam game and remembers a game SCSKiller cannot do', async () => {
    const compileShaders = vi.fn<UpgradeModules['compileShaders']>(async () => ({
      ok: false,
      unsupported: true,
      message: "SCSKiller doesn't list this game"
    }))
    const disableRecorder = vi.fn(async () => undefined)
    const ensureScsKiller = vi.fn<UpgradeModules['ensureScsKiller']>(
      async () => 'C:\\Up\\SCSKiller\\current\\cli\\scskiller.exe'
    )
    const t = setup({
      modules: {
        latestScsKiller: async () => ({
          version: '1.4.8',
          zipUrl: 'https://github.com/BlueHeisenberg/SCSKiller/releases/download/v1.4.8/x.zip',
          sumsUrl: null,
          fileName: 'SCSKiller-1.4.8-Portable.zip',
          size: 1,
          sha256: 'b'.repeat(64)
        }),
        ensureScsKiller,
        disableRecorder,
        compileShaders
      }
    })
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'shaders-compile' })
    expect(await end).toMatchObject({
      state: 'failed',
      message: "Portal 2: SCSKiller doesn't list this game"
    })
    expect(ensureScsKiller.mock.calls[0]![1]).toBe(join(t.root, 'Upgrades'))
    expect(disableRecorder).toHaveBeenCalledWith('C:\\Up\\SCSKiller\\data')
    expect(compileShaders.mock.calls[0]![1]).toEqual({
      steamAppId: '620',
      installDir: t.installDir,
      title: 'Portal 2'
    })
    const status = await t.service.upgradeStatus(t.game.id)
    // A note, not a lock: a later SCSKiller scan or driver update can change the answer, so the row stays usable.
    expect(status.shaders.unavailable).toBeNull()
    expect(status.shaders.note).toBe("SCSKiller doesn't list this game")

    // Trying again works, and a successful run clears the note.
    compileShaders.mockResolvedValueOnce({ ok: true, message: 'Precompiled 12 shaders (0 failed)' })
    const again = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'shaders-compile' })
    expect(await again).toMatchObject({ state: 'done' })
    const after = await t.service.upgradeStatus(t.game.id)
    expect(after.shaders.note).toBeNull()
    expect(after.shaders.compiledAt).not.toBeNull()
  })

  it('remembers when the shaders were precompiled', async () => {
    const t = setup({
      deps: { now: () => Date.parse('2026-11-19T10:00:00.000Z') },
      modules: {
        latestScsKiller: async () => null,
        disableRecorder: async () => undefined,
        compileShaders: async () => ({ ok: true, message: 'Precompiled 4816 shaders (0 failed)' })
      }
    })
    const exe = join(t.root, 'Upgrades', 'SCSKiller', 'current', 'cli', 'scskiller.exe')
    mkdirSync(join(exe, '..'), { recursive: true })
    writeFileSync(exe, '')
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'shaders-compile' })
    expect(await end).toMatchObject({
      state: 'done',
      message: 'Portal 2: Precompiled 4816 shaders (0 failed)'
    })
    expect((await t.service.upgradeStatus(t.game.id)).shaders.compiledAt).toBe(
      '2026-11-19T10:00:00.000Z'
    )
  })

  it('installs OptiScaler into the game folder for the graphics card, with the signer check', async () => {
    const ensureOptiScaler = vi.fn<UpgradeModules['ensureOptiScaler']>(
      async () => 'C:\\Up\\OptiScaler\\OptiScaler-0.9.5'
    )
    const installOptiScaler = vi.fn(async () => ({
      relDir: 'bin',
      asName: 'dxgi.dll',
      version: '0.9.5'
    }))
    const t = setup({
      gpus: [ARC_B580],
      modules: {
        scanDlls: async (dir) => [
          {
            kind: 'xess',
            relPath: 'bin\\libxess.dll',
            version: '1.3.0.28',
            swapped: false,
            path: join(dir, 'bin', 'libxess.dll')
          }
        ],
        pickExeDir: async (dir) => join(dir, 'bin'),
        latestOptiScaler: async () => ({
          version: '0.9.5',
          url: 'https://github.com/optiscaler/OptiScaler/releases/download/v0.9.5/o.7z',
          size: 10,
          sha256: 'c'.repeat(64),
          fileName: 'Optiscaler_0.9.5.7z'
        }),
        ensureOptiScaler,
        installOptiScaler
      }
    })
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'optiscaler-install' })
    expect(await end).toMatchObject({ state: 'done' })
    expect((await end.then(() => t.progress.at(-1)))?.message).toContain('OptiScaler 0.9.5')
    expect(ensureOptiScaler.mock.calls[0]![1]).toBe(join(t.root, 'Upgrades', 'OptiScaler'))
    expect(ensureOptiScaler.mock.calls[0]![2]).toMatchObject({
      verifySigner: t.deps.verifySigner
    })
    expect(installOptiScaler).toHaveBeenCalledWith(
      join(t.installDir, 'bin'),
      'C:\\Up\\OptiScaler\\OptiScaler-0.9.5',
      { gpuVendor: 'intel', version: '0.9.5', installDir: t.installDir }
    )
  })

  it('refuses OptiScaler for a game without upscaler files', async () => {
    const t = setup()
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'optiscaler-install' })
    expect(await end).toMatchObject({
      state: 'failed',
      message: expect.stringMatching(/needs DLSS/)
    })
  })

  it('downloads and opens DLSS AiO Swapper with the game folder', async () => {
    const openAioSwapper = vi.fn(async () => undefined)
    const ensureAioSwapper = vi.fn<UpgradeModules['ensureAioSwapper']>(
      async () => 'C:\\Up\\DLSS-AiO-Swapper\\x.exe'
    )
    const isProcessRunning = vi.fn(async () => false)
    const t = setup({
      deps: { isProcessRunning },
      modules: {
        latestAioSwapper: async () => ({
          version: '3.0.15',
          url: 'https://github.com/machiavelli31/DLSS-AiO-Swapper/releases/download/v3.0.15/x.exe',
          size: 1,
          sha256: 'd'.repeat(64),
          fileName: 'DLSS-AiO-Swapper-3.0.15-portable.exe'
        }),
        ensureAioSwapper,
        openAioSwapper
      }
    })
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'dlss5-open' })
    expect(await end).toMatchObject({
      state: 'done',
      message: 'DLSS AiO Swapper opened for Portal 2'
    })
    expect(ensureAioSwapper.mock.calls[0]![1]).toBe(join(t.root, 'Upgrades'))
    const [exe, dir, deps] = openAioSwapper.mock.calls[0]! as unknown as [
      string,
      string,
      { isAppRunning: () => Promise<boolean> }
    ]
    expect([exe, dir]).toEqual(['C:\\Up\\DLSS-AiO-Swapper\\x.exe', t.installDir])
    await deps.isAppRunning()
    expect(isProcessRunning).toHaveBeenCalledWith('x.exe')
  })

  it('puts the original DLLs back and removes OptiScaler', async () => {
    const t = setup({
      modules: {
        restoreDlls: async () => ({ restored: ['a.dll', 'b.dll'], failed: [] }),
        removeOptiScaler: async () => []
      }
    })
    let end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'dlls-restore' })
    expect(await end).toMatchObject({
      state: 'done',
      message: 'Portal 2: 2 original files put back'
    })
    end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'optiscaler-remove' })
    expect(await end).toMatchObject({ state: 'done', message: 'Portal 2: OptiScaler removed' })
  })
})

/** A compress / uncompress that runs until the job is stopped (also when stopped before it started). */
function untilStopped(
  signal: AbortSignal,
  message: string
): Promise<{ ok: boolean; message: string }> {
  return new Promise((r) => {
    if (signal.aborted) r({ ok: false, message })
    else signal.addEventListener('abort', () => r({ ok: false, message }))
  })
}

describe('compress and uncompress that do not finish', () => {
  const uncompressed = {
    size: 60 * GB,
    onDisk: 60 * GB,
    compressedFiles: 0,
    eligible: 10,
    eligibleCompressed: 0,
    changed: null as number | null
  }
  /** Half the files compressed: compressStateOf reads this as 'partial' when no compression time is known. */
  const half = { ...uncompressed, onDisk: 45 * GB, compressedFiles: 5, eligibleCompressed: 5 }

  it('a stopped compression ends at once, is not saved as done and then reads as partial', async () => {
    let answer: () => unknown = () => uncompressed
    const compressFolder = vi.fn<UpgradeModules['compressFolder']>(
      (_dir, _alg, _progress, signal) =>
        new Promise((r) =>
          signal.addEventListener('abort', () =>
            r({ ok: false, message: 'Compression was stopped.' })
          )
        )
    )
    const t = setup({ measure: () => answer(), modules: { compressFolder } })
    expect((await t.service.upgradeStatus(t.game.id)).compress.state).toBe('none')
    // The measure after the stop takes long (a huge game) until released.
    let release: (v: unknown) => void = () => undefined
    answer = () => new Promise((r) => (release = r))
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'compress', algorithm: 'xpress8k' })
    await vi.waitFor(() => expect(compressFolder).toHaveBeenCalled())
    await t.service.cancelUpgrade(t.game.id)
    // The job ends without waiting for the measure: the menu is usable again.
    expect(await end).toMatchObject({ state: 'failed', message: 'Compression was stopped.' })
    expect((await t.service.upgradeStatus(t.game.id)).busy).toBeNull()
    release(half)
    await vi.waitFor(async () =>
      expect((await t.service.upgradeStatus(t.game.id)).compress).toMatchObject({
        state: 'partial',
        onDisk: 45 * GB
      })
    )
    // No compression time or algorithm was saved for the stopped run (the measure looked at every file).
    expect(t.scripts.filter((s) => s.includes('PlayOutWof')).at(-1)).toContain(
      '$sinceMs = [double]0'
    )
    await t.service.dispose()
    const facts = JSON.parse(readFileSync(t.deps.paths.factsFile, 'utf8'))
    expect(facts.games['steam:620'].compressedAt).toBeUndefined()
    expect(facts.games['steam:620'].compressAlgorithm).toBeUndefined()
  })

  it('a stopped uncompress ends without waiting for the measure', async () => {
    let answer: () => unknown = () => half
    const t = setup({
      measure: () => answer(),
      modules: {
        uncompressFolder: (_dir, _progress, signal) =>
          untilStopped(signal, 'Uncompressing was stopped.')
      }
    })
    await t.service.upgradeStatus(t.game.id)
    answer = () => new Promise<never>(() => undefined)
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'uncompress' })
    await t.service.cancelUpgrade(t.game.id)
    expect(await end).toMatchObject({ state: 'failed', message: 'Uncompressing was stopped.' })
    // The job is gone although the measure never ends: another action can start.
    expect((await t.service.upgradeStatus(t.game.id)).busy).toBeNull()
    const next = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'dlls-restore' })
    expect(await next).toMatchObject({ state: 'done' })
  })

  it('a failed compression measures again, so the menu does not keep the state from before', async () => {
    let answer: unknown = uncompressed
    const t = setup({
      measure: () => answer,
      modules: {
        compressFolder: async () => ({ ok: false, message: '1 file could not be compressed.' })
      }
    })
    expect((await t.service.upgradeStatus(t.game.id)).compress.state).toBe('none')
    answer = { ...half, onDisk: 34 * GB, compressedFiles: 9, eligibleCompressed: 9 }
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'compress', algorithm: 'xpress8k' })
    expect(await end).toMatchObject({ state: 'failed' })
    await vi.waitFor(async () =>
      expect((await t.service.upgradeStatus(t.game.id)).compress).toMatchObject({
        state: 'partial',
        onDisk: 34 * GB
      })
    )
  })

  it('a failed uncompress measures again too', async () => {
    let answer: unknown = { ...half, onDisk: 30 * GB, compressedFiles: 10, eligibleCompressed: 10 }
    const t = setup({
      measure: () => answer,
      modules: {
        uncompressFolder: async () => ({ ok: false, message: '1 file could not be uncompressed.' })
      }
    })
    expect((await t.service.upgradeStatus(t.game.id)).compress.state).toBe('compressed')
    answer = { ...half, onDisk: 59 * GB, compressedFiles: 1, eligibleCompressed: 1 }
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'uncompress' })
    expect(await end).toMatchObject({ state: 'failed' })
    await vi.waitFor(async () =>
      expect((await t.service.upgradeStatus(t.game.id)).compress).toMatchObject({
        state: 'partial',
        onDisk: 59 * GB
      })
    )
  })
})

describe('upgrades running while the game starts', () => {
  it('still reports the running job (so the menu keeps Stop) when the game is started meanwhile', async () => {
    let running = false
    const t = setup({
      running: () => running,
      modules: {
        compressFolder: (_dir, _alg, _progress, signal) => untilStopped(signal, 'stopped')
      }
    })
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'compress', algorithm: 'xpress8k' })
    running = true
    const status = await t.service.upgradeStatus(t.game.id)
    expect(status).toMatchObject({ blocked: 'Close the game first.', busy: 'compress' })
    await t.service.cancelUpgrade(t.game.id)
    expect(await end).toMatchObject({ state: 'failed' })
  })
})

/** A tiny fake Windows program file carrying a version resource with the given file version. */
function makePe(version: string): Buffer {
  const [a, b, c, d] = version.split('.').map(Number)
  const head = Buffer.alloc(64, 0x11)
  head.write('MZ', 0, 'latin1')
  const key = Buffer.concat([Buffer.from('VS_VERSION_INFO', 'utf16le'), Buffer.alloc(2)])
  const fixed = Buffer.alloc(52)
  fixed.writeUInt32LE(0xfeef04bd, 0)
  fixed.writeUInt32LE(0x00010000, 4)
  fixed.writeUInt32LE(((a! << 16) | b!) >>> 0, 8)
  fixed.writeUInt32LE(((c! << 16) | d!) >>> 0, 12)
  return Buffer.concat([head, key, fixed, Buffer.alloc(16)])
}

/** Every file and folder under `dir` with its content, relative with forward slashes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = join(e.parentPath, e.name)
    const rel = full.slice(dir.length + 1).replace(/\\/g, '/')
    out[rel] = e.isDirectory() ? '<dir>' : readFileSync(full).toString('base64')
  }
  return out
}

describe('DLL update with OptiScaler installed', () => {
  it("leaves OptiScaler's files alone, so Remove and Restore put the folder back exactly", async () => {
    const vendor = (kind: VendorDll['kind'], fileName: string, version: string): VendorDll => ({
      ...DLSS_310,
      kind,
      fileName,
      version
    })
    const t = setup({
      modules: {
        latestVendorDlls: async () => ({
          dlss: DLSS_310,
          xess: vendor('xess', 'libxess.dll', '2.0.2.68')
        }),
        // The checked official files (no network): written into the test's own cache folder.
        ensureVendorDll: async (file, cacheDir) => {
          const path = join(cacheDir, file.kind, file.fileName)
          mkdirSync(join(path, '..'), { recursive: true })
          writeFileSync(path, makePe(file.version))
          return path
        }
      }
    })
    // A game shipping only DLSS.
    writeFileSync(join(t.installDir, 'Game.exe'), 'exe')
    writeFileSync(join(t.installDir, 'nvngx_dlss.dll'), makePe('3.5.10.0'))
    const original = snapshot(t.installDir)

    // OptiScaler for an AMD card adds its own (older) XeSS file.
    const pkg = join(t.root, 'pkg')
    mkdirSync(pkg)
    writeFileSync(join(pkg, 'OptiScaler.dll'), 'optiscaler')
    writeFileSync(join(pkg, 'libxess.dll'), makePe('1.3.0.0'))
    await installOptiScaler(t.installDir, pkg, {
      gpuVendor: 'amd',
      version: '0.9.5',
      installDir: t.installDir
    })
    expect(readFileSync(join(t.installDir, 'libxess.dll'))).toEqual(makePe('1.3.0.0'))

    // The update offers and replaces only the game's own DLSS file.
    expect((await t.service.upgradeStatus(t.game.id)).dlls.updatable).toBe(true)
    let end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'dlls-update' })
    expect(await end).toMatchObject({ state: 'done', message: 'Portal 2: DLSS 3.5.10 → 310.9.16' })
    expect(readFileSync(join(t.installDir, 'libxess.dll'))).toEqual(makePe('1.3.0.0'))
    expect(readFileSync(join(t.installDir, 'nvngx_dlss.dll'))).toEqual(makePe('310.9.16.0'))
    // Nothing left to update: OptiScaler's XeSS file is not offered.
    expect((await t.service.upgradeStatus(t.game.id)).dlls.updatable).toBe(false)

    end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'optiscaler-remove' })
    expect(await end).toMatchObject({ state: 'done', message: 'Portal 2: OptiScaler removed' })
    end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'dlls-restore' })
    expect(await end).toMatchObject({ state: 'done' })
    expect(snapshot(t.installDir)).toEqual(original)
  })

  it('leaves out the files OptiScaler lists, by either slash and any letter case', () => {
    const found = [{ relPath: 'Bin\\LIBXESS.dll' }, { relPath: 'Bin\\nvngx_dlss.dll' }]
    expect(notOptiScalers(found, ['bin/libxess.dll'])).toEqual([{ relPath: 'Bin\\nvngx_dlss.dll' }])
    expect(notOptiScalers(found, [])).toEqual(found)
  })
})

describe('signatures', () => {
  it('parses certificate subjects, quoted values included', () => {
    expect(parseSubject('CN=NVIDIA Corporation, O="Big, Inc.", C=US')).toEqual([
      ['CN', 'NVIDIA Corporation'],
      ['O', 'Big, Inc.'],
      ['C', 'US']
    ])
  })

  it('accepts the pinned signers and refuses anything else', () => {
    const nvidia =
      'CN=NVIDIA Corporation, OU=1005bk6, O=NVIDIA Corporation, L=Santa Clara, S=California, C=US'
    expect(signatureMatches({ status: 'Valid', subject: nvidia }, 'NVIDIA Corporation')).toBe(true)
    expect(signatureMatches({ status: 'NotSigned', subject: nvidia }, 'NVIDIA Corporation')).toBe(
      false
    )
    expect(signatureMatches({ status: 'Valid', subject: nvidia }, 'Intel Corporation')).toBe(false)
    expect(
      signatureMatches(
        { status: 'Valid', subject: 'CN=Advanced Micro Devices, O=Advanced Micro Devices, C=US' },
        'Advanced Micro Devices, Inc.'
      )
    ).toBe(true)
    const whcp =
      'CN=Microsoft Windows Hardware Compatibility Publisher, O=Microsoft Corporation, C=US'
    const signer = 'Microsoft Windows Hardware Compatibility Publisher'
    expect(
      signatureMatches(
        { status: 'Valid', subject: whcp, company: 'Intel Corporation' },
        signer,
        'Intel Corporation'
      )
    ).toBe(true)
    expect(
      signatureMatches(
        { status: 'Valid', subject: whcp, company: 'Someone' },
        signer,
        'Intel Corporation'
      )
    ).toBe(false)
    expect(signatureMatches(null, 'NVIDIA Corporation')).toBe(false)
  })

  it('passes the path single-quoted with its quotes doubled', () => {
    const script = signatureScript("C:\\Games\\Tom's Game\\x.dll")
    expect(script).toContain("-LiteralPath 'C:\\Games\\Tom''s Game\\x.dll'")
  })
})

describe('formatting', () => {
  it('writes sizes and versions as the player reads them', () => {
    expect(formatSize(41.2 * GB)).toBe('41.2 GB')
    expect(formatSize(300 * 1024 ** 2)).toBe('300 MB')
    expect(displayVersion('dlss', '310.9.16.0')).toBe('310.9.16')
    expect(displayVersion('xess', '2.0.2.68')).toBe('2.0.2.68')
  })
})

/** The upscaler files scanDlls finds in these tests: one DLSS 3.5 file. */
const dlssFound: UpgradeModules['scanDlls'] = async (dir) => [
  {
    kind: 'dlss',
    relPath: 'nvngx_dlss.dll',
    version: '3.5.10.0',
    swapped: false,
    path: join(dir, 'nvngx_dlss.dll')
  }
]

const XESS_2: VendorDll = {
  ...DLSS_310,
  kind: 'xess',
  version: '2.0.2.68',
  fileName: 'libxess.dll',
  signer: 'Intel Corporation'
}

describe('newest vendor versions', () => {
  it('asks again soon when a vendor could not be reached, instead of keeping the partial answer for 12 hours', async () => {
    let clock = Date.parse('2026-11-19T10:00:00Z')
    let nvidiaDown = true
    const latestVendorDlls = vi.fn<UpgradeModules['latestVendorDlls']>(async (d) => {
      if (!nvidiaDown) return { dlss: DLSS_310, xess: XESS_2 }
      d.onVendorFailed?.('NVIDIA', new Error('rate limited'))
      return { xess: XESS_2 }
    })
    const t = setup({
      modules: { scanDlls: dlssFound, latestVendorDlls },
      deps: { now: () => clock }
    })
    expect((await t.service.upgradeStatus(t.game.id)).dlls.latest).toEqual({ dlss: null })
    clock += 60_000
    await t.service.upgradeStatus(t.game.id)
    expect(latestVendorDlls).toHaveBeenCalledTimes(1)
    // Some minutes later NVIDIA is asked again (a complete answer would be kept for 12 hours).
    nvidiaDown = false
    clock += 10 * 60_000
    await vi.waitFor(async () =>
      expect((await t.service.upgradeStatus(t.game.id)).dlls.latest).toEqual({
        dlss: '310.9.16.0'
      })
    )
    expect(latestVendorDlls).toHaveBeenCalledTimes(2)
    // The complete answer is kept.
    clock += 60 * 60_000
    await t.service.upgradeStatus(t.game.id)
    expect(latestVendorDlls).toHaveBeenCalledTimes(2)
  })

  it("keeps a vendor's last files when only that vendor fails the next time", async () => {
    let clock = Date.parse('2026-11-19T10:00:00Z')
    let nvidiaDown = false
    const latestVendorDlls = vi.fn<UpgradeModules['latestVendorDlls']>(async (d) => {
      if (!nvidiaDown) return { dlss: DLSS_310, xess: XESS_2 }
      d.onVendorFailed?.('NVIDIA', new Error('rate limited'))
      return { xess: XESS_2 }
    })
    const t = setup({
      modules: { scanDlls: dlssFound, latestVendorDlls },
      deps: { now: () => clock }
    })
    expect((await t.service.upgradeStatus(t.game.id)).dlls.latest).toEqual({ dlss: '310.9.16.0' })
    nvidiaDown = true
    clock += 13 * 60 * 60_000
    await t.service.upgradeStatus(t.game.id)
    await vi.waitFor(() => expect(latestVendorDlls).toHaveBeenCalledTimes(2))
    expect((await t.service.upgradeStatus(t.game.id)).dlls.latest).toEqual({ dlss: '310.9.16.0' })
  })
})

describe('the DLL row summary', () => {
  it("sums up each kind with display versions; only the game's own files count as updatable", () => {
    const found: FoundUpscalerDll[] = [
      { kind: 'dlss', relPath: 'a\\nvngx_dlss.dll', version: '3.5.10.0', swapped: false },
      { kind: 'dlss', relPath: 'b\\nvngx_dlss.dll', version: '310.9.16.0', swapped: true },
      {
        kind: 'fsr-dx12',
        relPath: 'amd_fidelityfx_dx12.dll',
        version: '1.0.1.37507',
        swapped: false
      },
      { kind: 'xess', relPath: 'opti\\libxess.dll', version: '1.3.0.28', swapped: false },
      { kind: 'xell', relPath: 'libxell.dll', version: null, swapped: false }
    ]
    const own = found.filter((f) => !f.relPath.startsWith('opti'))
    const fsr: VendorDll = { ...DLSS_310, kind: 'fsr-dx12', version: '1.0.1.41314' }
    expect(dllKindSummaries(found, own, { dlss: DLSS_310, 'fsr-dx12': fsr, xess: XESS_2 })).toEqual(
      [
        { kind: 'dlss', version: '3.5.10', latest: '310.9.16', updatable: true },
        { kind: 'fsr-dx12', version: '3.1.1', latest: '3.1.4', updatable: true },
        // OptiScaler's file: never updated by the DLL update.
        { kind: 'xess', version: '1.3.0.28', latest: '2.0.2.68', updatable: false },
        { kind: 'xell', version: null, latest: null, updatable: false }
      ]
    )
  })
})

describe('measures and compression', () => {
  it('never keeps a measure that started before a compression, even when the compression throws', async () => {
    const uncompressed = {
      size: 60 * GB,
      onDisk: 60 * GB,
      compressedFiles: 0,
      eligible: 10,
      eligibleCompressed: 0,
      changed: null
    }
    const half = { ...uncompressed, onDisk: 45 * GB, compressedFiles: 5, eligibleCompressed: 5 }
    let release: (v: unknown) => void = () => undefined
    let answer: () => unknown = () => new Promise((r) => (release = r))
    let fail: (err: Error) => void = () => undefined
    const compressFolder = vi.fn<UpgradeModules['compressFolder']>(
      () => new Promise((_r, reject) => (fail = reject))
    )
    const t = setup({
      measure: () => answer(),
      modules: { compressFolder },
      deps: { measureWaitMs: 10 }
    })
    // A slow measure starts with the menu, then the player compresses.
    await t.service.upgradeStatus(t.game.id)
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'compress', algorithm: 'xpress8k' })
    await vi.waitFor(() => expect(compressFolder).toHaveBeenCalled())
    // The old measure ends part way through with the numbers from before, then compact.exe fails.
    answer = () => half
    release(uncompressed)
    fail(new Error('compact.exe could not be started'))
    expect(await end).toMatchObject({ state: 'failed' })
    // The folder is measured again: the stale numbers were not kept.
    await vi.waitFor(async () =>
      expect((await t.service.upgradeStatus(t.game.id)).compress).toMatchObject({
        state: 'partial',
        onDisk: 45 * GB
      })
    )
  })
})

describe('folder walks of the status', () => {
  it('answers within the time limit with anti-cheat unknown, then keeps the walk for next time', async () => {
    let releaseScan: (v: { names: string[]; complete: boolean }) => void = () => undefined
    const scanAntiCheat = vi.fn<UpgradeModules['scanAntiCheat']>(
      () => new Promise((r) => (releaseScan = r))
    )
    const scanDlls = vi.fn<UpgradeModules['scanDlls']>(async () => [])
    const t = setup({ modules: { scanAntiCheat, scanDlls }, deps: { scanWaitMs: 30 } })
    const started = Date.now()
    const first = await t.service.upgradeStatus(t.game.id)
    expect(Date.now() - started).toBeLessThan(2000)
    // Not checked in time: unknown, so the ban warning still shows.
    expect(first.risk.antiCheat).toEqual([antiCheatUnknown()])
    releaseScan({ names: ['BattlEye'], complete: true })
    await vi.waitFor(async () =>
      expect((await t.service.upgradeStatus(t.game.id)).risk.antiCheat).toEqual(['BattlEye'])
    )
    // Kept: the folder was walked once for each part.
    expect(scanAntiCheat).toHaveBeenCalledTimes(1)
    expect(scanDlls).toHaveBeenCalledTimes(1)

    // An action on the game drops what was kept: the next status walks again.
    scanAntiCheat.mockImplementation(async () => ({ names: [], complete: true }))
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'dlls-restore' })
    await end
    // BattlEye was dropped: the folder was walked again after the action.
    expect((await t.service.upgradeStatus(t.game.id)).risk.antiCheat).toEqual([])
    expect(scanAntiCheat.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('progress while an upgrade runs', () => {
  it('sends the last running line held back by the throttle, even when the action then pauses', async () => {
    const compressFolder = vi.fn<UpgradeModules['compressFolder']>(
      (_dir, _alg, progress, signal) => {
        progress({ progress: 0.1, message: 'Compressing 10%' })
        progress({ progress: 0.2, message: 'Compressing 20%' })
        return untilStopped(signal, 'stopped')
      }
    )
    const t = setup({ modules: { compressFolder } })
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'compress', algorithm: 'xpress8k' })
    await vi.waitFor(() =>
      expect(t.progress.at(-1)).toMatchObject({
        state: 'running',
        progress: 0.2,
        message: 'Compressing 20%'
      })
    )
    await t.service.cancelUpgrade(t.game.id)
    await end
  })

  it('tells which upgrade runs for a game (Play, Co-Op and deleting wait for it)', async () => {
    const t = setup({
      modules: {
        compressFolder: (_dir, _alg, _progress, signal) => untilStopped(signal, 'stopped')
      }
    })
    expect(t.service.busyFor(t.game.id)).toBeNull()
    const end = t.nextEnd()
    await t.service.runUpgrade(t.game.id, { kind: 'compress', algorithm: 'xpress8k' })
    expect(t.service.busyFor(t.game.id)).toBe('compress')
    await t.service.cancelUpgrade(t.game.id)
    await end
    expect(t.service.busyFor(t.game.id)).toBeNull()
  })
})
