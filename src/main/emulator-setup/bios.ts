import { promises as fs, type Dirent } from 'fs'
import { basename, join, relative } from 'path'
import { extractZipEntry, listZip, type ZipEntry } from '../util/zip'
import { setIniValues } from './ini'
import type { Logger, Runner } from './types'
import { tMain } from '../i18n'

/** What the BIOS sync needs: where each installed emulator lives and the data Emulation folder. */
export interface BiosContext {
  /** The emulator's folder (<root>\<folder>), or null when it is not installed (its sync is skipped). */
  emuDirOf(id: string): string | null
  /** The data Emulation folder D (its bios\ folder holds the user's files). */
  dataDir: string
  run: Runner
  log: Logger
}

const RPCS3_INSTALL_TIMEOUT_MS = 10 * 60 * 1000

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile()
  } catch {
    return false
  }
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** True when the two files have the same content. */
async function sameContent(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)])
    if (sa.size !== sb.size) return false
    const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)])
    return ba.equals(bb)
  } catch {
    return false
  }
}

/**
 * Link the user's BIOS files into the emulators that need them copied or installed (RPCS3 firmware, Ryujinx keys and
 * firmware, Dolphin IPL, mGBA BIOS keys). Idempotent; each emulator's sync is independent. Absent BIOS files are
 * normal and silent. Returns short user-facing notices for what failed.
 */
export async function syncBios(ctx: BiosContext): Promise<string[]> {
  const notices: string[] = []
  const steps: [string, string, (emuDir: string) => Promise<string | null>][] = [
    ['RPCS3', 'RPCS3', (e) => syncRpcs3(e, ctx)],
    ['RYUJINX', 'Ryujinx', (e) => syncRyujinxKeys(e, ctx)],
    ['RYUJINX', 'Ryujinx', (e) => syncRyujinxFirmware(e, ctx)],
    ['DOLPHIN', 'Dolphin', (e) => syncDolphinIpl(e, ctx)],
    ['MGBA', 'mGBA', (e) => syncMgba(e, ctx)]
  ]
  for (const [id, name, step] of steps) {
    const emuDir = ctx.emuDirOf(id)
    if (!emuDir) continue
    try {
      const notice = await step(emuDir)
      if (notice) notices.push(notice)
    } catch (err) {
      ctx.log.warn(`BIOS sync for ${name} failed: ${(err as Error).message}`)
      notices.push(
        tMain('mainEmulatorSetup.bios.failed', { emulator: name, error: (err as Error).message })
      )
    }
  }
  return notices
}

/** D-relative path for notices, e.g. bios\PS3UPDAT.PUP. */
function shown(ctx: BiosContext, path: string): string {
  return relative(ctx.dataDir, path) || path
}

/** RPCS3: install PS3UPDAT.PUP when the firmware (dev_flash\vsh\module\vsh.self) is missing. */
async function syncRpcs3(emuDir: string, ctx: BiosContext): Promise<string | null> {
  const bios = join(ctx.dataDir, 'bios')
  let pup: string | null = null
  for (const candidate of [join(bios, 'PS3UPDAT.PUP'), join(bios, 'ps3', 'PS3UPDAT.PUP')])
    if (await isFile(candidate)) {
      pup = candidate
      break
    }
  if (!pup) return null
  const vsh = join(emuDir, 'dev_flash', 'vsh', 'module', 'vsh.self')
  if (await exists(vsh)) return null
  ctx.log.info(`installing the PS3 firmware from ${pup}`)
  const result = await ctx.run(join(emuDir, 'rpcs3.exe'), ['--headless', '--installfw', pup], {
    cwd: emuDir,
    timeoutMs: RPCS3_INSTALL_TIMEOUT_MS
  })
  if (await exists(vsh)) return null
  ctx.log.warn(
    `RPCS3 firmware install failed (code ${result.code}): ${result.stderr.slice(0, 500)}`
  )
  return tMain('mainEmulatorSetup.bios.ps3Firmware', { file: shown(ctx, pup) })
}

const SWITCH_KEY_DIRS = [
  ['ryujinx', 'keys'],
  ['switch'],
  ['yuzu', 'keys'],
  ['eden', 'keys'],
  ['citron', 'keys'],
  []
]

/** Ryujinx: copy prod.keys and title.keys into portable\system when missing there or different. */
async function syncRyujinxKeys(emuDir: string, ctx: BiosContext): Promise<string | null> {
  const bios = join(ctx.dataDir, 'bios')
  let source: string | null = null
  for (const parts of SWITCH_KEY_DIRS) {
    const dir = join(bios, ...parts)
    if (await isFile(join(dir, 'prod.keys'))) {
      source = dir
      break
    }
  }
  if (!source) return null
  const system = join(emuDir, 'portable', 'system')
  try {
    await fs.mkdir(system, { recursive: true })
    for (const name of ['prod.keys', 'title.keys']) {
      const from = join(source, name)
      if (!(await isFile(from))) continue
      const to = join(system, name)
      if (await sameContent(from, to)) continue
      await fs.copyFile(from, to)
      ctx.log.info(`copied ${from} to ${to}`)
    }
  } catch (err) {
    ctx.log.warn(`Ryujinx keys copy failed: ${(err as Error).message}`)
    return tMain('mainEmulatorSetup.bios.switchKeys', { file: shown(ctx, source) })
  }
  return null
}

const SWITCH_FIRMWARE_DIRS = [
  ['ryujinx', 'firmware'],
  ['switch', 'firmware'],
  ['yuzu', 'firmware'],
  ['eden', 'firmware'],
  ['citron', 'firmware']
]

/** One firmware file to install: its NCA id and how to write it. */
interface NcaSource {
  id: string
  write(target: string): Promise<void>
}

/** The NCA id: the file name up to its first '.' (0100...nca, abcd.cnmt.nca). */
function ncaId(name: string): string {
  const dot = name.indexOf('.')
  return dot < 0 ? name : name.slice(0, dot)
}

/**
 * The NCAs a firmware folder holds: loose *.nca files (or the installed layout <id>.nca\00), or else the first .zip
 * in it that holds *.nca entries. Empty when the folder has none.
 */
async function firmwareSources(dir: string, ctx: BiosContext): Promise<NcaSource[]> {
  const entries = await readDirSafe(dir)
  const loose: NcaSource[] = []
  for (const entry of entries) {
    if (!/\.nca$/i.test(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isFile()) {
      loose.push({ id: ncaId(entry.name), write: (target) => fs.copyFile(full, target) })
    } else if (entry.isDirectory() && (await isFile(join(full, '00')))) {
      loose.push({
        id: ncaId(entry.name),
        write: (target) => fs.copyFile(join(full, '00'), target)
      })
    }
  }
  if (loose.length) return loose
  for (const entry of entries) {
    if (!entry.isFile() || !/\.zip$/i.test(entry.name)) continue
    const zip = join(dir, entry.name)
    let list: ZipEntry[]
    try {
      list = await listZip(zip)
    } catch (err) {
      ctx.log.warn(`skipping ${zip}: ${(err as Error).message}`)
      continue
    }
    const ncas = list.filter((e) => !e.name.endsWith('/') && /\.nca$/i.test(e.name))
    if (ncas.length)
      return ncas.map((e) => ({
        id: ncaId(basename(e.name)),
        write: (target) => extractZipEntry(zip, e, target)
      }))
  }
  return []
}

/**
 * Ryujinx: install the Switch firmware into portable\bis\system\Contents\registered (each NCA as <id>.nca\00) when
 * that folder is missing or empty. Staged in registered.playout-tmp and renamed into place; a non-empty registered
 * folder is never touched.
 */
async function syncRyujinxFirmware(emuDir: string, ctx: BiosContext): Promise<string | null> {
  const contents = join(emuDir, 'portable', 'bis', 'system', 'Contents')
  const registered = join(contents, 'registered')
  if ((await readDirSafe(registered)).length) return null
  const bios = join(ctx.dataDir, 'bios')
  let sourceDir: string | null = null
  let sources: NcaSource[] = []
  for (const parts of SWITCH_FIRMWARE_DIRS) {
    const dir = join(bios, ...parts)
    sources = await firmwareSources(dir, ctx)
    if (sources.length) {
      sourceDir = dir
      break
    }
  }
  if (!sourceDir) return null
  const staging = join(contents, 'registered.playout-tmp')
  try {
    await fs.rm(staging, { recursive: true, force: true })
    await fs.mkdir(staging, { recursive: true })
    for (const source of sources) {
      const folder = join(staging, `${source.id}.nca`)
      await fs.mkdir(folder, { recursive: true })
      await source.write(join(folder, '00'))
    }
    // Re-check: never replace a registered folder that filled up meanwhile.
    if ((await readDirSafe(registered)).length) {
      await fs.rm(staging, { recursive: true, force: true })
      return null
    }
    await fs.rm(registered, { recursive: true, force: true })
    await fs.rename(staging, registered)
    ctx.log.info(`installed ${sources.length} firmware files from ${sourceDir}`)
    return null
  } catch (err) {
    ctx.log.warn(`Ryujinx firmware install failed: ${(err as Error).message}`)
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    return tMain('mainEmulatorSetup.bios.switchFirmware', { folder: shown(ctx, sourceDir) })
  }
}

const GC_REGIONS = ['USA', 'EUR', 'JAP']

/** Dolphin: copy bios\GC\<region>\IPL.bin to User\GC\<region>\IPL.bin when missing there. */
async function syncDolphinIpl(emuDir: string, ctx: BiosContext): Promise<string | null> {
  const bios = join(ctx.dataDir, 'bios')
  const failed: string[] = []
  for (const region of GC_REGIONS) {
    let from: string | null = null
    for (const gc of ['GC', 'gc'])
      if (await isFile(join(bios, gc, region, 'IPL.bin'))) {
        from = join(bios, gc, region, 'IPL.bin')
        break
      }
    if (!from) continue
    const to = join(emuDir, 'User', 'GC', region, 'IPL.bin')
    if (await exists(to)) continue
    try {
      await fs.mkdir(join(emuDir, 'User', 'GC', region), { recursive: true })
      await fs.copyFile(from, to)
      ctx.log.info(`copied ${from} to ${to}`)
    } catch (err) {
      ctx.log.warn(`Dolphin IPL copy failed: ${(err as Error).message}`)
      failed.push(region)
    }
  }
  return failed.length
    ? tMain('mainEmulatorSetup.bios.gamecubeIpl', { regions: failed.join(', ') })
    : null
}

const MGBA_BIOS: [string, string][] = [
  ['gba.bios', 'gba_bios.bin'],
  ['gb.bios', 'gb_bios.bin'],
  ['gbc.bios', 'gbc_bios.bin'],
  ['sgb.bios', 'sgb_bios.bin']
]

/** mGBA: point [ports.qt] gba.bios/gb.bios/gbc.bios/sgb.bios at the BIOS files that exist in D\bios. */
async function syncMgba(emuDir: string, ctx: BiosContext): Promise<string | null> {
  const bios = join(ctx.dataDir, 'bios')
  const values: Record<string, string> = {}
  for (const [key, file] of MGBA_BIOS)
    if (await isFile(join(bios, file))) values[key] = join(bios, file)
  if (!Object.keys(values).length) return null
  try {
    await setIniValues(join(emuDir, 'config.ini'), 'ports.qt', values, { style: 'tight' })
  } catch (err) {
    ctx.log.warn(`mGBA BIOS keys failed: ${(err as Error).message}`)
    return tMain('mainEmulatorSetup.bios.mgba')
  }
  return null
}
