// Which recompilation title (several recompilations of one game) fits a library game. ROM games match on their system
// and name; PC games (store and manual) match recompilations of PC originals (DevilutionX for Diablo, ...). Strict on
// purpose: an exact normalized name, an edition word on a PC game ("GOTY Edition", "Gold"), or one name being the
// other plus a subtitle when only one title on that system fits. Never fuzzy: the UP button on a game page must not
// offer the wrong game's port.

import { basename } from 'path'
import { withoutXisoSuffix } from '@shared/convert'
import type { RecompTitle } from '@shared/recomp'
import type { Game, GameRecompInfo } from '@shared/types'
import { normalizeGameTitle, withoutBrackets, withoutVersionWord } from './titles'

/** Lookups over the catalog's titles, built once per catalog load (buildTitleIndex). */
export interface TitleIndex {
  /** Canonical system group (systemGroup) -> normalized game name -> title key. PC originals are under `pc`. */
  bySystem: Map<string, Map<string, string>>
  /**
   * PC (and MS-DOS) originals: normalized name -> title key, plus, prefixed POSSESSIVE, every name without a
   * publisher's or designer's possessive in front ("Sid Meier's Civilization II" -> "'s:civilizationii").
   */
  pc: Map<string, string>
  /**
   * Titles by the normalized part before a subtitle ("Fallout 2: A Post Nuclear..." -> "fallout2"), per system group
   * ('pc' for PC originals), for the one-candidate subtitle rule.
   */
  mains: Map<string, Map<string, string[]>>
}

/** Key prefix of the possessive-dropped names in `TitleIndex.pc` (kept apart from plain names). */
const POSSESSIVE = "'s:"

/** The PC group: catalog 'pc' (Windows) and 'dos' originals, and library games run on the PC. */
const PC = 'pc'

/**
 * System ids that are the same hardware for matching (ES-DE folder names and the codes catalogs use). Each id maps to
 * its group's first id.
 */
const SYSTEM_GROUPS: string[][] = [
  ['psx', 'ps1'],
  ['xbox360', 'x360'],
  ['gc', 'ngc', 'gamecube'],
  ['nds', 'ds'],
  ['n3ds', '3ds'],
  ['genesis', 'megadrive', 'megadrivejp', 'md'],
  ['snes', 'sfc', 'snesna'],
  ['nes', 'famicom'],
  ['saturn', 'saturnjp'],
  ['sega32x', 'sega32xjp', 'sega32xna', 's32x'],
  ['segacd', 'megacd', 'megacdjp'],
  ['dreamcast', 'dc'],
  ['tg16', 'pcengine'],
  ['tg-cd', 'pcenginecd'],
  ['gamegear', 'gg'],
  // Arcade boards: ES-DE keeps some in their own folders, the catalogs say "arcade" or the board.
  [
    'arcade',
    'mame',
    'fbneo',
    'fba',
    'neogeo',
    'cps1',
    'cps2',
    'cps3',
    'model2',
    'model3',
    'naomi',
    'naomi2',
    'naomigd',
    'atomiswave',
    'stv',
    'triforce'
  ]
]

/** Library systems whose games are PC games (DOS and Windows folders of a ROM library). */
const PC_SYSTEMS = new Set(['pc', 'dos', 'windows', 'windows3x', 'windows9x'])

const GROUP_OF = new Map<string, string>()
for (const group of SYSTEM_GROUPS) for (const id of group) GROUP_OF.set(id, group[0]!)

/** The group a system id is matched under: 'pc' for PC originals and PC library systems, else the hardware group. */
export function systemGroup(systemId: string): string {
  const id = systemId.toLowerCase()
  if (PC_SYSTEMS.has(id)) return PC
  return GROUP_OF.get(id) ?? id
}

/**
 * Store editions of the same game, at the end of the name: "Plants vs. Zombies GOTY Edition", "Diablo Gold", "Fallout 3
 * Game of the Year Edition", "Doom Classic". Nothing looser (decomp-buddy's store matching uses the same words).
 */
const EDITION =
  /[\s:–—-]+(?:goty|game of the year|gold|complete|deluxe|definitive|anniversary|steam|classic)(?:\s+edition)?\s*$/i

/** The name without a trailing edition word, or null when it has none (or would be left empty). */
export function stripEdition(title: string): string | null {
  const stripped = title.replace(/\s*[([{][^)\]}]*[)\]}]\s*$/, '').replace(EDITION, '')
  const name = normalizeGameTitle(stripped)
  return name && name !== normalizeGameTitle(title) ? stripped : null
}

/**
 * Edition words dropped from a CATALOG name too: only the ones that never name another game. "Classic", "Gold",
 * "Deluxe" and "Anniversary" do ("Minecraft Classic", "RuneScape Classic", "Tomb Raider: Anniversary").
 */
const STORE_EDITION =
  /[\s:–—-]+(?:goty|game of the year)(?:\s+edition)?\s*$|[\s:–—-]+(?:complete|definitive|steam)\s+edition\s*$/i

/** A catalog name without a store edition ("Fallout 3 Game of the Year Edition" -> "Fallout 3"), else null. */
function stripStoreEdition(title: string): string | null {
  const base = title.replace(/\s*[([{][^)\]}]*[)\]}]\s*$/, '')
  const stripped = base.replace(STORE_EDITION, '')
  return stripped !== base && normalizeGameTitle(stripped) ? stripped : null
}

/**
 * Publishers and designers whose name stores put in front of a game's ("Sid Meier's Civilization II"). Only these:
 * any other "X's" is part of the name ("Rodent's Revenge" is not "Montezuma's Revenge").
 */
const POSSESSIVE_NAMES = new Set([
  'sidmeier',
  'tomclancy',
  'americanmcgee',
  'clivebarker',
  'peterjackson',
  'jamescameron',
  'disney',
  'marvel',
  'bramstoker',
  'frankherbert',
  'robertludlum',
  'stephenking',
  'deankoontz',
  'johncarpenter',
  'stevenspielberg',
  'georgelucas',
  'jrrtolkien',
  'tolkien',
  'agathachristie',
  'kenfollett',
  'jerrybruckheimer',
  'johnromero',
  'richardgarriott',
  'hideokojima',
  'shigerumiyamoto'
])

/** A publisher's or designer's possessive in front of a PC game's name ("Sid Meier's Civilization II"), else null. */
function stripPossessive(title: string): string | null {
  const m = title.match(/^([\w.]+(?:\s+[\w.]+)?)['’]s\s+(.+)$/)
  if (!m || !POSSESSIVE_NAMES.has(normalizeGameTitle(m[1]!))) return null
  return normalizeGameTitle(m[2]!) ? m[2]! : null
}

/** Subtitle separators: a colon, or a dash with spaces around it ("Spider-Man" is not split). */
const SUBTITLE = /\s*:\s*|\s+[-–—]\s+/

/**
 * The normalized name before a subtitle ("Legend of Zelda, The - Majora's Mask" -> "legendofzelda"), or null when the
 * name has no subtitle. Too-short bases (under 3 letters) are not used: "X: ..." would match far too much.
 */
export function mainTitle(title: string): string | null {
  const parts = title.split(SUBTITLE)
  if (parts.length < 2) return null
  const main = normalizeGameTitle(parts[0]!)
  const full = normalizeGameTitle(title)
  if (main.length < 3 || main === full) return null
  return main
}

function addMain(index: TitleIndex, group: string, main: string, key: string): void {
  let byMain = index.mains.get(group)
  if (!byMain) index.mains.set(group, (byMain = new Map()))
  const list = byMain.get(main)
  if (!list) byMain.set(main, [key])
  else if (!list.includes(key)) list.push(key)
}

/** Put `name -> key` in `map` unless the name is taken (a title of the system itself wins over an alias's). */
function put(map: Map<string, string>, name: string, key: string): void {
  if (name && !map.has(name)) map.set(name, key)
}

export function buildTitleIndex(catalog: { titles: Map<string, RecompTitle> }): TitleIndex {
  const index: TitleIndex = { bySystem: new Map(), pc: new Map(), mains: new Map() }
  // Titles of a group's own id first, so "psx:x" beats an aliased "ps1:x" when both exist.
  const titles = [...catalog.titles.values()]
    .filter((t) => t.systemId && t.systemId !== 'other')
    .sort(
      (a, b) =>
        Number(systemGroup(a.systemId) !== a.systemId) -
        Number(systemGroup(b.systemId) !== b.systemId)
    )
  for (const title of titles) {
    const group = systemGroup(title.systemId)
    const name = normalizeGameTitle(title.game)
    if (!name) continue
    let bySystem = index.bySystem.get(group)
    if (!bySystem) index.bySystem.set(group, (bySystem = new Map()))
    put(bySystem, name, title.key)
    const main = mainTitle(title.game)
    if (main) addMain(index, group, main, title.key)
    if (group === PC) put(index.pc, name, title.key)
  }
  // Variants only after every plain name, so a plain name always wins. Of the edition words only the store editions
  // are dropped from catalog names (see STORE_EDITION).
  for (const title of titles) {
    const group = systemGroup(title.systemId)
    const edition = group === PC ? stripStoreEdition(title.game) : null
    if (edition) put(index.pc, normalizeGameTitle(edition), title.key)
    // "Pokémon Platinum Version" is also "Pokémon Platinum".
    const noVersion = withoutVersionWord(title.game)
    const bySystem = index.bySystem.get(group)
    if (noVersion && bySystem) {
      put(bySystem, normalizeGameTitle(noVersion), title.key)
      if (group === PC) put(index.pc, normalizeGameTitle(noVersion), title.key)
    }
    if (group !== PC) continue
    // Every PC name under its possessive-dropped form, so "Civilization II" finds "Sid Meier's Civilization II" and
    // the other way round.
    put(
      index.pc,
      POSSESSIVE + normalizeGameTitle(stripPossessive(title.game) ?? title.game),
      title.key
    )
  }
  // Last, another name of the game on its console (RecompTitle.aliases: another region's title), so every title's own
  // names and variants win over another title's alias. Console titles only.
  for (const title of titles) {
    const group = systemGroup(title.systemId)
    const bySystem = index.bySystem.get(group)
    if (group === PC || !bySystem) continue
    for (const alias of title.aliases ?? []) {
      put(bySystem, normalizeGameTitle(alias), title.key)
      const aliasNoVersion = withoutVersionWord(alias)
      if (aliasNoVersion) put(bySystem, normalizeGameTitle(aliasNoVersion), title.key)
    }
  }
  return index
}

type MatchableGame = Pick<Game, 'source' | 'platformId' | 'title' | 'metadata'> &
  Partial<Pick<Game, 'user' | 'romPath' | 'extra'>>

/**
 * The names a game may be known by, best first: the user's override, the library title, the ROM's file name; each
 * also without a trailing "Version" ("Pokemon - Emerald Version"); last, each without its bracketed parts (TOSEC's
 * "Doom (1993)(id Software)", where the year is only a tag).
 */
function namesOf(game: MatchableGame): string[] {
  const raw = [game.user?.titleOverride, game.title]
  if (game.source === 'rom') {
    const folder = game.extra?.gameFolder
    if (typeof folder === 'string' && folder) raw.push(basename(folder))
    if (game.romPath) raw.push(withoutXisoSuffix(basename(game.romPath).replace(/\.[^.]+$/, '')))
  }
  const given = raw.filter((n): n is string => !!n && !!n.trim())
  const names: (string | null)[] = given.flatMap((n) => [n, withoutVersionWord(n)])
  for (const n of given) {
    const bare = withoutBrackets(n)
    if (bare) names.push(bare, withoutVersionWord(bare))
  }
  const seen = new Set<string>()
  return names.filter((n): n is string => {
    if (!n || !n.trim()) return false
    const key = normalizeGameTitle(n)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Taglines PC stores add to a game's own name (the same game, not a sequel or spin-off). On PC a "Series: Subtitle"
 * name is otherwise a different game: "Call of Duty: Black Ops" is not Call of Duty, "Tomb Raider: Legend" not Tomb
 * Raider, "DOOM: The Dark Ages" not DOOM.
 */
const PC_TAGLINES = new Set([
  'apostnuclearroleplayinggame',
  'hellonearth',
  'shadowoftheserpentriders',
  'beyondheretic',
  'thedarkproject',
  'quaddamage',
  'thecomputergame',
  'theoriginal'
])

/** The normalized part after the first subtitle separator ('' when there is none). */
function subtitleOf(name: string): string {
  const at = SUBTITLE.exec(name)
  return at ? normalizeGameTitle(name.slice(at.index + at[0].length)) : ''
}

/** The one title key the subtitle rule allows for these names, or null (none, or more than one candidate). */
function subtitleMatch(
  names: string[],
  group: string,
  exact: Map<string, string>,
  index: TitleIndex
): string | null {
  const candidates = new Set<string>()
  const byMain = index.mains.get(group)
  for (const name of names) {
    // The game has a subtitle the catalog lacks: "Fallout 2: A Post Nuclear Role Playing Game" -> "Fallout 2". On PC
    // only for a known tagline (PC_TAGLINES).
    const main = mainTitle(name)
    const base =
      main && (group !== PC || PC_TAGLINES.has(subtitleOf(name))) ? exact.get(main) : undefined
    if (base) candidates.add(base)
    // The catalog has a subtitle the game lacks: "Sonic Adventure" -> "Sonic Adventure: Director's Cut".
    for (const key of byMain?.get(normalizeGameTitle(name)) ?? []) candidates.add(key)
  }
  return candidates.size === 1 ? [...candidates][0]! : null
}

function matchKey(game: MatchableGame, index: TitleIndex): string | null {
  const names = namesOf(game)
  if (!names.length) return null
  const isPc = game.source !== 'rom' || PC_SYSTEMS.has(game.platformId.toLowerCase())
  if (!isPc) {
    const group = systemGroup(game.platformId)
    const exact = index.bySystem.get(group)
    if (!exact) return null
    for (const name of names) {
      const key = exact.get(normalizeGameTitle(name))
      if (key) return key
    }
    return subtitleMatch(names, group, exact, index)
  }
  for (const name of names) {
    const key = index.pc.get(normalizeGameTitle(name))
    if (key) return key
  }
  for (const name of names) {
    const edition = stripEdition(name)
    const key = edition ? index.pc.get(normalizeGameTitle(edition)) : undefined
    if (key) return key
  }
  for (const name of names) {
    const base = stripEdition(name) ?? name
    const key = index.pc.get(POSSESSIVE + normalizeGameTitle(stripPossessive(base) ?? base))
    if (key) return key
  }
  // Subtitles against plain PC names only (index.pc also holds the variants above).
  return subtitleMatch(names, PC, index.bySystem.get(PC) ?? new Map(), index)
}

/** The recompilation title for a library game, or null. Games streamed from a host are the caller's to skip. */
export function matchGameToTitle(
  game: MatchableGame,
  catalog: { titles: Map<string, RecompTitle> },
  index: TitleIndex
): RecompTitle | null {
  const key = matchKey(game, index)
  return key ? (catalog.titles.get(key) ?? null) : null
}

/**
 * The version a game uses: the user's choice while it is still one of the title's recompilations, else the first
 * installed one (title order: recommended first), else the title's first.
 */
export function defaultPreferred(
  title: RecompTitle,
  installedIds: string[],
  chosen: string | null
): string {
  if (chosen && title.entries.includes(chosen)) return chosen
  return title.entries.find((id) => installedIds.includes(id)) ?? title.entries[0] ?? ''
}

/** `metadata.recomp` for a game matched to `title`. `installed`: every installed entry id (any title). */
export function recompInfo(
  title: RecompTitle,
  installed: string[],
  preferred: string | null,
  now: string
): GameRecompInfo {
  return {
    titleKey: title.key,
    count: title.entries.length,
    installed: title.entries.filter((id) => installed.includes(id)),
    preferred: defaultPreferred(title, installed, preferred),
    updatedAt: now
  }
}

/** Whether a game's stored info already says the same (so the library is not rewritten); `updatedAt` is ignored. */
export function sameRecompInfo(a: GameRecompInfo | undefined, b: GameRecompInfo): boolean {
  if (!a) return false
  return (
    a.titleKey === b.titleKey &&
    a.count === b.count &&
    a.preferred === b.preferred &&
    a.installed.length === b.installed.length &&
    a.installed.every((id, i) => id === b.installed[i])
  )
}
