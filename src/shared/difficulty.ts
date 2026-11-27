import type { DifficultyLevel, GameMetadata } from './types'

/**
 * How hard a game is: Filters > Difficulty and the Edit sheet's Difficulty choice. Every game has one: the user's own
 * pick (a local edit, else the PlayOut cloud's: GameMetadata.difficulty, laid over by shared/metadata-edit.ts), else
 * the level a Steam tag gives it (TAG_DIFFICULTIES: Visual Novel = Story, Casual, Free to Play and Relaxing = Easy,
 * Souls-like and Difficult = Hard), else Medium. Nothing looks difficulty up on the web (no source PlayOut can read
 * without a browser has it).
 *
 * A game Steam tags Utilities (a tool, not a game) is labelled N/A (Tools) instead (TOOLS_DIFFICULTY): a label, not a
 * level. It is never a pick (DIFFICULTY_IDS, isDifficultyId and pickedDifficulty leave it out, so it is never saved
 * or sent to the cloud), no Filters > Difficulty level shows it, and the Difficulty sort puts it last.
 */

/** The levels, easiest first (the Filters sub-menu's and the Edit sheet's order). */
export const DIFFICULTY_IDS = [
  'story',
  'easy',
  'medium',
  'hard',
  'impossible'
] as const satisfies readonly DifficultyLevel[]

export type DifficultyId = DifficultyLevel

export const DIFFICULTIES: readonly { id: DifficultyId; label: string }[] = [
  { id: 'story', label: 'Story' },
  { id: 'easy', label: 'Easy' },
  { id: 'medium', label: 'Medium' },
  { id: 'hard', label: 'Hard' },
  { id: 'impossible', label: 'Impossible' }
]

/** The label-only "N/A (Tools)" a game tagged Utilities gets when nobody picked a level for it; never a pick. */
export const TOOLS_DIFFICULTY = 'tools'

/** A game's level as PlayOut labels it: a level, or N/A (Tools). Only DifficultyId is ever picked or sent to the cloud. */
export type EffectiveDifficulty = DifficultyId | typeof TOOLS_DIFFICULTY

/** Whether a game's effective level is the N/A (Tools) label. */
export function isToolsDifficulty(level: unknown): level is typeof TOOLS_DIFFICULTY {
  return level === TOOLS_DIFFICULTY
}

/** A game without a pick: the middle of the scale, until the user says otherwise. */
export const DEFAULT_DIFFICULTY: DifficultyId = 'medium'

export function isDifficultyId(value: unknown): value is DifficultyId {
  return typeof value === 'string' && (DIFFICULTY_IDS as readonly string[]).includes(value)
}

/**
 * "Hard" for 'hard'; an unknown id as it is. The N/A (Tools) label is not a level, so it is not here: callers that can
 * meet it translate it themselves (lib.sections.difficulty.tools, gameDetail.edit.fields.difficulty.tools).
 */
export function difficultyLabel(id: string): string {
  return DIFFICULTIES.find((d) => d.id === id)?.label ?? id
}

/**
 * Steam tags that set a game's level when nobody picked one (the user's rules), strongest first: a game with several
 * takes the first, so a Souls-like or Difficult game also tagged Casual is Hard. Compared case-insensitively.
 * Utilities (a tool, not a game) is the strongest: it labels the game N/A (Tools) whatever else it is tagged.
 */
export const TAG_DIFFICULTIES: readonly { tag: string; level: EffectiveDifficulty }[] = [
  { tag: 'Utilities', level: TOOLS_DIFFICULTY },
  { tag: 'Souls-like', level: 'hard' },
  { tag: 'Difficult', level: 'hard' },
  { tag: 'Visual Novel', level: 'story' },
  { tag: 'Casual', level: 'easy' },
  { tag: 'Free to Play', level: 'easy' },
  { tag: 'Relaxing', level: 'easy' }
]

/** The level and the Steam tag that gives it to the game, or undefined when none of TAG_DIFFICULTIES' tags is on it. */
export function tagDifficulty(game: {
  metadata?: Pick<GameMetadata, 'steamTags'>
}): { level: EffectiveDifficulty; tag: string } | undefined {
  const tags = new Set((game.metadata?.steamTags?.tags ?? []).map((t) => t.trim().toLowerCase()))
  if (tags.size === 0) return undefined
  return TAG_DIFFICULTIES.find((rule) => tags.has(rule.tag.toLowerCase()))
}

/**
 * The user's (or the cloud's) pick for the game, without the Medium default. Undefined when there is none, or for a
 * level this version does not know. Pass the game as shown (the edits laid over it). There is no "level or Medium"
 * helper: a card looks at every copy's pick before falling back to DEFAULT_DIFFICULTY (lib/libraryFilter.ts).
 */
export function pickedDifficulty(game: {
  metadata?: Pick<GameMetadata, 'difficulty'>
}): DifficultyId | undefined {
  const level = game.metadata?.difficulty
  return isDifficultyId(level) ? level : undefined
}
