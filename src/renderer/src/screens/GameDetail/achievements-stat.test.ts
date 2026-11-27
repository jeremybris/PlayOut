import type { AchievementsInfo, Game, GameMetadata } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { achievementsStat, providerLink } from './achievements-stat'

const RECOMP = 'github:someone/game-recomp'

function game(over: Partial<Game> & { metadata?: GameMetadata } = {}): Game {
  return {
    id: 'rom:xbox360:abc',
    source: 'rom',
    platformId: 'xbox360',
    title: 'Some Game',
    installed: true,
    romPath: 'C:\\Roms\\xbox360\\Some Game.iso',
    metadata: {},
    ...over
  } as Game
}

const withRecomp = (achievements?: string[], over: Partial<Game> = {}): Game =>
  game({
    metadata: {
      recomp: {
        titleKey: 'xbox360:some game',
        count: 1,
        installed: [RECOMP],
        preferred: RECOMP,
        ...(achievements ? { achievements } : {}),
        updatedAt: ''
      }
    },
    ...over
  })

describe('achievementsStat', () => {
  it('shows an Xbox 360 card whose recompilation has achievements, as Achievements', () => {
    expect(achievementsStat(withRecomp([RECOMP]))).toEqual({ show: true, label: 'achievements' })
  })

  it('shows a recompilation-only card the same way', () => {
    const card = withRecomp([RECOMP], {
      installed: false,
      romPath: undefined,
      extra: { recompOnly: 'k' }
    })
    expect(achievementsStat(card)).toEqual({ show: true, label: 'achievements' })
  })

  it('leaves out an Xbox 360 card whose recompilation PlayOut cannot read achievements of', () => {
    expect(achievementsStat(withRecomp()).show).toBe(false)
    expect(achievementsStat(game()).show).toBe(false)
  })

  it('keeps RetroAchievements on a ROM whose recompilation has none PlayOut reads', () => {
    const n64 = withRecomp(undefined, { platformId: 'n64' })
    expect(achievementsStat(n64)).toEqual({ show: true, label: 'retro' })
  })

  it("names a paired host's counts that came from its recompilation Achievements", () => {
    const card = game({
      remote: { hostId: 'h' } as never,
      metadata: {
        achievements: { unlocked: 2, total: 10, updatedAt: '' },
        sources: { 'recomp-achievements': RECOMP }
      }
    })
    expect(achievementsStat(card)).toEqual({ show: true, label: 'achievements' })
  })

  it('does not take stale counts of a recompilation no longer installed for its own', () => {
    // Main clears them; until it has, the card is a ROM again (RetroAchievements).
    const card = game({
      platformId: 'n64',
      metadata: {
        achievements: { unlocked: 2, total: 10, updatedAt: '' },
        sources: { 'recomp-achievements': RECOMP }
      }
    })
    expect(achievementsStat(card)).toEqual({ show: true, label: 'retro' })
  })

  it('leaves a Steam card with an installed recompilation to Steam', () => {
    const steam = withRecomp([RECOMP], { source: 'steam', platformId: 'steam' })
    expect(achievementsStat(steam)).toEqual({ show: true, label: 'achievements' })
  })

  it("leaves a paired host's game to its host's counts", () => {
    const remote = withRecomp([RECOMP], { remote: { hostId: 'h' } as never })
    expect(achievementsStat(remote).show).toBe(false)
  })

  it('keeps Steam games as before', () => {
    expect(achievementsStat(game({ source: 'steam', platformId: 'steam' }))).toEqual({
      show: true,
      label: 'achievements'
    })
  })

  it('leaves out a Steam game Steam says has no achievements (Call of Duty: United Offensive)', () => {
    const none = game({
      source: 'steam',
      platformId: 'steam',
      metadata: { sources: { 'steam-achievements': 'none' } }
    })
    expect(achievementsStat(none).show).toBe(false)
  })

  it('keeps the stat of a Steam game not read yet, or read while signed out (no mark), and counts beat a mark', () => {
    expect(
      achievementsStat(game({ source: 'steam', platformId: 'steam', metadata: {} })).show
    ).toBe(true)
    const counted = game({
      source: 'steam',
      platformId: 'steam',
      metadata: {
        achievements: { unlocked: 1, total: 5, updatedAt: '' },
        sources: { 'steam-achievements': 'none' }
      }
    })
    expect(achievementsStat(counted).show).toBe(true)
  })
})

describe("achievementsStat: a paired host's ROMs and GOG games", () => {
  const hostRom = (over: Partial<Game> = {}): Game =>
    game({
      id: 'remote:h:rom:snes:x',
      platformId: 'snes',
      romPath: undefined,
      installed: false,
      remote: {
        hostId: 'h',
        hostName: 'Den',
        hostGameId: 'rom:snes:x',
        streamable: true,
        downloadable: true
      },
      ...over
    })

  it("shows a host's ROM file as RetroAchievements without counts (this PC's account reads it)", () => {
    expect(achievementsStat(hostRom())).toEqual({ show: true, label: 'retro' })
    // Known without: this PC's (or the host's) "none", or a system RetroAchievements does not cover.
    expect(
      achievementsStat(hostRom({ metadata: { sources: { retroachievements: 'none' } } })).show
    ).toBe(false)
    expect(achievementsStat(hostRom({ platformId: 'xbox360' })).show).toBe(false)
    // A card with no file to download (its recompilation plays) is left to the host's counts.
    const kept = hostRom()
    kept.remote = { ...kept.remote!, downloadable: false }
    expect(achievementsStat(kept).show).toBe(false)
  })

  it("shows a GOG game unless GOG said it has none, and leaves one with a Steam app id to Steam's rules", () => {
    const gog = (over: Partial<Game> = {}): Game =>
      game({ id: 'gog:1', source: 'gog', platformId: 'gog', romPath: undefined, ...over })
    expect(achievementsStat(gog())).toEqual({ show: true, label: 'achievements' })
    expect(
      achievementsStat(gog({ metadata: { sources: { 'gog-achievements': 'none' } } })).show
    ).toBe(false)
    expect(achievementsStat(gog({ extra: { steamAppId: 22380 } })).show).toBe(false)
  })

  it('shows an Epic game with its sandbox id unless Epic said it has none, also with a Steam app id', () => {
    const epic = (over: Partial<Game> = {}): Game =>
      game({
        id: 'epic:Hades',
        source: 'epic',
        platformId: 'epic',
        romPath: undefined,
        extra: { epicNamespace: 'min' },
        ...over
      })
    expect(achievementsStat(epic())).toEqual({ show: true, label: 'achievements' })
    expect(
      achievementsStat(epic({ extra: { epicNamespace: 'min', steamAppId: 1145360 } })).show
    ).toBe(true)
    expect(
      achievementsStat(epic({ metadata: { sources: { 'epic-achievements': 'none' } } })).show
    ).toBe(false)
    // Without a sandbox id PlayOut cannot ask Epic: only counts on the card show the stat.
    expect(achievementsStat(epic({ extra: {} })).show).toBe(false)
  })
})

describe('providerLink', () => {
  const info = (
    provider: 'steam' | 'retroachievements' | 'gog' | 'epic' | 'recomp',
    url?: string
  ): AchievementsInfo => ({
    provider,
    url,
    total: 1,
    unlocked: 0,
    list: []
  })

  it("opens only an https page of the list's own provider", () => {
    expect(providerLink(info('retroachievements', 'https://retroachievements.org/game/228'))).toBe(
      'https://retroachievements.org/game/228'
    )
    expect(providerLink(info('steam', 'https://steamcommunity.com/stats/620/achievements'))).toBe(
      'https://steamcommunity.com/stats/620/achievements'
    )
    expect(providerLink(info('gog', 'https://www.gog.com/game/x'))).toBe(
      'https://www.gog.com/game/x'
    )
    expect(providerLink(info('epic', 'https://store.epicgames.com/en-US/p/hades'))).toBe(
      'https://store.epicgames.com/en-US/p/hades'
    )
    expect(providerLink(info('epic', 'https://www.gog.com/game/x'))).toBeUndefined()
    // A paired host's answer naming another site, a look-alike or plain http gets no link.
    expect(providerLink(info('retroachievements', 'https://evil.example/game/1'))).toBeUndefined()
    expect(
      providerLink(info('retroachievements', 'https://retroachievements.org.evil.example/'))
    ).toBeUndefined()
    expect(
      providerLink(info('retroachievements', 'http://retroachievements.org/game/1'))
    ).toBeUndefined()
    expect(providerLink(info('steam', 'not a url'))).toBeUndefined()
    expect(providerLink(info('recomp', 'https://retroachievements.org/'))).toBeUndefined()
  })
})
