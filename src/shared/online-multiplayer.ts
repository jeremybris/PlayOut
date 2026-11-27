import type { Game } from './types'

/**
 * Filters > Online Multiplayer, from the game's Steam tags (compared case-insensitively), A to Z: All Competitive
 * (Competitive, eSports, PvP, Team-Based and Massively Multiplayer), All Cooperative (Online Co-Op), All Online
 * Multiplayer (every tag here), then one choice per Steam tag: eSports, Massively Multiplayer (with MMO), PvP and Team
 * Based.
 */
export const ONLINE_ALL = 'online-all'

const MMO_TAGS = ['Massively Multiplayer', 'MMO']

/** The Steam tags each choice takes. */
export const ONLINE_TAGS: Record<string, readonly string[]> = {
  // 'pvp' keeps its id (saved tabs): All Competitive.
  pvp: ['Competitive', 'eSports', 'PvP', 'Team-Based', ...MMO_TAGS],
  coop: ['Online Co-Op'],
  esports: ['eSports'],
  mmo: MMO_TAGS,
  versus: ['PvP'],
  team: ['Team-Based']
}
ONLINE_TAGS[ONLINE_ALL] = [...new Set(Object.values(ONLINE_TAGS).flat())]

/** The sub-menu's choices: All Online Multiplayer first, then the rest A to Z. */
export const ONLINE_CHOICES = [
  { id: ONLINE_ALL, label: 'All Online Multiplayer' },
  { id: 'pvp', label: 'All Competitive' },
  { id: 'coop', label: 'All Cooperative' },
  { id: 'esports', label: 'eSports' },
  { id: 'mmo', label: 'Massively Multiplayer' },
  { id: 'versus', label: 'PvP' },
  { id: 'team', label: 'Team Based' }
] as const

const lowered = Object.fromEntries(
  Object.entries(ONLINE_TAGS).map(([id, tags]) => [id, new Set(tags.map((t) => t.toLowerCase()))])
)

export function onlineMultiplayerLabel(id: string): string {
  if (id === ONLINE_ALL) return 'Online Multiplayer'
  return ONLINE_CHOICES.find((c) => c.id === id)?.label ?? id
}

/** The choices this version knows (a saved one it does not know is dropped). */
export function knownOnlineMultiplayerIds(ids: readonly string[]): string[] {
  return ids.filter((id) => ONLINE_CHOICES.some((c) => c.id === id))
}

/**
 * A game under Filters > Online Multiplayer > All Competitive. The in-game overlay never pauses one (as with a game
 * under an anti-cheat service): a suspended online game can be flagged by anti-cheat or dropped by its server.
 */
export function isCompetitiveOnline(game: Pick<Game, 'metadata'>): boolean {
  return matchesOnlineMultiplayer(game, 'pvp')
}

/** Whether a game has one of a choice's Steam tags. */
export function matchesOnlineMultiplayer(game: Pick<Game, 'metadata'>, id: string): boolean {
  const wanted = lowered[id]
  return !!wanted && !!game.metadata.steamTags?.tags.some((t) => wanted.has(t.trim().toLowerCase()))
}
