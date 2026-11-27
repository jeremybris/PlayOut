import type { ChildProcess, SpawnOptions } from 'child_process'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { basename, isAbsolute, join } from 'path'
import { createServer } from 'https'
import { PassThrough } from 'stream'
import { generate } from 'selfsigned'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '../logger'
import {
  createSunshine,
  credentialsMatch,
  normalizeAddress,
  pinnedSunshineRequest,
  SunshineApiError,
  sunshineApps,
  sunshineConf,
  sunshinePorts,
  type SunshineDeps,
  type SunshineHttpRequest
} from './sunshine'

const log: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

interface FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null
  killed: boolean
  stdout: PassThrough
  stderr: PassThrough
  kill(): boolean
  /** The process ends and its output closes. */
  exit(code: number): void
  /** The process ends while something else still holds its output: 'exit' without 'close'. */
  die(code: number): void
  /** The output of a process that died closes at last. */
  release(): void
}

let nextPid = 100

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = nextPid++
  child.exitCode = null
  child.killed = false
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  let closed = false
  child.die = (code: number): void => {
    if (child.exitCode !== null) return
    child.exitCode = code
    child.emit('exit', code)
  }
  child.release = (): void => {
    if (closed || child.exitCode === null) return
    closed = true
    child.emit('close', child.exitCode)
  }
  child.exit = (code: number): void => {
    child.die(code)
    child.release()
  }
  child.kill = (): boolean => {
    child.killed = true
    child.exit(1)
    return true
  }
  queueMicrotask(() => child.emit('spawn'))
  return child
}

interface SpawnCall {
  /** Windows tools by short name ('taskkill', 'sc', 'powershell'); anything else as spawned. */
  command: string
  /** What was actually spawned. */
  path: string
  args: readonly string[]
  options: SpawnOptions
  child: FakeChild
}

/** Records every spawn; `onSpawn` decides how a child behaves (default: keeps running). */
function fakeSpawn(onSpawn: (call: SpawnCall) => void = () => undefined): {
  spawn: SunshineDeps['spawn']
  calls: SpawnCall[]
} {
  const calls: SpawnCall[] = []
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    const child = fakeChild()
    // Windows tools are spawned by full path (System32); the tests name them by their short name.
    const system = /[\\/]System32[\\/]/i.test(command)
    const call = {
      command: system
        ? basename(command)
            .replace(/\.exe$/i, '')
            .toLowerCase()
        : command,
      path: command,
      args,
      options,
      child
    }
    calls.push(call)
    onSpawn(call)
    return child as unknown as ChildProcess
  }
  return { spawn, calls }
}

let root: string
let exe: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-sunshine-'))
  const dir = join(root, 'app', 'v1', 'Sunshine')
  await fs.mkdir(dir, { recursive: true })
  exe = join(dir, 'sunshine.exe')
  await fs.writeFile(exe, '')
  await fs.writeFile(join(root, 'app', 'installed.json'), JSON.stringify({ tag: 'v1' }))
})

afterEach(async () => {
  vi.useRealTimers()
  await fs.rm(root, { recursive: true, force: true })
})

const okRequest = async (): Promise<{ status: number; body: string }> => ({
  status: 200,
  body: '{"apps":[]}'
})

function sunshine(extra: Partial<SunshineDeps> = {}): ReturnType<typeof createSunshine> {
  return createSunshine({
    root,
    log,
    spawn: fakeSpawn().spawn,
    request: okRequest,
    probePort: async () => false,
    ownProcesses: async () => [],
    sleep: async () => undefined,
    ...extra
  })
}

const config = {
  name: 'Den PC',
  appCommand: '"C:\\PlayOut\\PlayOut.exe" --stream-launch'
}

describe('config files', () => {
  it('writes absolute paths, local-only web UI, no tray and no UPnP of its own', () => {
    const conf = sunshineConf('C:\\cfg', { ...config, name: 'Bad\r\nname = x' })
    expect(conf).toContain('sunshine_name = Bad  name   x\r\n')
    expect(conf).toContain('file_apps = C:\\cfg\\apps.json')
    expect(conf).toContain('credentials_file = C:\\cfg\\sunshine_state.json')
    expect(conf).toContain('file_state = C:\\cfg\\sunshine_state.json')
    expect(conf).toContain('log_path = C:\\cfg\\sunshine.log')
    expect(conf).toContain('pkey = C:\\cfg\\credentials\\cakey.pem')
    expect(conf).toContain('cert = C:\\cfg\\credentials\\cacert.pem')
    expect(conf).toContain('origin_web_ui_allowed = pc')
    expect(conf).toContain('system_tray = disabled')
    // PlayOut forwards Sunshine's ports itself: Sunshine's own mappings would outlive its forced stop.
    expect(conf).toContain('upnp = disabled')
    expect(conf).toContain('port = 47989')
    const other = sunshineConf('C:\\cfg', { ...config, port: 50000 })
    expect(other).toContain('port = 50000')
  })

  it("lists Sunshine's stream ports for the router", () => {
    expect(sunshinePorts(47989)).toEqual([
      ['TCP', 47984],
      ['TCP', 47989],
      ['TCP', 48010],
      ['UDP', 47998],
      ['UDP', 47999],
      ['UDP', 48000]
    ])
  })

  it('offers the single PlayOut app that waits for the game', () => {
    expect(JSON.parse(sunshineApps('"x.exe" --stream-launch'))).toEqual({
      env: {},
      apps: [
        {
          name: 'PlayOut',
          cmd: '"x.exe" --stream-launch',
          'auto-detach': false,
          'wait-all': true,
          'exit-timeout': 5
        }
      ]
    })
  })

  it('configure writes both files into the config folder', async () => {
    await sunshine().configure(config)
    const conf = await fs.readFile(join(root, 'config', 'sunshine.conf'), 'utf8')
    expect(conf).toContain(`file_apps = ${join(root, 'config', 'apps.json')}`)
    const apps = JSON.parse(await fs.readFile(join(root, 'config', 'apps.json'), 'utf8'))
    expect(apps.apps[0].cmd).toBe(config.appCommand)
  })
})

describe('helpers', () => {
  it('normalizes the addresses Sunshine and Node report', () => {
    expect(normalizeAddress('::ffff:192.168.1.20')).toBe('192.168.1.20')
    expect(normalizeAddress('192.168.1.20:5555')).toBe('192.168.1.20')
    expect(normalizeAddress('[FE80::1]:47989')).toBe('fe80::1')
    expect(normalizeAddress(' 10.0.0.2 ')).toBe('10.0.0.2')
  })

  it('checks a stored login against its salted hash', () => {
    const salt = 'abcdefghijklmnop'
    const password = createHash('sha256')
      .update('secret' + salt)
      .digest('hex')
      .toUpperCase()
    const state = { username: 'playout', salt, password }
    expect(credentialsMatch(state, 'playout', 'secret')).toBe(true)
    expect(credentialsMatch(state, 'playout', 'other')).toBe(false)
    expect(credentialsMatch(state, 'admin', 'secret')).toBe(false)
    expect(credentialsMatch(null, 'playout', 'secret')).toBe(false)
  })
})

describe('credentials', () => {
  it('sets the login with --creds after the conf path, and keeps the password', async () => {
    const stored: string[] = []
    const { spawn, calls } = fakeSpawn((call) => queueMicrotask(() => call.child.exit(0)))
    const s = sunshine({
      spawn,
      secret: { get: async () => null, set: async (v) => void stored.push(v) }
    })
    await s.configure(config)
    await s.ensureCredentials()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatch(/^[0-9a-f]{48}$/)
    expect(calls[0].command).toBe(exe)
    expect(calls[0].args).toEqual([
      join(root, 'config', 'sunshine.conf'),
      '--creds',
      'playout',
      stored[0]
    ])
  })

  it('skips --creds when the state file already holds the login', async () => {
    const salt = '0123456789abcdef'
    await fs.mkdir(join(root, 'config'), { recursive: true })
    await fs.writeFile(
      join(root, 'config', 'sunshine_state.json'),
      JSON.stringify({
        username: 'playout',
        salt,
        password: createHash('sha256')
          .update('pw' + salt)
          .digest('hex')
      })
    )
    const { spawn, calls } = fakeSpawn()
    const s = sunshine({ spawn, secret: { get: async () => 'pw', set: async () => undefined } })
    await s.ensureCredentials()
    expect(calls).toHaveLength(0)
  })

  it('reports a failed --creds', async () => {
    const { spawn } = fakeSpawn((call) => queueMicrotask(() => call.child.exit(3)))
    const s = sunshine({ spawn })
    await s.configure(config)
    await expect(s.ensureCredentials()).rejects.toThrow(/exit 3/)
  })
})

describe('running Sunshine', () => {
  it('starts it hidden with the conf and waits for the API', async () => {
    const { spawn, calls } = fakeSpawn()
    const statuses: string[] = []
    const s = sunshine({ spawn, onStatus: (st) => statuses.push(st.state) })
    await s.configure(config)
    await s.start()
    expect(calls[0].command).toBe(exe)
    expect(calls[0].args).toEqual([join(root, 'config', 'sunshine.conf')])
    expect(calls[0].options).toMatchObject({
      windowsHide: true,
      cwd: join(root, 'app', 'v1', 'Sunshine')
    })
    expect(s.running()).toBe(true)
    expect(s.status()).toMatchObject({ state: 'running', version: 'v1' })
    expect(statuses).toContain('running')
    await s.start()
    expect(calls).toHaveLength(1)
  })

  it('refuses to start beside another Sunshine', async () => {
    const ports: number[] = []
    const s = sunshine({
      probePort: async (p) => {
        ports.push(p)
        return p === 47990
      }
    })
    await expect(s.start()).rejects.toThrow(/another copy of Sunshine/)
    expect(ports.sort()).toEqual([47989, 47990])
  })

  it('ends a Sunshine an earlier PlayOut left running, then starts its own', async () => {
    let orphanAlive = true
    const dirs: string[] = []
    const { spawn, calls } = fakeSpawn((call) => {
      if (call.command === 'taskkill') {
        if (call.args.at(-1) === '4242') orphanAlive = false
        queueMicrotask(() => call.child.exit(0))
      }
    })
    const s = sunshine({
      spawn,
      probePort: async () => orphanAlive,
      ownProcesses: async (dir) => {
        dirs.push(dir)
        return orphanAlive ? [4242] : []
      }
    })
    await s.start()
    expect(dirs).toEqual([join(root, 'app')])
    expect(calls.map((c) => c.command)).toEqual(['taskkill', exe])
    expect(calls[0].args).toEqual(['/T', '/F', '/PID', '4242'])
    expect(s.running()).toBe(true)
  })

  it('shares one start between overlapping callers', async () => {
    const { spawn, calls } = fakeSpawn()
    let answer: () => void = () => undefined
    let first = true
    const s = sunshine({
      spawn,
      request: async () => {
        // The first readiness check hangs until both starts are under way.
        if (first) {
          first = false
          await new Promise<void>((r) => (answer = r))
        }
        return { status: 200, body: '{}' }
      }
    })
    const a = s.start()
    const b = s.start()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    answer()
    await Promise.all([a, b])
    expect(calls.filter((c) => c.command === exe)).toHaveLength(1)
    expect(s.running()).toBe(true)
  })

  it('fails the start when Sunshine refuses the login', async () => {
    const { spawn, calls } = fakeSpawn((call) => {
      if (call.command === 'taskkill') calls[0].child.exit(1)
    })
    const s = sunshine({ spawn, request: async () => ({ status: 401, body: '' }) })
    await expect(s.start()).rejects.toBeInstanceOf(SunshineApiError)
    expect(s.running()).toBe(false)
    expect(s.status().state).toBe('error')
  })

  it('restarts it when it dies, and stops the whole tree on stop', async () => {
    const { spawn, calls } = fakeSpawn((call) => {
      if (call.command === 'taskkill') {
        const pid = Number(call.args.at(-1))
        calls.find((c) => c.child.pid === pid)?.child.exit(1)
      }
    })
    const s = sunshine({ spawn })
    await s.start()
    vi.useFakeTimers()
    calls[0].child.exit(5)
    expect(s.running()).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(2)
    expect(s.running()).toBe(true)
    vi.useRealTimers()
    await s.stop()
    const kill = calls.find((c) => c.command === 'taskkill')!
    expect(kill.args).toEqual(['/T', '/F', '/PID', String(calls[1].child.pid)])
    expect(s.running()).toBe(false)
    expect(s.status().state).toBe('installed')
  })

  it('tells its owner when it closed on its own, not when it was stopped', async () => {
    const { spawn, calls } = fakeSpawn((call) => {
      if (call.command === 'taskkill') {
        const pid = Number(call.args.at(-1))
        calls.find((c) => c.child.pid === pid)?.child.exit(1)
      }
    })
    let exits = 0
    const s = sunshine({ spawn, onExit: () => void exits++ })
    await s.start()
    expect(exits).toBe(0)
    vi.useFakeTimers()
    calls[0].child.exit(5)
    expect(exits).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.running()).toBe(true)
    vi.useRealTimers()
    await s.stop()
    expect(s.running()).toBe(false)
    expect(exits).toBe(1)
  })

  it('tells its owner as soon as the process ends, while its app still holds the output open', async () => {
    const { spawn, calls } = fakeSpawn((call) => {
      if (call.command === 'taskkill') {
        const pid = Number(call.args.at(-1))
        calls.find((c) => c.child.pid === pid)?.child.exit(1)
      }
    })
    let exits = 0
    const s = sunshine({ spawn, onExit: () => void exits++ })
    await s.start()
    vi.useFakeTimers()
    calls[0].child.die(5)
    expect(exits).toBe(1)
    expect(s.running()).toBe(false)
    // The restart does not wait for the output either; when that closes at last, nothing happens a second time.
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(2)
    expect(s.running()).toBe(true)
    calls[0].child.release()
    expect(exits).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(2)
    expect(s.running()).toBe(true)
    vi.useRealTimers()
    await s.stop()
    expect(exits).toBe(1)
  })
})

describe('web API', () => {
  it('uses Basic auth on port + 1 and sends JSON on POST', async () => {
    const seen: SunshineHttpRequest[] = []
    const s = sunshine({
      secret: { get: async () => 'pw', set: async () => undefined },
      request: async (req) => {
        seen.push(req)
        return { status: 200, body: '' }
      }
    })
    await s.configure({ ...config, port: 50000 })
    await s.closeApp()
    expect(seen[0].url).toBe('https://127.0.0.1:50001/api/apps/close')
    expect(seen[0].method).toBe('POST')
    expect(seen[0].headers.Authorization).toBe(
      `Basic ${Buffer.from('playout:pw').toString('base64')}`
    )
    expect(seen[0].headers['Content-Type']).toBe('application/json')
    expect(seen[0].headers.Origin).toBeUndefined()
    expect(seen[0].body).toBe('{}')
  })

  it("hands Sunshine's certificate to the request once it exists", async () => {
    const seen: (string | undefined)[] = []
    const s = sunshine({
      request: async (req) => {
        seen.push(req.pinnedCertPem)
        return { status: 200, body: '' }
      }
    })
    await s.api('/api/apps')
    await fs.mkdir(join(root, 'config', 'credentials'), { recursive: true })
    await fs.writeFile(join(root, 'config', 'credentials', 'cacert.pem'), 'PEM')
    await s.api('/api/apps')
    expect(seen).toEqual([undefined, 'PEM'])
  })

  it('turns HTTP errors into SunshineApiError', async () => {
    const s = sunshine({ request: async () => ({ status: 500, body: 'boom' }) })
    await expect(s.api('/api/apps')).rejects.toMatchObject({ status: 500, body: 'boom' })
  })

  it('approves the pending pairing from the client address with the PIN', async () => {
    let polls = 0
    const posts: unknown[] = []
    const s = sunshine({
      request: async (req) => {
        if (req.method === 'GET') {
          polls++
          const pairings =
            polls < 3
              ? [{ id: 'other', name: 'x', address: '10.0.0.9' }]
              : [
                  { id: 'other', name: 'x', address: '10.0.0.9' },
                  { id: 'a'.repeat(32), name: 'y', address: '::ffff:192.168.1.20' }
                ]
          return { status: 200, body: JSON.stringify({ pairings }) }
        }
        posts.push(JSON.parse(req.body!))
        return { status: 200, body: '{"status":true}' }
      }
    })
    const ok = await s.approvePairing({
      clientAddress: '192.168.1.20',
      pin: '0420',
      name: 'Laptop'
    })
    expect(ok).toBe(true)
    expect(polls).toBe(3)
    expect(posts).toEqual([{ pairing_id: 'a'.repeat(32), pin: '0420', name: 'Laptop' }])
  })

  it('gives up when no pairing request arrives in time', async () => {
    let t = 0
    const s = sunshine({
      now: () => t,
      sleep: async (ms) => void (t += ms),
      request: async () => ({ status: 200, body: '{"pairings":[]}' })
    })
    expect(
      await s.approvePairing({ clientAddress: '1.2.3.4', pin: '1111', name: 'x', timeoutMs: 5000 })
    ).toBe(false)
    await expect(
      s.approvePairing({ clientAddress: '1.2.3.4', pin: '12a4', name: 'x' })
    ).rejects.toThrow(/4 digits/)
  })
})

describe('controller driver', () => {
  it('asks sc.exe whether the ViGEmBus service exists', async () => {
    const yes = fakeSpawn((call) => queueMicrotask(() => call.child.exit(0)))
    expect(await sunshine({ spawn: yes.spawn }).controllerDriverInstalled()).toBe(true)
    expect(yes.calls[0]).toMatchObject({ command: 'sc', args: ['query', 'ViGEmBus'] })
    // By full path: a bare name would be looked up in the current folder first.
    expect(isAbsolute(yes.calls[0].path)).toBe(true)
    expect(yes.calls[0].path).toMatch(/[\\/]System32[\\/]sc\.exe$/i)
    const no = fakeSpawn((call) => queueMicrotask(() => call.child.exit(1060)))
    expect(await sunshine({ spawn: no.spawn }).controllerDriverInstalled()).toBe(false)
  })
})

describe('pinned request', () => {
  function makeCert(): Promise<{ key: string; cert: string }> {
    return new Promise((resolve, reject) =>
      generate(
        [{ name: 'commonName', value: 'Sunshine Gamestream Host' }],
        { keySize: 2048 },
        (err, r) => (err || !r ? reject(err) : resolve({ key: r.private, cert: r.cert }))
      )
    )
  }

  it('sends the request only to the server holding the pinned certificate', async () => {
    const [mine, other] = await Promise.all([makeCert(), makeCert()])
    const received: string[] = []
    const server = createServer({ key: mine.key, cert: mine.cert }, (req, res) => {
      received.push(String(req.headers.authorization))
      res.end('{"ok":true}')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    const base = {
      method: 'GET',
      url: `https://127.0.0.1:${port}/api/apps`,
      headers: { Authorization: 'Basic secret' },
      timeoutMs: 5000
    }
    try {
      expect(await pinnedSunshineRequest({ ...base, pinnedCertPem: mine.cert })).toEqual({
        status: 200,
        body: '{"ok":true}'
      })
      await expect(pinnedSunshineRequest({ ...base, pinnedCertPem: other.cert })).rejects.toThrow(
        /certificate mismatch/
      )
      await expect(pinnedSunshineRequest(base)).rejects.toThrow(/not there yet/)
      expect(received).toEqual(['Basic secret'])
    } finally {
      server.close()
    }
  }, 30_000)
})
