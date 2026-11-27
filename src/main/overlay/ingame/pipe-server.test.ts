import { connect, type Socket } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPipeServer, type PipeServer } from './pipe-server'
import { encodeJson, FromDll, MessageReader, PIPE_PREFIX, ToDll } from './protocol'

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const GAME = 4321

const servers: PipeServer[] = []
const sockets: Socket[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  for (const s of sockets.splice(0)) s.destroy()
})

async function server(opts: { pingMs?: number; pongTimeoutMs?: number } = {}): Promise<PipeServer> {
  const s = createPipeServer({ log, gamePid: GAME, helloTimeoutMs: 300, ...opts })
  servers.push(s)
  await s.listen()
  return s
}

/** A DLL stand-in: connects, collects the messages it gets. */
async function dll(name: string): Promise<{
  socket: Socket
  got: number[]
  closed: Promise<void>
  send(type: number, json?: object): void
}> {
  const socket = connect(name)
  sockets.push(socket)
  await new Promise<void>((r, j) => {
    socket.once('connect', () => r())
    socket.once('error', j)
  })
  const got: number[] = []
  const reader = new MessageReader()
  socket.on('data', (c: Buffer) => {
    for (const m of reader.push(c)) got.push(m.type)
  })
  socket.on('error', () => undefined)
  const closed = new Promise<void>((r) => socket.once('close', () => r()))
  return { socket, got, closed, send: (t, j = {}) => socket.write(encodeJson(t, j)) }
}

const hello = (s: PipeServer, over: object = {}): object => ({
  proto: 1,
  dll: '0.1.0',
  pid: GAME,
  token: s.token,
  api: 'd3d11',
  width: 1920,
  height: 1080,
  format: 87,
  exclusive: true,
  hwnd: '77',
  ...over
})

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('createPipeServer', () => {
  it('names the pipe with 32 hex characters and makes a 64-hex token', () => {
    const s = createPipeServer({ log, gamePid: 1 })
    expect(s.name).toMatch(new RegExp(`^${PIPE_PREFIX.replace(/\\/g, '\\\\')}[0-9a-f]{32}$`))
    expect(s.token).toMatch(/^[0-9a-f]{64}$/)
    expect(createPipeServer({ log, gamePid: 1 }).token).not.toBe(s.token)
  })

  it('accepts a HELLO with the token, version and pid, then pings and passes messages on', async () => {
    const s = await server({ pingMs: 30 })
    const seen: string[] = []
    s.on('hello', (h) => seen.push(`hello ${h.width}`))
    s.on('resize', (r) => seen.push(`resize ${r.width}x${r.height} ${r.format} ${r.exclusive}`))
    s.on('presenting', (p) => seen.push(`presenting ${p.held}`))
    s.on('unsupported', (u) => seen.push(`unsupported ${u.reason}`))
    s.on('hidden', () => seen.push('hidden'))
    s.on('fault', (f) => seen.push(`fault ${f.where} ${f.code}`))
    s.on('log', (l) => seen.push(`log ${l.level} ${l.message}`))
    const d = await dll(s.name)
    d.send(FromDll.HELLO, hello(s))
    await until(() => s.connected())
    expect(s.hello()?.hwnd).toBe('77')
    d.send(FromDll.RESIZE, { width: 1280, height: 720, format: 28, exclusive: true })
    d.send(FromDll.PRESENTING, { held: true })
    d.send(FromDll.UNSUPPORTED, { reason: 'format' })
    d.send(FromDll.HIDDEN)
    d.send(FromDll.FAULT, { where: 'present', code: 3221225477 })
    d.send(FromDll.LOG, { level: 'warn', message: 'hi' })
    await until(() => seen.length === 7)
    expect(seen).toEqual([
      'hello 1920',
      'resize 1280x720 28 true',
      'presenting true',
      'unsupported format',
      'hidden',
      'fault present 3221225477',
      'log warn hi'
    ])
    expect(s.send(ToDll.SHOW, { hold: false })).toBe(true)
    await until(() => d.got.includes(ToDll.PING) && d.got.includes(ToDll.SHOW))
  })

  it.each([
    ['a wrong token', { token: 'b'.repeat(64) }],
    ['another protocol version', { proto: 2 }],
    ['another pid', { pid: 1 }],
    ['a broken HELLO', { width: 'wide' }]
  ])('drops a client with %s', async (_why, over) => {
    const s = await server()
    const d = await dll(s.name)
    d.send(FromDll.HELLO, hello(s, over))
    await d.closed
    expect(s.connected()).toBe(false)
  })

  it('drops a client whose first message is not a HELLO, or that says nothing', async () => {
    const s = await server()
    const a = await dll(s.name)
    a.send(FromDll.PONG)
    await a.closed
    const b = await dll(s.name)
    await b.closed
    // The right DLL can still come in afterwards.
    const c = await dll(s.name)
    c.send(FromDll.HELLO, hello(s))
    await until(() => s.connected())
  })

  it('stops listening once the DLL is in', async () => {
    const s = await server()
    const d = await dll(s.name)
    d.send(FromDll.HELLO, hello(s))
    await until(() => s.connected())
    await expect(dll(s.name)).rejects.toThrow()
  })

  it('counts the DLL gone without a PONG, and keeps it while it answers', async () => {
    const s = await server({ pingMs: 20, pongTimeoutMs: 150 })
    const gone: string[] = []
    s.on('gone', (g) => gone.push(g.reason))
    const d = await dll(s.name)
    d.socket.on('data', () => d.send(FromDll.PONG))
    d.send(FromDll.HELLO, hello(s))
    await until(() => s.connected())
    await new Promise((r) => setTimeout(r, 300))
    expect(gone).toEqual([])
    d.socket.removeAllListeners('data')
    await until(() => gone.length === 1)
    expect(gone).toEqual(['no PONG'])
    expect(s.connected()).toBe(false)
  })

  it('reports the pipe closing, and sends DETACH on close', async () => {
    const s = await server()
    const gone: string[] = []
    s.on('gone', (g) => gone.push(g.reason))
    const d = await dll(s.name)
    d.send(FromDll.HELLO, hello(s))
    await until(() => s.connected())
    s.close()
    await until(() => d.got.includes(ToDll.DETACH))
    expect(gone).toEqual(['closed by PlayOut'])
    expect(s.send(ToDll.HIDE)).toBe(false)

    const s2 = await server()
    s2.on('gone', (g) => gone.push(g.reason))
    const d2 = await dll(s2.name)
    d2.send(FromDll.HELLO, hello(s2))
    await until(() => s2.connected())
    d2.socket.destroy()
    await until(() => gone.length === 2)
    expect(gone[1]).toBe('pipe closed')
  })
})
