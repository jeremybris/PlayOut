import { randomBytes, timingSafeEqual } from 'crypto'
import * as nodeNet from 'net'
import type { Logger } from '../../logger'
import {
  encodeJson,
  FromDll,
  MessageReader,
  parseHello,
  parseJsonPayload,
  PIPE_PREFIX,
  PROTOCOL_VERSION,
  ToDll,
  type FaultPayload,
  type HelloPayload,
  type LogPayload,
  type PresentingPayload,
  type ResizePayload,
  type UnsupportedPayload
} from './protocol'

/**
 * PlayOut's end of the in-game overlay's pipe (ingame-helper/PROTOCOL.md, section 2): a named-pipe server with a
 * random name and token, made for one injection. It takes one client, which must open with a HELLO carrying the token,
 * the protocol version and the game's pid; anything else is dropped. Once the DLL is in, the server stops listening,
 * PINGs it every 500 ms and counts it gone when no PONG came for 2 s.
 */

export const PING_MS = 500
export const PONG_TIMEOUT_MS = 2_000
/** A client that sends no HELLO this long after connecting is dropped. */
export const HELLO_TIMEOUT_MS = 5_000
/** Frames are dropped (the next one is sent whole) while this much is still waiting to be written. */
export const FRAME_BACKLOG_BYTES = 48 * 1024 * 1024

export interface PipeServerEvents {
  hello: HelloPayload
  resize: ResizePayload
  presenting: PresentingPayload
  unsupported: UnsupportedPayload
  fault: FaultPayload
  hidden: Record<string, never>
  log: LogPayload
  /** The DLL is gone: the pipe closed, it missed the heartbeat or broke the protocol (the reason says which). */
  gone: { reason: string }
}

export type PipeServerEvent = keyof PipeServerEvents

export interface PipeServer {
  /** `\\.\pipe\PlayOut-ingame-<32 hex>`. */
  readonly name: string
  /** 64 hex characters, passed to the DLL through the config mapping. */
  readonly token: string
  listen(): Promise<void>
  /** A HELLO was accepted and the pipe has not closed since. */
  connected(): boolean
  /** The accepted HELLO (null before). */
  hello(): HelloPayload | null
  /** Send a control message; false when no DLL is connected. */
  send(type: number, json?: object): boolean
  /** Send an encoded FRAME message; false when it was not written (not connected, or the pipe is backed up). */
  sendFrame(message: Buffer): boolean
  on<E extends PipeServerEvent>(
    event: E,
    listener: (payload: PipeServerEvents[E]) => void
  ): () => void
  close(): void
}

/** The part of `net` the server uses (tests may pass a fake). */
export interface PipeNet {
  createServer(listener: (socket: nodeNet.Socket) => void): nodeNet.Server
}

export interface PipeServerDeps {
  log: Logger
  /** The game the DLL must say it runs in. */
  gamePid: number
  net?: PipeNet
  random?: (bytes: number) => Buffer
  /** Tests: shorter heartbeat. */
  pingMs?: number
  pongTimeoutMs?: number
  helloTimeoutMs?: number
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

export function createPipeServer(deps: PipeServerDeps): PipeServer {
  const { log, gamePid } = deps
  const net = deps.net ?? nodeNet
  const random = deps.random ?? randomBytes
  const pingMs = deps.pingMs ?? PING_MS
  const pongTimeoutMs = deps.pongTimeoutMs ?? PONG_TIMEOUT_MS
  const helloTimeoutMs = deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS
  const name = PIPE_PREFIX + random(16).toString('hex')
  const token = random(32).toString('hex')

  const listeners = new Map<PipeServerEvent, Set<(payload: never) => void>>()
  const emit = <E extends PipeServerEvent>(event: E, payload: PipeServerEvents[E]): void => {
    for (const l of listeners.get(event) ?? []) {
      try {
        ;(l as (p: PipeServerEvents[E]) => void)(payload)
      } catch (err) {
        log.warn(`ingame pipe: ${event} listener failed`, err)
      }
    }
  }

  let server: nodeNet.Server | null = null
  let pending: nodeNet.Socket | null = null
  let client: nodeNet.Socket | null = null
  let accepted: HelloPayload | null = null
  let closed = false
  let goneSent = false
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let lastPong = 0

  const stopServer = (): void => {
    const s = server
    server = null
    if (s) {
      try {
        s.close()
      } catch {
        /* already closed */
      }
    }
  }

  const gone = (reason: string): void => {
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = null
    const c = client
    client = null
    if (c) c.destroy()
    if (accepted && !goneSent) {
      goneSent = true
      log.info(`ingame pipe: DLL gone (${reason})`)
      emit('gone', { reason })
    }
  }

  const onMessage = (type: number, payload: Buffer): void => {
    const json = parseJsonPayload(payload) ?? {}
    switch (type) {
      case FromDll.PONG:
        lastPong = Date.now()
        return
      case FromDll.RESIZE:
        emit('resize', {
          width: num(json.width),
          height: num(json.height),
          format: num(json.format),
          exclusive: json.exclusive === true
        })
        return
      case FromDll.PRESENTING:
        emit('presenting', { held: json.held === true })
        return
      case FromDll.UNSUPPORTED:
        emit('unsupported', { reason: typeof json.reason === 'string' ? json.reason : 'unknown' })
        return
      case FromDll.FAULT:
        emit('fault', {
          where: typeof json.where === 'string' ? json.where : '?',
          code: num(json.code)
        })
        return
      case FromDll.HIDDEN:
        emit('hidden', {})
        return
      case FromDll.LOG: {
        const level = ['debug', 'info', 'warn', 'error'].includes(json.level as string)
          ? (json.level as LogPayload['level'])
          : 'info'
        const message = typeof json.message === 'string' ? json.message.slice(0, 2000) : ''
        emit('log', { level, message })
        return
      }
      case FromDll.HELLO:
        // Only the first message may be a HELLO; a later one is ignored.
        return
      default:
        log.debug(`ingame pipe: unknown message ${type}`)
    }
  }

  const onConnection = (socket: nodeNet.Socket): void => {
    if (closed || client || pending) {
      socket.destroy()
      return
    }
    pending = socket
    const reader = new MessageReader()
    let ok = false
    const reject = (why: string): void => {
      log.warn(`ingame pipe: dropped a client (${why})`)
      if (pending === socket) pending = null
      socket.destroy()
    }
    const helloTimer = setTimeout(() => {
      if (!ok) reject('no HELLO')
    }, helloTimeoutMs)
    helloTimer.unref?.()
    socket.on('error', () => undefined)
    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (pending === socket) pending = null
      if (client === socket) gone('pipe closed')
    })
    socket.on('data', (chunk: Buffer) => {
      let messages: { type: number; payload: Buffer }[]
      try {
        messages = reader.push(chunk)
      } catch (err) {
        if (ok) gone(`protocol error: ${(err as Error).message}`)
        else reject((err as Error).message)
        return
      }
      for (const m of messages) {
        if (!ok) {
          const hello = m.type === FromDll.HELLO ? parseHello(parseJsonPayload(m.payload)) : null
          if (!hello) return reject('first message is not a HELLO')
          if (!sameToken(hello.token, token)) return reject('wrong token')
          if (hello.proto !== PROTOCOL_VERSION) return reject(`protocol ${hello.proto}`)
          if (hello.pid !== gamePid) return reject(`pid ${hello.pid}, not ${gamePid}`)
          ok = true
          clearTimeout(helloTimer)
          pending = null
          client = socket
          accepted = hello
          stopServer()
          lastPong = Date.now()
          pingTimer = setInterval(() => {
            if (Date.now() - lastPong > pongTimeoutMs) return gone('no PONG')
            send(ToDll.PING)
          }, pingMs)
          pingTimer.unref?.()
          log.info(
            `ingame pipe: DLL ${hello.dll} connected (${hello.api}, ${hello.width}x${hello.height}, format ${hello.format}${hello.exclusive ? ', exclusive' : ''})`
          )
          emit('hello', hello)
          continue
        }
        if (client !== socket) return
        onMessage(m.type, m.payload)
      }
    })
  }

  function send(type: number, json: object = {}): boolean {
    const c = client
    if (!c || c.destroyed) return false
    try {
      c.write(encodeJson(type, json))
      return true
    } catch {
      return false
    }
  }

  return {
    name,
    token,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        if (closed) return reject(new Error('closed'))
        const s = net.createServer(onConnection)
        server = s
        s.once('error', reject)
        s.listen(name, () => {
          s.off('error', reject)
          s.on('error', (err) => log.warn('ingame pipe: server error', err))
          resolve()
        })
      }),
    connected: () => !!client && !client.destroyed,
    hello: () => accepted,
    send,
    sendFrame(message) {
      const c = client
      if (!c || c.destroyed) return false
      if (c.writableLength > FRAME_BACKLOG_BYTES) return false
      try {
        c.write(message)
        return true
      } catch {
        return false
      }
    },
    on(event, listener) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(listener as (payload: never) => void)
      return () => set!.delete(listener as (payload: never) => void)
    },
    close() {
      if (closed) return
      closed = true
      stopServer()
      pending?.destroy()
      pending = null
      const c = client
      if (c) {
        // DETACH is written before the pipe closes; the DLL closes its end on it.
        send(ToDll.DETACH)
        client = null
        c.end()
        setTimeout(() => c.destroy(), 1000).unref?.()
      }
      gone('closed by PlayOut')
    }
  }
}
