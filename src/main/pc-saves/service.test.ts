import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PC_SAVES_FOLDER } from '../../shared/pc-saves'
import type { Game } from '../../shared/types'
import { EventBus } from '../events'
import type { Logger } from '../logger'
import { readCopyMeta } from '../recomp/cloud'
import { isExcluded } from '../streaming/emulation-sync/rules'
import { listTree } from '../streaming/emulation-sync/scan'
import type { KnownFolders } from '../util/paths'
import { copyFolderName, createPcSavesService, keyHash, type PcSavesService } from './service'

const log: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

let root: string
let emu: string

interface Pc {
  name: string
  svc: PcSavesService
  events: EventBus
  games: Map<string, Game>
  running: { gameId: string; startedAt: string } | null
  userData: string
  saves: string
  enabled: boolean
  moving: boolean
  holds: number[]
  emulationDir: string
  game: Game
}

const pcs: Pc[] = []

function folders(base: string): KnownFolders {
  const profile = join(base, 'profile')
  return {
    userProfile: profile,
    appData: join(profile, 'AppData', 'Roaming'),
    localAppData: join(profile, 'AppData', 'Local'),
    programData: join(base, 'ProgramData'),
    programFiles: join(base, 'Program Files'),
    programFilesX86: join(base, 'Program Files (x86)'),
    publicDir: join(base, 'Public'),
    systemDrive: base
  }
}

function manualGame(id: string, exePath: string, title: string): Game {
  return {
    id,
    source: 'manual',
    externalId: exePath,
    platformId: 'pc',
    title,
    exePath,
    installDir: join(exePath, '..')
  } as unknown as Game
}

async function makePc(
  name: string,
  opts: { exe?: string; title?: string; saveDir?: string; emulationDir?: string } = {}
): Promise<Pc> {
  const base = join(root, name)
  const f = folders(base)
  const exe = opts.exe ?? join(base, 'Games', 'Hollow Knight', 'hollow_knight.exe')
  const game = manualGame(`manual:${name}:${exe}`, exe, opts.title ?? 'Hollow Knight')
  await fs.mkdir(join(exe, '..'), { recursive: true })
  await fs.writeFile(exe, 'MZ')
  const saves =
    opts.saveDir ?? join(f.userProfile, 'AppData', 'LocalLow', 'Team Cherry', 'Hollow Knight')
  await fs.mkdir(saves, { recursive: true })
  const pc = {
    name,
    events: new EventBus(),
    games: new Map([[game.id, game]]),
    running: null,
    userData: join(base, 'userData'),
    saves,
    enabled: true,
    moving: false,
    holds: [] as number[],
    emulationDir: opts.emulationDir ?? emu,
    game
  } as unknown as Pc
  pc.svc = createPcSavesService({
    userData: pc.userData,
    library: { getGame: (id) => pc.games.get(id) },
    launcher: { running: () => pc.running },
    events: pc.events,
    enabled: () => pc.enabled,
    emulationDir: () => pc.emulationDir,
    moving: () => pc.moving,
    ownFolders: () => [join(base, 'PlayOut')],
    holdSync: () => {
      pc.holds.push(1)
      return () => pc.holds.push(-1)
    },
    knownFolders: () => f,
    documents: join(f.userProfile, 'Documents'),
    machine: name,
    log,
    afterPlayDelayMs: 0
  })
  pcs.push(pc)
  return pc
}

const write = (dir: string, file: string, text: string): Promise<void> =>
  fs.mkdir(dir, { recursive: true }).then(() => fs.writeFile(join(dir, file), text))
const read = (dir: string, file: string): Promise<string> => fs.readFile(join(dir, file), 'utf8')
const copiesOf = (): Promise<string[]> => fs.readdir(join(emu, PC_SAVES_FOLDER)).catch(() => [])

/** Play: before-play copy, (the game writes saves), session ends, after-play copy. */
async function play(pc: Pc, change?: () => Promise<void>): Promise<void> {
  expect(await pc.svc.beforePlay(pc.game)).toBeNull()
  const startedAt = new Date().toISOString()
  pc.running = { gameId: pc.game.id, startedAt }
  await change?.()
  pc.running = null
  pc.events.emit('session:ended', {
    gameId: pc.game.id,
    startedAt,
    endedAt: new Date().toISOString(),
    minutes: 1
  })
  await new Promise((r) => setTimeout(r, 10))
  await pc.svc.afterPlay(pc.game.id) // waits on the same lock as the copy the event started
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'playout-pcsaves-'))
  emu = join(root, 'Emulation')
  await fs.mkdir(emu, { recursive: true })
})

afterEach(async () => {
  for (const pc of pcs.splice(0)) pc.svc.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe('PC Saves between two PCs', () => {
  it('copies after play, copies back before play on the other PC, and backs up what it replaces', async () => {
    const a = await makePc('PC-A')
    const b = await makePc('PC-B')
    await write(a.saves, 'user1.dat', 'A1')
    const va = await a.svc.setFolder(a.game.id, a.saves)
    expect(va.error).toBeNull()
    expect(va.syncedAt).not.toBeNull()
    expect(a.holds).toEqual([1, -1])

    // One folder, named by title and key hash, with a meta.json naming the game.
    const names = await copiesOf()
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^Hollow Knight \([0-9a-f]{10}\)$/)
    const meta = await readCopyMeta(join(emu, PC_SAVES_FOLDER, names[0]!))
    expect(meta?.machine).toBe('PC-A')
    expect(meta?.extra).toMatchObject({ kind: 'pc-saves', title: 'Hollow Knight' })
    expect(names[0]).toBe(copyFolderName('Hollow Knight', meta!.extra!.key!))

    // The other PC (another library id, the same key): the copy comes back without a question.
    const vb = await b.svc.setFolder(b.game.id, b.saves)
    expect(vb.confirm).toBeNull()
    expect(vb.conflict).toBeNull()
    expect(await read(b.saves, 'user1.dat')).toBe('A1')
    expect(vb.copyMachine).toBe('PC-A')

    // Played on B: copied after play; A gets it before its next play, backing its own saves up first.
    await play(b, () => write(b.saves, 'user1.dat', 'B2'))
    expect((await readCopyMeta(join(emu, PC_SAVES_FOLDER, names[0]!)))?.machine).toBe('PC-B')
    expect(await a.svc.beforePlay(a.game)).toBeNull()
    expect(await read(a.saves, 'user1.dat')).toBe('B2')
    const backups = await fs.readdir(join(a.userData, 'pc-save-backups'), { recursive: true })
    expect(backups.some((n) => String(n).endsWith('before restore.zip'))).toBe(true)
    // Never inside the Emulation folder.
    const emuFiles = await fs.readdir(emu, { recursive: true })
    expect(emuFiles.some((n) => String(n).endsWith('.zip'))).toBe(false)
  })

  it('asks which saves to keep when both changed; a streamed start goes on with the question open', async () => {
    const a = await makePc('PC-A')
    const b = await makePc('PC-B')
    await write(a.saves, 's.dat', 'A1')
    await a.svc.setFolder(a.game.id, a.saves)
    await b.svc.setFolder(b.game.id, b.saves)
    await play(a, () => write(a.saves, 's.dat', 'A2'))
    // B changed its saves too without seeing A2 (played outside PlayOut).
    await write(b.saves, 's.dat', 'B2')

    const refused = await b.svc.beforePlay(b.game)
    expect(refused?.kind).toBe('save-conflict')
    expect(refused?.message).toMatch(/changed on this PC and in the Emulation folder/)
    expect(await read(b.saves, 's.dat')).toBe('B2')
    const view = await b.svc.view(b.game.id)
    expect(view?.conflict?.cloudDevice).toBe('PC-A')

    // A paired PC's stream: starts anyway; nothing overwritten, the question waits.
    expect(await b.svc.beforePlay(b.game, { streamed: true })).toBeNull()
    expect((await b.svc.view(b.game.id))?.conflict).not.toBeNull()
    expect(await read(b.saves, 's.dat')).toBe('B2')

    const kept = await b.svc.resolve(b.game.id, 'local')
    expect(kept.conflict).toBeNull()
    expect(await a.svc.beforePlay(a.game)).toBeNull()
    expect(await read(a.saves, 's.dat')).toBe('B2')
    // A's own A2 was kept as a backup.
    expect(
      (await fs.readdir(join(a.userData, 'pc-save-backups'), { recursive: true })).length
    ).toBeGreaterThan(0)
  })

  it('first time both PCs have saves: the conflict prompt, never a silent overwrite', async () => {
    const a = await makePc('PC-A')
    const b = await makePc('PC-B')
    await write(a.saves, 's.dat', 'A')
    await write(b.saves, 's.dat', 'B')
    await a.svc.setFolder(a.game.id, a.saves)
    const vb = await b.svc.setFolder(b.game.id, b.saves)
    expect(vb.conflict).not.toBeNull()
    expect(await read(b.saves, 's.dat')).toBe('B')
    const cloud = await b.svc.resolve(b.game.id, 'cloud')
    expect(cloud.conflict).toBeNull()
    expect(await read(b.saves, 's.dat')).toBe('A')
  })

  it('asks before using a copy matched only by title, and makes its own when told no', async () => {
    const a = await makePc('PC-A')
    await write(a.saves, 's.dat', 'A1')
    await a.svc.setFolder(a.game.id, a.saves)
    // Another install of the same game: another folder and program name, so another key.
    const c = await makePc('PC-C', {
      exe: join(root, 'PC-C', 'Stuff', 'HK GOTY', 'hk.exe'),
      title: 'Hollow Knight'
    })
    const vc = await c.svc.setFolder(c.game.id, c.saves)
    expect(vc.confirm).toEqual({ machine: 'PC-A', title: 'Hollow Knight' })
    const refused = await c.svc.beforePlay(c.game)
    expect(refused?.kind).toBe('save-conflict')
    expect(refused?.message).toMatch(/PC-A/)
    await expect(fs.readdir(c.saves)).resolves.toEqual([])

    const used = await c.svc.answerCopy(c.game.id, true)
    expect(used.confirm).toBeNull()
    expect(await read(c.saves, 's.dat')).toBe('A1')

    const d = await makePc('PC-D', {
      exe: join(root, 'PC-D', 'Other', 'Hollow Knight Copy', 'hkx.exe'),
      title: 'Hollow Knight'
    })
    await write(d.saves, 'mine.dat', 'D')
    expect((await d.svc.setFolder(d.game.id, d.saves)).confirm).not.toBeNull()
    const own = await d.svc.answerCopy(d.game.id, false)
    expect(own.confirm).toBeNull()
    expect(own.copyDir).toMatch(/Hollow Knight \([0-9a-f]{10}\)$/)
    expect(await copiesOf()).toHaveLength(2)
    expect(await fs.readdir(d.saves)).toEqual(['mine.dat'])
  })

  it('a key match by folder hash never asks, whatever the title says on the other PC', async () => {
    const a = await makePc('PC-A')
    await write(a.saves, 's.dat', 'A1')
    await a.svc.setFolder(a.game.id, a.saves)
    const b = await makePc('PC-B', { title: 'Hollow Knight (renamed)' })
    const vb = await b.svc.setFolder(b.game.id, b.saves)
    expect(vb.confirm).toBeNull()
    expect(
      vb.copyDir?.endsWith(
        `(${keyHash(JSON.parse(await fs.readFile(join(vb.copyDir!, 'meta.json'), 'utf8')).extra.key)})`
      )
    ).toBe(true)
    expect(await read(b.saves, 's.dat')).toBe('A1')
  })
})

describe('PC Saves: when copies happen', () => {
  it('the Emulation folder sync carries the copy (its work in progress never)', async () => {
    const a = await makePc('PC-A')
    await write(a.saves, 's.dat', 'A1')
    const v = await a.svc.setFolder(a.game.id, a.saves)
    const name = v.copyDir!.split(/[\\/]/).pop()!
    const tree = await listTree(emu, { extraExcluded: [] })
    const keys = [...tree.files.keys()]
    expect(keys).toContain(`pc saves/${name.toLowerCase()}/meta.json`)
    expect(keys).toContain(`pc saves/${name.toLowerCase()}/current/0/s.dat`)
    const scope = { extraExcluded: [] }
    expect(isExcluded(`${PC_SAVES_FOLDER}/${name}/current/0/s.dat`, scope)).toBe(false)
    expect(
      isExcluded(`${PC_SAVES_FOLDER}/${name}/current.1a2b3c4d.playout-new/0/s.dat`, scope)
    ).toBe(true)
  })

  it('a Co-Op or PeerParty session (not started with Play) is not copied', async () => {
    const a = await makePc('PC-A')
    await write(a.saves, 's.dat', 'A1')
    await a.svc.setFolder(a.game.id, a.saves)
    const dir = (await a.svc.view(a.game.id))!.copyDir!
    const before = await readCopyMeta(dir)
    await write(a.saves, 's.dat', 'A2')
    a.events.emit('session:ended', {
      gameId: a.game.id,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      minutes: 1
    })
    await new Promise((r) => setTimeout(r, 20))
    expect((await readCopyMeta(dir))?.hash).toBe(before?.hash)
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/not started with Play/))
  })

  it('copies even with the Emulation folder sync off, and nothing with the switch off', async () => {
    const a = await makePc('PC-A')
    a.enabled = false
    await write(a.saves, 's.dat', 'A1')
    const v = await a.svc.setFolder(a.game.id, a.saves)
    expect(v.featureOn).toBe(false)
    expect(await copiesOf()).toEqual([])
    expect(await a.svc.beforePlay(a.game)).toBeNull()
    a.enabled = true
    expect((await a.svc.syncNow(a.game.id)).syncedAt).not.toBeNull()
    expect(await copiesOf()).toHaveLength(1)
  })

  it('Copy now is refused while the game runs', async () => {
    const a = await makePc('PC-A')
    await a.svc.setFolder(a.game.id, a.saves)
    a.running = { gameId: a.game.id, startedAt: new Date().toISOString() }
    await expect(a.svc.syncNow(a.game.id)).rejects.toThrow(/running/)
  })

  it('re-checks the size before every copy: over 512 MB nothing is copied', async () => {
    const a = await makePc('PC-A')
    await write(a.saves, 's.dat', 'A1')
    const first = await a.svc.setFolder(a.game.id, a.saves)
    const before = await readCopyMeta(first.copyDir!)
    const h = await fs.open(join(a.saves, 'huge.dat'), 'w')
    await h.truncate(513 * 1024 * 1024)
    await h.close()
    const v = await a.svc.syncNow(a.game.id)
    expect(v.error).toMatch(/513 MB/)
    expect((await readCopyMeta(first.copyDir!))?.hash).toBe(before?.hash)
    await expect(fs.access(join(first.copyDir!, 'current', '0', 'huge.dat'))).rejects.toThrow()
  })

  it('a changed Emulation folder forgets the last copy (a difference is a conflict); a moved one does not', async () => {
    const a = await makePc('PC-A')
    const b = await makePc('PC-B')
    const c = await makePc('PC-C')
    await write(a.saves, 's.dat', 'A1')
    await a.svc.setFolder(a.game.id, a.saves)
    await c.svc.setFolder(c.game.id, c.saves) // C has A1 too, last copied A1
    await b.svc.setFolder(b.game.id, b.saves)
    await play(b, () => write(b.saves, 's.dat', 'B2'))
    // The copy (B2, which moved on from A1) also stands in another folder.
    const emu2 = join(root, 'Emulation2')
    await fs.cp(emu, emu2, { recursive: true })

    // Moved with its copies: A's last copy still holds, so B2 simply comes back.
    await a.svc.noteEmulationFolderMoved(emu, emu2)
    a.emulationDir = emu2
    expect(await a.svc.beforePlay(a.game)).toBeNull()
    expect(await read(a.saves, 's.dat')).toBe('B2')

    // Another folder chosen (not moved): the last copy is forgotten, so the differing copy is asked about.
    c.emulationDir = emu2
    const refused = await c.svc.beforePlay(c.game)
    expect(refused?.kind).toBe('save-conflict')
    expect(await read(c.saves, 's.dat')).toBe('A1')
  })
})

describe('PC Saves: folders refused', () => {
  it('refuses another game’s folder, the Emulation folder, PlayOut’s folders and games it does not copy', async () => {
    const a = await makePc('PC-A')
    await a.svc.setFolder(a.game.id, a.saves)
    const other = manualGame('manual:other', join(root, 'PC-A', 'Games', 'Other', 'o.exe'), 'Other')
    a.games.set(other.id, other)
    await expect(a.svc.setFolder(other.id, a.saves)).rejects.toThrow(/Hollow Knight/)
    await expect(a.svc.setFolder(other.id, join(emu, 'saves'))).rejects.toThrow(/PlayOut’s own/)
    await expect(a.svc.setFolder(other.id, join(a.userData, 'x'))).rejects.toThrow(/PlayOut’s own/)
    await expect(
      a.svc.setFolder(other.id, join(root, 'PC-A', 'PlayOut', 'Emulators'))
    ).rejects.toThrow(/PlayOut’s own/)
    await expect(a.svc.setFolder(other.id, join(root, 'PC-A', 'profile'))).rejects.toThrow(
      /too broad/
    )
    const steam = { ...other, id: 'steam:1', source: 'steam' } as Game
    a.games.set(steam.id, steam)
    await expect(a.svc.setFolder(steam.id, a.saves)).rejects.toThrow(/PC games you added/)
    expect(await a.svc.view(steam.id)).toBeNull()
    const remote = { ...other, id: 'manual:remote', remote: { hostId: 'h' } } as unknown as Game
    a.games.set(remote.id, remote)
    expect(await a.svc.view(remote.id)).toBeNull()
  })

  it('inspect gives the size, and large above 100 MB', async () => {
    const a = await makePc('PC-A')
    const h = await fs.open(join(a.saves, 'big.dat'), 'w')
    await h.truncate(101 * 1024 * 1024)
    await h.close()
    const check = await a.svc.inspect(a.game.id, a.saves)
    expect(check).toMatchObject({ files: 1, large: true })
    expect(check.bytes).toBe(101 * 1024 * 1024)
  })

  it('Clear keeps both the saves and their copy', async () => {
    const a = await makePc('PC-A')
    await write(a.saves, 's.dat', 'A1')
    const v = await a.svc.setFolder(a.game.id, a.saves)
    const cleared = await a.svc.setFolder(a.game.id, null)
    expect(cleared.folder).toBeNull()
    expect(await read(a.saves, 's.dat')).toBe('A1')
    expect(await read(join(v.copyDir!, 'current', '0'), 's.dat')).toBe('A1')
  })
})

describe('PC Saves: review fixes', () => {
  /** The Emulation folder sync, roughly: every file of `from` that `to` lacks (work in progress left out). */
  async function carryMissing(from: string, to: string): Promise<void> {
    const names = (await fs.readdir(from, { recursive: true })) as string[]
    for (const n of names) {
      if (n.includes('.playout-')) continue
      const p = join(from, n)
      if ((await fs.stat(p)).isDirectory()) continue
      const t = join(to, n)
      if (await fs.stat(t).catch(() => null)) continue
      await fs.mkdir(join(t, '..'), { recursive: true })
      await fs.copyFile(p, t)
    }
  }

  it('two PCs that each made a copy folder for one game (titles differ) end up on the same one: a conflict', async () => {
    const emuA = join(root, 'EmuA')
    const emuB = join(root, 'EmuB')
    await fs.mkdir(emuA)
    await fs.mkdir(emuB)
    const a = await makePc('PC-A', { title: 'Hollow Knight', emulationDir: emuA })
    const b = await makePc('PC-B', {
      title: 'Hollow Knight: Voidheart Edition',
      emulationDir: emuB
    })
    await write(a.saves, 's.dat', 'A1')
    await write(b.saves, 's.dat', 'B1')
    await a.svc.setFolder(a.game.id, a.saves)
    await b.svc.setFolder(b.game.id, b.saves)
    await carryMissing(join(emuA, PC_SAVES_FOLDER), join(emuB, PC_SAVES_FOLDER))
    await carryMissing(join(emuB, PC_SAVES_FOLDER), join(emuA, PC_SAVES_FOLDER))
    await play(a, () => write(a.saves, 's.dat', 'A2'))
    await fs.cp(join(emuA, PC_SAVES_FOLDER), join(emuB, PC_SAVES_FOLDER), {
      recursive: true,
      force: true,
      filter: (s) => !s.includes('.playout-')
    })
    const refused = await b.svc.beforePlay(b.game)
    expect(refused?.kind).toBe('save-conflict')
    const view = (await b.svc.view(b.game.id))!
    expect(view.conflict).not.toBeNull()
    expect(view.copyDir).toBe((await a.svc.view(a.game.id))!.copyDir!.replace(emuA, emuB))
    expect(await read(b.saves, 's.dat')).toBe('B1')
  })

  it('a save folder gone with its game folder is reported, never made again and restored into', async () => {
    const exe = join(root, 'PC-A', 'D', 'Games', 'Foo', 'foo.exe')
    const saves = join(root, 'PC-A', 'D', 'Games', 'Foo', 'saves')
    const a = await makePc('PC-A', { exe, title: 'Foo', saveDir: saves })
    await write(saves, 's.dat', 'A1')
    const first = await a.svc.setFolder(a.game.id, saves)
    const moved = join(root, 'PC-A', 'E', 'Foo')
    await fs.mkdir(join(moved, '..'), { recursive: true })
    await fs.rename(join(root, 'PC-A', 'D', 'Games', 'Foo'), moved)
    a.game = { ...a.game, exePath: join(moved, 'foo.exe'), installDir: moved } as Game
    a.games.set(a.game.id, a.game)
    await play(a, () => write(join(moved, 'saves'), 's.dat', 'A2'))
    const v = (await a.svc.view(a.game.id))!
    expect(v.error).toMatch(/Save folder not found/)
    await expect(fs.access(saves)).rejects.toThrow()
    expect(await read(join(first.copyDir!, 'current', '0'), 's.dat')).toBe('A1')
    // A save folder the game simply has not made again, in a folder still there, is made and restored into.
    await fs.rm(join(moved, 'saves'), { recursive: true })
    await a.svc.setFolder(a.game.id, null)
    await fs.mkdir(join(moved, 'saves'))
    await a.svc.setFolder(a.game.id, join(moved, 'saves'))
    await fs.rm(join(moved, 'saves'), { recursive: true })
    expect(await a.svc.beforePlay(a.game)).toBeNull()
    expect(await read(join(moved, 'saves'), 's.dat')).toBe('A1')
  })

  it('refuses a save folder holding a junction (its saves would never be copied)', async () => {
    const a = await makePc('PC-A')
    const b = await makePc('PC-B')
    await write(join(a.saves, 'profile1'), 'save.dat', 'A1')
    await a.svc.setFolder(a.game.id, a.saves)
    const elsewhere = join(root, 'PC-B', 'OtherDrive', 'profile1')
    await write(elsewhere, 'save.dat', 'B-REAL')
    await fs.symlink(elsewhere, join(b.saves, 'profile1'), 'junction')
    await expect(b.svc.setFolder(b.game.id, b.saves)).rejects.toThrow(
      /link or junction \(profile1\)/
    )
    expect(await read(elsewhere, 'save.dat')).toBe('B-REAL')
    expect(await b.svc.view(b.game.id)).toMatchObject({ folder: null })
  })

  it('two games on one PC never share a copy: same key refused, a same-titled copy of this PC not offered', async () => {
    const a = await makePc('PC-A', { title: 'Doom' })
    await write(a.saves, 's.dat', 'A1')
    const steamKeyed = (g: Game): Game => ({ ...g, extra: { steamAppId: '2280' } }) as Game
    a.game = steamKeyed(a.game)
    a.games.set(a.game.id, a.game)
    const first = await a.svc.setFolder(a.game.id, a.saves)
    const modSaves = join(root, 'PC-A', 'profile', 'AppData', 'Roaming', 'DoomMod')
    await write(modSaves, 'm.dat', 'MOD')
    const mod = steamKeyed(
      manualGame('manual:mod', join(root, 'PC-A', 'Mods', 'Doom', 'doom.exe'), 'Doom')
    )
    a.games.set(mod.id, mod)
    await expect(a.svc.setFolder(mod.id, modSaves)).rejects.toThrow(/same game/)
    // Another key (no Steam id), same title: its own copy folder, no "Use the copy from PC-A?".
    const other = manualGame(
      'manual:other',
      join(root, 'PC-A', 'Mods', 'Doom2', 'doom.exe'),
      'Doom'
    )
    a.games.set(other.id, other)
    const v = await a.svc.setFolder(other.id, modSaves)
    expect(v.confirm).toBeNull()
    expect(v.copyDir).not.toBe(first.copyDir)
    expect(await read(join(first.copyDir!, 'current', '0'), 's.dat')).toBe('A1')
    expect(await read(a.saves, 's.dat')).toBe('A1')
    expect(await read(modSaves, 'm.dat')).toBe('MOD')
  })

  it('a start while the game still runs copies nothing back over its saves', async () => {
    const a = await makePc('PC-A')
    const b = await makePc('PC-B')
    await write(a.saves, 's.dat', 'A1')
    await a.svc.setFolder(a.game.id, a.saves)
    await b.svc.setFolder(b.game.id, b.saves)
    await play(b, () => write(b.saves, 's.dat', 'B2'))
    a.running = { gameId: a.game.id, startedAt: new Date().toISOString() }
    expect(await a.svc.beforePlay(a.game, { streamed: true })).toBeNull()
    expect(await read(a.saves, 's.dat')).toBe('A1')
  })

  it('a start that failed after its before-play copy does not make a later Co-Op session copied', async () => {
    const a = await makePc('PC-A')
    await write(a.saves, 's.dat', 'A1')
    const first = await a.svc.setFolder(a.game.id, a.saves)
    const before = await readCopyMeta(first.copyDir!)
    expect(await a.svc.beforePlay(a.game)).toBeNull() // ...and then the launch failed: no session
    await write(a.saves, 's.dat', 'A2')
    const later = new Date(Date.now() + 10 * 60_000).toISOString()
    a.events.emit('session:ended', {
      gameId: a.game.id,
      startedAt: later,
      endedAt: later,
      minutes: 1
    })
    await new Promise((r) => setTimeout(r, 30))
    expect((await readCopyMeta(first.copyDir!))?.hash).toBe(before?.hash)
  })

  it('no folder is chosen while the Emulation folder moves (Clear still works)', async () => {
    const a = await makePc('PC-A')
    await a.svc.setFolder(a.game.id, a.saves)
    a.moving = true
    await expect(a.svc.setFolder(a.game.id, a.saves)).rejects.toThrow(/mov/i)
    expect((await a.svc.setFolder(a.game.id, null)).folder).toBeNull()
  })

  it('re-checks the folder before every copy: programs or a junction inside since then stop it', async () => {
    const a = await makePc('PC-A')
    await write(a.saves, 's.dat', 'A1')
    const first = await a.svc.setFolder(a.game.id, a.saves)
    const before = await readCopyMeta(first.copyDir!)
    await write(a.saves, 'steam_api64.dll', 'MZ')
    expect((await a.svc.syncNow(a.game.id)).error).toMatch(/holds programs/)
    await fs.rm(join(a.saves, 'steam_api64.dll'))
    const target = join(root, 'PC-A', 'elsewhere')
    await fs.mkdir(target)
    await fs.symlink(target, join(a.saves, 'slot'), 'junction')
    expect((await a.svc.syncNow(a.game.id)).error).toMatch(/link or junction \(slot\)/)
    expect((await readCopyMeta(first.copyDir!))?.hash).toBe(before?.hash)
  })
})
