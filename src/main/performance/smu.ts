/**
 * AMD Ryzen mobile power limits through the SMU's MP1 mailbox, driven register by register with PawnIO's RyzenSMU
 * module (ioctl_read_smu_register / ioctl_write_smu_register). The module's own ioctl_send_smu_command uses the PSMU
 * mailbox, which has no fast and slow limit commands, hence the hand-driven MP1 protocol (as UXTU and R7250Adj do).
 *
 * Mailbox addresses and command ids come from RyzenAdj (lib/api.c, nb_smu_ops.c) as summarised in the power research;
 * families come from RyzenAdj's lib/cpuid.c. Only these families are supported: anything else is 'unsupported'.
 * This table is the single source: helper/csharp.ts generates the helper's C# lookup from it.
 */

export interface SmuMailbox {
  msg: number
  rsp: number
  arg: number
}

export interface SmuFamily {
  name: string
  /** CPUID family (decimal, as Win32_Processor's Caption prints it: 23 = 17h, 25 = 19h, 26 = 1Ah). */
  family: number
  models: number[]
  mailbox: SmuMailbox
  /** MP1 message ids for the STAPM, fast (PPT fast) and slow (PPT slow) limits; arguments in milliwatts. */
  cmds: { stapm: number; fast: number; slow: number }
  /** Highest limit offered, watts (conservative: the SMU clamps further itself). */
  maxWatts: number
}

const MP1_DEFAULT: SmuMailbox = { msg: 0x3b10528, rsp: 0x3b10564, arg: 0x3b10998 }
const MP1_REMBRANDT: SmuMailbox = { msg: 0x3b10528, rsp: 0x3b10578, arg: 0x3b10998 }
const MP1_STRIX: SmuMailbox = { msg: 0x3b10928, rsp: 0x3b10978, arg: 0x3b10998 }
const MP1_DRAGON: SmuMailbox = { msg: 0x3b10530, rsp: 0x3b1057c, arg: 0x3b109c4 }

const STD_CMDS = { stapm: 0x14, fast: 0x15, slow: 0x16 }
const RAVEN_CMDS = { stapm: 0x1a, fast: 0x1b, slow: 0x1c }
const DRAGON_CMDS = { stapm: 0x4f, fast: 0x3e, slow: 0x5f }

const fam = (
  name: string,
  family: number,
  models: number[],
  mailbox: SmuMailbox,
  cmds: SmuFamily['cmds'],
  maxWatts: number
): SmuFamily => ({ name, family, models, mailbox, cmds, maxWatts })

export const SMU_FAMILIES: SmuFamily[] = [
  fam('Raven', 23, [17], MP1_DEFAULT, RAVEN_CMDS, 35),
  fam('Picasso', 23, [24], MP1_DEFAULT, RAVEN_CMDS, 35),
  fam('Dali', 23, [32], MP1_DEFAULT, RAVEN_CMDS, 25),
  fam('Renoir', 23, [96], MP1_DEFAULT, STD_CMDS, 54),
  fam('Lucienne', 23, [104], MP1_DEFAULT, STD_CMDS, 54),
  fam('Van Gogh', 23, [144, 145], MP1_REMBRANDT, STD_CMDS, 30),
  fam('Mendocino', 23, [160], MP1_REMBRANDT, STD_CMDS, 30),
  fam('Cezanne', 25, [80], MP1_DEFAULT, STD_CMDS, 54),
  fam('Rembrandt', 25, [64, 68], MP1_REMBRANDT, STD_CMDS, 65),
  fam('Phoenix', 25, [116, 120], MP1_REMBRANDT, STD_CMDS, 65),
  fam('Hawk Point', 25, [117], MP1_REMBRANDT, STD_CMDS, 65),
  fam('Dragon Range', 25, [97], MP1_DRAGON, DRAGON_CMDS, 120),
  fam('Strix Point', 26, [32, 36], MP1_STRIX, STD_CMDS, 65),
  fam('Krackan Point', 26, [96], MP1_STRIX, STD_CMDS, 54),
  fam('Strix Halo', 26, [112], MP1_STRIX, STD_CMDS, 120),
  fam('Fire Range', 26, [68], MP1_DRAGON, DRAGON_CMDS, 120)
]

export const SMU_MIN_WATTS = 5

export interface CpuId {
  vendor: 'intel' | 'amd' | 'other'
  family: number
  model: number
}

/**
 * Parse Win32_Processor's Caption (or the registry's CentralProcessor\0 Identifier): "AMD64 Family 25 Model 116
 * Stepping 1", "Intel64 Family 6 Model 204 Stepping 2".
 */
export function parseCpuIdentifier(text: string | null | undefined): CpuId | null {
  const m = /^\s*(\S+)\s+Family\s+(\d+)\s+Model\s+(\d+)/i.exec(text ?? '')
  if (!m) return null
  const arch = m[1].toLowerCase()
  const vendor = arch.startsWith('amd64') ? 'amd' : arch.startsWith('intel') ? 'intel' : 'other'
  return { vendor, family: Number(m[2]), model: Number(m[3]) }
}

export function smuFamilyFor(cpu: CpuId | null): SmuFamily | null {
  if (!cpu || cpu.vendor !== 'amd') return null
  return SMU_FAMILIES.find((f) => f.family === cpu.family && f.models.includes(cpu.model)) ?? null
}

/** MP1 response codes (RyzenAdj's REP_MSG_*). */
export const SMU_RESPONSE = {
  OK: 0x1,
  FAILED: 0xff,
  UNKNOWN_CMD: 0xfe,
  REJECTED_PREREQ: 0xfd,
  REJECTED_BUSY: 0xfc,
  /** Not an SMU code: the response register stayed 0 for the whole poll. */
  TIMEOUT: 0
} as const

export function smuResponseText(code: number): string {
  switch (code) {
    case SMU_RESPONSE.OK:
      return 'ok'
    case SMU_RESPONSE.FAILED:
      return 'the SMU failed the command'
    case SMU_RESPONSE.UNKNOWN_CMD:
      return 'this SMU does not know the command'
    case SMU_RESPONSE.REJECTED_PREREQ:
      return 'the SMU rejected the command (prerequisite)'
    case SMU_RESPONSE.REJECTED_BUSY:
      return 'the SMU was busy'
    case SMU_RESPONSE.TIMEOUT:
      return 'the SMU did not answer'
    default:
      return `the SMU answered 0x${code.toString(16)}`
  }
}

/** 32-bit SMU registers (the helper's are PawnIO calls; tests use a fake register file). */
export interface SmuRegisters {
  read(addr: number): number
  write(addr: number, value: number): void
}

/** The MP1 mailbox has six 32-bit argument registers, 4 bytes apart. */
export const SMU_ARG_COUNT = 6

/**
 * Send one MP1 message: wait (bounded) for any previous message to finish, clear the response register, write the
 * six arguments, write the message id, then poll the response register until it is non-zero. Returns that code
 * (SMU_RESPONSE.OK = 1 is success; 0 = no answer within `maxPolls`).
 */
export function smuSend(
  regs: SmuRegisters,
  mailbox: SmuMailbox,
  cmd: number,
  args: number[],
  maxPolls = 8192
): number {
  // A message still in flight (another tool) shows rsp == 0; give it the same budget, then go ahead anyway.
  for (let i = 0; i < maxPolls && regs.read(mailbox.rsp) === 0; i++) {
    /* wait */
  }
  regs.write(mailbox.rsp, 0)
  for (let i = 0; i < SMU_ARG_COUNT; i++) regs.write(mailbox.arg + i * 4, (args[i] ?? 0) >>> 0)
  regs.write(mailbox.msg, cmd)
  for (let i = 0; i < maxPolls; i++) {
    const rsp = regs.read(mailbox.rsp)
    if (rsp !== 0) return rsp
  }
  return SMU_RESPONSE.TIMEOUT
}

/**
 * The messages that set the limits, in milliwatts: `watts` sets STAPM and slow (sustained), `boostWatts` sets fast
 * (short boost). A null value sends nothing for its limits.
 */
export function smuLimitMessages(
  fam: SmuFamily,
  watts: number | null,
  boostWatts: number | null
): { cmd: number; arg: number; what: string }[] {
  const out: { cmd: number; arg: number; what: string }[] = []
  if (watts !== null) {
    out.push({ cmd: fam.cmds.stapm, arg: Math.round(watts * 1000), what: 'STAPM' })
    out.push({ cmd: fam.cmds.slow, arg: Math.round(watts * 1000), what: 'slow' })
  }
  if (boostWatts !== null)
    out.push({ cmd: fam.cmds.fast, arg: Math.round(boostWatts * 1000), what: 'fast' })
  return out
}
