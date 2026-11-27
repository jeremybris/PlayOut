import type { ChildProcess, SpawnOptions } from 'child_process'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logger'
import { createMoonlight, streamArgs, type MoonlightDeps } from './moonlight'

const log: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

interface FakeChild extends EventEmitter {
  exitCode: number | null
  stdout: PassThrough
  stderr: PassThrough
  kill(): boolean
  exit(code: number): void
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.exitCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exit = (code: number): void => {
    if (child.exitCode !== null) return
    child.exitCode = code
    child.emit('close', code)
  }
  child.kill = (): boolean => {
    child.exit(1)
    return true
  }
  queueMicrotask(() => child.emit('spawn'))
  return child
}

interface SpawnCall {
  command: string
  args: readonly string[]
  options: SpawnOptions
  child: FakeChild
}

function fakeSpawn(onSpawn: (call: SpawnCall) => void = () => undefined): {
  spawn: MoonlightDeps['spawn']
  calls: SpawnCall[]
} {
  const calls: SpawnCall[] = []
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const child = fakeChild()
    const call = { command, args, options, child }
    calls.push(call)
    onSpawn(call)
    return child as unknown as ChildProcess
  }
  return { spawn, calls }
}

let root: string
let dir: string
let exe: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-moonlight-'))
  dir = join(root, 'app', 'v6.2.0', 'MoonlightPortable')
  await fs.mkdir(dir, { recursive: true })
  exe = join(dir, 'Moonlight.exe')
  await fs.writeFile(exe, '')
  await fs.writeFile(join(root, 'app', 'installed.json'), JSON.stringify({ tag: 'v6.2.0' }))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('streamArgs', () => {
  const base = { fps: 60, bitrateKbps: 0, displayMode: 'fullscreen' as const }

  it('maps the preset resolutions to their flags', () => {
    expect(streamArgs('10.0.0.2', 'PlayOut', { ...base, resolution: '1080' })).toEqual([
      'stream',
      '10.0.0.2',
      'PlayOut',
      '--1080',
      '--fps',
      '60',
      '--display-mode',
      'fullscreen',
      '--quit-after'
    ])
    expect(streamArgs('h', 'a', { ...base, resolution: '4K' })).toContain('--4K')
  })

  it('uses the screen size for auto, and the bitrate when set', () => {
    const args = streamArgs('h', 'a', {
      ...base,
      resolution: 'auto',
      screen: { width: 2560, height: 1440 },
      bitrateKbps: 30000
    })
    expect(args).toEqual(
      expect.arrayContaining(['--resolution', '2560x1440', '--bitrate', '30000'])
    )
    expect(streamArgs('h', 'a', { ...base, resolution: 'auto' })).not.toContain('--resolution')
  })
})

describe('createMoonlight', () => {
  it('runs from its own folder with portable.dat beside it', async () => {
    const { spawn, calls } = fakeSpawn()
    const m = createMoonlight({ root, log, spawn })
    const child = await m.stream('192.168.1.5', 'PlayOut', {
      resolution: '720',
      fps: 30,
      bitrateKbps: 0,
      displayMode: 'fullscreen'
    })
    expect(child).toBe(calls[0].child)
    expect(calls[0].command).toBe(exe)
    expect(calls[0].options.cwd).toBe(dir)
    expect(calls[0].args.slice(0, 4)).toEqual(['stream', '192.168.1.5', 'PlayOut', '--720'])
    await expect(fs.access(join(dir, 'portable.dat'))).resolves.toBeUndefined()
    expect(m.status()).toMatchObject({ state: 'installed', version: 'v6.2.0' })
  })

  it('pairs with the given PIN and reports when the window closed', async () => {
    const { spawn, calls } = fakeSpawn()
    const m = createMoonlight({ root, log, spawn })
    const { child, done } = await m.pair('192.168.1.5:47989', '0420')
    expect(calls[0].args).toEqual(['pair', '192.168.1.5:47989', '--pin', '0420'])
    child.kill()
    await expect(done).resolves.toBeUndefined()
    await expect(m.pair('h', '12345')).rejects.toThrow(/4 digits/)
  })

  it('knows it is paired from the list exit code', async () => {
    const ok = fakeSpawn((c) => queueMicrotask(() => c.child.exit(0)))
    expect(await createMoonlight({ root, log, spawn: ok.spawn }).isPaired('10.0.0.2')).toBe(true)
    expect(ok.calls[0].args).toEqual(['list', '10.0.0.2'])
    const no = fakeSpawn((c) => queueMicrotask(() => c.child.exit(-1)))
    expect(await createMoonlight({ root, log, spawn: no.spawn }).isPaired('10.0.0.2')).toBe(false)
  })

  it('quits the host app', async () => {
    const { spawn, calls } = fakeSpawn((c) => queueMicrotask(() => c.child.exit(0)))
    await createMoonlight({ root, log, spawn }).quit('10.0.0.2')
    expect(calls[0].args).toEqual(['quit', '10.0.0.2'])
  })

  it('refuses host strings that would read as options', async () => {
    const m = createMoonlight({ root, log, spawn: fakeSpawn().spawn })
    await expect(m.quit('--help')).rejects.toThrow(/not a host/)
    await expect(m.isPaired('a b')).rejects.toThrow(/not a host/)
  })

  it('says when Moonlight is not installed', async () => {
    await fs.rm(join(root, 'app'), { recursive: true })
    const m = createMoonlight({ root, log, spawn: fakeSpawn().spawn })
    await expect(m.quit('h')).rejects.toThrow(/not installed/)
    expect(m.status().state).toBe('missing')
  })
})
