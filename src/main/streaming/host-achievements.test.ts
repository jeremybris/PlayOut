import { describe, expect, it } from 'vitest'
import {
  MAX_ACHIEVEMENTS,
  sanitizeAchievementsInfo,
  sanitizeAchievementsSummary
} from './host-achievements'

const steamList = {
  provider: 'steam',
  total: 3,
  unlocked: 1,
  list: [
    {
      id: 'ACH_1',
      name: 'First',
      description: 'Do the first thing',
      unlocked: true,
      unlockedAt: '2026-10-01T10:00:00.000Z',
      icon: 'https://cdn.example.com/1.jpg'
    },
    { id: 'ACH_2', name: 'Second', unlocked: false, hidden: true },
    { id: 'ACH_3', name: 'Third', unlocked: false }
  ]
}

describe('sanitizeAchievementsInfo', () => {
  it('keeps a well-formed list as it is', () => {
    expect(sanitizeAchievementsInfo(steamList)).toEqual(steamList)
    const retro = {
      provider: 'retroachievements',
      total: 1,
      unlocked: 1,
      points: { earned: 10, total: 10 },
      url: 'https://retroachievements.org/game/1',
      list: [{ id: '7', name: 'Ring', unlocked: true, points: 10, hardcore: true }]
    }
    expect(sanitizeAchievementsInfo(retro)).toEqual(retro)
  })

  it('is null for what is not a list', () => {
    expect(sanitizeAchievementsInfo(null)).toBeNull()
    expect(sanitizeAchievementsInfo('x')).toBeNull()
    expect(sanitizeAchievementsInfo({ total: 1, unlocked: 0 })).toBeNull()
    expect(sanitizeAchievementsInfo({ total: -1, unlocked: 0, list: [] })).toBeNull()
    expect(
      sanitizeAchievementsInfo({ total: 1, unlocked: 0, list: new Array(MAX_ACHIEVEMENTS + 1) })
    ).toBeNull()
  })

  it('drops broken entries and fields, and repeated ids', () => {
    const info = sanitizeAchievementsInfo({
      ...steamList,
      provider: 'xbox',
      url: 'javascript:alert(1)',
      points: { earned: 20, total: 10 },
      list: [
        { id: 'A', name: 'Fine', unlocked: true, icon: 'file:///C:/secret.png', points: -3 },
        { id: 'A', name: 'Again', unlocked: false },
        { id: '', name: 'No id', unlocked: false },
        { id: 'B', name: 'No state' },
        { id: 'C', name: 'x'.repeat(5000), unlocked: false, unlockedAt: 'yesterday' },
        'junk'
      ]
    })
    expect(info).not.toBeNull()
    expect(info!.provider).toBeUndefined()
    expect(info!.url).toBeUndefined()
    expect(info!.points).toBeUndefined()
    expect(info!.list.map((a) => a.id)).toEqual(['A', 'C'])
    expect(info!.list[0]).toEqual({ id: 'A', name: 'Fine', unlocked: true })
    expect(info!.list[1].name).toHaveLength(300)
    expect(info!.list[1].unlockedAt).toBeUndefined()
  })

  it('keeps the counts within the list', () => {
    const info = sanitizeAchievementsInfo({ ...steamList, total: 1, unlocked: 9 })
    expect(info).toMatchObject({ total: 3, unlocked: 3 })
  })
})

describe('sanitizeAchievementsSummary', () => {
  it('takes unlocked of total', () => {
    expect(sanitizeAchievementsSummary({ unlocked: 0, total: 4, updatedAt: 'x' })).toEqual({
      unlocked: 0,
      total: 4
    })
    expect(sanitizeAchievementsSummary({ unlocked: 5, total: 4 })).toBeUndefined()
    expect(sanitizeAchievementsSummary({ unlocked: 0, total: 0 })).toBeUndefined()
    expect(sanitizeAchievementsSummary(undefined)).toBeUndefined()
  })
})
