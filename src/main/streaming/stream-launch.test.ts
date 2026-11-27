import { randomBytes } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../events'
import type { Logger } from '../logger'
import {
  createStreamLaunchServer,
  ensureStreamLaunchToken,
  hasStreamLaunchFlag,
  runStreamLaunchClient,
  sessionEndWaiter,
  startPlayOut,
  streamLaunchPipeName,
  type StreamLaunchServer,
  type StreamLaunchServerDeps
} from './stream-launch'

const TOKEN = 'a'.repeat(64)

function testPipe(): string {
  const id = randomBytes(6).toString('hex')
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\playout-test-${id}`
    : join(tmpdir(), `playout-test-${id}.sock`)
}

const quietLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

let dirs: string[] = []
let servers: StreamLaunchServer[] = []
afterEach(async () => {
  for (const s of servers) await s.close()
  servers = []
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function tokenFile(token = TOKEN): string {
  const dir = mkdtempSync(join(tmpdir(), 'playout-stream-launch-'))
  dirs.push(dir)
  const file = join(dir, 'stream-launch.token')
  writeFileSync(file, token)
  return file
}

interface Harness {
  pipeName: string
  tokenFile: string
  gone: string[]
  endGame: (gameId: string) => void
  server: StreamLaunchServer
}

async function startServer(overrides: Partial<StreamLaunchServerDeps> = {}): Promise<Harness> {
  const pipeName = testPipe()
  const gone: string[] = []
  const waiting = new Map<string, () => void>()
  const server = createStreamLaunchServer({
    pipeName,
    token: TOKEN,
    onRun: async () => ({ gameId: 'steam:620' }),
    waitEnded: (gameId) => new Promise<void>((resolve) => waiting.set(gameId, resolve)),
    onClientGone: (gameId) => {
      gone.push(gameId)
    },
    log: quietLog,
    ...overrides
  })
  await server.listen()
  servers.push(server)
  return {
    pipeName,
    tokenFile: tokenFile(),
    gone,
    endGame: (gameId) => waiting.get(gameId)?.(),
    server
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** A raw client: send one line, collect every line until the pipe closes. */
function rawClient(pipeName: string, line: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipeName)
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (data += chunk))
    socket.on('error', reject)
    socket.on('close', () => resolve(data.split('\n').filter(Boolean)))
    socket.on('connect', () => socket.write(line))
  })
}

describe('stream launch helpers', () => {
  it('recognises the flag in argv', () => {
    expect(hasStreamLaunchFlag(['PlayOut.exe', '--stream-launch'])).toBe(true)
    expect(hasStreamLaunchFlag(['PlayOut.exe', '--stream-launch=steam:620'])).toBe(true)
    expect(hasStreamLaunchFlag(['PlayOut.exe', '--stream-launcher'])).toBe(false)
    expect(hasStreamLaunchFlag(['PlayOut.exe'])).toBe(false)
  })

  it('derives a stable per-user pipe name without the user name in it', () => {
    const a = streamLaunchPipeName('PC\\Jeremy')
    expect(a).toMatch(/^\\\\\.\\pipe\\playout-stream-[0-9a-f]{16}$/)
    expect(a).not.toContain('Jeremy')
    expect(streamLaunchPipeName('pc\\jeremy')).toBe(a)
    expect(streamLaunchPipeName('PC\\Other')).not.toBe(a)
    expect(streamLaunchPipeName()).toMatch(/playout-stream-/)
  })

  it('creates the token once and reuses it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'playout-stream-launch-'))
    dirs.push(dir)
    const file = join(dir, 'streaming', 'stream-launch.token')
    const first = await ensureStreamLaunchToken(file)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await ensureStreamLaunchToken(file)).toBe(first)
    expect(readFileSync(file, 'utf8')).toBe(first)
    writeFileSync(file, 'garbage')
    expect(await ensureStreamLaunchToken(file)).not.toBe(first)
  })
})

describe('stream launch server and client', () => {
  it('runs the game, blocks until it ends, then exits 0', async () => {
    const h = await startServer()
    const lines: string[] = []
    const exit = runStreamLaunchClient(['x', '--stream-launch'], {
      pipeName: h.pipeName,
      tokenFile: h.tokenFile,
      log: (l) => lines.push(l)
    })
    await waitUntil(() => h.server.active() === 'steam:620')
    let settled = false
    void exit.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)
    h.endGame('steam:620')
    expect(await exit).toBe(0)
    expect(lines).toContain('started steam:620')
    expect(h.gone).toEqual([])
    await waitUntil(() => h.server.active() === null)
  })

  it('reports a failed launch as exit code 1', async () => {
    const h = await startServer({ onRun: async () => ({ error: 'nothing armed' }) })
    const lines: string[] = []
    const code = await runStreamLaunchClient(['--stream-launch'], {
      pipeName: h.pipeName,
      tokenFile: h.tokenFile,
      log: (l) => lines.push(l)
    })
    expect(code).toBe(1)
    expect(lines).toContain('PlayOut refused: nothing armed')
  })

  it('closes the game when the client goes away (the viewer quit the stream)', async () => {
    const h = await startServer()
    const socket = connect(h.pipeName)
    await new Promise((r) => socket.once('connect', r))
    socket.write(`${JSON.stringify({ op: 'run', token: TOKEN })}\n`)
    await waitUntil(() => h.server.active() === 'steam:620')
    socket.destroy()
    await waitUntil(() => h.gone.length > 0)
    expect(h.gone).toEqual(['steam:620'])
    expect(h.server.active()).toBeNull()
  })

  it('closes a game whose client left while it was starting', async () => {
    let release: () => void = () => {}
    const h = await startServer({
      onRun: () =>
        new Promise((resolve) => {
          release = () => resolve({ gameId: 'rom:snes:smw' })
        })
    })
    const socket = connect(h.pipeName)
    await new Promise((r) => socket.once('connect', r))
    socket.write(`${JSON.stringify({ op: 'run', token: TOKEN })}\n`)
    await new Promise((r) => setTimeout(r, 50))
    socket.destroy()
    await new Promise((r) => setTimeout(r, 50))
    release()
    await waitUntil(() => h.gone.length > 0)
    expect(h.gone).toEqual(['rom:snes:smw'])
  })

  it('keeps the stream slot until the game of a client that left is closed', async () => {
    let releaseRun: () => void = () => {}
    let releaseStop: () => void = () => {}
    const order: string[] = []
    const onRun = vi.fn(
      () =>
        new Promise<{ gameId: string }>((resolve) => {
          order.push('run')
          releaseRun = () => resolve({ gameId: 'steam:620' })
        })
    )
    const h = await startServer({
      onRun,
      onClientGone: (gameId) =>
        new Promise<void>((resolve) => {
          order.push(`gone ${gameId}`)
          releaseStop = () => {
            order.push('stopped')
            resolve()
          }
        })
    })
    const a = connect(h.pipeName)
    await new Promise((r) => a.once('connect', r))
    a.write(`${JSON.stringify({ op: 'run', token: TOKEN })}\n`)
    await waitUntil(() => onRun.mock.calls.length === 1)
    a.destroy()
    await new Promise((r) => setTimeout(r, 50))

    // Client B reconnects while A's launch is still pending, then again while A's game is being closed.
    const line = `${JSON.stringify({ op: 'run', token: TOKEN })}\n`
    const busy = [JSON.stringify({ event: 'error', message: 'busy' })]
    expect(await rawClient(h.pipeName, line)).toEqual(busy)
    releaseRun()
    await waitUntil(() => order.includes('gone steam:620'))
    expect(await rawClient(h.pipeName, line)).toEqual(busy)
    expect(onRun).toHaveBeenCalledTimes(1)

    releaseStop()
    await waitUntil(() => h.server.active() === null && order.includes('stopped'))
    const b = runStreamLaunchClient(['--stream-launch'], {
      pipeName: h.pipeName,
      tokenFile: h.tokenFile
    })
    await waitUntil(() => onRun.mock.calls.length === 2)
    releaseRun()
    await waitUntil(() => h.server.active() === 'steam:620')
    h.endGame('steam:620')
    expect(await b).toBe(0)
    expect(order).toEqual(['run', 'gone steam:620', 'stopped', 'run'])
  })

  it('refuses a wrong token, junk and a second stream', async () => {
    const onRun = vi.fn(async () => ({ gameId: 'steam:620' }))
    const h = await startServer({ onRun })
    expect(await rawClient(h.pipeName, `${JSON.stringify({ op: 'run', token: 'b' })}\n`)).toEqual([
      JSON.stringify({ event: 'error', message: 'unauthorized' })
    ])
    expect(await rawClient(h.pipeName, 'hello\n')).toEqual([
      JSON.stringify({ event: 'error', message: 'unknown request' })
    ])
    expect(onRun).not.toHaveBeenCalled()

    const first = runStreamLaunchClient(['--stream-launch'], {
      pipeName: h.pipeName,
      tokenFile: h.tokenFile
    })
    await waitUntil(() => h.server.active() === 'steam:620')
    expect(await rawClient(h.pipeName, `${JSON.stringify({ op: 'run', token: TOKEN })}\n`)).toEqual(
      [JSON.stringify({ event: 'error', message: 'busy' })]
    )
    h.endGame('steam:620')
    expect(await first).toBe(0)
    expect(onRun).toHaveBeenCalledTimes(1)
  })

  it('drops a client on request: its game closes and the slot is free again', async () => {
    const h = await startServer()
    const exit = runStreamLaunchClient(['--stream-launch'], {
      pipeName: h.pipeName,
      tokenFile: h.tokenFile
    })
    await waitUntil(() => h.server.active() === 'steam:620')
    h.server.dropClient()
    expect(await exit).toBe(1)
    await waitUntil(() => h.gone.length > 0)
    expect(h.gone).toEqual(['steam:620'])
    await waitUntil(() => h.server.active() === null)
    // Nothing connected: nothing to drop.
    h.server.dropClient()
    expect(h.gone).toEqual(['steam:620'])
  })

  it('does not close games when PlayOut itself shuts the server down', async () => {
    const h = await startServer()
    const exit = runStreamLaunchClient(['--stream-launch'], {
      pipeName: h.pipeName,
      tokenFile: h.tokenFile
    })
    await waitUntil(() => h.server.active() === 'steam:620')
    await h.server.close()
    expect(await exit).toBe(1)
    expect(h.gone).toEqual([])
  })

  it('starts PlayOut once when the pipe is missing and retries until it answers', async () => {
    const pipeName = testPipe()
    const file = tokenFile()
    let starts = 0
    const exit = runStreamLaunchClient(['--stream-launch'], {
      pipeName,
      tokenFile: file,
      retryMs: 20,
      startApp: () => {
        starts++
        // PlayOut comes up a little later, like a real start.
        setTimeout(() => {
          const server = createStreamLaunchServer({
            pipeName,
            token: TOKEN,
            onRun: async () => ({ gameId: 'steam:620' }),
            waitEnded: async () => {},
            onClientGone: () => {},
            log: quietLog
          })
          servers.push(server)
          void server.listen()
        }, 100)
      }
    })
    expect(await exit).toBe(0)
    expect(starts).toBe(1)
  })

  it('gives up after the connect timeout', async () => {
    let starts = 0
    const code = await runStreamLaunchClient(['--stream-launch'], {
      pipeName: testPipe(),
      tokenFile: tokenFile(),
      connectTimeoutMs: 100,
      retryMs: 20,
      startApp: () => starts++
    })
    expect(code).toBe(1)
    expect(starts).toBe(1)
  })

  it('starts PlayOut through Explorer so it outlives the stream job', () => {
    const child = { on: vi.fn(), unref: vi.fn() }
    const spawnFn = vi.fn(() => child)
    startPlayOut(spawnFn as unknown as Parameters<typeof startPlayOut>[0])
    expect(spawnFn).toHaveBeenCalledWith(
      // By full path, never looked up in the current folder.
      join(process.env['SystemRoot'] || process.env['windir'] || 'C:\\Windows', 'explorer.exe'),
      [process.env['PORTABLE_EXECUTABLE_FILE'] || process.execPath],
      { detached: true, stdio: 'ignore' }
    )
    expect(child.unref).toHaveBeenCalled()
  })

  it('exits 2 without the flag', async () => {
    expect(await runStreamLaunchClient([], { pipeName: testPipe(), tokenFile: 'x' })).toBe(2)
  })
})

describe('sessionEndWaiter', () => {
  it('resolves when the game session ends or another game replaces it', async () => {
    const events = new EventBus()
    let running: { gameId: string } | null = { gameId: 'steam:620' }
    const wait = sessionEndWaiter({ events, running: () => running })

    let done = false
    void wait('steam:620', new AbortController().signal).then(() => (done = true))
    events.emit('session:ended', {
      gameId: 'steam:1',
      startedAt: 'a',
      endedAt: 'b',
      minutes: 0
    })
    await Promise.resolve()
    expect(done).toBe(false)
    events.emit('session:ended', {
      gameId: 'steam:620',
      startedAt: 'a',
      endedAt: 'b',
      minutes: 1
    })
    await Promise.resolve()
    expect(done).toBe(true)

    let replaced = false
    void wait('steam:620', new AbortController().signal).then(() => (replaced = true))
    events.emit('session:started', { gameId: 'steam:2', startedAt: 'c' })
    await Promise.resolve()
    expect(replaced).toBe(true)

    running = null
    let untracked = false
    const ac = new AbortController()
    void wait('steam:620', ac.signal).then(() => (untracked = true))
    events.emit('session:ended', { gameId: 'steam:620', startedAt: 'a', endedAt: 'b', minutes: 0 })
    await Promise.resolve()
    expect(untracked).toBe(false)
    ac.abort()
    await Promise.resolve()
    expect(untracked).toBe(true)
  })
})
