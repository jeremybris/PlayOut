// ES-DE's scraped media as a local art source (docs/ARCHITECTURE.md §4.6 "Art pipeline", research §13.5):
// `<ES-DE home>\downloaded_media\<system>\{covers,3dboxes,marquees,fanart,screenshots,titlescreens}\<romname>.<ext>`
// plus the `<image>` / `<thumbnail>` / `<marquee>` paths of `gamelists\<system>\gamelist.xml`. One readdir per
// media folder per system, never a stat per ROM; keyed by `romSystemId` + `romName`.
import { XMLParser } from 'fast-xml-parser'
import { basename, dirname, extname, isAbsolute, join, normalize } from 'path'
import type { ArtKind, Game, Settings } from '../../../shared/types'
import { parseEsdeSettings } from '../../emulation/esde-import'
import type { Logger } from '../../logger'
import { isDirectory, listDir, readTextIfExists } from '../../util/fs'
import { knownFolders } from '../../util/paths'
import { sniffForKind } from '../image-sniff'
import type { ArtCandidate, ArtCandidates, ArtIds, LocalArtSource } from '../types'

const SOURCE_ID = 'esde-media' as const
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/** ES-DE media folders per kind, best first. Screenshots double as the hero fallback (16:9, accepted as `fallback`). */
const MEDIA_FOLDERS: Record<EsdeKind, string[]> = {
  cover: ['covers', '3dboxes'],
  logo: ['marquees'],
  hero: ['fanart', 'screenshots'],
  screenshot: ['screenshots', 'titlescreens']
}
/** gamelist.xml elements per kind, best first. */
const GAMELIST_TAGS: Record<EsdeKind, string[]> = {
  cover: ['thumbnail', 'image'],
  logo: ['marquee'],
  hero: ['fanart', 'image'],
  screenshot: ['image']
}

type EsdeKind = 'cover' | 'logo' | 'hero' | 'screenshot'

export interface EsdeMediaOptions {
  /** Override the ES-DE home (tests); default `settings.library.esdeHome` or `%USERPROFILE%\ES-DE`. */
  esdeHome?: string
  log?: Logger
}

interface EsdeIndex {
  esdeHome: string
  mediaDir: string
}

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) => name === 'game' || name === 'folder',
  parseTagValue: false,
  trimValues: true
})

/** ROM base name without its extension, lower-cased: the key both the media folders and the gamelist use. */
export function romKey(name: string): string {
  const base = basename(name.replace(/\\/g, '/'))
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase()
}

/** `<game>` entries of a gamelist -> ROM key -> tag -> absolute media path. Exported for tests. */
export function parseGamelistMedia(
  xml: string,
  systemDir: string
): Map<string, Partial<Record<string, string>>> {
  const out = new Map<string, Partial<Record<string, string>>>()
  let doc: { gameList?: { game?: Record<string, unknown>[] } }
  try {
    doc = parser.parse(xml.replace(/^\uFEFF/, '')) as typeof doc
  } catch {
    return out
  }
  for (const entry of doc.gameList?.game ?? []) {
    const path = typeof entry.path === 'string' ? entry.path : undefined
    if (!path) continue
    const media: Partial<Record<string, string>> = {}
    for (const tag of ['image', 'thumbnail', 'marquee', 'fanart']) {
      const value = entry[tag]
      if (typeof value !== 'string' || !value) continue
      const resolved = isAbsolute(value)
        ? normalize(value)
        : normalize(join(systemDir, value.replace(/^\.\//, '')))
      media[tag] = resolved
    }
    if (Object.keys(media).length) out.set(romKey(path), media)
  }
  return out
}

function expandEsdePath(value: string, esdeHome: string): string {
  const home = dirname(esdeHome)
  return normalize(value.replace(/^~(?=[\\/]|$)/, home).replace(/%ESPATH%/gi, home))
}

export function createEsdeMediaSource(options: EsdeMediaOptions = {}): LocalArtSource {
  const log = options.log
  let indexPromise: Promise<EsdeIndex | null> | null = null
  /** `<mediaDir>\<system>\<folder>` -> ROM key -> absolute path. */
  const folders = new Map<string, Promise<Map<string, string>>>()
  /** system -> gamelist media. */
  const gamelists = new Map<string, Promise<Map<string, Partial<Record<string, string>>>>>()

  async function buildIndex(settings: Settings): Promise<EsdeIndex | null> {
    const candidates: string[] = []
    if (options.esdeHome) candidates.push(options.esdeHome)
    else {
      const configured = settings.library.esdeHome
      if (configured) candidates.push(configured, join(configured, 'ES-DE'))
      candidates.push(join(knownFolders().userProfile, 'ES-DE'))
    }
    for (const home of [...new Set(candidates.map((c) => normalize(c)))]) {
      const hasMedia = await isDirectory(join(home, 'downloaded_media'))
      const hasGamelists = await isDirectory(join(home, 'gamelists'))
      if (!hasMedia && !hasGamelists) continue
      const parsed = parseEsdeSettings(
        (await readTextIfExists(join(home, 'settings', 'es_settings.xml'))) ?? ''
      )
      const mediaDir = parsed.mediaDirectory
        ? expandEsdePath(parsed.mediaDirectory, home)
        : join(home, 'downloaded_media')
      log?.info(`esde-media: using ${home} (media: ${mediaDir})`)
      return { esdeHome: home, mediaDir }
    }
    return null
  }

  function index(settings: Settings): Promise<EsdeIndex | null> {
    indexPromise ??= buildIndex(settings)
    return indexPromise
  }

  function folder(dir: string): Promise<Map<string, string>> {
    let pending = folders.get(dir)
    if (!pending) {
      pending = listDir(dir).then((entries) => {
        const map = new Map<string, string>()
        for (const e of entries) {
          if (!e.isFile() || !IMAGE_EXTENSIONS.has(extname(e.name).toLowerCase())) continue
          const key = romKey(e.name)
          if (!map.has(key)) map.set(key, join(dir, e.name))
        }
        return map
      })
      folders.set(dir, pending)
    }
    return pending
  }

  function gamelist(
    esdeHome: string,
    system: string
  ): Promise<Map<string, Partial<Record<string, string>>>> {
    let pending = gamelists.get(system)
    if (!pending) {
      pending = (async () => {
        const file = join(esdeHome, 'gamelists', system, 'gamelist.xml')
        const xml = await readTextIfExists(file)
        return xml === null ? new Map() : parseGamelistMedia(xml, dirname(file))
      })()
      gamelists.set(system, pending)
    }
    return pending
  }

  async function candidate(path: string, kind: EsdeKind): Promise<ArtCandidate | null> {
    const sniffed = await sniffForKind(path, kind)
    if (!sniffed) return null
    return { kind, source: SOURCE_ID, path, width: sniffed.info.width, height: sniffed.info.height }
  }

  let lastSettings: Settings | null = null

  return {
    id: SOURCE_ID,

    async isAvailable(settings) {
      lastSettings = settings
      return (await index(settings)) !== null
    },

    async index(settings) {
      lastSettings = settings
      await index(settings)
    },

    reset() {
      indexPromise = null
      folders.clear()
      gamelists.clear()
    },

    async lookup(_game: Game, ids: ArtIds, kinds: ArtKind[]) {
      const out: ArtCandidates = {}
      if (!ids.romSystemId || !ids.romName || !lastSettings) return out
      const idx = await index(lastSettings)
      if (!idx) return out
      // `romName` is already the base name without its extension (`art-ids.ts`); `romKey` would strip everything
      // after the last dot of "Super Mario Bros. (World)" and miss every name with an abbreviation in it.
      const key = ids.romName.toLowerCase()
      const system = ids.romSystemId
      for (const kind of kinds) {
        if (kind === 'icon') continue
        const paths: string[] = []
        for (const name of MEDIA_FOLDERS[kind]) {
          // ES-DE keeps a sub-folder's media in the same sub-folder; the top level is the fallback.
          const dirs = ids.romRelDir
            ? [
                join(idx.mediaDir, system, name, ...ids.romRelDir.split('/')),
                join(idx.mediaDir, system, name)
              ]
            : [join(idx.mediaDir, system, name)]
          for (const dir of dirs) {
            const path = (await folder(dir)).get(key)
            if (path) {
              paths.push(path)
              break
            }
          }
        }
        const listed = (await gamelist(idx.esdeHome, system)).get(key)
        for (const tag of GAMELIST_TAGS[kind]) {
          const path = listed?.[tag]
          if (path && !paths.includes(path)) paths.push(path)
        }
        const found: ArtCandidate[] = []
        for (const path of paths) {
          const c = await candidate(path, kind)
          if (c) found.push(c)
          if (found.length && kind !== 'screenshot') break
        }
        if (found.length) out[kind] = found
      }
      return out
    }
  }
}
