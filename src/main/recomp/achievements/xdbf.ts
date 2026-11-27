// The Xbox 360 title data block (XDBF): the resource in a game's executable that lists its achievements (the XACH
// table) and their texts (XSTR string tables, one per language). Read from the format's public description; all values
// are big-endian.

/** One achievement as the game defines it. */
export interface XdbfAchievement {
  id: number
  name: string
  description: string
  /** The text shown while it is locked (may be ''). */
  unachieved: string
  gamerscore: number
  flags: number
}

export interface XdbfInfo {
  achievements: XdbfAchievement[]
}

const MAGIC_XDBF = 0x58444246
const MAGIC_XACH = 0x58414348
const MAGIC_XSTC = 0x58535443
const MAGIC_XSTR = 0x58535452
const SECTION_METADATA = 1
const SECTION_STRINGS = 3
const HEADER = 24
const ENTRY = 18
const FREE_ENTRY = 8
const ACH_ENTRY = 0x24
/** The Xbox 360's language numbers of PlayOut's UI languages (its string tables are keyed by them). */
export const XLANGUAGE: Record<string, number> = { en: 1, es: 5 }
const ENGLISH = XLANGUAGE.en!
/** XACH flags: the achievement's details show while it is locked (otherwise it is a secret one). */
export const XACH_SHOW_UNACHIEVED = 0x8

/** The sections of an XDBF block, by "<section>:<id>". */
function sections(buf: Buffer): Map<string, Buffer> | null {
  if (buf.length < HEADER || buf.readUInt32BE(0) !== MAGIC_XDBF) return null
  const tableLength = buf.readUInt32BE(8)
  const used = buf.readUInt32BE(12)
  const freeLength = buf.readUInt32BE(16)
  if (used > tableLength || tableLength > 100_000 || freeLength > 100_000) return null
  const base = HEADER + tableLength * ENTRY + freeLength * FREE_ENTRY
  if (base > buf.length) return null
  const out = new Map<string, Buffer>()
  for (let i = 0; i < used; i++) {
    const at = HEADER + i * ENTRY
    const section = buf.readUInt16BE(at)
    const id = buf.readBigUInt64BE(at + 2)
    const offset = buf.readUInt32BE(at + 10)
    const size = buf.readUInt32BE(at + 14)
    const start = base + offset
    if (start + size > buf.length) continue
    out.set(`${section}:${id}`, buf.subarray(start, start + size))
  }
  return out
}

/** An XSTR string table as id -> text. */
function stringTable(data: Buffer | undefined): Map<number, string> {
  const out = new Map<number, string>()
  if (!data || data.length < 14 || data.readUInt32BE(0) !== MAGIC_XSTR) return out
  const count = data.readUInt16BE(12)
  let p = 14
  for (let i = 0; i < count && p + 4 <= data.length; i++) {
    const id = data.readUInt16BE(p)
    const length = data.readUInt16BE(p + 2)
    p += 4
    if (p + length > data.length) break
    out.set(id, data.toString('utf8', p, p + length))
    p += length
  }
  return out
}

/**
 * The achievements in an XDBF block, with texts in `language` (an Xbox 360 language number, XLANGUAGE) when the game
 * has them, else in English, else in its default language (else any language it has). Null when the block is not XDBF
 * or has no achievement table.
 */
export function parseXdbf(buf: Buffer, language: number = XLANGUAGE.en): XdbfInfo | null {
  const all = sections(buf)
  if (!all) return null
  const xach = all.get(`${SECTION_METADATA}:${MAGIC_XACH}`)
  if (!xach || xach.length < 14 || xach.readUInt32BE(0) !== MAGIC_XACH) return null
  const xstc = all.get(`${SECTION_METADATA}:${MAGIC_XSTC}`)
  const defaultLanguage =
    xstc && xstc.length >= 16 && xstc.readUInt32BE(0) === MAGIC_XSTC ? xstc.readUInt32BE(12) : null
  const tableKey =
    [language, ENGLISH, defaultLanguage]
      .map((lang) => (lang === null ? null : `${SECTION_STRINGS}:${lang}`))
      .find((k) => k !== null && all.has(k)) ??
    [...all.keys()].find((k) => k.startsWith(`${SECTION_STRINGS}:`))
  const strings = stringTable(tableKey ? all.get(tableKey) : undefined)
  const count = xach.readUInt16BE(12)
  const achievements: XdbfAchievement[] = []
  for (let i = 0; i < count; i++) {
    const at = 14 + i * ACH_ENTRY
    if (at + ACH_ENTRY > xach.length) break
    achievements.push({
      id: xach.readUInt16BE(at),
      name: strings.get(xach.readUInt16BE(at + 2)) ?? '',
      description: strings.get(xach.readUInt16BE(at + 4)) ?? '',
      unachieved: strings.get(xach.readUInt16BE(at + 6)) ?? '',
      gamerscore: xach.readUInt16BE(at + 12),
      flags: xach.readUInt32BE(at + 16)
    })
  }
  return { achievements }
}
