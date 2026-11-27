import { describe, expect, it } from 'vitest'
import {
  parseCpuIdentifier,
  SMU_FAMILIES,
  SMU_RESPONSE,
  smuFamilyFor,
  smuLimitMessages,
  smuResponseText,
  smuSend,
  type SmuRegisters
} from './smu'

/** A register file that answers `answer` a few reads after the message register is written. */
function fakeSmu(
  msg: number,
  rsp: number,
  answer: number,
  delay = 2,
  initial = 1
): { r: SmuRegisters; ops: string[]; regs: Map<number, number> } {
  const regs = new Map<number, number>([[rsp, initial]])
  const ops: string[] = []
  let pending = 0
  const r: SmuRegisters = {
    read(addr) {
      if (addr === rsp && pending > 0 && --pending === 0) regs.set(rsp, answer)
      ops.push(`R${addr.toString(16)}`)
      return regs.get(addr) ?? 0
    },
    write(addr, value) {
      ops.push(`W${addr.toString(16)}=${value}`)
      regs.set(addr, value)
      if (addr === msg) pending = delay
    }
  }
  return { r, ops, regs }
}

describe('parseCpuIdentifier', () => {
  it('reads vendor, family and model from Win32_Processor Caption', () => {
    expect(parseCpuIdentifier('AMD64 Family 25 Model 116 Stepping 1')).toEqual({
      vendor: 'amd',
      family: 25,
      model: 116
    })
    expect(parseCpuIdentifier('Intel64 Family 6 Model 204 Stepping 2')).toEqual({
      vendor: 'intel',
      family: 6,
      model: 204
    })
    expect(parseCpuIdentifier('x86 Family 6 Model 15 Stepping 2')).toMatchObject({
      vendor: 'other'
    })
    expect(parseCpuIdentifier('')).toBeNull()
    expect(parseCpuIdentifier(null)).toBeNull()
  })
})

describe('smuFamilyFor', () => {
  it('knows the RyzenAdj mobile families and nothing else', () => {
    expect(smuFamilyFor({ vendor: 'amd', family: 25, model: 116 })?.name).toBe('Phoenix')
    expect(smuFamilyFor({ vendor: 'amd', family: 26, model: 36 })?.name).toBe('Strix Point')
    expect(smuFamilyFor({ vendor: 'amd', family: 23, model: 145 })?.name).toBe('Van Gogh')
    expect(smuFamilyFor({ vendor: 'amd', family: 25, model: 33 })).toBeNull() // Vermeer (desktop)
    expect(smuFamilyFor({ vendor: 'intel', family: 25, model: 116 })).toBeNull()
    expect(smuFamilyFor(null)).toBeNull()
  })

  it('has no model listed twice and only addresses PawnIO lets through (0x3B10xxx)', () => {
    const keys = SMU_FAMILIES.flatMap((f) => f.models.map((m) => `${f.family}/${m}`))
    expect(new Set(keys).size).toBe(keys.length)
    for (const f of SMU_FAMILIES)
      for (const a of [f.mailbox.msg, f.mailbox.rsp, f.mailbox.arg + 20])
        expect((a & 0xfffff000) >>> 0).toBe(0x3b10000)
  })

  it('uses the Dragon Range ids and mailbox for Fire Range', () => {
    const f = smuFamilyFor({ vendor: 'amd', family: 26, model: 68 })!
    expect(f.cmds).toEqual({ stapm: 0x4f, fast: 0x3e, slow: 0x5f })
    expect(f.mailbox).toEqual({ msg: 0x3b10530, rsp: 0x3b1057c, arg: 0x3b109c4 })
  })
})

describe('smuSend', () => {
  const mb = { msg: 0x3b10528, rsp: 0x3b10578, arg: 0x3b10998 }

  it('clears RSP, writes six arguments, writes the message, then polls RSP', () => {
    const { r, ops } = fakeSmu(mb.msg, mb.rsp, SMU_RESPONSE.OK)
    expect(smuSend(r, mb, 0x14, [15000])).toBe(SMU_RESPONSE.OK)
    expect(ops).toEqual([
      'R3b10578', // previous message done (rsp 1)
      'W3b10578=0',
      'W3b10998=15000',
      'W3b1099c=0',
      'W3b109a0=0',
      'W3b109a4=0',
      'W3b109a8=0',
      'W3b109ac=0',
      'W3b10528=20',
      'R3b10578',
      'R3b10578'
    ])
  })

  it('passes the SMU error code through', () => {
    const { r } = fakeSmu(mb.msg, mb.rsp, SMU_RESPONSE.REJECTED_PREREQ)
    expect(smuSend(r, mb, 0x15, [1])).toBe(0xfd)
    expect(smuResponseText(0xfd)).toMatch(/rejected/)
  })

  it('gives up after maxPolls (0 = no answer), also when a previous message never finished', () => {
    const { r, ops } = fakeSmu(mb.msg, mb.rsp, 1, 100, 0)
    expect(smuSend(r, mb, 0x16, [], 5)).toBe(SMU_RESPONSE.TIMEOUT)
    expect(ops.filter((o) => o === 'W3b10528=22')).toHaveLength(1)
    expect(smuResponseText(0)).toMatch(/did not answer/)
  })

  it('writes 32-bit unsigned arguments', () => {
    const { r, regs } = fakeSmu(mb.msg, mb.rsp, 1)
    smuSend(r, mb, 0x14, [-1])
    expect(regs.get(mb.arg)).toBe(0xffffffff)
  })
})

describe('smuLimitMessages', () => {
  const phoenix = smuFamilyFor({ vendor: 'amd', family: 25, model: 116 })!

  it('sends STAPM and slow for watts, fast for boost, in milliwatts', () => {
    expect(smuLimitMessages(phoenix, 15, 25)).toEqual([
      { cmd: 0x14, arg: 15000, what: 'STAPM' },
      { cmd: 0x16, arg: 15000, what: 'slow' },
      { cmd: 0x15, arg: 25000, what: 'fast' }
    ])
    expect(smuLimitMessages(phoenix, null, 30)).toEqual([{ cmd: 0x15, arg: 30000, what: 'fast' }])
    expect(smuLimitMessages(phoenix, null, null)).toEqual([])
  })
})
