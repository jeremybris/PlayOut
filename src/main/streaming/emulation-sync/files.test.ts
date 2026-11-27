import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Backups, realInside } from './files'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'playout-emusync-files-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function listAll(root: string): Promise<string[]> {
  const names = await fs.readdir(root, { recursive: true }).catch(() => [] as string[])
  const out: string[] = []
  for (const n of names) if ((await fs.stat(join(root, String(n)))).isFile()) out.push(String(n))
  return out
}

describe('Backups', () => {
  it('copies the same content once while its replace keeps failing, and again when it changed', async () => {
    const file = join(dir, 'save.srm')
    await fs.writeFile(file, 'v1')
    let t = Date.parse('2026-11-12T12:00:00Z')
    const backups = new Backups(join(dir, 'backups'), () => t)
    expect(await backups.copy(file, 'saves/save.srm', 'h1')).not.toBeNull()
    t += 5 * 60_000
    expect(await backups.copy(file, 'saves/save.srm', 'h1')).toBeNull()
    await fs.writeFile(file, 'v2')
    expect(await backups.copy(file, 'saves/save.srm', 'h2')).not.toBeNull()
    expect(await listAll(join(dir, 'backups'))).toHaveLength(2)
    expect(await fs.readFile(file, 'utf8')).toBe('v2')
  })

  it('moves deleted files in and prunes folders older than 30 days', async () => {
    let t = Date.parse('2026-10-01T00:00:00Z')
    const backups = new Backups(join(dir, 'backups'), () => t)
    const file = join(dir, 'gone.srm')
    await fs.writeFile(file, 'x')
    await backups.keep(file, 'saves/gone.srm')
    await expect(fs.access(file)).rejects.toThrow()
    expect(await listAll(join(dir, 'backups'))).toHaveLength(1)
    t += 31 * 86_400_000
    await backups.prune()
    expect(await listAll(join(dir, 'backups'))).toHaveLength(0)
  })
})

describe('realInside', () => {
  it('is false through a junction anywhere on the way, true for plain and new paths', async () => {
    const root = join(dir, 'Emulation')
    await fs.mkdir(join(root, 'saves', 'real'), { recursive: true })
    await fs.mkdir(join(dir, 'outside'))
    await fs.symlink(join(dir, 'outside'), join(root, 'saves', 'link'), 'junction')
    expect(await realInside(root, 'saves/real/a.srm')).toBe(true)
    expect(await realInside(root, 'saves/new/deeper/a.srm')).toBe(true)
    expect(await realInside(root, 'saves/link/a.srm')).toBe(false)
    expect(await realInside(root, 'saves/link')).toBe(false)
    expect(await realInside(join(dir, 'missing'), 'saves/a.srm')).toBe(false)
  })
})
