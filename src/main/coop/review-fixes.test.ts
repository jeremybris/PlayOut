import type { CoopDevice, CoopHandlerEntry, CoopScreen, Game } from '@shared/types'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { contentRootFor } from './coop-service'
import { resolveCoopExe, type ExeSearchIo } from './exe'
import { extractedPaths } from './handler-pack'
import { handlerFileName } from './handler-script'
import { buildCoopLookup, matchCoopHandler } from './match'
import { planSession } from './plan'

const handler = (over: Partial<CoopHandlerEntry>): CoopHandlerEntry => ({
  archive: `handler-${over.gameName ?? 'x'}-v1.nc`,
  gameName: 'Game',
  exeNames: [],
  exeContext: [],
  supportsKeyboard: false,
  supportsMultipleKeyboardsAndMice: false,
  risks: [],
  ...over
})
const game = (over: Partial<Game>): Game =>
  ({
    id: 'g',
    source: 'manual',
    title: 'Some Game',
    user: {},
    metadata: {},
    ...over
  }) as Game

describe('handler names stay inside the handlers folder', () => {
  it('neutralises names that are empty, dots or device names', () => {
    for (const bad of ['..', '.', '???', ' .. ', 'CON', 'nul.txt']) {
      const name = handlerFileName(bad)
      expect(name).toMatch(/^handler-[0-9a-f]+$/)
    }
    expect(handlerFileName('Game.')).toBe('Game')
    const dir = join('C:', 'engine', 'handlers')
    for (const bad of ['..', '.', '']) {
      const paths = extractedPaths(bad, dir)
      expect(paths.folder.startsWith(dir + '\\') || paths.folder.startsWith(dir + '/')).toBe(true)
    }
  })
})

describe('automatic setup honours the per-monitor limit', () => {
  const pad = (i: number): CoopDevice => ({
    id: `xinput:${i}`,
    kind: 'xinput',
    index: i,
    name: 'Pad'
  })
  const screen = (index: number): CoopScreen => ({
    index,
    primary: index === 0,
    bounds: { x: index * 1920, y: 0, width: 1920, height: 1080 }
  })
  const h = {
    maxPlayers: 8,
    maxPlayersOneMonitor: 2,
    supportsKeyboard: false,
    supportsMultipleKeyboardsAndMice: false
  }

  it('never puts more players on a monitor than the handler takes', () => {
    const p = planSession({
      handler: h,
      devices: [pad(0), pad(1), pad(2), pad(3)],
      screens: [screen(0)],
      keyboardAllowed: false
    })
    expect(p.players).toHaveLength(2)
  })

  it('spreads over monitors even with a chosen layout', () => {
    const p = planSession({
      handler: h,
      devices: [pad(0), pad(1), pad(2), pad(3)],
      screens: [screen(0), screen(1)],
      keyboardAllowed: false,
      setup: { layout: 'DualVertical' }
    })
    expect(p.players.map((x) => x.screen)).toEqual([0, 0, 1, 1])
    expect(p.screens.every((s) => s.layout === 'DualVertical')).toBe(true)
  })

  it('says when the game takes one player per monitor', () => {
    const one = { ...h, maxPlayersOneMonitor: 1 }
    expect(
      planSession({
        handler: one,
        devices: [pad(0), pad(1)],
        screens: [screen(0)],
        keyboardAllowed: false
      }).problem
    ).toMatch(/one player per monitor/)
  })
})

describe('matching review fixes', () => {
  it('picks among several handlers sharing a specific exe name', () => {
    const a = handler({ gameName: 'Alpha Remastered', exeName: 'alpha.exe', archive: 'a.nc' })
    const b = handler({ gameName: 'Alpha Mod', exeName: 'alpha.exe', archive: 'b.nc' })
    expect(
      matchCoopHandler(
        game({ exePath: 'C:\\A\\alpha.exe', title: 'Alpha' }),
        buildCoopLookup([a, b])
      )?.matchedBy
    ).toBe('exe')
  })

  it('does not match by name when the known exe contradicts the handler', () => {
    const h = handler({ gameName: 'Doom', exeName: 'doom.exe' })
    expect(
      matchCoopHandler(game({ exePath: 'C:\\D\\DOOMx64.exe', title: 'DOOM' }), buildCoopLookup([h]))
    ).toBeNull()
  })

  it('does not treat an empty name as a match for a generic exe', () => {
    const h = handler({ gameName: '™', exeName: 'game.exe' })
    expect(
      matchCoopHandler(game({ exePath: 'C:\\X\\game.exe', title: '®' }), buildCoopLookup([h]))
    ).toBeNull()
  })
})

describe('exe and instance folders', () => {
  it('keeps the exe PlayOut knows first', async () => {
    const shallow = join('D:', 'G', 'Game.exe')
    const known = join('D:', 'G', 'Binaries', 'Game.exe')
    const io: ExeSearchIo = {
      async readdir(dir) {
        if (dir === join('D:', 'G'))
          return [
            { name: 'Game.exe', isDirectory: false },
            { name: 'Binaries', isDirectory: true }
          ]
        if (dir === join('D:', 'G', 'Binaries')) return [{ name: 'Game.exe', isDirectory: false }]
        return []
      },
      exists: async (p) => p === shallow || p === known
    }
    const r = await resolveCoopExe(
      { exePath: known, installDir: join('D:', 'G') },
      { exeName: 'Game.exe', exeNames: [], exeContext: [] },
      undefined,
      io
    )
    expect(r.exePath).toBe(known)
  })

  it('does not put instance folders inside a game installed at a drive root', () => {
    expect(contentRootFor('D:\\game.exe', 'C:\\engine', 'D:\\')).toBeUndefined()
    expect(contentRootFor('D:\\Games\\X\\game.exe', 'C:\\engine', 'D:\\Games\\X')).toBe(
      'D:\\PlayOut Co-Op'
    )
  })
})
