import { spawn } from 'child_process'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import {
  createProcessMonitor,
  createWorkerIo,
  findByNames,
  findByPid,
  findDescendants,
  findUnderDir,
  findUwp,
  isPidAlive,
  isProcessUnderDir,
  normalizeProcessName,
  parseCimRows,
  parseTasklistCsv,
  runTasklist,
  uwpPackageName,
  type ProcessInfo,
  type ProcessMonitorIo
} from './process-monitor'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function proc(overrides: Partial<ProcessInfo> & { pid: number }): ProcessInfo {
  return { parentPid: 4, name: 'x.exe', path: null, sessionId: 1, ...overrides }
}

describe('process list parsing', () => {
  it('parses CIM rows and tolerates nulls', () => {
    const list = parseCimRows([
      {
        ProcessId: 10,
        ParentProcessId: 4,
        Name: 'a.exe',
        ExecutablePath: 'C:\\a\\a.exe',
        SessionId: 1
      },
      { ProcessId: 11, ParentProcessId: null, Name: null, ExecutablePath: null, SessionId: null },
      {
        ProcessId: 'bad' as unknown as number,
        ParentProcessId: 1,
        Name: 'n',
        ExecutablePath: null,
        SessionId: 1
      }
    ])
    expect(list).toEqual([
      { pid: 10, parentPid: 4, name: 'a.exe', path: 'C:\\a\\a.exe', sessionId: 1, createdAt: null },
      { pid: 11, parentPid: null, name: '', path: null, sessionId: -1, createdAt: null }
    ])
    expect(
      parseCimRows([
        {
          ProcessId: 12,
          ParentProcessId: 4,
          Name: 'b.exe',
          ExecutablePath: null,
          SessionId: 1,
          Created: 1793359190124
        }
      ])[0].createdAt
    ).toBe(1793359190124)
  })

  it('parses tasklist CSV output and skips noise lines', () => {
    const text = [
      '',
      '"Image Name","PID","Session Name","Session#","Mem Usage"',
      '"System Idle Process","0","Services","0","8 K"',
      '"node.exe","9260","Console","1","67,440 K"',
      'INFO: No tasks are running which match the specified criteria.',
      '"Some Game.exe","1234","Console","1","1,234,567 K"'
    ].join('\r\n')
    expect(parseTasklistCsv(text)).toEqual([
      {
        pid: 0,
        parentPid: null,
        name: 'System Idle Process',
        path: null,
        sessionId: 0,
        createdAt: null
      },
      { pid: 9260, parentPid: null, name: 'node.exe', path: null, sessionId: 1, createdAt: null },
      {
        pid: 1234,
        parentPid: null,
        name: 'Some Game.exe',
        path: null,
        sessionId: 1,
        createdAt: null
      }
    ])
  })
})

describe('process predicates', () => {
  const list: ProcessInfo[] = [
    proc({ pid: 100, name: 'Fallout.exe', path: 'C:\\Games\\Fallout\\Fallout.exe' }),
    proc({ pid: 101, name: 'Fallout2.exe', path: 'C:\\Games\\Fallout 2\\Fallout2.exe' }),
    proc({ pid: 102, name: 'svc.exe', path: 'C:\\Games\\Fallout\\svc.exe', sessionId: 0 }),
    proc({ pid: 103, name: 'protected.exe', path: null }),
    proc({
      pid: 104,
      name: 'Notepad.exe',
      path: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2607.14.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe'
    }),
    proc({ pid: 105, name: 'GAME.EXE', path: 'd:/games/other/GAME.EXE' })
  ]

  it('normalizes process names', () => {
    expect(normalizeProcessName('Game.EXE')).toBe('game')
    expect(normalizeProcessName('C:\\x\\Game.exe')).toBe('game')
    expect(normalizeProcessName('  game ')).toBe('game')
    expect(normalizeProcessName('game.exe.exe')).toBe('game.exe')
  })

  it('matches processes under a directory case-insensitively without prefix bleed', () => {
    expect(findUnderDir(list, 'c:\\games\\fallout').map((p) => p.pid)).toEqual([100])
    expect(findUnderDir(list, 'C:\\Games\\Fallout\\').map((p) => p.pid)).toEqual([100])
    expect(findUnderDir(list, 'C:\\Games\\Fallout 2').map((p) => p.pid)).toEqual([101])
    expect(findUnderDir(list, 'D:\\Games').map((p) => p.pid)).toEqual([105])
    expect(isProcessUnderDir(list, 'C:\\Games')).toBe(true)
    expect(isProcessUnderDir(list, 'C:\\Nope')).toBe(false)
    expect(isProcessUnderDir(list, '')).toBe(false)
  })

  it('ignores session 0 (services) and processes without a path for directory matches', () => {
    expect(findUnderDir(list, 'C:\\Games\\Fallout').some((p) => p.pid === 102)).toBe(false)
    expect(findUnderDir(list, 'C:\\').some((p) => p.pid === 103)).toBe(false)
  })

  it('matches by name with or without .exe, case-insensitively', () => {
    expect(findByNames(list, ['fallout']).map((p) => p.pid)).toEqual([100])
    expect(findByNames(list, ['FALLOUT2.EXE', 'game']).map((p) => p.pid)).toEqual([101, 105])
    expect(findByNames(list, ['svc'])).toEqual([])
    expect(findByNames(list, [])).toEqual([])
  })

  it('finds by pid', () => {
    expect(findByPid(list, 104)?.name).toBe('Notepad.exe')
    expect(findByPid(list, 1)).toBeUndefined()
  })

  it('matches packaged apps by package family name', () => {
    expect(uwpPackageName('Microsoft.WindowsNotepad_8wekyb3d8bbwe')).toBe(
      'Microsoft.WindowsNotepad'
    )
    expect(uwpPackageName('NoHash')).toBe('NoHash')
    expect(findUwp(list, 'Microsoft.WindowsNotepad_8wekyb3d8bbwe').map((p) => p.pid)).toEqual([104])
    expect(findUwp(list, 'microsoft.windowsnotepad_8wekyb3d8bbwe').map((p) => p.pid)).toEqual([104])
    expect(findUwp(list, 'Microsoft.WindowsNote_8wekyb3d8bbwe')).toEqual([])
    expect(findUwp(list, 'Fallout_abc')).toEqual([])
  })

  it('walks descendants through parent links, dead roots included', () => {
    const tree: ProcessInfo[] = [
      proc({ pid: 10, parentPid: 1, name: 'explorer.exe' }),
      proc({ pid: 20, parentPid: 999, name: 'game.exe' }),
      proc({ pid: 21, parentPid: 20, name: 'helper.exe' }),
      proc({ pid: 22, parentPid: 21, name: 'grandchild.exe' }),
      proc({ pid: 30, parentPid: 30, name: 'self.exe' }),
      proc({ pid: 40, parentPid: null, name: 'unknown.exe' })
    ]
    expect(findDescendants(tree, [999]).map((p) => p.pid)).toEqual([20, 21, 22])
    expect(findDescendants(tree, [21]).map((p) => p.pid)).toEqual([21, 22])
    expect(findDescendants(tree, [10, 40]).map((p) => p.pid)).toEqual([10, 40])
    expect(findDescendants(tree, [5])).toEqual([])
  })

  it('never returns session-0 processes or excluded anchors, but still links through them', () => {
    const tree: ProcessInfo[] = [
      // A service that was handed the dead game's pid: must not count as the game, nor adopt its children.
      proc({ pid: 999, parentPid: 1, name: 'svchost.exe', sessionId: 0 }),
      proc({ pid: 20, parentPid: 999, name: 'game.exe' }),
      proc({ pid: 21, parentPid: 20, name: 'helper.exe' }),
      proc({ pid: 60, parentPid: 999, name: 'svc-child.exe', sessionId: 0 })
    ]
    expect(findDescendants(tree, [999]).map((p) => p.pid)).toEqual([20, 21])
    // An excluded (already dead) pid reused by a user process is an anchor only.
    const reused: ProcessInfo[] = [
      proc({ pid: 999, parentPid: 1, name: 'RuntimeBroker.exe' }),
      proc({ pid: 20, parentPid: 999, name: 'game.exe' })
    ]
    expect(findDescendants(reused, [999], new Set([999])).map((p) => p.pid)).toEqual([20])
    expect(findDescendants(reused, [999]).map((p) => p.pid)).toEqual([999, 20])
  })
})

describe('process monitor', () => {
  it('coalesces concurrent polls into one command and reuses recent results on request', async () => {
    let cimCalls = 0
    let taskCalls = 0
    const io: ProcessMonitorIo = {
      async queryProcesses() {
        cimCalls++
        await new Promise((r) => setTimeout(r, 30))
        return [
          {
            ProcessId: 7,
            ParentProcessId: 1,
            Name: 'a.exe',
            ExecutablePath: 'C:\\a.exe',
            SessionId: 1
          }
        ]
      },
      async runTasklist() {
        taskCalls++
        await new Promise((r) => setTimeout(r, 10))
        return '"a.exe","7","Console","1","1 K"\r\n'
      }
    }
    const monitor = createProcessMonitor(log, io)
    const [a, b, c] = await Promise.all([monitor.list(), monitor.list(), monitor.listNames()])
    expect(cimCalls).toBe(1)
    // Names come from the same CIM poll while PowerShell works; tasklist is only the fallback.
    expect(taskCalls).toBe(0)
    expect(a).toBe(b)
    expect(c).toBe(a)
    await monitor.list()
    expect(cimCalls).toBe(2)
    await monitor.list({ maxAgeMs: 10_000 })
    expect(cimCalls).toBe(2)
  })

  it('falls back to tasklist for names when the CIM poll fails', async () => {
    let taskCalls = 0
    const warnings: string[] = []
    const io: ProcessMonitorIo = {
      async queryProcesses() {
        throw new Error('PowerShell worker exited before answering')
      },
      async runTasklist() {
        taskCalls++
        return '"game.exe","4321","Console","1","1 K"\r\n'
      }
    }
    const monitor = createProcessMonitor(
      { ...log, warn: (...a: unknown[]) => warnings.push(a.join(' ')) },
      io
    )
    await expect(monitor.list()).rejects.toThrow(/worker exited/)
    const names = await monitor.listNames()
    expect(taskCalls).toBe(1)
    expect(names).toEqual([
      { pid: 4321, parentPid: null, name: 'game.exe', path: null, sessionId: 1, createdAt: null }
    ])
    expect(warnings.some((w) => /falling back to tasklist/.test(w))).toBe(true)
  })

  it('reports a failed poll as an error', async () => {
    const io: ProcessMonitorIo = {
      async queryProcesses() {
        return null
      },
      async runTasklist() {
        return 'ERROR: something'
      }
    }
    const monitor = createProcessMonitor(log, io)
    await expect(monitor.list()).rejects.toThrow(/unavailable/)
    await expect(monitor.listNames()).rejects.toThrow(/no processes/)
  })

  it('finds this node process by pid in the real CIM list and in the tasklist list', async () => {
    const debug: string[] = []
    const monitor = createProcessMonitor({
      ...log,
      debug: (...a: unknown[]) => debug.push(a.join(' '))
    })
    const t0 = performance.now()
    const list = await monitor.list()
    const cimMs = Math.round(performance.now() - t0)
    const t0b = performance.now()
    const again = await monitor.list()
    const warmMs = Math.round(performance.now() - t0b)
    expect(again.length).toBeGreaterThan(20)
    const me = findByPid(list, process.pid)
    expect(me).toBeDefined()
    expect(me!.name.toLowerCase()).toBe('node.exe')
    expect(me!.path?.toLowerCase()).toBe(process.execPath.toLowerCase())
    expect(me!.sessionId).not.toBe(0)
    expect(me!.parentPid).toBeGreaterThan(0)
    // Creation time arrives as epoch ms: this vitest worker started within the last hour, and not in the future.
    const uptimeMs = Math.round(process.uptime() * 1000)
    expect(me!.createdAt).toBeGreaterThan(Date.now() - uptimeMs - 60_000)
    expect(me!.createdAt).toBeLessThanOrEqual(Date.now() + 5_000)
    expect(list.length).toBeGreaterThan(20)

    const t1 = performance.now()
    const names = parseTasklistCsv(await runTasklist())
    const taskMs = Math.round(performance.now() - t1)
    const meByName = findByPid(names, process.pid)
    expect(meByName?.name.toLowerCase()).toBe('node.exe')
    expect(findByNames(names, ['node']).some((p) => p.pid === process.pid)).toBe(true)
    monitor.dispose()
    expect(debug.some((d) => /closing the idle powershell worker/.test(d))).toBe(true)
    console.info(
      `[process-monitor] cim via worker: ${list.length} processes in ${cimMs} ms cold, ${warmMs} ms warm; tasklist: ${names.length} in ${taskMs} ms`
    )
  }, 30_000)

  it('closes the powershell worker after the idle period and restarts it on demand', async () => {
    const debug: string[] = []
    const io = createWorkerIo({ ...log, debug: (...a: unknown[]) => debug.push(a.join(' ')) }, 100)
    try {
      const rows = await io.queryProcesses()
      expect(rows?.some((r) => r.ProcessId === process.pid)).toBe(true)
      await new Promise((r) => setTimeout(r, 400))
      expect(debug.filter((d) => /closing the idle powershell worker/.test(d))).toHaveLength(1)
      const rowsAgain = await io.queryProcesses()
      expect(rowsAgain?.some((r) => r.ProcessId === process.pid)).toBe(true)
      expect(debug.filter((d) => /starting the powershell worker/.test(d))).toHaveLength(2)
    } finally {
      io.dispose?.()
    }
  }, 30_000)

  it('checks pid liveness without spawning', async () => {
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
    const child = spawn(process.env['ComSpec'] || 'cmd.exe', ['/d', '/c', 'exit'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    const pid = child.pid!
    expect(isPidAlive(pid)).toBe(true)
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    expect(isPidAlive(pid)).toBe(false)
  })
})
