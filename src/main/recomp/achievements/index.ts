// Achievements of installed Xbox 360 recompilations built on ReXGlue, read without any launcher or service: the
// unlocks from the recompilation's own unlock file (unlock-file.ts), the names, descriptions and gamerscore from the
// achievement table in the player's own copy of the game (default.xex, xex.ts + xdbf.ts) with the recompilation's own
// achievements.toml laid over it when it ships one (meta-toml.ts), as the runtime does.
// The game's table never changes, so what was read from the executable (or that it has none) is kept per
// recompilation in <userData>\recomp-achievements\<hash>.json; a "none" is tried again only when the files it was read
// from change (or, when no executable was found at all, after the recompilation is played). The unlocks and the
// recompilation's achievements.toml are read fresh each time. The executable is decrypted and unpacked in steps that
// give the event loop a turn, so the main process never stalls on it.
import { createHash } from 'node:crypto'
import { promises as fs, type Dirent } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { AchievementsInfo, Game } from '../../../shared/types'
import { mainLanguage } from '../../i18n'
import type { Logger } from '../../logger'
import { isInside, normalizePath } from '../../util/paths'
import { expandSaveTemplate, isPlausibleSaveFolder, type SaveContext } from '../saves'
import {
  findAchievementsToml,
  mergeAchievements,
  readAchievementsToml,
  type MetadataRoot
} from './meta-toml'
import { locateUnlockFile, readUnlockFile, type Unlocks } from './unlock-file'
import { parseXdbf, XACH_SHOW_UNACHIEVED, XLANGUAGE, type XdbfAchievement } from './xdbf'
import { readXdvdfsRootFile } from './xdvdfs'
import { readXexTitleDataAsync } from './xex'

/** What the recompilation service knows of an installed recompilation with achievements. */
export interface RecompAchievementSource {
  recompId: string
  /** From the catalog (8 hex digits), when it gives one. */
  titleId: string | null
  /** The catalog's folder template for the game's user data ({game} = the install folder). */
  folder: string | null
  install: string
  ctx: SaveContext
  /** The installed recompilation's save folders, as templates. */
  saveTemplates: string[]
  /** The game files chosen for it (folders or disc images). */
  gameFiles: string[]
}

export interface RecompAchievementsReader {
  /** The achievements of installed recompilation `recompId` for library game `game`; null when none can be read. */
  read(game: Game, recompId: string): Promise<AchievementsInfo | null>
  /**
   * A play session of `recompId` ended: its unlock file (which appears with the first unlock) and a game executable
   * that was not found before are looked for again on the next read.
   */
  played(recompId: string): void
}

export interface RecompAchievementsDeps {
  /** <userData>\recomp-achievements. */
  dir: string
  source(recompId: string): Promise<RecompAchievementSource | null>
  log: Logger
  /** The UI language (the achievement texts follow it when the game has them); default: the main process's. */
  language?: () => string
}

interface Definitions {
  titleId: string | null
  achievements: XdbfAchievement[]
}

/** A file the game's list was read from (or looked for in), as it was then. */
interface Seen {
  path: string
  size: number
  mtimeMs: number
}

/** What the game's executable gave, kept per recompilation. */
interface KeptFile {
  version: 2
  recompId: string
  titleId: string | null
  /** The list per UI language (XLANGUAGE); null: the executable has no achievement table (or none could be read). */
  lists: Record<string, XdbfAchievement[]> | null
  /** The folder of the executable found: the game's data folder, where its achievements.toml may be. */
  gameRoot: string | null
  /** The places looked in (install folder, game files, the card's disc image). */
  places: string[]
  /** The files read: a "none" is tried again when one of them changes. */
  files: Seen[]
}

const TITLE_ID = /^[0-9A-F]{8}$/
/** A default.xex bigger than this is not read (a game's executable is tens of megabytes at most). */
const MAX_XEX = 96 * 1024 * 1024

/**
 * Whether a folder named by the catalog may be looked in for the unlock file: a local folder inside the install, a
 * plausible save place (saves.ts isPlausibleSaveFolder), or a named folder below the user's profile. Never a network
 * (UNC) or device path, another drive's or Windows' folder: looking there would make Windows sign in to whoever runs a
 * named server, or stall on a dead one.
 */
export function isSafeUserRoot(path: string, ctx: SaveContext): boolean {
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path)) return false
  const p = resolve(path)
  if (/^[\\/]{2}/.test(p)) return false
  if (isInside(ctx.install, p)) return true
  if (isPlausibleSaveFolder(p, ctx)) return true
  const profile = ctx.folders.userProfile
  return !!profile && isInside(profile, p) && normalizePath(profile) !== normalizePath(p)
}

/** The catalog's folder template on this PC ({game} is the install folder); null when it cannot be used. */
export function expandAchievementsFolder(template: string, ctx: SaveContext): string | null {
  const path = expandSaveTemplate(template.replace(/\{game\}/gi, '{install}'), ctx)
  return path && isSafeUserRoot(path, ctx) ? path : null
}

/** The user folders an unlock file may be under (two levels down). */
export function unlockRoots(ctx: SaveContext): string[] {
  const f = ctx.folders
  return [
    f.appData,
    f.localAppData,
    join(f.userProfile, 'AppData', 'LocalLow'),
    join(f.userProfile, 'Saved Games'),
    ctx.documents ?? join(f.userProfile, 'Documents')
  ]
}

/** A network (UNC) or device path. */
const remote = (p: string): boolean => /^[\\/]{2}/.test(p)

/** A default.xex under `dir`, at most `depth` folders down. */
async function findXex(dir: string, depth: number): Promise<string | null> {
  let level = [dir]
  let visited = 0
  for (let d = 0; d <= depth && level.length; d++) {
    const next: string[] = []
    for (const folder of level) {
      if (++visited > 2000) return null
      const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [] as Dirent[])
      const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'default.xex')
      if (hit) return join(folder, hit.name)
      for (const e of entries) if (e.isDirectory()) next.push(join(folder, e.name))
    }
    level = next
  }
  return null
}

async function seen(path: string): Promise<Seen | null> {
  const info = await fs.stat(path).catch(() => null)
  return info?.isFile() ? { path, size: info.size, mtimeMs: info.mtimeMs } : null
}

/** The game's executable at `path` (an .xex or a disc image holding one): its bytes, or null. */
async function xexBytes(path: string): Promise<Buffer | null> {
  const ext = extname(path).toLowerCase()
  if (ext === '.iso' || ext === '.xiso') return readXdvdfsRootFile(path, 'default.xex')
  const info = await fs.stat(path).catch(() => null)
  if (!info?.isFile() || info.size > MAX_XEX) return null
  return fs.readFile(path).catch(() => null)
}

/** The list a player sees: definitions with this player's unlocks. */
export function achievementsInfo(
  defs: Definitions | null,
  unlocks: Unlocks | null
): AchievementsInfo | null {
  if (!defs?.achievements.length) {
    // Counts only: the unlocks, without the game's list.
    return unlocks?.size ? { provider: 'recomp', total: 0, unlocked: unlocks.size, list: [] } : null
  }
  let earned = 0
  let total = 0
  let unlocked = 0
  const list = defs.achievements.map((a) => {
    const done = unlocks?.has(a.id) ?? false
    const at = unlocks?.get(a.id) ?? null
    total += a.gamerscore
    if (done) {
      unlocked++
      earned += a.gamerscore
    }
    const hidden = !(a.flags & XACH_SHOW_UNACHIEVED)
    return {
      id: String(a.id),
      name: a.name || `#${a.id}`,
      ...((done ? a.description : a.unachieved || a.description)
        ? { description: done ? a.description : a.unachieved || a.description }
        : {}),
      unlocked: done,
      ...(at ? { unlockedAt: at } : {}),
      ...(hidden ? { hidden: true } : {}),
      points: a.gamerscore
    }
  })
  return {
    provider: 'recomp',
    total: list.length,
    unlocked,
    ...(total > 0 ? { points: { earned, total } } : {}),
    list
  }
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

export function createRecompAchievements(deps: RecompAchievementsDeps): RecompAchievementsReader {
  const { log } = deps
  const language = deps.language ?? mainLanguage
  /** Recompilation id + title id -> its unlock file, once found; or null: not found since the last play session. */
  const unlockPaths = new Map<string, string | null>()
  /** Recompilation id -> what its game's executable gave (the kept file, read once). */
  const kept = new Map<string, KeptFile | null>()
  /** Recompilations played since their executable was last looked for. */
  const playedSince = new Set<string>()
  /** Reads of the executable in progress, so two page opens do not both read it. */
  const reading = new Map<string, Promise<KeptFile>>()

  const cacheFile = (recompId: string): string =>
    join(deps.dir, `${createHash('sha1').update(recompId).digest('hex').slice(0, 16)}.json`)

  async function load(recompId: string): Promise<KeptFile | null> {
    if (kept.has(recompId)) return kept.get(recompId)!
    let file: KeptFile | null = null
    try {
      const raw = JSON.parse(await fs.readFile(cacheFile(recompId), 'utf8')) as KeptFile
      if (raw?.version === 2 && raw.recompId === recompId && Array.isArray(raw.places)) file = raw
    } catch {
      file = null
    }
    kept.set(recompId, file)
    return file
  }

  async function remember(file: KeptFile): Promise<void> {
    kept.set(file.recompId, file)
    try {
      await fs.mkdir(deps.dir, { recursive: true })
      const path = cacheFile(file.recompId)
      const temp = `${path}.${process.pid}.tmp`
      await fs.writeFile(temp, JSON.stringify(file), 'utf8')
      await fs.rename(temp, path)
    } catch (err) {
      log.warn(`recomp achievements: could not keep ${file.recompId}: ${String(err)}`)
    }
  }

  /** Whether a kept answer still stands for `src` looked for in `places`. */
  async function stillGood(
    file: KeptFile,
    src: RecompAchievementSource,
    places: string[]
  ): Promise<boolean> {
    if (src.titleId && file.titleId && file.titleId !== src.titleId) return false
    // The game's list never changes.
    if (file.lists) return true
    if (!sameList(file.places, places)) return false
    if (!file.files.length) return !playedSince.has(src.recompId)
    for (const f of file.files) {
      const now = await seen(f.path)
      if (!now || now.size !== f.size || now.mtimeMs !== f.mtimeMs) return false
    }
    return true
  }

  /** Read the game's executable from the places it may be in (the slow part: run once per answer kept). */
  async function readExecutable(src: RecompAchievementSource, places: string[]): Promise<KeptFile> {
    const files: Seen[] = []
    const none = (titleId: string | null, gameRoot: string | null): KeptFile => ({
      version: 2,
      recompId: src.recompId,
      titleId,
      lists: null,
      gameRoot,
      places,
      files
    })
    let fallback: KeptFile | null = null
    for (const [i, place] of places.entries()) {
      const info = await fs.stat(place).catch(() => null)
      if (!info) continue
      // The install folder and a game folder hold the executable; a game file may be it or a disc image.
      const path = info.isDirectory() ? await findXex(place, i === 0 ? 3 : 2) : place
      if (!path) continue
      const at = await seen(path)
      if (!at) continue
      files.push(at)
      const gameRoot = info.isDirectory() ? dirname(path) : null
      try {
        const bytes = await xexBytes(path)
        if (!bytes) continue
        const data = await readXexTitleDataAsync(bytes)
        // Another game's executable (a disc image picked for something else): not this one's list.
        if (src.titleId && data.titleId && data.titleId !== src.titleId) continue
        const titleId = src.titleId ?? data.titleId
        const lists: Record<string, XdbfAchievement[]> = {}
        for (const [lang, number] of Object.entries(XLANGUAGE)) {
          const parsed = data.xdbf ? parseXdbf(data.xdbf, number) : null
          if (parsed?.achievements.length) lists[lang] = parsed.achievements
        }
        if (Object.keys(lists).length)
          return { ...none(titleId, gameRoot), lists, files: [...files] }
        fallback ??= none(titleId, gameRoot)
      } catch (err) {
        log.debug(`recomp achievements: could not read the executable in ${place}: ${String(err)}`)
      }
    }
    return fallback ? { ...fallback, files } : none(null, null)
  }

  /** What the game's executable gives: kept, or read now (once at a time). */
  async function fromExecutable(src: RecompAchievementSource, game: Game): Promise<KeptFile> {
    const places = [src.install, ...src.gameFiles, ...(game.romPath ? [game.romPath] : [])].filter(
      (p) => p && !remote(p)
    )
    const file = await load(src.recompId)
    if (file && (await stillGood(file, src, places))) return file
    const running = reading.get(src.recompId)
    if (running) return running
    const work = (async () => {
      playedSince.delete(src.recompId)
      const next = await readExecutable(src, places)
      await remember(next)
      return next
    })().finally(() => reading.delete(src.recompId))
    reading.set(src.recompId, work)
    return work
  }

  /** Where the recompilation's achievements.toml may be: beside the game's data, as the runtime looks. */
  async function metadataRoots(
    src: RecompAchievementSource,
    file: KeptFile
  ): Promise<MetadataRoot[]> {
    const roots: MetadataRoot[] = []
    if (file.gameRoot && isInside(src.install, file.gameRoot)) {
      // Its parent only while that is still the recompilation's own folder (the install folder's parent is shared).
      const parent = dirname(file.gameRoot)
      roots.push({
        dir: file.gameRoot,
        parent: parent !== file.gameRoot && isInside(src.install, parent)
      })
    }
    for (const p of src.gameFiles) {
      if (remote(p)) continue
      if ((await fs.stat(p).catch(() => null))?.isDirectory()) roots.push({ dir: p, parent: true })
    }
    roots.push({ dir: src.install, parent: false })
    return roots
  }

  /** The game's achievement definitions: its executable's list with the recompilation's own entries laid over it. */
  async function definitions(src: RecompAchievementSource, game: Game): Promise<Definitions> {
    const file = await fromExecutable(src, game)
    const lists = file.lists
    const base = lists ? (lists[language()] ?? lists.en ?? Object.values(lists)[0] ?? []) : []
    const toml = await findAchievementsToml(await metadataRoots(src, file))
    const own = toml ? await readAchievementsToml(toml) : null
    return {
      titleId: src.titleId ?? file.titleId,
      achievements: own ? mergeAchievements(base, own) : base
    }
  }

  async function unlockFile(
    src: RecompAchievementSource,
    titleId: string | null
  ): Promise<string | null> {
    const key = `${src.recompId}\n${titleId ?? ''}`
    if (unlockPaths.has(key)) {
      const known = unlockPaths.get(key)!
      // Not found since the last play session: it can only appear while the game runs.
      if (known === null) return null
      if ((await fs.stat(known).catch(() => null))?.isFile()) return known
    }
    const catalogFolder = src.folder ? expandAchievementsFolder(src.folder, src.ctx) : null
    const saveFolders = src.saveTemplates
      .map((t) => expandSaveTemplate(t, src.ctx))
      .filter((p): p is string => !!p && isAbsolute(p) && !remote(p))
    const found = await locateUnlockFile({
      titleId,
      catalogFolder,
      saveFolders,
      install: src.install,
      roots: unlockRoots(src.ctx)
    })
    unlockPaths.set(key, found)
    return found
  }

  return {
    async read(game, recompId) {
      const src = await deps.source(recompId)
      if (!src) return null
      const catalogId = src.titleId?.toUpperCase() ?? null
      const source = { ...src, titleId: catalogId && TITLE_ID.test(catalogId) ? catalogId : null }
      const defs = await definitions(source, game)
      const titleId = source.titleId ?? defs.titleId
      const path = await unlockFile(source, titleId)
      const unlocks = path ? await readUnlockFile(path) : null
      return achievementsInfo(defs, unlocks)
    },
    played(recompId) {
      for (const key of [...unlockPaths.keys()])
        if (key.startsWith(`${recompId}\n`)) unlockPaths.delete(key)
      playedSince.add(recompId)
    }
  }
}
