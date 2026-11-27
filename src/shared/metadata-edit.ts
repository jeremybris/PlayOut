import { withoutXisoSuffix } from './convert'
import { gameGenres } from './genres'
import type { DifficultyLevel, Game, GameMetadata, GameUserData } from './types'

/**
 * Metadata corrections (the game page's Edit sheet). A game's metadata comes in three layers, per field:
 *
 *   scraped (game.metadata, written by the scrapers)  <  cloud (the PlayOut-metadata repository)  <  local edit
 *
 * The scraped layer stays as the scrapers left it in library.json: every metadata writer keeps updating it, so a
 * field whose edit is removed falls straight back to fresh scraped values. The other two layers are laid over it when
 * a game leaves the main process (LibraryService.view / effectiveGame): the game page, the filters and the search all
 * see the effective values, and nothing a scraper writes can replace a field a cloud entry or a local edit sets.
 *
 * Media (cover, hero, logo) is not part of this: it stays local, with the custom artwork pickers.
 */

/** Every editable field, in the Edit sheet's order. */
export const METADATA_EDIT_FIELDS = [
  'title',
  'description',
  'shortDescription',
  'releaseDate',
  'developers',
  'publishers',
  'genres',
  'tags',
  'localPlayers',
  'controls',
  'hltb',
  'reviewScore',
  'difficulty'
] as const

export type MetadataEditField = (typeof METADATA_EDIT_FIELDS)[number]

export type ControllerSupport = 'full' | 'partial' | 'none'
export type VrSupport = 'only' | 'supported' | 'none'
export type ReviewSource = 'steam' | 'igdb'

/**
 * A game's controls as an edit sets them (MetadataEdit.controls): Steam's controller and VR support, plus `touch`
 * (touch screen support) and `keyboard` (full mouse and keyboard support alongside a controller), each only present
 * when true. An entry without them (one an older PlayOut wrote) has neither.
 */
export interface ControlsEdit {
  controller: ControllerSupport
  vr: VrSupport
  touch?: boolean
  keyboard?: boolean
}

/**
 * The Edit sheet's Controls choices, in its order: VR, Touch, Full Controller Support, Partial Controller Support,
 * Mouse & Keyboard, Mouse & Keyboard + Controller ('both') and All (VR, full controller and mouse and keyboard).
 */
export const CONTROLS_CHOICES = [
  'vr',
  'touch',
  'full',
  'partial',
  'keyboard',
  'both',
  'all'
] as const
export type ControlsChoice = (typeof CONTROLS_CHOICES)[number]

/** The controls a choice saves (always the same for a choice, so it reads back as that choice). */
export function controlsForChoice(choice: ControlsChoice): ControlsEdit {
  switch (choice) {
    case 'vr':
      return { controller: 'none', vr: 'only' }
    case 'touch':
      return { controller: 'none', vr: 'none', touch: true }
    case 'full':
      return { controller: 'full', vr: 'none' }
    case 'partial':
      return { controller: 'partial', vr: 'none' }
    case 'keyboard':
      return { controller: 'none', vr: 'none' }
    case 'both':
      return { controller: 'full', vr: 'none', keyboard: true }
    case 'all':
      return { controller: 'full', vr: 'supported', keyboard: true }
  }
}

/**
 * The choice that describes a game's controls best (any controls: scraped ones too, like full controller with VR
 * supported, which shows as Full Controller Support).
 */
export function controlsChoice(c: ControlsEdit): ControlsChoice {
  if (c.touch && c.controller === 'none' && c.vr === 'none') return 'touch'
  // VR only (a headset is needed) wins over the rest, as on the badge (renderer lib/controls.ts).
  if (c.vr === 'only') return 'vr'
  if (c.controller === 'full' && c.keyboard) return c.vr === 'supported' ? 'all' : 'both'
  if (c.controller === 'full') return 'full'
  if (c.controller === 'partial') return 'partial'
  if (c.vr === 'supported') return 'vr'
  return 'keyboard'
}

/** Controls with `touch` / `keyboard` only when true (a false one says the same as none). */
export function normalizeControls(c: ControlsEdit): ControlsEdit {
  return {
    controller: c.controller,
    vr: c.vr,
    ...(c.touch ? { touch: true } : {}),
    ...(c.keyboard ? { keyboard: true } : {})
  }
}

/**
 * A set of corrected fields (a local edit or a cloud entry). A field that is present replaces the scraped value; an
 * empty one ('' / [] / 0 / no times / no score) says "the game has none" and hides the scraped value.
 */
export interface MetadataEdit {
  title?: string
  description?: string
  shortDescription?: string
  /** 'YYYY-MM-DD', 'YYYY-MM' or 'YYYY'; '' = no date. */
  releaseDate?: string
  developers?: string[]
  publishers?: string[]
  genres?: string[]
  /** The game page's tag chips and Filters › Tags (metadata.steamTags.tags). */
  tags?: string[]
  /** Most local players (metadata.localPlayers.max); 0 = none shown. */
  localPlayers?: number
  /**
   * The controls badge and Filters > Controls (metadata.steamTags.controls): one of the Edit sheet's Controls choices
   * (controlsForChoice). A console game (ROM) always shows "Pad".
   */
  controls?: ControlsEdit
  /** HowLongToBeat hours; a time left out has none. */
  hltb?: { main?: number; extra?: number; completionist?: number; solo?: number }
  /** The rating stat: 0-100 and whose wording it uses (Steam's percent positive or IGDB's rating). */
  reviewScore?: { score?: number; source?: ReviewSource }
  /**
   * Filters > Difficulty's level for the game (shared/difficulty.ts). '' = Default (Medium): no pick. Saved as a local
   * edit it still hides a cloud pick, as an empty value hides any other field, so the user can put a game back to
   * Medium.
   */
  difficulty?: DifficultyLevel | ''
}

/** Where the value of a field the game page shows comes from. */
export type MetadataOrigin = 'scraped' | 'cloud' | 'local'

/** One game's three layers, for the Edit sheet (api.getMetadataLayers). */
export interface MetadataLayers {
  /** The game's cloud key (gameMetadataKey); null when it has none (no title). */
  key: string | null
  /** The scraped values of the editable fields. */
  scraped: MetadataEdit
  /** The cloud entry's fields; null when the cloud has none for the game. */
  cloud: MetadataEdit | null
  /** This PC's own edit (localMetadataEdit). */
  local: MetadataEdit
}

// ---------------------------------------------------------------------------
// Game key: the same game on every PC
// ---------------------------------------------------------------------------

/** Lower case ASCII words joined by '-' ("Pokémon: Red & Blue" -> "pokemon-red-and-blue"); at most 120 characters. */
export function normalizeKeyText(text: string): string {
  return text
    .replace(/[™®©]/g, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '')
}

/** An id as a key part: lower case, characters other than a-z 0-9 . _ - become '-'. */
function keyId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120)
}

/** Systems whose discs carry a PlayStation-family serial (SLUS-20777, ULUS-10336, NPUB-30001). */
const PLAYSTATION_SYSTEMS = new Set([
  'psx',
  'ps1',
  'ps2',
  'psp',
  'ps3',
  'playstation',
  'playstation2'
])
/** Systems whose discs carry a GameCube / Wii GameID (GALE01, RMGE01). */
const DOLPHIN_SYSTEMS = new Set(['gc', 'gamecube', 'ngc', 'wii'])

/**
 * A disc serial in a ROM's file name, looked for only on the systems that have one: a PlayStation-family serial
 * (four letters, five digits: SLUS-20777, SLUS_207.77) or a bracketed GameCube / Wii GameID ([GALE01]: G/D/R/S, two
 * characters, a region letter and a maker code with a digit), so a tag like "(GERMAN)" or "(EUROPE)" is never one.
 */
function serialFromName(system: string, name: string): string | undefined {
  if (PLAYSTATION_SYSTEMS.has(system)) {
    const ps = /(?<![A-Z0-9])([SUNBP][A-Z]{3})[-_ .]?(\d{3})[._ ]?(\d{2})(?![0-9])/i.exec(name)
    return ps ? `${ps[1]}${ps[2]}${ps[3]}`.toUpperCase() : undefined
  }
  if (DOLPHIN_SYSTEMS.has(system)) {
    const gc = /[[(]([GDRS][A-Z0-9]{2}[A-Z](?:[0-9][0-9A-Z]|[A-Z][0-9]))[\])]/.exec(name)
    return gc?.[1]
  }
  return undefined
}

const STORE_KEY_SOURCES = new Set(['gog', 'epic', 'ea', 'ubisoft', 'battlenet', 'xbox'])
/** Key prefixes other forms own: a ROM system id that is one of them is keyed 'rom-<systemId>-…' instead. */
const RESERVED_KEY_PREFIXES = new Set(['steam', 'manual', 'rom', ...STORE_KEY_SOURCES])

/** A path's last part without its extension. */
function fileStem(path: string): string {
  const name = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? ''
  return name.replace(/\.[^.]*$/, '') || name
}

/**
 * A ROM file name as key text: tags in () and [] left out ("Zelda, The (USA) [!].sfc" -> "zelda-the"), and a trimmed
 * Xbox image's ".xiso" too (its key is the full dump's: "Halo (USA).xiso.iso" -> "halo").
 */
function romNameKeyText(fileName: string): string {
  const folder = gameFolderOf(fileName)
  const stem = folder ?? withoutXisoSuffix(fileStem(fileName))
  return normalizeKeyText(stem.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')) || normalizeKeyText(stem)
}

/**
 * File names a game folder's executable or launcher always has: the folder names the game (the same list as
 * main/streaming/remote-library.ts GENERIC_ROM_FILES).
 */
const GENERIC_ROM_FILES = new Set(['eboot', 'default', 'boot', 'main', 'game', 'index', 'start'])
/** Extensions of executables, launchers and scripts (never a disc or cartridge image), as in remote-library.ts. */
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
/** Exact launch files whose extension is also used by images (.bin): a PS4 or PS5 dump's eboot.bin. */
const GAME_FOLDER_EXECUTABLES = new Set(['eboot.bin', 'boot.bin'])

/**
 * The game folder's name when a ROM is a game folder's fixed executable or launcher (a PS4 dump's
 * "ps4/Bloodborne/eboot.bin", an Xbox game's "xbox/Halo/default.xbe"): every such game has the same file name, so the
 * folder is what tells them apart. Null for every other ROM, and for an executable lying directly in a system folder
 * ("ps4/eboot.bin"), whose folder is not a game.
 */
function gameFolderOf(path: string): string | null {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const file = parts.pop() ?? ''
  const name = file.replace(/\.[^.]*$/, '')
  const ext = file.slice(name.length).toLowerCase()
  if (!GENERIC_ROM_FILES.has(name.toLowerCase())) return null
  if (!LAUNCHER_EXTENSIONS.has(ext) && !GAME_FOLDER_EXECUTABLES.has(file.toLowerCase())) return null
  if (parts.length <= 1) return null
  return parts.pop() || null
}

/** Folders an executable sits in that do not name the game (Game/Binaries/Win64/Game-Win64-Shipping.exe). */
const GENERIC_FOLDERS = new Set([
  'bin',
  'bin32',
  'bin64',
  'binaries',
  'win32',
  'win64',
  'windows',
  'x86',
  'x64',
  'x86-64',
  'release',
  'retail',
  'shipping',
  'game',
  'games',
  'app',
  'program',
  'exe'
])

/**
 * A manual game's key text from where it is installed, not its title (scrapers and rescans rewrite that): the name of
 * the nearest folder above the executable that is not a generic one (bin, x64, Binaries…), with tags and a version
 * left out, then the executable's name ("Hollow Knight/hollow_knight.exe" -> "hollow-knight", "To the Moon/Game.exe"
 * -> "to-the-moon-game").
 */
function manualKeyText(exePath: string): string {
  const parts = exePath.replace(/\\/g, '/').split('/').filter(Boolean)
  const stem = normalizeKeyText(fileStem(parts.pop() ?? ''))
  let folder = ''
  while (parts.length > 1) {
    const name = parts.pop() ?? ''
    const text = normalizeKeyText(
      name
        .replace(/_/g, ' ')
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
        .replace(/\s+v?\d+(\.\d+)+\s*$/i, '')
    )
    if (text && !GENERIC_FOLDERS.has(text)) {
      folder = text
      break
    }
  }
  if (!folder) return stem
  if (!stem || stem === folder || GENERIC_FOLDERS.has(stem)) return folder
  // 'hollow-knight' + 'hollow-knight' / 'hollowknight': the folder alone.
  if (stem.replace(/-/g, '') === folder.replace(/-/g, '')) return folder
  return normalizeKeyText(`${folder} ${stem}`)
}

/**
 * The game's key in the metadata cloud, the same on every PC:
 *
 * - 'steam-<appid>' when a Steam app id is known;
 * - a store game's '<source>-<externalId>';
 * - a ROM's '<systemId>-<serial>' when a disc serial is known (extra.serial, or in the file name on the systems that
 *   have one), else '<systemId>-<file name>' (the ROM file's name without its tags); a system id that another form
 *   owns (steam, xbox…) gets 'rom-' in front;
 * - a manual game's 'manual-<install folder and executable name>'.
 *
 * Only scan-time identity goes in: never the title, which scrapers, rescans and edits rewrite. Null when there is
 * nothing to go by.
 */
export function gameMetadataKey(
  game: Pick<Game, 'source' | 'externalId' | 'platformId' | 'extra' | 'romPath' | 'exePath'>
): string | null {
  const rawAppId = game.extra?.steamAppId ?? (game.source === 'steam' ? game.externalId : undefined)
  const appId = rawAppId === undefined ? '' : String(rawAppId).replace(/\D/g, '')
  if (appId && Number(appId) > 0) return `steam-${Number(appId)}`
  if (STORE_KEY_SOURCES.has(game.source)) {
    const id = keyId(game.externalId ?? '')
    return id ? `${game.source}-${id}` : null
  }
  if (game.source === 'rom') {
    const system = keyId(game.platformId ?? '')
    if (!system) return null
    const prefix = RESERVED_KEY_PREFIXES.has(system) ? `rom-${system}` : system
    const extraSerial = game.extra?.serial
    const file = game.romPath || game.externalId || ''
    const serial =
      (typeof extraSerial === 'string' && extraSerial.trim() ? extraSerial : undefined) ??
      serialFromName(system, file.replace(/\\/g, '/').split('/').pop() ?? '')
    if (serial) {
      const id = keyId(serial.replace(/[-_. ]/g, ''))
      if (id) return `${prefix}-${id}`
    }
    const name = romNameKeyText(file)
    return name ? `${prefix}-${name}` : null
  }
  if (game.source === 'manual') {
    const text = manualKeyText(game.exePath || game.externalId || '')
    return text ? `manual-${text}` : null
  }
  return null
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function present<K extends MetadataEditField>(
  edit: MetadataEdit | null | undefined,
  key: K
): boolean {
  return !!edit && edit[key] !== undefined
}

/**
 * This PC's own edit of a game. The title edit is `user.titleOverride` (the scrapers look the game up by it), every
 * other field `user.metadataEdits`.
 */
export function localMetadataEdit(game: Pick<Game, 'user'>): MetadataEdit {
  const edit: MetadataEdit = { ...(game.user?.metadataEdits ?? {}) }
  delete edit.title
  const title = game.user?.titleOverride?.trim()
  if (title) edit.title = title
  return edit
}

/** The values of the editable fields as `game.metadata` (and `game.title`) has them; fields it lacks are left out. */
export function editableValues(game: Pick<Game, 'source' | 'title' | 'metadata'>): MetadataEdit {
  const meta = game.metadata ?? {}
  const out: MetadataEdit = {}
  if (game.title) out.title = game.title
  if (meta.description?.trim()) out.description = meta.description
  if (meta.shortDescription?.trim()) out.shortDescription = meta.shortDescription
  if (meta.releaseDate) out.releaseDate = meta.releaseDate
  if (meta.developers?.length) out.developers = [...meta.developers]
  if (meta.publishers?.length) out.publishers = [...meta.publishers]
  const genres = gameGenres(game)
  if (genres.length) out.genres = [...genres]
  if (meta.steamTags?.tags?.length) out.tags = [...meta.steamTags.tags]
  if (typeof meta.localPlayers?.max === 'number') out.localPlayers = meta.localPlayers.max
  const c = meta.steamTags?.controls
  if (c)
    out.controls = {
      controller: c.controller ?? 'none',
      vr: c.vr ?? 'none',
      ...(c.touch === 'supported' ? { touch: true } : {}),
      ...(c.keyboard === 'full' ? { keyboard: true } : {})
    }
  const h = meta.hltb
  if (h && (h.main || h.extra || h.completionist || h.solo)) {
    out.hltb = {}
    if (h.main) out.hltb.main = h.main
    if (h.extra) out.hltb.extra = h.extra
    if (h.completionist) out.hltb.completionist = h.completionist
    if (h.solo) out.hltb.solo = h.solo
  }
  const r = meta.reviewScore
  if (r && typeof r.score === 'number')
    out.reviewScore = { score: r.score, ...(r.source ? { source: r.source } : {}) }
  // No `difficulty`: nothing scrapes it, so without a pick it is Default (Medium), the Edit sheet's '' choice.
  return out
}

/**
 * The fields a cloud entry or a local edit sets: their effective value is not the scraped one, so nothing a metadata
 * writer stores shows for them (writers may skip the work for them).
 */
export function lockedMetadataFields(
  game: Pick<Game, 'user'>,
  cloud?: MetadataEdit | null
): Set<MetadataEditField> {
  const local = localMetadataEdit(game)
  return new Set(METADATA_EDIT_FIELDS.filter((f) => present(local, f) || present(cloud, f)))
}

/** Whether `field` of the game is locked (lockedMetadataFields). */
export function isMetadataFieldLocked(
  game: Pick<Game, 'user'>,
  cloud: MetadataEdit | null | undefined,
  field: MetadataEditField
): boolean {
  return present(localMetadataEdit(game), field) || present(cloud, field)
}

/** Where each field's effective value comes from: the local edit, else the cloud, else the scrapers. */
export function metadataOrigins(
  game: Pick<Game, 'user'>,
  cloud?: MetadataEdit | null
): Record<MetadataEditField, MetadataOrigin> {
  const local = localMetadataEdit(game)
  const out = {} as Record<MetadataEditField, MetadataOrigin>
  for (const f of METADATA_EDIT_FIELDS)
    out[f] = present(local, f) ? 'local' : present(cloud, f) ? 'cloud' : 'scraped'
  return out
}

/** `sortTitle` of main/util/text.ts (shared copy: the overlay re-sorts a cloud title). */
function sortKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const cleanList = (list: string[]): string[] => list.map((s) => s.trim()).filter(Boolean)

/** Lay `edit` over a metadata object (returns a new one; `metadata` is not changed). */
export function applyEditToMetadata(
  metadata: GameMetadata,
  edit: MetadataEdit,
  source?: Game['source']
): GameMetadata {
  const m: GameMetadata = { ...metadata }
  const text = (key: 'description' | 'shortDescription' | 'releaseDate'): void => {
    const value = edit[key]
    if (value === undefined) return
    if (value.trim()) m[key] = value
    else delete m[key]
  }
  text('description')
  text('shortDescription')
  text('releaseDate')
  for (const key of ['developers', 'publishers'] as const) {
    const value = edit[key]
    if (value === undefined) continue
    const list = cleanList(value)
    if (list.length) m[key] = list
    else delete m[key]
  }
  if (edit.genres !== undefined) {
    const list = cleanList(edit.genres)
    if (list.length) m.genres = list
    else delete m.genres
    // A ROM shows LaunchBox's genres first (shared/genres.ts): the edit replaces those too.
    if (m.launchboxGenres || source === 'rom') {
      const lb = { ...(m.launchboxGenres ?? {}) }
      if (list.length) lb.genres = list
      else delete lb.genres
      m.launchboxGenres = lb
    }
  }
  if (edit.tags !== undefined || edit.controls !== undefined) {
    const st = { ...(m.steamTags ?? { tags: [] }) }
    if (edit.tags !== undefined) st.tags = cleanList(edit.tags)
    if (edit.controls !== undefined)
      st.controls = {
        controller: edit.controls.controller === 'none' ? null : edit.controls.controller,
        vr: edit.controls.vr === 'none' ? null : edit.controls.vr,
        // Touch and full mouse and keyboard come from the edit too: an edit without them clears them.
        ...(edit.controls.touch ? { touch: 'supported' as const } : {}),
        ...(edit.controls.keyboard ? { keyboard: 'full' as const } : {})
      }
    m.steamTags = st
  }
  if (edit.localPlayers !== undefined) {
    const lp = { ...(m.localPlayers ?? {}) }
    if (edit.localPlayers > 0) lp.max = edit.localPlayers
    else delete lp.max
    m.localPlayers = lp
  }
  if (edit.hltb !== undefined) {
    const h = { ...(m.hltb ?? {}) }
    for (const key of ['main', 'extra', 'completionist', 'solo'] as const) {
      const value = edit.hltb[key]
      if (typeof value === 'number' && value > 0) h[key] = value
      else delete h[key]
    }
    delete h.combined
    delete h.missedAt
    m.hltb = h
  }
  if (edit.reviewScore !== undefined) {
    const r: NonNullable<GameMetadata['reviewScore']> = {}
    if (m.reviewScore?.updatedAt) r.updatedAt = m.reviewScore.updatedAt
    if (edit.reviewScore.source) r.source = edit.reviewScore.source
    if (typeof edit.reviewScore.score === 'number') r.score = edit.reviewScore.score
    m.reviewScore = r
  }
  if (edit.difficulty !== undefined) {
    // '' (Default) is no pick: the game is Medium, even over a cloud pick laid on before it.
    if (edit.difficulty) m.difficulty = edit.difficulty
    else delete m.difficulty
  }
  return m
}

/**
 * The game as PlayOut shows it: the cloud entry, then the local edit, laid over the scraped metadata (see the top of
 * this file). Returns `game` itself when neither has anything for it; otherwise a copy (the stored game is untouched).
 * The local title stays `user.titleOverride` (displayTitle); a cloud title becomes `title` / `sortTitle`.
 */
export function effectiveGame<G extends Game>(game: G, cloud?: MetadataEdit | null): G {
  const local = game.user?.metadataEdits
  const hasLocal = !!local && Object.keys(local).length > 0
  const hasCloud = !!cloud && Object.keys(cloud).length > 0
  if (!hasLocal && !hasCloud) return game
  let metadata = game.metadata ?? {}
  const out = { ...game }
  if (hasCloud) {
    metadata = applyEditToMetadata(metadata, cloud, game.source)
    const title = cloud.title?.trim()
    if (title) {
      out.title = title
      out.sortTitle = sortKey(title)
    }
  }
  if (hasLocal) {
    const rest = { ...local }
    delete rest.title
    metadata = applyEditToMetadata(metadata, rest, game.source)
  }
  out.metadata = metadata
  return out
}

// ---------------------------------------------------------------------------
// Changing a local edit
// ---------------------------------------------------------------------------

/**
 * The user data with `edit` merged into the game's local edit (fields of `edit` replace the same fields; the title
 * goes to `titleOverride`, an empty title removes it). Returns a new object.
 */
export function withMetadataEdit(user: GameUserData, edit: MetadataEdit): GameUserData {
  const next: GameUserData = { ...user }
  const edits: MetadataEdit = { ...(user.metadataEdits ?? {}) }
  for (const field of METADATA_EDIT_FIELDS) {
    const value = edit[field]
    if (value === undefined) continue
    if (field === 'title') {
      const title = (value as string).trim()
      if (title) next.titleOverride = title
      else delete next.titleOverride
      continue
    }
    ;(edits as Record<string, unknown>)[field] = value
  }
  delete edits.title
  if (Object.keys(edits).length) next.metadataEdits = edits
  else delete next.metadataEdits
  return next
}

/** The user data without the local edit of `fields` (all of them when absent). Returns a new object. */
export function withoutMetadataEdit(
  user: GameUserData,
  fields?: readonly MetadataEditField[]
): GameUserData {
  const next: GameUserData = { ...user }
  const drop = fields ?? METADATA_EDIT_FIELDS
  const edits: MetadataEdit = { ...(user.metadataEdits ?? {}) }
  for (const field of drop) {
    if (field === 'title') delete next.titleOverride
    delete edits[field]
  }
  if (Object.keys(edits).length) next.metadataEdits = edits
  else delete next.metadataEdits
  return next
}

/** The game's layers for the Edit sheet. */
export function metadataLayers(game: Game, cloud?: MetadataEdit | null): MetadataLayers {
  return {
    key: gameMetadataKey(game),
    scraped: editableValues(game),
    cloud: cloud && Object.keys(cloud).length ? cloud : null,
    local: localMetadataEdit(game)
  }
}
