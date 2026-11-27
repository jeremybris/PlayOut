import { EventEmitter } from 'events'
import type { ChildProcess, SpawnOptions } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { defaultSettings } from '../../shared/defaults'
import type { Game, LaunchError, PlayOutEvents } from '../../shared/types'
import type { EmulationService, LaunchResolution } from '../emulation/types'
import { EventBus } from '../events'
import type { Logger } from '../logger'
import type { ActiveSession } from '../services/library-service'
import { runPowerShell, type PowerShellResult } from '../system/powershell'
import { ALLOWED_INSTALL_SCHEMES } from '../installs/install-uri'
import {
  ALLOWED_LAUNCH_SCHEMES,
  buildSpawnCommand,
  createGameLauncher,
  elevatedStartScript,
  isAllowedLaunchUri,
  isProtectedProcess,
  planLaunch,
  quoteCmdArg,
  quoteWindowsArg,
  safeHandoffDir,
  tokenizeArgs,
  type SpawnCommand,
  type SpawnCommandResult
} from './launcher'
import { createProcessMonitor, type ProcessInfo } from './process-monitor'
import {
  createSessionTracker,
  type SessionTracker,
  type TrackedLaunch,
  type TrackedSession
} from './session-tracker'
import type { LauncherService } from './types'

const systemRoot = process.env['SystemRoot'] || 'C:\\Windows'
const system32 = join(systemRoot, 'System32')
const notepad = join(system32, 'notepad.exe')
const haveNotepad = process.platform === 'win32' && existsSync(notepad)

function collectingLog(): Logger & { lines: string[] } {
  const lines: string[] = []
  const push = (...a: unknown[]): void => {
    lines.push(a.join(' '))
  }
  return { lines, debug: push, info: push, warn: push, error: push }
}

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'manual:notepad',
    source: 'manual',
    externalId: 'notepad',
    platformId: 'windows',
    title: 'Notepad',
    sortTitle: 'notepad',
    installed: true,
    launch: { kind: 'exec', file: notepad, args: [] },
    tracking: { mode: 'spawned' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'none',
    user: {},
    ...overrides
  }
}

function fakeEmulation(
  resolution: LaunchResolution
): EmulationService & { resolveLaunch: ReturnType<typeof vi.fn> } {
  return { resolveLaunch: vi.fn(async () => resolution) } as unknown as EmulationService & {
    resolveLaunch: ReturnType<typeof vi.fn>
  }
}

const noEmulation = (): EmulationService =>
  fakeEmulation({
    ok: false,
    error: { kind: 'failed', message: 'resolveLaunch must not be called' }
  })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitUntil(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await sleep(25)
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('tokenizeArgs', () => {
  it('splits on whitespace and drops empty input', () => {
    expect(tokenizeArgs('')).toEqual([])
    expect(tokenizeArgs('   ')).toEqual([])
    expect(tokenizeArgs('  -a   -b\t-c ')).toEqual(['-a', '-b', '-c'])
  })

  it('groups double-quoted text and removes the quotes', () => {
    expect(tokenizeArgs('-f "C:\\Program Files\\Game" --x=1')).toEqual([
      '-f',
      'C:\\Program Files\\Game',
      '--x=1'
    ])
    expect(tokenizeArgs('a"b c"d')).toEqual(['ab cd'])
    expect(tokenizeArgs('"" a')).toEqual(['', 'a'])
  })

  it('keeps an escaped quote and closes an unterminated one at the end', () => {
    expect(tokenizeArgs('--title=\\"Quoted\\"')).toEqual(['--title="Quoted"'])
    expect(tokenizeArgs('"unterminated arg')).toEqual(['unterminated arg'])
  })

  it('leaves path backslashes alone', () => {
    expect(tokenizeArgs('C:\\path\\to\\rom.zip -L "C:\\cores\\snes9x_libretro.dll"')).toEqual([
      'C:\\path\\to\\rom.zip',
      '-L',
      'C:\\cores\\snes9x_libretro.dll'
    ])
  })
})

describe('quoteWindowsArg', () => {
  it('quotes only what CommandLineToArgvW needs', () => {
    expect(quoteWindowsArg('plain')).toBe('plain')
    expect(quoteWindowsArg('C:\\no\\spaces\\')).toBe('C:\\no\\spaces\\')
    expect(quoteWindowsArg('')).toBe('""')
    expect(quoteWindowsArg('a b')).toBe('"a b"')
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('doubles backslashes that precede a quote or the end of a quoted argument', () => {
    expect(quoteWindowsArg('C:\\my dir\\')).toBe('"C:\\my dir\\\\"')
    expect(quoteWindowsArg('x\\"y')).toBe('"x\\\\\\"y"')
  })
})

describe('buildSpawnCommand', () => {
  const comspec = process.env['ComSpec'] || 'cmd.exe'

  it('passes executables through unchanged', () => {
    expect(buildSpawnCommand('C:\\G\\game.exe', ['-a', 'b c'])).toEqual({
      file: 'C:\\G\\game.exe',
      args: ['-a', 'b c'],
      verbatim: false
    })
  })

  function command(result: SpawnCommandResult): SpawnCommand {
    if ('error' in result) throw new Error(`unexpected error: ${result.error.message}`)
    return result
  }

  function error(result: SpawnCommandResult): LaunchError {
    if (!('error' in result)) throw new Error(`expected an error, got ${result.args.join(' ')}`)
    return result.error
  }

  it('wraps batch files in cmd /d /s /V:OFF /c with every token quoted for cmd', () => {
    const cmd = command(buildSpawnCommand('C:\\My Games\\run.bat', ['--full screen', '-x']))
    expect(cmd.file).toBe(comspec)
    expect(cmd.verbatim).toBe(true)
    expect(cmd.args).toEqual([
      '/d',
      '/s',
      '/V:OFF',
      '/c',
      '""C:\\My Games\\run.bat" "--full screen" "-x""'
    ])
    expect(command(buildSpawnCommand('C:\\x\\RUN.CMD', [])).args).toEqual([
      '/d',
      '/s',
      '/V:OFF',
      '/c',
      '""C:\\x\\RUN.CMD""'
    ])
  })

  it('quotes cmd metacharacters so a .commands or extraArgs token cannot chain a command', () => {
    const cmd = command(
      buildSpawnCommand('C:\\emu\\ra.bat', ['foo', '&', 'calc', 'a|b', '<x>', '^y'])
    )
    const line = cmd.args[cmd.args.length - 1]
    expect(line).toBe('""C:\\emu\\ra.bat" "foo" "&" "calc" "a|b" "<x>" "^y""')
    // Nothing outside the quotes but spaces: every metacharacter sits inside a quoted token.
    expect(line.slice(1, -1).replace(/"[^"]*"/g, '')).toMatch(/^ *$/)
    // A path with `&` and no spaces is quoted too, for the `start ""` fallback as well.
    expect(command(buildSpawnCommand('C:\\a&b\\run.bat', [])).args.at(-1)).toBe(
      '""C:\\a&b\\run.bat""'
    )
    expect(command(buildSpawnCommand('C:\\a&b\\Game.lnk', [])).args.at(-1)).toBe(
      '"start "" "C:\\a&b\\Game.lnk""'
    )
  })

  it('refuses tokens cmd would still interpret inside quotes', () => {
    expect(quoteCmdArg('plain')).toBe('"plain"')
    expect(quoteCmdArg('a b & c')).toBe('"a b & c"')
    expect(quoteCmdArg('a%PATH%b')).toBeNull()
    expect(quoteCmdArg('say"hi')).toBeNull()
    expect(quoteCmdArg('a\r\nb')).toBeNull()
    for (const bad of ['a%PATH%b', 'say"hi', 'line\nbreak']) {
      const err = error(buildSpawnCommand('C:\\emu\\ra.bat', ['ok', bad]))
      expect(err.kind).toBe('failed')
      expect(err.message).toContain('cmd.exe would interpret')
    }
    expect(error(buildSpawnCommand('C:\\100%\\run.bat', [])).kind).toBe('failed')
    // `!` is inert because delayed expansion is off (/V:OFF), so it is allowed through.
    expect(command(buildSpawnCommand('C:\\emu\\ra.bat', ['a!b'])).args.at(-1)).toBe(
      '""C:\\emu\\ra.bat" "a!b""'
    )
    // Executables never go through cmd, so the same tokens are fine there.
    expect(buildSpawnCommand('C:\\G\\game.exe', ['a%PATH%b', '&'])).toEqual({
      file: 'C:\\G\\game.exe',
      args: ['a%PATH%b', '&'],
      verbatim: false
    })
  })

  it('starts an unresolved shortcut through `start ""`', () => {
    const cmd = command(buildSpawnCommand('C:\\Users\\me\\Desktop\\Game.lnk', []))
    expect(cmd.file).toBe(comspec)
    expect(cmd.args).toEqual([
      '/d',
      '/s',
      '/V:OFF',
      '/c',
      '"start "" "C:\\Users\\me\\Desktop\\Game.lnk""'
    ])
  })
})

describe('elevatedStartScript', () => {
  it('builds a Start-Process -Verb RunAs line with one pre-quoted argument string', () => {
    const script = elevatedStartScript({
      file: "C:\\Games\\O'Neil\\game.exe",
      args: ['-x', 'a b'],
      cwd: 'C:\\Games',
      hideWindow: false
    })
    expect(script).toBe(
      "$p = Start-Process -FilePath 'C:\\Games\\O''Neil\\game.exe' -WorkingDirectory 'C:\\Games'" +
        ' -ArgumentList \'-x "a b"\' -Verb RunAs -PassThru\n$p.Id'
    )
    // No -ArgumentList at all without arguments (PowerShell 5.1 rejects an empty one); cwd defaults to the folder.
    expect(
      elevatedStartScript({ file: 'C:\\G\\game.exe', args: [], cwd: undefined, hideWindow: true })
    ).toBe(
      "$p = Start-Process -FilePath 'C:\\G\\game.exe' -WorkingDirectory 'C:\\G' -WindowStyle Hidden -Verb RunAs -PassThru\n$p.Id"
    )
  })
})

describe('safeHandoffDir', () => {
  it('rejects roots that host unrelated processes', () => {
    expect(safeHandoffDir(undefined)).toBeUndefined()
    expect(safeHandoffDir('C:')).toBeUndefined()
    expect(safeHandoffDir('C:\\')).toBeUndefined()
    expect(safeHandoffDir('relative\\dir')).toBeUndefined()
    expect(safeHandoffDir(systemRoot)).toBeUndefined()
    expect(safeHandoffDir(system32)).toBeUndefined()
    expect(safeHandoffDir(process.env['ProgramFiles'] || 'C:\\Program Files')).toBeUndefined()
    expect(safeHandoffDir(process.env['USERPROFILE'] || 'C:\\Users\\me')).toBeUndefined()
    expect(safeHandoffDir('C:\\Users')).toBeUndefined()
  })

  it('keeps game folders as given', () => {
    expect(safeHandoffDir('C:\\Games\\Portal 2\\')).toBe('C:\\Games\\Portal 2\\')
    expect(safeHandoffDir('D:\\Emulators\\RetroArch')).toBe('D:\\Emulators\\RetroArch')
    expect(
      safeHandoffDir(join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Some Game'))
    ).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// planLaunch
// ---------------------------------------------------------------------------

describe('planLaunch', () => {
  it('passes URIs through', async () => {
    const game = makeGame({ launch: { kind: 'uri', uri: 'steam://rungameid/620' } })
    expect(await planLaunch(game, undefined, noEmulation(), collectingLog())).toEqual({
      kind: 'uri',
      uri: 'steam://rungameid/620'
    })
  })

  it('passes every store client scheme the providers and the owned records emit', async () => {
    const uris = [
      'steam://rungameid/620',
      'com.epicgames.launcher://apps/ns%3Aid%3AApp?action=launch&silent=true',
      'origin2://game/launch?offerIds=OFB-EAST:109552316',
      'origin2://library/open',
      'battlenet://Pro',
      'uplay://launch/5541/0',
      'goggalaxy://openGameView/1207658924',
      'msxbox://game/?productId=9NBLGGH4R315',
      'ms-windows-store://pdp/?ProductId=9NBLGGH4R315',
      'STEAM://rungameid/620'
    ]
    for (const uri of uris) {
      expect(isAllowedLaunchUri(uri)).toBe(true)
      const game = makeGame({ launch: { kind: 'uri', uri } })
      expect(await planLaunch(game, undefined, noEmulation(), collectingLog())).toEqual({
        kind: 'uri',
        uri
      })
    }
    expect([...ALLOWED_LAUNCH_SCHEMES].sort()).toEqual(
      [...ALLOWED_INSTALL_SCHEMES].map(String).sort()
    )
  })

  it('refuses a URI whose scheme is not a store client, with a message naming it', async () => {
    const refused = [
      'https://evil.example/x',
      'http://evil.example/x',
      'file:///C:/Windows/System32/calc.exe',
      'ms-settings:appsfeatures',
      'search-ms:query=x',
      'javascript:alert(1)',
      ' steam://rungameid/620',
      'C:\\Windows\\System32\\calc.exe'
    ]
    for (const uri of refused) {
      const game = makeGame({ title: 'Portal 2', launch: { kind: 'uri', uri } })
      const plan = await planLaunch(game, undefined, noEmulation(), collectingLog())
      expect(plan).toMatchObject({ error: { kind: 'failed' } })
    }
    const https = await planLaunch(
      makeGame({ title: 'Portal 2', launch: { kind: 'uri', uri: 'https://evil.example/x' } }),
      undefined,
      noEmulation(),
      collectingLog()
    )
    expect(https).toEqual({
      error: {
        kind: 'failed',
        message:
          "Portal 2 cannot be started: its launch link uses https: which is not a store client's link"
      }
    })
    const empty = await planLaunch(
      makeGame({ title: 'Portal 2', launch: { kind: 'uri', uri: '' } }),
      undefined,
      noEmulation(),
      collectingLog()
    )
    expect(empty).toEqual({
      error: { kind: 'failed', message: 'Portal 2 cannot be started: it has no usable launch link' }
    })
  })

  it('never hands a refused URI to the shell, and leaves the running session alone', async () => {
    const tracker = fakeTracker()
    const opened: string[] = []
    const launcher = createGameLauncher({
      emulation: noEmulation(),
      tracker,
      log: collectingLog(),
      io: {
        async openExternal(uri) {
          opened.push(uri)
        }
      }
    })
    const result = await launcher.launch(
      makeGame({ id: 'steam:620', launch: { kind: 'uri', uri: 'https://evil.example/x' } })
    )
    expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } })
    expect(opened).toEqual([])
    expect(tracker.calls).toEqual([])
    launcher.dispose()
  })

  it('reports a missing executable with its path', async () => {
    const game = makeGame({ launch: { kind: 'exec', file: 'C:\\nope\\missing.exe', args: [] } })
    expect(await planLaunch(game, undefined, noEmulation(), collectingLog())).toEqual({
      error: { kind: 'file-missing', message: 'Executable not found: C:\\nope\\missing.exe' }
    })
  })

  it.skipIf(!haveNotepad)(
    'builds an exec plan with tokenized extra args and a safe working directory',
    async () => {
      const log = collectingLog()
      const game = makeGame({
        launch: { kind: 'exec', file: notepad, args: ['/A'], cwd: 'C:\\does\\not\\exist' },
        user: { extraArgs: '"C:\\My Notes\\todo.txt" /x' }
      })
      const plan = await planLaunch(game, undefined, noEmulation(), log)
      expect(plan).toMatchObject({
        kind: 'spawn',
        file: notepad,
        args: ['/A', 'C:\\My Notes\\todo.txt', '/x'],
        hideWindow: false,
        runInBackground: false,
        handoffDir: undefined
      })
      expect((plan as { cwd: string }).cwd.toLowerCase()).toBe(system32.toLowerCase())
      expect(
        log.lines.some((l) => /working directory C:\\does\\not\\exist does not exist/.test(l))
      ).toBe(true)

      const withDir = await planLaunch(
        makeGame({ installDir: 'C:\\Games\\Notes' }),
        undefined,
        noEmulation(),
        log
      )
      expect(withDir).toMatchObject({ kind: 'spawn', handoffDir: 'C:\\Games\\Notes' })
      expect((withDir as { cwd: string }).cwd.toLowerCase()).toBe(system32.toLowerCase())
    }
  )

  it('returns the emulation error unchanged and asks for the chosen emulator', async () => {
    const error: LaunchError = {
      kind: 'emulator-missing',
      message: 'RetroArch not found',
      emulatorId: 'retroarch'
    }
    const emulation = fakeEmulation({ ok: false, error })
    const game = makeGame({
      id: 'rom:snes:abc',
      source: 'rom',
      romPath: 'C:\\ROMs\\snes\\game.sfc',
      launch: { kind: 'emulator', systemId: 'snes', romPath: 'C:\\ROMs\\snes\\game.sfc' },
      user: { emulatorId: 'snes9x' }
    })
    const plan = await planLaunch(game, { emulatorId: 'retroarch' }, emulation, collectingLog())
    expect(plan).toEqual({ error })
    expect((plan as { error: LaunchError }).error).toBe(error)
    expect(emulation.resolveLaunch).toHaveBeenCalledWith(game, 'retroarch')

    await planLaunch(game, undefined, emulation, collectingLog())
    expect(emulation.resolveLaunch).toHaveBeenLastCalledWith(game, 'snes9x')
  })

  it('checks that the resolved emulator and the ROM exist', async () => {
    const rom = 'C:\\ROMs\\snes\\missing.sfc'
    const game = makeGame({
      romPath: rom,
      launch: { kind: 'emulator', systemId: 'snes', romPath: rom }
    })
    const missingEmu = fakeEmulation({
      ok: true,
      file: 'C:\\Emulators\\missing\\emu.exe',
      args: [rom],
      runInBackground: false,
      hideWindow: false
    })
    expect(await planLaunch(game, undefined, missingEmu, collectingLog())).toEqual({
      error: {
        kind: 'file-missing',
        message: 'Emulator not found: C:\\Emulators\\missing\\emu.exe'
      }
    })
    if (!haveNotepad) return
    const missingRom = fakeEmulation({
      ok: true,
      file: notepad,
      args: [rom],
      runInBackground: false,
      hideWindow: false
    })
    expect(await planLaunch(game, undefined, missingRom, collectingLog())).toEqual({
      error: { kind: 'file-missing', message: `ROM not found: ${rom}` }
    })
  })

  it.skipIf(!haveNotepad)(
    'builds an emulator plan honouring hideWindow, runInBackground and cwd',
    async () => {
      // A directory ROM (dirExtensions systems) only needs to exist.
      const rom = system32
      const game = makeGame({
        romPath: rom,
        launch: { kind: 'emulator', systemId: 'ps3', romPath: rom }
      })
      const emulation = fakeEmulation({
        ok: true,
        file: notepad,
        args: ['--no-gui', rom],
        cwd: systemRoot,
        runInBackground: true,
        hideWindow: true
      })
      expect(await planLaunch(game, undefined, emulation, collectingLog())).toEqual({
        kind: 'spawn',
        file: notepad,
        args: ['--no-gui', rom],
        cwd: systemRoot,
        hideWindow: true,
        runInBackground: true,
        handoffDir: undefined,
        rom
      })
    }
  )

  it('launches packaged apps through explorer.exe', async () => {
    const game = makeGame({
      launch: { kind: 'uwp', aumid: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' }
    })
    expect(await planLaunch(game, undefined, noEmulation(), collectingLog())).toEqual({
      kind: 'spawn',
      file: 'explorer.exe',
      args: ['shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'],
      cwd: undefined,
      hideWindow: false,
      runInBackground: false,
      handoffDir: undefined
    })
  })
})

// ---------------------------------------------------------------------------
// createGameLauncher with fake IO and tracker
// ---------------------------------------------------------------------------

interface FakeTracker extends SessionTracker {
  calls: string[]
  launches: TrackedLaunch[]
  /** What gameProcesses() answers; a function to answer differently per call, an Error to throw. */
  processes: ProcessInfo[] | Error | (() => ProcessInfo[] | Error)
}

function fakeTracker(): FakeTracker {
  const calls: string[] = []
  const launches: TrackedLaunch[] = []
  let current: TrackedSession | null = null
  const tracker: FakeTracker = {
    calls,
    launches,
    processes: [],
    start(launch) {
      calls.push(`start:${launch.game.id}`)
      launches.push(launch)
      current = {
        gameId: launch.game.id,
        startedAt: '2026-03-01T10:00:00.000Z',
        pid: launch.child?.pid ?? launch.pid,
        seen: false
      }
      return { sessionId: 's1', gameId: launch.game.id, startedAt: current.startedAt }
    },
    current: () => current,
    async gameProcesses() {
      const value =
        typeof tracker.processes === 'function' ? tracker.processes() : tracker.processes
      if (value instanceof Error) throw value
      return value
    },
    end(options) {
      calls.push(`end:${options?.restore ?? true}`)
      current = null
    },
    restoreWindow() {
      calls.push('restore')
    },
    dispose() {
      calls.push('dispose')
      current = null
    }
  }
  return tracker
}

interface FakeChild extends ChildProcess {
  unrefCalls: number
}

function fakeChild(pid: number, outcome: 'spawn' | 'error', errorCode = 'ENOENT'): FakeChild {
  const child = new EventEmitter() as FakeChild
  Object.assign(child, {
    pid: outcome === 'spawn' ? pid : undefined,
    exitCode: null,
    signalCode: null,
    unrefCalls: 0,
    unref() {
      child.unrefCalls++
    }
  })
  setImmediate(() => {
    if (outcome === 'spawn') child.emit('spawn')
    else child.emit('error', Object.assign(new Error(`spawn ${errorCode}`), { code: errorCode }))
  })
  return child
}

/** A scratch folder with an empty .bat and .lnk so planLaunch's isFile check passes for them. */
function scratchFiles(): { dir: string; bat: string; lnk: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'playout-launcher-'))
  const bat = join(dir, 'run.bat')
  const lnk = join(dir, 'Game.lnk')
  writeFileSync(bat, '@echo off\r\n')
  writeFileSync(lnk, '')
  return { dir, bat, lnk, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('createGameLauncher.track', () => {
  it('tracks a child as spawned, ends the running session first and passes a safe hand-off folder', async () => {
    const tracker = fakeTracker()
    const launcher = createGameLauncher({ emulation: noEmulation(), tracker, log: collectingLog() })
    const child = fakeChild(4242, 'spawn')
    launcher.track(makeGame({ id: 'a' }), child)
    expect(tracker.launches[0]!.game.tracking).toEqual({ mode: 'spawned' })
    expect(tracker.launches[0]!.handoffDir).toBeUndefined()
    launcher.track(makeGame({ id: 'b' }), child, {
      handoffDir: 'D:\\XboxGames\\Halo',
      reason: 'PeerParty'
    })
    expect(tracker.calls).toEqual(['start:a', 'end:false', 'start:b'])
    expect(tracker.launches[1]!.handoffDir).toBe('D:\\XboxGames\\Halo')
    // A drive root is never a hand-off folder (unrelated processes would keep the session open).
    launcher.track(makeGame({ id: 'c' }), child, { handoffDir: 'D:\\' })
    expect(tracker.launches[2]!.handoffDir).toBeUndefined()
    launcher.dispose()
  })
})

describe('createGameLauncher', () => {
  it('refuses a game while launchBlocked gives a reason (an upgrade rewriting it), and starts it after', async () => {
    const tracker = fakeTracker()
    const opened: string[] = []
    let blocked: string | null = 'An upgrade is changing this game.'
    const launcher = createGameLauncher({
      emulation: noEmulation(),
      tracker,
      log: collectingLog(),
      launchBlocked: () => blocked,
      io: {
        async openExternal(uri) {
          opened.push(uri)
        }
      }
    })
    const game = makeGame({
      id: 'steam:620',
      launch: { kind: 'uri', uri: 'steam://rungameid/620' }
    })
    expect(await launcher.launch(game)).toEqual({
      ok: false,
      error: { kind: 'failed', message: 'An upgrade is changing this game.' }
    })
    expect(opened).toEqual([])
    expect(tracker.calls).toEqual([])
    blocked = null
    expect(await launcher.launch(game)).toMatchObject({ ok: true })
    expect(opened).toEqual(['steam://rungameid/620'])
    launcher.dispose()
  })

  it('opens URIs with the shell and starts a session without a child', async () => {
    const tracker = fakeTracker()
    const opened: string[] = []
    const launcher = createGameLauncher({
      emulation: noEmulation(),
      tracker,
      log: collectingLog(),
      io: {
        async openExternal(uri) {
          opened.push(uri)
        },
        spawn: () => {
          throw new Error('spawn must not be called for a uri launch')
        }
      }
    })
    const game = makeGame({
      id: 'steam:620',
      launch: { kind: 'uri', uri: 'steam://rungameid/620' }
    })
    expect(await launcher.launch(game)).toEqual({ ok: true, startedAt: '2026-03-01T10:00:00.000Z' })
    expect(opened).toEqual(['steam://rungameid/620'])
    expect(tracker.calls).toEqual(['start:steam:620'])
    expect(tracker.launches[0]).toMatchObject({
      game,
      child: undefined,
      runInBackground: false,
      handoffDir: undefined
    })
    expect(launcher.running()).toEqual({
      gameId: 'steam:620',
      startedAt: '2026-03-01T10:00:00.000Z'
    })
    launcher.dispose()
    expect(tracker.calls).toContain('dispose')
    expect(launcher.running()).toBeNull()
  })

  it.skipIf(!haveNotepad)(
    'spawns executables detached, unref()s them and hands the child to the tracker',
    async () => {
      const tracker = fakeTracker()
      const spawns: { file: string; args: string[]; options: SpawnOptions }[] = []
      let child: FakeChild | undefined
      const launcher = createGameLauncher({
        emulation: noEmulation(),
        tracker,
        log: collectingLog(),
        io: {
          spawn(file, args, options) {
            spawns.push({ file, args, options })
            // Created here so its spawn event fires after the launcher subscribed to it.
            child = fakeChild(777, 'spawn')
            return child
          }
        }
      })
      const game = makeGame({ installDir: 'C:\\Games\\Notes', user: { extraArgs: '-x "a b"' } })
      const result = await launcher.launch(game)
      expect(result.ok).toBe(true)
      expect(spawns).toHaveLength(1)
      expect(spawns[0].file).toBe(notepad)
      expect(spawns[0].args).toEqual(['-x', 'a b'])
      expect(spawns[0].options).toMatchObject({
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        windowsVerbatimArguments: false
      })
      expect(String(spawns[0].options.cwd).toLowerCase()).toBe(system32.toLowerCase())
      expect(child?.unrefCalls).toBe(1)
      expect(tracker.launches[0]).toMatchObject({
        child,
        handoffDir: 'C:\\Games\\Notes',
        runInBackground: false
      })
      expect(launcher.running()).toMatchObject({ gameId: 'manual:notepad' })
    }
  )

  it.skipIf(!haveNotepad)(
    'reports a spawn failure and restores a window the replaced session minimized',
    async () => {
      const tracker = fakeTracker()
      tracker.start({ game: makeGame({ id: 'steam:1' }) })
      const log = collectingLog()
      const runPowerShell = vi.fn()
      const launcher = createGameLauncher({
        emulation: noEmulation(),
        tracker,
        log,
        io: { spawn: () => fakeChild(0, 'error', 'ENOENT'), runPowerShell }
      })
      const result = await launcher.launch(makeGame())
      expect(result.ok).toBe(false)
      expect(result.error).toMatchObject({
        kind: 'failed',
        message: /Could not start Notepad: spawn ENOENT/
      })
      // Only ERROR_ELEVATION_REQUIRED (EACCES) earns the UAC retry.
      expect(runPowerShell).not.toHaveBeenCalled()
      // The running session ended (without restoring) before the attempt; the failure then brought the window back.
      expect(tracker.calls).toEqual(['start:steam:1', 'end:false', 'restore'])
      expect(launcher.running()).toBeNull()
      expect(log.lines.some((l) => /launch of Notepad failed/.test(l))).toBe(true)
    }
  )

  describe.skipIf(!haveNotepad)('executables that need elevation (spawn EACCES)', () => {
    function elevatedHarness(result: PowerShellResult | Error): {
      tracker: FakeTracker
      scripts: string[]
      timeouts: number[]
      spawns: string[]
      log: ReturnType<typeof collectingLog>
      launch: LauncherService['launch']
    } {
      const tracker = fakeTracker()
      const scripts: string[] = []
      const timeouts: number[] = []
      const spawns: string[] = []
      const log = collectingLog()
      const launcher = createGameLauncher({
        emulation: noEmulation(),
        tracker,
        log,
        io: {
          spawn(file) {
            spawns.push(file)
            return fakeChild(0, 'error', 'EACCES')
          },
          async runPowerShell(script, options) {
            scripts.push(script)
            timeouts.push(options.timeoutMs)
            if (result instanceof Error) throw result
            return result
          }
        }
      })
      return { tracker, scripts, timeouts, spawns, log, launch: launcher.launch }
    }

    it('retries through Start-Process -Verb RunAs and tracks the returned pid', async () => {
      const h = elevatedHarness({ code: 0, stdout: '4321\r\n', stderr: '' })
      const game = makeGame({ installDir: 'C:\\Games\\Notes', user: { extraArgs: '-x "a b"' } })
      const result = await h.launch(game)
      expect(result.ok).toBe(true)
      expect(h.spawns).toEqual([notepad])
      expect(h.scripts).toHaveLength(1)
      expect(h.scripts[0]).toContain(' -Verb RunAs -PassThru')
      expect(h.scripts[0]).toContain(`-FilePath '${notepad}'`)
      expect(h.scripts[0].toLowerCase()).toContain(`-workingdirectory '${system32.toLowerCase()}'`)
      expect(h.scripts[0]).toContain(`-ArgumentList '-x "a b"'`)
      // Long enough for the user to answer the UAC prompt (it dismisses itself after about two minutes).
      expect(h.timeouts[0]).toBeGreaterThanOrEqual(120_000)
      expect(h.tracker.launches[0]).toMatchObject({
        child: undefined,
        pid: 4321,
        handoffDir: 'C:\\Games\\Notes'
      })
      expect(h.log.lines.some((l) => /needs elevation/.test(l))).toBe(true)
    })

    it('fails with a clear message when the UAC prompt is declined or the start produced no pid', async () => {
      const declined = elevatedHarness({
        code: 1,
        stdout: '',
        stderr: 'The operation was canceled by the user.\r\nAt line:1'
      })
      declined.tracker.start({ game: makeGame({ id: 'steam:1' }) })
      const result = await declined.launch(makeGame())
      expect(result.ok).toBe(false)
      expect(result.error).toMatchObject({
        kind: 'failed',
        message:
          /administrator rights.*declined or failed \(The operation was canceled by the user\.\)/
      })
      expect(declined.tracker.calls).toEqual(['start:steam:1', 'end:false', 'restore'])

      const noPid = elevatedHarness({ code: 0, stdout: 'garbage', stderr: '' })
      expect((await noPid.launch(makeGame())).error).toMatchObject({ kind: 'failed' })

      const thrown = elevatedHarness(new Error('powershell.exe missing'))
      expect((await thrown.launch(makeGame())).error).toMatchObject({
        kind: 'failed',
        message: /powershell\.exe missing/
      })
    })

    it('does not retry a .bat launch: the cmd.exe wrapper never needs elevation', async () => {
      const files = scratchFiles()
      try {
        const h = elevatedHarness({ code: 0, stdout: '1', stderr: '' })
        const game = makeGame({ launch: { kind: 'exec', file: files.bat, args: [] } })
        const result = await h.launch(game)
        expect(result.ok).toBe(false)
        expect(result.error).toMatchObject({ kind: 'failed', message: /spawn EACCES/ })
        expect(h.scripts).toEqual([])
      } finally {
        files.dispose()
      }
    })
  })

  describe.skipIf(!haveNotepad)('shortcut (.lnk) launches', () => {
    const files = scratchFiles()
    afterAll(() => files.dispose())

    function lnkHarness(
      readShortcutLink: (file: string) => Promise<{ target: string; args?: string; cwd?: string }>
    ): {
      tracker: FakeTracker
      spawns: { file: string; args: string[]; options: SpawnOptions }[]
      launch: LauncherService['launch']
    } {
      const tracker = fakeTracker()
      const spawns: { file: string; args: string[]; options: SpawnOptions }[] = []
      const launcher = createGameLauncher({
        emulation: noEmulation(),
        tracker,
        log: collectingLog(),
        io: {
          spawn(file, args, options) {
            spawns.push({ file, args, options })
            return fakeChild(55, 'spawn')
          },
          readShortcutLink
        }
      })
      return { tracker, spawns, launch: launcher.launch }
    }

    const lnkGame = (): Game =>
      makeGame({
        launch: { kind: 'exec', file: files.lnk, args: [] },
        user: { extraArgs: '--extra' }
      })

    it('spawns the resolved target directly with the shortcut arguments and working directory', async () => {
      const h = lnkHarness(async () => ({ target: notepad, args: '-a "b c"', cwd: system32 }))
      expect((await h.launch(lnkGame())).ok).toBe(true)
      expect(h.spawns).toHaveLength(1)
      expect(h.spawns[0].file).toBe(notepad)
      expect(h.spawns[0].args).toEqual(['-a', 'b c', '--extra'])
      expect(h.spawns[0].options).toMatchObject({
        cwd: system32,
        windowsVerbatimArguments: false
      })
    })

    it('applies the cmd rules when the shortcut points at a batch file', async () => {
      const h = lnkHarness(async () => ({ target: files.bat, args: 'x & calc' }))
      expect((await h.launch(lnkGame())).ok).toBe(true)
      const [spawned] = h.spawns
      expect(spawned.file.toLowerCase()).toMatch(/cmd\.exe$/)
      expect(spawned.options.windowsVerbatimArguments).toBe(true)
      expect(spawned.args.at(-1)).toBe(`""${files.bat}" "x" "&" "calc" "--extra""`)
      expect(spawned.options.cwd).toBe(files.dir)

      const injected = lnkHarness(async () => ({ target: files.bat, args: '%USERPROFILE%' }))
      expect((await injected.launch(lnkGame())).error).toMatchObject({
        kind: 'failed',
        message: /cmd\.exe would interpret/
      })
      expect(injected.spawns).toEqual([])
    })

    it('reports a missing target and falls back to `start ""` when the shortcut cannot be read', async () => {
      const missing = lnkHarness(async () => ({ target: 'C:\\gone\\game.exe' }))
      expect((await missing.launch(lnkGame())).error).toMatchObject({
        kind: 'file-missing',
        message: /Shortcut target not found/
      })
      expect(missing.spawns).toEqual([])

      const unreadable = lnkHarness(async () => {
        throw new Error('not a shortcut')
      })
      expect((await unreadable.launch(lnkGame())).ok).toBe(true)
      expect(unreadable.spawns[0].file.toLowerCase()).toMatch(/cmd\.exe$/)
      expect(unreadable.spawns[0].args.at(-1)).toBe(`"start "" "${files.lnk}" "--extra""`)
    })
  })

  it('ends the running session before a replacement launch and never touches IO on a planning error', async () => {
    const tracker = fakeTracker()
    tracker.start({ game: makeGame({ id: 'steam:1' }) })
    let ioCalls = 0
    const launcher = createGameLauncher({
      emulation: noEmulation(),
      tracker,
      log: collectingLog(),
      io: {
        async openExternal() {
          ioCalls++
        },
        spawn() {
          ioCalls++
          throw new Error('unexpected')
        }
      }
    })
    const missing = makeGame({
      id: 'manual:gone',
      launch: { kind: 'exec', file: 'C:\\nope\\gone.exe', args: [] }
    })
    const failed = await launcher.launch(missing)
    expect(failed).toEqual({
      ok: false,
      error: { kind: 'file-missing', message: 'Executable not found: C:\\nope\\gone.exe' }
    })
    expect(ioCalls).toBe(0)
    // A plan that cannot even start leaves the running game alone.
    expect(tracker.calls).toEqual(['start:steam:1'])

    const next = makeGame({ id: 'steam:2', launch: { kind: 'uri', uri: 'steam://rungameid/2' } })
    expect((await launcher.launch(next)).ok).toBe(true)
    expect(ioCalls).toBe(1)
    expect(tracker.calls).toEqual(['start:steam:1', 'end:false', 'start:steam:2'])
  })
})

// ---------------------------------------------------------------------------
// Battle.net: the client must be running before `--exec=launch` is sent
// ---------------------------------------------------------------------------

describe.skipIf(!haveNotepad)('createGameLauncher Battle.net client pre-start', () => {
  const client = 'C:\\Battle.net\\Battle.net.exe'
  const battlenetGame = (): Game =>
    makeGame({
      id: 'battlenet:d3',
      source: 'battlenet',
      externalId: 'd3',
      launch: { kind: 'exec', file: notepad, args: ['--exec=launch D3'] },
      tracking: { mode: 'process', processNames: ['Diablo III64'] },
      extra: { productCode: 'D3', launchesViaClient: true, clientPath: client }
    })
  const process = (name: string, pid: number): ProcessInfo => ({
    pid,
    parentPid: 1,
    name,
    path: null,
    sessionId: 1
  })

  function harness(
    initialClientProcesses: number,
    clientOutcome: 'spawn' | 'error' = 'spawn'
  ): {
    spawns: string[]
    sleeps: number[]
    log: ReturnType<typeof collectingLog>
    launch: (game: Game) => ReturnType<LauncherService['launch']>
  } {
    const spawns: string[] = []
    const sleeps: number[] = []
    const log = collectingLog()
    let list: ProcessInfo[] = Array.from({ length: initialClientProcesses }, (_, i) =>
      process('Battle.net.exe', 100 + i)
    )
    const launcher = createGameLauncher({
      emulation: noEmulation(),
      tracker: fakeTracker(),
      log,
      monitor: { listNames: async () => list },
      io: {
        spawn(file) {
          spawns.push(file)
          if (file === client) {
            if (clientOutcome === 'error') return fakeChild(0, 'error', 'EACCES')
            // The client spawns its helper processes shortly after the first poll.
            list = [1, 2, 3, 4, 5].map((i) => process('Battle.net.exe', i))
          }
          return fakeChild(900 + spawns.length, 'spawn')
        },
        sleep: async (ms) => {
          sleeps.push(ms)
        }
      }
    })
    return { spawns, sleeps, log, launch: launcher.launch }
  }

  it('survives a client that cannot be started and sends the launch command anyway', async () => {
    const h = harness(0, 'error')
    // A spawn 'error' without a listener would be an uncaught exception; the launch must resolve normally.
    const result = await h.launch(battlenetGame())
    expect(result.ok).toBe(true)
    expect(h.spawns).toEqual([client, notepad])
    expect(h.sleeps).toEqual([])
    expect(
      h.log.lines.some((l) => /could not start the Battle\.net client .*spawn EACCES/.test(l))
    ).toBe(true)
  })

  it('starts the client, waits for it to settle and then sends the launch command', async () => {
    const h = harness(0)
    const result = await h.launch(battlenetGame())
    expect(result.ok).toBe(true)
    expect(h.spawns).toEqual([client, notepad])
    expect(h.sleeps).toEqual([1_000, 5_000])
  })

  it('launches straight away when the client is already running', async () => {
    const h = harness(1)
    const result = await h.launch(battlenetGame())
    expect(result.ok).toBe(true)
    expect(h.spawns).toEqual([notepad])
    expect(h.sleeps).toEqual([])
  })

  it('does not touch the client for games of other sources', async () => {
    const h = harness(0)
    const result = await h.launch(makeGame())
    expect(result.ok).toBe(true)
    expect(h.spawns).toEqual([notepad])
  })
})

// ---------------------------------------------------------------------------
// Integration: a real notepad.exe with 'spawned' tracking, a real process monitor, fake library + EventBus
// ---------------------------------------------------------------------------

const isNotepad = (p: ProcessInfo): boolean => p.name.toLowerCase() === 'notepad.exe'

async function stopProcesses(pids: number[]): Promise<void> {
  if (!pids.length) return
  const result = await runPowerShell(
    `Stop-Process -Id ${pids.join(',')} -Force -ErrorAction SilentlyContinue; "stopped"`,
    { timeoutMs: 15_000 }
  )
  if (!/stopped/.test(result.stdout))
    throw new Error(`Stop-Process failed (exit ${result.code}): ${result.stderr}`)
}

describe.skipIf(!haveNotepad)('launcher integration (notepad.exe)', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const c of cleanups.splice(0)) c()
  })

  it('starts a session, sees notepad running, and ends the session once notepad is stopped', async () => {
    const log = collectingLog()
    const monitor = createProcessMonitor(log)
    cleanups.push(() => monitor.dispose())

    const events = new EventBus()
    const started: PlayOutEvents['session:started'][] = []
    const ended: PlayOutEvents['session:ended'][] = []
    events.on('session:started', (p) => started.push(p))
    events.on('session:ended', (p) => ended.push(p))
    const library = {
      beginSession(gameId: string): ActiveSession {
        const startedAt = new Date().toISOString()
        events.emit('session:started', { gameId, startedAt })
        return { sessionId: 'integration', gameId, startedAt }
      },
      endSession(active: ActiveSession, measuredMinutes?: number): void {
        const endedAt = new Date().toISOString()
        const minutes =
          measuredMinutes ??
          Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(active.startedAt)) / 60_000))
        events.emit('session:ended', {
          gameId: active.gameId,
          startedAt: active.startedAt,
          endedAt,
          minutes
        })
      }
    }
    const settings = defaultSettings()
    settings.ui.minimizeWhilePlaying = true
    const windowCalls: string[] = []
    let minimized = false
    const tracker = createSessionTracker({
      library,
      settings: { get: () => settings },
      window: {
        minimize() {
          windowCalls.push('minimize')
          minimized = true
        },
        isVisible: () => true,
        restore() {
          windowCalls.push('restore')
          minimized = false
        },
        isMinimized: () => minimized,
        focus() {
          windowCalls.push('focus')
        }
      },
      monitor,
      log,
      timing: {
        pollMs: 500,
        graceMs: 15_000,
        lingerMs: 1_500,
        stubWindowMs: 10_000,
        maxPollErrors: 3
      }
    })
    const launcher = createGameLauncher({ emulation: noEmulation(), tracker, log })
    cleanups.push(() => launcher.dispose())

    const game = makeGame()
    const before = new Set((await monitor.list()).filter(isNotepad).map((p) => p.pid))
    const ours = new Set<number>()
    try {
      const result = await launcher.launch(game)
      expect(result).toMatchObject({ ok: true })
      expect(started).toHaveLength(1)
      expect(started[0]).toEqual({ gameId: game.id, startedAt: result.startedAt })
      expect(launcher.running()).toEqual({
        gameId: game.id,
        startedAt: result.startedAt,
        pid: expect.any(Number)
      })

      await waitUntil(
        () => tracker.current()?.seen === true || ended.length > 0,
        10_000,
        'the tracker to see notepad'
      )
      const pid = tracker.current()?.pid
      if (pid) ours.add(pid)
      expect(windowCalls).toEqual(['minimize'])

      // On Windows 11 System32\notepad.exe is a stub that starts the Store Notepad and exits, so the process to
      // stop may not be the spawned pid: collect every Notepad that appeared since the snapshot.
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        for (const p of (await monitor.list()).filter(isNotepad))
          if (!before.has(p.pid)) ours.add(p.pid)
        const stubAlive = pid !== undefined && monitor.isPidAlive(pid)
        if ([...ours].some((id) => id !== pid) || (!stubAlive && ended.length > 0)) break
        await sleep(500)
      }
      await stopProcesses([...ours])

      await waitUntil(() => ended.length === 1, 15_000, 'session:ended')
      expect(ended[0]).toMatchObject({ gameId: game.id, startedAt: result.startedAt })
      expect(ended[0].minutes).toBeGreaterThanOrEqual(0)
      expect(Date.parse(ended[0].endedAt)).toBeGreaterThanOrEqual(Date.parse(ended[0].startedAt))
      expect(launcher.running()).toBeNull()
      expect(tracker.current()).toBeNull()
      expect(windowCalls).toEqual(['minimize', 'restore'])
      expect(log.lines.some((l) => /Notepad is running \(/.test(l))).toBe(true)
      expect(log.lines.some((l) => /session ended for Notepad/.test(l))).toBe(true)
      console.info(
        `[launcher] notepad pids ${[...ours].join(',') || 'none'} (spawned ${pid}); ` +
          log.lines.filter((l) => /spawned process|is running|session ended/.test(l)).join(' | ')
      )
    } finally {
      // Never leave a Notepad window behind, whatever the assertions did.
      const leftovers = (await monitor.list().catch(() => [] as ProcessInfo[]))
        .filter(isNotepad)
        .map((p) => p.pid)
        .filter((id) => !before.has(id))
      await stopProcesses([...new Set([...ours, ...leftovers])]).catch((err) =>
        console.warn(`[launcher] cleanup failed: ${(err as Error).message}`)
      )
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// stop(): closing the running game (a streamed game whose viewer left)
// ---------------------------------------------------------------------------

describe('createGameLauncher stop', () => {
  function stopHarness(): {
    tracker: FakeTracker
    killed: number[]
    log: Logger & { lines: string[] }
    launcher: LauncherService
    clock: { now: number }
    failKill: Set<number>
  } {
    const tracker = fakeTracker()
    const killed: number[] = []
    const failKill = new Set<number>()
    const log = collectingLog()
    const clock = { now: 1_000_000 }
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
    const launcher = createGameLauncher({
      emulation: noEmulation(),
      tracker,
      log,
      io: {
        async killTree(pid) {
          killed.push(pid)
          if (failKill.has(pid)) throw new Error('Access is denied.')
        },
        async sleep(ms) {
          clock.now += ms
        }
      }
    })
    return { tracker, killed, log, launcher, clock, failKill }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const game = makeGame({
    id: 'steam:620',
    launch: { kind: 'uri', uri: 'steam://rungameid/620' },
    tracking: { mode: 'installDir', installDir: 'C:\\Games\\Portal 2' }
  })
  const portal = (pid: number): ProcessInfo => ({
    pid,
    parentPid: 1,
    name: 'portal2.exe',
    path: 'C:\\Games\\Portal 2\\portal2.exe',
    sessionId: 1
  })

  it('does nothing when the game is not the running one', async () => {
    const h = stopHarness()
    expect(await h.launcher.stop('steam:620')).toBe(true)
    h.tracker.start({ game: makeGame({ id: 'steam:1' }) })
    h.tracker.processes = [portal(10)]
    expect(await h.launcher.stop('steam:620')).toBe(true)
    expect(h.killed).toEqual([])
    expect(h.tracker.calls).toEqual(['start:steam:1'])
  })

  it('kills every game process, then ends the session once none is left', async () => {
    const h = stopHarness()
    h.tracker.start({ game })
    let calls = 0
    h.tracker.processes = () =>
      ++calls === 1 ? [portal(10), portal(11)] : calls === 2 ? [portal(11)] : []
    expect(await h.launcher.stop('steam:620')).toBe(true)
    expect(h.killed).toEqual([10, 11])
    expect(h.tracker.calls).toEqual(['start:steam:620', 'end:true'])
    expect(h.launcher.running()).toBeNull()
  })

  it('never kills PlayOut, the shell or Windows processes even when the session matches them', async () => {
    const h = stopHarness()
    h.tracker.start({ game })
    const systemRoot = process.env['SystemRoot'] || 'C:\\Windows'
    let calls = 0
    h.tracker.processes = () =>
      ++calls === 1
        ? [
            portal(10),
            { pid: process.pid, parentPid: 1, name: 'PlayOut.exe', path: null, sessionId: 1 },
            { pid: 20, parentPid: 1, name: 'explorer.exe', path: null, sessionId: 1 },
            {
              pid: 21,
              parentPid: 1,
              name: 'conhost.exe',
              path: join(systemRoot, 'System32', 'conhost.exe'),
              sessionId: 1
            }
          ]
        : [{ pid: 20, parentPid: 1, name: 'explorer.exe', path: null, sessionId: 1 }]
    expect(await h.launcher.stop('steam:620')).toBe(true)
    expect(h.killed).toEqual([10])
  })

  it('keeps tracking and resolves false when the game survives (an elevated game)', async () => {
    const h = stopHarness()
    h.tracker.start({ game })
    h.tracker.processes = [portal(10)]
    h.failKill.add(10)
    expect(await h.launcher.stop('steam:620')).toBe(false)
    expect(h.killed).toEqual([10])
    expect(h.tracker.calls).toEqual(['start:steam:620'])
    expect(h.log.lines.some((l) => l.includes('Access is denied.'))).toBe(true)
    expect(h.log.lines.some((l) => l.includes('may still be running'))).toBe(true)
  })

  it('falls back to the spawned pid when the process list fails, and never ends on a failed list', async () => {
    const h = stopHarness()
    h.tracker.start({ game: makeGame({ id: 'rom:snes:mario' }), pid: 4242 })
    let calls = 0
    h.tracker.processes = () => (++calls < 4 ? new Error('cim down') : [])
    expect(await h.launcher.stop('rom:snes:mario')).toBe(true)
    expect(h.killed).toEqual([4242])
    expect(calls).toBe(4)
    expect(h.tracker.calls).toEqual(['start:rom:snes:mario', 'end:true'])
  })

  it('leaves a session that was replaced meanwhile alone', async () => {
    const h = stopHarness()
    h.tracker.start({ game })
    h.tracker.processes = () => {
      h.tracker.start({ game: makeGame({ id: 'steam:2' }) })
      return [portal(10)]
    }
    expect(await h.launcher.stop('steam:620')).toBe(true)
    expect(h.killed).toEqual([])
    expect(h.tracker.calls).toEqual(['start:steam:620', 'start:steam:2'])
  })
})

describe('isProtectedProcess', () => {
  it('protects PlayOut, low pids, shell names and anything under the Windows folder', () => {
    const systemRoot = process.env['SystemRoot'] || 'C:\\Windows'
    expect(isProtectedProcess({ pid: process.pid, name: 'x.exe', path: null })).toBe(true)
    expect(isProtectedProcess({ pid: 4, name: 'System', path: null })).toBe(true)
    expect(isProtectedProcess({ pid: 100, name: 'Explorer.EXE', path: null })).toBe(true)
    expect(isProtectedProcess({ pid: 100, name: 'sunshine.exe', path: null })).toBe(true)
    expect(
      isProtectedProcess({
        pid: 100,
        name: 'cmd.exe',
        path: join(systemRoot, 'System32', 'cmd.exe')
      })
    ).toBe(true)
    expect(
      isProtectedProcess({ pid: 100, name: 'game.exe', path: 'D:\\Games\\Windows Game\\game.exe' })
    ).toBe(false)
  })
})

describe('the before-launch hook', () => {
  it.skipIf(!haveNotepad)(
    'runs with the emulator id and exe before an emulator game is spawned, and never stops the launch',
    async () => {
      const rom = system32
      const game = makeGame({
        id: 'rom:switch:x',
        romPath: rom,
        launch: { kind: 'emulator', systemId: 'switch', romPath: rom }
      })
      const emulation = fakeEmulation({
        ok: true,
        file: notepad,
        args: ['--fullscreen', rom],
        runInBackground: false,
        hideWindow: false,
        emulatorId: 'RYUJINX'
      })
      const order: string[] = []
      const log = collectingLog()
      let fail = false
      const launcher = createGameLauncher({
        emulation,
        tracker: fakeTracker(),
        log,
        beforeLaunch: async (id, exe) => {
          order.push(`before:${id}:${exe}`)
          if (fail) throw new Error('no pads')
        },
        io: {
          spawn: () => {
            order.push('spawn')
            return fakeChild(4242, 'spawn')
          }
        }
      })
      expect(await launcher.launch(game)).toMatchObject({ ok: true })
      expect(order).toEqual([`before:RYUJINX:${notepad}`, 'spawn'])

      fail = true
      order.length = 0
      expect(await launcher.launch(game)).toMatchObject({ ok: true })
      expect(order).toEqual([`before:RYUJINX:${notepad}`, 'spawn'])
      expect(
        log.lines.some((l) => l.includes('before-launch step for RYUJINX failed: no pads'))
      ).toBe(true)
    }
  )

  it.skipIf(!haveNotepad)(
    'passes the game file, and a second Play while the game is still starting starts it once',
    async () => {
      const rom = system32
      const game = makeGame({
        id: 'rom:ps2:x',
        romPath: rom,
        launch: { kind: 'emulator', systemId: 'ps2', romPath: rom }
      })
      const emulation = fakeEmulation({
        ok: true,
        file: notepad,
        args: ['-batch', rom],
        runInBackground: false,
        hideWindow: false,
        emulatorId: 'PCSX2'
      })
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      const calls: string[] = []
      let spawns = 0
      const launcher = createGameLauncher({
        emulation,
        tracker: fakeTracker(),
        log: collectingLog(),
        beforeLaunch: async (id, _exe, file) => {
          calls.push(`${id}:${file}`)
          await held
        },
        io: {
          spawn: () => {
            spawns++
            return fakeChild(4244, 'spawn')
          }
        }
      })
      const first = launcher.launch(game)
      const second = launcher.launch(game)
      release()
      expect(await first).toMatchObject({ ok: true })
      expect(await second).toBe(await first)
      expect(calls).toEqual([`PCSX2:${rom}`])
      expect(spawns).toBe(1)
      // Started: the next Play is a new launch again.
      await launcher.launch(game)
      expect(spawns).toBe(2)
    }
  )

  it.skipIf(!haveNotepad)(
    'tells the step how long ago the same emulator last game ended, and its process',
    async () => {
      const rom = system32
      const game = makeGame({
        id: 'rom:ps2:y',
        romPath: rom,
        launch: { kind: 'emulator', systemId: 'ps2', romPath: rom }
      })
      const emulation = fakeEmulation({
        ok: true,
        file: notepad,
        args: ['-batch', rom],
        runInBackground: false,
        hideWindow: false,
        emulatorId: 'PCSX2'
      })
      let onEnded: ((e: { gameId: string }) => void) | null = null
      const contexts: unknown[] = []
      const tracker = fakeTracker()
      const launcher = createGameLauncher({
        emulation,
        tracker,
        log: collectingLog(),
        events: {
          on: ((_event: string, fn: (e: { gameId: string }) => void) => {
            onEnded = fn
            return () => undefined
          }) as never
        },
        beforeLaunch: async (_id, _exe, _rom, context) => void contexts.push(context),
        io: { spawn: () => fakeChild(4245, 'spawn') }
      })
      await launcher.launch(game)
      expect(contexts[0]).toEqual({})
      // An emulator game: PlayOut minimizes only once the emulator's window is in front.
      expect(tracker.launches[0].waitForWindow).toBe(true)
      onEnded!({ gameId: game.id })
      await launcher.launch(game)
      const second = contexts[1] as { endedMsAgo: number; pid: number }
      expect(second.endedMsAgo).toBeGreaterThanOrEqual(0)
      expect(second.endedMsAgo).toBeLessThan(5000)
      // The ended game's own process: probed instead of a process list.
      expect(second.pid).toBe(4245)
      // That launch runs a game on the emulator again: the earlier end no longer counts for the next one.
      await launcher.launch(game)
      expect(contexts[2]).toEqual({})
      launcher.dispose()
    }
  )

  it.skipIf(!haveNotepad)('is not called for games that do not start an emulator', async () => {
    const beforeLaunch = vi.fn(async () => undefined)
    const tracker = fakeTracker()
    const launcher = createGameLauncher({
      emulation: noEmulation(),
      tracker,
      log: collectingLog(),
      beforeLaunch,
      io: { spawn: () => fakeChild(4243, 'spawn') }
    })
    const game = makeGame({ launch: { kind: 'exec', file: notepad, args: [] } })
    expect(await launcher.launch(game)).toMatchObject({ ok: true })
    expect(beforeLaunch).not.toHaveBeenCalled()
    // Not an emulator: PlayOut minimizes as soon as the game runs, as before.
    expect(tracker.launches[0].waitForWindow).toBe(false)
  })
})
