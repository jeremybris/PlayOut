import { promises as fsp } from 'fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Runner } from '../types'
import {
  addAutoloadDir,
  applyPresets,
  gamepadEntry,
  generateRyujinxConfig,
  guidBytes,
  isDefaultInput,
  mergeControllers,
  refreshRyujinxControllers,
  ryujinxPadId,
  ryujinxPadIds,
  ryujinxUpdatesDir,
  type InputConfigEntry
} from './ryujinx'
import { parseSdlPads, RYUJINX_SDL_HINTS, sdlPadsScript, type SdlPad } from './sdl-pads'
import { PresetDeferredError, type HiddenProcess, type PresetContext } from './types'

let dir: string
let E: string
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'playout-ryujinx-'))
  E = join(dir, 'Ryujinx')
  await mkdir(join(E, 'portable'), { recursive: true })
  vi.clearAllMocks()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

/** An Xbox Series pad over USB: GUID 03 00 ... 5e 04 00 00 12 0b 00 00 ... in SDL memory order. */
const XBOX_GUID = '030000005e040000120b000000000000'
const XBOX_ID = '0-00000003-045e-0000-120b-000000000000'
const DS4_GUID = '030000004c050000cc09000000006800'

const keyboard = (): InputConfigEntry => ({
  left_joycon_stick: { stick_up: 'W' },
  version: 1,
  backend: 'WindowKeyboard',
  id: '0',
  name: 'Keyboard',
  controller_type: 'ProController',
  player_index: 'Player1'
})

/** A trimmed default Config.json (the real one has ~90 keys; order and unknown keys must survive). */
function defaultConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 70,
    enable_file_log: true,
    res_scale_custom: 1,
    start_fullscreen: false,
    show_console: true,
    hotkeys: { toggle_vsync_mode: 'F1' },
    input_config: [keyboard()],
    graphics_backend: 'Vulkan',
    dirty_hacks: [],
    autoload_dirs: [],
    ...extra
  }
}

const configFile = (): string => join(E, 'portable', 'Config.json')
const stateFile = (): string => join(E, 'portable', 'playout-controllers.json')
const readJson = async (p: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(p, 'utf8'))

/**
 * A runner: tasklist says whether Ryujinx runs (a function: asked on each call); PowerShell prints the pads (and calls
 * onDetect first).
 */
function runner(
  pads: SdlPad[] | null,
  running: boolean | (() => boolean) = false,
  onDetect?: () => void
): Runner & ReturnType<typeof vi.fn> {
  return vi.fn(async (file: string) => {
    if (file === 'tasklist') {
      return (typeof running === 'function' ? running() : running)
        ? { code: 0, stdout: '"Ryujinx.exe","4242","Console","1","300,000 K"\r\n', stderr: '' }
        : {
            code: 0,
            stdout: 'INFO: No tasks are running which match the specified criteria.\r\n',
            stderr: ''
          }
    }
    if (file === 'powershell.exe') {
      onDetect?.()
      return pads
        ? { code: 0, stdout: JSON.stringify({ pads }) + '\r\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'Unable to load DLL' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }) as unknown as Runner & ReturnType<typeof vi.fn>
}

function ctx(
  run: Runner,
  firstTime = true,
  startHidden?: PresetContext['startHidden']
): PresetContext {
  return {
    emuDir: E,
    dataDir: join(dir, 'Emulation'),
    run,
    log,
    firstTime,
    previousVersion: firstTime ? undefined : 3,
    startHidden:
      startHidden ??
      vi.fn(() => {
        throw new Error('never started')
      })
  }
}

/** A fake Ryujinx that writes `content` (in two steps, like a streamed write) and runs until stopped. */
function fakeRyujinx(
  content: string | null
): PresetContext['startHidden'] & ReturnType<typeof vi.fn> {
  return vi.fn((): HiddenProcess => {
    let resolveExit: (code: number | null) => void = () => {}
    const exited = new Promise<number | null>((r) => (resolveExit = r))
    if (content !== null) {
      void (async () => {
        await writeFile(configFile(), content.slice(0, 20))
        await new Promise((r) => setTimeout(r, 30))
        await writeFile(configFile(), content)
      })()
    }
    return {
      exited,
      stop: vi.fn(async () => resolveExit(null))
    }
  }) as unknown as PresetContext['startHidden'] & ReturnType<typeof vi.fn>
}

const sdl2 = (): Promise<void> => writeFile(join(E, 'SDL2.dll'), 'MZ')

describe('ryujinx controller ids', () => {
  it('formats SDL GUID bytes like System.Guid with the first four hex digits zeroed', () => {
    expect(ryujinxPadId(guidBytes(XBOX_GUID), 0)).toBe(XBOX_ID)
    const bytes = Array.from({ length: 16 }, (_, i) => i * 16 + i)
    // b1 b0 - b5 b4 - b7 b6 - b8 b9 - b10..b15
    expect(ryujinxPadId(bytes, 2)).toBe('2-00001100-5544-7766-8899-aabbccddeeff')
  })

  it('numbers identical pads in SDL order and skips empty GUIDs', () => {
    expect(
      ryujinxPadIds([
        { guid: XBOX_GUID, name: 'Xbox Series X Controller' },
        { guid: '0'.repeat(32), name: 'Broken' },
        { guid: DS4_GUID, name: 'PS4 Controller' },
        { guid: XBOX_GUID, name: 'Xbox Series X Controller' }
      ])
    ).toEqual([
      { id: XBOX_ID, name: 'Xbox Series X Controller' },
      { id: '0-00000003-054c-0000-cc09-000000006800', name: 'PS4 Controller' },
      { id: '1-00000003-045e-0000-120b-000000000000', name: 'Xbox Series X Controller' }
    ])
  })
})

describe('ryujinx SDL detection script', () => {
  it('loads the DLL by absolute path, sets the Ryujinx hints and prints JSON', () => {
    const script = sdlPadsScript("C:\\Emu's\\Ryujinx\\SDL2.dll", RYUJINX_SDL_HINTS)
    expect(script).toContain(
      '[DllImport(@"C:\\Emu\'s\\Ryujinx\\SDL2.dll", CallingConvention = CallingConvention.Cdecl)]'
    )
    expect(script).toContain("Add-Type -TypeDefinition @'")
    for (const [k, v] of RYUJINX_SDL_HINTS) expect(script).toContain(`SDL_SetHint('${k}', '${v}')`)
    expect(script).toContain('SDL_Init(0x6200)')
    expect(script).toContain('SDL_IsGameController($i)')
    expect(script).toContain('SDL_JoystickGetDeviceGUID($i)')
    expect(script).toContain('SDL_Quit()')
    expect(script).toContain('ConvertTo-Json')
    // The here-string terminator must start its own line.
    expect(script.split('\n')).toContain("'@")
  })

  it('parses the output and drops malformed pads', () => {
    expect(
      parseSdlPads(
        '\uFEFF{"pads":[{"guid":"' + XBOX_GUID.toUpperCase() + '","name":"X"},{"guid":"zz"}]}'
      )
    ).toEqual([{ guid: XBOX_GUID, name: 'X' }])
    expect(parseSdlPads('{"pads":[]}')).toEqual([])
    expect(parseSdlPads('garbage')).toBeNull()
  })
})

describe('ryujinx controller merge', () => {
  const pad1 = { id: XBOX_ID, name: 'Xbox Series X Controller' }
  const pad2 = { id: '0-00000003-054c-0000-cc09-000000006800', name: 'PS4 Controller' }

  it('replaces only the untouched default keyboard, one entry per pad', () => {
    expect(isDefaultInput([keyboard()])).toBe(true)
    const r = mergeControllers([keyboard()], [pad1, pad2], [])!
    expect(r.input).toEqual([
      gamepadEntry(XBOX_ID, 'Xbox Series X Controller (0)', 'Player1'),
      gamepadEntry(pad2.id, 'PS4 Controller (0)', 'Player2')
    ])
    expect(r.owned).toEqual([XBOX_ID, pad2.id])
    expect(r.input[0].right_joycon).toMatchObject({
      button_a: 'B',
      button_b: 'A',
      button_x: 'Y',
      button_y: 'X'
    })
    expect(r.input[0].backend).toBe('GamepadSDL2')
  })

  it('caps at four players and uses the Nintendo face layout for Nintendo pads', () => {
    const pads = Array.from({ length: 6 }, (_, i) => ({
      id: `${i}-0000x`,
      name: 'Nintendo Switch Pro Controller'
    }))
    const r = mergeControllers([keyboard()], pads, [])!
    expect(r.input.map((e) => e.player_index)).toEqual(['Player1', 'Player2', 'Player3', 'Player4'])
    expect(r.input.map((e) => e.name)).toEqual([
      'Nintendo Switch Pro Controller (0)',
      'Nintendo Switch Pro Controller (1)',
      'Nintendo Switch Pro Controller (2)',
      'Nintendo Switch Pro Controller (3)'
    ])
    expect(r.input[0].right_joycon).toMatchObject({
      button_a: 'A',
      button_b: 'B',
      button_x: 'X',
      button_y: 'Y'
    })
  })

  it('never touches a configuration the user changed', () => {
    const user = { ...keyboard(), name: 'Keyboard', player_index: 'Player2' }
    expect(mergeControllers([user], [pad1], [])).toBeNull()
    expect(
      mergeControllers([keyboard(), gamepadEntry('x', 'Mine (0)', 'Player2')], [pad1], [])
    ).toBeNull()
  })

  it('leaves everything when no pad is detected', () => {
    expect(mergeControllers([keyboard()], [], [])).toBeNull()
  })

  it('updates only owned entries, keeps the user entries and their slots', () => {
    const userEntry = gamepadEntry('user-pad', 'Mine (0)', 'Player1')
    const owned = { ...gamepadEntry(XBOX_ID, 'Xbox (0)', 'Player2'), deadzone_left: 0.2 }
    // Same pad still connected: nothing to do.
    expect(mergeControllers([userEntry, owned], [pad1], [XBOX_ID])).toBeNull()
    // A new pad arrived first in SDL order: it takes the first free slot, the known one keeps its tweaks.
    const r = mergeControllers([userEntry, owned], [pad2, pad1], [XBOX_ID])!
    expect(r.input[0]).toBe(userEntry)
    expect(r.input[1]).toMatchObject({ id: pad2.id, player_index: 'Player2' })
    expect(r.input[2]).toMatchObject({ id: XBOX_ID, player_index: 'Player3', deadzone_left: 0.2 })
    expect(r.owned).toEqual([pad2.id, XBOX_ID])
    // The owned pad was replaced by another one: the new pad takes player 2, the old entry stays for hot-plug.
    const swapped = mergeControllers([userEntry, owned], [pad2], [XBOX_ID])!
    expect(swapped.input.map((e) => [e.id, e.player_index])).toEqual([
      ['user-pad', 'Player1'],
      [pad2.id, 'Player2'],
      [XBOX_ID, 'Player3']
    ])
  })
})

describe('ryujinx presets', () => {
  it('generates Config.json with Ryujinx itself, then sets fullscreen and the detected pads', async () => {
    await rm(join(E, 'portable'), { recursive: true })
    await sdl2()
    const startHidden = fakeRyujinx(JSON.stringify(defaultConfig(), null, 2))
    const run = runner([{ guid: XBOX_GUID, name: 'Xbox Series X Controller' }])
    await applyPresets(ctx(run, true, startHidden))

    expect(startHidden).toHaveBeenCalledWith(join(E, 'Ryujinx.exe'), [], { cwd: E })
    const proc = startHidden.mock.results[0].value as HiddenProcess
    expect(proc.stop).toHaveBeenCalled()
    const cfg = await readJson(configFile())
    expect(Object.keys(cfg)).toEqual(Object.keys(defaultConfig()))
    expect(cfg.start_fullscreen).toBe(true)
    expect(cfg.input_config).toEqual([
      gamepadEntry(XBOX_ID, 'Xbox Series X Controller (0)', 'Player1')
    ])
    expect(await readJson(stateFile())).toEqual({ ids: [XBOX_ID] })
    await expect(stat(join(E, 'Config.json'))).rejects.toThrow()
  })

  it('merges into an existing file, keeps its line endings, and is idempotent', async () => {
    await sdl2()
    const original = JSON.stringify(defaultConfig(), null, 2).replace(/\n/g, '\r\n')
    await writeFile(configFile(), '\uFEFF' + original)
    const run = runner([{ guid: XBOX_GUID, name: 'Xbox Series X Controller' }])
    await applyPresets(ctx(run, true))
    const once = await readFile(configFile(), 'utf8')
    expect(once.charCodeAt(0)).not.toBe(0xfeff)
    expect(once).toContain('\r\n  "start_fullscreen": true,\r\n')
    await applyPresets(ctx(run, false))
    expect(await readFile(configFile(), 'utf8')).toBe(once)
  })

  it('does not turn fullscreen back on after the first time', async () => {
    await writeFile(configFile(), JSON.stringify(defaultConfig(), null, 2))
    await applyPresets(ctx(runner([]), false))
    expect((await readJson(configFile())).start_fullscreen).toBe(false)
  })

  it('keeps the keyboard and the file when SDL2.dll is missing, detection fails or no pad is found', async () => {
    const original = JSON.stringify(
      defaultConfig({
        start_fullscreen: true,
        autoload_dirs: [ryujinxUpdatesDir(join(dir, 'Emulation'))]
      }),
      null,
      2
    )
    await writeFile(configFile(), original)
    const run = runner([{ guid: XBOX_GUID, name: 'X' }])
    await applyPresets(ctx(run, false))
    expect(await readFile(configFile(), 'utf8')).toBe(original)
    expect(run.mock.calls.some((c) => c[0] === 'powershell.exe')).toBe(false)

    await sdl2()
    await applyPresets(ctx(runner(null), false))
    await applyPresets(ctx(runner([]), false))
    expect(await readFile(configFile(), 'utf8')).toBe(original)
    expect(await readJson(stateFile())).toEqual({ ids: [] })
  })

  it('defers (no write) while Ryujinx is running or when it was started during the presets', async () => {
    await writeFile(configFile(), JSON.stringify(defaultConfig(), null, 2))
    const before = await readFile(configFile(), 'utf8')
    await expect(applyPresets(ctx(runner([], true), true))).rejects.toBeInstanceOf(
      PresetDeferredError
    )
    expect(await readFile(configFile(), 'utf8')).toBe(before)

    await sdl2()
    let started = false
    const run = runner(
      [{ guid: XBOX_GUID, name: 'X' }],
      () => started,
      () => (started = true)
    )
    await expect(applyPresets(ctx(run, true))).rejects.toBeInstanceOf(PresetDeferredError)
    expect(await readFile(configFile(), 'utf8')).toBe(before)
    await expect(stat(stateFile())).rejects.toThrow()
  })

  it('throws (so it is retried) when Config.json cannot be generated or read', async () => {
    await rm(join(E, 'portable'), { recursive: true })
    const exits = vi.fn((): HiddenProcess => ({ exited: Promise.resolve(1), stop: async () => {} }))
    const failed = applyPresets(ctx(runner([]), true, exits))
    await expect(failed).rejects.toThrow('Ryujinx did not write its default Config.json')
    await expect(failed).rejects.not.toBeInstanceOf(PresetDeferredError)

    await writeFile(configFile(), '{ broken')
    await expect(applyPresets(ctx(runner([]), true))).rejects.toThrow('cannot be read')
    expect(await readFile(configFile(), 'utf8')).toBe('{ broken')
  })

  it('accepts a newer Config.json version but leaves its controllers alone', async () => {
    await rm(join(E, 'portable'), { recursive: true })
    await sdl2()
    const newer = defaultConfig({ version: 71 })
    const startHidden = fakeRyujinx(JSON.stringify(newer, null, 2))
    const run = runner([{ guid: XBOX_GUID, name: 'Xbox' }])
    await applyPresets(ctx(run, true, startHidden))
    const cfg = await readJson(configFile())
    expect(cfg.version).toBe(71)
    expect(cfg.start_fullscreen).toBe(true)
    expect(cfg.input_config).toEqual([keyboard()])
    expect(run.mock.calls.some((c) => c[0] === 'powershell.exe')).toBe(false)

    // A newer format without start_fullscreen does not get the key added.
    const { start_fullscreen: _drop, ...noKey } = newer
    void _drop
    await writeFile(configFile(), JSON.stringify(noKey, null, 2))
    await applyPresets(ctx(run, true))
    expect('start_fullscreen' in (await readJson(configFile()))).toBe(false)
  })

  it('keeps polling while Ryujinx holds Config.json locked (EBUSY)', async () => {
    const realRead = fsp.readFile.bind(fsp)
    let busy = 3
    vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: Parameters<typeof realRead>) => {
      if (String(args[0]) === configFile() && busy-- > 0) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      }
      return realRead(...args)
    }) as typeof fsp.readFile)
    const startHidden = fakeRyujinx(JSON.stringify(defaultConfig(), null, 2))
    const ok = await generateRyujinxConfig(ctx(runner([]), true, startHidden), configFile(), {
      timeoutMs: 5000,
      intervalMs: 10
    })
    expect(ok).toBe(true)
    expect(busy).toBeLessThan(0)
  })

  it('stops a Ryujinx that never writes the file and leaves nothing behind', async () => {
    const startHidden = fakeRyujinx(null)
    const ok = await generateRyujinxConfig(ctx(runner([]), true, startHidden), configFile(), {
      timeoutMs: 100,
      intervalMs: 10
    })
    expect(ok).toBe(false)
    expect((startHidden.mock.results[0].value as HiddenProcess).stop).toHaveBeenCalled()
    await expect(stat(configFile())).rejects.toThrow()
  })
})

describe("Ryujinx's updates and DLC folder", () => {
  it('adds Updates and DLC/Switch to autoload_dirs, keeping the user folders, once', async () => {
    const updates = ryujinxUpdatesDir(join(dir, 'Emulation'))
    expect(updates).toBe(join(dir, 'Emulation', 'Updates and DLC', 'Switch'))
    await writeFile(
      configFile(),
      JSON.stringify(defaultConfig({ autoload_dirs: ['D:/Mine'] }), null, 2)
    )
    await applyPresets(ctx(runner([]), false))
    expect((await readJson(configFile())).autoload_dirs).toEqual(['D:/Mine', updates])
    expect((await stat(updates)).isDirectory()).toBe(true)
    const once = await readFile(configFile(), 'utf8')
    await applyPresets(ctx(runner([]), false))
    expect(await readFile(configFile(), 'utf8')).toBe(once)
  })

  it('adds it before a launch of an older setup, without touching the controllers', async () => {
    await writeFile(configFile(), JSON.stringify(defaultConfig(), null, 2))
    await writeFile(stateFile(), JSON.stringify({ ids: [] }))
    await refreshRyujinxControllers({
      emuDir: E,
      run: runner([]),
      log,
      dataDir: join(dir, 'Emulation')
    })
    const cfg = await readJson(configFile())
    expect(cfg.autoload_dirs).toEqual([ryujinxUpdatesDir(join(dir, 'Emulation'))])
    expect(cfg.input_config).toEqual([keyboard()])
  })

  it('adds the key only to the Config.json format it knows', () => {
    const older: Record<string, unknown> = { version: 60 }
    expect(addAutoloadDir(older, 'C:/U')).toBe(false)
    expect(older).toEqual({ version: 60 })
    const known: Record<string, unknown> = { version: 70 }
    expect(addAutoloadDir(known, 'C:/U')).toBe(true)
    expect(known.autoload_dirs).toEqual(['C:/U'])
    expect(addAutoloadDir({ version: 71, autoload_dirs: ['c:/u'] }, 'C:/U')).toBe(false)
  })
})

describe('refreshRyujinxControllers', () => {
  it('does nothing when the presets never ran', async () => {
    await sdl2()
    await writeFile(configFile(), JSON.stringify(defaultConfig(), null, 2))
    const run = runner([{ guid: XBOX_GUID, name: 'X' }])
    await refreshRyujinxControllers({ emuDir: E, run, log })
    expect(run).not.toHaveBeenCalled()
  })

  it('sets up a pad connected after setup, then follows a changed pad in its own entries only', async () => {
    await sdl2()
    await writeFile(configFile(), JSON.stringify(defaultConfig(), null, 2))
    await applyPresets(ctx(runner([]), true))
    expect((await readJson(configFile())).input_config).toEqual([keyboard()])

    await refreshRyujinxControllers({
      emuDir: E,
      run: runner([{ guid: XBOX_GUID, name: 'Xbox' }]),
      log
    })
    expect((await readJson(configFile())).input_config).toEqual([
      gamepadEntry(XBOX_ID, 'Xbox (0)', 'Player1')
    ])

    await refreshRyujinxControllers({
      emuDir: E,
      run: runner([{ guid: DS4_GUID, name: 'PS4 Controller' }]),
      log
    })
    const input = (await readJson(configFile())).input_config as InputConfigEntry[]
    expect(input.map((e) => [e.id, e.player_index])).toEqual([
      ['0-00000003-054c-0000-cc09-000000006800', 'Player1'],
      [XBOX_ID, 'Player2']
    ])
    expect(await readJson(stateFile())).toEqual({
      ids: ['0-00000003-054c-0000-cc09-000000006800', XBOX_ID]
    })
  })

  it('leaves the user’s own entries and does nothing while Ryujinx runs', async () => {
    await sdl2()
    const userInput = [gamepadEntry('user', 'Mine (0)', 'Player1')]
    await writeFile(
      configFile(),
      JSON.stringify(defaultConfig({ input_config: userInput }), null, 2)
    )
    await writeFile(stateFile(), JSON.stringify({ ids: [] }))
    const before = await readFile(configFile(), 'utf8')
    await refreshRyujinxControllers({
      emuDir: E,
      run: runner([{ guid: XBOX_GUID, name: 'X' }]),
      log
    })
    expect(await readFile(configFile(), 'utf8')).toBe(before)

    await writeFile(configFile(), JSON.stringify(defaultConfig(), null, 2))
    const run = runner([{ guid: XBOX_GUID, name: 'X' }], true)
    await refreshRyujinxControllers({ emuDir: E, run, log })
    expect((await readJson(configFile())).input_config).toEqual([keyboard()])
    expect(run.mock.calls.some((c) => c[0] === 'powershell.exe')).toBe(false)
  })

  it('writes nothing once the launch stopped waiting (aborted) or Ryujinx was started meanwhile', async () => {
    await sdl2()
    await writeFile(configFile(), JSON.stringify(defaultConfig(), null, 2))
    await writeFile(stateFile(), JSON.stringify({ ids: [] }))
    const before = await readFile(configFile(), 'utf8')

    const abort = new AbortController()
    await refreshRyujinxControllers({
      emuDir: E,
      run: runner([{ guid: XBOX_GUID, name: 'X' }], false, () => abort.abort()),
      log,
      signal: abort.signal
    })
    expect(await readFile(configFile(), 'utf8')).toBe(before)

    let started = false
    await refreshRyujinxControllers({
      emuDir: E,
      run: runner(
        [{ guid: XBOX_GUID, name: 'X' }],
        () => started,
        () => (started = true)
      ),
      log
    })
    expect(await readFile(configFile(), 'utf8')).toBe(before)
    expect(await readJson(stateFile())).toEqual({ ids: [] })
  })
})
