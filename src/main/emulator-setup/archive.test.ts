import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from '../logger'
import { crc32Update } from '../util/hash'
import { detectArchive, extractArchive, flattenSingleRoot } from './archive'
import type { Runner } from './types'

const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** A stored (uncompressed) zip built in memory. Names are written exactly as given (backslashes included). */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const nameBuf = Buffer.from(name)
    const crc = crc32Update(0, data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const dir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(dir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, eocd])
}

interface RunCall {
  file: string
  args: string[]
}

/** A Runner answering each call in turn (the last repeats); `effect` may write files like the real tool would. */
function fakeRunner(
  results: { code: number | null; effect?: (args: string[]) => Promise<void> }[]
): { run: Runner; calls: RunCall[] } {
  const calls: RunCall[] = []
  const run: Runner = async (file, args) => {
    calls.push({ file, args })
    const r = results[Math.min(calls.length - 1, results.length - 1)]!
    await r.effect?.(args)
    return { code: r.code, stdout: '', stderr: r.code ? 'boom' : '' }
  }
  return { run, calls }
}

let root: string
let dest: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-archive-'))
  dest = join(root, 'out')
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function write(name: string, data: Buffer | string): Promise<string> {
  const path = join(root, name)
  await fs.writeFile(path, data)
  return path
}

const SEVEN_Z_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])
const noSevenZip = async (): Promise<string> => {
  throw new Error('7zr should not be needed')
}

describe('detectArchive', () => {
  it('recognises zip, 7z, sfx and unknown by content', async () => {
    expect(await detectArchive(await write('a.bin', makeZip({ a: 'a' })))).toBe('zip')
    expect(await detectArchive(await write('e.bin', makeZip({})))).toBe('zip')
    expect(await detectArchive(await write('b.zip', SEVEN_Z_MAGIC))).toBe('7z')
    expect(await detectArchive(await write('c.7z', 'MZ\x90\x00'))).toBe('sfx')
    expect(await detectArchive(await write('d.zip', 'hello'))).toBe('unknown')
    expect(await detectArchive(await write('f.zip', ''))).toBe('unknown')
  })
})

describe('extractArchive: zip', () => {
  it('extracts and removes the single root folder', async () => {
    const zip = await write(
      'scummvm.zip',
      makeZip({
        'scummvm-2026.4.0-win32-x86_64/': '',
        'scummvm-2026.4.0-win32-x86_64/scummvm.exe': 'exe',
        'scummvm-2026.4.0-win32-x86_64/doc/README.txt': 'doc'
      })
    )
    await extractArchive(zip, dest, { sevenZip: noSevenZip, run: fakeRunner([]).run, log })
    expect((await fs.readdir(dest)).sort()).toEqual(['doc', 'scummvm.exe'])
    expect(await fs.readFile(join(dest, 'doc', 'README.txt'), 'utf8')).toBe('doc')
  })

  it('handles Azahar-style backslash names and backslash folder entries', async () => {
    const zip = await write(
      'azahar.zip',
      makeZip({
        'azahar-windows-msys2-2126.2\\': '',
        'azahar-windows-msys2-2126.2\\azahar.exe': 'exe',
        'azahar-windows-msys2-2126.2\\plugins\\': '',
        'azahar-windows-msys2-2126.2\\plugins\\qwindows.dll': 'dll'
      })
    )
    await extractArchive(zip, dest, { sevenZip: noSevenZip, run: fakeRunner([]).run, log })
    expect((await fs.readdir(dest)).sort()).toEqual(['azahar.exe', 'plugins'])
    expect(await fs.readFile(join(dest, 'plugins', 'qwindows.dll'), 'utf8')).toBe('dll')
  })

  it('keeps a zip with several top-level entries as is', async () => {
    const zip = await write('m.zip', makeZip({ 'mame.exe': 'exe', 'ini/mame.ini': 'x' }))
    await extractArchive(zip, dest, { sevenZip: noSevenZip, run: fakeRunner([]).run, log })
    expect((await fs.readdir(dest)).sort()).toEqual(['ini', 'mame.exe'])
  })

  it('falls back to tar.exe when the built-in reader cannot read it', async () => {
    // A zip whose directory claims zip64 (0xffff entries).
    const zip = makeZip({ 'a.txt': 'a' })
    zip.writeUInt16LE(0xffff, zip.length - 22 + 10)
    const file = await write('big.zip', zip)
    const { run, calls } = fakeRunner([
      { code: 0, effect: async () => fs.writeFile(join(dest, 'a.txt'), 'a') }
    ])
    await extractArchive(file, dest, { sevenZip: noSevenZip, run, log })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.file).toMatch(/System32[\\/]tar\.exe$/i)
    expect(calls[0]!.args).toEqual(['-xf', file, '-C', dest])
    expect(await fs.readdir(dest)).toEqual(['a.txt'])
  })

  it('reports a tar failure', async () => {
    const zip = makeZip({ 'a.txt': 'a' })
    zip.writeUInt16LE(0xffff, zip.length - 22 + 10)
    const file = await write('big.zip', zip)
    await expect(
      extractArchive(file, dest, { sevenZip: noSevenZip, run: fakeRunner([{ code: 1 }]).run, log })
    ).rejects.toThrow(/tar exit 1/)
  })
})

describe('extractArchive: 7z and sfx', () => {
  it('runs 7zr x with the output folder and flattens', async () => {
    const file = await write('dolphin.7z', SEVEN_Z_MAGIC)
    const { run, calls } = fakeRunner([
      {
        code: 0,
        effect: async () => {
          await fs.mkdir(join(dest, 'Dolphin-x64'), { recursive: true })
          await fs.writeFile(join(dest, 'Dolphin-x64', 'Dolphin.exe'), 'exe')
        }
      }
    ])
    await extractArchive(file, dest, { sevenZip: async () => 'C:\\tools\\7zr.exe', run, log })
    expect(calls).toEqual([
      { file: 'C:\\tools\\7zr.exe', args: ['x', '-y', '-bd', `-o${dest}`, file] }
    ])
    expect(await fs.readdir(dest)).toEqual(['Dolphin.exe'])
  })

  it('passes flattenLevels on: RetroArch_cores.7z keeps cores\\', async () => {
    const file = await write('RetroArch_cores.7z', SEVEN_Z_MAGIC)
    const { run } = fakeRunner([
      {
        code: 0,
        effect: async () => {
          await fs.mkdir(join(dest, 'RetroArch-Win64', 'cores'), { recursive: true })
          await fs.writeFile(join(dest, 'RetroArch-Win64', 'cores', 'a_libretro.dll'), 'dll')
        }
      }
    ])
    await extractArchive(
      file,
      dest,
      { sevenZip: async () => '7zr.exe', run, log },
      { flattenLevels: 1 }
    )
    expect(await fs.readdir(dest)).toEqual(['cores'])
  })

  it('accepts 7-Zip warnings (exit 1) and rejects errors (exit 2)', async () => {
    const file = await write('a.7z', SEVEN_Z_MAGIC)
    await extractArchive(file, dest, {
      sevenZip: async () => '7zr.exe',
      run: fakeRunner([{ code: 1 }]).run,
      log
    })
    await expect(
      extractArchive(file, dest, {
        sevenZip: async () => '7zr.exe',
        run: fakeRunner([{ code: 2 }]).run,
        log
      })
    ).rejects.toThrow(/7-Zip exit 2/)
  })

  it('sfx: 7zr first', async () => {
    const file = await write('mame.exe', 'MZ....')
    const { run, calls } = fakeRunner([{ code: 0 }])
    await extractArchive(file, dest, { sevenZip: async () => '7zr.exe', run, log })
    expect(calls).toEqual([{ file: '7zr.exe', args: ['x', '-y', '-bd', `-o${dest}`, file] }])
  })

  it('sfx: runs the self-extractor when 7zr fails', async () => {
    const file = await write('mame.exe', 'MZ....')
    const { run, calls } = fakeRunner([
      { code: 2 },
      { code: 0, effect: async () => fs.writeFile(join(dest, 'mame.exe'), 'exe') }
    ])
    await extractArchive(file, dest, { sevenZip: async () => '7zr.exe', run, log })
    expect(calls[1]).toEqual({ file, args: [`-o${dest}`, '-y'] })
    expect(await fs.readdir(dest)).toEqual(['mame.exe'])
  })

  it('sfx: runs the self-extractor when 7zr cannot be obtained', async () => {
    const file = await write('mame.exe', 'MZ....')
    const { run, calls } = fakeRunner([{ code: 0 }])
    await extractArchive(file, dest, { sevenZip: noSevenZip, run, log })
    expect(calls).toEqual([{ file, args: [`-o${dest}`, '-y'] }])
  })

  it('rejects an unknown file', async () => {
    const file = await write('x.zip', 'not an archive')
    await expect(
      extractArchive(file, dest, { sevenZip: noSevenZip, run: fakeRunner([]).run, log })
    ).rejects.toThrow(/not a zip, 7z/)
  })
})

describe('flattenSingleRoot', () => {
  it('handles a child named like the root folder', async () => {
    await fs.mkdir(join(dest, 'RPCS3', 'RPCS3'), { recursive: true })
    await fs.writeFile(join(dest, 'RPCS3', 'RPCS3', 'inner.txt'), 'i')
    await fs.writeFile(join(dest, 'RPCS3', 'rpcs3.exe'), 'exe')
    await flattenSingleRoot(dest)
    expect((await fs.readdir(dest)).sort()).toEqual(['RPCS3', 'rpcs3.exe'])
    expect(await fs.readFile(join(dest, 'RPCS3', 'inner.txt'), 'utf8')).toBe('i')
  })

  it('stops after two levels and leaves a single file alone', async () => {
    await fs.mkdir(join(dest, 'a', 'b', 'c'), { recursive: true })
    await fs.writeFile(join(dest, 'a', 'b', 'c', 'f.txt'), 'f')
    await flattenSingleRoot(dest)
    expect(await fs.readdir(dest)).toEqual(['c'])

    const single = join(root, 'single')
    await fs.mkdir(single)
    await fs.writeFile(join(single, 'only.exe'), 'x')
    await flattenSingleRoot(single)
    expect(await fs.readdir(single)).toEqual(['only.exe'])
  })

  it('removes only one level when asked (RetroArch_cores.7z keeps its cores folder)', async () => {
    await fs.mkdir(join(dest, 'RetroArch-Win64', 'cores'), { recursive: true })
    await fs.writeFile(join(dest, 'RetroArch-Win64', 'cores', 'snes9x_libretro.dll'), 'dll')
    await flattenSingleRoot(dest, 1)
    expect(await fs.readdir(dest)).toEqual(['cores'])
    expect(await fs.readdir(join(dest, 'cores'))).toEqual(['snes9x_libretro.dll'])
  })
})
