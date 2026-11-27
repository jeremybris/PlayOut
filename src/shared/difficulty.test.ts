import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  DIFFICULTY_IDS,
  difficultyLabel,
  isDifficultyId,
  isToolsDifficulty,
  pickedDifficulty,
  tagDifficulty,
  TOOLS_DIFFICULTY
} from './difficulty'
import { effectiveGame, withMetadataEdit, withoutMetadataEdit } from './metadata-edit'
import type { Game } from './types'

function game(patch: Partial<Game> = {}): Game {
  return {
    id: 'steam:268910',
    source: 'steam',
    externalId: '268910',
    platformId: 'steam',
    title: 'Cuphead',
    sortTitle: 'cuphead',
    installed: true,
    launch: { kind: 'uri', uri: 'steam://rungameid/268910' },
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
    media: {},
    metadataStatus: 'done',
    user: {},
    ...patch
  }
}

describe('difficulty levels', () => {
  it('lists the five levels easiest first, with their names', () => {
    expect(DIFFICULTY_IDS).toEqual(['story', 'easy', 'medium', 'hard', 'impossible'])
    expect(DIFFICULTIES.map((d) => d.label)).toEqual([
      'Story',
      'Easy',
      'Medium',
      'Hard',
      'Impossible'
    ])
    expect(difficultyLabel('hard')).toBe('Hard')
    expect(difficultyLabel('other')).toBe('other')
    // A game without a pick is Medium.
    expect(DEFAULT_DIFFICULTY).toBe('medium')
  })
})

describe('pickedDifficulty', () => {
  it('is the pick, or none', () => {
    expect(pickedDifficulty(game())).toBeUndefined()
    expect(pickedDifficulty(game({ metadata: { difficulty: 'impossible' } }))).toBe('impossible')
    // A level this version does not know is no pick.
    const odd = game({ metadata: { difficulty: 'nightmare' as never } })
    expect(pickedDifficulty(odd)).toBeUndefined()
  })

  it('goes by the edit precedence: local edit > cloud > none', () => {
    const plain = game()
    expect(pickedDifficulty(effectiveGame(plain))).toBeUndefined()
    expect(pickedDifficulty(effectiveGame(plain, { difficulty: 'hard' }))).toBe('hard')
    // The user's own edit wins over the cloud's.
    const edited = { ...plain, user: withMetadataEdit(plain.user, { difficulty: 'easy' }) }
    expect(pickedDifficulty(effectiveGame(edited, { difficulty: 'hard' }))).toBe('easy')
    // Default (''): no pick (so Medium), even over a cloud pick.
    const reset = { ...plain, user: withMetadataEdit(plain.user, { difficulty: '' }) }
    expect(pickedDifficulty(effectiveGame(reset, { difficulty: 'hard' }))).toBeUndefined()
    expect(pickedDifficulty(effectiveGame(reset))).toBeUndefined()
    // The edit removed: the cloud's pick shows again.
    const removed = { ...edited, user: withoutMetadataEdit(edited.user, ['difficulty']) }
    expect(pickedDifficulty(effectiveGame(removed, { difficulty: 'hard' }))).toBe('hard')
    expect(pickedDifficulty(effectiveGame(removed))).toBeUndefined()
  })

  it('keeps the stored game without the pick', () => {
    const stored = game({ user: { metadataEdits: { difficulty: 'impossible' } } })
    expect(effectiveGame(stored).metadata.difficulty).toBe('impossible')
    expect(stored.metadata.difficulty).toBeUndefined()
  })
})

describe('tagDifficulty', () => {
  const tagged = (...tags: string[]): Game => game({ metadata: { steamTags: { tags } } })

  it('gives Visual Novel Story, Casual, Free to Play and Relaxing Easy, Souls-like and Difficult Hard, any case', () => {
    expect(tagDifficulty(tagged('Visual Novel'))).toEqual({ level: 'story', tag: 'Visual Novel' })
    expect(tagDifficulty(tagged('casual'))).toEqual({ level: 'easy', tag: 'Casual' })
    expect(tagDifficulty(tagged(' Souls-like '))).toEqual({ level: 'hard', tag: 'Souls-like' })
    expect(tagDifficulty(tagged('Free to Play'))).toEqual({ level: 'easy', tag: 'Free to Play' })
    expect(tagDifficulty(tagged('difficult'))).toEqual({ level: 'hard', tag: 'Difficult' })
    expect(tagDifficulty(tagged('Relaxing'))).toEqual({ level: 'easy', tag: 'Relaxing' })
  })

  it('takes the strongest rule when several tags are on the game', () => {
    expect(tagDifficulty(tagged('Casual', 'Souls-like'))?.level).toBe('hard')
    expect(tagDifficulty(tagged('Casual', 'Visual Novel'))?.level).toBe('story')
    expect(tagDifficulty(tagged('Free to Play', 'Souls-like'))?.level).toBe('hard')
    expect(tagDifficulty(tagged('Free to Play', 'Casual'))?.tag).toBe('Casual')
    expect(tagDifficulty(tagged('Visual Novel', 'Difficult'))?.level).toBe('hard')
    expect(tagDifficulty(tagged('Casual', 'Difficult'))?.level).toBe('hard')
    expect(tagDifficulty(tagged('Relaxing', 'Visual Novel'))?.level).toBe('story')
  })

  it('gives nothing without one of the tags', () => {
    expect(tagDifficulty(tagged('Action', 'Roguelike'))).toBeUndefined()
    expect(tagDifficulty(game())).toBeUndefined()
  })
})

describe('N/A (Tools)', () => {
  const tagged = (...tags: string[]): Game => game({ metadata: { steamTags: { tags } } })

  it("labels a game Steam tags Utilities, any case, over every other tag's level", () => {
    expect(tagDifficulty(tagged('Utilities'))).toEqual({
      level: TOOLS_DIFFICULTY,
      tag: 'Utilities'
    })
    expect(tagDifficulty(tagged(' utilities '))?.level).toBe('tools')
    expect(tagDifficulty(tagged('Utilities', 'Casual'))?.level).toBe('tools')
    expect(tagDifficulty(tagged('Souls-like', 'Utilities'))?.level).toBe('tools')
    // Not a level, so no hard-coded English label: callers translate it.
    expect(difficultyLabel(TOOLS_DIFFICULTY)).toBe('tools')
    expect(isToolsDifficulty('tools')).toBe(true)
    expect(isToolsDifficulty('medium')).toBe(false)
  })

  it('is never a level or a pick, so it is never saved or sent to the cloud', () => {
    expect(isDifficultyId('tools')).toBe(false)
    expect(DIFFICULTY_IDS).not.toContain('tools')
    expect(DIFFICULTIES.map((d) => d.id)).not.toContain('tools')
    // The tag gives no pick.
    expect(pickedDifficulty(tagged('Utilities'))).toBeUndefined()
    // A stored 'tools' (an old or hand-edited value) is no pick either.
    expect(pickedDifficulty(game({ metadata: { difficulty: 'tools' as never } }))).toBeUndefined()
  })
})
