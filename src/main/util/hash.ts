import { createHash } from 'crypto'
import { createReadStream } from 'fs'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32Update(crc: number, chunk: Uint8Array): number {
  let c = crc ^ 0xffffffff
  for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface FileHashes {
  size: number
  crc32: string
  md5: string
  sha1: string
}

/** Stream a file once and compute size, CRC32, MD5 and SHA-1 (all lower-case hex, CRC zero-padded to 8). */
export async function hashFile(
  path: string,
  options: { maxBytes?: number } = {}
): Promise<FileHashes | null> {
  return new Promise((resolve) => {
    const md5 = createHash('md5')
    const sha1 = createHash('sha1')
    let crc = 0
    let size = 0
    let aborted = false
    const stream = createReadStream(path)
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buf.length
      if (options.maxBytes && size > options.maxBytes) {
        aborted = true
        stream.destroy()
        return
      }
      md5.update(buf)
      sha1.update(buf)
      crc = crc32Update(crc, buf)
    })
    stream.on('error', () => resolve(null))
    stream.on('close', () => {
      if (aborted) return resolve(null)
      resolve({
        size,
        crc32: crc.toString(16).padStart(8, '0'),
        md5: md5.digest('hex'),
        sha1: sha1.digest('hex')
      })
    })
  })
}

export function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex')
}
