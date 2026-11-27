// How many players a game takes, from the LaunchBox Games Database (gamesdb.launchbox-app.com), for the controller
// badge on a game's page (`metadata.localPlayers`), and the genres of ROM games (`metadata.launchboxGenres`, shown
// instead of the scraped genres; shared/genres.ts).
//
// LaunchBox publishes its whole database as one public download, Metadata.zip (about 110 MB, refreshed daily; the
// file the LaunchBox app itself reads). PlayOut downloads it at most once a month, streams Metadata.xml out of it
// and keeps a small index of the games with a player count (name, platform, MaxPlayers, Cooperative, Steam app) in
// userData (also the games with genres); the zip is deleted. Games are then matched locally: by Steam app id when the game has one, else by
// name on the game's own platform (the year closest to the game's when a name has several entries).
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import { createInflateRaw } from 'zlib'
import type { Game, GameMetadata, PlayersProgress } from '../../shared/types'
import type { Logger } from '../logger'
import { bundleBase, normalizeTitle, stripEdition } from './hltb'
import { platformKeyForGame, platformNameFor } from './platform-ids'
import { steamAppFor } from './review-scores'

export const LAUNCHBOX_METADATA_URL = 'https://gamesdb.launchbox-app.com/Metadata.zip'
export const LAUNCHBOX_INDEX_FILE = 'launchbox-players.json'
/** The index is built again from a fresh download after this long. */
export const LAUNCHBOX_INDEX_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** After a failed download or build, the next try waits this long (a start in the meantime does not retry). */
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000
/** 2: games with genres kept too (`genres`). An index of version 1 still serves player counts until rebuilt. */
const INDEX_VERSION = 2
const OLDEST_USABLE_INDEX_VERSION = 1
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000
const PROGRESS_INTERVAL_MS = 500
/** A name match this many years newer than the game is another game of that name (Prey 2017 is not Prey 2006). */
const MAX_YEAR_GAP = 2

/** PlayOut platform keys (resources/systems/platform-ids.json) LaunchBox names differently. */
const LAUNCHBOX_PLATFORMS: Record<string, string[]> = {
  pc: ['Windows', 'MS-DOS', 'Windows 3.X'],
  pcwindows: ['Windows', 'Windows 3.X'],
  steam: ['Windows'],
  dos: ['MS-DOS'],
  adam: ['Coleco ADAM'],
  android: ['Android'],
  arduboy: ['Arduboy'],
  atarist: ['Atari ST'],
  atarixe: ['Atari XEGS', 'Atari 800'],
  atomiswave: ['Sammy Atomiswave'],
  bbcmicro: ['BBC Microcomputer System'],
  coco: ['TRS-80 Color Computer'],
  colecovision: ['ColecoVision'],
  dragon32: ['Dragon 32/64'],
  famicom: ['Nintendo Entertainment System'],
  gamecom: ['Tiger Game.com'],
  intellivision: ['Mattel Intellivision'],
  macintosh: ['Apple Mac OS'],
  mugen: ['MUGEN'],
  naomi: ['Sega Naomi'],
  neogeo: ['SNK Neo Geo AES', 'SNK Neo Geo MVS'],
  odyssey2: ['Magnavox Odyssey 2'],
  openbor: ['OpenBOR'],
  oric: ['Oric Atmos'],
  pc88: ['NEC PC-8801'],
  pc98: ['NEC PC-9801'],
  pcengine: ['NEC TurboGrafx-16'],
  pcenginecd: ['NEC TurboGrafx-CD'],
  pico8: ['PICO-8'],
  plus4: ['Commodore Plus 4'],
  pokemini: ['Nintendo Pokemon Mini'],
  ps2: ['Sony Playstation 2'],
  ps3: ['Sony Playstation 3'],
  ps4: ['Sony Playstation 4'],
  ps5: ['Sony Playstation 5'],
  psp: ['Sony PSP', 'Sony PSP Minis'],
  psvita: ['Sony Playstation Vita'],
  psx: ['Sony Playstation'],
  samcoupe: ['SAM Coupé'],
  scummvm: ['ScummVM'],
  sega32x: ['Sega 32X'],
  snes: ['Super Nintendo Entertainment System'],
  'snes-msu1': ['Super Nintendo Entertainment System'],
  sufami: ['Super Nintendo Entertainment System'],
  supracan: ['Funtech Super Acan'],
  ti99: ['Texas Instruments TI 99/4A'],
  uzebox: ['Uzebox'],
  wasm4: ['WASM-4'],
  fmtowns: ['Fujitsu FM Towns Marty'],
  gameandwatch: ['Nintendo Game & Watch'],
  megadrive: ['Sega Genesis'],
  genesis: ['Sega Genesis'],
  megaduck: ['Mega Duck'],
  msx: ['Microsoft MSX'],
  msx2: ['Microsoft MSX2'],
  sgb: ['Nintendo Game Boy'],
  supergrafx: ['PC Engine SuperGrafx'],
  wonderswan: ['WonderSwan'],
  wonderswancolor: ['WonderSwan Color'],
  zx81: ['Sinclair ZX-81']
}

/** The LaunchBox platform names a PlayOut platform key's games are listed under. */
export function launchBoxPlatforms(platformKey: string): string[] {
  const key = platformKey.trim().toLowerCase()
  const mapped = LAUNCHBOX_PLATFORMS[key]
  if (mapped) return mapped
  // The other names in platform-ids.json are LaunchBox's own ("Nintendo 64", "Sega Saturn").
  const name = platformNameFor(key)
  return name ? [name] : []
}

/** One LaunchBox game with a player count or genres, as the index keeps it. */
export interface LaunchBoxGame {
  id: number
  name: string
  platform: string
  /** MaxPlayers; absent when LaunchBox has none. */
  max?: number
  /** LaunchBox's genres (its Genres field, split at ';'). */
  genres?: string[]
  coop?: boolean
  steam?: number
  year?: number
  /** Other names of the game (GameAlternateName). */
  alt?: string[]
}

export interface LaunchBoxIndexFile {
  version: number
  builtAt: string
  games: LaunchBoxGame[]
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

function field(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return m ? decodeXml(m[1]!).trim() : undefined
}

/**
 * Reads Metadata.xml a chunk at a time: complete <Game> and <GameAlternateName> blocks are handed over, the
 * unfinished end is kept for the next chunk. Games with neither a player count nor genres are dropped here.
 */
export function createMetadataXmlReader(): {
  push(chunk: string): void
  games: Map<number, LaunchBoxGame>
  alternates: Map<number, string[]>
} {
  const games = new Map<number, LaunchBoxGame>()
  const alternates = new Map<number, string[]>()
  let rest = ''
  const blockRe = /<(Game|GameAlternateName)>([\s\S]*?)<\/\1>/g
  return {
    games,
    alternates,
    push(chunk: string): void {
      const text = rest + chunk
      blockRe.lastIndex = 0
      let end = 0
      for (let m = blockRe.exec(text); m; m = blockRe.exec(text)) {
        end = blockRe.lastIndex
        const block = m[2]!
        const id = Number.parseInt(field(block, 'DatabaseID') ?? '', 10)
        if (!Number.isInteger(id)) continue
        if (m[1] === 'GameAlternateName') {
          const name = field(block, 'AlternateName')
          if (name) alternates.set(id, [...(alternates.get(id) ?? []), name])
          continue
        }
        const max = Number.parseInt(field(block, 'MaxPlayers') ?? '', 10)
        const name = field(block, 'Name')
        const platform = field(block, 'Platform')
        const hasMax = Number.isInteger(max) && max > 0
        const genres = parseGenres(field(block, 'Genres'))
        if (!name || !platform || (!hasMax && !genres.length)) continue
        const steam = Number.parseInt(field(block, 'SteamAppId') ?? '', 10)
        const year =
          Number.parseInt(field(block, 'ReleaseYear') ?? '', 10) ||
          Number.parseInt((field(block, 'ReleaseDate') ?? '').slice(0, 4), 10)
        games.set(id, {
          id,
          name,
          platform,
          ...(hasMax ? { max } : {}),
          ...(genres.length ? { genres } : {}),
          ...(hasMax && field(block, 'Cooperative') === 'true' ? { coop: true } : {}),
          ...(Number.isInteger(steam) && steam > 0 ? { steam } : {}),
          ...(Number.isInteger(year) && year > 0 ? { year } : {})
        })
      }
      // Keep what follows the last complete block; a block never spans more than this tail.
      rest = text.slice(end)
      if (rest.length > 4 * 1024 * 1024) rest = rest.slice(-1024 * 1024)
    }
  }
}

/** LaunchBox's Genres field ("Action; Adventure"): its genres, trimmed, without repeats, at most 10 of 60 chars. */
export function parseGenres(text: string | undefined): string[] {
  const out: string[] = []
  for (const part of (text ?? '').split(';')) {
    const genre = part.trim()
    if (!genre || genre.length > 60) continue
    if (!out.some((g) => g.toLowerCase() === genre.toLowerCase())) out.push(genre)
    if (out.length === 10) break
  }
  return out
}

/** Where a zip entry's data starts, and how it is stored. Throws when the zip or the entry is not usable. */
export async function findZipEntry(
  path: string,
  entryName: string
): Promise<{ offset: number; compressed: number; method: number }> {
  const handle = await fs.open(path, 'r')
  try {
    const size = (await handle.stat()).size
    const tailSize = Math.min(size, 0xffff + 22)
    const tail = Buffer.alloc(tailSize)
    await handle.read(tail, 0, tailSize, size - tailSize)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    if (eocd < 0) throw new Error('not a zip file')
    const entries = tail.readUInt16LE(eocd + 10)
    const dirSize = tail.readUInt32LE(eocd + 12)
    const dirOffset = tail.readUInt32LE(eocd + 16)
    if (dirOffset + dirSize > size) throw new Error('zip directory out of range (zip64?)')
    const dir = Buffer.alloc(dirSize)
    await handle.read(dir, 0, dirSize, dirOffset)
    let at = 0
    for (let n = 0; n < entries && at + 46 <= dir.length; n++) {
      if (dir.readUInt32LE(at) !== 0x02014b50) throw new Error('bad zip directory')
      const method = dir.readUInt16LE(at + 10)
      const compressed = dir.readUInt32LE(at + 20)
      const nameLength = dir.readUInt16LE(at + 28)
      const extraLength = dir.readUInt16LE(at + 30)
      const commentLength = dir.readUInt16LE(at + 32)
      const localOffset = dir.readUInt32LE(at + 42)
      const name = dir.subarray(at + 46, at + 46 + nameLength).toString('utf8')
      at += 46 + nameLength + extraLength + commentLength
      if (name !== entryName) continue
      if (method !== 0 && method !== 8) throw new Error(`unsupported zip method ${method}`)
      const local = Buffer.alloc(30)
      await handle.read(local, 0, 30, localOffset)
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('bad zip entry')
      const offset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
      return { offset, compressed, method }
    }
    throw new Error(`${entryName} not in the zip`)
  } finally {
    await handle.close()
  }
}

/** The index of Metadata.zip at `zipPath`: its Metadata.xml streamed, the games with a count or genres kept. */
export async function buildIndexFromZip(
  zipPath: string,
  onRead?: (bytes: number, total: number) => void
): Promise<LaunchBoxIndexFile> {
  const entry = await findZipEntry(zipPath, 'Metadata.xml')
  const reader = createMetadataXmlReader()
  const input = createReadStream(zipPath, {
    start: entry.offset,
    end: entry.offset + entry.compressed - 1
  })
  let read = 0
  input.on('data', (chunk) => {
    read += chunk.length
    onRead?.(read, entry.compressed)
  })
  const decoder = new TextDecoder('utf-8')
  const source = entry.method === 8 ? input.pipe(createInflateRaw()) : input
  for await (const chunk of source as AsyncIterable<Buffer>)
    reader.push(decoder.decode(chunk, { stream: true }))
  reader.push(decoder.decode())
  const games: LaunchBoxGame[] = []
  for (const game of reader.games.values()) {
    const alt = reader.alternates.get(game.id)
    games.push(alt?.length ? { ...game, alt } : game)
  }
  return { version: INDEX_VERSION, builtAt: new Date().toISOString(), games }
}

/** Which LaunchBox entries a match may take: one with a player count, or one with genres. */
export type LaunchBoxWant = (game: LaunchBoxGame) => boolean
export const WITH_PLAYERS: LaunchBoxWant = (g) => !!g.max
export const WITH_GENRES: LaunchBoxWant = (g) => !!g.genres?.length

/** Lookups over the index: by Steam app, and by normalised name on a platform. */
export interface LaunchBoxLookup {
  /** Every entry of a Steam app, the Windows one first. */
  bySteam: Map<number, LaunchBoxGame[]>
  byName: Map<string, LaunchBoxGame[]>
  size: number
}

const nameKey = (name: string, platform: string): string => `${normalizeTitle(name)}|${platform}`

/**
 * The lookups for `games`. With `platforms`, names are indexed only for games on those LaunchBox platforms (the
 * library's: the whole database takes about 60 MB more); Steam apps always are.
 */
export function createLookup(
  games: readonly LaunchBoxGame[],
  platforms?: ReadonlySet<string>
): LaunchBoxLookup {
  const bySteam = new Map<number, LaunchBoxGame[]>()
  const byName = new Map<string, LaunchBoxGame[]>()
  const add = (key: string, game: LaunchBoxGame): void => {
    const list = byName.get(key)
    if (!list) byName.set(key, [game])
    else if (!list.includes(game)) list.push(game)
  }
  for (const game of games) {
    // A Windows entry first when several platforms share a Steam app (the PC game's count).
    if (game.steam) {
      const list = bySteam.get(game.steam)
      if (!list) bySteam.set(game.steam, [game])
      else if (game.platform === 'Windows') list.unshift(game)
      else list.push(game)
    }
    if (platforms && !platforms.has(game.platform)) continue
    for (const name of [game.name, ...(game.alt ?? [])]) {
      add(nameKey(name, game.platform), game)
      const base = stripEdition(normalizeTitle(name))
      if (base) add(`${base}|${game.platform}`, game)
    }
  }
  return { bySteam, byName, size: games.length }
}

function yearOf(releaseDate: string | undefined): number | undefined {
  const m = releaseDate?.match(/^(\d{4})/)
  return m ? Number.parseInt(m[1]!, 10) : undefined
}

/**
 * The LaunchBox game a library game is: by its Steam app (its own, or the one the Steam tags or size lookup found),
 * else by its name (also without edition words, and the game of a "Game + Add-on" title) on one of its platform's
 * LaunchBox platforms; among several of one name, the release year closest to the game's. Only entries `want` takes
 * (a player count by default) count. null when none matches.
 */
export function matchLaunchBox(
  game: Game,
  lookup: LaunchBoxLookup,
  want: LaunchBoxWant = WITH_PLAYERS
): LaunchBoxGame | null {
  const app = steamAppFor(game)
  if (app) {
    const bySteam = lookup.bySteam.get(app)?.find(want)
    if (bySteam) return bySteam
  }
  const platforms = launchBoxPlatforms(platformKeyForGame(game))
  if (!platforms.length) return null
  const title = game.user.titleOverride?.trim() || game.title
  const names = [title, bundleBase(title)].filter((n): n is string => !!n)
  const year = yearOf(game.metadata.releaseDate)
  for (const name of names) {
    const normalized = normalizeTitle(name)
    for (const variant of [normalized, stripEdition(normalized)]) {
      if (!variant) continue
      // Every platform of the game at once (a PC game's Windows and DOS entries): DOOM from 1993 is the DOS one.
      const found = platforms
        .flatMap((platform) => lookup.byName.get(`${variant}|${platform}`) ?? [])
        .filter(want)
      if (!found.length) continue
      // Without a year, the platform listed first (Windows for a PC game).
      if (!year) return found[0]!
      // The closest year; an entry without a year is taken at face value.
      const best = [...found].sort(
        (a, b) => Math.abs((a.year ?? year) - year) - Math.abs((b.year ?? year) - year)
      )[0]!
      // Only an entry years newer than the game is another game (a remake): a store copy dated years after
      // LaunchBox's entry is a re-release of it (a 1998 game sold on GOG in 2012).
      if (best.year && best.year - year > MAX_YEAR_GAP) continue
      return best
    }
  }
  return null
}

export type LocalPlayersRecord = NonNullable<GameMetadata['localPlayers']>

/** What is stored for a game: its LaunchBox player count, or a miss. */
export function localPlayersRecord(
  match: LaunchBoxGame | null,
  nowIso: string
): LocalPlayersRecord {
  return match?.max
    ? {
        max: match.max,
        ...(match.coop ? { coop: true } : {}),
        launchboxId: match.id,
        updatedAt: nowIso
      }
    : { missedAt: nowIso }
}

const sameRecord = (a: LocalPlayersRecord | undefined, b: LocalPlayersRecord): boolean =>
  !!a && a.max === b.max && !!a.coop === !!b.coop && a.launchboxId === b.launchboxId

export type LaunchBoxGenresRecord = NonNullable<GameMetadata['launchboxGenres']>

/** Whether LaunchBox genres are looked up for `game`: ROM games only (store games keep their scraped genres). */
export function wantsLaunchBoxGenres(game: Pick<Game, 'source'>): boolean {
  return game.source === 'rom'
}

/** What is stored for a game's genres: its LaunchBox entry's, or a miss (the scraped genres are shown then). */
export function launchBoxGenresRecord(
  match: LaunchBoxGame | null,
  nowIso: string
): LaunchBoxGenresRecord {
  return match?.genres?.length
    ? { genres: [...match.genres], launchboxId: match.id, updatedAt: nowIso }
    : { missedAt: nowIso }
}

const sameGenres = (a: LaunchBoxGenresRecord | undefined, b: LaunchBoxGenresRecord): boolean =>
  !!a &&
  a.launchboxId === b.launchboxId &&
  (a.genres ?? []).join('\u0000') === (b.genres ?? []).join('\u0000')

export interface LocalPlayersDeps {
  library: {
    games(): Game[]
    getGame(id: string): Game | undefined
    applyMetadata(
      id: string,
      update: { metadata?: Partial<GameMetadata> },
      options?: { overwrite?: boolean; quiet?: boolean }
    ): unknown
  }
  /** userData: where the index (and, while it is built, the download) is kept. */
  dataDir: string
  log: Logger
  /** The games whose count changed in a pass (written quietly): one library:changed for them all. */
  onChanged?: (gameIds: string[]) => void
  /** The download's and the index build's progress, for the bottom bar ('players:progress'); total 0 when idle. */
  onProgress?: (progress: PlayersProgress) => void
  /** Tests. */
  download?: (
    url: string,
    target: string,
    onBytes: (got: number, total: number) => void
  ) => Promise<void>
  now?: () => number
}

export interface LocalPlayersService {
  /** Make sure the index is there and current (downloading it when due), then match every game. */
  kick(): void
  idle(): Promise<void>
  dispose(): void
}

async function downloadToFile(
  url: string,
  target: string,
  onBytes: (got: number, total: number) => void
): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PlayOut (+https://github.com/jeremybris/PlayOut)' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${url}`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0
  const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)
  body.on('data', (chunk: Buffer) => {
    got += chunk.length
    onBytes(got, total)
  })
  await pipeline(body, createWriteStream(target))
}

export function createLocalPlayers(deps: LocalPlayersDeps): LocalPlayersService {
  const { library, dataDir, log } = deps
  const now = deps.now ?? Date.now
  const download = deps.download ?? downloadToFile
  const indexPath = join(dataDir, LAUNCHBOX_INDEX_FILE)
  const failedPath = join(dataDir, `${LAUNCHBOX_INDEX_FILE}.failed`)
  let lookup: LaunchBoxLookup | null = null
  /** The index in use has genres (version 2 and later). */
  let hasGenres = false
  let builtAt = 0
  let failedAt = 0
  let running: Promise<void> | null = null
  let again = false
  let disposed = false
  let reported = false

  let lastReport = 0
  function report(progress: PlayersProgress, force = false): void {
    const at = Date.now()
    if (!force && at - lastReport < PROGRESS_INTERVAL_MS) return
    lastReport = at
    if (!disposed) deps.onProgress?.(progress)
  }

  /** The LaunchBox platforms of the library's games: the ones the name lookup covers. */
  let lookupPlatforms = new Set<string>()
  const libraryPlatforms = (): Set<string> => {
    const out = new Set<string>()
    for (const game of library.games())
      for (const p of launchBoxPlatforms(platformKeyForGame(game))) out.add(p)
    return out
  }
  const covers = (wanted: Set<string>): boolean => [...wanted].every((p) => lookupPlatforms.has(p))

  /** The lookup from a parsed index, for the library's platforms; the index itself is not kept. */
  function applyIndex(file: LaunchBoxIndexFile): void {
    hasGenres = file.version >= 2
    lookupPlatforms = libraryPlatforms()
    lookup = createLookup(file.games, lookupPlatforms)
    builtAt = Date.parse(file.builtAt) || 0
  }

  /** The index from disk, unless the lookup already covers every platform the library has now. */
  async function loadIndex(): Promise<void> {
    if (lookup && covers(libraryPlatforms())) return
    try {
      const file = JSON.parse(await fs.readFile(indexPath, 'utf8')) as LaunchBoxIndexFile
      const version = file?.version
      if (
        typeof version !== 'number' ||
        version < OLDEST_USABLE_INDEX_VERSION ||
        version > INDEX_VERSION ||
        !Array.isArray(file.games)
      )
        return
      applyIndex(file)
      // An older index (no genres) serves until a new one is built, which is due now.
      if (version < INDEX_VERSION) builtAt = 0
      log.info(
        `LaunchBox player counts: ${file.games.length} game(s) in the index from ${file.builtAt}, ${lookupPlatforms.size} platform(s) looked up`
      )
    } catch {
      // No index yet (or an unreadable one): built from a download.
    }
  }

  async function rebuild(): Promise<void> {
    const zipPath = join(dataDir, 'launchbox-metadata.zip.part')
    log.info(`LaunchBox player counts: downloading ${LAUNCHBOX_METADATA_URL}`)
    try {
      report({ stage: 'download', done: 0, total: 0 }, true)
      await download(LAUNCHBOX_METADATA_URL, zipPath, (got, total) =>
        report({ stage: 'download', done: got, total: total || got })
      )
      if (disposed) return
      report({ stage: 'reading', done: 0, total: 1 }, true)
      const file = await buildIndexFromZip(zipPath, (read, total) =>
        report({ stage: 'reading', done: read, total })
      )
      // Its age goes by the service's clock, like the check that it is due.
      file.builtAt = new Date(now()).toISOString()
      if (disposed) return
      const tmp = `${indexPath}.tmp`
      await fs.writeFile(tmp, JSON.stringify(file))
      await fs.rename(tmp, indexPath)
      applyIndex(file)
      failedAt = 0
      await fs.rm(failedPath, { force: true }).catch(() => {})
      log.info(`LaunchBox player counts: index built with ${file.games.length} game(s)`)
    } catch (err) {
      failedAt = now()
      // On disk too: a start within the wait does not download the 110 MB again.
      await fs.writeFile(failedPath, String(failedAt)).catch(() => {})
      log.warn(
        `LaunchBox player counts: could not download or read the database (${err instanceof Error ? err.message : String(err)}); tried again later`
      )
    } finally {
      await fs.rm(zipPath, { force: true }).catch(() => {})
      report({ stage: 'reading', done: 0, total: 0 }, true)
    }
  }

  function matchAll(): void {
    if (!lookup) return
    const nowIso = new Date(now()).toISOString()
    let found = 0
    let withGenres = 0
    const changedIds: string[] = []
    for (const game of library.games()) {
      if (disposed) return
      const update: Partial<GameMetadata> = {}
      const match = matchLaunchBox(game, lookup, WITH_PLAYERS)
      if (match) found++
      const current = game.metadata.localPlayers
      const record = localPlayersRecord(match, nowIso)
      // Only a change is written: a new or different count shows on the game's page, a miss over nothing is kept
      // out of the library file.
      if (!(match ? sameRecord(current, record) : !current?.max)) update.localPlayers = record
      // Genres only from an index that has them (one of version 1 does not: nothing changes until it is rebuilt).
      if (hasGenres && wantsLaunchBoxGenres(game)) {
        const genreMatch = matchLaunchBox(game, lookup, WITH_GENRES)
        if (genreMatch) withGenres++
        const currentGenres = game.metadata.launchboxGenres
        const genresRecord = launchBoxGenresRecord(genreMatch, nowIso)
        // A miss over nothing (or over a miss) is not written; a miss over genres is (the scraped ones show again).
        if (genreMatch ? !sameGenres(currentGenres, genresRecord) : !!currentGenres?.genres?.length)
          update.launchboxGenres = genresRecord
      }
      if (!Object.keys(update).length) continue
      // Quiet: one library:changed for the whole pass below, not one per game (4,000+ on a first pass).
      library.applyMetadata(game.id, { metadata: update }, { overwrite: true, quiet: true })
      changedIds.push(game.id)
    }
    const changed = changedIds.length
    if (changed) deps.onChanged?.(changedIds)
    // Run after every library change: said only when it changed something, and once a run.
    if (changed || !reported) {
      reported = true
      log.info(
        `LaunchBox: ${found} of ${library.games().length} game(s) with a player count, ${withGenres} with genres, ${changed} updated`
      )
    }
  }

  async function pass(): Promise<void> {
    if (!failedAt) {
      const saved = Number.parseInt(await fs.readFile(failedPath, 'utf8').catch(() => ''), 10)
      if (Number.isFinite(saved) && saved > 0) failedAt = saved
    }
    await loadIndex()
    const stale = !lookup || now() - builtAt >= LAUNCHBOX_INDEX_TTL_MS
    if (stale && now() - failedAt >= RETRY_AFTER_FAILURE_MS) await rebuild()
    if (!disposed) matchAll()
  }

  return {
    kick() {
      if (disposed) return
      if (running) {
        again = true
        return
      }
      running = (async () => {
        do {
          again = false
          try {
            await pass()
          } catch (err) {
            log.error('LaunchBox player counts failed', err)
          }
        } while (again && !disposed)
        running = null
      })()
    },
    async idle() {
      while (running) await running
    },
    dispose() {
      disposed = true
    }
  }
}
