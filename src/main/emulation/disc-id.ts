import { promises as fs } from 'fs'
import { basename, dirname, extname, resolve } from 'path'
import { inflateRawSync } from 'zlib'
import { sfoString } from './ps3-hdd'
import { parseCueFiles, parseM3u } from './rom-scanner'

/**
 * The ids a ROM game is known by to the emulators' texture packs (and their folders): the serial of a PlayStation,
 * PS2 or PSP disc (SLUS-20777, ULUS-10336), the GameID of a GameCube / Wii disc (GALE01), a 3DS or Switch title id
 * (00040000000EE000, 0100000000010000) or a Dreamcast product number (MK-51058). Read from the file and folder names
 * (any system) and, where it is cheap, from the image itself: an ISO 9660 disc's SYSTEM.CNF boot line (PlayStation,
 * PS2), a PSP disc's UMD_DATA.BIN or PARAM.SFO, a GameCube / Wii disc header (also inside RVZ, WIA, WBFS and CISO),
 * an EBOOT.PBP's PARAM.SFO, a 3DS cartridge header, a Dreamcast IP.BIN. CHDs are read through the Xbox helper's
 * `read` command (CHDSharp), when one is given.
 */

/** What kind of id a system's games carry (and their texture folders are named after). */
export type GameIdKind = 'serial' | 'gamecube' | '3ds' | 'switch' | 'dreamcast'

/** For matching: upper case, without the separators names put in ids (SLUS_207.77, SLUS-20777 → SLUS20777). */
export function normalizeGameId(id: string): string {
  return id.toUpperCase().replace(/[-_. ]/g, '')
}

/** A PlayStation-family serial anywhere in a text: four letters, five digits, separators allowed (SLUS_207.77). */
const SERIAL_IN_NAME = /(?<![A-Z0-9])([SUNBP][A-Z]{3})[-_ .]?(\d{3})[._ ]?(\d{2})(?![0-9])/gi
/** A GameCube / Wii GameID in brackets ([GALE01], (RMGE01)); upper case only, so (Europe) is not one. */
const GAMECUBE_IN_NAME = /[[(]([A-Z][A-Z0-9]{5})[\])]/g
const GAMECUBE_ID = /^[A-Z][A-Z0-9]{5}$/
const N3DS_IN_NAME = /(?<![0-9A-F])(0004[0-9A-F]{12})(?![0-9A-F])/gi
const SWITCH_IN_NAME = /(?<![0-9A-F])(01[0-9A-F]{14})(?![0-9A-F])/gi
const DREAMCAST_IN_NAME = /(?<![A-Z0-9])(MK-?5\d{4}|T-?\d{4,5}[A-Z]?|HDR-?\d{4})(?![0-9])/gi

/** The ids of `kind` in a file or folder name (or any text). */
export function idsFromName(name: string, kind: GameIdKind): string[] {
  const out = new Set<string>()
  switch (kind) {
    case 'serial':
      for (const m of name.matchAll(SERIAL_IN_NAME)) out.add(`${m[1]}-${m[2]}${m[3]}`.toUpperCase())
      break
    case 'gamecube': {
      for (const m of name.matchAll(GAMECUBE_IN_NAME)) out.add(m[1])
      // A dump named after its GameID alone (GALE01.iso).
      const stem = basename(name, extname(name))
      if (GAMECUBE_ID.test(stem) && /\d/.test(stem)) out.add(stem)
      break
    }
    case '3ds':
      for (const m of name.matchAll(N3DS_IN_NAME)) out.add(m[1].toUpperCase())
      break
    case 'switch':
      for (const m of name.matchAll(SWITCH_IN_NAME)) out.add(m[1].toUpperCase())
      break
    case 'dreamcast':
      for (const m of name.matchAll(DREAMCAST_IN_NAME)) out.add(m[1].toUpperCase())
      break
  }
  return [...out]
}

/** The serial a PlayStation / PS2 SYSTEM.CNF boots (BOOT2 = cdrom0:\SLUS_207.77;1 → SLUS-20777); null when none. */
export function serialFromSystemCnf(text: string): string | null {
  const boot = /^\s*BOOT2?\s*=\s*cdrom0?:\\*([^\s;]+)/im.exec(text)
  if (!boot) return null
  const file = boot[1].split(/[\\/]/).pop() ?? ''
  return idsFromName(file, 'serial')[0] ?? null
}

// ---------------------------------------------------------------------------
// Reading images

/** Reads up to `length` bytes at `offset` (fewer at the end of the image). */
export type ReadAt = (offset: number, length: number) => Promise<Buffer>

/** A slice of a CHD's decompressed image, as the Xbox helper's `read` command gives it. */
export interface ChdSlice {
  /** 'cd', 'dvd', 'gd-rom', 'hdd' or 'unknown'. */
  classification: string
  imageBytes: number
  data: Buffer
}

/** Reads a slice of a CHD's decompressed image; null when it cannot (no helper, not a CHD). */
export type ChdReader = (path: string, offset: number, length: number) => Promise<ChdSlice | null>

const SECTOR = 2048
const RAW_SECTOR = 2352
/** A CD CHD's frame: the raw sector and its subcode. */
const CHD_CD_FRAME = 2448
const SYNC = Buffer.from([0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0])
/** Directories and files read from a disc's file system are small; anything bigger is not what we look for. */
const MAX_DIR_BYTES = 256 * 1024
const MAX_FILE_BYTES = 64 * 1024

async function fileReader(path: string): Promise<{ read: ReadAt; close: () => Promise<void> }> {
  const handle = await fs.open(path, 'r')
  return {
    read: async (offset, length) => {
      if (offset < 0 || length <= 0) return Buffer.alloc(0)
      const buf = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buf, 0, length, offset)
      return buf.subarray(0, bytesRead)
    },
    close: () => handle.close().catch(() => {})
  }
}

/** A disc's 2048-byte user data sectors, however the image stores them. */
type SectorRead = (lba: number, count?: number) => Promise<Buffer>

/** Plain 2048-byte sectors (an ISO, a DVD CHD). */
function cookedSectors(read: ReadAt): SectorRead {
  return (lba, count = 1) => read(lba * SECTOR, count * SECTOR)
}

/**
 * Raw CD frames (a .bin's 2352 bytes, a CD CHD's 2448): the user data of each starts after its sync and header (16
 * bytes for Mode 1, 24 for Mode 2 Form 1). A frame without sync holds the 2048 bytes at its start (a CHD's cooked
 * Mode 1 track).
 */
function rawSectors(read: ReadAt, frame: number): SectorRead {
  return async (lba, count = 1) => {
    const parts: Buffer[] = []
    const data = await read(lba * frame, count * frame)
    for (let i = 0; i < count; i++) {
      const f = data.subarray(i * frame, (i + 1) * frame)
      if (f.length < SECTOR) break
      const synced = f.subarray(0, 12).equals(SYNC)
      const at = !synced ? 0 : f[15] === 2 ? 24 : 16
      parts.push(f.subarray(at, at + SECTOR))
    }
    return Buffer.concat(parts)
  }
}

/** The disc's sectors when it holds an ISO 9660 volume (its descriptor at sector 16), cooked or raw; else null. */
async function iso9660Sectors(read: ReadAt, frames: number[]): Promise<SectorRead | null> {
  for (const frame of frames) {
    const sectors = frame === SECTOR ? cookedSectors(read) : rawSectors(read, frame)
    const pvd = await sectors(16)
    if (pvd.length >= 6 && pvd[0] === 1 && pvd.toString('latin1', 1, 6) === 'CD001') return sectors
  }
  return null
}

interface IsoEntry {
  lba: number
  size: number
  dir: boolean
}

async function isoDir(
  sectors: SectorRead,
  lba: number,
  size: number
): Promise<Map<string, IsoEntry>> {
  const out = new Map<string, IsoEntry>()
  const length = Math.min(size, MAX_DIR_BYTES)
  const data = await sectors(lba, Math.ceil(length / SECTOR))
  let at = 0
  while (at < Math.min(length, data.length)) {
    const len = data[at]
    if (len === 0) {
      // Records never cross a sector; the rest of this one is padding.
      at = (Math.floor(at / SECTOR) + 1) * SECTOR
      continue
    }
    if (at + 33 > data.length || len < 34) break
    const nameLen = data[at + 32]
    const name = data
      .toString('latin1', at + 33, at + 33 + nameLen)
      .replace(/;\d+$/, '')
      .toUpperCase()
    if (nameLen > 1 || (data[at + 33] !== 0 && data[at + 33] !== 1))
      out.set(name, {
        lba: data.readUInt32LE(at + 2),
        size: data.readUInt32LE(at + 10),
        dir: (data[at + 25] & 2) !== 0
      })
    at += len
  }
  return out
}

/** A small file of an ISO 9660 disc by its path (`['PSP_GAME', 'PARAM.SFO']`), or null. */
async function isoFile(sectors: SectorRead, path: string[]): Promise<Buffer | null> {
  const pvd = await sectors(16)
  if (pvd.length < 190) return null
  let dir: IsoEntry = {
    lba: pvd.readUInt32LE(156 + 2),
    size: pvd.readUInt32LE(156 + 10),
    dir: true
  }
  for (let i = 0; i < path.length; i++) {
    const entry = (await isoDir(sectors, dir.lba, dir.size)).get(path[i].toUpperCase())
    if (!entry) return null
    if (i < path.length - 1) {
      if (!entry.dir) return null
      dir = entry
      continue
    }
    if (entry.dir || entry.size > MAX_FILE_BYTES) return null
    const data = await sectors(entry.lba, Math.ceil(entry.size / SECTOR))
    return data.subarray(0, entry.size)
  }
  return null
}

/** The PlayStation / PS2 / PSP ids of an ISO 9660 disc. */
async function playStationDiscIds(sectors: SectorRead): Promise<string[]> {
  const ids = new Set<string>()
  const cnf = await isoFile(sectors, ['SYSTEM.CNF'])
  const serial = cnf ? serialFromSystemCnf(cnf.toString('latin1')) : null
  if (serial) ids.add(serial)
  const umd = await isoFile(sectors, ['UMD_DATA.BIN'])
  if (umd) for (const id of idsFromName(umd.toString('latin1').split('|')[0], 'serial')) ids.add(id)
  if (!ids.size) {
    const sfo = await isoFile(sectors, ['PSP_GAME', 'PARAM.SFO'])
    const disc = sfo ? sfoString(sfo, 'DISC_ID') : null
    if (disc) for (const id of idsFromName(disc, 'serial')) ids.add(id)
  }
  return [...ids]
}

/** The GameID in a GameCube / Wii disc header (its magic at 0x1C or 0x18), or null. */
export function gameCubeHeaderId(header: Buffer): string | null {
  if (header.length < 0x20) return null
  const gc = header.readUInt32BE(0x1c) === 0xc2339f3d
  const wii = header.readUInt32BE(0x18) === 0x5d1c9ea3
  if (!gc && !wii) return null
  const id = header.toString('latin1', 0, 6)
  return GAMECUBE_ID.test(id) ? id : null
}

/** The disc header of a GameCube / Wii image: plain (ISO, GCM), RVZ / WIA, WBFS or Dolphin's CISO. */
async function gameCubeImageId(read: ReadAt): Promise<string | null> {
  const head = await read(0, 0xd8)
  if (head.length < 0x20) return null
  const magic = head.toString('latin1', 0, 4)
  if ((magic === 'RVZ\u0001' || magic === 'WIA\u0001') && head.length >= 0x58 + 0x20)
    // Header 1 (0x48 bytes), then header 2: four u32 fields and the disc's first 0x80 bytes.
    return gameCubeHeaderId(head.subarray(0x58))
  if (magic === 'WBFS') {
    // The first disc's header copy is one hard disk sector in; its size is 1 << byte 8.
    const shift = head[8]
    if (shift < 9 || shift > 16) return null
    return gameCubeHeaderId(await read(2 ** shift, 0x20))
  }
  if (magic === 'CISO') {
    // Dolphin's CISO: a 0x8000-byte header (block size, then a used-block map); the used blocks follow in order.
    return head[8] === 1 ? gameCubeHeaderId(await read(0x8000, 0x20)) : null
  }
  return gameCubeHeaderId(head)
}

/** A PSP / PS2 CSO (v1: zlib blocks): its plain image, read through the block index. */
async function csoReader(read: ReadAt): Promise<ReadAt | null> {
  const head = await read(0, 0x18)
  if (head.length < 0x18 || head.toString('latin1', 0, 4) !== 'CISO') return null
  const total = Number(head.readBigUInt64LE(8))
  const blockSize = head.readUInt32LE(16)
  const version = head[20]
  const align = head[21]
  if (version > 1 || blockSize < SECTOR || blockSize > 1 << 20 || !(total > 0)) return null
  const blocks = Math.ceil(total / blockSize)
  const indexAt = async (i: number): Promise<number[]> => {
    const raw = await read(0x18 + i * 4, 8)
    return raw.length < 8 ? [] : [raw.readUInt32LE(0), raw.readUInt32LE(4)]
  }
  const block = async (i: number): Promise<Buffer> => {
    if (i >= blocks) return Buffer.alloc(0)
    const [a, b] = await indexAt(i)
    if (a === undefined) return Buffer.alloc(0)
    const start = (a & 0x7fffffff) * 2 ** align
    const end = (b & 0x7fffffff) * 2 ** align
    const size = Math.min(end - start, blockSize + 1024)
    if (size <= 0) return Buffer.alloc(0)
    const data = await read(start, size)
    if (a & 0x80000000) return data.subarray(0, blockSize)
    try {
      return inflateRawSync(data, { maxOutputLength: blockSize })
    } catch {
      return Buffer.alloc(0)
    }
  }
  return async (offset, length) => {
    const parts: Buffer[] = []
    let at = offset
    const end = Math.min(offset + length, total)
    while (at < end) {
      const i = Math.floor(at / blockSize)
      const data = await block(i)
      if (!data.length) break
      const from = at - i * blockSize
      const piece = data.subarray(from, Math.min(data.length, from + end - at))
      if (!piece.length) break
      parts.push(piece)
      at += piece.length
    }
    return Buffer.concat(parts)
  }
}

/** A CHD read through `readChd` in 256 KB slices (kept), as a plain ReadAt over its decompressed image. */
function chdReadAt(
  path: string,
  readChd: ChdReader,
  state: ReadState
): { read: ReadAt; classification: () => Promise<string | null> } {
  const CHUNK = 256 * 1024
  const chunks = new Map<number, Promise<ChdSlice | null>>()
  const chunk = (i: number): Promise<ChdSlice | null> => {
    let p = chunks.get(i)
    if (!p) {
      // Past the deadline no read starts, and one under way is no longer waited for.
      const read: Promise<ChdSlice | null> = state.signal?.aborted
        ? Promise.resolve(null)
        : untilAborted(
            readChd(path, i * CHUNK, CHUNK).catch(() => null),
            state.signal
          )
      p = read.then((slice) => {
        // No answer (helper missing, stuck, the file locked, the deadline): not the final word on this game.
        if (!slice) state.incomplete = true
        return slice
      })
      chunks.set(i, p)
    }
    return p
  }
  return {
    classification: async () => (await chunk(0))?.classification ?? null,
    read: async (offset, length) => {
      const parts: Buffer[] = []
      let at = offset
      const end = offset + length
      while (at < end) {
        const i = Math.floor(at / CHUNK)
        // 64 slices (16 MB) is far more than a file system lookup needs; past it, the image is not worth reading.
        if (!chunks.has(i) && chunks.size >= 64) break
        const slice = await chunk(i)
        if (!slice) break
        const from = at - i * CHUNK
        const piece = slice.data.subarray(from, Math.min(slice.data.length, from + end - at))
        if (!piece.length) break
        parts.push(piece)
        at += piece.length
      }
      return Buffer.concat(parts)
    }
  }
}

/** The product number in a Dreamcast IP.BIN ("SEGA SEGAKATANA" at its start; the number at 0x40). */
export function dreamcastIpBinId(data: Buffer): string | null {
  for (const at of [0, 16, 24]) {
    if (data.length < at + 0x50) continue
    if (data.toString('latin1', at, at + 15) !== 'SEGA SEGAKATANA') continue
    const id = data
      .toString('latin1', at + 0x40, at + 0x4a)
      .trim()
      .toUpperCase()
    return /^[A-Z0-9][A-Z0-9-]{3,9}$/.test(id) ? id : null
  }
  return null
}

/** The title id in a 3DS cartridge (NCSD: media id at 0x108) or NCCH (program id at 0x118) header. */
export function n3dsHeaderId(head: Buffer): string | null {
  if (head.length < 0x120) return null
  const magic = head.toString('latin1', 0x100, 0x104)
  const at = magic === 'NCSD' ? 0x108 : magic === 'NCCH' ? 0x118 : -1
  if (at < 0) return null
  const id = head.readBigUInt64LE(at).toString(16).toUpperCase().padStart(16, '0')
  return id.startsWith('0004') ? id : null
}

/** Set while reading an image when a read could not be done (a CHD the helper did not answer for). */
interface ReadState {
  incomplete: boolean
  /** The lookup's deadline: once aborted, no further read is made and the result is incomplete. */
  signal?: AbortSignal
}

/** `task`, or null as soon as `signal` aborts (the task itself is left to finish on its own). */
function untilAborted<T>(
  task: Promise<T | null>,
  signal: AbortSignal | undefined
): Promise<T | null> {
  if (!signal) return task
  return new Promise<T | null>((resolve) => {
    const stop = (): void => resolve(null)
    signal.addEventListener('abort', stop, { once: true })
    task.then(
      (v) => {
        signal.removeEventListener('abort', stop)
        resolve(v)
      },
      () => {
        signal.removeEventListener('abort', stop)
        resolve(null)
      }
    )
  })
}

/** The ids the image itself holds (see the top of this file); empty when it holds none we read. */
export async function imageIds(
  path: string,
  kind: GameIdKind,
  readChd?: ChdReader
): Promise<string[]> {
  return (await imageIdsChecked(path, kind, readChd)).ids
}

/**
 * imageIds, and whether every read it needed was answered (false: try again later rather than keep the result). Once
 * `signal` aborts (a deadline), the reads left are skipped and the result, what was read so far, is incomplete.
 */
export async function imageIdsChecked(
  path: string,
  kind: GameIdKind,
  readChd?: ChdReader,
  signal?: AbortSignal
): Promise<{ ids: string[]; complete: boolean }> {
  const state: ReadState = { incomplete: false, ...(signal ? { signal } : {}) }
  const ids = await readImageIds(path, kind, readChd, 0, state)
  return { ids, complete: !state.incomplete }
}

/** The discs of a multi-disc .m3u read for their ids, at most. */
const MAX_M3U_DISCS = 8

async function readImageIds(
  path: string,
  kind: GameIdKind,
  readChd: ChdReader | undefined,
  depth: number,
  state: ReadState
): Promise<string[]> {
  if (state.signal?.aborted) {
    state.incomplete = true
    return []
  }
  const ext = extname(path).toLowerCase()
  // Sheets: the files they list. A .cue's tracks and a .gdi's: the first that gives an id. An .m3u's discs: every
  // disc's ids (a multi-disc game's texture folder may be named after any of its discs).
  if ((ext === '.cue' || ext === '.m3u' || ext === '.gdi') && depth < 2) {
    const st = await fs.stat(path).catch(() => null)
    if (!st?.isFile() || st.size > 256 * 1024) return []
    const text = await fs.readFile(path, 'utf8').catch(() => '')
    const base = dirname(path)
    if (ext === '.m3u') {
      const out = new Set<string>()
      for (const ref of parseM3u(text, base).slice(0, MAX_M3U_DISCS))
        for (const id of await readImageIds(ref, kind, readChd, depth + 1, state)) out.add(id)
      return [...out]
    }
    const refs = ext === '.cue' ? parseCueFiles(text, base) : gdiTracks(text, base)
    for (const ref of refs.slice(0, 8)) {
      const ids = await readImageIds(ref, kind, readChd, depth + 1, state)
      if (ids.length) return ids
    }
    return []
  }

  if (ext === '.chd') {
    if (!readChd) return []
    const chd = chdReadAt(path, readChd, state)
    const classification = await chd.classification()
    if (classification === null) return []
    if (kind === 'serial') {
      // A CD's frames hold the sector and its subcode, a DVD's sectors are plain; a CHD classified neither (an older
      // or unusual one) is tried both ways, as the volume descriptor tells which fits.
      const frames =
        classification === 'cd'
          ? [CHD_CD_FRAME]
          : classification === 'dvd'
            ? [SECTOR]
            : classification === 'gd-rom'
              ? []
              : [SECTOR, CHD_CD_FRAME]
      const sectors = frames.length ? await iso9660Sectors(chd.read, frames) : null
      return sectors ? await playStationDiscIds(sectors) : []
    }
    // The header check validates the disc's magic, so any CHD that is not a CD is worth it.
    if (kind === 'gamecube' && classification !== 'cd' && classification !== 'gd-rom') {
      const id = gameCubeHeaderId(await chd.read(0, 0x20))
      return id ? [id] : []
    }
    return []
  }

  let file: Awaited<ReturnType<typeof fileReader>>
  try {
    const st = await fs.stat(path)
    if (!st.isFile()) return []
    file = await fileReader(path)
  } catch {
    return []
  }
  try {
    switch (kind) {
      case 'serial': {
        if (ext === '.pbp') {
          const head = await file.read(0, 0x28)
          if (head.length < 0x28 || head.toString('latin1', 0, 4) !== '\0PBP') return []
          const from = head.readUInt32LE(8)
          const to = head.readUInt32LE(12)
          if (to <= from || to - from > MAX_FILE_BYTES) return []
          const disc = sfoString(await file.read(from, to - from), 'DISC_ID')
          return disc ? idsFromName(disc, 'serial') : []
        }
        // PSP CSOs are named .cso or .ciso; csoReader checks the CISO header, so anything else reads as a plain image.
        const cso = ext === '.cso' || ext === '.ciso' ? await csoReader(file.read) : null
        const read = cso ?? file.read
        const frames = cso ? [SECTOR] : [SECTOR, RAW_SECTOR]
        const sectors = await iso9660Sectors(read, frames)
        return sectors ? await playStationDiscIds(sectors) : []
      }
      case 'gamecube': {
        const id = await gameCubeImageId(file.read)
        return id ? [id] : []
      }
      case '3ds': {
        const id = n3dsHeaderId(await file.read(0, 0x120))
        return id ? [id] : []
      }
      case 'dreamcast': {
        const id = dreamcastIpBinId(await file.read(0, 0x80))
        return id ? [id] : []
      }
      default:
        return []
    }
  } catch {
    return []
  } finally {
    await file.close()
  }
}

/** The track files of a Dreamcast .gdi, the high-density data track (track 3) first. */
function gdiTracks(text: string, baseDir: string): string[] {
  const tracks: { n: number; file: string }[] = []
  for (const line of text.split(/\r?\n/).slice(1)) {
    const m = /^\s*(\d+)\s+\d+\s+\d+\s+\d+\s+(?:"([^"]+)"|(\S+))/.exec(line)
    if (m) tracks.push({ n: Number(m[1]), file: resolve(baseDir, m[2] ?? m[3]) })
  }
  return [...tracks.filter((t) => t.n === 3), ...tracks.filter((t) => t.n !== 3)].map((t) => t.file)
}

/**
 * Every id of a ROM game: what its image holds (imageIds), then the ids in its file name and its folder's name.
 * Cached per file (path, size, last modified), so a game's set is cheap to build again. A result some read of which
 * went unanswered (the CHD helper missing or stuck) is kept for INCOMPLETE_CACHE_MS only, then read again.
 */
export function createGameIdReader(
  readChd?: ChdReader,
  now: () => number = Date.now
): {
  ids(romPath: string, kind: GameIdKind): Promise<string[]>
  /**
   * ids, and whether the image was read in full. With a `signal` (a deadline), the image reads stop when it aborts:
   * the ids in the file and folder names are always kept, and the incomplete result is cached briefly only.
   */
  idsChecked(
    romPath: string,
    kind: GameIdKind,
    signal?: AbortSignal
  ): Promise<{ ids: string[]; complete: boolean }>
} {
  const cache = new Map<
    string,
    { size: number; mtimeMs: number; ids: string[]; expires: number | null }
  >()
  const reader = {
    async ids(romPath: string, kind: GameIdKind): Promise<string[]> {
      return (await reader.idsChecked(romPath, kind)).ids
    },
    async idsChecked(
      romPath: string,
      kind: GameIdKind,
      signal?: AbortSignal
    ): Promise<{ ids: string[]; complete: boolean }> {
      const st = await fs.stat(romPath).catch(() => null)
      const key = `${kind}|${resolve(romPath).toLowerCase()}`
      const hit = cache.get(key)
      if (
        hit &&
        st &&
        hit.size === st.size &&
        hit.mtimeMs === st.mtimeMs &&
        (hit.expires === null || now() < hit.expires)
      )
        return { ids: hit.ids, complete: hit.expires === null }
      const out = new Set<string>()
      let complete = true
      if (st?.isFile()) {
        const read = await imageIdsChecked(romPath, kind, readChd, signal)
        complete = read.complete
        for (const id of read.ids) out.add(id)
      }
      for (const name of [basename(romPath), basename(dirname(romPath))])
        for (const id of idsFromName(name, kind)) out.add(id)
      const ids = [...out]
      if (st) {
        cache.delete(key)
        if (cache.size >= 2000) cache.delete(cache.keys().next().value as string)
        cache.set(key, {
          size: st.size,
          mtimeMs: st.mtimeMs,
          ids,
          expires: complete ? null : now() + INCOMPLETE_CACHE_MS
        })
      }
      return { ids, complete }
    }
  }
  return reader
}

/** How long a game's ids read without every answer (createGameIdReader) are kept. */
const INCOMPLETE_CACHE_MS = 60_000
