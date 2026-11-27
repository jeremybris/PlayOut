import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { Game } from '../../shared/types'
import { gameConfigExecutable, resolvePeerPartyExe, type ExeIo } from './exe'

const DIR = 'D:\\Games\\Thing'

function io(files: string[], texts: Record<string, string> = {}, ranked: string[] = []): ExeIo {
  const full = files.map((f) => join(DIR, f).toLowerCase())
  return {
    async readdir(dir) {
      const rel = dir.toLowerCase() === DIR.toLowerCase() ? '' : dir.slice(DIR.length + 1) + '\\'
      const names = new Map<string, boolean>()
      for (const f of files) {
        if (!f.toLowerCase().startsWith(rel.toLowerCase())) continue
        const parts = f.slice(rel.length).split('\\')
        names.set(parts[0]!, parts.length > 1)
      }
      return [...names].map(([name, isDirectory]) => ({ name, isDirectory, isLink: false }))
    },
    async isFile(path) {
      return full.includes(path.toLowerCase())
    },
    async readText(path) {
      return texts[path] ?? null
    },
    async rankedExes() {
      return ranked.map((r) => join(DIR, r))
    }
  }
}

const game = (g: Partial<Game>): Pick<Game, 'source' | 'installDir' | 'exePath' | 'launch'> => ({
  source: 'epic',
  installDir: DIR,
  launch: { kind: 'uri', uri: 'x://' },
  ...g
})

describe('gameConfigExecutable', () => {
  it("reads MicrosoftGame.config's Executable name", () => {
    expect(
      gameConfigExecutable(
        '<Game><ExecutableList><Executable Name="bin\\Game.exe" Id="Game"/></ExecutableList></Game>'
      )
    ).toBe('bin\\Game.exe')
    expect(gameConfigExecutable('<Game/>')).toBeNull()
  })
})

describe('resolvePeerPartyExe', () => {
  it("takes an Xbox app game's configured program", async () => {
    const f = io(['bin\\Game.exe'], {
      [join(DIR, 'MicrosoftGame.config')]: '<Executable Name="bin\\Game.exe"/>'
    })
    expect(await resolvePeerPartyExe(game({ source: 'xbox' }), f)).toBe(join(DIR, 'bin\\Game.exe'))
  })

  it('takes the known exe unless it is a launcher or outside the folder', async () => {
    const f = io(['Game.exe', 'Launcher.exe'], {}, ['Game.exe'])
    expect(await resolvePeerPartyExe(game({ exePath: join(DIR, 'Game.exe') }), f)).toBe(
      join(DIR, 'Game.exe')
    )
    expect(await resolvePeerPartyExe(game({ exePath: join(DIR, 'Launcher.exe') }), f)).toBe(
      join(DIR, 'Game.exe')
    )
    expect(await resolvePeerPartyExe(game({ exePath: 'C:\\Other\\Game.exe' }), f)).toBe(
      join(DIR, 'Game.exe')
    )
  })

  it("prefers Unreal's shipping exe outside Engine before the ranked guess", async () => {
    const f = io(
      [
        'Thing.exe',
        'Thing\\Binaries\\Win64\\Thing-Win64-Shipping.exe',
        'Engine\\Binaries\\Win64\\X-Win64-Shipping.exe'
      ],
      {},
      ['Thing.exe']
    )
    expect(await resolvePeerPartyExe(game({}), f)).toBe(
      join(DIR, 'Thing\\Binaries\\Win64\\Thing-Win64-Shipping.exe')
    )
  })

  it('takes an exec launch file, else null without a folder', async () => {
    const f = io(['run\\Game.exe'])
    expect(
      await resolvePeerPartyExe(
        game({
          source: 'manual',
          launch: { kind: 'exec', file: join(DIR, 'run\\Game.exe'), args: [] }
        }),
        f
      )
    ).toBe(join(DIR, 'run\\Game.exe'))
    expect(await resolvePeerPartyExe(game({ installDir: undefined }), f)).toBeNull()
  })
})
