import { promises as fs } from 'fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'path'
import type { InstalledRecomp } from '../../shared/recomp'
import { normalizePath } from '../util/paths'
import { safeRecompId } from './install'

async function isDir(p: string): Promise<boolean> {
  return !!(await fs.stat(p).catch(() => null))?.isDirectory()
}

async function isFile(p: string): Promise<boolean> {
  return !!(await fs.stat(p).catch(() => null))?.isFile()
}

/**
 * Where an installed recompilation's folder is now, when its stored folder is gone (renamed or moved by hand inside
 * the Recompilations folder): null when the stored folder is there, or no single folder can be told apart as its own.
 *
 * Tried in order, never a folder another recompilation's record owns (`claimed`) or PlayOut's own `.playout`:
 * 1. the program the user chose, when it is inside the Recompilations folder (its top folder there);
 * 2. a folder ending in the recompilation's id, "(owner-repo)", as PlayOut names them;
 * 3. a folder with the stored folder's name (the Recompilations folder itself moved);
 * 4. the one folder holding its program (a relative program path).
 */
export async function findMovedRecompDir(
  rec: Pick<InstalledRecomp, 'id' | 'dir' | 'exe'>,
  root: string,
  claimed: string[]
): Promise<string | null> {
  if (await isDir(rec.dir)) return null
  if (!(await isDir(root))) return null
  const taken = new Set(claimed.map(normalizePath))
  const free = (dir: string): boolean =>
    !taken.has(normalizePath(dir)) && basename(dir) !== '.playout'

  if (rec.exe && isAbsolute(rec.exe) && (await isFile(rec.exe))) {
    const rel = relative(resolve(root), resolve(rec.exe))
    const top = rel.split(sep)[0]
    if (top && top !== '..' && !isAbsolute(rel) && rel.includes(sep)) {
      const dir = join(resolve(root), top)
      if (free(dir) && (await isDir(dir))) return dir
    }
  }

  const subdirs: string[] = []
  for (const d of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (d.isDirectory()) {
      const dir = join(resolve(root), d.name)
      if (free(dir)) subdirs.push(dir)
    }
  }
  const only = (list: string[]): string | null => (list.length === 1 ? list[0] : null)

  const suffix = `(${safeRecompId(rec.id)})`.toLowerCase()
  const bySuffix = only(subdirs.filter((d) => basename(d).toLowerCase().endsWith(suffix)))
  if (bySuffix) return bySuffix

  const oldName = basename(rec.dir).toLowerCase()
  const byName = only(subdirs.filter((d) => basename(d).toLowerCase() === oldName))
  if (byName) return byName

  if (rec.exe && !isAbsolute(rec.exe)) {
    const holding: string[] = []
    for (const d of subdirs) if (await isFile(join(d, rec.exe))) holding.push(d)
    return only(holding)
  }
  return null
}
