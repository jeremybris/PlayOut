import { promises as fs } from 'fs'
import { dirname, extname, join } from 'path'

/**
 * Xbox 360 Games on Demand packages in a picked folder, for Convert's Games on Demand → ISO (Game Format Converter
 * 2.1.1's god_iso): an extension-less file that starts with an Xbox 360 package's magic (LIVE, PIRS or "CON ") and has
 * its "<name>.data" folder beside it, as the converter itself recognises one (is_god_header). The usual layout is
 * <title id>\00007000\<package> with <package>.data beside it; the folder picked may be any of those, and a game with
 * several discs has one package per disc. Looked for at most three folders down.
 */
const MAGICS = ['LIVE', 'PIRS', 'CON ']
/** The package's content type (big-endian, at 0x344): Games on Demand (0x7000) or an installed game (0x4000). */
const GOD_TYPES = [0x7000, 0x4000]
const HEADER = 0x348
const MAX_DEPTH = 3

/** The converter's own test (is_god_header): the magic, and a disc-game content type. */
async function isGodHeader(path: string): Promise<boolean> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(path, 'r')
    const buf = Buffer.alloc(HEADER)
    const { bytesRead } = await handle.read(buf, 0, HEADER, 0)
    return (
      bytesRead === HEADER &&
      MAGICS.includes(buf.toString('latin1', 0, 4)) &&
      GOD_TYPES.includes(buf.readUInt32BE(0x344))
    )
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function godPackagesIn(dir: string, depth = 0): Promise<string[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const folders = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name.toLowerCase()))
  const found: string[] = []
  for (const e of entries) {
    if (!e.isFile() || extname(e.name) !== '' || !folders.has(`${e.name.toLowerCase()}.data`))
      continue
    const path = join(dir, e.name)
    if (await isGodHeader(path)) found.push(path)
  }
  if (depth < MAX_DEPTH)
    for (const e of entries)
      if (e.isDirectory() && !e.name.toLowerCase().endsWith('.data'))
        found.push(...(await godPackagesIn(join(dir, e.name), depth + 1)))
  return found.sort((a, b) => a.localeCompare(b))
}

/**
 * The games among packages: a game's discs share the folder above their content-type folder (its title id, as in
 * <title id>\00007000\<package>). More than one: the picked folder holds several games.
 */
export function godGames(packages: readonly string[]): number {
  return new Set(packages.map((p) => dirname(dirname(p)).toLowerCase())).size
}
