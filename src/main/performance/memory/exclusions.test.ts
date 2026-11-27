import { describe, expect, it } from 'vitest'
import type { ProcessInfo } from '../../launcher/process-monitor'
import { ANTI_CHEAT } from '../../overlay/overlay-logic'
import {
  isPackagedAppPath,
  MAX_TRIM_PIDS,
  processTree,
  trimExclusion,
  trimScope,
  trimTargets,
  type TrimContext,
  type TrimReason
} from './exclusions'
import {
  ANTI_CHEAT_NAMES,
  CRITICAL_NAMES,
  HARD_NEVER_NAMES,
  normalizeImage,
  SECURITY_NAMES,
  STREAMING_NAMES
} from './names'
import { trimCSharpMembers, TRIM_CS_MAX_PIDS } from './trim-cs'

const OWN = 9000
const PARENT = 8000
const GAME = 5000
const WINDOWS = 'C:\\Windows'

let nextPid = 20_000
const proc = (name: string, over: Partial<ProcessInfo> = {}): ProcessInfo => ({
  pid: (nextPid += 4),
  parentPid: 700,
  name,
  path: `C:\\Program Files\\${name.replace(/\.exe$/i, '')}\\${name}`,
  sessionId: 1,
  ...over
})

const ctx = (over: Partial<TrimContext> = {}): TrimContext => ({
  ownPid: OWN,
  ownParentPid: PARENT,
  ownNames: ['PlayOut.exe', 'electron'],
  gameRunning: false,
  gamePids: [],
  gameDir: null,
  foregroundPid: null,
  windowsDir: WINDOWS,
  ...over
})

/** The reason one process is left alone, among `others`. */
const why = (
  p: ProcessInfo,
  c: TrimContext = ctx(),
  others: ProcessInfo[] = []
): TrimReason | null => trimExclusion(p, trimScope([p, ...others], c))

describe('trimExclusion', () => {
  it('lets an ordinary background program through', () => {
    expect(why(proc('Discord.exe'))).toBeNull()
    expect(why(proc('chrome.exe', { path: null }))).toBeNull()
  })

  it('never trims pids up to 4 or a process without a name', () => {
    expect(why(proc('System', { pid: 4, path: null }))).toBe('system')
    expect(why(proc('x.exe', { pid: 0 }))).toBe('system')
    expect(why(proc('', { path: null }))).toBe('system')
  })

  it('never trims PlayOut: its process, its parent, its whole process tree and anything with its name', () => {
    expect(why(proc('PlayOut.exe', { pid: OWN }))).toBe('playout')
    expect(why(proc('cmd.exe', { pid: PARENT, path: 'D:\\dev\\cmd.exe' }))).toBe('playout')
    // A renderer, and a PowerShell worker under a helper process (grandchild).
    const renderer = proc('whatever.exe', { parentPid: OWN })
    const worker = proc('powershell.exe', {
      parentPid: renderer.pid,
      path: 'D:\\ps\\powershell.exe'
    })
    expect(why(worker, ctx(), [renderer])).toBe('playout')
    // The same image started some other way (a second instance), and a development run.
    expect(why(proc('playout.exe'))).toBe('playout')
    expect(why(proc('electron.exe'))).toBe('playout')
  })

  it('never trims the running game: its process tree and everything in its install folder', () => {
    const c = ctx({ gameRunning: true, gamePids: [GAME], gameDir: 'D:\\Games\\Halo' })
    const game = proc('halo.exe', { pid: GAME, path: 'D:\\Games\\Halo\\halo.exe' })
    const child = proc('crashreporter.exe', {
      parentPid: GAME,
      path: 'C:\\Temp\\crashreporter.exe'
    })
    const sibling = proc('server.exe', { path: 'D:\\Games\\Halo\\bin\\server.exe' })
    expect(why(game, c)).toBe('game')
    expect(why(child, c, [game])).toBe('game')
    expect(why(sibling, c)).toBe('game')
    // 'D:\Games\Halo 2' is not inside 'D:\Games\Halo'.
    expect(why(proc('other.exe', { path: 'D:\\Games\\Halo 2\\other.exe' }), c)).toBeNull()
  })

  it("leaves a process without a known path alone while the game's folder would decide about it", () => {
    // PlayOut's window is in front; the game's child was started by a launcher stub that has already exited, and
    // its path could not be read (the list is read without administrator rights).
    const c = ctx({
      gameRunning: true,
      gamePids: [GAME],
      gameDir: 'D:\\Games\\Halo',
      foregroundPid: OWN
    })
    const game = proc('halo.exe', { pid: GAME, path: 'D:\\Games\\Halo\\halo.exe' })
    const orphan = proc('halo-win64-shipping.exe', { path: null, parentPid: 31_337 })
    const discord = proc('Discord.exe')
    const own = proc('PlayOut.exe', { pid: OWN })
    expect(why(orphan, c, [game])).toBe('game')
    expect(trimTargets([own, game, orphan, discord], c).pids).toEqual([discord.pid])
    // A known path outside the folder decides as before; without a game folder the path decides nothing.
    expect(why(proc('other.exe', { path: 'E:\\Apps\\other.exe' }), c)).toBeNull()
    expect(
      why(proc('halo-win64-shipping.exe', { path: null }), ctx({ gameRunning: true }))
    ).toBeNull()
    // The named reasons still win over "unknown".
    expect(why(proc('MsMpEng.exe', { path: null }), c)).toBe('security')
  })

  it('leaves the store clients and overlay tools alone while a game runs, not otherwise', () => {
    const running = ctx({ gameRunning: true, gamePids: [GAME] })
    for (const name of ['steam.exe', 'steamwebhelper.exe', 'EpicGamesLauncher.exe', 'RTSS.exe'])
      expect(why(proc(name), running), name).toMatch(/^(launcher|windows)$/)
    expect(why(proc('GalaxyClient.exe'), running)).toBe('launcher')
    expect(why(proc('GalaxyClient.exe'))).toBeNull()
  })

  it('never trims an emulator, started by PlayOut or not', () => {
    for (const name of [
      'retroarch.exe',
      'rpcs3.exe',
      'pcsx2-qtx64-avx2.exe',
      'Dolphin.exe',
      'Ryujinx.exe'
    ])
      expect(why(proc(name)), name).toBe('emulator')
  })

  it('never trims the program in front: its window process, its children and its other processes', () => {
    const browser = proc('chrome.exe')
    const tab = proc('chrome.exe')
    const child = proc('helper.exe', { parentPid: browser.pid })
    const c = ctx({ foregroundPid: browser.pid })
    expect(why(browser, c)).toBe('foreground')
    expect(why(child, c, [browser])).toBe('foreground')
    expect(why(tab, c, [browser])).toBe('foreground')
    expect(why(proc('Discord.exe'), c, [browser])).toBeNull()
  })

  it("never trims a Store app while a Store app's window is in front (it belongs to ApplicationFrameHost)", () => {
    const frame = proc('ApplicationFrameHost.exe', {
      path: 'C:\\Windows\\System32\\ApplicationFrameHost.exe',
      parentPid: 800
    })
    const store = proc('Minecraft.Windows.exe', {
      path: 'C:\\Program Files\\WindowsApps\\Microsoft.MinecraftUWP_1.21_x64__8wekyb3d8bbwe\\Minecraft.Windows.exe',
      parentPid: 800
    })
    const other = proc('Spotify.exe', {
      path: 'D:\\WindowsApps\\SpotifyAB.SpotifyMusic_1.2_x64__zpdnekdrzrea0\\Spotify.exe',
      parentPid: 800
    })
    const discord = proc('Discord.exe')
    const all = [frame, store, other, discord]
    const c = ctx({ foregroundPid: frame.pid })
    // The app's own process is neither the window's process nor below it: it is known by its folder only.
    expect(why(store, c, all)).toBe('foreground')
    expect(why(other, c, all)).toBe('foreground')
    expect(why(discord, c, all)).toBeNull()
    expect(trimTargets(all, c).pids).toEqual([discord.pid])
    // A process whose path could not be read may be the Store app in front: by its name alone it is not known.
    const unreadable = proc('Forza.exe', { path: null, parentPid: 800 })
    expect(why(unreadable, c, all)).toBe('foreground')
    expect(why(unreadable, ctx({ foregroundPid: discord.pid }), all)).toBeNull()
    // With an ordinary program in front a Store app in the background is trimmed like any other.
    const back = ctx({ foregroundPid: discord.pid })
    expect(why(store, back, all)).toBeNull()
    expect(isPackagedAppPath('C:/Program Files/WindowsApps/x/y.exe')).toBe(true)
    expect(isPackagedAppPath('C:\\Program Files\\WindowsAppsExtra\\y.exe')).toBe(false)
    expect(isPackagedAppPath(null)).toBe(false)
  })

  it("never trims Windows' critical processes, by name alone", () => {
    for (const name of [
      'System',
      'Registry',
      'Memory Compression',
      'smss.exe',
      'csrss.exe',
      'wininit.exe',
      'winlogon.exe',
      'services.exe',
      'lsass.exe',
      'dwm.exe',
      'fontdrvhost.exe',
      'audiodg.exe',
      'sihost.exe',
      'ctfmon.exe',
      'svchost.exe'
    ])
      expect(why(proc(name, { path: null, sessionId: 0 })), name).toBe('system')
  })

  it("never trims anything in Windows' folder, the shell's hosts or what a session never closes", () => {
    expect(why(proc('notepad.exe', { path: 'C:\\Windows\\System32\\notepad.exe' }))).toBe('windows')
    expect(why(proc('SearchHost.exe', { path: null }))).toBe('windows')
    expect(why(proc('RuntimeBroker.exe', { path: null }))).toBe('windows')
    expect(why(proc('app.exe', { path: 'C:\\WindowsApps\\app.exe' }))).toBeNull()
  })

  it('never trims security software', () => {
    for (const name of [
      'MsMpEng.exe',
      'NisSrv.exe',
      'SecurityHealthService.exe',
      'MpDefenderCoreService.exe',
      'SenseNdr.exe',
      'SenseCncProxy.exe'
    ])
      expect(why(proc(name, { path: null })), name).toBe('security')
  })

  it("never trims an anti-cheat service: every name of the overlay's ANTI_CHEAT list", () => {
    expect(ANTI_CHEAT.size).toBeGreaterThan(5)
    for (const name of ANTI_CHEAT) expect(why(proc(name)), name).toBe('anti-cheat')
    expect(ANTI_CHEAT_NAMES).toEqual([...ANTI_CHEAT].map(normalizeImage))
  })

  it('never trims Sunshine or Moonlight', () => {
    expect(why(proc('sunshine.exe'))).toBe('streaming')
    expect(why(proc('Moonlight.exe'))).toBe('streaming')
  })

  it('lets explorer.exe through only while the running game is in front', () => {
    const explorer = proc('explorer.exe', { path: 'C:\\Windows\\explorer.exe' })
    const game = proc('halo.exe', { pid: GAME, path: 'D:\\Games\\Halo\\halo.exe' })
    const gameWindow = proc('halo-render.exe', { parentPid: GAME })
    const running = ctx({ gameRunning: true, gamePids: [GAME] })
    // No game; a game in the background (PlayOut, the desktop or nothing known in front).
    expect(why(explorer)).toBe('windows')
    expect(why(explorer, running, [game])).toBe('windows')
    expect(why(explorer, { ...running, foregroundPid: OWN }, [game])).toBe('windows')
    expect(why(explorer, { ...running, foregroundPid: explorer.pid }, [game])).toBe('foreground')
    // The game (or a process of its tree, or one in its folder) owns the window in front.
    expect(why(explorer, { ...running, foregroundPid: GAME }, [game])).toBeNull()
    expect(
      why(explorer, { ...running, foregroundPid: gameWindow.pid }, [game, gameWindow])
    ).toBeNull()
    const inDir = proc('launcher.exe', { path: 'D:\\Games\\Halo\\launcher.exe' })
    expect(
      why(
        explorer,
        { ...running, gamePids: [], gameDir: 'D:\\Games\\Halo', foregroundPid: inDir.pid },
        [inDir]
      )
    ).toBeNull()
    // A game window in front without a session is just the foreground program: explorer stays.
    expect(why(explorer, ctx({ foregroundPid: GAME }), [game])).toBe('windows')
  })
})

describe('processTree', () => {
  it('follows parent pids from the roots and ignores cycles and pids up to 4', () => {
    const list = [
      proc('a', { pid: 100, parentPid: 4 }),
      proc('b', { pid: 104, parentPid: 100 }),
      proc('c', { pid: 108, parentPid: 104 }),
      proc('d', { pid: 112, parentPid: 112 }),
      proc('e', { pid: 116, parentPid: 120 }),
      proc('f', { pid: 120, parentPid: 116 })
    ]
    expect([...processTree(list, [100])].sort()).toEqual([100, 104, 108])
    expect([...processTree(list, [116])].sort()).toEqual([116, 120])
    expect(processTree(list, [4, 0]).size).toBe(0)
  })
})

describe('trimTargets', () => {
  it('lists what may be trimmed and counts the rest by reason', () => {
    const game = proc('halo.exe', { pid: GAME, path: 'D:\\Games\\Halo\\halo.exe' })
    const discord = proc('Discord.exe')
    const browser = proc('chrome.exe')
    const explorer = proc('explorer.exe', { path: 'C:\\Windows\\explorer.exe' })
    const list = [
      proc('System', { pid: 4, path: null }),
      proc('PlayOut.exe', { pid: OWN }),
      game,
      proc('steam.exe'),
      proc('MsMpEng.exe', { path: null }),
      proc('svchost.exe', { path: 'C:\\Windows\\System32\\svchost.exe', sessionId: 0 }),
      explorer,
      discord,
      browser,
      { ...discord }
    ]
    const background = trimTargets(list, ctx({ gameRunning: true, gamePids: [GAME] }))
    expect(background.pids).toEqual([discord.pid, browser.pid])
    expect(background.shell).toBe(false)
    expect(background.skipped).toBe(7)
    expect(background.excluded).toMatchObject({ playout: 1, game: 1, security: 1, system: 2 })

    const inFront = trimTargets(
      list,
      ctx({ gameRunning: true, gamePids: [GAME], foregroundPid: GAME })
    )
    expect(inFront.pids).toEqual([explorer.pid, discord.pid, browser.pid])
    expect(inFront.shell).toBe(true)
  })

  it('never names more pids than both tiers take', () => {
    const many = Array.from({ length: MAX_TRIM_PIDS + 30 }, (_, i) =>
      proc(`app${i}.exe`, { pid: 40_000 + i * 4 })
    )
    const t = trimTargets(many, ctx())
    expect(t.pids).toHaveLength(MAX_TRIM_PIDS)
    expect(t.skipped).toBe(30)
    expect(MAX_TRIM_PIDS).toBe(TRIM_CS_MAX_PIDS)
  })
})

describe('the C# both tiers compile', () => {
  const cs = trimCSharpMembers()

  it('refuses the same critical, security, anti-cheat and streaming names again', () => {
    for (const name of [
      ...CRITICAL_NAMES,
      ...SECURITY_NAMES,
      ...ANTI_CHEAT_NAMES,
      ...STREAMING_NAMES
    ]) {
      expect(HARD_NEVER_NAMES, name).toContain(name)
      expect(cs, name).toContain(`"${name}"`)
    }
    expect(cs).toContain('new string[] { "sense" }')
    // explorer is decided per pass (the shell flag), so it is not in the fixed list.
    expect(HARD_NEVER_NAMES).not.toContain('explorer')
    expect(cs).toContain(`MaxPids = ${TRIM_CS_MAX_PIDS};`)
  })

  it('only trims working sets: no system-wide or lasting call', () => {
    expect(cs).toContain('K32EmptyWorkingSet')
    // Every opened process is checked by its creation time before anything else is done with it.
    expect(cs).toContain('GetProcessTimes')
    expect(cs.indexOf('if (TooNew(CreatedMs(h), createdBeforeMs))')).toBeGreaterThan(0)
    expect(cs.indexOf('if (TooNew(CreatedMs(h), createdBeforeMs))')).toBeLessThan(
      cs.indexOf('K32EmptyWorkingSet(h)')
    )
    for (const never of [
      'SetSystemFileCacheSize',
      'NtSuspendProcess',
      'TerminateProcess',
      'SetProcessWorkingSetSize',
      'Registry',
      'ServiceController'
    ])
      expect(cs).not.toContain(never)
    // Plain ASCII: it is embedded in helper.ps1, which PowerShell 5.1 reads in the ANSI code page.
    expect([...cs].filter((c) => c.charCodeAt(0) > 0x7e)).toEqual([])
    // No line may end the here-string it is compiled from.
    expect(cs.split('\n').filter((l) => l.startsWith("'@"))).toEqual([])
  })
})
