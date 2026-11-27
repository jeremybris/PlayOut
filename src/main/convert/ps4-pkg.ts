import { createCipheriv, createDecipheriv, createHash, createHmac } from 'crypto'
import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import { basename, dirname, join, normalize, sep } from 'path'
import { inflateRawSync, inflateSync } from 'zlib'
import { FAKE_KEY, PKG_DERIVED_KEY3, type RsaKey } from './ps4-keys'
import { tMain } from '../i18n'

/**
 * PS4 packages (.pkg) unpacked into a game folder, as PS4PKGTool's "Full Extract" does: the game's files from the
 * package's file system image, with the package's own sce_sys files (param.sfo, icon0.png, trophies…) in `sce_sys`.
 * This is PlayOut's own reader of the format (no other program runs). Only fake packages (fPKG, made by homebrew and
 * backup tools) can be opened: their image key is locked with publicly known keys, where a retail package's is locked
 * with Sony's.
 *
 * The layout, in short:
 * - The package header (big-endian) points at the entry table (sce_sys files and keys) and at the PFS image.
 * - Entry 0x10 holds seven RSA-locked keys; the fourth (DK3), opened with the package-derived-key-3 key, unlocks the
 *   image key (entry 0x20, AES-CBC with SHA-256(entry record + DK3)), which the fake key then opens: the EKPFS.
 * - The outer PFS (little-endian) is AES-XTS encrypted in 0x1000-byte sectors after its first 0x10000 bytes, with keys
 *   made from the EKPFS and the image's seed (HMAC-SHA256). Inside it, pfs_image.dat is a PFSC image: the inner PFS
 *   in 0x10000-byte blocks, each zlib-compressed or stored, listed by a table of offsets.
 * - The inner PFS holds the game: inodes from block 1, directories as dirent lists, files in contiguous blocks.
 */

export const PKG_MAGIC = 0x7f434e54
const PFS_MAGIC = 20130315n
const PFSC_MAGIC = 0x43534650 // "PFSC", little-endian
const SECTOR = 0x1000
/** The outer image's first 16 sectors (its header) are not encrypted. */
const CLEAR_SECTORS = 16
const ENTRY_SIZE = 32

const ENTRY_KEYS = 0x10
const IMAGE_KEY = 0x20
const ENTRY_NAMES = 0x200
/** Entries below this are the package's own bookkeeping (digests, keys, names), not sce_sys files. */
const FIRST_SCE_SYS = 0x400

const DIRENT_FILE = 2
const DIRENT_DIR = 3

/** The sce_sys file names of the package entry ids (the PS4 SDK's table; numbered ranges are generated). */
const NAMED_ENTRIES: Record<number, string> = {
  0x400: 'license.dat',
  0x401: 'license.info',
  0x402: 'nptitle.dat',
  0x403: 'npbind.dat',
  0x404: 'selfinfo.dat',
  0x406: 'imageinfo.dat',
  0x407: 'target-deltainfo.dat',
  0x408: 'origin-deltainfo.dat',
  0x409: 'psreserved.dat',
  0x1000: 'param.sfo',
  0x1001: 'playgo-chunk.dat',
  0x1002: 'playgo-chunk.sha',
  0x1003: 'playgo-manifest.xml',
  0x1004: 'pronunciation.xml',
  0x1005: 'pronunciation.sig',
  0x1006: 'pic1.png',
  0x1007: 'pubtoolinfo.dat',
  0x1008: 'app/playgo-chunk.dat',
  0x1009: 'app/playgo-chunk.sha',
  0x100a: 'app/playgo-manifest.xml',
  0x100b: 'shareparam.json',
  0x100c: 'shareoverlayimage.png',
  0x100d: 'save_data.png',
  0x100e: 'shareprivacyguardimage.png',
  0x1200: 'icon0.png',
  0x1220: 'pic0.png',
  0x1240: 'snd0.at9',
  0x1260: 'changeinfo/changeinfo.xml',
  0x1280: 'icon0.dds',
  0x12a0: 'pic0.dds',
  0x12c0: 'pic1.dds'
}

const two = (n: number): string => String(n).padStart(2, '0')
const three = (n: number): string => String(n).padStart(3, '0')

/** The sce_sys path of a package entry id, or null for an id with no known name. */
export function entryName(id: number): string | null {
  const named = NAMED_ENTRIES[id]
  if (named) return named
  const inRange = (start: number, count: number): number | null =>
    id >= start && id < start + count ? id - start : null
  let n: number | null
  if ((n = inRange(0x1201, 31)) !== null) return `icon0_${two(n)}.png`
  if ((n = inRange(0x1241, 31)) !== null) return `pic1_${two(n)}.png`
  if ((n = inRange(0x1261, 31)) !== null) return `changeinfo/changeinfo_${two(n)}.xml`
  if ((n = inRange(0x1281, 31)) !== null) return `icon0_${two(n)}.dds`
  if ((n = inRange(0x12c1, 31)) !== null) return `pic1_${two(n)}.dds`
  if ((n = inRange(0x1400, 100)) !== null) return `trophy/trophy${two(n)}.trp`
  if ((n = inRange(0x1600, 10)) !== null) return `keymap_rp/${three(n + 1)}.png`
  if (id >= 0x1610 && id < 0x1800) {
    const folder = (id - 0x1610) >> 4
    const file = (id - 0x1610) & 0xf
    if (folder <= 30 && file < 10) return `keymap_rp/${two(folder)}/${three(file + 1)}.png`
  }
  return null
}

export interface PkgEntry {
  id: number
  filenameOffset: number
  flags1: number
  flags2: number
  offset: number
  size: number
  /** The entry's 32 bytes as stored (part of its decryption key). */
  record: Buffer
}

export interface PkgHeader {
  contentId: string
  /** CUSA00473: the content id's title part. */
  titleId: string
  drmType: number
  contentType: number
  contentFlags: number
  entryCount: number
  tableOffset: number
  pfsImageOffset: number
  pfsImageSize: number
  pkgSize: number
}

export function parsePkgHeader(b: Buffer): PkgHeader {
  if (b.length < 0x440 || b.readUInt32BE(0) !== PKG_MAGIC)
    throw new PkgError(tMain('mainConvert.pkg.notPs4'))
  const contentId = b.subarray(0x40, 0x64).toString('latin1').replace(/\0.*$/s, '')
  return {
    contentId,
    titleId: contentId.slice(7, 16),
    drmType: b.readUInt32BE(0x70),
    contentType: b.readUInt32BE(0x74),
    contentFlags: b.readUInt32BE(0x78),
    entryCount: b.readUInt32BE(0x10),
    tableOffset: b.readUInt32BE(0x18),
    pfsImageOffset: Number(b.readBigUInt64BE(0x410)),
    pfsImageSize: Number(b.readBigUInt64BE(0x418)),
    pkgSize: Number(b.readBigUInt64BE(0x430))
  }
}

export function parseEntries(table: Buffer, count: number): PkgEntry[] {
  const entries: PkgEntry[] = []
  for (let i = 0; i < count; i++) {
    const at = i * ENTRY_SIZE
    if (at + ENTRY_SIZE > table.length) break
    entries.push({
      id: table.readUInt32BE(at),
      filenameOffset: table.readUInt32BE(at + 4),
      flags1: table.readUInt32BE(at + 8),
      flags2: table.readUInt32BE(at + 12),
      offset: table.readUInt32BE(at + 16),
      size: table.readUInt32BE(at + 20),
      record: Buffer.from(table.subarray(at, at + ENTRY_SIZE))
    })
  }
  return entries
}

/** A package that cannot be unpacked, in words for the user. */
export class PkgError extends Error {}

function bigFromHex(hex: string): bigint {
  return BigInt(`0x${hex}`)
}

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

/**
 * RSA-2048 decryption with PKCS#1 v1.5 padding, by hand: Node refuses PKCS#1 v1.5 private decryption. Null when the
 * padding is wrong: the data was not locked with this key (a retail package).
 */
export function rsaDecrypt(key: RsaKey, cipher: Buffer): Buffer | null {
  const n = bigFromHex(key.modulus)
  const m = modPow(bigFromHex(cipher.toString('hex')), bigFromHex(key.privateExponent), n)
  const plain = Buffer.from(m.toString(16).padStart(512, '0'), 'hex')
  if (plain[0] !== 0 || plain[1] !== 2) return null
  const end = plain.indexOf(0, 2)
  if (end < 10) return null
  return plain.subarray(end + 1)
}

function aesCbcDecrypt(ivKey: Buffer, data: Buffer): Buffer {
  const padded =
    data.length % 16 ? Buffer.concat([data, Buffer.alloc(16 - (data.length % 16))]) : data
  const d = createDecipheriv('aes-128-cbc', ivKey.subarray(16, 32), ivKey.subarray(0, 16))
  d.setAutoPadding(false)
  return Buffer.concat([d.update(padded), d.final()]).subarray(0, data.length)
}

/** SHA-256 of the entry's record and DK3: the IV (first half) and key (second half) of an encrypted entry. */
function entryIvKey(entry: PkgEntry, dk3: Buffer): Buffer {
  return createHash('sha256').update(entry.record).update(dk3).digest()
}

export interface PfsKeys {
  dataKey: Buffer
  tweakKey: Buffer
}

/** The PFS image's XTS keys, from the EKPFS and the image's seed. */
export function pfsKeys(ekpfs: Buffer, seed: Buffer): PfsKeys {
  const index = Buffer.alloc(4)
  index.writeUInt32LE(1)
  const d = createHmac('sha256', ekpfs).update(index).update(seed).digest()
  return { tweakKey: d.subarray(0, 16), dataKey: d.subarray(16, 32) }
}

/**
 * AES-XTS over whole 0x1000-byte sectors, in place (IEEE 1619), built from AES-ECB: Electron's crypto (BoringSSL)
 * has no 'aes-128-xts', only plain Node's (OpenSSL) has. Per sector, the tweak is the sector number (little-endian)
 * encrypted with the tweak key, then multiplied by x in GF(2^128) for each 16-byte block; every block is XORed with
 * its tweak before and after the data key's AES. The tweaks of a sector are laid out once, so each sector takes one
 * AES call for the tweak and one for its 256 blocks.
 */
export function xtsSectors(
  keys: PfsKeys,
  data: Buffer,
  firstSector: number,
  direction: 'decrypt' | 'encrypt'
): void {
  const tweakCipher = createCipheriv('aes-128-ecb', keys.tweakKey, null)
  tweakCipher.setAutoPadding(false)
  const dataCipher =
    direction === 'decrypt'
      ? createDecipheriv('aes-128-ecb', keys.dataKey, null)
      : createCipheriv('aes-128-ecb', keys.dataKey, null)
  dataCipher.setAutoPadding(false)
  const sectorNumber = Buffer.alloc(16)
  const tweaks = Buffer.alloc(SECTOR)
  const t = Buffer.alloc(16)
  for (let at = 0; at + SECTOR <= data.length; at += SECTOR) {
    const sector = firstSector + at / SECTOR
    if (sector < CLEAR_SECTORS) continue
    sectorNumber.fill(0)
    sectorNumber.writeBigUInt64LE(BigInt(sector))
    tweakCipher.update(sectorNumber).copy(t)
    for (let block = 0; block < SECTOR; block += 16) {
      t.copy(tweaks, block)
      // t = t·x in GF(2^128), little-endian, with the polynomial x^128 + x^7 + x^2 + x + 1 (0x87).
      const carry = t[15]! >> 7
      for (let i = 15; i > 0; i--) t[i] = ((t[i]! << 1) | (t[i - 1]! >> 7)) & 0xff
      t[0] = ((t[0]! << 1) & 0xff) ^ (carry ? 0x87 : 0)
    }
    const sectorData = data.subarray(at, at + SECTOR)
    xorInto(sectorData, tweaks)
    const out = dataCipher.update(sectorData)
    xorInto(out, tweaks)
    out.copy(data, at)
  }
}

/** a ^= b (same length). */
function xorInto(a: Buffer, b: Buffer): void {
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0 && a.length % 4 === 0) {
    const x = new Uint32Array(a.buffer, a.byteOffset, a.length / 4)
    const y = new Uint32Array(b.buffer, b.byteOffset, b.length / 4)
    for (let i = 0; i < x.length; i++) x[i]! ^= y[i]!
    return
  }
  for (let i = 0; i < a.length; i++) a[i]! ^= b[i]!
}

/** Decrypt whole sectors in place; `firstSector` is the sector number of `data`'s start in the image. */
export function decryptSectors(keys: PfsKeys, data: Buffer, firstSector: number): void {
  xtsSectors(keys, data, firstSector, 'decrypt')
}

async function readAt(fh: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, offset + got)
    if (!bytesRead) throw new PkgError(tMain('mainConvert.pkg.endsEarly'))
    got += bytesRead
  }
  return buf
}

/** Reads the outer PFS image decrypted, through a window of whole sectors (reads are mostly in order). */
class OuterImage {
  private window: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private windowStart = 0
  constructor(
    private readonly fh: FileHandle,
    private readonly imageOffset: number,
    private readonly imageSize: number,
    private readonly keys: PfsKeys | null,
    private readonly windowSize = 8 * 1024 * 1024
  ) {}

  async read(offset: number, length: number): Promise<Buffer> {
    if (offset < 0 || offset + length > this.imageSize)
      throw new PkgError(tMain('mainConvert.pkg.fsOutsideImage'))
    const inWindow =
      offset >= this.windowStart && offset + length <= this.windowStart + this.window.length
    if (!inWindow) {
      const start = Math.floor(offset / SECTOR) * SECTOR
      const end = Math.min(
        this.imageSize,
        Math.max(start + this.windowSize, Math.ceil((offset + length) / SECTOR) * SECTOR)
      )
      const data = await readAt(this.fh, this.imageOffset + start, end - start)
      if (this.keys) decryptSectors(this.keys, data, start / SECTOR)
      this.window = data
      this.windowStart = start
    }
    const at = offset - this.windowStart
    return this.window.subarray(at, at + length)
  }
}

interface Inode {
  mode: number
  size: number
  blocks: number
  /** The first data block (files and directories are stored in contiguous blocks). */
  first: number
}

interface FsLayout {
  blockSize: number
  inodeSize: number
  /** Offset of the block number in a block pointer (signed images put a 32-byte signature first). */
  pointerAt: number
  is64: boolean
  inodeCount: number
  superroot: number
}

function readLayout(header: Buffer): FsLayout {
  if (header.readBigUInt64LE(8) !== PFS_MAGIC)
    throw new PkgError(tMain('mainConvert.pkg.fsUnreadable'))
  const mode = header.readUInt16LE(0x1c)
  const signed = (mode & 1) !== 0
  const is64 = (mode & 2) !== 0
  const pointer = (signed ? 32 : 0) + (is64 ? 8 : 4)
  return {
    blockSize: header.readUInt32LE(0x20),
    inodeSize: 0x64 + 17 * pointer,
    pointerAt: signed ? 32 : 0,
    is64,
    inodeCount: Number(header.readBigUInt64LE(0x30)),
    superroot: Number(header.readBigUInt64LE(0x48))
  }
}

function parseInode(b: Buffer, layout: FsLayout): Inode {
  const at = 0x64 + layout.pointerAt
  return {
    mode: b.readUInt16LE(0),
    size: Number(b.readBigInt64LE(8)),
    blocks: b.readUInt32LE(0x60),
    first: layout.is64 ? Number(b.readBigUInt64LE(at)) : b.readUInt32LE(at)
  }
}

export interface Dirent {
  ino: number
  type: number
  name: string
}

/** The entries of one directory block (it ends at an empty entry or the block's end). */
export function parseDirents(block: Buffer): Dirent[] {
  const out: Dirent[] = []
  let at = 0
  while (at + 16 <= block.length) {
    const ino = block.readUInt32LE(at)
    const type = block.readUInt32LE(at + 4)
    const nameLength = block.readUInt32LE(at + 8)
    const entSize = block.readUInt32LE(at + 12)
    // A blank entry ends the list (inode 0 alone is not one: ".." of a top folder names the superroot, inode 0).
    if (!type || entSize < 16 || at + 16 + nameLength > block.length) break
    out.push({ ino, type, name: block.subarray(at + 16, at + 16 + nameLength).toString('utf8') })
    at += entSize
  }
  return out
}

/** A PFS read through a block reader: inodes, directories, file contents. */
class PfsReader {
  private readonly inodeCache = new Map<number, Inode>()
  constructor(
    readonly layout: FsLayout,
    private readonly block: (index: number) => Promise<Buffer>
  ) {}

  async inode(ino: number): Promise<Inode> {
    const cached = this.inodeCache.get(ino)
    if (cached) return cached
    if (ino < 0 || ino >= this.layout.inodeCount)
      throw new PkgError(tMain('mainConvert.pkg.fsMissingFile'))
    const perBlock = Math.floor(this.layout.blockSize / this.layout.inodeSize)
    const block = await this.block(1 + Math.floor(ino / perBlock))
    const at = (ino % perBlock) * this.layout.inodeSize
    const inode = parseInode(block.subarray(at, at + this.layout.inodeSize), this.layout)
    this.inodeCache.set(ino, inode)
    return inode
  }

  async list(ino: number): Promise<Dirent[]> {
    const dir = await this.inode(ino)
    const out: Dirent[] = []
    for (let i = 0; i < dir.blocks; i++) out.push(...parseDirents(await this.block(dir.first + i)))
    return out.filter((e) => e.type === DIRENT_FILE || e.type === DIRENT_DIR)
  }

  async find(ino: number, name: string): Promise<Dirent | undefined> {
    return (await this.list(ino)).find((e) => e.name === name)
  }
}

/** One block of the PFSC image: stored, compressed (zlib) or empty, always `blockSize` long. */
export function pfscBlock(raw: Buffer, blockSize: number): Buffer {
  if (raw.length === blockSize) return raw
  if (raw.length === 0) return Buffer.alloc(blockSize)
  if (raw.length > blockSize) throw new PkgError(tMain('mainConvert.pkg.blockTooLarge'))
  let out: Buffer<ArrayBufferLike>
  try {
    out = inflateSync(raw, { maxOutputLength: blockSize })
  } catch {
    try {
      out = inflateRawSync(raw, { maxOutputLength: blockSize })
    } catch {
      throw new PkgError(tMain('mainConvert.pkg.blockDecompress'))
    }
  }
  if (out.length > blockSize) throw new PkgError(tMain('mainConvert.pkg.blockDecompressLarge'))
  return out.length === blockSize ? out : Buffer.concat([out, Buffer.alloc(blockSize - out.length)])
}

/** A path inside the game folder that cannot climb out of it. */
function safeJoin(root: string, ...parts: string[]): string {
  for (const p of parts)
    if (!p || p === '.' || p === '..' || /[\\/:*?"<>|\0]/.test(p))
      throw new PkgError(tMain('mainConvert.pkg.badName', { name: p }))
  const path = normalize(join(root, ...parts))
  if (!path.startsWith(normalize(root) + sep))
    throw new PkgError(tMain('mainConvert.pkg.unsafePath'))
  return path
}

export interface UnpackProgress {
  /** Bytes of game files written so far, of `total`. */
  done: number
  total: number
}

export interface UnpackResult {
  header: PkgHeader
  files: number
  bytes: number
}

export interface UnpackOptions {
  signal?: AbortSignal
  onProgress?: (p: UnpackProgress) => void
}

interface FileJob {
  path: string
  inode: Inode
}

const aborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' })
}

/** The package's keys: DK3 (for encrypted sce_sys entries) and the EKPFS (for its file system). */
async function packageKeys(
  fh: FileHandle,
  entries: PkgEntry[]
): Promise<{ dk3: Buffer; ekpfs: Buffer }> {
  const keysEntry = entries.find((e) => e.id === ENTRY_KEYS)
  const imageEntry = entries.find((e) => e.id === IMAGE_KEY)
  if (!keysEntry || !imageEntry) throw new PkgError(tMain('mainConvert.pkg.noKeys'))
  const keys = await readAt(fh, keysEntry.offset, 32 + 7 * 32 + 7 * 256)
  const dk3 = rsaDecrypt(
    PKG_DERIVED_KEY3,
    keys.subarray(32 + 7 * 32 + 3 * 256, 32 + 7 * 32 + 4 * 256)
  )
  const locked = await readAt(fh, imageEntry.offset, 256)
  const imageKey = dk3 ? aesCbcDecrypt(entryIvKey(imageEntry, dk3.subarray(0, 32)), locked) : null
  const ekpfs = imageKey ? rsaDecrypt(FAKE_KEY, imageKey) : null
  if (!dk3 || !ekpfs || ekpfs.length < 32) throw new PkgError(tMain('mainConvert.pkg.retail'))
  return { dk3: dk3.subarray(0, 32), ekpfs: ekpfs.subarray(0, 32) }
}

/** The package's sce_sys files (param.sfo, icon0.png, trophies…), decrypted where they are locked with DK3. */
async function writeSceSys(
  fh: FileHandle,
  entries: PkgEntry[],
  dk3: Buffer,
  outDir: string
): Promise<number> {
  const namesEntry = entries.find((e) => e.id === ENTRY_NAMES)
  const names = namesEntry ? await readAt(fh, namesEntry.offset, namesEntry.size) : null
  let written = 0
  for (const entry of entries) {
    if (entry.id < FIRST_SCE_SYS) continue
    let name = entryName(entry.id)
    if (!name && names && entry.filenameOffset && entry.filenameOffset < names.length) {
      const end = names.indexOf(0, entry.filenameOffset)
      name = names.subarray(entry.filenameOffset, end < 0 ? undefined : end).toString('utf8')
    }
    if (!name) continue
    let data: Buffer
    if (entry.flags1 & 0x80000000) {
      // Locked entries: only key 3 (DK3) is known; the others (Sony's) stay out. The cipher text fills whole
      // 16-byte blocks (entries are aligned to 16 in the package), past the entry's size.
      if ((entry.flags2 & 0xf000) >> 12 !== 3) continue
      const whole = await readAt(fh, entry.offset, Math.ceil(entry.size / 16) * 16)
      data = aesCbcDecrypt(entryIvKey(entry, dk3), whole).subarray(0, entry.size)
    } else data = await readAt(fh, entry.offset, entry.size)
    const path = safeJoin(join(outDir, 'sce_sys'), ...name.split('/'))
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, data)
    written++
  }
  return written
}

/** The hidden folder a package is unpacked into before it takes its name (the ROM scan skips dot names). */
export function unpackingFolder(outDir: string): string {
  return join(dirname(outDir), `.${basename(outDir)}.unpacking`)
}

/**
 * Unpack the fake PS4 package at `pkgPath` into the game folder `outDir`, which must not exist. Everything is written
 * into a hidden folder beside it (left over by an earlier unpack that PlayOut quit during: emptied first), renamed to
 * `outDir` only once complete, so a half-written folder is never taken for a game or for a finished unpack. Throws
 * PkgError with the reason a package cannot be unpacked, or an AbortError when `signal` stops it; either way nothing
 * of it stays.
 */
export async function unpackPs4Pkg(
  pkgPath: string,
  outDir: string,
  options: UnpackOptions = {}
): Promise<UnpackResult> {
  const work = unpackingFolder(outDir)
  await fs.rm(work, { recursive: true, force: true })
  try {
    const result = await unpackInto(pkgPath, work, options)
    try {
      await fs.rename(work, outDir)
    } catch (err) {
      // Windows refuses to rename onto a folder (EPERM), elsewhere EEXIST/ENOTEMPTY: say why.
      if (
        await fs.stat(outDir).then(
          () => true,
          () => false
        )
      )
        throw new PkgError(tMain('mainConvert.pkg.folderAppeared', { folder: basename(outDir) }))
      throw err
    }
    return result
  } catch (err) {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

async function unpackInto(
  pkgPath: string,
  outDir: string,
  options: UnpackOptions
): Promise<UnpackResult> {
  const { signal, onProgress } = options
  const fh = await fs.open(pkgPath, 'r')
  try {
    const { size: fileSize } = await fh.stat()
    const header = parsePkgHeader(await readAt(fh, 0, Math.min(0x1000, fileSize)))
    if (header.pkgSize > fileSize) throw new PkgError(tMain('mainConvert.pkg.incomplete'))
    if (!header.pfsImageSize || header.pfsImageOffset + header.pfsImageSize > fileSize)
      throw new PkgError(tMain('mainConvert.pkg.noImage'))
    const entries = parseEntries(
      await readAt(fh, header.tableOffset, header.entryCount * ENTRY_SIZE),
      header.entryCount
    )
    const { dk3, ekpfs } = await packageKeys(fh, entries)

    // The outer PFS: its header is in the clear; the rest is encrypted when its mode says so.
    const outerHeader = await readAt(fh, header.pfsImageOffset, 0x400)
    const outerLayout = readLayout(outerHeader)
    const encrypted = (outerHeader.readUInt16LE(0x1c) & 4) !== 0
    const keys = encrypted ? pfsKeys(ekpfs, outerHeader.subarray(0x370, 0x380)) : null
    const outer = new OuterImage(fh, header.pfsImageOffset, header.pfsImageSize, keys)
    const outerFs = new PfsReader(outerLayout, (i) =>
      outer.read(i * outerLayout.blockSize, outerLayout.blockSize)
    )
    const outerRoot = await outerFs.find(outerLayout.superroot, 'uroot')
    const image = outerRoot && (await outerFs.find(outerRoot.ino, 'pfs_image.dat'))
    if (!image) throw new PkgError(tMain('mainConvert.pkg.noImageFile'))
    const imageInode = await outerFs.inode(image.ino)
    const pfscStart = imageInode.first * outerLayout.blockSize
    const pfscHeader = await outer.read(pfscStart, 0x30)
    if (pfscHeader.readUInt32LE(0) !== PFSC_MAGIC)
      throw new PkgError(tMain('mainConvert.pkg.imageDamaged'))
    const blockSize = Number(pfscHeader.readBigUInt64LE(0x10))
    const offsetsAt = Number(pfscHeader.readBigUInt64LE(0x18))
    const dataLength = Number(pfscHeader.readBigUInt64LE(0x28))
    if (!blockSize || blockSize > 0x100000)
      throw new PkgError(tMain('mainConvert.pkg.imageDamaged'))
    const blockCount = Math.ceil(dataLength / blockSize)
    const table = await outer.read(pfscStart + offsetsAt, (blockCount + 1) * 8)
    const offsets = new Float64Array(blockCount + 1)
    for (let i = 0; i <= blockCount; i++) offsets[i] = Number(table.readBigUInt64LE(i * 8))

    const innerBlock = async (i: number): Promise<Buffer> => {
      if (i < 0 || i >= blockCount) throw new PkgError(tMain('mainConvert.pkg.fsOutsideData'))
      const from = offsets[i]!
      const to = offsets[i + 1]!
      if (to < from || to - from > blockSize)
        throw new PkgError(tMain('mainConvert.pkg.imageDamaged'))
      return pfscBlock(await outer.read(pfscStart + from, to - from), blockSize)
    }
    const innerLayout = readLayout(await innerBlock(0))
    if (innerLayout.blockSize !== blockSize) throw new PkgError(tMain('mainConvert.pkg.blockSizes'))
    const inner = new PfsReader(innerLayout, innerBlock)
    const root = await inner.find(innerLayout.superroot, 'uroot')
    if (!root) throw new PkgError(tMain('mainConvert.pkg.noUroot'))

    // Every folder and file first (for the total), then the contents in block order.
    const files: FileJob[] = []
    const folders: string[] = []
    const seen = new Set<number>([root.ino])
    const walk = async (ino: number, path: string): Promise<void> => {
      for (const entry of await inner.list(ino)) {
        aborted(signal)
        if (seen.has(entry.ino)) continue
        seen.add(entry.ino)
        const target = safeJoin(path, entry.name)
        if (entry.type === DIRENT_DIR) {
          folders.push(target)
          await walk(entry.ino, target)
        } else files.push({ path: target, inode: await inner.inode(entry.ino) })
      }
    }
    await walk(root.ino, outDir)
    files.sort((a, b) => a.inode.first - b.inode.first)
    const total = files.reduce((sum, f) => sum + f.inode.size, 0)

    await fs.mkdir(outDir)
    const sceSys = await writeSceSys(fh, entries, dk3, outDir)
    for (const folder of folders) await fs.mkdir(folder, { recursive: true })
    let done = 0
    let lastReport = 0
    for (const file of files) {
      const out = await fs.open(file.path, 'w')
      try {
        let left = file.inode.size
        for (let i = 0; left > 0; i++) {
          aborted(signal)
          if (i >= file.inode.blocks) throw new PkgError(tMain('mainConvert.pkg.fileShort'))
          const block = await innerBlock(file.inode.first + i)
          const take = Math.min(left, blockSize)
          await out.write(block, 0, take)
          left -= take
          done += take
          const now = Date.now()
          if (onProgress && now - lastReport > 250) {
            lastReport = now
            onProgress({ done, total })
          }
        }
      } finally {
        await out.close()
      }
    }
    onProgress?.({ done: total, total })
    return { header, files: files.length + sceSys, bytes: total }
  } finally {
    await fh.close()
  }
}

/** The package's header and title, read without unpacking (null when it is not a PS4 package). */
export async function readPkgHeader(pkgPath: string): Promise<PkgHeader | null> {
  const fh = await fs.open(pkgPath, 'r')
  try {
    return parsePkgHeader(await readAt(fh, 0, 0x1000))
  } catch {
    return null
  } finally {
    await fh.close()
  }
}
