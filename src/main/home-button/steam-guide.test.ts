import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseVdf } from '../util/vdf'
import { createOverridesStore } from './overrides-store'
import {
  accountIdOf,
  createSteamGuideOverride,
  pickLoginUser,
  STEAM_BUSY_MESSAGE
} from './steam-guide'
import { findVdfKey, findVdfKeyAt } from './steam-vdf'
import { createFakeWindows, silentLog, type FakeWindows } from './testing'

const STEAM = 'c:\\program files (x86)\\steam'
const CONFIG = `${STEAM}\\config\\config.vdf`
const LOGINUSERS = `${STEAM}\\config\\loginusers.vdf`
const LOCAL = `${STEAM}\\userdata\\39734373\\config\\localconfig.vdf`
const OTHER_LOCAL = `${STEAM}\\userdata\\39734474\\config\\localconfig.vdf`
const DATA = 'C:\\data\\home-button'
const EXE = `${STEAM}\\steam.exe`

const CONFIG_TEXT = [
  '"InstallConfigStore"',
  '{',
  '\t"Software"',
  '\t{',
  '\t\t"Valve"',
  '\t\t{',
  '\t\t\t"Steam"',
  '\t\t\t{',
  '\t\t\t\t"AutoUpdateWindowEnabled"\t\t"0"',
  '\t\t\t}',
  '\t\t}',
  '\t}',
  '}',
  ''
].join('\n')
const LOCAL_TEXT =
  '"UserLocalConfigStore"\n{\n\t"system"\n\t{\n\t\t"EnableGameOverlay"\t\t"1"\n\t}\n}\n'
const LOGIN_TEXT = [
  '"users"',
  '{',
  '\t"76561198000000101"',
  '\t{',
  '\t\t"AccountName"\t\t"first"',
  '\t\t"timestamp"\t\t"1700000000"',
  '\t}',
  '\t"76561198000000202"',
  '\t{',
  '\t\t"AccountName"\t\t"second"',
  '\t\t"timestamp"\t\t"1600000000"',
  '\t}',
  '}',
  ''
].join('\n')

const guide = (w: FakeWindows, path: string): string[] =>
  findVdfKey(w.text(path) ?? '', 'Controller_CheckGuideButton').map((e) => e.value)
const overlay = (w: FakeWindows, path: string): string[] =>
  findVdfKey(w.text(path) ?? '', 'EnableGameOverlay').map((e) => e.value)

function setup(): {
  w: FakeWindows
  steam: ReturnType<typeof createSteamGuideOverride>
  store: ReturnType<typeof createOverridesStore>
} {
  const w = createFakeWindows()
  w.registry.set('hkcu\\software\\valve\\steam|steampath', {
    type: 'REG_SZ',
    data: 'c:/program files (x86)/steam'
  })
  w.registry.set('hkcu\\software\\valve\\steam\\activeprocess|activeuser', {
    type: 'REG_DWORD',
    data: 0
  })
  w.setText(`${STEAM}\\steam.exe`, 'MZ')
  w.setText(CONFIG, CONFIG_TEXT)
  w.setText(LOGINUSERS, LOGIN_TEXT)
  w.setText(LOCAL, LOCAL_TEXT)
  w.setText(OTHER_LOCAL, LOCAL_TEXT)
  const store = createOverridesStore(w.io, DATA)
  const steam = createSteamGuideOverride({
    io: w.io,
    store,
    dataDir: DATA,
    log: silentLog,
    pollMs: 500
  })
  return { w, steam, store }
}

describe('accountIdOf / pickLoginUser', () => {
  it('converts a SteamID64 to the userdata folder name', () => {
    expect(accountIdOf('76561198000000101')).toBe('39734373')
    expect(accountIdOf('76561197960265728')).toBeNull()
    expect(accountIdOf('123')).toBeNull()
    expect(accountIdOf('7656119798422827x')).toBeNull()
  })

  it('prefers MostRecent, then AutoLoginUser, then the latest timestamp', () => {
    const login = parseVdf(LOGIN_TEXT)
    expect(pickLoginUser(login, null)).toBe('39734373')
    expect(pickLoginUser(login, 'SECOND')).toBe('39734474')
    const recent = parseVdf(LOGIN_TEXT.replace('"second"', '"second"\n\t\t"mostrecent"\t\t"1"'))
    expect(pickLoginUser(recent, 'first')).toBe('39734474')
    expect(pickLoginUser(parseVdf('"users"\n{\n}\n'), null)).toBeNull()
    expect(pickLoginUser(parseVdf('"other"\n{\n}\n'), null)).toBeNull()
  })
})

describe('Steam Guide override', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
  })

  it('is missing without a Steam install', async () => {
    ctx.w.registry.clear()
    expect(await ctx.steam.apply()).toEqual({ state: 'missing' })
    const w2 = setup()
    w2.w.files.delete(`${STEAM}\\steam.exe`)
    expect(await w2.steam.apply()).toEqual({ state: 'missing' })
  })

  it('adds the key to both files when Steam is closed, without touching Steam', async () => {
    const pending = vi.fn()
    expect(await ctx.steam.apply(pending)).toEqual({ state: 'applied' })
    expect(pending).not.toHaveBeenCalled()
    expect(ctx.w.spawned).toEqual([])
    expect(guide(ctx.w, CONFIG)).toEqual(['0'])
    expect(guide(ctx.w, LOCAL)).toEqual(['0'])
    // The other account is left alone.
    expect(guide(ctx.w, OTHER_LOCAL)).toEqual([])
    const record = await ctx.store.read()
    expect(record.steam?.files.map((f) => [f.path, f.original])).toEqual([
      [CONFIG, null],
      [LOCAL, null]
    ])
    // Backups hold the files as they were.
    expect(ctx.w.text(`${DATA}\\steam-backup\\config.vdf`)).toBe(CONFIG_TEXT)
    expect(ctx.w.text(`${DATA}\\steam-backup\\localconfig-39734373.vdf`)).toBe(LOCAL_TEXT)
    // No temp file left behind.
    expect([...ctx.w.files.keys()].some((k) => k.endsWith('.playout-tmp'))).toBe(false)
  })

  it('uses ActiveUser before loginusers.vdf', async () => {
    ctx.w.registry.set('hkcu\\software\\valve\\steam\\activeprocess|activeuser', {
      type: 'REG_DWORD',
      data: 39734474
    })
    await ctx.steam.apply()
    expect(guide(ctx.w, OTHER_LOCAL)).toEqual(['0'])
    expect(guide(ctx.w, LOCAL)).toEqual([])
  })

  it('reports already when every file has it off, and applied once PlayOut did it', async () => {
    ctx.w.setText(
      CONFIG,
      CONFIG_TEXT.replace(
        '"AutoUpdateWindowEnabled"',
        '"Controller_CheckGuideButton"\t\t"0"\n\t\t\t\t"AutoUpdateWindowEnabled"'
      )
    )
    ctx.w.setText(
      LOCAL,
      LOCAL_TEXT.replace('"system"', '"Controller_CheckGuideButton"\t\t"0"\n\t"system"').replace(
        '"EnableGameOverlay"\t\t"1"',
        '"EnableGameOverlay"\t\t"0"'
      )
    )
    expect(await ctx.steam.apply()).toEqual({ state: 'already' })
    expect((await ctx.store.read()).steam).toBeUndefined()

    const fresh = setup()
    expect(await fresh.steam.apply()).toEqual({ state: 'applied' })
    const commandsBefore = fresh.w.commands.length
    expect(await fresh.steam.apply()).toEqual({ state: 'applied' })
    // A second apply only reads.
    expect(fresh.w.commands.slice(commandsBefore).some((c) => c.includes('add'))).toBe(false)
  })

  it('closes a running Steam, edits what it wrote on exit, and starts it again', async () => {
    ctx.w.processes.add('steam.exe')
    ctx.w.steamExitAfter = 3
    // Steam's exit writes the key as "1" into localconfig.vdf.
    ctx.w.onSteamExit = () =>
      ctx.w.setText(
        LOCAL,
        LOCAL_TEXT.replace('"system"', '"Controller_CheckGuideButton"\t\t"1"\n\t"system"')
      )
    const pending = vi.fn()
    expect(await ctx.steam.apply(pending)).toEqual({ state: 'applied' })
    expect(pending).toHaveBeenCalledOnce()
    expect(ctx.w.spawned).toEqual([
      { file: `${STEAM}\\steam.exe`, args: ['-shutdown'] },
      { file: `${STEAM}\\steam.exe`, args: ['-silent'] }
    ])
    expect(ctx.w.sleeps).toBe(3)
    expect(guide(ctx.w, LOCAL)).toEqual(['0'])
    const files = (await ctx.store.read()).steam!.files
    expect(files.find((f) => f.path === LOCAL)?.original).toBe('1')
  })

  it('never closes Steam while it runs a game, waiting instead and changing nothing', async () => {
    ctx.w.processes.add('steam.exe')
    ctx.w.registry.set('hkcu\\software\\valve\\steam|runningappid', {
      type: 'REG_DWORD',
      data: 1145360
    })
    const status = await ctx.steam.apply()
    expect(status).toEqual({ state: 'pending', message: STEAM_BUSY_MESSAGE })
    expect(ctx.w.spawned).toEqual([])
    expect(guide(ctx.w, CONFIG)).toEqual([])
    expect((await ctx.store.read()).steam).toBeUndefined()
  })

  it('never closes Steam while a PlayOut game runs', async () => {
    ctx.w.processes.add('steam.exe')
    const store = createOverridesStore(ctx.w.io, DATA)
    const steam = createSteamGuideOverride({
      io: ctx.w.io,
      store,
      dataDir: DATA,
      log: silentLog,
      gameRunning: () => true
    })
    expect((await steam.apply()).state).toBe('pending')
    expect(ctx.w.spawned).toEqual([])
  })

  it('gives up when Steam does not close in time, changing nothing and not starting it', async () => {
    ctx.w.processes.add('steam.exe')
    ctx.w.steamExitAfter = Infinity
    const status = await ctx.steam.apply()
    expect(status.state).toBe('error')
    expect(status.message).toMatch(/slow to close \(still running after 30 seconds\)/)
    expect(status.message).toMatch(/not changed/)
    expect(ctx.w.sleeps).toBeGreaterThanOrEqual(60)
    // The background watch gives up after 5 more minutes of 2 s polls (150) without starting anything.
    await vi.waitFor(async () => expect((await ctx.store.read()).steamClosed).toBeUndefined())
    expect(ctx.w.sleeps).toBe(60 + 150)
    expect(guide(ctx.w, CONFIG)).toEqual([])
    expect(ctx.w.spawned.map((s) => s.args[0])).toEqual(['-shutdown'])
    expect((await ctx.store.read()).steam).toBeUndefined()
  })

  it('reports an unreadable config file as an error, leaving it as it is', async () => {
    ctx.w.setText(CONFIG, '"InstallConfigStore"\n{\n\t"Software"\n')
    const status = await ctx.steam.apply()
    expect(status.state).toBe('error')
    expect(ctx.w.text(CONFIG)).toBe('"InstallConfigStore"\n{\n\t"Software"\n')
  })

  it('keeps the first originals when the user turned it back on in Steam', async () => {
    await ctx.steam.apply()
    ctx.w.setText(
      LOCAL,
      (ctx.w.text(LOCAL) ?? '').replace(
        '"Controller_CheckGuideButton"\t\t"0"',
        '"Controller_CheckGuideButton"\t\t"1"'
      )
    )
    expect(await ctx.steam.apply()).toEqual({ state: 'applied' })
    expect(guide(ctx.w, LOCAL)).toEqual(['0'])
    expect((await ctx.store.read()).steam!.files.map((f) => f.original)).toEqual([null, null])
  })

  it("turns Steam's in-game overlay off in the account's localconfig.vdf only, and records it", async () => {
    expect(await ctx.steam.apply()).toEqual({ state: 'applied' })
    expect(overlay(ctx.w, LOCAL)).toEqual(['0'])
    expect(overlay(ctx.w, CONFIG)).toEqual([])
    expect(overlay(ctx.w, OTHER_LOCAL)).toEqual(['1'])
    const local = (await ctx.store.read()).steam!.files.find((f) => f.path === LOCAL)!
    expect(local.originals).toEqual({ Controller_CheckGuideButton: null, EnableGameOverlay: '1' })
  })

  it('adds the overlay key to the system block when Steam has none, and removes it on restore', async () => {
    const bare = '"UserLocalConfigStore"\n{\n\t"friends"\n\t{\n\t}\n}\n'
    ctx.w.setText(LOCAL, bare)
    await ctx.steam.apply()
    const system = ['UserLocalConfigStore', 'system']
    expect(
      findVdfKeyAt(ctx.w.text(LOCAL) ?? '', system, 'EnableGameOverlay').map((e) => e.value)
    ).toEqual(['0'])
    await ctx.steam.restore()
    expect(overlay(ctx.w, LOCAL)).toEqual([])
    expect(guide(ctx.w, LOCAL)).toEqual([])
  })

  it('turns the overlay off too where an older PlayOut only changed the Guide button, keeping that original', async () => {
    // What PlayOut before 0.9.49 left: the Guide key off, recorded with `original` only.
    ctx.w.setText(
      CONFIG,
      CONFIG_TEXT.replace(
        '"AutoUpdateWindowEnabled"',
        '"Controller_CheckGuideButton"\t\t"0"\n\t\t\t\t"AutoUpdateWindowEnabled"'
      )
    )
    ctx.w.setText(
      LOCAL,
      LOCAL_TEXT.replace('"system"', '"Controller_CheckGuideButton"\t\t"0"\n\t"system"')
    )
    await ctx.store.set('steam', {
      steamPath: STEAM,
      files: [
        { path: CONFIG, original: '1' },
        { path: LOCAL, original: null }
      ]
    })
    expect(await ctx.steam.apply()).toEqual({ state: 'applied' })
    expect(overlay(ctx.w, LOCAL)).toEqual(['0'])
    const files = (await ctx.store.read()).steam!.files
    expect(files.find((f) => f.path === LOCAL)!.originals).toEqual({
      Controller_CheckGuideButton: null,
      EnableGameOverlay: '1'
    })
    expect(await ctx.steam.restore()).toEqual({ state: 'off' })
    expect(guide(ctx.w, CONFIG)).toEqual(['1'])
    expect(ctx.w.text(LOCAL)).toBe(LOCAL_TEXT)
  })

  describe('restore', () => {
    it('is off with nothing recorded', async () => {
      expect(await ctx.steam.restore()).toEqual({ state: 'off' })
      expect(ctx.w.commands.some((c) => c[0] === 'tasklist.exe')).toBe(false)
    })

    it('gives the files back exactly as they were', async () => {
      ctx.w.setText(
        CONFIG,
        CONFIG_TEXT.replace(
          '"AutoUpdateWindowEnabled"',
          '"Controller_CheckGuideButton"\t\t"1"\n\t\t\t\t"AutoUpdateWindowEnabled"'
        )
      )
      const configBefore = ctx.w.text(CONFIG)
      await ctx.steam.apply()
      expect(await ctx.steam.restore()).toEqual({ state: 'off' })
      expect(ctx.w.text(CONFIG)).toBe(configBefore)
      expect(ctx.w.text(LOCAL)).toBe(LOCAL_TEXT)
      expect((await ctx.store.read()).steam).toBeUndefined()
    })

    it('closes and restarts a running Steam', async () => {
      await ctx.steam.apply()
      ctx.w.processes.add('steam.exe')
      const pending = vi.fn()
      expect(await ctx.steam.restore(pending)).toEqual({ state: 'off' })
      expect(pending).toHaveBeenCalledOnce()
      expect(ctx.w.spawned.map((s) => s.args[0])).toEqual(['-shutdown', '-silent'])
      expect(ctx.w.text(LOCAL)).toBe(LOCAL_TEXT)
    })

    it('leaves a value the user changed since, without closing Steam', async () => {
      await ctx.steam.apply()
      ctx.w.processes.add('steam.exe')
      for (const p of [CONFIG, LOCAL]) {
        ctx.w.setText(
          p,
          (ctx.w.text(p) ?? '')
            .replace('"Controller_CheckGuideButton"\t\t"0"', '"Controller_CheckGuideButton"\t\t"1"')
            .replace('"EnableGameOverlay"\t\t"0"', '"EnableGameOverlay"\t\t"1"')
        )
      }
      const changed = ctx.w.text(LOCAL)
      expect(await ctx.steam.restore()).toEqual({ state: 'off' })
      expect(ctx.w.spawned).toEqual([])
      expect(ctx.w.text(LOCAL)).toBe(changed)
      expect((await ctx.store.read()).steam).toBeUndefined()
    })

    it('keeps the record when Steam does not close', async () => {
      await ctx.steam.apply()
      ctx.w.processes.add('steam.exe')
      ctx.w.steamExitAfter = Infinity
      expect((await ctx.steam.restore()).state).toBe('error')
      expect((await ctx.store.read()).steam).toBeDefined()
      expect(guide(ctx.w, LOCAL)).toEqual(['0'])
    })
  })
})

describe('Steam left closed', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
  })
  const markerFile = `${DATA}\\overrides.json`
  const marker = (): unknown => JSON.parse(ctx.w.text(markerFile) ?? '{}').steamClosed

  it('records that Steam was closed before -shutdown and clears it once Steam is started again', async () => {
    ctx.w.processes.add('steam.exe')
    let seen: unknown
    ctx.w.onSteamExit = () => (seen = marker())
    expect(await ctx.steam.apply()).toEqual({ state: 'applied' })
    expect(seen).toMatchObject({ exe: EXE })
    expect(typeof (seen as { steamClosedAt: number }).steamClosedAt).toBe('number')
    expect(marker()).toBeUndefined()
  })

  it('starts Steam once it has exited after a slow shutdown, still reporting the error', async () => {
    ctx.w.processes.add('steam.exe')
    // 60 polls of 500 ms time out; Steam exits 5 polls (10 s) into the background watch.
    ctx.w.steamExitAfter = 65
    const status = await ctx.steam.apply()
    expect(status.state).toBe('error')
    expect(status.message).toMatch(/slow to close/)
    expect(guide(ctx.w, CONFIG)).toEqual([])
    await vi.waitFor(() =>
      expect(ctx.w.spawned.map((s) => s.args[0])).toEqual(['-shutdown', '-silent'])
    )
    expect(ctx.w.processes.has('steam.exe')).toBe(true)
    await vi.waitFor(() => expect(marker()).toBeUndefined())
    expect(ctx.w.sleeps).toBe(65)
    // Nothing was changed and nothing recorded.
    expect((await ctx.store.read()).steam).toBeUndefined()
  })

  it('changes nothing while it still waits for a slow Steam to close', async () => {
    ctx.w.processes.add('steam.exe')
    ctx.w.steamExitAfter = 65
    // Hold the background watch at its first poll until released.
    const realSleep = ctx.w.io.sleep
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    ctx.w.io.sleep = async (ms) => {
      if (ctx.w.sleeps >= 60) await gate
      return realSleep(ms)
    }
    expect((await ctx.steam.apply()).state).toBe('error')
    const second = await ctx.steam.apply()
    expect(second.state).toBe('error')
    expect(second.message).toMatch(/not running again yet/)
    // No second -shutdown, no edit.
    expect(ctx.w.spawned.map((s) => s.args[0])).toEqual(['-shutdown'])
    expect(guide(ctx.w, CONFIG)).toEqual([])
    release()
    await vi.waitFor(() =>
      expect(ctx.w.spawned.map((s) => s.args[0])).toEqual(['-shutdown', '-silent'])
    )
    // Once Steam is back, a change goes through again.
    await vi.waitFor(() => expect(marker()).toBeUndefined())
    ctx.w.steamExitAfter = 2
    expect(await ctx.steam.apply()).toEqual({ state: 'applied' })
  })

  it('at start, starts a Steam that PlayOut closed and never started again', async () => {
    await ctx.store.set('steamClosed', { steamClosedAt: 1, exe: EXE })
    await ctx.steam.recover()
    expect(ctx.w.spawned).toEqual([{ file: EXE, args: ['-silent'] }])
    expect((await ctx.store.read()).steamClosed).toBeUndefined()
  })

  it('at start, leaves a running Steam alone and drops the marker', async () => {
    ctx.w.processes.add('steam.exe')
    await ctx.store.set('steamClosed', { steamClosedAt: 1, exe: EXE })
    await ctx.steam.recover()
    expect(ctx.w.spawned).toEqual([])
    expect((await ctx.store.read()).steamClosed).toBeUndefined()
  })

  it('at start, does nothing without a marker', async () => {
    await ctx.steam.recover()
    expect(ctx.w.spawned).toEqual([])
    expect(ctx.w.commands).toEqual([])
  })

  it('a crash after -shutdown leaves the marker for the next start', async () => {
    ctx.w.processes.add('steam.exe')
    // PlayOut stops while Steam closes: apply never gets to start it.
    ctx.w.io.sleep = () => new Promise<void>(() => {})
    void ctx.steam.apply()
    await vi.waitFor(() => expect(ctx.w.spawned.map((s) => s.args[0])).toEqual(['-shutdown']))
    expect(marker()).toBeDefined()
    // Steam exits; the next PlayOut finds it closed and starts it.
    ctx.w.processes.delete('steam.exe')
    const next = createSteamGuideOverride({
      io: { ...ctx.w.io, sleep: async () => {} },
      store: createOverridesStore(ctx.w.io, DATA),
      dataDir: DATA,
      log: silentLog
    })
    await next.recover()
    expect(ctx.w.spawned.map((s) => s.args[0])).toEqual(['-shutdown', '-silent'])
    expect(marker()).toBeUndefined()
  })
})

describe('overrides store', () => {
  it('sets aside an unreadable record instead of losing it', async () => {
    const w = createFakeWindows()
    w.setText(`${DATA}\\overrides.json`, '{not json')
    const store = createOverridesStore(w.io, DATA)
    expect(await store.read()).toEqual({ version: 1 })
    expect(w.text(`${DATA}\\overrides.json.bad`)).toBe('{not json')
    await store.set('gameBar', { values: { A: 1 } })
    await store.set('steam', { steamPath: 'x', files: [] })
    await store.set('gameBar', undefined)
    expect(JSON.parse(w.text(`${DATA}\\overrides.json`) ?? '')).toEqual({
      version: 1,
      steam: { steamPath: 'x', files: [] }
    })
  })
})
