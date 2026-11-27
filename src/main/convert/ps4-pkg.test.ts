import { mkdirSync, promises as fs, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { deflateSync } from 'zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  entryName,
  parseDirents,
  PkgError,
  pfscBlock,
  readPkgHeader,
  unpackingFolder,
  unpackPs4Pkg,
  xtsSectors
} from './ps4-pkg'
import { createCipheriv, getCiphers, randomBytes } from 'crypto'
import { buildFakePkg } from './test-helpers'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-ps4pkg-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** Bytes that do not compress (so a block is stored, not deflated). */
function noise(length: number, seed = 1): Buffer {
  const b = Buffer.alloc(length)
  let x = seed
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    b[i] = x >>> 24
  }
  return b
}

const GAME = [
  { path: 'eboot.bin', data: Buffer.from('\x4f\x15\x3d\x1d the game') },
  // Three blocks: one that compresses, one stored, and a short tail.
  {
    path: 'Media/big.dat',
    data: Buffer.concat([Buffer.alloc(0x10000, 7), noise(0x10000), Buffer.from('tail')])
  },
  { path: 'Media/Sub/deep.txt', data: Buffer.from('deep') },
  { path: 'sce_module/libc.prx', data: Buffer.from('module') },
  { path: 'empty.bin', data: Buffer.alloc(0) }
]

async function write(name: string, data: Buffer): Promise<string> {
  const path = join(dir, name)
  await fs.writeFile(path, data)
  return path
}

describe('entryName', () => {
  it('names the sce_sys entries, numbered ranges included', () => {
    expect(entryName(0x1000)).toBe('param.sfo')
    expect(entryName(0x1200)).toBe('icon0.png')
    expect(entryName(0x1201)).toBe('icon0_00.png')
    expect(entryName(0x121f)).toBe('icon0_30.png')
    expect(entryName(0x1261)).toBe('changeinfo/changeinfo_00.xml')
    expect(entryName(0x1400)).toBe('trophy/trophy00.trp')
    expect(entryName(0x1463)).toBe('trophy/trophy99.trp')
    expect(entryName(0x1600)).toBe('keymap_rp/001.png')
    expect(entryName(0x1609)).toBe('keymap_rp/010.png')
    expect(entryName(0x1610)).toBe('keymap_rp/00/001.png')
    expect(entryName(0x17f9)).toBe('keymap_rp/30/010.png')
    expect(entryName(0x160a)).toBeNull()
    expect(entryName(0x161a)).toBeNull()
    expect(entryName(0x10)).toBeNull()
  })
})

describe('xtsSectors', () => {
  it('matches standard AES-XTS (OpenSSL) and leaves the first 16 sectors as they are', () => {
    const keys = { dataKey: randomBytes(16), tweakKey: randomBytes(16) }
    const plain = randomBytes(0x1000 * 20)
    const data = Buffer.from(plain)
    xtsSectors(keys, data, 0, 'encrypt')
    expect(data.subarray(0, 0x10000).equals(plain.subarray(0, 0x10000))).toBe(true)
    if (getCiphers().includes('aes-128-xts')) {
      for (let sector = 16; sector < 20; sector++) {
        const iv = Buffer.alloc(16)
        iv.writeBigUInt64LE(BigInt(sector))
        const ref = createCipheriv('aes-128-xts', Buffer.concat([keys.dataKey, keys.tweakKey]), iv)
        const at = sector * 0x1000
        expect(
          ref.update(plain.subarray(at, at + 0x1000)).equals(data.subarray(at, at + 0x1000))
        ).toBe(true)
      }
    }
    xtsSectors(keys, data, 0, 'decrypt')
    expect(data.equals(plain)).toBe(true)
  })
})

describe('pfscBlock', () => {
  it('passes stored blocks, inflates compressed ones and fills empty ones', () => {
    const raw = noise(0x100)
    expect(pfscBlock(raw, 0x100)).toBe(raw)
    expect(pfscBlock(deflateSync(Buffer.alloc(0x100, 3)), 0x100)).toEqual(Buffer.alloc(0x100, 3))
    expect(pfscBlock(Buffer.alloc(0), 0x100)).toEqual(Buffer.alloc(0x100))
    expect(() => pfscBlock(Buffer.from('not zlib'), 0x100)).toThrow(PkgError)
    // A block that would inflate past its size is refused without inflating it all.
    expect(() => pfscBlock(deflateSync(Buffer.alloc(0x100000)), 0x100)).toThrow(PkgError)
  })
})

describe('parseDirents', () => {
  it('reads entries up to an empty one', () => {
    const b = Buffer.alloc(64)
    b.writeUInt32LE(5, 0)
    b.writeUInt32LE(2, 4)
    b.writeUInt32LE(3, 8)
    b.writeUInt32LE(24, 12)
    b.write('abc', 16)
    expect(parseDirents(b)).toEqual([{ ino: 5, type: 2, name: 'abc' }])
  })
})

describe('unpackPs4Pkg', () => {
  it('unpacks a fake package: game files from its file system, sce_sys from its entries', async () => {
    const sfo = Buffer.from('\0PSF fake param')
    const license = Buffer.from('license data, locked with DK3')
    const pkg = await write(
      'Game.pkg',
      buildFakePkg({
        files: GAME,
        entries: {
          0x1000: sfo,
          0x1200: Buffer.from('png'),
          0x1400: Buffer.from('trophy'),
          0x400: license
        },
        locked: [0x400]
      })
    )
    const out = join(dir, 'Game')
    const reports: number[] = []
    const result = await unpackPs4Pkg(pkg, out, { onProgress: (p) => reports.push(p.done) })
    for (const f of GAME) expect(await fs.readFile(join(out, ...f.path.split('/')))).toEqual(f.data)
    expect(await fs.readFile(join(out, 'sce_sys', 'param.sfo'))).toEqual(sfo)
    expect(await fs.readFile(join(out, 'sce_sys', 'icon0.png'), 'utf8')).toBe('png')
    expect(await fs.readFile(join(out, 'sce_sys', 'trophy', 'trophy00.trp'), 'utf8')).toBe('trophy')
    expect(await fs.readFile(join(out, 'sce_sys', 'license.dat'))).toEqual(license)
    expect(result.header.titleId).toBe('CUSA99999')
    expect(result.files).toBe(GAME.length + 4)
    expect(result.bytes).toBe(GAME.reduce((s, f) => s + f.data.length, 0))
    expect(reports.at(-1)).toBe(result.bytes)
    expect((await readPkgHeader(pkg))?.contentId).toBe('UP0000-CUSA99999_00-PLAYOUTTEST00001')
  })

  it('refuses a retail package (its image key is not locked with the fake key)', async () => {
    const pkg = await write('Retail.pkg', buildFakePkg({ files: GAME, retail: true }))
    const out = join(dir, 'Retail')
    await expect(unpackPs4Pkg(pkg, out)).rejects.toThrow(/retail package/)
    await expect(fs.access(out)).rejects.toThrow()
  })

  it('refuses a file that is not a PS4 package, and a cut-off one', async () => {
    const ps3 = Buffer.alloc(0x1000)
    ps3.writeUInt32BE(0x7f504b47, 0)
    await expect(unpackPs4Pkg(await write('PS3.pkg', ps3), join(dir, 'a'))).rejects.toThrow(
      /not a PS4 package/
    )
    const whole = buildFakePkg({ files: GAME })
    await expect(
      unpackPs4Pkg(
        await write('Cut.pkg', whole.subarray(0, whole.length - 0x20000)),
        join(dir, 'b')
      )
    ).rejects.toThrow(PkgError)
  })

  it('stops when told to, half way, leaving nothing behind', async () => {
    const pkg = await write('Game.pkg', buildFakePkg({ files: GAME }))
    const controller = new AbortController()
    const out = join(dir, 'Game')
    await expect(
      unpackPs4Pkg(pkg, out, { signal: controller.signal, onProgress: () => controller.abort() })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(await fs.readdir(dir)).toEqual(['Game.pkg'])
  })

  it('writes into a hidden folder first, replacing one an earlier quit left behind', async () => {
    const pkg = await write('Game.pkg', buildFakePkg({ files: GAME }))
    const out = join(dir, 'Game')
    expect(unpackingFolder(out)).toBe(join(dir, '.Game.unpacking'))
    await fs.mkdir(unpackingFolder(out))
    await fs.writeFile(join(unpackingFolder(out), 'stale.bin'), 'old')
    await unpackPs4Pkg(pkg, out)
    expect((await fs.readdir(dir)).sort()).toEqual(['Game', 'Game.pkg'])
    expect((await fs.readdir(out)).sort()).toEqual([
      'Media',
      'eboot.bin',
      'empty.bin',
      'sce_module'
    ])
  })

  it('leaves a folder of the same name that appears meanwhile alone', async () => {
    const pkg = await write('Game.pkg', buildFakePkg({ files: GAME }))
    const out = join(dir, 'Game')
    let made = false
    await expect(
      unpackPs4Pkg(pkg, out, {
        onProgress: () => {
          if (made) return
          made = true
          mkdirSync(out)
          writeFileSync(join(out, 'theirs.txt'), 'theirs')
        }
      })
    ).rejects.toThrow(/appeared while unpacking/)
    expect(await fs.readdir(out)).toEqual(['theirs.txt'])
    await expect(fs.access(unpackingFolder(out))).rejects.toThrow()
  })

  it('never writes outside the game folder', async () => {
    const pkg = await write(
      'Evil.pkg',
      buildFakePkg({ files: [{ path: '../escape.txt', data: Buffer.from('x') }] })
    )
    await expect(unpackPs4Pkg(pkg, join(dir, 'Evil'))).rejects.toThrow(/unusable name/)
    await expect(fs.access(join(dir, 'escape.txt'))).rejects.toThrow()
  })
})
