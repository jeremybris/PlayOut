import { promises as fs } from 'fs'
import { join } from 'path'
import { RM_RETRY, renameRetry } from '../util/fs'
import { extractZip } from '../util/zip'
import type { Logger, Runner } from './types'
import { tMain } from '../i18n'

/**
 * Unpacking an emulator download into its folder: zip (PlayOut's own reader, Windows' tar.exe for zip64), 7z (7zr.exe)
 * and 7-Zip self-extracting .exe files; then the archive's single top-level folder is removed.
 */

export type ArchiveKind = 'zip' | '7z' | 'sfx' | 'unknown'

/** 7-Zip and the SFX may take a while on a 500 MB archive behind an antivirus scan. */
const EXTRACT_TIMEOUT_MS = 30 * 60_000

/** The archive's kind, from its first bytes (the file name's extension is not trusted). */
export async function detectArchive(file: string): Promise<ArchiveKind> {
  const handle = await fs.open(file, 'r')
  try {
    const head = Buffer.alloc(6)
    const { bytesRead } = await handle.read(head, 0, 6, 0)
    const b = head.subarray(0, bytesRead)
    if (
      b.length >= 4 &&
      b[0] === 0x50 &&
      b[1] === 0x4b &&
      ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6))
    )
      return 'zip'
    if (b.length >= 6 && b.equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z'
    if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return 'sfx'
    return 'unknown'
  } finally {
    await handle.close()
  }
}

/**
 * While `dir` holds exactly one entry and it is a folder, move that folder's children up into `dir` (an archive's
 * "Dolphin-x64/" or "RetroArch-Win64/" level). A child named like the folder itself is handled. At most `levels`
 * levels (default 2; RetroArch's parts pass 1 so RetroArch_cores.7z keeps its "cores" folder).
 */
export async function flattenSingleRoot(dir: string, levels = 2): Promise<void> {
  for (let level = 0; level < levels; level++) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    if (entries.length !== 1 || !entries[0]!.isDirectory()) return
    const name = entries[0]!.name
    // Renamed aside first, so a child with the same name can move up into its place.
    const aside = join(dir, `${name}.flatten-${process.pid}-${Date.now()}`)
    await renameRetry(join(dir, name), aside)
    for (const child of await fs.readdir(aside))
      await renameRetry(join(aside, child), join(dir, child))
    await fs.rm(aside, RM_RETRY)
  }
}

/** Empties `dir` (a failed attempt's partial output) and recreates it. */
async function resetDir(dir: string): Promise<void> {
  await fs.rm(dir, RM_RETRY)
  await fs.mkdir(dir, { recursive: true })
}

const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(' | ')

/** Windows' bundled bsdtar (it reads zip64, which PlayOut's zip reader does not). */
function windowsTar(): string {
  return join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'tar.exe')
}

async function extractZipFile(
  file: string,
  destDir: string,
  deps: { run: Runner; log: Logger }
): Promise<void> {
  try {
    // listZip already turns backslash names (Azahar's msys2 zip) into '/', so "x\" folder entries are skipped as
    // folders; the map keeps the stored name and safeEntryPath rejects anything leaving destDir.
    await extractZip(file, destDir, (entry) => (/[\\/]$/.test(entry.name) ? null : entry.name))
    return
  } catch (err) {
    deps.log.warn(
      `${file}: built-in unzip failed (${err instanceof Error ? err.message : String(err)}); using tar.exe`
    )
  }
  await resetDir(destDir)
  const result = await deps.run(windowsTar(), ['-xf', file, '-C', destDir], {
    timeoutMs: EXTRACT_TIMEOUT_MS
  })
  if (result.code !== 0)
    throw new Error(
      tMain('mainEmulatorSetup.archive.tarFailed', {
        file,
        code: String(result.code),
        output: tail(result.stderr || result.stdout)
      })
    )
}

/** 7zr.exe x; exit 1 (warnings) is accepted and logged. Returns an error message, or null on success. */
async function sevenZipExtract(
  file: string,
  destDir: string,
  deps: { sevenZip: () => Promise<string>; run: Runner; log: Logger }
): Promise<string | null> {
  try {
    const exe = await deps.sevenZip()
    const result = await deps.run(exe, ['x', '-y', '-bd', `-o${destDir}`, file], {
      timeoutMs: EXTRACT_TIMEOUT_MS
    })
    if (result.code === 0) return null
    if (result.code === 1) {
      deps.log.warn(
        `${file}: 7-Zip finished with warnings: ${tail(result.stderr || result.stdout)}`
      )
      return null
    }
    return `7-Zip exit ${result.code}: ${tail(result.stderr || result.stdout)}`
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/**
 * Unpack `file` (zip, 7z or 7-Zip SFX, recognised by content) into `destDir`, then remove a single top-level folder.
 * `destDir` should be a fresh staging folder: a failed attempt's output is cleared before a fallback runs.
 * `options.flattenLevels` caps how many single top-level folders are removed (default 2, see flattenSingleRoot).
 */
export async function extractArchive(
  file: string,
  destDir: string,
  deps: { sevenZip: () => Promise<string>; run: Runner; log: Logger },
  options: { flattenLevels?: number } = {}
): Promise<void> {
  await fs.mkdir(destDir, { recursive: true })
  const kind = await detectArchive(file)
  switch (kind) {
    case 'zip':
      await extractZipFile(file, destDir, deps)
      break
    case '7z': {
      const failure = await sevenZipExtract(file, destDir, deps)
      if (failure)
        throw new Error(tMain('mainEmulatorSetup.archive.unpackFailed', { file, error: failure }))
      break
    }
    case 'sfx': {
      // A 7-Zip SFX is a 7z archive behind a small exe: 7zr reads it without running anything.
      const failure = await sevenZipExtract(file, destDir, deps)
      if (failure) {
        deps.log.warn(`${file}: 7-Zip could not read the self-extractor (${failure}); running it`)
        await resetDir(destDir)
        const result = await deps.run(file, [`-o${destDir}`, '-y'], {
          timeoutMs: EXTRACT_TIMEOUT_MS
        })
        if (result.code !== 0)
          throw new Error(
            tMain('mainEmulatorSetup.archive.sfxFailed', {
              file,
              code: String(result.code),
              output: tail(result.stderr || result.stdout)
            })
          )
      }
      break
    }
    default:
      throw new Error(tMain('mainEmulatorSetup.archive.notArchive', { file }))
  }
  await flattenSingleRoot(destDir, options.flattenLevels ?? 2)
}
