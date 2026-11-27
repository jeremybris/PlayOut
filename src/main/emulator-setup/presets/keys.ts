import { promises as fs } from 'fs'

/**
 * Small read-only helpers the presets use to decide whether a key is still missing (or still the emulator's own
 * default) before writing it. Writing goes through ini.ts.
 */

/** The lines of a text file (BOM and line endings removed), or null when the file does not exist. */
export async function readLines(file: string): Promise<string[] | null> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text.split(/\r?\n/)
}

/**
 * The value of `key` in INI section body lines (`key=value` or `key = value`, key compared case-insensitively,
 * `;`/`#` comment lines skipped, a trailing `;comment` kept as part of the value), or undefined when it is absent.
 */
export function iniValue(lines: string[] | null, key: string): string | undefined {
  if (!lines) return undefined
  const wanted = key.toLowerCase()
  for (const line of lines) {
    const t = line.trimStart()
    if (t.startsWith(';') || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    if (t.slice(0, eq).trim().toLowerCase() === wanted) return t.slice(eq + 1).trim()
  }
  return undefined
}
