import { parse } from '@node-steam/vdf'
import { readTextIfExists } from './fs'

export type VdfValue = string | number | VdfObject
export interface VdfObject {
  [key: string]: VdfValue
}

/**
 * True when a double-quoted string is still open at the end of the text. @node-steam/vdf 2.2.0 loops forever on
 * such input (it keeps appending lines past the end of the array), so parseVdf rejects it up front.
 */
export function hasUnterminatedString(text: string): boolean {
  let open = false
  let inBlockComment = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!open) {
      if (inBlockComment) {
        if (line.includes('*/')) inBlockComment = false
        continue
      }
      if (line.startsWith('//')) continue
      if (line.startsWith('/*')) {
        if (!line.includes('*/')) inBlockComment = true
        continue
      }
    }
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '\\' && open) {
        i++
        continue
      }
      if (ch === '"') open = !open
    }
  }
  return open
}

/** Parse Valve's text KeyValues format (libraryfolders.vdf, appmanifest_*.acf, localconfig.vdf). */
export function parseVdf(text: string): VdfObject {
  const body = text.replace(/^\uFEFF/, '')
  if (hasUnterminatedString(body)) throw new SyntaxError('VDF: unterminated quoted string')
  return parse(body) as VdfObject
}

export async function readVdfFile(path: string): Promise<VdfObject | null> {
  const text = await readTextIfExists(path)
  if (text === null) return null
  try {
    return parseVdf(text)
  } catch {
    return null
  }
}

/** Case-insensitive nested lookup: vdfGet(obj, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps'). */
export function vdfGet(obj: VdfValue | undefined, ...keys: string[]): VdfValue | undefined {
  let current: VdfValue | undefined = obj
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined
    const lower = key.toLowerCase()
    const found = Object.keys(current).find((k) => k.toLowerCase() === lower)
    current = found === undefined ? undefined : current[found]
  }
  return current
}

export function vdfString(value: VdfValue | undefined): string | undefined {
  if (value === undefined || typeof value === 'object') return undefined
  return String(value)
}

export function vdfNumber(value: VdfValue | undefined): number | undefined {
  if (value === undefined || typeof value === 'object') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}
