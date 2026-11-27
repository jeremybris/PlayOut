import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { peMachine, sdlDirFor } from './sdl'

/** A minimal PE header: "MZ", e_lfanew = 0x80, "PE\0\0", then the machine field. */
function pe(machine: number): Buffer {
  const b = Buffer.alloc(0x100)
  b.write('MZ', 0, 'latin1')
  b.writeUInt32LE(0x80, 0x3c)
  b.write('PE\0\0', 0x80, 'latin1')
  b.writeUInt16LE(machine, 0x84)
  return b
}

const root = mkdtempSync(join(tmpdir(), 'playout-sdl-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function folder(name: string, dll?: Buffer): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (dll) writeFileSync(join(dir, 'SDL2.dll'), dll)
  return dir
}

describe('peMachine', () => {
  it('reads the machine of a PE header', () => {
    expect(peMachine(pe(0x8664))).toBe(0x8664)
    expect(peMachine(pe(0x14c))).toBe(0x14c)
  })

  it('rejects what is not a PE image', () => {
    expect(
      peMachine(Buffer.from('not a dll at all, just some text padding it out to 64 bytes......'))
    ).toBeNull()
    expect(peMachine(Buffer.alloc(10))).toBeNull()
    const bad = pe(0x8664)
    bad.writeUInt32LE(0x1000, 0x3c) // e_lfanew past the end
    expect(peMachine(bad)).toBeNull()
  })
})

describe('sdlDirFor', () => {
  it('picks the first folder with an x64 SDL2.dll, skipping missing and 32-bit copies', () => {
    const empty = folder('empty')
    const x86 = folder('x86', pe(0x14c))
    const x64 = folder('x64', pe(0x8664))
    const later = folder('later', pe(0x8664))
    expect(sdlDirFor(['', join(root, 'missing'), empty, x86, x64, later])).toBe(x64)
  })

  it('returns null when no folder has one', () => {
    expect(sdlDirFor([])).toBeNull()
    expect(sdlDirFor([folder('none'), folder('junk', Buffer.from('junk'))])).toBeNull()
  })
})
