// Setup programs that take the game as an unpacked folder (Recompilations, ARCHITECTURE.md §4.14). Some
// recompilations ship a setup program that reads the retail disc image itself and refuses anything but the exact
// retail dump (by checksum) — a trimmed XISO, as Trim Games makes, is refused. The same setups skip the image when
// the game is already unpacked in the folder they install to. So before such a setup runs, PlayOut unpacks the
// player's own image of the game there with its Xbox helper (`extract`: verified file by file, written under a
// `.playout-partial` name and renamed last, so the setup never sees a half-unpacked folder).
import { createHash } from 'crypto'
import { createReadStream, promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { Game } from '../../shared/types'
import { helperPresent, parseHelperLine, spawnHelper, type HelperRun } from '../convert/xbox-helper'
import { romGameFolder } from '../emulation/rom-scanner'
import type { Logger } from '../logger'
import { tMain } from '../i18n'

/** A setup program that installs from the game unpacked in a folder of its own. */
export interface UnpackedGameSetup {
  /** The recompilation's entry id (compared without regard to case). */
  recompId: string
  /** The game, in the words shown to the player. */
  game: string
  /** The library platform whose disc images hold the game. */
  platform: 'xbox360'
  /** The folder the setup reads the unpacked game from, below the user's home folder. */
  homeRelative: string[]
  /** The file the setup looks for in that folder to know the game is there. */
  marker: string
  /** Known SHA-256 of the marker by release, for the log only (the helper already verifies its output). */
  knownMarkerSha256?: Record<string, string>
}

export const UNPACKED_GAME_SETUPS: UnpackedGameSetup[] = [
  {
    // Xerenge (Burnout Revenge): its installer extracts the retail redump images only (two SHA-256s), and skips the
    // image when <install>/game/default.xex exists. Install folder: %USERPROFILE%\Games\Burnout Revenge.
    recompId: 'github:shipa-2/xerenge',
    game: 'Burnout Revenge',
    platform: 'xbox360',
    homeRelative: ['Games', 'Burnout Revenge', 'game'],
    marker: 'default.xex',
    knownMarkerSha256: {
      USA: '5258c75d9ae649ed4fb71d4e2fe8808545db16092cfe764ea1a2504f5aae2e2d'
    }
  }
]

/** The table's row for a recompilation, or null. */
export function unpackedSetupFor(
  recompId: string,
  table: readonly UnpackedGameSetup[] = UNPACKED_GAME_SETUPS
): UnpackedGameSetup | null {
  const id = recompId.toLowerCase()
  return (
    table.find((s) => {
      const want = s.recompId.toLowerCase()
      return id === want || id.startsWith(`${want}#`)
    }) ?? null
  )
}

export function setupGameFolder(setup: UnpackedGameSetup, home: string): string {
  return join(home, ...setup.homeRelative)
}

const isFile = (path: string): Promise<boolean> =>
  fs.stat(path).then(
    (s) => s.isFile(),
    () => false
  )

/** The game is already unpacked where the setup looks. */
export function markerPresent(setup: UnpackedGameSetup, home: string): Promise<boolean> {
  return isFile(join(setupGameFolder(setup, home), setup.marker))
}

/** A library game that is a disc image of `platform` on this PC. */
function isImageOf(game: Game, platform: string): boolean {
  return (
    !game.remote &&
    !!game.romPath &&
    game.source === 'rom' &&
    (game.platformId === platform || game.id.toLowerCase().startsWith(`rom:${platform}:`))
  )
}

/**
 * The image to unpack: the game being launched when it is an image of the setup's platform, else a library game of
 * that platform matched to the recompilation (`belongs`). The first one whose file exists; for a game that is an
 * extracted game folder (an Xbox 360 game's default.xex), that folder (copyFolder takes it).
 */
export async function findSetupImage(
  setup: UnpackedGameSetup,
  launched: Game,
  games: readonly Game[],
  belongs: (game: Game) => boolean
): Promise<string | null> {
  const candidates: Game[] = []
  if (isImageOf(launched, setup.platform)) candidates.push(launched)
  for (const g of games)
    if (g.id !== launched.id && isImageOf(g, setup.platform) && belongs(g)) candidates.push(g)
  for (const g of candidates) {
    const folder = romGameFolder(g.romPath!, g)
    if (folder) {
      if (await isFile(g.romPath!)) return folder
    } else if (await isFile(g.romPath!)) return g.romPath!
  }
  return null
}

/** Unpack `image` into `outDir` (absent or empty); `onPercent` 0-100. Rejects with the reason in plain words. */
export type ExtractImage = (
  image: string,
  outDir: string,
  onPercent: (percent: number) => void,
  signal: AbortSignal
) => Promise<void>

/** An already extracted game (a game folder in the library): copied to where the setup looks, the folder kept. */
export const copyFolder: ExtractImage = async (folder, outDir, onPercent, signal) => {
  if (signal.aborted) throw new Error('stopped')
  // Like the helper: into `<outDir>.playout-partial`, renamed only when whole (a failed copy leaves nothing behind).
  const partial = `${outDir}.playout-partial`
  await fs.rm(partial, { recursive: true, force: true })
  try {
    await fs.cp(folder, partial, { recursive: true, errorOnExist: false, force: false })
    if (signal.aborted) throw new Error('stopped')
    await fs.rm(outDir, { recursive: true, force: true })
    await fs.rename(partial, outDir)
  } catch (err) {
    await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
  onPercent(100)
}

/** Whether `path` is a folder (findSetupImage gave an extracted game folder). */
export const isFolder = (path: string): Promise<boolean> =>
  fs.stat(path).then(
    (s) => s.isDirectory(),
    () => false
  )

/** The Xbox helper's `extract` (it writes `<outDir>.playout-partial`, verifies it, then renames it to `outDir`). */
export function helperExtractor(helperExe: string, run: HelperRun = spawnHelper): ExtractImage {
  return async (image, outDir, onPercent, signal) => {
    if (!(await helperPresent(helperExe))) throw new Error(tMain('mainRecomp.setup.helperMissing'))
    let failure: string | null = null
    const code = await run(
      helperExe,
      ['extract', image, outDir],
      (line) => {
        const parsed = parseHelperLine(line)
        if (parsed?.type === 'progress') onPercent(parsed.overall ?? parsed.percent)
        else if (parsed?.type === 'error') failure = parsed.message
      },
      signal
    )
    if (code !== 0) throw new Error(failure ?? tMain('mainRecomp.setup.helperStopped', { code }))
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')))
  })
}

export interface UnpackDeps {
  home: string
  extract: ExtractImage
  log: Logger
  onPercent?: (percent: number) => void
  signal?: AbortSignal
}

export type UnpackResult = { ok: true; folder: string } | { ok: false; message: string }

/**
 * Unpack the player's image of the game into the folder the setup reads. Never touches a folder that already holds
 * files; a folder unpacked without the marker (not this game's disc) is removed again.
 */
export async function unpackSetupGame(
  setup: UnpackedGameSetup,
  image: string,
  deps: UnpackDeps
): Promise<UnpackResult> {
  const folder = setupGameFolder(setup, deps.home)
  const fail = (why: string): UnpackResult => ({
    ok: false,
    message: tMain('mainRecomp.setup.couldNotUnpack', { game: setup.game, why })
  })
  const existing = await fs.readdir(folder).catch(() => null)
  if (existing && existing.length)
    return fail(tMain('mainRecomp.setup.folderHasFiles', { folder, marker: setup.marker }))
  try {
    await fs.mkdir(dirname(folder), { recursive: true })
    deps.log.info(`recomp: unpacking ${image} into ${folder} for ${setup.recompId}`)
    await deps.extract(
      image,
      folder,
      deps.onPercent ?? (() => {}),
      deps.signal ?? new AbortController().signal
    )
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    // Stopped (PlayOut closing): the killed helper could not clean up its partial folder; only that one is removed.
    if (deps.signal?.aborted)
      await fs
        .rm(`${folder}.playout-partial`, { recursive: true, force: true })
        .catch(() => undefined)
    deps.log.warn(`recomp: unpacking ${image} for ${setup.recompId} failed (${why})`)
    return fail(why)
  }
  const marker = join(folder, setup.marker)
  if (!(await isFile(marker))) {
    deps.log.warn(`recomp: ${image} unpacked without ${setup.marker}; removing ${folder}`)
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
    return fail(tMain('mainRecomp.setup.wrongDisc', { marker: setup.marker, game: setup.game }))
  }
  const known = Object.entries(setup.knownMarkerSha256 ?? {})
  if (known.length) {
    const digest = await sha256File(marker).catch(() => null)
    const release = known.find(([, h]) => h.toLowerCase() === digest)?.[0]
    deps.log.info(
      release
        ? `recomp: ${setup.marker} of ${setup.game} is the ${release} release`
        : `recomp: ${setup.marker} of ${setup.game} (sha256 ${digest ?? 'unknown'}) matches no known release (another region is fine)`
    )
  }
  deps.log.info(`recomp: ${setup.game} unpacked into ${folder}`)
  return { ok: true, folder }
}
