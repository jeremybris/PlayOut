import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../shared/defaults'
import type { UninstallEntry } from '../system/uninstall'
import type { WalkEntry } from '../util/fs'
import {
  buildScannedGame,
  candidatesFromMfst,
  candidatesFromUninstallEntries,
  eaProvider,
  evaluateCandidate,
  isMfstInstalled,
  mergeCandidates,
  parseInstallerData,
  parseMfst,
  pickLauncher,
  pickTitle,
  resolveLauncherPath,
  splitParameters,
  type CandidateDeps,
  type EaCandidate
} from './ea'

const verbose = { debug: () => {}, info: console.info, warn: console.warn, error: console.error }
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** A fake file system for evaluateCandidate: directories, text files and plain existing files. */
function fakeFs(input: {
  dirs?: string[]
  texts?: Record<string, string>
  files?: string[]
  exe?: string | null
}): CandidateDeps {
  const dirs = new Set(input.dirs ?? [])
  const texts = input.texts ?? {}
  const files = new Set([...(input.files ?? []), ...Object.keys(texts)])
  return {
    isDirectory: async (p) => dirs.has(p),
    isFile: async (p) => files.has(p),
    readText: async (p) => texts[p] ?? null,
    resolveLauncher: async () => input.exe ?? null
  }
}

function entry(partial: Partial<UninstallEntry>): UninstallEntry {
  return {
    keyName: partial.keyName ?? 'key',
    hive: 'HKLM',
    view: 'x86',
    displayName: '',
    installLocation: '',
    uninstallString: '',
    publisher: '',
    displayIcon: '',
    displayVersion: '',
    ...partial
  }
}

const INSTALLER_DATA = `<?xml version="1.0" encoding="utf-8"?>
<DiPManifest version="4.0">
  <buildMetaData>
    <gameVersion version="1.0.0.1"/>
    <requirements osMinVersion="6.0" osReqs64Bit="1"/>
  </buildMetaData>
  <contentIDs>
    <contentID>1013894</contentID>
    <contentID>1018201</contentID>
  </contentIDs>
  <gameTitles>
    <gameTitle locale="de_DE">Battlefield 4™ (DE)</gameTitle>
    <gameTitle locale="en_US">Battlefield 4™</gameTitle>
  </gameTitles>
  <runtime>
    <launcher uid="trial">
      <name locale="en_US">Battlefield 4 Trial</name>
      <filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Battlefield 4\\Install Dir]bf4_trial.exe</filePath>
      <parameters></parameters>
      <executeElevated>0</executeElevated>
      <requires64BitOS>1</requires64BitOS>
      <trial>1</trial>
    </launcher>
    <launcher uid="x86">
      <name locale="en_US">Battlefield 4 (32-bit)</name>
      <filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Battlefield 4\\Install Dir]bf4_x86.exe</filePath>
      <parameters>-x86</parameters>
      <executeElevated>0</executeElevated>
      <requires64BitOS>0</requires64BitOS>
      <trial>0</trial>
    </launcher>
    <launcher uid="x64">
      <name locale="en_US">Battlefield 4</name>
      <filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Battlefield 4\\Install Dir]bf4.exe</filePath>
      <parameters>-dataPath "C:\\Data Path" -fullscreen</parameters>
      <executeElevated>0</executeElevated>
      <requires64BitOS>1</requires64BitOS>
      <trial>0</trial>
    </launcher>
  </runtime>
</DiPManifest>`

describe('installerdata.xml', () => {
  it('extracts content ids, titles and launchers', () => {
    const data = parseInstallerData(INSTALLER_DATA)
    expect(data).not.toBeNull()
    expect(data!.contentIds).toEqual(['1013894', '1018201'])
    expect(data!.titles).toEqual({ de_DE: 'Battlefield 4™ (DE)', en_US: 'Battlefield 4™' })
    expect(pickTitle(data!.titles)).toBe('Battlefield 4™')
    expect(data!.launchers).toHaveLength(3)
    expect(data!.launchers[2]).toEqual({
      filePath: '[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Battlefield 4\\Install Dir]bf4.exe',
      parameters: '-dataPath "C:\\Data Path" -fullscreen',
      trial: false,
      requires64BitOS: true,
      executeElevated: false,
      name: 'Battlefield 4'
    })
  })

  it('prefers the first non-trial 64-bit launcher', () => {
    const data = parseInstallerData(INSTALLER_DATA)!
    expect(pickLauncher(data.launchers)?.name).toBe('Battlefield 4')
    expect(pickLauncher(data.launchers.slice(0, 2))?.name).toBe('Battlefield 4 (32-bit)')
    expect(pickLauncher([data.launchers[0]])?.name).toBe('Battlefield 4 Trial')
    expect(pickLauncher([])).toBeUndefined()
  })

  it('handles a single content id and rejects other documents', () => {
    const data = parseInstallerData(
      '<DiPManifest><contentIDs><contentID>OFB-EAST:109552409</contentID></contentIDs><gameTitles><gameTitle locale="en_US">Titanfall</gameTitle></gameTitles></DiPManifest>'
    )
    expect(data).toEqual({
      contentIds: ['OFB-EAST:109552409'],
      titles: { en_US: 'Titanfall' },
      launchers: []
    })
    expect(parseInstallerData('<html><body/></html>')).toBeNull()
    expect(parseInstallerData('not xml <<<')).toBeNull()
  })

  it('resolves registry-style launcher paths through the registry, then the install dir', async () => {
    const lookup = async (hive: string, path: string, name: string): Promise<string | null> =>
      hive === 'HKLM' && path === 'SOFTWARE\\EA Games\\Battlefield 4' && name === 'Install Dir'
        ? 'D:\\Games\\BF4'
        : null
    const files = new Set([
      'D:\\Games\\BF4\\bf4.exe',
      'C:\\Install\\bf4_x86.exe',
      'C:\\Install\\Game\\Bin\\TS4_x64.exe'
    ])
    const exists = async (p: string): Promise<boolean> => files.has(p)
    expect(
      await resolveLauncherPath(
        '[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\Battlefield 4\\Install Dir]bf4.exe',
        'C:\\Install',
        lookup,
        exists
      )
    ).toBe('D:\\Games\\BF4\\bf4.exe')
    expect(
      await resolveLauncherPath(
        '[HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\EA Games\\Battlefield 4\\Install Dir]bf4_x86.exe',
        'C:\\Install',
        lookup,
        exists
      )
    ).toBe('C:\\Install\\bf4_x86.exe')
    expect(await resolveLauncherPath('Game\\Bin\\TS4_x64.exe', 'C:\\Install', lookup, exists)).toBe(
      'C:\\Install\\Game\\Bin\\TS4_x64.exe'
    )
    expect(
      await resolveLauncherPath('https://www.ea.com/play', 'C:\\Install', lookup, exists)
    ).toBeNull()
    expect(await resolveLauncherPath('missing.exe', 'C:\\Install', lookup, exists)).toBeNull()
  })

  it('splits launcher parameters like a shell', () => {
    expect(splitParameters('-dataPath "C:\\Data Path" -fullscreen')).toEqual([
      '-dataPath',
      'C:\\Data Path',
      '-fullscreen'
    ])
    expect(splitParameters('')).toEqual([])
  })
})

describe('Origin *.mfst', () => {
  it('parses the install path, offer id and state', () => {
    const text =
      '?currentstate=kReadyToStart&ddinitialdownload=0&dipinstallpath=C%3A%5CProgram%20Files%20%28x86%29%5COrigin%20Games%5CTitanfall%5C&id=OFB-EAST%3A109552409&previousstate=kCompleted'
    expect(parseMfst(text, 'OFB-EAST109552409.mfst')).toEqual({
      offerId: 'OFB-EAST:109552409',
      installPath: 'C:\\Program Files (x86)\\Origin Games\\Titanfall',
      state: 'kReadyToStart'
    })
  })

  it('derives the offer id from the file name when the text lacks it', () => {
    expect(
      parseMfst(
        '?currentstate=kPaused&dipinstallpath=D%3A%5CGames%5CApex',
        'Origin.OFR.50.0002694.mfst'
      )
    ).toEqual({
      offerId: 'Origin.OFR.50.0002694',
      installPath: 'D:\\Games\\Apex',
      state: 'kPaused'
    })
    expect(parseMfst('?dipinstallpath=D%3A%5CGames%5CBF', 'OFB-EAST55409.mfst').offerId).toBe(
      'OFB-EAST:55409'
    )
    expect(parseMfst('').installPath).toBeNull()
  })

  it('treats only completed download states as installed', () => {
    expect(isMfstInstalled('kReadyToStart')).toBe(true)
    expect(isMfstInstalled('kCompleted')).toBe(true)
    expect(isMfstInstalled(null)).toBe(true)
    expect(isMfstInstalled(undefined)).toBe(true)
    expect(isMfstInstalled('kPaused')).toBe(false)
    expect(isMfstInstalled('kTransferring')).toBe(false)
    expect(isMfstInstalled('kEnqueued')).toBe(false)
    expect(isMfstInstalled('kInstalling')).toBe(false)
  })

  it('does not turn a paused or in-flight download into a candidate', async () => {
    const root = 'C:\\ProgramData\\Origin\\LocalContent'
    const manifests: Record<string, string> = {
      [`${root}\\Titanfall\\OFB-EAST109552409.mfst`]:
        '?currentstate=kReadyToStart&dipinstallpath=C%3A%5COrigin%20Games%5CTitanfall%5C&id=OFB-EAST%3A109552409',
      [`${root}\\Apex\\Origin.OFR.50.0002694.mfst`]:
        '?currentstate=kPaused&dipinstallpath=D%3A%5CGames%5CApex&id=Origin.OFR.50.0002694',
      [`${root}\\BF2042\\Origin.OFR.50.0004000.mfst`]:
        '?currentstate=kTransferring&dipinstallpath=D%3A%5CGames%5CBF2042&id=Origin.OFR.50.0004000',
      [`${root}\\Legacy\\OFB-EAST55409.mfst`]: '?dipinstallpath=D%3A%5CGames%5CBF'
    }
    async function* walk(): AsyncGenerator<WalkEntry> {
      for (const path of Object.keys(manifests)) {
        const parts = path.split('\\')
        yield { path, name: parts[parts.length - 1], depth: 1, isDirectory: false }
      }
    }
    const candidates = await candidatesFromMfst(silent, {
      root,
      isDirectory: async (p) => p === root,
      walk,
      readText: async (p) => manifests[p] ?? null
    })
    expect(candidates.map((c) => c.dir).sort()).toEqual([
      'C:\\Origin Games\\Titanfall',
      'D:\\Games\\BF'
    ])
    expect(candidates.find((c) => c.offerId === 'OFB-EAST:109552409')?.mfstState).toBe(
      'kReadyToStart'
    )
    expect(candidates.every((c) => c.sources.has('mfst'))).toBe(true)
  })
})

describe('candidate folders', () => {
  it('collapses DLC rows onto the base game and strips trademarks', () => {
    const rows = [
      entry({
        keyName: '{C05D8CDB}_The Sims 3 Pets',
        displayName: 'The Sims™ 3 Pets',
        installLocation: 'C:\\Program Files\\EA Games\\The Sims 3\\',
        publisher: 'Electronic Arts Inc.',
        displayIcon: '"C:\\Program Files\\EA Games\\The Sims 3\\EP05\\Sims3EP05.ico"'
      }),
      entry({
        keyName: '{C05D8CDB}',
        displayName: 'The Sims™ 3',
        installLocation: 'C:\\Program Files\\EA Games\\The Sims 3\\',
        publisher: 'Electronic Arts Inc.',
        displayIcon: '"C:\\Program Files\\EA Games\\The Sims 3\\Game\\Bin\\Sims3Launcher.exe"'
      }),
      entry({
        keyName: '{0843d159}',
        displayName: 'EA app',
        installLocation: '',
        publisher: 'Electronic Arts'
      }),
      entry({
        keyName: 'Steam App 620',
        displayName: 'Portal 2',
        installLocation: 'C:\\Steam\\steamapps\\common\\Portal 2',
        publisher: 'Valve'
      })
    ]
    const candidates = candidatesFromUninstallEntries(rows)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].dir).toBe('C:\\Program Files\\EA Games\\The Sims 3')
    expect(candidates[0].uninstallTitle).toBe('The Sims 3')
    expect(candidates[0].displayIcon).toBe(
      'C:\\Program Files\\EA Games\\The Sims 3\\Game\\Bin\\Sims3Launcher.exe'
    )
    expect([...candidates[0].sources]).toEqual(['uninstall'])
  })

  it('merges sources by normalized directory', () => {
    const merged = mergeCandidates([
      [{ dir: 'C:\\Games\\Apex', uninstallTitle: 'Apex Legends', sources: new Set(['uninstall']) }],
      [
        {
          dir: 'c:/games/apex/',
          offerId: 'Origin.OFR.50.0002694',
          mfstState: 'kReadyToStart',
          sources: new Set(['mfst'])
        }
      ],
      [
        { dir: 'C:\\Games\\Apex', sources: new Set(['root']) },
        { dir: 'C:\\Games\\Other', sources: new Set(['root']) }
      ]
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({
      dir: 'C:\\Games\\Apex',
      uninstallTitle: 'Apex Legends',
      offerId: 'Origin.OFR.50.0002694'
    })
    expect([...merged[0].sources].sort()).toEqual(['mfst', 'root', 'uninstall'])
  })
})

describe('scanned games', () => {
  const candidate: EaCandidate = {
    dir: 'C:\\Games\\Battlefield 4',
    uninstallTitle: 'Battlefield 4',
    displayIcon: 'C:\\Games\\Battlefield 4\\bf4.ico',
    sources: new Set(['uninstall'])
  }

  it('launches through origin2://game/launch when a content id is known', () => {
    const game = buildScannedGame({
      candidate,
      installerData: parseInstallerData(INSTALLER_DATA),
      exePath: 'C:\\Games\\Battlefield 4\\bf4.exe',
      launcherParameters: '',
      iconPath: 'C:\\Games\\Battlefield 4\\bf4.ico'
    })
    expect(game.externalId).toBe('1013894')
    expect(game.title).toBe('Battlefield 4')
    expect(game.launch).toEqual({ kind: 'uri', uri: 'origin2://game/launch?offerIds=1013894' })
    expect(game.tracking).toEqual({ mode: 'installDir', installDir: 'C:\\Games\\Battlefield 4' })
    expect(game.exePath).toBe('C:\\Games\\Battlefield 4\\bf4.exe')
    expect(game.localMedia).toEqual({ icon: 'C:\\Games\\Battlefield 4\\bf4.ico' })
    // Every content id of the install, so the account import recognises the record under the edition's id too.
    expect(game.extra).toEqual({
      hasInstallerManifest: true,
      contentId: '1013894',
      contentIds: '1013894;1018201'
    })
  })

  it('uses the mfst offer id and keeps it in extra', () => {
    const game = buildScannedGame({
      candidate: { ...candidate, offerId: 'OFB-EAST:109552409' },
      installerData: null,
      exePath: null,
      launcherParameters: ''
    })
    expect(game.externalId).toBe('OFB-EAST:109552409')
    expect(game.launch).toEqual({
      kind: 'uri',
      uri: 'origin2://game/launch?offerIds=OFB-EAST:109552409'
    })
    expect(game.extra).toEqual({
      hasInstallerManifest: false,
      contentId: 'OFB-EAST:109552409',
      eaOfferId: 'OFB-EAST:109552409'
    })
  })

  it('runs the executable when there is no content id, else opens the library', () => {
    const withExe = buildScannedGame({
      candidate: { ...candidate, displayIcon: undefined },
      installerData: null,
      exePath: 'C:\\Games\\Battlefield 4\\bf4.exe',
      launcherParameters: '-fullscreen'
    })
    expect(withExe.launch).toEqual({
      kind: 'exec',
      file: 'C:\\Games\\Battlefield 4\\bf4.exe',
      args: ['-fullscreen'],
      cwd: 'C:\\Games\\Battlefield 4'
    })
    expect(withExe.externalId).toMatch(/^path:[A-Za-z0-9_-]{16}$/)
    expect(withExe.localMedia).toBeUndefined()
    const bare = buildScannedGame({
      candidate: { dir: 'D:\\EA\\Thing', sources: new Set(['mfst']) },
      installerData: null,
      exePath: null,
      launcherParameters: ''
    })
    expect(bare.launch).toEqual({ kind: 'uri', uri: 'origin2://library/open' })
    expect(bare.title).toBe('Thing')
  })

  it('only records an Uninstall icon when the file exists', () => {
    const noIcon = buildScannedGame({
      candidate,
      installerData: null,
      exePath: 'C:\\Games\\Battlefield 4\\bf4.exe',
      launcherParameters: ''
    })
    expect(noIcon.localMedia).toBeUndefined()
    const withIcon = buildScannedGame({
      candidate: { ...candidate, displayIcon: undefined },
      installerData: null,
      exePath: 'C:\\Games\\Battlefield 4\\bf4.exe',
      launcherParameters: '',
      iconPath: 'C:\\Games\\Battlefield 4\\bf4.ico'
    })
    expect(withIcon.localMedia).toEqual({ icon: 'C:\\Games\\Battlefield 4\\bf4.ico' })
  })
})

describe('candidate evaluation', () => {
  const dir = 'C:\\Games\\Battlefield 4'
  const manifestPath = `${dir}\\__Installer\\installerdata.xml`
  const exe = `${dir}\\bf4.exe`
  const ico = `${dir}\\bf4.ico`

  it('skips an mfst-only folder whose launcher exe is not there yet (download in progress)', async () => {
    const candidate: EaCandidate = {
      dir,
      offerId: 'OFB-EAST:1013894',
      mfstState: 'kReadyToStart',
      sources: new Set(['mfst'])
    }
    // Folder and manifest exist, exe does not: still downloading or left over after an uninstall.
    const partial = fakeFs({ dirs: [dir], texts: { [manifestPath]: INSTALLER_DATA }, exe: null })
    expect(await evaluateCandidate(candidate, silent, partial)).toBeNull()
    // Folder only, no installerdata.xml at all.
    expect(await evaluateCandidate(candidate, silent, fakeFs({ dirs: [dir] }))).toBeNull()
    // Missing folder.
    expect(await evaluateCandidate(candidate, silent, fakeFs({}))).toBeNull()
    // Complete install: manifest plus a resolvable launcher.
    const complete = fakeFs({ dirs: [dir], texts: { [manifestPath]: INSTALLER_DATA }, exe })
    const game = await evaluateCandidate(candidate, silent, complete)
    expect(game?.externalId).toBe('1013894')
    expect(game?.exePath).toBe(exe)
    expect(game?.launch).toEqual({ kind: 'uri', uri: 'origin2://game/launch?offerIds=1013894' })
  })

  it('ignores a root-only folder without a manifest and keeps one with a manifest and exe', async () => {
    const candidate: EaCandidate = { dir, sources: new Set(['root']) }
    expect(await evaluateCandidate(candidate, silent, fakeFs({ dirs: [dir] }))).toBeNull()
    const complete = fakeFs({ dirs: [dir], texts: { [manifestPath]: INSTALLER_DATA }, exe })
    expect((await evaluateCandidate(candidate, silent, complete))?.title).toBe('Battlefield 4')
  })

  it('accepts an Uninstall row without an exe and checks that its icon exists', async () => {
    const candidate: EaCandidate = {
      dir,
      uninstallTitle: 'Battlefield 4',
      displayIcon: ico,
      sources: new Set(['uninstall'])
    }
    const iconGone = await evaluateCandidate(candidate, silent, fakeFs({ dirs: [dir] }))
    expect(iconGone).not.toBeNull()
    expect(iconGone!.title).toBe('Battlefield 4')
    expect(iconGone!.localMedia).toBeUndefined()
    expect(iconGone!.launch).toEqual({ kind: 'uri', uri: 'origin2://library/open' })

    const iconPresent = await evaluateCandidate(
      candidate,
      silent,
      fakeFs({ dirs: [dir], files: [ico] })
    )
    expect(iconPresent!.localMedia).toEqual({ icon: ico })

    // A DisplayIcon that is an executable doubles as the launch exe when the manifest has none.
    const exeIcon = await evaluateCandidate(
      { ...candidate, displayIcon: exe },
      silent,
      fakeFs({ dirs: [dir], files: [exe] })
    )
    expect(exeIcon!.exePath).toBe(exe)
    expect(exeIcon!.launch).toMatchObject({ kind: 'exec', file: exe })
    expect(exeIcon!.localMedia).toBeUndefined()
  })
})

describe('ea integration (this machine)', () => {
  it('detects the client and scans without throwing', async () => {
    const client = await eaProvider.detectClient()
    console.info(`[ea] client: ${JSON.stringify(client)}`)
    if (!client.installed) {
      console.info('[ea] EA app is not installed on this machine; scan skipped')
      return
    }
    const games = await eaProvider.scanInstalled({
      settings: defaultSettings(),
      log: verbose,
      resourcesDir: resolve('resources/systems'),
      progress: () => {}
    })
    console.info(
      `[ea] ${games.length} game(s): ${games.map((g) => `${g.title} [${g.externalId}] ${g.installDir} -> ${JSON.stringify(g.launch)}`).join('; ')}`
    )
    for (const g of games) {
      expect(g.source).toBe('ea')
      expect(g.title).toBeTruthy()
      expect(g.installDir).toBeTruthy()
      expect(g.tracking.mode).toBe('installDir')
    }
  }, 60_000)
})
