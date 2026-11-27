import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findTools, missingFor, readHexKey, toolArgs } from './requirements'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-emulation-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function put(relative: string, data: string | Buffer): Promise<string> {
  const path = join(dir, ...relative.split('/'))
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, data)
  return path
}

const KEY = '00112233445566778899aabbccddeeff'
const none = async (): Promise<null> => null

describe('keys and tools for Convert', () => {
  it('reads a key from 16 bytes or from hex text in its usual spellings', () => {
    expect(readHexKey(Buffer.from(KEY, 'hex'))).toBe(KEY)
    expect(readHexKey(Buffer.from(`# my key\ncommon = 0x${KEY.toUpperCase()}\n`))).toBe(KEY)
    expect(readHexKey(Buffer.from('00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff'))).toBe(KEY)
    expect(readHexKey(Buffer.from('not a key'))).toBeNull()
  })

  it("finds the Switch keys in an emulator's keys folder, as EmuDeck keeps them", async () => {
    const keys = await put('bios/ryujinx/keys/prod.keys', 'header_key = 00')
    expect(await findTools(['switchKeys'], { emulationDir: dir, emulatorPath: none })).toEqual({
      switchKeys: keys
    })
  })

  it('takes DolphinTool beside the Dolphin PlayOut found, and RPCS3 for PS3 packages', async () => {
    const dolphin = await put('emu/Dolphin.exe', '')
    const tool = await put('emu/DolphinTool.exe', '')
    const rpcs3 = await put('emu/rpcs3.exe', '')
    const emulatorPath = async (id: string): Promise<string | null> =>
      id === 'DOLPHIN' ? dolphin : id === 'RPCS3' ? rpcs3 : null
    expect(await findTools(['wiiKey', 'ps3Unpack'], { emulationDir: dir, emulatorPath })).toEqual({
      dolphinTool: tool,
      rpcs3
    })
  })

  it('says what is missing and exactly where it goes, blocking only what cannot run without it', async () => {
    const missing = missingFor(['switchKeys', 'wiiKey', 'ps3PackKey'], {}, dir)
    expect(missing.map((m) => [m.need, m.blocking])).toEqual([
      ['switchKeys', false],
      ['wiiKey', true],
      ['ps3PackKey', true]
    ])
    expect(missing[0]!.place).toBe(join(dir, 'bios', 'switch', 'prod.keys'))
    expect(missing[2]!.place).toBe(join(dir, 'bios', 'ps3', 'pkg-key.txt'))
    // A PS3 package unpacks with RPCS3 or the key, so either one is enough.
    expect(missingFor(['ps3Unpack'], { rpcs3: 'x' }, dir)).toEqual([])
  })

  it('passes the found keys and tools to the converter', async () => {
    await put('bios/ps3/pkg-key.txt', KEY)
    const tools = await findTools(['ps3PackKey'], { emulationDir: dir, emulatorPath: none })
    expect(toolArgs(tools)).toEqual(['--pkg-key', KEY])
  })
})
