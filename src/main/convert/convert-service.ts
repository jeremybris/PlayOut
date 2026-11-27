import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { basename, dirname, extname, isAbsolute, join, relative } from 'path'
import {
  convertPair,
  directionFormats,
  type ConvertDirection,
  type ConvertFormat,
  type ConvertItem,
  type ConvertMissing,
  type ConvertNeed,
  type ConvertRequest,
  type ConvertStatus,
  type XboxCommand
} from '../../shared/convert'
import type { Game } from '../../shared/types'
import type { Logger } from '../logger'
import { gameFolderExecutableFile, ps3FolderKind, romGameFolder } from '../emulation/rom-scanner'
import { isHeldDirName } from '../services/held-files'
import { isFile } from '../util/fs'
import { makeGameId } from '../util/ids'
import {
  ensureConverter,
  installedConverter,
  MIN_CONVERTER_VERSION,
  versionAtLeast,
  type ConverterInstall
} from './converter-tool'
import { findTools, missingFor, needPlace, toolArgs, type ConvertTools } from './requirements'
import { PkgError, unpackPs4Pkg, type UnpackOptions, type UnpackResult } from './ps4-pkg'
import { m3uFiles, sourceFiles } from './sources'
import { godGames, godPackagesIn } from './god'
import {
  PARTIAL_MARKER,
  helperOutput,
  helperPresent,
  parseHelperLine,
  spawnHelper,
  type HelperRun
} from './xbox-helper'
import { tMain } from '../i18n'

/**
 * Settings › Convert's runs: each picked file (or folder) through the direction's converter targets, one file at a
 * time (or all together, for packages the converter combines with their updates). A result is written next to the
 * original; only a complete result the converter verified sends the original and the files it needs to the Recycle
 * Bin, and moves the game's library record (play time, sessions, art) to the new file. A two-step direction goes
 * through a temporary file in the work folder.
 */

export interface ConvertServiceDeps {
  /** Where the converter is downloaded to (`<userData>\tools\game-format-converter`). */
  toolRoot: string
  /** Temporary files of two-step directions (`<userData>\tools\convert-work`). */
  workDir: string
  emulationDir: () => string
  emulatorPath: (id: string) => Promise<string | null>
  library: {
    games(): Game[]
    rekeyRom(
      fromId: string,
      externalId: string,
      romPath: string,
      mediaUrl?: (url: string) => string
    ): string | null
  }
  /** A ROM system's file and folder extensions (lowercase, with the dot), null for an unknown system. */
  romExtensions: (systemId: string) => string[] | null
  imageCache: { moveGame(fromId: string, toId: string): Promise<(url: string) => string> }
  /** Send a file or folder to the Recycle Bin. */
  trash: (path: string) => Promise<void>
  /** Rescan the ROM folder (the converted games' new files). */
  rescanRoms: () => Promise<void>
  emit: (status: ConvertStatus) => void
  log: Logger
  /** Tests: run the converter, telling each line it prints; resolves to its exit code. */
  run?: (
    exe: string,
    args: string[],
    onLine: (line: string) => void,
    signal: AbortSignal
  ) => Promise<number>
  /** Tests. */
  ensure?: () => Promise<ConverterInstall>
  /** Tests: unpack a PS4 package (PlayOut's own unpacker otherwise). */
  unpackPs4?: (pkg: string, outDir: string, options: UnpackOptions) => Promise<UnpackResult>
  /** The Xbox image helper (`resources\xbox\PlayOutXbox.exe`), which runs every Xbox / Xbox 360 direction. */
  xboxHelper?: string
  /** Tests: run the Xbox helper (spawned otherwise). */
  runHelper?: HelperRun
  /**
   * The PS5 package helper (`resources\ps5pkg\PlayOutPs5Pkg.exe`, ps5pkg-helper/: PS5PKGTool's extraction), which
   * unpacks fake PS5 packages. It is run with `runHelper` too (same one-JSON-object-per-line output).
   */
  ps5Helper?: string
}

export interface ConvertService {
  status(): Promise<ConvertStatus>
  /** What the direction needs that this PC lacks (keys, emulators), each with where it goes. */
  check(request: Omit<ConvertRequest, 'paths'>): Promise<ConvertMissing[]>
  /** The folder a missing key goes in, made when it is not there yet. */
  placeFolder(need: ConvertNeed): Promise<string>
  /** Start converting (progress on 'convert:progress'); rejects while a run is going or when something blocks it. */
  start(request: ConvertRequest): Promise<ConvertStatus>
  /**
   * Stop the run: the file being converted is left as it was, and what was written of its result is removed. Resolves
   * once the run has ended and cleaned up (at once when nothing runs).
   */
  stop(): Promise<void>
  /** PlayOut is closing: what runs stops (as stop()), and no conversion starts any more (start() rejects). */
  close(): Promise<void>
}

type Verdict = { state: 'done' | 'failed' | 'skipped'; detail: string }

/** "OK   Game.iso: …", "FAIL Game.iso: …", "SKIP Game.iso: …": the converter's verdict, with the input it names. */
export function readVerdict(line: string): (Verdict & { name: string }) | null {
  const m = /^(OK|FAIL|SKIP)\s+(.+?):\s*(.*)$/.exec(line.trim())
  if (!m) return null
  return {
    name: m[2]!,
    state: m[1] === 'OK' ? 'done' : m[1] === 'FAIL' ? 'failed' : 'skipped',
    detail: m[3]!.trim()
  }
}

/** The verdict on the input named `name`, if the line is one. */
export function parseVerdict(line: string, name: string): Verdict | null {
  const v = readVerdict(line)
  if (!v || v.name !== name) return null
  return { state: v.state, detail: v.detail }
}

/** The converter refused the target for this file ("can't become 'cue' (it can become: …)"): try the next one. */
function refusedTarget(v: Verdict): boolean {
  return v.state === 'failed' && /can't become '/.test(v.detail)
}

/** An OK that did not make everything: some results were already there (the converter keeps its sources then). */
function partlyExisting(detail: string): boolean {
  return /already existed/i.test(detail)
}

const ABORTED = 130

function defaultRun(
  exe: string,
  args: string[],
  onLine: (line: string) => void,
  signal: AbortSignal
): Promise<number> {
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, cwd: dirname(exe) })
    let buffered = ''
    const take = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8')
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onLine(line)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const abort = (): void => {
      // The converter is a packed program that runs a child of its own: the whole tree goes.
      if (child.pid)
        spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }).on(
          'error',
          () => child.kill()
        )
      else child.kill()
    }
    signal.addEventListener('abort', abort, { once: true })
    child.on('error', (err) => {
      signal.removeEventListener('abort', abort)
      reject(err)
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (buffered.trim()) onLine(buffered)
      resolve(code ?? 1)
    })
  })
}

/**
 * The entries of `dir`, without a recompilation's hidden holding folder (.playout-held): a disc image moved aside
 * while a conversion runs in the same folder is never taken for this run's output, nor removed with it.
 */
async function listNames(dir: string): Promise<Set<string>> {
  try {
    return new Set((await fs.readdir(dir)).filter((name) => !isHeldDirName(name)))
  } catch {
    return new Set()
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  return fs.access(path).then(
    () => true,
    () => false
  )
}

/** Remove what a stopped or refused run wrote (the entries of `dir` that were not in `before`). */
export async function removeNew(dir: string, before: Set<string>): Promise<void> {
  for (const name of await listNames(dir))
    if (!before.has(name) && !isHeldDirName(name))
      await fs.rm(join(dir, name), { recursive: true, force: true }).catch(() => {})
}

/**
 * Of the new entries in `dir`, the converted game itself: one of the target format's files (or a folder for a folder
 * format). The converter writes some results into a folder of their own (`Game\Game.cue` with its BINs): those files
 * move up next to the original when nothing there has their names, so the result sits where the original was.
 */
export async function primaryOutput(
  dir: string,
  made: string[],
  format: ConvertFormat
): Promise<string | undefined> {
  const matches = (name: string): boolean => format.exts.includes(extname(name).toLowerCase())
  made = made.filter((name) => !isHeldDirName(name))
  for (const name of made) {
    const path = join(dir, name)
    const folder = await isDirectory(path)
    if (format.folder ? folder : !folder && matches(name)) return path
  }
  if (format.folder) return undefined
  for (const name of made) {
    const sub = join(dir, name)
    if (!(await isDirectory(sub))) continue
    const inside = await fs.readdir(sub)
    const game = inside.find(matches)
    if (!game) continue
    const taken = await Promise.all(inside.map((n) => exists(join(dir, n))))
    if (taken.some(Boolean)) return join(sub, game)
    for (const n of inside) await fs.rename(join(sub, n), join(dir, n))
    await fs.rmdir(sub).catch(() => {})
    return join(dir, game)
  }
  return undefined
}

const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * `output` renamed to `original` (whose file went to the Recycle Bin), when that name is free and both share a folder
 * and an extension; else `output` as it is.
 */
export async function takeName(output: string, original: string): Promise<string> {
  if (samePath(output, original)) return output
  if (dirname(output).toLowerCase() !== dirname(original).toLowerCase()) return output
  if (extname(output).toLowerCase() !== extname(original).toLowerCase()) return output
  try {
    await fs.access(original)
    return output
  } catch {
    // free
  }
  try {
    await fs.rename(output, original)
    return original
  } catch {
    return output
  }
}

/**
 * What is at `out` is the Xbox helper's own result: it exited 0 and its done line names `out` (and, for a file, its
 * size is the one reported). Anything else there is not this run's to remove.
 */
async function madeByThisRun(
  code: number,
  reported: string | undefined,
  out: string,
  result: Record<string, unknown> | null
): Promise<boolean> {
  if (code !== 0 || !reported || !samePath(reported, out)) return false
  const stat = await fs.stat(out).catch(() => null)
  if (!stat) return false
  const expected = result?.['outputBytes']
  return !(stat.isFile() && typeof expected === 'number' && stat.size !== expected)
}

/** A step's targets: `a|b` names alternatives, tried in order. */
const alternatives = (step: string): string[] => step.split('|').filter(Boolean)

export function createConvertService(deps: ConvertServiceDeps): ConvertService {
  const { log } = deps
  const run = deps.run ?? defaultRun
  const ensure = deps.ensure ?? (() => ensureConverter({ root: deps.toolRoot, log }, onBytes))
  const unpackPs4 = deps.unpackPs4 ?? unpackPs4Pkg
  const runHelper = deps.runHelper ?? spawnHelper
  let tool: ConverterInstall | null = null
  let downloading: ConvertStatus['downloading'] = null
  let running = false
  let items: ConvertItem[] = []
  let error: string | undefined
  let controller: AbortController | null = null
  /** PlayOut is closing (close()): no run starts any more. */
  let closed = false
  /** The run going on, until it has ended and cleaned up. */
  let task: Promise<void> | null = null
  /** Items done whose original stays, and why (an Xbox extract that had to rename files for Windows). */
  const keepOriginal = new WeakMap<ConvertItem, string>()

  function snapshot(): ConvertStatus {
    return {
      tool: tool ? { version: tool.version } : null,
      downloading,
      running,
      items: items.map((i) => ({ ...i })),
      ...(error ? { error } : {})
    }
  }
  const emit = (): void => deps.emit(snapshot())

  let lastBytesEmit = 0
  function onBytes(done: number, total: number): void {
    const now = Date.now()
    if (now - lastBytesEmit < 250 && done < total) return
    lastBytesEmit = now
    downloading = { fraction: total ? Math.min(1, done / total) : null }
    emit()
  }

  function resolveDirection(
    request: Omit<ConvertRequest, 'paths'>
  ): NonNullable<ReturnType<typeof directionFormats>> {
    const pair = convertPair(request.platformId, request.pairId)
    const formats = pair ? directionFormats(pair, request.reversed) : null
    if (!formats) throw new Error(tMain('mainConvert.notOffered'))
    return formats
  }

  async function toolsFor(request: Omit<ConvertRequest, 'paths'>): Promise<{
    tools: ConvertTools
    missing: ConvertMissing[]
  }> {
    const { direction } = resolveDirection(request)
    const needs = direction.needs ?? []
    const emulationDir = deps.emulationDir()
    const tools = await findTools(needs, { emulationDir, emulatorPath: deps.emulatorPath })
    return { tools, missing: missingFor(needs, tools, emulationDir) }
  }

  /** The library's ROM game whose file (or one of its files) is among `sources`, if any. */
  function gameOf(sources: string[]): Game | undefined {
    return deps.library
      .games()
      .find(
        (g) =>
          g.source === 'rom' &&
          !!g.romPath &&
          sources.some(
            (s) =>
              samePath(s, g.romPath!) || samePath(s, romGameFolder(g.romPath!, g) ?? g.romPath!)
          )
      )
  }

  /**
   * Where a converted game's library record goes for this result, as the ROM scan will find it: the result itself
   * when its system lists it (a folder: when its name carries one of the system's folder extensions); a PS3 game
   * folder (PS3_GAME, or USRDIR with PARAM.SFO) itself; for another extracted game folder, the file the scan makes it
   * one game through (an Xbox 360 game's default.xex, an Xbox game's default.xbe, a PS4 dump's eboot.bin), else the
   * first file in it with one of the system's extensions. Null when the system cannot list the result (an Xbox 360 game as CHD): the record
   * then stays where it was, as a game whose file is gone.
   */
  async function landingOf(game: Game, output: string): Promise<string | null> {
    const exts = (deps.romExtensions(game.platformId) ?? []).filter((e) => e !== '.')
    const listed = (path: string): boolean => {
      const ext = extname(path).toLowerCase()
      return ext !== '' && exts.includes(ext)
    }
    if (listed(output)) return output
    if (!(await isDirectory(output))) return null
    if (game.platformId === 'ps3') return (await ps3FolderKind(output, true)) ? output : null
    const names = [...(await listNames(output))].sort((a, b) => a.localeCompare(b))
    const files: string[] = []
    for (const name of names) if (await isFile(join(output, name))) files.push(name)
    const executable = gameFolderExecutableFile(game.platformId)
    const pick = executable
      ? files.find((f) => f.toLowerCase() === executable)
      : files.find((f) => listed(f))
    return pick ? join(output, pick) : null
  }

  /**
   * The converted game's library record moves to its new file (`landing`: landingOf), when the ROM scan will know that
   * file as the same game: in the game's folder or a folder in it.
   */
  async function carryOver(game: Game, landing: string): Promise<void> {
    // A folder game (Halo 3/default.xex) moves from beside its folder, the rest from beside their file.
    const base = dirname(romGameFolder(game.romPath!, game) ?? game.romPath!)
    const rel = relative(base, landing)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return
    const own = relative(base, game.romPath!).split(/[\\/]/).length
    const recorded = game.externalId.replace(/\\/g, '/').split('/')
    if (recorded.length < own) return
    const externalId = [...recorded.slice(0, -own), ...rel.split(/[\\/]/)].join('/')
    const output = landing
    const toId = makeGameId('rom', externalId, game.platformId)
    // The media folder moves only for a record that will move (not onto a game the scan already found).
    if (toId === game.id || deps.library.games().some((g) => g.id === toId)) return
    const mediaUrl = await deps.imageCache.moveGame(game.id, toId)
    if (deps.library.rekeyRom(game.id, externalId, output, mediaUrl))
      log.info(`Convert: ${game.title} moved to ${basename(output)}`)
  }

  /** Playlists beside the converted disc that named it now name its result (the playlist game keeps working). */
  async function updatePlaylists(sources: string[], output: string): Promise<void> {
    const dir = dirname(output)
    const names = new Map(sources.map((s) => [basename(s).toLowerCase(), basename(output)]))
    for (const name of await listNames(dir)) {
      if (extname(name).toLowerCase() !== '.m3u') continue
      const path = join(dir, name)
      if (sources.some((s) => samePath(s, path))) continue
      const text = await fs.readFile(path, 'utf8').catch(() => null)
      if (text === null) continue
      const listed = m3uFiles(text, dir)
      if (!listed.some((p) => sources.some((s) => samePath(s, p)))) continue
      const next = text
        .split(/(\r?\n)/)
        .map((line) => names.get(line.trim().toLowerCase()) ?? line)
        .join('')
      if (next !== text) {
        await fs.writeFile(path, next)
        log.info(`Convert: ${name} now lists ${basename(output)}`)
      }
    }
  }

  /** Send the files of a converted image to the Recycle Bin; the names that could not go. */
  async function recycle(sources: string[], output: string): Promise<string[]> {
    const kept: string[] = []
    for (const source of sources) {
      if (samePath(source, output)) continue
      try {
        await deps.trash(source)
      } catch (err) {
        log.warn(`Convert: ${source} could not go to the Recycle Bin: ${(err as Error).message}`)
        kept.push(basename(source))
      }
    }
    return kept
  }

  interface StepResult {
    verdict: Verdict | null
    /** Verdicts on inputs other than the one given (a folder that holds other games). */
    others: number
    code: number
    before: Set<string>
  }

  async function runStep(
    exe: string,
    inputs: string[],
    target: string,
    outDir: string,
    args: string[],
    signal: AbortSignal,
    verdicts?: Map<string, Verdict>
  ): Promise<StepResult> {
    await fs.mkdir(outDir, { recursive: true })
    const before = await listNames(outDir)
    const name = basename(inputs[0]!)
    let verdict: Verdict | null = null
    let others = 0
    const code = await run(
      exe,
      ['cli', ...inputs, '--to', target, '-o', outDir, '--flat', '--no-m3u', ...args],
      (line) => {
        log.debug(`converter: ${line}`)
        const v = readVerdict(line)
        if (!v) return
        verdicts?.set(v.name, v)
        if (v.name === name) verdict ??= { state: v.state, detail: v.detail }
        else others++
      },
      signal
    )
    return { verdict, others, code, before }
  }

  /** One input through every step; the item is updated as it goes. Resolves to the result, when there is one. */
  async function convertOne(
    item: ConvertItem,
    direction: ConvertDirection,
    to: ConvertFormat,
    args: string[],
    exe: string,
    signal: AbortSignal
  ): Promise<string | undefined> {
    if (direction.builtIn === 'ps4pkg') return unpackOne(item, signal)
    if (direction.builtIn === 'ps5pkg') return ps5One(item, signal)
    if (direction.builtIn === 'xbox')
      return xboxOne(item, direction.steps[0] as XboxCommand, signal)
    if (direction.godPackage) return godOne(item, direction, to, args, exe, signal)
    return stepsOne(item, direction, to, args, exe, signal, dirname(item.path))
  }

  /**
   * Games on Demand → ISO: each package in the picked folder (one per disc) becomes a disc image beside that folder.
   * The packages are kept (the direction is unverified).
   */
  async function godOne(
    item: ConvertItem,
    direction: ConvertDirection,
    to: ConvertFormat,
    args: string[],
    exe: string,
    signal: AbortSignal
  ): Promise<string | undefined> {
    const packages = await godPackagesIn(item.path)
    if (packages.length === 0) {
      item.state = 'failed'
      item.detail = tMain('mainConvert.detail.noGod')
      return undefined
    }
    if (godGames(packages) > 1) {
      item.state = 'failed'
      item.detail = tMain('mainConvert.detail.severalGames')
      return undefined
    }
    const made: string[] = []
    let first: string | undefined
    for (const pkg of packages) {
      const disc: ConvertItem = { path: pkg, state: 'running' }
      const output = await stepsOne(disc, direction, to, args, exe, signal, dirname(item.path))
      if (!output) {
        item.state = disc.state
        item.detail = made.length
          ? tMain('mainConvert.detail.made', {
              detail: disc.detail ?? tMain('mainConvert.detail.discNotConverted'),
              files: made.join(', ')
            })
          : disc.detail
        return undefined
      }
      first ??= output
      made.push(basename(output))
    }
    item.detail = `→ ${made.join(', ')}`
    return first
  }

  /** The converter's steps for one input; the last step's result goes to `finalDir`. */
  async function stepsOne(
    item: ConvertItem,
    direction: ConvertDirection,
    to: ConvertFormat,
    args: string[],
    exe: string,
    signal: AbortSignal,
    finalDir: string
  ): Promise<string | undefined> {
    let input = item.path
    const work = join(deps.workDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    try {
      for (const [index, step] of direction.steps.entries()) {
        const last = index === direction.steps.length - 1
        const outDir = last ? finalDir : work
        let result: StepResult | null = null
        for (const target of alternatives(step)) {
          result = await runStep(exe, [input], target, outDir, args, signal)
          if (signal.aborted || !result.verdict || !refusedTarget(result.verdict)) break
        }
        const { verdict, others, code, before } = result!
        if (signal.aborted) {
          await removeNew(outDir, before)
          item.state = 'stopped'
          return undefined
        }
        if (!verdict && others) {
          // A folder that holds other games (or loose images): what was made of them is taken away again.
          await removeNew(outDir, before)
          item.state = 'failed'
          item.detail = tMain('mainConvert.detail.notOneGame')
          return undefined
        }
        if (!verdict || verdict.state !== 'done') {
          item.state = verdict?.state === 'skipped' ? 'skipped' : 'failed'
          item.detail =
            verdict?.detail ||
            (verdict?.state === 'skipped'
              ? tMain('mainConvert.detail.alreadyConverted')
              : tMain('mainConvert.detail.converterStopped', { code }))
          return undefined
        }
        const made = [...(await listNames(outDir))].filter(
          (n) => !before.has(n) && !n.endsWith('.part') && !n.endsWith('.tmp')
        )
        const output = last
          ? await primaryOutput(outDir, made, to)
          : made[0]
            ? join(outDir, made[0])
            : undefined
        if (!output) {
          item.state = 'failed'
          item.detail = tMain('mainConvert.detail.resultMissing')
          return undefined
        }
        item.detail = verdict.detail
        if (last) return output
        input = output
      }
      return undefined
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * A PS4 package unpacked by PlayOut itself into a game folder of its name next to it (as PS4PKGTool's Full
   * Extract). A folder already there is left alone (skipped); a stopped or failed unpack leaves nothing.
   */
  async function unpackOne(item: ConvertItem, signal: AbortSignal): Promise<string | undefined> {
    const out = join(dirname(item.path), basename(item.path, extname(item.path)))
    if (await exists(out)) {
      item.state = 'skipped'
      item.detail = tMain('mainConvert.detail.alreadyUnpacked', { file: basename(out) })
      return undefined
    }
    item.progress = 0
    let lastEmit = 0
    try {
      const result = await unpackPs4(item.path, out, {
        signal,
        onProgress: ({ done, total }) => {
          item.progress = total ? done / total : 0
          const now = Date.now()
          if (now - lastEmit >= 500) {
            lastEmit = now
            emit()
          }
        }
      })
      item.detail = tMain('mainConvert.detail.doneFiles', {
        file: basename(out),
        files: result.files
      })
      log.info(
        `Convert: ${basename(item.path)} unpacked (${result.header.contentId}, ${result.files} files)`
      )
      return out
    } catch (err) {
      // The unpacker leaves nothing behind (it writes into a hidden folder it removes); a folder named like the
      // result that appeared meanwhile is not ours to remove.
      if (signal.aborted) {
        item.state = 'stopped'
        return undefined
      }
      item.state = 'failed'
      item.detail =
        err instanceof PkgError
          ? err.message
          : tMain('mainConvert.detail.couldNotUnpack', { error: (err as Error).message })
      if (!(err instanceof PkgError)) log.warn(`Convert: ${item.path} not unpacked`, err)
      return undefined
    } finally {
      delete item.progress
    }
  }

  /**
   * A PS5 package unpacked by PlayOut's PS5 package helper (PS5PKGTool's extraction) into a game folder of its name
   * next to it. A folder already there is left alone (skipped). The helper writes into a staging folder beside the
   * result (`<name>.extracting.<id>`) and moves it into place only when every file is written; a stop kills it, so
   * the staging folders this run left are removed here (never one that was there before).
   */
  async function ps5One(item: ConvertItem, signal: AbortSignal): Promise<string | undefined> {
    const exe = deps.ps5Helper
    if (!exe || !(await helperPresent(exe))) {
      item.state = 'failed'
      item.detail = tMain('mainConvert.detail.ps5HelperMissing')
      return undefined
    }
    const dir = dirname(item.path)
    const out = join(dir, basename(item.path, extname(item.path)))
    if (await exists(out)) {
      item.state = 'skipped'
      item.detail = tMain('mainConvert.detail.alreadyUnpacked', { file: basename(out) })
      return undefined
    }
    const staging = (names: Set<string>): string[] =>
      [...names].filter((n) =>
        n.toLowerCase().startsWith(`${basename(out).toLowerCase()}.extracting.`)
      )
    const before = new Set(staging(await listNames(dir)))
    item.progress = 0
    item.detail = tMain('mainConvert.detail.readingPackage')
    emit()
    let lastEmit = 0
    let done: Record<string, unknown> | null = null
    let failure: string | null = null
    let code: number
    try {
      code = await runHelper(
        exe,
        ['extract', item.path, out],
        (line) => {
          const parsed = parseHelperLine(line)
          if (!parsed) return log.debug(`ps5pkg: ${line}`)
          if (parsed.type === 'error') failure = parsed.message
          else if (parsed.type === 'done') done = parsed
          else {
            const p = parsed as unknown as { done?: number; total?: number; phase?: string }
            if (p.phase === 'reading') return
            if (typeof p.done === 'number' && typeof p.total === 'number' && p.total > 0) {
              item.progress = Math.min(1, p.done / p.total)
              item.detail = tMain('mainConvert.detail.writingFiles')
            }
            const now = Date.now()
            if (now - lastEmit >= 500) {
              lastEmit = now
              emit()
            }
          }
        },
        signal
      )
    } catch (err) {
      code = -1
      failure = tMain('mainConvert.detail.ps5HelperNoStart', { error: (err as Error).message })
    } finally {
      delete item.progress
    }
    const result = done as Record<string, unknown> | null
    // The folder was not there before this run (checked above), and the helper only moves it into place once every
    // file is written: its being there means this run finished, even when a stop came in just after the move (before
    // or after the done line). It is then kept, and the game rescanned.
    if (await isDirectory(out)) {
      const files = typeof result?.['files'] === 'number' ? result['files'] : null
      item.detail =
        files !== null
          ? tMain('mainConvert.detail.doneFiles', { file: basename(out), files })
          : `→ ${basename(out)}`
      log.info(
        `Convert: ${basename(item.path)} unpacked by the PS5 package helper (${files ?? '?'} files)`
      )
      return out
    }
    // Stopped (killed) or failed: the staging folders this run made go. The helper moves its result into place only
    // once every file is written, so there is no half result to remove.
    for (const name of staging(await listNames(dir)))
      if (!before.has(name))
        await fs.rm(join(dir, name), { recursive: true, force: true }).catch(() => undefined)
    if (signal.aborted) {
      item.state = 'stopped'
      delete item.detail
      return undefined
    }
    item.state = 'failed'
    item.detail = failure ?? tMain('mainConvert.detail.ps5HelperStopped', { code })
    if (!failure) log.warn(`Convert: ${item.path} not unpacked (PS5 helper exit ${code})`)
    return undefined
  }

  /**
   * An Xbox / Xbox 360 image (or game folder) through PlayOut's Xbox helper. Its result goes next to the original
   * under the original's name; a result already there is left alone (skipped). The helper writes under a
   * `.playout-partial` name and renames only once every file is verified, so exit 0 with its `done` line naming the
   * result is the one success; a stopped or failed run leaves nothing (its partial names are removed here).
   */
  async function xboxOne(
    item: ConvertItem,
    command: XboxCommand,
    signal: AbortSignal
  ): Promise<string | undefined> {
    const exe = deps.xboxHelper
    if (!exe || !(await helperPresent(exe))) {
      item.state = 'failed'
      item.detail = tMain('mainConvert.detail.xboxHelperMissing')
      return undefined
    }
    const out = helperOutput(command, item.path, await isDirectory(item.path))
    if (await exists(out)) {
      item.state = 'skipped'
      item.detail = tMain('mainConvert.detail.alreadyConvertedThere', { file: basename(out) })
      return undefined
    }
    const dir = dirname(out)
    const before = await listNames(dir)
    let done: Record<string, unknown> | null = null
    let failure: string | undefined
    let code: number
    let lastEmit = 0
    item.progress = 0
    try {
      code = await runHelper(
        exe,
        [command, item.path, out],
        (line) => {
          const parsed = parseHelperLine(line)
          if (!parsed) {
            log.debug(`xbox helper: ${line}`)
            return
          }
          if (parsed.type === 'done') done = parsed
          else if (parsed.type === 'error') failure = parsed.message
          else {
            // The helper's overall percent across its phases (trim, verify, chd, verify); an older helper's phase
            // percent as the work, then its check: 80 / 20. Never backwards within the item.
            const fraction = (n: number): number => Math.max(0, Math.min(100, n)) / 100
            const p = fraction(parsed.percent)
            const next =
              typeof parsed.overall === 'number'
                ? fraction(parsed.overall)
                : parsed.phase === 'verify'
                  ? 0.8 + p * 0.2
                  : p * 0.8
            item.progress = Math.max(item.progress ?? 0, next)
            const now = Date.now()
            if (now - lastEmit >= 500) {
              lastEmit = now
              emit()
            }
          }
        },
        signal
      )
    } catch (err) {
      code = -1
      failure = tMain('mainConvert.detail.xboxHelperNoStart', { error: (err as Error).message })
    } finally {
      delete item.progress
    }
    // Whatever the helper left unfinished (killed, failed, or a CHD's temporary trimmed source) goes.
    const leftovers = async (): Promise<void> => {
      for (const name of await listNames(dir))
        if (!before.has(name) && name.toLowerCase().includes(PARTIAL_MARKER))
          await fs.rm(join(dir, name), { recursive: true, force: true }).catch(() => {})
    }
    await leftovers()
    const result = done as Record<string, unknown> | null
    const reported = typeof result?.['output'] === 'string' ? result['output'] : undefined
    if (signal.aborted) {
      // Stopped: a result this run renamed into place just before the stop goes too (the original is untouched).
      // Only that one: anything else at `out` (put there by someone else meanwhile, which the helper refuses to
      // replace) stays; this run's unfinished files went with the leftovers above.
      if (!before.has(basename(out)) && (await madeByThisRun(code, reported, out, result)))
        await fs.rm(out, { recursive: true, force: true }).catch(() => {})
      item.state = 'stopped'
      return undefined
    }
    if (code === 0 && result && typeof result['skipped'] === 'string') {
      item.state = 'skipped'
      item.detail =
        result['skipped'] === 'already optimized'
          ? tMain('mainConvert.detail.alreadyTrimmed')
          : result['skipped']
      return undefined
    }
    if (code !== 0 || !reported || !samePath(reported, out) || !(await exists(out))) {
      item.state = 'failed'
      item.detail =
        failure ??
        (code === 0
          ? tMain('mainConvert.detail.xboxResultMissing')
          : tMain('mainConvert.detail.xboxHelperStopped', { code }))
      return undefined
    }
    const renamed = typeof result?.['renamed'] === 'number' ? result['renamed'] : 0
    item.detail = tMain('mainConvert.detail.verified', { file: basename(out) })
    // Files whose names Windows cannot hold were extracted under other names: the image stays the faithful copy.
    if (renamed > 0)
      keepOriginal.set(item, tMain('mainConvert.detail.renamedKept', { count: renamed }))
    log.info(`Convert: ${basename(item.path)} → ${basename(out)} (Xbox helper ${command})`)
    return out
  }

  /** Why the original stays even though the result was made, or null when it may go. */
  function keepReason(direction: ConvertDirection, detail: string | undefined): string | null {
    if (direction.builtIn === 'ps4pkg' || direction.builtIn === 'ps5pkg')
      return tMain('mainConvert.detail.packageKept')
    if (direction.unverified) return tMain('mainConvert.detail.unverifiedKept')
    if (detail && partlyExisting(detail)) return tMain('mainConvert.detail.partlyKept')
    return null
  }

  async function runEach(
    direction: ConvertDirection,
    to: ConvertFormat,
    exe: string,
    args: string[],
    signal: AbortSignal
  ): Promise<number> {
    let converted = 0
    for (const item of items) {
      if (signal.aborted) {
        if (item.state === 'queued') item.state = 'stopped'
        continue
      }
      item.state = 'running'
      emit()
      try {
        const sources = await sourceFiles(item.path)
        const game = gameOf(sources)
        const output = await convertOne(item, direction, to, args, exe, signal)
        if (output) {
          item.state = 'done'
          item.output = output
          converted++
          const keep = keepOriginal.get(item) ?? keepReason(direction, item.detail)
          if (keep) {
            item.detail = `${item.detail ?? ''} (${keep})`.trim()
          } else {
            const kept = await recycle(sources, output)
            if (kept.length)
              item.detail = tMain('mainConvert.detail.kept', {
                detail: item.detail ?? '',
                files: kept.join(', ')
              }).trim()
            else {
              // A result with the original's extension ("Game (trimmed).nds") takes the original's name now it is free.
              const final = direction.keepName ? await takeName(output, item.path) : output
              if (final !== output) {
                item.output = final
                item.detail = `→ ${basename(final)}`
              }
              // Where the game's library record goes (the result, or the game file in an extracted folder).
              const landing = game?.romPath ? await landingOf(game, final) : null
              await updatePlaylists(sources, item.output ?? output).catch((err) =>
                log.warn(`Convert: playlists not updated: ${(err as Error).message}`)
              )
              if (game?.romPath && landing)
                await carryOver(game, landing).catch((err) =>
                  log.warn(
                    `Convert: ${game.title}'s library record did not move: ${(err as Error).message}`
                  )
                )
            }
          }
        }
      } catch (err) {
        item.state = 'failed'
        item.detail = (err as Error).message
      }
      emit()
    }
    return converted
  }

  /**
   * Every picked file in one converter run (a game's packages with its updates and extra content, combined). The
   * converter names its verdicts after the first file of each game; the files it combined into one share it.
   */
  async function runTogether(
    direction: ConvertDirection,
    to: ConvertFormat,
    exe: string,
    args: string[],
    signal: AbortSignal
  ): Promise<number> {
    for (const item of items) item.state = 'running'
    emit()
    const dirs = [...new Set(items.map((i) => dirname(i.path)))]
    const before = new Map(
      await Promise.all(dirs.map(async (d) => [d, await listNames(d)] as const))
    )
    const verdicts = new Map<string, Verdict>()
    const target = alternatives(direction.steps[0]!)[0]!
    const inputs = items.map((i) => i.path)
    let code: number
    try {
      code = (await runStep(exe, inputs, target, dirs[0]!, args, signal, verdicts)).code
    } catch (err) {
      for (const item of items)
        Object.assign(item, { state: 'failed', detail: (err as Error).message })
      return 0
    }
    // The result goes next to the first file; its folder's snapshot was taken by runStep.
    if (signal.aborted) {
      for (const [dir, names] of before) await removeNew(dir, names)
      for (const item of items) item.state = 'stopped'
      return 0
    }
    const all = [...verdicts.values()]
    const clean = code === 0 && all.length > 0 && all.every((v) => v.state === 'done')
    const made = [...(await listNames(dirs[0]!))].filter((n) => !before.get(dirs[0]!)!.has(n))
    const output = await primaryOutput(dirs[0]!, made, to)
    let converted = 0
    for (const item of items) {
      const own = verdicts.get(basename(item.path))
      if (own) {
        item.state = own.state
        item.detail = own.detail
      } else if (clean) {
        item.state = 'done'
        item.detail = tMain('mainConvert.detail.combined')
      } else {
        item.state = 'failed'
        item.detail = tMain('mainConvert.detail.notConverted', { code })
      }
      if (item.state === 'done') {
        converted++
        if (output) item.output = output
      }
    }
    // The packages go only when everything was made and checked: one bad update keeps them all.
    if (clean && output && !keepReason(direction, all.map((v) => v.detail).join(' ')))
      for (const item of items) {
        const kept = await recycle(await sourceFiles(item.path), output)
        if (kept.length)
          item.detail = tMain('mainConvert.detail.kept', {
            detail: item.detail ?? '',
            files: kept.join(', ')
          }).trim()
      }
    return converted
  }

  async function runAll(
    request: ConvertRequest,
    exe: string,
    args: string[],
    signal: AbortSignal
  ): Promise<void> {
    const { to, direction } = resolveDirection(request)
    const converted =
      direction.together && items.length > 1
        ? await runTogether(direction, to, exe, args, signal)
        : await runEach(direction, to, exe, args, signal)
    if (converted)
      await deps
        .rescanRoms()
        .catch((err) => log.warn(`Convert: rescan failed: ${(err as Error).message}`))
  }

  async function validate(
    request: ConvertRequest
  ): Promise<{ paths: string[]; tools: ConvertTools }> {
    const { from } = resolveDirection(request)
    const paths = [...new Set(request.paths)]
    if (!paths.length) throw new Error(tMain('mainConvert.chooseFiles'))
    for (const path of paths) {
      const folder = await isDirectory(path)
      if (from.folder ? !folder : folder || !from.exts.includes(extname(path).toLowerCase()))
        // The code lets Trim Games tell a refusal about one file from one about the run, in any language.
        throw Object.assign(
          new Error(
            from.folder
              ? tMain('mainConvert.notFolder', { file: basename(path) })
              : tMain('mainConvert.notFormat', { file: basename(path), format: from.label })
          ),
          { code: 'convert-path' }
        )
    }
    const { tools, missing } = await toolsFor(request)
    const blocking = missing.find((m) => m.blocking)
    if (blocking)
      throw new Error(
        tMain('mainConvert.blockingPlace', { message: blocking.message, place: blocking.place })
      )
    return { paths, tools }
  }

  return {
    async status() {
      tool ??= await installedConverter(deps.toolRoot)
      return snapshot()
    },

    async check(request) {
      return (await toolsFor(request)).missing
    },

    async placeFolder(need) {
      const folder = dirname(needPlace(need, deps.emulationDir()))
      await fs.mkdir(folder, { recursive: true })
      return folder
    },

    async start(request) {
      // Taken before anything is awaited: a second press arriving meanwhile is refused, not run beside this one.
      if (closed) throw new Error(tMain('mainConvert.closing'))
      if (running)
        throw Object.assign(new Error(tMain('mainConvert.alreadyRunning')), {
          code: 'convert-busy'
        })
      running = true
      // Made before the checks are awaited: a stop (or PlayOut closing) arriving meanwhile is not lost.
      const own = new AbortController()
      controller = own
      let checked: { paths: string[]; tools: ConvertTools }
      try {
        checked = await validate(request)
      } catch (err) {
        running = false
        controller = null
        throw err
      }
      error = undefined
      if (own.signal.aborted || closed) {
        // Stopped while it was being checked: nothing ran.
        items = checked.paths.map((path) => ({ path, state: 'stopped' }))
        running = false
        controller = null
        emit()
        return snapshot()
      }
      items = checked.paths.map((path) => ({ path, state: 'queued' }))
      emit()
      const builtIn = resolveDirection(request).direction.builtIn
      task = (async () => {
        try {
          if (builtIn) {
            await runAll(request, '', [], own.signal)
            return
          }
          // Downloaded at first use, and updated when it is older than the conversions need (the Convert tab's status
          // may have read an older one already). An update that could not download leaves the older one for this run
          // only: it is tried again at the next.
          let exe = tool?.exe
          if (!tool || !versionAtLeast(tool.version, MIN_CONVERTER_VERSION)) {
            downloading = { fraction: null }
            emit()
            try {
              const got = await ensure()
              exe = got.exe
              tool = versionAtLeast(got.version, MIN_CONVERTER_VERSION) ? got : (tool ?? got)
            } finally {
              downloading = null
            }
          }
          if (own.signal.aborted) {
            for (const item of items) item.state = 'stopped'
          } else await runAll(request, exe!, toolArgs(checked.tools), own.signal)
        } catch (err) {
          error = tMain('mainConvert.couldNotRun', { error: (err as Error).message })
          log.error('Convert run failed', err)
          for (const item of items)
            if (item.state === 'queued' || item.state === 'running') item.state = 'failed'
        } finally {
          running = false
          controller = null
          task = null
          emit()
        }
      })()
      return snapshot()
    },

    async stop() {
      controller?.abort()
      await task
    },

    async close() {
      closed = true
      controller?.abort()
      await task
    }
  }
}
