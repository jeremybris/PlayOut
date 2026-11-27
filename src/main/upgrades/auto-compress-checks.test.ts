import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Game } from '../../shared/types'
import { tMain } from '../i18n'
import {
  createAutoCompressChecks,
  folderActivity,
  folderCreatedAt,
  steamManifestBusy,
  steamManifestPath,
  type AutoCompressCheckDeps,
  type AutoCompressChecks
} from './auto-compress-checks'

/** The wiring index.ts gives Compress games automatically: what holds a game back, before and while it compresses. */

const STEAM_DIR = 'D:\\SteamLibrary\\steamapps\\common\\Portal 2'
const ACF = 'D:\\SteamLibrary\\steamapps\\appmanifest_620.acf'

const game = (overrides: Partial<Game> = {}): Game =>
  ({
    id: 'steam:620',
    source: 'steam',
    externalId: '620',
    title: 'Portal 2',
    installed: true,
    installDir: STEAM_DIR,
    ...overrides
  }) as Game

const acf = (flags: number): string =>
  `"AppState"\n{\n\t"appid"\t\t"620"\n\t"StateFlags"\t\t"${flags}"\n}\n`

function checks(
  over: Partial<AutoCompressCheckDeps> = {},
  files: Record<string, string> = {}
): AutoCompressChecks {
  return createAutoCompressChecks({
    runningGameId: () => null,
    trackedGameIds: () => [],
    downloadingGameIds: () => [],
    emulationMoving: () => false,
    upgradeRunning: () => false,
    convertRunning: async () => false,
    steamAppId: (g) => (g.source === 'steam' ? Number(g.externalId) : null),
    readFile: async (path) => {
      if (path in files) return files[path]
      throw new Error('ENOENT')
    },
    ...over
  })
}

const w = (key: string): string => tMain(`mainApp.autoCompressWait.${key}`)

describe('auto compress checks', () => {
  it("finds a Steam game's appmanifest beside its steamapps\\common folder", () => {
    expect(steamManifestPath(STEAM_DIR, '620')).toBe(ACF)
  })

  it('reads the appmanifest flags: installed (with an update waiting) is idle, anything else is busy', () => {
    expect(steamManifestBusy(acf(4))).toBe(false)
    expect(steamManifestBusy(acf(6))).toBe(false)
    // Downloading / update started / paused part way / running.
    expect(steamManifestBusy(acf(1026))).toBe(true)
    expect(steamManifestBusy(acf(1030))).toBe(true)
    expect(steamManifestBusy(acf(1542))).toBe(true)
    expect(steamManifestBusy(acf(68))).toBe(true)
    expect(steamManifestBusy('"AppState" {}')).toBe(false)
  })

  it('a Steam game waits while its appmanifest shows Steam writing it, and its compress stops', async () => {
    const busy = checks({}, { [ACF]: acf(1026) })
    expect(await busy.gameWaitReason(game())).toBe(w('steamWriting'))
    expect(await busy.stopReason(game())).toBe(w('steamWriting'))
    const idle = checks({}, { [ACF]: acf(4) })
    expect(await idle.gameWaitReason(game())).toBeNull()
    expect(await idle.stopReason(game())).toBeNull()
    // No manifest (another store, or none found): nothing to wait for.
    expect(await checks().gameWaitReason(game())).toBeNull()
    expect(
      await checks({}, { [ACF]: acf(1026) }).gameWaitReason(game({ source: 'epic' }))
    ).toBeNull()
  })

  it('a game waits while its install is tracked or downloading in the install queue', async () => {
    expect(await checks({ trackedGameIds: () => ['steam:620'] }).gameWaitReason(game())).toBe(
      w('installTracked')
    )
    expect(await checks({ downloadingGameIds: () => ['steam:620'] }).gameWaitReason(game())).toBe(
      w('downloading')
    )
    expect(
      await checks({ downloadingGameIds: () => ['steam:1'] }).gameWaitReason(game())
    ).toBeNull()
  })

  it('every game waits while a game runs, the Emulation folder moves, an upgrade or a Convert run runs', async () => {
    expect(await checks().busyReason()).toBeNull()
    expect(await checks({ runningGameId: () => 'steam:1' }).busyReason()).toBe(w('gameRunning'))
    expect(await checks({ emulationMoving: () => true }).busyReason()).toBe(w('emulationMoving'))
    expect(await checks({ upgradeRunning: () => true }).busyReason()).toBe(w('upgradeRunning'))
    expect(await checks({ convertRunning: async () => true }).busyReason()).toBe(
      w('convertRunning')
    )
    // A game started while it compresses stops the compress.
    expect(await checks({ runningGameId: () => 'steam:1' }).stopReason(game())).toBe(
      w('gameRunning')
    )
  })
})

describe('folder activity', () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it('counts files and bytes through subfolders, and tells when the folder was made', async () => {
    dir = await mkdtemp(join(tmpdir(), 'playout-autocompress-'))
    await mkdir(join(dir, 'bin'))
    await writeFile(join(dir, 'game.exe'), 'abcd')
    await writeFile(join(dir, 'bin', 'data.pak'), '123456')
    const a = await folderActivity(dir)
    expect(a).toMatchObject({ files: 2, bytes: 10 })
    expect(a!.newest).toBeGreaterThan(0)
    expect(await folderCreatedAt(dir)).toBeGreaterThan(0)
    expect(await folderActivity(join(dir, 'missing'))).toBeNull()
    expect(await folderCreatedAt(join(dir, 'missing'))).toBeNull()
  })
})
