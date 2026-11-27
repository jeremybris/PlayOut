import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deflateRawSync } from 'zlib'

vi.mock('./ini', () => ({ setIniValues: vi.fn(async () => undefined) }))

import { syncBios, type BiosContext } from './bios'
import { setIniValues } from './ini'
import type { Runner } from './types'

/** A minimal zip writer for tests: deflated entries. */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const raw = Buffer.from(text)
    const data = deflateRawSync(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

let root: string
let data: string
let emus: Record<string, string>

async function put(path: string, content: string | Buffer = 'x'): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, content)
}

async function read(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

function context(run: Runner = async () => ({ code: 0, stdout: '', stderr: '' })): BiosContext {
  return { emuDirOf: (id) => emus[id] ?? null, dataDir: data, run, log }
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-bios-'))
  data = join(root, 'data')
  await fs.mkdir(join(data, 'bios'), { recursive: true })
  emus = {}
  vi.mocked(setIniValues).mockClear()
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('syncBios', () => {
  it('does nothing and reports nothing when no emulator or BIOS file is there', async () => {
    expect(await syncBios(context())).toEqual([])
    emus = {
      RPCS3: join(root, 'RPCS3'),
      RYUJINX: join(root, 'Ryujinx'),
      DOLPHIN: join(root, 'Dolphin'),
      MGBA: join(root, 'mGBA')
    }
    const run = vi.fn<Runner>(async () => ({ code: 0, stdout: '', stderr: '' }))
    expect(await syncBios(context(run))).toEqual([])
    expect(run).not.toHaveBeenCalled()
    expect(setIniValues).not.toHaveBeenCalled()
  })

  describe('RPCS3', () => {
    beforeEach(() => {
      emus.RPCS3 = join(root, 'RPCS3')
    })

    it('installs the firmware headless and verifies vsh.self', async () => {
      const pup = join(data, 'bios', 'ps3', 'PS3UPDAT.PUP')
      await put(pup)
      const run = vi.fn<Runner>(async (_file, _args, options) => {
        await put(join(options!.cwd!, 'dev_flash', 'vsh', 'module', 'vsh.self'))
        return { code: 0, stdout: '', stderr: '' }
      })
      expect(await syncBios(context(run))).toEqual([])
      expect(run).toHaveBeenCalledWith(
        join(emus.RPCS3, 'rpcs3.exe'),
        ['--headless', '--installfw', pup],
        { cwd: emus.RPCS3, timeoutMs: 600000 }
      )
      // Installed: not run again.
      expect(await syncBios(context(run))).toEqual([])
      expect(run).toHaveBeenCalledTimes(1)
    })

    it('prefers bios\\PS3UPDAT.PUP and reports a failed install', async () => {
      await put(join(data, 'bios', 'PS3UPDAT.PUP'))
      await put(join(data, 'bios', 'ps3', 'PS3UPDAT.PUP'))
      const run = vi.fn<Runner>(async () => ({ code: 1, stdout: '', stderr: 'bad' }))
      expect(await syncBios(context(run))).toEqual([
        'RPCS3: the PS3 firmware could not be installed from bios\\PS3UPDAT.PUP.'
      ])
      expect(run.mock.calls[0][1][2]).toBe(join(data, 'bios', 'PS3UPDAT.PUP'))
    })
  })

  describe('Ryujinx', () => {
    let system: string
    let registered: string
    beforeEach(() => {
      emus.RYUJINX = join(root, 'Ryujinx')
      system = join(emus.RYUJINX, 'portable', 'system')
      registered = join(emus.RYUJINX, 'portable', 'bis', 'system', 'Contents', 'registered')
    })

    it('copies the keys from the first folder with prod.keys, only when different', async () => {
      await put(join(data, 'bios', 'prod.keys'), 'root')
      await put(join(data, 'bios', 'switch', 'prod.keys'), 'prod')
      await put(join(data, 'bios', 'switch', 'title.keys'), 'title')
      expect(await syncBios(context())).toEqual([])
      expect(await read(join(system, 'prod.keys'))).toBe('prod')
      expect(await read(join(system, 'title.keys'))).toBe('title')

      const stamp = new Date('2020-01-01T00:00:00Z')
      await fs.utimes(join(system, 'prod.keys'), stamp, stamp)
      await syncBios(context())
      expect((await fs.stat(join(system, 'prod.keys'))).mtime.getTime()).toBe(stamp.getTime())

      await put(join(data, 'bios', 'switch', 'prod.keys'), 'prod2')
      await syncBios(context())
      expect(await read(join(system, 'prod.keys'))).toBe('prod2')
    })

    it('installs loose .nca firmware as registered\\<id>.nca\\00', async () => {
      const fw = join(data, 'bios', 'switch', 'firmware')
      await put(join(fw, 'aaa111.nca'), 'A')
      await put(join(fw, 'bbb222.cnmt.nca'), 'B')
      await put(join(fw, 'readme.txt'), 'ignored')
      expect(await syncBios(context())).toEqual([])
      expect(await read(join(registered, 'aaa111.nca', '00'))).toBe('A')
      expect(await read(join(registered, 'bbb222.nca', '00'))).toBe('B')
      expect((await fs.readdir(registered)).sort()).toEqual(['aaa111.nca', 'bbb222.nca'])
      await expect(fs.access(`${registered}.playout-tmp`)).rejects.toThrow()
    })

    it('installs firmware from a zip of .nca files when the folder has no loose ones', async () => {
      const fw = join(data, 'bios', 'ryujinx', 'firmware')
      await put(
        join(fw, 'Firmware 19.0.1.zip'),
        makeZip({ 'Firmware/ccc333.nca': 'C', 'Firmware/ddd444.cnmt.nca': 'D', 'notes.txt': 'n' })
      )
      expect(await syncBios(context())).toEqual([])
      expect(await read(join(registered, 'ccc333.nca', '00'))).toBe('C')
      expect(await read(join(registered, 'ddd444.nca', '00'))).toBe('D')
    })

    it('replaces an empty registered folder but never touches a non-empty one', async () => {
      const fw = join(data, 'bios', 'switch', 'firmware')
      await put(join(fw, 'aaa111.nca'), 'A')
      await fs.mkdir(registered, { recursive: true })
      await syncBios(context())
      expect(await read(join(registered, 'aaa111.nca', '00'))).toBe('A')

      await fs.rm(registered, { recursive: true })
      await put(join(registered, 'existing.nca', '00'), 'E')
      await syncBios(context())
      expect(await fs.readdir(registered)).toEqual(['existing.nca'])
    })

    it('reports a firmware folder that cannot be installed and cleans up the staging folder', async () => {
      const fw = join(data, 'bios', 'switch', 'firmware')
      await put(join(fw, 'aaa111.nca'), 'A')
      // A file where Contents should be: the staging folder cannot be made.
      await put(join(emus.RYUJINX, 'portable', 'bis', 'system', 'Contents'), 'blocker')
      expect(await syncBios(context())).toEqual([
        'Ryujinx: the Switch firmware could not be installed from bios\\switch\\firmware.'
      ])
    })
  })

  it('copies the Dolphin IPL per region when missing', async () => {
    emus.DOLPHIN = join(root, 'Dolphin')
    await put(join(data, 'bios', 'GC', 'USA', 'IPL.bin'), 'usa')
    await put(join(data, 'bios', 'GC', 'EUR', 'IPL.bin'), 'eur')
    await put(join(emus.DOLPHIN, 'User', 'GC', 'EUR', 'IPL.bin'), 'mine')
    expect(await syncBios(context())).toEqual([])
    expect(await read(join(emus.DOLPHIN, 'User', 'GC', 'USA', 'IPL.bin'))).toBe('usa')
    expect(await read(join(emus.DOLPHIN, 'User', 'GC', 'EUR', 'IPL.bin'))).toBe('mine')
    expect(await read(join(emus.DOLPHIN, 'User', 'GC', 'JAP', 'IPL.bin'))).toBeNull()
  })

  it('sets the mGBA BIOS keys for the files that exist', async () => {
    emus.MGBA = join(root, 'mGBA')
    await put(join(data, 'bios', 'gba_bios.bin'))
    await put(join(data, 'bios', 'gbc_bios.bin'))
    expect(await syncBios(context())).toEqual([])
    expect(setIniValues).toHaveBeenCalledWith(
      join(emus.MGBA, 'config.ini'),
      'ports.qt',
      {
        'gba.bios': join(data, 'bios', 'gba_bios.bin'),
        'gbc.bios': join(data, 'bios', 'gbc_bios.bin')
      },
      { style: 'tight' }
    )
  })

  it('keeps going when one emulator fails', async () => {
    emus.MGBA = join(root, 'mGBA')
    emus.DOLPHIN = join(root, 'Dolphin')
    await put(join(data, 'bios', 'gba_bios.bin'))
    await put(join(data, 'bios', 'GC', 'JAP', 'IPL.bin'), 'jap')
    vi.mocked(setIniValues).mockRejectedValueOnce(new Error('locked'))
    expect(await syncBios(context())).toEqual([
      'mGBA: the BIOS paths could not be written to config.ini.'
    ])
    expect(await read(join(emus.DOLPHIN, 'User', 'GC', 'JAP', 'IPL.bin'))).toBe('jap')
  })
})
