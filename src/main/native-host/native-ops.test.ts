import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { MAX_ELAPSED_MS, TRIM_CS_MAX_PIDS } from '../performance/memory/trim-cs'
import type { PsRunner } from '../system/ps-worker'
import { MEMORY_CS, MEMORY_INIT, NATIVE_INIT } from './native-cs'
import {
  compareModes,
  createNativeOps,
  hwndOf,
  isDisplayDevice,
  isHwnd,
  isTrimPidList,
  mapPlaybackStatus,
  normalizeModes,
  parseForeground,
  parseFlagged,
  parseHdrState,
  parseMediaSession,
  parseOsdResult,
  parseRtssSnapshot,
  parseTrimResult,
  type NativeOps
} from './native-ops'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function fakeRunner(answer: (script: string) => unknown): PsRunner & { scripts: string[] } {
  const scripts: string[] = []
  return {
    scripts,
    async run<T>(script: string): Promise<T | null> {
      scripts.push(script)
      const value = answer(script)
      if (value instanceof Error) throw value
      return (value ?? null) as T | null
    }
  }
}

const FG = {
  hwnd: '8455804',
  pid: 26340,
  exe: 'C:\\Games\\game.exe',
  title: 'Game "1"',
  className: 'UnityWndClass',
  rect: { x: 0, y: 0, width: 1920, height: 1200 },
  monitor: {
    device: '\\\\.\\DISPLAY1',
    rect: { x: 0, y: 0, width: 1920, height: 1200 },
    workArea: { x: 0, y: 0, width: 1920, height: 1152 }
  },
  fullscreen: true,
  exclusive: false
}

describe('hwndOf', () => {
  it('reads a 64-bit little-endian handle as decimal', () => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(8455804n)
    expect(hwndOf(b)).toBe('8455804')
    // Only the low 32 bits count: a sign-extended handle reads the same as the C# side's unsigned spelling.
    b.writeBigUInt64LE(0xffff_ffff_8001_0a7cn)
    expect(hwndOf(b)).toBe(String(0x8001_0a7c))
  })

  it('reads a 32-bit handle, and refuses a short buffer', () => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(0x00810a7c)
    expect(hwndOf(b)).toBe(String(0x00810a7c))
    expect(() => hwndOf(Buffer.alloc(2))).toThrow()
  })
})

describe('input checks', () => {
  it('lets through only decimal handles and \\\\.\\DISPLAYn devices', () => {
    expect(isHwnd('8455804')).toBe(true)
    expect(isHwnd('0')).toBe(false)
    expect(isHwnd("1'); Remove-Item x; ('")).toBe(false)
    expect(isHwnd('-5')).toBe(false)
    expect(isDisplayDevice('\\\\.\\DISPLAY1')).toBe(true)
    expect(isDisplayDevice('\\\\.\\DISPLAY12')).toBe(true)
    expect(isDisplayDevice("\\\\.\\DISPLAY1'")).toBe(false)
    expect(isDisplayDevice('DISPLAY1')).toBe(false)
  })
})

describe('parseForeground', () => {
  it('parses the C# JSON string', () => {
    expect(parseForeground(JSON.stringify(FG))).toEqual({
      hwnd: '8455804',
      pid: 26340,
      exe: 'C:\\Games\\game.exe',
      title: 'Game "1"',
      rect: FG.rect,
      monitor: FG.monitor,
      fullscreen: true,
      exclusive: false
    })
  })

  it('keeps a window without a monitor, and rejects nonsense', () => {
    expect(parseForeground({ ...FG, monitor: null })?.monitor).toBeNull()
    expect(parseForeground('null')).toBeNull()
    expect(parseForeground(null)).toBeNull()
    expect(parseForeground('{not json')).toBeNull()
    expect(parseForeground({ ...FG, hwnd: 'abc' })).toBeNull()
    expect(parseForeground({ ...FG, rect: { x: 0 } })).toBeNull()
  })
})

describe('normalizeModes', () => {
  it('keeps 32-bit modes once each, largest first then highest rate', () => {
    const raw = {
      current: { width: 1920, height: 1080, hz: 144, bpp: 32 },
      modes: [
        { width: 1280, height: 720, hz: 60, bpp: 32 },
        { width: 1920, height: 1080, hz: 60, bpp: 32 },
        { width: 1920, height: 1080, hz: 144, bpp: 32 },
        { width: 1920, height: 1080, hz: 144, bpp: 32 },
        { width: 1920, height: 1080, hz: 144, bpp: 16 },
        { width: 1920, height: 1200, hz: 60, bpp: 32 },
        { width: 640, height: 480, hz: 1, bpp: 32 },
        { width: 'x', height: 1, hz: 1, bpp: 32 }
      ]
    }
    expect(normalizeModes(JSON.stringify(raw))).toEqual({
      current: { width: 1920, height: 1080, hz: 144 },
      modes: [
        { width: 1920, height: 1200, hz: 60 },
        { width: 1920, height: 1080, hz: 144 },
        { width: 1920, height: 1080, hz: 60 },
        { width: 1280, height: 720, hz: 60 }
      ]
    })
  })

  it('orders equal pixel counts by width', () => {
    const a = { width: 1600, height: 1200, hz: 60 }
    const b = { width: 1200, height: 1600, hz: 60 }
    expect([b, a].sort(compareModes)).toEqual([a, b])
  })

  it('returns null without a current mode', () => {
    expect(normalizeModes('null')).toBeNull()
    expect(normalizeModes({ modes: [] })).toBeNull()
  })
})

describe('media mapping', () => {
  it('maps playback statuses', () => {
    expect(mapPlaybackStatus('Playing')).toBe('playing')
    expect(mapPlaybackStatus('Paused')).toBe('paused')
    expect(mapPlaybackStatus('Stopped')).toBe('stopped')
    expect(mapPlaybackStatus('Closed')).toBe('stopped')
    expect(mapPlaybackStatus('Changing')).toBe('other')
    expect(mapPlaybackStatus('')).toBe('other')
  })

  it('parses a session and keeps only image data URLs as art', () => {
    const raw = {
      app: 'Spotify.exe',
      title: 'Song',
      artist: 'Band',
      album: null,
      status: 'Playing',
      art: 'data:image/jpeg;base64,/9j/',
      canNext: true,
      canPrevious: false
    }
    expect(parseMediaSession(raw)).toEqual({
      app: 'Spotify.exe',
      title: 'Song',
      artist: 'Band',
      album: '',
      status: 'playing',
      art: 'data:image/jpeg;base64,/9j/',
      canNext: true,
      canPrevious: false
    })
    expect(parseMediaSession({ ...raw, art: 'javascript:alert(1)' })?.art).toBeUndefined()
    expect(parseMediaSession(null)).toBeNull()
  })
})

describe('createNativeOps with a fake runner', () => {
  it('builds the expected calls and validates input before any script runs', async () => {
    const runner = fakeRunner((script) => {
      if (script.includes('Foreground()')) return JSON.stringify(FG)
      if (script.includes('Activate(')) return true
      if (script.includes('DisplayModes('))
        return JSON.stringify({ current: { width: 1, height: 1, hz: 60, bpp: 32 }, modes: [] })
      if (script.includes('SetDisplayMode(')) return -2
      if (script.includes('TrySkipNextAsync')) return true
      if (script.includes('GetCurrentSession')) return null
      return null
    })
    const ops = createNativeOps({ log, runner })
    expect((await ops.foreground())?.hwnd).toBe('8455804')
    expect(await ops.focus('123')).toBe(true)
    expect(runner.scripts.at(-1)).toBe("[PlayOutNative]::Activate('123')")
    expect(await ops.focus('1; evil')).toBe(false)
    expect(runner.scripts.at(-1)).toBe("[PlayOutNative]::Activate('123')")
    await ops.restore('456')
    expect(runner.scripts.at(-1)).toBe("[PlayOutNative]::Activate('456')")

    expect((await ops.displayModes('\\\\.\\DISPLAY2')).current).toEqual({
      width: 1,
      height: 1,
      hz: 60
    })
    expect(runner.scripts.at(-1)).toBe("[PlayOutNative]::DisplayModes('\\\\.\\DISPLAY2')")
    await expect(ops.displayModes("x'")).rejects.toThrow()

    expect(
      await ops.setDisplayMode('\\\\.\\DISPLAY1', { width: 1920, height: 1080, hz: 120 })
    ).toEqual({
      ok: false,
      code: -2
    })
    expect(runner.scripts.at(-1)).toBe(
      "[PlayOutNative]::SetDisplayMode('\\\\.\\DISPLAY1', 1920, 1080, 120)"
    )
    await expect(
      ops.setDisplayMode('\\\\.\\DISPLAY1', { width: 1.5, height: 1, hz: 1 })
    ).rejects.toThrow()

    await ops.mediaControl('next')
    expect(runner.scripts.at(-1)).toContain('$s.TrySkipNextAsync()')
    expect(await ops.mediaSession()).toBeNull()
    ops.dispose()
  })

  it('turns runner failures into null / false / no-op where the API says so', async () => {
    const ops = createNativeOps({ log, runner: fakeRunner(() => new Error('boom')) })
    expect(await ops.foreground()).toBeNull()
    expect(await ops.focus('1')).toBe(false)
    await expect(ops.restore('1')).resolves.toBeUndefined()
    expect(await ops.mediaSession()).toBeNull()
    await expect(ops.mediaControl('toggle')).resolves.toBeUndefined()
    await expect(ops.displayModes('\\\\.\\DISPLAY1')).rejects.toThrow('boom')
  })

  it('trims working sets through PlayOutMemory with literal pids only', async () => {
    const runner = fakeRunner(() => '{"trimmed":2,"denied":5,"skipped":1,"gone":0}')
    const ops = createNativeOps({ log, runner })
    const listedAt = 1_700_000_000_000
    expect(await ops.trimWorkingSets([1234, 5678], false, listedAt)).toEqual({
      trimmed: 2,
      denied: 5,
      skipped: 1,
      gone: 0
    })
    expect(runner.scripts.at(-1)).toBe(
      '[PlayOutMemory]::Trim([int[]]@(1234, 5678), $false, [long]1700000000000)'
    )
    await ops.trimWorkingSets([], true, listedAt)
    expect(runner.scripts.at(-1)).toBe(
      '[PlayOutMemory]::Trim([int[]]@(), $true, [long]1700000000000)'
    )
    // How long the trim took, when the class says.
    const timed = createNativeOps({
      log,
      runner: fakeRunner(() => '{"trimmed":2,"denied":5,"skipped":1,"gone":0,"ms":87}')
    })
    expect(await timed.trimWorkingSets([1234], false, listedAt)).toEqual({
      trimmed: 2,
      denied: 5,
      skipped: 1,
      gone: 0,
      ms: 87
    })
    // Nothing but whole pids above 4 reaches the script, and never more than the C# takes.
    const sent = runner.scripts.length
    for (const bad of [
      [4],
      [0],
      [-1],
      [12.5],
      [NaN],
      [2 ** 31],
      ['1); calc' as unknown as number],
      Array.from({ length: TRIM_CS_MAX_PIDS + 1 }, (_, i) => 8 + i * 4)
    ])
      await expect(ops.trimWorkingSets(bad, false, listedAt)).rejects.toThrow(
        /Not a list of processes/
      )
    // Nor without the time the process list was read (a reused process id could be trimmed otherwise).
    for (const bad of [0, -5, 1.5, NaN, Infinity, '1700000000000' as unknown as number])
      await expect(ops.trimWorkingSets([1234], false, bad), String(bad)).rejects.toThrow(
        /Not a time/
      )
    expect(runner.scripts).toHaveLength(sent)
    expect(isTrimPidList(Array.from({ length: TRIM_CS_MAX_PIDS }, (_, i) => 8 + i * 4))).toBe(true)
  })

  it('throws when the memory class did not answer, instead of reporting a trim that did not happen', async () => {
    expect(parseTrimResult('{"trimmed":0,"denied":0,"skipped":0,"gone":3}')).toEqual({
      trimmed: 0,
      denied: 0,
      skipped: 0,
      gone: 3
    })
    // A time that is not one is left out; the counts are still good. An absurd one is cut.
    for (const bad of ['-1', '"87"', 'null', 'true', '{}'])
      expect(
        parseTrimResult(`{"trimmed":1,"denied":0,"skipped":0,"gone":0,"ms":${bad}}`),
        bad
      ).toEqual({ trimmed: 1, denied: 0, skipped: 0, gone: 0 })
    expect(parseTrimResult('{"trimmed":1,"ms":1e12}').ms).toBe(MAX_ELAPSED_MS)
    expect(parseTrimResult('{"trimmed":1,"ms":0}').ms).toBe(0)
    for (const bad of [null, '', 'nope', '{}', '{"trimmed":"2"}', 7])
      expect(() => parseTrimResult(bad), String(bad)).toThrow(/did not answer/)
    const broken = createNativeOps({ log, runner: fakeRunner(() => new Error('boom')) })
    await expect(broken.trimWorkingSets([1234], false, 1_700_000_000_000)).rejects.toThrow('boom')
  })

  it('compiles the memory class on its own, so a failure leaves the other classes working', () => {
    expect(MEMORY_INIT).toContain("if (-not ('PlayOutMemory' -as [type]))")
    expect(MEMORY_INIT).toContain('$global:PlayOutMemoryError')
    expect(NATIVE_INIT).toContain(MEMORY_INIT)
    expect(MEMORY_CS).toContain('public static class PlayOutMemory')
    expect(MEMORY_CS).toContain('K32EmptyWorkingSet')
    // The here-string it is compiled from ends exactly once.
    expect(MEMORY_INIT.split('\n').filter((l) => l.startsWith("'@"))).toEqual(["'@"])
  })
})

describe.skipIf(process.platform !== 'win32')('PlayOutMemory (compiled with Add-Type)', () => {
  it('compiles as the worker compiles it; a dry run opens and checks and trims nothing', () => {
    // Only TrimProcesses(..., dryRun: true) and Trim with no process at all are called: no working set is trimmed
    // on this PC.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      MEMORY_INIT,
      'if ($global:PlayOutMemoryError) { throw $global:PlayOutMemoryError }',
      '$r = @{}',
      '$r.counts = [PlayOutMemory]::TrimProcesses([int[]]@([int]$env:PLAYOUT_TEST_PID, $PID, 4, 999999), $false, [long]::MaxValue, $true)',
      // The same pids as if the process list had been read long before any of them started: nothing is let through.
      '$r.old = [PlayOutMemory]::TrimProcesses([int[]]@([int]$env:PLAYOUT_TEST_PID, $PID, 4, 999999), $false, [long]1000, $true)',
      "$r.protected = @([PlayOutMemory]::Protected('C:\\Windows\\explorer.exe', $false, 'C:\\Windows\\'), [PlayOutMemory]::Protected('C:\\Windows\\explorer.exe', $true, 'C:\\Windows\\'), [PlayOutMemory]::Protected('D:\\x\\MsMpEng.exe', $true, 'C:\\Windows\\'), [PlayOutMemory]::Protected('D:\\Apps\\app.exe', $false, 'C:\\Windows\\'))",
      '$r.max = [PlayOutMemory]::MaxPids',
      // The real entry point with an empty list: it opens and trims nothing, and answers its counts and its time.
      '$r.none = [PlayOutMemory]::Trim([int[]]@(), $false, [long]1)',
      '$r | ConvertTo-Json -Depth 4 -Compress'
    ].join('\r\n')
    const dir = mkdtempSync(join(tmpdir(), 'playout-memory-cs-'))
    try {
      const file = join(dir, 'check.ps1')
      writeFileSync(file, `\ufeff${script}`, 'utf8')
      const ps = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        {
          encoding: 'utf8',
          timeout: 120_000,
          windowsHide: true,
          env: { ...process.env, PLAYOUT_TEST_PID: String(process.pid) }
        }
      )
      if (ps.status !== 0)
        throw new Error(`PowerShell failed (${ps.status}): ${ps.stderr || ps.stdout}`)
      const r = JSON.parse(ps.stdout.trim()) as {
        counts: number[]
        old: number[]
        protected: boolean[]
        max: number
        none: string
      }
      const [trimmed, denied, skipped, gone] = r.counts as [number, number, number, number]
      // This PowerShell and pid 4 are skipped, the odd pid does not exist, node.exe is the fourth.
      expect(gone).toBe(1)
      expect(skipped).toBeGreaterThanOrEqual(2)
      expect(trimmed + denied + skipped + gone).toBe(4)
      // Created after the list was read: node.exe is skipped as well (or denied when it could not be opened).
      expect(r.old[0]).toBe(0)
      expect(r.old[3]).toBe(1)
      expect(r.old[1]! + r.old[2]!).toBe(3)
      expect(r.protected).toEqual([true, false, true, false])
      expect(r.max).toBe(TRIM_CS_MAX_PIDS)
      expect(r.none).toMatch(/^\{"trimmed":0,"denied":0,"skipped":0,"gone":0,"ms":\d+\}$/)
      expect(parseTrimResult(r.none).ms).toBeLessThan(60_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

describe.skipIf(process.platform !== 'win32')('native ops on Windows (read-only calls)', () => {
  let ops: NativeOps | null = null
  afterAll(() => ops?.dispose())

  it('compiles PlayOutNative, reads the foreground window and its monitor modes', async () => {
    ops = createNativeOps({ log })
    const fg = await ops.foreground()
    // A test runner can have no foreground window (a locked session); when there is one, it parses whole.
    if (fg) {
      expect(isHwnd(fg.hwnd)).toBe(true)
      expect(fg.monitor?.device).toMatch(/^\\\\\.\\DISPLAY\d+$/)
      const modes = await ops.displayModes(fg.monitor!.device)
      expect(modes.current.width).toBeGreaterThan(0)
      expect(modes.modes.length).toBeGreaterThan(0)
    }
    // Media: null or a parsed session, never a throw.
    const media = await ops.mediaSession()
    expect(media === null || typeof media.app === 'string').toBe(true)
    // RTSS (read-only snapshot) and HDR compile in the same worker: null or parsed, never a throw. The OSD and the
    // profile reload write RTSS's memory, so they are never called here.
    const snap = await ops.rtssSnapshot()
    expect(snap === null || typeof snap.version === 'number').toBe(true)
    const hdr = await ops.hdrState('\\\\.\\DISPLAY1')
    expect(hdr === null || typeof hdr.enabled === 'boolean').toBe(true)
  }, 60_000)
})

describe('RTSS and HDR ops', () => {
  it('parses the OSD, reload and HDR answers', () => {
    expect(parseOsdResult('{"ok":true,"slot":3}')).toEqual({ ok: true, slot: 3 })
    expect(parseOsdResult('{"ok":true}')).toEqual({ ok: true })
    expect(parseOsdResult('{"ok":false,"error":"busy"}')).toEqual({ ok: false, error: 'busy' })
    expect(parseOsdResult('null')).toEqual({ ok: false, error: 'missing' })
    expect(parseFlagged('{"ok":true,"flagged":7}')).toBe(7)
    expect(parseFlagged('{"ok":false,"flagged":0}')).toBe(0)
    expect(parseFlagged(null)).toBe(0)
    expect(parseHdrState('{"supported":true,"enabled":false,"source":15}')).toEqual({
      supported: true,
      enabled: false
    })
    expect(parseHdrState('null')).toBeNull()
    expect(parseHdrState('{"supported":1}')).toBeNull()
    expect(parseRtssSnapshot('{"version":131093,"foregroundPid":0,"apps":[]}')).toEqual({
      version: 131093,
      foregroundPid: null,
      apps: []
    })
  })

  it('sends the OSD text base64-encoded, validates owner and device, and never throws', async () => {
    const runner = fakeRunner((script) => {
      if (script.includes('Snapshot()')) return 'null'
      if (script.includes('Osd(')) return '{"ok":true,"slot":2}'
      if (script.includes('RequestProfileUpdate()')) return '{"ok":true,"flagged":3}'
      if (script.includes('PlayOutHdr')) return '{"supported":true,"enabled":true,"source":9}'
      return null
    })
    const ops = createNativeOps({ log, runner })
    expect(await ops.rtssSnapshot()).toBeNull()
    const text = "60 FPS\n'); Remove-Item x; ('’"
    expect(await ops.rtssOsd('PlayOut', text)).toEqual({ ok: true, slot: 2 })
    const script = runner.scripts.at(-1)!
    expect(
      script.startsWith("[PlayOutRtss]::Osd('PlayOut', [System.Text.Encoding]::UTF8.GetString(")
    ).toBe(true)
    expect(script).toContain(Buffer.from(text, 'utf8').toString('base64'))
    expect(script).not.toContain('Remove-Item')
    expect(await ops.rtssOsd('PlayOut', null)).toEqual({ ok: true, slot: 2 })
    expect(runner.scripts.at(-1)).toBe("[PlayOutRtss]::Osd('PlayOut', $null)")
    await ops.rtssOsd('PlayOut', 'x'.repeat(5000))
    expect(runner.scripts.at(-1)).toContain(Buffer.from('x'.repeat(4095)).toString('base64'))
    const n = runner.scripts.length
    expect(await ops.rtssOsd("Play'Out", 'x')).toEqual({ ok: false, error: 'owner' })
    expect(runner.scripts.length).toBe(n)
    expect(await ops.rtssRequestProfileUpdate()).toBe(3)
    expect(await ops.hdrState('\\\\.\\DISPLAY1')).toEqual({ supported: true, enabled: true })
    expect(runner.scripts.at(-1)).toBe("[PlayOutHdr]::State('\\\\.\\DISPLAY1')")
    expect(await ops.hdrState("\\\\.\\DISPLAY1'")).toBeNull()

    const broken = createNativeOps({ log, runner: fakeRunner(() => new Error('boom')) })
    expect(await broken.rtssSnapshot()).toBeNull()
    expect(await broken.rtssOsd('PlayOut', 'x')).toEqual({ ok: false, error: 'boom' })
    expect(await broken.rtssRequestProfileUpdate()).toBe(0)
    expect(await broken.hdrState('\\\\.\\DISPLAY1')).toBeNull()
  })
})
