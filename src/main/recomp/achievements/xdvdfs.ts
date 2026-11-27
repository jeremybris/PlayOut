// Reading one file from the root folder of an Xbox / Xbox 360 disc image (the XDVDFS file system of an XISO or a
// full retail image), written for PlayOut from the format's public description: enough to take default.xex out of the
// player's own disc image without unpacking it.
import { open, type FileHandle } from 'node:fs/promises'

const SECTOR = 2048
const MAGIC = 'MICROSOFT*XBOX*MEDIA'
/** Where the game partition starts: a rebuilt XISO, then full XGD3, XGD2 and XGD1 images. */
const PARTITIONS = [0, 0x2080000, 0xfd90000, 0x18300000]
/** Folders bigger than this are not read (a root folder is a few kilobytes). */
const MAX_DIR = 4 * 1024 * 1024
/** Files bigger than this are not read. */
const MAX_FILE = 96 * 1024 * 1024

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fh.read(buf, 0, length, position)
  return buf.subarray(0, bytesRead)
}

/** Find `name` (any case) in a folder table: a binary tree of entries, walked whole. */
function findInDir(table: Buffer, name: string): { sector: number; size: number } | null {
  const want = name.toLowerCase()
  const seen = new Set<number>()
  const stack = [0]
  while (stack.length) {
    const at = stack.pop()!
    if (seen.has(at) || at + 14 > table.length) continue
    seen.add(at)
    const left = table.readUInt16LE(at)
    const right = table.readUInt16LE(at + 2)
    if (left === 0xffff && right === 0xffff) continue
    const sector = table.readUInt32LE(at + 4)
    const size = table.readUInt32LE(at + 8)
    const attrs = table[at + 12]!
    const length = table[at + 13]!
    if (at + 14 + length > table.length) continue
    const entry = table.toString('latin1', at + 14, at + 14 + length)
    if (entry.toLowerCase() === want && !(attrs & 0x10)) return { sector, size }
    if (left && left !== 0xffff) stack.push(left * 4)
    if (right && right !== 0xffff) stack.push(right * 4)
  }
  return null
}

/** A file in the image's root folder (e.g. "default.xex"), or null when the image has none or is not XDVDFS. */
export async function readXdvdfsRootFile(image: string, name: string): Promise<Buffer | null> {
  const fh = await open(image, 'r')
  try {
    for (const base of PARTITIONS) {
      const vd = await readAt(fh, base + 32 * SECTOR, 32)
      if (vd.length < 28 || vd.toString('latin1', 0, 20) !== MAGIC) continue
      const rootSector = vd.readUInt32LE(20)
      const rootSize = vd.readUInt32LE(24)
      if (!rootSize || rootSize > MAX_DIR) return null
      const table = await readAt(fh, base + rootSector * SECTOR, rootSize)
      const hit = findInDir(table, name)
      if (!hit || hit.size > MAX_FILE) return null
      const data = await readAt(fh, base + hit.sector * SECTOR, hit.size)
      return data.length === hit.size ? data : null
    }
    return null
  } finally {
    await fh.close()
  }
}
