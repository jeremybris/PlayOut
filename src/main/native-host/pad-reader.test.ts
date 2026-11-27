import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CRASH_LIMIT,
  createPadReader,
  parsePadLine,
  restartDelay,
  stderrMessage,
  type PadProcess,
  type PadReader,
  type PadSpawn
} from './pad-reader'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this
  }
}

class FakeProc extends EventEmitter implements PadProcess {
  stdout = new FakeStream()
  stderr = new FakeStream()
  written = ''
  stdinEnded = false
  killed = false
  stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      this.written += chunk
      return true
    },
    end: () => {
      this.stdinEnded = true
    }
  })
  kill(): boolean {
    this.killed = true
    return true
  }
  out(text: string): void {
    this.stdout.emit('data', text)
  }
  exit(code = 1): void {
    this.emit('exit', code, null)
  }
}

function fakeSpawn(): { spawn: PadSpawn; procs: FakeProc[]; calls: string[][] } {
  const procs: FakeProc[] = []
  const calls: string[][] = []
  const spawn: PadSpawn = (command, args) => {
    calls.push([command, ...args])
    const p = new FakeProc()
    procs.push(p)
    return p
  }
  return { spawn, procs, calls }
}

describe('parsePadLine', () => {
  it('parses the ready line', () => {
    expect(parsePadLine('{"ready":true,"sdl":true,"sdlError":""}')).toEqual({
      kind: 'ready',
      sdl: true,
      sdlError: ''
    })
    expect(parsePadLine('{"ready":true,"sdl":false,"sdlError":"Unable to load DLL"}\r')).toEqual({
      kind: 'ready',
      sdl: false,
      sdlError: 'Unable to load DLL'
    })
  })

  it('parses pads, masking the buttons to 17 bits and dropping malformed entries', () => {
    expect(
      parsePadLine(
        '{"pads":[{"id":"xinput:0","name":"Controller 1 (XInput)","buttons":65537},{"id":"sdl:3","name":"","buttons":1.5},{"name":"x"},null,{"id":"sdl:4","name":"DualSense","buttons":262143}]}'
      )
    ).toEqual({
      kind: 'pads',
      pads: [
        { id: 'xinput:0', name: 'Controller 1 (XInput)', buttons: 65537 },
        { id: 'sdl:3', name: 'Controller', buttons: 0 },
        { id: 'sdl:4', name: 'DualSense', buttons: 0x1ffff }
      ]
    })
    expect(parsePadLine('{"pads":[]}')).toEqual({ kind: 'pads', pads: [] })
  })

  it('keeps sticks and triggers, clamped, and leaves out malformed ones', () => {
    expect(
      parsePadLine(
        '{"pads":[{"id":"xinput:0","name":"P","buttons":0,"axes":[1,-0.609375,-0,-2],"triggers":[1,0.5]},{"id":"sdl:1","name":"S","buttons":1,"axes":[0,0,0],"triggers":[2,"x"]}]}'
      )
    ).toEqual({
      kind: 'pads',
      pads: [
        { id: 'xinput:0', name: 'P', buttons: 0, axes: [1, -0.609375, 0, -1], triggers: [1, 0.5] },
        { id: 'sdl:1', name: 'S', buttons: 1 }
      ]
    })
  })

  it('ignores noise', () => {
    expect(parsePadLine('')).toBeNull()
    expect(parsePadLine('WARNING: something')).toBeNull()
    expect(parsePadLine('{broken')).toBeNull()
    expect(parsePadLine('{"other":1}')).toBeNull()
  })
})

describe('stderrMessage and restartDelay', () => {
  it('keeps the first non-empty stderr line, capped', () => {
    expect(stderrMessage('\r\nAdd-Type : c:\\x.cs(3) : error CS1002\r\nAt line:1 char:1\r\n')).toBe(
      'Add-Type : c:\\x.cs(3) : error CS1002'
    )
    expect(stderrMessage('   \n')).toBeUndefined()
    expect(stderrMessage('x'.repeat(500))).toHaveLength(300)
  })

  it('doubles from 1 s up to 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(restartDelay)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000
    ])
  })
})

describe('createPadReader', () => {
  let reader: PadReader | null = null
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })
  afterEach(() => {
    reader?.stop()
    reader = null
    vi.useRealTimers()
  })

  it('spawns PowerShell with the script on stdin (CRLF) and reports ready and pads', () => {
    const { spawn, procs, calls } = fakeSpawn()
    reader = createPadReader({ log, sdlDir: () => "C:\\Emu's\\Ryujinx", spawn })
    const statuses: string[] = []
    const padsSeen: number[][] = []
    reader.onStatus((s) => statuses.push(s.state))
    reader.onPads((pads) => padsSeen.push(pads.map((p) => p.buttons)))
    reader.start()
    expect(calls[0]).toEqual([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      '-'
    ])
    const p = procs[0]
    const b64 = Buffer.from("C:\\Emu's\\Ryujinx", 'utf8').toString('base64')
    expect(p.written).toContain(`FromBase64String('${b64}')), 16, $false)`)
    // The here-string must be followed by a blank line, or powershell.exe swallows the Run line into it.
    expect(p.written).toContain("\r\n'@\r\n\r\n[PlayOutPadReader]::Run(")
    expect(p.written).not.toMatch(/[^\r]\n/)
    expect(p.stdinEnded).toBe(false)
    expect(reader.status().state).toBe('starting')

    p.out('{"ready":true,"sdl":true,"sdlError":""}\r\n{"pads":[{"id":"xinput:0","name":"P1","bu')
    expect(reader.status()).toEqual({ state: 'running' })
    expect(reader.pads()).toEqual([])
    p.out('ttons":1}]}\r\n')
    expect(reader.pads()).toEqual([{ id: 'xinput:0', name: 'P1', buttons: 1 }])
    // The same state again is not a change.
    p.out('{"pads":[{"id":"xinput:0","name":"P1","buttons":1}]}\r\n')
    p.out('{"pads":[{"id":"xinput:0","name":"P1","buttons":0}]}\r\n')
    expect(padsSeen).toEqual([[1], [0]])
    expect(statuses).toEqual(['starting', 'running'])
  })

  it('restarts with backoff after an exit, clearing pads, and asks sdlDir again', () => {
    const { spawn, procs } = fakeSpawn()
    const sdlDir = vi.fn(() => null)
    reader = createPadReader({ log, sdlDir, spawn })
    reader.start()
    procs[0].out(
      '{"ready":true,"sdl":false,"sdlError":""}\n{"pads":[{"id":"xinput:1","name":"P","buttons":0}]}\n'
    )
    expect(reader.pads()).toHaveLength(1)
    procs[0].stderr.emit('data', 'Something broke\r\nAt line:1\r\n')
    procs[0].exit(1)
    expect(reader.pads()).toEqual([])
    expect(reader.status()).toEqual({ state: 'starting', message: 'Something broke' })
    vi.advanceTimersByTime(999)
    expect(procs).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(procs).toHaveLength(2)
    expect(sdlDir).toHaveBeenCalledTimes(2)
    procs[1].exit(1)
    vi.advanceTimersByTime(1999)
    expect(procs).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(procs).toHaveLength(3)
  })

  it(`gives up after ${CRASH_LIMIT} fast exits with the stderr message, and start() tries again`, () => {
    const { spawn, procs } = fakeSpawn()
    reader = createPadReader({ log, sdlDir: () => null, spawn })
    reader.start()
    for (let i = 0; i < CRASH_LIMIT; i++) {
      const p = procs[procs.length - 1]
      p.stderr.emit('data', 'Add-Type : Cannot add type. Compilation errors occurred.\r\n')
      p.exit(1)
      vi.advanceTimersByTime(restartDelay(i + 1))
    }
    expect(procs).toHaveLength(CRASH_LIMIT)
    expect(reader.status()).toEqual({
      state: 'unavailable',
      message: 'Add-Type : Cannot add type. Compilation errors occurred.'
    })
    reader.start()
    expect(procs).toHaveLength(CRASH_LIMIT + 1)
    expect(reader.status().state).toBe('starting')
  })

  it('does not give up on exits spread over more than a minute', () => {
    const { spawn, procs } = fakeSpawn()
    reader = createPadReader({ log, sdlDir: () => null, spawn })
    reader.start()
    for (let i = 0; i < CRASH_LIMIT * 2; i++) {
      procs[procs.length - 1].exit(1)
      vi.advanceTimersByTime(30_000)
    }
    expect(reader.status().state).toBe('starting')
    expect(procs.length).toBeGreaterThan(CRASH_LIMIT)
  })

  it('treats a spawn error like an exit', () => {
    const { spawn, procs } = fakeSpawn()
    reader = createPadReader({ log, sdlDir: () => null, spawn })
    reader.start()
    procs[0].emit('error', new Error('spawn powershell.exe ENOENT'))
    expect(reader.status()).toEqual({ state: 'starting', message: 'spawn powershell.exe ENOENT' })
    // A later exit event of the same process is not counted twice.
    procs[0].exit(1)
    vi.advanceTimersByTime(1000)
    expect(procs).toHaveLength(2)
  })

  it('restarts a reader that never says ready', () => {
    const { spawn, procs } = fakeSpawn()
    reader = createPadReader({ log, sdlDir: () => null, spawn })
    reader.start()
    vi.advanceTimersByTime(30_000)
    expect(procs[0].killed).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(procs).toHaveLength(2)
  })

  it('stop() closes stdin, kills a lingering process, clears pads and does not restart', () => {
    const { spawn, procs } = fakeSpawn()
    reader = createPadReader({ log, sdlDir: () => null, spawn })
    reader.start()
    reader.start() // no second process
    expect(procs).toHaveLength(1)
    procs[0].out(
      '{"ready":true,"sdl":false,"sdlError":""}\n{"pads":[{"id":"xinput:0","name":"P","buttons":0}]}\n'
    )
    const seen = vi.fn()
    reader.onPads(seen)
    reader.stop()
    expect(procs[0].stdinEnded).toBe(true)
    expect(seen).toHaveBeenCalledWith([])
    expect(reader.status().state).toBe('unavailable')
    procs[0].exit(0)
    vi.advanceTimersByTime(60_000)
    expect(procs).toHaveLength(1)
    expect(procs[0].killed).toBe(true)
  })

  it('unsubscribes listeners', () => {
    const { spawn, procs } = fakeSpawn()
    reader = createPadReader({ log, sdlDir: () => null, spawn })
    const seen = vi.fn()
    const off = reader.onPads(seen)
    off()
    reader.start()
    procs[0].out('{"pads":[{"id":"xinput:0","name":"P","buttons":3}]}\n')
    expect(seen).not.toHaveBeenCalled()
  })
})

describe.skipIf(process.platform !== 'win32')('pad reader on Windows', () => {
  it('compiles the C# and reports ready from a real powershell.exe, then stops', async () => {
    const reader = createPadReader({ log, sdlDir: () => null })
    const ready = new Promise<void>((resolve) =>
      reader.onStatus((s) => {
        if (s.state === 'running') resolve()
      })
    )
    reader.start()
    await ready
    expect(reader.status()).toEqual({ state: 'running' })
    expect(Array.isArray(reader.pads())).toBe(true)
    reader.stop()
  }, 30_000)
})
