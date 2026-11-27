import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Game, Ps3UpdateProgress } from '../../shared/types'
import type { Runner } from '../emulator-setup/types'
import { ps3Dev0Dir } from './ps3-hdd'
import { createPs3UpdateService, type Ps3UpdateServiceDeps } from './ps3-update-service'
import { updateListUrl, type FileFetch, type TextGet } from './ps3-updates'

/** A PARAM.SFO with these string entries (format 0x0204, utf8 with a trailing null). */
function sfo(entries: Record<string, string>): Buffer {
  const keys = Object.keys(entries)
  const keyTable = Buffer.from(keys.map((k) => `${k}\0`).join(''), 'latin1')
  const values = keys.map((k) => Buffer.from(`${entries[k]}\0`, 'latin1'))
  const indexSize = 16 * keys.length
  const keyStart = 20 + indexSize
  const dataStart = keyStart + keyTable.length
  const header = Buffer.alloc(20)
  header.writeUInt32BE(0x00505346, 0)
  header.writeUInt32LE(0x0101, 4)
  header.writeUInt32LE(keyStart, 8)
  header.writeUInt32LE(dataStart, 12)
  header.writeUInt32LE(keys.length, 16)
  const index = Buffer.alloc(indexSize)
  let keyOffset = 0
  let dataOffset = 0
  keys.forEach((k, i) => {
    index.writeUInt16LE(keyOffset, i * 16)
    index.writeUInt16LE(0x0204, i * 16 + 2)
    index.writeUInt32LE(values[i].length, i * 16 + 4)
    index.writeUInt32LE(values[i].length, i * 16 + 8)
    index.writeUInt32LE(dataOffset, i * 16 + 12)
    keyOffset += k.length + 1
    dataOffset += values[i].length
  })
  return Buffer.concat([header, index, keyTable, ...values])
}

const SERIAL = 'BLUS30443'
const VERSION = '01.02'

// The package: some bytes and a 32-byte trailer starting with their SHA-1, as a real PKG.
const BODY = Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 7) % 256))
const SHA1 = createHash('sha1').update(BODY).digest('hex')
const TRAILER = Buffer.alloc(32)
Buffer.from(SHA1, 'hex').copy(TRAILER)
const PKG = Buffer.concat([BODY, TRAILER])
const PKG_URL = `http://b0.ww.np.dl.playstation.net/tppkg/np/${SERIAL}/x/UP0001-${SERIAL}_00-PATCH-A0102-V0100-PE.pkg`
const XML = `<?xml version='1.0' encoding='UTF-8'?><titlepatch status="alive" titleid="${SERIAL}"><tag name="${SERIAL}_T2"><package version="${VERSION}" size="${PKG.length}" sha1sum="${SHA1}" url="${PKG_URL}" ps3_system_ver="04.4000"/></tag></titlepatch>`

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

let dir: string
let roms: string
let emu: string
let cache: string
let games: Map<string, Game>
let events: Ps3UpdateProgress[]
let emit: ReturnType<typeof vi.fn>
let get: ReturnType<typeof vi.fn> & TextGet
let fetch: ReturnType<typeof vi.fn> & FileFetch
let run: ReturnType<typeof vi.fn> & Runner
let rpcs3Running: boolean
let rpcs3Exe: string | null
let autoUpdate: boolean
let clock: number
let service: ReturnType<typeof createPs3UpdateService> | null
/** Every service a test made, so afterEach can wait for each one's work before removing the temp folder. */
let services: ReturnType<typeof createPs3UpdateService>[]
/** afterEach is waiting for the services: the ROM folder reads as unset, so a job queued now touches no file. */
let draining: boolean
const DRAIN_ID = 'rom:drain'

async function put(path: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, data)
}

/** A PS3 disc folder game in the ROM folder (PS3_GAME\PARAM.SFO with its serial at 01.00). */
async function ps3Game(id: string, serial: string, title = id): Promise<Game> {
  const romPath = join(roms, 'ps3', id.replace(/[^a-z0-9]+/gi, '_'))
  await put(join(romPath, 'PS3_GAME', 'PARAM.SFO'), sfo({ TITLE_ID: serial, APP_VER: '01.00' }))
  const game = {
    id,
    source: 'rom',
    externalId: `ps3/${id}`,
    platformId: 'ps3',
    title,
    sortTitle: title,
    installed: true,
    romPath,
    launch: { kind: 'emulator', systemId: 'ps3', romPath },
    user: {}
  } as unknown as Game
  games.set(id, game)
  return game
}

function deps(over: Partial<Ps3UpdateServiceDeps> = {}): Ps3UpdateServiceDeps {
  return {
    library: { games: () => [...games.values()], getGame: (id) => games.get(id) },
    romsRoot: () => (draining ? null : roms),
    emulationDir: () => emu,
    rpcs3Exe: async () => rpcs3Exe,
    rpcs3Running: async () => rpcs3Running,
    autoUpdate: () => autoUpdate,
    cacheDir: cache,
    events: { emit } as unknown as Ps3UpdateServiceDeps['events'],
    log,
    run,
    get,
    fetch,
    now: () => clock,
    ...over
  }
}

function make(over: Partial<Ps3UpdateServiceDeps> = {}): ReturnType<typeof createPs3UpdateService> {
  service = createPs3UpdateService(deps(over))
  services.push(service)
  return service
}

/**
 * Resolves once no service is working in the temp folder any more. An automatic pass runs in the background and a
 * test may end while its game is still being updated (the fake RPCS3 writing its PARAM.SFO, the package being
 * deleted): removing the folder under it fails with ENOTEMPTY. dispose() lets no further game start, and the
 * service updates one game at a time, so a menu update queued now runs after whatever is in flight; with the ROM
 * folder unset it returns at once without touching a file.
 */
async function settled(): Promise<void> {
  draining = true
  games.set(DRAIN_ID, {
    id: DRAIN_ID,
    title: 'Drain',
    launch: { kind: 'emulator', systemId: 'ps3' }
  } as unknown as Game)
  for (const s of services)
    expect(await s.updatePs3Game(DRAIN_ID)).toMatchObject({ message: 'No ROM folder is set' })
}

/** The dev_hdd0 the fake RPCS3 installs into (what its vfs.yml names). */
let installDev0: string
const sfoPath = (serial: string): string => join(installDev0, 'game', serial, 'PARAM.SFO')

/** A fake rpcs3.exe whose config\vfs.yml points /dev_hdd0/ at `dev0` (null: no vfs.yml, RPCS3's default). */
async function fakeRpcs3(folder: string, dev0: string | null): Promise<string> {
  const exe = join(dir, folder, 'rpcs3.exe')
  await put(exe, 'MZ')
  if (dev0)
    await put(
      join(dir, folder, 'config', 'vfs.yml'),
      [
        '$(EmulatorDir): ""',
        `/dev_hdd0/: ${dev0.split('\\').join('/')}/`,
        '/dev_hdd1/: $(EmulatorDir)dev_hdd1/',
        ''
      ].join('\n')
    )
  return exe
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-ps3-update-service-'))
  roms = join(dir, 'roms')
  emu = join(dir, 'Emulation')
  cache = join(dir, 'cache')
  games = new Map()
  events = []
  emit = vi.fn((_name: string, p: Ps3UpdateProgress) => void events.push(p))
  get = vi.fn(async (url: string) =>
    url === updateListUrl(SERIAL) ? { status: 200, body: XML } : { status: 404, body: '' }
  ) as unknown as ReturnType<typeof vi.fn> & TextGet
  fetch = vi.fn(async () => {
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.close()
        else {
          sent = true
          controller.enqueue(new Uint8Array(PKG))
        }
      }
    })
    return new Response(body, { status: 200 })
  }) as unknown as ReturnType<typeof vi.fn> & FileFetch
  // RPCS3 installing the package: its PARAM.SFO lands in dev_hdd0\game\<serial> with the package's version.
  run = vi.fn(async (_exe: string, args: string[]) => {
    const version = basename(args[2]!).split('-')[0]!
    await put(sfoPath(SERIAL), sfo({ TITLE_ID: SERIAL, APP_VER: version }))
    return { code: 0, stdout: '', stderr: '' }
  }) as unknown as ReturnType<typeof vi.fn> & Runner
  rpcs3Running = false
  installDev0 = ps3Dev0Dir(emu)
  rpcs3Exe = await fakeRpcs3('RPCS3', installDev0)
  autoUpdate = true
  clock = 1_000_000_000_000
  service = null
  services = []
  draining = false
})

afterEach(async () => {
  for (const s of services) s.dispose()
  await settled()
  // Retries: on Windows a file just closed (or held a moment by a scanner) can still make rmdir fail.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('createPs3UpdateService: Update PS3 game', () => {
  it('downloads, installs through RPCS3 and deletes the package', async () => {
    await ps3Game('rom:tlou', SERIAL, 'The Game')
    const result = await make().updatePs3Game('rom:tlou')
    expect(result).toMatchObject({ outcome: 'installed', version: VERSION })
    expect(result.message).toContain(VERSION)
    expect(get).toHaveBeenCalledWith(updateListUrl(SERIAL), expect.anything())
    expect(fetch).toHaveBeenCalledWith(PKG_URL, expect.anything())
    expect(run).toHaveBeenCalledTimes(1)
    const [exe, args] = run.mock.calls[0]!
    expect(exe).toBe(rpcs3Exe)
    expect(args.slice(0, 2)).toEqual(['--headless', '--installpkg'])
    expect(args[2]).toBe(join(cache, `${VERSION}-${SHA1}.pkg`))
    // The package is gone once installed.
    expect(await fs.readdir(cache)).toEqual([])
  })

  it('says up to date the second time', async () => {
    await ps3Game('rom:tlou', SERIAL)
    const s = make()
    await s.updatePs3Game('rom:tlou')
    expect(await s.updatePs3Game('rom:tlou')).toMatchObject({
      outcome: 'up-to-date',
      version: VERSION
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('says when Sony lists no updates', async () => {
    await ps3Game('rom:x', 'BLES00001')
    expect(await make().updatePs3Game('rom:x')).toMatchObject({
      outcome: 'no-updates',
      version: null
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('reports its progress as manual', async () => {
    await ps3Game('rom:tlou', SERIAL, 'The Game')
    await make().updatePs3Game('rom:tlou')
    expect(emit).toHaveBeenCalledWith('ps3-update:progress', expect.anything())
    expect(events.map((e) => e.phase)).toEqual(['checking', 'downloading', 'installing', 'done'])
    expect(events.every((e) => e.manual && e.gameId === 'rom:tlou' && e.title === 'The Game')).toBe(
      true
    )
    expect(events[1]).toMatchObject({ bytes: PKG.length, total: PKG.length, version: VERSION })
    expect(events[3]).toMatchObject({ version: VERSION })
  })

  it('refuses while RPCS3 is running, without running anything', async () => {
    await ps3Game('rom:tlou', SERIAL)
    rpcs3Running = true
    const result = await make().updatePs3Game('rom:tlou')
    expect(result.outcome).toBe('failed')
    expect(result.message).toMatch(/RPCS3/)
    expect(run).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({ phase: 'failed', manual: true })
  })

  it('fails without RPCS3', async () => {
    await ps3Game('rom:tlou', SERIAL)
    rpcs3Exe = null
    const result = await make().updatePs3Game('rom:tlou')
    expect(result).toMatchObject({ outcome: 'failed' })
    expect(result.message).toMatch(/RPCS3 is not installed/)
    expect(run).not.toHaveBeenCalled()
  })

  it('fails when RPCS3 does not install the package', async () => {
    await ps3Game('rom:tlou', SERIAL)
    run.mockImplementation(async () => ({ code: 1, stdout: '', stderr: 'bad pkg\n' }))
    const result = await make().updatePs3Game('rom:tlou')
    expect(result).toMatchObject({ outcome: 'failed', version: '01.00' })
    expect(result.message).toMatch(/did not install/)
    expect(result.message).toMatch(/exit 1: bad pkg/)
  })

  it("fails when Sony's server cannot be reached", async () => {
    await ps3Game('rom:tlou', SERIAL)
    get.mockImplementation(async () => {
      throw new Error('ECONNRESET')
    })
    const result = await make().updatePs3Game('rom:tlou')
    expect(result.outcome).toBe('failed')
    expect(result.message).toMatch(/could not be reached.*ECONNRESET/)
    // A server error answer fails too.
    get.mockImplementation(async () => ({ status: 503, body: 'busy' }))
    expect((await service!.updatePs3Game('rom:tlou')).message).toMatch(/503/)
  })

  it('fails for a game that is not a PS3 game on this PC', async () => {
    const s = make()
    expect(await s.updatePs3Game('missing')).toMatchObject({ outcome: 'failed' })
    const g = await ps3Game('rom:psx', SERIAL)
    games.set('rom:psx', {
      ...g,
      launch: { kind: 'emulator', systemId: 'psx', romPath: g.romPath! }
    } as Game)
    expect(await s.updatePs3Game('rom:psx')).toMatchObject({
      outcome: 'failed',
      message: 'That is not a PS3 game on this PC'
    })
    games.set('rom:remote', { ...g, id: 'rom:remote', remote: {} } as unknown as Game)
    expect((await s.updatePs3Game('rom:remote')).outcome).toBe('failed')
    expect(get).not.toHaveBeenCalled()
  })

  it('fails for a PS3 game without a serial', async () => {
    const romPath = join(roms, 'ps3', 'NoSerial.iso')
    await put(romPath, 'not a disc image')
    games.set('rom:n', {
      id: 'rom:n',
      source: 'rom',
      title: 'No Serial',
      installed: true,
      romPath,
      launch: { kind: 'emulator', systemId: 'ps3', romPath }
    } as unknown as Game)
    const result = await make().updatePs3Game('rom:n')
    expect(result).toMatchObject({ outcome: 'failed' })
    expect(result.message).toMatch(/No PS3 serial/)
  })
})

describe('createPs3UpdateService: automatic updates', () => {
  it('does nothing when automatic updates are off', async () => {
    await ps3Game('rom:tlou', SERIAL)
    autoUpdate = false
    make({ startDelayMs: 1 }).start()
    await new Promise((r) => setTimeout(r, 60))
    expect(get).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('does nothing while the PC is offline', async () => {
    await ps3Game('rom:tlou', SERIAL)
    make({ startDelayMs: 1, isOnline: () => false }).start()
    await new Promise((r) => setTimeout(r, 60))
    expect(get).not.toHaveBeenCalled()
  })

  it('installs after start, reporting as automatic', async () => {
    await ps3Game('rom:tlou', SERIAL)
    make({ startDelayMs: 1 }).start()
    await vi.waitFor(() => expect(events.at(-1)?.phase).toBe('done'), { timeout: 5000 })
    expect(run).toHaveBeenCalledTimes(1)
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.manual === false)).toBe(true)
    // The automatic pass does not report checking.
    expect(events.map((e) => e.phase)).not.toContain('checking')
  })

  it('kick checks only the PS3 games added since', async () => {
    await ps3Game('rom:tlou', SERIAL)
    const s = make({ startDelayMs: 1, kickDebounceMs: 1 })
    s.start()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1), { timeout: 5000 })
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1))
    // The first pass has finished (a kick before that runs a full pass, by design).
    await vi.waitFor(() => expect(events.some((e) => e.phase === 'done')).toBe(true), {
      timeout: 5000
    })
    await new Promise((r) => setTimeout(r, 30))
    // A day later, so the first game would be asked for again by a full pass.
    clock += 2 * 24 * 60 * 60 * 1000
    await ps3Game('rom:new', 'BLES00002')
    s.kick()
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2), { timeout: 5000 })
    await new Promise((r) => setTimeout(r, 50))
    expect(get).toHaveBeenCalledTimes(2)
    expect(get.mock.calls[1]![0]).toBe(updateListUrl('BLES00002'))
  })

  it('kick does nothing when no PS3 game was added', async () => {
    await ps3Game('rom:tlou', SERIAL)
    const s = make({ startDelayMs: 1, kickDebounceMs: 1 })
    s.start()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1), { timeout: 5000 })
    // The first pass has finished (a kick before that runs a full pass, by design).
    await vi.waitFor(() => expect(events.some((e) => e.phase === 'done')).toBe(true), {
      timeout: 5000
    })
    await new Promise((r) => setTimeout(r, 30))
    clock += 2 * 24 * 60 * 60 * 1000
    s.kick()
    await new Promise((r) => setTimeout(r, 60))
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('waits while RPCS3 is running, as automatic', async () => {
    await ps3Game('rom:tlou', SERIAL)
    rpcs3Running = true
    make({ startDelayMs: 1 }).start()
    await vi.waitFor(() => expect(events.at(-1)?.phase).toBe('waiting'), { timeout: 5000 })
    expect(events.at(-1)).toMatchObject({ manual: false, message: expect.stringMatching(/RPCS3/) })
    expect(run).not.toHaveBeenCalled()
  })

  it('dispose stops the timers', async () => {
    await ps3Game('rom:tlou', SERIAL)
    const s = make({ startDelayMs: 20, kickDebounceMs: 20 })
    s.start()
    s.kick()
    s.dispose()
    await new Promise((r) => setTimeout(r, 100))
    expect(get).not.toHaveBeenCalled()
    // Starting or kicking after dispose does nothing either.
    s.start()
    s.kick()
    await new Promise((r) => setTimeout(r, 60))
    expect(get).not.toHaveBeenCalled()
  })

  it('dispose stops the periodic pass', async () => {
    await ps3Game('rom:tlou', SERIAL)
    autoUpdate = false
    const auto = vi.fn(() => autoUpdate)
    const s = make({ startDelayMs: 1, everyMs: 10, autoUpdate: auto })
    s.start()
    await vi.waitFor(() => expect(auto.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 5000
    })
    s.dispose()
    // A pass that was already running may still ask once more; then nothing.
    await new Promise((r) => setTimeout(r, 20))
    const calls = auto.mock.calls.length
    await new Promise((r) => setTimeout(r, 80))
    expect(auto.mock.calls.length).toBe(calls)
  })

  it('does nothing while a game is running, but the menu still updates', async () => {
    await ps3Game('rom:tlou', SERIAL)
    const s = make({ startDelayMs: 1, gameRunning: () => true })
    s.start()
    await new Promise((r) => setTimeout(r, 60))
    expect(get).not.toHaveBeenCalled()
    expect(await s.updatePs3Game('rom:tlou')).toMatchObject({
      outcome: 'installed',
      version: VERSION
    })
  })

  it('kick does nothing before the first pass', async () => {
    await ps3Game('rom:tlou', SERIAL)
    const s = make({ startDelayMs: 60_000, kickDebounceMs: 1 })
    s.start()
    s.kick()
    await new Promise((r) => setTimeout(r, 60))
    expect(get).not.toHaveBeenCalled()
    // Without start() at all, too.
    make({ kickDebounceMs: 1 }).kick()
    await new Promise((r) => setTimeout(r, 30))
    expect(get).not.toHaveBeenCalled()
  })

  it('kick runs a full pass when the first pass found automatic updates off', async () => {
    await ps3Game('rom:tlou', SERIAL)
    autoUpdate = false
    const auto = vi.fn(() => autoUpdate)
    const s = make({ startDelayMs: 1, kickDebounceMs: 1, autoUpdate: auto })
    s.start()
    await vi.waitFor(() => expect(auto).toHaveBeenCalled(), { timeout: 5000 })
    expect(get).not.toHaveBeenCalled()
    // Turned on later: the next library change checks every PS3 game, not only new ones.
    autoUpdate = true
    s.kick()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1), { timeout: 5000 })
    expect(get).toHaveBeenCalledWith(updateListUrl(SERIAL), expect.anything())
  })

  it('kick runs a full pass when the first pass found a game running', async () => {
    await ps3Game('rom:tlou', SERIAL)
    let playing = true
    const s = make({ startDelayMs: 1, kickDebounceMs: 1, gameRunning: () => playing })
    s.start()
    await new Promise((r) => setTimeout(r, 40))
    expect(get).not.toHaveBeenCalled()
    playing = false
    s.kick()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1), { timeout: 5000 })
  })

  it('dispose cancels a pending kick', async () => {
    await ps3Game('rom:tlou', SERIAL)
    autoUpdate = false
    const auto = vi.fn(() => autoUpdate)
    const s = make({ startDelayMs: 1, kickDebounceMs: 30, autoUpdate: auto })
    s.start()
    await vi.waitFor(() => expect(auto).toHaveBeenCalled(), { timeout: 5000 })
    autoUpdate = true
    s.kick()
    s.dispose()
    await new Promise((r) => setTimeout(r, 100))
    expect(get).not.toHaveBeenCalled()
  })
})

describe("createPs3UpdateService: the RPCS3 in use's dev_hdd0", () => {
  it("reads the installed version in the exe's vfs.yml dev_hdd0, not PlayOut's own", async () => {
    await ps3Game('rom:tlou', SERIAL)
    // The update is in PlayOut's PS3 HDD, but this RPCS3 (no vfs.yml) uses the dev_hdd0 next to it.
    await put(
      join(ps3Dev0Dir(emu), 'game', SERIAL, 'PARAM.SFO'),
      sfo({ TITLE_ID: SERIAL, APP_VER: VERSION })
    )
    rpcs3Exe = await fakeRpcs3('OtherRPCS3', null)
    installDev0 = join(dir, 'OtherRPCS3', 'dev_hdd0')
    const s = make()
    expect(await s.updatePs3Game('rom:tlou')).toMatchObject({
      outcome: 'installed',
      version: VERSION
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0]).toBe(rpcs3Exe)
    // Now in the RPCS3's own dev_hdd0: up to date.
    expect((await s.updatePs3Game('rom:tlou')).outcome).toBe('up-to-date')
  })

  it("is up to date when the exe's dev_hdd0 already holds the update", async () => {
    await ps3Game('rom:tlou', SERIAL)
    const custom = join(dir, 'Custom HDD')
    rpcs3Exe = await fakeRpcs3('CustomRPCS3', custom)
    await put(
      join(custom, 'game', SERIAL, 'PARAM.SFO'),
      sfo({ TITLE_ID: SERIAL, APP_VER: VERSION })
    )
    expect(await make().updatePs3Game('rom:tlou')).toMatchObject({
      outcome: 'up-to-date',
      version: VERSION
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })
})
