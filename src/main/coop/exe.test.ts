import { join, sep } from 'path'
import { describe, expect, it } from 'vitest'
import { findExes, rankExes, resolveCoopExe, type ExeSearchIo } from './exe'

/** A fake folder tree: paths ending with "/" are folders. */
function fakeIo(paths: string[]): ExeSearchIo {
  const norm = (p: string): string => p.replace(/[\\/]+/g, sep).replace(/[\\/]$/, '')
  const all = paths.map((p) => ({ path: norm(p), dir: p.endsWith('/') }))
  return {
    async readdir(dir) {
      const d = norm(dir)
      const kids = all.filter(
        (e) => e.path.startsWith(d + sep) && !e.path.slice(d.length + 1).includes(sep)
      )
      if (!kids.length && !all.some((e) => e.path === d)) throw new Error('ENOENT')
      return kids.map((e) => ({ name: e.path.slice(d.length + 1), isDirectory: e.dir }))
    },
    async exists(p) {
      return all.some((e) => e.path.toLowerCase() === norm(p).toLowerCase())
    }
  }
}

const root = join('D:', 'Steam', 'BL2')
const tree = fakeIo([
  `${root}/`,
  `${root}/Binaries/`,
  `${root}/Binaries/Win32/`,
  `${root}/Binaries/Win32/Borderlands2.exe`,
  `${root}/Binaries/Win64/`,
  `${root}/Binaries/Win64/Borderlands2.exe`,
  `${root}/_CommonRedist/`,
  `${root}/_CommonRedist/Borderlands2.exe`
])

describe('findExes', () => {
  it('finds the exe by name, case-insensitive, outside redistributable folders', async () => {
    const found = await findExes(root, ['borderlands2.exe'], tree)
    expect(found.sort()).toEqual([
      join(root, 'Binaries', 'Win32', 'Borderlands2.exe'),
      join(root, 'Binaries', 'Win64', 'Borderlands2.exe')
    ])
  })
})

describe('rankExes', () => {
  it('prefers the handler BinariesFolder', () => {
    const paths = [
      join(root, 'Binaries', 'Win64', 'a.exe'),
      join(root, 'Binaries', 'Win32', 'a.exe')
    ]
    expect(rankExes(paths, 'Binaries\\Win32')[0]).toBe(paths[1])
  })
})

describe('resolveCoopExe', () => {
  const entry = {
    exeName: 'Borderlands2.exe',
    exeNames: [],
    exeContext: [],
    binariesFolder: 'Binaries\\Win32'
  }
  it('searches the install folder when the game has no exe', async () => {
    const r = await resolveCoopExe({ installDir: root }, entry, undefined, tree)
    expect(r.exePath).toBe(join(root, 'Binaries', 'Win32', 'Borderlands2.exe'))
    expect(r.choices).toHaveLength(2)
  })

  it('uses the user choice while it exists', async () => {
    const chosen = join(root, 'Binaries', 'Win64', 'Borderlands2.exe')
    expect((await resolveCoopExe({ installDir: root }, entry, chosen, tree)).exePath).toBe(chosen)
    expect(
      (await resolveCoopExe({ installDir: root }, entry, 'X:\\gone.exe', tree)).exePath
    ).not.toBe('X:\\gone.exe')
  })

  it('is null when the exe is not installed', async () => {
    expect(
      (await resolveCoopExe({ installDir: join('D:', 'Nope') }, entry, undefined, tree)).exePath
    ).toBeNull()
  })
})
