import { withoutXisoSuffix } from '../../shared/convert'

/** Lower-case sort key without a leading article or punctuation. */
export function sortTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface CleanedTitle {
  title: string
  /** Region/version tags found in parentheses or brackets, e.g. ['USA', 'Rev 1']. */
  tags: string[]
}

/**
 * Turn a ROM file name such as "Super Mario World (USA) [!].sfc" into { title: 'Super Mario World', tags: ['USA', '!'] }.
 * The extension is removed when `stripExtension` is true (default), with a trimmed Xbox image's ".xiso" in front of it
 * ("Halo (USA).xiso.iso" is "Halo").
 */
export function cleanRomTitle(fileName: string, stripExtension = true): CleanedTitle {
  let name = fileName
  if (stripExtension) name = withoutXisoSuffix(name.replace(/\.[^./\\]+$/, ''))
  const tags: string[] = []
  name = name.replace(/\s*[([]([^()[\]]*)[)\]]/g, (_m, tag: string) => {
    const t = tag.trim()
    if (t) tags.push(t)
    return ''
  })
  name = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  // "DRIVECLUB - [EU] [EN]" leaves "DRIVECLUB -" once its tags are gone.
  name = name.replace(/\s+[-–—]+$/, '')
  // "Legend of Zelda, The" -> "The Legend of Zelda"
  const m = name.match(/^(.*),\s*(The|A|An)$/i)
  if (m) name = `${m[2]} ${m[1]}`
  return { title: name || fileName, tags }
}

export function formatHours(minutes: number): string {
  if (!minutes || minutes < 1) return '0 hours'
  const hours = minutes / 60
  if (hours < 1) return `${Math.round(minutes)} min`
  return `${hours.toFixed(1).replace(/\.0$/, '')} hours`
}

/** Playnite's RemoveTrademarks: drop ™ ® © and collapse whitespace. */
export function removeTrademarks(name: string): string {
  return name.replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim()
}

/** The file part of an Uninstall DisplayIcon value: `"C:\x\game.ico",0` -> `C:\x\game.ico`. */
export function displayIconPath(value: string): string {
  return value
    .trim()
    .replace(/,-?\d+$/, '')
    .replace(/^"+|"+$/g, '')
    .trim()
}
