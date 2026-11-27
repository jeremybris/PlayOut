import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixSharedMemoryCard, gameSettingsName, separateSlots } from './pcsx2-memory-cards'

const GLOBAL = [
  'Slot1_Enable = true',
  'Slot1_Filename = Mcd001.ps2',
  'Slot2_Enable = true',
  'Slot2_Filename = Mcd002.ps2'
]

describe('separateSlots', () => {
  it('gives the other slot the card the chosen slot would have used (the two cards trade places)', () => {
    // This PC: 007's Game Properties put its save card, Mcd002, in slot 1; slot 2 uses Mcd002 for every game.
    expect(separateSlots(GLOBAL, ['Slot1_Filename = Mcd002.ps2'])).toEqual({
      Slot2_Filename: 'Mcd001.ps2'
    })
    expect(separateSlots(GLOBAL, ['Slot2_Filename = mcd001.ps2'])).toEqual({
      Slot1_Filename: 'Mcd002.ps2'
    })
  })

  it('switches the other slot off when there is no other card to give it', () => {
    expect(separateSlots(GLOBAL, ['Slot1_Filename = X.ps2', 'Slot2_Filename = X.ps2'])).toEqual({
      Slot2_Enable: 'false'
    })
    const sameGlobal = ['Slot1_Filename = A.ps2', 'Slot2_Filename = A.ps2']
    expect(separateSlots(sameGlobal, null)).toEqual({ Slot2_Enable: 'false' })
  })

  it('leaves slots that already use different cards, or a switched-off slot, alone', () => {
    expect(separateSlots(GLOBAL, null)).toBeNull()
    expect(separateSlots(GLOBAL, ['Slot1_Filename = Mcd003.ps2'])).toBeNull()
    expect(
      separateSlots(GLOBAL, ['Slot1_Filename = Mcd002.ps2', 'Slot2_Enable = false'])
    ).toBeNull()
    // PCSX2's defaults when PCSX2.ini names no cards.
    expect(separateSlots(null, null)).toBeNull()
    expect(separateSlots(null, ['Slot2_Filename = Mcd001.ps2'])).toEqual({
      Slot1_Filename: 'Mcd002.ps2'
    })
  })

  it('names a game settings file as PCSX2 does', () => {
    expect(gameSettingsName('SLUS-21282', 0x22dc8eac)).toBe('SLUS-21282_22DC8EAC.ini')
    expect(gameSettingsName('', 0xab)).toBe('000000AB.ini')
  })
})

describe('fixSharedMemoryCard', () => {
  let emu: string
  const rom = 'C:\\Games\\ps2\\007 - From Russia with Love (USA).chd'
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const str = (s: string): Buffer => {
    const b = Buffer.from(s, 'utf8')
    const n = Buffer.alloc(4)
    n.writeUInt32LE(b.length)
    return Buffer.concat([n, b])
  }
  /** PCSX2's cache with one record (GameList.cpp WriteEntryToCache). */
  const cache = (path: string, serial: string, crc: number): Buffer => {
    const tail = Buffer.alloc(23)
    tail.writeBigUInt64LE(1_000n, 10)
    tail.writeUInt32LE(crc, 18)
    return Buffer.concat([
      Buffer.from([0x47, 0x4c, 0x43, 0x45, 34, 0, 0, 0]),
      str(path),
      str(serial),
      str('007'),
      str(''),
      str(''),
      tail
    ])
  }

  beforeEach(async () => {
    emu = await mkdtemp(join(tmpdir(), 'playout-pcsx2-cards-'))
    for (const d of ['inis', 'cache', 'gamesettings']) await mkdir(join(emu, d))
    await writeFile(
      join(emu, 'inis', 'PCSX2.ini'),
      `[Folders]\nCache = cache\n\n[MemoryCards]\n${GLOBAL.join('\n')}\n`
    )
    await writeFile(join(emu, 'cache', 'gamelist.cache'), cache(rom, 'SLUS-21282', 0x22dc8eac))
    vi.clearAllMocks()
  })
  afterEach(() => rm(emu, { recursive: true, force: true }))

  it("fixes 007's settings on this PC, keeping its card and the rest of the file", async () => {
    const own = join(emu, 'gamesettings', 'SLUS-21282_22DC8EAC.ini')
    await writeFile(
      own,
      '[MemoryCards]\nSlot1_Filename = Mcd002.ps2\n\n\n[Patches]\nEnable = Widescreen 16:9\n'
    )
    expect(await fixSharedMemoryCard({ emuDir: emu, rom, log })).toBe(true)
    const text = await readFile(own, 'utf8')
    expect(text).toContain('Slot1_Filename = Mcd002.ps2\nSlot2_Filename = Mcd001.ps2\n')
    expect(text).toContain('[Patches]\nEnable = Widescreen 16:9')
    // Fixed: nothing more to do.
    expect(await fixSharedMemoryCard({ emuDir: emu, rom, log })).toBe(false)
  })

  it('does nothing for a game PCSX2 has not listed, or without settings of its own', async () => {
    expect(await fixSharedMemoryCard({ emuDir: emu, rom: 'C:\\Games\\other.iso', log })).toBe(false)
    // A first launch before PCSX2 scanned the game: no serial and CRC to name its file, which is logged.
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('not in the game list cache yet'))
    expect(await fixSharedMemoryCard({ emuDir: emu, rom, log })).toBe(false)
  })

  it('asks whether PCSX2 runs only before a write, and writes nothing while it does', async () => {
    const isRunning = vi.fn(async () => true)
    // Nothing to change: no process list at all.
    expect(await fixSharedMemoryCard({ emuDir: emu, rom, log, isRunning })).toBe(false)
    expect(isRunning).not.toHaveBeenCalled()

    const own = join(emu, 'gamesettings', 'SLUS-21282_22DC8EAC.ini')
    const shared = '[MemoryCards]\nSlot1_Filename = Mcd002.ps2\n'
    await writeFile(own, shared)
    expect(await fixSharedMemoryCard({ emuDir: emu, rom, log, isRunning })).toBe(false)
    expect(isRunning).toHaveBeenCalledTimes(1)
    expect(await readFile(own, 'utf8')).toBe(shared)

    isRunning.mockResolvedValue(false)
    expect(await fixSharedMemoryCard({ emuDir: emu, rom, log, isRunning })).toBe(true)
    expect(await readFile(own, 'utf8')).toContain('Slot2_Filename = Mcd001.ps2')
  })
})
