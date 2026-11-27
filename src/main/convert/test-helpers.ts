import { createCipheriv, createHash, randomBytes } from 'crypto'
import { deflateSync } from 'zlib'
import { FAKE_KEY, PKG_DERIVED_KEY3, type RsaKey } from './ps4-keys'
import { PKG_MAGIC, pfsKeys, xtsSectors } from './ps4-pkg'

/**
 * A small fake PS4 package built the way the real ones are (tests): an entry table with keys locked by the public fake
 * keys, an encrypted outer PFS holding pfs_image.dat, and inside it a PFSC image of an inner PFS with the game files.
 */

export interface FakePkgFile {
  /** Path inside the game folder, `/`-separated. */
  path: string
  data: Buffer
}

export interface FakePkgOptions {
  files: FakePkgFile[]
  contentId?: string
  /** The image key locked with a key PlayOut does not have (a retail package). */
  retail?: boolean
  /** sce_sys entries: id → contents; locked with DK3 when `locked` lists the id. */
  entries?: Record<number, Buffer>
  locked?: number[]
}

const B = 0x10000

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n
  let b = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return result
}

/** RSA-2048 encryption with PKCS#1 v1.5 padding, with the key's public exponent (65537). */
function rsaEncrypt(key: RsaKey, message: Buffer): Buffer {
  const pad = Buffer.alloc(256 - 3 - message.length)
  for (let i = 0; i < pad.length; i++) pad[i] = 1 + (randomBytes(1)[0]! % 255)
  const block = Buffer.concat([Buffer.from([0, 2]), pad, Buffer.from([0]), message])
  const c = modPow(BigInt(`0x${block.toString('hex')}`), 65537n, BigInt(`0x${key.modulus}`))
  return Buffer.from(c.toString(16).padStart(512, '0'), 'hex')
}

function aesCbcEncrypt(ivKey: Buffer, data: Buffer): Buffer {
  const padded =
    data.length % 16 ? Buffer.concat([data, Buffer.alloc(16 - (data.length % 16))]) : data
  const c = createCipheriv('aes-128-cbc', ivKey.subarray(16, 32), ivKey.subarray(0, 16))
  c.setAutoPadding(false)
  return Buffer.concat([c.update(padded), c.final()])
}

interface Node {
  ino: number
  name: string
  dir: boolean
  data?: Buffer
  children: Node[]
}

function dirents(entries: { ino: number; type: number; name: string }[]): Buffer {
  const parts = entries.map((e) => {
    const name = Buffer.from(e.name, 'utf8')
    const size = Math.ceil((16 + name.length) / 8) * 8
    const b = Buffer.alloc(size)
    b.writeUInt32LE(e.ino, 0)
    b.writeUInt32LE(e.type, 4)
    b.writeUInt32LE(name.length, 8)
    b.writeUInt32LE(size, 12)
    name.copy(b, 16)
    return b
  })
  return Buffer.concat(parts)
}

interface FsSpec {
  signed: boolean
  /** ino → inode fields; blocks are filled in as data is laid out. */
  inodes: { dir: boolean; data: Buffer }[]
  superroot: number
}

/** A PFS image of `blockSize` blocks: header, the inode table, then every inode's data in order. */
function buildPfs(spec: FsSpec, seed?: Buffer): Buffer {
  const pointer = spec.signed ? 36 : 4
  const inodeSize = 0x64 + 17 * pointer
  const perBlock = Math.floor(B / inodeSize)
  const tableBlocks = Math.ceil(spec.inodes.length / perBlock)
  let next = 1 + tableBlocks
  const placed = spec.inodes.map((n) => {
    const blocks = Math.ceil(n.data.length / B)
    const first = next
    next += blocks
    return { first, blocks }
  })
  const image = Buffer.alloc(next * B)
  image.writeBigUInt64LE(1n, 0)
  image.writeBigUInt64LE(20130315n, 8)
  image.writeUInt16LE(spec.signed ? 0x1 | 0x4 | 0x8 : 0x8, 0x1c)
  image.writeUInt32LE(B, 0x20)
  image.writeBigUInt64LE(BigInt(next), 0x28)
  image.writeBigUInt64LE(BigInt(spec.inodes.length), 0x30)
  image.writeBigUInt64LE(BigInt(spec.superroot), 0x48)
  if (seed) seed.copy(image, 0x370)
  spec.inodes.forEach((n, ino) => {
    const at = (1 + Math.floor(ino / perBlock)) * B + (ino % perBlock) * inodeSize
    image.writeUInt16LE(n.dir ? 0x4000 | 0x16d : 0x8000 | 0x124, at)
    image.writeBigInt64LE(BigInt(n.data.length), at + 8)
    image.writeUInt32LE(placed[ino]!.blocks, at + 0x60)
    for (let i = 0; i < Math.min(12, placed[ino]!.blocks); i++)
      image.writeUInt32LE(placed[ino]!.first + i, at + 0x64 + i * pointer + (spec.signed ? 32 : 0))
    n.data.copy(image, placed[ino]!.first * B)
  })
  return image
}

/** Lay a tree out as a PFS spec: superroot (0) → flat_path_table (1), uroot (2) → the tree. */
function fsSpec(root: Node[], signed: boolean, count: number): FsSpec {
  const inodes: FsSpec['inodes'] = new Array(count)
  const dirData = (self: number, parent: number, children: Node[]): Buffer =>
    dirents([
      { ino: self, type: 4, name: '.' },
      { ino: parent, type: 5, name: '..' },
      ...children.map((c) => ({ ino: c.ino, type: c.dir ? 3 : 2, name: c.name }))
    ])
  inodes[0] = {
    dir: true,
    data: dirents([
      { ino: 1, type: 2, name: 'flat_path_table' },
      { ino: 2, type: 3, name: 'uroot' }
    ])
  }
  inodes[1] = { dir: false, data: Buffer.alloc(16) }
  inodes[2] = { dir: true, data: dirData(2, 0, root) }
  const fill = (nodes: Node[], parent: number): void => {
    for (const n of nodes) {
      if (n.dir) {
        inodes[n.ino] = { dir: true, data: dirData(n.ino, parent, n.children) }
        fill(n.children, n.ino)
      } else inodes[n.ino] = { dir: false, data: n.data! }
    }
  }
  fill(root, 2)
  return { signed, inodes, superroot: 0 }
}

function tree(files: FakePkgFile[]): { root: Node[]; count: number } {
  let ino = 3
  const root: Node[] = []
  for (const f of files) {
    const parts = f.path.split('/')
    let level = root
    parts.forEach((part, i) => {
      const last = i === parts.length - 1
      let node = level.find((n) => n.name === part)
      if (!node) {
        node = {
          ino: ino++,
          name: part,
          dir: !last,
          children: [],
          ...(last ? { data: f.data } : {})
        }
        level.push(node)
      }
      level = node.children
    })
  }
  return { root, count: ino }
}

/** The inner image as PFSC: header, the block offset table, then each block deflated (or stored when that is not smaller). */
function pfsc(inner: Buffer): Buffer {
  const n = inner.length / B
  const blocks: Buffer[] = []
  for (let i = 0; i < n; i++) {
    const raw = inner.subarray(i * B, (i + 1) * B)
    const packed = deflateSync(raw)
    blocks.push(packed.length < B ? packed : raw)
  }
  const tableAt = 0x30
  const dataAt = Math.ceil((tableAt + (n + 1) * 8) / 16) * 16
  const header = Buffer.alloc(dataAt)
  header.writeUInt32LE(0x43534650, 0)
  header.writeUInt32LE(B, 0x0c)
  header.writeBigUInt64LE(BigInt(B), 0x10)
  header.writeBigUInt64LE(BigInt(tableAt), 0x18)
  header.writeBigUInt64LE(BigInt(dataAt), 0x20)
  header.writeBigUInt64LE(BigInt(inner.length), 0x28)
  let at = dataAt
  for (let i = 0; i <= n; i++) {
    header.writeBigUInt64LE(BigInt(at), tableAt + i * 8)
    if (i < n) at += blocks[i]!.length
  }
  return Buffer.concat([header, ...blocks])
}

/** The outer image encrypted as packages are (AES-XTS from the 17th sector; checked against OpenSSL in ps4-pkg.test). */
function encryptOuter(image: Buffer, dataKey: Buffer, tweakKey: Buffer): void {
  xtsSectors({ dataKey, tweakKey }, image, 0, 'encrypt')
}

/** The whole package file. */
export function buildFakePkg(options: FakePkgOptions): Buffer {
  const contentId = options.contentId ?? 'UP0000-CUSA99999_00-PLAYOUTTEST00001'
  const { root, count } = tree(options.files)
  const inner = buildPfs(fsSpec(root, false, count))
  const image = pfsc(inner)
  const seed = randomBytes(16)
  const outer = buildPfs(
    {
      signed: true,
      superroot: 0,
      inodes: [
        {
          dir: true,
          data: dirents([
            { ino: 1, type: 2, name: 'flat_path_table' },
            { ino: 2, type: 3, name: 'uroot' }
          ])
        },
        { dir: false, data: Buffer.alloc(16) },
        {
          dir: true,
          data: dirents([
            { ino: 2, type: 4, name: '.' },
            { ino: 0, type: 5, name: '..' },
            { ino: 3, type: 2, name: 'pfs_image.dat' }
          ])
        },
        { dir: false, data: image }
      ]
    },
    seed
  )
  const ekpfs = randomBytes(32)
  const { dataKey, tweakKey } = pfsKeys(ekpfs, seed)
  encryptOuter(outer, dataKey, tweakKey)

  // The entry table: keys, image key, then the sce_sys files.
  const dk3 = randomBytes(32)
  const sceSys = Object.entries(options.entries ?? {}).map(([id, data]) => ({
    id: Number(id),
    data
  }))
  const ids = [0x10, 0x20, ...sceSys.map((e) => e.id)]
  const tableAt = 0x2000
  const bodyAt = tableAt + 0x1000
  const sizes = new Map<number, number>([
    [0x10, 32 + 7 * 32 + 7 * 256],
    [0x20, 256],
    ...sceSys.map((e) => [e.id, Math.ceil(e.data.length / 16) * 16] as [number, number])
  ])
  const offsets = new Map<number, number>()
  let at = bodyAt
  for (const id of ids) {
    offsets.set(id, at)
    at += Math.ceil(sizes.get(id)! / 16) * 16
  }
  const pfsAt = Math.ceil(at / B) * B
  const records = new Map<number, Buffer>()
  for (const id of ids) {
    const r = Buffer.alloc(32)
    r.writeUInt32BE(id, 0)
    const lockedEntry = options.locked?.includes(id)
    r.writeUInt32BE(lockedEntry ? 0x80000000 : 0, 8)
    r.writeUInt32BE(lockedEntry ? 0x3000 : 0, 12)
    r.writeUInt32BE(offsets.get(id)!, 16)
    const own = sceSys.find((e) => e.id === id)
    r.writeUInt32BE(own ? own.data.length : sizes.get(id)!, 20)
    records.set(id, r)
  }
  const ivKey = (id: number): Buffer =>
    createHash('sha256').update(records.get(id)!).update(dk3).digest()

  const pkg = Buffer.alloc(pfsAt + outer.length)
  pkg.writeUInt32BE(PKG_MAGIC, 0)
  pkg.writeUInt32BE(ids.length, 0x10)
  pkg.writeUInt32BE(tableAt, 0x18)
  pkg.write(contentId, 0x40, 'latin1')
  pkg.writeUInt32BE(0xf, 0x70)
  pkg.writeUInt32BE(0x1a, 0x74)
  pkg.writeBigUInt64BE(BigInt(pfsAt), 0x410)
  pkg.writeBigUInt64BE(BigInt(outer.length), 0x418)
  pkg.writeBigUInt64BE(BigInt(pkg.length), 0x430)
  ids.forEach((id, i) => records.get(id)!.copy(pkg, tableAt + i * 32))

  const keys = Buffer.alloc(sizes.get(0x10)!)
  rsaEncrypt(PKG_DERIVED_KEY3, dk3).copy(keys, 32 + 7 * 32 + 3 * 256)
  keys.copy(pkg, offsets.get(0x10)!)
  const lockedEkpfs = options.retail ? randomBytes(256) : rsaEncrypt(FAKE_KEY, ekpfs)
  aesCbcEncrypt(ivKey(0x20), lockedEkpfs).copy(pkg, offsets.get(0x20)!)
  for (const e of sceSys) {
    const data = options.locked?.includes(e.id) ? aesCbcEncrypt(ivKey(e.id), e.data) : e.data
    data.copy(pkg, offsets.get(e.id)!)
  }
  outer.copy(pkg, pfsAt)
  return pkg
}
