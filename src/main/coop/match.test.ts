import type { CoopHandlerEntry, Game } from '@shared/types'
import { describe, expect, it } from 'vitest'
import {
  buildCoopLookup,
  coopRecord,
  matchCoopHandler,
  normalizeTitle,
  sameCoopRecord,
  steamAppIdOf
} from './match'

function handler(over: Partial<CoopHandlerEntry>): CoopHandlerEntry {
  return {
    archive: `handler-${over.gameName ?? 'x'}-v1.nc`,
    gameName: 'Game',
    exeNames: [],
    exeContext: [],
    supportsKeyboard: false,
    supportsMultipleKeyboardsAndMice: false,
    risks: [],
    ...over
  }
}

function game(over: Partial<Game>): Game {
  return {
    id: 'g',
    source: 'manual',
    externalId: 'x',
    platformId: 'pc',
    title: 'Some Game',
    sortTitle: 'some game',
    installed: true,
    launch: { kind: 'none' } as never,
    tracking: { mode: 'none' },
    hidden: false,
    favorite: false,
    playtimeMinutes: 0,
    playCount: 0,
    addedAt: '',
    metadata: {},
    media: {},
    metadataStatus: 'done',
    user: {},
    ...over
  } as Game
}

const bl2 = handler({ gameName: 'Borderlands 2', exeName: 'Borderlands2.exe', steamId: '49520' })
const generic = handler({ gameName: 'Indie Thing', exeName: 'Game.exe' })
const seamless = handler({
  gameName: 'Elden Ring',
  title: 'Elden Ring Seamless Co-op',
  exeName: 'eldenring.exe',
  steamId: '1245620',
  risks: ['eac']
})
const lookup = buildCoopLookup([bl2, generic, seamless])

describe('normalizeTitle', () => {
  it('compares names loosely', () => {
    expect(normalizeTitle('The Witcher® 3: Wild Hunt')).toBe(normalizeTitle('witcher 3 wild hunt'))
    expect(normalizeTitle('Rock & Roll')).toBe('rockandroll')
  })
})

describe('matchCoopHandler', () => {
  it('matches by exe name', () => {
    expect(
      matchCoopHandler(game({ exePath: 'D:\\G\\Binaries\\Win32\\BORDERLANDS2.EXE' }), lookup)
    ).toMatchObject({
      entry: bl2,
      matchedBy: 'exe'
    })
  })

  it('needs the Steam id or the name for a generic exe name', () => {
    expect(
      matchCoopHandler(game({ exePath: 'C:\\X\\game.exe', title: 'Other' }), lookup)
    ).toBeNull()
    expect(
      matchCoopHandler(game({ exePath: 'C:\\X\\game.exe', title: 'Indie Thing' }), lookup)?.entry
    ).toBe(generic)
  })

  it('matches Steam games by app id', () => {
    const steam = game({ source: 'steam', externalId: '49520', title: 'BL2 GOTY' })
    expect(matchCoopHandler(steam, lookup)).toMatchObject({ entry: bl2, matchedBy: 'steam' })
    expect(steamAppIdOf(game({ source: 'gog', extra: { steamAppId: 1245620 } }))).toBe('1245620')
  })

  it('falls back to the name, the hub title included', () => {
    expect(matchCoopHandler(game({ title: 'Elden Ring Seamless Co-op' }), lookup)?.matchedBy).toBe(
      'name'
    )
  })

  it('never matches by name a handler made for another Steam app', () => {
    const tqae = handler({
      gameName: 'Titan Quest Anniversary Edition',
      title: 'Titan Quest',
      steamId: '475150'
    })
    const l = buildCoopLookup([tqae])
    expect(
      matchCoopHandler(game({ source: 'steam', externalId: '4540', title: 'Titan Quest' }), l)
    ).toBeNull()
    expect(matchCoopHandler(game({ source: 'epic', title: 'Titan Quest' }), l)?.matchedBy).toBe(
      'name'
    )
  })

  it('leaves ROMs alone', () => {
    expect(matchCoopHandler(game({ source: 'rom', title: 'Borderlands 2' }), lookup)).toBeNull()
  })

  it('checks the ExecutableContext files', () => {
    expect(
      matchCoopHandler(game({ exePath: 'D:\\Borderlands2.exe', title: 'x' }), lookup, () => false)
    ).toBeNull()
  })

  it('compares a handler Steam id written with other characters by its digits', () => {
    // The lookup keys are digits only; the comparisons must read the handler's id the same way.
    const spaced = handler({ gameName: 'Space War', exeName: 'Game.exe', steamId: 'app/480' })
    expect(
      matchCoopHandler(
        game({ exePath: 'C:\\S\\Game.exe', title: 'Other', extra: { steamAppId: 480 } }),
        buildCoopLookup([spaced])
      )
    ).toMatchObject({ entry: spaced, matchedBy: 'exe' })
  })

  it('treats a handler Steam id without digits as none when matching by name', () => {
    const none = handler({ gameName: 'Free Game', steamId: 'N/A' })
    expect(
      matchCoopHandler(
        game({ source: 'steam', externalId: '123', title: 'Free Game' }),
        buildCoopLookup([none])
      )
    ).toMatchObject({ entry: none, matchedBy: 'name' })
  })
})

describe('coopRecord', () => {
  it('keeps what the badge and setup need and compares without the date', () => {
    const a = coopRecord({ entry: seamless, matchedBy: 'steam' }, '2026-01-01')
    expect(a).toMatchObject({ gameName: 'Elden Ring', risks: ['eac'], matchedBy: 'steam' })
    expect(
      sameCoopRecord(a, coopRecord({ entry: seamless, matchedBy: 'steam' }, '2027-01-01'))
    ).toBe(true)
    expect(
      sameCoopRecord(a, coopRecord({ entry: seamless, matchedBy: 'name' }, '2027-01-01'))
    ).toBe(false)
  })
})
