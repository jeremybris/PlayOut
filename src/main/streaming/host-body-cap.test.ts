import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { connect as tlsConnect, type TLSSocket } from 'tls'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '../logger'
import {
  createHostServer,
  discardLimit,
  DISCARD_MAX_BYTES,
  MAX_BODY_BYTES,
  type HostHandlers,
  type HostServer
} from './host-server'
import { ensureHostCertificate } from './tls'

/**
 * A request body over its cap, sent by a raw TLS caller that decides itself when each part goes out. The refusal (413)
 * must reach a caller that is still sending: answered too early, the connection is closed under it and it sees a
 * broken connection instead (the reset the 413 tests in host-channel.test.ts hit now and then).
 */

const KIB = 1024
const MIB = 1024 * 1024

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger
const pair = vi.fn(async () => ({ ok: false as const, error: 'not-pairing' }))

let root: string
let server: HostServer

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-body-cap-'))
  const cert = await ensureHostCertificate(root)
  // Only the routes open before authentication are used here: /v1/info and /v1/pair (the one that reads a body).
  const handlers = {
    info: () => ({ id: 'host-1', name: 'PC', version: '1', fingerprint: cert.fingerprint }),
    pair
  } as unknown as HostHandlers
  server = createHostServer({
    tls: cert,
    port: 0,
    host: '127.0.0.1',
    log,
    auth: () => null,
    handlers
  })
  await server.listen()
}, 60_000)

afterAll(async () => {
  await server?.close()
  await fs.rm(root, { recursive: true, force: true })
})

beforeEach(() => {
  pair.mockClear()
  log.error.mockClear()
})

interface Answer {
  status: number
  headers: Record<string, string>
  body: string
}

interface Caller {
  socket: TLSSocket
  errors: Error[]
  /** Bytes received and not yet taken by answer(). */
  pending(): number
  write(data: string | Buffer): Promise<void>
  /** The next complete answer; rejects when the connection ends or breaks first. */
  answer(): Promise<Answer>
  /** Resolves once the host has closed the connection. */
  closed: Promise<void>
}

async function open(): Promise<Caller> {
  const socket = tlsConnect({ host: '127.0.0.1', port: server.port, rejectUnauthorized: false })
  const errors: Error[] = []
  let buffer = Buffer.alloc(0)
  let over = false
  let wake: (() => void) | null = null
  const changed = (): void => {
    wake?.()
    wake = null
  }
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    changed()
  })
  socket.on('error', (err) => {
    errors.push(err)
    changed()
  })
  const closed = new Promise<void>((resolve) => {
    socket.on('close', () => {
      over = true
      changed()
      resolve()
    })
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
  })
  const take = (): Answer | null => {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return null
    const [first, ...lines] = buffer.subarray(0, end).toString('latin1').split('\r\n')
    const headers: Record<string, string> = {}
    for (const line of lines) {
      const at = line.indexOf(':')
      headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim()
    }
    const length = Number(headers['content-length'] ?? 0)
    if (buffer.length < end + 4 + length) return null
    const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8')
    buffer = buffer.subarray(end + 4 + length)
    return { status: Number(first.split(' ')[1]), headers, body }
  }
  return {
    socket,
    errors,
    closed,
    pending: () => buffer.length,
    write: (data) =>
      new Promise<void>((resolve, reject) => {
        socket.write(data, (err) => (err ? reject(err) : resolve()))
      }),
    async answer() {
      for (;;) {
        const got = take()
        if (got) return got
        if (errors.length > 0) throw errors[0]
        if (over) throw new Error('the connection closed without an answer')
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    }
  }
}

function head(method: string, path: string, extra: string[] = []): string {
  return [`${method} ${path} HTTP/1.1`, 'Host: host', ...extra, '', ''].join('\r\n')
}

/** One chunk of a body sent with Transfer-Encoding: chunked. */
function piece(size: number): Buffer {
  return Buffer.concat([
    Buffer.from(`${size.toString(16)}\r\n`),
    Buffer.alloc(size, 0x78),
    Buffer.from('\r\n')
  ])
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('discardLimit', () => {
  it('is a few times the cap plus a margin, and never above DISCARD_MAX_BYTES', () => {
    expect(DISCARD_MAX_BYTES).toBe(8 * MIB)
    expect(discardLimit(0)).toBe(MIB)
    expect(discardLimit(MAX_BODY_BYTES)).toBe(1.25 * MIB)
    expect(discardLimit(512 * KIB)).toBe(3 * MIB)
    expect(discardLimit(2 * MIB)).toBe(8 * MIB)
    expect(discardLimit(64 * MIB)).toBe(8 * MIB)
  })

  it('is above every cap it is used with', () => {
    for (const cap of [1, MAX_BODY_BYTES, 260 * KIB, 512 * KIB, 2 * MIB])
      expect(discardLimit(cap)).toBeGreaterThan(cap)
  })
})

describe('a request body over its cap', () => {
  it('is answered 413 only once the caller has sent it all, as the app sends it (Connection: close)', async () => {
    const caller = await open()
    const size = 200 * KIB
    await caller.write(
      head('POST', '/v1/pair', [`Content-Length: ${size}`, 'Connection: close']) +
        'x'.repeat(size / 2)
    )
    // The caller is in the middle of its body. An answer now would be followed by the host closing the connection,
    // and the second half would then be written into a closed connection (a reset).
    await pause(300)
    expect(caller.pending()).toBe(0)
    expect(caller.errors).toEqual([])
    await caller.write('x'.repeat(size / 2))
    const answer = await caller.answer()
    expect(answer.status).toBe(413)
    expect(JSON.parse(answer.body)).toEqual({ error: 'too-large' })
    await caller.closed
    expect(caller.errors).toEqual([])
    expect(pair).not.toHaveBeenCalled()
  })

  it('leaves a keep-alive connection usable after the refusal', async () => {
    const caller = await open()
    const size = 200 * KIB
    await caller.write(head('POST', '/v1/pair', [`Content-Length: ${size}`]) + 'x'.repeat(size / 2))
    await pause(100)
    expect(caller.pending()).toBe(0)
    await caller.write('x'.repeat(size / 2))
    const refused = await caller.answer()
    expect(refused.status).toBe(413)
    expect(refused.headers.connection).not.toBe('close')
    await caller.write(head('GET', '/v1/info'))
    const info = await caller.answer()
    expect(info.status).toBe(200)
    expect(JSON.parse(info.body)).toMatchObject({ id: 'host-1' })
    expect(caller.errors).toEqual([])
    caller.socket.destroy()
  })

  it('accepts a body of exactly the cap and refuses one byte more', async () => {
    const caller = await open()
    const exact = JSON.stringify({ clientId: 'c', clientName: 'n', proof: 'p', pad: '' })
    const padded = JSON.stringify({
      clientId: 'c',
      clientName: 'n',
      proof: 'p',
      pad: 'x'.repeat(MAX_BODY_BYTES - exact.length)
    })
    expect(Buffer.byteLength(padded)).toBe(MAX_BODY_BYTES)
    await caller.write(head('POST', '/v1/pair', [`Content-Length: ${MAX_BODY_BYTES}`]) + padded)
    // The stub pair handler refuses every proof: a 403 shows the body got through to it.
    expect((await caller.answer()).status).toBe(403)
    expect(pair).toHaveBeenCalledTimes(1)

    await caller.write(
      head('POST', '/v1/pair', [`Content-Length: ${MAX_BODY_BYTES + 1}`]) + padded + ' '
    )
    expect((await caller.answer()).status).toBe(413)
    expect(pair).toHaveBeenCalledTimes(1)
    expect(caller.errors).toEqual([])
    caller.socket.destroy()
  })

  it('refuses a chunked body (no declared length) over the cap and keeps the connection', async () => {
    const caller = await open()
    await caller.write(head('POST', '/v1/pair', ['Transfer-Encoding: chunked']))
    for (let i = 0; i < 4; i++) await caller.write(piece(50 * KIB))
    await pause(100)
    expect(caller.pending()).toBe(0)
    await caller.write('0\r\n\r\n')
    const refused = await caller.answer()
    expect(refused.status).toBe(413)
    expect(refused.headers.connection).not.toBe('close')
    await caller.write(head('GET', '/v1/info'))
    expect((await caller.answer()).status).toBe(200)
    expect(caller.errors).toEqual([])
    caller.socket.destroy()
  })

  it('refuses a declared length far past the discard limit at once and closes the connection', async () => {
    const caller = await open()
    // Only the headers go out: the host must not wait for 50 MiB, nor go on reading them after its answer.
    await caller.write(head('POST', '/v1/pair', [`Content-Length: ${50 * MIB}`]))
    const refused = await caller.answer()
    expect(refused.status).toBe(413)
    expect(refused.headers.connection).toBe('close')
    await caller.closed
    expect(caller.errors).toEqual([])
    expect(pair).not.toHaveBeenCalled()
  })

  it('stops reading a chunked body at the discard limit, answers 413 and closes the connection', async () => {
    const caller = await open()
    const limit = discardLimit(MAX_BODY_BYTES)
    await caller.write(head('POST', '/v1/pair', ['Transfer-Encoding: chunked']))
    for (let sent = 0; sent < limit; sent += 64 * KIB) await caller.write(piece(64 * KIB))
    // Exactly at the limit: still being read, nothing answered.
    await pause(200)
    expect(caller.pending()).toBe(0)
    // One small piece more passes the limit; the body is not ended, and no end is waited for.
    await caller.write(piece(KIB))
    const refused = await caller.answer()
    expect(refused.status).toBe(413)
    expect(refused.headers.connection).toBe('close')
    await caller.closed
    expect(caller.errors).toEqual([])
  })

  it('stays quiet when the caller goes away while its body is being thrown away', async () => {
    const caller = await open()
    await caller.write(
      head('POST', '/v1/pair', [`Content-Length: ${300 * KIB}`]) + 'x'.repeat(100 * KIB)
    )
    await pause(100)
    caller.socket.destroy()
    await caller.closed
    // The host is still there, and has had the time to notice the caller left.
    const next = await open()
    await pause(100)
    await next.write(head('GET', '/v1/info'))
    expect((await next.answer()).status).toBe(200)
    next.socket.destroy()
    expect(log.error).not.toHaveBeenCalled()
    expect(pair).not.toHaveBeenCalled()
  })
})
