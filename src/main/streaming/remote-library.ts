import { STORE_SOURCES } from '../../shared/types'
import {
  playsOnlyRecomp,
  RECOMP_ACHIEVEMENTS_SOURCE as RECOMP_ACHIEVEMENTS_KEY
} from '../../shared/recomp-play'
import { withoutXisoSuffix } from '../../shared/convert'
import { isDifficultyId } from '../../shared/difficulty'
import { hashShort } from '../util/ids'
import { sanitizeAchievementsSummary } from './host-achievements'
import { sortTitle } from '../util/text'
import { romGameFolder, staleGameFolderSize } from '../emulation/rom-scanner'
import type {
  Game,
  GameMedia,
  GameMetadata,
  RemoteGameInfo,
  RemoteLibrary,
  SourceId,
  SteamControls
} from '../../shared/types'

/**
 * Pure library merge for Streaming. The host turns its library into an offer (`hostOffer`): installed store games it
 * can stream and ROM games it can stream or hand out, stripped of everything that only makes sense on the host (paths,
 * launch and tracking specs, local media URLs). The client folds every paired host's offer into its own library
 * (`buildRemoteLibrary`): a game this PC already has stays this PC's copy and only learns which hosts also have it;
 * the rest become `remote:` games the renderer shows next to the local ones.
 */

/** Host fields the client must never see or rely on: they are paths and specs that only work on the host. */
type HostOnlyField =
  | 'installDir'
  | 'exePath'
  | 'romPath'
  | 'launch'
  | 'tracking'
  | 'user'
  | 'extra'
  | 'media'
  | 'remote'
  | 'installSize'
  | 'romRemoved'

/** One game a host offers over `GET /v1/library`. */
export type HostGame = Omit<Game, HostOnlyField> & {
  /** Only the user's title, so the client shows the name the host's owner chose. */
  user?: { titleOverride?: string }
  /** Kinds the host serves at `/v1/media/:gameId/:kind`: cover, hero, logo, icon, screenshot0..9. */
  mediaKinds: string[]
  /**
   * Per kind, the revision of the host's image (`MEDIA_REV`: its file's write time): a client keeps the image it
   * fetched until this changes, so art the host replaced (a game matched again) is fetched again. Absent from an
   * older host, and for an image with none: such an image is kept as it was first fetched.
   */
  mediaRevs?: Record<string, string>
  /** ROM games: the emulated system (ES-DE id). */
  systemId?: string
  /** ROM games: every file of the ROM when known, else the size the host measured or was told. */
  sizeBytes?: number
  /**
   * The host's achievements of the game (its Steam / RetroAchievements account), unlocked of total. Not in `metadata`:
   * a client copies the offer's metadata into its own copies of a game (importFromHost), and these counts are the
   * host's. Shown on the client's host-only card only (host-achievements.ts).
   */
  achievements?: { unlocked: number; total: number }
  /**
   * A ROM card whose disc image went to the Recycle Bin for its recompilation (Game.romRemoved): still offered, so its
   * favourite, play time and achievements keep syncing and a client's copy stays paired, but there is no file to
   * download. Streaming it starts the recompilation on the host.
   */
  noRomFile?: true
  /**
   * ROM games: the RetroAchievements hash of the host's file (lower-case MD5), when the host worked it out (signed in
   * to RetroAchievements or not). A client matches the ROM with its own RetroAchievements account by it.
   */
  raHash?: string
}

/** A RetroAchievements ROM hash as an offer carries it. */
const RA_HASH = /^[0-9a-f]{32}$/

/** Screenshots the host serves: `screenshot0`..`screenshot9`. */
export const MAX_REMOTE_SCREENSHOTS = 10

const SOURCES: ReadonlySet<string> = new Set<SourceId>([...STORE_SOURCES, 'manual', 'rom'])
const STORES: ReadonlySet<string> = new Set<string>(STORE_SOURCES)
const ART_KINDS = ['cover', 'hero', 'logo', 'icon'] as const

export interface HostOfferOptions {
  /** ROM set size (cue/bin tracks, m3u discs, folder contents) when the host has measured it. */
  romSetSize?: (game: Game) => number | undefined
  /** A ROM's RetroAchievements hash when the host worked it out (main achievements-service.ts raHashOf). */
  raHash?: (game: Game) => string | undefined
}

/** The system of a ROM game: its launch spec, else the `rom:<system>:<hash>` id, else its platform. */
export function romSystemId(
  game: Pick<Game, 'id' | 'platformId'> & { launch?: Game['launch'] }
): string {
  if (game.launch?.kind === 'emulator' && game.launch.systemId) return game.launch.systemId
  const match = /^rom:([^:]+):/.exec(game.id)
  return match ? match[1] : game.platformId
}

function mediaKindsOf(game: Game): string[] {
  const media: GameMedia = game.media ?? {}
  const custom = game.user?.customMedia ?? {}
  const kinds: string[] = ART_KINDS.filter((kind) => Boolean(media[kind] || custom[kind]))
  const shots = (media.screenshots ?? []).slice(0, MAX_REMOTE_SCREENSHOTS)
  shots.forEach((_, i) => kinds.push(`screenshot${i}`))
  return kinds
}

/** A host image's revision as an offer carries it, a remote media URL (`?v=`) and a cache file's name. */
export const MEDIA_REV = /^[A-Za-z0-9]{1,24}$/

/**
 * Whether a cached host image is the revision asked for (its file is named `<stem>.v<rev>.<ext>`): false for the
 * file of an earlier revision that is served while the host's current one could not be fetched. True without a
 * usable revision (an older host: the file first fetched is the one there is).
 */
export function isMediaRevision(file: string, rev: string | undefined): boolean {
  if (!rev || !MEDIA_REV.test(rev)) return true
  const name = file.split(/[\\/]/).pop() ?? ''
  return name.replace(/\.[^.]+$/, '').endsWith(`.v${rev}`)
}

/** The revision of each image the host serves: the `?v=` of its media URL (image-cache.ts: the file's write time). */
function mediaRevsOf(game: Game): Record<string, string> {
  const media: GameMedia = game.media ?? {}
  const custom = game.user?.customMedia ?? {}
  const revs: Record<string, string> = {}
  const note = (kind: string, url: string | undefined): void => {
    const rev = /[?&]v=([^&#]+)/.exec(url ?? '')?.[1]
    if (rev && MEDIA_REV.test(rev)) revs[kind] = rev
  }
  for (const kind of ART_KINDS) note(kind, custom[kind] || media[kind])
  ;(media.screenshots ?? [])
    .slice(0, MAX_REMOTE_SCREENSHOTS)
    .forEach((url, i) => note(`screenshot${i}`, url))
  return revs
}

function positive(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined
}

function knownSize(game: Game, options: HostOfferOptions): number | undefined {
  const romSet = game.source === 'rom' ? positive(options.romSetSize?.(game)) : undefined
  const folderRom = isGameFolderRom(game)
  // A dumped PS4 game's measurement counts only when it is of its whole folder (not one of its eboot.bin from before).
  const measured =
    game.installSize?.unmeasurable || (folderRom && staleGameFolderSize(game))
      ? undefined
      : positive(game.installSize?.bytes)
  return (
    romSet ??
    positive(game.user?.installSize) ??
    measured ??
    (folderRom ? undefined : positive(game.extra?.fileSize))
  )
}

/**
 * A dumped PS4 game: the scan's fileSize is its eboot.bin's, a sliver of the game; only the measured folder (its
 * installSize, when it is of that folder) is its size.
 */
function isGameFolderRom(game: Game): boolean {
  return game.source === 'rom' && romGameFolder(game.romPath ?? game.externalId, game) !== null
}

/**
 * The metadata a client can use as its own: what describes the game (text, times, players, scores, tags, its Steam
 * screenshots' addresses). Left out: what is about this PC (achievements, Co-Op handlers, its match bookkeeping) or
 * changes by the minute (current players), and this PC's files (saved screenshot thumbnails).
 */
export function portableMetadata(metadata: GameMetadata | undefined): GameMetadata {
  /* eslint-disable @typescript-eslint/no-unused-vars -- picked off so the rest is what is shared */
  const {
    achievements,
    coop,
    currentPlayers,
    nameMatchRules,
    nameMatchChecked,
    rematch,
    rematchTried,
    steamScreenshots,
    ...rest
  } = metadata ?? {}
  /* eslint-enable @typescript-eslint/no-unused-vars */
  const out: GameMetadata = { ...rest }
  if (steamScreenshots?.items.length)
    out.steamScreenshots = {
      items: steamScreenshots.items.map(({ thumbnail, full }) => ({ thumbnail, full })),
      updatedAt: steamScreenshots.updatedAt
    }
  return out
}

/** The id a game goes by in this PC's offer: its own, but a stand-in for a game added by its .exe (no path). */
export function offeredId(game: Pick<Game, 'id' | 'source'>): string {
  return game.source === 'manual' ? `manual:${hashShort(game.id)}` : game.id
}

/**
 * What this PC offers its paired clients: every installed game, store games and games added by their .exe (they
 * stream) and ROM games (they stream, or the client downloads the files). Hidden games stay out: the owner hid them
 * here, so they are not offered either. A ROM card whose disc image went to the Recycle Bin for its recompilation
 * (Game.romRemoved) is offered with noRomFile: it syncs as before, but there is no file to download.
 */
export function hostOffer(games: Game[], options: HostOfferOptions = {}): HostGame[] {
  const offer: HostGame[] = []
  for (const game of games) {
    // A recompilation's own card (shared/recomp-play recompOnlyKey) has no file, but streams its recompilation.
    const recompOnly = playsOnlyRecomp(game)
    if ((!game.installed && !recompOnly) || game.hidden) continue
    const isRom = game.source === 'rom'
    if (!isRom && !STORES.has(game.source) && game.source !== 'manual') continue
    /* eslint-disable @typescript-eslint/no-unused-vars -- picked off so the rest is the offered record */
    const {
      installDir,
      exePath,
      romPath,
      launch,
      tracking,
      user,
      extra,
      media,
      remote,
      installSize,
      romRemoved,
      ...rest
    } = game
    /* eslint-enable @typescript-eslint/no-unused-vars */
    const entry: HostGame = {
      ...rest,
      metadata: portableMetadata(game.metadata),
      mediaKinds: mediaKindsOf(game)
    }
    const revs = mediaRevsOf(game)
    if (Object.keys(revs).length) entry.mediaRevs = revs
    // A game added by its .exe is known by the exe's path ("manual:c:/users/<name>/…"): clients get a stand-in.
    if (game.source === 'manual') {
      entry.id = offeredId(game)
      entry.externalId = entry.id.slice('manual:'.length)
    }
    const title = user?.titleOverride?.trim()
    if (title) entry.user = { titleOverride: title }
    if (isRom) entry.systemId = romSystemId(game)
    if (romRemoved || recompOnly) entry.noRomFile = true
    const size = romRemoved || recompOnly ? undefined : knownSize(game, options)
    if (size !== undefined) entry.sizeBytes = size
    const achievements = sanitizeAchievementsSummary(game.metadata?.achievements)
    if (achievements) entry.achievements = achievements
    if (isRom && !romRemoved && !recompOnly) {
      const raHash = options.raHash?.(game)?.toLowerCase()
      if (raHash && RA_HASH.test(raHash)) entry.raHash = raHash
    }
    offer.push(entry)
  }
  return offer
}

// ---------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------

const ROMAN: Record<string, string> = {
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  xi: '11',
  xii: '12',
  xiii: '13',
  xiv: '14',
  xv: '15',
  xvi: '16',
  xvii: '17',
  xviii: '18',
  xix: '19',
  xx: '20'
}

/**
 * The matching key of a title, the same idea as the renderer's copyKey but looser so the two PCs' stores agree:
 * lower case, accents and ™ ® © gone, bracketed tags gone ("(USA)", "[!]"), '&' read as "and", a leading or trailing
 * ", The" article dropped, roman numerals II-XX read as numbers ("Final Fantasy VII" = "Final Fantasy 7"), then only
 * letters and digits ("Spider-Man" = "Spiderman"). "I" and "X" stay letters: "Mega Man X" and "Mega Man 10" are two
 * different games. Empty when nothing is left.
 */
export function titleKey(title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[™®©]/g, '')
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/,\s*(the|a|an)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0)
  if (words.length > 1 && ['the', 'a', 'an'].includes(words[0])) words.shift()
  return words.map((w) => ROMAN[w] ?? w).join('')
}

function releaseYear(metadata: GameMetadata | undefined): number | null {
  const match = /^(\d{4})/.exec(metadata?.releaseDate ?? '')
  return match ? Number(match[1]) : null
}

function yearsAgree(a: GameMetadata | undefined, b: GameMetadata | undefined): boolean {
  const ya = releaseYear(a)
  const yb = releaseYear(b)
  return ya === null || yb === null || Math.abs(ya - yb) <= 1
}

/** Every title key a game answers to: its scanned title and the user's title. */
function keysOf(game: { title: string; user?: { titleOverride?: string } }): string[] {
  const keys = new Set<string>()
  for (const t of [game.title, game.user?.titleOverride]) {
    if (typeof t !== 'string') continue
    const key = titleKey(t)
    if (key) keys.add(key)
  }
  return [...keys]
}

/**
 * A host's card for a recompilation whose game is not in its library (LibraryService.addRecompGame names it
 * "Recompilations/<title key>"): no ROM file, so it is the same game as a ROM of its system by title.
 */
export function isRecompCard(game: Pick<Game, 'source' | 'externalId'>): boolean {
  return game.source === 'rom' && game.externalId.startsWith('Recompilations/')
}

type Matchable = Pick<
  Game,
  'id' | 'source' | 'platformId' | 'externalId' | 'title' | 'metadata'
> & {
  user?: { titleOverride?: string }
}

/** A ROM's file name without its folder or extension, lower case ("snes/Game (USA).sfc" -> "game (usa)"). */
export function romStem(externalId: string): string {
  const parts = externalId.replace(/\\/g, '/').split('/').filter(Boolean)
  const file = parts.pop() ?? ''
  // A trimmed Xbox image ("Halo.xiso.iso", what Trim Games and Convert make of "Halo.iso") is the same game.
  let name = withoutXisoSuffix(file.replace(/\.[^.]*$/, ''))
  // A game folder's fixed executable or launcher (a PS4 dump's eboot.bin, an Xbox game's default.xbe, a DOS game's
  // GAME.BAT) is named by its folder. Never a disc or cartridge image: "PS2/Favorites 1/Game.iso" is the game "game",
  // not the sub-folder it is sorted into.
  const ext = file.slice(name.length).toLowerCase()
  if (
    GENERIC_ROM_FILES.has(name.toLowerCase()) &&
    (LAUNCHER_EXTENSIONS.has(ext) || GAME_FOLDER_EXECUTABLES.has(file.toLowerCase())) &&
    parts.length > 1
  )
    name = parts.pop()!.replace(/\.[^.]*$/, '')
  return (
    name
      .toLowerCase()
      // One game whatever its discs or tracks are called: "Game (Disc 1).cue" is the "Game.m3u" playlist's game.
      .replace(/[\s._-]*[([]?\b(?:disc|disk|cd|track)\s*\d+[)\]]?/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** File names a game folder's executable or launcher always has: the folder names the game. */
const GENERIC_ROM_FILES = new Set(['eboot', 'default', 'boot', 'main', 'game', 'index', 'start'])

/** Extensions of executables, launchers and scripts (never a disc or cartridge image). */
const LAUNCHER_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.lnk',
  '.url',
  '.conf',
  '.sh',
  '.html',
  '.htm',
  '.xbe',
  '.xex',
  '.dol',
  '.elf',
  '.self',
  '.rpx'
])

/** Exact launch files whose extension is also used by images (.bin): a PS4 dump's eboot.bin. */
const GAME_FOLDER_EXECUTABLES = new Set(['eboot.bin', 'boot.bin'])

/** Index of games by the keys a host game can match on. */
class MatchIndex<T extends Matchable> {
  private readonly byId = new Map<string, T[]>()
  private readonly pcByTitle = new Map<string, T[]>()
  private readonly romByExternal = new Map<string, T[]>()
  private readonly romByStem = new Map<string, T[]>()
  private readonly romByTitle = new Map<string, T[]>()
  private readonly recompCardByTitle = new Map<string, T[]>()

  add(game: T): void {
    push(this.byId, game.id, game)
    if (game.source === 'rom') {
      push(this.romByExternal, `${game.platformId}|${game.externalId.toLowerCase()}`, game)
      const stem = romStem(game.externalId)
      if (stem) push(this.romByStem, `${game.platformId}|${stem}`, game)
      // Indexed by title only to meet a recompilation card (the other way round, in find).
      for (const key of keysOf(game)) push(this.romByTitle, `${game.platformId}|${key}`, game)
      if (isRecompCard(game))
        for (const key of keysOf(game))
          push(this.recompCardByTitle, `${game.platformId}|${key}`, game)
    } else {
      for (const key of keysOf(game)) push(this.pcByTitle, key, game)
    }
  }

  /** Every indexed game that is the same game as `game`, in the order they were added. */
  find(game: Matchable): T[] {
    const found = new Set<T>(this.byId.get(game.id) ?? [])
    if (game.source === 'rom') {
      const external = `${game.platformId}|${game.externalId.toLowerCase()}`
      for (const g of this.romByExternal.get(external) ?? []) found.add(g)
      // The same ROM file name (any format: "Game (USA).chd" is "Game (USA).cue"), never just the title: the
      // "(Europe)" and "(USA)" releases, revisions and hacks are different ROMs, each shown.
      const stem = romStem(game.externalId)
      for (const g of (stem && this.romByStem.get(`${game.platformId}|${stem}`)) || []) found.add(g)
      // A recompilation's card has no ROM file: it is the same game as a ROM of its system by title (and year), the
      // host's card and this PC's ROM or this PC's card and the host's ROM.
      const byTitle = isRecompCard(game) ? this.romByTitle : this.recompCardByTitle
      for (const key of keysOf(game))
        for (const g of byTitle.get(`${game.platformId}|${key}`) ?? [])
          if (yearsAgree(g.metadata, game.metadata)) found.add(g)
    } else {
      for (const key of keysOf(game)) {
        for (const g of this.pcByTitle.get(key) ?? []) {
          // Two products from one store are two games even under one title (Steam has Doom 1993 and Doom 2016): a
          // missing year must not fold them together. Same-store copies only match by id, above.
          if (g.source === 'rom' || g.source === game.source) continue
          if (yearsAgree(g.metadata, game.metadata)) found.add(g)
        }
      }
    }
    return [...found]
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** The URL the renderer loads a host's image from; the media protocol fetches it through the host connection. */
export function remoteMediaUrl(
  hostId: string,
  hostGameId: string,
  kind: string,
  rev?: string
): string {
  const url = `media://remote/${encodeURIComponent(hostId)}/${encodeURIComponent(hostGameId)}/${kind}`
  // The host's revision of the image: a replaced image has another URL, so no cache keeps showing the old one.
  return rev ? `${url}?v=${rev}` : url
}

/** The id a host-only game has on this PC. */
export function remoteGameId(hostId: string, hostGameId: string): string {
  return `remote:${hostId}:${hostGameId}`
}

/**
 * What a host id may look like. Host game ids contain colons, so `remote:<hostId>:<hostGameId>` only parses back when
 * host ids never do; `buildRemoteLibrary` skips a host whose id breaks this rather than let it pose as another host.
 */
export const HOST_ID = /^[A-Za-z0-9._-]{1,128}$/

/** Longest host game id accepted; real ones are a source plus a store id or a hash. */
const MAX_HOST_GAME_ID = 512

/** Parses `remote:<hostId>:<hostGameId>` (host game ids contain colons; host ids never do). */
export function parseRemoteGameId(id: string): { hostId: string; hostGameId: string } | null {
  const match = /^remote:([^:]+):([\s\S]+)$/.exec(id)
  return match ? { hostId: match[1], hostGameId: match[2] } : null
}

const MEDIA_KIND = /^(cover|hero|logo|icon|screenshot\d)$/

function str(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter(str)
  return list.length > 0 ? list : undefined
}

/** The metadata fields the renderer reads, each with the type it expects; anything else is dropped. */
/** A host game's controller / VR support (GameMetadata.steamTags.controls), only the values PlayOut knows. */
function controlsFrom(raw: unknown): { controls: SteamControls } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const c = raw as Record<string, unknown>
  const controller = c.controller === 'full' || c.controller === 'partial' ? c.controller : null
  const vr = c.vr === 'only' || c.vr === 'supported' ? c.vr : null
  return {
    controls: {
      controller,
      vr,
      ...(c.touch === 'supported' ? { touch: 'supported' } : {}),
      ...(c.keyboard === 'full' ? { keyboard: 'full' } : {}),
      ...(c.lightgun === 'supported' ? { lightgun: 'supported' } : {})
    }
  }
}

function sanitizeMetadata(raw: unknown): GameMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const m = raw as Record<string, unknown>
  const out: GameMetadata = {}
  // Capped: a host's text ends up in this PC's own library (copied into its games), so none may be outsized.
  const limits = {
    description: 64_000,
    shortDescription: 2_000,
    releaseDate: 64,
    updatedAt: 64
  } as const
  for (const key of ['description', 'shortDescription', 'releaseDate', 'updatedAt'] as const) {
    const v = m[key]
    if (str(v)) out[key] = v.slice(0, limits[key])
  }
  for (const key of ['developers', 'publishers', 'genres', 'tags'] as const) {
    const list = strings(m[key])
    if (list) out[key] = list.slice(0, 50).map((s) => s.slice(0, 200))
  }
  if (typeof m.rating === 'number' && Number.isFinite(m.rating) && m.rating >= 0 && m.rating <= 100)
    out.rating = m.rating
  if (str(m.players) && m.players.length <= 32) out.players = m.players
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
  const obj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  const hltb = obj(m.hltb)
  if (hltb) {
    const kept: NonNullable<GameMetadata['hltb']> = {}
    for (const key of ['main', 'extra', 'completionist', 'solo', 'rules'] as const) {
      const v = num(hltb[key])
      if (v !== undefined) kept[key] = v
    }
    if (typeof hltb.combined === 'boolean') kept.combined = hltb.combined
    if (str(hltb.updatedAt)) kept.updatedAt = hltb.updatedAt
    if (Object.keys(kept).length) out.hltb = kept
  }
  const players = obj(m.localPlayers)
  if (players) {
    const kept: NonNullable<GameMetadata['localPlayers']> = {}
    const max = num(players.max)
    if (max !== undefined) kept.max = max
    if (typeof players.coop === 'boolean') kept.coop = players.coop
    const lb = num(players.launchboxId)
    if (lb !== undefined) kept.launchboxId = lb
    if (str(players.updatedAt)) kept.updatedAt = players.updatedAt
    if (Object.keys(kept).length) out.localPlayers = kept
  }
  // LaunchBox's genres, shown instead of `genres` for a game that is not a Steam game (shared/genres.ts).
  const lbGenres = obj(m.launchboxGenres)
  if (lbGenres) {
    const kept: NonNullable<GameMetadata['launchboxGenres']> = {}
    const list = strings(lbGenres.genres)
    if (list) kept.genres = list.slice(0, 10).map((s) => s.slice(0, 60))
    const lb = num(lbGenres.launchboxId)
    if (lb !== undefined) kept.launchboxId = lb
    if (str(lbGenres.updatedAt)) kept.updatedAt = lbGenres.updatedAt.slice(0, 64)
    if (str(lbGenres.missedAt)) kept.missedAt = lbGenres.missedAt.slice(0, 64)
    if (Object.keys(kept).length) out.launchboxGenres = kept
  }
  const review = obj(m.reviewScore)
  if (review && num(review.score) !== undefined) {
    const kept: NonNullable<GameMetadata['reviewScore']> = { score: num(review.score) }
    if (review.source === 'steam' || review.source === 'igdb') kept.source = review.source
    const count = num(review.count)
    if (count !== undefined) kept.count = count
    if (str(review.label) && review.label.length <= 64) kept.label = review.label
    if (str(review.updatedAt)) kept.updatedAt = review.updatedAt
    out.reviewScore = kept
  }
  // Filters > Difficulty: the host's (or its cloud's) pick, a known level only; none = Medium here too.
  if (isDifficultyId(m.difficulty)) out.difficulty = m.difficulty
  const steamTags = obj(m.steamTags)
  const tagList = steamTags ? strings(steamTags.tags) : undefined
  // A record with no tags still counts for its Workshop answer (a game whose page asked Steam: checkWorkshop).
  if (steamTags && (tagList || typeof steamTags.workshop === 'boolean'))
    out.steamTags = {
      tags: (tagList ?? []).slice(0, 50),
      ...(str(steamTags.updatedAt) ? { updatedAt: steamTags.updatedAt } : {}),
      ...(controlsFrom(steamTags.controls) ?? {}),
      // The game page's Workshop link: shown only when the host knows the app has one.
      ...(typeof steamTags.workshop === 'boolean' ? { workshop: steamTags.workshop } : {})
    }
  const shots = obj(m.steamScreenshots)
  if (shots && Array.isArray(shots.items)) {
    // Steam's own image servers only: these addresses are downloaded from on this PC.
    const https = (v: unknown): v is string => {
      if (!str(v) || v.length > 500) return false
      try {
        const url = new URL(v)
        const host = url.hostname.toLowerCase()
        return (
          url.protocol === 'https:' &&
          ['steamstatic.com', 'akamaihd.net', 'steampowered.com', 'steamusercontent.com'].some(
            (h) => host === h || host.endsWith(`.${h}`)
          )
        )
      } catch {
        return false
      }
    }
    const items = shots.items
      .map((i) => obj(i))
      .filter((i): i is Record<string, unknown> => !!i && https(i.thumbnail) && https(i.full))
      .slice(0, 50)
      .map((i) => ({ thumbnail: i.thumbnail as string, full: i.full as string }))
    if (items.length)
      out.steamScreenshots = { items, updatedAt: str(shots.updatedAt) ? shots.updatedAt : '' }
  }
  if (m.links && typeof m.links === 'object') {
    const links = m.links as Record<string, unknown>
    const kept: NonNullable<GameMetadata['links']> = {}
    if (str(links.store) && /^https?:\/\//i.test(links.store)) kept.store = links.store
    if (str(links.website) && /^https?:\/\//i.test(links.website)) kept.website = links.website
    if (kept.store || kept.website) out.links = kept
  }
  if (m.sources && typeof m.sources === 'object' && !Array.isArray(m.sources)) {
    // Match ids and art bookkeeping keys only ("igdb", "art:cover"), short, and a few dozen at most.
    const sources = Object.entries(m.sources as Record<string, unknown>)
      .filter(
        (e): e is [string, string] =>
          /^[a-z0-9:_-]{1,48}$/i.test(e[0]) && str(e[1]) && e[1].length <= 500
      )
      .slice(0, 64)
    if (sources.length > 0) out.sources = Object.fromEntries(sources)
  }
  return out
}

/**
 * A host game as received, checked field by field: the offer comes over the network, so a broken or hostile host
 * must not be able to hand the renderer a game with a missing title or an unknown source. Null when unusable.
 */
export function sanitizeHostGame(raw: unknown): HostGame | null {
  if (!raw || typeof raw !== 'object') return null
  const g = raw as Record<string, unknown>
  if (!str(g.id) || !str(g.title) || !str(g.platformId) || typeof g.externalId !== 'string')
    return null
  // The id goes into remote ids, media urls and requests back to the host.
  // eslint-disable-next-line no-control-regex
  if (g.id.length > MAX_HOST_GAME_ID || /[\u0000-\u001f\u007f]/.test(g.id)) return null
  if (typeof g.source !== 'string' || !SOURCES.has(g.source)) return null
  const metadata = sanitizeMetadata(g.metadata)
  const user = g.user as { titleOverride?: unknown } | undefined
  const kinds = Array.isArray(g.mediaKinds) ? g.mediaKinds : []
  // An older host titled a trimmed Xbox image by its file name less only ".iso" ("Halo.xiso"): the game's name is
  // "Halo" here (recompilation matching, copies, search), whatever version the host runs.
  const title = g.source === 'rom' ? withoutXisoSuffix(g.title) : g.title
  const renamed = title !== g.title
  const game: HostGame = {
    id: g.id,
    source: g.source as SourceId,
    externalId: g.externalId,
    platformId: g.platformId,
    title,
    sortTitle: renamed ? sortTitle(title) : str(g.sortTitle) ? g.sortTitle : g.title.toLowerCase(),
    installed: true,
    hidden: false,
    // The host's favourite (the favourites sync shows it on a host-only game's card; rebuild() drops it while the sync
    // is off here).
    favorite: g.favorite === true,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: str(g.addedAt) ? g.addedAt : '',
    metadata,
    metadataStatus: g.metadataStatus === 'done' ? 'done' : 'none',
    mediaKinds: [...new Set(kinds.filter((k): k is string => str(k) && MEDIA_KIND.test(k)))]
  }
  if (user && typeof user === 'object' && str(user.titleOverride)) {
    game.user = { titleOverride: user.titleOverride }
  }
  if (g.mediaRevs && typeof g.mediaRevs === 'object' && !Array.isArray(g.mediaRevs)) {
    const revs: Record<string, string> = {}
    for (const kind of game.mediaKinds) {
      const rev = (g.mediaRevs as Record<string, unknown>)[kind]
      if (str(rev) && MEDIA_REV.test(rev)) revs[kind] = rev
    }
    if (Object.keys(revs).length) game.mediaRevs = revs
  }
  if (str(g.systemId)) game.systemId = g.systemId
  if (g.noRomFile === true) game.noRomFile = true
  // When the host's copy was last played, on the host's clock (lastPlayedHere puts it on this PC's). Its play time and
  // play count stay the host's own.
  if (str(g.lastPlayed) && g.lastPlayed.length <= 40 && Number.isFinite(Date.parse(g.lastPlayed)))
    game.lastPlayed = g.lastPlayed
  if (str(g.favoriteAt) && g.favoriteAt.length <= 40 && Number.isFinite(Date.parse(g.favoriteAt)))
    game.favoriteAt = g.favoriteAt
  const size = positive(g.sizeBytes)
  if (size !== undefined) game.sizeBytes = size
  const achievements = sanitizeAchievementsSummary(g.achievements)
  if (achievements) game.achievements = achievements
  if (game.source === 'rom' && typeof g.raHash === 'string' && RA_HASH.test(g.raHash))
    game.raHash = g.raHash
  return game
}

export interface HostOfferInput {
  hostId: string
  hostName: string
  /** Not reachable now: these are the games it offered when last reached. */
  offline?: boolean
  /** The host's offer as received; entries are checked with `sanitizeHostGame`. */
  games: unknown[]
  /**
   * The host's clock minus this PC's, in ms (its games' last played are dated on the host's clock). Undefined: the
   * host sent no clock with its offer, an older PlayOut. Its games then show no last played: that host cannot leave
   * the dates out while its own play time sync is off, so they are not this PC's to show.
   */
  skewMs?: number
}

/** A last played dated further ahead than this (on this PC's clock) is dropped: a wrong clock, not a play. */
const MAX_LAST_PLAYED_AHEAD_MS = 24 * 60 * 60 * 1000
/** Clock differences below this are the request's own timing: ignored (as the play time sync does). */
const MIN_SKEW_MS = 1000

/**
 * When a host's game was last played, on this PC's clock: `iso` is the host's own time (`skewMs` = the host's clock
 * minus this PC's). Undefined for none, one that is no date, or one more than a day ahead of `nowMs`. One less far
 * ahead (the clocks disagree, or the date was never on the host's clock: a store's own last played) is taken as now:
 * a host's date never outranks a play made on this PC in Recent or Sort > Recently played.
 */
export function lastPlayedHere(
  iso: string | undefined,
  nowMs: number,
  skewMs = 0
): string | undefined {
  if (!iso) return undefined
  const skew = Number.isFinite(skewMs) && Math.abs(skewMs) >= MIN_SKEW_MS ? skewMs : 0
  const at = Date.parse(iso) - skew
  if (!Number.isFinite(at) || at < 0 || at > nowMs + MAX_LAST_PLAYED_AHEAD_MS) return undefined
  return new Date(Math.min(at, nowMs)).toISOString()
}

/** When `host` last played its `game`, on this PC's clock; none from a host that sent no clock (HostOfferInput.skewMs). */
function playedOnHost(host: HostOfferInput, game: HostGame, nowMs: number): string | undefined {
  return host.skewMs === undefined ? undefined : lastPlayedHere(game.lastPlayed, nowMs, host.skewMs)
}

/** `card` with a later last played, when `played` is one (a game several hosts have: the latest of them). */
function raiseLastPlayed(card: Game, played: string | undefined): void {
  if (played && (!card.lastPlayed || played > card.lastPlayed)) card.lastPlayed = played
}

function infoFor(host: HostOfferInput, game: HostGame): RemoteGameInfo {
  const info: RemoteGameInfo = {
    hostId: host.hostId,
    hostName: host.hostName,
    hostGameId: game.id,
    streamable: true,
    downloadable: game.source === 'rom' && !game.noRomFile
  }
  if (host.offline) info.offline = true
  if (game.sizeBytes !== undefined) info.sizeBytes = game.sizeBytes
  if (game.raHash) info.raHash = game.raHash
  return info
}

function mediaFor(hostId: string, game: HostGame): GameMedia {
  const media: GameMedia = {}
  const kinds = new Set(game.mediaKinds)
  for (const kind of ART_KINDS) {
    if (kinds.has(kind)) media[kind] = remoteMediaUrl(hostId, game.id, kind, game.mediaRevs?.[kind])
  }
  const shots: string[] = []
  for (let i = 0; i < MAX_REMOTE_SCREENSHOTS; i++) {
    const kind = `screenshot${i}`
    if (kinds.has(kind)) shots.push(remoteMediaUrl(hostId, game.id, kind, game.mediaRevs?.[kind]))
  }
  if (shots.length > 0) media.screenshots = shots
  return media
}

/**
 * A host's game as this PC would show it, with its download / stream facts (streaming-service: a recompilation card's
 * original on a host is matched and downloaded through it even when it is folded into a local card).
 */
export function hostGameAsGame(host: HostOfferInput, game: HostGame, now: string): Game {
  return toRemoteGame(host, game, infoFor(host, game), now)
}

/**
 * A host-only game as this PC shows it. Per-PC facts (playtime, hidden) start empty: they belong to whoever plays
 * here. Its favourite is the host's (the favourites sync makes it a favourite there), and so
 * are its achievements (host-achievements.ts) and when it was last played (the host's last played counts its own play,
 * a stream to any client and the sessions its other clients sent it; Home's Recent row and Sort > Recently played go
 * by it, and rebuild() drops it while the play time sync is off here). Launch and tracking are inert placeholders; Stream and Download go through the streaming service.
 */
function toRemoteGame(
  host: HostOfferInput,
  game: HostGame,
  info: RemoteGameInfo,
  now: string
): Game {
  const remote: Game = {
    id: remoteGameId(host.hostId, game.id),
    source: game.source,
    externalId: game.externalId,
    platformId: game.platformId,
    title: game.title,
    sortTitle: game.sortTitle,
    installed: false,
    owned: false,
    launch: { kind: 'uri', uri: '' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: game.favorite,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: game.addedAt || now,
    // The host's achievement counts show as a game's own do (the full list comes from the host when opened).
    metadata: game.achievements
      ? { ...game.metadata, achievements: { ...game.achievements, updatedAt: now } }
      : game.metadata,
    media: mediaFor(host.hostId, game),
    metadataStatus: game.metadataStatus,
    user: {},
    remote: info
  }
  if (game.user?.titleOverride) remote.user = { titleOverride: game.user.titleOverride }
  raiseLastPlayed(remote, playedOnHost(host, game, Date.parse(now)))
  return remote
}

/**
 * Only a copy that is surely the same game fills this PC's data from a host's (its metadata and art):
 * the same id (the same store game), a ROM of the same file, or a game whose release years are both known and agree.
 * A title alone ("Doom": 1993 or 2016?) is not enough.
 */
export function surelySameGame(
  mine: Pick<Game, 'id' | 'source' | 'metadata'>,
  theirs: Pick<HostGame, 'id' | 'metadata'>
): boolean {
  if (mine.id === theirs.id || mine.source === 'rom') return true
  const a = releaseYear(mine.metadata)
  const b = releaseYear(theirs.metadata)
  return a !== null && b !== null && Math.abs(a - b) <= 1
}

/**
 * This PC's games that are the same game as each of a host's, by the host's game id: exactly the matches
 * buildRemoteLibrary folds (a host game shown as this PC's card, the host in its alsoOnHost), so the favourites and
 * play time sync every game the Library shows as one, and no other. Host games none of this PC's match are left out
 * (they are `remote:` cards, whose favourite is the host's).
 */
export function localMatches(clientGames: Game[], hostGames: HostGame[]): Map<string, Game[]> {
  const index = new MatchIndex<Game>()
  for (const game of clientGames) index.add(game)
  const out = new Map<string, Game[]>()
  for (const game of hostGames) {
    const found = index.find(game)
    if (found.length) out.set(game.id, found)
  }
  return out
}

/**
 * Folds the paired hosts' offers into what this PC shows. A host game this PC also has (same id; PC games: same title
 * key and release years within 1; ROMs: same system and same relative path or file name) adds that host to
 * `alsoOnHost[localId]` for every matching local copy, and no card of its own. The rest become `remote:` games; a game
 * several hosts have becomes one card, from the first host by name, and then `alsoOnHost[remoteId]` lists every host
 * that has it (the card's own host first) so the Stream menu can offer each. One host is listed once per game even when it
 * has two copies (Steam and GOG): either streams the same game.
 */
export function buildRemoteLibrary(
  clientGames: Game[],
  hosts: HostOfferInput[],
  now: Date = new Date()
): RemoteLibrary {
  const stamp = now.toISOString()
  const local = new MatchIndex<Game>()
  for (const game of clientGames) local.add(game)

  const alsoOnHost: Record<string, RemoteGameInfo[]> = {}
  const addInfo = (gameId: string, info: RemoteGameInfo): void => {
    const list = (alsoOnHost[gameId] ??= [])
    if (!list.some((i) => i.hostId === info.hostId)) list.push(info)
  }

  const games: Game[] = []
  const cards = new Map<string, Game>()
  const remoteIndex = new MatchIndex<HostGame & { cardId: string; info: RemoteGameInfo }>()
  const ordered = [...hosts].sort(
    (a, b) =>
      a.hostName.localeCompare(b.hostName, undefined, { sensitivity: 'base' }) ||
      a.hostId.localeCompare(b.hostId)
  )
  const seenHosts = new Set<string>()
  for (const host of ordered) {
    // A host listed twice (a stale entry, a renamed host) would otherwise duplicate every card.
    if (!HOST_ID.test(host.hostId) || seenHosts.has(host.hostId)) continue
    seenHosts.add(host.hostId)
    const seenIds = new Set<string>()
    for (const raw of host.games) {
      const game = sanitizeHostGame(raw)
      if (!game || seenIds.has(game.id)) continue
      seenIds.add(game.id)
      const info = infoFor(host, game)

      const mine = local.find(game)
      if (mine.length > 0) {
        for (const g of mine) addInfo(g.id, info)
        continue
      }
      const card = remoteIndex.find(game)[0]
      if (card) {
        // One card for every host's copy (and a host's two copies): last played is the latest of them.
        const shown = cards.get(card.cardId)
        if (shown) raiseLastPlayed(shown, playedOnHost(host, game, now.getTime()))
        if (card.info.hostId !== info.hostId) {
          addInfo(card.cardId, card.info)
          addInfo(card.cardId, info)
        }
        continue
      }
      const remote = toRemoteGame(host, game, info, stamp)
      games.push(remote)
      cards.set(remote.id, remote)
      remoteIndex.add({ ...game, cardId: remote.id, info })
    }
  }

  return { games, alsoOnHost, updatedAt: stamp }
}

/**
 * A host-only game with this PC's own Steam Workshop answer (SteamTagsService.remoteWorkshop: its page asked Steam)
 * when the host sent none. The host's own true / false always wins.
 */
export function withRemoteWorkshop(game: Game, workshop: boolean | undefined): Game {
  if (workshop === undefined || !game.remote) return game
  if (game.metadata.steamTags?.workshop !== undefined) return game
  return {
    ...game,
    metadata: {
      ...game.metadata,
      steamTags: { ...(game.metadata.steamTags ?? { tags: [] }), workshop }
    }
  }
}

/** This PC's own RetroAchievements answer for a host's ROM (main achievements-service.ts remoteRetro). */
export type RemoteRetroAnswer =
  { none: true } | { raId: number; unlocked: number; total: number; updatedAt: string }

/**
 * A host-only ROM with this PC's own RetroAchievements answer laid over the host's: its counts and game id, or its
 * "none" (the stat goes). The host's counts stay when this PC has no answer, and on a ROM whose counts are the host's
 * recompilation's.
 */
export function withRemoteRetro(game: Game, answer: RemoteRetroAnswer | undefined): Game {
  if (!answer || game.source !== 'rom' || !game.remote) return game
  if (game.metadata.sources?.[RECOMP_ACHIEVEMENTS_KEY]) return game
  const metadata: GameMetadata = { ...game.metadata, sources: { ...game.metadata.sources } }
  if ('none' in answer) {
    delete metadata.achievements
    metadata.sources!.retroachievements = 'none'
  } else {
    metadata.achievements = {
      unlocked: answer.unlocked,
      total: answer.total,
      updatedAt: answer.updatedAt
    }
    metadata.sources!.retroachievements = String(answer.raId)
  }
  return { ...game, metadata }
}
