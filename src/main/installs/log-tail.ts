// Byte-offset tail of a client log (GOG's GalaxyClient.log, EA's EADesktopVerbose.log): each read returns the complete
// lines appended since the last one and starts over when the file was rotated or truncated (size shrank). The
// install probes anchor the tail at the file's end before the hand-off (`lookbackBytes: 0` + one read), so old lines
// about the same product (an earlier uninstall, a previous install) never reach the new watch.
import { promises as fs } from 'fs'

export interface LogTail {
  /** New complete lines since the previous call (the first call starts `lookbackBytes` before the end). */
  readNew(): Promise<string[]>
}

export function createLogTail(file: string, options: { lookbackBytes?: number } = {}): LogTail {
  const lookback = options.lookbackBytes ?? 64 * 1024
  let offset: number | null = null
  let partial = ''

  return {
    async readNew(): Promise<string[]> {
      let size: number
      try {
        size = (await fs.stat(file)).size
      } catch {
        offset = null
        partial = ''
        return []
      }
      if (offset === null) offset = Math.max(0, size - lookback)
      if (size < offset) {
        // Rotated or truncated: the new file starts from scratch.
        offset = 0
        partial = ''
      }
      if (size === offset) return []
      let handle: fs.FileHandle
      try {
        handle = await fs.open(file, 'r')
      } catch {
        return []
      }
      try {
        const length = size - offset
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        offset += bytesRead
        const text = partial + buffer.subarray(0, bytesRead).toString('utf8')
        const lines = text.split(/\r?\n/)
        partial = lines.pop() ?? ''
        return lines.filter((l) => l.length > 0)
      } catch {
        return []
      } finally {
        await handle.close().catch(() => undefined)
      }
    }
  }
}
