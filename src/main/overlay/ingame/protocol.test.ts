import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  CONFIG_MAGIC,
  CONFIG_MAPPING_PREFIX,
  DRAWABLE_FORMATS,
  encodeFrame,
  encodeJson,
  encodeMessage,
  FRAME_HEADER_BYTES,
  FromDll,
  HEADER_BYTES,
  MAX_PAYLOAD_BYTES,
  MessageReader,
  parseHello,
  parseJsonPayload,
  PROTOCOL_VERSION,
  ToDll
} from './protocol'

const hello = {
  proto: 1,
  dll: '0.1.0',
  pid: 1234,
  token: 'a'.repeat(64),
  api: 'd3d11',
  width: 1920,
  height: 1080,
  format: 87,
  exclusive: true,
  hwnd: '5243086'
}

describe('encodeMessage / encodeJson', () => {
  it('writes the 8-byte little-endian header and the payload', () => {
    const m = encodeMessage(ToDll.PING, Buffer.from('ab'))
    expect(m.length).toBe(HEADER_BYTES + 2)
    expect(m.readUInt32LE(0)).toBe(104)
    expect(m.readUInt32LE(4)).toBe(2)
    expect(m.subarray(8).toString()).toBe('ab')
  })

  it('encodes {} as an empty payload and other objects as JSON', () => {
    expect(encodeJson(ToDll.HIDE).length).toBe(HEADER_BYTES)
    const show = encodeJson(ToDll.SHOW, { hold: true })
    expect(show.readUInt32LE(4)).toBe(show.length - HEADER_BYTES)
    expect(JSON.parse(show.subarray(HEADER_BYTES).toString('utf8'))).toEqual({ hold: true })
  })

  it('refuses a payload over the limit', () => {
    expect(() => encodeMessage(1, Buffer.alloc(MAX_PAYLOAD_BYTES + 1))).toThrow(/too large/)
  })
})

describe('MessageReader', () => {
  it('round-trips messages fed one byte at a time and all at once', () => {
    const a = encodeJson(FromDll.HELLO, hello)
    const b = encodeJson(FromDll.PONG)
    const c = encodeJson(FromDll.LOG, { level: 'info', message: 'héllo' })
    const all = Buffer.concat([a, b, c])

    const whole = new MessageReader().push(all)
    expect(whole.map((m) => m.type)).toEqual([1, 6, 5])
    expect(parseHello(parseJsonPayload(whole[0]!.payload))).toEqual(hello)
    expect(parseJsonPayload(whole[1]!.payload)).toEqual({})
    expect(parseJsonPayload(whole[2]!.payload)).toEqual({ level: 'info', message: 'héllo' })

    const reader = new MessageReader()
    const got: number[] = []
    for (let i = 0; i < all.length; i++) {
      for (const m of reader.push(all.subarray(i, i + 1))) got.push(m.type)
    }
    expect(got).toEqual([1, 6, 5])
  })

  it('keeps a split header and payload until they complete', () => {
    const msg = encodeJson(FromDll.RESIZE, { width: 1, height: 2, format: 87, exclusive: true })
    const reader = new MessageReader()
    expect(reader.push(msg.subarray(0, 5))).toEqual([])
    expect(reader.push(msg.subarray(5, 12))).toEqual([])
    const out = reader.push(msg.subarray(12))
    expect(out).toHaveLength(1)
    expect(parseJsonPayload(out[0]!.payload)).toEqual({
      width: 1,
      height: 2,
      format: 87,
      exclusive: true
    })
  })

  it('throws on a length over the limit', () => {
    const header = Buffer.alloc(8)
    header.writeUInt32LE(1, 0)
    header.writeUInt32LE(MAX_PAYLOAD_BYTES + 1, 4)
    expect(() => new MessageReader().push(header)).toThrow(/too large/)
  })
})

describe('parseJsonPayload / parseHello', () => {
  it('gives null for non-objects and bad JSON', () => {
    expect(parseJsonPayload(Buffer.from('[1]'))).toBeNull()
    expect(parseJsonPayload(Buffer.from('nope'))).toBeNull()
    expect(parseJsonPayload(Buffer.from('3'))).toBeNull()
  })

  it('needs every HELLO field with its type', () => {
    expect(parseHello(hello as unknown as Record<string, unknown>)).toEqual(hello)
    expect(parseHello(null)).toBeNull()
    for (const key of Object.keys(hello)) {
      const broken: Record<string, unknown> = { ...hello }
      delete broken[key]
      expect(parseHello(broken)).toBeNull()
    }
    expect(parseHello({ ...hello, exclusive: 'yes' })).toBeNull()
    expect(parseHello({ ...hello, pid: '1234' })).toBeNull()
  })
})

describe('encodeFrame', () => {
  /** A 4 x 3 image whose pixel (x, y) is [x, y, 0xAA, 0xFF]. */
  const W = 4
  const H = 3
  const bitmap = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) bitmap.set([x, y, 0xaa, 0xff], (y * W + x) * 4)

  const fields = (m: Buffer): number[] =>
    [0, 4, 8, 12, 16, 20].map((o) => m.readUInt32LE(HEADER_BYTES + o))

  it('packs the rectangle rows tightly', () => {
    const m = encodeFrame(bitmap, W, H, { x: 1, y: 1, w: 2, h: 2 })!
    expect(m.readUInt32LE(0)).toBe(ToDll.FRAME)
    expect(m.readUInt32LE(4)).toBe(FRAME_HEADER_BYTES + 2 * 2 * 4)
    expect(fields(m)).toEqual([1, 1, 2, 2, W, H])
    const px = m.subarray(HEADER_BYTES + FRAME_HEADER_BYTES)
    expect([...px.subarray(0, 4)]).toEqual([1, 1, 0xaa, 0xff])
    expect([...px.subarray(4, 8)]).toEqual([2, 1, 0xaa, 0xff])
    expect([...px.subarray(8, 12)]).toEqual([1, 2, 0xaa, 0xff])
  })

  it('clamps the rectangle to the image and rounds it outward', () => {
    expect(fields(encodeFrame(bitmap, W, H, { x: -5, y: -1, w: 100, h: 100 })!)).toEqual([
      0,
      0,
      W,
      H,
      W,
      H
    ])
    expect(fields(encodeFrame(bitmap, W, H, { x: 0.5, y: 0.5, w: 1, h: 1 })!)).toEqual([
      0,
      0,
      2,
      2,
      W,
      H
    ])
  })

  it('gives null for an empty rectangle and throws for a short bitmap', () => {
    expect(encodeFrame(bitmap, W, H, { x: 0, y: 0, w: 0, h: 2 })).toBeNull()
    expect(encodeFrame(bitmap, W, H, { x: 9, y: 0, w: 2, h: 2 })).toBeNull()
    expect(() => encodeFrame(Buffer.alloc(4), W, H, { x: 0, y: 0, w: 1, h: 1 })).toThrow()
  })
})

describe('protocol.h parity', () => {
  const header = readFileSync(
    join(__dirname, '..', '..', '..', '..', 'ingame-helper', 'hook', 'protocol.h'),
    'utf8'
  )
  /** Every `constexpr <type> NAME = value;` line of protocol.h. */
  const constants = new Map<string, string>()
  for (const m of header.matchAll(/^\s*constexpr\s+[\w\s*:]+?\s(\w+)\s*=\s*([^;]+);/gm)) {
    constants.set(m[1]!, m[2]!.trim())
  }
  const num = (name: string): number => {
    const raw = constants.get(name)
    if (raw === undefined) throw new Error(`protocol.h has no ${name}`)
    return Number(raw)
  }

  it('reads the constants', () => {
    expect(constants.size).toBeGreaterThanOrEqual(20)
  })

  it('has the same sizes, version and magic', () => {
    expect(num('PROTOCOL_VERSION')).toBe(PROTOCOL_VERSION)
    expect(num('HEADER_BYTES')).toBe(HEADER_BYTES)
    expect(num('MAX_PAYLOAD_BYTES')).toBe(MAX_PAYLOAD_BYTES)
    expect(num('FRAME_HEADER_BYTES')).toBe(FRAME_HEADER_BYTES)
    expect(num('CONFIG_MAGIC')).toBe(CONFIG_MAGIC)
    expect(num('CONFIG_VERSION')).toBe(PROTOCOL_VERSION)
    // L"Local\\PlayOutIngame-" in C++ is the same string as the TS literal.
    const prefix = constants.get('CONFIG_MAPPING_PREFIX')!
    expect(prefix.replace(/^L"|"$/g, '').replace(/\\\\/g, '\\')).toBe(CONFIG_MAPPING_PREFIX)
  })

  it('has every message type, both ways, with the same values', () => {
    const msgs = [...constants.keys()].filter((k) => k.startsWith('MSG_'))
    const ts: Record<string, number> = { ...FromDll, ...ToDll }
    expect(msgs.map((k) => k.slice(4)).sort()).toEqual(Object.keys(ts).sort())
    for (const k of msgs) expect(num(k), k).toBe(ts[k.slice(4)])
  })

  it('declares the header structs with the sizes the codec uses', () => {
    expect(header).toMatch(/static_assert\(sizeof\(MessageHeader\) == HEADER_BYTES/)
    expect(header).toMatch(/static_assert\(sizeof\(FrameHeader\) == FRAME_HEADER_BYTES/)
    const frame = /struct FrameHeader \{([^}]*)\}/.exec(header)![1]!
    expect(frame.match(/uint32_t \w+;/g)!.map((f) => f.slice(9, -1))).toEqual([
      'x',
      'y',
      'w',
      'h',
      'fullWidth',
      'fullHeight'
    ])
  })

  it('lists only 8-bit RGBA / BGRA formats as drawable', () => {
    expect([...DRAWABLE_FORMATS].sort((a, b) => a - b)).toEqual([28, 29, 87, 91])
  })
})
