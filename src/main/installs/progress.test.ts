// Progress readers against fixture files: a Steam manifest mid-download, GOG and EA log lines, an Epic .item with a
// growing folder, a Battle.net product.db encoded from the schema, an Xbox folder and a Ubisoft registry key.
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { productDbType } from '../providers/battlenet'
import { createBattlenetProbe, progressFromProductDb } from './battlenet-progress'
import { applyEaLogLine, createEaProbe, emptyEaState, progressFromEaState } from './ea-progress'
import { createEpicProbe, progressFromItem } from './epic-progress'
import {
  applyGalaxyLogLine,
  createGogProbe,
  emptyGalaxyState,
  progressFromGalaxyState
} from './gog-progress'
import { createLogTail } from './log-tail'
import { createSteamProbe, parseAcfProgress, progressFromAcf } from './steam-progress'
import { createUbisoftProbe, progressFromState } from './ubisoft-progress'
import { createXboxProbe, folderKey } from './xbox-progress'

function acf(fields: Record<string, string | number>): string {
  const lines = Object.entries(fields).map(([k, v]) => `\t"${k}"\t\t"${v}"`)
  return `"AppState"\n{\n${lines.join('\n')}\n}\n`
}

const MID_DOWNLOAD = acf({
  appid: 35140,
  name: 'Batman: Arkham Asylum GOTY Edition',
  StateFlags: 1026,
  installdir: 'Batman Arkham Asylum GOTY',
  buildid: 0,
  TargetBuildID: 1234,
  BytesToDownload: 7789490880,
  BytesDownloaded: 1947372720,
  BytesToStage: 8471095333,
  BytesStaged: 0
})

const INSTALLED = acf({
  appid: 35140,
  name: 'Batman: Arkham Asylum GOTY Edition',
  StateFlags: 4,
  installdir: 'Batman Arkham Asylum GOTY',
  buildid: 1234,
  TargetBuildID: 1234,
  BytesToDownload: 7789490880,
  BytesDownloaded: 7789490880,
  BytesToStage: 8471095333,
  BytesStaged: 8471095333
})

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-installs-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('steam progress', () => {
  it('reads the percent from the bytes while downloading and done from FullyInstalled', () => {
    const mid = parseAcfProgress(MID_DOWNLOAD)!
    expect(mid).toMatchObject({
      appId: 35140,
      stateFlags: 1026,
      bytesToDownload: 7789490880,
      bytesDownloaded: 1947372720
    })
    const progress = progressFromAcf(mid, false)
    expect(progress.state).toBe('downloading')
    expect(progress.percent).toBeCloseTo(25, 0)
    expect(progress).toMatchObject({ bytesDone: 1947372720, bytesTotal: 7789490880 })
    expect(progressFromAcf({ ...mid, bytesDownloaded: 0 }, false).state).toBe('queued')
    expect(progressFromAcf({ ...mid, stateFlags: 1026 | 512 }, false).message).toBe(
      'Paused in Steam'
    )
    const staging = progressFromAcf(
      { ...mid, bytesDownloaded: mid.bytesToDownload, bytesStaged: 4235547666 },
      false
    )
    expect(staging.state).toBe('installing')
    expect(staging.percent).toBeCloseTo(50, 0)

    const done = parseAcfProgress(INSTALLED)!
    expect(progressFromAcf(done, true)).toMatchObject({
      state: 'installing',
      percent: 100,
      complete: true
    })
    expect(progressFromAcf(done, false).complete).toBeUndefined()
    // Stale Bytes* keys from the last update are not progress once bit 4 is set and the builds agree.
    expect(progressFromAcf({ ...done, bytesDownloaded: 10 }, true).complete).toBe(true)
    expect(progressFromAcf({ ...done, targetBuildId: 1300 }, true)).toMatchObject({
      state: 'installing',
      percent: 99
    })
    expect(progressFromAcf({ ...done, stateFlags: 2048 }, true).cancelled).toBe(true)
    expect(parseAcfProgress('"Other" { }')).toBeNull()
    expect(parseAcfProgress('"AppState" { "appid" "unterminated')).toBeNull()
    // Bit 4 set mid-download (1030 UpdateStarted|FullyInstalled|UpdateRequired, buildid 0): still in flight, so
    // the confirming scan must not end the watch even though the common folder already exists.
    const early = progressFromAcf(
      { ...mid, stateFlags: 1030, buildId: 0, targetBuildId: 777, bytesDownloaded: 10 },
      true
    )
    expect(early).toMatchObject({ state: 'downloading', inFlight: true })
    expect(early.complete).toBeUndefined()
    expect(early.percent).toBeLessThan(1)
    expect(progressFromAcf({ ...mid, stateFlags: 1542, buildId: 0 }, true)).toMatchObject({
      message: 'Paused in Steam',
      inFlight: true
    })
    // An update bit on an installed build (1028 = UpdateStarted|FullyInstalled) is in flight too.
    expect(progressFromAcf({ ...done, stateFlags: 1028 }, true).complete).toBeUndefined()
    expect(progressFromAcf(done, true).inFlight).toBeUndefined()
  })

  it('polls every library folder and reports a vanished manifest as cancelled', async () => {
    const lib1 = join(dir, 'lib1')
    const lib2 = join(dir, 'lib2')
    await fs.mkdir(join(lib1, 'steamapps'), { recursive: true })
    await fs.mkdir(join(lib2, 'steamapps', 'common', 'Batman Arkham Asylum GOTY'), {
      recursive: true
    })
    const probe = createSteamProbe({ appId: 35140, libraries: async () => [lib1, lib2] })
    expect(await probe()).toBeNull()
    await fs.writeFile(join(lib2, 'steamapps', 'appmanifest_35140.acf'), MID_DOWNLOAD)
    expect(await probe()).toMatchObject({ state: 'downloading', bytesDone: 1947372720 })
    await fs.writeFile(join(lib2, 'steamapps', 'appmanifest_35140.acf'), INSTALLED)
    expect(await probe()).toMatchObject({ state: 'installing', complete: true })
    // Absent once or twice (the `.acf.tmp` rename, a locked commit) is not cancelled yet; three times is.
    await fs.rm(join(lib2, 'steamapps', 'appmanifest_35140.acf'))
    expect(await probe()).toMatchObject({ state: 'installing', complete: true })
    expect((await probe())?.cancelled).toBeUndefined()
    expect(await probe()).toMatchObject({ cancelled: true })
  })

  it('retries a torn manifest read instead of reporting the install cancelled', async () => {
    const lib = join(dir, 'lib')
    const steamapps = join(lib, 'steamapps')
    await fs.mkdir(steamapps, { recursive: true })
    const probe = createSteamProbe({ appId: 35140, libraries: async () => [lib] })
    await fs.writeFile(join(steamapps, 'appmanifest_35140.acf'), MID_DOWNLOAD)
    const first = await probe()
    expect(first).toMatchObject({ state: 'downloading' })
    // Steam is half-way through rewriting the file: the previous result stands.
    await fs.writeFile(join(steamapps, 'appmanifest_35140.acf'), MID_DOWNLOAD.slice(0, 40))
    expect(await probe()).toEqual(first)
    expect(await probe()).toEqual(first)
    await fs.writeFile(join(steamapps, 'appmanifest_35140.acf'), INSTALLED)
    await fs.mkdir(join(steamapps, 'common', 'Batman Arkham Asylum GOTY'), { recursive: true })
    expect(await probe()).toMatchObject({ complete: true })
    // The downloading folder alone (manifest not written yet) keeps the watch alive wherever the check runs.
    await fs.rm(join(steamapps, 'appmanifest_35140.acf'))
    await fs.mkdir(join(steamapps, 'downloading', '35140'), { recursive: true })
    expect(await probe()).toMatchObject({ state: 'downloading', inFlight: true })
  })
})

describe('gog progress', () => {
  const LINES = [
    '2026-11-01 07:58:01.000 [Information][ 1234] [TID 1][galaxy_client]: Adding job ProductInstall (1454587428) id: 7 state: Scheduled',
    '2026-11-01 07:58:02.000 [Information][ 1234] [TID 1][galaxy_client]: Storing new ProductState for product 1454587428 => operation state: installing, installation state: none.',
    "2026-11-01 07:58:03.000 [Information][ 1234] [TID 1][galaxy_client]: Job 'ProductInstall (1454587428) id: 7 state: Running' state changed",
    '2026-11-01 07:58:04.000 [Information][ 1234] [TID 1][galaxy_client]: Initializing download for product 1454587428 (buildId 1, language en, 0 DLCs), files to download 4 (uncompressed size 123456); target file count 4 ...',
    "2026-11-01 07:58:05.000 [Information][ 1234] [TID 1][galaxy_client]: Marking file 'a.bin' as complete.",
    "2026-11-01 07:58:06.000 [Information][ 1234] [TID 1][galaxy_client]: Marking file 'b.bin' as complete.",
    '2026-11-01 07:58:07.000 [Information][ 1234] [TID 1][galaxy_client]: Writing C:\\Games\\X\\goggame-galaxyFileList.ini for gameId 1454587428',
    '2026-11-01 07:58:08.000 [Information][ 1234] [TID 1][galaxy_client]: Changing installation state of product 1454587428 from none to installed'
  ]

  it('walks the job lifecycle and counts files', () => {
    const state = emptyGalaxyState()
    expect(progressFromGalaxyState(state)).toBeNull()
    applyGalaxyLogLine(state, LINES[0], '1454587428')
    expect(progressFromGalaxyState(state)).toMatchObject({ state: 'queued' })
    for (const line of LINES.slice(1, 6)) applyGalaxyLogLine(state, line, '1454587428')
    expect(progressFromGalaxyState(state)).toMatchObject({
      state: 'downloading',
      percent: 50,
      bytesTotal: 123456
    })
    applyGalaxyLogLine(state, LINES[6], '1454587428')
    expect(progressFromGalaxyState(state)).toMatchObject({ state: 'installing', percent: 99 })
    applyGalaxyLogLine(state, LINES[7], '1454587428')
    expect(progressFromGalaxyState(state)).toMatchObject({
      state: 'installing',
      percent: 100,
      complete: true
    })
    // Another product's lines are ignored.
    const other = emptyGalaxyState()
    expect(applyGalaxyLogLine(other, LINES[0].replace('1454587428', '999'), '1454587428')).toBe(
      false
    )
    const cancelled = emptyGalaxyState()
    applyGalaxyLogLine(
      cancelled,
      'x [galaxy_client]: Scheduling game 1454587428 (1454587428) uninstallation',
      '1454587428'
    )
    expect(progressFromGalaxyState(cancelled)).toMatchObject({ cancelled: true })
  })

  it('tails the log file across appends', async () => {
    const file = join(dir, 'GalaxyClient.log')
    await fs.writeFile(file, 'old line\n')
    const probe = createGogProbe({ productId: '1454587428', logFile: file })
    expect(await probe()).toBeNull()
    await fs.appendFile(file, LINES.slice(0, 4).join('\n') + '\n')
    expect(await probe()).toMatchObject({ state: 'downloading', percent: 0 })
    await fs.appendFile(file, LINES.slice(4).join('\n') + '\n')
    expect(await probe()).toMatchObject({ complete: true })
  })

  it('an anchored tail skips what the client logged before the hand-off', async () => {
    const file = join(dir, 'GalaxyClient.log')
    // The previous session uninstalled the same product: with a lookback this line would cancel the new watch.
    await fs.writeFile(
      file,
      'x [galaxy_client]: Scheduling game 1454587428 (1454587428) uninstallation\n'
    )
    // The default lookback replays it at the first probe...
    const replayed = createGogProbe({ productId: '1454587428', logFile: file })
    expect(await replayed()).toMatchObject({ cancelled: true })
    // ...while the anchored tail the install service builds before the hand-off starts after it.
    const tail = createLogTail(file, { lookbackBytes: 0 })
    expect(await tail.readNew()).toEqual([])
    const probe = createGogProbe({ productId: '1454587428', logFile: file, tail })
    expect(await probe()).toBeNull()
    await fs.appendFile(file, LINES.slice(0, 4).join('\n') + '\n')
    expect(await probe()).toMatchObject({ state: 'downloading' })
  })

  it('log tail restarts after truncation and keeps partial lines', async () => {
    const file = join(dir, 'tail.log')
    await fs.writeFile(file, 'a\nb')
    const tail = createLogTail(file, { lookbackBytes: 1024 })
    expect(await tail.readNew()).toEqual(['a'])
    await fs.appendFile(file, 'c\nd\n')
    expect(await tail.readNew()).toEqual(['bc', 'd'])
    await fs.writeFile(file, 'z\n')
    expect(await tail.readNew()).toEqual(['z'])
  })
})

describe('ea progress', () => {
  const ids = {
    offerId: 'Origin.OFR.50.0001139',
    slug: 'the-sims-3',
    softwareId: 'Origin.SFT.50.0000456'
  }

  it('reads bytes, rate and ETA, the status JSON and the installed line', () => {
    const state = emptyEaState()
    expect(progressFromEaState(state)).toBeNull()
    applyEaLogLine(
      state,
      '1\t2026-10-24T10:00:00\t1\t2\tINFO\t(sendInstallStatus)\tWe will emit onGameStatusUpdated signal to SPA: [{"gameStatus":{"installed":false,"installing":true},"installInfo":{"installStatusString":"QUEUED"},"offerId":"Origin.OFR.50.0001139"}]',
      ids
    )
    expect(progressFromEaState(state)).toMatchObject({ state: 'queued' })
    applyEaLogLine(
      state,
      '2\t..\t1\t2\tINFO\t(eax::ui::GamesManagerProxy::getDownloadProgress)\treceived download progress downloaded = [6702985622], Kb/s = [33629.2], timeRemaining = [2.7375042], offer = [Origin.OFR.50.0001139]',
      ids
    )
    const active = progressFromEaState(state)!
    expect(active.state).toBe('downloading')
    expect(active.bytesDone).toBe(6702985622)
    expect(active.bytesTotal).toBeGreaterThan(6702985622)
    expect(active.percent).toBeGreaterThan(90)
    expect(
      applyEaLogLine(
        state,
        'received download progress downloaded = [1], Kb/s = [1], timeRemaining = [1], offer = [Origin.OFR.50.0009999]',
        ids
      )
    ).toBe(false)
    applyEaLogLine(
      state,
      '3\t..\t1\t2\tINFO\t(eax::domain::model::content::InstallStore::updateInfos)\tIS update: set installInfo for softwareId=[Origin.SFT.50.0000456] baseSlug=[the-sims-3] installedStatus=[Installed]',
      ids
    )
    expect(progressFromEaState(state)).toMatchObject({
      state: 'installing',
      percent: 100,
      complete: true
    })
  })

  it('tails EADesktopVerbose.log', async () => {
    const file = join(dir, 'EADesktopVerbose.log')
    await fs.writeFile(file, '')
    const probe = createEaProbe({ ids, logFile: file })
    expect(await probe()).toBeNull()
    await fs.appendFile(
      file,
      'x\treceived download progress downloaded = [100], Kb/s = [10], timeRemaining = [10], offer = [Origin.OFR.50.0001139]\n'
    )
    expect(await probe()).toMatchObject({
      state: 'downloading',
      bytesDone: 100,
      bytesTotal: 100100
    })
  })
})

describe('epic progress', () => {
  it('measures the install folder against InstallSize and reports completion', async () => {
    const manifests = join(dir, 'Manifests')
    const install = join(dir, 'Games', 'AlanWake')
    await fs.mkdir(manifests, { recursive: true })
    await fs.mkdir(join(install, '.egstore'), { recursive: true })
    const probe = createEpicProbe({ appName: 'AlanWake', manifestsDir: manifests })
    expect(await probe()).toBeNull()
    const item = {
      AppName: 'AlanWake',
      InstallLocation: install,
      InstallSize: 1000,
      LaunchExecutable: 'Game.exe',
      bIsIncompleteInstall: true
    }
    await fs.writeFile(join(manifests, 'ABC.item'), JSON.stringify(item))
    await fs.writeFile(
      join(manifests, 'OTHER.item'),
      JSON.stringify({ AppName: 'Other', bIsIncompleteInstall: false })
    )
    await fs.writeFile(join(install, '.egstore', 'chunk'), Buffer.alloc(900))
    await fs.writeFile(join(install, 'data.pak'), Buffer.alloc(250))
    expect(await probe()).toMatchObject({
      state: 'downloading',
      percent: 25,
      bytesDone: 250,
      bytesTotal: 1000
    })
    await fs.writeFile(
      join(manifests, 'ABC.item'),
      JSON.stringify({ ...item, bIsIncompleteInstall: false })
    )
    expect((await probe())!.complete).toBeUndefined()
    await fs.writeFile(join(install, 'Game.exe'), 'MZ')
    expect(await probe()).toMatchObject({ state: 'installing', percent: 100, complete: true })
    await fs.rm(join(manifests, 'ABC.item'))
    expect(await probe()).toMatchObject({ cancelled: true })
    expect(progressFromItem({ bIsIncompleteInstall: true }, 10, false)).toMatchObject({
      state: 'downloading',
      bytesDone: 10
    })
  })
})

describe('battlenet progress', () => {
  it('maps update progress, handshakes and playable products', () => {
    expect(progressFromProductDb({}, 'wow', false)).toBeNull()
    expect(progressFromProductDb({}, 'wow', true)).toMatchObject({ cancelled: true })
    expect(
      progressFromProductDb(
        { active_installs: [{ product: 'WoW', uid: 'wow_enus' }] },
        'wow',
        false
      )
    ).toMatchObject({ state: 'queued' })
    const downloading = {
      product_installs: [
        {
          uid: 'wow_enus',
          product_code: 'WoW',
          cached_product_state: {
            base_product_state: { installed: false, playable: false },
            update_progress: { progress: 0.42, total_to_download: 1000, download_remaining: 580 }
          },
          product_operations: { active_operation: 0 }
        }
      ]
    }
    expect(progressFromProductDb(downloading, 'wow', true)).toMatchObject({
      state: 'downloading',
      percent: 42,
      bytesDone: 420,
      bytesTotal: 1000
    })
    const playable = {
      product_installs: [
        {
          uid: 'wow_enus',
          cached_product_state: { base_product_state: { installed: true, playable: true } }
        }
      ]
    }
    expect(progressFromProductDb(playable, 'wow', true)).toMatchObject({
      state: 'installing',
      percent: 100,
      complete: true
    })
  })

  it('decodes a product.db written with the schema', async () => {
    const type = productDbType()
    const message = type.fromObject({
      product_installs: [
        {
          uid: 'pro',
          product_code: 'Pro',
          settings: { install_path: 'C:/Games/Overwatch' },
          cached_product_state: {
            base_product_state: { installed: false, playable: false },
            update_progress: { progress: 0.1, total_to_download: 200, download_remaining: 180 }
          },
          product_operations: { active_operation: 0 }
        }
      ]
    })
    const file = join(dir, 'product.db')
    await fs.writeFile(file, type.encode(message).finish())
    const probe = createBattlenetProbe({ uid: 'pro', dbPath: file })
    expect(await probe()).toMatchObject({
      state: 'downloading',
      percent: 10,
      bytesDone: 20,
      bytesTotal: 200
    })
    expect(await createBattlenetProbe({ uid: 'pro', dbPath: join(dir, 'missing.db') })()).toBeNull()
  })
})

describe('xbox and ubisoft progress', () => {
  it('finds the XboxGames folder by its letters and reports its growth', async () => {
    const root = join(dir, 'XboxGames')
    await fs.mkdir(root, { recursive: true })
    const probe = createXboxProbe({
      title: 'Conker: Live and Reloaded',
      bytesTotal: 1000,
      roots: async () => [root]
    })
    expect(await probe()).toBeNull()
    const content = join(root, 'Conker- Live and Reloaded', 'Content')
    await fs.mkdir(content, { recursive: true })
    await fs.writeFile(join(content, 'a.bin'), Buffer.alloc(300))
    expect(await probe()).toMatchObject({
      state: 'downloading',
      bytesDone: 300,
      bytesTotal: 1000,
      percent: 30
    })
    await fs.rm(join(root, 'Conker- Live and Reloaded'), { recursive: true })
    expect(await probe()).toMatchObject({ cancelled: true })
    expect(folderKey('Halo: The Master Chief Collection')).toBe('halothemasterchiefcollection')
  })

  it('reads the Ubisoft install key and the state file marker', async () => {
    const install = join(dir, 'Ubi', 'Game')
    await fs.mkdir(install, { recursive: true })
    let present = false
    let reads = 0
    const readKey = (async (_hive: string, path: string) =>
      ++reads && present && path.endsWith('\\5595')
        ? {
            name: path,
            leaf: '5595',
            values: { InstallDir: install.replace(/\\/g, '/') + '/' },
            subkeys: []
          }
        : null) as never
    const probe = createUbisoftProbe({ id: '5595', readKey })
    expect(await probe()).toBeNull()
    present = true
    await fs.writeFile(join(install, 'data.forge'), Buffer.alloc(64))
    expect(await probe()).toMatchObject({ state: 'downloading', bytesDone: 64 })
    await fs.writeFile(join(install, 'uplay_install.state'), Buffer.from([0x0a, 0x01]))
    expect(await probe()).toMatchObject({ state: 'installing', percent: 100, complete: true })
    // The InstallDir is cached after the first hit (no registry read per probe); an uninstall removes the folder.
    expect(reads).toBe(3)
    present = false
    await fs.rm(install, { recursive: true, force: true })
    expect(await probe()).toMatchObject({ cancelled: true })
    expect(reads).toBe(3)
    expect(progressFromState(5, 0x08).state).toBe('downloading')
  })
})
