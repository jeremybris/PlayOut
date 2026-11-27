import { promises as fs } from 'fs'
import { basename, dirname, extname, isAbsolute, join } from 'path'

/**
 * The files that make up one game image: what goes to the Recycle Bin once it is converted. A .cue and the files its
 * FILE lines name, a .gdi and its tracks, a .m3u and the discs it lists, the pieces of a split PS3 image, or a folder.
 */

async function exists(path: string): Promise<boolean> {
  return fs.access(path).then(
    () => true,
    () => false
  )
}

function resolveIn(dir: string, name: string): string {
  const clean = name.trim().replace(/^"(.*)"$/, '$1')
  return isAbsolute(clean) ? clean : join(dir, clean)
}

/** The files a .cue sheet names (FILE "x.bin" BINARY). */
export function cueFiles(text: string, dir: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*FILE\s+(?:"([^"]+)"|(\S+))/i.exec(line)
    if (m) out.push(resolveIn(dir, m[1] ?? m[2]!))
  }
  return out
}

/** The track files a .gdi lists ("1 0 4 2352 track01.bin 0", the name possibly quoted). */
export function gdiFiles(text: string, dir: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/).slice(1)) {
    const m = /^\s*\d+\s+\d+\s+\d+\s+\d+\s+(?:"([^"]+)"|(\S+))/.exec(line)
    if (m) out.push(resolveIn(dir, m[1] ?? m[2]!))
  }
  return out
}

/** The discs a .m3u playlist lists (comments and blank lines skipped). */
export function m3uFiles(text: string, dir: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => resolveIn(dir, l))
}

/** The image and every file it needs, as far as they exist (the image itself first). */
export async function sourceFiles(path: string): Promise<string[]> {
  const stat = await fs.stat(path)
  if (stat.isDirectory()) return [path]
  const dir = dirname(path)
  const ext = extname(path).toLowerCase()
  let parts: string[] = []
  if (ext === '.cue' || ext === '.gdi' || ext === '.m3u') {
    const text = await fs.readFile(path, 'utf8').catch(() => '')
    parts =
      ext === '.cue'
        ? cueFiles(text, dir)
        : ext === '.gdi'
          ? gdiFiles(text, dir)
          : m3uFiles(text, dir)
    // A playlist's discs bring their own files (a .cue's BINs).
    if (ext === '.m3u')
      for (const disc of [...parts])
        if (extname(disc).toLowerCase() === '.cue' && (await exists(disc)))
          parts.push(...cueFiles(await fs.readFile(disc, 'utf8').catch(() => ''), dirname(disc)))
  } else if (/^\.(\d+|66600)$/.test(ext)) {
    // A split PS3 image: "Game.iso.0, Game.iso.1, …" or "Game.66600, Game.66601, …".
    const stem = basename(path, ext)
    const numbered = ext === '.66600' ? /^\.666\d\d$/ : /^\.\d+$/
    for (const name of await fs.readdir(dir))
      if (
        name !== basename(path) &&
        name.startsWith(`${stem}.`) &&
        numbered.test(name.slice(stem.length))
      )
        parts.push(join(dir, name))
  }
  const out = [path]
  for (const part of parts) if (!out.includes(part) && (await exists(part))) out.push(part)
  return out
}
