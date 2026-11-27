import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { pathExists } from '../util/fs'
import { downloadFile, type HttpDeps } from './download'
import type { ResolvedDownload } from './types'

/**
 * 7-Zip's standalone console extractor (7zr.exe: 7z archives only, LGPL), pinned by version, size and SHA-256 and
 * downloaded once on demand: most emulators ship as .7z.
 */
export const SEVEN_ZIP: ResolvedDownload = {
  version: '26.06',
  url: 'https://github.com/ip7z/7zip/releases/download/26.06/7zr.exe',
  fileName: '7zr.exe',
  size: 600064,
  sha256: 'e80db2dad715a6c5adabe292d31ed54e11f4e9b99ca349827b50573b175891bc'
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

const inFlight = new Map<string, Promise<string>>()

/**
 * The path of 7zr.exe in `workDir`, downloading it first when it is missing or not the pinned file. Concurrent calls
 * for the same folder share one download.
 */
export function ensureSevenZip(workDir: string, deps: HttpDeps): Promise<string> {
  const exe = join(workDir, SEVEN_ZIP.fileName)
  const key = exe.toLowerCase()
  const running = inFlight.get(key)
  if (running) return running
  const job = (async () => {
    if ((await pathExists(exe)) && (await sha256Of(exe).catch(() => '')) === SEVEN_ZIP.sha256)
      return exe
    deps.log.info(`downloading 7-Zip ${SEVEN_ZIP.version} (7zr.exe)`)
    return downloadFile(SEVEN_ZIP, workDir, deps)
  })().finally(() => inFlight.delete(key))
  inFlight.set(key, job)
  return job
}
