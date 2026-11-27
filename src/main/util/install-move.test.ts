import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  installDirRegArgs,
  oldDefaultInstallDir,
  readInstallMove,
  recordInstallMove,
  underProgramFiles
} from './install-move'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-move-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readInstallMove / recordInstallMove', () => {
  it('on the first start, rebases from the old default folder; once recorded, from the folder it ran from', () => {
    const userData = join(dir, 'userData')
    const local = join(dir, 'Local')
    const old = oldDefaultInstallDir(local)
    const games = join(dir, 'Games', 'PlayOut')
    expect(readInstallMove(games, userData, local)).toEqual({ moved: true, rebaseFrom: [old] })
    recordInstallMove(games, userData)
    expect(JSON.parse(readFileSync(join(userData, 'install-dir.json'), 'utf8'))).toEqual({
      exeDir: games
    })
    expect(readInstallMove(games, userData, local).moved).toBe(false)
    // The user moved the folder: the folder it ran from first.
    const other = join(dir, 'Other', 'PlayOut')
    expect(readInstallMove(other, userData, local)).toEqual({
      moved: true,
      rebaseFrom: [games, old]
    })
  })

  it('names nothing when PlayOut still runs from the old default folder', () => {
    const local = join(dir, 'Local')
    expect(readInstallMove(oldDefaultInstallDir(local), join(dir, 'u'), local).rebaseFrom).toEqual(
      []
    )
  })

  it('reads an older record that also listed folders still to move', () => {
    const userData = join(dir, 'userData')
    const games = join(dir, 'Games', 'PlayOut')
    recordInstallMove(games, userData)
    writeFileSync(
      join(userData, 'install-dir.json'),
      JSON.stringify({ exeDir: games, pending: [join(dir, 'x')] })
    )
    expect(readInstallMove(games, userData, join(dir, 'Local')).moved).toBe(false)
  })
})

describe('underProgramFiles', () => {
  it('tells an install for all users from a per-user folder', () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)'
    }
    expect(underProgramFiles('C:\\Program Files\\PlayOut', env)).toBe(true)
    expect(underProgramFiles('c:\\program files (x86)\\PlayOut', env)).toBe(true)
    expect(underProgramFiles('C:\\Program Files Extra\\PlayOut', env)).toBe(false)
    expect(underProgramFiles('C:\\Users\\me\\Games\\PlayOut', env)).toBe(false)
    expect(underProgramFiles('C:\\Users\\me\\Games\\PlayOut', {})).toBe(false)
  })
})

describe('installDirRegArgs', () => {
  it('records the folder in PlayOut’s own key, without a trailing backslash', () => {
    expect(installDirRegArgs('D:\\My Games\\PlayOut\\')).toEqual([
      'add',
      'HKCU\\Software\\PlayOut',
      '/v',
      'InstallDir',
      '/t',
      'REG_SZ',
      '/d',
      'D:\\My Games\\PlayOut',
      '/f'
    ])
  })
})
