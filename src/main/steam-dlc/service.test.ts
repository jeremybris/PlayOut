import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join as hostJoin } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Game } from '../../shared/types'
import { EventBus } from '../events'
import type { CommandResult } from '../home-button/io'
import { readAcfDlc } from './acf'
import {
  createSteamDlcService,
  dlcListFailedMessage,
  gameRunningMessage,
  runningCheckFailedMessage,
  steamDownloadingMessage,
  type SteamDlcDeps,
  type SteamDlcIo
} from './service'

const ROOT = 'C:\\Steam'
const LIB = 'D:\\SteamLibrary'
const ACF_PATH = `${LIB}\\steamapps\\appmanifest_251470.acf`
const OTHER_ACF = `${ROOT}\\steamapps\\appmanifest_10.acf`

function acf(opts: { user?: string; mounted?: string; flags?: number } = {}): string {
  return [
    '"AppState"',
    '{',
    '\t"appid"\t\t"251470"',
    `\t"StateFlags"\t\t"${opts.flags ?? 4}"`,
    '\t"InstalledDepots"',
    '\t{',
    '\t\t"337841"',
    '\t\t{',
    '\t\t\t"manifest"\t\t"456"',
    '\t\t\t"dlcappid"\t\t"337840"',
    '\t\t}',
    '\t}',
    '\t"UserConfig"',
    '\t{',
    ...(opts.user !== undefined ? [`\t\t"DisabledDLC"\t\t"${opts.user}"`] : []),
    '\t\t"language"\t\t"english"',
    '\t}',
    '\t"MountedConfig"',
    '\t{',
    ...(opts.mounted !== undefined ? [`\t\t"DisabledDLC"\t\t"${opts.mounted}"`] : []),
    '\t\t"language"\t\t"english"',
    '\t}',
    '}',
    ''
  ].join('\n')
}

function game(over: Partial<Game> = {}): Game {
  return {
    id: 'steam:251470',
    source: 'steam',
    externalId: '251470',
    platformId: 'pc',
    title: 'TowerFall Ascension',
    sortTitle: 'towerfall ascension',
    installed: true,
    installDir: `${LIB}\\steamapps\\common\\TowerFall`,
    launch: { kind: 'uri', uri: 'steam://rungameid/251470' },
    tracking: { mode: 'installDir', installDir: `${LIB}\\steamapps\\common\\TowerFall` },
    hidden: false,
    favorite: false,
    ...over
  } as Game
}

interface FakeSteam {
  io: SteamDlcIo
  files: Map<string, string>
  spawned: string[][]
  state: { running: boolean; closesAfterPolls: number; runningAppId: number; polls: number }
}

function fakeSteam(): FakeSteam {
  const files = new Map<string, string>()
  const spawned: string[][] = []
  const state = { running: true, closesAfterPolls: 2, runningAppId: 0, polls: 0 }
  let closing = false
  const run = async (file: string, args: string[]): Promise<CommandResult> => {
    if (file === 'tasklist.exe') {
      if (closing) {
        state.polls++
        if (state.polls >= state.closesAfterPolls) {
          closing = false
          state.running = false
        }
      }
      return {
        code: 0,
        stdout: `"System","4"\r\n${state.running ? '"steam.exe","1234"\r\n' : ''}`,
        stderr: ''
      }
    }
    if (file === 'reg.exe' && args[0] === 'query') {
      return {
        code: 0,
        stdout: `\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    RunningAppID    REG_DWORD    0x${state.runningAppId.toString(16)}\r\n`,
        stderr: ''
      }
    }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }
  const io: SteamDlcIo = {
    run,
    async readFile(path) {
      const t = files.get(path)
      return t === undefined ? null : Buffer.from(t, 'utf8')
    },
    async writeFile(path, data) {
      files.set(path, data.toString())
    },
    async rename(from, to) {
      const t = files.get(from)
      if (t === undefined) throw new Error('ENOENT')
      files.delete(from)
      files.set(to, t)
    },
    async copyFile(from, to) {
      const t = files.get(from)
      if (t === undefined) throw new Error('ENOENT')
      files.set(to, t)
    },
    mkdir: () => Promise.resolve(),
    async exists(path) {
      return files.has(path)
    },
    spawnDetached(file, args) {
      spawned.push([file, ...args])
      if (args[0] === '-shutdown') {
        closing = true
        state.polls = 0
      }
      if (args[0] === '-silent') state.running = true
    },
    sleep: () => Promise.resolve(),
    env: {},
    async listDir(dir) {
      const prefix = `${dir}\\`
      return [...files.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('\\'))
        .map((k) => k.slice(prefix.length))
    }
  }
  return { io, files, spawned, state }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(hostJoin(tmpdir(), 'playout-steam-dlc-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const silentLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function setupAll(over: Partial<SteamDlcDeps> & { games?: Game[] } = {}): FakeSteam & {
  service: ReturnType<typeof createSteamDlcService>
  events: EventBus
  applied: unknown[]
  games: Map<string, Game>
  opened: string[]
} {
  const steam = fakeSteam()
  steam.files.set(ACF_PATH, acf({ mounted: undefined }))
  steam.files.set(OTHER_ACF, '"AppState"\n{\n\t"appid"\t\t"10"\n\t"StateFlags"\t\t"4"\n}\n')
  const events = new EventBus()
  const applied: unknown[] = []
  events.on('steam-dlc:applied', (p) => applied.push(p))
  const games = new Map((over.games ?? [game()]).map((g) => [g.id, g]))
  const opened: string[] = []
  const service = createSteamDlcService({
    library: { getGame: (id) => games.get(id) },
    events,
    log: silentLog,
    plansFile: hostJoin(dir, 'steam-dlc-plans.json'),
    gameRunning: () => false,
    openExternal: async (uri) => {
      opened.push(uri)
    },
    io: steam.io,
    steamPaths: async () => ({ root: ROOT, libraries: [ROOT, LIB] }),
    appDlc: async () => [
      { appId: 337840, sizeBytes: 200, steamOnly: false },
      { appId: 337850, sizeBytes: null, steamOnly: false },
      { appId: 337860, sizeBytes: 10, steamOnly: false },
      { appId: 337870, sizeBytes: 5, steamOnly: true }
    ],
    names: async () =>
      new Map([
        [337840, 'Dark World'],
        [337850, 'Bonus Pack'],
        [337870, 'Workshop Tools']
      ]),
    ownedApps: async () => new Set([251470, 337850, 337870]),
    retryMs: 60_000,
    startDelayMs: 1,
    changeDelayMs: 1,
    ...over
  })
  return { ...steam, service, events, applied, games, opened }
}

const setup = setupAll

/** reg.exe query fails with an error code (not 0 "found", not 1 "missing"). */
function failRegQuery(t: FakeSteam): void {
  const run = t.io.run
  t.io.run = async (file, args) =>
    file === 'reg.exe' && args[0] === 'query'
      ? { code: 5, stdout: '', stderr: 'ERROR: Access is denied.' }
      : run(file, args)
}

/** A plan saved before the service loads it (as one left by an earlier PlayOut run). */
function writePlan(plan: { disabled: number[]; createdAt?: string; installedAt?: string }): void {
  writeFileSync(
    hostJoin(dir, 'steam-dlc-plans.json'),
    JSON.stringify({
      version: 1,
      plans: {
        'steam:251470': {
          appId: 251470,
          createdAt: plan.createdAt ?? new Date().toISOString(),
          ...plan
        }
      }
    })
  )
}

describe('steamDlc', () => {
  it('lists owned DLC by name with Steam state, and counts the ones not owned', async () => {
    const t = setup()
    t.files.set(ACF_PATH, acf({ user: '337840', mounted: '' }))
    const info = await t.service.steamDlc('steam:251470')
    expect(info).toEqual({
      gameId: 'steam:251470',
      appId: 251470,
      installed: true,
      dlc: [
        {
          appId: 337850,
          name: 'Bonus Pack',
          sizeBytes: null,
          owned: true,
          enabled: true,
          installed: false,
          pending: false,
          steamOnly: false
        },
        {
          // Installed content counts as owned.
          appId: 337840,
          name: 'Dark World',
          sizeBytes: 200,
          owned: true,
          enabled: false,
          installed: true,
          pending: true,
          steamOnly: false
        },
        {
          appId: 337870,
          name: 'Workshop Tools',
          sizeBytes: 5,
          owned: true,
          enabled: true,
          installed: false,
          pending: false,
          steamOnly: true
        }
      ],
      notOwnedCount: 1,
      steamRunning: true,
      blocked: null,
      plannedDisabled: null
    })
  })

  it('leaves ownership unknown without a Steam sign-in, with a fallback name', async () => {
    const t = setup({ ownedApps: async () => null, names: async () => new Map() })
    const info = await t.service.steamDlc('steam:251470')
    expect(info.notOwnedCount).toBe(0)
    expect(info.dlc.map((d) => [d.name, d.owned])).toEqual([
      ['DLC 337840', true],
      ['DLC 337850', null],
      ['DLC 337860', null],
      ['DLC 337870', null]
    ])
  })

  it('shows a not installed game with everything on', async () => {
    const t = setup({ games: [game({ installed: false, installDir: undefined })] })
    t.files.delete(ACF_PATH)
    const info = await t.service.steamDlc('steam:251470')
    expect(info.installed).toBe(false)
    expect(info.dlc.every((d) => d.enabled && !d.installed && !d.pending)).toBe(true)
  })

  it('reports the DLC list error and still lists the DLC the manifest names', async () => {
    const t = setup({
      appDlc: async () => {
        throw new Error('offline')
      }
    })
    const info = await t.service.steamDlc('steam:251470')
    expect(info.error).toMatch(/could not be read/)
    expect(info.dlc.map((d) => d.appId)).toEqual([337840])
  })

  it('says why a change cannot be made now', async () => {
    const t = setup()
    t.state.runningAppId = 620
    expect((await t.service.steamDlc('steam:251470')).blocked).toBe(gameRunningMessage())
    t.state.runningAppId = 0
    t.files.set(OTHER_ACF, '"AppState"\n{\n\t"StateFlags"\t\t"1030"\n}\n')
    expect((await t.service.steamDlc('steam:251470')).blocked).toBe(steamDownloadingMessage())
  })

  it('refuses a game that is not from Steam', async () => {
    const t = setup({ games: [game({ id: 'epic:x', source: 'epic', externalId: 'x' })] })
    await expect(t.service.steamDlc('epic:x')).rejects.toThrow(/not a Steam game/)
    await expect(t.service.steamDlc('steam:1')).rejects.toThrow(/not in the library/)
  })
})

describe('setSteamDlc on an installed game', () => {
  it('closes Steam, backs up the manifest, changes only UserConfig and starts Steam again', async () => {
    const t = setup()
    const before = acf({ mounted: '' })
    t.files.set(ACF_PATH, before)
    const result = await t.service.setSteamDlc('steam:251470', [337840])
    expect(result).toEqual({ ok: true, restartedSteam: true })
    expect(t.spawned).toEqual([
      [`${ROOT}\\steam.exe`, '-shutdown'],
      [`${ROOT}\\steam.exe`, '-silent']
    ])
    expect(t.files.get(`${ACF_PATH}.playout-bak`)).toBe(before)
    const after = t.files.get(ACF_PATH) ?? ''
    expect(after).toBe(
      before.replace(
        '\t"UserConfig"\n\t{\n',
        '\t"UserConfig"\n\t{\n\t\t"DisabledDLC"\t\t"337840"\n'
      )
    )
    expect(readAcfDlc(after)).toMatchObject({ userDisabled: [337840], mountedDisabled: [] })
    expect(t.files.has(`${ACF_PATH}.playout-tmp`)).toBe(false)
  })

  it('does not restart a Steam that was not running, but starts it to apply the change', async () => {
    const t = setup()
    t.state.running = false
    t.files.set(ACF_PATH, acf({ user: '337840' }))
    const result = await t.service.setSteamDlc('steam:251470', [])
    expect(result).toEqual({ ok: true, restartedSteam: false })
    expect(t.spawned).toEqual([[`${ROOT}\\steam.exe`, '-silent']])
    expect(readAcfDlc(t.files.get(ACF_PATH) ?? '').userDisabled).toEqual([])
  })

  it('changes nothing when Steam does not close in time', async () => {
    const t = setup({ shutdownTimeoutMs: 3000, pollMs: 1000 })
    t.state.closesAfterPolls = 1000
    const before = t.files.get(ACF_PATH)
    const result = await t.service.setSteamDlc('steam:251470', [337840])
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Steam did not close/)
    expect(t.files.get(ACF_PATH)).toBe(before)
    expect(t.files.has(`${ACF_PATH}.playout-bak`)).toBe(false)
    expect(t.spawned).toEqual([[`${ROOT}\\steam.exe`, '-shutdown']])
    await t.service.dispose()
  })

  it('refuses while a game runs or Steam downloads, without touching Steam', async () => {
    let playing = true
    const t = setup({ gameRunning: () => playing })
    expect(await t.service.setSteamDlc('steam:251470', [337840])).toEqual({
      ok: false,
      error: gameRunningMessage()
    })
    playing = false
    t.files.set(OTHER_ACF, '"AppState"\n{\n\t"StateFlags"\t\t"1030"\n}\n')
    expect(await t.service.setSteamDlc('steam:251470', [337840])).toEqual({
      ok: false,
      error: steamDownloadingMessage()
    })
    expect(t.spawned).toEqual([])
  })

  it('refuses ids that are not DLC of the game', async () => {
    const t = setup()
    const result = await t.service.setSteamDlc('steam:251470', [337840, 999])
    expect(result).toEqual({ ok: false, error: 'Not a DLC of TowerFall Ascension: 999' })
    expect(t.spawned).toEqual([])
  })

  it('keeps Steam-only DLC as Steam has them', async () => {
    const t = setup()
    t.files.set(ACF_PATH, acf({ user: '337870' }))
    await t.service.setSteamDlc('steam:251470', [337840])
    expect(readAcfDlc(t.files.get(ACF_PATH) ?? '').userDisabled).toEqual([337840, 337870])
  })

  it('keeps DLC hidden as not owned and Steam-only DLC off when the request leaves them out', async () => {
    const t = setup()
    // 337860 is not owned and not installed (hidden), 337870 is Steam-only: neither can be switched.
    t.files.set(ACF_PATH, acf({ user: '337860,337870', mounted: '337860,337870' }))
    expect((await t.service.setSteamDlc('steam:251470', [337840])).ok).toBe(true)
    expect(readAcfDlc(t.files.get(ACF_PATH) ?? '').userDisabled).toEqual([337840, 337860, 337870])
    // Turning everything on leaves them off too.
    expect((await t.service.setSteamDlc('steam:251470', [])).ok).toBe(true)
    expect(readAcfDlc(t.files.get(ACF_PATH) ?? '').userDisabled).toEqual([337860, 337870])
  })

  it("changes nothing when Steam's DLC list cannot be read", async () => {
    const t = setup({
      appDlc: async () => {
        throw new Error('offline')
      }
    })
    const before = t.files.get(ACF_PATH)
    expect(await t.service.setSteamDlc('steam:251470', [337840])).toEqual({
      ok: false,
      error: dlcListFailedMessage()
    })
    expect(t.spawned).toEqual([])
    expect(t.files.get(ACF_PATH)).toBe(before)
  })

  it('leaves Steam alone when reg.exe cannot tell whether a game runs', async () => {
    const t = setup()
    failRegQuery(t)
    const before = t.files.get(ACF_PATH)
    expect(await t.service.setSteamDlc('steam:251470', [337840])).toEqual({
      ok: false,
      error: runningCheckFailedMessage()
    })
    expect(t.spawned).toEqual([])
    expect(t.files.get(ACF_PATH)).toBe(before)
    expect((await t.service.steamDlc('steam:251470')).blocked).toBe(runningCheckFailedMessage())
  })

  it('refuses a game marked installed without an install record, and saves no plan', async () => {
    const t = setup()
    t.files.delete(ACF_PATH)
    const result = await t.service.setSteamDlc('steam:251470', [337840])
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no install record/)
    expect(t.spawned).toEqual([])
    expect(existsSync(hostJoin(dir, 'steam-dlc-plans.json'))).toBe(false)
  })

  it('lets an apply under way finish (Steam started again) when PlayOut quits', async () => {
    const t = setup()
    let release: (() => void) | undefined
    let sleeping!: () => void
    const asleep = new Promise<void>((r) => (sleeping = r))
    t.io.sleep = () =>
      new Promise<void>((r) => {
        release = r
        sleeping()
      })
    const result = t.service.setSteamDlc('steam:251470', [337840])
    await asleep
    expect(t.spawned).toEqual([[`${ROOT}\\steam.exe`, '-shutdown']])
    const disposed = t.service.dispose()
    t.io.sleep = () => Promise.resolve()
    release?.()
    await disposed
    expect(await result).toEqual({ ok: true, restartedSteam: true })
    expect(t.spawned).toEqual([
      [`${ROOT}\\steam.exe`, '-shutdown'],
      [`${ROOT}\\steam.exe`, '-silent']
    ])
  })

  it('starts Steam again when PlayOut quits while an apply is stuck after closing Steam', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const t = setup()
      let sleeping!: () => void
      const asleep = new Promise<void>((r) => (sleeping = r))
      // Steam was asked to close and the wait for it never ends.
      t.io.sleep = () => {
        sleeping()
        return new Promise<void>(() => undefined)
      }
      void t.service.setSteamDlc('steam:251470', [337840])
      await asleep
      const disposed = t.service.dispose()
      await vi.advanceTimersByTimeAsync(10_000)
      await disposed
      expect(t.spawned).toEqual([
        [`${ROOT}\\steam.exe`, '-shutdown'],
        [`${ROOT}\\steam.exe`, '-silent']
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does nothing when the choice is already Steam’s', async () => {
    const t = setup()
    t.files.set(ACF_PATH, acf({ user: '337840', mounted: '337840' }))
    expect(await t.service.setSteamDlc('steam:251470', [337840])).toEqual({
      ok: true,
      restartedSteam: false
    })
    expect(t.spawned).toEqual([])
  })

  it('applies one change at a time', async () => {
    const t = setup()
    const [a, b] = await Promise.all([
      t.service.setSteamDlc('steam:251470', [337840]),
      t.service.setSteamDlc('steam:251470', [337850])
    ])
    expect(a.ok && b.ok).toBe(true)
    expect(t.spawned.map((s) => s[1])).toEqual(['-shutdown', '-silent', '-shutdown', '-silent'])
    expect(readAcfDlc(t.files.get(ACF_PATH) ?? '').userDisabled).toEqual([337850])
  })
})

describe('plans', () => {
  // Ownership unknown (not signed in to Steam in PlayOut): every listed DLC can be switched.
  const setup = (over: Parameters<typeof setupAll>[0] = {}): ReturnType<typeof setupAll> =>
    setupAll({ ownedApps: async () => null, ...over })

  const plansFile = (): unknown =>
    JSON.parse(readFileSync(hostJoin(dir, 'steam-dlc-plans.json'), 'utf8'))

  it('saves the choice for a game not installed and applies it once installed', async () => {
    const t = setup({ games: [game({ installed: false, installDir: undefined })] })
    t.files.delete(ACF_PATH)
    expect(await t.service.setSteamDlc('steam:251470', [337840, 337870])).toEqual({
      ok: true,
      planned: true
    })
    // Steam-only DLC are left out of the plan.
    expect(plansFile()).toMatchObject({
      plans: { 'steam:251470': { appId: 251470, disabled: [337840] } }
    })
    expect((await t.service.steamDlc('steam:251470')).plannedDisabled).toEqual([337840])
    expect(t.spawned).toEqual([])

    // Still installing: nothing happens.
    await t.service.processPlans()
    expect(t.applied).toEqual([])

    // The install finished: Steam installed every DLC; the plan turns the unwanted one off.
    t.games.set('steam:251470', game())
    t.files.set(ACF_PATH, acf())
    await t.service.processPlans()
    expect(readAcfDlc(t.files.get(ACF_PATH) ?? '').userDisabled).toEqual([337840])
    expect(t.spawned.map((s) => s[1])).toEqual(['-shutdown', '-silent'])
    expect(t.applied).toEqual([{ gameId: 'steam:251470', title: 'TowerFall Ascension', ok: true }])
    expect(plansFile()).toEqual({ version: 1, plans: {} })
    await t.service.dispose()
  })

  it('applies a plan after a library change once start() listens', async () => {
    const t = setup({ games: [game({ installed: false, installDir: undefined })] })
    t.files.delete(ACF_PATH)
    await t.service.setSteamDlc('steam:251470', [337840])
    t.service.start()
    t.games.set('steam:251470', game())
    t.files.set(ACF_PATH, acf())
    t.events.emit('library:changed', { reason: 'scan' })
    await vi.waitFor(() => expect(t.applied).toHaveLength(1))
    await t.service.dispose()
  })

  it('waits while blocked and gives up after a week', async () => {
    let clock = Date.parse('2026-11-15T00:00:00Z')
    const t = setup({
      games: [game({ installed: false, installDir: undefined })],
      gameRunning: () => true,
      now: () => clock
    })
    t.files.delete(ACF_PATH)
    await t.service.setSteamDlc('steam:251470', [337840])
    t.games.set('steam:251470', game())
    t.files.set(ACF_PATH, acf())
    await t.service.processPlans()
    expect(t.applied).toEqual([])
    expect(plansFile()).toMatchObject({
      plans: { 'steam:251470': { installedAt: expect.any(String) } }
    })
    clock += 8 * 24 * 60 * 60_000
    await t.service.processPlans()
    expect(t.applied).toEqual([
      {
        gameId: 'steam:251470',
        title: 'TowerFall Ascension',
        ok: false,
        error: gameRunningMessage()
      }
    ])
    expect(plansFile()).toEqual({ version: 1, plans: {} })
    expect(t.spawned).toEqual([])
    await t.service.dispose()
  })

  it('drops the plan of a game that left the library', async () => {
    const t = setup({ games: [game({ installed: false, installDir: undefined })] })
    t.files.delete(ACF_PATH)
    await t.service.setSteamDlc('steam:251470', [337840])
    t.games.delete('steam:251470')
    await t.service.processPlans()
    expect(plansFile()).toEqual({ version: 1, plans: {} })
    expect(t.applied).toEqual([])
  })

  it('turning every DLC on before the install deletes the plan', async () => {
    const t = setup({ games: [game({ installed: false, installDir: undefined })] })
    t.files.delete(ACF_PATH)
    await t.service.setSteamDlc('steam:251470', [337840])
    expect(plansFile()).toMatchObject({ plans: { 'steam:251470': { disabled: [337840] } } })
    expect(await t.service.setSteamDlc('steam:251470', [])).toEqual({ ok: true, planned: true })
    expect(plansFile()).toEqual({ version: 1, plans: {} })
    expect((await t.service.steamDlc('steam:251470')).plannedDisabled).toBeNull()
  })

  it("waits while Steam's DLC list cannot be read", async () => {
    writePlan({ disabled: [337840] })
    let offline = true
    const t = setup({
      appDlc: async () => {
        if (offline) throw new Error('offline')
        return [{ appId: 337840, sizeBytes: 200, steamOnly: false }]
      }
    })
    await t.service.processPlans()
    expect(t.spawned).toEqual([])
    expect(t.applied).toEqual([])
    expect(plansFile()).toMatchObject({ plans: { 'steam:251470': { disabled: [337840] } } })
    expect(readAcfDlc(t.files.get(ACF_PATH) ?? '').userDisabled).toEqual([])

    offline = false
    await t.service.processPlans()
    expect(readAcfDlc(t.files.get(ACF_PATH) ?? '').userDisabled).toEqual([337840])
    expect(t.applied).toEqual([{ gameId: 'steam:251470', title: 'TowerFall Ascension', ok: true }])
    await t.service.dispose()
  })

  it('waits while reg.exe cannot tell whether a game runs', async () => {
    writePlan({ disabled: [337840] })
    const t = setup()
    failRegQuery(t)
    await t.service.processPlans()
    expect(t.spawned).toEqual([])
    expect(t.applied).toEqual([])
    expect(plansFile()).toMatchObject({ plans: { 'steam:251470': { disabled: [337840] } } })
    await t.service.dispose()
  })

  it('drops the plan of an install that stopped, after a grace period', async () => {
    let clock = Date.parse('2026-11-15T00:00:00Z')
    let active = ['steam:251470']
    const t = setup({
      games: [game({ installed: false, installDir: undefined })],
      now: () => clock,
      installActive: () => active
    })
    t.files.delete(ACF_PATH)
    await t.service.setSteamDlc('steam:251470', [337840])

    // Still installing long after the choice: kept.
    clock += 60 * 60_000
    await t.service.processPlans()
    expect(plansFile()).toMatchObject({ plans: { 'steam:251470': { disabled: [337840] } } })

    // A fresh choice whose install then left the queue: kept for 2 minutes.
    await t.service.setSteamDlc('steam:251470', [337850])
    active = []
    clock += 60_000
    await t.service.processPlans()
    expect(plansFile()).toMatchObject({ plans: { 'steam:251470': { disabled: [337850] } } })

    clock += 2 * 60_000
    await t.service.processPlans()
    expect(plansFile()).toEqual({ version: 1, plans: {} })
    expect(t.applied).toEqual([])
    expect(t.spawned).toEqual([])
    await t.service.dispose()
  })

  it('gives up after Steam fails to close in time twice', async () => {
    writePlan({ disabled: [337840] })
    const t = setup({ shutdownTimeoutMs: 3, pollMs: 1 })
    t.state.closesAfterPolls = 1_000_000
    await t.service.processPlans()
    expect(t.applied).toEqual([])
    expect(plansFile()).toMatchObject({ plans: { 'steam:251470': { disabled: [337840] } } })
    // The slow-exit watch (immediate sleeps in the fake) ends with Steam still running.
    await new Promise((r) => setTimeout(r, 0))

    await t.service.processPlans()
    expect(t.applied).toEqual([
      {
        gameId: 'steam:251470',
        title: 'TowerFall Ascension',
        ok: false,
        error: expect.stringMatching(/did not close in time \(twice\)/)
      }
    ])
    expect(plansFile()).toEqual({ version: 1, plans: {} })
    expect(t.spawned).toEqual([
      [`${ROOT}\\steam.exe`, '-shutdown'],
      [`${ROOT}\\steam.exe`, '-shutdown']
    ])
    expect(readAcfDlc(t.files.get(ACF_PATH) ?? '').userDisabled).toEqual([])
    await t.service.dispose()
  })

  it('a later choice on the installed game replaces the plan', async () => {
    const t = setup({ games: [game({ installed: false, installDir: undefined })] })
    t.files.delete(ACF_PATH)
    await t.service.setSteamDlc('steam:251470', [337840])
    t.games.set('steam:251470', game())
    t.files.set(ACF_PATH, acf())
    expect((await t.service.setSteamDlc('steam:251470', [337850])).ok).toBe(true)
    expect(plansFile()).toEqual({ version: 1, plans: {} })
    expect(readAcfDlc(t.files.get(ACF_PATH) ?? '').userDisabled).toEqual([337850])
  })
})

describe('openSteamDlcPage', () => {
  it("opens the game's page in Steam", async () => {
    const t = setup()
    await t.service.openSteamDlcPage('steam:251470')
    expect(t.opened).toEqual(['steam://nav/games/details/251470'])
  })
})
