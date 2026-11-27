import { closeSync, openSync, readSync } from 'fs'
import { join } from 'path'

/** IMAGE_FILE_MACHINE_AMD64: the controller reader runs in 64-bit powershell.exe, so only an x64 SDL2.dll loads. */
const MACHINE_AMD64 = 0x8664

/**
 * The PE machine type of a DLL's header bytes, or null when they are not a PE image. `e_lfanew` (offset 0x3C) points
 * at the "PE\0\0" signature, which the 2-byte machine field follows.
 */
export function peMachine(header: Buffer): number | null {
  if (header.length < 0x40 || header.readUInt16LE(0) !== 0x5a4d) return null
  const pe = header.readUInt32LE(0x3c)
  if (pe + 6 > header.length || header.readUInt32LE(pe) !== 0x00004550) return null
  return header.readUInt16LE(pe + 4)
}

function machineOf(file: string): number | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const header = Buffer.alloc(4096)
    const read = readSync(fd, header, 0, header.length, 0)
    return peMachine(header.subarray(0, read))
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * The first folder of `candidates` holding an x64 SDL2.dll, for the controller reader's non-XInput pads (DualShock 4,
 * DualSense, Switch Pro); null when none does, and the reader then reads XInput pads only. A 32-bit copy is skipped
 * rather than chosen: loading it would fail inside the reader and leave those pads unread.
 */
export function sdlDirFor(candidates: readonly string[]): string | null {
  for (const dir of candidates) {
    if (!dir) continue
    if (machineOf(join(dir, 'SDL2.dll')) === MACHINE_AMD64) return dir
  }
  return null
}
