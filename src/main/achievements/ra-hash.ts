// RetroAchievements identifies a game by the MD5 of its ROM, computed the way rcheevos (rc_hash) does: the whole file
// for most cartridge systems, without the copier / container header for a few, in big-endian order for N64, a
// mix of header and code for Nintendo DS, and the file name for arcade sets. Disc images (PlayStation, Saturn,
// Sega CD, Dreamcast ...) need a CD reader; they are matched by title instead (achievements-service.ts).
import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { createInflateRaw } from 'node:zlib'
import { RA_CONSOLE } from '../../shared/ra-consoles'

export { RA_CONSOLE, raConsoleFor } from '../../shared/ra-consoles'

/** rcheevos hashes at most this much of a file. */
const MAX_HASH_BYTES = 64 * 1024 * 1024
/** A zip larger than this is not opened (cartridge sets are small; this is a disc image or a full romset). */
const MAX_ZIP_BYTES = 256 * 1024 * 1024

/** Consoles whose games are disc images: rc_hash reads their file systems, which this module does not. */
const DISC_CONSOLES = new Set<number>([
  RA_CONSOLE.psx,
  RA_CONSOLE.ps2,
  RA_CONSOLE.psp,
  RA_CONSOLE.saturn,
  RA_CONSOLE.segacd,
  RA_CONSOLE.dreamcast,
  RA_CONSOLE.pcenginecd,
  RA_CONSOLE.threedo,
  RA_CONSOLE.pcfx,
  RA_CONSOLE.neogeocd,
  RA_CONSOLE.gamecube,
  RA_CONSOLE.wii,
  RA_CONSOLE.jaguarcd
])

/** False for the consoles whose ROMs are matched by title only. */
export function canHash(consoleId: number): boolean {
  return !DISC_CONSOLES.has(consoleId)
}

/** Containers and playlists that are not the ROM itself. */
const UNHASHABLE_EXTENSIONS = new Set([
  '.7z',
  '.rar',
  '.m3u',
  '.cue',
  '.chd',
  '.iso',
  '.gdi',
  '.cdi',
  '.ccd',
  '.mds',
  '.pbp',
  '.cso'
])
/** Files in a zip that are never the ROM. */
const ZIP_SKIP_EXTENSIONS = new Set([
  '.txt',
  '.nfo',
  '.diz',
  '.xml',
  '.dat',
  '.jpg',
  '.png',
  '.pdf'
])

/** FBNeo prefixes a non-arcade set's name with its folder ("nes_smb"). */
const ARCADE_FOLDER_PREFIXES = new Set([
  'nes',
  'fds',
  'sms',
  'msx',
  'ngp',
  'pce',
  'chf',
  'sgx',
  'tg16',
  'msx1',
  'neocd',
  'coleco',
  'sg1000',
  'genesis',
  'gamegear',
  'megadriv',
  'pcengine',
  'channelf',
  'spectrum',
  'megadrive',
  'supergrafx',
  'zxspectrum',
  'mastersystem',
  'colecovision'
])

const md5 = (...parts: Buffer[]): string => {
  const hash = createHash('md5')
  for (const p of parts) hash.update(p)
  return hash.digest('hex')
}

/**
 * The RetroAchievements hash of the ROM at `path` for console `consoleId`; null when it cannot be computed here
 * (a disc image, a directory, a 7z, an unreadable file). Zip files of cartridge systems are opened and their ROM
 * hashed, like RetroArch does.
 */
export async function raHashRom(path: string, consoleId: number): Promise<string | null> {
  if (consoleId === RA_CONSOLE.arcade) return arcadeHash(path)
  if (!canHash(consoleId)) return null
  const info = await stat(path)
  if (!info.isFile()) return null
  const ext = extname(path).toLowerCase()
  if (UNHASHABLE_EXTENSIONS.has(ext)) return null
  let data: Buffer | null
  if (ext === '.zip') {
    if (info.size > MAX_ZIP_BYTES) return null
    data = await readZipRom(path)
  } else {
    data = await readHead(path, Math.min(info.size, MAX_HASH_BYTES))
  }
  if (!data || !data.length) return null
  return hashBuffer(data.subarray(0, MAX_HASH_BYTES), consoleId)
}

/** rc_hash's per-console rules for a ROM already in memory. Exported for tests. */
export function hashBuffer(data: Buffer, consoleId: number): string | null {
  switch (consoleId) {
    case RA_CONSOLE.nes:
    case RA_CONSOLE.fds: {
      const magic = data.subarray(0, 4).toString('latin1')
      if (data.length > 16 && (magic === 'NES\x1a' || magic === 'FDS\x1a'))
        return md5(data.subarray(16))
      return md5(data)
    }
    case RA_CONSOLE.snes: {
      // A copier header makes the size 512 bytes more than a multiple of 8 KiB.
      const whole = Math.floor(data.length / 0x2000) * 0x2000
      return md5(data.length - whole === 512 ? data.subarray(512) : data)
    }
    case RA_CONSOLE.lynx:
      if (data.length > 64 && data.subarray(0, 5).toString('latin1') === 'LYNX\0')
        return md5(data.subarray(64))
      return md5(data)
    case RA_CONSOLE.atari7800:
      if (data.length > 128 && data.subarray(1, 10).toString('latin1') === 'ATARI7800')
        return md5(data.subarray(128))
      return md5(data)
    case RA_CONSOLE.pcengine: {
      // As SNES, in 128 KiB units: a header makes the size 512 bytes more than a multiple of 128 KiB.
      const whole = Math.floor(data.length / 0x20000) * 0x20000
      return md5(data.length - whole === 512 ? data.subarray(512) : data)
    }
    case RA_CONSOLE.n64:
      return n64Hash(data)
    case RA_CONSOLE.nds:
      return ndsHash(data)
    default:
      return md5(data)
  }
}

/** N64 dumps come in three byte orders; RetroAchievements hashes the big-endian (.z64) one. */
function n64Hash(data: Buffer): string | null {
  const first = data[0]
  if (first === 0x80 || first === 0xe8 || first === 0x22) return md5(data)
  const copy = Buffer.from(data)
  if (first === 0x37) {
    // .v64: 16-bit words byte-swapped.
    for (let i = 0; i + 1 < copy.length; i += 2) {
      const t = copy[i]
      copy[i] = copy[i + 1]
      copy[i + 1] = t
    }
    return md5(copy)
  }
  if (first === 0x40) {
    // .n64: 32-bit words reversed.
    for (let i = 0; i + 3 < copy.length; i += 4) {
      const a = copy[i]
      const b = copy[i + 1]
      copy[i] = copy[i + 3]
      copy[i + 1] = copy[i + 2]
      copy[i + 2] = b
      copy[i + 3] = a
    }
    return md5(copy)
  }
  return null
}

/** Nintendo DS: the header, the ARM9 and ARM7 code and the icon / title block, in that order. */
function ndsHash(input: Buffer): string | null {
  let data = input
  // A SuperCard dump carries a 512-byte loader in front of the ROM.
  if (
    data.length > 0x200 + 0x160 &&
    data.readUInt32BE(0) === 0x2e0000ea &&
    data.readUInt32BE(0xb0) === 0x44469600
  )
    data = data.subarray(0x200)
  if (data.length < 0x160) return null
  const arm9Offset = data.readUInt32LE(0x20)
  const arm9Size = data.readUInt32LE(0x2c)
  const arm7Offset = data.readUInt32LE(0x30)
  const arm7Size = data.readUInt32LE(0x3c)
  const iconOffset = data.readUInt32LE(0x68)
  if (arm9Size + arm7Size > 16 * 1024 * 1024) return null
  const slice = (offset: number, size: number): Buffer => {
    const out = Buffer.alloc(size)
    if (offset < data.length) data.copy(out, 0, offset, Math.min(data.length, offset + size))
    return out
  }
  return md5(
    data.subarray(0, 0x160),
    slice(arm9Offset, arm9Size),
    slice(arm7Offset, arm7Size),
    slice(iconOffset, 0xa00)
  )
}

/** Arcade: the set's name, not its contents ("galaga.zip" -> md5("galaga")). */
function arcadeHash(path: string): string | null {
  const ext = extname(path)
  const name = basename(path, ext)
  if (!name) return null
  const folder = basename(dirname(path)).toLowerCase()
  return md5(Buffer.from(ARCADE_FOLDER_PREFIXES.has(folder) ? `${folder}_${name}` : name, 'utf8'))
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    let read = 0
    while (read < bytes) {
      const { bytesRead } = await handle.read(buffer, read, bytes - read, read)
      if (!bytesRead) break
      read += bytesRead
    }
    return buffer.subarray(0, read)
  } finally {
    await handle.close()
  }
}

/**
 * The first ROM of a zip (stored or deflated entries; no zip64, no encryption): what RetroArch loads from it.
 * null when the archive holds nothing usable.
 */
export async function readZipRom(path: string): Promise<Buffer | null> {
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    const tailSize = Math.min(size, 0xffff + 22)
    const tail = Buffer.alloc(tailSize)
    await handle.read(tail, 0, tailSize, size - tailSize)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return null
    const entries = tail.readUInt16LE(eocd + 10)
    const dirSize = tail.readUInt32LE(eocd + 12)
    const dirOffset = tail.readUInt32LE(eocd + 16)
    if (dirOffset + dirSize > size) return null
    const dir = Buffer.alloc(dirSize)
    await handle.read(dir, 0, dirSize, dirOffset)
    let at = 0
    for (let n = 0; n < entries && at + 46 <= dir.length; n++) {
      if (dir.readUInt32LE(at) !== 0x02014b50) return null
      const flags = dir.readUInt16LE(at + 8)
      const method = dir.readUInt16LE(at + 10)
      const compressed = dir.readUInt32LE(at + 20)
      const uncompressed = dir.readUInt32LE(at + 24)
      const nameLength = dir.readUInt16LE(at + 28)
      const extraLength = dir.readUInt16LE(at + 30)
      const commentLength = dir.readUInt16LE(at + 32)
      const localOffset = dir.readUInt32LE(at + 42)
      const name = dir.subarray(at + 46, at + 46 + nameLength).toString('utf8')
      at += 46 + nameLength + extraLength + commentLength
      if (name.endsWith('/') || ZIP_SKIP_EXTENSIONS.has(extname(name).toLowerCase())) continue
      if (flags & 1 || (method !== 0 && method !== 8)) return null
      if (uncompressed > MAX_ZIP_BYTES || compressed > MAX_ZIP_BYTES) return null
      const local = Buffer.alloc(30)
      await handle.read(local, 0, 30, localOffset)
      if (local.readUInt32LE(0) !== 0x04034b50) return null
      const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
      if (dataOffset + compressed > size || compressed === 0) return null
      if (method === 0) {
        const raw = Buffer.alloc(Math.min(compressed, MAX_HASH_BYTES))
        await handle.read(raw, 0, raw.length, dataOffset)
        return raw
      }
      return await inflateHead(path, dataOffset, compressed)
    }
    return null
  } finally {
    await handle.close()
  }
}

/**
 * Inflate a deflated zip entry off the main thread's critical path (streamed, async) and stop at MAX_HASH_BYTES,
 * whatever size the archive claims: rcheevos hashes no more than that.
 */
async function inflateHead(path: string, offset: number, length: number): Promise<Buffer> {
  const { createReadStream } = await import('node:fs')
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const input = createReadStream(path, { start: offset, end: offset + length - 1 })
    const inflate = createInflateRaw()
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      input.destroy()
      inflate.destroy()
      if (err) reject(err)
      else resolve(Buffer.concat(chunks, Math.min(total, MAX_HASH_BYTES)))
    }
    inflate.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      if (total >= MAX_HASH_BYTES) finish()
    })
    inflate.on('end', () => finish())
    inflate.on('error', finish)
    input.on('error', finish)
    input.pipe(inflate)
  })
}

/**
 * A title reduced for matching ROM names to RetroAchievements titles: no region / revision tags, no articles,
 * no punctuation, lower case. "Legend of Zelda, The - A Link to the Past (USA)" -> "legend of zelda a link to the past".
 */
export function matchTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
    .replace(/^~[^~]*~\s*/, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/,\s*(the|a|an)\b/g, ' ')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}
