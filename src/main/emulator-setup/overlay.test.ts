import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { journalOf, keepRule, overlayFolder, recoverOverlay } from './overlay'

let dir: string
const read = (p: string): Promise<string> => fs.readFile(p, 'utf8')
async function put(p: string, text: string): Promise<void> {
  await fs.mkdir(join(p, '..'), { recursive: true })
  await fs.writeFile(p, text)
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-overlay-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('overlayFolder', () => {
  it('replaces the build files, adds new ones and keeps everything else', async () => {
    const src = join(dir, 'new')
    const dst = join(dir, 'Emu')
    await put(join(src, 'emu.exe'), 'v2')
    await put(join(src, 'lib', 'a.dll'), 'a2')
    await put(join(src, 'lib', 'b.dll'), 'b2')
    await put(join(dst, 'emu.exe'), 'v1')
    await put(join(dst, 'lib', 'a.dll'), 'a1')
    await put(join(dst, 'settings.ini'), 'mine')
    const o = await overlayFolder(src, dst, { backupDir: join(dir, 'backup') })
    expect([o.replaced, o.added]).toEqual([2, 1])
    expect(await read(join(dst, 'emu.exe'))).toBe('v2')
    expect(await read(join(dst, 'lib', 'b.dll'))).toBe('b2')
    expect(await read(join(dst, 'settings.ini'))).toBe('mine')
    await o.commit()
    await expect(fs.access(join(dir, 'backup'))).rejects.toThrow()
  })

  it('keeps installed files the keep rule names, and adds them when missing', async () => {
    const src = join(dir, 'new')
    const dst = join(dir, 'Emu')
    await put(join(src, 'portable.txt'), 'default')
    await put(join(src, 'config', 'x.yml'), 'default')
    await put(join(src, 'config', 'y.yml'), 'default')
    await put(join(dst, 'portable.txt'), 'mine')
    await put(join(dst, 'config', 'x.yml'), 'mine')
    const o = await overlayFolder(src, dst, {
      backupDir: join(dir, 'backup'),
      keep: keepRule(['portable.txt', 'config/'])
    })
    expect(await read(join(dst, 'portable.txt'))).toBe('mine')
    expect(await read(join(dst, 'config', 'x.yml'))).toBe('mine')
    expect(await read(join(dst, 'config', 'y.yml'))).toBe('default')
    expect(o.skipped.length).toBe(2)
  })

  it('never writes through a junction into the data folder', async () => {
    const src = join(dir, 'new')
    const dst = join(dir, 'Emu')
    const data = join(dir, 'data-saves')
    await put(join(src, 'saves', 'default.sav'), 'build')
    await put(join(data, 'game.sav'), 'save')
    await fs.mkdir(dst, { recursive: true })
    await fs.symlink(data, join(dst, 'saves'), 'junction')
    const o = await overlayFolder(src, dst, { backupDir: join(dir, 'backup') })
    expect(o.skipped).toEqual(['saves'])
    expect(await fs.readdir(data)).toEqual(['game.sav'])
  })

  it('puts the folder back when undone', async () => {
    const src = join(dir, 'new')
    const dst = join(dir, 'Emu')
    await put(join(src, 'emu.exe'), 'v2')
    await put(join(src, 'new', 'n.dll'), 'n')
    await put(join(dst, 'emu.exe'), 'v1')
    const o = await overlayFolder(src, dst, { backupDir: join(dir, 'backup') })
    await o.undo()
    expect(await read(join(dst, 'emu.exe'))).toBe('v1')
    expect(await fs.readdir(dst)).toEqual(['emu.exe'])
  })
})

describe('keepRule', () => {
  it('matches files and folders, any case and separator', () => {
    const keep = keepRule(['portable.txt', 'Config/'])
    expect(keep('PORTABLE.TXT')).toBe(true)
    expect(keep(join('config', 'a.yml'))).toBe(true)
    expect(keep('configs.txt')).toBe(false)
  })
})

describe('interrupted overlays', () => {
  it('a journal left behind (PlayOut closed half-way) puts the folder back', async () => {
    const src = join(dir, 'new')
    const dst = join(dir, 'Emu')
    const backupDir = join(dir, 'backup')
    await put(join(src, 'emu.exe'), 'v2')
    await put(join(src, 'added.dll'), 'new')
    await put(join(dst, 'emu.exe'), 'v1')
    await overlayFolder(src, dst, { backupDir })
    // Neither committed nor undone: as if PlayOut closed right after the swap.
    expect(await read(journalOf(backupDir))).toContain('B\temu.exe')
    expect(await recoverOverlay(dst, backupDir)).toBe('restored')
    expect(await read(join(dst, 'emu.exe'))).toBe('v1')
    expect(await fs.readdir(dst)).toEqual(['emu.exe'])
    await expect(fs.access(backupDir)).rejects.toThrow()
    await expect(fs.access(journalOf(backupDir))).rejects.toThrow()
  })

  it('a committed overlay leaves nothing to recover, and a backup without a journal is just deleted', async () => {
    const src = join(dir, 'new')
    const dst = join(dir, 'Emu')
    const backupDir = join(dir, 'backup')
    await put(join(src, 'emu.exe'), 'v2')
    await put(join(dst, 'emu.exe'), 'v1')
    const o = await overlayFolder(src, dst, { backupDir })
    await o.commit()
    expect(await recoverOverlay(dst, backupDir)).toBe('none')
    await put(join(backupDir, 'emu.exe'), 'v1')
    expect(await recoverOverlay(dst, backupDir)).toBe('none')
    expect(await read(join(dst, 'emu.exe'))).toBe('v2')
    await expect(fs.access(backupDir)).rejects.toThrow()
  })

  it('keeps the backup and journal when a file cannot be put back', async () => {
    const dst = join(dir, 'Emu')
    const backupDir = join(dir, 'backup')
    await put(join(backupDir, 'emu.exe'), 'v1')
    // The installed path is now a folder (cannot be replaced by the old file).
    await fs.mkdir(join(dst, 'emu.exe', 'inside'), { recursive: true })
    await put(join(dst, 'emu.exe', 'inside', 'x'), 'x')
    await fs.writeFile(journalOf(backupDir), 'B\temu.exe\nC\temu.exe\n')
    expect(await recoverOverlay(dst, backupDir)).toBe('incomplete')
    expect(await read(join(backupDir, 'emu.exe'))).toBe('v1')
    // A new overlay refuses to start over it.
    await put(join(dir, 'new', 'emu.exe'), 'v3')
    await expect(overlayFolder(join(dir, 'new'), dst, { backupDir })).rejects.toThrow(
      /could not be undone/
    )
  })

  it('leaves a journal it cannot read, and its backup, alone', async () => {
    const dst = join(dir, 'Emu')
    const backupDir = join(dir, 'backup')
    await put(join(backupDir, 'emu.exe'), 'v1')
    await put(join(dst, 'emu.exe'), 'v2')
    // A folder where the journal file should be: reading it fails with something other than "not there".
    await fs.mkdir(journalOf(backupDir), { recursive: true })
    expect(await recoverOverlay(dst, backupDir)).toBe('incomplete')
    expect(await read(join(backupDir, 'emu.exe'))).toBe('v1')
  })

  it('ignores a last journal line cut short', async () => {
    const dst = join(dir, 'Emu')
    const backupDir = join(dir, 'backup')
    await put(join(dst, 'emu.exe'), 'v1')
    await fs.writeFile(journalOf(backupDir), 'C\temu.exe')
    expect(await recoverOverlay(dst, backupDir)).toBe('restored')
    expect(await read(join(dst, 'emu.exe'))).toBe('v1')
  })

  it('ignores journal lines that point outside the folder', async () => {
    const dst = join(dir, 'Emu')
    const backupDir = join(dir, 'backup')
    await put(join(dir, 'outside.txt'), 'keep me')
    await fs.mkdir(dst, { recursive: true })
    await fs.writeFile(
      journalOf(backupDir),
      `C\t${join('..', 'outside.txt')}\nC\t${join(dir, 'outside.txt')}\n`
    )
    expect(await recoverOverlay(dst, backupDir)).toBe('restored')
    expect(await read(join(dir, 'outside.txt'))).toBe('keep me')
  })
})
