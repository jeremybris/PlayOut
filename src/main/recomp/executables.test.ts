import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledRecomp, RecompExecutable } from '../../shared/recomp'
import {
  automaticExe,
  carryExeChoice,
  checkExeChoice,
  chooseExe,
  confirmExe,
  EXE_LIST_MAX,
  exeUnclear,
  listExecutables,
  programOf
} from './executables'
import { defaultCloudState } from './state'

let tmp: string
let dir: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'playout-recomp-exes-'))
  dir = join(tmp, 'Recompilations', 'Burnout')
  await fs.mkdir(dir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

async function touch(path: string): Promise<string> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, 'MZ')
  return path
}

function record(over: Partial<InstalledRecomp> = {}): InstalledRecomp {
  return {
    id: 'github:x/burnout',
    dir,
    tag: 'v1',
    asset: 'Burnout.zip',
    downloadBytes: 1,
    diskBytes: 1,
    sha256: '',
    verified: 'unverified',
    exe: 'Burnout.exe',
    installedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    releaseFiles: ['burnout.exe'],
    autoUpdate: false,
    gameFiles: {},
    savePaths: [],
    saveSource: null,
    cloud: defaultCloudState(),
    prevTag: null,
    ...over
  }
}

const entry = { name: 'Burnout Recompiled', game: 'Burnout Revenge', repo: 'x/burnout' }

describe('checkExeChoice', () => {
  it('stores a program in the folder relative and one elsewhere in full', async () => {
    await touch(join(dir, 'bin', 'Burnout.exe'))
    const outside = await touch(join(tmp, 'Games', 'Burnout Revenge', 'BurnoutRevenge.exe'))
    expect(await checkExeChoice(record(), join(dir, 'bin', 'Burnout.exe'))).toBe(
      join('bin', 'Burnout.exe')
    )
    expect(await checkExeChoice(record(), join('bin', 'Burnout.exe'))).toBe(
      join('bin', 'Burnout.exe')
    )
    expect(await checkExeChoice(record(), outside)).toBe(outside)
  })

  it('refuses what is not an existing .exe file, and a relative path out of the folder', async () => {
    await touch(join(dir, 'readme.txt'))
    await touch(join(tmp, 'Other.exe'))
    await fs.mkdir(join(dir, 'folder.exe'))
    await expect(checkExeChoice(record(), '  ')).rejects.toThrow('Choose a program')
    await expect(checkExeChoice(record(), join(dir, 'readme.txt'))).rejects.toThrow(
      'is not a program'
    )
    await expect(checkExeChoice(record(), join(dir, 'Missing.exe'))).rejects.toThrow(
      'was not found'
    )
    await expect(checkExeChoice(record(), join(dir, 'folder.exe'))).rejects.toThrow('was not found')
    await expect(checkExeChoice(record(), join('..', '..', 'Other.exe'))).rejects.toThrow(
      "is not in the recompilation's folder"
    )
  })
})

describe('choosing and Automatic', () => {
  it('keeps PlayOut’s pick aside and goes back to it', () => {
    const rec = record({ exe: 'Burnout_Installer-win-amd64.exe' })
    chooseExe(rec, 'D:\\Games\\Burnout\\Burnout.exe')
    expect(rec).toMatchObject({
      exe: 'D:\\Games\\Burnout\\Burnout.exe',
      exeChosen: 'user',
      autoExe: 'Burnout_Installer-win-amd64.exe'
    })
    // A second choice keeps the first pick aside, not the first choice.
    chooseExe(rec, 'bin\\Other.exe')
    expect(rec.autoExe).toBe('Burnout_Installer-win-amd64.exe')
    automaticExe(rec, null)
    expect(rec.exe).toBe('Burnout_Installer-win-amd64.exe')
    // Automatic: the player accepted PlayOut's pick.
    expect(rec.exeChosen).toBe('confirmed')
    expect(rec.autoExe).toBeUndefined()
    expect(programOf(rec, null)).toEqual({
      program: 'Burnout_Installer-win-amd64.exe',
      source: 'auto'
    })
  })

  it('starts the user’s choice over the developer’s program, else the developer’s over PlayOut’s pick', () => {
    expect(programOf(record(), null)).toEqual({ program: 'Burnout.exe', source: 'auto' })
    expect(programOf(record(), 'game/Dev.exe')).toEqual({
      program: 'game/Dev.exe',
      source: 'developer'
    })
    expect(
      programOf(record({ exe: 'Mine.exe', exeChosen: 'user', autoExe: 'Burnout.exe' }), 'Dev.exe')
    ).toEqual({ program: 'Mine.exe', source: 'user' })
  })
})

describe('carryExeChoice', () => {
  const log = { warn: vi.fn() }

  it('keeps a choice whose file is still there (inside at the same path, or outside)', async () => {
    await touch(join(dir, 'bin', 'Game.exe'))
    const outside = await touch(join(tmp, 'Games', 'Game.exe'))
    for (const chosen of [join('bin', 'Game.exe'), outside]) {
      const next = record({ exe: 'Burnout.exe' })
      await carryExeChoice(
        next,
        record({ exe: chosen, exeChosen: 'user', autoExe: 'Old.exe' }),
        log
      )
      expect(next).toMatchObject({ exe: chosen, exeChosen: 'user', autoExe: 'Burnout.exe' })
    }
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('drops a choice whose file went, and logs it', async () => {
    const next = record({ exe: 'Burnout.exe' })
    await carryExeChoice(next, record({ exe: join('bin', 'Gone.exe'), exeChosen: 'user' }), log)
    expect(next.exe).toBe('Burnout.exe')
    expect(next.exeChosen).toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Gone.exe'))
  })

  it('leaves PlayOut’s pick alone when nothing was chosen', async () => {
    const next = record({ exe: 'New.exe' })
    await carryExeChoice(next, record({ exe: 'Burnout.exe' }), log)
    expect(next).toEqual(record({ exe: 'New.exe' }))
  })
})

describe('listExecutables', () => {
  it('lists every program, the likely game first and the others marked last', async () => {
    await touch(join(dir, 'Burnout.exe'))
    await touch(join(dir, 'tools', 'shadercompiler.exe'))
    await touch(join(dir, 'unins000.exe'))
    await touch(join(dir, 'crashpad_handler.exe'))
    await touch(join(dir, 'redist', 'vc_redist.x64.exe'))
    await touch(join(dir, 'Burnout_Installer-win-amd64.exe'))
    await touch(join(dir, 'a', 'b', 'c', 'Deep.exe'))
    await touch(join(dir, 'data.pak'))
    const view = await listExecutables(record(), entry, null)
    expect(view.candidates.map((c) => c.path)).toEqual([
      'Burnout.exe',
      join('a', 'b', 'c', 'Deep.exe'),
      'unins000.exe',
      'crashpad_handler.exe',
      'Burnout_Installer-win-amd64.exe',
      join('redist', 'vc_redist.x64.exe'),
      join('tools', 'shadercompiler.exe')
    ])
    expect(view.candidates.map((c) => c.note)).toEqual([
      null,
      null,
      'Uninstaller',
      'Crash reporter',
      'Setup program',
      'Runtime installer',
      'Helper program'
    ])
    expect(view).toMatchObject({
      current: 'Burnout.exe',
      currentFull: join(dir, 'Burnout.exe'),
      source: 'auto',
      auto: 'Burnout.exe',
      outside: false,
      missing: false,
      truncated: false
    })
    expect(view.candidates[0]).toMatchObject({ current: true, auto: true })
  })

  it('shows a chosen program outside the folder, and a missing one', async () => {
    await touch(join(dir, 'Burnout_Installer-win-amd64.exe'))
    const outside = join(tmp, 'Games', 'Burnout Revenge', 'BurnoutRevenge.exe')
    const rec = record({
      exe: outside,
      exeChosen: 'user',
      autoExe: 'Burnout_Installer-win-amd64.exe'
    })
    let view = await listExecutables(rec, entry, null)
    expect(view).toMatchObject({
      current: outside,
      source: 'user',
      auto: 'Burnout_Installer-win-amd64.exe',
      outside: true,
      missing: true
    })
    expect(view.candidates).toEqual([
      expect.objectContaining({
        path: 'Burnout_Installer-win-amd64.exe',
        note: 'Setup program',
        current: false,
        auto: true
      })
    ])
    await touch(outside)
    view = await listExecutables(rec, entry, null)
    expect(view.missing).toBe(false)
  })

  it('caps the list but always keeps the program in use', async () => {
    for (let i = 0; i < EXE_LIST_MAX + 5; i++)
      await touch(join(dir, `Burnout${String(i).padStart(3, '0')}.exe`))
    await touch(join(dir, 'unins000.exe'))
    const view = await listExecutables(record({ exe: 'unins000.exe' }), entry, null)
    expect(view.truncated).toBe(true)
    expect(view.candidates).toHaveLength(EXE_LIST_MAX + 1)
    expect(view.candidates.at(-1)).toMatchObject({ path: 'unins000.exe', current: true })
  })
})

describe('exeUnclear (UP asks which program starts the game)', () => {
  const exe = (path: string, note: string | null = null): RecompExecutable => ({
    path,
    full: path,
    note,
    current: false,
    auto: false
  })
  const several = [exe('Game.exe'), exe('Editor.exe'), exe('unins000.exe', 'Uninstaller')]
  const fresh = { releaseFiles: [] as string[] }

  it('asks when nobody chose and several programs could be the game', () => {
    expect(exeUnclear({ source: 'auto', candidates: several }, fresh, false)).toBe(true)
  })

  it('does not ask once the user chose, or when the developer names the program', () => {
    expect(exeUnclear({ source: 'user', candidates: several }, fresh, false)).toBe(false)
    expect(exeUnclear({ source: 'developer', candidates: several }, fresh, false)).toBe(false)
  })

  it('does not ask once the player accepted PlayOut’s pick (Automatic, or it started the game)', () => {
    const confirmed = { ...fresh, exeChosen: 'confirmed' as const }
    expect(exeUnclear({ source: 'auto', candidates: several }, confirmed, false)).toBe(false)
  })

  it('does not ask with one program that could be the game (helpers do not count)', () => {
    const one = [
      exe('Game.exe'),
      exe('unins000.exe', 'Uninstaller'),
      exe('crashpad_handler.exe', 'Crash reporter'),
      exe('vc_redist.x64.exe', 'Runtime installer'),
      exe('Updater.exe', 'Updater'),
      exe('setup.exe', 'Setup program'),
      exe(join('tools', 'wadgen.exe'), 'Helper program')
    ]
    expect(exeUnclear({ source: 'auto', candidates: one }, fresh, false)).toBe(false)
    expect(exeUnclear({ source: 'auto', candidates: [] }, fresh, false)).toBe(false)
  })

  it('counts only programs the release shipped, when that is known (copied game files do not count)', () => {
    const view = { source: 'auto' as const, candidates: [exe('Game.exe'), exe('Original.exe')] }
    expect(exeUnclear(view, { releaseFiles: ['game.exe', 'readme.txt'] }, false)).toBe(false)
    expect(exeUnclear(view, { releaseFiles: ['game.exe', 'original.exe'] }, false)).toBe(true)
  })

  it('does not count programs deeper than PlayOut looks for its pick', () => {
    const view = {
      source: 'auto' as const,
      candidates: [exe('Game.exe'), exe(join('a', 'b', 'c', 'd', 'Other.exe'))]
    }
    expect(exeUnclear(view, fresh, false)).toBe(false)
  })

  it('does not ask for a setup program (UP runs the setup, as before)', () => {
    expect(exeUnclear({ source: 'auto', candidates: several }, fresh, true)).toBe(false)
  })

  it('confirmExe marks PlayOut’s pick only, never over a user’s choice', () => {
    const rec = record()
    confirmExe(rec)
    expect(rec.exeChosen).toBe('confirmed')
    const chosen = record({ exe: 'Other.exe', exeChosen: 'user', autoExe: 'Burnout.exe' })
    confirmExe(chosen)
    expect(chosen.exeChosen).toBe('user')
  })
})
