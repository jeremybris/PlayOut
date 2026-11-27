import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { godGames, godPackagesIn } from './god'
import { takeName } from './convert-service'
import { MIN_CONVERTER_VERSION, versionAtLeast } from './converter-tool'

/** A package header: its magic and, at 0x344, its content type. */
const header = (magic: string, type: number): Buffer => {
  const b = Buffer.alloc(0x348)
  b.write(magic, 0, 'latin1')
  b.writeUInt32BE(type, 0x344)
  return b
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'god-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('godPackagesIn', () => {
  it('finds each package (magic, no extension, its .data folder beside it), from the title folder down', async () => {
    const content = join(dir, '4D5307E6', '00007000')
    mkdirSync(join(content, 'ABCDEF0123.data'), { recursive: true })
    mkdirSync(join(content, 'FEDCBA3210.data'), { recursive: true })
    writeFileSync(join(content, 'ABCDEF0123'), header('LIVE', 0x7000))
    writeFileSync(join(content, 'FEDCBA3210'), header('CON ', 0x4000))
    // An Original Xbox package (0x5000) with its .data folder is not a disc game for the converter.
    mkdirSync(join(content, 'XBOX1PKG.data'))
    writeFileSync(join(content, 'XBOX1PKG'), header('LIVE', 0x5000))
    // Not packages: no .data folder, another magic, an extension.
    writeFileSync(join(content, 'LONELY'), 'LIVE')
    mkdirSync(join(content, 'OTHER.data'))
    writeFileSync(join(content, 'OTHER'), 'XYZW')
    await expect(godPackagesIn(dir)).resolves.toEqual([
      join(content, 'ABCDEF0123'),
      join(content, 'FEDCBA3210')
    ])
  })

  it('tells one game (its discs under one title id) from several', () => {
    expect(godGames(['C:/c/4D5307E6/00007000/A', 'C:/c/4D5307E6/00007000/B'])).toBe(1)
    expect(godGames(['C:/c/4D5307E6/00007000/A', 'C:/c/415607D1/00007000/B'])).toBe(2)
  })

  it('finds nothing in a folder without a package', async () => {
    writeFileSync(join(dir, 'game.iso'), 'x')
    expect(await godPackagesIn(dir)).toEqual([])
  })
})

describe('takeName', () => {
  it("gives a same-extension result the original's name once the original is gone, never over a file", async () => {
    const original = join(dir, 'Mario.nds')
    const output = join(dir, 'Mario (trimmed).nds')
    writeFileSync(output, 'new')
    writeFileSync(original, 'old')
    expect(await takeName(output, original)).toBe(output)
    rmSync(original)
    expect(await takeName(output, original)).toBe(original)
    expect(await takeName(join(dir, 'x.sfc'), join(dir, 'x.smc'))).toBe(join(dir, 'x.sfc'))
  })
})

describe('converter version', () => {
  it('needs 2.1.1 or newer', () => {
    expect(MIN_CONVERTER_VERSION).toBe('2.1.1')
    expect(versionAtLeast('2.1.1', '2.1.1')).toBe(true)
    expect(versionAtLeast('2.10.0', '2.1.1')).toBe(true)
    expect(versionAtLeast('2.1.0', '2.1.1')).toBe(false)
    expect(versionAtLeast('2.1', '2.1.1')).toBe(false)
    expect(versionAtLeast('3', '2.1.1')).toBe(true)
  })
})
