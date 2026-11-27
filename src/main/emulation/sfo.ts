import { promises as fs } from 'fs'

/** A text value of a PARAM.SFO (the PS3's game info file) by key (TITLE_ID, APP_VER, ...); null when absent. */
export function sfoString(data: Buffer, key: string): string | null {
  if (data.length < 20 || data.readUInt32BE(0) !== 0x00505346) return null
  const keyTable = data.readUInt32LE(8)
  const dataTable = data.readUInt32LE(12)
  const count = data.readUInt32LE(16)
  for (let i = 0; i < count && 20 + i * 16 + 16 <= data.length; i++) {
    const at = 20 + i * 16
    const keyStart = keyTable + data.readUInt16LE(at)
    const keyEnd = data.indexOf(0, keyStart)
    if (keyStart >= data.length || keyEnd < 0) return null
    if (data.toString('latin1', keyStart, keyEnd) !== key) continue
    const len = data.readUInt32LE(at + 4)
    const start = dataTable + data.readUInt32LE(at + 12)
    if (start + len > data.length) return null
    return data
      .toString('latin1', start, start + len)
      .replace(/\0+$/, '')
      .trim()
  }
  return null
}

/** A PARAM.SFO file's value of `key` (64 KB at most); null when unreadable or absent. */
export async function sfoFileString(path: string, key: string): Promise<string | null> {
  const data = await readSmall(path, 64 * 1024)
  return data ? sfoString(data, key) : null
}

/** A file of at most `max` bytes, read whole; null when larger, absent or unreadable. */
export async function readSmall(path: string, max: number): Promise<Buffer | null> {
  try {
    const st = await fs.stat(path)
    if (!st.isFile() || st.size > max) return null
    return await fs.readFile(path)
  } catch {
    return null
  }
}
