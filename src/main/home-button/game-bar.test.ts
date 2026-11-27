import { describe, expect, it } from 'vitest'
import { createGameBarOverride } from './game-bar'
import { linkKey, noOpCommand } from './game-bar-links'
import { parseRegQuery } from './io'
import { createOverridesStore } from './overrides-store'
import { createFakeWindows, silentLog } from './testing'

const NEXUS = 'hkcu\\software\\microsoft\\gamebar|usenexusforgamebarenabled'
const CHORD = 'hkcu\\software\\microsoft\\gamebar|gamepadnexuschordenabled'
const commandOf = (link: string): string =>
  `${linkKey(link).toLowerCase()}\\shell\\open\\command|(default)`
/** This PC: both links exist as bare "URL Protocol" keys, opened by Game Bar's own app registration. */
function bareLinks(w: ReturnType<typeof createFakeWindows>): void {
  for (const link of ['ms-gamebar', 'ms-gamingoverlay']) {
    w.registry.set(`${linkKey(link).toLowerCase()}|(default)`, {
      type: 'REG_SZ',
      data: `URL:${link}`
    })
    w.registry.set(`${linkKey(link).toLowerCase()}|url protocol`, { type: 'REG_SZ', data: '' })
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a test fixture
function setup(nexus: number | null, chord: number | null) {
  const w = createFakeWindows()
  if (nexus !== null) w.registry.set(NEXUS, { type: 'REG_DWORD', data: nexus })
  if (chord !== null) w.registry.set(CHORD, { type: 'REG_DWORD', data: chord })
  const store = createOverridesStore(w.io, 'C:\\data')
  const gameBar = createGameBarOverride({ run: w.io.run, store, log: silentLog })
  return { w, store, gameBar }
}

describe('parseRegQuery', () => {
  it('reads DWORD and string values as reg.exe prints them', () => {
    const out =
      '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\GameBar\r\n    AutoGameModeEnabled    REG_DWORD    0x1\r\n    UseNexusForGameBarEnabled    REG_DWORD    0x0\r\n\r\n'
    expect(parseRegQuery(out, 'UseNexusForGameBarEnabled')).toEqual({ type: 'REG_DWORD', data: 0 })
    expect(parseRegQuery(out, 'AutoGameModeEnabled')).toEqual({ type: 'REG_DWORD', data: 1 })
    expect(parseRegQuery(out, 'Missing')).toBeNull()
    expect(
      parseRegQuery('    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n', 'SteamPath')
    ).toEqual({ type: 'REG_SZ', data: 'c:/program files (x86)/steam' })
    expect(parseRegQuery('    Empty    REG_SZ    \r\n', 'Empty')).toEqual({
      type: 'REG_SZ',
      data: ''
    })
  })
})

describe('Game Bar override', () => {
  it('reports already when the shortcuts are 0 and the links already open nothing, writing nothing', async () => {
    const { w, gameBar, store } = setup(0, 0)
    for (const link of ['ms-gamebar', 'ms-gamingoverlay'])
      w.registry.set(commandOf(link), { type: 'REG_SZ', data: noOpCommand() })
    expect(await gameBar.apply()).toEqual({ state: 'already' })
    expect(w.commands.some((c) => c[1] === 'add')).toBe(false)
    expect((await store.read()).gameBar).toBeUndefined()
    expect(await gameBar.restore()).toEqual({ state: 'off' })
  })

  it('points the Game Bar links at nothing on this PC (shortcuts already off) and puts them back exactly', async () => {
    const { w, gameBar, store } = setup(0, 0)
    bareLinks(w)
    expect(await gameBar.apply()).toEqual({ state: 'applied' })
    for (const link of ['ms-gamebar', 'ms-gamingoverlay']) {
      expect(w.registry.get(commandOf(link))?.data).toBe(noOpCommand())
      expect(w.registry.has(`${linkKey(link).toLowerCase()}|noopenwith`)).toBe(true)
    }
    expect((await store.read()).gameBar?.links?.['ms-gamebar']).toEqual({
      keyExisted: true,
      shellExisted: false,
      openExisted: false,
      commandKeyExisted: false,
      command: null,
      commandType: null,
      keyDefault: true,
      urlProtocol: '',
      noOpenWith: false
    })
    // A second apply changes nothing more.
    const adds = w.commands.filter((c) => c[1] === 'add').length
    expect(await gameBar.apply()).toEqual({ state: 'applied' })
    expect(w.commands.filter((c) => c[1] === 'add').length).toBe(adds)

    expect(await gameBar.restore()).toEqual({ state: 'off' })
    for (const link of ['ms-gamebar', 'ms-gamingoverlay']) {
      expect(w.registry.has(commandOf(link))).toBe(false)
      expect(w.registry.has(`${linkKey(link).toLowerCase()}|noopenwith`)).toBe(false)
      // The link's own key stays as it was.
      expect(w.registry.get(`${linkKey(link).toLowerCase()}|(default)`)?.data).toBe(`URL:${link}`)
    }
  })

  it('removes link keys it created, and puts back a command another program had set', async () => {
    const { w, gameBar } = setup(0, 0)
    w.registry.set(commandOf('ms-gamebar'), { type: 'REG_SZ', data: '"C:\\Tools\\other.exe" %1' })
    await gameBar.apply()
    expect(w.registry.get(commandOf('ms-gamebar'))?.data).toBe(noOpCommand())
    await gameBar.restore()
    expect(w.registry.get(commandOf('ms-gamebar'))?.data).toBe('"C:\\Tools\\other.exe" %1')
    // ms-gamingoverlay had no key at all: it is gone again.
    expect([...w.registry.keys()].some((k) => k.includes('ms-gamingoverlay'))).toBe(false)
  })

  it('reads an unset default as none, never as the text reg.exe prints for it', async () => {
    const { w, gameBar } = setup(0, 0)
    bareLinks(w)
    const commandKey = commandOf('ms-gamebar').split('|')[0]
    // shell\open\command exists with no default value: reg.exe prints "(value not set)" for it.
    await w.io.run('reg.exe', ['add', commandKey, '/f'])
    await gameBar.apply()
    await gameBar.restore()
    expect(w.registry.has(commandOf('ms-gamebar'))).toBe(false)
    expect([...w.registry.values()].some((v) => v.data === '(value not set)')).toBe(false)
  })

  it('puts back what it added to a key that existed, and the command with its own type', async () => {
    const { w, gameBar } = setup(0, 0)
    const key = linkKey('ms-gamebar').toLowerCase()
    w.registry.set(commandOf('ms-gamebar'), {
      type: 'REG_EXPAND_SZ',
      data: '%SystemRoot%\\other.exe %1'
    })
    await gameBar.apply()
    expect(w.registry.get(`${key}|url protocol`)?.data).toBe('')
    expect(w.registry.get(`${key}|(default)`)?.data).toBe('URL:ms-gamebar')
    await gameBar.restore()
    expect(w.registry.get(commandOf('ms-gamebar'))).toEqual({
      type: 'REG_EXPAND_SZ',
      data: '%SystemRoot%\\other.exe %1'
    })
    expect(w.registry.has(`${key}|url protocol`)).toBe(false)
    expect(w.registry.has(`${key}|(default)`)).toBe(false)
    expect(w.registry.has(`${key}|noopenwith`)).toBe(false)
  })

  it('cleans up an apply that stopped before the command was written', async () => {
    const { w, store } = setup(0, 0)
    bareLinks(w)
    const failing = createGameBarOverride({
      run: async (file, args) =>
        args[0] === 'add' && args[1].toLowerCase().endsWith('\\command')
          ? { code: 5, stdout: '', stderr: 'ERROR: Access is denied.' }
          : w.io.run(file, args),
      store,
      log: silentLog
    })
    expect((await failing.apply()).state).toBe('error')
    const key = linkKey('ms-gamebar').toLowerCase()
    expect(w.registry.has(`${key}|noopenwith`)).toBe(true)
    const gameBar = createGameBarOverride({ run: w.io.run, store, log: silentLog })
    await gameBar.restore()
    expect(w.registry.has(`${key}|noopenwith`)).toBe(false)
    expect(w.registry.get(`${key}|url protocol`)?.data).toBe('')
  })

  it('never records a link it could not read (reg.exe timed out) and changes nothing for it', async () => {
    const { w, store } = setup(0, 0)
    bareLinks(w)
    const gameBar = createGameBarOverride({
      run: async (file, args) =>
        args[0] === 'query' && args[1].toLowerCase().includes('ms-gamebar')
          ? { code: null, stdout: '', stderr: '' }
          : w.io.run(file, args),
      store,
      log: silentLog
    })
    expect((await gameBar.apply()).state).toBe('error')
    expect((await store.read()).gameBar?.links?.['ms-gamebar']).toBeUndefined()
    expect(w.registry.has(commandOf('ms-gamebar'))).toBe(false)
  })

  it('leaves a link someone pointed elsewhere since', async () => {
    const { w, gameBar } = setup(0, 0)
    bareLinks(w)
    await gameBar.apply()
    w.registry.set(commandOf('ms-gamebar'), { type: 'REG_SZ', data: 'C:\\new.exe' })
    await gameBar.restore()
    expect(w.registry.get(commandOf('ms-gamebar'))?.data).toBe('C:\\new.exe')
  })

  it('turns both off and puts them back, absent values removed again', async () => {
    const { w, gameBar, store } = setup(1, null)
    expect(await gameBar.apply()).toEqual({ state: 'applied' })
    expect(w.registry.get(NEXUS)?.data).toBe(0)
    expect(w.registry.get(CHORD)?.data).toBe(0)
    expect((await store.read()).gameBar?.values).toEqual({
      UseNexusForGameBarEnabled: 1,
      GamepadNexusChordEnabled: null
    })
    expect(await gameBar.apply()).toEqual({ state: 'applied' })

    expect(await gameBar.restore()).toEqual({ state: 'off' })
    expect(w.registry.get(NEXUS)?.data).toBe(1)
    expect(w.registry.has(CHORD)).toBe(false)
    expect((await store.read()).gameBar).toBeUndefined()
  })

  it('records only what it changed', async () => {
    const { gameBar, store } = setup(0, 1)
    await gameBar.apply()
    expect((await store.read()).gameBar?.values).toEqual({ GamepadNexusChordEnabled: 1 })
  })

  it('keeps the first originals when Windows turned one back on', async () => {
    const { w, gameBar, store } = setup(1, 1)
    await gameBar.apply()
    w.registry.set(NEXUS, { type: 'REG_DWORD', data: 1 })
    await gameBar.apply()
    expect((await store.read()).gameBar?.values).toEqual({
      UseNexusForGameBarEnabled: 1,
      GamepadNexusChordEnabled: 1
    })
    expect(w.registry.get(NEXUS)?.data).toBe(0)
  })

  it('leaves a value the user changed since', async () => {
    const { w, gameBar } = setup(1, 1)
    await gameBar.apply()
    w.registry.set(CHORD, { type: 'REG_DWORD', data: 5 })
    await gameBar.restore()
    expect(w.registry.get(NEXUS)?.data).toBe(1)
    expect(w.registry.get(CHORD)?.data).toBe(5)
  })

  it('reports a failing reg.exe as an error', async () => {
    const { w, store } = setup(1, 1)
    const gameBar = createGameBarOverride({
      run: async (file, args) =>
        args[0] === 'add'
          ? { code: 5, stdout: '', stderr: 'ERROR: Access is denied.' }
          : w.io.run(file, args),
      store,
      log: silentLog
    })
    const status = await gameBar.apply()
    expect(status).toEqual({ state: 'error', message: 'reg add failed: ERROR: Access is denied.' })
  })
})
