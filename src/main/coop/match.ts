import type { CoopGameInfo, CoopHandlerEntry, Game } from '@shared/types'
import { basename } from 'path'

/**
 * Which Nucleus Co-op handler fits a library game. Nucleus matches by the exe's file name only; PlayOut knows the exe
 * of some games (manual, GOG, Battle.net, ...) but not of Steam or Ubisoft ones, so it also matches by Steam app id
 * and, last, by the game's name. A handler for a mode or mod of a game ("Elden Ring Seamless Co-op") still matches
 * the game by exe or Steam id; among several, the one named like the game is preferred.
 */

/** Lowercase letters and digits only, "&" as "and", trademark signs and a leading "the" dropped. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/&/g, ' and ')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '')
}

export interface CoopLookup {
  byExe: Map<string, CoopHandlerEntry[]>
  bySteam: Map<string, CoopHandlerEntry[]>
  byName: Map<string, CoopHandlerEntry[]>
}

function add(
  map: Map<string, CoopHandlerEntry[]>,
  key: string | undefined,
  entry: CoopHandlerEntry
): void {
  if (!key) return
  const list = map.get(key)
  if (list) list.push(entry)
  else map.set(key, [entry])
}

export function buildCoopLookup(handlers: readonly CoopHandlerEntry[]): CoopLookup {
  const lookup: CoopLookup = { byExe: new Map(), bySteam: new Map(), byName: new Map() }
  for (const h of handlers) {
    for (const exe of new Set([h.exeName, ...h.exeNames].filter(Boolean) as string[]))
      add(lookup.byExe, exe.toLowerCase(), h)
    add(lookup.bySteam, handlerSteamId(h), h)
    add(lookup.byName, normalizeTitle(h.gameName) || undefined, h)
    if (h.title && normalizeTitle(h.title) !== normalizeTitle(h.gameName))
      add(lookup.byName, normalizeTitle(h.title) || undefined, h)
  }
  return lookup
}

/** A handler's Steam app id as digits only (the form the lookup and the games use); undefined when it has none. */
function handlerSteamId(h: CoopHandlerEntry): string | undefined {
  return h.steamId?.replace(/\D/g, '') || undefined
}

/** The game's Steam app id, when it has one (Steam games; other stores' copies of a Steam game may carry it too). */
export function steamAppIdOf(game: Game): string | undefined {
  const id = game.extra?.steamAppId ?? (game.source === 'steam' ? game.externalId : undefined)
  const text = id === undefined ? '' : String(id).replace(/\D/g, '')
  return text || undefined
}

/** ROMs run in emulators: Nucleus handlers are for PC games. */
function isPcGame(game: Game): boolean {
  return game.source !== 'rom' && !game.romPath
}

/**
 * The handler for `game` and how it was found; null when none fits. `contextOk` checks a handler's
 * ExecutableContext files next to the exe (Nucleus's tie-break between handlers sharing an exe name).
 */
export function matchCoopHandler(
  game: Game,
  lookup: CoopLookup,
  contextOk: (entry: CoopHandlerEntry, exePath: string) => boolean = () => true
): { entry: CoopHandlerEntry; matchedBy: CoopGameInfo['matchedBy'] } | null {
  if (!isPcGame(game)) return null
  const name = normalizeTitle(game.user.titleOverride ?? game.title)
  const named = (h: CoopHandlerEntry): boolean =>
    !!name &&
    (normalizeTitle(h.gameName) === name || (!!h.title && normalizeTitle(h.title) === name))
  const pick = (list: CoopHandlerEntry[]): CoopHandlerEntry =>
    [...list].sort(
      (a, b) =>
        Number(named(b)) - Number(named(a)) ||
        Number(b.risks.length === 0) - Number(a.risks.length === 0) ||
        a.archive.localeCompare(b.archive)
    )[0]!

  const steam = steamAppIdOf(game)
  const exePath = game.exePath
  if (exePath) {
    const byExe = (lookup.byExe.get(basename(exePath).toLowerCase()) ?? []).filter((h) =>
      contextOk(h, exePath)
    )
    if (byExe.length) {
      // The same exe name in several games ("game.exe", "launcher.exe"): the Steam id or the name must agree then.
      const sure = byExe.filter((h) => (steam && handlerSteamId(h) === steam) || named(h))
      if (sure.length) return { entry: pick(sure), matchedBy: 'exe' }
      if (!isGenericExe(basename(exePath))) return { entry: pick(byExe), matchedBy: 'exe' }
    }
  }
  if (steam) {
    const bySteam = lookup.bySteam.get(steam)
    if (bySteam?.length) return { entry: pick(bySteam), matchedBy: 'steam' }
  }
  // By name, but never a handler made for another Steam app ("Titan Quest" is not "Titan Quest Anniversary Edition",
  // whose hub title is "Titan Quest").
  // Nor one whose exe is not the game's known exe (a remake with the same title).
  const exeName = exePath ? basename(exePath).toLowerCase() : undefined
  const byName = (name ? (lookup.byName.get(name) ?? []) : []).filter(
    (h) =>
      (!steam || !handlerSteamId(h) || handlerSteamId(h) === steam) &&
      (!exeName ||
        ![h.exeName, ...h.exeNames].some(Boolean) ||
        [h.exeName, ...h.exeNames].some((n) => n?.toLowerCase() === exeName))
  )
  if (byName.length) return { entry: pick(byName), matchedBy: 'name' }
  return null
}

/** Exe names many games share: a match by them alone is no evidence. */
function isGenericExe(name: string): boolean {
  return /^(game|launcher|start|play|run|client|main|app|setup)(-?(win)?(32|64))?\.exe$/i.test(name)
}

/** The record stored on the game (Game.metadata.coop). */
export function coopRecord(
  match: { entry: CoopHandlerEntry; matchedBy: CoopGameInfo['matchedBy'] },
  nowIso: string
): CoopGameInfo {
  const { entry } = match
  return {
    archive: entry.archive,
    hubId: entry.hubId,
    gameName: entry.gameName,
    maxPlayers: entry.maxPlayers,
    keyboard: entry.supportsKeyboard || entry.supportsMultipleKeyboardsAndMice || undefined,
    risks: entry.risks.length ? [...entry.risks] : undefined,
    matchedBy: match.matchedBy,
    updatedAt: nowIso
  }
}

/** Same handler and facts (the date aside): nothing to write. */
export function sameCoopRecord(a: CoopGameInfo | undefined, b: CoopGameInfo): boolean {
  return (
    !!a &&
    a.archive === b.archive &&
    a.gameName === b.gameName &&
    a.maxPlayers === b.maxPlayers &&
    a.keyboard === b.keyboard &&
    a.matchedBy === b.matchedBy &&
    (a.risks ?? []).join() === (b.risks ?? []).join()
  )
}
