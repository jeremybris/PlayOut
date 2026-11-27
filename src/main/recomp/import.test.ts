import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RecompEntry } from '../../shared/recomp'
import type { RecompCatalog } from './catalog'
import {
  detectImport,
  matchCandidate,
  onlyLauncherLeftovers,
  rebaseInto,
  rewriteOldPaths,
  versionFromText,
  type ImportCandidate
} from './import'
import { stubEntry } from './service'

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'recomp-import-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function file(path: string, text = 'x'): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, text)
}

/** A Quiver Launcher folder as the user's: apps.json, QuiverLauncher.exe, apps\<GameName>-<Project>. */
async function quiver(root: string): Promise<string> {
  await file(join(root, 'QuiverLauncher.exe'))
  await file(join(root, '.portable'), '')
  await file(join(root, 'settings.json'), JSON.stringify({ AppsPath: '' }))
  await file(
    join(root, 'apps.json'),
    JSON.stringify({
      apps: [
        {
          name: 'Skate',
          folderName: 'Skate-Skate1Recompiled',
          repository: 'someone/Skate1Recompiled',
          project: 'Skate1Recompiled'
        },
        {
          name: 'Burnout Revenge',
          folderName: 'BurnoutRevenge-Xerenge',
          repository: 'Shipa-2/Xerenge'
        },
        {
          name: 'Some GitLab Port',
          folderName: 'SomePort-Port',
          repository: 'group/port',
          repositorySource: 'gitlab'
        },
        { name: 'FreeRCT', folderName: 'RollerCoasterTycoon-FreeRCT', repository: null }
      ]
    })
  )
  const apps = join(root, 'Apps')
  const skate = join(apps, 'Skate-Skate1Recompiled')
  await file(join(skate, 'skate1.exe'))
  await file(join(skate, 'version.txt'), 'v0.2.0\n')
  await file(join(skate, 'installed-build.txt'), `Skate1-PC-v0.2.0.zip\n${'a'.repeat(64)}\n`)
  await file(
    join(skate, 'selected_executable.txt'),
    join(root, 'Apps', 'Skate-Skate1Recompiled', 'skate1.exe')
  )
  const burnout = join(apps, 'BurnoutRevenge-Xerenge')
  await file(join(burnout, 'Xerenge-Setup.exe'))
  await file(join(burnout, 'version.txt'), 'V3')
  await file(join(apps, 'SomePort-Port', 'port.exe'))
  await file(join(apps, 'RollerCoasterTycoon-FreeRCT', 'Place app files here.txt'))
  await fs.mkdir(join(apps, '.staging'), { recursive: true })
  return apps
}

describe('detectImport: Quiver Launcher', () => {
  it("reads the launcher's folder: apps.json names each app's repository; placeholders are not installs", async () => {
    const root = join(tmp, 'Quiver Launcher')
    await quiver(root)
    const { candidates, ignored } = await detectImport([root])
    expect(candidates.map((c) => c.name).sort()).toEqual([
      'Burnout Revenge',
      'Skate',
      'Some GitLab Port'
    ])
    expect(ignored).toBe(1)
    const skate = candidates.find((c) => c.name === 'Skate')!
    expect(skate).toMatchObject({
      launcher: 'quiver',
      repo: { host: 'github', repo: 'someone/Skate1Recompiled' },
      tag: 'v0.2.0',
      asset: 'Skate1-PC-v0.2.0.zip',
      sha256: 'a'.repeat(64),
      releaseFiles: [],
      installerOnly: false
    })
    expect(skate.userExe).toMatch(/skate1\.exe$/)
    expect(candidates.find((c) => c.name === 'Some GitLab Port')!.repo).toEqual({
      host: 'gitlab',
      repo: 'group/port'
    })
    expect(candidates.find((c) => c.name === 'Burnout Revenge')!.installerOnly).toBe(true)
  })

  it('reads the apps folder, and one app folder, the same way', async () => {
    const root = join(tmp, 'Quiver Launcher')
    const apps = await quiver(root)
    expect((await detectImport([apps])).candidates).toHaveLength(3)
    const one = await detectImport([join(apps, 'Skate-Skate1Recompiled')])
    expect(one.candidates.map((c) => c.name)).toEqual(['Skate'])
  })

  it("finds a Quiver Launcher folder among the picked folder's children (one level only)", async () => {
    await quiver(join(tmp, 'Desktop', 'Quiver Launcher'))
    expect((await detectImport([join(tmp, 'Desktop')])).candidates).toHaveLength(3)
    // Two levels down is not looked at.
    expect((await detectImport([tmp])).candidates).toHaveLength(0)
  })
})

describe('detectImport: RecompLauncher', () => {
  it('reads a library: each folder is the app id; recomplauncher.json names the repository; a version file is read', async () => {
    const lib = join(tmp, 'Recomp Library')
    await fs.mkdir(join(lib, '.staging'), { recursive: true })
    await fs.mkdir(join(lib, '.backups', 'downhill-revived', 'saves'), { recursive: true })
    await file(join(lib, 'zelda64recomp', 'Zelda64Recompiled.exe'))
    await file(join(lib, 'xcx-recomp', 'xcx.exe'))
    await file(join(lib, 'xcx-recomp', 'VERSION.txt'), 'ProjectVersion=0.1.21\n')
    await file(join(lib, 'ssx-recomp', 'ssx-recomp.exe'))
    await file(
      join(lib, 'ssx-recomp', 'recomplauncher.json'),
      JSON.stringify({
        format: 1,
        name: 'SSX',
        repo: 'AmarilloNL/ssx-recomp',
        game: { kind: 'iso_or_folder' }
      })
    )
    await file(join(lib, 'downhill-revived', 'downhill.exe'))
    await file(join(lib, 'burnout3', 'Burnout3-Setup.exe'))
    await fs.mkdir(join(lib, 'empty'))
    const { candidates, ignored } = await detectImport([lib])
    expect(candidates.map((c) => c.rlId)).toEqual([
      'burnout3',
      'downhill-revived',
      'ssx-recomp',
      'xcx-recomp',
      'zelda64recomp'
    ])
    expect(ignored).toBe(1)
    const ssx = candidates.find((c) => c.rlId === 'ssx-recomp')!
    expect(ssx).toMatchObject({
      launcher: 'recomplauncher',
      name: 'SSX',
      repo: { host: 'github', repo: 'AmarilloNL/ssx-recomp' },
      readsGameInPlace: true
    })
    expect(candidates.find((c) => c.rlId === 'xcx-recomp')!.tag).toBe('0.1.21')
    expect(candidates.find((c) => c.rlId === 'zelda64recomp')!.tag).toBeNull()
    expect(candidates.find((c) => c.rlId === 'burnout3')!.installerOnly).toBe(true)
    expect(candidates.find((c) => c.rlId === 'downhill-revived')!.launcherBackups).toBe(
      join(lib, '.backups', 'downhill-revived')
    )
  })

  it('reads one app folder of a library', async () => {
    const lib = join(tmp, 'Recomp Library')
    await fs.mkdir(join(lib, '.downloads'), { recursive: true })
    await file(join(lib, 'zelda64recomp', 'Zelda64Recompiled.exe'))
    const { candidates } = await detectImport([join(lib, 'zelda64recomp')])
    expect(candidates.map((c) => [c.launcher, c.rlId])).toEqual([
      ['recomplauncher', 'zelda64recomp']
    ])
  })
})

describe('detectImport: Decomp Buddy', () => {
  const manifest = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      decompBuddyVersion: 1,
      setUpAt: '2026-10-01T10:00:00.000Z',
      target: 'windows',
      repo: 'Zelda64Recomp/Zelda64Recomp',
      repoUrl: 'https://github.com/Zelda64Recomp/Zelda64Recomp',
      release: {
        tag: 'v1.2.2',
        url: 'https://github.com/x/releases/v1.2.2',
        files: ['Zelda64Recompiled.exe', 'assets\\a.bin']
      },
      folder: 'Zelda 64 - N64',
      status: 'ready',
      plan: {
        game_title: "The Legend of Zelda: Majora's Mask",
        console: 'N64',
        build: { executable: 'Zelda64Recompiled.exe' }
      },
      ...over
    })

  it('reads decomp-buddy.json in each game folder; a set-up for a console is refused', async () => {
    const games = join(tmp, 'Games', 'Decomp Buddy')
    await file(join(games, 'Zelda 64 - N64', 'decomp-buddy.json'), manifest())
    await file(join(games, 'Zelda 64 - N64', 'Zelda64Recompiled.exe'))
    await file(join(games, 'Phone - Android', 'decomp-buddy.json'), manifest({ target: 'android' }))
    await file(join(games, 'Phone - Android', 'game.apk'))
    await fs.mkdir(join(games, 'Console Games'), { recursive: true })
    const { candidates, ignored } = await detectImport([games])
    expect(ignored).toBe(1)
    const zelda = candidates.find((c) => c.refused === null)!
    expect(zelda).toMatchObject({
      launcher: 'decompbuddy',
      name: "The Legend of Zelda: Majora's Mask",
      repo: { host: 'github', repo: 'Zelda64Recomp/Zelda64Recomp' },
      tag: 'v1.2.2',
      exeHint: 'Zelda64Recompiled.exe',
      releaseFiles: ['zelda64recompiled.exe', 'assets/a.bin'],
      installedAt: '2026-10-01T10:00:00.000Z'
    })
    expect(candidates.find((c) => c.refused === 'not-windows')).toBeTruthy()
  })

  it('skips folders it is told to (the Recompilations folder)', async () => {
    const games = join(tmp, 'Games')
    await file(join(games, 'A', 'decomp-buddy.json'), manifest())
    await file(join(games, 'B', 'decomp-buddy.json'), manifest())
    const { candidates } = await detectImport([games], (dir) => dir.endsWith('B'))
    expect(candidates).toHaveLength(1)
  })
})

function entry(over: Partial<RecompEntry> & { id: string }): RecompEntry {
  const base = stubEntry(over.id, null)
  return { ...base, ...over }
}

function catalogOf(list: RecompEntry[], rl: Record<string, string[]> = {}): RecompCatalog {
  const byRepo = new Map<string, string[]>()
  for (const e of list) {
    const key = `${e.host}:${e.repo}`.toLowerCase()
    byRepo.set(key, [...(byRepo.get(key) ?? []), e.id])
  }
  return {
    entries: new Map(list.map((e) => [e.id, e])),
    titles: new Map(),
    byRepo,
    byRl: new Map(Object.entries(rl)),
    fetchedAt: { 'decomp-buddy': null, recomplauncher: null },
    offline: []
  }
}

function candidate(over: Partial<ImportCandidate>): ImportCandidate {
  return {
    folder: 'C:\\x',
    launcher: 'quiver',
    name: 'X',
    otherNames: [],
    repo: null,
    rlId: null,
    tag: null,
    asset: null,
    sha256: null,
    exeHint: null,
    userExe: null,
    releaseFiles: [],
    installedAt: null,
    installerOnly: false,
    readsGameInPlace: false,
    launcherBackups: null,
    refused: null,
    ...over
  }
}

describe('matchCandidate', () => {
  const ssx3a = entry({
    id: 'github:bertibertig/ssx3-recomp',
    repo: 'bertibertig/SSX3-Recomp',
    game: 'SSX 3'
  })
  const ssx3b = entry({
    id: 'github:koenhendriks/ssx3-recomp',
    repo: 'koenhendriks/SSX3-recomp',
    game: 'SSX 3'
  })
  const sonic1 = entry({ id: 'github:rdc/decomp#sonic-1', repo: 'rdc/decomp', game: 'Sonic 1' })
  const sonic2 = entry({ id: 'github:rdc/decomp#sonic-2', repo: 'rdc/decomp', game: 'Sonic 2' })
  const moved = entry({
    id: 'github:harbourmasters/2ship2harkinian',
    repo: 'HarbourMasters/2ship2harkinian',
    game: "Majora's Mask"
  })
  const cat = catalogOf([ssx3a, ssx3b, sonic1, sonic2, moved], { 'ssx3-recomp': [ssx3b.id] })

  it('goes by repository first: the same game from two projects is never mixed up', () => {
    expect(
      matchCandidate(candidate({ repo: { host: 'github', repo: 'BertiBertig/SSX3-Recomp' } }), cat)
    ).toEqual({
      match: 'repo',
      ids: [ssx3a.id]
    })
    expect(matchCandidate(candidate({ rlId: 'ssx3-recomp', name: 'SSX 3' }), cat)).toEqual({
      match: 'launcher-id',
      ids: [ssx3b.id]
    })
  })

  it('a multi-game repository gives every game to choose from', () => {
    const m = matchCandidate(candidate({ repo: { host: 'github', repo: 'rdc/decomp' } }), cat)
    expect(m.match).toBe('repo')
    expect(m.ids.sort()).toEqual([sonic1.id, sonic2.id].sort())
  })

  it('a project that moved owner, or the game name alone, is only a suggestion', () => {
    expect(
      matchCandidate(
        candidate({ repo: { host: 'github', repo: '2ship2harkinian/2ship2harkinian' } }),
        cat
      )
    ).toEqual({ match: 'title', ids: [moved.id] })
    expect(matchCandidate(candidate({ name: "Majora's Mask" }), cat)).toEqual({
      match: 'title',
      ids: [moved.id]
    })
    expect(
      matchCandidate(candidate({ name: 'Metroid Prime 2', rlId: 'metroidprime2port' }), cat)
    ).toEqual({
      match: 'none',
      ids: []
    })
    expect(matchCandidate(candidate({ name: 'X' }), null)).toEqual({ match: 'none', ids: [] })
  })
})

describe('versionFromText', () => {
  it('reads the versions projects write', () => {
    expect(versionFromText('ProjectVersion=0.0.8')).toBe('0.0.8')
    expect(versionFromText('0.4.1+6151ac4f')).toBe('0.4.1')
    expect(versionFromText('ico-pc v0.11.8 built 2026-10-01')).toBe('0.11.8')
    expect(versionFromText('{"version":"v0.1.13"}')).toBe('0.1.13')
    expect(versionFromText('nothing here')).toBeNull()
  })
})

describe('rewriteOldPaths', () => {
  it('rewrites the old folder in small settings files (kept as .playout-old), not in logs', async () => {
    const from = join(tmp, 'Quiver Launcher', 'apps', 'FableII-FableIIRecompiled')
    const to = join(tmp, 'Recompilations', 'Fable II (x-fable)')
    const fromUpper = from.replace(/\\apps\\/, '\\Apps\\')
    await file(join(to, 'launcher-game-path.txt'), `${fromUpper}\\game\\default.xex`)
    await file(
      join(to, 'user', 'launcher_settings.json'),
      JSON.stringify({ sys_modules: `${from}\\sys`, other: `${from}2\\keep` })
    )
    await file(join(to, 'quiver-launch.log'), `${from}\\x`)
    const changed = await rewriteOldPaths(to, from, to)
    expect(changed).toHaveLength(2)
    expect(await fs.readFile(join(to, 'launcher-game-path.txt'), 'utf8')).toBe(
      `${to}\\game\\default.xex`
    )
    const json = JSON.parse(await fs.readFile(join(to, 'user', 'launcher_settings.json'), 'utf8'))
    expect(json.sys_modules).toBe(`${to}\\sys`)
    // A different folder whose name only starts the same is left alone.
    expect(json.other).toBe(`${from}2\\keep`)
    expect(await fs.readFile(join(to, 'quiver-launch.log'), 'utf8')).toBe(`${from}\\x`)
    expect(await fs.readFile(join(to, 'launcher-game-path.txt.playout-old'), 'utf8')).toContain(
      'default.xex'
    )
  })

  it('rebases a path inside the old folder', () => {
    expect(rebaseInto('C:\\A\\Apps\\X\\x.exe', 'C:\\A\\apps\\X', 'D:\\R\\X (x)')).toBe(
      'D:\\R\\X (x)\\x.exe'
    )
    expect(rebaseInto('C:\\Games\\Burnout\\b.exe', 'C:\\A\\apps\\X', 'D:\\R')).toBeNull()
  })
})

describe('import review fixes', () => {
  it('rewriteOldPaths never rewrites another folder that only starts with the old name', async () => {
    const from = join(tmp, 'Lib', 'Zelda')
    const to = join(tmp, 'New', 'Zelda (z)')
    const cfg = join(to, 'settings.ini')
    const sibling = join(tmp, 'Lib', 'Zelda 2', 'save.dat')
    await file(cfg, `other=${sibling}\nmine=${join(from, 'game.exe')}\nend=${from}\n`)
    await rewriteOldPaths(to, from, to)
    expect(await fs.readFile(cfg, 'utf8')).toBe(
      `other=${sibling}\nmine=${join(to, 'game.exe')}\nend=${to}\n`
    )
  })

  it('rewriteOldPaths keeps every other byte of a file that is not UTF-8 (an ANSI .ini)', async () => {
    const from = join(tmp, 'Lib', 'Zelda')
    const to = join(tmp, 'New', 'Zelda (z)')
    const cfg = join(to, 'config.ini')
    const head = Buffer.concat([Buffer.from('name=Pok'), Buffer.from([0xe9]), Buffer.from('mon\n')])
    await fs.mkdir(to, { recursive: true })
    await fs.writeFile(
      cfg,
      Buffer.concat([head, Buffer.from(`path=${join(from, 'game.exe')}\n`, 'latin1')])
    )
    await rewriteOldPaths(to, from, to)
    expect(await fs.readFile(cfg)).toEqual(
      Buffer.concat([head, Buffer.from(`path=${join(to, 'game.exe')}\n`, 'latin1')])
    )
  })

  it('rewriteOldPaths always keeps the file first, beside an earlier backup', async () => {
    const from = join(tmp, 'Lib', 'Zelda')
    const to = join(tmp, 'New', 'Zelda (z)')
    const cfg = join(to, 'a.json')
    const before = JSON.stringify({ p: join(from, 'x') })
    await file(cfg, before)
    await file(`${cfg}.playout-old`, 'unrelated older file')
    await rewriteOldPaths(to, from, to)
    expect(await fs.readFile(`${cfg}.playout-old`, 'utf8')).toBe('unrelated older file')
    expect(await fs.readFile(`${cfg}.playout-old-2`, 'utf8')).toBe(before)
    expect(await fs.readFile(cfg, 'utf8')).not.toContain('Lib')
  })

  it("Quiver's apps folder without its Quiver folder beside it is still read as Quiver's (not RecompLauncher's)", async () => {
    const apps = join(tmp, 'Custom', 'apps')
    await fs.mkdir(join(apps, '.staging'), { recursive: true })
    await fs.mkdir(join(apps, '.downloads'), { recursive: true })
    const ssx = join(apps, 'SSX3-SSX3Recomp')
    await file(join(ssx, 'version.txt'), 'v1.0')
    await file(join(ssx, 'installed-build.txt'), `ssx3.zip\n${'a'.repeat(64)}`)
    await file(join(ssx, 'ssx3.exe'), 'MZ')
    for (const picked of [apps, ssx]) {
      const { candidates } = await detectImport([picked])
      expect(candidates).toHaveLength(1)
      expect(candidates[0]).toMatchObject({ launcher: 'quiver', tag: 'v1.0', rlId: null })
      expect(candidates[0]!.sha256).toBe('a'.repeat(64))
    }
  })

  it("a Quiver apps folder set to Documents offers only Quiver's own apps", async () => {
    const docs = join(tmp, 'Documents')
    await file(join(docs, 'Emulation', 'saves', 'memcard.ps2'), 'card')
    await file(join(docs, 'My Games', 'x.sav'), 'x')
    await file(join(docs, 'Listed', 'game.exe'), 'MZ')
    const q = join(tmp, 'Quiver Launcher')
    await file(join(q, 'QuiverLauncher.exe'))
    await file(
      join(q, 'apps.json'),
      JSON.stringify({ apps: [{ folderName: 'Listed', repository: 'a/b', name: 'Listed' }] })
    )
    await file(join(q, 'settings.json'), JSON.stringify({ AppsPath: docs }))
    const { candidates } = await detectImport([q])
    expect(candidates.map((c) => c.folder)).toEqual([join(docs, 'Listed')])
  })

  it("onlyLauncherLeftovers: Quiver's placeholder is a leftover, anything else is not", async () => {
    const a = join(tmp, 'a')
    await file(join(a, 'Place app files here.txt'), '')
    expect(await onlyLauncherLeftovers(a)).toBe(true)
    await file(join(a, 'save.dat'), 'x')
    expect(await onlyLauncherLeftovers(a)).toBe(false)
    const b = join(tmp, 'b')
    await fs.mkdir(join(b, 'sub'), { recursive: true })
    expect(await onlyLauncherLeftovers(b)).toBe(false)
  })
})
